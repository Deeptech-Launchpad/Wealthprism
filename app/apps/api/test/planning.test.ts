import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildApp } from "../src/server.js";
import { pool, withFamily } from "../src/lib/db.js";
import { runOptimiser, matchActuals } from "../src/jobs/planning.js";

const FAMILY = "11111111-1111-1111-1111-111111111111";
const ARJUN = "33333333-0000-0000-0000-000000000001", HUF = "33333333-0000-0000-0000-000000000002", SPOUSE = "33333333-0000-0000-0000-000000000003";
const BASELINE = "99999999-0000-0000-0000-000000000000", SC_PROPERTY = "99999999-0000-0000-0000-000000000001", SC_HARVEST = "99999999-0000-0000-0000-000000000002", SC_HUF = "99999999-0000-0000-0000-000000000003";
const TCS_HOLDING = "46464646-0000-0000-0000-000000000007", TCS = "44444444-0000-0000-0000-000000000002", ANNA_NAGAR = "55555555-0000-0000-0000-000000000003";
let app: ReturnType<typeof buildApp>; let owner = "", operator = "", viewer = "";
const h = (t = owner) => ({ authorization: `Bearer ${t}`, "x-family-id": FAMILY });
const get = async (url: string, t = owner) => { const r = await app.inject({ url: `/api/v1${url}`, headers: h(t) }); return { code: r.statusCode, body: r.json() }; };
const send = async (method: "POST" | "PATCH" | "PUT" | "DELETE", url: string, payload: any = {}, t = owner) => { const r = await app.inject({ method, url: `/api/v1${url}`, headers: h(t), payload }); return { code: r.statusCode, body: r.statusCode === 204 ? null : r.json() }; };

const TABLES = ["plan_results", "plan_comments", "plan_actions", "plan_scenarios", "tax_suggestions", "tasks", "notifications", "investment_txns", "lots", "holdings"];
const before: Record<string, string[]> = {};
let scenarioBefore: any[] = [], actionBefore: any[] = [], suggestionRows: any[] = [], lotsBefore: any[] = [], holdingsBefore: any[] = [];

beforeAll(async () => {
  app = buildApp(); await app.ready();
  const login = async (email: string) => (await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password: "Prototype!2026" } })).json().access_token;
  owner = await login("arjun@example.com"); operator = await login("ops@example.com"); viewer = await login("ca@example.com");
  await withFamily(FAMILY, async (c) => {
    for (const t of TABLES) before[t] = (await c.query(`select id::text k from ${t}`)).rows.map((r) => r.k);
    scenarioBefore = (await c.query("select id, status, version, approved_by, approved_at, last_error from plan_scenarios")).rows;
    actionBefore = (await c.query("select id, status, task_id, actual_date, actual_amount, actual_ref_type, actual_ref_id, variance, simulated_effect, params from plan_actions")).rows;
    suggestionRows = (await c.query("select * from tax_suggestions")).rows;
    lotsBefore = (await c.query("select id, remaining_qty from lots")).rows; holdingsBefore = (await c.query("select id, quantity, avg_cost from holdings")).rows;
  });
});
afterAll(async () => {
  await withFamily(FAMILY, async (c) => {
    for (const s of scenarioBefore) await c.query("update plan_scenarios set status=$2, version=$3, approved_by=$4, approved_at=$5, last_error=$6, deleted_at=null where id=$1", [s.id, s.status, s.version, s.approved_by, s.approved_at, s.last_error]);
    for (const a of actionBefore) await c.query("update plan_actions set status=$2, task_id=$3, actual_date=$4, actual_amount=$5, actual_ref_type=$6, actual_ref_id=$7, variance=$8, simulated_effect=$9, params=$10 where id=$1", [a.id, a.status, a.task_id, a.actual_date, a.actual_amount, a.actual_ref_type, a.actual_ref_id, a.variance, a.simulated_effect, a.params]);
    for (const t of ["plan_results", "plan_comments", "plan_actions", "tax_suggestions", "tasks", "investment_txns", "lots", "holdings"]) await c.query(`delete from ${t} where id::text <> all($1::text[])`, [before[t]]);
    await c.query("delete from plan_scenarios where id::text <> all($1::text[])", [before.plan_scenarios]);
    await c.query("delete from tax_suggestions");
    for (const r of suggestionRows) await c.query("insert into tax_suggestions (id, family_id, scenario_id, entity_id, code, title, rationale, est_saving, fy, proposed_actions, status, created_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)", [r.id, r.family_id, r.scenario_id, r.entity_id, r.code, r.title, r.rationale, r.est_saving, r.fy, JSON.stringify(r.proposed_actions), r.status, r.created_at]);
    for (const l of lotsBefore) await c.query("update lots set remaining_qty=$2 where id=$1", [l.id, l.remaining_qty]);
    for (const x of holdingsBefore) await c.query("update holdings set quantity=$2, avg_cost=$3 where id=$1", [x.id, x.quantity, x.avg_cost]);
    await c.query("delete from notifications where id::text <> all($1::text[])", [before.notifications]);
  });
  await app.close(); await pool.end();
});

