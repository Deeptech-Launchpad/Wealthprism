import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildApp } from "../src/server.js";
import { pool, withFamily } from "../src/lib/db.js";
import { generators } from "../src/jobs/tasks.js";

// Residue (FO-44, 45, 60; PRD 3.5, 3.6): goals with links and funded %, bucket targets / glide paths / a tax-aware bucket proposal, the
// asset-class lens (model → targets → status → band and review tasks), working-capital settings / plan / tasks / ladder. Self-cleaning.
const FAMILY = "11111111-1111-1111-1111-111111111111", SPOUSE = "33333333-0000-0000-0000-000000000003", ARJUN = "33333333-0000-0000-0000-000000000001", TCS_HOLDING = "46464646-0000-0000-0000-000000000007", MBA_GOAL = "77777777-0000-0000-0000-000000000001";
const TODAY = "2026-09-12";
let app: ReturnType<typeof buildApp>; let owner = "", viewer = "";
const h = (t = owner) => ({ authorization: `Bearer ${t}`, "x-family-id": FAMILY });
const get = async (url: string, t = owner) => { const r = await app.inject({ url: `/api/v1${url}`, headers: h(t) }); return { code: r.statusCode, body: r.json() }; };
const send = async (method: "POST" | "PATCH" | "PUT" | "DELETE", url: string, payload: any = {}, t = owner) => { const r = await app.inject({ method, url: `/api/v1${url}`, headers: h(t), payload }); return { code: r.statusCode, body: r.statusCode === 204 ? null : r.json() }; };
const run = <T>(fn: (c: any) => Promise<T>) => withFamily(FAMILY, fn);
const gen = (name: string) => generators.find((g) => g.name === name)!;
let before: any = {};

beforeAll(async () => {
  app = buildApp(); await app.ready();
  const login = async (email: string) => (await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password: "Prototype!2026" } })).json().access_token;
  owner = await login("arjun@example.com"); viewer = await login("ca@example.com");
  await run(async (c) => { before.bt = (await c.query("select id from bucket_targets where family_id=$1", [FAMILY])).rows.map((r) => r.id); before.act = (await c.query("select id from asset_class_targets where family_id=$1", [FAMILY])).rows.map((r) => r.id); before.policy = (await c.query("select * from allocation_policies where family_id=$1", [FAMILY])).rows[0]; before.wc = (await c.query("select * from wc_settings where family_id=$1", [FAMILY])).rows[0]; before.glide = (await c.query("select goal_id, steps from glide_paths where family_id=$1", [FAMILY])).rows; before.tcsGoal = (await c.query("select goal_id from holdings where id=$1", [TCS_HOLDING])).rows[0].goal_id; });
  await cleanup();
});
async function cleanup() {
  await run(async (c) => {
    await c.query("delete from tasks where family_id=$1 and source_type in ('bucket_move','allocation_band','allocation_review','deployment_plan')", [FAMILY]);
    await c.query("delete from deployment_plans where family_id=$1 and created_at > now() - interval '1 day'", [FAMILY]);
    if (before.bt) await c.query("delete from bucket_targets where family_id=$1 and id::text <> all($2::text[])", [FAMILY, before.bt]);
    if (before.act) await c.query("delete from asset_class_targets where family_id=$1 and id::text <> all($2::text[])", [FAMILY, before.act]);
    if (before.policy) await c.query("update allocation_policies set strategy=$2, model_portfolio_id=$3, review_every_months=$4, next_review_on=$5, rebalance_trigger_pp=$6, include_self_occupied=$7, include_epf_ppf=$8 where family_id=$1", [FAMILY, before.policy.strategy, before.policy.model_portfolio_id, before.policy.review_every_months, before.policy.next_review_on, before.policy.rebalance_trigger_pp, before.policy.include_self_occupied, before.policy.include_epf_ppf]);
    if (before.wc) await c.query("update wc_settings set float_days=$2, buffer_months=$3, idle_days=$4, instrument_prefs=$5 where family_id=$1", [FAMILY, before.wc.float_days, before.wc.buffer_months, before.wc.idle_days, before.wc.instrument_prefs]);
    const mine = (await c.query("select id from goals where family_id=$1 and name like 'Test goal%'", [FAMILY])).rows.map((r) => r.id);
    if (mine.length) { await c.query("update holdings set goal_id=null where goal_id = any($1::uuid[])", [mine]); await c.query("delete from glide_paths where goal_id = any($1::uuid[])", [mine]); await c.query("delete from goal_links where goal_id = any($1::uuid[])", [mine]); await c.query("delete from goals where id = any($1::uuid[])", [mine]); }
    if (before.tcsGoal !== undefined) await c.query("update holdings set goal_id=$2 where id=$1", [TCS_HOLDING, before.tcsGoal]);
    for (const g of before.glide ?? []) await c.query("update glide_paths set steps=$2 where goal_id=$1", [g.goal_id, JSON.stringify(g.steps)]);
    await c.query("delete from model_portfolios where family_id=$1 and code like 'test_%'", [FAMILY]);
  });
}
afterAll(async () => { await cleanup(); await app.close(); await pool.end(); });

