import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildApp } from "../src/server.js";
import { pool, withFamily } from "../src/lib/db.js";
import { generators } from "../src/jobs/tasks.js";
import { syncOutflows } from "../src/lib/balance.js";
import { emiFor } from "@fo/finance";

// Balance sheet (PRD 3.11; FO-90..94, 96): net worth = assets − liabilities, loan schedules matched to bank debits, 24(b) interest into the tax
// projection, LTV / premium / nominee tasks, insurance adequacy, lifestyle assets, ownership look-through and succession gaps. Self-cleaning.
const FAMILY = "11111111-1111-1111-1111-111111111111", ARJUN = "33333333-0000-0000-0000-000000000001", HUF = "33333333-0000-0000-0000-000000000002", SPOUSE = "33333333-0000-0000-0000-000000000003";
const ARJUN_HDFC = "89898989-0000-0000-0000-000000000001", HOME_LOAN = "e1000000-0000-0000-0000-000000000001", LAS = "e1000000-0000-0000-0000-000000000002";
const HEALTH = "e2000000-0000-0000-0000-000000000002", JEWEL = "e3000000-0000-0000-0000-000000000002", ART = "e3000000-0000-0000-0000-000000000003", TCS_HOLDING = "46464646-0000-0000-0000-000000000007", WILL = "e5000000-0000-0000-0000-000000000001";
const TODAY = "2026-09-12";
let app: ReturnType<typeof buildApp>; let owner = "";
const h = (t = owner) => ({ authorization: `Bearer ${t}`, "x-family-id": FAMILY });
const get = async (url: string, t = owner) => { const r = await app.inject({ url: `/api/v1${url}`, headers: h(t) }); return { code: r.statusCode, body: r.json() }; };
const send = async (method: "POST" | "PATCH" | "PUT" | "DELETE", url: string, payload: any = {}, t = owner) => { const r = await app.inject({ method, url: `/api/v1${url}`, headers: h(t), payload }); return { code: r.statusCode, body: r.statusCode === 204 ? null : r.json() }; };
const run = <T>(fn: (c: any) => Promise<T>) => withFamily(FAMILY, fn);
const gen = (name: string) => generators.find((g) => g.name === name)!;
const near = (a: any, b: any, tol = 0.02) => Math.abs(Number(a) - Number(b)) <= tol;
let scheduleBefore: any[] = [], liabBefore: any[] = [], outflowsBefore: string[] = [];

beforeAll(async () => {
  app = buildApp(); await app.ready();
  owner = (await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: "arjun@example.com", password: "Prototype!2026" } })).json().access_token;
  await cleanup();
  await run(async (c) => {
    scheduleBefore = (await c.query("select s.id, s.paid_on, s.bank_txn_id, s.matched_at from liability_schedule s join liabilities l on l.id=s.liability_id where l.family_id=$1", [FAMILY])).rows;
    liabBefore = (await c.query("select id, outstanding, outstanding_as_of, ltv_pct, tax_section from liabilities where family_id=$1", [FAMILY])).rows;
    outflowsBefore = (await c.query("select id from committed_outflows where family_id=$1", [FAMILY])).rows.map((r) => r.id);
  });
});
async function cleanup() {
  await run(async (c) => {
    await c.query("delete from tasks where family_id=$1 and (source_type in ('nominee_gap','ltv_breach','premium_due','forecast_float') or source_id in (select id from liabilities where lender='Test Finance'))", [FAMILY]);
    await c.query("delete from committed_outflows where family_id=$1 and source_id in (select s.id from liability_schedule s join liabilities l on l.id=s.liability_id where l.lender='Test Finance')", [FAMILY]);
    await c.query("delete from liability_schedule where liability_id in (select id from liabilities where family_id=$1 and lender='Test Finance')", [FAMILY]);
    await c.query("delete from liabilities where family_id=$1 and lender='Test Finance'", [FAMILY]);
    await c.query("delete from bank_txns where family_id=$1 and hash like 'bal-test-%'", [FAMILY]);
    await c.query("delete from nominations where family_id=$1 and nominee_name='Test Nominee'", [FAMILY]);
    await c.query("delete from ownership_links where family_id=$1 and owned_type='lifestyle_asset'", [FAMILY]);
    await c.query("update lifestyle_assets set include_in_net_worth=false where id=$1", [ART]);
    await c.query("update insurance_policies set next_premium_due='2026-09-28' where id=$1", [HEALTH]);
  });
}
afterAll(async () => {
  await cleanup();
  await run(async (c) => {
    for (const s of scheduleBefore) await c.query("update liability_schedule set paid_on=$2, bank_txn_id=$3, matched_at=$4 where id=$1", [s.id, s.paid_on, s.bank_txn_id, s.matched_at]);
    for (const l of liabBefore) await c.query("update liabilities set outstanding=$2, outstanding_as_of=$3, ltv_pct=$4, tax_section=$5 where id=$1", [l.id, l.outstanding, l.outstanding_as_of, l.ltv_pct, l.tax_section]);
    if (outflowsBefore.length) await c.query("delete from committed_outflows where family_id=$1 and id::text <> all($2::text[])", [FAMILY, outflowsBefore]);
    else await c.query("delete from committed_outflows where family_id=$1 and source_type in ('liability_schedule','insurance_policy')", [FAMILY]);
  });
  await app.close(); await pool.end();
});

