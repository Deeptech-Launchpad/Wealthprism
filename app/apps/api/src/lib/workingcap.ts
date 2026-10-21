/** Working capital (PRD 3.6; FO-60, 121 residue): settings, the horizon-matched, tax-aware deployment plan for the excess over the float, one task
 *  per plan line, and the ladder of what is already deployed. Yields and preferred instruments are family data in wc_settings; slab rates come
 *  from the entities; post-tax yields from @fo/finance. */
import type pg from "pg";
import { requiredFloat, deployableExcess, postTaxYield } from "@fo/finance";
import { money } from "./db.js";
import { AllocError, today } from "./allocation.js";
import { activeDepositValues } from "./depositvalue.js";

const r2 = (n: number) => Math.round(n * 100) / 100;
export type LineKind = "overnight_fund" | "liquid_fund" | "arbitrage_fund" | "bank_fd" | "target_maturity_debt";
const DEFAULT_PREFS = { instruments: { overnight_fund: "Overnight fund", liquid_fund: "Liquid fund", arbitrage_fund: "Arbitrage fund", bank_fd: "Bank fixed deposit", target_maturity_debt: "Target-maturity debt fund" }, yields: { overnight_fund: 6.0, liquid_fund: 6.5, arbitrage_fund: 7.0, bank_fd: 7.0, target_maturity_debt: 7.2 } };
const TREATMENT: Record<LineKind, "slab" | "equity_stcg" | "equity_ltcg" | "exempt"> = { overnight_fund: "slab", liquid_fund: "slab", arbitrage_fund: "equity_stcg", bank_fd: "slab", target_maturity_debt: "slab" };
const HORIZON: Record<LineKind, string> = { overnight_fund: "0–7 days", liquid_fund: "7–90 days", arbitrage_fund: "3–12 months", bank_fd: "1–3 years", target_maturity_debt: "3+ years" };

