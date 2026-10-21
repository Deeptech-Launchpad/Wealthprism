/**
 * Balance-sheet completeness (PRD 3.14; FO-90..94): net worth = every asset (investments, property, private and operating stakes, cash,
 * lifestyle assets, policy values) − every liability, headline by entity and look-through by ultimate owner; liabilities with amortisation,
 * EMI matching to bank debits and an LTV monitor; the insurance register with coverage adequacy; lifestyle assets with valuation history;
 * the ownership graph; nominations, succession documents and the gap report. Everything runs inside the caller's family transaction.
 */
import type pg from "pg";
import { amortise, ltv as ltvOf, matchEmi, ultimateOwners, lifeCoverAdequacy, premiumDates, type ScheduleRow } from "@fo/finance";
import { activeDepositValues } from "./depositvalue.js";
import { notifyTask } from "./notify.js";

export class BalanceError extends Error { constructor(public status: number, m: string, public extra?: any) { super(m); } }
export const today = () => new Date().toISOString().slice(0, 10);
export const iso = (d: any) => (d == null ? null : typeof d === "string" ? d.slice(0, 10) : new Date(d).toISOString().slice(0, 10));
const r2 = (n: number) => Math.round(n * 100) / 100;
const money = (v: unknown) => (v == null ? "0.00" : Number(v).toFixed(2));
const FREQ: Record<string, number | undefined> = { monthly: 12, quarterly: 4, half_yearly: 2, yearly: 1, single: 0 };
const addDays = (d: string, n: number) => new Date(Date.parse(d + "T00:00:00Z") + n * 86400000).toISOString().slice(0, 10);

