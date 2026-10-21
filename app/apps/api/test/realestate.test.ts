import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildApp } from "../src/server.js";
import { pool, withFamily } from "../src/lib/db.js";

const FAMILY = "11111111-1111-1111-1111-111111111111";
const HUF = "33333333-0000-0000-0000-000000000002", SPOUSE = "33333333-0000-0000-0000-000000000003";
const HUF_GSTIN = "34343434-0000-0000-0000-000000000001";
const RACE_COURSE = "55555555-0000-0000-0000-000000000001";
let app: ReturnType<typeof buildApp>; let token = "";
const h = () => ({ authorization: `Bearer ${token}`, "x-family-id": FAMILY });
const get = async (url: string) => { const r = await app.inject({ url: `/api/v1${url}`, headers: h() }); return { code: r.statusCode, body: r.json() }; };
const send = async (method: "POST" | "PATCH", url: string, payload: any = {}) => { const r = await app.inject({ method, url: `/api/v1${url}`, headers: h(), payload }); return { code: r.statusCode, body: r.json() }; };

const TABLES = ["rent_reminders", "rent_schedule", "leases", "tenants", "property_taxes", "property_expenses", "property_valuations", "property_owners", "properties", "gst_returns", "tasks", "notifications", "bank_txns"];
const before: Record<string, string[]> = {};
let rentBefore: any[] = [], taxBefore: any[] = [], gstBefore: any[] = [], leaseBefore: any[] = [];
const key = (t: string) => (t === "property_owners" ? "property_id::text || entity_id::text" : "id::text");

beforeAll(async () => {
  app = buildApp(); await app.ready();
  token = (await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: "arjun@example.com", password: "Prototype!2026" } })).json().access_token;
  await withFamily(FAMILY, async (c) => {
    for (const t of TABLES) before[t] = (await c.query(`select ${key(t)} k from ${t}`)).rows.map((r) => r.k);
    rentBefore = (await c.query("select id, status, received_amount, received_on, bank_txn_id from rent_schedule")).rows;
    taxBefore = (await c.query("select id, status, paid_on, bank_txn_id, amount from property_taxes")).rows;
    gstBefore = (await c.query("select id, status, filed_on, arn from gst_returns")).rows;
    leaseBefore = (await c.query("select id, rent, end_date, status from leases")).rows;
  });
});
afterAll(async () => {
  await withFamily(FAMILY, async (c) => {
    for (const r of rentBefore) await c.query("update rent_schedule set status=$2, received_amount=$3, received_on=$4, bank_txn_id=$5 where id=$1", [r.id, r.status, r.received_amount, r.received_on, r.bank_txn_id]);
    for (const r of taxBefore) await c.query("update property_taxes set status=$2, paid_on=$3, bank_txn_id=$4, amount=$5 where id=$1", [r.id, r.status, r.paid_on, r.bank_txn_id, r.amount]);
    for (const r of gstBefore) await c.query("update gst_returns set status=$2, filed_on=$3, arn=$4 where id=$1", [r.id, r.status, r.filed_on, r.arn]);
    for (const r of leaseBefore) await c.query("update leases set rent=$2, end_date=$3, status=$4 where id=$1", [r.id, r.rent, r.end_date, r.status]);
    for (const t of TABLES) await c.query(`delete from ${t} where (${key(t)}) <> all($1::text[])`, [before[t]]);
  });
  await pool.query("delete from notifications where id <> all($1::uuid[])", [before.notifications]);
  await app.close(); await pool.end();
});

describe("properties", () => {
  it("lists with yields, shows detail P&L, creates and updates with owners, adds valuations", async () => {
    const list = (await get("/properties")).body;
    const rc = list.find((p: any) => p.id === RACE_COURSE);
    expect(rc.active_lease.tenant).toBe("Kovai Analytics Pvt Ltd"); expect(rc.gross_yield_pct).toBeCloseTo((2850 * 12 / 480000) * 100, 1);
    const detail = (await get(`/properties/${RACE_COURSE}`)).body;
    expect(Number(detail.pnl_fytd.rent)).toBeGreaterThan(0); expect(Number(detail.pnl_fytd.property_tax)).toBe(482); expect(Number(detail.pnl_fytd.expenses)).toBe(220);
    expect(Number(detail.pnl_fytd.net)).toBeCloseTo(Number(detail.pnl_fytd.rent) - 482 - 220, 2);
    expect(detail.valuations.length).toBe(1); expect(detail.leases.length).toBe(1); expect(typeof detail.net_yield_pct).toBe("number");

    const bad = await send("POST", "/properties", { type: "residential", name: "Flat", owners: [{ entity_id: HUF, ownership_pct: 60 }] });
    expect(bad.code).toBe(422);
    const created = await send("POST", "/properties", { type: "residential", name: "RS Puram flat", address: { city: "Coimbatore", state: "TN" }, acquisition_date: "2021-06-15", acquisition_cost: 250000, stamp_duty: 17500, registration: 2500, owners: [{ entity_id: HUF, ownership_pct: 60 }, { entity_id: SPOUSE, ownership_pct: 40 }] });
    expect(created.code).toBe(201); expect(created.body.owners.length).toBe(2); expect(created.body.current_value).toBe("0.00"); expect(created.body.gross_yield_pct).toBeNull();
    const pid = created.body.id;
    const val = await send("POST", `/properties/${pid}/valuations`, { valued_on: "2026-09-01", value: 310000, source: "Broker quote" });
    expect(val.code).toBe(201);
    const upd = await send("PATCH", `/properties/${pid}`, { name: "RS Puram flat (2BHK)", self_occupied: false });
    expect(upd.code).toBe(200); expect(upd.body.name).toBe("RS Puram flat (2BHK)"); expect(upd.body.current_value).toBe("310000.00");
    const d2 = (await get(`/properties/${pid}`)).body;
    expect(d2.cost_of_acquisition).toBe("270000.00");
  });
});

