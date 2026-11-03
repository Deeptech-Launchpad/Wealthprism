import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildApp } from "../src/server.js";
import { pool, withFamily } from "../src/lib/db.js";

// Property size and registration details: area + unit, cost per sq ft, first valuation from the purchase price.
const FAMILY = "11111111-1111-1111-1111-111111111111";
let app: ReturnType<typeof buildApp>; let owner = "";
const call = async (method: string, url: string, payload?: any) => { const r = await app.inject({ method: method as any, url: `/api/v1${url}`, headers: { authorization: `Bearer ${owner}`, "x-family-id": FAMILY }, payload }); return { code: r.statusCode, body: r.body ? r.json() : null }; };

beforeAll(async () => { app = buildApp(); await app.ready(); owner = (await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: "arjun@example.com", password: "Prototype!2026" } })).json().access_token; });
afterAll(async () => { await withFamily(FAMILY, async (c) => {
  await c.query("delete from committed_outflows where source_type='liability' and source_id in (select id from liabilities where lender like 'ZZ Bank%')"); await c.query("delete from liabilities where lender like 'ZZ Bank%'");
  await c.query("delete from committed_outflows where source_type='lease_refund' and source_id in (select l.id from leases l join properties p on p.id=l.property_id where p.name like 'ZZ Detail%')");
  await c.query("delete from property_expenses where property_id in (select id from properties where name like 'ZZ Detail%')");
  await c.query("delete from leases where property_id in (select id from properties where name like 'ZZ Detail%')"); await c.query("delete from properties where name like 'ZZ Detail%'"); }); await app.close(); await pool.end(); });

