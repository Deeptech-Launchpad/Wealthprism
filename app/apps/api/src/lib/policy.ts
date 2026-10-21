// Investment Policy Framework (FO-140..146): load clause chains, build look-through snapshots, evaluate compliance,
// activate versions into the live tables, render the IPS, simulate drafts. Everything runs inside the caller's family transaction.
import type pg from "pg";
import { resolveEffective, evaluateCompliance, concentration, seriesMetrics, periodicReturns, allocClassOf, validateClauses, diffClauses, expectedPortfolio, checkIntent, isIlliquid, PROFILE_TEMPLATES, scoreQuestionnaire, emptyClauses, fyOf,
  type PolicyClauses, type Position, type Snapshot, type ChainLink, type Lens, type Compliance, type AllocClass, type Profile } from "@fo/finance";
import { loadState, tablesProvider, DEFAULT_ASSUMPTIONS } from "./planning.js";
import { notifyTask } from "./notify.js";
import { activeDepositValues } from "./depositvalue.js";
import { emitEvent } from "./opendata.js";

export const iso = (d: any) => (d ? new Date(d).toISOString().slice(0, 10) : null);
const r2 = (n: number) => Math.round(n * 100) / 100 + 0;
const today = () => new Date().toISOString().slice(0, 10);
const addMonths = (d: string, m: number) => { const x = new Date(d + "T00:00:00Z"); x.setUTCMonth(x.getUTCMonth() + m); return x.toISOString().slice(0, 10); };
export class PolicyError extends Error { constructor(public status: number, message: string, public errors?: unknown) { super(message); } }

// ---------- clauses ----------
export async function versionClauses(c: pg.PoolClient, versionId: string): Promise<PolicyClauses & { version: any }> {
  const v = (await c.query("select * from policy_versions where id=$1", [versionId])).rows[0]; if (!v) throw new PolicyError(404, "Version not found");
  const allocations = (await c.query("select lens, key, target_pct, min_pct, max_pct from policy_allocations where policy_version_id=$1 order by lens, target_pct desc", [versionId])).rows.map((a) => ({ lens: a.lens as Lens, key: a.key, target_pct: Number(a.target_pct), min_pct: a.min_pct == null ? null : Number(a.min_pct), max_pct: a.max_pct == null ? null : Number(a.max_pct) }));
  const risk_limits = (await c.query("select metric, operator, limit_value, warn_value, severity from policy_risk_limits where policy_version_id=$1 order by metric", [versionId])).rows.map((l) => ({ metric: l.metric, operator: l.operator, limit_value: Number(l.limit_value), warn_value: l.warn_value == null ? null : Number(l.warn_value), severity: Number(l.severity) }));
  return { ...emptyClauses(), objectives: v.objectives ?? {}, risk: v.risk ?? {}, constraints: v.constraints ?? {}, permitted: v.permitted ?? {}, rebalancing: v.rebalancing ?? {}, monitoring: v.monitoring ?? {}, guardrails: v.guardrails ?? {}, allocations, risk_limits, ips_rules: v.ips_rules ?? [], glide_path: v.glide_path ?? null, version: v };
}
/** family → entity → goal chain ending in this policy (at `versionId`, default its current version). Ancestors without an active version are skipped. */
export async function chainFor(c: pg.PoolClient, policy: any, versionId?: string | null): Promise<ChainLink[]> {
  const links: ChainLink[] = []; let p = policy; let vid = versionId ?? policy.current_version_id; let guard = 0;
  while (p && guard++ < 4) {
    if (vid) { const cl = await versionClauses(c, vid); links.unshift({ id: p.id, name: p.name, clauses: cl }); }
    if (!p.parent_policy_id) break;
    p = (await c.query("select * from investment_policies where id=$1 and deleted_at is null", [p.parent_policy_id])).rows[0]; vid = p?.current_version_id;
  }
  return links;
}
export async function effectiveFor(c: pg.PoolClient, policy: any, versionId?: string | null) { const chain = await chainFor(c, policy, versionId); return { chain, ...resolveEffective(chain) }; }
/** The policy that governs an entity (entity policy if it has an active version, else the family policy). */
export async function governingPolicy(c: pg.PoolClient, entityId?: string | null, goalId?: string | null) {
  if (goalId) { const g = (await c.query("select * from investment_policies where scope='goal' and goal_id=$1 and deleted_at is null and current_version_id is not null", [goalId])).rows[0]; if (g) return g; }
  if (entityId) { const e = (await c.query("select * from investment_policies where scope='entity' and entity_id=$1 and deleted_at is null and current_version_id is not null", [entityId])).rows[0]; if (e) return e; }
  return (await c.query("select * from investment_policies where scope='family' and deleted_at is null and current_version_id is not null order by created_at limit 1")).rows[0] ?? null;
}

