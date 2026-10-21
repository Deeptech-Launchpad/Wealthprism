import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildApp } from "../src/server.js";
import { withFamily } from "../src/lib/db.js";
import { matchMoves } from "../src/lib/rebalance.js";

const FAMILY = "11111111-1111-1111-1111-111111111111";
const ARJUN = "33333333-0000-0000-0000-000000000001", HUF = "33333333-0000-0000-0000-000000000002";
const PG_FAMILY = "9e000000-0000-0000-0000-000000000001", PG_MBA = "9e000000-0000-0000-0000-000000000003";
const HDFC_HOLDING = "46464646-0000-0000-0000-000000000001", HDFC = "44444444-0000-0000-0000-000000000001", PPFAS_HOLDING = "46464646-0000-0000-0000-000000000002";
let app: ReturnType<typeof buildApp>; let owner = "", operator = "", viewer = "";
const h = (t = owner) => ({ authorization: `Bearer ${t}`, "x-family-id": FAMILY });
const get = async (url: string, t = owner) => { const r = await app.inject({ url: `/api/v1${url}`, headers: h(t) }); return { code: r.statusCode, body: r.json() }; };
const send = async (method: "POST" | "PATCH" | "PUT" | "DELETE", url: string, payload: any = {}, t = owner) => { const r = await app.inject({ method, url: `/api/v1${url}`, headers: h(t), payload }); return { code: r.statusCode, body: r.statusCode === 204 ? null : r.json() }; };

const TABLES = ["funding_needs", "lot_constraints", "rebalance_runs", "rebalance_plans", "rebalance_moves", "action_intents", "action_approvals", "connectors", "tasks", "notifications", "investment_txns"];
const before: Record<string, string[]> = {}; let plansBefore: any[] = [], runsBefore: any[] = [];
beforeAll(async () => {
  app = buildApp(); await app.ready();
  const login = async (email: string) => (await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password: "Prototype!2026" } })).json().access_token;
  owner = await login("arjun@example.com"); operator = await login("ops@example.com"); viewer = await login("ca@example.com");
  await withFamily(FAMILY, async (c) => {
    for (const t of TABLES) before[t] = (await c.query(`select ${t === "lot_constraints" ? "lot_id" : "id"}::text k from ${t}`)).rows.map((r) => r.k);
    plansBefore = (await c.query("select id, status, approved_by, approved_at, intent_batch_id, simulation from rebalance_plans")).rows; runsBefore = (await c.query("select id, status, plan_id from rebalance_runs")).rows;
  });
});
afterAll(async () => {
  await withFamily(FAMILY, async (c) => {
    await c.query("delete from need_coverage where move_id in (select id from rebalance_moves where id::text <> all($1::text[])) or need_id in (select id from funding_needs where id::text <> all($2::text[]))", [before.rebalance_moves, before.funding_needs]);
    await c.query("update rebalance_moves set intent_id=null where intent_id in (select id from action_intents where id::text <> all($1::text[]))", [before.action_intents]);
    for (const t of ["action_approvals", "action_intents", "rebalance_moves", "tasks", "notifications", "investment_txns"]) await c.query(`delete from ${t} where id::text <> all($1::text[])`, [before[t]]);
    await c.query("update rebalance_runs set plan_id=null where plan_id in (select id from rebalance_plans where id::text <> all($1::text[]))", [before.rebalance_plans]);
    await c.query("delete from rebalance_plans where id::text <> all($1::text[])", [before.rebalance_plans]); await c.query("delete from rebalance_runs where id::text <> all($1::text[])", [before.rebalance_runs]);
    await c.query("delete from connectors where id::text <> all($1::text[])", [before.connectors]);
    await c.query("delete from funding_needs where id::text <> all($1::text[])", [before.funding_needs]); await c.query("delete from lot_constraints where lot_id::text <> all($1::text[])", [before.lot_constraints]);
    for (const p of plansBefore) await c.query("update rebalance_plans set status=$2, approved_by=$3, approved_at=$4, intent_batch_id=$5, simulation=$6 where id=$1", [p.id, p.status, p.approved_by, p.approved_at, p.intent_batch_id, p.simulation]).catch(() => null);
    for (const r of runsBefore) await c.query("update rebalance_runs set status=$2, plan_id=$3 where id=$1", [r.id, r.status, r.plan_id]);
  });
  await app.close();
});

