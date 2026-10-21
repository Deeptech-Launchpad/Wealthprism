// Investment Policy Framework (FO-140..146): inheritance, diff, validation, risk profiling, risk metrics and
// compliance evaluation. Pure functions — the API loads clauses and portfolio snapshots and persists results.
import type { Valuation, Flow } from "./twr.js";
import { twr } from "./twr.js";

export type Lens = "bucket" | "asset_class" | "sub_class" | "geography" | "currency";
export type AllocClass = "equity" | "debt" | "gold" | "real_estate" | "cash" | "global" | "alternatives";
export type Profile = "conservative" | "moderately_conservative" | "moderate" | "moderately_aggressive" | "aggressive";
export const PROFILES: Profile[] = ["conservative", "moderately_conservative", "moderate", "moderately_aggressive", "aggressive"];

export interface AllocationClause { lens: Lens; key: string; target_pct: number; min_pct?: number | null; max_pct?: number | null }
export interface RiskLimitClause { metric: string; operator: "<=" | ">="; limit_value: number; warn_value?: number | null; severity?: number }
export interface IpsRuleClause { code: string; params: Record<string, any>; severity?: number }
export interface GlidePath { steps: { year: number; growth_pct?: number; equity_pct?: number }[] }
export interface PolicyClauses {
  objectives: Record<string, any>; risk: Record<string, any>; constraints: Record<string, any>; permitted: Record<string, any>;
  rebalancing: Record<string, any>; monitoring: Record<string, any>; guardrails: Record<string, any>;
  allocations: AllocationClause[]; risk_limits: RiskLimitClause[]; ips_rules: IpsRuleClause[]; glide_path?: GlidePath | null;
}
export const SECTIONS = ["objectives", "risk", "constraints", "permitted", "rebalancing", "monitoring", "guardrails"] as const;
export const emptyClauses = (): PolicyClauses => ({ objectives: {}, risk: {}, constraints: {}, permitted: {}, rebalancing: {}, monitoring: {}, guardrails: {}, allocations: [], risk_limits: [], ips_rules: [], glide_path: null });

const r2 = (n: number) => Math.round(n * 100) / 100 + 0;
const isEmpty = (v: any) => v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0);
const same = (a: any, b: any) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

// ---------- flattening (shared by effective view and diff) ----------
export interface FlatClause { section: string; key: string; value: any }
export function flatten(c: PolicyClauses): FlatClause[] {
  const out: FlatClause[] = [];
  for (const s of SECTIONS) for (const [k, v] of Object.entries(c[s] ?? {})) if (!isEmpty(v)) out.push({ section: s, key: k, value: v });
  for (const a of c.allocations ?? []) out.push({ section: "allocation", key: `${a.lens}:${a.key}`, value: { target_pct: Number(a.target_pct), min_pct: a.min_pct == null ? null : Number(a.min_pct), max_pct: a.max_pct == null ? null : Number(a.max_pct) } });
  for (const l of c.risk_limits ?? []) out.push({ section: "risk_limit", key: l.metric, value: { operator: l.operator, limit_value: Number(l.limit_value), warn_value: l.warn_value == null ? null : Number(l.warn_value), severity: l.severity ?? 2 } });
  for (const r of c.ips_rules ?? []) out.push({ section: "ips_rule", key: r.code, value: { params: r.params ?? {}, severity: r.severity ?? 2 } });
  if (c.glide_path?.steps?.length) out.push({ section: "glide_path", key: "steps", value: c.glide_path.steps });
  return out;
}

// ---------- inheritance: family → entity → goal ----------
export interface ChainLink { id: string; name: string; clauses: PolicyClauses }
export interface EffectiveClause extends FlatClause { origin_id: string; origin: string; inherited: boolean; parent_value: any }
/** parent ∘ override, clause by clause. Scalars merge per key; an allocation lens, a risk-limit metric, an IPS-rule code
 *  and the glide path are replaced by the child when it defines them (a lens must sum to 100 on its own). */
export function resolveEffective(chain: ChainLink[]): { clauses: PolicyClauses; items: EffectiveClause[] } {
  const eff = emptyClauses(); const origin = new Map<string, { id: string; name: string; parent_value: any }>();
  for (const link of chain) {
    const before = flatten(eff);
    for (const s of SECTIONS) for (const [k, v] of Object.entries(link.clauses[s] ?? {})) if (!isEmpty(v)) (eff[s] as any)[k] = v;
    const lenses = new Set((link.clauses.allocations ?? []).map((a) => a.lens));
    if (lenses.size) eff.allocations = [...eff.allocations.filter((a) => !lenses.has(a.lens)), ...(link.clauses.allocations ?? [])];
    for (const l of link.clauses.risk_limits ?? []) eff.risk_limits = [...eff.risk_limits.filter((x) => x.metric !== l.metric), l];
    for (const r of link.clauses.ips_rules ?? []) eff.ips_rules = [...eff.ips_rules.filter((x) => x.code !== r.code), r];
    if (link.clauses.glide_path?.steps?.length) eff.glide_path = link.clauses.glide_path;
    for (const f of flatten(eff)) { const prev = before.find((b) => b.section === f.section && b.key === f.key); if (!prev || !same(prev.value, f.value)) origin.set(`${f.section}|${f.key}`, { id: link.id, name: link.name, parent_value: prev?.value ?? null }); }
  }
  const last = chain[chain.length - 1];
  const items = flatten(eff).map((f) => { const o = origin.get(`${f.section}|${f.key}`)!; return { ...f, origin_id: o.id, origin: o.name, inherited: o.id !== last?.id, parent_value: o.parent_value }; });
  return { clauses: eff, items };
}