// ---------- snapshot: look-through positions of the policy's scope ----------
export interface PolicySnapshot extends Snapshot { total: number; scope: { type: "family" | "entity" | "goal"; id: string }; liquid: number; monthlySpend: number | null; series_periods: number; benchmark: string | null }
export async function snapshotFor(c: pg.PoolClient, familyId: string, policy: any, eff: PolicyClauses, asOf = today()): Promise<PolicySnapshot> {
  const state = await loadState(c, asOf, policy.entity_id ? [policy.entity_id] : null);
  const goal = policy.goal_id ? state.goals.find((g) => g.id === policy.goal_id) : null;
  const ids = [...new Set(state.holdings.map((h) => h.instrumentId))];
  const attrs = new Map((await c.query("select distinct on (instrument_id) * from instrument_attributes where instrument_id = any($1) order by instrument_id, as_of desc", [ids])).rows.map((a) => [a.instrument_id, a]));
  const inst = new Map((await c.query("select id, type, isin, meta from instruments where id = any($1)", [ids])).rows.map((i) => [i.id, i]));
  const positions: (Position & { bucket: string; subClass: string; geography: string; entityId: string | null; holdingId?: string; assetClass?: string; cost?: number; lots?: any[] })[] = [];
  const holdings = goal ? state.holdings.filter((h) => goal.linkedHoldingIds.includes(h.id)) : state.holdings;
  for (const h of holdings) {
    const qty = h.lots.reduce((s, l) => s + l.remainingQty, 0) || Number(h.quantity ?? 0); if (qty <= 0) continue; // hand-entered PMS/AIF units carry no lots
    const a = attrs.get(h.instrumentId) ?? {}; const i = inst.get(h.instrumentId) ?? {}; const meta = i.meta ?? {};
    const cls = allocClassOf(h.assetClass, i.type, meta.sub_class ?? h.name);
    positions.push({ id: h.instrumentId, holdingId: h.id, name: h.name, value: r2(qty * h.price), allocClass: cls, instrumentType: i.type, issuer: a.issuer ?? null, manager: a.manager ?? null, sector: a.sector ?? null, rating: a.credit_rating ?? null, liquidityClass: a.liquidity_class ?? null, currency: meta.currency ?? "INR", modifiedDuration: a.modified_duration == null ? null : Number(a.modified_duration), marketCapBand: a.market_cap_band ?? null,
      bucket: h.bucket, subClass: meta.sub_class ?? (cls === "equity" ? `${a.market_cap_band ?? "large"}_cap` : cls), geography: meta.country ?? (cls === "global" ? "US" : "IN"), entityId: h.entityId, assetClass: h.assetClass, cost: h.lots.reduce((s, l) => s + l.remainingQty * l.unitCost, 0), lots: h.lots });
  }
  const privates = goal ? state.privates.filter((p) => goal.linkedPrivateIds.includes(p.id)) : state.privates;
  for (const p of privates) positions.push({ id: p.id, name: p.name, value: r2(p.mark), allocClass: "alternatives", instrumentType: "private", liquidityClass: "locked", currency: "INR", bucket: p.bucket, subClass: "private_equity", geography: "IN", entityId: p.entityId, cost: p.cost });
  // FDs and RDs are debt the family holds; without this the policy saw only the cash and judged a mostly-deposit portfolio as 100% cash
  const goalDeps = goal ? new Set((await c.query("select deposit_id from goal_links where goal_id=$1 and deposit_id is not null", [goal.id])).rows.map((r) => r.deposit_id as string)) : null;
  for (const d of await activeDepositValues(c, familyId, policy.entity_id ?? null)) { if (goalDeps && !goalDeps.has(d.id)) continue; if (d.value <= 0) continue;
    positions.push({ id: d.id, name: `${d.bank} ${d.kind.toUpperCase()}${d.account_no ? " " + d.account_no : ""}`, value: r2(d.value), allocClass: "debt", instrumentType: "deposit", issuer: d.bank, liquidityClass: "t3", currency: "INR", bucket: d.bucket, subClass: "bank_deposit", geography: "IN", entityId: d.entity_id }); }
  if (!goal) for (const [eid, v] of Object.entries(state.cash)) if (v > 0) positions.push({ id: `cash:${eid}`, name: "Bank balances", value: r2(v), allocClass: "cash", instrumentType: "cash", liquidityClass: "t0", currency: "INR", bucket: "liquidity", subClass: "bank", geography: "IN", entityId: eid });
  if (eff.constraints?.include_real_estate) for (const p of (goal ? state.properties.filter((x) => goal.linkedPropertyIds.includes(x.id)) : state.properties)) positions.push({ id: p.id, name: p.name, value: r2(p.value * p.ownershipPct / 100), allocClass: "real_estate", instrumentType: "property", liquidityClass: "locked", currency: "INR", bucket: "growth", subClass: "residential", geography: "IN", entityId: p.entityId, cost: p.cost * p.ownershipPct / 100 });
  const total = positions.reduce((s, p) => s + p.value, 0);
  const lens = (key: (p: typeof positions[number]) => string) => { const m: Record<string, number> = {}; for (const p of positions) m[key(p)] = (m[key(p)] ?? 0) + p.value; return Object.fromEntries(Object.entries(m).map(([k, v]) => [k, total ? r2(v / total * 100) : 0])); };
  const allocation: Snapshot["allocation"] = { bucket: lens((p) => p.bucket), asset_class: lens((p) => p.allocClass), sub_class: lens((p) => p.subClass), geography: lens((p) => p.geography), currency: lens((p) => p.currency ?? "INR") };
  const liquid = positions.filter((p) => p.bucket === "liquidity" || ["t0", "t1"].includes(String(p.liquidityClass ?? ""))).reduce((s, p) => s + p.value, 0);
  const spendPa = Number(eff.objectives?.spending_need_pa ?? 0); const monthlySpend = spendPa > 0 ? spendPa / 12 : null;
  const liquidityMonths = monthlySpend ? r2(liquid / monthlySpend) : null;
  const scope = goal ? { type: "goal" as const, id: goal.id } : policy.entity_id ? { type: "entity" as const, id: policy.entity_id } : { type: "family" as const, id: familyId };
  const conc = concentration(positions);
  const series = await seriesFor(c, familyId, scope.type, scope.id, eff.monitoring?.benchmark_code ?? null, asOf);
  const liabilities = state.liabilities.filter((l) => !policy.entity_id || l.entityId === policy.entity_id).reduce((s, l) => s + l.outstanding, 0);
  const metrics: Record<string, any> = { ...conc, ...series.metrics, leverage_max: total ? r2(liabilities / total * 100) : 0, liquidity_coverage_months_min: liquidityMonths };
  return { positions, allocation, metrics, liquidityMonths, year: Number(asOf.slice(0, 4)), total: r2(total), scope, liquid: r2(liquid), monthlySpend, series_periods: series.metrics.periods, benchmark: series.benchmark };
}
/** Month-end valuation series for a scope (from valuations_daily) with daily flows, plus the benchmark's matching returns. */
export async function seriesFor(c: pg.PoolClient, familyId: string, scopeType: string, scopeId: string, benchmarkCode: string | null, asOf = today(), months = 36) {
  const from = addMonths(asOf, -months);
  const rows = (await c.query("select as_of, value, net_flow from valuations_daily where family_id=$1 and scope_type=$2::scope_type and scope_id=$3 and as_of between $4 and $5 order by as_of", [familyId, scopeType, scopeId, from, asOf])).rows;
  const byMonth = new Map<string, { date: string; value: number }>(); for (const r of rows) byMonth.set(iso(r.as_of)!.slice(0, 7), { date: iso(r.as_of)!, value: Number(r.value) });
  const vals = [...byMonth.values()]; const flows = rows.filter((r) => Number(r.net_flow)).map((r) => ({ date: iso(r.as_of)!, amount: Number(r.net_flow) }));
  const rets = periodicReturns(vals, flows);
  let bench: number[] | null = null; let benchmark: string | null = null;
  if (benchmarkCode && rets.length) {
    const b = (await c.query("select p.price_date, p.value from benchmark_prices p join benchmarks b on b.id=p.benchmark_id where b.code=$1 and p.price_date between $2 and $3 order by p.price_date", [benchmarkCode, addMonths(vals[0]?.date ?? from, -1), asOf])).rows;
    if (b.length) { const at = (d: string) => { let v: number | null = null; for (const r of b) { if (iso(r.price_date)! <= d) v = Number(r.value); else break; } return v; }; const series = vals.map((v) => at(v.date)); if (series.every((x) => x != null)) { bench = []; for (let i = 1; i < series.length; i++) bench.push(series[i]! / series[i - 1]! - 1); benchmark = benchmarkCode; } }
  }
  return { valuations: vals, returns: rets, metrics: seriesMetrics(rets.map((r) => r.ret), { benchmark: bench, periodsPerYear: 12 }), benchmark };
}
const SERIES_METRICS = ["volatility_1y", "max_drawdown", "var_95_1m", "beta", "tracking_error", "sharpe", "annual_return", "concentration_top5", "issuer_max", "manager_max", "sector_max", "illiquid_max", "unrated_debt_max", "fx_exposure_max", "duration_max", "leverage_max", "liquidity_coverage_months_min", "single_stock_max"];
export async function persistMetrics(c: pg.PoolClient, familyId: string, snap: PolicySnapshot, asOf: string) {
  const bid = snap.benchmark ? (await c.query("select id from benchmarks where code=$1", [snap.benchmark])).rows[0]?.id ?? null : null;
  for (const m of SERIES_METRICS) { const v = snap.metrics[m]; if (v == null || typeof v !== "number") continue;
    await c.query("insert into risk_metrics (family_id, scope_type, scope_id, as_of, metric, value, lookback, benchmark_id) values ($1,$2::scope_type,$3,$4,$5,$6,$7,$8) on conflict (family_id, scope_type, scope_id, as_of, metric) do update set value=excluded.value, lookback=excluded.lookback, benchmark_id=excluded.benchmark_id", [familyId, snap.scope.type, snap.scope.id, asOf, m, v, ["volatility_1y", "max_drawdown", "beta", "tracking_error", "sharpe", "annual_return"].includes(m) ? `${snap.series_periods}m` : null, bid]); }
}