// ---------- assets, liabilities and look-through ----------
export interface AssetRow { type: string; id: string; name: string; entity_id: string; klass: string; value: number }
/** Every asset the family holds, valued as of today, with the class it reports under. */
export async function assetRows(c: pg.PoolClient, familyId: string, entityId?: string | null): Promise<AssetRow[]> {
  const out: AssetRow[] = [];
  for (const h of (await c.query(`select h.id, h.entity_id, i.name, i.asset_class, i.type, round(h.quantity * coalesce(p.close, h.avg_cost), 2) value from holdings h join instruments i on i.id=h.instrument_id
      left join lateral (select close from prices where instrument_id=i.id order by price_date desc limit 1) p on true where h.family_id=$1 and h.quantity > 0 and ($2::uuid is null or h.entity_id=$2)`, [familyId, entityId ?? null])).rows) out.push({ type: "holding", id: h.id, name: h.name, entity_id: h.entity_id, klass: ["pms", "aif"].includes(h.type) ? "alternatives" : h.asset_class === "equity" || h.type === "stock" ? "equity" : /debt|bond|liquid|arbitrage|gsec|tbill|fd/.test(String(h.asset_class) + h.type) ? "debt" : h.type === "gold" || h.type === "sgb" ? "gold" : "other_investments", value: Number(h.value) });
  for (const p of (await c.query(`select p.id, p.name, coalesce((select value from property_valuations v where v.property_id=p.id order by valued_on desc limit 1), p.acquisition_cost) value, o.entity_id, o.ownership_pct from properties p join property_owners o on o.property_id=p.id where p.family_id=$1 and p.deleted_at is null and ($2::uuid is null or o.entity_id=$2)`, [familyId, entityId ?? null])).rows) out.push({ type: "property", id: p.id, name: p.name, entity_id: p.entity_id, klass: "real_estate", value: r2(Number(p.value) * Number(p.ownership_pct) / 100) });
  for (const pi of (await c.query(`select pi.id, pi.entity_id, pi.instrument, co.name, pi.amount, pi.holding_pct, pi.business_profit, pi.business_multiple, (select value from private_marks m where m.private_investment_id=pi.id order by marked_on desc limit 1) mark from private_investments pi join private_companies co on co.id=pi.company_id where pi.family_id=$1 and pi.status <> 'written_off' and ($2::uuid is null or pi.entity_id=$2)`, [familyId, entityId ?? null])).rows) {
    const business = pi.instrument === "operating_business"; const value = business && pi.business_profit != null && pi.business_multiple != null ? r2(Number(pi.business_profit) * Number(pi.business_multiple) * (Number(pi.holding_pct ?? 100) / 100)) : Number(pi.mark ?? pi.amount);
    out.push({ type: "private_investment", id: pi.id, name: pi.name, entity_id: pi.entity_id, klass: business ? "operating_business" : "private", value });
  }
  for (const b of (await c.query("select id, entity_id, bank||' '||account_masked name, balance, type from bank_accounts where family_id=$1 and deleted_at is null and ($2::uuid is null or entity_id=$2)", [familyId, entityId ?? null])).rows) { if (Number(b.balance) >= 0 && b.type !== "card") out.push({ type: "bank_account", id: b.id, name: b.name, entity_id: b.entity_id, klass: "cash", value: Number(b.balance) }); }
  for (const a of (await c.query("select id, entity_id, name, current_value from lifestyle_assets where family_id=$1 and deleted_at is null and include_in_net_worth and ($2::uuid is null or entity_id=$2)", [familyId, entityId ?? null])).rows) out.push({ type: "lifestyle_asset", id: a.id, name: a.name, entity_id: a.entity_id, klass: "lifestyle", value: Number(a.current_value ?? 0) });
  for (const p of (await c.query("select id, entity_id, insurer||' '||kind name, coalesce(fund_value, surrender_value) v from insurance_policies where family_id=$1 and deleted_at is null and status='active' and coalesce(fund_value, surrender_value) is not null and ($2::uuid is null or entity_id=$2)", [familyId, entityId ?? null])).rows) out.push({ type: "insurance_policy", id: p.id, name: p.name, entity_id: p.entity_id, klass: "insurance_value", value: Number(p.v) });
  for (const d of await activeDepositValues(c, familyId, entityId)) out.push({ type: "deposit", id: d.id, name: `${d.bank} ${d.kind.toUpperCase()}${d.account_no ? ` · ${d.account_no}` : ""}`, entity_id: d.entity_id, klass: "debt", value: d.value });
  return out;
}
export async function liabilityRows(c: pg.PoolClient, familyId: string, entityId?: string | null) {
  const rows = (await c.query("select id, entity_id, kind, lender, outstanding from liabilities where family_id=$1 and status='active' and deleted_at is null and ($2::uuid is null or entity_id=$2)", [familyId, entityId ?? null])).rows.map((l) => ({ type: "liability", id: l.id, name: `${l.lender} · ${String(l.kind).replace(/_/g, " ")}`, entity_id: l.entity_id, klass: l.kind, value: Number(l.outstanding) }));
  for (const b of (await c.query("select id, entity_id, bank||' '||account_masked name, balance from bank_accounts where family_id=$1 and deleted_at is null and balance < 0 and ($2::uuid is null or entity_id=$2)", [familyId, entityId ?? null])).rows) rows.push({ type: "card", id: b.id, name: b.name, entity_id: b.entity_id, klass: "card_due", value: -Number(b.balance) });
  return rows;
}
/** The balance sheet: assets − liabilities by entity and class, plus look-through by ultimate owner through the ownership graph. */
export async function netWorth(c: pg.PoolClient, familyId: string, opts: { entityId?: string | null; asOf?: string } = {}) {
  const asOf = opts.asOf ?? today(); const ents = (await c.query("select id, name, type from entities where family_id=$1 and deleted_at is null order by created_at", [familyId])).rows;
  const assets = await assetRows(c, familyId, opts.entityId); const liabilities = await liabilityRows(c, familyId, opts.entityId);
  const edges = (await c.query("select owner_entity_id, owned_type, owned_id, pct, effective_from::text, effective_to::text from ownership_links where family_id=$1", [familyId])).rows.map((e) => ({ ...e, pct: Number(e.pct) }));
  const byEntity: Record<string, any> = {}; const ent = (id: string) => (byEntity[id] ??= { entity_id: id, name: ents.find((e) => e.id === id)?.name ?? "—", type: ents.find((e) => e.id === id)?.type, assets: 0, liabilities: 0, net_worth: 0, by_class: {} as Record<string, number>, lookthrough: 0 });
  const byClass: Record<string, number> = {};
  for (const a of assets) { const e = ent(a.entity_id); e.assets += a.value; e.by_class[a.klass] = (e.by_class[a.klass] ?? 0) + a.value; byClass[a.klass] = (byClass[a.klass] ?? 0) + a.value; }
  for (const l of liabilities) { const e = ent(l.entity_id); e.liabilities += l.value; }
  const individuals = new Set(ents.filter((e) => e.type === "individual").map((e) => e.id));
  for (const a of assets) { const owners = edges.some((e) => e.owned_type === a.type && e.owned_id === a.id) ? ultimateOwners(edges, a.type, a.id, asOf, { individuals }) : ultimateOwners(edges, "entity", a.entity_id, asOf, { individuals }); const total = Object.values(owners).reduce((s, v) => s + v, 0); if (!total) { ent(a.entity_id).lookthrough += a.value; continue; } for (const [id, pct] of Object.entries(owners)) ent(id).lookthrough += (a.value * pct) / 100; }
  for (const l of liabilities) { const owners = ultimateOwners(edges, "entity", l.entity_id, asOf, { individuals }); const total = Object.values(owners).reduce((s, v) => s + v, 0); if (!total) { ent(l.entity_id).lookthrough -= l.value; continue; } for (const [id, pct] of Object.entries(owners)) ent(id).lookthrough -= (l.value * pct) / 100; }
  const totalAssets = assets.reduce((s, a) => s + a.value, 0), totalLiab = liabilities.reduce((s, l) => s + l.value, 0);
  return {
    as_of: asOf, assets: money(totalAssets), liabilities: money(totalLiab), net_worth: money(totalAssets - totalLiab),
    by_class: Object.entries(byClass).map(([klass, value]) => ({ klass, value: money(value), pct: totalAssets ? r2((value / totalAssets) * 100) : 0 })).sort((a, b) => Number(b.value) - Number(a.value)),
    by_entity: Object.values(byEntity).map((e) => ({ entity_id: e.entity_id, name: e.name, type: e.type, assets: money(e.assets), liabilities: money(e.liabilities), net_worth: money(e.assets - e.liabilities), lookthrough_net_worth: money(e.lookthrough), by_class: Object.fromEntries(Object.entries(e.by_class).map(([k, v]) => [k, money(v as number)])) })),
    liabilities_detail: liabilities.map((l) => ({ ...l, value: money(l.value) })), asset_count: assets.length,
    note: "Headline net worth attributes each asset to the entity that holds it; look-through follows the ownership graph to the ultimate individual owners.",
  };
}

