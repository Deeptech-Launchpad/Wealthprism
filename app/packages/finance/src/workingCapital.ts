export interface Outflow { dueDate: string; amount: number }
export interface WcInput { cash: number; outflows: Outflow[]; floatDays: number; avgMonthlyOutflow: number; bufferMonths: number; asOf: string }
export function requiredFloat(i: WcInput): number {
  const horizon = new Date(i.asOf); horizon.setDate(horizon.getDate() + i.floatDays);
  const committed = i.outflows.filter((o) => new Date(o.dueDate) <= horizon).reduce((a, o) => a + o.amount, 0);
  return +(committed + i.avgMonthlyOutflow * i.bufferMonths).toFixed(2);
}
export function deployableExcess(i: WcInput): number { return +Math.max(0, i.cash - requiredFloat(i)).toFixed(2); }
/** Post-tax yield given gross yield, tax treatment and the entity's slab. */
export function postTaxYield(gross: number, treatment: "slab" | "equity_stcg" | "equity_ltcg" | "exempt", slabRate: number): number {
  const rate = treatment === "slab" ? slabRate : treatment === "equity_stcg" ? 20 : treatment === "equity_ltcg" ? 12.5 : 0;
  return +(gross * (1 - rate / 100)).toFixed(2);
}

export interface NavPoint { date: string; nav: number }
export interface NavYield { pct: number; basisDays: number; days: number; from: string; to: string }
const dayMs = 86400000;
/** The annualised return of a fund from its NAV history, over about `basisDays`: the latest NAV against the last NAV on or before (latest − basisDays),
 *  compounded to a year over the days that actually passed. Returns null when the history is too thin to say anything honest — the earlier point
 *  must be within 10 days of the target date, so a fund tracked for only a week cannot pass for a 1-year figure. Past growth, not a promise. */
export function navYield(points: NavPoint[], basisDays: number): NavYield | null {
  const pts = points.filter((p) => p.nav > 0 && /^\d{4}-\d{2}-\d{2}/.test(p.date)).sort((a, b) => a.date.localeCompare(b.date));
  if (pts.length < 2) return null;
  const latest = pts[pts.length - 1]; const target = Date.parse(latest.date) - basisDays * dayMs;
  let earlier: NavPoint | null = null; for (const p of pts) { if (Date.parse(p.date) <= target) earlier = p; else break; }
  if (!earlier) return null;
  if (target - Date.parse(earlier.date) > 10 * dayMs) return null;
  const days = Math.round((Date.parse(latest.date) - Date.parse(earlier.date)) / dayMs); if (days < Math.ceil(basisDays * 0.8)) return null;
  const pct = (Math.pow(latest.nav / earlier.nav, 365 / days) - 1) * 100;
  if (!Number.isFinite(pct)) return null;
  return { pct: Math.round(pct * 100) / 100, basisDays, days, from: earlier.date, to: latest.date };
}