// ---------- compliance ----------
export interface Evaluation { policy_id: string; policy_version_id: string; as_of: string; compliance: Compliance; snapshot: { total: number; allocation: Snapshot["allocation"]; liquidity_months: number | null; positions: number; scope: PolicySnapshot["scope"]; series_periods: number; benchmark: string | null }; metrics: Record<string, any>; task_ids: string[] }
export async function evaluatePolicy(c: pg.PoolClient, familyId: string, policyId: string, opts: { versionId?: string | null; asOf?: string; persist?: boolean; notify?: boolean } = {}): Promise<Evaluation | null> {
  const policy = (await c.query("select * from investment_policies where id=$1 and deleted_at is null", [policyId])).rows[0]; if (!policy) throw new PolicyError(404, "Policy not found");
  const versionId = opts.versionId ?? policy.current_version_id; if (!versionId) return null;
  const asOf = opts.asOf ?? today();
  const { clauses } = await effectiveFor(c, policy, versionId);
  const snap = await snapshotFor(c, familyId, policy, clauses, asOf);
  const compliance = evaluateCompliance(clauses, snap);
  const out: Evaluation = { policy_id: policy.id, policy_version_id: versionId, as_of: asOf, compliance, snapshot: { total: snap.total, allocation: snap.allocation, liquidity_months: snap.liquidityMonths, positions: snap.positions.length, scope: snap.scope, series_periods: snap.series_periods, benchmark: snap.benchmark }, metrics: Object.fromEntries(Object.entries(snap.metrics).filter(([, v]) => v == null || typeof v !== "object")), task_ids: [] };
  if (opts.persist) {
    await persistMetrics(c, familyId, snap, asOf);
    const breached = compliance.checks.filter((x) => x.status === "breach");
    if (breached.length) {
      const sev = Math.min(2, ...breached.map((x) => x.severity ?? 2)) as 1 | 2;
      const title = `Policy breach: ${policy.name}`; const reason = breached.map((x) => `${x.key} ${x.actual} vs ${x.target}${x.detail ? ` — ${x.detail}` : ""}`).join("; ").slice(0, 900);
      const r = await c.query(`insert into tasks (family_id, entity_id, module, title, reason, severity, source_type, source_id, verification) select $1,$2,'policy',$3,$4,$5,'policy_breach',$6,'na' where not exists (select 1 from tasks where family_id=$1 and source_type='policy_breach' and source_id=$6 and status='open') returning *`, [familyId, policy.entity_id ?? null, title, reason, sev, policy.id]);
      if (r.rows[0]) { if (opts.notify !== false) await notifyTask(c, r.rows[0]); } else await c.query("update tasks set title=$3, reason=$4, severity=$5 where family_id=$1 and source_type='policy_breach' and source_id=$2 and status='open'", [familyId, policy.id, title, reason, sev]);
    } else await c.query("update tasks set status='done', done_at=now(), verification='verified' where family_id=$1 and source_type='policy_breach' and source_id=$2 and status='open'", [familyId, policy.id]);
    out.task_ids = (await c.query("select id from tasks where family_id=$1 and source_type='policy_breach' and source_id=$2 and status='open'", [familyId, policy.id])).rows.map((x) => x.id);
    if (breached.length) await emitEvent(c, familyId, "ips.breach", { policy_id: policy.id, policy: policy.name, as_of: asOf, breaches: breached.map((x) => ({ key: x.key, actual: x.actual, target: x.target })) }).catch(() => null);
    await c.query(`insert into policy_compliance (family_id, policy_version_id, as_of, overall, checks, breaches, warnings, task_ids, metrics) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      on conflict (policy_version_id, as_of) do update set overall=excluded.overall, checks=excluded.checks, breaches=excluded.breaches, warnings=excluded.warnings, task_ids=excluded.task_ids, metrics=excluded.metrics`,
      [familyId, versionId, asOf, compliance.overall, JSON.stringify(compliance.checks), compliance.breaches, compliance.warnings, out.task_ids, JSON.stringify({ ...out.metrics, total: snap.total, allocation: snap.allocation, liquidity_months: snap.liquidityMonths })]);
  }
  return out;
}