// ---------- A1 liabilities ----------
export const liabilityView = (l: any) => ({ ...l, principal_original: money(l.principal_original), outstanding: money(l.outstanding), emi: l.emi == null ? null : money(l.emi), rate_pct: l.rate_pct == null ? null : Number(l.rate_pct), ltv_pct: l.ltv_pct == null ? null : Number(l.ltv_pct), ltv_alert_pct: l.ltv_alert_pct == null ? null : Number(l.ltv_alert_pct), security_value: l.security_value == null ? null : money(l.security_value), outstanding_as_of: iso(l.outstanding_as_of), start_date: iso(l.start_date), end_date: iso(l.end_date), ltv_breach: l.ltv_pct != null && l.ltv_alert_pct != null && Number(l.ltv_pct) > Number(l.ltv_alert_pct) });
/** (Re)build the schedule from the loan terms: paid rows are kept, unpaid future rows are replaced. */
export async function regenerateSchedule(c: pg.PoolClient, l: any): Promise<ScheduleRow[]> {
  if (l.interest_only || !l.start_date || (!l.emi && !l.end_date)) { await c.query("delete from liability_schedule where liability_id=$1 and paid_on is null", [l.id]); return []; }
  const start = iso(l.start_date)!; const months = l.end_date ? Math.max(1, Math.round((Date.parse(iso(l.end_date)!) - Date.parse(start)) / (86400000 * 30.4375))) : null;
  const rows = amortise({ principal: Number(l.principal_original), ratePct: Number(l.rate_pct ?? 0), emi: l.emi ? Number(l.emi) : null, months: l.emi ? null : months, start, emiDay: l.emi_day ?? null });
  await c.query("delete from liability_schedule where liability_id=$1 and paid_on is null", [l.id]);
  for (const r of rows) await c.query("insert into liability_schedule (liability_id, due_date, principal, interest) values ($1,$2,$3,$4) on conflict (liability_id, due_date) do nothing", [l.id, r.due_date, r.principal, r.interest]);
  return rows;
}
export async function liabilitySchedule(c: pg.PoolClient, id: string) { return (await c.query("select id, due_date::text, principal, interest, (principal+interest) emi, paid_on::text, bank_txn_id, matched_at from liability_schedule where liability_id=$1 order by due_date", [id])).rows.map((r) => ({ ...r, principal: money(r.principal), interest: money(r.interest), emi: money(r.emi) })); }
/** Outstanding from the schedule (paid principal) for amortising loans; interest-only lines keep what the lender reports. */
export async function refreshOutstanding(c: pg.PoolClient, id: string) {
  const l = (await c.query("select * from liabilities where id=$1", [id])).rows[0]; if (!l || l.interest_only) return l;
  const paid = Number((await c.query("select coalesce(sum(principal),0) v from liability_schedule where liability_id=$1 and paid_on is not null", [id])).rows[0].v);
  return (await c.query("update liabilities set outstanding=greatest(0, principal_original - $2), outstanding_as_of=coalesce((select max(paid_on) from liability_schedule where liability_id=$1), outstanding_as_of), updated_at=now() where id=$1 returning *", [id, paid])).rows[0];
}
/** Match unpaid instalments to bank debits (same amount ±1%, ±5 days) on the loan's bank account. */
export async function matchEmis(c: pg.PoolClient, familyId: string, day = today()) {
  const due = (await c.query(`select s.id, s.due_date::text, (s.principal + s.interest) emi, l.id liability_id, l.bank_account_id, l.entity_id from liability_schedule s join liabilities l on l.id=s.liability_id where l.family_id=$1 and s.paid_on is null and s.due_date <= $2::date + 5 and l.bank_account_id is not null and l.status='active'`, [familyId, day])).rows;
  let matched = 0; const touched = new Set<string>();
  for (const row of due) {
    const debits = (await c.query("select id, txn_date::text, amount from bank_txns where family_id=$1 and bank_account_id=$2 and amount < 0 and txn_date between $3::date - 7 and $3::date + 7 and id not in (select bank_txn_id from liability_schedule where bank_txn_id is not null)", [familyId, row.bank_account_id, row.due_date])).rows.map((d) => ({ id: d.id, txn_date: d.txn_date, amount: Number(d.amount) }));
    const hit = matchEmi({ due_date: row.due_date, emi: Number(row.emi) }, debits); if (!hit) continue;
    await c.query("update liability_schedule set paid_on=$2, bank_txn_id=$3, matched_at=now() where id=$1", [row.id, hit.txn_date, hit.id]);
    await c.query("update bank_txns set category_id=coalesce(category_id, (select id from categories where name='EMI' and (family_id=$2 or family_id is null) limit 1)) where id=$1", [hit.id, familyId]);
    matched++; touched.add(row.liability_id);
  }
  for (const id of touched) await refreshOutstanding(c, id);
  return { rows: matched, note: `${matched} EMI${matched === 1 ? "" : "s"} matched to bank debits` };
}
/** LTV against the current value of the security; loans above their alert level raise a task through the generator. */
export async function refreshLtv(c: pg.PoolClient, familyId: string) {
  const loans = (await c.query("select * from liabilities where family_id=$1 and status='active' and deleted_at is null and secured_by_type is not null", [familyId])).rows; let n = 0;
  for (const l of loans) {
    let value: number | null = null;
    if (l.secured_by_type === "property") value = Number((await c.query("select coalesce((select value from property_valuations v where v.property_id=$1 order by valued_on desc limit 1), acquisition_cost) v from properties where id=$1", [l.secured_by_id])).rows[0]?.v ?? 0) || null;
    else if (l.secured_by_type === "holding") value = Number((await c.query("select round(h.quantity * coalesce((select close from prices where instrument_id=h.instrument_id order by price_date desc limit 1), h.avg_cost), 2) v from holdings h where h.id=$1", [l.secured_by_id])).rows[0]?.v ?? 0) || null;
    else if (l.secured_by_type === "lifestyle_asset") value = Number((await c.query("select current_value v from lifestyle_assets where id=$1", [l.secured_by_id])).rows[0]?.v ?? 0) || null;
    else if (l.secured_by_type === "private_investment") value = Number((await c.query("select coalesce((select value from private_marks m where m.private_investment_id=pi.id order by marked_on desc limit 1), pi.amount) v from private_investments pi where pi.id=$1", [l.secured_by_id])).rows[0]?.v ?? 0) || null;
    await c.query("update liabilities set security_value=$2, ltv_pct=$3, updated_at=now() where id=$1", [l.id, value, ltvOf(Number(l.outstanding), value)]); n++;
  }
  return { rows: n, note: `${n} secured loans re-measured` };
}
/** EMIs due in the next three months and premiums due in the next ninety days become committed outflows (working capital float, funding needs). */
export async function syncOutflows(c: pg.PoolClient, familyId: string, day = today()) {
  let n = 0; const until = addDays(day, 92);
  for (const s of (await c.query("select s.id, s.due_date::text, (s.principal+s.interest) amount, l.entity_id, l.lender, l.kind from liability_schedule s join liabilities l on l.id=s.liability_id where l.family_id=$1 and l.status='active' and s.paid_on is null and s.due_date between $2 and $3", [familyId, day, until])).rows) {
    const r = await c.query("insert into committed_outflows (family_id, entity_id, kind, label, due_date, amount, source_type, source_id, status) select $1,$2,'emi',$3,$4,$5,'liability_schedule',$6,'pending' where not exists (select 1 from committed_outflows where family_id=$1 and source_type='liability_schedule' and source_id=$6)", [familyId, s.entity_id, `EMI — ${s.lender} ${String(s.kind).replace(/_/g, " ")}`, s.due_date, s.amount, s.id]); n += r.rowCount ?? 0;
  }
  for (const p of (await c.query("select id, entity_id, insurer, kind, premium, premium_frequency, next_premium_due::text from insurance_policies where family_id=$1 and status='active' and deleted_at is null and next_premium_due is not null and next_premium_due <= $2", [familyId, until])).rows) {
    const r = await c.query("insert into committed_outflows (family_id, entity_id, kind, label, due_date, amount, source_type, source_id, status) select $1,$2,'manual',$3,$4,$5,'insurance_policy',$6,'pending' where not exists (select 1 from committed_outflows where family_id=$1 and source_type='insurance_policy' and source_id=$6 and due_date=$4)", [familyId, p.entity_id, `Premium — ${p.insurer} ${p.kind}`, p.next_premium_due, p.premium, p.id]); n += r.rowCount ?? 0;
  }
  // an rd instalment is a dated, certain outflow: it must reduce the deployable cash (working capital) and show in the forecast
  for (const r of (await c.query("select r.id, r.due_date::text due, r.expected_amount amount, d.entity_id, d.bank, d.account_no from deposit_receipts r join deposits d on d.id=r.deposit_id where d.family_id=$1 and d.status='active' and r.kind='contribution' and r.status in ('expected','overdue','partial') and r.due_date between $2 and $3", [familyId, day, until])).rows) {
    const x = await c.query("insert into committed_outflows (family_id, entity_id, kind, label, due_date, amount, source_type, source_id, status) select $1,$2,'manual',$3,$4,$5,'deposit_receipt',$6,'pending' where not exists (select 1 from committed_outflows where family_id=$1 and source_type='deposit_receipt' and source_id=$6)", [familyId, r.entity_id, `RD instalment — ${r.bank}${r.account_no ? ` ${r.account_no}` : ""}`, r.due, r.amount, r.id]); n += x.rowCount ?? 0;
  }
  await c.query("update committed_outflows o set status='done' where o.family_id=$1 and o.status='pending' and o.source_type='liability_schedule' and exists (select 1 from liability_schedule s where s.id=o.source_id and s.paid_on is not null)", [familyId]);
  await c.query("update committed_outflows o set status='done' where o.family_id=$1 and o.status='pending' and o.source_type='deposit_receipt' and exists (select 1 from deposit_receipts r where r.id=o.source_id and r.status='received')", [familyId]);
  await c.query("delete from committed_outflows o where o.family_id=$1 and o.status='pending' and o.source_type='deposit_receipt' and not exists (select 1 from deposit_receipts r where r.id=o.source_id)", [familyId]);
  return { rows: n, note: `${n} committed outflows added` };
}

