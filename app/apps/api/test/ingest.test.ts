import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { buildApp } from "../src/server.js";
import { pool, withFamily } from "../src/lib/db.js";
import { signIngest } from "../src/lib/ingest.js";

// Importer extras (FO-30, FO-31, e-CAS): PMS and AIF statements, depository e-CAS into reconciliation, and the signed e-mail ingest hook with
// allow-list, quarantine and release. Everything created here is removed and the seeded commitments restored.
const FAMILY = "11111111-1111-1111-1111-111111111111", ARJUN = "33333333-0000-0000-0000-000000000001", HUF = "33333333-0000-0000-0000-000000000002";
const MARCELLUS = "44444444-0000-0000-0000-000000000004", VARAHA = "67676767-0000-0000-0000-000000000005", HDFC_HOLDING = "46464646-0000-0000-0000-000000000001"; let INGEST_ADDR = "";
const S = (f: string) => readFileSync(new URL(`../../../../samples/${f}`, import.meta.url), "utf8");
let app: ReturnType<typeof buildApp>; let owner = "";
const h = () => ({ authorization: `Bearer ${owner}`, "x-family-id": FAMILY });
const get = async (url: string) => { const r = await app.inject({ url: `/api/v1${url}`, headers: h() }); return { code: r.statusCode, body: r.json() }; };
const send = async (method: "POST" | "PATCH", url: string, payload: any = {}) => { const r = await app.inject({ method, url: `/api/v1${url}`, headers: h(), payload }); return { code: r.statusCode, body: r.json() }; };
const run = <T>(fn: (c: any) => Promise<T>) => withFamily(FAMILY, fn);
const inbound = async (payload: any, sig?: string) => { const raw = JSON.stringify(payload); const r = await app.inject({ method: "POST", url: "/api/v1/ingest/email", headers: { "content-type": "application/json", "x-ingest-signature": sig ?? signIngest(raw) }, payload: raw }); return { code: r.statusCode, body: r.json() }; };
let before: any = {};

beforeAll(async () => {
  app = buildApp(); await app.ready();
  owner = (await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: "arjun@example.com", password: "Prototype!2026" } })).json().access_token;
  await cleanup(); INGEST_ADDR = (await get("/ingest/settings")).body.ingest_address;
  await run(async (c) => { before.jobs = (await c.query("select id from import_jobs where family_id=$1", [FAMILY])).rows.map((r) => r.id); before.schedule = (await c.query("select schedule, drawn, total_commitment from fund_commitments where private_investment_id=$1", [VARAHA])).rows[0]; before.allow = (await c.query("select ingest_allow_senders from families where id=$1", [FAMILY])).rows[0].ingest_allow_senders; before.docs = (await c.query("select id from documents where family_id=$1", [FAMILY])).rows.map((r) => r.id); });
});
async function cleanup() {
  await run(async (c) => {
    await c.query("delete from tasks where family_id=$1 and (source_type in ('aif_call','email_ingest') or (source_type='reconciliation_item' and source_id in (select id from reconciliation_items where source in ('ecas_nsdl','ecas_cdsl','cas_mf','pms_stmt'))))", [FAMILY]);
    await c.query("delete from audit_log where family_id=$1 and table_name='reconciliation_items' and row_id in (select id from reconciliation_items where source in ('ecas_nsdl','ecas_cdsl','cas_mf','pms_stmt'))", [FAMILY]);
    await c.query("delete from reconciliation_items where family_id=$1 and source in ('ecas_nsdl','ecas_cdsl','cas_mf','pms_stmt')", [FAMILY]);
    await c.query("delete from prices where instrument_id=$1 and source='pms_stmt'", [MARCELLUS]); await c.query("update instruments set meta = meta - 'pms_holdings' - 'pms_holdings_as_of' where id=$1", [MARCELLUS]);
    await c.query("delete from fees_ledger where family_id=$1 and source in ('pms_stmt','aif_stmt')", [FAMILY]);
    await c.query("delete from private_marks where private_investment_id=$1 and note like '%statement%'", [VARAHA]); await c.query("delete from fund_cashflows where private_investment_id=$1 and source like '%statement%'", [VARAHA]);
    await c.query("delete from committed_outflows where family_id=$1 and source_type='aif_statement'", [FAMILY]);
    if (before.schedule) await c.query("update fund_commitments set schedule=$2, drawn=$3, total_commitment=$4 where private_investment_id=$1", [VARAHA, JSON.stringify(before.schedule.schedule), before.schedule.drawn, before.schedule.total_commitment]);
    await c.query("delete from email_ingest where family_id=$1", [FAMILY]);
    if (before.docs) await c.query("delete from documents where family_id=$1 and id::text <> all($2::text[])", [FAMILY, before.docs]); else await c.query("delete from documents where family_id=$1 and source='email'", [FAMILY]);
    if (before.jobs) await c.query("delete from import_jobs where family_id=$1 and id::text <> all($2::text[])", [FAMILY, before.jobs]); else await c.query("delete from import_jobs where family_id=$1 and (source in ('pms_stmt','ecas') or error_log::text like '%marcellus-sep%')", [FAMILY]);
    if (before.allow) await c.query("update families set ingest_allow_senders=$2 where id=$1", [FAMILY, before.allow]);
  });
}
afterAll(async () => { await cleanup(); await app.close(); await pool.end(); });

