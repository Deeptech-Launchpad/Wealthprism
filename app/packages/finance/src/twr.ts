/** Time-weighted return: Modified Dietz inside each valuation interval, geometric linking across intervals. */
export interface Valuation { date: string; value: number }
/** +contribution into the scope, −withdrawal out of it, on `date` (treated as end of that day). */
export interface Flow { date: string; amount: number }
export interface SubPeriod { from: string; to: string; startValue: number; endValue: number; netFlow: number; ret: number }
export interface TwrResult { total: number; annualised: number | null; days: number; subPeriods: SubPeriod[] }

const DAY = 86400000;
const days = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / DAY);

/** Modified Dietz over [start, end]: (EV − BV − ΣCF) / (BV + Σ wᵢ·CFᵢ), wᵢ = share of the period remaining after the flow. */
export function modifiedDietz(startValue: number, endValue: number, flows: Flow[], start: string, end: string): number {
  const T = Math.max(1, days(start, end));
  let sum = 0, weighted = 0;
  for (const f of flows) {
    if (f.date <= start || f.date > end) continue;
    const w = (T - days(start, f.date)) / T; // a flow at the very end has weight 0, at the start weight 1
    sum += f.amount; weighted += w * f.amount;
  }
  const denom = startValue + weighted;
  if (Math.abs(denom) < 1e-9) return 0;
  return (endValue - startValue - sum) / denom;
}

/** Geometric linking: Π(1 + rᵢ) − 1. */
export function linkReturns(returns: number[]): number {
  return returns.reduce((acc, r) => acc * (1 + r), 1) - 1;
}

/** Annualise a cumulative return held for `days` days; cumulative is left as-is under a year (industry convention). */
export function annualise(total: number, periodDays: number): number | null {
  if (periodDays < 365) return null;
  if (1 + total <= 0) return -1;
  return Math.pow(1 + total, 365 / periodDays) - 1;
}

/** TWR from a dated valuation series (daily or sparser) with the external flows that happened between valuations. */
export function twr(valuations: Valuation[], flows: Flow[] = []): TwrResult {
  const v = [...valuations].sort((a, b) => a.date.localeCompare(b.date));
  if (v.length < 2) return { total: 0, annualised: null, days: 0, subPeriods: [] };
  const subPeriods: SubPeriod[] = [];
  for (let i = 1; i < v.length; i++) {
    const a = v[i - 1], b = v[i];
    const inWindow = flows.filter((f) => f.date > a.date && f.date <= b.date);
    const netFlow = inWindow.reduce((s, f) => s + f.amount, 0);
    // a scope that starts from nothing has no return until money arrives
    const ret = a.value <= 0 && b.value - netFlow <= 0 ? 0 : a.value <= 0 ? (netFlow ? (b.value - netFlow) / netFlow : 0) : modifiedDietz(a.value, b.value, inWindow, a.date, b.date);
    subPeriods.push({ from: a.date, to: b.date, startValue: a.value, endValue: b.value, netFlow, ret });
  }
  const total = linkReturns(subPeriods.map((s) => s.ret));
  const d = days(v[0].date, v[v.length - 1].date);
  return { total, annualised: annualise(total, d), days: d, subPeriods };
}

/** Cash flows for XIRR of the same scope and window: opening value out, flows as they happened, closing value in. */
export function xirrFlowsFor(valuations: Valuation[], flows: Flow[]): { date: Date; amount: number }[] {
  const v = [...valuations].sort((a, b) => a.date.localeCompare(b.date));
  if (v.length < 2) return [];
  const first = v[0], last = v[v.length - 1];
  const out: { date: Date; amount: number }[] = [];
  if (first.value > 0) out.push({ date: new Date(first.date), amount: -first.value });
  for (const f of flows) if (f.date > first.date && f.date <= last.date) out.push({ date: new Date(f.date), amount: -f.amount });
  out.push({ date: new Date(last.date), amount: last.value });
  return out;
}

/** Explains a TWR / XIRR gap: large flows relative to the opening value make the two legitimately diverge. */
export function divergenceNote(twrPct: number, xirrPct: number, valuations: Valuation[], flows: Flow[]): string | null {
  const gap = Math.abs(twrPct - xirrPct);
  if (gap < 1) return null;
  const open = [...valuations].sort((a, b) => a.date.localeCompare(b.date))[0]?.value ?? 0;
  const gross = flows.reduce((s, f) => s + Math.abs(f.amount), 0);
  const heavy = open > 0 ? gross / open : Infinity;
  if (heavy > 0.25) return `TWR and XIRR differ by ${gap.toFixed(1)} pp because flows during the period (${Math.round(heavy * 100)}% of the opening value) changed how much money was invested when returns were ${xirrPct > twrPct ? "strong" : "weak"}. TWR measures the manager; XIRR measures your money.`;
  return `TWR and XIRR differ by ${gap.toFixed(1)} pp; the timing of flows was ${xirrPct > twrPct ? "favourable" : "unfavourable"}.`;
}
