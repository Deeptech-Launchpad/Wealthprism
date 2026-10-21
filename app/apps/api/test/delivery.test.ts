import { describe, it, expect, beforeAll, afterAll } from "vitest";
import net from "node:net";
import { createHash } from "node:crypto";
import { buildApp } from "../src/server.js";
import { pool, withFamily } from "../src/lib/db.js";
import { smtpSend, buildMime, sesTransport, whatsappTransport, smsTransport, setDeliveryFetch, setTransports, deliver, dispatchReminders, installDelivery, phone } from "../src/lib/delivery.js";
import { sendEmail, setSenders, logEmail } from "../src/lib/notify.js";

// Delivery (FO-56): the SMTP client against a fake server, SES / WhatsApp / SMS request shapes against a fake fetch, the message log, and the
// rent-reminder queue draining with retries. Nothing leaves the process.
const FAMILY = "11111111-1111-1111-1111-111111111111";
let app: ReturnType<typeof buildApp>; let owner = "";
const h = () => ({ authorization: `Bearer ${owner}`, "x-family-id": FAMILY });
const send = async (method: "POST" | "PATCH", url: string, payload: any = {}) => { const r = await app.inject({ method, url: `/api/v1${url}`, headers: h(), payload }); return { code: r.statusCode, body: r.json() }; };
const run = <T>(fn: (c: any) => Promise<T>) => withFamily(FAMILY, fn);
let reminderIds: string[] = [];
const captured: { url: string; init: any }[] = [];
const fakeFetch = (reply: any = {}, status = 200) => { captured.length = 0; return async (url: string, init: any) => { captured.push({ url, init }); return { ok: status < 300, status, json: async () => reply, text: async () => JSON.stringify(reply) }; }; };

/** A minimal SMTP server: EHLO with AUTH, PLAIN accepted, one message captured. */
function fakeSmtp(opts: { rejectRcpt?: boolean } = {}) {
  const got: { from?: string; to?: string; auth?: string; data?: string; cmds: string[] } = { cmds: [] };
  const server = net.createServer((s) => {
    s.write("220 fake.smtp ESMTP\r\n"); let buf = ""; let inData = false;
    s.on("data", (d) => { buf += d.toString(); if (inData) { const i = buf.indexOf("\r\n.\r\n"); if (i < 0) return; got.data = buf.slice(0, i); buf = buf.slice(i + 5); inData = false; s.write("250 OK queued as FAKE123\r\n"); }
      let n: number; while ((n = buf.indexOf("\r\n")) >= 0) { const line = buf.slice(0, n); buf = buf.slice(n + 2); got.cmds.push(line.split(" ")[0]);
        if (/^EHLO/i.test(line)) s.write("250-fake.smtp\r\n250-SIZE 35882577\r\n250 AUTH PLAIN LOGIN\r\n"); else if (/^AUTH PLAIN/i.test(line)) { got.auth = Buffer.from(line.split(" ")[2], "base64").toString("utf8"); s.write("235 ok\r\n"); }
        else if (/^MAIL FROM/i.test(line)) { got.from = line; s.write("250 ok\r\n"); } else if (/^RCPT TO/i.test(line)) { got.to = line; s.write(opts.rejectRcpt ? "550 no such user\r\n" : "250 ok\r\n"); }
        else if (/^DATA/i.test(line)) { inData = true; s.write("354 go ahead\r\n"); if (buf.length) { const i = buf.indexOf("\r\n.\r\n"); if (i >= 0) { got.data = buf.slice(0, i); buf = buf.slice(i + 5); inData = false; s.write("250 OK queued as FAKE123\r\n"); } } }
        else if (/^QUIT/i.test(line)) { s.write("221 bye\r\n"); s.end(); } else s.write("250 ok\r\n"); } });
  });
  return new Promise<{ port: number; got: typeof got; close: () => void }>((res) => server.listen(0, "127.0.0.1", () => res({ port: (server.address() as net.AddressInfo).port, got, close: () => server.close() })));
}