describe("tenants, leases and the rent ledger", () => {
  let tenantId = "", leaseId = "", pid = "";
  it("creates a GST-registered tenant and a lease whose schedule carries escalation, GST and TDS", async () => {
    pid = (await get("/properties")).body.find((p: any) => /RS Puram/.test(p.name)).id;
    const t = await send("POST", "/tenants", { name: "Nova Retail LLP", pan: "AAFFN1234K", gstin: "29AAFFN1234K1Z7", phone: "+91 98400 00009", email: "accounts@nova.example", type: "company" });
    expect(t.code).toBe(201); expect(t.body.pan_last4).toBe("234K"); expect(t.body.state_code).toBe("29");
    tenantId = t.body.id;
    expect((await send("POST", "/leases", { property_id: pid, tenant_id: tenantId, start_date: "2026-10-01", end_date: "2029-09-30", rent: 3000, gst_applicable: true })).code).toBe(422); // needs the landlord GSTIN
    const l = await send("POST", "/leases", { property_id: pid, tenant_id: tenantId, entity_gstin_id: HUF_GSTIN, start_date: "2026-10-01", end_date: "2029-09-30", rent: 3000, due_day: 7, grace_days: 5, escalation_pct: 5, escalation_every_months: 12, deposit: 18000, gst_applicable: true, tds_applicable: true, notice_days: 60 });
    expect(l.code).toBe(201); expect(l.body.schedule_rows).toBe(36); expect(l.body.tenant.gstin).toBe("29AAFFN1234K1Z7"); expect(l.body.rent).toBe("3000.00");
    leaseId = l.body.id;
    const oct = (await get("/rent-schedule?month=2026-10")).body.find((r: any) => r.lease_id === leaseId);
    expect(oct).toMatchObject({ due_date: "2026-10-07", expected_rent: "3000.00", expected_gst: "540.00", expected_tds: "300.00", status: "due", net_due: "3240.00" });
    const oct27 = (await get("/rent-schedule?month=2027-10")).body.find((r: any) => r.lease_id === leaseId);
    expect(oct27.expected_rent).toBe("3150.00"); expect(oct27.expected_gst).toBe("567.00");
    expect((await get("/leases?status=active")).body.some((x: any) => x.id === leaseId)).toBe(true);
    // the property now shows the lease and a yield on its valuation
    const p = (await get(`/properties/${pid}`)).body;
    expect(p.active_lease.tenant).toBe("Nova Retail LLP"); expect(p.gross_yield_pct).toBeCloseTo((36000 / 310000) * 100, 1);
  });
  it("records receipts: partial stays open, full closes the overdue task; a reminder is queued with the tenant's contact", async () => {
    const overdue = (await get("/rent-schedule?month=2026-09&status=overdue")).body[0];
    expect(overdue.tenant).toBe("R. Sundaram");
    await withFamily(FAMILY, async (c) => c.query("insert into tasks (family_id, module, title, reason, severity, source_type, source_id) values ($1,'real_estate','Rent overdue','test',1,'rent_schedule',$2)", [FAMILY, overdue.id]));
    const part = await send("POST", `/rent-schedule/${overdue.id}/receive`, { amount: 200, received_on: "2026-09-10" });
    expect(part.code).toBe(200); expect(part.body.status).toBe("partial"); expect(part.body.received_amount).toBe("200.00");
    expect((await get("/tasks?status=open")).body.some((t: any) => t.source_id === overdue.id)).toBe(true);
    const rem = await send("POST", `/rent-schedule/${overdue.id}/remind`, { channel: "whatsapp" });
    expect(rem.code).toBe(202); expect(rem.body.to).toBe("+91 98400 00002"); expect(rem.body.message).toMatch(/R\. Sundaram/); expect(rem.body.message).toMatch(/220|420/);
    expect((await send("POST", `/rent-schedule/${overdue.id}/remind`, { channel: "email" })).code).toBe(422); // no e-mail on file
    const full = await send("POST", `/rent-schedule/${overdue.id}/receive`, { amount: 220, received_on: "2026-09-12" });
    expect(full.body.status).toBe("received"); expect(full.body.received_amount).toBe("420.00");
    const closed = (await get("/tasks?status=done")).body.find((t: any) => t.source_id === overdue.id);
    expect(closed).toBeTruthy();
    expect((await get("/rent-reminders")).body[0].status).toBe("queued");
  });
  it("links a bank credit as the receipt and marks the task verified", async () => {
    const sep = (await get("/rent-schedule?month=2026-09")).body.find((r: any) => r.tenant === "Bloom Pharmacy");
    await withFamily(FAMILY, async (c) => c.query("update rent_schedule set status='due', received_amount=0, received_on=null, bank_txn_id=null where id=$1", [sep.id]));
    const acct = (await get("/bank-accounts")).body[0].id;
    const txn = await withFamily(FAMILY, async (c) => (await c.query("insert into bank_txns (family_id, bank_account_id, txn_date, narration, amount, hash, source) values ($1,$2,'2026-09-04','NEFT BLOOM PHARMACY RENT',1782,'test-bloom','csv') returning id", [FAMILY, acct])).rows[0].id);
    await withFamily(FAMILY, async (c) => c.query("insert into tasks (family_id, module, title, reason, severity, source_type, source_id) values ($1,'real_estate','Rent overdue','test',1,'rent_schedule',$2)", [FAMILY, sep.id]));
    const r = await send("POST", `/rent-schedule/${sep.id}/receive`, { bank_txn_id: txn });
    expect(r.body.status).toBe("received"); expect(r.body.received_on).toBe("2026-09-04"); expect(r.body.bank_txn_id).toBe(txn);
    const t = (await get("/tasks?status=done")).body.find((x: any) => x.source_id === sep.id);
    expect(t.verification).toBe("verified");
  });
  it("re-prices future rows when the lease changes and stops the schedule when it ends", async () => {
    const upd = await send("PATCH", `/leases/${leaseId}`, { rent: 3300, effective_from: "2027-01-01" });
    expect(upd.code).toBe(200); expect(upd.body.rent).toBe("3300.00"); expect(upd.body.regenerated).toBe(33);
    expect((await get("/rent-schedule?month=2026-12")).body.find((r: any) => r.lease_id === leaseId).expected_rent).toBe("3000.00");
    expect((await get("/rent-schedule?month=2027-01")).body.find((r: any) => r.lease_id === leaseId).expected_rent).toBe("3300.00");
    const end = await send("PATCH", `/leases/${leaseId}`, { status: "ended" });
    expect(end.body.status).toBe("ended");
    expect((await get("/rent-schedule?month=2027-06")).body.some((r: any) => r.lease_id === leaseId)).toBe(false);
  });
});