// ---------- A2 insurance ----------
export const policyView = (p: any) => ({ ...p, sum_assured: money(p.sum_assured), premium: money(p.premium), surrender_value: p.surrender_value == null ? null : money(p.surrender_value), fund_value: p.fund_value == null ? null : money(p.fund_value), next_premium_due: iso(p.next_premium_due), start_date: iso(p.start_date), maturity_date: iso(p.maturity_date), premium_annualised: money(Number(p.premium) * (FREQ[p.premium_frequency] ?? 1)) });
/** Coverage adequacy: life cover vs liabilities + goals + income replacement per individual; health cover per member; uninsured properties and vehicles. */
export async function adequacy(c: pg.PoolClient, familyId: string) {
  const ents = (await c.query("select id, name, type from entities where family_id=$1 and deleted_at is null", [familyId])).rows; const policies = (await c.query("select * from insurance_policies where family_id=$1 and deleted_at is null and status='active'", [familyId])).rows;
  const liabilities = (await c.query("select entity_id, sum(outstanding) v from liabilities where family_id=$1 and status='active' and deleted_at is null group by entity_id", [familyId])).rows;
  const goals = (await c.query("select entity_id, name, amount_today, inflation_pct, target_year, funded_pct from goals where family_id=$1 and status='active'", [familyId])).rows;
  const spend = Number((await c.query("select coalesce(avg(m),0) v from (select date_trunc('month', txn_date) mo, sum(-amount) m from bank_txns where family_id=$1 and amount < 0 and txn_date >= current_date - 180 group by 1) x", [familyId])).rows[0].v);
  const year = new Date().getUTCFullYear();
  const life = ents.filter((e) => e.type === "individual").map((e) => {
    const covers = policies.filter((p) => ["term_life", "endowment", "ulip"].includes(p.kind) && (p.entity_id === e.id || (p.covers_members ?? []).includes(e.name) || p.life_assured === e.name)).map((p) => ({ kind: p.kind, sum_assured: Number(p.sum_assured), status: p.status }));
    const liab = Number(liabilities.find((l) => l.entity_id === e.id)?.v ?? 0); const goalNeed = goals.filter((g) => g.entity_id === e.id).reduce((s, g) => s + Number(g.amount_today) * Math.pow(1 + Number(g.inflation_pct ?? 6) / 100, Math.max(0, Number(g.target_year) - year)) * (1 - Number(g.funded_pct ?? 0) / 100), 0);
    return { entity_id: e.id, name: e.name, ...lifeCoverAdequacy(covers, liab, r2(goalNeed), r2(spend * 12 / Math.max(1, ents.filter((x) => x.type === "individual").length)), 10), liabilities: money(liab), goals_need: money(goalNeed), policies: covers.length };
  });
  const members = [...new Set([...ents.filter((e) => e.type === "individual").map((e) => e.name), ...policies.flatMap((p) => p.covers_members ?? [])])];
  const health = members.map((m) => ({ member: m, health_cover: money(policies.filter((p) => ["health", "critical_illness"].includes(p.kind) && (p.covers_members ?? []).includes(m)).reduce((s, p) => s + Number(p.sum_assured), 0)), policies: policies.filter((p) => ["health", "critical_illness"].includes(p.kind) && (p.covers_members ?? []).includes(m)).map((p) => `${p.insurer} ${p.kind}`) }));
  const props = (await c.query("select p.id, p.name, coalesce((select value from property_valuations v where v.property_id=p.id order by valued_on desc limit 1), p.acquisition_cost) value from properties p where p.family_id=$1 and p.deleted_at is null", [familyId])).rows;
  const things = (await c.query("select id, kind, name, current_value, insured_policy_id from lifestyle_assets where family_id=$1 and deleted_at is null", [familyId])).rows;   // vehicles, jewellery, art … anything insurable
  const uninsured = [...props.filter((p) => !policies.some((x) => x.kind === "property" && x.covers_id === p.id)).map((p) => ({ type: "property", id: p.id, name: p.name, value: money(p.value) })), ...things.filter((v) => !v.insured_policy_id && !policies.some((x) => ["vehicle", "property", "other"].includes(x.kind) && x.covers_id === v.id)).map((v) => ({ type: v.kind, id: v.id, name: v.name, value: money(v.current_value ?? 0) }))];
  const calendar = policies.flatMap((p) => (p.next_premium_due ? premiumDates(iso(p.next_premium_due)!, p.premium_frequency, addDays(today(), 365)).map((d) => ({ due: d, policy_id: p.id, insurer: p.insurer, kind: p.kind, amount: money(p.premium), entity_id: p.entity_id })) : [])).sort((a, b) => a.due.localeCompare(b.due));
  return { life, health, uninsured, premium_calendar: calendar, annual_premiums: money(policies.reduce((s, p) => s + Number(p.premium) * (FREQ[p.premium_frequency] ?? 1), 0)) };
}