/** Changed clauses only. */
export function diffClauses(a: PolicyClauses, b: PolicyClauses): { section: string; key: string; before: any; after: any }[] {
  const fa = flatten(a), fb = flatten(b); const out: { section: string; key: string; before: any; after: any }[] = [];
  for (const x of fa) { const y = fb.find((f) => f.section === x.section && f.key === x.key); if (!y) out.push({ section: x.section, key: x.key, before: x.value, after: null }); else if (!same(x.value, y.value)) out.push({ section: x.section, key: x.key, before: x.value, after: y.value }); }
  for (const y of fb) if (!fa.some((f) => f.section === y.section && f.key === y.key)) out.push({ section: y.section, key: y.key, before: null, after: y.value });
  return out;
}

export function validateClauses(c: PolicyClauses): { field: string; message: string }[] {
  const errs: { field: string; message: string }[] = [];
  const byLens: Record<string, AllocationClause[]> = {};
  for (const a of c.allocations ?? []) (byLens[a.lens] ??= []).push(a);
  for (const [lens, rows] of Object.entries(byLens)) {
    const sum = rows.reduce((t, a) => t + Number(a.target_pct), 0);
    if (Math.abs(sum - 100) > 0.5) errs.push({ field: `allocations.${lens}`, message: `${lens} targets sum to ${r2(sum)}%, not 100 ± 0.5` });
    for (const a of rows) {
      if (a.min_pct != null && Number(a.min_pct) > Number(a.target_pct)) errs.push({ field: `allocations.${lens}.${a.key}`, message: `min ${a.min_pct} above target ${a.target_pct}` });
      if (a.max_pct != null && Number(a.max_pct) < Number(a.target_pct)) errs.push({ field: `allocations.${lens}.${a.key}`, message: `max ${a.max_pct} below target ${a.target_pct}` });
    }
    const keys = rows.map((a) => a.key); if (new Set(keys).size !== keys.length) errs.push({ field: `allocations.${lens}`, message: "duplicate key" });
  }
  for (const l of c.risk_limits ?? []) {
    if (!["<=", ">="].includes(l.operator)) errs.push({ field: `risk_limits.${l.metric}`, message: "operator must be <= or >=" });
    if (l.warn_value != null && ((l.operator === "<=" && Number(l.warn_value) > Number(l.limit_value)) || (l.operator === ">=" && Number(l.warn_value) < Number(l.limit_value)))) errs.push({ field: `risk_limits.${l.metric}`, message: "warn threshold must sit inside the limit" });
  }
  if (c.permitted?.min_rating && ratingRank(c.permitted.min_rating) < 0) errs.push({ field: "permitted.min_rating", message: `unknown rating ${c.permitted.min_rating}` });
  if (c.constraints?.liquidity_months != null && Number(c.constraints.liquidity_months) < 0) errs.push({ field: "constraints.liquidity_months", message: "must be ≥ 0" });
  return errs;
}

// ---------- risk profiling (FO-141) ----------
export interface Question { id: string; dimension: "capacity" | "tolerance" | "horizon" | "knowledge"; text: string; options: { label: string; score: number }[] }
export interface Scoring { weights: Record<string, number>; bands: { max: number; profile: Profile }[] }
export interface ProfileResult { score: number; capacity_score: number; tolerance_score: number; horizon_score: number; knowledge_score: number; profile: Profile; notes: string[] }
/** Dimension scores are 0–100 (option scores 1..5 → 0..100). Profile = the lower of the capacity and tolerance bands
 *  (capacity caps tolerance), stepped down one band when the horizon is short (≤ 25); the weighted score is reported for display. */
