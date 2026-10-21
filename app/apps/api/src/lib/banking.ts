/** Banking helpers (PRD 3.4; FO-52, 54): categorisation rules with learning, internal-transfer detection, the cash-flow view and committed outflows. */
import type pg from "pg";
import { money } from "./db.js";

export class BankingError extends Error { constructor(public status: number, message: string, public extra?: Record<string, unknown>) { super(message); } }
export const today = () => new Date().toISOString().slice(0, 10);
const r2 = (n: number) => Math.round(n * 100) / 100;

/** A rule pattern from a narration: drop dates, references and amounts, keep the two or three longest words that name the counterparty. */
export function patternFromNarration(narration: string): string {
  const cleaned = narration.toUpperCase().replace(/\b\d[\d\/\-:.,]*\b/g, " ").replace(/\b(UPI|NEFT|IMPS|RTGS|ACH|NACH|ECS|POS|ATM|TXN|REF|TO|FROM|PAY|PAYMENT|DEBIT|CREDIT|D-|C-|PVT|LTD|LIMITED|INDIA|THE|AND|OF|BY|VIA|MOB|BIL|BILLDESK)\b/g, " ");
  const words = cleaned.split(/[^A-Z&']+/).filter((w) => w.length >= 3);
  if (!words.length) return narration.trim().slice(0, 40);
  const seen = new Set<string>(); const uniq = words.filter((w) => (seen.has(w) ? false : (seen.add(w), true)));
  const first = uniq[0]; const rest = uniq.slice(1, 3).filter((w) => w.length >= 4);
  return [first, ...rest].join("\\s+");
}

/** Rules for a family ordered by priority; a rule matches its field (narration | counterparty) case-insensitively. */
export async function matchRule(c: pg.PoolClient, familyId: string, txn: { narration: string; counterparty?: string | null }) {
  const rules = (await c.query("select id, pattern, field, category_id, link_type, link_id from categorisation_rules where family_id=$1 and active order by priority, created_at", [familyId])).rows;
  for (const r of rules) {
    const hay = r.field === "counterparty" ? txn.counterparty ?? "" : txn.narration;
    let ok = false; try { ok = new RegExp(r.pattern, "i").test(hay); } catch { ok = hay.toUpperCase().includes(String(r.pattern).toUpperCase()); }
    if (ok) { await c.query("update categorisation_rules set hits = hits + 1, last_hit_at = now() where id=$1", [r.id]); return r; }
  }
  return null;
}

export async function listRules(c: pg.PoolClient, familyId: string) {
  return (await c.query("select r.*, cat.name category from categorisation_rules r left join categories cat on cat.id=r.category_id where r.family_id=$1 order by r.priority, r.created_at", [familyId])).rows;
}

/** A learned rule from a transaction the user re-categorised: pattern from the narration, priority ahead of the keyword defaults. */
export async function learnRule(c: pg.PoolClient, familyId: string, userId: string | null, txn: { narration: string }, target: { category_id: string | null; link_type: string; link_id: string | null }) {
  const pattern = patternFromNarration(txn.narration);
  const existing = (await c.query("select id from categorisation_rules where family_id=$1 and pattern=$2 and coalesce(field,'narration')='narration'", [familyId, pattern])).rows[0];
  if (existing) { await c.query("update categorisation_rules set category_id=$2, link_type=$3, link_id=$4, learned=true, active=true where id=$1", [existing.id, target.category_id, target.link_type, target.link_id]); return { id: existing.id, pattern, updated: true }; }
  const r = (await c.query("insert into categorisation_rules (family_id, pattern, field, category_id, link_type, link_id, priority, learned, name, created_by) values ($1,$2,'narration',$3,$4,$5,5,true,$6,$7) returning id", [familyId, pattern, target.category_id, target.link_type, target.link_id, `Learned: ${pattern.replace(/\\s\+/g, " ")}`, userId])).rows[0];
  return { id: r.id, pattern, updated: false };
}

/** Re-run the rules over transactions — only the uncategorised / default-bucket ones unless `all`. Returns how many changed. */
export async function applyRules(c: pg.PoolClient, familyId: string, opts: { all?: boolean; days?: number } = {}) {
  const defaults = (await c.query("select id from categories where family_id is null and name in ('Household','Other income')")).rows.map((r) => r.id);
  const txns = (await c.query(`select id, narration, counterparty, amount, category_id, link_type from bank_txns where family_id=$1 and not is_transfer and txn_date >= current_date - $2::int ${opts.all ? "" : "and (category_id is null or category_id = any($3::uuid[]))"}`, opts.all ? [familyId, opts.days ?? 365] : [familyId, opts.days ?? 365, defaults])).rows;
  let changed = 0;
  for (const t of txns) {
    const r = await matchRule(c, familyId, t); if (!r) continue;
    if (r.category_id !== t.category_id || (r.link_type ?? "none") !== t.link_type) { await c.query("update bank_txns set category_id=$2, link_type=$3, link_id=coalesce($4, link_id), updated_at=now() where id=$1", [t.id, r.category_id, r.link_type ?? "none", r.link_id]); changed++; }
  }
  return { rows: changed, scanned: txns.length, note: `${changed} of ${txns.length} transactions re-categorised` };
}

/** Internal transfers: a debit in one own account and an equal credit in another within three days are one movement, not spend or income. */
export async function detectTransfers(c: pg.PoolClient, familyId: string, opts: { days?: number } = {}) {
  const cat = (await c.query("select id from categories where family_id is null and name='Internal transfer'")).rows[0]?.id ?? null;
  const debits = (await c.query("select id, bank_account_id, txn_date::text, amount, narration from bank_txns where family_id=$1 and amount < 0 and not is_transfer and link_type in ('none','transfer') and txn_date >= current_date - $2::int order by txn_date", [familyId, opts.days ?? 45])).rows;
  let pairs = 0;
  for (const d of debits) {
    const hit = (await c.query("select id, bank_account_id from bank_txns where family_id=$1 and bank_account_id <> $2 and amount = $3 and not is_transfer and link_type in ('none','transfer') and txn_date between $4::date - 3 and $4::date + 3 order by abs(txn_date - $4::date) limit 1", [familyId, d.bank_account_id, -Number(d.amount), d.txn_date])).rows[0];
    if (!hit) continue;
    await c.query("update bank_txns set is_transfer=true, transfer_txn_id=$2, link_type='transfer', category_id=coalesce($3, category_id), updated_at=now() where id=$1", [d.id, hit.id, cat]);
    await c.query("update bank_txns set is_transfer=true, transfer_txn_id=$2, link_type='transfer', category_id=coalesce($3, category_id), updated_at=now() where id=$1", [hit.id, d.id, cat]);
    pairs++;
  }
  return { rows: pairs, note: `${pairs} internal transfer pair${pairs === 1 ? "" : "s"} flagged` };
}

/** Cash flow for the window: inflows, outflows, net, by category (kind = inflow | outflow), by entity, by month; transfers excluded. */
export async function cashflow(c: pg.PoolClient, familyId: string, opts: { days?: number; entityId?: string | null } = {}) {
  const days = opts.days ?? 30; const from = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  const rows = (await c.query(`select t.amount, t.txn_date::text, coalesce(cat.name, case when t.amount > 0 then 'Other income' else 'Household' end) category, b.entity_id, e.name entity, b.bank||' '||b.account_masked account, t.counterparty, t.narration
      from bank_txns t join bank_accounts b on b.id=t.bank_account_id join entities e on e.id=b.entity_id left join categories cat on cat.id=t.category_id
      where t.family_id=$1 and t.txn_date >= $2 and not t.is_transfer and t.link_type <> 'transfer' and coalesce(cat.name,'') <> 'Internal transfer' and ($3::uuid is null or b.entity_id=$3)`, [familyId, from, opts.entityId ?? null])).rows;
  const inflows = rows.filter((r) => Number(r.amount) > 0).reduce((s, r) => s + Number(r.amount), 0), outflows = rows.filter((r) => Number(r.amount) < 0).reduce((s, r) => s - Number(r.amount), 0);
  const group = (key: (r: any) => string) => { const m = new Map<string, { inflow: number; outflow: number; n: number }>(); for (const r of rows) { const k = key(r); const e = m.get(k) ?? { inflow: 0, outflow: 0, n: 0 }; if (Number(r.amount) > 0) e.inflow += Number(r.amount); else e.outflow -= Number(r.amount); e.n++; m.set(k, e); } return m; };
  const byCat = [...group((r) => r.category).entries()].flatMap(([category, v]) => [v.inflow ? { category, kind: "inflow", amount: money(v.inflow), n: v.n } : null, v.outflow ? { category, kind: "outflow", amount: money(v.outflow), n: v.n } : null].filter(Boolean) as any[]).sort((a, b) => Number(b.amount) - Number(a.amount));
  const byEntity = [...group((r) => r.entity).entries()].map(([entity, v]) => ({ entity, inflows: money(v.inflow), outflows: money(v.outflow), net: money(v.inflow - v.outflow) }));
  const byMonth = [...group((r) => r.txn_date.slice(0, 7)).entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([month, v]) => ({ month, inflows: money(v.inflow), outflows: money(v.outflow), net: money(v.inflow - v.outflow) }));
  const top = [...group((r) => (r.counterparty ?? r.narration.replace(/\b\d[\d\/\-:.,]*\b/g, "").trim().slice(0, 40))).entries()].filter(([, v]) => v.outflow > 0).sort((a, b) => b[1].outflow - a[1].outflow).slice(0, 8).map(([counterparty, v]) => ({ counterparty, amount: money(v.outflow), n: v.n }));
  const transfers = Number((await c.query("select coalesce(sum(-amount),0) v from bank_txns t join bank_accounts b on b.id=t.bank_account_id where t.family_id=$1 and t.txn_date >= $2 and t.is_transfer and t.amount < 0 and ($3::uuid is null or b.entity_id=$3)", [familyId, from, opts.entityId ?? null])).rows[0].v);
  return { days, from, to: today(), inflows: money(inflows), outflows: money(outflows), net: money(inflows - outflows), transfers_excluded: money(transfers), txns: rows.length, by_category: byCat, by_entity: byEntity, by_month: byMonth, top_counterparties: top, savings_rate_pct: inflows ? r2(((inflows - outflows) / inflows) * 100) : null };
}

export const outflowView = (o: any) => ({ ...o, amount: money(o.amount), due_date: typeof o.due_date === "string" ? o.due_date.slice(0, 10) : new Date(o.due_date).toISOString().slice(0, 10), source: o.source_type ?? "manual" });
export async function listOutflows(c: pg.PoolClient, familyId: string, days = 90) {
  return (await c.query("select o.*, e.name entity_name from committed_outflows o left join entities e on e.id=o.entity_id where o.family_id=$1 and o.due_date between current_date - 7 and current_date + $2::int order by o.due_date, o.amount desc", [familyId, days])).rows.map(outflowView);
}