describe("PMS and AIF statements", () => {
  it("a PMS statement prices the holding at the closing value, books the fees and reconciles capital contributed", async () => {
    const r = await send("POST", "/imports", { text: S("pms_statement_extracted_text_sample.txt") }); expect(r.code).toBe(201); expect(r.body).toMatchObject({ source: "pms_stmt", status: "done", rows_ok: 1 });
    const px = await run(async (c) => (await c.query("select close, source from prices where instrument_id=$1 and price_date='2026-08-31'", [MARCELLUS])).rows[0]); expect(px).toMatchObject({ close: "30400.0000", source: "pms_stmt" });
    const fees = await run(async (c) => (await c.query("select kind, amount from fees_ledger where family_id=$1 and instrument_id=$2 and fee_date='2026-08-31' order by kind", [FAMILY, MARCELLUS])).rows); expect(fees).toEqual([{ kind: "other", amount: "4.10" }, { kind: "pms_mgmt", amount: "63.33" }]);
    const hold = (await get("/holdings?limit=100")).body.items.find((x: any) => x.instrument_id === MARCELLUS || /Marcellus/.test(x.name ?? x.instrument_name ?? "")); expect(Number(hold.value)).toBe(30400);
    expect(await run(async (c) => (await c.query("select count(*)::int n from reconciliation_items where family_id=$1 and source='pms_stmt'", [FAMILY])).rows[0].n)).toBe(0);   // contributed 25,000 = cost on platform
    const again = await send("POST", "/imports", { text: S("pms_statement_extracted_text_sample.txt") }); expect(again.body.duplicate_of_previous_upload).toBe(true);
    const meta = await run(async (c) => (await c.query("select meta->'pms_holdings' h from instruments where id=$1", [MARCELLUS])).rows[0].h); expect(meta.length).toBe(3);
  });
  it("an AIF statement keeps commitment, NAV and distributions, and a call notice becomes an outflow + task on its due date", async () => {
    const r = await send("POST", "/imports", { text: S("aif_statement_extracted_text_sample.txt") }); expect(r.code).toBe(201); expect(r.body.source).toBe("pms_stmt");
    const mark = await run(async (c) => (await c.query("select value, basis from private_marks where private_investment_id=$1 and marked_on='2026-08-31'", [VARAHA])).rows[0]); expect(mark).toMatchObject({ value: "139000.00", basis: "nav" });
    expect(await run(async (c) => (await c.query("select count(*)::int n from fund_cashflows where private_investment_id=$1 and kind='distribution' and flow_date='2026-02-10'", [VARAHA])).rows[0].n)).toBe(1);   // not duplicated
    expect(await run(async (c) => (await c.query("select count(*)::int n from committed_outflows where family_id=$1 and kind='drawdown' and due_date='2026-10-14' and label ilike '%varaha%'", [FAMILY])).rows[0].n)).toBe(1);   // the seeded outflow is the same call
    const t = await run(async (c) => (await c.query("select title, due_date::text, amount, severity from tasks where family_id=$1 and source_type='aif_call' order by due_date", [FAMILY])).rows); expect(t.length).toBe(1); expect(t[0]).toMatchObject({ due_date: "2026-10-14", amount: "20000.00", severity: 1 }); expect(t[0].title).toMatch(/Varaha.*4\/6/);
    const extra = S("aif_statement_extracted_text_sample.txt").replace("Statement for: August 2026", "Statement for: September 2026").replace("31-Aug-2026", "30-Sep-2026").replace("31-Aug-2026", "30-Sep-2026") + "Capital Call Notice No. 5/6 of Rs. 30,000.00 due on 14-Jan-2027\n";
    const r2 = await send("POST", "/imports", { text: extra }); expect(r2.code).toBe(201);
    const o = await run(async (c) => (await c.query("select kind, label, due_date::text, amount, source_type from committed_outflows where family_id=$1 and due_date='2027-01-14'", [FAMILY])).rows[0]); expect(o).toMatchObject({ kind: "drawdown", due_date: "2027-01-14", amount: "30000.00", source_type: "aif_statement" }); expect(o.label).toMatch(/Varaha.*5\/6/);
    const t2 = await run(async (c) => (await c.query("select due_date::text from tasks where family_id=$1 and source_type='aif_call' order by due_date", [FAMILY])).rows.map((x) => x.due_date)); expect(t2).toEqual(["2026-10-14", "2027-01-14"]);
    const sched = await run(async (c) => (await c.query("select schedule from fund_commitments where private_investment_id=$1", [VARAHA])).rows[0].schedule); expect(sched.some((s: any) => s.due === "2027-01-14" && Number(s.amount) === 30000)).toBe(true);
    const fees = await run(async (c) => (await c.query("select count(*)::int n from fees_ledger where family_id=$1 and source='aif_stmt'", [FAMILY])).rows[0].n); expect(fees).toBe(4);   // two statements × (management + other)
  });
});

