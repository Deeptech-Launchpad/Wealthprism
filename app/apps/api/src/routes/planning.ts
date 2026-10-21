import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireFamily, requireRole } from "../lib/auth.js";
import { withFamily, money } from "../lib/db.js";
import { notifyTask } from "../lib/notify.js";
import { runScenario, ensureBaseline, tablesProvider, loadState, DEFAULT_ASSUMPTIONS } from "../lib/planning.js";
import { runOptimiser, executionProgress } from "../jobs/planning.js";
import { simulate, compareRegimes, fyOf } from "@fo/finance";
import { emitEvent } from "../lib/opendata.js";

const iso = (d: any) => (d ? new Date(d).toISOString().slice(0, 10) : null);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const KINDS = ["sell_holding", "buy_instrument", "switch", "redeem_before_date", "defer_sale_to_fy", "harvest_loss", "book_gain_within_exemption", "transfer_to_entity", "change_tax_regime", "sell_property", "reinvest_54ec", "reinvest_54f", "prepay_loan", "exit_private", "donate_80g", "contribute_nps", "contribute_ppf", "change_rent", "deploy_cash", "custom"] as const;
const TARGETS = ["holding", "property", "private_investment", "bank_account", "goal", "entity"] as const;
const WRITERS = requireRole("owner", "member", "operator");
const scenarioInput = z.object({ name: z.string().min(1).max(120), description: z.string().max(2000).optional(), parent_scenario_id: z.string().uuid().optional(), base_date: date.optional(), horizon_fys: z.number().int().min(1).max(10).optional(), entity_scope: z.array(z.string().uuid()).nullable().optional(),
  assumptions: z.object({ returns: z.object({ liquidity: z.number().optional(), income: z.number().optional(), growth: z.number().optional() }).partial().optional(), inflation: z.number().optional(), regime: z.record(z.enum(["old", "new"])).optional(), price_growth: z.record(z.number()).optional() }).optional() });
const actionInput = z.object({ seq: z.number().int().positive().optional(), kind: z.enum(KINDS), entity_id: z.string().uuid().nullable().optional(), target_type: z.enum(TARGETS).nullable().optional(), target_id: z.string().uuid().nullable().optional(), params: z.record(z.any()).default({}), planned_date: date, planned_amount: z.union([z.number(), z.string()]).nullable().optional(), note: z.string().max(1000).optional() });
/** Field-level checks per kind (FO-73): the engine tolerates gaps, but the API refuses obviously incomplete actions. */
function validateAction(a: z.infer<typeof actionInput>): { field: string; message: string }[] {
  const errs: { field: string; message: string }[] = []; const p = a.params ?? {};
  const need = (cond: boolean, field: string, message: string) => { if (!cond) errs.push({ field, message }); };
  switch (a.kind) {
    case "sell_holding": case "harvest_loss": case "redeem_before_date": case "book_gain_within_exemption": case "switch": need(!!(a.target_id || p.instrument_id), "target_id", "holding (target_id) or params.instrument_id required"); if (a.kind === "switch") need(!!p.to_instrument_id, "params.to_instrument_id", "required"); break;
    case "defer_sale_to_fy": need(!!(a.target_id || p.instrument_id), "target_id", "holding required"); need(/^\d{4}-\d{2}$/.test(String(p.fy ?? "")), "params.fy", "FY like 2027-28 required"); break;
    case "buy_instrument": case "deploy_cash": need(Number(p.amount ?? a.planned_amount) > 0, "params.amount", "positive amount required"); break;
    case "transfer_to_entity": need(!!(p.to_entity_id || a.target_id), "params.to_entity_id", "required"); need(Number(p.amount ?? p.monthly ?? a.planned_amount) > 0 || !!p.holding_id, "params.amount", "amount, monthly or holding_id required"); break;
    case "change_tax_regime": need(["old", "new"].includes(p.regime), "params.regime", "old or new"); need(!!a.entity_id, "entity_id", "required"); break;
    case "sell_property": case "change_rent": need(!!a.target_id, "target_id", "property required"); if (a.kind === "sell_property") need(Number(p.price ?? a.planned_amount) > 0, "params.price", "sale price required"); break;
    case "reinvest_54ec": case "reinvest_54f": case "prepay_loan": case "donate_80g": case "contribute_nps": case "contribute_ppf": need(Number(p.amount ?? a.planned_amount) > 0, "params.amount", "positive amount required"); break;
    case "exit_private": need(!!a.target_id, "target_id", "private investment required"); break;
    case "custom": need(p.amount != null || p.note, "params", "amount or note required"); break;
  }
  return errs;
}
const TRANSITIONS: Record<string, string[]> = { draft: ["in_review", "archived"], in_review: ["draft", "approved", "archived"], approved: ["executing", "archived"], executing: ["completed", "archived"], completed: ["archived"], archived: ["draft"] };
const scenarioView = (s: any) => ({ ...s, base_date: iso(s.base_date), latest_result: s.latest_result ?? null });
const SCENARIO_SQL = `select p.*, (select row_to_json(r) from (select id, computed_at, engine_version, summary, warnings, allocation_after, goals_after, by_fy from plan_results r where r.scenario_id=p.id order by computed_at desc limit 1) r) as latest_result,
  (select count(*) from plan_actions a where a.scenario_id=p.id) as action_count, (select count(*) from plan_actions a where a.scenario_id=p.id and a.status='done') as actions_done, u.name as created_by_name
  from plan_scenarios p left join users u on u.id=p.created_by where p.deleted_at is null`;

