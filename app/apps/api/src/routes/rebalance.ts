import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireFamily, requireRole, verifyStepUp } from "../lib/auth.js";
import { withFamily } from "../lib/db.js";
import { RebalanceError, gatherNeeds, needsView, computeLotConstraints, runProgram, evaluatePrograms, planView, revisePlan, simulatePlan, convertPlan, calendar, iso, refreshNeedStatus } from "../lib/rebalance.js";
import { nextCalendarRun, addDays } from "@fo/finance";

const WRITERS = requireRole("owner", "member", "operator");
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const OBJECTIVES = ["back_to_target", "to_band_edge", "fund_needs_only", "needs_plus_bands", "glide_step"] as const;
const problem = (reply: any, e: any) => { if (e instanceof RebalanceError) return void reply.code(e.status).send({ title: e.message, status: e.status, extra: e.extra }); throw e; };
const programInput = z.object({ scope: z.enum(["family", "entity", "goal"]).optional(), entity_id: z.string().uuid().nullable().optional(), goal_id: z.string().uuid().nullable().optional(), policy_id: z.string().uuid().nullable().optional(), name: z.string().min(1).max(120).optional(), calendar_rrule: z.string().max(120).nullable().optional(), band_trigger: z.boolean().optional(), drift_threshold_pp: z.number().nullable().optional(),
  milestone_triggers: z.array(z.object({ kind: z.enum(["goal_years_to_go", "goal_funded_pct", "life_event", "glide_step", "net_worth_crosses", "age"]), value: z.any().optional() })).optional(), need_lookahead_days: z.number().int().min(7).max(1100).optional(), large_flow_pct: z.number().nullable().optional(), tax_year_end: z.boolean().optional(), constraints: z.record(z.any()).optional(), auto_draft: z.boolean().optional(), auto_convert_low_risk: z.boolean().optional(), active: z.boolean().optional() });
const PROGRAM_SQL = `select p.*, e.name entity_name, g.name goal_name, ip.name policy_name, (select row_to_json(x) from (select r.id, r.run_at, r.triggered_by, r.status, r.plan_id from rebalance_runs r where r.program_id=p.id order by r.run_at desc limit 1) x) last_run from rebalance_programs p left join entities e on e.id=p.entity_id left join goals g on g.id=p.goal_id left join investment_policies ip on ip.id=p.policy_id`;
const programView = (p: any, today: string) => ({ ...p, drift_threshold_pp: p.drift_threshold_pp == null ? null : Number(p.drift_threshold_pp), large_flow_pct: p.large_flow_pct == null ? null : Number(p.large_flow_pct), next_calendar_run: nextCalendarRun(p.calendar_rrule, today) });

