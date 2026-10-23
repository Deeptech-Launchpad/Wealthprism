/** Task engine (FO-55): pluggable generators run hourly per family. Every generator is de-duplicated on
 *  (source_type, source_id) while a task is open, closes its own task when the source is resolved, and new tasks
 *  are fanned out to the family's notification channels. */
import type pg from "pg";
import { allocationBandDrafts, allocationReviewDrafts } from "../lib/allocation.js";
import { pool } from "../lib/db.js";
import { notifyTask } from "../lib/notify.js";
import { generateRentSchedule, fyOf } from "@fo/finance";
import { emitEvent } from "../lib/opendata.js";

export interface Draft { entity_id?: string | null; module: string; title: string; reason: string; amount?: number | null; due_date?: string | null; severity: 1 | 2 | 3; source_type: string; source_id: string; verification?: "na" | "pending" }
export interface Generator { name: string; run: (c: pg.PoolClient, familyId: string, today: string) => Promise<{ drafts: Draft[]; resolved?: { source_type: string; source_id: string }[] }> }
const iso = (d: any) => (d ? new Date(d).toISOString().slice(0, 10) : null);
const fmt = (d: any) => new Date(d).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });

export const generators: Generator[] = [
  { name: "rent_overdue", run: async (c, fam, today) => {
    // promote due → overdue past the grace period first, so the generator sees the current state
    const promoted = (await c.query(`update rent_schedule rs set status='overdue' from leases l where l.id=rs.lease_id and rs.status='due' and rs.due_date + l.grace_days < $1::date returning rs.id, rs.due_date, rs.expected_rent, l.property_id`, [today])).rows;
    for (const r of promoted) await emitEvent(c, fam, "rent.overdue", { rent_schedule_id: r.id, due_date: r.due_date, expected_rent: r.expected_rent, property_id: r.property_id }).catch(() => null);
    const rows = (await c.query(`select rs.id, rs.due_date, rs.expected_rent, rs.received_amount, p.name property, t.name tenant, (select entity_id from property_owners o where o.property_id=p.id order by ownership_pct desc limit 1) entity_id, ($1::date - rs.due_date) days
        from rent_schedule rs join leases l on l.id=rs.lease_id join properties p on p.id=l.property_id join tenants t on t.id=l.tenant_id where rs.status in ('overdue','partial') and rs.due_date < $1::date`, [today])).rows;
    return { drafts: rows.map((r) => ({ entity_id: r.entity_id, module: "real_estate", title: `Rent overdue ${r.days} d: ${r.property} — remind ${r.tenant}`, reason: `Due ${fmt(r.due_date)}, ${Number(r.received_amount) ? "part-paid" : "not received"}`, amount: Number(r.expected_rent) - Number(r.received_amount), due_date: iso(r.due_date), severity: 1 as const, source_type: "rent_schedule", source_id: r.id, verification: "pending" as const })),
      resolved: (await c.query("select id from rent_schedule where status in ('received','waived')")).rows.map((r) => ({ source_type: "rent_schedule", source_id: r.id })) };
  } },
  { name: "deposit_overdue", run: async (c, fam, today) => {
    const promoted = (await c.query(`update deposit_receipts r set status='overdue' from deposits d where d.id=r.deposit_id and r.status='expected' and r.due_date < $1::date returning r.id, r.due_date, r.expected_amount, r.deposit_id`, [today])).rows;
    for (const r of promoted) await emitEvent(c, fam, "deposit.overdue", { deposit_receipt_id: r.id, due_date: r.due_date, expected_amount: r.expected_amount, deposit_id: r.deposit_id }).catch(() => null);
    const rows = (await c.query(`select r.id, r.due_date, r.expected_amount, r.received_amount, r.kind, d.bank, d.account_no, d.entity_id, ($1::date - r.due_date) days
        from deposit_receipts r join deposits d on d.id=r.deposit_id where d.status='active' and r.status in ('overdue','partial') and r.due_date < $1::date`, [today])).rows;
    const label = (k: string) => k === "maturity" ? "Maturity" : k === "contribution" ? "RD instalment" : "Interest";
    return { drafts: rows.map((r) => ({ entity_id: r.entity_id, module: "investments", title: `${label(r.kind)} overdue ${r.days} d: ${r.bank}${r.account_no ? ` · ${r.account_no}` : ""}`, reason: `Due ${fmt(r.due_date)}, ${Number(r.received_amount) ? "part-paid" : "not received"}`, amount: Number(r.expected_amount) - Number(r.received_amount), due_date: iso(r.due_date), severity: 1 as const, source_type: "deposit_receipt", source_id: r.id, verification: "pending" as const })),
      resolved: (await c.query("select id from deposit_receipts where status='received'")).rows.map((r) => ({ source_type: "deposit_receipt", source_id: r.id })) };
  } },
  { name: "deposit_due_soon", run: async (c, fam, today) => {
    // an RD instalment is usually debited automatically, so this is a heads-up to keep the balance in the account; a
    // statement match closes it silently, and "Mark paid" closes it by hand. Overdue ones are the generator above.
    const rows = (await c.query(`select r.id, r.due_date, r.expected_amount, d.bank, d.account_no, d.entity_id, coalesce(b.bank||' '||b.account_masked, 'the linked account') acct
        from deposit_receipts r join deposits d on d.id=r.deposit_id left join bank_accounts b on b.id=d.payout_bank_account_id
        where d.status='active' and r.kind='contribution' and r.status='expected' and r.due_date between $1::date and $1::date + 3`, [today])).rows;
    return { drafts: rows.map((r) => ({ entity_id: r.entity_id, module: "investments", title: `RD instalment ₹${Number(r.expected_amount).toLocaleString("en-IN")} due ${fmt(r.due_date)}: ${r.bank}${r.account_no ? ` · ${r.account_no}` : ""}`, reason: `Keep the balance in ${r.acct}; if it is not auto-debited, pay it and click Mark paid`, amount: Number(r.expected_amount), due_date: iso(r.due_date), severity: 2 as const, source_type: "deposit_receipt", source_id: r.id, verification: "pending" as const })),
      resolved: (await c.query("select id from deposit_receipts where status='received'")).rows.map((r) => ({ source_type: "deposit_receipt", source_id: r.id })) };
  } },
  { name: "deposit_maturing", run: async (c, fam, today) => {
    // a heads-up a month before the money is due back, so the family can decide to renew, move or reinvest it; receiving the maturity (or an import match) resolves it
    const rows = (await c.query(`select r.id, r.due_date::text due_date, r.expected_amount, d.bank, d.account_no, d.entity_id, (r.due_date - $1::date) days, coalesce(b.bank||' '||b.account_masked, 'the linked account') acct
        from deposit_receipts r join deposits d on d.id=r.deposit_id left join bank_accounts b on b.id=d.payout_bank_account_id
        where d.status='active' and r.kind='maturity' and r.status='expected' and r.due_date between $1::date and $1::date + 30`, [today])).rows;
    return { drafts: rows.map((r) => ({ entity_id: r.entity_id, module: "investments", title: `Maturing ${r.days === 0 ? "today" : `in ${r.days} d`}: ${r.bank}${r.account_no ? ` · ${r.account_no}` : ""}`, reason: `₹${Number(r.expected_amount).toLocaleString("en-IN")} is due back on ${fmt(r.due_date)} into ${r.acct}. Decide: renew, withdraw or reinvest — then click Receive when the bank credits it.`, amount: Number(r.expected_amount), due_date: iso(r.due_date), severity: 2 as const, source_type: "deposit_receipt", source_id: r.id, verification: "pending" as const })),
      resolved: (await c.query("select id from deposit_receipts where status='received'")).rows.map((r) => ({ source_type: "deposit_receipt", source_id: r.id })) };
  } },
  { name: "deposit_foreclosure", run: async (c, fam, today) => {
    // a closed-early deposit's money must show up: remind after 3 days with no credit seen, and whenever a credit was found but differs from what was recorded
    const rows = (await c.query(`select r.id, r.due_date, r.expected_amount, r.received_amount, r.status, d.bank, d.account_no, d.entity_id, ($1::date - r.due_date) days
        from deposit_receipts r join deposits d on d.id=r.deposit_id where r.kind='foreclosure' and (r.status='variance' or (r.status in ('expected','overdue') and r.due_date <= $1::date - 3))`, [today])).rows;
    const money = (n: any) => "₹" + Number(n).toLocaleString("en-IN");
    return { drafts: rows.map((r) => r.status === "variance"
        ? { entity_id: r.entity_id, module: "investments", title: `Closure credit differs: ${r.bank}${r.account_no ? ` · ${r.account_no}` : ""}`, reason: `You recorded ${money(r.expected_amount)} but the bank statement shows ${money(r.received_amount)}. Check the closure and click Confirm amount.`, amount: Number(r.received_amount), due_date: iso(r.due_date), severity: 1 as const, source_type: "deposit_receipt", source_id: r.id, verification: "pending" as const }
        : { entity_id: r.entity_id, module: "investments", title: `Closure amount not credited yet: ${r.bank}${r.account_no ? ` · ${r.account_no}` : ""}`, reason: `Closed on ${fmt(r.due_date)}; ${money(r.expected_amount)} expected but no credit has been seen on a statement or confirmed.`, amount: Number(r.expected_amount), due_date: iso(r.due_date), severity: 1 as const, source_type: "deposit_receipt", source_id: r.id, verification: "pending" as const }),
      resolved: (await c.query("select id from deposit_receipts where kind='foreclosure' and status='received'")).rows.map((r) => ({ source_type: "deposit_receipt", source_id: r.id })) };
  } },
  { name: "lease_expiry", run: async (c, fam, today) => {
    const rows = (await c.query(`select l.id, l.end_date, l.notice_days, l.escalation_pct, p.name property, t.name tenant, (select entity_id from property_owners o where o.property_id=p.id order by ownership_pct desc limit 1) entity_id
        from leases l join properties p on p.id=l.property_id join tenants t on t.id=l.tenant_id where l.status='active' and l.end_date <= $1::date + l.notice_days and l.end_date >= $1::date`, [today])).rows;
    return { drafts: rows.map((r) => ({ entity_id: r.entity_id, module: "real_estate", title: `Renew or vacate: ${r.property} lease ends ${fmt(r.end_date)}`, reason: `${r.tenant} · ${r.notice_days}-day notice window${Number(r.escalation_pct) ? ` · ${Number(r.escalation_pct)}% escalation clause` : ""}`, due_date: iso(new Date(new Date(r.end_date).getTime() - r.notice_days * 86400000)), severity: 1 as const, source_type: "lease_expiry", source_id: r.id })),
      resolved: (await c.query("select id from leases where status <> 'active' or end_date > $1::date + notice_days", [today])).rows.map((r) => ({ source_type: "lease_expiry", source_id: r.id })) };
  } },
  { name: "property_tax_due", run: async (c, fam, today) => {
    const rows = (await c.query(`select x.id, x.due_date, x.amount, x.authority, x.period, p.name property, (select entity_id from property_owners o where o.property_id=p.id order by ownership_pct desc limit 1) entity_id
        from property_taxes x join properties p on p.id=x.property_id where x.status='due' and x.due_date <= $1::date + 30`, [today])).rows;
    return { drafts: rows.map((r) => ({ entity_id: r.entity_id, module: "real_estate", title: `Property tax ${iso(r.due_date)! < today ? "overdue" : "due"}: ${r.property}`, reason: `${r.authority} · ${r.period} · due ${fmt(r.due_date)}`, amount: Number(r.amount), due_date: iso(r.due_date), severity: (iso(r.due_date)! < today ? 1 : 2) as 1 | 2, source_type: "property_tax", source_id: r.id, verification: "pending" as const })),
      resolved: (await c.query("select id from property_taxes where status='paid'")).rows.map((r) => ({ source_type: "property_tax", source_id: r.id })) };
  } },
  { name: "gst_filing_due", run: async (c, fam, today) => {
    const rows = (await c.query(`select r.id, r.form, r.period_month, r.due_date, r.tax_amount, g.gstin, g.entity_id, e.name entity from gst_returns r join entity_gstins g on g.id=r.entity_gstin_id join entities e on e.id=g.entity_id
        where r.status='due' and r.due_date <= $1::date + 10`, [today])).rows;
    return { drafts: rows.map((r) => ({ entity_id: r.entity_id, module: "real_estate", title: `File ${r.form === "gstr1" ? "GSTR-1" : "GSTR-3B"} for ${new Date(r.period_month).toLocaleDateString("en-IN", { month: "short", year: "numeric" })} — ${r.entity}`, reason: `${r.gstin} · due ${fmt(r.due_date)}${iso(r.due_date)! < today ? " · overdue, late fee applies" : ""}`, amount: r.form === "gstr3b" ? Number(r.tax_amount) : null, due_date: iso(r.due_date), severity: (iso(r.due_date)! < today ? 1 : 2) as 1 | 2, source_type: "gst_return", source_id: r.id })),
      resolved: (await c.query("select id from gst_returns where status <> 'due'")).rows.map((r) => ({ source_type: "gst_return", source_id: r.id })) };
  } },
  { name: "consent_expiry", run: async (c, fam, today) => {
    const rows = (await c.query(`select a.id, a.provider, a.expires_on, a.entity_id, e.name entity, (select count(*) from bank_accounts b where b.aa_consent_id=a.id and b.deleted_at is null) accounts from aa_consents a join entities e on e.id=a.entity_id
        where a.status='active' and a.expires_on <= $1::date + 30`, [today])).rows;
    return { drafts: rows.map((r) => ({ entity_id: r.entity_id, module: "banking", title: `Renew Account Aggregator consent — ${r.entity}`, reason: `${r.provider} consent expires ${fmt(r.expires_on)} · ${r.accounts} linked account${Number(r.accounts) === 1 ? "" : "s"} go stale`, due_date: iso(r.expires_on), severity: 2 as const, source_type: "aa_consent", source_id: r.id })),
      resolved: (await c.query("select id from aa_consents where status <> 'active' or expires_on > $1::date + 30", [today])).rows.map((r) => ({ source_type: "aa_consent", source_id: r.id })) };
  } },
  { name: "fund_drawdown", run: async (c, fam, today) => {
    const rows = (await c.query(`select id, entity_id, label, due_date, amount from committed_outflows where status='pending' and kind='drawdown' and due_date <= $1::date + 21`, [today])).rows;
    return { drafts: rows.map((r) => ({ entity_id: r.entity_id, module: "startups", title: r.label, reason: `Capital call due ${fmt(r.due_date)} — keep the amount liquid`, amount: Number(r.amount), due_date: iso(r.due_date), severity: 2 as const, source_type: "committed_outflow", source_id: r.id, verification: "pending" as const })),
      resolved: (await c.query("select id from committed_outflows where status <> 'pending'")).rows.map((r) => ({ source_type: "committed_outflow", source_id: r.id })) };
  } },
  { name: "premium_due", run: async (c, fam, today) => {
    const rows = (await c.query(`select p.id, p.entity_id, p.insurer, p.kind, p.premium, p.next_premium_due, e.name entity from insurance_policies p join entities e on e.id=p.entity_id where p.family_id=$1 and p.status='active' and p.deleted_at is null and p.next_premium_due <= $2::date + 30`, [fam, today])).rows;
    return { drafts: rows.map((r) => ({ entity_id: r.entity_id, module: "insurance", title: `Premium due ${fmt(r.next_premium_due)} — ${r.insurer} ${String(r.kind).replace(/_/g, " ")}`, reason: `${r.entity} · pay before the grace period ends to keep the cover in force`, amount: Number(r.premium), due_date: iso(r.next_premium_due), severity: (new Date(r.next_premium_due) < new Date(today) ? 1 : 2) as 1 | 2, source_type: "insurance_policy", source_id: r.id })),
      resolved: (await c.query("select id from insurance_policies where status <> 'active' or deleted_at is not null or next_premium_due is null or next_premium_due > $1::date + 30", [today])).rows.map((r) => ({ source_type: "insurance_policy", source_id: r.id })) };
  } },
  { name: "ltv_breach", run: async (c, fam) => {
    const rows = (await c.query(`select l.id, l.entity_id, l.lender, l.kind, l.ltv_pct, l.ltv_alert_pct, l.outstanding, l.security_value from liabilities l where l.family_id=$1 and l.status='active' and l.deleted_at is null and l.ltv_pct is not null and l.ltv_alert_pct is not null and l.ltv_pct > l.ltv_alert_pct`, [fam])).rows;
    return { drafts: rows.map((r) => ({ entity_id: r.entity_id, module: "balance_sheet", title: `LTV ${Number(r.ltv_pct)}% on ${r.lender} ${String(r.kind).replace(/_/g, " ")} — above ${Number(r.ltv_alert_pct)}%`, reason: `Outstanding ₹${Number(r.outstanding).toLocaleString("en-IN")} against security worth ₹${Number(r.security_value).toLocaleString("en-IN")}; top up the margin or repay before the lender calls it`, amount: Number(r.outstanding), severity: 1 as const, source_type: "liability_ltv", source_id: r.id })),
      resolved: (await c.query("select id from liabilities where status <> 'active' or deleted_at is not null or ltv_pct is null or ltv_alert_pct is null or ltv_pct <= ltv_alert_pct")).rows.map((r) => ({ source_type: "liability_ltv", source_id: r.id })) };
  } },
  { name: "nominee_gap", run: async (c, fam, today) => {
    const { successionGaps } = await import("../lib/balance.js"); const g = await successionGaps(c, fam, today); const drafts: Draft[] = [];
    for (const x of g.gaps) {
      if (x.issue === "no_nominee" || x.issue === "unverified" || x.issue === "share_mismatch") drafts.push({ entity_id: x.entity_id, module: "balance_sheet", title: `${x.issue === "no_nominee" ? "No nominee" : x.issue === "unverified" ? "Nomination unverified" : "Nominee shares do not add up"}: ${x.name}`, reason: `${x.detail} (${x.asset_type.replace(/_/g, " ")}, ${x.entity})`, amount: Number(x.value) || null, severity: x.severity, source_type: "nominee_gap", source_id: x.asset_id });
      else if (x.issue === "will_missing") drafts.push({ entity_id: x.entity_id, module: "balance_sheet", title: `No will on the register — ${x.name}`, reason: "Assets held by an individual with no will recorded; register the will (and where it is kept)", severity: 2, source_type: "will_missing", source_id: x.asset_id });
      else if (x.issue === "review_overdue") drafts.push({ entity_id: x.entity_id, module: "balance_sheet", title: `Review overdue: ${x.name}`, reason: x.detail, severity: 2, source_type: "succession_review", source_id: x.asset_id });
    }
    const live = new Set(drafts.map((d) => `${d.source_type}:${d.source_id}`)); const open = (await c.query("select source_type, source_id from tasks where family_id=$1 and status='open' and source_type in ('nominee_gap','will_missing','succession_review')", [fam])).rows;
    return { drafts, resolved: open.filter((o) => !live.has(`${o.source_type}:${o.source_id}`)).map((o) => ({ source_type: o.source_type, source_id: o.source_id })) };
  } },
  { name: "forecast_below_float", run: async (c, fam, today) => {
    const rows = (await c.query("select month::text, amount, label from cashflow_forecast where family_id=$1 and kind='float_gap' and month between date_trunc('month', $2::date)::date and ($2::date + 45) order by month limit 1", [fam, today])).rows;
    const monthId = (m: string) => `00000000-0000-4000-8000-${m.replace(/-/g, "").padStart(12, "0")}`;
    return { drafts: rows.map((r) => ({ entity_id: null, module: "banking", title: `Cash forecast dips below the float in ${new Date(r.month).toLocaleDateString("en-IN", { month: "long", year: "numeric" })}`, reason: `${r.label} — line up a redemption, defer an outflow or draw the credit line 45 days ahead`, amount: Number(r.amount), due_date: iso(r.month), severity: 2 as const, source_type: "forecast_float", source_id: monthId(r.month.slice(0, 7)) })),
      resolved: (await c.query("select source_id from tasks where family_id=$1 and status='open' and source_type='forecast_float'", [fam])).rows.filter((t) => !rows.some((r) => monthId(r.month.slice(0, 7)) === t.source_id)).map((t) => ({ source_type: "forecast_float", source_id: t.source_id })) };
  } },
  { name: "allocation_band", run: async (c, fam) => allocationBandDrafts(c, fam) },
  { name: "allocation_review", run: async (c, fam, today) => allocationReviewDrafts(c, fam, today) },
  { name: "unmatched_credit", run: async (c, fam, today) => {
    const min = Number(process.env.UNMATCHED_CREDIT_MIN ?? 10000);
    const rows = (await c.query(`select t.id, t.txn_date, t.amount, t.narration, b.entity_id, b.bank, b.account_masked from bank_txns t join bank_accounts b on b.id=t.bank_account_id
        left join categories cat on cat.id=t.category_id where t.amount >= $2 and t.link_type='none' and (cat.name is null or cat.name in ('Other income')) and t.txn_date >= $1::date - 30`, [today, min])).rows;
    return { drafts: rows.map((r) => ({ entity_id: r.entity_id, module: "banking", title: `Unmatched credit ₹${Number(r.amount).toLocaleString("en-IN")} in ${r.bank} ${r.account_masked}`, reason: `${fmt(r.txn_date)} · ${r.narration.slice(0, 80)} — categorise or link it`, amount: Number(r.amount), due_date: today, severity: 3 as const, source_type: "bank_txn", source_id: r.id })),
      resolved: (await c.query("select t.id from bank_txns t left join categories cat on cat.id=t.category_id where t.link_type <> 'none' or (cat.name is not null and cat.name <> 'Other income')")).rows.map((r) => ({ source_type: "bank_txn", source_id: r.id })) };
  } },
  { name: "import_failure", run: async (c, fam, today) => {
    const rows = (await c.query(`select id, source, status, created_at, error_log from import_jobs where status in ('failed','needs_mapping') and created_at >= $1::date - 7`, [today])).rows;
    return { drafts: rows.map((r) => { const log: any[] = r.error_log ?? []; const file = log.find((l) => l.filename)?.filename ?? r.source; const msg = log.find((l) => l.message)?.message; return { module: "investments", title: r.status === "needs_mapping" ? `Map the columns of ${file}` : `Import failed: ${file}`, reason: msg ?? "Unknown layout — the mapping assistant is waiting", due_date: today, severity: 3 as const, source_type: "import_job", source_id: r.id }; }),
      resolved: (await c.query("select id from import_jobs where status = 'done'")).rows.map((r) => ({ source_type: "import_job", source_id: r.id })) };
  } },
  { name: "tds_mismatch", run: async (c, fam, today) => {
    // 26AS rows imported for the FY vs TDS expected on rent: a deductor missing or short by more than ₹1 is a mismatch
    const fy = fyOf(today);
    const expected = (await c.query(`select t.id tenant_id, t.name, sum(rs.expected_tds) exp, (select entity_id from property_owners o where o.property_id=p.id order by ownership_pct desc limit 1) entity_id
        from rent_schedule rs join leases l on l.id=rs.lease_id join tenants t on t.id=l.tenant_id join properties p on p.id=l.property_id
        where rs.expected_tds > 0 and rs.status='received' and rs.period_month >= $1::date and rs.period_month < $1::date + interval '1 year' group by t.id, t.name, p.id`, [`${fy.slice(0, 4)}-04-01`])).rows;
    const has26 = (await c.query("select count(*) n from tds_26as where fy=$1", [fy])).rows[0].n;
    if (!Number(has26)) return { drafts: [], resolved: [] };
    const drafts: Draft[] = [];
    for (const e of expected) {
      const got = Number((await c.query("select coalesce(sum(tds_deducted),0) s from tds_26as where fy=$1 and section='194I' and lower(deductor_name) like lower($2)", [fy, `%${e.name.split(" ")[0]}%`])).rows[0].s);
      if (got + 1 < Number(e.exp)) drafts.push({ entity_id: e.entity_id, module: "real_estate", title: `TDS short in 26AS: ${e.name}`, reason: `Rent TDS expected ₹${Number(e.exp).toLocaleString("en-IN")} for FY ${fy}, 26AS shows ₹${got.toLocaleString("en-IN")} — ask the tenant to file / correct TDS return`, amount: Number(e.exp) - got, due_date: today, severity: 2, source_type: "tds_mismatch", source_id: e.tenant_id });
    }
    return { drafts, resolved: expected.filter((e) => !drafts.some((d) => d.source_id === e.tenant_id)).map((e) => ({ source_type: "tds_mismatch", source_id: e.tenant_id })) };
  } },
];