export default async function routes(app: FastifyInstance) {
  app.addHook("preHandler", requireFamily);
  const fam = (req: any) => req.family!.familyId as string;

  // ---------- scenarios ----------
  app.get("/plans", async (req) => withFamily(fam(req), async (c) => {
    const q = z.object({ status: z.string().optional() }).parse(req.query);
    await ensureBaseline(c, fam(req), req.user!.id);
    const rows = (await c.query(`${SCENARIO_SQL} ${q.status ? "and p.status=$1" : ""} order by p.is_baseline desc, p.created_at`, q.status ? [q.status] : [])).rows;
    const out = [];
    for (const s of rows) out.push({ ...scenarioView(s), execution: await executionProgress(c, s.id) });
    return out;
  }));
  app.post("/plans", { preHandler: WRITERS }, async (req, reply) => {
    const b = scenarioInput.parse(req.body);
    return withFamily(fam(req), async (c) => {
      let parentVersion = 0;
      if (b.parent_scenario_id) { const p = (await c.query("select version from plan_scenarios where id=$1 and deleted_at is null", [b.parent_scenario_id])).rows[0]; if (!p) return void reply.code(404).send({ title: "Parent scenario not found", status: 404 }); parentVersion = Number(p.version); }
      const s = (await c.query("insert into plan_scenarios (family_id, name, description, parent_scenario_id, version, base_date, horizon_fys, entity_scope, assumptions, created_by) values ($1,$2,$3,$4,$5,coalesce($6::date, current_date),$7,$8,$9,$10) returning *",
        [fam(req), b.name, b.description ?? null, b.parent_scenario_id ?? null, parentVersion + 1, b.base_date ?? null, b.horizon_fys ?? 3, b.entity_scope ?? null, JSON.stringify({ ...DEFAULT_ASSUMPTIONS, ...(b.assumptions ?? {}), returns: { ...DEFAULT_ASSUMPTIONS.returns, ...(b.assumptions?.returns ?? {}) } }), req.user!.id])).rows[0];
      if (b.parent_scenario_id) await c.query("insert into plan_actions (family_id, scenario_id, seq, kind, entity_id, target_type, target_id, params, planned_date, planned_amount, note) select family_id, $2, seq, kind, entity_id, target_type, target_id, params, planned_date, planned_amount, note from plan_actions where scenario_id=$1", [b.parent_scenario_id, s.id]);
      return void reply.code(201).send(scenarioView(s));
    });
  });
  app.get("/plans/compare", async (req, reply) => withFamily(fam(req), async (c) => {
    const ids = String((req.query as any).ids ?? "").split(",").map((x) => x.trim()).filter(Boolean);
    if (ids.length < 1 || ids.length > 4) return void reply.code(422).send({ title: "Pass 1–4 scenario ids", status: 422 });
    const base = await ensureBaseline(c, fam(req));
    const all = [base.id, ...ids.filter((i) => i !== base.id)];
    const rows = (await c.query(`${SCENARIO_SQL} and p.id = any($1)`, [all])).rows;
    const cols = all.map((id) => rows.find((r) => r.id === id)).filter(Boolean);
    const results: Record<string, any> = {};
    for (const s of cols) results[s.id] = s.latest_result ?? (await runScenario(c, fam(req), s.id));
    const name = (s: any) => s.name;
    const val = (fn: (r: any, s: any) => string) => Object.fromEntries(cols.map((s) => [name(s), fn(results[s.id], s)]));
    const fys = [...new Set(cols.flatMap((s) => (results[s.id].by_fy ?? []).map((x: any) => x.fy)))].sort() as string[];
    return {
      scenarios: cols.map((s) => ({ id: s.id, name: s.name, status: s.status, is_baseline: s.is_baseline })),
      metrics: [
        { metric: "Tax over the horizon", values: val((r) => money(r.summary?.tax_total)) },
        { metric: "Saving vs baseline", values: val((r, s) => (s.is_baseline ? "—" : money(-(r.summary?.tax_vs_baseline ?? 0)))) },
        { metric: "Post-tax cash generated", values: val((r) => money(r.summary?.post_tax_cash)) },
        { metric: "Max bucket drift after", values: val((r) => `${r.summary?.drift_max_pp ?? 0} pp`) },
        { metric: "Income bucket after", values: val((r) => `${(r.allocation_after ?? []).find((a: any) => a.bucket === "income")?.pct ?? 0}%`) },
        { metric: "Projected net worth at horizon", values: val((r) => money(r.summary?.net_worth_end)) },
        { metric: "234B/C interest exposure", values: val((r) => money(r.summary?.interest_234_total)) },
        { metric: "Actions / warnings", values: val((r, s) => `${s.action_count} · ${(r.warnings ?? []).length} warning${(r.warnings ?? []).length === 1 ? "" : "s"}`) },
      ],
      by_fy: fys.map((fy) => ({ fy, tax: Object.fromEntries(cols.map((s) => [name(s), money((results[s.id].by_fy ?? []).filter((x: any) => x.fy === fy).reduce((t: number, x: any) => t + Number(x.tax?.total ?? 0), 0))])) })),
      allocation: ["liquidity", "income", "growth"].map((b) => ({ bucket: b, pct: Object.fromEntries(cols.map((s) => [name(s), (results[s.id].allocation_after ?? []).find((a: any) => a.bucket === b)?.pct ?? 0])) })),
    };
  }));
  app.get("/plans/:id", async (req, reply) => withFamily(fam(req), async (c) => {
    const id = (req.params as any).id;
    const s = (await c.query(`${SCENARIO_SQL} and p.id=$1`, [id])).rows[0];
    if (!s) return void reply.code(404).send({ title: "Not found", status: 404 });
    const actions = (await c.query("select a.*, t.status as task_status from plan_actions a left join tasks t on t.id=a.task_id where a.scenario_id=$1 order by a.seq", [id])).rows.map(actionView);
    const comments = (await c.query("select pc.id, pc.user_id, u.name as user_name, pc.body, pc.created_at from plan_comments pc join users u on u.id=pc.user_id where scenario_id=$1 order by created_at", [id])).rows;
    const results = (await c.query("select id, computed_at, engine_version, summary, by_fy, allocation_after, goals_after, cash_ladder, warnings from plan_results where scenario_id=$1 order by computed_at desc limit 1", [id])).rows;
    return { ...scenarioView(s), actions, comments, latest_result: results[0] ?? null, execution: await executionProgress(c, id) };
  }));
  const editable = async (c: any, id: string, reply: any) => { const s = (await c.query("select * from plan_scenarios where id=$1 and deleted_at is null", [id])).rows[0]; if (!s) { reply.code(404).send({ title: "Not found", status: 404 }); return null; } if (s.is_baseline) { reply.code(409).send({ title: "The baseline is maintained automatically", status: 409 }); return null; } if (!["draft", "in_review"].includes(s.status)) { reply.code(409).send({ title: `A ${s.status} scenario is frozen — clone it to change`, status: 409 }); return null; } return s; };
  app.patch("/plans/:id", { preHandler: WRITERS }, async (req, reply) => {
    const b = scenarioInput.partial().parse(req.body ?? {});
    return withFamily(fam(req), async (c) => {
      const id = (req.params as any).id; const s = await editable(c, id, reply); if (!s) return;
      const assumptions = b.assumptions ? { ...s.assumptions, ...b.assumptions, returns: { ...(s.assumptions?.returns ?? {}), ...(b.assumptions.returns ?? {}) } } : s.assumptions;
      const r = (await c.query("update plan_scenarios set name=coalesce($2,name), description=coalesce($3,description), base_date=coalesce($4::date,base_date), horizon_fys=coalesce($5,horizon_fys), entity_scope=coalesce($6,entity_scope), assumptions=$7, version=version+1 where id=$1 returning *", [id, b.name ?? null, b.description ?? null, b.base_date ?? null, b.horizon_fys ?? null, b.entity_scope ?? null, JSON.stringify(assumptions)])).rows[0];
      return scenarioView(r);
    });
  });
  app.delete("/plans/:id", { preHandler: WRITERS }, async (req, reply) => withFamily(fam(req), async (c) => {
    const s = (await c.query("select is_baseline from plan_scenarios where id=$1 and deleted_at is null", [(req.params as any).id])).rows[0];
    if (!s) return void reply.code(404).send({ title: "Not found", status: 404 });
    if (s.is_baseline) return void reply.code(409).send({ title: "The baseline cannot be deleted", status: 409 });
    await c.query("update plan_scenarios set deleted_at=now(), status='archived' where id=$1", [(req.params as any).id]);
    return void reply.code(204).send();
  }));
  app.post("/plans/:id/clone", { preHandler: WRITERS }, async (req, reply) => withFamily(fam(req), async (c) => {
    const id = (req.params as any).id; const b = z.object({ name: z.string().optional() }).parse(req.body ?? {});
    const s = (await c.query("select * from plan_scenarios where id=$1 and deleted_at is null", [id])).rows[0];
    if (!s) return void reply.code(404).send({ title: "Not found", status: 404 });
    const n = (await c.query("insert into plan_scenarios (family_id, name, description, parent_scenario_id, version, base_date, horizon_fys, entity_scope, assumptions, created_by) values ($1,$2,$3,$4,$5,current_date,$6,$7,$8,$9) returning *", [fam(req), b.name ?? `${s.name} (v${Number(s.version) + 1})`, s.description, s.id, Number(s.version) + 1, s.horizon_fys, s.entity_scope, JSON.stringify(s.assumptions), req.user!.id])).rows[0];
    await c.query("insert into plan_actions (family_id, scenario_id, seq, kind, entity_id, target_type, target_id, params, planned_date, planned_amount, note) select family_id, $2, seq, kind, entity_id, target_type, target_id, params, planned_date, planned_amount, note from plan_actions where scenario_id=$1", [id, n.id]);
    return void reply.code(201).send({ ...scenarioView(n), action_count: (await c.query("select count(*) n from plan_actions where scenario_id=$1", [n.id])).rows[0].n });
  }));

  // ---------- actions ----------
  const actionView = (a: any) => ({ ...a, planned_date: iso(a.planned_date), actual_date: iso(a.actual_date), planned_amount: a.planned_amount == null ? null : money(a.planned_amount), actual_amount: a.actual_amount == null ? null : money(a.actual_amount) });
  app.get("/plans/:id/actions", async (req) => withFamily(fam(req), async (c) => (await c.query("select * from plan_actions where scenario_id=$1 order by seq", [(req.params as any).id])).rows.map(actionView)));
  app.post("/plans/:id/actions", { preHandler: WRITERS }, async (req, reply) => {
    const b = actionInput.parse(req.body); const errs = validateAction(b);
    if (errs.length) return void reply.code(422).send({ title: "Action is incomplete", status: 422, errors: errs });
    return withFamily(fam(req), async (c) => {
      const id = (req.params as any).id; const s = await editable(c, id, reply); if (!s) return;
      const seq = b.seq ?? Number((await c.query("select coalesce(max(seq),0)+1 n from plan_actions where scenario_id=$1", [id])).rows[0].n);
      const a = (await c.query("insert into plan_actions (family_id, scenario_id, seq, kind, entity_id, target_type, target_id, params, planned_date, planned_amount, note) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning *", [fam(req), id, seq, b.kind, b.entity_id ?? null, b.target_type ?? null, b.target_id ?? null, JSON.stringify(b.params ?? {}), b.planned_date, b.planned_amount == null ? null : Number(b.planned_amount), b.note ?? null])).rows[0];
      await c.query("update plan_scenarios set version=version+1 where id=$1", [id]);
      return void reply.code(201).send(actionView(a));
    });
  });
  app.put("/plans/:id/actions", { preHandler: WRITERS }, async (req, reply) => {
    const list = z.array(actionInput).parse(req.body);
    const errs = list.flatMap((a, i) => validateAction(a).map((e) => ({ ...e, index: i })));
    if (errs.length) return void reply.code(422).send({ title: "Action list is incomplete", status: 422, errors: errs });
    return withFamily(fam(req), async (c) => {
      const id = (req.params as any).id; const s = await editable(c, id, reply); if (!s) return;
      await c.query("delete from plan_actions where scenario_id=$1", [id]);
      const out = [];
      for (const [i, b] of list.entries()) out.push(actionView((await c.query("insert into plan_actions (family_id, scenario_id, seq, kind, entity_id, target_type, target_id, params, planned_date, planned_amount, note) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning *", [fam(req), id, b.seq ?? i + 1, b.kind, b.entity_id ?? null, b.target_type ?? null, b.target_id ?? null, JSON.stringify(b.params ?? {}), b.planned_date, b.planned_amount == null ? null : Number(b.planned_amount), b.note ?? null])).rows[0]));
      await c.query("update plan_scenarios set version=version+1 where id=$1", [id]);
      return out;
    });
  });
  app.patch("/plans/:id/actions/:actionId", { preHandler: WRITERS }, async (req, reply) => {
    const b = actionInput.partial().extend({ status: z.enum(["planned", "in_progress", "done", "skipped"]).optional(), actual_date: date.optional(), actual_amount: z.union([z.number(), z.string()]).optional(), actual_ref_type: z.string().optional(), actual_ref_id: z.string().uuid().optional() }).parse(req.body ?? {});
    return withFamily(fam(req), async (c) => {
      const { id, actionId } = req.params as any;
      const s = (await c.query("select * from plan_scenarios where id=$1 and deleted_at is null", [id])).rows[0]; if (!s) return void reply.code(404).send({ title: "Not found", status: 404 });
      const a = (await c.query("select * from plan_actions where id=$1 and scenario_id=$2", [actionId, id])).rows[0]; if (!a) return void reply.code(404).send({ title: "Action not found", status: 404 });
      const editingTerms = ["kind", "entity_id", "target_type", "target_id", "params", "planned_date", "planned_amount", "seq"].some((k) => (b as any)[k] !== undefined);
      if (editingTerms && !["draft", "in_review"].includes(s.status)) return void reply.code(409).send({ title: `A ${s.status} scenario is frozen — record execution or clone it`, status: 409 });
      const merged = { ...a, ...Object.fromEntries(Object.entries(b).filter(([, v]) => v !== undefined)) };
      if (editingTerms) { const errs = validateAction({ ...merged, params: merged.params ?? {} } as any); if (errs.length) return void reply.code(422).send({ title: "Action is incomplete", status: 422, errors: errs }); }
      const r = (await c.query(`update plan_actions set seq=$2, kind=$3, entity_id=$4, target_type=$5, target_id=$6, params=$7, planned_date=$8, planned_amount=$9, note=$10, status=$11, actual_date=$12, actual_amount=$13, actual_ref_type=$14, actual_ref_id=$15,
          variance = case when $12::date is not null and $13::numeric is not null then jsonb_build_object('amount', $13::numeric - coalesce(planned_amount, $13::numeric), 'days', $12::date - planned_date) else variance end where id=$1 returning *`,
        [actionId, merged.seq, merged.kind, merged.entity_id ?? null, merged.target_type ?? null, merged.target_id ?? null, JSON.stringify(merged.params ?? {}), iso(merged.planned_date), merged.planned_amount == null ? null : Number(merged.planned_amount), merged.note ?? null, merged.status ?? a.status, merged.actual_date ?? iso(a.actual_date), merged.actual_amount == null ? null : Number(merged.actual_amount), merged.actual_ref_type ?? a.actual_ref_type, merged.actual_ref_id ?? a.actual_ref_id])).rows[0];
      if (b.status === "done" && a.task_id) await c.query("update tasks set status='done', done_at=now(), verification = (case when $2::text is not null then 'verified' else 'pending' end)::verification where id=$1 and status='open'", [a.task_id, b.actual_ref_id ?? null]);
      if (b.status === "skipped" && a.task_id) await c.query("update tasks set status='dismissed' where id=$1 and status='open'", [a.task_id]);
      if (editingTerms) await c.query("update plan_scenarios set version=version+1 where id=$1", [id]);
      // every action done or skipped → the plan is complete
      const left = Number((await c.query("select count(*) n from plan_actions where scenario_id=$1 and status in ('planned','in_progress')", [id])).rows[0].n);
      if (!left && s.status === "executing") await c.query("update plan_scenarios set status='completed' where id=$1", [id]);
      return actionView(r);
    });
  });
  app.delete("/plans/:id/actions/:actionId", { preHandler: WRITERS }, async (req, reply) => withFamily(fam(req), async (c) => {
    const { id, actionId } = req.params as any; const s = await editable(c, id, reply); if (!s) return;
    const r = await c.query("delete from plan_actions where id=$1 and scenario_id=$2", [actionId, id]);
    if (!r.rowCount) return void reply.code(404).send({ title: "Action not found", status: 404 });
    await c.query("update plan_scenarios set version=version+1 where id=$1", [id]);
    return void reply.code(204).send();
  }));

  // ---------- simulate / results ----------
  app.post("/plans/:id/simulate", async (req, reply) => {
    const b = z.object({ assumptions_override: z.record(z.any()).optional() }).parse(req.body ?? {});
    return withFamily(fam(req), async (c) => {
      const id = (req.params as any).id;
      const n = Number((await c.query("select count(*) n from plan_actions where scenario_id=$1", [id])).rows[0]?.n ?? 0);
      if (n > 50) return void reply.code(202).send({ job_id: id, status: "queued", detail: "Scenarios above 50 actions run in the nightly job" });
      try { const r = await runScenario(c, fam(req), id, { assumptionsOverride: b.assumptions_override as any, persist: true }); return { ...r, action_effects: undefined, actions: (await c.query("select id, seq, kind, simulated_effect from plan_actions where scenario_id=$1 order by seq", [id])).rows }; }
      catch (e: any) { if (/not found/.test(e.message)) return void reply.code(404).send({ title: e.message, status: 404 }); await c.query("update plan_scenarios set last_error=$2 where id=$1", [id, e.message]); throw e; }
    });
  });
  app.get("/plans/:id/results", async (req) => withFamily(fam(req), async (c) => {
    const q = z.object({ limit: z.coerce.number().min(1).max(20).default(5) }).parse(req.query);
    return (await c.query("select id, scenario_id, computed_at, engine_version, summary, by_fy, allocation_after, goals_after, cash_ladder, warnings from plan_results where scenario_id=$1 order by computed_at desc limit $2", [(req.params as any).id, q.limit])).rows;
  }));

  // ---------- review workflow ----------
  app.post("/plans/:id/comments", async (req, reply) => {
    const b = z.object({ body: z.string().min(1).max(4000) }).parse(req.body);
    return withFamily(fam(req), async (c) => {
      const id = (req.params as any).id;
      if (!(await c.query("select 1 from plan_scenarios where id=$1 and deleted_at is null", [id])).rows[0]) return void reply.code(404).send({ title: "Not found", status: 404 });
      const r = (await c.query("insert into plan_comments (family_id, scenario_id, user_id, body) values ($1,$2,$3,$4) returning id, user_id, body, created_at", [fam(req), id, req.user!.id, b.body])).rows[0];
      return void reply.code(201).send({ ...r, user_name: req.user!.name });
    });
  });
  /** draft → in_review → approved (owner, freezes, creates one task per action) → executing → completed; 409 on conflicts. */
  app.post("/plans/:id/status", { preHandler: requireRole("owner", "member", "operator") }, async (req, reply) => {
    const b = z.object({ status: z.enum(["draft", "in_review", "approved", "executing", "completed", "archived"]), note: z.string().optional() }).parse(req.body);
    return withFamily(fam(req), async (c) => {
      const id = (req.params as any).id; const role = req.family!.role;
      const s = (await c.query("select * from plan_scenarios where id=$1 and deleted_at is null", [id])).rows[0];
      if (!s) return void reply.code(404).send({ title: "Not found", status: 404 });
      if (s.is_baseline) return void reply.code(409).send({ title: "The baseline has no workflow", status: 409 });
      if (!TRANSITIONS[s.status]?.includes(b.status)) return void reply.code(409).send({ title: `Cannot move from ${s.status} to ${b.status}`, status: 409, allowed: TRANSITIONS[s.status] });
      if (b.status === "approved" && role !== "owner") return void reply.code(403).send({ title: "Only an owner can approve a scenario", status: 403 });
      if (["executing", "completed"].includes(b.status) && !["owner", "member"].includes(role)) return void reply.code(403).send({ title: "Insufficient role", status: 403 });
      const actions = (await c.query("select * from plan_actions where scenario_id=$1 order by seq", [id])).rows;
      if (b.status === "approved") {
        if (!actions.length) return void reply.code(409).send({ title: "Nothing to approve — the scenario has no actions", status: 409 });
        // two executing scenarios may not act on the same holding / property
        const targets = actions.map((a) => a.target_id).filter(Boolean);
        const clash = (await c.query("select distinct p.name from plan_actions a join plan_scenarios p on p.id=a.scenario_id where p.status in ('approved','executing') and p.id <> $1 and p.deleted_at is null and a.target_id = any($2::uuid[]) and a.status in ('planned','in_progress')", [id, targets])).rows;
        if (clash.length) return void reply.code(409).send({ title: `Another plan is already executing on the same targets: ${clash.map((x) => x.name).join(", ")}`, status: 409 });
        if (!(await c.query("select 1 from plan_results where scenario_id=$1", [id])).rows[0]) await runScenario(c, fam(req), id);
        await c.query("update plan_scenarios set status='approved', approved_by=$2, approved_at=now() where id=$1", [id, req.user!.id]);
        await emitEvent(c, fam(req), "plan.approved", { scenario_id: id, approved_by: req.user!.id, actions: actions.length }).catch(() => null);
        const ents = (await c.query("select id, name from entities")).rows;
        for (const a of actions) {
          if (a.task_id) continue;
          const eff = a.simulated_effect ?? {}; const ent = ents.find((e) => e.id === a.entity_id);
          const title = `${describeAction(a, ent?.name)}`;
          const reason = `Plan "${s.name}"${eff.detail ? ` · ${eff.detail}` : ""}${eff.tax ? ` · tax effect ₹${Number(eff.tax).toLocaleString("en-IN")}` : ""}`;
          const t = (await c.query("insert into tasks (family_id, entity_id, module, title, reason, amount, due_date, severity, source_type, source_id, verification) values ($1,$2,'planning',$3,$4,$5,$6,2,'plan_action',$7, case when $8 then 'pending'::verification else 'na'::verification end) returning *",
            [fam(req), a.entity_id ?? null, title, reason, a.planned_amount ?? null, iso(a.planned_date), a.id, ["sell_holding", "harvest_loss", "book_gain_within_exemption", "defer_sale_to_fy", "redeem_before_date", "buy_instrument", "switch", "exit_private", "sell_property", "deploy_cash"].includes(a.kind)])).rows[0];
          await c.query("update plan_actions set task_id=$2 where id=$1", [a.id, t.id]);
          await notifyTask(c, t, { push: false });
        }
        await c.query("update plan_scenarios set status='executing' where id=$1 and exists (select 1 from plan_actions where scenario_id=$1)", [id]);
      } else {
        await c.query("update plan_scenarios set status=$2 where id=$1", [id, b.status]);
        if (b.status === "archived" || b.status === "draft") await c.query("update tasks set status='dismissed' where source_type='plan_action' and source_id in (select id from plan_actions where scenario_id=$1) and status='open'", [id]);
      }
      if (b.note) await c.query("insert into plan_comments (family_id, scenario_id, user_id, body) values ($1,$2,$3,$4)", [fam(req), id, req.user!.id, `[${b.status}] ${b.note}`]);
      await c.query("insert into audit_log (family_id, user_id, action, table_name, row_id, after) values ($1,$2,'status','plan_scenarios',$3,$4)", [fam(req), req.user!.id, id, JSON.stringify(b)]);
      const out = (await c.query(`${SCENARIO_SQL} and p.id=$1`, [id])).rows[0];
      return { ...scenarioView(out), execution: await executionProgress(c, id), tasks_created: b.status === "approved" ? actions.length : 0 };
    });
  });
  app.get("/plans/:id/execution", async (req, reply) => withFamily(fam(req), async (c) => {
    const id = (req.params as any).id;
    if (!(await c.query("select 1 from plan_scenarios where id=$1 and deleted_at is null", [id])).rows[0]) return void reply.code(404).send({ title: "Not found", status: 404 });
    const actions = (await c.query("select a.*, t.status task_status, t.title task_title, t.verification task_verification from plan_actions a left join tasks t on t.id=a.task_id where a.scenario_id=$1 order by a.seq", [id])).rows.map(actionView);
    return { ...(await executionProgress(c, id)), actions };
  }));

  // ---------- tax position ----------
  app.get("/tax/projection", async (req) => withFamily(fam(req), async (c) => {
    const q = z.object({ fy: z.string().regex(/^\d{4}-\d{2}$/), entity_id: z.string().uuid().optional(), scenario_id: z.string().uuid().optional() }).parse(req.query);
    const base = await ensureBaseline(c, fam(req));
    const r = await runScenario(c, fam(req), q.scenario_id ?? base.id, { persist: false });
    return r.by_fy.filter((x) => x.fy === q.fy && (!q.entity_id || x.entity_id === q.entity_id));
  }));
  app.get("/tax/advance-tax", async (req) => withFamily(fam(req), async (c) => {
    const q = z.object({ fy: z.string().regex(/^\d{4}-\d{2}$/), entity_id: z.string().uuid().optional(), scenario_id: z.string().uuid().optional() }).parse(req.query);
    const base = await ensureBaseline(c, fam(req));
    const r = await runScenario(c, fam(req), q.scenario_id ?? base.id, { persist: false });
    const rows = r.by_fy.filter((x) => x.fy === q.fy && (!q.entity_id || x.entity_id === q.entity_id));
    const family = rows[0]?.advance_tax.map((_, i) => ({ due: rows[0].advance_tax[i].due, cumulative_pct: rows[0].advance_tax[i].cumulative_pct, amount: money(rows.reduce((t, x) => t + x.advance_tax[i].amount, 0)), paid: money(rows.reduce((t, x) => t + x.advance_tax[i].paid, 0)), shortfall: money(rows.reduce((t, x) => t + x.advance_tax[i].shortfall, 0)), interest: money(rows.reduce((t, x) => t + x.advance_tax[i].interest, 0)) })) ?? [];
    return { fy: q.fy, entities: rows.map((x) => ({ entity_id: x.entity_id, entity_name: x.entity_name, net_payable: money(x.net_payable), instalments: x.advance_tax.map((i) => ({ ...i, amount: money(i.amount), paid: money(i.paid), shortfall: money(i.shortfall), interest: money(i.interest) })), interest_234b: money(x.interest_234b), interest_234c: money(x.interest_234c) })), family, interest_234_total: money(rows.reduce((t, x) => t + x.interest_234, 0)) };
  }));
  app.get("/tax/regime-compare", async (req, reply) => withFamily(fam(req), async (c) => {
    const q = z.object({ fy: z.string().regex(/^\d{4}-\d{2}$/), entity_id: z.string().uuid(), scenario_id: z.string().uuid().optional() }).parse(req.query);
    const base = await ensureBaseline(c, fam(req));
    const sc = (await c.query("select * from plan_scenarios where id=$1", [q.scenario_id ?? base.id])).rows[0];
    const ent = (await c.query("select id, name, type from entities where id=$1", [q.entity_id])).rows[0]; if (!ent) return void reply.code(404).send({ title: "Entity not found", status: 404 });
    const { tables, cii } = await tablesProvider(c);
    const state = await loadState(c, new Date().toISOString().slice(0, 10), sc.entity_scope);
    const actions = (await c.query("select * from plan_actions where scenario_id=$1 order by seq", [sc.id])).rows.map((a) => ({ id: a.id, seq: a.seq, kind: a.kind, entityId: a.entity_id, targetType: a.target_type, targetId: a.target_id, params: a.params ?? {}, plannedDate: iso(a.planned_date)!, plannedAmount: a.planned_amount == null ? null : Number(a.planned_amount) }));
    const run = (regime: "old" | "new") => simulate(state, actions, { ...DEFAULT_ASSUMPTIONS, ...(sc.assumptions ?? {}), regime: { ...(sc.assumptions?.regime ?? {}), [q.entity_id]: regime } }, tables, { horizonFys: Number(sc.horizon_fys ?? 3), cii }).by_fy.find((x) => x.fy === q.fy && x.entity_id === q.entity_id);
    const o = run("old"), n = run("new");
    if (!o || !n) return void reply.code(422).send({ title: `No computation for ${ent.name} in FY ${q.fy} (check tax tables for entity type ${ent.type})`, status: 422 });
    const saving = Math.abs(o.tax.total - n.tax.total); const rec = o.tax.total < n.tax.total ? "old" : "new";
    return { entity_id: ent.id, entity_name: ent.name, fy: q.fy, current_regime: state.entities.find((e) => e.id === ent.id)?.regime, old: o, new: n, recommended: rec, saving: money(saving),
      notes: [rec === "old" ? `Old regime saves ₹${saving.toLocaleString("en-IN")}: deductions of ₹${o.deductions_total.toLocaleString("en-IN")} outweigh the wider new slabs` : `New regime saves ₹${saving.toLocaleString("en-IN")} with the deductions on file (₹${o.deductions_total.toLocaleString("en-IN")})`, ...o.notes.map((x) => `old: ${x}`), ...n.notes.map((x) => `new: ${x}`)],
      add_to_scenario: { kind: "change_tax_regime", entity_id: ent.id, target_type: "entity", target_id: ent.id, params: { regime: rec, fy: q.fy }, planned_date: `${Number(q.fy.slice(0, 4)) + 1}-03-31` } };
  }));

  // ---------- optimiser ----------
  app.get("/tax/suggestions", async (req) => withFamily(fam(req), async (c) => {
    const q = z.object({ scenario_id: z.string().uuid().optional(), entity_id: z.string().uuid().optional(), status: z.string().default("new") }).parse(req.query);
    return (await c.query(`select s.*, e.name as entity_name from tax_suggestions s left join entities e on e.id=s.entity_id where ($1::text = 'all' or s.status::text = $1) and ($2::uuid is null or s.scenario_id = $2) and ($3::uuid is null or s.entity_id = $3) order by s.est_saving desc nulls last, s.created_at desc`, [q.status, q.scenario_id ?? null, q.entity_id ?? null])).rows.map((s) => ({ ...s, est_saving: s.est_saving == null ? null : money(s.est_saving) }));
  }));
  app.post("/tax/suggestions", { preHandler: WRITERS }, async (req, reply) => {
    const b = z.object({ scenario_id: z.string().uuid().optional(), fy: z.string().optional() }).parse(req.body ?? {});
    return withFamily(fam(req), async (c) => { const r = await runOptimiser(c, fam(req), { scenarioId: b.scenario_id, fy: b.fy }); return void reply.code(202).send({ job_id: null, status: "done", ...r }); });
  });
  app.post("/tax/suggestions/:id/apply", { preHandler: WRITERS }, async (req, reply) => {
    const b = z.object({ scenario_id: z.string().uuid().optional() }).parse(req.body ?? {});
    return withFamily(fam(req), async (c) => {
      const sg = (await c.query("select * from tax_suggestions where id=$1", [(req.params as any).id])).rows[0];
      if (!sg) return void reply.code(404).send({ title: "Not found", status: 404 });
      let sc = b.scenario_id ? (await c.query("select * from plan_scenarios where id=$1 and deleted_at is null and status in ('draft','in_review') and not is_baseline", [b.scenario_id])).rows[0] : null;
      if (b.scenario_id && !sc) return void reply.code(409).send({ title: "Target scenario must be a draft or in review", status: 409 });
      if (!sc) sc = (await c.query("insert into plan_scenarios (family_id, name, description, created_by, assumptions) values ($1,$2,$3,$4,$5) returning *", [fam(req), `Optimiser: ${sg.title}`.slice(0, 120), sg.rationale, req.user!.id, JSON.stringify(DEFAULT_ASSUMPTIONS)])).rows[0];
      let seq = Number((await c.query("select coalesce(max(seq),0) n from plan_actions where scenario_id=$1", [sc.id])).rows[0].n);
      for (const a of sg.proposed_actions as any[]) {
        seq++;
        await c.query("insert into plan_actions (family_id, scenario_id, seq, kind, entity_id, target_type, target_id, params, planned_date, planned_amount, note) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
          [fam(req), sc.id, seq, a.kind, a.entity_id ?? sg.entity_id ?? null, a.target_type ?? (a.target_id ? "holding" : null), a.target_id ?? null, JSON.stringify(a.params ?? {}), a.planned_date ?? `${Number((sg.fy ?? fyOf(new Date().toISOString().slice(0, 10))).slice(0, 4)) + 1}-03-15`, a.planned_amount ?? null, `from optimiser: ${sg.code}`]);
      }
      await c.query("update tax_suggestions set status='added_to_plan' where id=$1", [sg.id]);
      await c.query("update plan_scenarios set version=version+1 where id=$1", [sc.id]);
      const out = (await c.query(`${SCENARIO_SQL} and p.id=$1`, [sc.id])).rows[0];
      return scenarioView(out);
    });
  });
  app.post("/tax/suggestions/:id/dismiss", { preHandler: WRITERS }, async (req, reply) => withFamily(fam(req), async (c) => {
    const r = await c.query("update tax_suggestions set status='dismissed' where id=$1 returning id", [(req.params as any).id]);
    if (!r.rows[0]) return void reply.code(404).send({ title: "Not found", status: 404 });
    return { id: r.rows[0].id, status: "dismissed" };
  }));

  // ---------- inputs the projection needs (income sources, advance tax, deductions) ----------
  app.get("/tax/inputs", async (req) => withFamily(fam(req), async (c) => ({
    income_sources: (await c.query("select s.*, e.name entity_name from entity_income_sources s join entities e on e.id=s.entity_id order by e.name, s.kind")).rows.map((r) => ({ ...r, annual_amount: money(r.annual_amount) })),
    advance_tax: (await c.query("select a.*, e.name entity_name from advance_tax_payments a join entities e on e.id=a.entity_id order by a.paid_on desc")).rows.map((r) => ({ ...r, paid_on: iso(r.paid_on), amount: money(r.amount) })),
    deductions: (await c.query("select d.*, e.name entity_name from entity_deductions d join entities e on e.id=d.entity_id order by d.fy desc, e.name, d.code")).rows.map((r) => ({ ...r, amount: money(r.amount) })),
  })));
  app.post("/tax/inputs/income", { preHandler: WRITERS }, async (req, reply) => {
    const b = z.object({ entity_id: z.string().uuid(), kind: z.enum(["salary", "fees", "business", "interest", "dividend", "other"]), label: z.string().min(1), annual_amount: z.union([z.number(), z.string()]), growth_pct: z.number().default(0), from_fy: z.string().optional(), to_fy: z.string().optional() }).parse(req.body);
    return withFamily(fam(req), async (c) => void reply.code(201).send((await c.query("insert into entity_income_sources (family_id, entity_id, kind, label, annual_amount, growth_pct, from_fy, to_fy) values ($1,$2,$3,$4,$5,$6,$7,$8) returning *", [fam(req), b.entity_id, b.kind, b.label, Number(b.annual_amount), b.growth_pct, b.from_fy ?? null, b.to_fy ?? null])).rows[0]));
  });
  app.post("/tax/inputs/advance-tax", { preHandler: WRITERS }, async (req, reply) => {
    const b = z.object({ entity_id: z.string().uuid(), fy: z.string().regex(/^\d{4}-\d{2}$/), paid_on: date, amount: z.union([z.number(), z.string()]), challan: z.string().optional(), bank_txn_id: z.string().uuid().optional() }).parse(req.body);
    return withFamily(fam(req), async (c) => void reply.code(201).send((await c.query("insert into advance_tax_payments (family_id, entity_id, fy, paid_on, amount, challan, bank_txn_id) values ($1,$2,$3,$4,$5,$6,$7) returning *", [fam(req), b.entity_id, b.fy, b.paid_on, Number(b.amount), b.challan ?? null, b.bank_txn_id ?? null])).rows[0]));
  });
  app.put("/tax/inputs/deductions", { preHandler: WRITERS }, async (req) => {
    const b = z.object({ entity_id: z.string().uuid(), fy: z.string().regex(/^\d{4}-\d{2}$/), code: z.string().min(2), amount: z.union([z.number(), z.string()]), note: z.string().optional() }).parse(req.body);
    return withFamily(fam(req), async (c) => (await c.query("insert into entity_deductions (family_id, entity_id, fy, code, amount, note) values ($1,$2,$3,$4,$5,$6) on conflict (entity_id, fy, code) do update set amount=excluded.amount, note=excluded.note returning *", [fam(req), b.entity_id, b.fy, b.code, Number(b.amount), b.note ?? null])).rows[0]);
  });
}

