/** E-mail ingest (FO-30): a gateway (SES → Lambda, Postmark inbound, or any forwarder) posts the parsed message to `POST /ingest/email`, signed
 *  over the raw body. The recipient address picks the family; the sender must be on the family's allow-list (or be a member) or the message is
 *  quarantined with a task. Attachments are stored as documents, unlocked with the configured PDF passwords, and imported through `runImport`. */
import { createHmac, timingSafeEqual } from "node:crypto";
import type pg from "pg";
import { detect } from "@fo/parsers";
import { extractPdfText, PdfError } from "@fo/reports";
import { pool, withFamily } from "./db.js";
import { storeDocument, DocError } from "./documents.js";
import { storage } from "./storage.js";
import { notifyTask } from "./notify.js";
import { runImport } from "../routes/imports.js";

export class IngestError extends Error { constructor(public status: number, message: string) { super(message); } }
export interface InboundAttachment { name: string; content_type?: string; content_base64: string }
export interface InboundMail { message_id?: string | null; from: string; to: string; subject?: string | null; text?: string | null; received_at?: string | null; attachments: InboundAttachment[] }
export const ingestSecret = () => process.env.INGEST_WEBHOOK_SECRET || "ingest-dev-secret";
export const signIngest = (raw: string, secret = ingestSecret()) => createHmac("sha256", secret).update(raw, "utf8").digest("hex");
export function verifyIngest(raw: string, headers: Record<string, any>): boolean { const s = headers["x-ingest-signature"]; if (typeof s !== "string" || !s) return false; const e = signIngest(raw); return s.length === e.length && timingSafeEqual(Buffer.from(s), Buffer.from(e)); }
const addr = (s: string) => (String(s ?? "").match(/<([^>]+)>/)?.[1] ?? String(s ?? "")).trim().toLowerCase();
/** Accepts our own shape and Postmark's inbound JSON (From / To / Subject / MessageID / Attachments[{Name, Content, ContentType}]). */
export function normaliseInbound(b: any): InboundMail {
  const atts: any[] = b.attachments ?? b.Attachments ?? [];
  return { message_id: b.message_id ?? b.MessageID ?? b.messageId ?? null, from: addr(b.from ?? b.From ?? b.FromFull?.Email ?? ""), to: addr(b.to ?? b.To ?? b.OriginalRecipient ?? b.ToFull?.[0]?.Email ?? ""), subject: b.subject ?? b.Subject ?? null, text: b.text ?? b.TextBody ?? null, received_at: b.received_at ?? b.Date ?? null,
    attachments: atts.map((a: any) => ({ name: a.name ?? a.Name ?? "attachment", content_type: a.content_type ?? a.ContentType ?? undefined, content_base64: a.content_base64 ?? a.Content ?? "" })).filter((a: any) => a.content_base64) };
}
const mimeOf = (name: string, given?: string) => { if (given && given !== "application/octet-stream") return given.split(";")[0].trim(); const ext = name.toLowerCase().split(".").pop(); return ({ pdf: "application/pdf", csv: "text/csv", txt: "text/plain", json: "application/json", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", xls: "application/vnd.ms-excel" } as Record<string, string>)[ext ?? ""] ?? "application/octet-stream"; };
const folderFor = (kind: string | null) => (kind === "bank_csv" || kind === "aa" ? "Bank statements" : kind === "pms" || kind === "aif" ? "PMS / AIF statements" : kind === "form26as" ? "Tax filings (ITR, GST)" : "CA correspondence");
/** Text from an attachment: text types as-is; PDFs opened with the configured passwords (INGEST_PDF_PASSWORDS, comma-separated — holders' PANs go here). */
export function textOf(buf: Buffer, mime: string): { text: string | null; reason?: string } {
  if (mime === "application/pdf") { const pws = ["", ...(process.env.INGEST_PDF_PASSWORDS ?? "").split(",").map((s) => s.trim()).filter(Boolean)]; let last = "password_required";
    for (const pw of pws) { try { return { text: extractPdfText(buf, pw) }; } catch (e: any) { last = e instanceof PdfError ? e.code : "unsupported"; if (last !== "password_required" && last !== "wrong_password") break; } } return { text: null, reason: last }; }
  if (/^text\/|json|csv/.test(mime)) return { text: buf.toString("utf8") };
  return { text: null, reason: "unsupported" };
}
async function allowedSender(c: pg.PoolClient, familyId: string, sender: string, allow: string[]) {
  const s = sender.toLowerCase(); if (allow.some((a) => a.toLowerCase() === s || (a.startsWith("@") && s.endsWith(a.toLowerCase())))) return true;
  return !!(await c.query("select 1 from users u join family_members m on m.user_id=u.id where m.family_id=$1 and lower(u.email)=$2", [familyId, s])).rowCount;
}
/** Store every attachment as a document (so a quarantined message can be released later) and, when allowed, import each one. */
async function processAttachments(c: pg.PoolClient, familyId: string, row: any, mail: InboundMail | null, userId: string | null, doImport: boolean) {
  const atts: any[] = Array.isArray(row.attachments) && row.attachments.length ? row.attachments : (mail?.attachments ?? []).map((a) => ({ name: a.name, mime: mimeOf(a.name, a.content_type), size: 0, status: "received" }));
  for (const [i, a] of atts.entries()) {
    try {
      let buf: Buffer | null = null;
      if (!a.document_id && mail) { buf = Buffer.from(mail.attachments[i].content_base64, "base64"); a.size = buf.length; const { doc } = await storeDocument(c, { familyId, folderName: folderFor(detect(textOf(buf, a.mime).text ?? "")), name: a.name, mime: a.mime, buffer: buf, uploadedBy: userId, source: "email", tags: ["e-mail", row.sender].slice(0, doImport ? 2 : 3).concat(doImport ? [] : ["quarantined"]) }); a.document_id = doc.id; }
      if (!doImport) { a.status = "held"; continue; }
      if (!buf) { const d = (await c.query("select storage_key from documents where id=$1", [a.document_id])).rows[0]; if (!d) { a.status = "failed"; a.note = "document missing"; continue; } buf = await storage().get(d.storage_key); }
      const t = textOf(buf, a.mime); if (t.text == null) { a.status = t.reason ?? "unsupported"; a.note = t.reason === "password_required" || t.reason === "wrong_password" ? "PDF is password-protected — add the holder's PAN to INGEST_PDF_PASSWORDS or open it from Documents" : "no importer reads this file type"; continue; }
      if (!detect(t.text)) { a.status = "unrecognised"; a.note = "not a statement the importers recognise; kept in Documents"; continue; }
      const r = await runImport(c, familyId, userId, { text: t.text, filename: a.name }); a.import_job_id = r.body.id; a.status = r.body.status ?? (r.code < 300 ? "done" : "failed"); a.note = r.body.duplicate_of_previous_upload ? "already imported earlier" : r.body.errors?.[0]?.message ?? null;
    } catch (e: any) { a.status = "failed"; a.note = e instanceof DocError ? e.message : String(e.message).slice(0, 200); }
  }
  const status = !doImport ? row.status : atts.length === 0 ? "no_attachments" : atts.every((a) => a.status === "done") ? "imported" : atts.some((a) => a.status === "done") ? "partial" : "failed";
  const r = (await c.query("update email_ingest set attachments=$2, status=$3 where id=$1 returning *", [row.id, JSON.stringify(atts), status])).rows[0]; return r;
}
export const ingestView = (r: any) => ({ id: r.id, message_id: r.message_id, sender: r.sender, recipient: r.recipient, subject: r.subject, received_at: r.received_at, status: r.status, reason: r.reason, attachments: r.attachments ?? [], task_id: r.task_id, released_by: r.released_by, released_at: r.released_at, created_at: r.created_at });

/** Intake: resolve the family, decide allow / quarantine, store and import. Idempotent on message_id. */
export async function processInbound(mail: InboundMail) {
  if (!mail.from || !mail.to) throw new IngestError(422, "from and to are required");
  const fam = (await pool.query("select id, name, ingest_allow_senders, ingest_quarantine_unknown from family_by_ingest_address($1)", [mail.to])).rows[0]; if (!fam) throw new IngestError(404, `No family receives mail at ${mail.to}`);
  return withFamily(fam.id, async (c) => {
    if (mail.message_id) { const ex = (await c.query("select * from email_ingest where family_id=$1 and message_id=$2", [fam.id, mail.message_id])).rows[0]; if (ex) return { ...ingestView(ex), family_id: fam.id, duplicate: true }; }
    const allowed = await allowedSender(c, fam.id, mail.from, fam.ingest_allow_senders ?? []);
    const quarantine = !allowed && fam.ingest_quarantine_unknown !== false;
    const row = (await c.query("insert into email_ingest (family_id, message_id, sender, recipient, subject, received_at, status, reason) values ($1,$2,$3,$4,$5,coalesce($6::timestamptz, now()),$7,$8) returning *", [fam.id, mail.message_id ?? null, mail.from, mail.to, mail.subject ?? null, mail.received_at ?? null, quarantine ? "quarantined" : "accepted", quarantine ? "sender is not on the allow-list" : !allowed ? "unknown sender accepted (quarantine off)" : null])).rows[0];
    let out = await processAttachments(c, fam.id, row, mail, null, !quarantine);
    if (quarantine) { const t = (await c.query("insert into tasks (family_id, module, title, reason, severity, source_type, source_id, verification) values ($1,'imports',$2,$3,2,'email_ingest',$4,'na') returning *", [fam.id, `Quarantined e-mail from ${mail.from}${mail.subject ? ` — ${String(mail.subject).slice(0, 60)}` : ""}`, `${mail.attachments.length} attachment${mail.attachments.length === 1 ? "" : "s"} held; release it from Imports if the sender is genuine (optionally adding them to the allow-list)`, row.id])).rows[0]; out = (await c.query("update email_ingest set task_id=$2 where id=$1 returning *", [row.id, t.id])).rows[0]; await notifyTask(c, t).catch(() => null); }
    return { ...ingestView(out), family_id: fam.id, duplicate: false };
  });
}
/** A member releases a quarantined message: import its stored attachments and, if asked, trust the sender from now on. */
export async function releaseInbound(c: pg.PoolClient, familyId: string, id: string, userId: string, opts: { allow_sender?: boolean } = {}) {
  const row = (await c.query("select * from email_ingest where id=$1 and family_id=$2", [id, familyId])).rows[0]; if (!row) throw new IngestError(404, "Message not found");
  if (row.status !== "quarantined") throw new IngestError(409, `Message is ${row.status}`);
  const out = await processAttachments(c, familyId, { ...row, status: "accepted" }, null, userId, true);
  await c.query("update email_ingest set released_by=$2, released_at=now(), reason=null where id=$1", [id, userId]);
  if (opts.allow_sender) await c.query("update families set ingest_allow_senders = array(select distinct unnest(ingest_allow_senders || $2::text)) where id=$1", [familyId, row.sender.toLowerCase()]);
  if (row.task_id) await c.query("update tasks set status='done', done_at=now(), verification='verified' where id=$1 and status='open'", [row.task_id]);
  await c.query("insert into audit_log (family_id, user_id, action, table_name, row_id, after) values ($1,$2,'ingest.release','email_ingest',$3,$4)", [familyId, userId, id, JSON.stringify({ allow_sender: !!opts.allow_sender, status: out.status })]);
  return ingestView((await c.query("select * from email_ingest where id=$1", [id])).rows[0]);
}
export async function rejectInbound(c: pg.PoolClient, familyId: string, id: string, userId: string) {
  const row = (await c.query("select * from email_ingest where id=$1 and family_id=$2", [id, familyId])).rows[0]; if (!row) throw new IngestError(404, "Message not found");
  const r = (await c.query("update email_ingest set status='rejected', released_by=$2, released_at=now() where id=$1 returning *", [id, userId])).rows[0];
  if (row.task_id) await c.query("update tasks set status='dismissed', done_at=now() where id=$1 and status='open'", [row.task_id]);
  for (const a of row.attachments ?? []) if (a.document_id) await c.query("update documents set deleted_at=now() where id=$1 and deleted_at is null", [a.document_id]);
  return ingestView(r);
}
export async function ingestSettings(c: pg.PoolClient, familyId: string) {
  const f = (await c.query("select id, name, ingest_address, ingest_allow_senders, ingest_quarantine_unknown from families where id=$1", [familyId])).rows[0];
  if (!f.ingest_address) { const slug = String(f.name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""); const address = `${slug}-${familyId.slice(0, 6)}@${process.env.INGEST_DOMAIN ?? "ingest.familyoffice.local"}`; await c.query("update families set ingest_address=$2 where id=$1", [familyId, address]); f.ingest_address = address; }
  return { ingest_address: f.ingest_address, allow_senders: f.ingest_allow_senders ?? [], quarantine_unknown: f.ingest_quarantine_unknown !== false, note: "Forward statements to the ingest address from an allowed sender; unknown senders are held for review. Password-protected PDFs open with the passwords in INGEST_PDF_PASSWORDS." };
}