export function scoreQuestionnaire(questions: Question[], scoring: Scoring, answers: Record<string, string>): ProfileResult {
  const dims: Record<string, number[]> = {};
  for (const q of questions) { const opt = q.options.find((o) => o.label === answers[q.id]); if (opt) (dims[q.dimension] ??= []).push(Number(opt.score)); }
  const d = (k: string) => { const a = dims[k] ?? []; return a.length ? r2((a.reduce((s, x) => s + x, 0) / a.length - 1) / 4 * 100) : 50; };
  const capacity = d("capacity"), tolerance = d("tolerance"), horizon = d("horizon"), knowledge = d("knowledge");
  const w = scoring.weights; const score = r2(capacity * (w.capacity ?? 0) + tolerance * (w.tolerance ?? 0) + horizon * (w.horizon ?? 0) + knowledge * (w.knowledge ?? 0));
  const band = (v: number): Profile => scoring.bands.find((b) => v <= b.max)?.profile ?? "aggressive";
  const notes: string[] = [];
  let idx = Math.min(PROFILES.indexOf(band(capacity)), PROFILES.indexOf(band(tolerance)));
  if (band(capacity) !== band(tolerance) && PROFILES.indexOf(band(capacity)) < PROFILES.indexOf(band(tolerance))) notes.push("capacity caps tolerance");
  if (horizon <= 25 && idx > 0) { idx--; notes.push("short horizon pulls the band down"); }
  return { score, capacity_score: capacity, tolerance_score: tolerance, horizon_score: horizon, knowledge_score: knowledge, profile: PROFILES[idx], notes };
}

/** Starting points per profile: model mix + bands, drawdown, liquidity, limit set. Data, not law — families edit them in the builder. */
export const PROFILE_TEMPLATES: Record<Profile, { model_code: string; mix: Record<string, number>; bands: Record<string, [number, number]>; max_drawdown_pct: number; liquidity_months: number; limits: RiskLimitClause[] }> = {
  conservative: { model_code: "conservative", mix: { equity: 30, debt: 60, gold: 10 }, bands: { equity: [20, 40], debt: [50, 70], gold: [5, 15] }, max_drawdown_pct: -8, liquidity_months: 36,
    limits: [{ metric: "volatility_1y", operator: "<=", limit_value: 8, warn_value: 6 }, { metric: "max_drawdown", operator: ">=", limit_value: -8, warn_value: -6 }, { metric: "var_95_1m", operator: "<=", limit_value: 2.5, warn_value: 2 }, { metric: "beta", operator: "<=", limit_value: 0.4, warn_value: 0.35 }, { metric: "concentration_top5", operator: "<=", limit_value: 40, warn_value: 35 }, { metric: "issuer_max", operator: "<=", limit_value: 10, warn_value: 8 }, { metric: "manager_max", operator: "<=", limit_value: 25, warn_value: 20 }, { metric: "illiquid_max", operator: "<=", limit_value: 5, warn_value: 4 }, { metric: "liquidity_coverage_months_min", operator: ">=", limit_value: 36, warn_value: 40 }, { metric: "unrated_debt_max", operator: "<=", limit_value: 0 }] },
  moderately_conservative: { model_code: "moderately_conservative", mix: { equity: 45, debt: 40, gold: 10, cash: 5 }, bands: { equity: [35, 55], debt: [30, 50], gold: [3, 15], cash: [3, 10] }, max_drawdown_pct: -12, liquidity_months: 36,
    limits: [{ metric: "volatility_1y", operator: "<=", limit_value: 14, warn_value: 11 }, { metric: "max_drawdown", operator: ">=", limit_value: -12, warn_value: -9 }, { metric: "var_95_1m", operator: "<=", limit_value: 4, warn_value: 3 }, { metric: "beta", operator: "<=", limit_value: 0.7, warn_value: 0.6 }, { metric: "tracking_error", operator: "<=", limit_value: 3, warn_value: 2 }, { metric: "concentration_top5", operator: "<=", limit_value: 45, warn_value: 40 }, { metric: "issuer_max", operator: "<=", limit_value: 10, warn_value: 8 }, { metric: "manager_max", operator: "<=", limit_value: 25, warn_value: 20 }, { metric: "illiquid_max", operator: "<=", limit_value: 10, warn_value: 8 }, { metric: "liquidity_coverage_months_min", operator: ">=", limit_value: 36, warn_value: 40 }, { metric: "unrated_debt_max", operator: "<=", limit_value: 0 }] },
  moderate: { model_code: "moderate", mix: { equity: 60, debt: 30, gold: 10 }, bands: { equity: [50, 70], debt: [20, 40], gold: [5, 15] }, max_drawdown_pct: -20, liquidity_months: 24,
    limits: [{ metric: "volatility_1y", operator: "<=", limit_value: 18, warn_value: 15 }, { metric: "max_drawdown", operator: ">=", limit_value: -20, warn_value: -15 }, { metric: "var_95_1m", operator: "<=", limit_value: 6, warn_value: 5 }, { metric: "beta", operator: "<=", limit_value: 0.9, warn_value: 0.8 }, { metric: "concentration_top5", operator: "<=", limit_value: 50, warn_value: 45 }, { metric: "issuer_max", operator: "<=", limit_value: 10, warn_value: 8 }, { metric: "manager_max", operator: "<=", limit_value: 25, warn_value: 20 }, { metric: "illiquid_max", operator: "<=", limit_value: 25, warn_value: 20 }, { metric: "liquidity_coverage_months_min", operator: ">=", limit_value: 24, warn_value: 27 }, { metric: "unrated_debt_max", operator: "<=", limit_value: 5, warn_value: 3 }] },
  moderately_aggressive: { model_code: "growth_70_15_15", mix: { equity: 70, debt: 15, gold: 15 }, bands: { equity: [60, 80], debt: [10, 25], gold: [5, 20] }, max_drawdown_pct: -25, liquidity_months: 18,
    limits: [{ metric: "volatility_1y", operator: "<=", limit_value: 22, warn_value: 18 }, { metric: "max_drawdown", operator: ">=", limit_value: -25, warn_value: -20 }, { metric: "var_95_1m", operator: "<=", limit_value: 8, warn_value: 6.5 }, { metric: "beta", operator: "<=", limit_value: 1.1, warn_value: 1 }, { metric: "concentration_top5", operator: "<=", limit_value: 55, warn_value: 50 }, { metric: "issuer_max", operator: "<=", limit_value: 12, warn_value: 10 }, { metric: "manager_max", operator: "<=", limit_value: 30, warn_value: 25 }, { metric: "illiquid_max", operator: "<=", limit_value: 30, warn_value: 25 }, { metric: "liquidity_coverage_months_min", operator: ">=", limit_value: 18, warn_value: 21 }, { metric: "unrated_debt_max", operator: "<=", limit_value: 10, warn_value: 7 }] },
  aggressive: { model_code: "aggressive", mix: { equity: 80, debt: 12, gold: 8 }, bands: { equity: [70, 90], debt: [5, 20], gold: [3, 12] }, max_drawdown_pct: -35, liquidity_months: 12,
    limits: [{ metric: "volatility_1y", operator: "<=", limit_value: 28, warn_value: 24 }, { metric: "max_drawdown", operator: ">=", limit_value: -35, warn_value: -28 }, { metric: "var_95_1m", operator: "<=", limit_value: 10, warn_value: 8.5 }, { metric: "beta", operator: "<=", limit_value: 1.3, warn_value: 1.2 }, { metric: "concentration_top5", operator: "<=", limit_value: 60, warn_value: 55 }, { metric: "issuer_max", operator: "<=", limit_value: 15, warn_value: 12 }, { metric: "manager_max", operator: "<=", limit_value: 35, warn_value: 30 }, { metric: "illiquid_max", operator: "<=", limit_value: 40, warn_value: 35 }, { metric: "liquidity_coverage_months_min", operator: ">=", limit_value: 12, warn_value: 15 }, { metric: "unrated_debt_max", operator: "<=", limit_value: 15, warn_value: 10 }] },
};