// ---------- action-plane hook (FO-144): prohibited instrument or a band the intent would worsen ----------
export async function intentPolicyCheck(c: pg.PoolClient, familyId: string, entityId: string, kind: string, amount: number, payload: Record<string, any>) {
  const policy = await governingPolicy(c, entityId, payload.goal_id ?? null); if (!policy) return null;
  const { clauses } = await effectiveFor(c, policy);
  const key = payload.instrument_id ? ["id=$1", payload.instrument_id] : payload.isin ? ["isin=$1", payload.isin] : payload.symbol ? ["symbol=$1", payload.symbol] : payload.amfi_code ? ["amfi_code=$1", payload.amfi_code] : null;
  const inst = key ? (await c.query(`select i.*, a.credit_rating, a.sector from instruments i left join lateral (select credit_rating, sector from instrument_attributes x where x.instrument_id=i.id order by as_of desc limit 1) a on true where i.${key[0]}`, [key[1]])).rows[0] : null;
  const type = inst?.type ?? payload.instrument_type ?? (kind.startsWith("mf_") ? "mf" : kind === "equity_order" ? "stock" : null);
  const direction: "buy" | "sell" = kind.includes("redemption") || String(payload.side ?? payload.transaction_type ?? "").toLowerCase() === "sell" ? "sell" : "buy";
  const snap = await snapshotFor(c, familyId, policy, clauses);
  const r = checkIntent(clauses, snap, { instrumentType: type, name: inst?.name ?? payload.instrument_name ?? payload.name ?? null, allocClass: inst ? allocClassOf(inst.asset_class, inst.type) : (payload.alloc_class ?? null), amount, direction, rating: inst?.credit_rating ?? payload.rating ?? null, sector: inst?.sector ?? null });
  return { code: "investment_policy", pass: r.pass, policy_id: policy.id, policy: policy.name, clause: r.clause, detail: r.detail || `within ${policy.name}` };
}

