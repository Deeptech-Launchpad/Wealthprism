/** Interest and maturity payments expected from bonds, G-Secs, SGBs and T-bills (holding_receipts): the schedule is built from the instrument's coupon, how often it is
 *  paid, its maturity date and the quantity held, kept in step with the holdings, matched to bank-statement credits, or confirmed by hand. Same idea as deposit_receipts. */
import type pg from "pg";
import { money } from "./db.js";

const r2 = (n: number) => Math.round(n * 100) / 100;
const STEP_MONTHS: Record<string, number> = { monthly: 1, quarterly: 3, half_yearly: 6, yearly: 12 };
export const RECEIPT_TYPES = ["bond", "gsec", "sgb", "tbill"];
export interface ScheduleInput { type: string; quantity: number; totalCost: number; faceValue?: number | null; couponPct?: number | null; frequency?: string | null; maturityDate: string; from: string }
export interface ScheduleRow { kind: "interest" | "maturity"; due: string; amount: number }

const pad = (n: number) => String(n).padStart(2, "0");
/** Move a yyyy-mm-dd date by whole months, keeping the day (or the last day of a shorter month). */
export function addMonths(d: string, months: number): string {
  const [y, m, day] = d.split("-").map(Number); const t = (y * 12 + (m - 1)) + months; const ny = Math.floor(t / 12), nm = t % 12;
  const last = new Date(Date.UTC(ny, nm + 1, 0)).getUTCDate();
  return `${ny}-${pad(nm + 1)}-${pad(Math.min(day, last))}`;
}
const dayDiff = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);

/** Coupon dates run back from the maturity date in whole periods; only those after the day the units were bought are due. */
export function receiptSchedule(i: ScheduleInput): ScheduleRow[] {
  const sgb = i.type === "sgb"; const face = i.faceValue ?? (i.type === "bond" ? 1000 : 100);
  const base = sgb ? i.totalCost : i.quantity * face;   // an SGB pays on its issue price (what was paid), the others on the face value
  const rows: ScheduleRow[] = []; const coupon = Number(i.couponPct ?? 0); const freq = sgb ? "half_yearly" : i.frequency ?? "yearly";
  if (coupon > 0 && i.type !== "tbill") {
    const step = STEP_MONTHS[freq];
    if (step) { for (let k = 0; k < 600; k++) { const d = addMonths(i.maturityDate, -k * step); if (d <= i.from) break; rows.push({ kind: "interest", due: d, amount: r2(base * coupon / 100 * step / 12) }); } }
    else { const years = Math.max(0, dayDiff(i.from, i.maturityDate) / 365.25); if (years > 0) rows.push({ kind: "interest", due: i.maturityDate, amount: r2(base * coupon / 100 * years) }); }   // cumulative: all the interest at maturity
  }
  rows.push({ kind: "maturity", due: i.maturityDate, amount: r2(base) });   // an SGB is redeemed at the gold price on the day: this is only the amount paid, to be corrected when it arrives
  return rows.sort((a, b) => (a.due === b.due ? (a.kind === "interest" ? -1 : 1) : a.due < b.due ? -1 : 1));
}