describe("property tax, expenses and GST", () => {
  it("adds and pays a tax bill, closing its task; logs an expense that feeds the P&L", async () => {
    const t = await send("POST", "/property-taxes", { property_id: RACE_COURSE, authority: "Coimbatore City Municipal Corporation", assessment_no: "CCMC/RC/1182", period: "2026-27 H2", amount: 482, due_date: "2027-03-31" });
    expect(t.code).toBe(201); expect(t.body.status).toBe("due");
    await withFamily(FAMILY, async (c) => c.query("insert into tasks (family_id, module, title, reason, severity, source_type, source_id) values ($1,'real_estate','Property tax due','test',2,'property_tax',$2)", [FAMILY, t.body.id]));
    const paid = await send("POST", `/property-taxes/${t.body.id}/pay`, { paid_on: "2026-09-12" });
    expect(paid.body.status).toBe("paid"); expect(paid.body.paid_on).toBe("2026-09-12");
    expect((await get("/tasks?status=done")).body.some((x: any) => x.source_id === t.body.id)).toBe(true);
    expect((await get("/property-taxes?status=due")).body.every((x: any) => x.status === "due")).toBe(true);
    const before = Number((await get(`/properties/${RACE_COURSE}`)).body.pnl_fytd.expenses);
    const e = await send("POST", "/property-expenses", { property_id: RACE_COURSE, expense_date: "2026-09-05", category: "repair", vendor: "Sparkle Electricals", amount: 150, note: "DB rewiring" });
    expect(e.code).toBe(201);
    const capex = await send("POST", "/property-expenses", { property_id: RACE_COURSE, expense_date: "2026-09-06", category: "other", capital_improvement: true, vendor: "Interiors Co", amount: 5000, note: "Mezzanine" });
    expect(capex.code).toBe(201);
    const d = (await get(`/properties/${RACE_COURSE}`)).body;
    expect(Number(d.pnl_fytd.expenses)).toBe(before + 150); // capex is excluded from the P&L
    expect(Number(d.capital_improvements)).toBe(5000); expect(Number(d.cost_of_acquisition)).toBe(310000 + 21700 + 3100 + 5000);
    expect((await get(`/property-expenses?property_id=${RACE_COURSE}&from=2026-09-01`)).body.length).toBe(2);
  });
  it("builds the GSTR-1 register per GSTIN with CGST/SGST for intra-state and IGST for inter-state tenants", async () => {
    const aug = (await get("/gst/register?month=2026-08")).body;
    const huf = aug.find((g: any) => g.gstin_id === HUF_GSTIN);
    expect(huf.rows.length).toBe(1);
    expect(huf.rows[0]).toMatchObject({ tenant: "Kovai Analytics Pvt Ltd", sac: "997212", taxable_value: "2850.00", rate: 18, cgst: "256.50", sgst: "256.50", igst: "0.00", place_of_supply: "33", invoice_type: "B2C" });
    expect(huf.gstr3b_liability).toBe("513.00"); expect(Number(huf.turnover_fytd)).toBe(2850); // the seed carries Aug and Sep schedules only
    expect(huf.threshold).toBe("2000000.00"); expect(huf.threshold_pct).toBeCloseTo(0.14, 2);
    expect(huf.returns.map((r: any) => r.form).sort()).toEqual(["gstr1", "gstr3b"]);
    // a Karnataka tenant of a Tamil Nadu GSTIN is an inter-state supply: IGST, B2B because the tenant is registered
    const pid = (await get("/properties")).body.find((p: any) => /RS Puram/.test(p.name)).id;
    const nova = (await get("/tenants")).body.find((t: any) => t.name === "Nova Retail LLP");
    const lease = await send("POST", "/leases", { property_id: pid, tenant_id: nova.id, entity_gstin_id: HUF_GSTIN, start_date: "2026-10-01", end_date: "2026-12-31", rent: 3000, gst_applicable: true });
    expect(lease.code).toBe(201);
    const oct = (await get(`/gst/register?month=2026-10&gstin_id=${HUF_GSTIN}`)).body;
    const row = oct.rows.find((r: any) => r.tenant === "Nova Retail LLP");
    expect(row).toMatchObject({ taxable_value: "3000.00", cgst: "0.00", sgst: "0.00", igst: "540.00", place_of_supply: "29", invoice_type: "B2B", tenant_gstin: "29AAFFN1234K1Z7" });
    expect(oct.gstr3b_liability).toBe("540.00"); // the seed has no October row for Kovai yet; Nova's IGST alone
  });
  it("lists returns for the FY and marks one filed, closing its task; late filings are labelled", async () => {
    const list = (await get("/gst/returns?fy=2026-27")).body;
    const due = list.find((r: any) => r.status === "due" && r.form === "gstr3b" && r.gstin === "33AAAAA1234H1Z5");
    expect(due).toBeTruthy(); expect(due.period_month).toBe("2026-08"); expect(due.due_date).toBe("2026-09-20"); expect(due.tax_amount).toBe("513.00");
    await withFamily(FAMILY, async (c) => c.query("insert into tasks (family_id, module, title, reason, severity, source_type, source_id) values ($1,'real_estate','File GSTR-3B','test',2,'gst_return',$2)", [FAMILY, due.id]));
    const filed = await send("PATCH", `/gst/returns/${due.id}`, { filed_on: "2026-09-12", arn: "AA330926000123X" });
    expect(filed.body.status).toBe("filed"); expect(filed.body.arn).toBe("AA330926000123X");
    expect((await get("/tasks?status=done")).body.some((x: any) => x.source_id === due.id)).toBe(true);
    const other = list.find((r: any) => r.status === "due" && r.form === "gstr3b" && r.gstin !== "33AAAAA1234H1Z5");
    expect((await send("PATCH", `/gst/returns/${other.id}`, { filed_on: "2026-09-25" })).body.status).toBe("late");
    // viewers cannot write anything here
    const viewer = (await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: "ca@example.com", password: "Prototype!2026" } })).json().access_token;
    expect((await app.inject({ method: "POST", url: "/api/v1/property-expenses", headers: { authorization: `Bearer ${viewer}`, "x-family-id": FAMILY }, payload: { property_id: RACE_COURSE, expense_date: "2026-09-05", category: "repair", amount: 1 } })).statusCode).toBe(403);
  });
});