beforeAll(async () => {
  app = buildApp(); await app.ready();
  owner = (await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: "arjun@example.com", password: "Prototype!2026" } })).json().access_token;
  await cleanup();
});
async function cleanup() {
  await run(async (c) => { await c.query("delete from message_log where family_id=$1 and (ref_type='rent_reminder' or to_contact like '%delivery-test%')", [FAMILY]); await c.query("delete from rent_reminders where family_id=$1 and (id = any($2::uuid[]) or message like 'Delivery test%')", [FAMILY, reminderIds]); });
  await pool.query("delete from message_log where family_id is null and to_contact like '%delivery-test%'");
  setTransports({ email: null, whatsapp: null, sms: null }); setDeliveryFetch(null); setSenders({ email: logEmail }); captured.length = 0;
}
afterAll(async () => { await cleanup(); await app.close(); await pool.end(); });

describe("transports", () => {
  it("SMTP: EHLO, AUTH PLAIN, MAIL / RCPT / DATA with a UTF-8 subject and base64 body; a rejected recipient is an error", async () => {
    const srv = await fakeSmtp();
    const r = await smtpSend({ host: "127.0.0.1", port: srv.port, secure: false, startTls: false, user: "smtp-user", pass: "smtp-pass", from: "noreply@familyoffice.local", to: "arjun@delivery-test.example", subject: "Rent reminder — ₹2,565 due", text: "Dear tenant,\nrent is due.\n.leading dot line" });
    expect(r).toMatchObject({ ok: true, provider: "smtp" }); expect(r.ref).toContain("FAKE123");
    expect(srv.got.auth).toBe("\0smtp-user\0smtp-pass"); expect(srv.got.from).toBe("MAIL FROM:<noreply@familyoffice.local>"); expect(srv.got.to).toBe("RCPT TO:<arjun@delivery-test.example>");
    expect(srv.got.data).toMatch(/^From: noreply@familyoffice.local\r\nTo: arjun@delivery-test.example\r\nSubject: =\?UTF-8\?B\?/); expect(srv.got.data).toContain("Content-Transfer-Encoding: base64");
    const body = srv.got.data!.split("\r\n\r\n")[1]; expect(Buffer.from(body.replace(/\r\n/g, ""), "base64").toString("utf8")).toBe("Dear tenant,\nrent is due.\n.leading dot line");
    expect(srv.got.cmds).toEqual(["EHLO", "AUTH", "MAIL", "RCPT", "DATA", "QUIT"]); srv.close();
    const bad = await fakeSmtp({ rejectRcpt: true }); const e = await smtpSend({ host: "127.0.0.1", port: bad.port, startTls: false, from: "a@b.c", to: "x@y.z", subject: "s", text: "t" }); expect(e.ok).toBe(false); expect(e.error).toMatch(/RCPT → 550/); bad.close();
    const mime = buildMime({ from: "a@b.c", to: "d@e.f", subject: "plain", text: "hi", html: "<b>hi</b>" }); expect(mime).toContain("multipart/alternative"); expect(mime).toContain("text/html");
  });
  it("SES: SigV4-signed SendEmail over the v2 API with the payload hash", async () => {
    process.env.AWS_ACCESS_KEY_ID = "AKIATEST"; process.env.AWS_SECRET_ACCESS_KEY = "secret"; process.env.AWS_REGION = "ap-south-1"; process.env.MAIL_FROM = "noreply@familyoffice.local";
    setDeliveryFetch(fakeFetch({ MessageId: "ses-msg-1" }));
    const r = await sesTransport().send({ channel: "email", to: "priya@delivery-test.example", subject: "Digest", text: "3 open tasks" });
    expect(r).toEqual({ ok: true, provider: "ses", ref: "ses-msg-1" }); const c = captured[0]; expect(c.url).toBe("https://email.ap-south-1.amazonaws.com/v2/email/outbound-emails");
    expect(c.init.headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIATEST\/\d{8}\/ap-south-1\/ses\/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/);
    expect(c.init.headers["x-amz-content-sha256"]).toBe(createHash("sha256").update(c.init.body).digest("hex")); const body = JSON.parse(c.init.body); expect(body.Destination.ToAddresses).toEqual(["priya@delivery-test.example"]); expect(body.Content.Simple.Subject.Data).toBe("Digest");
    delete process.env.AWS_ACCESS_KEY_ID; delete process.env.AWS_SECRET_ACCESS_KEY; expect((await sesTransport().send({ channel: "email", to: "x@delivery-test.example", text: "t" })).ok).toBe(false);
  });
  it("WhatsApp (Meta, Gupshup) and SMS (MSG91, Twilio) request shapes; Indian numbers get the country code", async () => {
    expect(phone("+91 98400 00002")).toBe("919840000002"); expect(phone("9840000002")).toBe("919840000002");
    process.env.WHATSAPP_TOKEN = "wt"; process.env.WHATSAPP_PHONE_ID = "12345"; setDeliveryFetch(fakeFetch({ messages: [{ id: "wamid.1" }] }));
    const m = await whatsappTransport("meta").send({ channel: "whatsapp", to: "+91 98400 00002", text: "Rent due", template: "rent_reminder", params: { tenant: "Sundaram", amount: "₹420" } });
    expect(m).toEqual({ ok: true, provider: "whatsapp:meta", ref: "wamid.1" }); expect(captured[0].url).toBe("https://graph.facebook.com/v19.0/12345/messages"); const mb = JSON.parse(captured[0].init.body); expect(mb).toMatchObject({ messaging_product: "whatsapp", to: "919840000002", type: "template" }); expect(mb.template.components[0].parameters.map((p: any) => p.text)).toEqual(["Sundaram", "₹420"]);
    process.env.WHATSAPP_BSP_KEY = "gk"; process.env.WHATSAPP_SOURCE = "917000000000"; setDeliveryFetch(fakeFetch({ status: "submitted", messageId: "gs-1" }));
    const g = await whatsappTransport("gupshup").send({ channel: "whatsapp", to: "9840000002", text: "Rent due" }); expect(g.ref).toBe("gs-1"); const form = new URLSearchParams(captured[0].init.body); expect(form.get("destination")).toBe("919840000002"); expect(JSON.parse(form.get("message")!)).toEqual({ type: "text", text: "Rent due" }); expect(captured[0].init.headers.apikey).toBe("gk");
    process.env.MSG91_AUTHKEY = "mk"; delete process.env.MSG91_TEMPLATE_ID; setDeliveryFetch(fakeFetch({ type: "success", message: "req-1" }));
    const s = await smsTransport("msg91").send({ channel: "sms", to: "9840000002", text: "Rent due" }); expect(s).toEqual({ ok: true, provider: "sms:msg91", ref: "req-1" }); expect(JSON.parse(captured[0].init.body).sms[0].to).toEqual(["919840000002"]);
    process.env.TWILIO_ACCOUNT_SID = "ACxx"; process.env.TWILIO_AUTH_TOKEN = "tt"; process.env.TWILIO_FROM = "+15005550006"; setDeliveryFetch(fakeFetch({ sid: "SM1" }));
    const t = await smsTransport("twilio").send({ channel: "sms", to: "9840000002", text: "Rent due" }); expect(t.ref).toBe("SM1"); expect(captured[0].url).toBe("https://api.twilio.com/2010-04-01/Accounts/ACxx/Messages.json"); expect(captured[0].init.headers.authorization).toBe(`Basic ${Buffer.from("ACxx:tt").toString("base64")}`); expect(new URLSearchParams(captured[0].init.body).get("To")).toBe("+919840000002");
    expect((await whatsappTransport("log").send({ channel: "whatsapp", to: "1", text: "x" })).provider).toBe("log");
  });
  it("deliver() records every send in message_log, and notify's e-mail goes through the installed transport", async () => {
    setTransports({ email: { name: "fake-email", async send() { return { ok: true, provider: "fake-email", ref: "f-1" }; } } });
    const r = await deliver({ channel: "email", to: "ca@delivery-test.example", subject: "Report ready", text: "link", familyId: FAMILY, refType: "report_job" }); expect(r.ref).toBe("f-1");
    const row = await run(async (c) => (await c.query("select channel, provider, provider_ref, status, ref_type from message_log where family_id=$1 and to_contact='ca@delivery-test.example'", [FAMILY])).rows[0]); expect(row).toEqual({ channel: "email", provider: "fake-email", provider_ref: "f-1", status: "sent", ref_type: "report_job" });
    installDelivery(); expect(await sendEmail("owner@delivery-test.example", "Digest", "text")).toBe(true);
    expect(Number((await pool.query("select count(*) from message_log where family_id is null and to_contact='owner@delivery-test.example'")).rows[0].count)).toBe(1);   // account-level mail has no family
    setTransports({ email: { name: "down", async send() { throw new Error("connection refused"); } } }); const f = await deliver({ channel: "email", to: "x@delivery-test.example", text: "t" }); expect(f).toMatchObject({ ok: false, error: "connection refused" });
  });
});