describe("needs, lot constraints, programs (FO-160..162)", () => {
  it("gathers dated needs from outflows, commitments and goals; the Varaha call is one need, not two", async () => {
    const g = (await send("POST", "/funding-needs/gather", {})).body; expect(g.rows).toBeGreaterThanOrEqual(5);
    const needs = (await get("/funding-needs")).body;
    expect(needs.map((n: any) => `${n.need_date} ${n.kind}`)).toEqual(expect.arrayContaining(["2026-09-15 tax_instalment", "2026-09-20 tax_instalment", "2026-10-01 planned_expense", "2026-10-14 capital_call", "2027-04-14 capital_call", "2029-06-01 goal_drawdown"]));
    expect(needs.filter((n: any) => n.need_date === "2026-10-14").length).toBe(1); expect(needs.find((n: any) => n.kind === "goal_drawdown").amount).toBeCloseTo(160000 * 1.06 ** 3, 0);
    expect((await send("POST", "/funding-needs/gather", {})).body.rows).toBe(g.rows); expect((await get("/funding-needs")).body.length).toBe(needs.length); // idempotent
    const manual = await send("POST", "/funding-needs", { entity_id: ARJUN, kind: "planned_expense", label: "Wedding gift", need_date: "2026-12-05", amount: 4000, priority: 2 }); expect(manual.code).toBe(201); expect(manual.body.status).toBe("planned"); expect(manual.body.shortfall).toBe(4000);
    expect((await send("PATCH", `/funding-needs/${manual.body.id}`, { funded_amount: 4000 })).body.status).toBe("funded");
    expect((await send("DELETE", `/funding-needs/${manual.body.id}`)).code).toBe(204); expect((await get("/funding-needs")).body.some((n: any) => n.id === manual.body.id)).toBe(false);
    expect((await send("POST", "/funding-needs", { entity_id: ARJUN, label: "x", need_date: "2026-12-05", amount: 1 }, viewer)).code).toBe(403);
  });
  it("derives lot constraints per holding: exit-load window, LTCG date, settlement; a manual override survives recompute", async () => {
    const pp = (await get(`/holdings/${PPFAS_HOLDING}/lot-constraints`)).body; const lot = pp.lots.find((l: any) => l.buy_date === "2025-06-10");
    expect(lot).toMatchObject({ exit_load_until: "2026-06-10", exit_load_pct: 1, ltcg_eligible_on: "2026-06-10", settlement_days: 3, liquidity_class: "t3", lock_in_until: null });
    const hd = (await get(`/holdings/${HDFC_HOLDING}/lot-constraints`)).body; expect(hd.lots.find((l: any) => l.buy_date === "2026-08-28")).toMatchObject({ ltcg_eligible_on: "2027-08-28", settlement_days: 1, exit_load_until: null });
    const ov = await send("PUT", `/lots/${lot.lot_id}/constraints`, { exit_load_until: "2026-12-31", exit_load_pct: 1.5 }); expect(ov.body.manual).toBe(true);
    await send("POST", "/funding-needs/gather", {}); expect((await get(`/holdings/${PPFAS_HOLDING}/lot-constraints`)).body.lots.find((l: any) => l.buy_date === "2025-06-10").exit_load_until).toBe("2026-12-31");
    await withFamily(FAMILY, (c) => c.query("update lot_constraints set manual=false, exit_load_until='2026-06-10', exit_load_pct=1 where lot_id=$1", [lot.lot_id]));
  });
  it("lists the seeded programs with the next calendar run and creates one from a policy's rebalancing clause", async () => {
    const list = (await get("/rebalance/programs")).body; expect(list.length).toBe(3);
    const fam = list.find((p: any) => p.id === PG_FAMILY); expect(fam.next_calendar_run).toBe("2026-10-01"); expect(fam.policy_name).toBe("Mehta Family Investment Policy"); expect(fam.last_run.triggered_by).toBe("calendar");
    const created = await send("POST", "/rebalance/programs", { scope: "entity", entity_id: HUF }); expect(created.code).toBe(201); expect(created.body).toMatchObject({ name: "Mehta HUF", calendar_rrule: "FREQ=MONTHLY;INTERVAL=3;BYMONTHDAY=1", band_trigger: true }); expect(created.body.constraints.prefer_new_cash).toBe(true);
    expect((await send("POST", "/rebalance/programs", { scope: "entity", entity_id: HUF })).code).toBe(409);
    expect((await send("PATCH", `/rebalance/programs/${created.body.id}`, { active: false, constraints: { max_turnover_pct: 10 } })).body).toMatchObject({ active: false }); 
    await withFamily(FAMILY, (c) => c.query("delete from rebalance_programs where id=$1", [created.body.id]));
  });
});