describe("goals and buckets", () => {
  it("creates a goal, links assets with a share, and reports funded % and the monthly gap", async () => {
    const g = await send("POST", "/goals", { entity_id: SPOUSE, name: "Test goal — Ooty cottage", target_year: 2032, amount_today: 500000, inflation_pct: 6, bucket: "growth", assumed_return_pct: 10 }); expect(g.code).toBe(201);
    expect(Number(g.body.inflated_need)).toBeGreaterThan(500000); expect(g.body.funded_pct).toBe(0); expect(g.body.years_left).toBe(6); expect(Number(g.body.monthly_required)).toBeGreaterThan(0);
    expect((await send("PUT", `/goals/${g.body.id}/links`, [{ holding_id: TCS_HOLDING, property_id: "55555555-0000-0000-0000-000000000003" }])).code).toBe(422);
    const l = await send("PUT", `/goals/${g.body.id}/links`, [{ holding_id: TCS_HOLDING, allocation_pct: 50 }]); expect(l.code).toBe(200);
    const tcs = (await get("/holdings?limit=100")).body.items.find((x: any) => x.id === TCS_HOLDING); expect(Number(l.body.linked_value)).toBeCloseTo(Number(tcs.value) / 2, 0); expect(l.body.funded_pct).toBeGreaterThan(0); expect(l.body.links[0].name).toMatch(/Tata/);
    const p = await send("PATCH", `/goals/${g.body.id}`, { amount_today: 250000 }); expect(Number(p.body.inflated_need)).toBeLessThan(Number(g.body.inflated_need)); expect(p.body.funded_pct).toBeGreaterThan(l.body.funded_pct);
    expect((await get("/goals")).body.some((x: any) => x.id === g.body.id && Number(x.funded_pct) === p.body.funded_pct)).toBe(true);
    expect((await send("POST", "/goals", { name: "Test goal — no", target_year: 2030, amount_today: 1, bucket: "growth" }, viewer)).code).toBe(403);
  });
  it("bucket targets must total 100, apply to the drift view, and glide paths only de-risk", async () => {
    expect((await send("PUT", "/bucket-targets", { liquidity_pct: 50, income_pct: 30, growth_pct: 30 })).code).toBe(422);
    const t = await send("PUT", "/bucket-targets", { liquidity_pct: 10, income_pct: 30, growth_pct: 60, drift_threshold_pp: 4 }); expect(t.code).toBe(200); expect(t.body).toMatchObject({ liquidity_pct: 10, income_pct: 30, growth_pct: 60, drift_threshold_pp: 4, inherited: false });
    expect((await get("/buckets/drift")).body.find((b: any) => b.bucket === "liquidity").targetPct).toBe(10);
    expect((await get(`/bucket-targets?entity_id=${SPOUSE}`)).body.inherited).toBe(true);
    expect((await send("PUT", "/glide-paths", { goal_id: MBA_GOAL, steps: [{ year: 2026, growth_pct: 40 }, { year: 2028, growth_pct: 50 }] })).code).toBe(422);
    const gp = await send("PUT", "/glide-paths", { goal_id: MBA_GOAL, steps: [{ year: 2028, growth_pct: 30 }, { year: 2026, growth_pct: 40 }] }); expect(gp.code).toBe(200); expect(gp.body.steps.map((s: any) => s.year)).toEqual([2026, 2028]);
    expect((await get("/glide-paths")).body.find((x: any) => x.goal_id === MBA_GOAL).goal).toMatch(/MBA/);
  });
  it("the rebalance proposal moves value out of the over-target bucket from the holdings with the smallest taxable gain", async () => {
    await send("PUT", "/bucket-targets", { liquidity_pct: 60, income_pct: 30, growth_pct: 10, drift_threshold_pp: 2 });
    const r = await send("POST", "/buckets/rebalance-proposal", { create_tasks: true }); expect(r.code).toBe(200);
    expect(r.body.drift.length).toBe(3); const over = r.body.drift.find((d: any) => d.bucket === "growth"); expect(over.breached).toBe(true); expect(over.driftPp).toBeGreaterThan(0);
    expect(r.body.moves.length).toBeGreaterThan(0); const m = r.body.moves[0]; const worst = [...r.body.drift].filter((d: any) => d.breached && d.driftPp > 0).sort((a: any, b: any) => b.driftPp - a.driftPp)[0]; expect(m).toMatchObject({ from_bucket: worst.bucket, to_bucket: "liquidity" }); expect(m.to_instrument).toMatch(/Liquid/); expect(Number(m.amount)).toBeGreaterThan(0); expect(m.tax_impact).toMatch(/^\d+\.\d{2}$/); expect(m.reason).toMatch(/smallest taxable gain/); expect(m.task_id).toBeTruthy();
    const gains = r.body.moves.map((x: any) => Number(x.est_gain) / Number(x.amount)); expect(gains).toEqual([...gains].sort((a, b) => a - b));   // cheapest tax first
    expect(r.body.tasks_created).toBe(r.body.moves.length); expect(Number(r.body.est_tax_total)).toBeCloseTo(r.body.moves.reduce((s: number, x: any) => s + Number(x.tax_impact), 0), 1);
    expect((await run(async (c) => (await c.query("select count(*)::int n from tasks where family_id=$1 and source_type='bucket_move' and status='open'", [FAMILY])).rows[0].n))).toBe(r.body.moves.length);
    await send("PUT", "/bucket-targets", { liquidity_pct: 8, income_pct: 32, growth_pct: 60, drift_threshold_pp: 40 }); expect((await send("POST", "/buckets/rebalance-proposal", {})).body.moves).toEqual([]);
  });
});

