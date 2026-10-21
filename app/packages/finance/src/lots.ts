export interface Lot { id: string; buyDate: string; quantity: number; remainingQty: number; unitCost: number; charges: number }
export interface SellResult { consumed: { lotId: string; qty: number; cost: number; buyDate: string }[]; remaining: Lot[] }
/** FIFO consumption of lots for a sale. Cost includes proportional charges. */
export function consumeFifo(lots: Lot[], qty: number): SellResult {
  const sorted = [...lots].sort((a, b) => a.buyDate.localeCompare(b.buyDate));
  const consumed: SellResult["consumed"] = [];
  let left = qty;
  const remaining = sorted.map((l) => ({ ...l }));
  for (const l of remaining) {
    if (left <= 1e-9) break;
    if (l.remainingQty <= 0) continue;
    const take = Math.min(l.remainingQty, left);
    const costPerUnit = l.unitCost + l.charges / l.quantity;
    consumed.push({ lotId: l.id, qty: take, cost: +(take * costPerUnit).toFixed(2), buyDate: l.buyDate });
    l.remainingQty = +(l.remainingQty - take).toFixed(6);
    left -= take;
  }
  if (left > 1e-6) throw new Error(`insufficient quantity: short by ${left}`);
  return { consumed, remaining };
}
/** Bonus/split: adds units at zero (bonus) or rescales (split) without changing total cost. */
export function applyBonus(lots: Lot[], num: number, den: number, exDate: string): Lot[] {
  return lots.flatMap((l) => {
    const bonusQty = +((l.remainingQty * num) / den).toFixed(6);
    return bonusQty > 0 ? [l, { id: `${l.id}-bonus`, buyDate: exDate, quantity: bonusQty, remainingQty: bonusQty, unitCost: 0, charges: 0 }] : [l];
  });
}
export function applySplit(lots: Lot[], num: number, den: number): Lot[] {
  return lots.map((l) => ({ ...l, quantity: +((l.quantity * num) / den).toFixed(6), remainingQty: +((l.remainingQty * num) / den).toFixed(6), unitCost: +((l.unitCost * den) / num).toFixed(6) }));
}
/** Demerger: `costSplitPct` of each lot's cost moves to the new company; the child lots keep the parent's buy dates
 *  (holding period carries over under s.49(2C)/(2D)) and receive `num/den` shares per parent share. */
export function applyDemerger(lots: Lot[], costSplitPct: number, num = 1, den = 1): { parent: Lot[]; child: Lot[] } {
  const keep = (100 - costSplitPct) / 100, move = costSplitPct / 100;
  const parent = lots.map((l) => ({ ...l, unitCost: +(l.unitCost * keep).toFixed(6), charges: +(l.charges * keep).toFixed(2) }));
  const child = lots.filter((l) => l.remainingQty > 0).map((l) => {
    const qty = +((l.remainingQty * num) / den).toFixed(6);
    return { id: `${l.id}-demerged`, buyDate: l.buyDate, quantity: qty, remainingQty: qty, unitCost: +(((l.unitCost * move) * l.remainingQty) / qty).toFixed(6), charges: +(l.charges * move * (l.remainingQty / l.quantity)).toFixed(2) };
  });
  return { parent, child };
}
/** Merger / amalgamation: `num` new shares for every `den` old ones; total cost and buy dates carry over. */
export function applyMerger(lots: Lot[], num: number, den: number): Lot[] {
  return lots.filter((l) => l.remainingQty > 0).map((l) => {
    const qty = +((l.remainingQty * num) / den).toFixed(6);
    return { id: `${l.id}-merged`, buyDate: l.buyDate, quantity: qty, remainingQty: qty, unitCost: +((l.unitCost * l.remainingQty) / qty).toFixed(6), charges: +(l.charges * (l.remainingQty / l.quantity)).toFixed(2) };
  });
}
