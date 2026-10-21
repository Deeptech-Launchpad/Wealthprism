/** Goals & buckets write paths and the asset-class lens (PRD 3.5; FO-44, 45): goals with links and funded %, bucket targets and glide paths,
 *  a tax-aware bucket rebalance proposal, asset-class targets from model portfolios, the allocation policy with its review cadence, and the
 *  headline / look-through status whose band breaches raise rebalancing tasks. */
import type pg from "pg";
import { bucketDrift } from "@fo/finance";
import { activeDepositValues } from "./depositvalue.js";
import { money } from "./db.js";
import { positions } from "./analytics.js";

export class AllocError extends Error { constructor(public status: number, message: string, public extra?: Record<string, unknown>) { super(message); } }
export const today = () => new Date().toISOString().slice(0, 10);
const r2 = (n: number) => Math.round(n * 100) / 100;
const addMonths = (iso: string, n: number) => { const d = new Date(iso + "T00:00:00Z"); d.setUTCMonth(d.getUTCMonth() + n); return d.toISOString().slice(0, 10); };
const BUCKETS = ["liquidity", "income", "growth"] as const; type Bucket = (typeof BUCKETS)[number];
const HOLD_SQL = `select h.id, h.entity_id, e.name entity_name, h.bucket, h.quantity, h.avg_cost, h.core_satellite, i.id instrument_id, i.name instrument, i.type, i.asset_class, coalesce(p.close, h.avg_cost) price,
    round(h.quantity * h.avg_cost, 2) cost, round(h.quantity * coalesce(p.close, h.avg_cost), 2) value, (select min(buy_date) from lots l where l.holding_id=h.id) first_buy
  from holdings h join entities e on e.id=h.entity_id join instruments i on i.id=h.instrument_id left join lateral (select close from prices where instrument_id=i.id order by price_date desc limit 1) p on true
  where h.family_id=$1 and h.quantity > 0 and ($2::uuid is null or h.entity_id=$2)`;

