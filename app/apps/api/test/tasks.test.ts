import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildApp } from "../src/server.js";
import { pool, withFamily } from "../src/lib/db.js";
import { generateTasksFor, generators } from "../src/jobs/tasks.js";
import { setSenders, sendDigests, notifyTask } from "../src/lib/notify.js";

const FAMILY = "11111111-1111-1111-1111-111111111111";
let app: ReturnType<typeof buildApp>; let token = "", userId = "";
const h = (t = token) => ({ authorization: `Bearer ${t}`, "x-family-id": FAMILY });
const get = async (url: string, t = token) => { const r = await app.inject({ url: `/api/v1${url}`, headers: h(t) }); return { code: r.statusCode, body: r.json() }; };
const TODAY = "2026-09-12";

const TABLES = ["tasks", "gst_returns", "rent_schedule", "property_taxes", "aa_consents", "committed_outflows", "bank_txns", "import_jobs", "tds_26as", "leases"];
const before: Record<string, string[]> = {};
let rentBefore: any[] = [], consentBefore: any[] = [], outflowBefore: any[] = [], leaseBefore: any[] = [], taxBefore: any[] = [];
const pushed: any[] = []; const mailed: any[] = [];
const gen = (name: string) => generators.find((g) => g.name === name)!;
const run = (fn: (c: any) => Promise<any>) => withFamily(FAMILY, fn);

beforeAll(async () => {
  app = buildApp(); await app.ready();
  const login = (await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: "arjun@example.com", password: "Prototype!2026" } })).json();
  token = login.access_token; userId = login.user.id;
  setSenders({ push: async (m) => { pushed.push(...m); return { ok: m.length, failed: 0 }; }, email: async (to, subject, text) => { mailed.push({ to, subject, text }); return true; } });
  await run(async (c) => {
    for (const t of TABLES) before[t] = (await c.query(`select id::text k from ${t}`)).rows.map((r) => r.k);
    rentBefore = (await c.query("select id, status, received_amount from rent_schedule")).rows;
    consentBefore = (await c.query("select id, expires_on, status from aa_consents")).rows;
    outflowBefore = (await c.query("select id, status, due_date from committed_outflows")).rows;
    leaseBefore = (await c.query("select id, end_date, status from leases")).rows;
    taxBefore = (await c.query("select id, status, paid_on from property_taxes")).rows;
  });
  await run((c) => c.query("delete from notifications where user_id in (select user_id from family_members where family_id=$1)", [FAMILY]));
});
afterAll(async () => {
  await run(async (c) => {
    for (const r of rentBefore) await c.query("update rent_schedule set status=$2, received_amount=$3 where id=$1", [r.id, r.status, r.received_amount]);
    for (const r of consentBefore) await c.query("update aa_consents set expires_on=$2, status=$3 where id=$1", [r.id, r.expires_on, r.status]);
    for (const r of outflowBefore) await c.query("update committed_outflows set status=$2, due_date=$3 where id=$1", [r.id, r.status, r.due_date]);
    for (const r of leaseBefore) await c.query("update leases set end_date=$2, status=$3 where id=$1", [r.id, r.end_date, r.status]);
    for (const r of taxBefore) await c.query("update property_taxes set status=$2, paid_on=$3 where id=$1", [r.id, r.status, r.paid_on]);
    for (const t of TABLES) await c.query(`delete from ${t} where id::text <> all($1::text[])`, [before[t]]);
  });
  await run(async (c) => { await c.query("delete from notifications where user_id in (select user_id from family_members where family_id=$1)", [FAMILY]); await c.query("delete from notification_prefs where user_id in (select user_id from family_members where family_id=$1)", [FAMILY]); });
  await pool.query("delete from user_devices where user_id=$1", [userId]);
  await app.close(); await pool.end();
});

