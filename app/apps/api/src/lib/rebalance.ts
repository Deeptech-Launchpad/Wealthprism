// Rebalancing & liquidity timing (FO-160..165): needs gatherer, lot constraints, snapshot, runs and plans, conversion to
// scheduled intents, reconciliation from imports, calendar. Everything inside the caller's family transaction.
import type pg from "pg";
import { solve, evaluateTriggers, nextCalendarRun, lotConstraintsFor, allocClassOf, requiredFloat, fyOf, addDays, type RbSnapshot, type RbPlan, type RbMove, type Objective, type Fired, type AllocClass } from "@fo/finance";
import { loadState, tablesProvider } from "./planning.js";
import { effectiveFor, governingPolicy, evaluatePolicy } from "./policy.js";
import { notifyTask } from "./notify.js";

export const iso = (d: any) => (d ? new Date(d).toISOString().slice(0, 10) : null);
const r2 = (n: number) => Math.round(n * 100) / 100 + 0;
const today = () => new Date().toISOString().slice(0, 10);
export class RebalanceError extends Error { constructor(public status: number, message: string, public extra?: unknown) { super(message); } }
const NEED_KIND: Record<string, { kind: string; priority: number; flex: number }> = { advance_tax: { kind: "tax_instalment", priority: 1, flex: 0 }, gst: { kind: "tax_instalment", priority: 1, flex: 0 }, property_tax: { kind: "tax_instalment", priority: 1, flex: 15 }, drawdown: { kind: "capital_call", priority: 1, flex: 0 }, card_due: { kind: "planned_expense", priority: 2, flex: 0 }, emi: { kind: "liability_payment", priority: 1, flex: 0 }, manual: { kind: "planned_expense", priority: 2, flex: 7 } };

// ---------- funding needs (FO-161) ----------
/** Upsert auto-gathered needs by source; manual needs are left alone. Status follows funded_amount and the date. */
export async function gatherNeeds(c: pg.PoolClient, familyId: string, day = today(), horizonDays = 1100) {
  const until = addDays(day, horizonDays); const defaultEntity = (await c.query("select id from entities where deleted_at is null order by (type = 'individual') desc, created_at, id limit 1")).rows[0]?.id; // family-level outflows sit with the principal
  const upsert = async (n: { entity_id: string; goal_id?: string | null; kind: string; label: string; need_date: string; amount: number; flexibility_days: number; source_type: string; source_id: string; priority: number }) => {
    const ex = (await c.query("select id, status, funded_amount from funding_needs where family_id=$1 and source_type=$2 and source_id=$3 and need_date=$4", [familyId, n.source_type, n.source_id, n.need_date])).rows[0];
    if (ex) { if (!["met", "cancelled"].includes(ex.status)) await c.query("update funding_needs set amount=$2, label=$3, updated_at=now() where id=$1", [ex.id, n.amount, n.label]); return ex.id; }
    return (await c.query("insert into funding_needs (family_id, entity_id, goal_id, kind, label, need_date, amount, flexibility_days, source_type, source_id, priority) values ($1,$2,$3,$4::need_kind,$5,$6,$7,$8,$9,$10,$11) returning id", [familyId, n.entity_id, n.goal_id ?? null, n.kind, n.label, n.need_date, n.amount, n.flexibility_days, n.source_type, n.source_id, n.priority])).rows[0].id;
  };
  let n = 0;
  // Routine dated outflows — EMIs, interest and insurance premiums — are working-capital items: the balance-sheet nightly writes them into committed_outflows,
  // the float provides for them, and the float-rebuild need below funds any shortfall. Rebalancing funds the lumpy needs beyond the float, so they are not needs twice.
  await c.query("delete from funding_needs where family_id=$1 and source_type in ('liability_schedule','insurance_policy') and status not in ('met','cancelled')", [familyId]);
  for (const o of (await c.query("select * from committed_outflows where status='pending' and due_date between $1 and $2 and kind <> 'sip' and coalesce(source_type,'') not in ('liability_schedule','insurance_policy')", [day, until])).rows) { const k = NEED_KIND[o.kind] ?? NEED_KIND.manual; await upsert({ entity_id: o.entity_id ?? defaultEntity, kind: k.kind, label: o.label, need_date: iso(o.due_date)!, amount: Number(o.amount), flexibility_days: k.flex, source_type: "committed_outflow", source_id: o.id, priority: k.priority }); n++; }
  for (const f of (await c.query("select fc.*, pi.entity_id, co.name from fund_commitments fc join private_investments pi on pi.id=fc.private_investment_id join private_companies co on co.id=pi.company_id where pi.family_id=$1", [familyId])).rows)
    for (const s of (f.schedule ?? []) as { due: string; amount: number }[]) { if (s.due < day || s.due > until) continue; // a drawdown already tracked as a committed outflow on the same date is one need, not two
      if ((await c.query("select 1 from funding_needs where family_id=$1 and kind='capital_call' and entity_id=$2 and need_date=$3 and source_type='committed_outflow'", [familyId, f.entity_id, s.due])).rowCount) continue;
      await upsert({ entity_id: f.entity_id, kind: "capital_call", label: `${f.name} drawdown`, need_date: s.due, amount: Number(s.amount), flexibility_days: 0, source_type: "fund_commitment", source_id: f.id, priority: 1 }); n++; }
  for (const g of (await c.query("select * from goals where family_id=$1 and status='active' and target_year <= $2", [familyId, Number(day.slice(0, 4)) + 3])).rows) { const years = Number(g.target_year) - Number(day.slice(0, 4)); if (years < 0) continue; const amt = r2(Number(g.amount_today) * Math.pow(1 + Number(g.inflation_pct ?? 6) / 100, Math.max(0, years))); const date = `${g.target_year}-06-01`; if (date < day) continue;
    await upsert({ entity_id: g.entity_id, goal_id: g.id, kind: "goal_drawdown", label: `${g.name} — drawdown`, need_date: date, amount: amt, flexibility_days: 30, source_type: "goal", source_id: g.id, priority: 2 }); n++; }
  // float rebuild: cash below the working-capital float
  const wc = await floatFor(c, familyId, day); if (wc.cash < wc.floatRequired - 1) { await upsert({ entity_id: defaultEntity, kind: "buffer_rebuild", label: "Rebuild working-capital float", need_date: addDays(day, 30), amount: r2(wc.floatRequired - wc.cash), flexibility_days: 30, source_type: "wc_float", source_id: familyId, priority: 3 }); n++; }
  await refreshNeedStatus(c, familyId, day);
  return { rows: n, note: `${n} needs gathered` };
}
export async function refreshNeedStatus(c: pg.PoolClient, familyId: string, day = today()) {
  await c.query(`update funding_needs set status = case when status in ('met','cancelled') then status when funded_amount >= amount and need_date <= $2 then 'met' when funded_amount >= amount then 'funded' when funded_amount > 0 then 'partially_funded' when need_date <= $2 then 'due' else 'planned' end::need_status, updated_at=now() where family_id=$1 and status <> 'cancelled'`, [familyId, day]);
}
export async function floatFor(c: pg.PoolClient, familyId: string, day = today()) {
  const s = (await c.query("select float_days, buffer_months from wc_settings where family_id=$1", [familyId])).rows[0] ?? { float_days: 60, buffer_months: 1 };
  const accounts = (await c.query("select id, entity_id, balance from bank_accounts where family_id=$1 and deleted_at is null and type in ('savings','current')", [familyId])).rows;
  const cash = accounts.reduce((x, a) => x + Number(a.balance), 0);
  const outflows = (await c.query("select due_date, amount from committed_outflows where family_id=$1 and status='pending' and due_date >= $2", [familyId, day])).rows.map((o) => ({ dueDate: iso(o.due_date)!, amount: Number(o.amount) }));
  const avg = Number((await c.query("select coalesce(avg(m),0) v from (select date_trunc('month', txn_date) mo, sum(-amount) m from bank_txns where family_id=$1 and amount < 0 and txn_date >= $2::date - 180 group by 1) x", [familyId, day])).rows[0].v);
  return { cash: r2(cash), floatRequired: requiredFloat({ cash, outflows, floatDays: Number(s.float_days), avgMonthlyOutflow: avg, bufferMonths: Number(s.buffer_months), asOf: day }), accounts: accounts.map((a) => ({ accountId: a.id, entityId: a.entity_id, balance: Number(a.balance) })) };
}
/** Coverage view for a need: recorded coverage rows plus cash available today. */
export async function needsView(c: pg.PoolClient, familyId: string, opts: { entityId?: string | null; days?: number; status?: string | null; day?: string } = {}) {
  const day = opts.day ?? today(); const until = addDays(day, opts.days ?? 1100);
  const rows = (await c.query(`select n.*, e.name entity_name, g.name goal_name, coalesce((select json_agg(json_build_object('source', case when nc.move_id is not null then 'move' else 'cash' end, 'move_id', nc.move_id, 'bank_account_id', nc.bank_account_id, 'amount', nc.amount, 'available_on', nc.available_on, 'what', m.what, 'status', m.status)) from need_coverage nc left join rebalance_moves m on m.id=nc.move_id where nc.need_id=n.id), '[]') coverage
    from funding_needs n join entities e on e.id=n.entity_id left join goals g on g.id=n.goal_id where n.family_id=$1 and n.need_date <= $2 and ($3::uuid is null or n.entity_id=$3) and ($4::text is null or n.status::text=$4) and n.status <> 'cancelled' order by n.need_date, n.priority`, [familyId, until, opts.entityId ?? null, opts.status ?? null])).rows;
  return rows.map((n) => { const cov = (n.coverage as any[]).reduce((x, k) => x + Number(k.amount), 0); return { ...n, need_date: iso(n.need_date), amount: Number(n.amount), funded_amount: Number(n.funded_amount), coverage: n.coverage, covered_planned: r2(cov), shortfall: r2(Math.max(0, Number(n.amount) - Number(n.funded_amount) - cov)) }; });
}

