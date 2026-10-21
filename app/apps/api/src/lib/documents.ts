/**
 * Documents (PRD 3.10, FO-100): a folder tree per family with system folders, objects in the store with server-side encryption, sha-256
 * de-duplication, a 25 MB / allow-listed MIME gate, optional virus scan (SCAN_COMMAND), extracted text for PDFs / CSV / TXT, and the
 * LLM-assisted extraction review queue — the deterministic parsers classify and extract offline; a model call (optional, PII-redacted) enriches
 * the result; nothing is written to the books until a person approves, and approval runs the ordinary import pipeline.
 */
import type pg from "pg";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detect, parseAny } from "@fo/parsers";
import { extractPdfText, PdfError } from "@fo/reports";
import { storage, safeName } from "./storage.js";
import { agentEnabled, agentModel, claudeJson } from "./agent.js";

export class DocError extends Error { constructor(public status: number, m: string, public extra?: any) { super(m); } }
export const MAX_DOC_BYTES = 25 * 1024 * 1024;
/** PRD 3.10: PDF / JPG / PNG / XLS(X) / DOCX, plus the text formats the importers and exports use. */
export const ALLOWED_MIME: Record<string, string> = { "application/pdf": "pdf", "image/jpeg": "jpg", "image/png": "png", "application/vnd.ms-excel": "xls", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx", "text/csv": "csv", "text/plain": "txt", "application/json": "json", "application/xml": "xml", "text/xml": "xml", "application/x-parquet": "parquet", "application/vnd.apache.parquet": "parquet" };
export const SYSTEM_FOLDERS = ["Property deeds & agreements", "Tax filings (ITR, GST)", "PMS / AIF statements", "Startup SHAs & term sheets", "Bank statements", "Insurance policies", "Wills & nominations", "CA correspondence", "Reports", "Exports", "Imports", "Research notes"];
const EXT_MIME: Record<string, string> = { pdf: "application/pdf", jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", xls: "application/vnd.ms-excel", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", csv: "text/csv", txt: "text/plain", json: "application/json", xml: "application/xml", parquet: "application/vnd.apache.parquet" };
/** The declared type is checked against the bytes for the formats with magic numbers; text types are accepted when the content is text. */
export function sniffMime(buf: Buffer, declared: string | undefined, filename: string): string {
  const ext = (filename.split(".").pop() ?? "").toLowerCase(); const head = buf.subarray(0, 8);
  if (head.subarray(0, 4).toString("latin1") === "%PDF") return "application/pdf";
  if (head[0] === 0xff && head[1] === 0xd8) return "image/jpeg";
  if (head[0] === 0x89 && head.subarray(1, 4).toString("latin1") === "PNG") return "image/png";
  if (head[0] === 0x50 && head[1] === 0x4b) return ext === "docx" ? EXT_MIME.docx : EXT_MIME.xlsx;   // zip container: xlsx / docx by extension
  if (head[0] === 0xd0 && head[1] === 0xcf) return EXT_MIME.xls;
  if (buf.subarray(0, 4).toString("latin1") === "PAR1") return EXT_MIME.parquet;
  const isText = !buf.subarray(0, 4096).some((b) => b === 0); if (!isText) throw new DocError(415, "Unsupported file type");
  const d = (declared ?? "").split(";")[0].trim().toLowerCase(); if (d && ALLOWED_MIME[d] && !["application/pdf", "image/jpeg", "image/png"].includes(d)) return d === "text/xml" ? "application/xml" : d;
  return EXT_MIME[ext] && !["pdf", "jpg", "jpeg", "png", "xlsx", "docx", "xls", "parquet"].includes(ext) ? EXT_MIME[ext] : ext === "csv" ? "text/csv" : "text/plain";
}
/** Optional virus scan: SCAN_COMMAND (e.g. `clamdscan --no-summary`) gets the file path; exit 0 clean, 1 infected. */
export function scan(buf: Buffer, name: string): "skipped" | "clean" | "infected" | "error" {
  const cmd = process.env.SCAN_COMMAND; if (!cmd) return "skipped"; const dir = mkdtempSync(join(tmpdir(), "fo-scan-")); const p = join(dir, safeName(name));
  try { writeFileSync(p, buf); const [bin, ...args] = cmd.split(/\s+/); execFileSync(bin, [...args, p], { stdio: "ignore", timeout: 60_000 }); return "clean"; } catch (e: any) { return e?.status === 1 ? "infected" : "error"; } finally { rmSync(dir, { recursive: true, force: true }); }
}
export function sha256(buf: Buffer) { return createHash("sha256").update(buf).digest("hex"); }
/** Text for extraction and search; a password-protected PDF comes back null with the reason so the caller can ask for the password. */
export function extractText(buf: Buffer, mime: string, password?: string): { text: string | null; reason?: string } {
  if (mime === "application/pdf") { try { return { text: extractPdfText(buf, password ?? "") }; } catch (e: any) { return { text: null, reason: e instanceof PdfError ? e.code : "invalid" }; } }
  if (mime.startsWith("text/") || mime === "application/json" || mime === "application/xml") return { text: buf.toString("utf8") };
  return { text: null, reason: "binary" };
}
/** Scanned PDFs and images (FO-28): OCR_COMMAND gets the file path and must print the text (e.g. `tesseract {in} stdout -l eng`, or
 *  `ocrmypdf --sidecar - {in} /dev/null`); `{in}` is replaced with the temp path, or the path is appended. Returns null when no OCR is
 *  configured or it fails, so callers can tag the document `needs-ocr` and try again later. */
export function ocrText(buf: Buffer, name: string): { text: string | null; reason?: string } {
  const cmd = process.env.OCR_COMMAND; if (!cmd) return { text: null, reason: "ocr_not_configured" };
  const dir = mkdtempSync(join(tmpdir(), "fo-ocr-")); const p = join(dir, safeName(name));
  try { writeFileSync(p, buf); const parts = cmd.split(/\s+/); const [bin, ...args] = parts.some((a) => a.includes("{in}")) ? parts.map((a) => a.replace("{in}", p)) : [...parts, p];
    const out = execFileSync(bin, args, { encoding: "utf8", timeout: Number(process.env.OCR_TIMEOUT_MS ?? 120_000), maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] }); const text = out.replace(/\f/g, "\n").trim(); return text ? { text } : { text: null, reason: "ocr_empty" }; }
  catch (e: any) { return { text: null, reason: e?.code === "ETIMEDOUT" ? "ocr_timeout" : "ocr_failed" }; } finally { rmSync(dir, { recursive: true, force: true }); }
}
export const needsOcr = (text: string | null, mime: string) => (mime === "application/pdf" && (text == null || text.trim().length < 20)) || mime.startsWith("image/");
export async function systemFolder(c: pg.PoolClient, familyId: string, name: string): Promise<string> {
  const f = (await c.query("select id from folders where family_id=$1 and parent_id is null and name=$2", [familyId, name])).rows[0]; if (f) return f.id;
  return (await c.query("insert into folders (family_id, name, system) values ($1,$2,true) returning id", [familyId, name])).rows[0].id;
}
export async function folderTree(c: pg.PoolClient, familyId: string) {
  return (await c.query(`select f.id, f.name, f.parent_id, f.system, f.entity_id, (select count(*) from documents d where d.folder_id=f.id and d.deleted_at is null)::int count from folders f where f.family_id=$1 order by f.system desc, f.name`, [familyId])).rows;
}
export interface StoreInput { familyId: string; entityId?: string | null; folderId?: string | null; folderName?: string; name: string; mime?: string; buffer: Buffer; uploadedBy?: string | null; linked?: { type: string; id: string } | null; source?: string; docType?: string | null; tags?: string[]; text?: string | null; reportCode?: string | null; params?: any; expiresAt?: Date | null; password?: string }
/** Store a document: gate → scan → object → row → text. The same bytes uploaded twice return the existing document (`duplicate: true`). */
export async function storeDocument(c: pg.PoolClient, i: StoreInput): Promise<{ doc: any; duplicate: boolean }> {
  if (i.buffer.length > MAX_DOC_BYTES) throw new DocError(413, "File too large (25 MB limit)"); if (!i.buffer.length) throw new DocError(422, "Empty file");
  const mime = sniffMime(i.buffer, i.mime, i.name); if (!ALLOWED_MIME[mime]) throw new DocError(415, `Unsupported file type ${mime}`);
  const sha = sha256(i.buffer); const source = i.source ?? "upload";
  if (source === "upload") { const dup = (await c.query("select * from documents where family_id=$1 and sha256=$2 and deleted_at is null and source='upload' limit 1", [i.familyId, sha])).rows[0]; if (dup) return { doc: dup, duplicate: true }; }
  const scanStatus = scan(i.buffer, i.name); if (scanStatus === "infected") throw new DocError(422, "The file failed the virus scan and was not stored");
  const folderId = i.folderId ?? (i.folderName ? await systemFolder(c, i.familyId, i.folderName) : null);
  const id = (await c.query("select gen_random_uuid() id")).rows[0].id; const now = new Date(); const key = `${i.familyId}/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, "0")}/${id}-${safeName(i.name)}`;
  await storage().put(key, i.buffer, mime);
  let text = i.text ?? null; let tags = [...(i.tags ?? [])];
  if (text == null) { const t = extractText(i.buffer, mime, i.password); text = t.text; if (t.reason === "password_required") tags.push("password-protected"); if (t.reason === "wrong_password") tags.push("wrong-password");
    if (!tags.includes("password-protected") && !tags.includes("wrong-password") && needsOcr(text, mime)) { const o = ocrText(i.buffer, i.name); if (o.text) { text = o.text; tags.push("ocr"); } else tags.push("needs-ocr"); } }   // scanned PDF / image: OCR when configured, else flagged for later
  const row = (await c.query(`insert into documents (id, family_id, entity_id, folder_id, name, mime, size, storage_key, sha256, uploaded_by, linked_type, linked_id, doc_type, source, text, tags, scan_status, report_code, params, expires_at)
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) returning *`,
    [id, i.familyId, i.entityId ?? null, folderId, i.name, mime, i.buffer.length, key, sha, i.uploadedBy ?? null, i.linked?.type ?? null, i.linked?.id ?? null, i.docType ?? null, source, text, tags, scanStatus, i.reportCode ?? null, i.params ? JSON.stringify(i.params) : null, i.expiresAt ?? null])).rows[0];
  return { doc: row, duplicate: false };
}
export async function documentView(row: any, opts: { url?: boolean; ttl?: number } = { url: true }) {
  const { text, ...rest } = row; const url = opts.url === false ? undefined : await storage().signedGetUrl(row.storage_key, { ttlSeconds: opts.ttl ?? 900, filename: row.name, mime: row.mime });
  return { ...rest, size: Number(row.size), has_text: !!text, text_chars: text ? text.length : 0, url, folder_name: row.folder_name, entity_name: row.entity_name };
}
export async function getDocument(c: pg.PoolClient, familyId: string, id: string) {
  const d = (await c.query("select d.*, f.name folder_name, e.name entity_name from documents d left join folders f on f.id=d.folder_id left join entities e on e.id=d.entity_id where d.id=$1 and d.family_id=$2 and d.deleted_at is null", [id, familyId])).rows[0];
  if (!d) throw new DocError(404, "Document not found"); return d;
}
export async function listDocuments(c: pg.PoolClient, familyId: string, q: { folder_id?: string; linked_type?: string; linked_id?: string; entity_id?: string; source?: string; doc_type?: string; q?: string; limit?: number }) {
  return (await c.query(`select d.*, f.name folder_name, e.name entity_name from documents d left join folders f on f.id=d.folder_id left join entities e on e.id=d.entity_id
    where d.family_id=$1 and d.deleted_at is null and ($2::uuid is null or d.folder_id=$2) and ($3::text is null or d.linked_type=$3) and ($4::uuid is null or d.linked_id=$4) and ($5::uuid is null or d.entity_id=$5) and ($6::text is null or d.source=$6) and ($7::text is null or d.doc_type=$7)
      and ($8::text is null or d.name ilike '%'||$8||'%' or d.text ilike '%'||$8||'%' or $8 = any(d.tags))
    order by d.created_at desc limit $9`, [familyId, q.folder_id ?? null, q.linked_type ?? null, q.linked_id ?? null, q.entity_id ?? null, q.source ?? null, q.doc_type ?? null, q.q ?? null, Math.min(q.limit ?? 200, 500)])).rows;
}
export async function deleteDocument(c: pg.PoolClient, familyId: string, id: string, userId: string | null) {
  const d = await getDocument(c, familyId, id); await c.query("update documents set deleted_at=now(), updated_at=now() where id=$1", [id]);
  await c.query("insert into audit_log (family_id, user_id, action, table_name, row_id, before) values ($1,$2,'delete','documents',$3,$4)", [familyId, userId, id, JSON.stringify({ name: d.name, storage_key: d.storage_key })]);
  await storage().delete(d.storage_key).catch(() => null); return d;
}
/** Purge expired temporary objects (exports) — worker housekeeping. */
export async function purgeExpired(c: pg.PoolClient, familyId: string) {
  const rows = (await c.query("select id, storage_key from documents where family_id=$1 and deleted_at is null and expires_at < now()", [familyId])).rows;
  for (const r of rows) { await storage().delete(r.storage_key).catch(() => null); await c.query("update documents set deleted_at=now() where id=$1", [r.id]); }
  return rows.length;
}