describe("generators", () => {
  it("rent_overdue: raises for the overdue row, never twice, and resolves once received", async () => {
    const r1 = await run((c) => gen("rent_overdue").run(c, FAMILY, TODAY));
    expect(r1.drafts.length).toBe(1); expect(r1.drafts[0]).toMatchObject({ severity: 1, source_type: "rent_schedule", verification: "pending", amount: 420 }); expect(r1.drafts[0].title).toMatch(/Rent overdue 7 d: .*Saibaba.*R\. Sundaram/);
    const a = await run((c) => generateTasksFor(c, FAMILY, TODAY, { notify: false })); expect(a.byGenerator.rent_overdue).toBe(1);
    const b = await run((c) => generateTasksFor(c, FAMILY, TODAY, { notify: false })); expect(b.byGenerator.rent_overdue).toBe(0);
    const id = r1.drafts[0].source_id;
    await run((c) => c.query("update rent_schedule set status='received', received_amount=420 where id=$1", [id]));
    const cl = await run((c) => generateTasksFor(c, FAMILY, TODAY, { notify: false })); expect(cl.closed).toBeGreaterThanOrEqual(1);
    const done = (await get("/tasks?status=done")).body.find((t: any) => t.source_id === id);
    expect(done.verification).toBe("verified"); // it was pending and the source resolved
  });
  it("lease_expiry: fires inside the notice window with the escalation clause", async () => {
    const r = await run((c) => gen("lease_expiry").run(c, FAMILY, TODAY));
    expect(r.drafts.length).toBe(1); expect(r.drafts[0].title).toMatch(/Anna Nagar/); expect(r.drafts[0].reason).toMatch(/Bloom Pharmacy.*90-day.*8% escalation/); expect(r.drafts[0].due_date).toBe("2026-09-01");
    await run((c) => c.query("update leases set end_date='2027-11-30' where id=$1", [r.drafts[0].source_id]));
    const r2 = await run((c) => gen("lease_expiry").run(c, FAMILY, TODAY));
    expect(r2.drafts.length).toBe(0); expect(r2.resolved!.some((x) => x.source_id === r.drafts[0].source_id)).toBe(true);
  });
  it("property_tax_due: due bills within 30 days, overdue ones at severity 1", async () => {
    const r = await run((c) => gen("property_tax_due").run(c, FAMILY, TODAY));
    expect(r.drafts.length).toBe(1); // Saibaba Colony due 30 Sep; Anna Nagar (15 Oct) is still outside the 30-day window
    expect(r.drafts[0]).toMatchObject({ severity: 2, verification: "pending", amount: 114, source_type: "property_tax" }); expect(r.drafts[0].title).toMatch(/^Property tax due: .*Saibaba/);
    const r2 = await run((c) => gen("property_tax_due").run(c, FAMILY, "2026-10-05"));
    expect(r2.drafts.length).toBe(2);
    expect(r2.drafts.find((d) => /Saibaba/.test(d.title))!).toMatchObject({ severity: 1 }); expect(r2.drafts.find((d) => /Saibaba/.test(d.title))!.title).toMatch(/overdue/);
    expect(r2.drafts.find((d) => /Anna Nagar/.test(d.title))!.severity).toBe(2);
    expect(r2.resolved!.length).toBe(2); // the two paid bills
  });
  it("gst_filing_due: creates the monthly returns from GST leases and flags the ones due within 10 days", async () => {
    await run((c) => generateTasksFor(c, FAMILY, TODAY, { notify: false }));
    const open = (await get("/tasks?status=open&module=real_estate")).body.filter((t: any) => t.source_type === "gst_return");
    expect(open.map((t: any) => t.title).sort()).toEqual(["File GSTR-3B for Aug 2026 — Mehta HUF", "File GSTR-3B for Aug 2026 — Spouse (Individual)"]);
    expect(Number(open[0].amount)).toBeGreaterThan(0);
    const late = await run((c) => gen("gst_filing_due").run(c, FAMILY, "2026-09-25"));
    expect(late.drafts.every((d) => d.severity === 1 && /overdue/.test(d.reason))).toBe(true);
    // September's returns are created once September is over
    const rows = await run(async (c) => (await c.query("select form, due_date from gst_returns where period_month='2026-09-01' order by form")).rows);
    expect(rows.length).toBe(0);
    await run((c) => generateTasksFor(c, FAMILY, "2026-10-02", { notify: false }));
    const sep = await run(async (c) => (await c.query("select form, due_date::text d from gst_returns where period_month='2026-09-01' order by form, d")).rows);
    expect(sep.map((x) => `${x.form}:${x.d}`)).toEqual(["gstr1:2026-10-11", "gstr1:2026-10-11", "gstr3b:2026-10-20", "gstr3b:2026-10-20"]);
  });
  it("consent_expiry, fund_drawdown, unmatched_credit, import_failure and tds_mismatch each watch their source", async () => {
    expect((await run((c) => gen("consent_expiry").run(c, FAMILY, TODAY))).drafts.length).toBe(0);
    await run((c) => c.query("update aa_consents set expires_on='2026-10-01' where consent_handle='ch_demo_huf'"));
    const ce = await run((c) => gen("consent_expiry").run(c, FAMILY, TODAY));
    expect(ce.drafts.length).toBe(1); expect(ce.drafts[0].title).toMatch(/Mehta HUF/); expect(ce.drafts[0].reason).toMatch(/1 linked account go/);

    const dd = await run((c) => gen("fund_drawdown").run(c, FAMILY, "2026-10-01"));
    expect(dd.drafts.length).toBe(1); expect(dd.drafts[0]).toMatchObject({ title: "Varaha Fund II drawdown 4/6", amount: 20000, module: "startups" });
    expect((await run((c) => gen("fund_drawdown").run(c, FAMILY, TODAY))).drafts.length).toBe(0); // 32 days out, beyond the 21-day window

    const acct = (await get("/bank-accounts")).body[0].id;
    const txn = await run(async (c) => (await c.query("insert into bank_txns (family_id, bank_account_id, txn_date, narration, amount, hash, source, category_id) values ($1,$2,'2026-09-10','IMPS FROM UNKNOWN 9988',25000,'test-unmatched','csv',(select id from categories where name='Other income' and family_id is null)) returning id", [FAMILY, acct])).rows[0].id);
    const uc = await run((c) => gen("unmatched_credit").run(c, FAMILY, TODAY));
    expect(uc.drafts.length).toBe(1); expect(uc.drafts[0].title).toMatch(/₹25,000/); expect(uc.drafts[0].source_id).toBe(txn);
    await run((c) => c.query("update bank_txns set link_type='transfer' where id=$1", [txn]));
    expect((await run((c) => gen("unmatched_credit").run(c, FAMILY, TODAY))).resolved!.some((x) => x.source_id === txn)).toBe(true);

    const job = await run(async (c) => (await c.query("insert into import_jobs (family_id, source, status, error_log) values ($1,'contract_note','needs_mapping','[{\"filename\":\"hdfcsec.csv\"}]') returning id", [FAMILY])).rows[0].id);
    const imp = await run((c) => gen("import_failure").run(c, FAMILY, TODAY));
    expect(imp.drafts.find((d) => d.source_id === job)!.title).toBe("Map the columns of hdfcsec.csv");

    // 26AS on file with less TDS than the rent schedule expects → mismatch for that tenant
    await run((c) => c.query("insert into tds_26as (family_id, entity_id, fy, quarter, deductor_tan, deductor_name, section, amount_paid, tds_deducted) values ($1,'33333333-0000-0000-0000-000000000002','2026-27',2,'CHEK01234A','KOVAI ANALYTICS PVT LTD','194I',2850,285)", [FAMILY]));
    const tds = await run((c) => gen("tds_mismatch").run(c, FAMILY, TODAY));
    const kovai = tds.drafts.find((d) => /Kovai/.test(d.title));
    expect(kovai).toBeTruthy(); expect(kovai!.reason).toMatch(/expected ₹570.*shows ₹285/);
  });
});