// ---------- lot constraints (FO-162) ----------
export async function computeLotConstraints(c: pg.PoolClient, familyId: string, day = today()) {
  const { tables } = await tablesProvider(c); const rules = tables(fyOf(day), "new", "individual").rules;
  const lots = (await c.query("select l.id, l.buy_date, i.type, i.asset_class, i.name, i.meta, a.liquidity_class from lots l join holdings h on h.id=l.holding_id join instruments i on i.id=h.instrument_id left join lateral (select liquidity_class from instrument_attributes x where x.instrument_id=i.id order by as_of desc limit 1) a on true where l.family_id=$1 and l.remaining_qty > 0", [familyId])).rows;
  let n = 0;
  for (const l of lots) { const k = lotConstraintsFor({ buyDate: iso(l.buy_date)!, instrumentType: l.type, assetClass: l.asset_class, name: l.name, meta: l.meta, liquidityClass: l.liquidity_class }, rules, day);
    await c.query(`insert into lot_constraints (lot_id, family_id, lock_in_until, exit_load_until, exit_load_pct, ltcg_eligible_on, settlement_days, liquidity_class, matures_on, computed_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,now())
      on conflict (lot_id) do update set lock_in_until=excluded.lock_in_until, exit_load_until=excluded.exit_load_until, exit_load_pct=excluded.exit_load_pct, ltcg_eligible_on=excluded.ltcg_eligible_on, settlement_days=excluded.settlement_days, liquidity_class=excluded.liquidity_class, matures_on=excluded.matures_on, computed_at=now() where lot_constraints.manual = false`, [l.id, familyId, k.lock_in_until, k.exit_load_until, k.exit_load_pct, k.ltcg_eligible_on, k.settlement_days, k.liquidity_class, k.matures_on]); n++; }
  return { rows: n, note: `${n} lots` };
}