// ---------- A3 lifestyle ----------
export const lifestyleView = (a: any) => ({ ...a, cost: a.cost == null ? null : money(a.cost), current_value: a.current_value == null ? null : money(a.current_value), acquired_on: iso(a.acquired_on), valued_on: iso(a.valued_on) });

// ---------- B1 ownership graph ----------
export async function ownershipGraph(c: pg.PoolClient, familyId: string, asOf = today()) {
  const ents = (await c.query("select id, name, type from entities where family_id=$1 and deleted_at is null order by created_at", [familyId])).rows;
  const edges = (await c.query("select id, owner_entity_id, owned_type, owned_id, pct, role, effective_from::text, effective_to::text from ownership_links where family_id=$1 order by effective_from", [familyId])).rows.map((e) => ({ ...e, pct: Number(e.pct) }));
  const assets = await assetRows(c, familyId); const nw = await netWorth(c, familyId, { asOf });
  const nodes = [...ents.map((e) => ({ id: e.id, type: "entity", name: e.name, entity_type: e.type, value: Number(nw.by_entity.find((x) => x.entity_id === e.id)?.assets ?? 0) })), ...assets.filter((a) => a.type !== "bank_account" && a.type !== "insurance_policy").map((a) => ({ id: a.id, type: a.type, name: a.name, entity_id: a.entity_id, value: a.value }))];
  const live = edges.filter((e) => (!e.effective_from || e.effective_from <= asOf) && (!e.effective_to || e.effective_to > asOf));
  return { as_of: asOf, nodes, edges: live, history: edges.filter((e) => !live.includes(e)), lookthrough_net_worth: nw.by_entity.map((e) => ({ entity_id: e.entity_id, name: e.name, type: e.type, headline: e.net_worth, value: e.lookthrough_net_worth })) };
}
/** Replace the live links for the pairs given: identical links are kept, changed ones are closed today and re-opened, so history survives. */
export async function replaceLinks(c: pg.PoolClient, familyId: string, links: { owner_entity_id: string; owned_type: string; owned_id: string; pct: number; role?: string | null; effective_from?: string | null }[], day = today()) {
  let changed = 0;
  for (const l of links) {
    const same = (await c.query("select id from ownership_links where family_id=$1 and owner_entity_id=$2 and owned_type=$3 and owned_id=$4 and pct=$5 and (effective_to is null or effective_to > $6)", [familyId, l.owner_entity_id, l.owned_type, l.owned_id, l.pct, day])).rows[0]; if (same) continue;
    await c.query("update ownership_links set effective_to=$5 where family_id=$1 and owner_entity_id=$2 and owned_type=$3 and owned_id=$4 and (effective_to is null or effective_to > $5)", [familyId, l.owner_entity_id, l.owned_type, l.owned_id, day]);
    await c.query("insert into ownership_links (family_id, owner_entity_id, owned_type, owned_id, pct, role, effective_from) values ($1,$2,$3,$4,$5,$6,$7) on conflict (owner_entity_id, owned_type, owned_id, effective_from) do update set pct=excluded.pct, role=excluded.role, effective_to=null", [familyId, l.owner_entity_id, l.owned_type, l.owned_id, l.pct, l.role ?? null, l.effective_from ?? day]); changed++;
  }
  const bad = (await c.query("select owned_type, owned_id, sum(pct) s from ownership_links where family_id=$1 and (effective_to is null or effective_to > $2) group by 1,2 having sum(pct) > 100.01", [familyId, day])).rows;
  if (bad.length) throw new BalanceError(422, `Ownership exceeds 100% for ${bad.map((b) => `${b.owned_type} ${String(b.owned_id).slice(0, 8)} (${Number(b.s)}%)`).join(", ")}`);
  return changed;
}