describe("property details", () => {
  it("saves land area with a unit, works out cost per sq ft and records the purchase as the first valuation", async () => {
    const r = await call("POST", "/properties", { type: "land", name: "ZZ Detail Land", acquisition_date: "2024-06-15", acquisition_cost: 4356000, area_value: 10, area_unit: "cent", land_use: "agricultural", survey_no: "123/4A", patta_no: "P-88", registration_no: "1234/2024", sub_registrar: "Pollachi", boundaries: "N: road" });
    expect(r.code).toBe(201); expect(r.body.area_sqft).toBe(4356); expect(r.body.cost_per_sqft).toBe(1000); expect(r.body.survey_no).toBe("123/4A"); expect(Number(r.body.current_value)).toBe(4356000);
    const d = (await call("GET", `/properties/${r.body.id}`)).body; expect(d.valuations[0].source).toBe("acquisition"); expect(d.land_use).toBe("agricultural");
  });
  it("converts acre, ground and flat built-up area; refuses an area with no unit; edits and clears fields", async () => {
    const acre = await call("POST", "/properties", { type: "land", name: "ZZ Detail Acre", acquisition_cost: 4356000, area_value: 1, area_unit: "acre" }); expect(acre.body.area_sqft).toBe(43560); expect(acre.body.cost_per_sqft).toBe(100);
    const ground = await call("POST", "/properties", { type: "land", name: "ZZ Detail Ground", area_value: 2, area_unit: "ground" }); expect(ground.body.area_sqft).toBe(4800);
    const flat = await call("POST", "/properties", { type: "residential", name: "ZZ Detail Flat", acquisition_cost: 6000000, built_up_sqft: 1200, carpet_sqft: 1000, unit_no: "B-204" }); expect(flat.body.cost_per_sqft).toBe(5000); expect(flat.body.unit_no).toBe("B-204");
    expect((await call("POST", "/properties", { type: "land", name: "ZZ Detail NoUnit", area_value: 5 })).code).toBe(422);
    const e = await call("PATCH", `/properties/${flat.body.id}`, { unit_no: null, built_up_sqft: 1500 }); expect(e.body.unit_no).toBeNull(); expect(e.body.built_up_sqft).toBe(1500); expect(e.body.carpet_sqft).toBe(1000);
  });
  it("deletes a property: refused while it has an active lease, otherwise it leaves the list and the portfolio", async () => {
    const before = (await call("GET", "/properties")).body.length;
    const p = await call("POST", "/properties", { type: "land", name: "ZZ Detail Delete", acquisition_cost: 100000 });
    expect((await call("GET", "/properties")).body.length).toBe(before + 1);
    expect((await call("DELETE", `/properties/${p.body.id}`)).code).toBe(204);
    expect((await call("GET", "/properties")).body.length).toBe(before);
    expect((await call("GET", `/properties/${p.body.id}`)).code).toBe(404);
    expect((await call("DELETE", `/properties/${p.body.id}`)).code).toBe(404);
    const leased = (await call("GET", "/properties")).body.find((x: any) => x.active_lease);
    expect(leased).toBeTruthy();
    const r = await call("DELETE", `/properties/${leased.id}`); expect(r.code).toBe(422); expect(r.body.title).toMatch(/active lease/);
  });
  it("loan interest: paid EMIs add their interest to the property's Net, an EMI is paid from the property page data, and a hand-logged loan interest is not counted twice", async () => {
    const ent = (await call("GET", "/entities")).body[0].id; const today = new Date().toISOString().slice(0, 10);
    const p = await call("POST", "/properties", { type: "residential", name: "ZZ Detail Interest", acquisition_cost: 5000000, acquisition_date: "2024-01-10" });
    expect((await call("GET", `/properties/${p.body.id}`)).body.pnl_fytd.loan_interest).toBe("0.00");
    const loan = await call("POST", "/liabilities", { entity_id: ent, kind: "home_loan", lender: "ZZ Bank Interest", principal_original: 2000000, outstanding: 2000000, rate_pct: 8.5, emi: 20000, emi_day: 5, start_date: "2026-06-01", end_date: "2036-06-01", secured_by_type: "property", secured_by_id: p.body.id });
    expect(loan.code).toBe(201);
    const next = (await call("GET", `/properties/${p.body.id}`)).body.loans[0].next_instalment; expect(next.id).toBeTruthy(); expect(Number(next.amount)).toBeGreaterThan(0);
    expect((await call("POST", `/liabilities/${loan.body.id}/schedule/${next.id}/pay`, { paid_on: today })).code).toBe(200);
    const d1 = (await call("GET", `/properties/${p.body.id}`)).body; const interest = Number(d1.pnl_fytd.loan_interest);
    expect(interest).toBeGreaterThan(0); expect(Number(d1.pnl_fytd.net)).toBeCloseTo(-interest, 2);
    expect(d1.loans[0].paid.length).toBe(1); expect(d1.loans[0].paid[0].id).toBe(next.id); expect(d1.loans[0].paid[0].paid_on).toBe(today);   // the paid list
    expect(d1.loans[0].next_instalment.id).not.toBe(next.id);                    // the next one is now offered
    await call("POST", "/property-expenses", { property_id: p.body.id, expense_date: today, category: "loan_interest", amount: 5000 });
    const d2 = (await call("GET", `/properties/${p.body.id}`)).body; expect(d2.pnl_fytd.expenses).toBe("0.00"); expect(Number(d2.pnl_fytd.net)).toBeCloseTo(-interest, 2);   // not counted twice
    await call("PATCH", `/liabilities/${loan.body.id}`, { secured_by_type: null, secured_by_id: null });                     // loan unlinked: the hand-logged interest counts again
    const d3 = (await call("GET", `/properties/${p.body.id}`)).body; expect(d3.pnl_fytd.expenses).toBe("5000.00"); expect(d3.pnl_fytd.loan_interest).toBe("0.00");
  });
  it("closing a loan early cancels the unpaid instalments and the money kept back for them, and keeps the paid history; the same loan cannot be closed twice", async () => {
    const ent = (await call("GET", "/entities")).body[0].id; const today = new Date().toISOString().slice(0, 10);
    const p = await call("POST", "/properties", { type: "residential", name: "ZZ Detail Early", acquisition_cost: 5000000 });
    const loan = await call("POST", "/liabilities", { entity_id: ent, kind: "home_loan", lender: "ZZ Bank Early", principal_original: 2000000, outstanding: 2000000, rate_pct: 8.5, emi: 20000, emi_day: 5, start_date: today, end_date: "2036-06-01", secured_by_type: "property", secured_by_id: p.body.id });
    const next = (await call("GET", `/properties/${p.body.id}`)).body.loans[0].next_instalment;
    await call("POST", `/liabilities/${loan.body.id}/schedule/${next.id}/pay`, { paid_on: today });
    const d0 = (await call("GET", `/properties/${p.body.id}`)).body; expect(d0.loans[0].last_instalment > d0.loans[0].next_instalment.due_date).toBe(true);
    const pending = () => withFamily(FAMILY, async (c) => Number((await c.query("select count(*) n from committed_outflows where source_type='liability_schedule' and status='pending' and source_id in (select id from liability_schedule where liability_id=$1 and paid_on is null)", [loan.body.id])).rows[0].n));
    expect(await pending()).toBeGreaterThan(0);                                   // the next EMI is kept back in Working capital
    const closed = await call("POST", `/liabilities/${loan.body.id}/close`, { closed_on: today, paid_amount: 1900000 });
    expect(closed.code).toBe(200); expect(closed.body.status).toBe("closed");
    const l = (await call("GET", `/liabilities/${loan.body.id}`)).body; expect(l.schedule.length).toBe(1); expect(l.schedule[0].paid_on).toBe(today);   // only the paid one is left
    expect(await pending()).toBe(0);
    const d = (await call("GET", `/properties/${p.body.id}`)).body;
    expect(d.loans.length).toBe(0); expect(d.closed_loans.length).toBe(1); expect(d.closed_loans[0]).toMatchObject({ emis_paid: 1, closed_on: today, closed_amount: "1900000.00" });
    expect(Number(d.pnl_fytd.loan_interest)).toBeGreaterThan(0);                  // the interest already paid still counts
    expect(d.loan_outstanding).toBe("0.00");
    expect((await call("POST", `/liabilities/${loan.body.id}/close`, {})).code).toBe(422);
  });
  it("a loan closes by itself when its last instalment is paid", async () => {
    const ent = (await call("GET", "/entities")).body[0].id; const today = new Date().toISOString().slice(0, 10);
    const p = await call("POST", "/properties", { type: "residential", name: "ZZ Detail Auto", acquisition_cost: 5000000 });
    const loan = await call("POST", "/liabilities", { entity_id: ent, kind: "personal_loan", lender: "ZZ Bank Auto", principal_original: 30000, outstanding: 30000, rate_pct: 12, emi: 10000, emi_day: 5, start_date: today, secured_by_type: "property", secured_by_id: p.body.id });
    let paid = 0;
    for (let i = 0; i < 10; i++) { const n = (await call("GET", `/properties/${p.body.id}`)).body.loans[0]?.next_instalment; if (!n) break; expect((await call("GET", `/liabilities/${loan.body.id}`)).body.status).toBe("active"); await call("POST", `/liabilities/${loan.body.id}/schedule/${n.id}/pay`, { paid_on: today }); paid++; }
    expect(paid).toBeGreaterThanOrEqual(3);
    expect((await call("GET", `/liabilities/${loan.body.id}`)).body.status).toBe("closed");
    const d = (await call("GET", `/properties/${p.body.id}`)).body; expect(d.loans.length).toBe(0); expect(d.closed_loans[0]).toMatchObject({ emis_paid: paid, closed_amount: null });
  });
  it("lump-sum lease (no monthly rent), a loan on the property, equity and cash flow, then ending the lease with a refund", async () => {
    const ent = (await call("GET", "/entities")).body[0].id; const tenant = (await call("GET", "/tenants")).body[0].id;
    const p = await call("POST", "/properties", { type: "residential", name: "ZZ Detail Bhogya", acquisition_cost: 5000000, acquisition_date: "2024-01-10" });
    const lease = (over: any = {}) => call("POST", "/leases", { property_id: p.body.id, tenant_id: tenant, start_date: "2026-04-01", end_date: "2029-03-31", lease_kind: "lump_sum", rent: 0, deposit: 1000000, ...over });
    expect((await lease({ deposit: 0 })).code).toBe(422);                       // lump sum needs an amount
    expect((await lease({ lease_kind: "rent", rent: 0 })).code).toBe(422);     // rent lease needs a rent
    const l = await lease(); expect(l.code).toBe(201); expect(l.body.schedule_rows).toBe(0); expect(l.body.lease_kind).toBe("lump_sum");
    const refund = async () => withFamily(FAMILY, async (c) => (await c.query("select amount::text, due_date::text d, status, label from committed_outflows where source_type='lease_refund' and source_id=$1", [l.body.id])).rows);
    const o1 = await refund(); expect(o1.length).toBe(1); expect(o1[0]).toMatchObject({ amount: "1000000.00", d: "2029-03-31", status: "pending" }); expect(o1[0].label).toMatch(/Return lump sum/);   // Working capital keeps this money back
    const row = (await call("GET", "/properties")).body.find((x: any) => x.id === p.body.id); expect(row.active_lease.lease_kind).toBe("lump_sum"); expect(row.monthly_cash_flow).toBe("0.00");
    const loan = await call("POST", "/liabilities", { entity_id: ent, kind: "home_loan", lender: "ZZ Bank", principal_original: 2000000, outstanding: 2000000, rate_pct: 8.5, emi: 20000, emi_day: 5, secured_by_type: "property", secured_by_id: p.body.id });
    expect(loan.code).toBe(201);
    const d = (await call("GET", `/properties/${p.body.id}`)).body;
    expect(d.loans.length).toBe(1); expect(d.loan_emi).toBe("20000.00"); expect(Number(d.loan_outstanding)).toBeGreaterThan(0);
    expect(Number(d.equity)).toBe(Number(d.current_value) - Number(d.loan_outstanding)); expect(d.monthly_cash_flow).toBe("-20000.00");
    expect((await call("POST", `/leases/${l.body.id}/end`, { refunded_amount: 1500000 })).code).toBe(422);   // cannot hand back more than held
    const ended = await call("POST", `/leases/${l.body.id}/end`, { refunded_amount: 900000, refunded_on: "2029-03-31" });
    expect(ended.code).toBe(200); expect(ended.body.status).toBe("ended"); expect(ended.body.refunded_amount).toBe("900000.00"); expect(ended.body.refunded_on).toBe("2029-03-31");
    expect((await refund())[0].status).toBe("done");   // handed back, so no longer reserved
    expect((await call("POST", `/leases/${l.body.id}/end`, {})).code).toBe(422);
    expect((await call("DELETE", `/properties/${p.body.id}`)).code).toBe(204);   // no active lease any more
    await call("PATCH", `/liabilities/${loan.body.id}`, { secured_by_type: null, secured_by_id: null });
  });
});