describe("scenarios", () => {
  it("lists the seeded scenarios with results and execution, and simulates the baseline from live data", async () => {
    const list = (await get("/plans")).body;
    expect(list[0].is_baseline).toBe(true); expect(list.length).toBe(4); expect(list.find((s: any) => s.id === SC_HARVEST).execution.done).toBe(1);
    const r = await send("POST", `/plans/${BASELINE}/simulate`);
    expect(r.code).toBe(200); expect(r.body.engine_version).toBe("sim-2.0"); expect(r.body.fys).toEqual(["2026-27", "2027-28", "2028-29"]);
    expect(r.body.by_fy.length).toBe(9); // 3 entities × 3 FYs
    const arjun = r.body.by_fy.find((x: any) => x.entity_id === ARJUN && x.fy === "2026-27");
    expect(arjun.heads.business).toBe(8000); expect(arjun.heads.capital_gains.ltcg_equity).toBe(1100); expect(arjun.advance_tax[0].paid).toBe(520); expect(arjun.tax.total).toBe(0); // scaled demo incomes sit under the basic exemption
    const huf = r.body.by_fy.find((x: any) => x.entity_id === HUF && x.fy === "2026-27");
    expect(huf.heads.house_property).toBeGreaterThan(0); // Race Course Road rent less 30%
    expect(r.body.allocation_after.length).toBe(3); expect(r.body.cash_ladder.length).toBeGreaterThan(24); expect(r.body.goals_after.length).toBe(5);
    expect(r.body.summary.tax_vs_baseline).toBeNull();
    expect((await get(`/plans/${BASELINE}/results`)).body[0].engine_version).toBe("sim-2.0");
  });
  it("creates, edits, clones and archives scenarios; the baseline and frozen scenarios are protected", async () => {
    const created = await send("POST", "/plans", { name: "Test: sell some TCS", description: "unit", horizon_fys: 2, assumptions: { returns: { growth: 10 } } });
    expect(created.code).toBe(201); expect(created.body.version).toBe(1); expect(created.body.assumptions.returns).toEqual({ liquidity: 6.5, income: 8, growth: 10 });
    const id = created.body.id;
    expect((await send("PATCH", `/plans/${id}`, { name: "Test: sell some TCS (2)" })).body.version).toBe(2);
    expect((await send("PATCH", `/plans/${BASELINE}`, { name: "x" })).code).toBe(409);
    expect((await send("DELETE", `/plans/${BASELINE}`)).code).toBe(409);
    expect((await send("PATCH", `/plans/${SC_HARVEST}`, { name: "x" })).code).toBe(409); // approved → frozen
    const clone = await send("POST", `/plans/${SC_HARVEST}/clone`, {});
    expect(clone.code).toBe(201); expect(clone.body.parent_scenario_id).toBe(SC_HARVEST); expect(clone.body.version).toBe(2); expect(Number(clone.body.action_count)).toBe(4); expect(clone.body.status).toBe("draft");
    const cloneActions = (await get(`/plans/${clone.body.id}/actions`)).body;
    expect(cloneActions.length).toBe(4); expect(cloneActions.every((a: any) => a.status === "planned" && !a.task_id)).toBe(true);
    expect((await send("DELETE", `/plans/${clone.body.id}`)).code).toBe(204);
    expect((await get(`/plans/${clone.body.id}`)).code).toBe(404);
    expect((await send("POST", "/plans", { name: "nope" }, viewer)).code).toBe(403);
  });
});