export default async function routes(app: FastifyInstance) {
  app.addHook("preHandler", requireFamily);
  const fam = (req: any) => req.family!.familyId as string; const today = () => new Date().toISOString().slice(0, 10);

  // ---------- programs ----------
  app.get("/rebalance/programs", async (req) => withFamily(fam(req), async (c) => (await c.query(`${PROGRAM_SQL} where p.family_id=$1 order by case p.scope when 'family' then 0 when 'entity' then 1 else 2 end, p.name`, [fam(req)])).rows.map((p) => programView(p, today()))));
  app.post("/rebalance/programs", { preHandler: WRITERS }, async (req, reply) => {
    const b = programInput.parse(req.body); if (!b.scope) return void reply.code(422).send({ title: "scope required", status: 422 });
    return withFamily(fam(req), async (c) => {
      const policy = b.policy_id ? (await c.query("select * from investment_policies where id=$1", [b.policy_id])).rows[0] : (await c.query("select * from investment_policies where deleted_at is null and scope=$1::policy_scope and entity_id is not distinct from $2 and goal_id is not distinct from $3", [b.scope, b.scope === "entity" ? b.entity_id : null, b.scope === "goal" ? b.goal_id : null])).rows[0];
      const rb = policy?.current_version_id ? (await c.query("select rebalancing from policy_versions where id=$1", [policy.current_version_id])).rows[0]?.rebalancing ?? {} : {};
      const rrule = b.calendar_rrule !== undefined ? b.calendar_rrule : rb.method === "bands" ? null : rb.calendar === "monthly" ? "FREQ=MONTHLY;BYMONTHDAY=1" : rb.calendar === "annual" ? "FREQ=YEARLY;BYMONTH=4;BYMONTHDAY=1" : rb.calendar === "half-yearly" ? "FREQ=MONTHLY;INTERVAL=6;BYMONTHDAY=1" : "FREQ=MONTHLY;INTERVAL=3;BYMONTHDAY=1";
      const constraints = { min_trade: 2000, max_turnover_pct: 15, avoid_exit_load: true, respect_lock_in: true, prefer_new_cash: rb.use_new_cash_first ?? true, tax_aware: rb.tax_aware ?? true, ltcg_wait_days: 45, settlement_buffer_days: 2, ...(b.constraints ?? {}) };
      const goal = b.scope === "goal" && b.goal_id ? (await c.query("select name, target_year from goals where id=$1", [b.goal_id])).rows[0] : null;
      const milestones = b.milestone_triggers ?? (goal ? [{ kind: "goal_years_to_go", value: 5 }, { kind: "goal_years_to_go", value: 3 }, { kind: "goal_years_to_go", value: 1 }, { kind: "glide_step" }] : []);
      try {
        const r = (await c.query("insert into rebalance_programs (family_id, scope, entity_id, goal_id, policy_id, name, calendar_rrule, band_trigger, drift_threshold_pp, milestone_triggers, need_lookahead_days, large_flow_pct, tax_year_end, constraints, auto_draft, auto_convert_low_risk) values ($1,$2::policy_scope,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) returning id",
          [fam(req), b.scope, b.scope === "entity" ? b.entity_id : null, b.scope === "goal" ? b.goal_id : null, policy?.id ?? null, b.name ?? (goal ? `${goal.name} (${goal.target_year})` : policy?.name ?? `${b.scope} program`), rrule, b.band_trigger ?? (rb.method !== "calendar"), b.drift_threshold_pp ?? (rb.tolerance_pp ? Number(rb.tolerance_pp) * 2 : null), JSON.stringify(milestones), b.need_lookahead_days ?? (goal ? 180 : 120), b.large_flow_pct ?? 5, b.tax_year_end ?? b.scope === "family", JSON.stringify(constraints), b.auto_draft ?? true, b.auto_convert_low_risk ?? false])).rows[0];
        return void reply.code(201).send(programView((await c.query(`${PROGRAM_SQL} where p.id=$1`, [r.id])).rows[0], today()));
      } catch (e: any) { if (e.code === "23505") return void reply.code(409).send({ title: "A program already exists for this scope", status: 409 }); throw e; }
    });
  });
  app.patch("/rebalance/programs/:id", { preHandler: WRITERS }, async (req, reply) => {
    const b = programInput.parse(req.body ?? {});
    return withFamily(fam(req), async (c) => {
      const p = (await c.query("select * from rebalance_programs where id=$1", [(req.params as any).id])).rows[0]; if (!p) return void reply.code(404).send({ title: "Not found", status: 404 });
      await c.query("update rebalance_programs set name=coalesce($2,name), calendar_rrule=case when $3::boolean then $4 else calendar_rrule end, band_trigger=coalesce($5,band_trigger), drift_threshold_pp=case when $6::boolean then $7 else drift_threshold_pp end, milestone_triggers=coalesce($8,milestone_triggers), need_lookahead_days=coalesce($9,need_lookahead_days), large_flow_pct=coalesce($10,large_flow_pct), tax_year_end=coalesce($11,tax_year_end), constraints=coalesce($12,constraints), auto_draft=coalesce($13,auto_draft), auto_convert_low_risk=coalesce($14,auto_convert_low_risk), active=coalesce($15,active) where id=$1",
        [p.id, b.name ?? null, b.calendar_rrule !== undefined, b.calendar_rrule ?? null, b.band_trigger ?? null, b.drift_threshold_pp !== undefined, b.drift_threshold_pp ?? null, b.milestone_triggers ? JSON.stringify(b.milestone_triggers) : null, b.need_lookahead_days ?? null, b.large_flow_pct ?? null, b.tax_year_end ?? null, b.constraints ? JSON.stringify({ ...p.constraints, ...b.constraints }) : null, b.auto_draft ?? null, b.auto_convert_low_risk ?? null, b.active ?? null]);
      return programView((await c.query(`${PROGRAM_SQL} where p.id=$1`, [p.id])).rows[0], today());
    });
  });
  app.post("/rebalance/programs/:id/run", { preHandler: WRITERS }, async (req, reply) => {
    const b = z.object({ objective: z.enum(OBJECTIVES).optional(), tax_year_end: z.boolean().optional(), as_of: date.optional(), note: z.string().max(500).optional() }).parse(req.body ?? {});
    return withFamily(fam(req), async (c) => { try { const r = await runProgram(c, fam(req), (req.params as any).id, { triggeredBy: "manual", detail: { by: req.user!.id }, objective: b.objective, day: b.as_of, taxYearEnd: b.tax_year_end, note: b.note }); return { ...r.run, run_at: r.run.run_at, plan: r.plan_id ? await planView(c, r.plan_id) : null, solver: { warnings: r.plan.warnings, summary: r.plan.summary } }; } catch (e) { return problem(reply, e); } });
  });
  app.post("/rebalance/evaluate", { preHandler: WRITERS }, async (req) => withFamily(fam(req), (c) => evaluatePrograms(c, fam(req), (req.body as any)?.today)));
  app.get("/rebalance/runs", async (req) => withFamily(fam(req), async (c) => {
    const q = z.object({ program_id: z.string().uuid().optional(), status: z.string().optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }).parse(req.query);
    return (await c.query(`select r.*, p.name program_name, p.scope, pl.version plan_version, pl.status plan_status, pl.summary plan_summary, (select count(*) from rebalance_moves m where m.plan_id=pl.id) moves, (select count(*) from rebalance_moves m where m.plan_id=pl.id and m.status='executed') executed
      from rebalance_runs r join rebalance_programs p on p.id=r.program_id left join rebalance_plans pl on pl.id=r.plan_id where r.family_id=$1 and ($2::uuid is null or r.program_id=$2) and ($3::text is null or r.status::text=$3) order by r.run_at desc limit $4`, [fam(req), q.program_id ?? null, q.status ?? null, q.limit])).rows.map((r) => ({ ...r, moves: Number(r.moves), executed: Number(r.executed) }));
  }));

  // ---------- plans ----------
  app.get("/rebalance/plans/:id", async (req, reply) => withFamily(fam(req), async (c) => { try { return await planView(c, (req.params as any).id); } catch (e) { return problem(reply, e); } }));
  app.patch("/rebalance/plans/:id", { preHandler: WRITERS }, async (req, reply) => {
    const b = z.object({ objective: z.enum(OBJECTIVES).optional(), exclude_move_ids: z.array(z.string().uuid()).optional(), moves: z.array(z.object({ id: z.string().uuid(), planned_date: date.optional(), amount: z.number().optional() })).optional() }).parse(req.body ?? {});
    return withFamily(fam(req), async (c) => { try { const id = await revisePlan(c, fam(req), (req.params as any).id, b); await simulatePlan(c, fam(req), id); return planView(c, id); } catch (e) { return problem(reply, e); } });
  });
  app.post("/rebalance/plans/:id/simulate", { preHandler: WRITERS }, async (req, reply) => withFamily(fam(req), async (c) => { try { return await simulatePlan(c, fam(req), (req.params as any).id); } catch (e) { return problem(reply, e); } }));
  app.post("/rebalance/plans/:id/status", { preHandler: WRITERS }, async (req, reply) => {
    const b = z.object({ status: z.enum(["in_review", "approved", "converted", "cancelled", "draft"]), auth_method: z.enum(["totp", "biometric", "passkey"]).optional(), auth_proof: z.string().optional(), note: z.string().max(1000).optional(), override_breach: z.boolean().optional() }).parse(req.body);
    return withFamily(fam(req), async (c) => { try {
      const id = (req.params as any).id; const p = (await c.query("select * from rebalance_plans where id=$1", [id])).rows[0]; if (!p) return void reply.code(404).send({ title: "Not found", status: 404 });
      if (b.status === "approved") {
        if (!["owner", "member"].includes(req.family!.role)) return void reply.code(403).send({ title: "Only an owner or member can approve a plan", status: 403 });
        if (!b.auth_proof || !(await verifyStepUp(req.user!.id, b.auth_method ?? "totp", b.auth_proof))) return void reply.code(403).send({ title: "Step-up failed", status: 403 });
        const sim = p.simulation ?? (await simulatePlan(c, fam(req), id));
        if (sim.new_breach && !b.override_breach) return void reply.code(409).send({ title: "The plan leaves a new policy breach — override with a note or edit the plan", status: 409, simulation: sim });
        try { await c.query("update rebalance_plans set status='approved', approved_by=$2, approved_at=now(), note=coalesce($3,note) where id=$1", [id, req.user!.id, b.note ?? null]); } catch (e: any) { return void reply.code(409).send({ title: e.message.replace(/^.*?illegal/, "Illegal"), status: 409 }); } // the DB state machine decides
        await c.query("update rebalance_runs set status='plan_approved' where plan_id=$1", [id]);
        return planView(c, id);
      }
      if (b.status === "converted") { const r = await convertPlan(c, fam(req), id, req.user!.id); return { ...(await planView(c, id)), intents: r.intents }; }
      try { await c.query("update rebalance_plans set status=$2::rebalance_plan_status, note=coalesce($3,note) where id=$1", [id, b.status, b.note ?? null]); } catch (e: any) { return void reply.code(409).send({ title: e.message.replace(/^.*?illegal/, "Illegal"), status: 409 }); }
      if (b.status === "cancelled") { await c.query("update rebalance_runs set status='cancelled' where plan_id=$1", [id]); await c.query("delete from need_coverage where move_id in (select id from rebalance_moves where plan_id=$1)", [id]); }
      return planView(c, id);
    } catch (e) { return problem(reply, e); } });
  });

  // ---------- funding needs ----------
  app.get("/funding-needs", async (req) => withFamily(fam(req), async (c) => { const q = z.object({ entity_id: z.string().uuid().optional(), days: z.coerce.number().int().min(1).max(3650).optional(), status: z.string().optional() }).parse(req.query); return needsView(c, fam(req), { entityId: q.entity_id ?? null, days: q.days, status: q.status ?? null }); }));
  app.post("/funding-needs/gather", { preHandler: WRITERS }, async (req) => withFamily(fam(req), async (c) => { const r = await gatherNeeds(c, fam(req), (req.body as any)?.today); await computeLotConstraints(c, fam(req)); return r; }));
  app.post("/funding-needs", { preHandler: WRITERS }, async (req, reply) => {
    const b = z.object({ entity_id: z.string().uuid(), goal_id: z.string().uuid().nullable().optional(), kind: z.enum(["goal_drawdown", "capital_call", "tax_instalment", "liability_payment", "insurance_premium", "planned_expense", "distribution_to_family", "buffer_rebuild", "other"]).default("other"), label: z.string().min(1).max(160), need_date: date, amount: z.union([z.number(), z.string()]), flexibility_days: z.number().int().min(0).max(365).default(0), priority: z.number().int().min(1).max(3).default(2), bank_account_id: z.string().uuid().nullable().optional(), note: z.string().max(500).optional() }).parse(req.body);
    return withFamily(fam(req), async (c) => { const r = (await c.query("insert into funding_needs (family_id, entity_id, goal_id, kind, label, need_date, amount, flexibility_days, source_type, source_id, priority, bank_account_id, note) values ($1,$2,$3,$4::need_kind,$5,$6,$7,$8,'manual',gen_random_uuid(),$9,$10,$11) returning id", [fam(req), b.entity_id, b.goal_id ?? null, b.kind, b.label, b.need_date, Number(b.amount), b.flexibility_days, b.priority, b.bank_account_id ?? null, b.note ?? null])).rows[0]; await refreshNeedStatus(c, fam(req)); return void reply.code(201).send((await needsView(c, fam(req))).find((n) => n.id === r.id)); });
  });
  app.patch("/funding-needs/:id", { preHandler: WRITERS }, async (req, reply) => {
    const b = z.object({ label: z.string().min(1).max(160).optional(), need_date: date.optional(), amount: z.union([z.number(), z.string()]).optional(), flexibility_days: z.number().int().min(0).optional(), priority: z.number().int().min(1).max(3).optional(), status: z.enum(["planned", "funded", "partially_funded", "due", "met", "cancelled"]).optional(), funded_amount: z.union([z.number(), z.string()]).optional(), bank_account_id: z.string().uuid().nullable().optional(), note: z.string().max(500).nullable().optional() }).parse(req.body ?? {});
    return withFamily(fam(req), async (c) => { const r = await c.query("update funding_needs set label=coalesce($2,label), need_date=coalesce($3,need_date), amount=coalesce($4,amount), flexibility_days=coalesce($5,flexibility_days), priority=coalesce($6,priority), status=coalesce($7::need_status,status), funded_amount=coalesce($8,funded_amount), bank_account_id=coalesce($9,bank_account_id), note=coalesce($10,note), updated_at=now() where id=$1 returning id", [(req.params as any).id, b.label ?? null, b.need_date ?? null, b.amount == null ? null : Number(b.amount), b.flexibility_days ?? null, b.priority ?? null, b.status ?? null, b.funded_amount == null ? null : Number(b.funded_amount), b.bank_account_id ?? null, b.note ?? null]); if (!r.rowCount) return void reply.code(404).send({ title: "Not found", status: 404 }); if (!b.status) await refreshNeedStatus(c, fam(req)); return (await needsView(c, fam(req))).find((n) => n.id === (req.params as any).id) ?? { id: (req.params as any).id, status: b.status }; });
  });
  app.delete("/funding-needs/:id", { preHandler: WRITERS }, async (req, reply) => withFamily(fam(req), async (c) => { const r = await c.query("update funding_needs set status='cancelled', updated_at=now() where id=$1", [(req.params as any).id]); return r.rowCount ? void reply.code(204).send() : void reply.code(404).send({ title: "Not found", status: 404 }); }));

  // ---------- calendar & lot constraints ----------
  app.get("/rebalance/calendar", async (req) => withFamily(fam(req), async (c) => { const q = z.object({ entity_id: z.string().uuid().optional(), from: date.optional(), to: date.optional() }).parse(req.query); const from = q.from ?? addDays(today(), -14); return calendar(c, fam(req), from, q.to ?? addDays(from, 400), q.entity_id ?? null); }));
  app.get("/holdings/:id/lot-constraints", async (req, reply) => withFamily(fam(req), async (c) => {
    const h = (await c.query("select h.id, i.name from holdings h join instruments i on i.id=h.instrument_id where h.id=$1", [(req.params as any).id])).rows[0]; if (!h) return void reply.code(404).send({ title: "Not found", status: 404 });
    if (!(await c.query("select 1 from lot_constraints lc join lots l on l.id=lc.lot_id where l.holding_id=$1 limit 1", [h.id])).rowCount) await computeLotConstraints(c, fam(req));
    return { holding_id: h.id, instrument: h.name, lots: (await c.query("select l.id lot_id, l.buy_date, l.remaining_qty, l.unit_cost, lc.lock_in_until, lc.exit_load_until, lc.exit_load_pct, lc.ltcg_eligible_on, lc.settlement_days, lc.liquidity_class, lc.matures_on, lc.manual, lc.computed_at from lots l left join lot_constraints lc on lc.lot_id=l.id where l.holding_id=$1 and l.remaining_qty > 0 order by l.buy_date", [h.id])).rows.map((l) => ({ ...l, buy_date: iso(l.buy_date), remaining_qty: Number(l.remaining_qty), unit_cost: Number(l.unit_cost), lock_in_until: iso(l.lock_in_until), exit_load_until: iso(l.exit_load_until), ltcg_eligible_on: iso(l.ltcg_eligible_on), matures_on: iso(l.matures_on), exit_load_pct: l.exit_load_pct == null ? null : Number(l.exit_load_pct) })) };
  }));
  app.put("/lots/:id/constraints", { preHandler: WRITERS }, async (req, reply) => {
    const b = z.object({ lock_in_until: date.nullable().optional(), exit_load_until: date.nullable().optional(), exit_load_pct: z.number().nullable().optional(), ltcg_eligible_on: date.nullable().optional(), settlement_days: z.number().int().min(0).max(120).optional(), liquidity_class: z.string().max(20).optional(), matures_on: date.nullable().optional() }).parse(req.body ?? {});
    return withFamily(fam(req), async (c) => { const l = (await c.query("select id from lots where id=$1", [(req.params as any).id])).rows[0]; if (!l) return void reply.code(404).send({ title: "Not found", status: 404 }); await computeLotConstraints(c, fam(req)).catch(() => null);
      const r = (await c.query("update lot_constraints set lock_in_until=coalesce($2,lock_in_until), exit_load_until=coalesce($3,exit_load_until), exit_load_pct=coalesce($4,exit_load_pct), ltcg_eligible_on=coalesce($5,ltcg_eligible_on), settlement_days=coalesce($6,settlement_days), liquidity_class=coalesce($7,liquidity_class), matures_on=coalesce($8,matures_on), manual=true, computed_at=now() where lot_id=$1 returning *", [l.id, b.lock_in_until ?? null, b.exit_load_until ?? null, b.exit_load_pct ?? null, b.ltcg_eligible_on ?? null, b.settlement_days ?? null, b.liquidity_class ?? null, b.matures_on ?? null])).rows[0]; return { ...r, lock_in_until: iso(r.lock_in_until), exit_load_until: iso(r.exit_load_until), ltcg_eligible_on: iso(r.ltcg_eligible_on), matures_on: iso(r.matures_on) }; });
  });
}