// ---------- goals ----------
export interface GoalInput { entity_id?: string | null; name: string; target_year: number; amount_today: number; inflation_pct?: number; bucket: Bucket; assumed_return_pct?: number; status?: string }
const inflated = (g: any) => Number(g.amount_today) * Math.pow(1 + Number(g.inflation_pct ?? 6) / 100, Math.max(0, Number(g.target_year) - new Date().getUTCFullYear()));
/** Linked value: holdings (× allocation %), private stakes at their mark and properties at their latest valuation. */
export async function goalLinkedValue(c: pg.PoolClient, familyId: string, goalId: string) {
  const rows = (await c.query(`select l.allocation_pct, l.holding_id, l.private_investment_id, l.property_id, l.deposit_id,
      (select round(h.quantity * coalesce((select close from prices p where p.instrument_id=h.instrument_id order by price_date desc limit 1), h.avg_cost), 2) from holdings h where h.id=l.holding_id) hv,
      (select coalesce((select value from private_marks m where m.private_investment_id=pi.id order by marked_on desc limit 1), pi.amount) from private_investments pi where pi.id=l.private_investment_id) pv,
      (select coalesce((select value from property_valuations v where v.property_id=p.id order by valued_on desc limit 1), p.acquisition_cost) from properties p where p.id=l.property_id) rv
    from goal_links l where l.goal_id=$1`, [goalId])).rows;
  const deposits = new Map((await activeDepositValues(c, familyId)).map((d) => [d.id, d.value]));
  return r2(rows.reduce((s, r) => s + (Number(r.hv ?? r.pv ?? r.rv ?? (r.deposit_id ? deposits.get(r.deposit_id) : 0) ?? 0) * Number(r.allocation_pct ?? 100)) / 100, 0));
}
export async function goalView(c: pg.PoolClient, familyId: string, g: any) {
  const linked = await goalLinkedValue(c, familyId, g.id); const need = inflated(g); const funded = need ? r2((linked / need) * 100) : 0;
  await c.query("update goals set funded_pct=$2 where id=$1 and funded_pct is distinct from $2", [g.id, funded]);
  const links = (await c.query(`select l.*, coalesce(i.name, co.name, p.name, dp.bank || ' ' || upper(dp.kind) || coalesce(' ' || dp.account_no, '')) name from goal_links l left join holdings h on h.id=l.holding_id left join instruments i on i.id=h.instrument_id left join private_investments pi on pi.id=l.private_investment_id left join private_companies co on co.id=pi.company_id left join properties p on p.id=l.property_id left join deposits dp on dp.id=l.deposit_id where l.goal_id=$1`, [g.id])).rows;
  const years = Math.max(0, Number(g.target_year) - new Date().getUTCFullYear()); const ret = Number(g.assumed_return_pct ?? 10) / 100; const gap = Math.max(0, need - linked * Math.pow(1 + ret, years));
  const monthly = years > 0 && ret > 0 ? gap * (ret / 12) / (Math.pow(1 + ret / 12, years * 12) - 1) : years > 0 ? gap / (years * 12) : gap;
  return { ...g, amount_today: money(g.amount_today), inflated_need: money(need), linked_value: money(linked), funded_pct: funded, gap_at_target: money(gap), monthly_required: money(monthly), years_left: years, links: links.map((l) => ({ ...l, allocation_pct: Number(l.allocation_pct ?? 100) })) };
}
export async function createGoal(c: pg.PoolClient, familyId: string, b: GoalInput) {
  if (b.entity_id && !(await c.query("select 1 from entities where id=$1 and family_id=$2 and deleted_at is null", [b.entity_id, familyId])).rowCount) throw new AllocError(404, "Entity not found");
  const r = (await c.query("insert into goals (family_id, entity_id, name, target_year, amount_today, inflation_pct, bucket, assumed_return_pct, funded_pct, status) values ($1,$2,$3,$4,$5,$6,$7,$8,0,'active') returning *", [familyId, b.entity_id ?? null, b.name, b.target_year, b.amount_today, b.inflation_pct ?? 6, b.bucket, b.assumed_return_pct ?? 10])).rows[0];
  return goalView(c, familyId, r);
}
export async function updateGoal(c: pg.PoolClient, familyId: string, id: string, b: Partial<GoalInput>) {
  const r = (await c.query("update goals set entity_id=case when $3::boolean then $4 else entity_id end, name=coalesce($5,name), target_year=coalesce($6,target_year), amount_today=coalesce($7,amount_today), inflation_pct=coalesce($8,inflation_pct), bucket=coalesce($9,bucket), assumed_return_pct=coalesce($10,assumed_return_pct), status=coalesce($11,status) where id=$1 and family_id=$2 returning *", [id, familyId, b.entity_id !== undefined, b.entity_id ?? null, b.name ?? null, b.target_year ?? null, b.amount_today ?? null, b.inflation_pct ?? null, b.bucket ?? null, b.assumed_return_pct ?? null, b.status ?? null])).rows[0];
  if (!r) throw new AllocError(404, "Goal not found"); return goalView(c, familyId, r);
}
export async function setGoalLinks(c: pg.PoolClient, familyId: string, id: string, links: { holding_id?: string | null; private_investment_id?: string | null; property_id?: string | null; deposit_id?: string | null; allocation_pct?: number }[]) {
  const g = (await c.query("select * from goals where id=$1 and family_id=$2", [id, familyId])).rows[0]; if (!g) throw new AllocError(404, "Goal not found");
  for (const l of links) {
    const n = [l.holding_id, l.private_investment_id, l.property_id, l.deposit_id].filter(Boolean).length; if (n !== 1) throw new AllocError(422, "Each link names exactly one of holding_id, private_investment_id, property_id, deposit_id");
    const ok = l.deposit_id ? (await c.query("select 1 from deposits where id=$1 and family_id=$2", [l.deposit_id, familyId])).rowCount : l.holding_id ? (await c.query("select 1 from holdings where id=$1 and family_id=$2", [l.holding_id, familyId])).rowCount : l.private_investment_id ? (await c.query("select 1 from private_investments where id=$1 and family_id=$2", [l.private_investment_id, familyId])).rowCount : (await c.query("select 1 from properties where id=$1 and family_id=$2 and deleted_at is null", [l.property_id, familyId])).rowCount;
    if (!ok) throw new AllocError(404, "Linked asset not found");
  }
  await c.query("delete from goal_links where goal_id=$1", [id]);
  for (const l of links) await c.query("insert into goal_links (goal_id, holding_id, private_investment_id, property_id, deposit_id, allocation_pct) values ($1,$2,$3,$4,$5,$6)", [id, l.holding_id ?? null, l.private_investment_id ?? null, l.property_id ?? null, l.deposit_id ?? null, l.allocation_pct ?? 100]);
  await c.query("update holdings set goal_id=case when id = any($2::uuid[]) then $1 else case when goal_id=$1 then null else goal_id end end where family_id=$3", [id, links.map((l) => l.holding_id).filter(Boolean), familyId]);
  return goalView(c, familyId, g);
}