// ---------- classification helpers ----------
const RATINGS = ["D", "C", "B-", "B", "B+", "BB-", "BB", "BB+", "BBB-", "BBB", "BBB+", "A-", "A", "A+", "AA-", "AA", "AA+", "AAA", "SOV"];
export const ratingRank = (r: string | null | undefined) => (r ? RATINGS.indexOf(String(r).toUpperCase().replace(/\s|\(.*\)|CRISIL|ICRA|CARE|IND/g, "")) : -1);
/** instruments.asset_class (tax lens) + type → allocation class (policy lens). Properties → real_estate, private → alternatives, bank → cash. */
export function allocClassOf(assetClass: string | null | undefined, type?: string | null, hint?: string | null): AllocClass {
  const a = (assetClass ?? "").toLowerCase(), t = (type ?? "").toLowerCase(), h = (hint ?? "").toLowerCase();
  if (/\b(liquid|overnight|money market|arbitrage|ultra short)\b/.test(h) && (t === "mf" || t === "etf")) return "cash"; // cash-like funds by scheme name / sub-class
  if (t === "aif" || a.includes("private") || a.includes("alternative")) return "alternatives";
  if (a.includes("intl") || a.includes("global") || a.includes("international") || a.includes("foreign")) return "global";
  if (a.includes("gold") || a.includes("silver") || t === "sgb" || t === "gold") return "gold";
  if (a.includes("reit") || a.includes("invit") || a.includes("real_estate")) return "real_estate";
  if (a.includes("equity") || t === "stock" || t === "pms") return "equity";
  if (a.includes("arbitrage") || a.includes("liquid") || a.includes("overnight") || t === "tbill" || t === "fd" || t === "rd") return "cash";
  return "debt";
}