// ---------- snapshot ----------
export interface ProgramRow { id: string; family_id: string; scope: "family" | "entity" | "goal"; entity_id: string | null; goal_id: string | null; policy_id: string | null; name: string; calendar_rrule: string | null; band_trigger: boolean; drift_threshold_pp: number | null; milestone_triggers: any[]; need_lookahead_days: number; large_flow_pct: number | null; tax_year_end: boolean; constraints: Record<string, any>; auto_draft: boolean; auto_convert_low_risk: boolean; active: boolean }
export async function buildSnapshot(c: pg.PoolClient, familyId: string, p: ProgramRow, day = today()): Promise<RbSnapshot & { policy_version_id: string | null; policy_name: string | null; goal: any | null }> {
  await computeLotConstraints(c, familyId, day).catch(() => null);
  const state = await loadState(c, day, p.entity_id ? [p.entity_id] : null);
  const goal = p.goal_id ? state.goals.find((g) => g.id === p.goal_id) ?? null : null;
  const policy = p.policy_id ? (await c.query("select * from investment_policies where id=$1 and deleted_at is null", [p.policy_id])).rows[0] : await governingPolicy(c, p.entity_id, p.goal_id);
  const eff = policy?.current_version_id ? await effectiveFor(c, policy) : null;
  const targets = (eff?.clauses.allocations ?? []).filter((a) => a.lens === "asset_class").map((a) => ({ key: a.key as AllocClass, target: a.target_pct, min: a.min_pct ?? null, max: a.max_pct ?? null }));
  const ids = [...new Set(state.holdings.map((h) => h.instrumentId))];
  const inst = new Map((await c.query("select id, type, name, meta from instruments where id = any($1)", [ids])).rows.map((i) => [i.id, i]));
  const lc = new Map((await c.query("select * from lot_constraints where family_id=$1", [familyId])).rows.map((r) => [r.lot_id, r]));
  const holdings: RbSnapshot["holdings"] = (goal ? state.holdings.filter((h) => goal.linkedHoldingIds.includes(h.id)) : state.holdings).map((h) => { const i = inst.get(h.instrumentId) ?? {}; const cls = allocClassOf(h.assetClass, i.type, i.meta?.sub_class ?? h.name);
    const lots = (h.lots.length ? h.lots.map((l) => ({ l, k: lc.get(l.id) })) : [{ l: { id: `virtual:${h.id}`, buyDate: day, quantity: h.quantity ?? 0, remainingQty: h.quantity ?? 0, unitCost: h.price, charges: 0 }, k: null as any }])
      .map(({ l, k }) => ({ id: l.id, buyDate: l.buyDate, qty: l.remainingQty, unitCost: l.unitCost, lockInUntil: iso(k?.lock_in_until) ?? (i.type === "aif" || i.type === "pms" ? addDays(day, 3650) : null), exitLoadUntil: iso(k?.exit_load_until), exitLoadPct: k?.exit_load_pct == null ? null : Number(k.exit_load_pct), ltcgEligibleOn: iso(k?.ltcg_eligible_on), settlementDays: Number(k?.settlement_days ?? (i.type === "stock" ? 1 : 3)) }));
    return { id: h.id, entityId: h.entityId, instrumentId: h.instrumentId, name: h.name, allocClass: cls, bucket: h.bucket, price: h.price, assetClass: h.assetClass, instrumentType: i.type ?? "mf", lots, maturesOn: iso([...lc.values()].find((k) => h.lots.some((l) => l.id === k.lot_id))?.matures_on) ?? i.meta?.maturity_date ?? null, liquidityClass: null as string | null }; });
  // private rounds and fund units sit in the allocation as an untradeable alternatives sleeve (one locked virtual lot each)
  for (const pr of goal ? state.privates.filter((x) => goal.linkedPrivateIds.includes(x.id)) : state.privates) if (pr.mark > 0) holdings.push({ id: pr.id, entityId: pr.entityId, instrumentId: pr.id, name: pr.name, allocClass: "alternatives", bucket: pr.bucket, price: pr.mark, assetClass: "unlisted_equity", instrumentType: "private", lots: [{ id: `private:${pr.id}`, buyDate: pr.investedOn, qty: 1, unitCost: pr.cost, lockInUntil: "2099-12-31", settlementDays: 90 }], maturesOn: null, liquidityClass: "locked" });
  const wc = await floatFor(c, familyId, day); const cash = goal ? [] : wc.accounts.filter((a) => !p.entity_id || a.entityId === p.entity_id);
  const needs = (await c.query("select * from funding_needs where family_id=$1 and status in ('planned','partially_funded','due') and need_date between $2 and $3 and ($4::uuid is null or entity_id=$4) and ($5::uuid is null or goal_id=$5) order by priority, need_date", [familyId, addDays(day, -30), addDays(day, p.need_lookahead_days), p.entity_id, p.goal_id])).rows
    .map((n) => ({ id: n.id, label: n.label, date: iso(n.need_date)!, amount: Number(n.amount), priority: Number(n.priority) as 1 | 2 | 3, flexibilityDays: Number(n.flexibility_days), entityId: n.entity_id, fundedAmount: Number(n.funded_amount), bankAccountId: n.bank_account_id }));
  const { tables } = await tablesProvider(c); const fy = fyOf(day); const rules = tables(fy, "new", "individual").rules;
  const ents = (await c.query("select id, slab_rate from entities where deleted_at is null")).rows; const eqRule = rules.find((r) => r.assetClass === "equity" && r.term === "long");
  const used = (await c.query("select entity_id, coalesce(sum(exemption_used),0) u from realized_gains where family_id=$1 and fy=$2 group by entity_id", [familyId, fy])).rows;
  const exemptionRemaining = Object.fromEntries(ents.map((e) => [e.id, Math.max(0, Number(eqRule?.exemptionAmount ?? 0) - Number(used.find((u) => u.entity_id === e.id)?.u ?? 0))]));
  const contributions = goal ? [] : (await c.query("select id, label, amount, entity_id from committed_outflows where family_id=$1 and kind='sip' and status='pending' and ($2::uuid is null or entity_id=$2)", [familyId, p.entity_id])).rows.map((s) => ({ label: s.label, monthly: Number(s.amount), allocClass: "equity" as AllocClass, entityId: s.entity_id ?? ents[0]?.id }));
  const glide = goal ? (await c.query("select steps from glide_paths where goal_id=$1 order by policy_version_id nulls last limit 1", [goal.id])).rows[0]?.steps as any[] | undefined : undefined;
  const year = Number(day.slice(0, 4)); const glideGrowthPct = glide?.length ? (() => { const st = glide.map((s) => ({ y: Number(s.year), p: Number(s.growth_pct ?? s.equity_pct) })).sort((a, b) => a.y - b.y); if (year <= st[0].y) return st[0].p; if (year >= st[st.length - 1].y) return st[st.length - 1].p; for (let i = 1; i < st.length; i++) if (year <= st[i].y) return r2(st[i - 1].p + (st[i].p - st[i - 1].p) * (year - st[i - 1].y) / (st[i].y - st[i - 1].y)); return null; })() : null;
  // default instrument per class: the most liquid one the family already holds, else the system suggestion
  const buyInstrument: RbSnapshot["buyInstrument"] = {};
  for (const h of holdings) if (!buyInstrument[h.allocClass] || (h.instrumentType === "mf" && buyInstrument[h.allocClass]!.settlementDays > 1)) buyInstrument[h.allocClass] = { id: h.instrumentId, name: h.name, settlementDays: Math.min(...h.lots.map((l) => l.settlementDays)) };
  for (const d of (await c.query("select id, name, type, asset_class from instruments where amfi_code is not null or type in ('etf','gsec','tbill') order by name")).rows) { const cls = allocClassOf(d.asset_class, d.type, d.name); if (!buyInstrument[cls]) buyInstrument[cls] = { id: d.id, name: d.name, settlementDays: 1 }; }
  return { asOf: day, holdings, cash, floatRequired: goal ? 0 : wc.floatRequired, needs, targets, glideGrowthPct, contributions, rules, slabRate: Object.fromEntries(ents.map((e) => [e.id, Number(e.slab_rate ?? 30)])), exemptionRemaining, fyEnd: `${Number(fy.slice(0, 4)) + 1}-03-31`, buyInstrument, policy_version_id: policy?.current_version_id ?? null, policy_name: policy?.name ?? null, goal };
}

