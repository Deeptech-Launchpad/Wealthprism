import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildApp } from "../src/server.js";
import { pool, withFamily } from "../src/lib/db.js";
import { generators } from "../src/jobs/tasks.js";

// Analytics (PRD 3.12; FO-97..99, 101, 102): look-through exposure, IPS rules, private-market metrics, all-in fees, cash-flow forecast and
// reconciliation. Everything this file creates is removed in teardown and the HDFC Bank holding is restored.
const FAMILY = "11111111-1111-1111-1111-111111111111", ARJUN = "33333333-0000-0000-0000-000000000001", VARAHA = "67676767-0000-0000-0000-000000000005", HDFC_HOLDING = "46464646-0000-0000-0000-000000000001";
const TODAY = "2026-09-12";
let app: ReturnType<typeof buildApp>; let owner = "", member = "";
const h = (t = owner) => ({ authorization: `Bearer ${t}`, "x-family-id": FAMILY });
const get = async (url: string, t = owner) => { const r = await app.inject({ url: `/api/v1${url}`, headers: h(t) }); return { code: r.statusCode, body: r.json() }; };
const send = async (method: "POST" | "PATCH" | "DELETE", url: string, payload: any = {}, t = owner) => { const r = await app.inject({ method, url: `/api/v1${url}`, headers: h(t), payload }); return { code: r.statusCode, body: r.statusCode === 204 ? null : r.json() }; };
const run = <T>(fn: (c: any) => Promise<T>) => withFamily(FAMILY, fn);
const gen = (name: string) => generators.find((g) => g.name === name)!;
const sum = (rows: any[], k: string) => rows.reduce((s, r) => s + Number(r[k]), 0);
let holdingBefore: any, lotsBefore: string[] = [], forecastBefore: any[] = [];

beforeAll(async () => {
  app = buildApp(); await app.ready();
  const login = async (email: string) => (await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password: "Prototype!2026" } })).json().access_token;
  owner = await login("arjun@example.com"); member = await login("priya@example.com");
  await cleanup();
  await run(async (c) => { holdingBefore = (await c.query("select quantity, avg_cost from holdings where id=$1", [HDFC_HOLDING])).rows[0]; lotsBefore = (await c.query("select id from lots where holding_id=$1", [HDFC_HOLDING])).rows.map((r) => r.id); forecastBefore = (await c.query("select * from cashflow_forecast where family_id=$1", [FAMILY])).rows; });
});
async function cleanup() {
  await run(async (c) => {
    const rules = (await c.query("select id from ips_rules where family_id=$1 and code='max_single_issuer' and severity=3", [FAMILY])).rows.map((r) => r.id);
    const breaches = (await c.query("select id, task_id from ips_breaches where family_id=$1 and rule_id = any($2::uuid[])", [FAMILY, rules])).rows;
    await c.query("delete from ips_breaches where id = any($1::uuid[])", [breaches.map((b) => b.id)]);
    await c.query("delete from tasks where family_id=$1 and (id = any($2::uuid[]) or source_type='forecast_float' or source_type='reconciliation_item' and source_id in (select id from reconciliation_items where source='ecas_nsdl'))", [FAMILY, breaches.map((b) => b.task_id).filter(Boolean)]);
    await c.query("delete from ips_rules where id = any($1::uuid[])", [rules]);
    await c.query("delete from audit_log where family_id=$1 and table_name='reconciliation_items' and row_id in (select id from reconciliation_items where source='ecas_nsdl')", [FAMILY]);
    await c.query("delete from reconciliation_items where family_id=$1 and source='ecas_nsdl'", [FAMILY]);
  });
}
afterAll(async () => {
  await cleanup();
  await run(async (c) => {
    if (holdingBefore) { await c.query("update holdings set quantity=$2 where id=$1", [HDFC_HOLDING, holdingBefore.quantity]); await c.query("delete from lots where holding_id=$1 and id::text <> all($2::text[])", [HDFC_HOLDING, lotsBefore]); }
    await c.query("delete from cashflow_forecast where family_id=$1", [FAMILY]);
    for (const f of forecastBefore) await c.query("insert into cashflow_forecast (family_id, entity_id, month, kind, amount, source_type, source_id, label) values ($1,$2,$3,$4,$5,$6,$7,$8) on conflict do nothing", [FAMILY, f.entity_id, f.month, f.kind, f.amount, f.source_type, f.source_id, f.label]);
  });
  await app.close(); await pool.end();
});

