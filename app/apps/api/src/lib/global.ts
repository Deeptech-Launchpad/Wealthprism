/** Global module (PRD 3.13): FX reference rates (global table, fed daily), LRS remittances against the annual limit with TCS from tax_params, and
 *  foreign tax credits per FY for Form 67. Limits and rates are data, never constants. */
import type pg from "pg";
import { pool, money } from "./db.js";
import { AllocError, today } from "./allocation.js";

const r2 = (n: number) => Math.round(n * 100) / 100;
export const fyOf = (d: string) => { const [y, m] = d.split("-").map(Number); const s = m >= 4 ? y : y - 1; return `${s}-${String(s + 1).slice(-2)}`; };
export async function fxRate(ccy: string, date = today(), source?: string | null) {
  if (ccy.toUpperCase() === "INR") return { ccy: "INR", rate_date: date, rate_inr: "1.0000", source: "identity" };
  const r = (await pool.query("select ccy, rate_date::text, rate_inr, source from fx_rates where ccy=$1 and rate_date <= $2 and ($3::text is null or source=$3) order by rate_date desc limit 1", [ccy.toUpperCase(), date, source ?? null])).rows[0];
  return r ? { ...r, rate_inr: Number(r.rate_inr).toFixed(4) } : null;
}
export async function fxRates(opts: { ccy?: string; date?: string; source?: string | null } = {}) {
  if (opts.ccy) { const r = await fxRate(opts.ccy, opts.date, opts.source); if (!r) throw new AllocError(404, `No ${opts.ccy.toUpperCase()} rate on or before ${opts.date ?? today()}`); return [r]; }
  return (await pool.query("select distinct on (ccy) ccy, rate_date::text, rate_inr, source from fx_rates where rate_date <= $1 and ($2::text is null or source=$2) order by ccy, rate_date desc", [opts.date ?? today(), opts.source ?? null])).rows.map((r) => ({ ...r, rate_inr: Number(r.rate_inr).toFixed(4) }));
}
export async function putFxRate(b: { ccy: string; rate_date: string; rate_inr: number; source?: string }) {
  if (b.rate_inr <= 0) throw new AllocError(422, "rate_inr must be positive");
  await pool.query("insert into fx_rates (ccy, rate_date, rate_inr, source) values ($1,$2,$3,$4) on conflict (ccy, rate_date, source) do update set rate_inr=excluded.rate_inr", [b.ccy.toUpperCase(), b.rate_date, b.rate_inr, b.source ?? "manual"]).catch(async () => { await pool.query("delete from fx_rates where ccy=$1 and rate_date=$2 and source=$3", [b.ccy.toUpperCase(), b.rate_date, b.source ?? "manual"]); await pool.query("insert into fx_rates (ccy, rate_date, rate_inr, source) values ($1,$2,$3,$4)", [b.ccy.toUpperCase(), b.rate_date, b.rate_inr, b.source ?? "manual"]); });
  return fxRate(b.ccy, b.rate_date, b.source ?? "manual");
}
/** Daily reference rates from a JSON feed: `{"base":"INR","date":"…","rates":{"USD":0.012}}` (frankfurter / ECB shape, inverted to INR per unit) or `{"base":"USD","rates":{"INR":83.2}}`. */
export async function ingestFxRates(json: any, source = "ecb") {
  const base = String(json.base ?? json.base_code ?? "INR").toUpperCase(); const date = String(json.date ?? today()).slice(0, 10); const rates: Record<string, number> = json.rates ?? json.conversion_rates ?? {}; let n = 0;
  if (base === "INR") { for (const [ccy, v] of Object.entries(rates)) { const x = Number(v); if (!x) continue; await putFxRate({ ccy, rate_date: date, rate_inr: r2(1 / x * 10000) / 10000, source }); n++; } }
  else if (rates.INR) { const inr = Number(rates.INR); await putFxRate({ ccy: base, rate_date: date, rate_inr: inr, source }); n++; for (const [ccy, v] of Object.entries(rates)) { if (ccy === "INR" || !Number(v)) continue; await putFxRate({ ccy, rate_date: date, rate_inr: r2(inr / Number(v) * 10000) / 10000, source }); n++; } }
  return { rows: n, note: `${n} rates for ${date} (${source})` };
}
async function param(c: pg.PoolClient, code: string, fy: string) { const r = (await c.query("select value from tax_params where code=$1 and fy <= $2 order by fy desc limit 1", [code, fy])).rows[0]; return r ? Number(r.value) : null; }
const iso = (d: any) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));
export async function lrsSummary(c: pg.PoolClient, familyId: string, fy: string, entityId?: string | null) {
  const items = (await c.query("select l.*, e.name entity_name from lrs_remittances l join entities e on e.id=l.entity_id where l.family_id=$1 and l.fy=$2 and ($3::uuid is null or l.entity_id=$3) order by l.remitted_on", [familyId, fy, entityId ?? null])).rows;
  const limit = (await param(c, "LRS_LIMIT_USD", fy)) ?? 0, threshold = (await param(c, "LRS_TCS_THRESHOLD_INR", fy)) ?? 0, tcsRate = (await param(c, "LRS_TCS_RATE_PCT", fy)) ?? 0;
  const usd = async (l: any) => { if (l.ccy === "USD") return Number(l.amount_ccy); const r = await fxRate("USD", iso(l.remitted_on)); return r ? Number(l.amount_inr) / Number(r.rate_inr) : 0; };
  const byEntity: Record<string, { entity: string; total_usd: number; total_inr: number; tcs: number }> = {};
  for (const l of items) { const e = (byEntity[l.entity_id] ??= { entity: l.entity_name, total_usd: 0, total_inr: 0, tcs: 0 }); e.total_usd += await usd(l); e.total_inr += Number(l.amount_inr); e.tcs += Number(l.tcs_collected ?? 0); }
  const rows = Object.entries(byEntity).map(([entity_id, e]) => ({ entity_id, entity: e.entity, total_usd: r2(e.total_usd), total_inr: money(e.total_inr), tcs_collected: money(e.tcs), limit_usd: limit, headroom_usd: r2(limit - e.total_usd), tcs_expected: money(Math.max(0, e.total_inr - threshold) * tcsRate / 100), over_limit: e.total_usd > limit }));
  return { fy, limit_usd: limit, tcs_threshold_inr: money(threshold), tcs_rate_pct: tcsRate, total_usd: r2(rows.reduce((s, r) => s + r.total_usd, 0)), by_entity: rows, items: items.map((l) => ({ ...l, remitted_on: iso(l.remitted_on), amount_ccy: money(l.amount_ccy), amount_inr: money(l.amount_inr), tcs_collected: l.tcs_collected == null ? null : money(l.tcs_collected) })), note: "The limit is per resident individual per FY under LRS; TCS applies to the aggregate above the threshold at the rate for overseas investment (tax_params)." };
}
export async function createLrs(c: pg.PoolClient, familyId: string, b: { entity_id: string; remitted_on: string; ccy: string; amount_ccy: number; amount_inr?: number | null; purpose?: string | null; tcs_collected?: number | null; bank_txn_id?: string | null; note?: string | null }) {
  if (!(await c.query("select 1 from entities where id=$1 and family_id=$2 and deleted_at is null", [b.entity_id, familyId])).rowCount) throw new AllocError(404, "Entity not found");
  let inr = b.amount_inr ?? null; if (inr == null) { const r = await fxRate(b.ccy, b.remitted_on); if (!r) throw new AllocError(422, `No ${b.ccy.toUpperCase()} rate for ${b.remitted_on}; pass amount_inr`); inr = r2(b.amount_ccy * Number(r.rate_inr)); }
  const fy = fyOf(b.remitted_on); const before = await lrsSummary(c, familyId, fy, b.entity_id); const priorUsd = before.by_entity[0]?.total_usd ?? 0; const usdNow = b.ccy.toUpperCase() === "USD" ? b.amount_ccy : inr / Number((await fxRate("USD", b.remitted_on))?.rate_inr ?? 83);
  const r = (await c.query("insert into lrs_remittances (family_id, entity_id, fy, remitted_on, ccy, amount_ccy, amount_inr, purpose, tcs_collected, bank_txn_id, note) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning *", [familyId, b.entity_id, fy, b.remitted_on, b.ccy.toUpperCase(), b.amount_ccy, inr, b.purpose ?? "overseas_investment", b.tcs_collected ?? 0, b.bank_txn_id ?? null, b.note ?? null])).rows[0];
  const warn = priorUsd + usdNow > before.limit_usd ? `This takes the entity to USD ${r2(priorUsd + usdNow).toLocaleString("en-IN")} in ${fy}, above the LRS limit of USD ${before.limit_usd.toLocaleString("en-IN")}` : null;
  return { ...r, amount_ccy: money(r.amount_ccy), amount_inr: money(r.amount_inr), remitted_on: iso(r.remitted_on), warning: warn };
}
export async function ftcList(c: pg.PoolClient, familyId: string, fy?: string | null, entityId?: string | null) {
  const rows = (await c.query("select f.*, e.name entity_name from foreign_tax_credits f join entities e on e.id=f.entity_id where f.family_id=$1 and ($2::text is null or f.fy=$2) and ($3::uuid is null or f.entity_id=$3) order by f.fy desc, f.country, f.income_type", [familyId, fy ?? null, entityId ?? null])).rows;
  const totals = rows.reduce((m, r) => { const k = `${r.entity_id}|${r.fy}`; const e = (m[k] ??= { entity: r.entity_name, entity_id: r.entity_id, fy: r.fy, income_inr: 0, foreign_tax_inr: 0, form67_pending: 0 }); e.income_inr += Number(r.income_inr); e.foreign_tax_inr += Number(r.foreign_tax_inr); if (!r.form67_filed_on) e.form67_pending++; return m; }, {} as Record<string, any>);
  return { items: rows.map((r) => ({ ...r, income_inr: money(r.income_inr), foreign_tax_inr: money(r.foreign_tax_inr), form67_filed_on: r.form67_filed_on ? String(r.form67_filed_on).slice(0, 10) : null })), by_entity_fy: Object.values(totals).map((t: any) => ({ ...t, income_inr: money(t.income_inr), foreign_tax_inr: money(t.foreign_tax_inr) })), note: "Credit under the DTAA article is capped at the Indian tax on the same income; Form 67 must be filed before the return to claim it." };
}
export async function createFtc(c: pg.PoolClient, familyId: string, b: { entity_id: string; fy: string; country: string; income_type: string; income_inr: number; foreign_tax_inr: number; dtaa_article?: string | null; form67_filed_on?: string | null; note?: string | null }) {
  if (!(await c.query("select 1 from entities where id=$1 and family_id=$2 and deleted_at is null", [b.entity_id, familyId])).rowCount) throw new AllocError(404, "Entity not found");
  if (b.foreign_tax_inr > b.income_inr) throw new AllocError(422, "Foreign tax cannot exceed the income it was withheld on");
  const r = (await c.query("insert into foreign_tax_credits (family_id, entity_id, fy, country, income_type, income_inr, foreign_tax_inr, dtaa_article, form67_filed_on, note) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning *", [familyId, b.entity_id, b.fy, b.country.toUpperCase(), b.income_type, b.income_inr, b.foreign_tax_inr, b.dtaa_article ?? null, b.form67_filed_on ?? null, b.note ?? null])).rows[0];
  return { ...r, income_inr: money(r.income_inr), foreign_tax_inr: money(r.foreign_tax_inr) };
}