// ---------- runs and plans (FO-160, FO-163, FO-164) ----------
export async function persistPlan(c: pg.PoolClient, familyId: string, runId: string, plan: RbPlan, version: number, snap: RbSnapshot) {
  const p = (await c.query("insert into rebalance_plans (family_id, run_id, version, status, objective, allocation_after, summary, warnings, coverage, cash_timeline) values ($1,$2,$3,'draft',$4,$5,$6,$7,$8,$9) returning id", [familyId, runId, version, plan.objective, JSON.stringify(plan.allocationAfter), JSON.stringify(plan.summary), JSON.stringify(plan.warnings), JSON.stringify(plan.coverage), JSON.stringify(plan.cashTimeline)])).rows[0];
  const ids = new Map<number, string>();
  for (const m of plan.moves) {
    const lotIds = (m.fromLotIds ?? []).filter((x) => !x.startsWith("virtual:") && !x.startsWith("private:"));
    const r = (await c.query(`insert into rebalance_moves (family_id, plan_id, seq, kind, entity_id, from_holding_id, from_lot_ids, to_instrument_id, to_bank_account_id, to_alloc_class, quantity, amount, planned_date, earliest_date, latest_date, settles_on, reason, need_id, est_gain, est_tax, est_cost, exit_load, constraints_checked, depends_on_move_id, what)
      values ($1,$2,$3,$4::move_kind,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25) returning id`,
      [familyId, p.id, m.seq, m.kind, m.entityId, m.fromHoldingId ?? null, lotIds.length ? lotIds : null, m.toInstrumentId ?? null, m.toBankAccountId ?? null, m.toAllocClass ?? null, m.quantity ?? null, m.amount, m.plannedDate, m.earliestDate, m.latestDate, m.settlesOn, m.reason, m.needId ?? null, m.estGain, m.estTax, m.estCost, m.exitLoad, JSON.stringify(m.constraintsChecked), m.dependsOnSeq != null ? ids.get(m.dependsOnSeq) ?? null : null, m.what])).rows[0];
    ids.set(m.seq, r.id);
  }
  for (const cv of plan.coverage) for (const s of cv.sources) {
    if (s.kind === "move" || s.kind === "maturity") { const mid = s.kind === "move" ? ids.get(Number(s.ref)) : null; if (!mid) continue; await c.query("insert into need_coverage (need_id, move_id, amount, available_on) values ($1,$2,$3,$4) on conflict do nothing", [cv.needId, mid, s.amount, s.availableOn]); }
    else { const acct = snap.cash.find((k) => k.accountId === s.ref)?.accountId ?? snap.cash[0]?.accountId; if (acct) await c.query("insert into need_coverage (need_id, bank_account_id, amount, available_on) values ($1,$2,$3,$4) on conflict (need_id, coverage_key) do update set amount=excluded.amount", [cv.needId, acct, s.amount, s.availableOn]); }
  }
  return p.id as string;
}
export async function runProgram(c: pg.PoolClient, familyId: string, programId: string, opts: { triggeredBy?: string; detail?: Record<string, any>; objective?: Objective; day?: string; taxYearEnd?: boolean; note?: string } = {}) {
  const p = (await c.query("select * from rebalance_programs where id=$1", [programId])).rows[0] as ProgramRow; if (!p) throw new RebalanceError(404, "Program not found");
  const day = opts.day ?? today(); const snap = await buildSnapshot(c, familyId, p, day);
  const objective = opts.objective ?? "needs_plus_bands";
  const plan = solve(snap, objective, p.constraints ?? {}, { taxYearEnd: opts.taxYearEnd ?? opts.triggeredBy === "tax_year_end" });
  const drift = { max_pp: plan.summary.drift_before_max_pp, classes: plan.allocationAfter.map((a) => ({ key: a.key, before: a.before_pct, target: a.target, min: a.min, max: a.max })) };
  const snapshot = { total: plan.summary.total, idle_cash: plan.summary.idle_cash, float_required: snap.floatRequired, needs_in_window: snap.needs.map((n) => ({ id: n.id, label: n.label, date: n.date, amount: n.amount })), policy_version_id: snap.policy_version_id, policy: snap.policy_name, holdings: snap.holdings.length, as_of: day };
  const noAction = plan.moves.length === 0;
  const run = (await c.query("insert into rebalance_runs (family_id, program_id, triggered_by, trigger_detail, run_at, snapshot, drift, status, objective, note) values ($1,$2,$3::rebalance_trigger,$4,now(),$5,$6,$7::rebalance_run_status,$8,$9) returning *", [familyId, programId, opts.triggeredBy ?? "manual", JSON.stringify(opts.detail ?? {}), JSON.stringify(snapshot), JSON.stringify(drift), noAction ? "no_action" : "plan_drafted", objective, opts.note ?? (noAction ? `no action: ${plan.warnings.join("; ") || `max drift ${plan.summary.drift_before_max_pp} pp, needs covered by cash`}` : null)])).rows[0];
  let planId: string | null = null;
  if (!noAction) { planId = await persistPlan(c, familyId, run.id, plan, 1, snap); await c.query("update rebalance_runs set plan_id=$2 where id=$1", [run.id, planId]);
    if (plan.summary.needs_uncovered > 0) { const t = (await c.query("insert into tasks (family_id, entity_id, module, title, reason, severity, source_type, source_id, verification) select $1,$2,'rebalance',$3,$4,1,'rebalance_run',$5,'na' where not exists (select 1 from tasks where source_type='rebalance_run' and source_id=$5 and status='open') returning *", [familyId, p.entity_id, `Funding gap: ${p.name}`, plan.warnings.filter((w) => /uncovered/.test(w)).join("; ").slice(0, 900), run.id])).rows[0]; if (t) await notifyTask(c, t); } }
  return { run: { ...run, run_at: run.run_at, plan_id: planId }, plan, plan_id: planId, snapshot: snap };
}
/** Nightly: evaluate every active program's triggers and run the first one that fires (one open plan per program at a time). */
export async function evaluatePrograms(c: pg.PoolClient, familyId: string, day = today()) {
  await gatherNeeds(c, familyId, day).catch(() => null);
  const programs = (await c.query("select * from rebalance_programs where family_id=$1 and active order by scope, name", [familyId])).rows as ProgramRow[];
  const out: any[] = [];
  for (const p of programs) {
    const open = (await c.query("select 1 from rebalance_runs r join rebalance_plans pl on pl.id=r.plan_id where r.program_id=$1 and pl.status in ('draft','in_review','approved')", [p.id])).rowCount; if (open) { out.push({ program: p.name, skipped: "open plan" }); continue; }
    const snap = await buildSnapshot(c, familyId, p, day);
    const last = (await c.query("select run_at, triggered_by, trigger_detail from rebalance_runs where program_id=$1 order by run_at desc limit 1", [p.id])).rows[0];
    const fired = (await c.query("select trigger_detail->>'milestone' m from rebalance_runs where program_id=$1 and triggered_by in ('milestone','glide_step')", [p.id])).rows.map((r) => r.m).filter(Boolean);
    const lastTye = (await c.query("select trigger_detail->>'fy' fy from rebalance_runs where program_id=$1 and triggered_by='tax_year_end' order by run_at desc limit 1", [p.id])).rows[0]?.fy ?? null;
    const policyChanged = snap.policy_version_id ? (await c.query("select approved_at from policy_versions where id=$1", [snap.policy_version_id])).rows[0]?.approved_at : null;
    const flow = Number((await c.query("select coalesce(sum(case when type in ('buy','sip','switch_in','capital_call') then amount when type in ('sell','redemption','switch_out','distribution') then -amount else 0 end),0) f from investment_txns where family_id=$1 and txn_date >= $2::date - 7 and ($3::uuid is null or entity_id=$3)", [familyId, day, p.entity_id])).rows[0].f);
    const goalCtx = snap.goal ? { targetYear: snap.goal.targetYear, fundedPct: (await c.query("select funded_pct from goals where id=$1", [snap.goal.id])).rows[0]?.funded_pct ?? null, glideStepYears: ((await c.query("select steps from glide_paths where goal_id=$1 limit 1", [snap.goal.id])).rows[0]?.steps ?? []).map((s: any) => Number(s.year)) } : null;
    const triggers = evaluateTriggers(p, snap, { today: day, lastRunAt: last ? new Date(last.run_at).toISOString() : null, lastTaxYearEndRunFy: lastTye, goal: goalCtx ? { ...goalCtx, fundedPct: goalCtx.fundedPct == null ? null : Number(goalCtx.fundedPct) } : null, flowPct: plan_total(snap) ? r2(flow / plan_total(snap) * 100) : 0, policyChangedAt: policyChanged ? new Date(policyChanged).toISOString() : null, firedMilestones: fired });
    if (!triggers.length) { out.push({ program: p.name, fired: [] }); continue; }
    const order = ["funding_need", "band_breach", "milestone", "glide_step", "policy_change", "tax_year_end", "large_flow", "drift_threshold", "calendar"]; triggers.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
    const first = triggers[0]; const detail = { ...first.detail, also: triggers.slice(1).map((t) => t.kind) };
    const r = await runProgram(c, familyId, p.id, { triggeredBy: first.kind, detail, objective: first.objective, day, taxYearEnd: triggers.some((t) => t.kind === "tax_year_end") });
    out.push({ program: p.name, fired: triggers.map((t) => t.kind), run_id: r.run.id, status: r.run.status, moves: r.plan.moves.length });
  }
  return { rows: out.filter((o) => o.run_id).length, note: out.map((o) => `${o.program}: ${o.skipped ?? (o.fired.length ? `${o.fired.join("+")} → ${o.status}` : "quiet")}`).join(" | "), programs: out };
}
const plan_total = (s: RbSnapshot) => s.holdings.reduce((x, h) => x + h.lots.reduce((y, l) => y + l.qty, 0) * h.price, 0) + s.cash.reduce((x, k) => x + k.balance, 0);

