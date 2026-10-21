/** One place that values every active deposit as of today. Net worth, the bucket drift (dashboard, goals) and the exposure positions
 *  (asset-class lens, policy checks) all read it, so they can never disagree — an earlier copy-pasted version of this logic is exactly
 *  how the dashboard once ignored deposits that net worth counted. Dates are text, so there is no timezone day-shift. */
import type pg from "pg";
import { depositCurrentValue } from "@fo/finance";

export interface DepositValue { id: string; entity_id: string; kind: "fd" | "rd"; bank: string; account_no: string | null; bucket: "liquidity" | "income" | "growth"; value: number }

export async function activeDepositValues(c: pg.PoolClient, familyId: string, entityId?: string | null): Promise<DepositValue[]> {
  const rows = (await c.query(`select d.id, d.entity_id, d.kind, d.bank, d.account_no, d.bucket, d.principal, d.rate_pct, d.start_date::text start_date, d.maturity_date::text maturity_date,
      (select expected_amount from deposit_receipts r where r.deposit_id=d.id and r.kind='maturity' limit 1) maturity_amount,
      (select coalesce(json_agg(json_build_object('a', r.received_amount, 'on', coalesce(r.received_on::text, r.due_date::text))), '[]'::json) from deposit_receipts r where r.deposit_id=d.id and r.kind='contribution' and r.received_amount > 0) paid
    from deposits d where d.family_id=$1 and d.status='active' and ($2::uuid is null or d.entity_id=$2)`, [familyId, entityId ?? null])).rows;
  const today = new Date().toISOString().slice(0, 10);
  return rows.map((d) => ({ id: d.id, entity_id: d.entity_id, kind: d.kind, bank: d.bank, account_no: d.account_no, bucket: d.bucket,
    value: depositCurrentValue({ kind: d.kind, principal: d.principal, startDate: d.start_date, maturityDate: d.maturity_date, ratePct: Number(d.rate_pct), paid: d.paid }, Number(d.maturity_amount ?? d.principal ?? 0), today) }));
}
