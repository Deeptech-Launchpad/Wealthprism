import { consumeFifo, Lot } from "./lots.js";
export interface TaxRule { assetClass: string; term: "short" | "long"; rate: number; taxedAtSlab: boolean; exemptionAmount: number; holdingMonthsForLong: number }
export interface GainLine { lotId: string; buyDate: string; sellDate: string; qty: number; cost: number; proceeds: number; gain: number; term: "short" | "long"; grandfathered: boolean }
function monthsBetween(a: string, b: string): number {
  const [ay, am, ad] = a.split("-").map(Number), [by, bm, bd] = b.split("-").map(Number);
  let m = (by - ay) * 12 + (bm - am);
  if (bd < ad) m -= 1;
  return m;
}
/**
 * Compute realised gains for a sale using FIFO lots, holding-period term and (for equity) grandfathering
 * to the 31 Jan 2018 FMV where the lot predates it. All rates come from the supplied rules (data, not code).
 */
export function realiseSale(opts: { lots: Lot[]; qty: number; price: number; sellDate: string; charges?: number; assetClass: string; rules: TaxRule[]; fmv31Jan2018?: number }): { lines: GainLine[]; remaining: Lot[] } {
  const { lots, qty, price, sellDate, charges = 0, assetClass, rules, fmv31Jan2018 } = opts;
  const longRule = rules.find((r) => r.assetClass === assetClass && r.term === "long");
  if (!longRule) throw new Error(`no long-term rule for ${assetClass}`);
  const { consumed, remaining } = consumeFifo(lots, qty);
  const totalProceeds = qty * price - charges;
  const lines = consumed.map((c) => {
    const proceeds = +((totalProceeds * c.qty) / qty).toFixed(2);
    let cost = c.cost;
    let grandfathered = false;
    if (assetClass === "equity" && fmv31Jan2018 && c.buyDate < "2018-02-01") {
      // cost = higher of actual cost and lower of (FMV, sale price)
      const gf = Math.min(fmv31Jan2018 * c.qty, proceeds);
      if (gf > cost) { cost = +gf.toFixed(2); grandfathered = true; }
    }
    const term: "short" | "long" = monthsBetween(c.buyDate, sellDate) >= longRule.holdingMonthsForLong ? "long" : "short";
    return { lotId: c.lotId, buyDate: c.buyDate, sellDate, qty: c.qty, cost, proceeds, gain: +(proceeds - cost).toFixed(2), term, grandfathered };
  });
  return { lines, remaining };
}
/** Tax on a set of gain lines for one entity and FY, applying the long-term exemption once. */
export function taxOnGains(lines: GainLine[], assetClass: string, rules: TaxRule[], slabRate: number): { stcg: number; ltcg: number; exemptionUsed: number; tax: number } {
  const s = rules.find((r) => r.assetClass === assetClass && r.term === "short")!;
  const l = rules.find((r) => r.assetClass === assetClass && r.term === "long")!;
  const stcg = lines.filter((x) => x.term === "short").reduce((a, x) => a + x.gain, 0);
  const ltcg = lines.filter((x) => x.term === "long").reduce((a, x) => a + x.gain, 0);
  const exemptionUsed = Math.max(0, Math.min(ltcg, l.exemptionAmount));
  const taxableLt = Math.max(0, ltcg - exemptionUsed);
  const stRate = s.taxedAtSlab ? slabRate : s.rate;
  const tax = Math.max(0, stcg) * stRate / 100 + taxableLt * l.rate / 100;
  return { stcg: +stcg.toFixed(2), ltcg: +ltcg.toFixed(2), exemptionUsed: +exemptionUsed.toFixed(2), tax: +tax.toFixed(2) };
}