export async function wcSettings(c: pg.PoolClient, familyId: string) {
  const s = (await c.query("select * from wc_settings where family_id=$1", [familyId])).rows[0];
  const prefs = { instruments: { ...DEFAULT_PREFS.instruments, ...(s?.instrument_prefs?.instruments ?? {}) }, yields: { ...DEFAULT_PREFS.yields, ...(s?.instrument_prefs?.yields ?? {}) } };
  return { float_days: Number(s?.float_days ?? 60), buffer_months: Number(s?.buffer_months ?? 1), idle_days: Number(s?.idle_days ?? 30), instrument_prefs: prefs };
}
export async function putWcSettings(c: pg.PoolClient, familyId: string, b: { float_days?: number; buffer_months?: number; idle_days?: number; instrument_prefs?: { instruments?: Record<string, string>; yields?: Record<string, number> } }) {
  const cur = await wcSettings(c, familyId); const prefs = { instruments: { ...cur.instrument_prefs.instruments, ...(b.instrument_prefs?.instruments ?? {}) }, yields: { ...cur.instrument_prefs.yields, ...(b.instrument_prefs?.yields ?? {}) } };
  await c.query("insert into wc_settings (family_id, float_days, buffer_months, idle_days, instrument_prefs) values ($1,$2,$3,$4,$5) on conflict (family_id) do update set float_days=excluded.float_days, buffer_months=excluded.buffer_months, idle_days=excluded.idle_days, instrument_prefs=excluded.instrument_prefs", [familyId, b.float_days ?? cur.float_days, b.buffer_months ?? cur.buffer_months, b.idle_days ?? cur.idle_days, JSON.stringify(prefs)]);
  return wcSettings(c, familyId);
}
export async function wcSummary(c: pg.PoolClient, familyId: string, entityId?: string | null) {
  const s = await wcSettings(c, familyId);
  const cash = Number((await c.query("select coalesce(sum(balance),0) v from bank_accounts where family_id=$1 and deleted_at is null and type in ('savings','current') and ($2::uuid is null or entity_id=$2)", [familyId, entityId ?? null])).rows[0].v);
  const outflows = (await c.query("select due_date::text d, amount from committed_outflows where family_id=$1 and status='pending' and due_date >= current_date and ($2::uuid is null or entity_id is null or entity_id=$2) order by due_date", [familyId, entityId ?? null])).rows.map((r) => ({ dueDate: r.d, amount: Number(r.amount) }));
  const avg = Number((await c.query("select coalesce(-sum(t.amount),0)/3 v from bank_txns t join bank_accounts b on b.id=t.bank_account_id where t.family_id=$1 and t.amount < 0 and t.txn_date > current_date - 90 and not t.is_transfer and t.link_type <> 'transfer' and ($2::uuid is null or b.entity_id=$2)", [familyId, entityId ?? null])).rows[0].v);
  const input = { cash, outflows, floatDays: s.float_days, avgMonthlyOutflow: avg, bufferMonths: s.buffer_months, asOf: today() };
  return { cash, outflows, requiredFloat: requiredFloat(input), excess: deployableExcess(input), settings: s };
}
/** Horizon-matched ladder: each pending outflow inside the horizon is covered by the instrument whose liquidity matches its date; the remainder goes to the best post-tax yield among the longer buckets. */
export async function buildPlan(c: pg.PoolClient, familyId: string, opts: { amount?: number | null; entityId?: string | null; userId?: string | null } = {}) {
  const sum = await wcSummary(c, familyId, opts.entityId); const amount = r2(opts.amount ?? sum.excess); if (amount <= 0) throw new AllocError(422, "Nothing to deploy: cash is at or below the required float", { excess: money(sum.excess) });
  const slab = Number((await c.query("select coalesce(max(slab_rate), 30) v from entities where family_id=$1 and deleted_at is null and ($2::uuid is null or id=$2)", [familyId, opts.entityId ?? null])).rows[0].v);
  const y = sum.settings.instrument_prefs.yields, names = sum.settings.instrument_prefs.instruments; const day = new Date(today() + "T00:00:00Z").getTime();
  const buckets: Record<LineKind, number> = { overnight_fund: 0, liquid_fund: 0, arbitrage_fund: 0, bank_fd: 0, target_maturity_debt: 0 }; let left = amount;
  // committed outflows beyond the float horizon are matched first (the float already covers the near ones), never past the deployable amount
  for (const o of sum.outflows) { const days = Math.round((new Date(o.dueDate + "T00:00:00Z").getTime() - day) / 86400000); if (days <= sum.settings.float_days || left <= 0) continue; const k: LineKind = days <= 90 ? "liquid_fund" : days <= 365 ? "arbitrage_fund" : "bank_fd"; const a = r2(Math.min(left, o.amount)); buckets[k] += a; left = r2(left - a); }
  if (left > 0) { const post = (k: LineKind) => postTaxYield(Number(y[k]), TREATMENT[k], slab); const longer: LineKind[] = ["arbitrage_fund", "bank_fd", "target_maturity_debt"]; const best = longer.sort((a, b) => post(b) - post(a))[0]; const park = r2(Math.min(left, Math.max(0, sum.requiredFloat * 0.1))); buckets.liquid_fund += park; buckets[best] += r2(left - park); }
  const lines = (Object.keys(buckets) as LineKind[]).filter((k) => buckets[k] > 0).map((k, i) => ({ seq: i + 1, kind: k, instrument: names[k], horizon: HORIZON[k], amount: money(buckets[k]), gross_yield_pct: Number(y[k]), tax_treatment: TREATMENT[k], post_tax_yield_pct: r2(postTaxYield(Number(y[k]), TREATMENT[k], slab)), slab_rate_pct: slab }));
  const blended = amount ? r2(lines.reduce((s, l) => s + Number(l.amount) * l.post_tax_yield_pct, 0) / amount) : 0;
  // a still-'proposed' plan was never tasked or executed, so a fresh "Build plan" replaces it outright rather than leaving it around to be tasked later as a duplicate
  await c.query("delete from deployment_plans where family_id=$1 and entity_id is not distinct from $2 and status='proposed'", [familyId, opts.entityId ?? null]);
  const r = (await c.query("insert into deployment_plans (family_id, entity_id, excess_amount, lines, status, created_by) values ($1,$2,$3,$4,'proposed',$5) returning *", [familyId, opts.entityId ?? null, amount, JSON.stringify(lines), opts.userId ?? null])).rows[0];
  return planView({ ...r, lines }, { blended_post_tax_yield_pct: blended, required_float: money(sum.requiredFloat), cash: money(sum.cash) });
}
export const planView = (r: any, extra: Record<string, unknown> = {}) => ({ id: r.id, entity_id: r.entity_id, excess_amount: money(r.excess_amount), status: r.status, lines: r.lines ?? [], created_at: r.created_at, tasked_at: r.tasked_at ?? null, note: r.note ?? null, ...extra });
export async function plans(c: pg.PoolClient, familyId: string) { return (await c.query("select * from deployment_plans where family_id=$1 order by created_at desc limit 20", [familyId])).rows.map((r) => planView(r)); }
export async function planTasks(c: pg.PoolClient, familyId: string, planId: string, userId: string) {
  const p = (await c.query("select * from deployment_plans where id=$1 and family_id=$2", [planId, familyId])).rows[0]; if (!p) throw new AllocError(404, "Plan not found"); if (p.status !== "proposed") throw new AllocError(409, `Plan is ${p.status}`);
  // each rebuilt plan gets a fresh id, so dedup can't key off source_id like bucket_move does — key off the task's own identity (entity + title) while still open instead
  const out: any[] = []; for (const l of p.lines as any[]) {
    const title = `Deploy ₹${Number(l.amount).toLocaleString("en-IN")} into ${l.instrument} (${l.horizon})`;
    const dup = (await c.query("select 1 from tasks where family_id=$1 and entity_id is not distinct from $2 and source_type='deployment_plan' and title=$3 and status='open'", [familyId, p.entity_id, title])).rowCount;
    if (!dup) out.push((await c.query("insert into tasks (family_id, entity_id, module, title, reason, severity, amount, due_date, source_type, source_id, verification, created_by) values ($1,$2,'banking',$3,$4,2,$5,current_date + 2,'deployment_plan',$6,'pending','user') returning *", [familyId, p.entity_id, title, `${l.kind.replace(/_/g, " ")}: ${l.gross_yield_pct}% gross, ${l.post_tax_yield_pct}% post-tax (${l.tax_treatment}); part of the ₹${Number(p.excess_amount).toLocaleString("en-IN")} excess over the float`, l.amount, p.id])).rows[0]);
  }
  await c.query("update deployment_plans set status='tasked', tasked_at=now() where id=$1", [p.id]);
  await c.query("insert into audit_log (family_id, user_id, action, table_name, row_id, after) values ($1,$2,'wc.plan.tasks','deployment_plans',$3,$4)", [familyId, userId, p.id, JSON.stringify({ tasks: out.length })]);
  return out.map((t) => ({ ...t, amount: money(t.amount) }));
}
/** What is already deployed, by horizon: liquid / overnight funds, arbitrage, FDs and bonds with their yields and the post-tax view. */
export async function ladder(c: pg.PoolClient, familyId: string, entityId?: string | null) {
  const s = await wcSettings(c, familyId); const slab = Number((await c.query("select coalesce(max(slab_rate), 30) v from entities where family_id=$1 and deleted_at is null", [familyId])).rows[0].v);
  const rows = (await c.query(`select h.id, e.name entity, i.name instrument, i.type, i.asset_class, i.meta, round(h.quantity * coalesce(p.close, h.avg_cost), 2) value from holdings h join entities e on e.id=h.entity_id join instruments i on i.id=h.instrument_id left join lateral (select close from prices where instrument_id=i.id order by price_date desc limit 1) p on true
      where h.family_id=$1 and h.quantity > 0 and ($2::uuid is null or h.entity_id=$2) and (i.type in ('fd','bond','gsec','tbill') or i.asset_class in ('debt_mf_post_apr23','debt_mf_pre_apr23','arbitrage_fund','liquid')) order by i.type, i.name`, [familyId, entityId ?? null])).rows;
  const kindOf = (r: any): LineKind => r.asset_class === "arbitrage_fund" ? "arbitrage_fund" : /overnight/i.test(r.instrument) ? "overnight_fund" : /liquid|money market|ultra short/i.test(r.instrument) || r.type === "tbill" ? "liquid_fund" : r.type === "fd" ? "bank_fd" : "target_maturity_debt";
  const held = rows.map((r) => { const k = kindOf(r); const gross = Number(r.meta?.ytm_pct ?? r.meta?.coupon_pct ?? String(r.instrument).match(/(\d+(?:\.\d+)?)%/)?.[1] ?? s.instrument_prefs.yields[k]); return { holding_id: r.id, entity: r.entity, instrument: r.instrument, kind: k, horizon: HORIZON[k], deployed: money(r.value), gross_yield_pct: r2(gross), tax_treatment: TREATMENT[k], post_tax_yield_pct: r2(postTaxYield(gross, TREATMENT[k], slab)) }; });
  // FDs and RDs added in the Deposits tab live in their own table, so they are read here too — otherwise money already sitting in a deposit looks undeployed
  const dv = await activeDepositValues(c, familyId, entityId);
  const meta = new Map((await c.query("select d.id, d.rate_pct, e.name entity from deposits d join entities e on e.id=d.entity_id where d.family_id=$1", [familyId])).rows.map((r) => [r.id, r]));
  const deps = dv.map((d) => { const m: any = meta.get(d.id); const gross = Number(m?.rate_pct ?? s.instrument_prefs.yields.bank_fd); return { holding_id: d.id, entity: m?.entity ?? "", instrument: `${d.bank} ${d.kind.toUpperCase()}${d.account_no ? " " + d.account_no : ""}`, kind: "bank_fd" as LineKind, horizon: HORIZON.bank_fd, deployed: money(d.value), gross_yield_pct: r2(gross), tax_treatment: TREATMENT.bank_fd, post_tax_yield_pct: r2(postTaxYield(gross, TREATMENT.bank_fd, slab)) }; }).filter((d) => Number(d.deployed) > 0);
  const out = [...held, ...deps];
  const total = out.reduce((s, x) => s + Number(x.deployed), 0);
  return { rows: out, total: money(total), blended_post_tax_yield_pct: total ? r2(out.reduce((s, x) => s + Number(x.deployed) * x.post_tax_yield_pct, 0) / total) : 0, by_horizon: Object.entries(out.reduce((m, x) => { m[x.horizon] = (m[x.horizon] ?? 0) + Number(x.deployed); return m; }, {} as Record<string, number>)).map(([horizon, v]) => ({ horizon, deployed: money(v) })) };
}