describe("actions and simulation", () => {
  let id = "";
  it("adds actions with per-kind validation and simulates them with per-action effects", async () => {
    id = (await send("POST", "/plans", { name: "Test: TCS + PPF", horizon_fys: 2 })).body.id;
    const bad = await send("POST", `/plans/${id}/actions`, { kind: "sell_holding", planned_date: "2026-12-01", params: {} });
    expect(bad.code).toBe(422); expect(bad.body.errors[0].field).toBe("target_id");
    expect((await send("POST", `/plans/${id}/actions`, { kind: "change_tax_regime", planned_date: "2027-03-31", params: { regime: "sideways" } })).code).toBe(422);
    const a1 = await send("POST", `/plans/${id}/actions`, { kind: "sell_holding", entity_id: SPOUSE, target_type: "holding", target_id: TCS_HOLDING, params: { quantity: 4, price: 3800 }, planned_date: "2026-12-01", planned_amount: 15200 });
    expect(a1.code).toBe(201); expect(a1.body.seq).toBe(1);
    const a2 = await send("POST", `/plans/${id}/actions`, { kind: "contribute_ppf", entity_id: ARJUN, params: { amount: 1500 }, planned_date: "2027-03-25" });
    expect(a2.body.seq).toBe(2);
    const sim = await send("POST", `/plans/${id}/simulate`);
    expect(sim.code).toBe(200);
    const effects = sim.body.actions.map((a: any) => a.simulated_effect);
    expect(effects[0].gain).toBeCloseTo(4 * (3800 - 3044.44 - 8 / 9), 0); expect(effects[0].term).toBe("long"); expect(effects[0].cash).toBe(15200); // the seeded lot carries ₹8 of charges over 9 units
    expect(effects[1].warnings.join()).toMatch(/new regime.*80C gives no deduction/);
    expect(typeof sim.body.summary.tax_vs_baseline).toBe("number");
    const detail = (await get(`/plans/${id}`)).body;
    expect(detail.actions[0].simulated_effect.gain).toBeCloseTo(effects[0].gain, 0); expect(detail.latest_result.summary.tax_total).toBe(sim.body.summary.tax_total);
    // replace the list, edit one, delete one
    const put = await send("PUT", `/plans/${id}/actions`, [{ kind: "sell_holding", entity_id: SPOUSE, target_type: "holding", target_id: TCS_HOLDING, params: { quantity: 2, price: 3800 }, planned_date: "2026-12-01" }, { kind: "custom", entity_id: ARJUN, params: { amount: 5000, tax_head: "other", note: "royalty" }, planned_date: "2027-01-10" }]);
    expect(put.code).toBe(200); expect(put.body.length).toBe(2);
    const edited = await send("PATCH", `/plans/${id}/actions/${put.body[0].id}`, { params: { quantity: 3, price: 3800 } });
    expect(edited.body.params.quantity).toBe(3);
    expect((await send("DELETE", `/plans/${id}/actions/${put.body[1].id}`)).code).toBe(204);
    expect((await get(`/plans/${id}/actions`)).body.length).toBe(1);
  });
  it("compares scenarios against the baseline", async () => {
    const cmp = (await get(`/plans/compare?ids=${SC_PROPERTY},${SC_HARVEST}`)).body;
    expect(cmp.scenarios[0].is_baseline).toBe(true); expect(cmp.scenarios.length).toBe(3);
    expect(cmp.metrics.map((m: any) => m.metric)).toContain("Saving vs baseline");
    expect(Object.keys(cmp.metrics[0].values).length).toBe(3); expect(cmp.by_fy.length).toBeGreaterThanOrEqual(2); expect(cmp.allocation.length).toBe(3);
    expect((await get("/plans/compare?ids=a,b,c,d,e")).code).toBe(422);
  });
  it("runs the review workflow: comments, owner-only approval, tasks per action, target conflicts, completion", async () => {
    const com = await send("POST", `/plans/${id}/comments`, { body: "Looks fine to me" }, operator);
    expect(com.code).toBe(201); expect(com.body.user_name).toMatch(/Rohan/);
    expect((await send("POST", `/plans/${id}/status`, { status: "approved" })).code).toBe(409); // draft → approved is not allowed
    expect((await send("POST", `/plans/${id}/status`, { status: "in_review" }, operator)).body.status).toBe("in_review");
    expect((await send("POST", `/plans/${id}/status`, { status: "approved" }, operator)).code).toBe(403);
    // SC_HARVEST (approved, seeded) already acts on the TCS holding → conflict
    const clash = await send("POST", `/plans/${id}/status`, { status: "approved" });
    expect(clash.code).toBe(409); expect(clash.body.title).toMatch(/Harvest losses/);
    await withFamily(FAMILY, async (c) => c.query("update plan_scenarios set status='completed' where id=$1", [SC_HARVEST]));
    const ok = await send("POST", `/plans/${id}/status`, { status: "approved", note: "go" });
    expect(ok.code).toBe(200); expect(ok.body.status).toBe("executing"); expect(ok.body.approved_by).toBeTruthy(); expect(ok.body.tasks_created).toBe(1);
    const tasks = (await get("/tasks?status=open&module=planning")).body.filter((t: any) => t.source_type === "plan_action");
    expect(tasks.length).toBe(1); expect(tasks[0].title).toMatch(/Sell 3 units/); expect(tasks[0].verification).toBe("pending");
    expect((await send("PATCH", `/plans/${id}/actions/${(await get(`/plans/${id}/actions`)).body[0].id}`, { params: { quantity: 9 } })).code).toBe(409); // frozen
    expect((await get(`/plans/${id}`)).body.comments.some((c: any) => /\[approved\] go/.test(c.body))).toBe(true);
    // recording execution by hand closes the task and completes the plan
    const actionId = (await get(`/plans/${id}/actions`)).body[0].id;
    const done = await send("PATCH", `/plans/${id}/actions/${actionId}`, { status: "done", actual_date: "2026-12-03", actual_amount: 11500 });
    expect(done.body.status).toBe("done"); expect(done.body.variance.days).toBe(2);
    expect((await get(`/plans/${id}`)).body.status).toBe("completed");
    const ex = (await get(`/plans/${id}/execution`)).body; expect(ex.done).toBe(1); expect(ex.pct).toBe(100); expect(ex.actions[0].task_status).toBe("done");
  });
});