describe("asset-class lens", () => {
  it("applying the Moderate model sets 60/30/10 with bands; the status shows headline vs look-through and flags breaches", async () => {
    const models = (await get("/model-portfolios")).body; const moderate = models.find((m: any) => m.code === "moderate"); expect(moderate.system).toBe(true); expect(models.length).toBeGreaterThanOrEqual(5);
    const t = await send("PUT", "/asset-class-targets", { model_portfolio_id: moderate.id }); expect(t.code).toBe(200);
    expect(t.body.find((x: any) => x.alloc_class === "equity")).toMatchObject({ target_pct: 60, min_pct: 50, max_pct: 70, inherited: false }); expect(t.body.reduce((s: number, x: any) => s + x.target_pct, 0)).toBe(100);
    expect((await send("PUT", "/asset-class-targets", { targets: [{ alloc_class: "equity", target_pct: 70 }, { alloc_class: "debt", target_pct: 40 }] })).code).toBe(422);
    const s = (await get("/allocation/status")).body; expect(s.model).toBe("Moderate"); expect(s.look_through).toBe(true); expect(s.satellite_pct).toBeGreaterThan(0);
    const eq = s.rows.find((r: any) => r.alloc_class === "equity"); expect(eq).toMatchObject({ target_pct: 60, min_pct: 50, max_pct: 70, band_breached: true, status: "breach" }); expect(eq.look_through_pct).toBeLessThan(50); expect(eq.look_through_pct).not.toBe(eq.actual_pct);   // funds split through to their underlying
    expect(s.rows.find((r: any) => r.alloc_class === "real_estate").status).toBe("untargeted"); expect(Math.abs(s.rows.reduce((a: number, r: any) => a + r.look_through_pct, 0) - 100)).toBeLessThan(0.2);
    const headline = (await get("/allocation/status?look_through=false")).body; expect(headline.look_through).toBe(false);
    const band = await run((c) => gen("allocation_band").run(c, FAMILY, TODAY)); expect(band.drafts.some((d: any) => d.title.startsWith("equity outside its band"))).toBe(true); expect(band.drafts[0].module).toBe("goals");
    const mine = await send("POST", "/model-portfolios", { code: "test_barbell", name: "Test barbell", mix: { equity: 50, cash: 50 } }); expect(mine.code).toBe(201); expect(mine.body.bands.equity).toEqual([40, 60]);
    expect((await send("POST", "/model-portfolios", { code: "test_bad", name: "Bad", mix: { equity: 50, cash: 40 } })).code).toBe(422);
  });
  it("the allocation policy carries the review cadence: a review due within 30 days raises a task, recording it moves the date on", async () => {
    const p = (await get("/allocation/policy")).body; expect(p).toMatchObject({ strategy: "strategic", model_code: "moderate", review_every_months: 6, next_review_on: "2026-10-01", include_self_occupied: false });
    const rv = await run((c) => gen("allocation_review").run(c, FAMILY, TODAY)); expect(rv.drafts.length).toBe(1); expect(rv.drafts[0]).toMatchObject({ due_date: "2026-10-01", source_type: "allocation_review", severity: 3 });
    const done = await send("POST", "/allocation/policy/review", { note: "targets confirmed" }); expect(done.body.next_review_on).toBe("2027-04-01");
    expect((await run((c) => gen("allocation_review").run(c, FAMILY, TODAY))).drafts.length).toBe(0);
    const u = await send("PUT", "/allocation/policy", { strategy: "core_satellite", review_every_months: 12, include_self_occupied: true, rebalance_trigger_pp: 3 }); expect(u.body).toMatchObject({ strategy: "core_satellite", review_every_months: 12, include_self_occupied: true, rebalance_trigger_pp: 3 });
    expect((await send("PUT", "/allocation/policy", { strategy: "strategic" }, viewer)).code).toBe(403);
  });
});