describe("rent reminders", () => {
  it("queued reminders go out by channel with the provider reference; failures back off and give up after three attempts", async () => {
    const row = await run(async (c) => (await c.query("select rs.id from rent_schedule rs where rs.family_id=$1 and rs.status in ('overdue','due') order by rs.due_date limit 1", [FAMILY])).rows[0]); expect(row).toBeTruthy();
    const q = await send("POST", `/rent-schedule/${row.id}/remind`, { channel: "whatsapp", message: "Delivery test — rent due" }); expect(q.code).toBe(202); reminderIds.push(q.body.id); expect(q.body.to).toMatch(/^\+91/);
    const sent: any[] = []; setTransports({ whatsapp: { name: "whatsapp:fake", async send(m) { sent.push(m); return { ok: true, provider: "whatsapp:fake", ref: "wamid.fake" }; } } });
    const d = await dispatchReminders({ familyId: FAMILY }); expect(d.sent).toBeGreaterThanOrEqual(1); expect(sent[0]).toMatchObject({ channel: "whatsapp", to: q.body.to, text: "Delivery test — rent due", familyId: FAMILY, refType: "rent_reminder" });
    const r1 = await run(async (c) => (await c.query("select status, provider, provider_ref, attempts, sent_at from rent_reminders where id=$1", [q.body.id])).rows[0]); expect(r1).toMatchObject({ status: "sent", provider: "whatsapp:fake", provider_ref: "wamid.fake", attempts: 1 }); expect(r1.sent_at).toBeTruthy();
    expect(await run(async (c) => (await c.query("select 1 from message_log where family_id=$1 and ref_type='rent_reminder' and ref_id=$2", [FAMILY, q.body.id])).rowCount)).toBe(1);
    const q2 = await send("POST", `/rent-schedule/${row.id}/remind`, { channel: "sms", message: "Delivery test — retry" }); reminderIds.push(q2.body.id);
    setTransports({ sms: { name: "sms:down", async send() { return { ok: false, provider: "sms:down", error: "gateway timeout" }; } } });
    const d2 = await dispatchReminders({ familyId: FAMILY }); expect(d2.retry).toBe(1);
    const r2 = await run(async (c) => (await c.query("select status, attempts, error, next_attempt_at from rent_reminders where id=$1", [q2.body.id])).rows[0]); expect(r2).toMatchObject({ status: "queued", attempts: 1, error: "gateway timeout" }); expect(new Date(r2.next_attempt_at).getTime()).toBeGreaterThan(Date.now() + 4 * 60_000);
    expect((await dispatchReminders({ familyId: FAMILY })).retry).toBe(0);   // not due yet
    await run((c) => c.query("update rent_reminders set attempts=2, next_attempt_at=now() - interval '1 minute' where id=$1", [q2.body.id]));
    const d3 = await dispatchReminders({ familyId: FAMILY }); expect(d3.failed).toBe(1); expect((await run(async (c) => (await c.query("select status from rent_reminders where id=$1", [q2.body.id])).rows[0])).status).toBe("failed");
  });
});