describe("exposure", () => {
  it("sums to 100% on every dimension with the unclassified remainder shown explicitly", async () => {
    const all = (await get("/exposure/all")).body; expect(all.dimensions.length).toBe(10);
    for (const d of all.dimensions) { const rows = all.exposure[d]; expect(rows.length).toBeGreaterThan(0); expect(Math.abs(sum(rows, "pct") - 100)).toBeLessThan(0.1); }
    const rating = (await get("/exposure?by=rating&full=1")).body; expect(rating.rows.some((r: any) => r.key === "unrated")).toBe(true); expect(Number(rating.total)).toBeGreaterThan(0);
    const sector = (await get("/exposure?by=sector")).body; expect(sector.some((r: any) => r.key === "unclassified")).toBe(true);
    expect(sector.filter((r: any) => r.key !== "unclassified").length).toBeGreaterThan(2);   // funds split through to their underlying sectors
    const bad = await get("/exposure?by=colour"); expect(bad.code).toBe(422);
  });
  it("a stored instrument composition overrides the factsheet look-through", async () => {
    const ppfas = await run(async (c) => (await c.query("select id from instruments where name like 'Parag Parikh%'")).rows[0].id);
    const before = (await get(`/instruments/${ppfas}/exposure`)).body; expect(before.source).toMatch(/factsheet/); expect(before.rows.length).toBeGreaterThan(1);
    const us0 = Number((await get("/exposure?by=geography")).body.find((r: any) => r.key === "US")?.value ?? 0);
    expect((await send("PUT", `/instruments/${ppfas}/exposure`, { rows: [{ alloc_class: "equity", country: "IN", pct: 60 }, { alloc_class: "global", country: "US", pct: 50 }] })).code).toBe(422);
    const put = await send("PUT", `/instruments/${ppfas}/exposure`, { rows: [{ alloc_class: "equity", country: "IN", pct: 40 }, { alloc_class: "global", country: "US", pct: 55 }], source: "AMC portfolio Aug-26" }); expect(put.code).toBe(200);
    expect(put.body.source).toBe("AMC portfolio Aug-26"); expect(put.body.rows.map((r: any) => r.pct)).toEqual([55, 40]);
    const us1 = Number((await get("/exposure?by=geography")).body.find((r: any) => r.key === "US")?.value ?? 0); expect(us1).toBeGreaterThan(us0);
    await run((c) => c.query("delete from instrument_exposure where instrument_id=$1", [ppfas]));
    expect((await get(`/instruments/${ppfas}/exposure`)).body.source).toMatch(/factsheet/);
  });
});

describe("IPS rules", () => {
  it("flags the top issuer against a tighter limit, opens a task, and closes it once the limit is met again", async () => {
    const props = (await get("/properties")).body.map((p: any) => p.name);
    const issuers = (await get("/exposure?by=issuer")).body.filter((r: any) => !props.includes(r.key) && !["direct", "unclassified", "cash"].includes(r.key));
    const top = issuers[0]; expect(Number(top.pct)).toBeGreaterThan(1);
    const limit = Math.floor(Number(top.pct) * 0.8 * 100) / 100;
    const r = await send("POST", "/ips-rules", { code: "max_single_issuer", params: { pct: limit }, severity: 3 }); expect(r.code).toBe(201);
    const ev = await send("POST", "/ips-rules/evaluate"); expect(ev.code).toBe(200);
    const mine = ev.body.results.find((x: any) => x.rule_id === r.body.id); expect(mine.ok).toBe(false); expect(mine.detail).toMatch(new RegExp(top.key.slice(0, 8)));
    const open = (await get("/ips-breaches")).body.find((b: any) => b.rule_id === r.body.id); expect(open).toBeDefined(); expect(open.resolved_on).toBeNull();
    const task = await run(async (c) => (await c.query("select status, title, severity from tasks where family_id=$1 and source_type='ips_breach' and source_id=$2", [FAMILY, open.id])).rows[0]);
    expect(task).toMatchObject({ status: "open", severity: 3 }); expect(task.title).toMatch(/max single issuer/);
    expect((await send("PATCH", `/ips-rules/${r.body.id}`, { params: { pct: Number(top.pct) + 5 } })).code).toBe(200);
    await send("POST", "/ips-rules/evaluate");
    const closed = (await get("/ips-breaches?all=1")).body.find((b: any) => b.id === open.id); expect(closed.resolved_on).toBe(TODAY.slice(0, 4) + closed.resolved_on.slice(4));
    expect((await run(async (c) => (await c.query("select status from tasks where source_type='ips_breach' and source_id=$1", [open.id])).rows[0])).status).toBe("done");
    expect((await send("POST", "/ips-rules", { code: "max_single_issuer", params: { pct: 1 } }, member)).code).toBe(201);   // members may set policy rules
    await run((c) => c.query("delete from ips_rules where family_id=$1 and code='max_single_issuer' and params->>'pct'='1'", [FAMILY]));
  });
});

