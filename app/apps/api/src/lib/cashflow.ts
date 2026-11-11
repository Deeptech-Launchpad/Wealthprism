// Monthly cash flow for the Income & expenses page. One place builds the figures the card shows:
// manual income and household entries, plus the items the app already knows about (rent, loan EMIs, insurance premiums, property running costs).
import type pg from "pg";

const num = (v: any) => Number(v ?? 0);
const r2 = (n: number) => Math.round(n * 100) / 100;
const PREMIUM_MONTHS: Record<string, number> = { monthly: 1, quarterly: 3, half_yearly: 6, yearly: 12 };

export async function cashflowSummary(c: pg.PoolClient, familyId: string) {
  // names of the linked assets, so each line can say which asset it belongs to
  const names = new Map<string, string>();
  for (const r of (await c.query("select id, name from properties where family_id=$1 and deleted_at is null", [familyId])).rows) names.set(r.id, r.name);
  for (const r of (await c.query("select id, name from lifestyle_assets where family_id=$1 and deleted_at is null", [familyId])).rows) names.set(r.id, r.name);
  for (const r of (await c.query("select id, insurer, kind from insurance_policies where family_id=$1 and deleted_at is null", [familyId])).rows) names.set(r.id, `${r.insurer} (${r.kind})`);
  for (const r of (await c.query("select id, institution, scheme from savings_accounts where family_id=$1", [familyId])).rows) names.set(r.id, `${r.institution} (${String(r.scheme).toUpperCase()})`);
  for (const r of (await c.query("select h.id, i.name from holdings h join instruments i on i.id=h.instrument_id where h.family_id=$1", [familyId])).rows) names.set(r.id, r.name);

  const lines: any[] = [];

  // 1. income you enter (stored as a yearly amount; shown monthly)
  for (const s of (await c.query("select s.id, s.kind, s.label, s.annual_amount, s.frequency, s.linked_type, s.linked_id, e.name entity_name from entity_income_sources s join entities e on e.id=s.entity_id where s.family_id=$1 order by s.label", [familyId])).rows) {
    lines.push({ id: s.id, group: "income", source: "manual", label: s.label, detail: `${s.entity_name} · ${s.kind}`, frequency: s.frequency, monthly: r2(num(s.annual_amount) / 12), auto: false, linked_type: s.linked_type, linked_id: s.linked_id });
  }

  // 2. rent from active leases (automatic)
  for (const l of (await c.query("select l.id, l.rent, l.property_id, p.name from leases l join properties p on p.id=l.property_id where l.family_id=$1 and l.status='active' and l.lease_kind='rent' and p.deleted_at is null", [familyId])).rows) {
    lines.push({ id: l.id, group: "income", source: "lease", label: "Rent from tenant", detail: "from the lease", frequency: "monthly", monthly: r2(num(l.rent)), auto: true, linked_type: "property", linked_id: l.property_id });
  }

  // 3. household expenses you enter. The amount is stored in monthly_amount whatever the frequency (monthly, yearly or once).
  for (const h of (await c.query("select h.id, h.category, h.label, h.monthly_amount, h.frequency, to_char(h.once_on,'YYYY-MM-DD') once_on, h.linked_type, h.linked_id, e.name entity_name from household_expenses h join entities e on e.id=h.entity_id where h.family_id=$1 and h.deleted_at is null order by h.label", [familyId])).rows) {
    const amt = num(h.monthly_amount);
    const monthly = h.frequency === "monthly" ? amt : h.frequency === "yearly" ? amt / 12 : 0;
    lines.push({ id: h.id, group: "expense", source: "manual", label: h.label, detail: `${h.entity_name} · ${h.category}`, frequency: h.frequency, monthly: r2(monthly), once_on: h.once_on, once_amount: h.frequency === "once" ? amt : null, auto: false, linked_type: h.linked_type, linked_id: h.linked_id });
  }

  // 4. loan EMIs (automatic)
  for (const l of (await c.query("select l.id, l.lender, l.emi, l.secured_by_type, l.secured_by_id from liabilities l where l.family_id=$1 and l.status='active' and l.deleted_at is null and coalesce(l.emi,0) > 0", [familyId])).rows) {
    const onProp = l.secured_by_type === "property";
    lines.push({ id: l.id, group: "expense", source: "loan", label: `EMI — ${l.lender}`, detail: "loan", frequency: "monthly", monthly: r2(num(l.emi)), auto: true, linked_type: onProp ? "property" : null, linked_id: onProp ? l.secured_by_id : null });
  }

  // 5. insurance premiums (automatic). A single premium is not a monthly cost, so it is left out here.
  for (const p of (await c.query("select id, insurer, kind, premium, premium_frequency from insurance_policies where family_id=$1 and deleted_at is null", [familyId])).rows) {
    const months = PREMIUM_MONTHS[p.premium_frequency];
    if (!months) continue;
    lines.push({ id: p.id, group: "expense", source: "insurance", label: `Premium — ${p.insurer}`, detail: p.kind, frequency: p.premium_frequency, monthly: r2(num(p.premium) / months), auto: true, linked_type: "insurance_policy", linked_id: p.id });
  }

  // 6. property running costs: last 12 months of maintenance, repairs, society and similar, averaged per month (automatic)
  for (const r of (await c.query("select p.id, coalesce(sum(e.amount),0) total from properties p left join property_expenses e on e.property_id=p.id and not e.capital_improvement and e.category <> 'loan_interest' and e.expense_date >= (current_date - interval '12 months') where p.family_id=$1 and p.deleted_at is null group by p.id", [familyId])).rows) {
    if (num(r.total) <= 0) continue;
    lines.push({ id: r.id, group: "expense", source: "property", label: "Running costs (last 12 months ÷ 12)", detail: "from the property expenses", frequency: "monthly", monthly: r2(num(r.total) / 12), auto: true, linked_type: "property", linked_id: r.id });
  }

  for (const l of lines) {
    const asset = l.linked_id ? names.get(l.linked_id) ?? null : null;
    l.asset = asset;
  }

  const sum = (g: string) => lines.filter((l) => l.group === g).reduce((s, l) => s + num(l.monthly), 0);
  const monthly_income = r2(sum("income"));
  const monthly_expenses = r2(sum("expense"));

  const byAsset = new Map<string, { asset: string; income: number; expenses: number }>();
  for (const l of lines) {
    const key = l.asset ?? "Not linked to an asset";
    const row = byAsset.get(key) ?? { asset: key, income: 0, expenses: 0 };
    if (l.group === "income") row.income = r2(row.income + num(l.monthly)); else row.expenses = r2(row.expenses + num(l.monthly));
    byAsset.set(key, row);
  }

  return {
    monthly_income,
    monthly_expenses,
    surplus: r2(monthly_income - monthly_expenses),
    lines,
    by_asset: [...byAsset.values()].sort((a, b) => a.asset.localeCompare(b.asset)),
    one_off: lines.filter((l) => l.once_amount != null).map((l) => ({ label: l.label, on: l.once_on, amount: l.once_amount, asset: l.asset })),
  };
}