// ---------- risk metrics (FO-143) ----------
export interface SeriesMetrics { volatility_1y: number | null; max_drawdown: number | null; var_95_1m: number | null; beta: number | null; tracking_error: number | null; sharpe: number | null; periods: number; annual_return: number | null }
const mean = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
const stdev = (a: number[]) => { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };
/** Periodic (flow-adjusted) returns from a valuation series, one per interval. */
export function periodicReturns(valuations: Valuation[], flows: Flow[] = []): { date: string; ret: number }[] {
  if (valuations.length < 2) return [];
  return twr(valuations, flows).subPeriods.map((s) => ({ date: s.to, ret: s.ret }));
}
export function seriesMetrics(returns: number[], opts: { periodsPerYear?: number; benchmark?: number[] | null; riskFreePct?: number; minPeriods?: number } = {}): SeriesMetrics {
  const ppy = opts.periodsPerYear ?? 12, minN = opts.minPeriods ?? 6, rf = (opts.riskFreePct ?? 6.5) / 100;
  const n = returns.length; const none: SeriesMetrics = { volatility_1y: null, max_drawdown: null, var_95_1m: null, beta: null, tracking_error: null, sharpe: null, periods: n, annual_return: null };
  if (n < minN) return none;
  const vol = stdev(returns) * Math.sqrt(ppy);
  let idx = 1, peak = 1, mdd = 0; for (const r of returns) { idx *= 1 + r; peak = Math.max(peak, idx); mdd = Math.min(mdd, idx / peak - 1); }
  const sorted = [...returns].sort((a, b) => a - b); const pos = 0.05 * (n - 1); const lo = Math.floor(pos), hi = Math.ceil(pos); const p5 = sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
  const var95 = Math.max(0, -p5) * Math.sqrt(12 / ppy);
  const annual = Math.pow(idx, ppy / n) - 1;
  const sharpe = vol > 0 ? (annual - rf) / vol : null;
  let beta: number | null = null, te: number | null = null;
  const b = opts.benchmark; if (b && b.length === n && n >= minN) {
    const mb = mean(b), mr = mean(returns); const cov = returns.reduce((s, r, i) => s + (r - mr) * (b[i] - mb), 0) / (n - 1); const vb = stdev(b) ** 2;
    beta = vb > 0 ? cov / vb : null; te = stdev(returns.map((r, i) => r - b[i])) * Math.sqrt(ppy);
  }
  const pct = (x: number | null) => (x == null ? null : r2(x * 100));
  return { volatility_1y: pct(vol), max_drawdown: pct(mdd), var_95_1m: pct(var95), beta: beta == null ? null : r2(beta), tracking_error: pct(te), sharpe: sharpe == null ? null : r2(sharpe), periods: n, annual_return: pct(annual) };
}

export interface Position { id: string; name?: string; value: number; allocClass: AllocClass; instrumentType?: string | null; issuer?: string | null; manager?: string | null; sector?: string | null; rating?: string | null; liquidityClass?: string | null; currency?: string | null; modifiedDuration?: number | null; marketCapBand?: string | null }
export interface ConcentrationMetrics { total: number; concentration_top5: number | null; issuer_max: number | null; issuer_top: string | null; manager_max: number | null; manager_top: string | null; sector_max: number | null; sector_top: string | null; illiquid_max: number; unrated_debt_max: number; fx_exposure_max: number; duration_max: number | null; single_stock_max: number; single_stock_top: string | null }
const PSEUDO_TYPES = new Set(["cash", "private", "property", "deposit"]); // not instruments: never judged by the permitted-types clause
const ILLIQUID = new Set(["quarterly", "locked", "annual"]);
export const isIlliquid = (p: Position) => ILLIQUID.has(String(p.liquidityClass ?? "").toLowerCase()) || ["pms", "aif"].includes(String(p.instrumentType ?? "").toLowerCase()) || p.allocClass === "alternatives" || p.allocClass === "real_estate";
export function concentration(positions: Position[]): ConcentrationMetrics {
  const total = positions.reduce((s, p) => s + Math.max(0, p.value), 0);
  const share = (v: number) => (total ? r2(v / total * 100) : 0);
  const maxBy = (key: (p: Position) => string | null | undefined) => { const m = new Map<string, number>(); for (const p of positions) { const k = key(p); if (k) m.set(k, (m.get(k) ?? 0) + p.value); } let top: string | null = null, v = 0; for (const [k, x] of m) if (x > v) { v = x; top = k; } return { pct: share(v), top }; };
  const top5 = [...positions].sort((a, b) => b.value - a.value).slice(0, 5).reduce((s, p) => s + p.value, 0);
  const small = positions.length < 3; // issuer / manager / sector shares are undefined for a one- or two-position sleeve
  const issuer = maxBy((p) => p.issuer ?? (p.instrumentType === "stock" ? p.name : null)), manager = maxBy((p) => p.manager), sector = maxBy((p) => p.sector);
  const debt = positions.filter((p) => p.allocClass === "debt"); const debtV = debt.reduce((s, p) => s + p.value, 0);
  const unrated = debt.filter((p) => ratingRank(p.rating) < 0 && !["gsec", "tbill", "fd", "rd", "ppf", "epf", "nps"].includes(String(p.instrumentType ?? ""))).reduce((s, p) => s + p.value, 0);
  const durW = debt.filter((p) => p.modifiedDuration != null); const dur = durW.length ? r2(durW.reduce((s, p) => s + p.value * Number(p.modifiedDuration), 0) / durW.reduce((s, p) => s + p.value, 0)) : null;
  const stock = maxBy((p) => (p.instrumentType === "stock" ? p.name ?? p.id : null));
  return { total: r2(total), concentration_top5: positions.length > 5 ? share(top5) : null, // undefined for a book of five positions or fewer
    issuer_max: small ? null : issuer.pct, issuer_top: issuer.top, manager_max: small ? null : manager.pct, manager_top: manager.top, sector_max: small ? null : sector.pct, sector_top: sector.top,
    illiquid_max: share(positions.filter(isIlliquid).reduce((s, p) => s + p.value, 0)), unrated_debt_max: debtV ? r2(unrated / debtV * 100) : 0, fx_exposure_max: share(positions.filter((p) => p.currency && p.currency !== "INR").reduce((s, p) => s + p.value, 0)), duration_max: dur, single_stock_max: stock.pct, single_stock_top: stock.top };
}