describe("private markets", () => {
  it("computes Varaha Fund II's DPI / TVPI from the call and distribution history and forecasts the remaining calls", async () => {
    const m = (await get(`/private-investments/${VARAHA}/metrics`)).body;
    expect(m.paid_in).toBe("120000.00"); expect(m.distributed).toBe("9000.00"); expect(m.commitment).toBe("160000.00"); expect(m.unfunded).toBe("40000.00");
    expect(Math.abs(m.dpi - 0.075)).toBeLessThan(0.006); expect(Math.abs(m.tvpi - (m.dpi + m.rvpi))).toBeLessThan(0.011); expect(m.tvpi).toBeGreaterThan(0.9);
    expect(typeof m.irr_pct).toBe("number"); expect(m.pme == null || typeof m.pme === "number").toBe(true);
    const calls = m.forecast.filter((f: any) => Number(f.calls) > 0); expect(calls.some((f: any) => f.month === "2026-10" && Number(f.calls) >= 20000)).toBe(true); expect(calls.some((f: any) => f.month === "2027-04")).toBe(true);
    const all = (await get("/private-metrics")).body; expect(all.length).toBeGreaterThanOrEqual(5); expect(all.find((x: any) => x.instrument === "operating_business").valuation_basis).toMatch(/audited profit/);
    const f = await send("POST", `/private-investments/${VARAHA}/cashflows`, { flow_date: "2026-08-20", kind: "distribution", amount: 1000 }); expect(f.code).toBe(201);
    expect((await get(`/private-investments/${VARAHA}/metrics`)).body.distributed).toBe("10000.00");
    expect((await send("DELETE", `/private-investments/${VARAHA}/cashflows/${f.body.id}`)).code).toBe(204);
  });
});

describe("fees", () => {
  it("adds ledger fees, implied TER and contract-note charges and states them as a % of AUM", async () => {
    const f = (await get("/fees?fy=2026-27")).body;
    expect(f.rows.length).toBeGreaterThanOrEqual(6); expect(Math.abs(sum(f.rows, "amount") - Number(f.total))).toBeLessThan(0.02);
    expect(f.by_kind.some((k: any) => k.key === "advisor" && k.amount === "1500.00")).toBe(true); expect(f.by_kind.some((k: any) => k.key === "ter_implied")).toBe(true);
    expect(Math.abs(sum(f.by_kind, "amount") - Number(f.total))).toBeLessThan(0.02);
    const pct = (Number(f.total) / Number(f.aum)) * 100; expect(Math.abs(f.pct_of_aum - pct) / pct).toBeLessThan(0.01);
    expect(f.annualised_pct_of_aum).toBeGreaterThan(f.pct_of_aum);
    const e = (await get(`/fees?fy=2026-27&entity_id=${ARJUN}`)).body; expect(Number(e.total)).toBeLessThan(Number(f.total)); expect(e.by_entity.length).toBe(1);
  });
});