describe("runs, plans, conversion, reconciliation (FO-163..165)", () => {
  let planId = "", runId = "";
  it("nightly evaluation drafts the family plan on the funding-need trigger: cash first, SIP redirect, then tax-aware sales timed for the call", async () => {
    const ev = (await send("POST", "/rebalance/evaluate", { today: "2026-09-12" })).body;   // the demo data is anchored on 12 Sep 2026: pin the evaluation day so the plan is the same every day
    const fam = ev.programs.find((p: any) => p.program === "Family policy program"); expect(fam.fired[0]).toBe("funding_need"); expect(fam.status).toBe("plan_drafted"); runId = fam.run_id;
    expect(ev.programs.find((p: any) => p.program === "Daughter's MBA (2029)").fired).toEqual([]);
    const run = (await get("/rebalance/runs")).body.find((r: any) => r.id === runId); expect(run.trigger_detail.needs.some((n: any) => /Varaha/.test(n.label))).toBe(true); expect(Number(run.snapshot.total)).toBeGreaterThan(500000);
    planId = run.plan_id; const plan = (await get(`/rebalance/plans/${planId}`)).body;
    expect(plan.status).toBe("draft"); expect(plan.summary.needs_uncovered).toBe(0); expect(plan.summary.est_tax).toBe(0); expect(plan.warnings).toEqual([]);
    const kinds = plan.moves.map((m: any) => m.kind); expect(kinds.filter((k: string) => k === "hold_cash").length).toBe(3); expect(kinds).toContain("sip_change"); expect(kinds.filter((k: string) => k === "sell").length).toBe(2);
    const varaha = plan.moves.filter((m: any) => /Varaha/.test(m.need_label ?? "")); const raised = varaha.reduce((s: number, m: any) => s + m.amount, 0); expect(raised).toBeGreaterThanOrEqual(20000); expect(raised).toBeLessThan(20000 + 1800); // fully covered, over by at most one whole share
    const sale = plan.moves.find((m: any) => m.kind === "sell" && /Varaha/.test(m.need_label)); expect(sale.settles_on <= "2026-10-12").toBe(true); expect(sale.latest_date).toBe(sale.planned_date); expect(sale.constraints_checked.join(" | ")).toMatch(/within exemption → tax ₹0/); expect(sale.from_holding_name).toBe("HDFC Bank");
    expect((await get("/funding-needs")).body.find((n: any) => /Varaha Fund II drawdown 4\/6/.test(n.label))).toMatchObject({ shortfall: 0 }); // coverage recorded
    expect((await send("POST", "/rebalance/evaluate", { today: "2026-09-12" })).body.programs.find((p: any) => p.program === "Family policy program").skipped).toBe("open plan");
  });
  it("editing a draft re-solves into v2; simulate reports compliance after; the plan then goes through review and step-up approval", async () => {
    const plan = (await get(`/rebalance/plans/${planId}`)).body; const sip = plan.moves.find((m: any) => m.kind === "sip_change");
    const v2 = (await send("PATCH", `/rebalance/plans/${planId}`, { exclude_move_ids: [sip.id] })).body;
    expect(v2.version).toBe(2); expect(v2.status).toBe("draft"); expect(v2.moves.some((m: any) => m.kind === "sip_change")).toBe(false); expect(v2.simulation.compliance_after).toBeTruthy(); expect(v2.summary.needs_uncovered).toBe(0);
    expect((await get(`/rebalance/plans/${planId}`)).body.status).toBe("superseded"); planId = v2.id;
    const sim = (await send("POST", `/rebalance/plans/${planId}/simulate`)).body; expect(sim.new_breach).toBe(false); expect(sim.compliance_after.overall).toBeTruthy(); expect(sim.allocation_after.length).toBeGreaterThan(0);
    expect((await send("POST", `/rebalance/plans/${planId}/status`, { status: "approved", auth_method: "totp", auth_proof: "000000" })).code).toBe(409); // draft → approved is not a legal transition
    expect((await send("POST", `/rebalance/plans/${planId}/status`, { status: "in_review" })).body.status).toBe("in_review");
    expect((await send("POST", `/rebalance/plans/${planId}/status`, { status: "approved", auth_method: "totp", auth_proof: "000000" }, operator)).code).toBe(403);
    expect((await send("POST", `/rebalance/plans/${planId}/status`, { status: "approved", auth_method: "totp", auth_proof: "111111" })).code).toBe(403);
    const ap = (await send("POST", `/rebalance/plans/${planId}/status`, { status: "approved", auth_method: "totp", auth_proof: "000000" })).body; expect(ap.status).toBe("approved"); expect(ap.approved_by_name).toBe("Arjun Mehta");
    expect((await get("/rebalance/runs")).body.find((r: any) => r.id === runId).status).toBe("plan_approved");
  });
  it("converting creates dated intents held until each planned date; an import then reconciles the move and funds the need", async () => {
    const cv = (await send("POST", `/rebalance/plans/${planId}/status`, { status: "converted" })).body;
    expect(cv.status).toBe("converted"); expect(cv.intents.length).toBe(2); // the two sales; cash holds need no intent
    const sale = cv.moves.find((m: any) => m.kind === "sell" && /Varaha/.test(m.need_label)); const intent = cv.intents.find((i: any) => i.source_id === sale.id);
    expect(intent).toMatchObject({ kind: "equity_order", status: "approved", proposed_by_kind: "rule" }); expect(intent.cooling_off_until.slice(0, 10)).toBe(sale.planned_date); expect(intent.payload).toMatchObject({ side: "sell", instrument_id: HDFC, quantity: sale.quantity });
    expect(cv.moves.filter((m: any) => m.kind === "hold_cash").every((m: any) => m.status === "executed")).toBe(true); expect(sale.status).toBe("intent_created");
    const inbox = (await get("/actions")).body.items; expect(inbox.some((i: any) => i.id === intent.id && i.status === "approved")).toBe(true);
    await withFamily(FAMILY, async (c) => {
      await c.query("insert into investment_txns (family_id, entity_id, account_id, instrument_id, type, txn_date, quantity, price, amount, charges, source, hash) values ($1,$2,(select id from accounts where entity_id=$2 limit 1),$3,'sell',$4,$5,$6,$7,0,'contract_note','test-rb-hdfc')", [FAMILY, ARJUN, HDFC, sale.planned_date, sale.quantity, sale.amount / sale.quantity, sale.amount]);
      expect((await matchMoves(c, FAMILY)).matched).toBe(1);
    });
    const after = (await get(`/rebalance/plans/${planId}`)).body; expect(after.moves.find((m: any) => m.id === sale.id)).toMatchObject({ status: "executed", executed_ref_type: "investment_txn" }); expect(after.executed).toBe(4);
    const need = (await get("/funding-needs")).body.find((n: any) => /Varaha Fund II drawdown 4\/6/.test(n.label)); expect(need.funded_amount).toBeCloseTo(sale.amount, 0); expect(need.status).toBe("partially_funded");
    expect((await get("/rebalance/runs")).body.find((r: any) => r.id === runId)).toMatchObject({ status: "executing", executed: 4 });
  });
  it("a manual run on a goal with nothing to do records no action; the calendar merges moves, settlements, needs, runs and lot gates", async () => {
    const r = (await send("POST", `/rebalance/programs/${PG_MBA}/run`, { objective: "to_band_edge" })).body; expect(r.status).toBe("no_action"); expect(r.plan).toBeNull(); expect(r.note).toMatch(/no action/);
    const hist = (await get("/rebalance/runs?program_id=" + PG_MBA)).body; expect(hist[0].status).toBe("no_action"); expect(hist.some((x: any) => x.triggered_by === "milestone" && x.status === "completed")).toBe(true);
    const cal = (await get("/rebalance/calendar?from=2026-09-01&to=2028-12-31")).body; const kinds = new Set(cal.map((x: any) => x.kind));
    expect([...kinds]).toEqual(expect.arrayContaining(["need", "move", "settlement", "calendar_run", "ltcg_eligible", "milestone"]));
    expect(cal.find((x: any) => x.kind === "calendar_run")).toMatchObject({ date: "2026-10-01" }); expect(cal.some((x: any) => x.kind === "ltcg_eligible" && /HDFC Bank lot 2026-08-28/.test(x.label) && x.date === "2027-08-28")).toBe(true);
    expect(cal.some((x: any) => x.kind === "need" && /Varaha/.test(x.label) && x.date === "2026-10-14")).toBe(true); expect(cal.every((x: any, i: number) => i === 0 || x.date >= cal[i - 1].date)).toBe(true);
  });
});