describe("e-CAS", () => {
  it("depository positions reconcile by ISIN; a differing quantity raises an exception with a task", async () => {
    const ok = await send("POST", "/imports", { text: S("ecas_nsdl_extracted_text_sample.txt") }); expect(ok.code).toBe(201); expect(ok.body.source).toBe("ecas");
    const log = await run(async (c) => (await c.query("select error_log from import_jobs where id=$1", [ok.body.id])).rows[0].error_log.find((l: any) => l.statement === "ecas")); expect(log).toMatchObject({ entity_id: ARJUN, positions: 2, exceptions: 0, matched: 2 });
    const diff = S("ecas_nsdl_extracted_text_sample.txt").replace("42.000     1,723.81       72,400.02", "45.000     1,723.81       77,571.45");
    const bad = await send("POST", "/imports", { text: diff }); expect(bad.code).toBe(201);
    const item = (await get("/reconciliation?status=mismatch")).body.find((x: any) => x.holding_id === HDFC_HOLDING && x.source === "ecas_nsdl"); expect(item).toMatchObject({ platform_qty: 42, source_qty: 45, entity_name: "Arjun Mehta" }); expect(item.source_ref).toBe("12081600");
    expect(await run(async (c) => (await c.query("select count(*)::int n from tasks where family_id=$1 and source_type='reconciliation_item' and source_id=$2 and status='open'", [FAMILY, item.id])).rows[0].n)).toBe(1);
    const spouse = S("ecas_nsdl_extracted_text_sample.txt").replace("ARJUN MEHTA", "SPOUSE (INDIVIDUAL)").replace("ABCPM1234A", "ABCPS5789K").replace(/Demat Account[^\n]*/, "Demat Account : IN301348 / 13017715 (ICICI Direct)").replace(/INE040A01034[^\n]*/, "INE467B01029  Tata Consultancy Services              Equity    9.000      3,788.89       34,100.01\nINE062A08157  SBI 7.72% 2033 Bond                   Bond      15.000     1,020.00       15,300.00").replace(/Mutual Fund Folios[\s\S]*$/, "");
    const sp = await send("POST", "/imports", { text: spouse }); const sl = await run(async (c) => (await c.query("select error_log from import_jobs where id=$1", [sp.body.id])).rows[0].error_log.find((l: any) => l.statement === "ecas")); expect(sl).toMatchObject({ exceptions: 0, matched: 2 });
  });
});