// ---------- buckets ----------
export async function bucketTargets(c: pg.PoolClient, familyId: string, entityId?: string | null) {
  const pick = "order by effective_from desc, (policy_version_id is null) desc, id desc limit 1";   // a hand-set target of the same date beats a policy-applied one
  const t = (await c.query(`select * from bucket_targets where family_id=$1 and entity_id is not distinct from $2 ${pick}`, [familyId, entityId ?? null])).rows[0] ?? (entityId ? (await c.query(`select * from bucket_targets where family_id=$1 and entity_id is null ${pick}`, [familyId])).rows[0] : null);
  return t ? { entity_id: t.entity_id, liquidity_pct: Number(t.liquidity_pct), income_pct: Number(t.income_pct), growth_pct: Number(t.growth_pct), drift_threshold_pp: Number(t.drift_threshold_pp ?? 5), effective_from: t.effective_from, inherited: !!entityId && t.entity_id == null } : { entity_id: entityId ?? null, liquidity_pct: 8, income_pct: 32, growth_pct: 60, drift_threshold_pp: 5, effective_from: null, inherited: true };
}
export async function putBucketTargets(c: pg.PoolClient, familyId: string, b: { entity_id?: string | null; liquidity_pct: number; income_pct: number; growth_pct: number; drift_threshold_pp?: number }) {
  if (Math.abs(b.liquidity_pct + b.income_pct + b.growth_pct - 100) > 0.01) throw new AllocError(422, `Bucket targets add to ${r2(b.liquidity_pct + b.income_pct + b.growth_pct)}%; they must total 100`);
  await c.query("delete from bucket_targets where family_id=$1 and entity_id is not distinct from $2 and policy_version_id is null and effective_from = current_date", [familyId, b.entity_id ?? null]);
  await c.query("insert into bucket_targets (family_id, entity_id, liquidity_pct, income_pct, growth_pct, drift_threshold_pp, effective_from) values ($1,$2,$3,$4,$5,$6,current_date)", [familyId, b.entity_id ?? null, b.liquidity_pct, b.income_pct, b.growth_pct, b.drift_threshold_pp ?? 5]);
  return bucketTargets(c, familyId, b.entity_id ?? null);
}
export async function glidePaths(c: pg.PoolClient, familyId: string) { return (await c.query("select gp.id, gp.goal_id, g.name goal, gp.steps from glide_paths gp join goals g on g.id=gp.goal_id where gp.family_id=$1 order by g.target_year", [familyId])).rows; }
export async function putGlidePath(c: pg.PoolClient, familyId: string, b: { goal_id: string; steps: { year: number; growth_pct: number }[] }) {
  if (!(await c.query("select 1 from goals where id=$1 and family_id=$2", [b.goal_id, familyId])).rowCount) throw new AllocError(404, "Goal not found");
  const steps = [...b.steps].sort((a, z) => a.year - z.year); for (let i = 1; i < steps.length; i++) if (steps[i].growth_pct > steps[i - 1].growth_pct) throw new AllocError(422, "A glide path de-risks: growth % cannot rise from one step to the next");
  const existing = (await c.query("select id from glide_paths where family_id=$1 and goal_id=$2 and policy_version_id is null order by id limit 1", [familyId, b.goal_id])).rows[0];
  const r = existing
    ? (await c.query("update glide_paths set steps=$2 where id=$1 returning *", [existing.id, JSON.stringify(steps)])).rows[0]
    : (await c.query("insert into glide_paths (family_id, goal_id, steps) values ($1,$2,$3) returning *", [familyId, b.goal_id, JSON.stringify(steps)])).rows[0];
  return r;
}
export async function bucketValues(c: pg.PoolClient, familyId: string, entityId?: string | null) {
  const rows = (await c.query(HOLD_SQL, [familyId, entityId ?? null])).rows; const v: Record<Bucket, number> = { liquidity: 0, income: 0, growth: 0 };
  for (const r of rows) v[(r.bucket as Bucket) ?? "growth"] += Number(r.value);
  v.income += Number((await c.query("select coalesce(sum(coalesce((select value from property_valuations v where v.property_id=p.id order by valued_on desc limit 1), p.acquisition_cost) * o.ownership_pct / 100), 0) v from properties p join property_owners o on o.property_id=p.id where p.family_id=$1 and p.deleted_at is null and not p.self_occupied and ($2::uuid is null or o.entity_id=$2)", [familyId, entityId ?? null])).rows[0].v);
  v.growth += Number((await c.query("select coalesce(sum(coalesce((select value from private_marks m where m.private_investment_id=pi.id order by marked_on desc limit 1), pi.amount)), 0) v from private_investments pi where pi.family_id=$1 and pi.status <> 'written_off' and pi.instrument <> 'operating_business' and ($2::uuid is null or pi.entity_id=$2)", [familyId, entityId ?? null])).rows[0].v);
  v.liquidity += Number((await c.query("select coalesce(sum(balance),0) v from bank_accounts where family_id=$1 and deleted_at is null and type <> 'card' and ($2::uuid is null or entity_id=$2)", [familyId, entityId ?? null])).rows[0].v);
  // not added to `rows`: like a property, a deposit isn't a tradeable holding a rebalance proposal can sell to fix a breach
  for (const d of await activeDepositValues(c, familyId, entityId)) v[d.bucket as Bucket] += d.value;
  return { v, rows };
}
/** Tax rate for a sale today from tax_rules (data): term by the holding's oldest lot against the class's long-term threshold. */
async function saleTax(c: pg.PoolClient, h: any, gain: number, slabRate: number) {
  if (gain <= 0) return { tax: 0, term: "n/a", rate: 0 };
  const fy = (() => { const d = new Date(); const y = d.getUTCMonth() >= 3 ? d.getUTCFullYear() : d.getUTCFullYear() - 1; return `${y}-${String(y + 1).slice(-2)}`; })();
  const cls = ["stock", "etf"].includes(h.type) ? "equity" : h.asset_class ?? "equity";
  const rules = (await c.query("select term, rate, taxed_at_slab, holding_months_for_long from tax_rules where asset_class=$1 and fy <= $2 order by fy desc", [cls, fy])).rows; if (!rules.length) return { tax: r2(gain * slabRate / 100), term: "slab", rate: slabRate };
  const long = rules.find((r) => r.term === "long"), short = rules.find((r) => r.term === "short"); const months = h.first_buy ? (Date.now() - new Date(h.first_buy).getTime()) / (30.44 * 86400000) : 0;
  const rule = long && months >= Number(long.holding_months_for_long ?? 12) ? long : short ?? long!; const rate = rule.taxed_at_slab ? slabRate : Number(rule.rate);
  return { tax: r2(gain * rate / 100), term: rule.term, rate };
}
/** Bucket rebalance proposal: move value out of over-target buckets from the holdings with the smallest taxable gain into the under-target bucket's preferred instrument. */
export async function rebalanceProposal(c: pg.PoolClient, familyId: string, opts: { entityId?: string | null; createTasks?: boolean; userId?: string | null } = {}) {
  const { v, rows } = await bucketValues(c, familyId, opts.entityId); const t = await bucketTargets(c, familyId, opts.entityId);
  const drift = bucketDrift(v, { liquidity: t.liquidity_pct, income: t.income_pct, growth: t.growth_pct, driftThresholdPp: t.drift_threshold_pp }); const total = Object.values(v).reduce((s, x) => s + x, 0);
  const prefs = (await c.query("select instrument_prefs from wc_settings where family_id=$1", [familyId])).rows[0]?.instrument_prefs ?? {}; const slab = Number((await c.query("select coalesce(max(slab_rate), 30) v from entities where family_id=$1 and deleted_at is null", [familyId])).rows[0].v);
  const over = drift.filter((d) => d.breached && d.driftPp > 0).sort((a, b) => b.driftPp - a.driftPp), under = drift.filter((d) => d.driftPp < 0).sort((a, b) => a.driftPp - b.driftPp);
  const dest = (b: Bucket) => b === "liquidity" ? prefs.instruments?.liquid_fund ?? "Liquid fund" : b === "income" ? prefs.instruments?.target_maturity_debt ?? "Target-maturity debt fund" : rows.filter((h) => h.bucket === "growth").sort((a, b) => Number(b.value) - Number(a.value))[0]?.instrument ?? "Flexi-cap fund";
  const moves: any[] = []; let taskCount = 0;
  for (const o of over) {
    let toMove = r2((o.driftPp / 100) * total); const target = under[0]?.bucket as Bucket | undefined; if (!target || toMove <= 0) continue;
    const cands = rows.filter((h) => h.bucket === o.bucket && !["pms", "aif"].includes(h.type)).map((h) => ({ h, gainPct: Number(h.cost) ? (Number(h.value) - Number(h.cost)) / Number(h.cost) : 0 })).sort((a, b) => a.gainPct - b.gainPct);
    for (const { h } of cands) { if (toMove <= 0) break; const amt = r2(Math.min(toMove, Number(h.value))); const gain = r2(amt * (1 - Number(h.cost) / Math.max(1, Number(h.value)))); const tx = await saleTax(c, h, gain, slab);
      const m = { from_holding_id: h.id, from: h.instrument, entity: h.entity_name, from_bucket: o.bucket, to_bucket: target, to_instrument: dest(target), amount: money(amt), est_gain: money(gain), tax_impact: money(tx.tax), term: tx.term, reason: `${o.bucket} is ${o.driftPp > 0 ? "+" : ""}${o.driftPp} pp over target; ${h.instrument} carries the smallest taxable gain (${tx.term}${tx.rate ? ` @ ${tx.rate}%` : ""})`, task_id: null as string | null };
      // de-duplicated on (source_type, source_id) while open, same as every generator in jobs/tasks.ts — re-proposing an unresolved drift must not pile up a fresh task each time
      if (opts.createTasks) { const tk = (await c.query("insert into tasks (family_id, entity_id, module, title, reason, severity, amount, due_date, source_type, source_id, verification) select $1,$2,'goals',$3,$4,2,$5,current_date + 7,'bucket_move',$6,'pending' where not exists (select 1 from tasks where family_id=$1 and source_type='bucket_move' and source_id=$6 and status='open') returning id", [familyId, h.entity_id, `Move ₹${amt.toLocaleString("en-IN")} from ${h.instrument} to ${m.to_instrument}`, m.reason, amt, h.id])).rows[0]
        ?? (await c.query("select id from tasks where family_id=$1 and source_type='bucket_move' and source_id=$2 and status='open' order by created_at desc limit 1", [familyId, h.id])).rows[0];
        m.task_id = tk?.id ?? null; if (tk) taskCount++; }
      moves.push(m); toMove = r2(toMove - amt); }
  }
  // A bucket can be breached (over.length > 0) yet have nothing to sell — e.g. its value is entirely an illiquid
  // property, which bucketValues() counts toward the bucket total but which never appears in `rows` (holdings only).
  // That must not be reported the same way as "no bucket is breached" — they are different situations.
  const stuck = over.filter((o) => !moves.some((m) => m.from_bucket === o.bucket));
  const stuckNote = (o: (typeof stuck)[number]) => `${o.bucket} is ${o.driftPp > 0 ? "+" : ""}${o.driftPp} pp over target but has no tradeable holdings to sell — that value sits in property or other assets a rebalance can't move automatically; resolve it manually or accept the drift`;
  const note = over.length === 0 ? "Every bucket is within its drift threshold."
    : moves.length === 0 ? stuck.map(stuckNote).join(". ") + "."
    : "Sells ordered by the smallest taxable gain; rates from tax_rules for the year; the destination is the under-target bucket's preferred instrument." + (stuck.length ? " Also: " + stuck.map(stuckNote).join(". ") + "." : "");
  return { as_of: today(), total: money(total), targets: t, drift: drift.map((d) => ({ ...d, value: money(d.value) })), moves, tasks_created: taskCount, est_tax_total: money(moves.reduce((s, m) => s + Number(m.tax_impact), 0)), note };
}