// ---------- drafts, validation, activation ----------
export async function writeClauses(c: pg.PoolClient, familyId: string, versionId: string, input: Partial<PolicyClauses> & { change_summary?: string }) {
  const cur = await versionClauses(c, versionId);
  const next: PolicyClauses = { ...cur, ...Object.fromEntries(Object.entries(input).filter(([k, v]) => v !== undefined && k !== "version")) } as PolicyClauses;
  const errs = validateClauses(next); if (errs.length) throw new PolicyError(422, "Policy clauses are invalid", errs);
  await c.query("update policy_versions set objectives=$2, risk=$3, constraints=$4, permitted=$5, rebalancing=$6, monitoring=$7, guardrails=$8, ips_rules=$9, glide_path=$10, change_summary=coalesce($11, change_summary), updated_at=now() where id=$1",
    [versionId, next.objectives, next.risk, next.constraints, next.permitted, next.rebalancing, next.monitoring, next.guardrails, JSON.stringify(next.ips_rules ?? []), next.glide_path ? JSON.stringify(next.glide_path) : null, input.change_summary ?? null]);
  if (input.allocations) { await c.query("delete from policy_allocations where policy_version_id=$1", [versionId]); for (const a of next.allocations) await c.query("insert into policy_allocations (family_id, policy_version_id, lens, key, target_pct, min_pct, max_pct) values ($1,$2,$3,$4,$5,$6,$7)", [familyId, versionId, a.lens, a.key, a.target_pct, a.min_pct ?? null, a.max_pct ?? null]); }
  if (input.risk_limits) { await c.query("delete from policy_risk_limits where policy_version_id=$1", [versionId]); for (const l of next.risk_limits) await c.query("insert into policy_risk_limits (family_id, policy_version_id, metric, operator, limit_value, warn_value, severity) values ($1,$2,$3,$4,$5,$6,$7)", [familyId, versionId, l.metric, l.operator, l.limit_value, l.warn_value ?? null, l.severity ?? 2]); }
  return versionClauses(c, versionId);
}
/** Starting clauses for a first draft: from a risk-profile response, a model portfolio, the parent's effective policy, or blank. */
export async function startingClauses(c: pg.PoolClient, policy: any, startFrom: string, opts: { model_portfolio_id?: string | null; questionnaire_response_id?: string | null }): Promise<PolicyClauses> {
  const out = emptyClauses();
  const parent = policy.parent_policy_id ? (await c.query("select * from investment_policies where id=$1", [policy.parent_policy_id])).rows[0] : null;
  const asAlloc = (mix: Record<string, number>, bands: Record<string, [number, number] | number[]>) => Object.entries(mix).map(([k, t]) => ({ lens: "asset_class" as Lens, key: k, target_pct: Number(t), min_pct: bands?.[k]?.[0] ?? null, max_pct: bands?.[k]?.[1] ?? null }));
  if (startFrom === "copy_parent" && parent) { const { clauses } = await effectiveFor(c, parent); return { ...clauses, objectives: { ...clauses.objectives }, risk: { ...clauses.risk } }; }
  if (startFrom === "model_portfolio") {
    // $1 arrives as a short code ("moderate") from the New-policy form, not a uuid — cast id to text too, or Postgres
    // infers $1's type from the first `id=$1` usage and rejects a non-uuid string before `code=$1` ever gets a chance
    const m = (await c.query("select * from model_portfolios where id::text=$1 or code=$1 order by family_id nulls last limit 1", [opts.model_portfolio_id])).rows[0]; if (!m) throw new PolicyError(404, "Model portfolio not found");
    out.allocations = asAlloc(m.mix, m.bands ?? {}); const prof = (["conservative", "moderate", "aggressive"].includes(m.risk_profile) ? m.risk_profile : "moderate") as Profile; out.risk = { profile: prof, max_drawdown_pct: PROFILE_TEMPLATES[prof].max_drawdown_pct, model_portfolio_id: m.id }; out.risk_limits = PROFILE_TEMPLATES[prof].limits; out.constraints = { liquidity_months: PROFILE_TEMPLATES[prof].liquidity_months };
  }
  if (startFrom === "risk_profile") {
    const resp = (await c.query(opts.questionnaire_response_id ? "select * from risk_questionnaire_responses where id=$1" : "select * from risk_questionnaire_responses where ($1::uuid is null or goal_id=$1) and ($2::uuid is null or entity_id=$2) order by completed_at desc limit 1",
      opts.questionnaire_response_id ? [opts.questionnaire_response_id] : [policy.goal_id ?? null, policy.entity_id ?? null])).rows[0];
    const prof = (resp?.profile ?? "moderate") as Profile; const t = PROFILE_TEMPLATES[prof];
    out.allocations = asAlloc(t.mix, t.bands); out.risk = { profile: prof, score: resp ? Number(resp.score) : null, capacity_score: resp ? Number(resp.capacity_score) : null, tolerance_score: resp ? Number(resp.tolerance_score) : null, max_drawdown_pct: t.max_drawdown_pct, questionnaire_response_id: resp?.id ?? null }; out.risk_limits = t.limits; out.constraints = { liquidity_months: t.liquidity_months };
  }
  if (policy.scope === "family" && startFrom !== "blank") {
    out.permitted = { instrument_types: ["stock", "etf", "mf", "pms", "aif", "bond", "sgb", "gsec", "tbill", "fd"], min_rating: "AA", prohibited: ["f&o", "crypto", "unrated_debt", "single_stocks > 5"], managers: [] };
    out.rebalancing = { method: "both", calendar: "quarterly", tolerance_pp: 5, use_new_cash_first: true, tax_aware: true };
    out.monitoring = { benchmark_code: "BLEND_6040", tracking_error_max_pct: 4, report_to: ["principal"], review_every_months: Number(policy.review_every_months ?? 12), triggers: ["breach_persisting", "drawdown", "goal_change", "new_entity", "regulation"] };
    out.guardrails = { execution_policies: [{ code: "max_single_amount", params: { amount: 500000 } }, { code: "approvers_required", params: { count: 2, above: 2500000 } }, { code: "cooling_off_minutes", params: { minutes: 30, above: 5000000 } }], approval_tiers: [{ up_to: 500000, approvers: 1 }, { up_to: 2500000, approvers: 2 }, { above: 2500000, approvers: 2, cooling_off_minutes: 30 }] };
    out.ips_rules = [{ code: "max_single_issuer", params: { pct: 10 }, severity: 2 }, { code: "max_single_manager", params: { pct: 25 }, severity: 2 }, { code: "max_illiquid_pct", params: { pct: 25 }, severity: 2 }, { code: "max_unrated_pct", params: { pct: 0 }, severity: 1 }];
  }
  if (policy.goal_id && startFrom !== "blank") { const g = (await c.query("select * from goals where id=$1", [policy.goal_id])).rows[0]; if (g) out.objectives = { purpose: `Fund ${g.name} (${g.target_year})`, horizon_years: Math.max(1, Number(g.target_year) - new Date().getFullYear()), spending_need_pa: 0 }; }
  return out;
}
export async function createVersion(c: pg.PoolClient, familyId: string, policyId: string, userId: string, clauses: PolicyClauses, changeSummary?: string | null) {
  const n = Number((await c.query("select coalesce(max(version),0)+1 v from policy_versions where policy_id=$1", [policyId])).rows[0].v);
  const v = (await c.query("insert into policy_versions (family_id, policy_id, version, status, objectives, risk, constraints, permitted, rebalancing, monitoring, guardrails, ips_rules, glide_path, change_summary, created_by) values ($1,$2,$3,'draft',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) returning id",
    [familyId, policyId, n, clauses.objectives ?? {}, clauses.risk ?? {}, clauses.constraints ?? {}, clauses.permitted ?? {}, clauses.rebalancing ?? {}, clauses.monitoring ?? {}, clauses.guardrails ?? {}, JSON.stringify(clauses.ips_rules ?? []), clauses.glide_path ? JSON.stringify(clauses.glide_path) : null, changeSummary ?? null, userId])).rows[0];
  for (const a of clauses.allocations ?? []) await c.query("insert into policy_allocations (family_id, policy_version_id, lens, key, target_pct, min_pct, max_pct) values ($1,$2,$3,$4,$5,$6,$7)", [familyId, v.id, a.lens, a.key, a.target_pct, a.min_pct ?? null, a.max_pct ?? null]);
  for (const l of clauses.risk_limits ?? []) await c.query("insert into policy_risk_limits (family_id, policy_version_id, metric, operator, limit_value, warn_value, severity) values ($1,$2,$3,$4,$5,$6,$7)", [familyId, v.id, l.metric, l.operator, l.limit_value, l.warn_value ?? null, l.severity ?? 2]);
  return v.id as string;
}
/** Activation (FO-142): supersede the current version, write the clauses into the live tables atomically, schedule the next review, render the IPS. */
export async function activateVersion(c: pg.PoolClient, familyId: string, versionId: string, userId: string, effectiveFrom = today()) {
  const cl = await versionClauses(c, versionId); const v = cl.version;
  if (!["in_review", "draft"].includes(v.status)) throw new PolicyError(409, `Cannot activate a ${v.status} version`);
  if (!(v.signed_by ?? []).length) throw new PolicyError(409, "At least one signature is required before activation");
  const errs = validateClauses(cl); if (errs.length) throw new PolicyError(422, "Policy clauses are invalid", errs);
  const policy = (await c.query("select * from investment_policies where id=$1", [v.policy_id])).rows[0];
  const prev = (await c.query("select * from policy_versions where policy_id=$1 and status='active'", [v.policy_id])).rows[0];
  if (prev) await c.query("update policy_versions set status='superseded', effective_to=$2::date - 1 where id=$1", [prev.id, effectiveFrom]);
  await c.query("update policy_versions set status='active', effective_from=$2, approved_by=coalesce(approved_by,$3), approved_at=coalesce(approved_at, now()), updated_at=now() where id=$1", [versionId, effectiveFrom, userId]);
  const months = Number(cl.monitoring?.review_every_months ?? policy.review_every_months ?? 12);
  await c.query("update investment_policies set current_version_id=$2, review_every_months=$3, next_review_on=$4 where id=$1", [policy.id, versionId, months, addMonths(effectiveFrom, months)]);
  // live tables: bucket targets, asset-class targets, IPS rules, execution guardrails, glide path
  const bucket = cl.allocations.filter((a) => a.lens === "bucket"); const b = (k: string) => Number(bucket.find((a) => a.key === k)?.target_pct ?? 0);
  if (bucket.length && Math.abs(b("liquidity") + b("income") + b("growth") - 100) < 0.01 && policy.scope !== "goal") {
    await c.query("delete from bucket_targets where family_id=$1 and entity_id is not distinct from $2 and (policy_version_id = $3 or policy_version_id is null or policy_version_id = $4)", [familyId, policy.entity_id ?? null, versionId, prev?.id ?? versionId]);
    await c.query("insert into bucket_targets (family_id, entity_id, liquidity_pct, income_pct, growth_pct, drift_threshold_pp, effective_from, policy_version_id) values ($1,$2,$3,$4,$5,$6,$7,$8)", [familyId, policy.entity_id ?? null, b("liquidity"), b("income"), b("growth"), Number(cl.rebalancing?.tolerance_pp ?? 1.5), effectiveFrom, versionId]);
  }
  const classes = cl.allocations.filter((a) => a.lens === "asset_class");
  if (classes.length && policy.scope !== "goal") {
    if (prev) await c.query("delete from asset_class_targets where policy_version_id=$1", [prev.id]);
    for (const a of classes) await c.query("insert into asset_class_targets (family_id, entity_id, alloc_class, target_pct, min_pct, max_pct, effective_from, policy_version_id) values ($1,$2,$3::alloc_class,$4,$5,$6,$7,$8) on conflict (family_id, entity_key, alloc_class, effective_from) do update set target_pct=excluded.target_pct, min_pct=excluded.min_pct, max_pct=excluded.max_pct, policy_version_id=excluded.policy_version_id", [familyId, policy.entity_id ?? null, a.key, a.target_pct, a.min_pct ?? null, a.max_pct ?? null, effectiveFrom, versionId]);
  }
  if (prev) { await c.query("update ips_rules set active=false where policy_version_id=$1", [prev.id]); await c.query("update execution_policies set active=false where policy_version_id=$1", [prev.id]); await c.query("delete from glide_paths where policy_version_id=$1", [prev.id]); }
  for (const r of cl.ips_rules ?? []) await c.query("insert into ips_rules (family_id, entity_id, code, params, severity, active, policy_version_id) values ($1,$2,$3,$4,$5,true,$6)", [familyId, policy.entity_id ?? null, r.code, JSON.stringify(r.params ?? {}), r.severity ?? 2, versionId]);
  for (const g of (cl.guardrails?.execution_policies ?? []) as any[]) await c.query("insert into execution_policies (family_id, entity_id, intent_kind, code, params, active, created_by, policy_version_id) values ($1,$2,$3::intent_kind,$4,$5,true,$6,$7)", [familyId, policy.entity_id ?? null, g.intent_kind ?? null, g.code, JSON.stringify(g.params ?? {}), userId, versionId]);
  if (cl.glide_path?.steps?.length && policy.goal_id) { await c.query("delete from glide_paths where goal_id=$1 and (policy_version_id is null or policy_version_id=$2)", [policy.goal_id, versionId]); await c.query("insert into glide_paths (family_id, goal_id, steps, policy_version_id) values ($1,$2,$3,$4)", [familyId, policy.goal_id, JSON.stringify(cl.glide_path.steps), versionId]); }
  await renderDocument(c, versionId);
  return { previous_version_id: prev?.id ?? null, next_review_on: addMonths(effectiveFrom, months) };
}

