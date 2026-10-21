import type pg from "pg";
import { applyBonus, applySplit, applyDemerger, applyMerger, type Lot } from "@fo/finance";

export interface CorporateActionRow {
  id: string; instrument_id: string; type: string; ex_date: string | Date; ratio_num: string | null; ratio_den: string | null;
  cash_per_unit: string | null; new_instrument_id: string | null; cost_split_pct: string | null; status: string;
}
export interface ApplyOverrides { cost_split_pct?: number; new_instrument_id?: string; ratio_num?: number; ratio_den?: number }

const iso = (d: string | Date) => (typeof d === "string" ? d.slice(0, 10) : d.toISOString().slice(0, 10));
const lotOf = (l: any): Lot => ({ id: l.id, buyDate: iso(l.buy_date), quantity: Number(l.quantity), remainingQty: Number(l.remaining_qty), unitCost: Number(l.unit_cost), charges: Number(l.charges) });

async function recompute(c: pg.PoolClient, holdingId: string) {
  await c.query(`update holdings h set quantity = s.q, avg_cost = case when s.q > 0 then s.c / s.q else 0 end, updated_at = now()
     from (select coalesce(sum(remaining_qty),0) q, coalesce(sum(remaining_qty * unit_cost + case when quantity > 0 then charges * remaining_qty / quantity else 0 end),0) c from lots where holding_id=$1) s where h.id=$1`, [holdingId]);
}

/** Apply one corporate action to every holding of the family in that instrument, inside the caller's family transaction.
 *  Idempotent per holding (corporate_action_applications). Returns the holdings touched. */
export async function applyCorporateAction(c: pg.PoolClient, familyId: string, ca: CorporateActionRow, userId: string | null, o: ApplyOverrides = {}) {
  const exDate = iso(ca.ex_date);
  const num = o.ratio_num ?? (ca.ratio_num != null ? Number(ca.ratio_num) : undefined);
  const den = o.ratio_den ?? (ca.ratio_den != null ? Number(ca.ratio_den) : undefined);
  const holdings = (await c.query(`select h.id, h.entity_id, h.account_id, h.bucket, h.quantity from holdings h
      where h.instrument_id=$1 and not exists (select 1 from corporate_action_applications a where a.corporate_action_id=$2 and a.holding_id=h.id) order by h.id`, [ca.instrument_id, ca.id])).rows;
  const touched: { holding_id: string; detail: any }[] = [];
  for (const h of holdings) {
    // only lots bought cum-action participate
    const lots = (await c.query("select id, buy_date, quantity, remaining_qty, unit_cost, charges from lots where holding_id=$1 and remaining_qty > 0 and buy_date < $2 order by buy_date", [h.id, exDate])).rows.map(lotOf);
    const qty = lots.reduce((s, l) => s + l.remainingQty, 0);
    if (qty <= 0) continue;
    const txnHash = `ca:${ca.id}:${h.id}`;
    let detail: any = { quantity_before: qty };
    if (ca.type === "bonus") {
      if (!num || !den) throw new Error("bonus needs a ratio");
      const out = applyBonus(lots, num, den, exDate).filter((l) => l.id.endsWith("-bonus"));
      for (const l of out) await c.query("insert into lots (family_id, holding_id, buy_date, quantity, remaining_qty, unit_cost, charges) values ($1,$2,$3,$4,$4,0,0)", [familyId, h.id, exDate, l.quantity]);
      const added = out.reduce((s, l) => s + l.quantity, 0);
      await c.query("insert into investment_txns (family_id, entity_id, account_id, instrument_id, type, txn_date, quantity, price, amount, charges, source, source_ref, hash) values ($1,$2,$3,$4,'bonus',$5,$6,0,0,0,'corporate_action',$7,$8) on conflict do nothing", [familyId, h.entity_id, h.account_id, ca.instrument_id, exDate, added, ca.id, txnHash]);
      detail = { ...detail, bonus_units: added, ratio: `${num}:${den}` };
    } else if (ca.type === "split") {
      if (!num || !den) throw new Error("split needs a ratio");
      const out = applySplit(lots, num, den);
      for (const l of out) await c.query("update lots set quantity=$2, remaining_qty=$3, unit_cost=$4 where id=$1", [l.id, l.quantity, l.remainingQty, l.unitCost]);
      await c.query("insert into investment_txns (family_id, entity_id, account_id, instrument_id, type, txn_date, quantity, price, amount, charges, source, source_ref, hash) values ($1,$2,$3,$4,'split',$5,$6,0,0,0,'corporate_action',$7,$8) on conflict do nothing", [familyId, h.entity_id, h.account_id, ca.instrument_id, exDate, out.reduce((s, l) => s + l.remainingQty, 0) - qty, ca.id, txnHash]);
      detail = { ...detail, ratio: `${num}:${den}`, quantity_after: out.reduce((s, l) => s + l.remainingQty, 0) };
    } else if (ca.type === "dividend") {
      const cash = ca.cash_per_unit != null ? Number(ca.cash_per_unit) : null;
      if (cash == null) throw new Error("dividend needs cash_per_unit");
      const amount = +(cash * qty).toFixed(2);
      await c.query("insert into investment_txns (family_id, entity_id, account_id, instrument_id, type, txn_date, quantity, price, amount, charges, source, source_ref, hash) values ($1,$2,$3,$4,'dividend',$5,$6,$7,$8,0,'corporate_action',$9,$10) on conflict do nothing", [familyId, h.entity_id, h.account_id, ca.instrument_id, exDate, qty, cash, amount, ca.id, txnHash]);
      detail = { ...detail, cash_per_unit: cash, amount };
    } else if (ca.type === "demerger" || ca.type === "merger") {
      const newInstrument = o.new_instrument_id ?? ca.new_instrument_id;
      if (!newInstrument) throw new Error(`${ca.type} needs new_instrument_id`);
      const ins = (await c.query("select default_bucket from instruments where id=$1", [newInstrument])).rows[0];
      if (!ins) throw new Error("new_instrument_id not found");
      const target = (await c.query(`insert into holdings (family_id, entity_id, account_id, instrument_id, quantity, avg_cost, bucket) values ($1,$2,$3,$4,0,0,$5)
          on conflict (entity_id, account_id, instrument_id) do update set updated_at = now() returning id`, [familyId, h.entity_id, h.account_id, newInstrument, h.bucket ?? ins.default_bucket])).rows[0].id;
      let child: Lot[];
      if (ca.type === "demerger") {
        const pct = o.cost_split_pct ?? (ca.cost_split_pct != null ? Number(ca.cost_split_pct) : undefined);
        if (pct == null) throw new Error("demerger needs cost_split_pct");
        const r = applyDemerger(lots, pct, num ?? 1, den ?? 1);
        for (const l of r.parent) await c.query("update lots set unit_cost=$2, charges=$3 where id=$1", [l.id, l.unitCost, l.charges]);
        child = r.child; detail = { ...detail, cost_split_pct: pct, ratio: `${num ?? 1}:${den ?? 1}` };
      } else {
        if (!num || !den) throw new Error("merger needs a ratio");
        child = applyMerger(lots, num, den);
        for (const l of lots) await c.query("update lots set remaining_qty=0 where id=$1", [l.id]);
        detail = { ...detail, ratio: `${num}:${den}` };
      }
      for (const l of child) await c.query("insert into lots (family_id, holding_id, buy_date, quantity, remaining_qty, unit_cost, charges) values ($1,$2,$3,$4,$4,$5,$6)", [familyId, target, l.buyDate, l.quantity, l.unitCost, l.charges]);
      await c.query("insert into investment_txns (family_id, entity_id, account_id, instrument_id, type, txn_date, quantity, price, amount, charges, source, source_ref, hash) values ($1,$2,$3,$4,$5,$6,$7,0,0,0,'corporate_action',$8,$9) on conflict do nothing", [familyId, h.entity_id, h.account_id, newInstrument, ca.type, exDate, child.reduce((s, l) => s + l.quantity, 0), ca.id, txnHash]);
      await recompute(c, target);
      detail = { ...detail, new_holding_id: target, new_units: child.reduce((s, l) => s + l.quantity, 0) };
    } else {
      throw new Error(`${ca.type} is recorded through the contract note / statement import, not applied automatically`);
    }
    await recompute(c, h.id);
    await c.query("insert into corporate_action_applications (corporate_action_id, family_id, holding_id, applied_by, detail) values ($1,$2,$3,$4,$5)", [ca.id, familyId, h.id, userId, JSON.stringify(detail)]);
    touched.push({ holding_id: h.id, detail });
  }
  return touched;
}

