export interface CashFlow { date: Date; amount: number }
const DAY = 86400000;
function npv(rate: number, flows: CashFlow[], t0: number): number {
  return flows.reduce((s, f) => s + f.amount / Math.pow(1 + rate, (f.date.getTime() - t0) / DAY / 365), 0);
}
/** XIRR: Newton–Raphson with bisection fallback. Returns annualised rate (0.12 = 12%). */
export function xirr(flows: CashFlow[]): number {
  if (flows.length < 2) throw new Error("need at least two cash flows");
  const t0 = Math.min(...flows.map((f) => f.date.getTime()));
  const hasPos = flows.some((f) => f.amount > 0), hasNeg = flows.some((f) => f.amount < 0);
  if (!hasPos || !hasNeg) throw new Error("need both inflows and outflows");
  let rate = 0.1;
  for (let i = 0; i < 100; i++) {
    const f = npv(rate, flows, t0);
    const h = 1e-6;
    const d = (npv(rate + h, flows, t0) - f) / h;
    if (Math.abs(d) < 1e-12) break;
    const next = rate - f / d;
    if (!isFinite(next) || next <= -0.9999) break;
    if (Math.abs(next - rate) < 1e-9) return next;
    rate = next;
  }
  let lo = -0.9999, hi = 10;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (npv(lo, flows, t0) * npv(mid, flows, t0) <= 0) hi = mid; else lo = mid;
    if (hi - lo < 1e-10) break;
  }
  return (lo + hi) / 2;
}