/** Bring the open receipts of every held bond in step with the holdings: new purchases add payments, sales and maturity remove them, amounts follow the quantity. */
export async function syncHoldingReceipts(c: pg.PoolClient, familyId: string): Promise<number> {
  const held = (await c.query(`select h.id, h.entity_id, h.instrument_id, h.quantity, h.avg_cost, i.type, i.meta,
      (select min(buy_date)::text from lots l where l.holding_id=h.id) first_buy
    from holdings h join instruments i on i.id=h.instrument_id where h.family_id=$1 and i.type = any($2)`, [familyId, RECEIPT_TYPES])).rows;
  let changed = 0; const today = new Date().toISOString().slice(0, 10);
  for (const h of held) {
    const meta = h.meta ?? {}; const qty = Number(h.quantity);
    const existing = (await c.query("select id, kind, due_date::text due, expected_amount, status from holding_receipts where holding_id=$1", [h.id])).rows;
    const open = existing.filter((r: any) => r.status === "expected" || r.status === "overdue");
    if (qty <= 0 || !meta.maturity_date) { for (const r of open) { await c.query("update holding_receipts set status='cancelled' where id=$1", [r.id]); changed++; } continue; }
    const want = receiptSchedule({ type: h.type, quantity: qty, totalCost: qty * Number(h.avg_cost), faceValue: meta.face_value == null ? null : Number(meta.face_value), couponPct: meta.coupon_pct == null ? null : Number(meta.coupon_pct), frequency: meta.coupon_frequency, maturityDate: String(meta.maturity_date).slice(0, 10), from: h.first_buy ?? today });
    const key = (k: string, d: string) => `${k}|${d}`; const have = new Map<string, any>(existing.map((r: any) => [key(r.kind, r.due), r]));
    for (const w of want) {
      const cur = have.get(key(w.kind, w.due)); const st = w.due < today ? "overdue" : "expected";
      if (!cur) { await c.query("insert into holding_receipts (family_id, entity_id, holding_id, instrument_id, kind, due_date, expected_amount, status) values ($1,$2,$3,$4,$5,$6,$7,$8)", [familyId, h.entity_id, h.id, h.instrument_id, w.kind, w.due, w.amount, st]); changed++; }
      else if (cur.status === "cancelled") { await c.query("update holding_receipts set status=$2, expected_amount=$3 where id=$1", [cur.id, st, w.amount]); changed++; }
      else if ((cur.status === "expected" || cur.status === "overdue") && Number(cur.expected_amount) !== w.amount) { await c.query("update holding_receipts set expected_amount=$2 where id=$1", [cur.id, w.amount]); changed++; }
    }
    const wanted = new Set(want.map((w) => key(w.kind, w.due)));
    for (const r of open) if (!wanted.has(key(r.kind, r.due))) { await c.query("update holding_receipts set status='cancelled' where id=$1", [r.id]); changed++; }
  }
  await c.query("update holding_receipts set status='overdue' where family_id=$1 and status='expected' and due_date < current_date", [familyId]);
  return changed;
}

export const receiptView = (r: any) => ({ ...r, expected_amount: money(r.expected_amount), received_amount: money(r.received_amount) });

/** Record money that has arrived for one receipt. Done when the amount is in (interest after a 10% TDS counts); a finished interest payment is entered as an income
 *  transaction on the security, a finished maturity redeems the units through the lot engine (realised gain, holding to zero). */
export async function settleHoldingReceipt(c: pg.PoolClient, familyId: string, r: any, amount: number, receivedOn: string, how: { bankAccountId?: string | null; bankTxnRef?: string | null } = {}): Promise<{ status: string; note: string | null }> {
  const total = r2(Number(r.received_amount) + amount); const expected = Number(r.expected_amount);
  const sgbMaturity = r.kind === "maturity" && r.instrument_type === "sgb";
  const done = r.kind === "interest" ? total >= expected * 0.895 - 0.5 : sgbMaturity ? total > 0 : total >= expected * 0.995 - 0.5;
  const status = done ? "received" : "partial";
  await c.query("update holding_receipts set received_amount=$2, received_on=$3, status=$4, bank_account_id=coalesce($5, bank_account_id), bank_txn_ref=coalesce($6, bank_txn_ref) where id=$1", [r.id, total, receivedOn, status, how.bankAccountId ?? null, how.bankTxnRef ?? null]);
  let note: string | null = null;
  if (done) {
    const h = (await c.query("select h.id, h.entity_id, h.account_id, h.quantity, i.id iid, i.name, i.type, i.isin, i.symbol, i.amfi_code, a.kind akind, a.identifier_masked aident, a.provider aprov from holdings h join instruments i on i.id=h.instrument_id left join accounts a on a.id=h.account_id where h.id=$1", [r.holding_id])).rows[0];
    if (h) {
      if (r.kind === "interest") {
        await c.query("insert into investment_txns (family_id, entity_id, account_id, instrument_id, type, txn_date, quantity, price, amount, charges, source, hash) values ($1,$2,$3,$4,'interest',$5,0,0,$6,0,'manual',$7) on conflict do nothing", [familyId, h.entity_id, h.account_id, h.iid, receivedOn, total, `holdrcpt:${r.id}`]);
      } else if (Number(h.quantity) > 0) {
        const { applyInvestmentTxn } = await import("../routes/imports.js");
        const qty = Number(h.quantity);
        const t: any = { source: "manual", provider: h.aprov ?? "manual", account: { kind: h.akind ?? "demat", identifier: h.aident ?? "MANUAL" }, instrument: { id: h.iid, name: h.name, isin: h.isin, amfiCode: h.amfi_code, symbol: h.symbol, type: h.type }, type: "redemption", date: receivedOn, quantity: qty, price: Math.round(total / qty * 10000) / 10000 || 0.0001, amount: total, charges: 0, ref: `holdrcpt:${r.id}:redeem` };
        try { await applyInvestmentTxn(c, familyId, h.entity_id, t, null); note = "The units were redeemed and the holding is closed."; } catch (e: any) { note = `Payment recorded, but the units could not be redeemed automatically: ${e.message}`; }
      }
    }
    await c.query("update tasks set status='done', done_at=now(), verification = case when verification='pending' then 'verified' else verification end where family_id=$1 and status='open' and source_type='holding_receipt' and source_id=$2", [familyId, r.id]);
  }
  return { status, note };
}