export async function planView(c: pg.PoolClient, planId: string) {
  const p = (await c.query("select pl.*, r.program_id, r.triggered_by, r.trigger_detail, r.run_at, r.snapshot, pr.name program_name, pr.scope, u.name approved_by_name from rebalance_plans pl join rebalance_runs r on r.id=pl.run_id join rebalance_programs pr on pr.id=r.program_id left join users u on u.id=pl.approved_by where pl.id=$1", [planId])).rows[0]; if (!p) throw new RebalanceError(404, "Plan not found");
  const moves = (await c.query("select m.*, e.name entity_name, i.name to_instrument_name, h.instrument_id from_instrument_id, hi.name from_holding_name, n.label need_label, n.need_date, ai.status intent_status from rebalance_moves m join entities e on e.id=m.entity_id left join instruments i on i.id=m.to_instrument_id left join holdings h on h.id=m.from_holding_id left join instruments hi on hi.id=h.instrument_id left join funding_needs n on n.id=m.need_id left join action_intents ai on ai.id=m.intent_id where m.plan_id=$1 order by m.seq", [planId])).rows
    .map((m) => ({ ...m, amount: Number(m.amount), quantity: m.quantity == null ? null : Number(m.quantity), est_gain: Number(m.est_gain ?? 0), est_tax: Number(m.est_tax ?? 0), est_cost: Number(m.est_cost ?? 0), exit_load: Number(m.exit_load ?? 0), planned_date: iso(m.planned_date), earliest_date: iso(m.earliest_date), latest_date: iso(m.latest_date), settles_on: iso(m.settles_on), need_date: iso(m.need_date), executed_on: iso(m.executed_on) }));
  const versions = (await c.query("select id, version, status, created_at from rebalance_plans where run_id=$1 order by version", [p.run_id])).rows;
  return { ...p, moves, versions, executed: moves.filter((m) => m.status === "executed").length };
}
/** Edit a draft: exclude moves, change dates, change the objective → re-solve into a new version; the old one is superseded. */
export async function revisePlan(c: pg.PoolClient, familyId: string, planId: string, edits: { objective?: Objective; exclude_move_ids?: string[]; moves?: { id: string; planned_date?: string; amount?: number }[] }) {
  const p = (await c.query("select pl.*, r.program_id, r.triggered_by from rebalance_plans pl join rebalance_runs r on r.id=pl.run_id where pl.id=$1", [planId])).rows[0]; if (!p) throw new RebalanceError(404, "Plan not found");
  if (!["draft", "in_review"].includes(p.status)) throw new RebalanceError(409, `A ${p.status} plan cannot be edited — start a new run`);
  const program = (await c.query("select * from rebalance_programs where id=$1", [p.program_id])).rows[0] as ProgramRow;
  const old = (await c.query("select * from rebalance_moves where plan_id=$1", [planId])).rows;
  const excluded = old.filter((m) => (edits.exclude_move_ids ?? []).includes(m.id));
  const snap = await buildSnapshot(c, familyId, program, iso(p.created_at)! < today() ? today() : today());
  const excludeHoldingIds = excluded.filter((m) => m.from_holding_id).map((m) => m.from_holding_id); const excludeNeedIds = excluded.filter((m) => m.kind === "hold_cash" && m.need_id).map((m) => m.need_id);
  const dateOverrides: Record<string, string> = {}; for (const e of edits.moves ?? []) { const m = old.find((x) => x.id === e.id); if (m && e.planned_date) dateOverrides[String(m.seq)] = e.planned_date; }
  const constraints = { ...(program.constraints ?? {}), ...(excluded.some((m) => m.kind === "sip_change") ? { prefer_new_cash: false } : {}) }; // dropping the SIP redirect means selling instead
  const plan = solve(snap, edits.objective ?? p.objective, constraints, { taxYearEnd: p.triggered_by === "tax_year_end", excludeHoldingIds, excludeNeedIds, dateOverrides });
  await c.query("update rebalance_plans set status='superseded' where id=$1", [planId]);
  await c.query("delete from need_coverage where move_id in (select id from rebalance_moves where plan_id=$1)", [planId]);
  const newId = await persistPlan(c, familyId, p.run_id, plan, Number(p.version) + 1, snap);
  await c.query("update rebalance_runs set plan_id=$2 where id=$1", [p.run_id, newId]);
  return newId;
}
/** Simulate: allocation after and policy compliance after the plan (the planner's tax view is the per-move estimate). */
export async function simulatePlan(c: pg.PoolClient, familyId: string, planId: string) {
  const p = (await c.query("select pl.*, r.program_id from rebalance_plans pl join rebalance_runs r on r.id=pl.run_id where pl.id=$1", [planId])).rows[0]; if (!p) throw new RebalanceError(404, "Plan not found");
  const program = (await c.query("select * from rebalance_programs where id=$1", [p.program_id])).rows[0] as ProgramRow;
  const policy = program.policy_id ? (await c.query("select * from investment_policies where id=$1", [program.policy_id])).rows[0] : await governingPolicy(c, program.entity_id, program.goal_id);
  const before = policy?.current_version_id ? await evaluatePolicy(c, familyId, policy.id, { persist: false }) : null;
  const after = (p.allocation_after as any[]).map((a) => ({ key: a.key, target_pct: a.target, min_pct: a.min, max_pct: a.max, actual_pct: a.actual_pct, before_pct: a.before_pct, status: a.status }));
  const breachesAfter = after.filter((a) => a.status === "breach").length, breachesBefore = after.filter((a) => { const miss = a.min_pct != null && a.before_pct < a.min_pct ? 1 : a.max_pct != null && a.before_pct > a.max_pct ? 1 : 0; return miss; }).length;
  const compliance = before ? { ...before.compliance, checks: before.compliance.checks.map((ch) => { if (ch.kind !== "allocation") return ch; const a = after.find((x) => `asset_class:${x.key}` === ch.key); return a ? { ...ch, actual: `${a.actual_pct}%`, status: a.status, detail: a.status === "in_band" ? "after the plan" : ch.detail } : ch; }) } : null;
  if (compliance) { compliance.breaches = compliance.checks.filter((x) => x.status === "breach").length; compliance.warnings = compliance.checks.filter((x) => x.status === "warning").length; compliance.overall = compliance.breaches ? "breach" : compliance.warnings ? "warning" : "compliant"; }
  const sim = { compliance_after: compliance, allocation_after: after, band_breaches_before: breachesBefore, band_breaches_after: breachesAfter, est_tax: Number(p.summary?.est_tax ?? 0), est_costs: Number(p.summary?.est_costs ?? 0), cash_timeline: p.cash_timeline, new_breach: compliance ? compliance.breaches > (before?.compliance.breaches ?? 0) : false, simulated_at: new Date().toISOString() };
  await c.query("update rebalance_plans set simulation=$2 where id=$1", [planId, JSON.stringify(sim)]);
  return sim;
}
const INTENT_KIND: Record<string, string> = { sell: "equity_order", buy: "mf_purchase", redeem: "mf_redemption", switch: "mf_switch", transfer_cash: "bank_transfer", sip_change: "mf_sip_mandate" };
/** Convert an approved plan into action-plane intents scheduled on each move's planned date (cooling-off until 09:00 IST that day). */
export async function convertPlan(c: pg.PoolClient, familyId: string, planId: string, userId: string) {
  const p = (await c.query("select * from rebalance_plans where id=$1", [planId])).rows[0]; if (!p) throw new RebalanceError(404, "Plan not found");
  if (p.status !== "approved") throw new RebalanceError(409, "Only an approved plan converts to intents");
  const moves = (await c.query("select m.*, i.type to_type, hi.type from_type, hi.id from_instrument_id, hi.name from_name from rebalance_moves m left join instruments i on i.id=m.to_instrument_id left join holdings h on h.id=m.from_holding_id left join instruments hi on hi.id=h.instrument_id where m.plan_id=$1 and m.status='planned' order by m.seq", [planId])).rows;
  const batch = (await c.query("select gen_random_uuid() id")).rows[0].id; const intents: any[] = [];
  for (const m of moves) {
    if (m.kind === "hold_cash") { await c.query("update rebalance_moves set status='executed', executed_on=current_date, executed_ref_type='cash_reserved' where id=$1", [m.id]); continue; }
    let kind = INTENT_KIND[m.kind] ?? "assisted"; if (m.kind === "sell" && m.from_type === "mf") kind = "mf_redemption"; if (m.kind === "redeem" && m.from_type && m.from_type !== "mf") kind = m.from_type === "stock" || m.from_type === "etf" ? "equity_order" : "assisted"; if (m.kind === "buy" && (m.to_type === "stock" || m.to_type === "etf")) kind = "equity_order"; if (m.kind === "buy" && !m.to_instrument_id) kind = "assisted";
    const payload = { instrument_id: m.from_instrument_id ?? m.to_instrument_id ?? null, side: ["sell", "redeem"].includes(m.kind) ? "sell" : "buy", quantity: m.quantity == null ? null : Number(m.quantity), amount: Number(m.amount), scheduled_for: iso(m.planned_date), settles_on: iso(m.settles_on), lot_ids: m.from_lot_ids, reason: m.reason, plan_id: planId, move_id: m.id, name: m.from_name ?? m.what };
    const connector = (await c.query("select id from connectors where entity_id=$1 and revoked_at is null and status in ('active','sandbox') order by (status='active') desc limit 1", [m.entity_id])).rows[0];
    const connectorId = connector?.id ?? (await c.query("insert into connectors (family_id, entity_id, kind, provider, label, status, sandbox, created_by) values ($1,$2,'custom','manual','Assisted / sandbox','sandbox',true,$3) returning id", [familyId, m.entity_id, userId])).rows[0].id;
    const holdAt = new Date(`${iso(m.planned_date)}T03:30:00Z`); // 09:00 IST on the planned date: the worker queues it then
    const r = (await c.query(`insert into action_intents (family_id, entity_id, kind, status, connector_id, payload, amount, rationale, proposed_by_kind, source_type, source_id, policy_result, approvers_required, cooling_off_until, expires_at, batch_id, idempotency_key)
      values ($1,$2,$3::intent_kind,'draft',$4,$5,$6,$7,'rule','rebalance_move',$8,$9,1,$10,$11,$12,$13) returning id`, [familyId, m.entity_id, kind, connectorId, JSON.stringify(payload), Number(m.amount), `Rebalancing plan v${p.version}: ${m.reason}`, m.id, JSON.stringify([{ code: "rebalance_plan", pass: true, detail: "approved plan" }]), holdAt, new Date(holdAt.getTime() + 30 * 86400000), batch, `rebalance-${m.id}`])).rows[0];
    await c.query("update action_intents set status='pending_approval' where id=$1", [r.id]);
    await c.query("insert into action_approvals (family_id, intent_id, approver_user_id, decision, note, auth_method) values ($1,$2,$3,'approved',$4,'plan')", [familyId, r.id, userId, `plan ${planId} v${p.version}`]);
    await c.query("update action_intents set status='approved' where id=$1", [r.id]);
    if (holdAt.getTime() <= Date.now()) { await c.query("savepoint q"); try { await c.query("update action_intents set status='queued' where id=$1", [r.id]); await c.query("release savepoint q"); } catch { await c.query("rollback to savepoint q"); } }
    await c.query("update rebalance_moves set intent_id=$2, status='intent_created' where id=$1", [m.id, r.id]);
    intents.push((await c.query("select * from action_intents where id=$1", [r.id])).rows[0]);
  }
  await c.query("update rebalance_plans set status='converted', intent_batch_id=$2 where id=$1", [planId, batch]);
  await c.query("update rebalance_runs set status='executing' where plan_id=$1", [planId]);
  return { batch_id: batch, intents };
}
/** After an import (or a fill): match transactions to converted moves; mark executed, fund the need, complete the run. */
export async function matchMoves(c: pg.PoolClient, familyId: string, opts: { since?: string } = {}) {
  const pending = (await c.query("select m.*, h.instrument_id from rebalance_moves m join rebalance_plans pl on pl.id=m.plan_id left join holdings h on h.id=m.from_holding_id where m.family_id=$1 and pl.status='converted' and m.status in ('planned','intent_created') and m.kind in ('sell','redeem','buy','switch')", [familyId])).rows;
  let matched = 0;
  for (const m of pending) {
    const inst = m.instrument_id ?? m.to_instrument_id; if (!inst) continue;
    const types = ["sell", "redeem", "switch"].includes(m.kind) ? ["sell", "redemption", "switch_out"] : ["buy", "sip", "switch_in"];
    const t = (await c.query(`select t.* from investment_txns t where t.family_id=$1 and t.instrument_id=$2 and t.entity_id=$3 and t.type = any($4) and t.txn_date between $5::date - 10 and $5::date + 10 and ($6::numeric is null or abs(t.quantity - $6::numeric) <= greatest(0.0001, $6::numeric * 0.02))
      and ($7::timestamptz is null or t.created_at >= $7::timestamptz) and not exists (select 1 from rebalance_moves x where x.executed_ref_id = t.id) order by abs(t.txn_date - $5::date) limit 1`, [familyId, inst, m.entity_id, types, iso(m.planned_date), m.quantity, opts.since ?? null])).rows[0];
    if (!t) continue;
    await c.query("update rebalance_moves set status='executed', executed_on=$2, executed_ref_type='investment_txn', executed_ref_id=$3 where id=$1", [m.id, iso(t.txn_date), t.id]);
    if (m.intent_id) await c.query("update action_intents set status = case status when 'filled' then 'reconciled' else status end where id=$1", [m.intent_id]).catch(() => null);
    if (m.need_id) { await c.query("update funding_needs set funded_amount = least(amount, funded_amount + $2), updated_at=now() where id=$1", [m.need_id, Number(t.amount)]); }
    matched++;
    const left = Number((await c.query("select count(*) n from rebalance_moves where plan_id=$1 and status in ('planned','intent_created')", [m.plan_id])).rows[0].n);
    if (!left) await c.query("update rebalance_runs set status='completed' where plan_id=$1", [m.plan_id]);
  }
  await refreshNeedStatus(c, familyId);
  return { matched };
}