describe("tax position, regime comparison, optimiser", () => {
  it("projects the FY per entity and the advance-tax schedule", async () => {
    const proj = (await get("/tax/projection?fy=2026-27")).body;
    expect(proj.length).toBe(3); expect(proj.map((p: any) => p.entity_name).sort()).toEqual(["Arjun Mehta", "Mehta HUF", "Spouse (Individual)"]);
    expect(proj.find((p: any) => p.entity_id === SPOUSE).heads.capital_gains.ltcg_other).toBe(1400); // seeded SBI bond gain
    const adv = (await get("/tax/advance-tax?fy=2026-27")).body;
    expect(adv.family.length).toBe(4); expect(adv.family[0].due).toBe("2026-06-15"); expect(adv.family[1].cumulative_pct).toBe(45); expect(Number(adv.family[0].paid)).toBe(1200);
    expect((await get(`/tax/projection?fy=2026-27&entity_id=${HUF}`)).body.length).toBe(1);
  });
  it("compares regimes for an entity and offers the change as an action", async () => {
    const rc = (await get(`/tax/regime-compare?fy=2026-27&entity_id=${HUF}`)).body;
    expect(rc.old.regime).toBe("old"); expect(rc.new.regime).toBe("new"); expect(["old", "new"]).toContain(rc.recommended); expect(rc.add_to_scenario.kind).toBe("change_tax_regime"); expect(rc.add_to_scenario.params.regime).toBe(rc.recommended);
    expect(rc.old.deductions["80C"]).toBe(1500); expect(rc.new.deductions["80C"]).toBeUndefined();
  });
  it("runs the optimiser rules, writes suggestions, applies one into a draft and keeps dismissed ones down", async () => {
    // give the spouse a booked gain and Arjun a loss lot so harvest_loss and use_ltcg_exemption both fire
    // the spouse has a booked long-term bond gain (₹1,400); marking the bond below cost gives a loss lot that offsets it
    await withFamily(FAMILY, async (c) => { await c.query("insert into prices (instrument_id, price_date, close, source) values ('44444444-0000-0000-0000-000000000006', current_date, 990, 'test') on conflict (instrument_id, price_date) do update set close=990, source='test'"); });
    const r = await withFamily(FAMILY, (c) => runOptimiser(c, FAMILY, { today: "2026-09-12" }));
    expect(r.drafts).toBeGreaterThanOrEqual(3);
    const list = (await get("/tax/suggestions")).body;
    const codes = list.map((s: any) => s.code);
    expect(codes).toContain("use_ltcg_exemption"); expect(codes).toContain("harvest_loss");
    expect(list.every((s: any) => s.status === "new" && s.proposed_actions.length >= 1)).toBe(true);
    const ltcg = list.find((s: any) => s.code === "use_ltcg_exemption" && s.entity_id === SPOUSE);
    expect(ltcg).toBeTruthy(); expect(ltcg.title).toMatch(/Tata Consultancy/); expect(Number(ltcg.est_saving)).toBeGreaterThan(0);
    const applied = await send("POST", `/tax/suggestions/${ltcg.id}/apply`, {});
    expect(applied.code).toBe(200); expect(applied.body.name).toMatch(/^Optimiser:/); expect(Number(applied.body.action_count)).toBe(2);
    expect((await get("/tax/suggestions?status=added_to_plan")).body.some((s: any) => s.id === ltcg.id)).toBe(true);
    const harvest = list.find((s: any) => s.code === "harvest_loss"); expect(harvest.entity_id).toBe(SPOUSE); expect(harvest.title).toMatch(/SBI 7\.72/);
    expect((await send("POST", `/tax/suggestions/${harvest.id}/dismiss`)).body.status).toBe("dismissed");
    await withFamily(FAMILY, (c) => runOptimiser(c, FAMILY, { today: "2026-09-12" }));
    expect((await get("/tax/suggestions")).body.some((s: any) => s.id === harvest.id)).toBe(false);
    expect((await get("/tax/suggestions?status=dismissed")).body.some((s: any) => s.id === harvest.id)).toBe(true);
    expect((await send("POST", "/tax/suggestions", {})).code).toBe(202);
    await withFamily(FAMILY, async (c) => { await c.query("delete from prices where source='test'"); });
  });
  it("matches an imported transaction to a planned action and flags variance beyond tolerance", async () => {
    const id = (await send("POST", "/plans", { name: "Test: execute TCS", horizon_fys: 1 })).body.id;
    await send("POST", `/plans/${id}/actions`, { kind: "sell_holding", entity_id: SPOUSE, target_type: "holding", target_id: TCS_HOLDING, params: { quantity: 2, price: 3800 }, planned_date: "2026-09-10", planned_amount: 7600 });
    await send("POST", `/plans/${id}/actions`, { kind: "sell_holding", entity_id: SPOUSE, target_type: "holding", target_id: TCS_HOLDING, params: { quantity: 3, price: 3800 }, planned_date: "2026-09-11", planned_amount: 11400 });
    await send("POST", `/plans/${id}/simulate`);
    await send("POST", `/plans/${id}/status`, { status: "in_review" }); const ok = await send("POST", `/plans/${id}/status`, { status: "approved" }); expect(ok.code).toBe(200);
    const acct = "45454545-0000-0000-0000-000000000003";
    await withFamily(FAMILY, async (c) => {
      await c.query("insert into investment_txns (family_id, entity_id, account_id, instrument_id, type, txn_date, quantity, price, amount, charges, source, hash) values ($1,$2,$3,$4,'sell','2026-09-12',2,3810,7620,0,'contract_note','test-tcs-sell-1')", [FAMILY, SPOUSE, acct, TCS]);
      await c.query("insert into investment_txns (family_id, entity_id, account_id, instrument_id, type, txn_date, quantity, price, amount, charges, source, hash) values ($1,$2,$3,$4,'sell','2026-09-12',3,4100,12300,0,'contract_note','test-tcs-sell-2')", [FAMILY, SPOUSE, acct, TCS]); // 7.9% above plan
    });
    const m = await withFamily(FAMILY, (c) => matchActuals(c, FAMILY));
    expect(m.matched).toBe(2); expect(m.flagged).toBe(1);
    const ex = (await get(`/plans/${id}/execution`)).body;
    expect(ex.done).toBe(2); expect(ex.actions[0].variance.breach).toBe(false); expect(ex.actions[0].variance.days).toBe(2); expect(ex.actions[1].variance.breach).toBe(true); expect(ex.actions[1].variance.price_pct).toBeCloseTo(7.89, 1);
    expect(ex.actions.every((a: any) => a.task_status === "done" && a.task_verification === "verified")).toBe(true);
    expect((await get(`/plans/${id}`)).body.status).toBe("completed");
    const flag = (await get("/tasks?status=open&module=planning")).body.find((t: any) => t.source_type === "plan_variance");
    expect(flag).toBeTruthy(); expect(flag.reason).toMatch(/price 7\.9% off plan/);
  });
});