describe("net worth", () => {
  it("is assets less liabilities on /net-worth and the dashboard, and look-through conserves the total", async () => {
    const nw = (await get("/net-worth")).body;
    expect(near(Number(nw.assets) - Number(nw.liabilities), nw.net_worth)).toBe(true);
    expect(near(nw.by_class.reduce((s: number, r: any) => s + Number(r.value), 0), nw.assets)).toBe(true);
    expect(near(nw.by_entity.reduce((s: number, e: any) => s + Number(e.net_worth), 0), nw.net_worth)).toBe(true);
    expect(near(nw.by_entity.reduce((s: number, e: any) => s + Number(e.lookthrough_net_worth), 0), nw.net_worth, 0.1)).toBe(true);
    expect(Number(nw.liabilities)).toBeGreaterThan(0); expect(nw.liabilities_detail.length).toBeGreaterThanOrEqual(3); expect(nw.liabilities_detail.some((l: any) => l.type === "card")).toBe(true);   // the card balance counts as a liability
    const d = (await get("/dashboard")).body; expect(d.net_worth).toBe(nw.net_worth); expect(d.assets).toBe(nw.assets); expect(d.liabilities).toBe(nw.liabilities);
    expect(d.by_entity.find((e: any) => e.name.match(/HUF/)).net_worth ?? d.by_entity.find((e: any) => e.name.match(/HUF/)).value).toBeDefined();
  });
  it("splits Mehta Textiles 60/40 through the ownership graph: Arjun's look-through exceeds his headline by 40% of the stake", async () => {
    const nw = (await get("/net-worth")).body; const huf = (await get(`/net-worth?entity_id=${HUF}`)).body;
    const mehta = Number(huf.by_class.find((r: any) => r.klass === "operating_business").value); expect(mehta).toBeGreaterThan(0);
    const arjun = nw.by_entity.find((e: any) => e.entity_id === ARJUN);
    expect(near(Number(arjun.lookthrough_net_worth) - Number(arjun.net_worth), mehta * 0.4, 0.05)).toBe(true);
    const g = (await get("/ownership")).body; expect(g.edges.some((l: any) => l.owned_id === "67676767-0000-0000-0000-000000000006" && Number(l.pct) === 60)).toBe(true);
  });
  it("counts the ULIP's fund value once, and a lifestyle asset only when it is included", async () => {
    const nw = (await get("/net-worth")).body;
    expect(nw.by_class.find((r: any) => r.klass === "insurance_value").value).toBe("38500.00");
    expect(near(nw.by_class.find((r: any) => r.klass === "lifestyle").value, 52000 + 92000)).toBe(true);   // car + jewellery; the canvas is excluded
    const p = await send("PATCH", `/lifestyle-assets/${ART}`, { include_in_net_worth: true }); expect(p.code).toBe(200);
    const after = (await get("/net-worth")).body; expect(near(Number(after.assets) - Number(nw.assets), 45000)).toBe(true);
    await send("PATCH", `/lifestyle-assets/${ART}`, { include_in_net_worth: false });
    const v = await send("POST", `/lifestyle-assets/${JEWEL}/valuations`, { valued_on: "2026-09-10", value: 95000, source: "jeweller appraisal" }); expect(v.code).toBe(201);
    expect((await get(`/lifestyle-assets/${JEWEL}`)).body.current_value).toBe("95000.00");
    await run((c) => c.query("delete from lifestyle_valuations where asset_id=$1 and valued_on='2026-09-10'", [JEWEL]).then(() => c.query("update lifestyle_assets set current_value=92000, valued_on='2026-06-30' where id=$1", [JEWEL])));
  });
});