describe("cash-flow forecast", () => {
  it("dips below the float in October on the Varaha call and raises the task 45 days ahead", async () => {
    const ran = await send("POST", "/cashflow/forecast/run", { months: 12 }); expect(ran.code).toBe(200); expect(ran.body.months).toBe(12);
    expect(ran.body.first_below_float).not.toBeNull(); expect(ran.body.first_below_float! <= "2026-10").toBe(true);
    const r = await get("/cashflow/forecast?months=12&full=1"); expect(r.body.rows.length).toBe(12); expect(r.body.first_below_float).toBe(ran.body.first_below_float);
    const oct = r.body.rows.find((x: any) => x.month === "2026-10"); expect(Number(oct.by_kind.capital_call)).toBeLessThanOrEqual(-20000); expect(oct.below_float).toBe(true);
    expect(r.body.rows.every((x: any) => Number(x.inflows) >= 0 && Number(x.outflows) >= 0)).toBe(true);
    expect(r.body.rows.filter((x: any) => Number(x.by_kind.rent ?? 0) > 2500).length).toBeGreaterThanOrEqual(10);   // lease rent projected past the generated schedule
    expect(r.body.items.some((i: any) => i.kind === "emi")).toBe(true);
    const gaps = await run(async (c) => (await c.query("select month::text from cashflow_forecast where family_id=$1 and kind='float_gap' order by month", [FAMILY])).rows);
    expect(gaps.length).toBeGreaterThanOrEqual(2);
    const t = await run((c) => gen("forecast_below_float").run(c, FAMILY, TODAY)); expect(t.drafts.length).toBe(1); expect(t.drafts[0].title).toMatch(/below the float in (September|October) 2026/); expect(t.drafts[0].module).toBe("banking");
  });
});

describe("reconciliation", () => {
  it("raises a mismatch for a 10-unit difference and accept_source adjusts the holding with an audit trail", async () => {
    const r = await send("POST", "/reconciliation", { source: "ecas_nsdl", entity_id: ARJUN, positions: [{ isin: "INE040A01034", quantity: 52 }] }); expect(r.code).toBe(202);
    expect(r.body.items.length).toBe(1); const it_ = r.body.items[0]; expect(it_).toMatchObject({ status: "mismatch", platform_qty: 42, source_qty: 52, holding_id: HDFC_HOLDING });
    const task = await run(async (c) => (await c.query("select status, title from tasks where family_id=$1 and source_type='reconciliation_item' and source_id=$2", [FAMILY, it_.id])).rows[0]); expect(task.status).toBe("open"); expect(task.title).toMatch(/HDFC Bank/);
    const again = await send("POST", "/reconciliation", { source: "ecas_nsdl", entity_id: ARJUN, positions: [{ isin: "INE040A01034", quantity: 52 }] }); expect(again.body.items.length).toBe(0);   // the open item is refreshed, not duplicated
    const res = await send("POST", `/reconciliation/${it_.id}/resolve`, { action: "accept_source", note: "eCAS is right; a bonus credit was missed" }); expect(res.code).toBe(200); expect(res.body.status).toBe("resolved");
    const h = await run(async (c) => ({ qty: Number((await c.query("select quantity from holdings where id=$1", [HDFC_HOLDING])).rows[0].quantity), lots: Number((await c.query("select coalesce(sum(remaining_qty),0) v from lots where holding_id=$1", [HDFC_HOLDING])).rows[0].v) }));
    expect(h.qty).toBe(52); expect(h.lots).toBe(52);
    const audit = await run(async (c) => (await c.query("select action, before, after from audit_log where family_id=$1 and table_name='reconciliation_items' and row_id=$2", [FAMILY, it_.id])).rows[0]);
    expect(audit.action).toBe("reconcile:accept_source"); expect(audit.before).toEqual({ quantity: 42 }); expect(audit.after.quantity).toBe(52);
    expect((await run(async (c) => (await c.query("select status, verification from tasks where source_type='reconciliation_item' and source_id=$1", [it_.id])).rows[0]))).toMatchObject({ status: "done", verification: "verified" });
    expect((await send("POST", `/reconciliation/${it_.id}/resolve`, { action: "ignore" })).code).toBe(409);
    const list = (await get("/reconciliation?status=resolved")).body; expect(list.some((x: any) => x.id === it_.id && x.resolution === "accept_source")).toBe(true);
  });
});