export function describeAction(a: any, entityName?: string) {
  const p = a.params ?? {}; const who = entityName ? ` (${entityName})` : "";
  const amt = a.planned_amount != null ? ` ₹${Number(a.planned_amount).toLocaleString("en-IN")}` : "";
  switch (a.kind) {
    case "sell_holding": return `Sell ${p.quantity ?? "all"} units${who}${amt}`;
    case "harvest_loss": return `Harvest loss: redeem ${p.quantity ?? "all"} units${who}`;
    case "book_gain_within_exemption": return `Book LTCG within exemption${p.quantity ? ` (${p.quantity} units)` : ""}${who}`;
    case "defer_sale_to_fy": return `Sell ${p.quantity ?? "all"} units in FY ${p.fy}${who}`;
    case "redeem_before_date": return `Redeem before ${a.planned_date}${who}`;
    case "buy_instrument": return `Buy${amt}${p.note ? ` — ${p.note}` : ""}${who}`;
    case "deploy_cash": return `Deploy cash${amt}${who}`;
    case "switch": return `Switch ${p.quantity ?? "all"} units${who}`;
    case "transfer_to_entity": return `Transfer${amt || (p.monthly ? ` ₹${Number(p.monthly).toLocaleString("en-IN")}/month` : "")}${who}`;
    case "change_tax_regime": return `Opt for the ${p.regime} regime${p.fy ? ` for FY ${p.fy}` : ""}${who}`;
    case "sell_property": return `Sell property${amt}${who}`;
    case "reinvest_54ec": return `Invest${amt} in ${p.issuer ?? "54EC"} capital-gain bonds${who}`;
    case "reinvest_54f": return `Reinvest${amt} in a residential house (54F)${who}`;
    case "prepay_loan": return `Prepay loan${amt}${who}`;
    case "exit_private": return `Exit private investment${amt}${who}`;
    case "donate_80g": return `Donate${amt} (80G)${who}`;
    case "contribute_nps": return `Contribute${amt} to NPS (80CCD(1B))${who}`;
    case "contribute_ppf": return `Contribute${amt} to PPF (80C)${who}`;
    case "change_rent": return `${/vacate|do not renew/i.test(String(p.note)) || p.vacate ? "Do not renew lease; vacate" : `Revise rent to ₹${Number(p.new_rent ?? 0).toLocaleString("en-IN")}`}${who}`;
    default: return `${p.note ?? a.kind}${amt}${who}`;
  }
}