// ---------- simulate a draft (FO-142 step 9) ----------
export async function simulateDraft(c: pg.PoolClient, familyId: string, versionId: string, asOf = today()) {
  const cl = await versionClauses(c, versionId); const policy = (await c.query("select * from investment_policies where id=$1", [cl.version.policy_id])).rows[0];
  const { clauses } = await effectiveFor(c, policy, versionId);
  const snap = await snapshotFor(c, familyId, policy, clauses, asOf);
  const compliance = evaluateCompliance(clauses, snap);
  // moves: bring every out-of-band asset class back to target; sells pick the lowest-gain holdings first (tax-aware)
  const { tables } = await tablesProvider(c); const fy = fyOf(asOf); const ent = (await c.query("select id, type, tax_regime from entities where deleted_at is null")).rows;
  const classes = clauses.allocations.filter((a) => a.lens === "asset_class"); const actual = snap.allocation.asset_class ?? {};
  const over = classes.filter((a) => a.max_pct != null && (actual[a.key] ?? 0) > Number(a.max_pct)).map((a) => ({ key: a.key, amount: r2(((actual[a.key] ?? 0) - a.target_pct) / 100 * snap.total) }));
  const under = classes.filter((a) => a.min_pct != null && (actual[a.key] ?? 0) < Number(a.min_pct)).map((a) => ({ key: a.key, amount: r2((a.target_pct - (actual[a.key] ?? 0)) / 100 * snap.total) }));
  const moves: any[] = []; let tax = 0;
  for (const o of over) {
    let left = o.amount; const cands = (snap.positions as any[]).filter((p) => p.allocClass === o.key && p.holdingId && p.cost != null).map((p) => ({ ...p, gainRatio: p.value ? Math.max(0, (p.value - p.cost) / p.value) : 0 })).sort((a, b) => a.gainRatio - b.gainRatio);
    for (const p of cands) { if (left <= 0) break; const amt = Math.min(left, p.value); const gain = r2(amt * p.gainRatio); const e = ent.find((x) => x.id === p.entityId);
      const oldest = p.lots?.length ? p.lots.reduce((m: string, l: any) => (l.buyDate < m ? l.buyDate : m), p.lots[0].buyDate) : asOf; const monthsHeld = (Date.parse(asOf) - Date.parse(oldest)) / (30.44 * 86400000);
      const rules = tables(fy, e?.tax_regime ?? "new", e?.type ?? "individual").rules; const rule = rules.find((r) => r.assetClass === p.assetClass && r.term === (monthsHeld >= (rules.find((x) => x.assetClass === p.assetClass)?.holdingMonthsForLong ?? 12) ? "long" : "short"));
      const t = rule ? r2(Math.max(0, gain - (rule.term === "long" ? Number(rule.exemptionAmount ?? 0) : 0)) * (rule.taxedAtSlab ? 30 : rule.rate) / 100) : r2(gain * 0.125);
      moves.push({ kind: "sell", from: o.key, holding_id: p.holdingId, name: p.name, amount: r2(amt), estimated_gain: gain, estimated_tax: t, term: rule?.term ?? null }); tax += t; left -= amt; }
  }
  const sellTotal = moves.reduce((s, m) => s + m.amount, 0); const underTotal = under.reduce((s, u) => s + u.amount, 0) || 1;
  for (const u of under) moves.push({ kind: "buy", to: u.key, amount: r2(Math.min(u.amount, sellTotal * u.amount / underTotal)), note: clauses.rebalancing?.use_new_cash_first ? "new contributions first, then the sale proceeds" : "from sale proceeds" });
  const mix = Object.fromEntries(classes.map((a) => [a.key, a.target_pct])); const exp = expectedPortfolio(mix);
  const objective = Number(clauses.objectives?.return_objective_pct ?? 0); const nominal = clauses.objectives?.return_basis === "real" ? objective + DEFAULT_ASSUMPTIONS.inflation : objective;
  const result = { compliance, moves, expected_return_pct: exp.ret, expected_vol_pct: exp.vol, objective_nominal_pct: r2(nominal), objective_gap_pct: r2(exp.ret - nominal), tax_cost_to_comply: r2(tax).toFixed(2), vol_limit_pct: clauses.risk_limits.find((l) => l.metric === "volatility_1y")?.limit_value ?? null, as_of: asOf, total: snap.total, allocation_now: snap.allocation.asset_class };
  await c.query("update policy_versions set simulation=$2, updated_at=now() where id=$1", [versionId, JSON.stringify(result)]);
  return result;
}

