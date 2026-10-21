/** Delivery adapters (FO-56, PRD 3.8): e-mail through SES (SigV4 over the v2 API) or any SMTP server (own client: STARTTLS / implicit TLS, AUTH PLAIN
 *  or LOGIN), WhatsApp through the Meta Cloud API or a BSP (Gupshup), SMS through MSG91 or Twilio. Every send lands in `message_log`; without
 *  credentials the transports log, so development never loses a message silently. The rent-reminder queue drains through here. */
import net from "node:net";
import tls from "node:tls";
import { createHash, randomUUID } from "node:crypto";
import { pool, withFamily } from "./db.js";
import { sigv4Headers } from "./storage.js";
import { setSenders } from "./notify.js";

export type Channel = "email" | "whatsapp" | "sms";
export interface Message { channel: Channel; to: string; subject?: string; text: string; html?: string; template?: string; params?: Record<string, string>; familyId?: string | null; refType?: string | null; refId?: string | null }
export interface SendResult { ok: boolean; provider: string; ref?: string | null; error?: string | null }
export interface Transport { name: string; send(m: Message): Promise<SendResult> }
type FetchFn = (url: string, init?: any) => Promise<{ ok: boolean; status: number; json(): Promise<any>; text(): Promise<string> }>;
let fetchFn: FetchFn = fetch as any;
/** Tests inject a fetch; production uses the global one. */
export function setDeliveryFetch(f: FetchFn | null) { fetchFn = f ?? (fetch as any); }
const quiet = () => process.env.LOG_LEVEL === "silent";
export const phone = (s: string) => { const d = s.replace(/[^\d+]/g, "").replace(/^\+/, ""); return d.length === 10 ? `91${d}` : d.replace(/^0+/, ""); };
const sha256hex = (s: string) => createHash("sha256").update(s).digest("hex");

// ---------- e-mail ----------
export const logTransport = (channel: Channel): Transport => ({ name: "log", async send(m) { if (!quiet()) console.log(`[${channel}] to=${m.to}${m.subject ? ` subject="${m.subject}"` : ""} ${m.text.slice(0, 80).replace(/\n/g, " ")}`); return { ok: true, provider: "log", ref: null }; } });

/** Amazon SES v2 `SendEmail`, header-signed with the same SigV4 code that signs S3 requests. */
export function sesTransport(): Transport {
  return { name: "ses", async send(m) {
    const region = process.env.AWS_REGION ?? process.env.SES_REGION ?? "ap-south-1"; const accessKey = process.env.AWS_ACCESS_KEY_ID ?? process.env.SES_ACCESS_KEY, secretKey = process.env.AWS_SECRET_ACCESS_KEY ?? process.env.SES_SECRET_KEY;
    if (!accessKey || !secretKey) return { ok: false, provider: "ses", error: "AWS credentials are not configured" };
    const url = process.env.SES_ENDPOINT ?? `https://email.${region}.amazonaws.com/v2/email/outbound-emails`;
    const body = JSON.stringify({ FromEmailAddress: process.env.MAIL_FROM ?? "noreply@familyoffice.local", Destination: { ToAddresses: [m.to] }, Content: { Simple: { Subject: { Data: m.subject ?? "(no subject)", Charset: "UTF-8" }, Body: { Text: { Data: m.text, Charset: "UTF-8" }, ...(m.html ? { Html: { Data: m.html, Charset: "UTF-8" } } : {}) } } }, ...(process.env.SES_CONFIGURATION_SET ? { ConfigurationSetName: process.env.SES_CONFIGURATION_SET } : {}) });
    const headers = sigv4Headers({ method: "POST", url, headers: { "content-type": "application/json" }, payloadHash: sha256hex(body), accessKey, secretKey, region, service: "ses", sessionToken: process.env.AWS_SESSION_TOKEN });
    try { const r = await fetchFn(url, { method: "POST", headers, body }); const j: any = await r.json().catch(() => ({})); return r.ok ? { ok: true, provider: "ses", ref: j.MessageId ?? null } : { ok: false, provider: "ses", error: `HTTP ${r.status} ${j.message ?? j.Message ?? ""}`.trim() }; }
    catch (e: any) { return { ok: false, provider: "ses", error: e.message }; }
  } };
}