describe("working capital", () => {
  it("settings carry the float and the instrument preferences; the plan ladders the excess by horizon with post-tax yields; tasks and the deployed ladder follow", async () => {
    const s = (await get("/working-capital/settings")).body; expect(s.instrument_prefs.yields.liquid_fund).toBe(6.8); expect(s.instrument_prefs.instruments.arbitrage_fund).toMatch(/Kotak/);
    expect((await send("PUT", "/working-capital/settings", { float_days: 45, instrument_prefs: { yields: { bank_fd: 7.3 } } })).body).toMatchObject({ float_days: 45 }); expect((await get("/working-capital/settings")).body.instrument_prefs.yields.bank_fd).toBe(7.3);
    const ex = (await get("/working-capital/excess")).body; expect(ex.required_float).toBeGreaterThan(0);
    const plan = await send("POST", "/working-capital/plan", { amount: 20000 }); expect(plan.code).toBe(201); expect(plan.body.status).toBe("proposed"); expect(plan.body.excess_amount).toBe("20000.00");
    expect(Math.abs(plan.body.lines.reduce((a: number, l: any) => a + Number(l.amount), 0) - 20000)).toBeLessThan(0.02); expect(plan.body.lines.length).toBeGreaterThanOrEqual(2);
    for (const l of plan.body.lines) { expect(l.post_tax_yield_pct).toBeLessThan(l.gross_yield_pct); expect(["slab", "equity_stcg"]).toContain(l.tax_treatment); expect(l.horizon).toBeTruthy(); }
    expect(plan.body.blended_post_tax_yield_pct).toBeGreaterThan(4); expect(plan.body.lines.find((l: any) => l.kind === "arbitrage_fund").tax_treatment).toBe("equity_stcg");
    const tasks = await send("POST", `/working-capital/plan/${plan.body.id}/tasks`); expect(tasks.code).toBe(201); expect(tasks.body.length).toBe(plan.body.lines.length); expect(tasks.body[0].title).toMatch(/^Deploy ₹/); expect(tasks.body[0].module).toBe("banking");
    expect((await send("POST", `/working-capital/plan/${plan.body.id}/tasks`)).code).toBe(409); expect((await get("/working-capital/plans")).body[0]).toMatchObject({ id: plan.body.id, status: "tasked" });
    const lad = (await get("/working-capital/ladder")).body; expect(lad.rows.some((r: any) => /Liquid/.test(r.instrument) && r.kind === "liquid_fund")).toBe(true); expect(lad.rows.find((r: any) => /SBI 7.72%/.test(r.instrument))).toMatchObject({ kind: "target_maturity_debt", gross_yield_pct: 7.72 }); expect(Number(lad.total)).toBeGreaterThan(0); expect(lad.by_horizon.length).toBeGreaterThan(0);
    expect((await send("POST", "/working-capital/plan", { amount: 0 })).code).toBe(422);
  });
});