// ---------- IPS document (FO-146) ----------
const esc = (s: any) => String(s ?? "").replace(/[&<>]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[ch]!));
const fmtD = (d: any) => (d ? new Date(d).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }) : "—");
export async function renderDocument(c: pg.PoolClient, versionId: string) {
  const cl = await versionClauses(c, versionId); const v = cl.version;
  const policy = (await c.query("select p.*, e.name entity_name, g.name goal_name, g.target_year from investment_policies p left join entities e on e.id=p.entity_id left join goals g on g.id=p.goal_id where p.id=$1", [v.policy_id])).rows[0];
  const fam = (await c.query("select name from families where id=$1", [v.family_id])).rows[0];
  const { clauses: eff, items, chain } = await effectiveFor(c, policy, versionId);
  const history = (await c.query("select version, status, effective_from, effective_to, change_summary, approved_at from policy_versions where policy_id=$1 order by version", [v.policy_id])).rows;
  const alloc = (lens: Lens) => eff.allocations.filter((a) => a.lens === lens).map((a) => `${esc(a.key.replace(/_/g, " "))} ${a.target_pct}%${a.min_pct != null || a.max_pct != null ? ` (${a.min_pct ?? "—"}–${a.max_pct ?? "—"})` : ""}`).join(", ");
  const o = eff.objectives ?? {}, r = eff.risk ?? {}, k = eff.constraints ?? {}, p = eff.permitted ?? {}, rb = eff.rebalancing ?? {}, m = eff.monitoring ?? {}, g = eff.guardrails ?? {};
  const inherited = items.filter((i) => i.inherited).length, parentName = chain.length > 1 ? chain[chain.length - 2].name : null;
  const sec: string[] = [];
  sec.push(`<b>1. Purpose.</b> ${esc(o.purpose ?? `This policy governs the investments of ${policy.entity_name ?? policy.goal_name ?? fam?.name}.`)}${policy.goal_name ? ` Goal: ${esc(policy.goal_name)} (${policy.target_year}).` : ""}${parentName ? ` It inherits the ${esc(parentName)} and overrides ${items.length - inherited} clause${items.length - inherited === 1 ? "" : "s"}.` : ""}`);
  sec.push(`<b>2. Objectives.</b> ${o.return_objective_pct != null ? `A return of ${o.return_objective_pct}% per annum ${o.return_basis === "real" ? "above inflation" : "nominal"}` : "No numeric return objective"}${o.horizon_years ? ` over a ${o.horizon_years}-year horizon` : ""}${Number(o.spending_need_pa) > 0 ? `, sufficient to fund ₹${Number(o.spending_need_pa).toLocaleString("en-IN")} per annum in today's money` : ""}.`);
  sec.push(`<b>3. Risk.</b> Profile: ${esc(String(r.profile ?? "—").replace(/_/g, " "))}${r.score != null ? ` (score ${Math.round(Number(r.score))}${r.capacity_score != null ? `, capacity ${Math.round(Number(r.capacity_score))}, tolerance ${Math.round(Number(r.tolerance_score))}` : ""})` : ""}. ${r.max_drawdown_pct != null ? `The family accepts a maximum peak-to-trough decline of ${Math.abs(Number(r.max_drawdown_pct))}% in any year.` : ""} ${eff.risk_limits.length ? `Limits: ${eff.risk_limits.map((l) => `${l.metric.replace(/_/g, " ")} ${l.operator} ${l.limit_value}`).join("; ")}.` : ""}`);
  sec.push(`<b>4. Strategic allocation.</b> ${alloc("asset_class") || "—"}${alloc("bucket") ? `. Buckets: ${alloc("bucket")}` : ""}${eff.glide_path?.steps?.length ? `. Glide path: ${eff.glide_path.steps.map((s) => `${s.year} ${s.growth_pct ?? s.equity_pct}%`).join(" → ")}` : ""}.`);
  sec.push(`<b>5. Constraints.</b> ${k.liquidity_months != null ? `${k.liquidity_months} months of expenses in liquid assets at all times` : "No liquidity floor"}${k.tax ? `; ${[k.tax.prefer_direct_plans && "direct plans", k.tax.ltcg_first && "long-term gains realised first", k.tax.use_exemptions && "every entity's exemption used each year"].filter(Boolean).join(", ")}` : ""}${(k.legal ?? []).length ? `; legal: ${esc(k.legal.join("; "))}` : ""}${(k.unique ?? []).length ? `; unique circumstances: ${esc(k.unique.join("; "))}` : ""}.`);
  sec.push(`<b>6. Permitted and prohibited.</b> ${(p.instrument_types ?? []).length ? `Permitted: ${esc(p.instrument_types.join(", "))}.` : ""} ${p.min_rating ? `Debt rated ${esc(p.min_rating)} or better.` : ""} ${(p.prohibited ?? []).length ? `Prohibited: ${esc(p.prohibited.join(", "))}.` : ""} ${(p.managers ?? []).length ? `Approved managers: ${esc(p.managers.join(", "))}.` : ""}`);
  sec.push(`<b>7. Concentration and structure.</b> ${eff.ips_rules.length ? eff.ips_rules.map((x) => `${x.code.replace(/_/g, " ")} ${Object.values(x.params ?? {}).join("/")}${/pct/.test(x.code) || /issuer|manager/.test(x.code) ? "%" : ""}`).join("; ") : "No concentration rules"}.`);
  sec.push(`<b>8. Rebalancing.</b> ${rb.method === "both" ? "When any band is breached and at each " + (rb.calendar ?? "quarter") + "-end" : rb.method === "calendar" ? `Each ${rb.calendar ?? "quarter"}` : rb.method === "bands" ? "When any band is breached" : "As decided at review"}${rb.tolerance_pp ? ` (tolerance ${rb.tolerance_pp} pp)` : ""}${rb.use_new_cash_first ? "; new contributions first" : ""}${rb.tax_aware ? "; sales sequenced to minimise tax" : ""}.`);
  sec.push(`<b>9. Monitoring and review.</b> ${m.benchmark_code ? `Benchmark ${esc(m.benchmark_code)}` : "No benchmark"}${m.tracking_error_max_pct ? `; tracking error ≤ ${m.tracking_error_max_pct}%` : ""}; compliance evaluated nightly${(m.report_to ?? []).length ? `, reported to ${esc(m.report_to.join(" and "))}` : ""}; review every ${policy.review_every_months} months${(m.triggers ?? []).length ? ` or on trigger (${esc(m.triggers.join(", ").replace(/_/g, " "))})` : ""}.`);
  sec.push(`<b>10. Guardrails.</b> ${(g.approval_tiers ?? []).length ? `Approval tiers: ${g.approval_tiers.map((t: any) => `${t.up_to ? `≤ ₹${Number(t.up_to).toLocaleString("en-IN")}` : "above"}: ${t.approvers} approver${t.approvers > 1 ? "s" : ""}${t.cooling_off_minutes ? ` + ${t.cooling_off_minutes} min cooling-off` : ""}`).join(" · ")}.` : "Approval per the family defaults."} Prohibited instruments cannot be proposed or approved in the action plane.`);
  const signed = (v.signed_by ?? []).map((s: any) => `${esc(s.name)} (${esc(s.role)}, ${fmtD(s.signed_at)})`).join(", ");
  const approver = v.approved_by ? (await c.query("select name from users where id=$1", [v.approved_by])).rows[0]?.name : null;
  const html = `<article class="ips"><h2>Investment Policy Statement — ${esc(policy.name)} · v${v.version}</h2><p class="meta">${esc(fam?.name ?? "")} · ${esc(policy.scope)} policy${policy.entity_name ? ` · ${esc(policy.entity_name)}` : ""} · status ${esc(v.status)}${v.effective_from ? ` · effective ${fmtD(v.effective_from)}${v.effective_to ? ` to ${fmtD(v.effective_to)}` : ""}` : ""}</p>${sec.map((s) => `<p>${s}</p>`).join("")}<table class="alloc"><thead><tr><th>Clause</th><th>Value</th><th>Origin</th></tr></thead><tbody>${items.map((i) => `<tr><td>${esc(i.section)} · ${esc(i.key)}</td><td>${esc(typeof i.value === "object" ? JSON.stringify(i.value) : i.value)}</td><td>${i.inherited ? `inherited from ${esc(i.origin)}` : "this policy"}</td></tr>`).join("")}</tbody></table><p class="sign">${approver ? `Approved by ${esc(approver)} on ${fmtD(v.approved_at)}` : "Not yet approved"}${signed ? ` · Signed: ${signed}` : " · Unsigned"}.</p><p class="log">Change log: ${history.map((h) => `v${h.version} ${esc(h.status)}${h.effective_from ? ` from ${fmtD(h.effective_from)}` : ""}${h.change_summary ? ` — ${esc(h.change_summary)}` : ""}`).join(" · ")}.</p></article>`;
  await c.query("update policy_versions set document_html=$2 where id=$1", [versionId, html]);
  return html;
}

// ---------- questionnaire (FO-141) ----------
export async function respond(c: pg.PoolClient, familyId: string, userId: string, questionnaireId: string, body: { entity_id?: string | null; goal_id?: string | null; answers: Record<string, string> }) {
  const q = (await c.query("select * from risk_questionnaires where id=$1", [questionnaireId])).rows[0]; if (!q) throw new PolicyError(404, "Questionnaire not found");
  const r = scoreQuestionnaire(q.questions, q.scoring, body.answers); const t = PROFILE_TEMPLATES[r.profile];
  const model = (await c.query("select id, code, name, mix, bands from model_portfolios where code=$1 order by family_id nulls last limit 1", [t.model_code])).rows[0] ?? null;
  const ins = await c.query("insert into risk_questionnaire_responses (family_id, questionnaire_id, entity_id, goal_id, respondent_user_id, answers, score, capacity_score, tolerance_score, horizon_score, knowledge_score, profile) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning id, completed_at",
    [familyId, questionnaireId, body.entity_id ?? null, body.goal_id ?? null, userId, JSON.stringify(body.answers), r.score, r.capacity_score, r.tolerance_score, r.horizon_score, r.knowledge_score, r.profile]);
  return { response_id: ins.rows[0].id, completed_at: ins.rows[0].completed_at, ...r, suggested_model_portfolio_id: model?.id ?? null, suggested_model: model ? { code: model.code, name: model.name, mix: model.mix, bands: model.bands } : { code: t.model_code, mix: t.mix, bands: t.bands }, suggested_limits: t.limits, suggested_max_drawdown_pct: t.max_drawdown_pct, suggested_liquidity_months: t.liquidity_months };
}
export { diffClauses, validateClauses };