// ---------- asset-class lens ----------
const CLASSES = ["equity", "debt", "gold", "real_estate", "cash", "global", "alternatives"] as const;
export async function modelPortfolios(c: pg.PoolClient, familyId: string) { return (await c.query("select id, family_id, code, name, risk_profile, mix, bands, notes, (family_id is null) system from model_portfolios where family_id is null or family_id=$1 order by family_id nulls first, created_at", [familyId])).rows; }
export async function createModelPortfolio(c: pg.PoolClient, familyId: string, b: { code: string; name: string; risk_profile?: string | null; mix: Record<string, number>; bands?: Record<string, [number, number]>; notes?: string | null }) {
  const sum = Object.values(b.mix).reduce((s, x) => s + Number(x), 0); if (Math.abs(sum - 100) > 0.01) throw new AllocError(422, `Model mix adds to ${r2(sum)}%; it must total 100`);
  for (const k of Object.keys(b.mix)) if (!CLASSES.includes(k as any)) throw new AllocError(422, `Unknown asset class ${k}`);
  const bands = b.bands ?? Object.fromEntries(Object.entries(b.mix).map(([k, v]) => [k, [Math.max(0, Number(v) - 10), Math.min(100, Number(v) + 10)]]));
  return (await c.query("insert into model_portfolios (family_id, code, name, risk_profile, mix, bands, notes) values ($1,$2,$3,$4,$5,$6,$7) returning *", [familyId, b.code, b.name, b.risk_profile ?? null, JSON.stringify(b.mix), JSON.stringify(bands), b.notes ?? null])).rows[0];
}
export interface AcTarget { id: string | null; entity_id: string | null; alloc_class: string; target_pct: number; min_pct: number | null; max_pct: number | null; effective_from: string | null; policy_version_id: string | null; inherited: boolean }
export async function assetClassTargets(c: pg.PoolClient, familyId: string, entityId?: string | null): Promise<AcTarget[]> {
  const rows = (await c.query("select distinct on (alloc_class) id, entity_id, alloc_class::text alloc_class, target_pct, min_pct, max_pct, effective_from::text, policy_version_id from asset_class_targets where family_id=$1 and entity_id is not distinct from $2 and effective_from <= current_date order by alloc_class, effective_from desc, id desc", [familyId, entityId ?? null])).rows;
  if (!rows.length && entityId) return (await assetClassTargets(c, familyId, null)).map((r: AcTarget) => ({ ...r, inherited: true }));
  return rows.map((r: any): AcTarget => ({ id: r.id, entity_id: r.entity_id, alloc_class: r.alloc_class, target_pct: Number(r.target_pct), min_pct: r.min_pct == null ? null : Number(r.min_pct), max_pct: r.max_pct == null ? null : Number(r.max_pct), effective_from: r.effective_from, policy_version_id: r.policy_version_id, inherited: false }));
}
export async function putAssetClassTargets(c: pg.PoolClient, familyId: string, b: { entity_id?: string | null; model_portfolio_id?: string | null; targets?: { alloc_class: string; target_pct: number; min_pct?: number | null; max_pct?: number | null }[] }) {
  let targets = b.targets ?? [];
  if (b.model_portfolio_id) { const m = (await c.query("select * from model_portfolios where id=$1 and (family_id is null or family_id=$2)", [b.model_portfolio_id, familyId])).rows[0]; if (!m) throw new AllocError(404, "Model portfolio not found"); targets = Object.entries(m.mix as Record<string, number>).map(([k, v]) => ({ alloc_class: k, target_pct: Number(v), min_pct: m.bands?.[k]?.[0] ?? null, max_pct: m.bands?.[k]?.[1] ?? null })); }
  if (!targets.length) throw new AllocError(422, "targets or model_portfolio_id required");
  const sum = targets.reduce((s, t) => s + Number(t.target_pct), 0); if (Math.abs(sum - 100) > 0.01) throw new AllocError(422, `Targets add to ${r2(sum)}%; they must total 100`);
  for (const t of targets) { if (!CLASSES.includes(t.alloc_class as any)) throw new AllocError(422, `Unknown asset class ${t.alloc_class}`); if (t.min_pct != null && t.max_pct != null && (t.min_pct > t.target_pct || t.max_pct < t.target_pct)) throw new AllocError(422, `${t.alloc_class}: the band must contain the target`); }
  await c.query("delete from asset_class_targets where family_id=$1 and entity_id is not distinct from $2 and policy_version_id is null and effective_from = current_date", [familyId, b.entity_id ?? null]);
  for (const t of targets) await c.query("insert into asset_class_targets (family_id, entity_id, alloc_class, target_pct, min_pct, max_pct, effective_from) values ($1,$2,$3::alloc_class,$4,$5,$6,current_date)", [familyId, b.entity_id ?? null, t.alloc_class, t.target_pct, t.min_pct ?? null, t.max_pct ?? null]);
  if (b.model_portfolio_id && !b.entity_id) await c.query("insert into allocation_policies (family_id, model_portfolio_id) values ($1,$2) on conflict (family_id) do update set model_portfolio_id=excluded.model_portfolio_id, updated_at=now()", [familyId, b.model_portfolio_id]);
  return assetClassTargets(c, familyId, b.entity_id ?? null);
}
export async function allocationPolicy(c: pg.PoolClient, familyId: string) {
  const p = (await c.query("select p.*, m.code model_code, m.name model_name from allocation_policies p left join model_portfolios m on m.id=p.model_portfolio_id where p.family_id=$1", [familyId])).rows[0];
  return p ? { strategy: p.strategy, model_portfolio_id: p.model_portfolio_id, model_code: p.model_code, model_name: p.model_name, review_every_months: p.review_every_months, next_review_on: p.next_review_on ? new Date(p.next_review_on).toISOString().slice(0, 10) : null, rebalance_trigger_pp: p.rebalance_trigger_pp == null ? null : Number(p.rebalance_trigger_pp), include_self_occupied: p.include_self_occupied, include_epf_ppf: p.include_epf_ppf, updated_at: p.updated_at } : { strategy: "strategic", model_portfolio_id: null, model_code: null, model_name: null, review_every_months: 6, next_review_on: null, rebalance_trigger_pp: 5, include_self_occupied: false, include_epf_ppf: true, updated_at: null };
}
export async function putAllocationPolicy(c: pg.PoolClient, familyId: string, b: { strategy?: string; model_portfolio_id?: string | null; review_every_months?: number; next_review_on?: string | null; rebalance_trigger_pp?: number; include_self_occupied?: boolean; include_epf_ppf?: boolean }) {
  const cur = await allocationPolicy(c, familyId); const months = b.review_every_months ?? cur.review_every_months ?? 6;
  const next = b.next_review_on === undefined ? cur.next_review_on ?? addMonths(today(), months) : b.next_review_on ?? addMonths(today(), months);
  await c.query("insert into allocation_policies (family_id, strategy, model_portfolio_id, review_every_months, next_review_on, rebalance_trigger_pp, include_self_occupied, include_epf_ppf, updated_at) values ($1,$2,$3,$4,$5,$6,$7,$8,now()) on conflict (family_id) do update set strategy=excluded.strategy, model_portfolio_id=excluded.model_portfolio_id, review_every_months=excluded.review_every_months, next_review_on=excluded.next_review_on, rebalance_trigger_pp=excluded.rebalance_trigger_pp, include_self_occupied=excluded.include_self_occupied, include_epf_ppf=excluded.include_epf_ppf, updated_at=now()",
    [familyId, b.strategy ?? cur.strategy, b.model_portfolio_id === undefined ? cur.model_portfolio_id : b.model_portfolio_id, months, next, b.rebalance_trigger_pp ?? cur.rebalance_trigger_pp ?? 5, b.include_self_occupied ?? cur.include_self_occupied, b.include_epf_ppf ?? cur.include_epf_ppf]);
  if (b.model_portfolio_id && b.model_portfolio_id !== cur.model_portfolio_id) await putAssetClassTargets(c, familyId, { model_portfolio_id: b.model_portfolio_id });
  return allocationPolicy(c, familyId);
}
const classOf = (p: any): string => { const k = String(p.alloc_class ?? ""); if (CLASSES.includes(k as any)) return k; if (k === "arbitrage") return "debt"; if (p.type === "property") return "real_estate"; if (p.type === "bank_account") return "cash"; if (p.type === "private_investment" || p.type === "pms" || p.type === "aif") return "alternatives"; return "equity"; };
/** Actual vs target per class — headline (each position at its own class) and look-through (funds split into their underlying) — with band breaches. */
export async function allocationStatus(c: pg.PoolClient, familyId: string, opts: { entityId?: string | null; lookThrough?: boolean } = {}) {
  const pol = await allocationPolicy(c, familyId); const targets = await assetClassTargets(c, familyId, opts.entityId);
  let pos = await positions(c, familyId, opts.entityId);
  if (!pol.include_self_occupied) { const so = (await c.query("select id from properties where family_id=$1 and self_occupied", [familyId])).rows.map((r) => r.id); pos = pos.filter((p) => !(p.type === "property" && so.includes(p.id))); }
  if (!pol.include_epf_ppf) pos = pos.filter((p) => !/\b(epf|ppf|nps)\b/i.test(String(p.name)));
  const total = pos.reduce((s, p) => s + p.value, 0); const head: Record<string, number> = {}, look: Record<string, number> = {}; let satellite = 0;
  const sats = new Set((await c.query("select id from holdings where family_id=$1 and core_satellite='satellite'", [familyId])).rows.map((r) => r.id));
  for (const p of pos) { const k = classOf(p); head[k] = (head[k] ?? 0) + p.value; if (sats.has(p.id)) satellite += p.value;
    if (p.lookthrough?.length) { let used = 0; for (const lt of p.lookthrough) { const lk = classOf({ ...p, alloc_class: lt.alloc_class ?? p.alloc_class }); look[lk] = (look[lk] ?? 0) + (p.value * lt.pct) / 100; used += lt.pct; } if (used < 99.9) look[k] = (look[k] ?? 0) + (p.value * (100 - used)) / 100; } else look[k] = (look[k] ?? 0) + p.value; }
  const classes = [...new Set([...targets.map((t: AcTarget) => t.alloc_class), ...Object.keys(head), ...Object.keys(look)])].sort((a, b) => CLASSES.indexOf(a as any) - CLASSES.indexOf(b as any));
  const rows = classes.map((k) => { const t = targets.find((x: AcTarget) => x.alloc_class === k); const actual = total ? r2(((head[k] ?? 0) / total) * 100) : 0, lt = total ? r2(((look[k] ?? 0) / total) * 100) : 0; const use = opts.lookThrough === false ? actual : lt;
    const breached = !!t && ((t.min_pct != null && use < t.min_pct) || (t.max_pct != null && use > t.max_pct)); const drift = t ? r2(use - t.target_pct) : null;
    return { alloc_class: k, target_pct: t?.target_pct ?? null, min_pct: t?.min_pct ?? null, max_pct: t?.max_pct ?? null, actual_pct: actual, look_through_pct: lt, drift_pp: drift, value: money(look[k] ?? head[k] ?? 0), band_breached: breached, status: !t ? "untargeted" : breached ? "breach" : pol.rebalance_trigger_pp != null && drift != null && Math.abs(drift) >= Number(pol.rebalance_trigger_pp) ? "drift" : "in_band" }; });
  return { as_of: today(), entity_id: opts.entityId ?? null, total: money(total), model: pol.model_name, strategy: pol.strategy, look_through: opts.lookThrough !== false, satellite_pct: total ? r2((satellite / total) * 100) : 0, breaches: rows.filter((r) => r.band_breached).length, next_review_on: pol.next_review_on, rows };
}
const classId = (k: string) => `00000000-0000-4000-9000-${Buffer.from(k.padEnd(6, "_")).toString("hex").slice(0, 12)}`;
/** Task generators: a class outside its band (rebalancing, severity by distance) and the policy review 30 days ahead. */
export async function allocationBandDrafts(c: pg.PoolClient, familyId: string) {
  const s = await allocationStatus(c, familyId, { lookThrough: true });
  const drafts = s.rows.filter((r) => r.band_breached).map((r) => ({ entity_id: null, module: "goals", title: `${r.alloc_class.replace(/_/g, " ")} outside its band — ${r.look_through_pct}% look-through vs ${r.min_pct ?? 0}–${r.max_pct ?? 100}%`, reason: `Target ${r.target_pct}% (${s.model ?? "family targets"}); rebalance or widen the band. Drift ${r.drift_pp} pp.`, severity: (Math.abs(Number(r.drift_pp)) >= 15 ? 1 : 2) as 1 | 2, source_type: "allocation_band", source_id: classId(r.alloc_class) }));
  const resolved = s.rows.filter((r) => !r.band_breached).map((r) => ({ source_type: "allocation_band", source_id: classId(r.alloc_class) }));
  return { drafts, resolved };
}
export async function allocationReviewDrafts(c: pg.PoolClient, familyId: string, day = today()) {
  const p = await allocationPolicy(c, familyId); const due = p.next_review_on && p.next_review_on <= addMonths(day, 1);
  return { drafts: due ? [{ entity_id: null, module: "goals", title: `Allocation policy review due ${p.next_review_on}`, reason: `${p.strategy} strategy on the ${p.model_name ?? "family"} model, reviewed every ${p.review_every_months} months; confirm targets and bands or record a change`, severity: 3 as const, due_date: p.next_review_on, source_type: "allocation_review", source_id: familyId }] : [], resolved: due ? [] : [{ source_type: "allocation_review", source_id: familyId }] };
}
/** Recording a review moves the next date forward by the cadence and closes the task. */
export async function recordAllocationReview(c: pg.PoolClient, familyId: string, userId: string, note?: string) {
  const p = await allocationPolicy(c, familyId); const next = addMonths(p.next_review_on ?? today(), p.review_every_months ?? 6);
  await c.query("update allocation_policies set next_review_on=$2, updated_at=now() where family_id=$1", [familyId, next]);
  await c.query("update tasks set status='done', done_at=now(), verification='verified' where family_id=$1 and source_type='allocation_review' and status='open'", [familyId]);
  await c.query("insert into audit_log (family_id, user_id, action, table_name, row_id, after) values ($1,$2,'allocation.review','allocation_policies',$1,$3)", [familyId, userId, JSON.stringify({ reviewed_on: today(), next_review_on: next, note: note ?? null })]);
  return allocationPolicy(c, familyId);
}