// ---------- extraction (FO-100) ----------
/** Mask PAN, Aadhaar, long account numbers, e-mail addresses and phone numbers before any text leaves the platform. */
export function redactPii(text: string): { text: string; count: number } {
  let count = 0; const sub = (re: RegExp, f: (m: string) => string) => { text = text.replace(re, (m) => { count++; return f(m); }); };
  sub(/\b[A-Z]{5}\d{4}[A-Z]\b/g, (m) => m.slice(0, 2) + "XXX" + "XXXX" + m.slice(-1));
  sub(/\b\d{9,18}\b/g, (m) => "X".repeat(m.length - 4) + m.slice(-4));            // account numbers (and unspaced Aadhaar): keep the last four
  sub(/\b\d{4}\s\d{4}\s\d{4}\b/g, () => "XXXX XXXX XXXX");
  sub(/[\w.+-]+@[\w-]+\.[\w.]+/g, () => "[email]");
  sub(/(?<!\d)(?:\+91[\s-]?)?[6-9]\d{4}[\s-]?\d{5}(?!\d)/g, () => "[phone]");
  return { text, count };
}
const money = (s: string) => Number(s.replace(/[,\s]/g, "")); const MONEY_RE = /(?:₹|Rs\.?|INR)\s*([\d,]+(?:\.\d+)?)(\s*(?:lakh|lac|crore|cr|L)\b)?/i;
const findAmount = (t: string) => { const m = t.match(MONEY_RE); if (!m) return null; let v = money(m[1]); const u = (m[2] ?? "").trim().toLowerCase(); if (u.startsWith("l")) v *= 1e5; if (u.startsWith("cr")) v *= 1e7; return v; };
const findDate = (t: string, label: RegExp) => { const m = t.match(new RegExp("(?:" + label.source + ")" + String.raw`[^\n]{0,20}?(\d{1,2}[\s/-](?:[A-Za-z]{3,9}|\d{1,2})[\s/-]\d{2,4}|\d{4}-\d{2}-\d{2})`, "i")); if (!m) return null; const d = new Date(m[1].replace(/(\d{1,2})[\s/-]([A-Za-z]{3,9})[\s/-](\d{2,4})/, "$2 $1, $3")); return Number.isNaN(d.getTime()) ? m[1] : d.toISOString().slice(0, 10); };
export interface Classification { doc_type: string; source_kind: string | null; confidence: number; summary: string; extracted: Record<string, any> }
/** Deterministic classification: the importers' detectors first, then document-specific cues. */
export function classifyDocument(text: string | null, name: string, mime: string): Classification {
  if (!text || !text.trim()) return { doc_type: mime.startsWith("image/") ? "image" : "other", source_kind: null, confidence: 0.2, summary: "No text could be read; needs manual review", extracted: {} };
  const kind = detect(text);
  if (kind) {
    const { result } = parseAny(text); const rows: any[] = (result as any)?.rows ?? []; const errors = (result as any)?.errors ?? []; const docType = kind === "cas" ? "cas" : kind === "zerodha" ? "contract_note" : kind === "bank_csv" ? "bank_statement" : kind === "form26as" ? "form26as" : "bank_statement";
    const conf = rows.length ? Math.max(0.6, Math.min(0.99, 0.95 - errors.length / Math.max(1, rows.length + errors.length))) : 0.55;
    return { doc_type: docType, source_kind: kind, confidence: Number(conf.toFixed(3)), summary: `${docType.replace(/_/g, " ")} (${(result as any)?.provider ?? kind}): ${rows.length} rows parsed${errors.length ? `, ${errors.length} rows with errors` : ""}`, extracted: { provider: (result as any)?.provider, rows: rows.length, errors: errors.length, sample: rows.slice(0, 5) } };
  }
  const t = text;
  if (/capital call|drawdown notice|call notice|contribution notice/i.test(t)) { const amount = findAmount(t); const due = findDate(t, /due (?:date|on|by)|payable (?:on|by)|last date/); const fund = t.match(/(?:fund|scheme)[:\s]+([A-Z][\w &.-]{3,60})/i)?.[1]?.trim() ?? t.split("\n").find((l) => /fund/i.test(l))?.trim() ?? null; const conf = Math.min(0.85, (amount ? 0.45 : 0) + (due ? 0.3 : 0) + (fund ? 0.2 : 0) + 0.05); /* capped: a call notice always gets a human look before it becomes a task */ return { doc_type: "capital_call", source_kind: null, confidence: Number(conf.toFixed(3)), summary: `Capital call${fund ? ` from ${fund}` : ""}${amount ? ` for Rs. ${amount.toLocaleString("en-IN")}` : ""}${due ? ` due ${due}` : ""}`, extracted: { fund, amount, due_date: due, call_ref: t.match(/(?:ref(?:erence)?|notice)\s*(?:no\.?|#|:)\s*([\w/-]+)/i)?.[1] ?? null } }; }
  if (/premium|policy (?:no|number)|sum assured/i.test(t)) { const premium = findAmount(t); const due = findDate(t, /premium due|due date|next premium/); return { doc_type: "insurance", source_kind: null, confidence: premium ? 0.75 : 0.5, summary: `Insurance document${premium ? `, premium Rs. ${premium.toLocaleString("en-IN")}` : ""}${due ? ` due ${due}` : ""}`, extracted: { premium, due_date: due, insurer: t.match(/([A-Z][\w& ]{2,40}(?:Life|General|Insurance|Assurance)[\w ]{0,20})/)?.[1] ?? null, policy_no_masked: t.match(/policy (?:no\.?|number)[:\s]*([\w-]+)/i)?.[1]?.replace(/.(?=.{4})/g, "•") ?? null } }; }
  if (/\bEMI\b|loan account|outstanding principal|amortis/i.test(t)) { const emi = findAmount(t); return { doc_type: "loan_statement", source_kind: null, confidence: emi ? 0.7 : 0.5, summary: `Loan statement${emi ? `, EMI Rs. ${emi.toLocaleString("en-IN")}` : ""}`, extracted: { emi, lender: t.match(/([A-Z][\w ]{2,30}(?:Bank|Finance|Housing|HFC))/)?.[1] ?? null } }; }
  if (/investment policy statement/i.test(t)) return { doc_type: "ips", source_kind: null, confidence: 0.8, summary: "Investment Policy Statement", extracted: {} };
  if (/net asset value|NAV statement|portfolio statement|PMS/i.test(t)) return { doc_type: "nav_statement", source_kind: null, confidence: 0.6, summary: "Portfolio / NAV statement (no importer for this layout yet — use the mapping assistant)", extracted: {} };
  return { doc_type: "other", source_kind: null, confidence: 0.3, summary: "Unrecognised document; needs manual review", extracted: {} };
}
const AUTO_THRESHOLD = () => Number(process.env.EXTRACTION_AUTO_THRESHOLD ?? 0.9);
/** Run extraction for a document into the review queue. The optional model call sees redacted text only and cannot lower the deterministic confidence. */
export async function extractDocument(c: pg.PoolClient, familyId: string, docId: string, opts: { userId?: string | null; password?: string; allowUnreadable?: boolean } = {}) {
  const d = await getDocument(c, familyId, docId); let text = d.text as string | null;
  if (text == null && opts.password && d.mime === "application/pdf") { const buf = await storage().get(d.storage_key); const t = extractText(buf, d.mime, opts.password); if (t.reason === "wrong_password") throw new DocError(422, "The password does not open this PDF"); text = t.text; if (text != null) await c.query("update documents set text=$2, tags=array_remove(tags,'password-protected'), updated_at=now() where id=$1", [docId, text]); }
  if (text == null && (d.tags ?? []).includes("password-protected")) throw new DocError(422, "This PDF needs a password (the holder's PAN for CAS statements)", { code: "password_required" });
  if ((d.tags ?? []).includes("needs-ocr") && (text == null || text.trim().length < 20)) { const buf = await storage().get(d.storage_key); const o = ocrText(buf, d.name); if (o.text) { text = o.text; await c.query("update documents set text=$2, tags=array_remove(tags,'needs-ocr') || '{ocr}', updated_at=now() where id=$1", [docId, text]); } else if (!opts.allowUnreadable) throw new DocError(422, o.reason === "ocr_not_configured" ? "This document is scanned: set OCR_COMMAND (e.g. tesseract) to read it" : `OCR did not read this document (${o.reason})`, { code: "needs_ocr", reason: o.reason }); }
  const cls = classifyDocument(text, d.name, d.mime); let model = "heuristic-v1"; let redactions = 0; let extracted = cls.extracted; let summary = cls.summary; let confidence = cls.confidence;
  if (agentEnabled() && text) {
    const red = redactPii(text.slice(0, 12000)); redactions = red.count; model = agentModel();
    const out = await claudeJson<{ doc_type?: string; summary?: string; fields?: Record<string, any>; confidence?: number }>("You classify family-office documents (cas, contract_note, bank_statement, form26as, capital_call, insurance, loan_statement, nav_statement, ips, other) and extract the key fields as JSON {doc_type, summary, fields, confidence}. Personal identifiers are already masked; never guess them.", `Filename: ${d.name}\n\n${red.text}`).catch(() => null);
    if (out) { extracted = { ...extracted, ...(out.fields ?? {}), agent: { doc_type: out.doc_type, confidence: out.confidence } }; if (out.summary) summary = out.summary; if (cls.doc_type === "other" && out.doc_type) { cls.doc_type = out.doc_type; confidence = Math.min(0.85, Number(out.confidence ?? 0.6)); } }
  }
  const status = confidence >= AUTO_THRESHOLD() ? "extracted" : "needs_review";
  const row = (await c.query(`insert into document_extractions (family_id, document_id, doc_type, model, extracted, confidence, status, summary, redactions, source_kind) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning *`,
    [familyId, docId, cls.doc_type, model, JSON.stringify(extracted), confidence, status, summary, redactions, cls.source_kind])).rows[0];
  await c.query("update documents set doc_type=coalesce(doc_type,$2), updated_at=now() where id=$1", [docId, cls.doc_type]);
  return row;
}
export async function listExtractions(c: pg.PoolClient, familyId: string, status?: string) {
  return (await c.query(`select x.*, d.name document_name, d.mime, d.entity_id, u.name reviewed_by_name from document_extractions x join documents d on d.id=x.document_id left join users u on u.id=x.reviewed_by where x.family_id=$1 and ($2::text is null or x.status::text=$2) order by x.created_at desc limit 200`, [familyId, status ?? null])).rows;
}