// ---------- calendar (FO-165) ----------
export async function calendar(c: pg.PoolClient, familyId: string, from: string, to: string, entityId?: string | null) {
  const items: { date: string; kind: string; label: string; amount?: number | null; ref_type?: string; ref_id?: string; status?: string }[] = [];
  for (const m of (await c.query("select m.*, pl.version, pl.status plan_status from rebalance_moves m join rebalance_plans pl on pl.id=m.plan_id where m.family_id=$1 and pl.status in ('draft','in_review','approved','converted') and ($2::uuid is null or m.entity_id=$2) and (m.planned_date between $3 and $4 or m.settles_on between $3 and $4)", [familyId, entityId ?? null, from, to])).rows) {
    if (iso(m.planned_date)! >= from && iso(m.planned_date)! <= to) items.push({ date: iso(m.planned_date)!, kind: "move", label: `#${m.seq} ${m.what} (plan v${m.version} ${m.plan_status})`, amount: Number(m.amount), ref_type: "rebalance_move", ref_id: m.id, status: m.status });
    if (m.kind !== "hold_cash" && iso(m.settles_on)! >= from && iso(m.settles_on)! <= to && iso(m.settles_on) !== iso(m.planned_date)) items.push({ date: iso(m.settles_on)!, kind: "settlement", label: `#${m.seq} settles${m.need_id ? " → need reserved" : ""}`, amount: Number(m.amount), ref_type: "rebalance_move", ref_id: m.id });
  }
  for (const n of (await c.query("select * from funding_needs where family_id=$1 and status <> 'cancelled' and need_date between $2 and $3 and ($4::uuid is null or entity_id=$4)", [familyId, from, to, entityId ?? null])).rows) items.push({ date: iso(n.need_date)!, kind: "need", label: `${n.label} ${n.status === "met" ? "— met" : n.status === "funded" ? "— funded" : n.status === "partially_funded" ? "— partly funded" : ""}`.trim(), amount: Number(n.amount), ref_type: "funding_need", ref_id: n.id, status: n.status });
  for (const p of (await c.query("select id, name, calendar_rrule from rebalance_programs where family_id=$1 and active and calendar_rrule is not null", [familyId])).rows) { let d = nextCalendarRun(p.calendar_rrule, addDays(from, -1)); let guard = 0; while (d && d <= to && guard++ < 24) { items.push({ date: d, kind: "calendar_run", label: `${p.name} — scheduled run`, ref_type: "rebalance_program", ref_id: p.id }); d = nextCalendarRun(p.calendar_rrule, d); } }
  for (const g of (await c.query("select g.*, p.milestone_triggers from goals g join rebalance_programs p on p.goal_id=g.id where g.family_id=$1 and p.active", [familyId])).rows) for (const m of (g.milestone_triggers ?? []) as any[]) { if (m.kind !== "goal_years_to_go") continue; const d = `${Number(g.target_year) - Number(m.value)}-01-01`; if (d >= from && d <= to) items.push({ date: d, kind: "milestone", label: `${g.name}: ${m.value} year${m.value > 1 ? "s" : ""} to go`, ref_type: "goal", ref_id: g.id }); }
  for (const g of (await c.query("select gp.steps, go.name from glide_paths gp join goals go on go.id=gp.goal_id where gp.family_id=$1", [familyId])).rows) for (const s of (g.steps ?? []) as any[]) { const d = `${s.year}-04-01`; if (d >= from && d <= to) items.push({ date: d, kind: "milestone", label: `${g.name}: glide step → growth ${s.growth_pct ?? s.equity_pct}%` }); }
  for (const l of (await c.query("select lc.*, i.name, l.buy_date, l.remaining_qty, h.entity_id from lot_constraints lc join lots l on l.id=lc.lot_id join holdings h on h.id=l.holding_id join instruments i on i.id=h.instrument_id where lc.family_id=$1 and l.remaining_qty > 0 and ($2::uuid is null or h.entity_id=$2)", [familyId, entityId ?? null])).rows) {
    for (const [col, kind, txt] of [["ltcg_eligible_on", "ltcg_eligible", "LTCG eligible"], ["exit_load_until", "exit_load_expiry", "exit load ends"], ["lock_in_until", "lock_in_expiry", "lock-in ends"], ["matures_on", "maturity", "matures"]] as const) { const d = iso(l[col]); if (d && d >= from && d <= to) items.push({ date: d, kind, label: `${l.name} lot ${iso(l.buy_date)} (${Number(l.remaining_qty)} u): ${txt}`, ref_type: "lot", ref_id: l.lot_id }); }
  }
  return items.sort((a, b) => a.date.localeCompare(b.date) || a.kind.localeCompare(b.kind));
}
