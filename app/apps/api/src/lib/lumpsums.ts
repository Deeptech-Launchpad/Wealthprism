// One-time sums of money (bonus, gift, sale, inheritance, refund). Not income: they only change the bank balance.
// A pending entry is matched to the bank statement credit that is the same money: same account, amount within ₹1 or 0.5%,
// date within 5 days, and that bank line is not already matched. A matched entry is 'verified' and changes nothing else.
import type pg from "pg";

export const LUMP_REASONS = ["bonus", "gift", "sale", "inheritance", "refund", "other"] as const;
const r2 = (n: number) => Math.round(n * 100) / 100;

/** Match pending lump sums to bank credits. Returns how many were verified in this run. */
export async function matchLumpSums(c: pg.PoolClient, familyId: string): Promise<number> {
  const open = (await c.query("select id, bank_account_id, amount, entry_date::text d from lump_sums where family_id=$1 and status='pending' and deleted_at is null order by entry_date", [familyId])).rows;
  let matched = 0;
  for (const ls of open) {
    const amount = Number(ls.amount); const tol = Math.max(1, amount * 0.005);
    const hit = (await c.query(
      `select t.id from bank_txns t
        where t.family_id=$1 and t.bank_account_id=$2 and t.amount > 0
          and abs(t.amount - $3::numeric) <= $4::numeric
          and t.txn_date between $5::date - 5 and $5::date + 5
          and not exists (select 1 from lump_sums x where x.bank_txn_id = t.id)
        order by abs(t.txn_date - $5::date), abs(t.amount - $3::numeric) limit 1`,
      [familyId, ls.bank_account_id, amount, r2(tol), ls.d])).rows[0];
    if (!hit) continue;
    await c.query("update lump_sums set status='verified', bank_txn_id=$2 where id=$1", [ls.id, hit.id]);
    matched++;
  }
  return matched;
}

export const lumpSumView = (r: any) => ({
  id: r.id, bank_account_id: r.bank_account_id, bank: r.bank, account_masked: r.account_masked, entity_id: r.entity_id, entity_name: r.entity_name,
  entry_date: r.entry_date, amount: r2(Number(r.amount)).toFixed(2), reason: r.reason, note: r.note ?? null, status: r.status,
  bank_txn_id: r.bank_txn_id ?? null, verified_on: r.verified_on ?? null, created_at: r.created_at,
});