// ---------- expected return / volatility of a target mix ----------
/** Long-run nominal assumptions per allocation class (editable in the builder's assumptions; indicative, not advice). */
export const CLASS_ASSUMPTIONS: Record<AllocClass, { ret: number; vol: number }> = { equity: { ret: 12, vol: 16 }, debt: { ret: 7, vol: 3 }, gold: { ret: 8, vol: 14 }, real_estate: { ret: 8, vol: 10 }, cash: { ret: 5.5, vol: 0.5 }, global: { ret: 10, vol: 15 }, alternatives: { ret: 13, vol: 20 } };
export function expectedPortfolio(mix: Record<string, number>, assumptions = CLASS_ASSUMPTIONS, corr = 0.3): { ret: number; vol: number } {
  const w = Object.entries(mix).map(([k, p]) => ({ w: Number(p) / 100, a: assumptions[k as AllocClass] ?? { ret: 7, vol: 8 } }));
  const ret = w.reduce((s, x) => s + x.w * x.a.ret, 0);
  let v = 0; for (const i of w) for (const j of w) v += i.w * j.w * i.a.vol * j.a.vol * (i === j ? 1 : corr);
  return { ret: r2(ret), vol: r2(Math.sqrt(v)) };
}

// ---------- compliance (FO-144) ----------
export type CheckStatus = "in_band" | "warning" | "breach" | "n/a";
export interface Check { kind: "allocation" | "risk_limit" | "permitted" | "ips_rule" | "liquidity" | "glide_path"; key: string; target: string; actual: string; status: CheckStatus; detail: string; severity?: number }
export interface Snapshot { allocation: Partial<Record<Lens, Record<string, number>>>; metrics: Record<string, number | null>; positions: Position[]; liquidityMonths: number | null; year: number }
export interface Compliance { overall: "compliant" | "warning" | "breach"; checks: Check[]; breaches: number; warnings: number }
const fmt = (n: number | null | undefined, unit = "%") => (n == null ? "—" : `${r2(n)}${unit}`);
const glideTarget = (g: GlidePath | null | undefined, year: number): number | null => {
  const steps = (g?.steps ?? []).map((s) => ({ year: Number(s.year), pct: Number(s.growth_pct ?? s.equity_pct) })).filter((s) => !isNaN(s.pct)).sort((a, b) => a.year - b.year);
  if (!steps.length) return null; if (year <= steps[0].year) return steps[0].pct; if (year >= steps[steps.length - 1].year) return steps[steps.length - 1].pct;
  for (let i = 1; i < steps.length; i++) if (year <= steps[i].year) { const a = steps[i - 1], b = steps[i]; return r2(a.pct + (b.pct - a.pct) * (year - a.year) / (b.year - a.year)); }
  return null;
};
export function evaluateCompliance(eff: PolicyClauses, snap: Snapshot, opts: { bandWarnPp?: number } = {}): Compliance {
  const warnPp = opts.bandWarnPp ?? 1; const checks: Check[] = [];
  const empty = !snap.positions.length;
  for (const a of eff.allocations ?? []) {
    const actual = snap.allocation[a.lens]?.[a.key] ?? 0; const min = a.min_pct == null ? null : Number(a.min_pct), max = a.max_pct == null ? null : Number(a.max_pct);
    const miss = min != null && actual < min ? min - actual : max != null && actual > max ? actual - max : 0;
    const status: CheckStatus = empty ? "n/a" : miss === 0 ? "in_band" : miss <= warnPp ? "warning" : "breach";
    checks.push({ kind: "allocation", key: `${a.lens}:${a.key}`, target: `${a.target_pct}%${min != null || max != null ? ` (${min ?? "—"}–${max ?? "—"})` : ""}`, actual: fmt(actual), status, detail: miss ? `${r2(miss)} pp ${actual < Number(min) ? "below" : "above"} the band` : "" });
  }
  for (const l of eff.risk_limits ?? []) {
    const v = snap.metrics[l.metric]; const lim = Number(l.limit_value), warn = l.warn_value == null ? null : Number(l.warn_value);
    let status: CheckStatus = "n/a"; let detail = "not enough history";
    if (v != null) { const okLim = l.operator === "<=" ? v <= lim : v >= lim; const okWarn = warn == null ? true : l.operator === "<=" ? v <= warn : v >= warn; status = !okLim ? "breach" : !okWarn ? "warning" : "in_band"; detail = status === "warning" ? `soft threshold ${warn}, hard ${lim}` : ""; }
    checks.push({ kind: "risk_limit", key: l.metric, target: `${l.operator} ${lim}`, actual: fmt(v, ["beta", "sharpe", "duration_max"].includes(l.metric) ? "" : l.metric.includes("months") ? " mo" : "%"), status, detail, severity: l.severity });
  }
  if (eff.constraints?.liquidity_months != null) {
    const need = Number(eff.constraints.liquidity_months), have = snap.liquidityMonths;
    const status: CheckStatus = have == null || need <= 0 ? "n/a" : have < need ? "breach" : have < need * 1.1 ? "warning" : "in_band";
    checks.push({ kind: "liquidity", key: "liquidity_coverage", target: `≥ ${need} months`, actual: have == null ? "—" : `${r2(have)} months`, status, detail: status === "breach" ? `${r2(need - (have ?? 0))} months short` : "" });
  }
  const perm = eff.permitted ?? {}; const total = snap.positions.reduce((s, p) => s + p.value, 0) || 1;
  if (Array.isArray(perm.prohibited) && perm.prohibited.length) {
    const hits: string[] = [];
    for (const rule of perm.prohibited as string[]) { const r = rule.toLowerCase();
      const m = r.match(/single[_ ]stocks?[_ ]?(?:>|above|over)?\s*(\d+(?:\.\d+)?)/); if (m) { const cap = Number(m[1]); for (const p of snap.positions) if (p.instrumentType === "stock" && p.value / total * 100 > cap) hits.push(`${p.name ?? p.id} ${r2(p.value / total * 100)}% > ${cap}%`); continue; }
      if (r.includes("unrated")) { for (const p of snap.positions) if (p.allocClass === "debt" && ratingRank(p.rating) < 0 && !["gsec", "tbill", "fd", "rd", "ppf", "epf", "nps"].includes(String(p.instrumentType ?? ""))) hits.push(`${p.name ?? p.id} (unrated debt)`); continue; }
      for (const p of snap.positions) if (String(p.instrumentType ?? "").toLowerCase() === r || String(p.sector ?? "").toLowerCase() === r || (p.name ?? "").toLowerCase().includes(r)) hits.push(`${p.name ?? p.id} (${rule})`);
    }
    checks.push({ kind: "permitted", key: "prohibited", target: "none held", actual: hits.length ? `${hits.length} held` : "none", status: hits.length ? "breach" : "in_band", detail: hits.join("; ") });
  }
  if (Array.isArray(perm.instrument_types) && perm.instrument_types.length) {
    const allowed = new Set((perm.instrument_types as string[]).map((x) => x.toLowerCase())); const off = snap.positions.filter((p) => p.instrumentType && !PSEUDO_TYPES.has(String(p.instrumentType)) && !allowed.has(String(p.instrumentType).toLowerCase()));
    checks.push({ kind: "permitted", key: "instrument_types", target: [...allowed].join(", "), actual: off.length ? `${off.length} outside` : "all permitted", status: off.length ? "breach" : "in_band", detail: off.map((p) => `${p.name ?? p.id} (${p.instrumentType})`).join("; ") });
  }
  if (perm.min_rating) {
    const min = ratingRank(perm.min_rating); const off = snap.positions.filter((p) => p.allocClass === "debt" && p.instrumentType === "bond" && ratingRank(p.rating) >= 0 && ratingRank(p.rating) < min);
    checks.push({ kind: "permitted", key: "min_rating", target: `≥ ${perm.min_rating}`, actual: off.length ? `${off.length} below` : "all at or above", status: off.length ? "breach" : "in_band", detail: off.map((p) => `${p.name ?? p.id} ${p.rating}`).join("; ") });
  }
  const m = snap.metrics;
  for (const r of eff.ips_rules ?? []) {
    const p = r.params ?? {}; let target = "", actual: number | null = null, status: CheckStatus = "n/a", detail = "";
    const le = (v: number | null, cap: number) => (v == null ? "n/a" : v > cap ? "breach" : v > cap * 0.9 ? "warning" : "in_band") as CheckStatus;
    switch (r.code) {
      case "max_single_issuer": target = `≤ ${p.pct}%`; actual = m.issuer_max ?? null; status = le(actual, Number(p.pct)); detail = String((m as any).issuer_top ?? ""); break;
      case "max_single_manager": target = `≤ ${p.pct}%`; actual = m.manager_max ?? null; status = le(actual, Number(p.pct)); detail = String((m as any).manager_top ?? ""); break;
      case "max_sector_pct": target = `≤ ${p.pct}%`; actual = m.sector_max ?? null; status = le(actual, Number(p.pct)); detail = String((m as any).sector_top ?? ""); break;
      case "max_illiquid_pct": target = `≤ ${p.pct}%`; actual = m.illiquid_max ?? null; status = le(actual, Number(p.pct)); break;
      case "max_unrated_pct": target = `≤ ${p.pct}%`; actual = m.unrated_debt_max ?? null; status = le(actual, Number(p.pct)); break;
      case "max_leverage_pct": target = `≤ ${p.pct}%`; actual = m.leverage_max ?? null; status = le(actual, Number(p.pct)); break;
      case "max_fx_pct": target = `≤ ${p.pct}%`; actual = m.fx_exposure_max ?? null; status = le(actual, Number(p.pct)); break;
      case "max_duration": target = `≤ ${p.years} y`; actual = m.duration_max ?? null; status = le(actual, Number(p.years)); break;
      case "min_liquidity_months": target = `≥ ${p.months} mo`; actual = snap.liquidityMonths; status = actual == null ? "n/a" : actual < Number(p.months) ? "breach" : actual < Number(p.months) * 1.1 ? "warning" : "in_band"; break;
      case "min_credit_rating": { const min = ratingRank(p.rating); const off = snap.positions.filter((x) => x.instrumentType === "bond" && ratingRank(x.rating) >= 0 && ratingRank(x.rating) < min); target = `≥ ${p.rating}`; status = off.length ? "breach" : "in_band"; detail = off.map((x) => `${x.name} ${x.rating}`).join("; "); break; }
      default: target = JSON.stringify(p); detail = "rule not evaluated";
    }
    checks.push({ kind: "ips_rule", key: r.code, target, actual: r.code === "min_credit_rating" ? (status === "breach" ? "below" : "ok") : fmt(actual, r.code === "max_duration" ? " y" : r.code === "min_liquidity_months" ? " mo" : "%"), status, detail, severity: r.severity });
  }
  const gt = glideTarget(eff.glide_path, snap.year);
  if (gt != null) {
    const actual = snap.allocation.bucket?.growth ?? snap.allocation.asset_class?.equity ?? 0; const miss = Math.abs(actual - gt);
    checks.push({ kind: "glide_path", key: "growth_vs_glide", target: `${gt}% (${snap.year})`, actual: fmt(actual), status: miss <= 5 ? "in_band" : miss <= 10 ? "warning" : "breach", detail: miss > 5 ? `${r2(miss)} pp off the glide path` : "" });
  }
  const breaches = checks.filter((c) => c.status === "breach").length, warnings = checks.filter((c) => c.status === "warning").length;
  return { overall: breaches ? "breach" : warnings ? "warning" : "compliant", checks, breaches, warnings };
}