/** GST returns are due monthly per GSTIN once there is taxable rent: create the rows the filing generator watches. */
export async function ensureGstReturns(c: pg.PoolClient, familyId: string, today: string) {
  const gst = (await c.query("select * from gst_settings where fy=$1", [fyOf(today)])).rows[0];
  if (!gst) return 0;
  const months = (await c.query(`select l.entity_gstin_id, rs.period_month, sum(rs.expected_rent) taxable, sum(rs.expected_gst) tax from rent_schedule rs join leases l on l.id=rs.lease_id
      where l.gst_applicable and l.entity_gstin_id is not null and rs.period_month < date_trunc('month', $1::date) and rs.period_month >= date_trunc('month', $1::date) - interval '3 months' group by 1, 2`, [today])).rows;
  let n = 0;
  for (const m of months) for (const [form, day] of [["gstr1", gst.gstr1_due_day], ["gstr3b", gst.gstr3b_due_day]] as const) {
    const due = new Date(m.period_month); due.setUTCMonth(due.getUTCMonth() + 1); due.setUTCDate(day);
    const r = await c.query("insert into gst_returns (family_id, entity_gstin_id, period_month, form, taxable_value, tax_amount, due_date) values ($1,$2,$3,$4,$5,$6,$7) on conflict (entity_gstin_id, period_month, form) do nothing", [familyId, m.entity_gstin_id, m.period_month, form, m.taxable, m.tax, due.toISOString().slice(0, 10)]);
    n += r.rowCount ?? 0;
  }
  return n;
}