/** Match expected receipts to real bank credits: right amount (an interest credit may be net of 10% TDS), inside the date window, in an account of the entity, and a narration that
 *  names the security or says interest / coupon / redemption. A match is final and silent; anything unmatched stays open for the user to confirm by hand. */
const KW = String.raw`(interest|\mint\M|coupon|redemp|matur|\mncd\M|\mbond\M|\msgb\M|\mgsec\M|g-sec|t-bill|tbill|debenture)`;
export async function reconcileHoldingReceipts(c: pg.PoolClient, familyId: string): Promise<number> {
  const open = (await c.query(`select r.*, r.due_date::text due, i.name iname, i.isin, i.type instrument_type from holding_receipts r join instruments i on i.id=r.instrument_id
    where r.family_id=$1 and r.status in ('expected','overdue','partial') order by r.due_date`, [familyId])).rows;
  let matched = 0;
  for (const r of open) {
    const exp = Number(r.expected_amount) - Number(r.received_amount); if (exp <= 0) continue;
    const lo = r.kind === "interest" ? exp * 0.895 : r.instrument_type === "sgb" ? 1 : exp * 0.99, hi = r.instrument_type === "sgb" && r.kind === "maturity" ? exp * 5 : exp * 1.01 + 1;
    const nameHit = `%${String(r.iname).split(/\s+/).slice(0, 2).join("%")}%`; const isin = r.isin ? `%${r.isin}%` : null;
    const hit = (await c.query(`select t.id, t.amount, t.txn_date::text txn_date, t.bank_account_id from bank_txns t
      where t.family_id=$1 and t.link_type in ('none','interest','redemption') and t.link_id is null and t.amount > 0
        and t.amount between $2::numeric and $3::numeric and t.txn_date between $4::date - 5 and $4::date + 15
        and t.bank_account_id in (select id from bank_accounts where entity_id=$5::uuid)
        and (t.narration ~* $6::text or t.narration ilike $7::text or ($8::text is not null and t.narration ilike $8::text))
        and not exists (select 1 from holding_receipts x where x.bank_txn_ref = t.id::text)
      order by abs(t.amount - $9::numeric), t.txn_date limit 1`, [familyId, lo, hi, r.due, r.entity_id, KW, nameHit, isin, exp])).rows[0];
    if (!hit) continue;
    const res = await settleHoldingReceipt(c, familyId, { ...r, due_date: r.due }, Math.abs(Number(hit.amount)), String(hit.txn_date).slice(0, 10), { bankAccountId: hit.bank_account_id, bankTxnRef: hit.id });
    await c.query("update bank_txns set link_type='holding_receipt', link_id=$2 where id=$1", [hit.id, r.id]);
    if (res.status === "received") matched++;
  }
  return matched;
}