/** A small SMTP client: greeting → EHLO → STARTTLS when offered (or implicit TLS on 465) → AUTH PLAIN / LOGIN → MAIL / RCPT / DATA → QUIT. */
export interface SmtpOptions { host: string; port?: number; secure?: boolean; user?: string; pass?: string; from: string; to: string; subject: string; text: string; html?: string; timeoutMs?: number; startTls?: boolean; rejectUnauthorized?: boolean }
export function buildMime(o: { from: string; to: string; subject: string; text: string; html?: string; messageId?: string }): string {
  const enc = (s: string) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, "utf8").toString("base64")}?=`);
  const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64").replace(/(.{76})/g, "$1\r\n");
  const id = o.messageId ?? `<${randomUUID()}@${(o.from.split("@")[1] ?? "familyoffice").replace(/>$/, "")}>`;
  const head = [`From: ${o.from}`, `To: ${o.to}`, `Subject: ${enc(o.subject)}`, `Date: ${new Date().toUTCString()}`, `Message-ID: ${id}`, "MIME-Version: 1.0"];
  if (!o.html) return [...head, "Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: base64", "", b64(o.text)].join("\r\n");
  const boundary = `----=_wp_${randomUUID().slice(0, 12)}`;
  return [...head, `Content-Type: multipart/alternative; boundary="${boundary}"`, "", `--${boundary}`, "Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: base64", "", b64(o.text), `--${boundary}`, "Content-Type: text/html; charset=utf-8", "Content-Transfer-Encoding: base64", "", b64(o.html), `--${boundary}--`, ""].join("\r\n");
}
export async function smtpSend(o: SmtpOptions): Promise<SendResult> {
  const port = o.port ?? (o.secure ? 465 : 587); const timeoutMs = o.timeoutMs ?? 20_000;
  return new Promise<SendResult>((resolve) => {
    let sock: net.Socket | tls.TLSSocket; let buf = ""; let done = false; const waiters: { resolve: (r: { code: number; lines: string[] }) => void; reject: (e: Error) => void }[] = [];
    const finish = (r: SendResult) => { if (done) return; done = true; try { sock.destroy(); } catch { /* closed */ } resolve(r); };
    const timer = setTimeout(() => finish({ ok: false, provider: "smtp", error: "SMTP timeout" }), timeoutMs);
    const onData = (d: Buffer) => { buf += d.toString("utf8"); let idx: number; const lines: string[] = [];
      while ((idx = buf.indexOf("\r\n")) >= 0) { const line = buf.slice(0, idx); buf = buf.slice(idx + 2); lines.push(line); if (/^\d{3} /.test(line) || /^\d{3}$/.test(line)) { const w = waiters.shift(); const code = Number(line.slice(0, 3)); w?.resolve({ code, lines: lines.splice(0) }); } } };
    const reply = () => new Promise<{ code: number; lines: string[] }>((res, rej) => waiters.push({ resolve: res, reject: rej }));
    const cmd = async (line: string | null, ...okCodes: number[]) => { if (line !== null) sock.write(line + "\r\n"); const r = await reply(); if (!okCodes.includes(r.code)) throw new Error(`${line?.split(" ")[0] ?? "greeting"} → ${r.lines.join(" ")}`); return r; };
    const attach = (s: net.Socket | tls.TLSSocket) => { sock = s; s.on("data", onData); s.on("error", (e) => finish({ ok: false, provider: "smtp", error: e.message })); s.on("close", () => { if (!done) finish({ ok: false, provider: "smtp", error: "connection closed" }); }); };
    const session = async () => {
      await cmd(null, 220);
      let ehlo = await cmd(`EHLO ${process.env.SMTP_EHLO ?? "wealthprism.local"}`, 250);
      if (!o.secure && (o.startTls ?? true) && ehlo.lines.some((l) => /STARTTLS/i.test(l))) {
        await cmd("STARTTLS", 220); sock.removeAllListeners("data"); sock.removeAllListeners("close");
        const t = tls.connect({ socket: sock, servername: o.host, rejectUnauthorized: o.rejectUnauthorized ?? process.env.SMTP_REJECT_UNAUTHORIZED !== "false" }); await new Promise<void>((res, rej) => { t.once("secureConnect", () => res()); t.once("error", rej); }); attach(t);
        ehlo = await cmd(`EHLO ${process.env.SMTP_EHLO ?? "wealthprism.local"}`, 250);
      }
      if (o.user) {
        const auth = ehlo.lines.find((l) => /^250[- ]AUTH/i.test(l)) ?? "";
        if (/PLAIN/i.test(auth) || !/LOGIN/i.test(auth)) await cmd(`AUTH PLAIN ${Buffer.from(`\0${o.user}\0${o.pass ?? ""}`, "utf8").toString("base64")}`, 235);
        else { await cmd("AUTH LOGIN", 334); await cmd(Buffer.from(o.user).toString("base64"), 334); await cmd(Buffer.from(o.pass ?? "").toString("base64"), 235); }
      }
      await cmd(`MAIL FROM:<${o.from.replace(/^.*<|>.*$/g, "")}>`, 250); await cmd(`RCPT TO:<${o.to.replace(/^.*<|>.*$/g, "")}>`, 250, 251); await cmd("DATA", 354);
      const data = buildMime(o).replace(/\r?\n\./g, "\r\n.."); const r = await cmd(`${data}\r\n.`, 250);
      await cmd("QUIT", 221).catch(() => null); clearTimeout(timer); finish({ ok: true, provider: "smtp", ref: r.lines.join(" ").replace(/^250 /, "") });
    };
    const start = (s: net.Socket | tls.TLSSocket) => { attach(s); session().catch((e) => { clearTimeout(timer); finish({ ok: false, provider: "smtp", error: e.message }); }); };
    if (o.secure) start(tls.connect({ host: o.host, port, servername: o.host, rejectUnauthorized: o.rejectUnauthorized ?? process.env.SMTP_REJECT_UNAUTHORIZED !== "false" }));
    else start(net.connect({ host: o.host, port }));
  });
}
export function smtpTransport(): Transport {
  return { name: "smtp", async send(m) {
    if (!process.env.SMTP_HOST) return { ok: false, provider: "smtp", error: "SMTP_HOST is not configured" };
    return smtpSend({ host: process.env.SMTP_HOST, port: Number(process.env.SMTP_PORT ?? (process.env.SMTP_SECURE === "true" ? 465 : 587)), secure: process.env.SMTP_SECURE === "true", user: process.env.SMTP_USER || undefined, pass: process.env.SMTP_PASS || undefined, from: process.env.MAIL_FROM ?? "noreply@familyoffice.local", to: m.to, subject: m.subject ?? "(no subject)", text: m.text, html: m.html, startTls: process.env.SMTP_STARTTLS !== "false" });
  } };
}

// ---------- WhatsApp and SMS ----------
export function whatsappTransport(provider = process.env.WHATSAPP_PROVIDER ?? process.env.WHATSAPP_BSP ?? "log"): Transport {
  if (provider === "meta") return { name: "whatsapp:meta", async send(m) {
    const token = process.env.WHATSAPP_TOKEN, phoneId = process.env.WHATSAPP_PHONE_ID; if (!token || !phoneId) return { ok: false, provider: "whatsapp:meta", error: "WHATSAPP_TOKEN / WHATSAPP_PHONE_ID are not configured" };
    const body = m.template ? { messaging_product: "whatsapp", to: phone(m.to), type: "template", template: { name: m.template, language: { code: process.env.WHATSAPP_LANG ?? "en" }, components: [{ type: "body", parameters: Object.values(m.params ?? { text: m.text }).map((text) => ({ type: "text", text })) }] } } : { messaging_product: "whatsapp", to: phone(m.to), type: "text", text: { preview_url: false, body: m.text } };
    try { const r = await fetchFn(`${(process.env.WHATSAPP_API_URL ?? "https://graph.facebook.com/v19.0").replace(/\/$/, "")}/${phoneId}/messages`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) }); const j: any = await r.json().catch(() => ({})); return r.ok ? { ok: true, provider: "whatsapp:meta", ref: j.messages?.[0]?.id ?? null } : { ok: false, provider: "whatsapp:meta", error: `HTTP ${r.status} ${j.error?.message ?? ""}`.trim() }; }
    catch (e: any) { return { ok: false, provider: "whatsapp:meta", error: e.message }; }
  } };
  if (provider === "gupshup") return { name: "whatsapp:gupshup", async send(m) {
    const key = process.env.WHATSAPP_BSP_KEY ?? process.env.GUPSHUP_API_KEY, source = process.env.WHATSAPP_SOURCE; if (!key || !source) return { ok: false, provider: "whatsapp:gupshup", error: "WHATSAPP_BSP_KEY / WHATSAPP_SOURCE are not configured" };
    const form = new URLSearchParams({ channel: "whatsapp", source, destination: phone(m.to), "src.name": process.env.WHATSAPP_APP ?? "WealthPrism", message: JSON.stringify(m.template ? { type: "text", text: m.text } : { type: "text", text: m.text }) });
    try { const r = await fetchFn(process.env.GUPSHUP_URL ?? "https://api.gupshup.io/wa/api/v1/msg", { method: "POST", headers: { apikey: key, "content-type": "application/x-www-form-urlencoded" }, body: form.toString() }); const j: any = await r.json().catch(() => ({})); return r.ok && j.status !== "error" ? { ok: true, provider: "whatsapp:gupshup", ref: j.messageId ?? null } : { ok: false, provider: "whatsapp:gupshup", error: `HTTP ${r.status} ${j.message ?? ""}`.trim() }; }
    catch (e: any) { return { ok: false, provider: "whatsapp:gupshup", error: e.message }; }
  } };
  return logTransport("whatsapp");
}
export function smsTransport(provider = process.env.SMS_PROVIDER ?? "log"): Transport {
  if (provider === "msg91") return { name: "sms:msg91", async send(m) {
    const key = process.env.MSG91_AUTHKEY; if (!key) return { ok: false, provider: "sms:msg91", error: "MSG91_AUTHKEY is not configured" };
    const body = process.env.MSG91_TEMPLATE_ID ? { template_id: process.env.MSG91_TEMPLATE_ID, short_url: "0", recipients: [{ mobiles: phone(m.to), ...(m.params ?? { message: m.text }) }] } : { sender: process.env.MSG91_SENDER ?? "WLTHPR", route: "4", country: "91", sms: [{ message: m.text, to: [phone(m.to)] }] };
    try { const r = await fetchFn(process.env.MSG91_URL ?? (process.env.MSG91_TEMPLATE_ID ? "https://control.msg91.com/api/v5/flow/" : "https://api.msg91.com/api/v2/sendsms"), { method: "POST", headers: { authkey: key, "content-type": "application/json" }, body: JSON.stringify(body) }); const j: any = await r.json().catch(() => ({})); return r.ok && j.type !== "error" ? { ok: true, provider: "sms:msg91", ref: j.message ?? j.request_id ?? null } : { ok: false, provider: "sms:msg91", error: `HTTP ${r.status} ${j.message ?? ""}`.trim() }; }
    catch (e: any) { return { ok: false, provider: "sms:msg91", error: e.message }; }
  } };
  if (provider === "twilio") return { name: "sms:twilio", async send(m) {
    const sid = process.env.TWILIO_ACCOUNT_SID, tok = process.env.TWILIO_AUTH_TOKEN, from = process.env.TWILIO_FROM; if (!sid || !tok || !from) return { ok: false, provider: "sms:twilio", error: "TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_FROM are not configured" };
    const form = new URLSearchParams({ To: `+${phone(m.to)}`, From: from, Body: m.text });
    try { const r = await fetchFn(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, { method: "POST", headers: { authorization: `Basic ${Buffer.from(`${sid}:${tok}`).toString("base64")}`, "content-type": "application/x-www-form-urlencoded" }, body: form.toString() }); const j: any = await r.json().catch(() => ({})); return r.ok ? { ok: true, provider: "sms:twilio", ref: j.sid ?? null } : { ok: false, provider: "sms:twilio", error: `HTTP ${r.status} ${j.message ?? ""}`.trim() }; }
    catch (e: any) { return { ok: false, provider: "sms:twilio", error: e.message }; }
  } };
  return logTransport("sms");
}
export function emailTransport(kind = process.env.EMAIL_TRANSPORT ?? "log"): Transport { return kind === "ses" ? sesTransport() : kind === "smtp" ? smtpTransport() : logTransport("email"); }

// ---------- dispatch ----------
const overrides: Partial<Record<Channel, Transport>> = {};
/** Tests pin a transport per channel; `null` clears. */
export function setTransports(t: Partial<Record<Channel, Transport | null>>) { for (const [k, v] of Object.entries(t)) { if (v) overrides[k as Channel] = v; else delete overrides[k as Channel]; } }
export const transportFor = (ch: Channel): Transport => overrides[ch] ?? (ch === "email" ? emailTransport() : ch === "whatsapp" ? whatsappTransport() : smsTransport());
/** Send one message and record it (family-scoped when the message belongs to a family). */
export async function deliver(m: Message): Promise<SendResult> {
  const t = transportFor(m.channel); let r: SendResult;
  try { r = await t.send(m); } catch (e: any) { r = { ok: false, provider: t.name, error: e.message }; }
  const row = [m.familyId ?? null, m.channel, m.to, m.subject ?? null, r.provider, r.ref ?? null, r.ok ? (r.provider === "log" ? "logged" : "sent") : "failed", r.error ?? null, m.refType ?? null, m.refId ?? null];
  const sql = "insert into message_log (family_id, channel, to_contact, subject, provider, provider_ref, status, error, ref_type, ref_id) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)";
  try { if (m.familyId) await withFamily(m.familyId, (c) => c.query(sql, row)); else await pool.query(sql, row); } catch (e: any) { if (!quiet()) console.error("message_log", e.message); }
  return r;
}
/** Route notify's e-mail through the configured transport (digests, report links, invitations). Idempotent; called at API and worker start. */
export function installDelivery() { setSenders({ email: async (to, subject, text) => (await deliver({ channel: "email", to, subject, text })).ok }); }

/** Drain the rent-reminder queue: send by channel, keep the provider reference, back off 5 / 30 / 120 minutes and give up after three attempts. */
const BACKOFF_MIN = [5, 30, 120];
export async function dispatchReminders(opts: { familyId?: string; limit?: number } = {}) {
  const fams = opts.familyId ? [{ id: opts.familyId }] : (await pool.query("select id from families")).rows; let sent = 0, failed = 0, retry = 0;
  for (const f of fams) {
    await withFamily(f.id, async (c) => {
      const due = (await c.query("select r.*, rs.period_month, p.name property, t.name tenant from rent_reminders r join rent_schedule rs on rs.id=r.rent_schedule_id join leases l on l.id=rs.lease_id join properties p on p.id=l.property_id join tenants t on t.id=l.tenant_id where r.family_id=$1 and r.status='queued' and (r.next_attempt_at is null or r.next_attempt_at <= now()) order by r.queued_at limit $2", [f.id, opts.limit ?? 50])).rows;
      for (const r of due) {
        const ch = (["email", "whatsapp", "sms"].includes(r.channel) ? r.channel : "sms") as Channel;
        const res = await deliver({ channel: ch, to: r.to_contact, subject: ch === "email" ? `Rent reminder — ${r.property} (${new Date(r.period_month).toLocaleDateString("en-IN", { month: "long", year: "numeric" })})` : undefined, text: r.message, template: r.template && r.template !== "default" ? r.template : undefined, familyId: f.id, refType: "rent_reminder", refId: r.id });
        const attempts = Number(r.attempts) + 1;
        if (res.ok) { await c.query("update rent_reminders set status='sent', sent_at=now(), provider=$2, provider_ref=$3, attempts=$4, error=null where id=$1", [r.id, res.provider, res.ref ?? null, attempts]); sent++; }
        else if (attempts >= BACKOFF_MIN.length) { await c.query("update rent_reminders set status='failed', provider=$2, attempts=$3, error=$4 where id=$1", [r.id, res.provider, attempts, res.error ?? "failed"]); failed++; }
        else { await c.query("update rent_reminders set attempts=$2, provider=$3, error=$4, next_attempt_at=now() + ($5::int * interval '1 minute') where id=$1", [r.id, attempts, res.provider, res.error ?? "failed", BACKOFF_MIN[attempts - 1]]); retry++; }
      }
    });
  }
  return { rows: sent, note: `${sent} reminder${sent === 1 ? "" : "s"} sent${retry ? `, ${retry} to retry` : ""}${failed ? `, ${failed} failed` : ""}`, sent, retry, failed };
}