/** Run every generator for one family inside its RLS transaction. */
export async function generateTasksFor(c: pg.PoolClient, familyId: string, today = new Date().toISOString().slice(0, 10), opts: { notify?: boolean } = { notify: true }) {
  await ensureGstReturns(c, familyId, today);
  let created = 0, closed = 0; const byGenerator: Record<string, number> = {};
  for (const g of generators) {
    const { drafts, resolved = [] } = await g.run(c, familyId, today);
    byGenerator[g.name] = 0;
    for (const d of drafts) {
      const r = await c.query(`insert into tasks (family_id, entity_id, module, title, reason, amount, due_date, severity, source_type, source_id, verification)
          select $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11 where not exists (select 1 from tasks where family_id=$1 and source_type=$9 and source_id=$10 and status='open') returning *`,
        [familyId, d.entity_id ?? null, d.module, d.title, d.reason, d.amount ?? null, d.due_date ?? null, d.severity, d.source_type, d.source_id, d.verification ?? "na"]);
      if (r.rows[0]) { created++; byGenerator[g.name]++; if (opts.notify) await notifyTask(c, r.rows[0]); }
      else await c.query("update tasks set title=$4, reason=$5, amount=$6, severity=$7 where family_id=$1 and source_type=$2 and source_id=$3 and status='open'", [familyId, d.source_type, d.source_id, d.title, d.reason, d.amount ?? null, d.severity]);
    }
    for (const s of resolved) {
      const r = await c.query("update tasks set status='done', done_at=now(), verification = case when verification='pending' then 'verified' else verification end where family_id=$1 and source_type=$2 and source_id=$3 and status='open'", [familyId, s.source_type, s.source_id]);
      closed += r.rowCount ?? 0;
    }
  }
  return { created, closed, byGenerator };
}

export async function generateTasks(today?: string) {
  const fams = (await pool.query("select id from families")).rows;
  let created = 0, closed = 0;
  for (const f of fams) {
    const c = await pool.connect();
    try { await c.query("begin"); await c.query("select set_config('app.family_id',$1,true)", [f.id]); const r = await generateTasksFor(c, f.id, today); created += r.created; closed += r.closed; await c.query("commit"); }
    catch (e) { await c.query("rollback"); console.error("tasks.generate", f.id, e); } finally { c.release(); }
  }
  return { rows: created, closed, note: `${created} raised, ${closed} closed` };
}

export { generateRentSchedule };
