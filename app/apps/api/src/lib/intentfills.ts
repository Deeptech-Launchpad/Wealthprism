import type pg from "pg";

/** An equity order that came from a research proposal and was confirmed ("filled") becomes "reconciled" when the broker's trade for
 *  it arrives in an import (tradebook, contract note, CAS). The broker's order id is hashed away by the importer, so the match is made
 *  the same way as for rebalancing moves: same owner, security and side, quantity within 2%, a trade date from the day before the
 *  order was created until ten days after it was confirmed. One fill settles one order: a fill already linked to an order (or to a
 *  rebalancing move) is never used twice, so two tranches of the same size each take their own trade. The linked trade is kept on the
 *  order (payload.fill_txn_id) so the Action plane can show it. */
export async function matchProposalOrders(c: pg.PoolClient, familyId: string) {
  await c.query("savepoint match_orders");
  try {
    const orders = (await c.query(
      `select id, entity_id, payload, created_at, updated_at from action_intents
        where family_id=$1 and status='filled' and source_type='investment_proposal' and kind='equity_order' order by updated_at, created_at`, [familyId])).rows;
    let matched = 0;
    for (const o of orders) {
      const p = o.payload ?? {}; const instrument = p.instrument_id ?? p.instrument?.id; const qty = Number(p.quantity);
      if (!instrument || !(qty > 0) || !["buy", "sell"].includes(p.side)) continue;
      const types = p.side === "sell" ? ["sell", "redemption", "switch_out"] : ["buy", "sip", "switch_in"];
      const fill = (await c.query(
        `select t.id, t.txn_date::text txn_date from investment_txns t
          where t.family_id=$1 and t.entity_id=$2 and t.instrument_id=$3 and t.type = any($4)
            and abs(t.quantity - $5::numeric) <= greatest(0.0001, $5::numeric * 0.02)
            and t.txn_date between $6::timestamptz::date - 1 and $7::timestamptz::date + 10
            and not exists (select 1 from action_intents x where x.family_id=$1 and x.payload->>'fill_txn_id' = t.id::text)
            and not exists (select 1 from rebalance_moves m where m.executed_ref_id = t.id)
          order by abs(t.txn_date - $7::timestamptz::date), abs(t.quantity - $5::numeric), t.created_at limit 1`,
        [familyId, o.entity_id, instrument, types, qty, o.created_at, o.updated_at])).rows[0];
      if (!fill) continue;
      await c.query("update action_intents set status='reconciled', payload = payload || jsonb_build_object('fill_txn_id', $2::text, 'fill_date', $3::text), updated_at=now() where id=$1 and status='filled'", [o.id, fill.id, fill.txn_date]);
      matched++;
    }
    await c.query("release savepoint match_orders");
    return { matched };
  } catch (e) { await c.query("rollback to savepoint match_orders"); await c.query("release savepoint match_orders"); throw e; }
}