/** Human-readable effect for the list view. */
export function describeEffect(ca: { type: string; ratio_num: any; ratio_den: any; cash_per_unit: any; cost_split_pct: any; face_value_from?: any; face_value_to?: any }) {
  const r = ca.ratio_num != null && ca.ratio_den != null ? `${Number(ca.ratio_num)}:${Number(ca.ratio_den)}` : null;
  switch (ca.type) {
    case "bonus": return r ? `${Number(ca.ratio_num)} bonus share${Number(ca.ratio_num) > 1 ? "s" : ""} for every ${Number(ca.ratio_den)} held; cost per share falls, total cost unchanged` : "Bonus issue";
    case "split": return ca.face_value_from ? `Face value ₹${Number(ca.face_value_from)} → ₹${Number(ca.face_value_to)}: quantity × ${Number(ca.ratio_num)}, unit cost ÷ ${Number(ca.ratio_num)}` : r ? `Quantity × ${r}` : "Stock split";
    case "dividend": return ca.cash_per_unit != null ? `₹${Number(ca.cash_per_unit)} per share credited to the linked bank account` : "Dividend";
    case "demerger": return ca.cost_split_pct != null ? `Cost apportioned ${100 - Number(ca.cost_split_pct)} / ${Number(ca.cost_split_pct)} to the new company` : "Demerger — cost split to be confirmed";
    case "merger": return r ? `${Number(ca.ratio_num)} new shares for every ${Number(ca.ratio_den)} held` : "Merger — ratio to be confirmed";
    case "rights": return r ? `Rights ${r}${ca.cash_per_unit != null ? ` at ₹${Number(ca.cash_per_unit)}` : ""} — record the subscription from the contract note` : "Rights issue";
    default: return ca.type;
  }
}