/** Would this intent worsen a breach or touch a prohibited instrument? Used by the action plane and the assistant (FO-144). */
export function checkIntent(eff: PolicyClauses, snap: Snapshot, intent: { instrumentType?: string | null; name?: string | null; allocClass?: AllocClass | null; amount: number; direction: "buy" | "sell"; rating?: string | null; sector?: string | null }): { pass: boolean; clause: string | null; detail: string } {
  const perm = eff.permitted ?? {}; const nm = (intent.name ?? "").toLowerCase(), ty = String(intent.instrumentType ?? "").toLowerCase();
  for (const rule of (perm.prohibited ?? []) as string[]) { const r = rule.toLowerCase(); if (r.includes("unrated") && intent.allocClass === "debt" && ratingRank(intent.rating) < 0 && ty === "bond") return { pass: false, clause: "permitted.prohibited", detail: `unrated debt is prohibited (${rule})` }; if (ty && ty === r) return { pass: false, clause: "permitted.prohibited", detail: `${rule} is prohibited` }; if (nm && r.length > 3 && nm.includes(r)) return { pass: false, clause: "permitted.prohibited", detail: `${rule} is prohibited` }; }
  if (Array.isArray(perm.instrument_types) && perm.instrument_types.length && ty && !perm.instrument_types.map((x: string) => x.toLowerCase()).includes(ty)) return { pass: false, clause: "permitted.instrument_types", detail: `${ty} is not a permitted instrument type` };
  if (perm.min_rating && ty === "bond" && intent.direction === "buy" && ratingRank(intent.rating) >= 0 && ratingRank(intent.rating) < ratingRank(perm.min_rating)) return { pass: false, clause: "permitted.min_rating", detail: `${intent.rating} is below the minimum rating ${perm.min_rating}` };
  if (intent.allocClass && intent.direction === "buy") {
    const total = snap.positions.reduce((s, p) => s + p.value, 0); const band = (eff.allocations ?? []).find((a) => a.lens === "asset_class" && a.key === intent.allocClass);
    if (band && band.max_pct != null && total > 0) { const now = snap.allocation.asset_class?.[intent.allocClass] ?? 0; const after = ((now / 100) * total + intent.amount) / (total + intent.amount) * 100; if (after > Number(band.max_pct) && after > now) return { pass: false, clause: `allocation.asset_class:${intent.allocClass}`, detail: `${intent.allocClass} would move ${r2(now)}% → ${r2(after)}%, above the ${band.max_pct}% band` }; }
  }
  return { pass: true, clause: null, detail: "" };
}