// ---------- B3 nominations and succession ----------
export async function nominationView(n: any) { return { ...n, share_pct: Number(n.share_pct), registered_on: iso(n.registered_on), verified_on: iso(n.verified_on) }; }
/** Every nominable asset of the family's individuals with its nominations, and the gap list. */
export async function successionGaps(c: pg.PoolClient, familyId: string, day = today()) {
  const ents = (await c.query("select id, name, type from entities where family_id=$1 and deleted_at is null", [familyId])).rows; const individuals = ents.filter((e) => e.type === "individual").map((e) => e.id);
  const assets: { asset_type: string; asset_id: string; name: string; entity_id: string; value: number }[] = [];
  for (const h of (await c.query("select h.id, h.entity_id, i.name, round(h.quantity * coalesce((select close from prices where instrument_id=i.id order by price_date desc limit 1), h.avg_cost), 2) value from holdings h join instruments i on i.id=h.instrument_id where h.family_id=$1 and h.quantity > 0 and h.entity_id = any($2)", [familyId, individuals])).rows) assets.push({ asset_type: "holding", asset_id: h.id, name: h.name, entity_id: h.entity_id, value: Number(h.value) });
  for (const a of (await c.query("select id, entity_id, provider||' '||kind||' '||identifier_masked name from accounts where family_id=$1 and deleted_at is null and entity_id = any($2)", [familyId, individuals])).rows) assets.push({ asset_type: "account", asset_id: a.id, name: a.name, entity_id: a.entity_id, value: 0 });
  for (const b of (await c.query("select id, entity_id, bank||' '||account_masked name, balance from bank_accounts where family_id=$1 and deleted_at is null and type <> 'card' and entity_id = any($2)", [familyId, individuals])).rows) assets.push({ asset_type: "bank_account", asset_id: b.id, name: b.name, entity_id: b.entity_id, value: Number(b.balance) });
  for (const p of (await c.query("select p.id, p.name, o.entity_id, coalesce((select value from property_valuations v where v.property_id=p.id order by valued_on desc limit 1), p.acquisition_cost) value from properties p join property_owners o on o.property_id=p.id where p.family_id=$1 and p.deleted_at is null and o.entity_id = any($2)", [familyId, individuals])).rows) assets.push({ asset_type: "property", asset_id: p.id, name: p.name, entity_id: p.entity_id, value: Number(p.value) });
  for (const p of (await c.query("select id, entity_id, insurer||' '||kind name, sum_assured, nominee from insurance_policies where family_id=$1 and deleted_at is null and status='active' and entity_id = any($2)", [familyId, individuals])).rows) assets.push({ asset_type: "insurance_policy", asset_id: p.id, name: p.name, entity_id: p.entity_id, value: Number(p.sum_assured) });
  for (const pi of (await c.query("select pi.id, pi.entity_id, co.name, coalesce((select value from private_marks m where m.private_investment_id=pi.id order by marked_on desc limit 1), pi.amount) value from private_investments pi join private_companies co on co.id=pi.company_id where pi.family_id=$1 and pi.status <> 'written_off' and pi.entity_id = any($2)", [familyId, individuals])).rows) assets.push({ asset_type: "private_investment", asset_id: pi.id, name: pi.name, entity_id: pi.entity_id, value: Number(pi.value) });
  for (const a of (await c.query("select id, entity_id, name, current_value from lifestyle_assets where family_id=$1 and deleted_at is null and entity_id = any($2)", [familyId, individuals])).rows) assets.push({ asset_type: "lifestyle_asset", asset_id: a.id, name: a.name, entity_id: a.entity_id, value: Number(a.current_value ?? 0) });
  const noms = (await c.query("select * from nominations where family_id=$1", [familyId])).rows; const docs = (await c.query("select * from succession_documents where family_id=$1", [familyId])).rows;
  const gaps: { asset_type: string; asset_id: string; name: string; entity_id: string | null; entity: string; issue: string; detail: string; severity: 1 | 2 | 3; value: string }[] = [];
  const ename = (id: string | null) => ents.find((e) => e.id === id)?.name ?? "—";
  for (const a of assets) {
    const mine = noms.filter((n) => n.asset_type === a.asset_type && n.asset_id === a.asset_id);
    if (!mine.length) { if (a.asset_type === "insurance_policy" && (await c.query("select 1 from insurance_policies where id=$1 and nominee is not null", [a.asset_id])).rowCount) continue; gaps.push({ ...a, entity: ename(a.entity_id), issue: "no_nominee", detail: "No nominee recorded", severity: 3, value: money(a.value) }); continue; }
    if (mine.some((n) => !n.verified_on)) gaps.push({ ...a, entity: ename(a.entity_id), issue: "unverified", detail: `Nomination in favour of ${mine.filter((n) => !n.verified_on).map((n) => n.nominee_name).join(", ")} not verified with the ${mine[0].registered_with ?? "registrar"}`, severity: 3, value: money(a.value) });
    const share = mine.reduce((s, n) => s + Number(n.share_pct), 0); if (Math.abs(share - 100) > 0.01) gaps.push({ ...a, entity: ename(a.entity_id), issue: "share_mismatch", detail: `Nominee shares add to ${share}%`, severity: 2, value: money(a.value) });
  }
  for (const id of individuals) { const will = docs.find((d) => d.kind === "will" && d.entity_id === id); const has = assets.some((a) => a.entity_id === id); if (has && !will) gaps.push({ asset_type: "entity", asset_id: id, name: ename(id), entity_id: id, entity: ename(id), issue: "will_missing", detail: "No will on the register", severity: 2, value: "0.00" }); }
  for (const d of docs) if (d.review_due && iso(d.review_due)! < day) gaps.push({ asset_type: "succession_document", asset_id: d.id, name: `${String(d.kind).replace(/_/g, " ")} — ${ename(d.entity_id)}`, entity_id: d.entity_id, entity: ename(d.entity_id), issue: "review_overdue", detail: `Review was due ${iso(d.review_due)}`, severity: 2, value: "0.00" });
  // nominee named in a policy row but not in the nominations register → recorded once for visibility
  return { as_of: day, assets: assets.length, nominated: assets.filter((a) => noms.some((n) => n.asset_type === a.asset_type && n.asset_id === a.asset_id)).length, gaps, documents: docs.map((d) => ({ ...d, executed_on: iso(d.executed_on), review_due: iso(d.review_due), overdue: !!d.review_due && iso(d.review_due)! < day })) };
}
export { notifyTask };
