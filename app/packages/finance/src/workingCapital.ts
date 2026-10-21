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