describe("notifications", () => {
  it("fans a new task out to the inbox of every member and pushes to registered devices by severity", async () => {
    const dev = await app.inject({ method: "POST", url: "/api/v1/devices", headers: h(), payload: { push_token: "ExponentPushToken[test-owner-device]", platform: "ios" } });
    expect(dev.statusCode).toBe(201);
    const prefs = await app.inject({ method: "PUT", url: "/api/v1/notification-preferences", headers: h(), payload: { push_min_severity: 2, email_digest: "daily" } });
    expect(prefs.json().push_min_severity).toBe(2);
    pushed.length = 0;
    const created = await app.inject({ method: "POST", url: "/api/v1/tasks", headers: h(), payload: { module: "banking", title: "Chase the Kotak FD renewal", reason: "matures 30 Sep", severity: 2, due_date: "2026-09-30", amount: 500000 } });
    expect(created.statusCode).toBe(201); expect(created.json().created_by).toBe("user");
    expect(pushed.length).toBe(1); expect(pushed[0]).toMatchObject({ to: "ExponentPushToken[test-owner-device]", title: "Chase the Kotak FD renewal" }); expect(pushed[0].body).toMatch(/matures 30 Sep · ₹5,00,000 · due 30 Sep/);
    const inbox = (await get("/notifications?unread=true")).body;
    expect(inbox.unread).toBeGreaterThanOrEqual(1); expect(inbox.items[0].task_id).toBe(created.json().id); expect(inbox.items[0].family_name).toBe("Mehta Family");
    // a severity-3 task does not push at min severity 2, but still lands in the inbox
    pushed.length = 0;
    await app.inject({ method: "POST", url: "/api/v1/tasks", headers: h(), payload: { module: "banking", title: "Low priority note", severity: 3 } });
    expect(pushed.length).toBe(0);
    const priya = (await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: "priya@example.com", password: "Prototype!2026" } })).json().access_token;
    const priyaInbox = (await get("/notifications", priya)).body;
    expect(priyaInbox.items.some((n: any) => n.title === "Chase the Kotak FD renewal")).toBe(true);
    const read = await app.inject({ method: "POST", url: "/api/v1/notifications/read", headers: h(), payload: { all: true } });
    expect(read.json().marked).toBeGreaterThanOrEqual(2);
    expect((await get("/notifications?unread=true")).body.unread).toBe(0);
    expect((await app.inject({ url: "/api/v1/notifications" })).statusCode).toBe(401);
  });
  it("builds a daily digest of open tasks grouped by module and respects 'off'", async () => {
    mailed.length = 0;
    const d = await sendDigests(new Date("2026-09-12T02:30:00Z"));
    const mine = d.find((x) => x.user === "arjun@example.com");
    expect(mine).toBeTruthy(); expect(mine!.tasks).toBeGreaterThan(3); expect(mine!.sent).toBe(true);
    const mail = mailed.find((m) => m.to === "arjun@example.com");
    expect(mail.subject).toMatch(/open tasks/); expect(mail.text).toMatch(/\[real_estate\]/); expect(mail.text).toMatch(/\[banking\]/); expect(mail.text).toMatch(/Mehta Family — \d+ open/);
    // not again within the day
    expect((await sendDigests(new Date("2026-09-12T05:30:00Z"))).find((x) => x.user === "arjun@example.com")).toBeUndefined();
    await app.inject({ method: "PUT", url: "/api/v1/notification-preferences", headers: h(), payload: { email_digest: "off" } });
    expect((await sendDigests(new Date("2026-09-14T02:30:00Z"))).find((x) => x.user === "arjun@example.com")).toBeUndefined();
  });
  it("manual done on a verifiable task is pending until the import proves it", async () => {
    const rent = (await get("/rent-schedule?month=2026-09")).body.find((r: any) => r.tenant === "R. Sundaram");
    const t = await run(async (c) => (await c.query("insert into tasks (family_id, module, title, reason, severity, source_type, source_id) values ($1,'real_estate','Rent overdue','test',1,'rent_schedule',$2) returning id", [FAMILY, rent.id])).rows[0]);
    const done = await app.inject({ method: "PATCH", url: `/api/v1/tasks/${t.id}`, headers: h(), payload: { status: "done" } });
    expect(done.json().verification).toBe("pending");
    const reopened = await app.inject({ method: "PATCH", url: `/api/v1/tasks/${t.id}`, headers: h(), payload: { status: "open" } });
    expect(reopened.json().done_at).toBeNull();
  });
});