describe("e-mail ingest", () => {
  const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");
  const sept = S("pms_statement_extracted_text_sample.txt").replace("Statement for: August 2026", "Statement for: September 2026").replace("(01-Aug-2026)", "(01-Sep-2026)").replace("Closing Portfolio Value (31-Aug-2026): 30,400.00", "Closing Portfolio Value (30-Sep-2026): 30,900.00").replace("Management Fee (Aug)", "Management Fee (Sep)").replace("Holdings as on 31-Aug-2026", "Holdings as on 30-Sep-2026");
  it("refuses a bad signature and an unknown recipient", async () => {
    expect((await inbound({ from: "arjun@example.com", to: INGEST_ADDR, attachments: [] }, "bad")).code).toBe(401);
    expect((await inbound({ from: "arjun@example.com", to: "nobody@ingest.familyoffice.local", attachments: [] })).code).toBe(404);
    const s = (await get("/ingest/settings")).body; expect(s.ingest_address).toMatch(/@ingest\./); expect(s.allow_senders).toContain("arjun@example.com");
  });
  it("an allowed sender's statement is stored as a document and imported; the same message id is not imported twice", async () => {
    const r = await inbound({ message_id: "<m-1@test>", from: "Arjun Mehta <arjun@example.com>", to: `Family <${INGEST_ADDR}>`, subject: "Marcellus statement Sep 2026", attachments: [{ name: "marcellus-sep-2026.txt", content_type: "text/plain", content_base64: b64(sept) }] });
    expect(r.code).toBe(202); expect(r.body.status).toBe("imported"); expect(r.body.attachments[0]).toMatchObject({ name: "marcellus-sep-2026.txt", status: "done" }); expect(r.body.attachments[0].import_job_id).toBeTruthy(); expect(r.body.attachments[0].document_id).toBeTruthy();
    const px = await run(async (c) => (await c.query("select close from prices where instrument_id=$1 and price_date='2026-09-30'", [MARCELLUS])).rows[0]); expect(px.close).toBe("30900.0000");
    const doc = (await get(`/documents/${r.body.attachments[0].document_id}`)).body; expect(doc.source).toBe("email"); expect(doc.folder_name ?? doc.folder).toMatch(/PMS/);
    const again = await inbound({ message_id: "<m-1@test>", from: "arjun@example.com", to: INGEST_ADDR, attachments: [{ name: "marcellus-sep-2026.txt", content_type: "text/plain", content_base64: b64(sept) }] }); expect(again.body.duplicate).toBe(true); expect(again.body.id).toBe(r.body.id);
    const list = (await get("/ingest/email")).body; expect(list.find((x: any) => x.id === r.body.id)).toMatchObject({ sender: "arjun@example.com", subject: "Marcellus statement Sep 2026", status: "imported" });
    const plain = await inbound({ message_id: "<m-2@test>", from: "arjun@example.com", to: INGEST_ADDR, subject: "photo", attachments: [{ name: "photo.png", content_type: "image/png", content_base64: b64("\x89PNG not really") }] }); expect(plain.body.status).toBe("failed"); expect(plain.body.attachments[0].status).toMatch(/unsupported|failed/);
  });
  it("an unknown sender is quarantined with a task; release imports the attachment and can trust the sender", async () => {
    const ecas = S("ecas_nsdl_extracted_text_sample.txt");
    const q = await inbound({ message_id: "<m-3@test>", from: "statements@nsdl-cas.example", to: INGEST_ADDR, subject: "Your e-CAS", attachments: [{ name: "ecas-aug-2026.txt", content_type: "text/plain", content_base64: b64(ecas) }] });
    expect(q.code).toBe(202); expect(q.body.status).toBe("quarantined"); expect(q.body.attachments[0]).toMatchObject({ status: "held" }); expect(q.body.attachments[0].document_id).toBeTruthy(); expect(q.body.task_id).toBeTruthy();
    const task = await run(async (c) => (await c.query("select title, module, status from tasks where id=$1", [q.body.task_id])).rows[0]); expect(task).toMatchObject({ module: "imports", status: "open" }); expect(task.title).toMatch(/Quarantined e-mail from statements@nsdl-cas.example/);
    const rel = await send("POST", `/ingest/email/${q.body.id}/release`, { allow_sender: true }); expect(rel.code).toBe(200); expect(rel.body.status).toBe("imported"); expect(rel.body.attachments[0].status).toBe("done");
    expect((await get("/ingest/settings")).body.allow_senders).toContain("statements@nsdl-cas.example"); expect((await run(async (c) => (await c.query("select status from tasks where id=$1", [q.body.task_id])).rows[0])).status).toBe("done");
    const q2 = await inbound({ message_id: "<m-4@test>", from: "statements@nsdl-cas.example", to: INGEST_ADDR, attachments: [{ name: "ecas-again.txt", content_type: "text/plain", content_base64: b64(ecas) }] }); expect(q2.body.status).toBe("imported"); expect(q2.body.attachments[0].note).toMatch(/already imported/);
    expect((await send("POST", `/ingest/email/${q.body.id}/release`)).code).toBe(409);
    const q3 = await inbound({ message_id: "<m-5@test>", from: "spam@elsewhere.example", to: INGEST_ADDR, attachments: [] }); expect(q3.body.status).toBe("quarantined");
    expect((await send("POST", `/ingest/email/${q3.body.id}/reject`)).body.status).toBe("rejected");
    expect((await send("PATCH", "/ingest/settings", { allow_senders: ["arjun@example.com", "@camsonline.com"] })).body.allow_senders).toEqual(["arjun@example.com", "@camsonline.com"]);
    expect((await inbound({ message_id: "<m-6@test>", from: "donotreply@camsonline.com", to: INGEST_ADDR, attachments: [] })).body.status).toBe("no_attachments");   // domain allow-list
  });
});