describe("liabilities", () => {
  it("builds the amortisation schedule from the terms and matches the EMI to the bank debit", async () => {
    const emi = emiFor(24000, 12, 24); expect(near(emi, 1129.76)).toBe(true);
    const r = await send("POST", "/liabilities", { entity_id: ARJUN, kind: "personal_loan", lender: "Test Finance", principal_original: 24000, rate_pct: 12, emi, emi_day: 5, start_date: "2026-07-05", bank_account_id: ARJUN_HDFC });
    expect(r.code).toBe(201); const id = r.body.id;
    const sched = (await get(`/liabilities/${id}/schedule`)).body; expect(sched.length).toBe(24); expect(near(sched[0].emi, emi)).toBe(true); expect(sched[0].due_date).toBe("2026-08-05");
    expect(near(sched.reduce((s: number, x: any) => s + Number(x.principal), 0), 24000)).toBe(true);
    await run((c) => c.query("insert into bank_txns (family_id, bank_account_id, txn_date, narration, amount, hash, source) values ($1,$2,'2026-09-06','ACH D- TEST FINANCE EMI',$3,'bal-test-emi','csv')", [FAMILY, ARJUN_HDFC, -Math.round(emi)]));
    const m = await send("POST", "/liabilities/match-emis"); expect(m.code).toBe(200); expect(m.body.matched).toBeGreaterThanOrEqual(1);
    const after = (await get(`/liabilities/${id}/schedule`)).body; const sep = after.find((x: any) => x.due_date === "2026-09-05");
    expect(sep.paid_on).toBe("2026-09-06"); expect(sep.bank_txn_id).toBeTruthy(); expect(after.find((x: any) => x.due_date === "2026-08-05").paid_on).toBeNull();
    const l = (await get(`/liabilities/${id}`)).body; expect(Number(l.outstanding)).toBeLessThan(24000); expect(Number(l.outstanding)).toBeGreaterThan(22000);
    const d = await send("DELETE", `/liabilities/${id}`); expect(d.code).toBe(204);
  });
  it("feeds the home loan's 24(b) interest into the HUF's house-property head", async () => {
    const a = (await get(`/tax/projection?fy=2026-27&entity_id=${HUF}`)).body[0].heads.house_property;
    await send("PATCH", `/liabilities/${HOME_LOAN}`, { tax_section: "none" });
    const b = (await get(`/tax/projection?fy=2026-27&entity_id=${HUF}`)).body[0].heads.house_property;
    await send("PATCH", `/liabilities/${HOME_LOAN}`, { tax_section: "24b" });
    const interest = await run(async (c) => Number((await c.query("select sum(interest) v from liability_schedule where liability_id=$1 and due_date between '2026-04-01' and '2027-03-31'", [HOME_LOAN])).rows[0].v));
    expect(interest).toBeGreaterThan(8000); expect(near(Number(b) - Number(a), interest, 1)).toBe(true);
  });
  it("raises a task when a loan against securities breaches its LTV alert", async () => {
    const l = (await get(`/liabilities/${LAS}`)).body; expect(l.ltv_breach).toBe(true); expect(Number(l.ltv_pct)).toBeGreaterThan(50);
    const r = await run((c) => gen("ltv_breach").run(c, FAMILY, TODAY)); const d = r.drafts.find((x: any) => x.source_id === LAS);
    expect(d).toBeDefined(); expect(d.title).toMatch(/LTV 56\.\d+% on Kotak Securities/); expect(d.reason).toMatch(/top up the margin/); expect(d.severity).toBe(1);
  });
});

describe("insurance", () => {
  it("premiums due within 30 days raise tasks and stand as committed outflows until paid", async () => {
    const r = await run((c) => gen("premium_due").run(c, FAMILY, TODAY)); const titles = r.drafts.map((d: any) => d.title).join(" | ");
    expect(r.drafts.length).toBe(2); expect(titles).toMatch(/Star Health/); expect(titles).toMatch(/HDFC Life/);
    await run((c) => syncOutflows(c, FAMILY, TODAY));
    const o = await run(async (c) => (await c.query("select status, amount, due_date::text from committed_outflows where family_id=$1 and source_type='insurance_policy' and source_id=$2", [FAMILY, HEALTH])).rows[0]);
    expect(o).toMatchObject({ status: "pending", amount: "2400.00", due_date: "2026-09-28" });
    const p = await send("POST", `/insurance-policies/${HEALTH}/premium-paid`, { paid_on: "2026-09-27" }); expect(p.code).toBe(200); expect(p.body.next_premium_due).toBe("2027-09-28");
    const o2 = await run(async (c) => (await c.query("select status from committed_outflows where family_id=$1 and source_type='insurance_policy' and source_id=$2 and due_date='2026-09-28'", [FAMILY, HEALTH])).rows[0]);
    expect(o2.status).toBe("done");
    expect((await run((c) => gen("premium_due").run(c, FAMILY, TODAY))).drafts.length).toBe(1);
  });
  it("adequacy lists the uninsured jewellery and the life-cover gap per individual", async () => {
    const a = (await get("/insurance/adequacy")).body;
    expect(a.uninsured.some((u: any) => u.id === JEWEL && u.type === "jewellery")).toBe(true); expect(a.uninsured.some((u: any) => u.type === "vehicle")).toBe(false);
    const arjun = a.life.find((l: any) => l.entity_id === ARJUN); expect(Number(arjun.life_cover)).toBeGreaterThanOrEqual(2000000); expect(arjun.need).toBeGreaterThan(0); expect(typeof arjun.adequacy_pct).toBe("number");
    expect(a.health.find((m: any) => m.member.match(/Arjun/)).health_cover).toBe("500000.00");
    expect(a.premium_calendar.length).toBeGreaterThanOrEqual(4); expect(Number(a.annual_premiums)).toBeGreaterThan(0);
  });
});

describe("succession", () => {
  it("nominee gaps raise per asset and disappear from the run once a verified nomination is recorded", async () => {
    const r1 = await run((c) => gen("nominee_gap").run(c, FAMILY, TODAY)); const tcs = r1.drafts.find((d: any) => d.source_id === TCS_HOLDING);
    expect(tcs).toBeDefined(); expect(tcs.title).toMatch(/nominee/i); expect(tcs.module).toBe("balance_sheet");
    const gaps = (await get("/succession/gaps")).body;
    expect(gaps.some((g: any) => g.issue === "will_missing" && g.entity_id === SPOUSE)).toBe(true); expect(gaps.some((g: any) => g.issue === "review_overdue" && g.asset_id === WILL)).toBe(true);
    const n = await send("POST", "/nominations", { asset_type: "holding", asset_id: TCS_HOLDING, nominee_name: "Test Nominee", nominee_relation: "spouse", share_pct: 100, registered_with: "CDSL", verified_on: "2026-09-01" }); expect(n.code).toBe(201);
    const r2 = await run((c) => gen("nominee_gap").run(c, FAMILY, TODAY)); expect(r2.drafts.some((d: any) => d.source_id === TCS_HOLDING)).toBe(false);
    expect(r2.resolved!.some((x: any) => x.source_id === TCS_HOLDING)).toBe(false);   // nothing was open, nothing to close
    const s = (await get("/succession/summary")).body; expect(s.nominated).toBeGreaterThan(0); expect(s.documents.find((d: any) => d.id === WILL).overdue).toBe(true);
  });
  it("ownership links cannot exceed 100% of an asset", async () => {
    const bad = await send("PUT", "/ownership", [{ owner_entity_id: ARJUN, owned_type: "lifestyle_asset", owned_id: JEWEL, pct: 60 }, { owner_entity_id: SPOUSE, owned_type: "lifestyle_asset", owned_id: JEWEL, pct: 50 }]);
    expect(bad.code).toBe(422);
    const ok = await send("PUT", "/ownership", [{ owner_entity_id: ARJUN, owned_type: "lifestyle_asset", owned_id: JEWEL, pct: 60 }, { owner_entity_id: SPOUSE, owned_type: "lifestyle_asset", owned_id: JEWEL, pct: 40 }]);
    expect(ok.code).toBe(200);
    const g = (await get("/ownership")).body; expect(g.edges.filter((l: any) => l.owned_id === JEWEL).length).toBe(2);
  });
});
