// General ledger (FO-47, 62, 63, 110..117): posting engine driven by gl_posting_rules, event collectors for every platform
// source, opening balances, statements, reconciliation, year-end close, recurring journals, inter-entity, Tally XML.
import type pg from "pg";
import { fyOf } from "@fo/finance";

export const iso = (d: any) => (d ? new Date(d).toISOString().slice(0, 10) : null);
const r2 = (n: number) => Math.round(n * 100) / 100 + 0;
const today = () => new Date().toISOString().slice(0, 10);
export class GlError extends Error { constructor(public status: number, message: string, public extra?: unknown) { super(message); } }
export const fyStart = (fy: string) => `${fy.slice(0, 4)}-04-01`, fyEnd = (fy: string) => `${Number(fy.slice(0, 4)) + 1}-03-31`;
const nextFy = (fy: string) => { const y = Number(fy.slice(0, 4)) + 1; return `${y}-${String(y + 1).slice(-2)}`; };
export const slug = (s: string) => s.toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");

// ---------- accounts & journals ----------
export async function accountMap(c: pg.PoolClient, entityId: string) { return new Map<string, { id: string; type: string; name: string }>((await c.query("select id, code, type, name from gl_accounts where entity_id=$1 and active", [entityId])).rows.map((a) => [a.code, { id: a.id, type: a.type, name: a.name }])); }
export interface LineIn { account_id?: string; account_code?: string; debit?: number; credit?: number; narration?: string | null; sub_ledger_type?: string | null; sub_ledger_id?: string | null; ccy?: string; amount_ccy?: number | null; fx_rate?: number | null }
export interface JournalIn { entityId: string; entryDate: string; source: "auto" | "manual" | "recurring" | "opening" | "closing" | "tally_import" | "reversal"; sourceType: string; sourceId?: string | null; narration: string; lines: LineIn[]; status?: "draft" | "posted"; postedBy?: string | null; approvedBy?: string | null; intercompanyGroup?: string | null; tallyGuid?: string | null; reversesJournalId?: string | null; reason?: string | null }
/** Insert a balanced journal (the DB re-checks balance, period lock and immutability). Zero lines are dropped; 1-paise rounding is absorbed into the last line. */
export async function postJournal(c: pg.PoolClient, familyId: string, j: JournalIn) {
  const accts = await accountMap(c, j.entityId);
  const lines = j.lines.map((l) => ({ ...l, debit: r2(Number(l.debit ?? 0)), credit: r2(Number(l.credit ?? 0)), account_id: l.account_id ?? accts.get(l.account_code ?? "")?.id })).filter((l) => l.debit > 0 || l.credit > 0);
  if (lines.length < 2) throw new GlError(422, "A journal needs at least two non-zero lines");
  const missing = lines.find((l) => !l.account_id); if (missing) throw new GlError(422, `Account ${missing.account_code ?? "?"} is not in this book`, { code: "account_missing" });
  const d = r2(lines.reduce((s, l) => s + l.debit, 0)), cr = r2(lines.reduce((s, l) => s + l.credit, 0));
  if (Math.abs(d - cr) > 0.011) throw new GlError(422, `Journal does not balance: debit ${d} credit ${cr}`, { code: "unbalanced" });
  if (d !== cr) { const last = lines[lines.length - 1]; if (last.debit) last.debit = r2(last.debit + (cr - d)); else last.credit = r2(last.credit + (d - cr)); }
  const fy = fyOf(j.entryDate);
  const no = Number((await c.query("select coalesce(max(journal_no),0)+1 n from gl_journals where entity_id=$1 and fy=$2", [j.entityId, fy])).rows[0].n);
  const row = (await c.query(`insert into gl_journals (family_id, entity_id, journal_no, fy, entry_date, source, source_type, source_id, narration, status, posted_by, approved_by, intercompany_group, tally_voucher_guid, reverses_journal_id, reason)
    values ($1,$2,$3,$4,$5,$6::journal_source,$7,$8,$9,$10::journal_status,$11,$12,$13,$14,$15,$16) returning *`, [familyId, j.entityId, no, fy, j.entryDate, j.source, j.sourceType, j.sourceId ?? null, j.narration, j.status ?? "posted", j.postedBy ?? null, j.approvedBy ?? null, j.intercompanyGroup ?? null, j.tallyGuid ?? null, j.reversesJournalId ?? null, j.reason ?? null])).rows[0];
  let i = 1; for (const l of lines) await c.query("insert into gl_lines (family_id, journal_id, line_no, account_id, debit, credit, ccy, amount_ccy, fx_rate, sub_ledger_type, sub_ledger_id, narration) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)", [familyId, row.id, i++, l.account_id, l.debit, l.credit, l.ccy ?? "INR", l.amount_ccy ?? null, l.fx_rate ?? null, l.sub_ledger_type ?? null, l.sub_ledger_id ?? null, l.narration ?? null]);
  return row;
}
export async function journalView(c: pg.PoolClient, id: string) {
  const j = (await c.query("select j.*, u.name posted_by_name, a.name approved_by_name from gl_journals j left join users u on u.id=j.posted_by left join users a on a.id=j.approved_by where j.id=$1", [id])).rows[0]; if (!j) throw new GlError(404, "Journal not found");
  const lines = (await c.query("select l.line_no, l.account_id, a.code account_code, a.name account_name, l.debit, l.credit, l.ccy, l.amount_ccy, l.fx_rate, l.sub_ledger_type, l.sub_ledger_id, l.narration from gl_lines l join gl_accounts a on a.id=l.account_id where l.journal_id=$1 order by l.line_no", [id])).rows.map((l) => ({ ...l, debit: Number(l.debit), credit: Number(l.credit) }));
  return { ...j, entry_date: iso(j.entry_date), lines };
}
/** Reversal: mirrored lines, original marked reversed (its only legal mutation). */
export async function reverseJournal(c: pg.PoolClient, familyId: string, id: string, userId: string | null, opts: { entry_date?: string; reason?: string } = {}) {
  const j = await journalView(c, id); if (j.status !== "posted") throw new GlError(409, `Only a posted journal can be reversed (this one is ${j.status})`);
  const rev = await postJournal(c, familyId, { entityId: j.entity_id, entryDate: opts.entry_date ?? today(), source: "reversal", sourceType: `${j.source_type}:reversal`, sourceId: j.source_id, narration: `Reversal of #${j.journal_no}: ${j.narration}${opts.reason ? ` — ${opts.reason}` : ""}`, lines: j.lines.map((l: any) => ({ account_id: l.account_id, debit: l.credit, credit: l.debit, sub_ledger_type: l.sub_ledger_type, sub_ledger_id: l.sub_ledger_id, narration: l.narration })), postedBy: userId, reversesJournalId: j.id, reason: opts.reason ?? null });
  await c.query("update gl_journals set status='reversed', reversed_by_journal_id=$2 where id=$1", [j.id, rev.id]);
  if (j.source === "auto" && j.source_id) await c.query("insert into gl_unposted (family_id, entity_id, event_type, source_type, source_id, event_date, reason, detail) values ($1,$2,$3,$4,$5,$6,'reversed',$7) on conflict (entity_id, source_type, source_id) do update set reason='reversed', created_at=now()", [familyId, j.entity_id, j.source_type, j.source_type, j.source_id, j.entry_date, JSON.stringify({ journal_id: j.id, reversal_id: rev.id, note: "re-post from the queue once the source is corrected" })]);
  return journalView(c, rev.id);
}

// ---------- posting rules ----------
export async function resolveRule(c: pg.PoolClient, familyId: string, eventType: string, instrumentClass: string | null, basis: string) {
  const rows = (await c.query("select * from gl_posting_rules where active and event_type=$1 and (family_id=$2 or family_id is null) and (instrument_class is null or instrument_class=$3) and (basis is null or basis::text=$4) order by (family_id is not null) desc, (instrument_class is not null) desc, (basis is not null) desc, priority", [eventType, familyId, instrumentClass, basis])).rows;
  return rows[0] ?? null;
}
export interface EventCtx { amounts: Record<string, number>; term?: "short" | "long" | null; capital_improvement?: boolean; expense_category?: string | null; via_bank?: boolean; cash_code?: string; asset_code?: string; liability_code?: string; sub?: Record<string, { type: string; id: string } | undefined>; entity_role?: Record<string, string> }
const pick = (alts: string, ctx: EventCtx): string => {
  const a = alts.split("|"); if (a.length === 1) return a[0] === "12xx" ? ctx.asset_code ?? "1210" : a[0];
  if (alts === "4400|4410") return ctx.term === "long" ? "4410" : "4400";
  if (alts.startsWith("5120")) return ctx.capital_improvement ? "1320" : ["society", "insurance"].includes(ctx.expense_category ?? "") && a.includes("5130") ? "5130" : "5120";
  if (alts === "1110|2220") return ctx.via_bank === false ? "2220" : "1110";
  if (alts === "1110|1230") return ctx.via_bank === false ? "1230" : "1110";
  if (alts === "2110|2120|2130") return ctx.liability_code ?? "2130";
  if (alts === "1210|1220") return ctx.asset_code ?? "1210";
  return a[0];
};
const subFor = (code: string, ctx: EventCtx) => (code === "1110" || code === "2210" ? ctx.sub?.bank : code.startsWith("12") ? ctx.sub?.holding ?? ctx.sub?.private : code === "1410" || code === "2230" ? ctx.sub?.tenant : code.startsWith("13") || code.startsWith("51") ? ctx.sub?.property : code.startsWith("21") ? ctx.sub?.liability : undefined);
/** Rule + event context → journal lines; the bank account's own kind decides 1110 vs 2210 (card). */
export function applyRule(rule: { lines: any[] }, ctx: EventCtx): LineIn[] {
  const out: LineIn[] = [];
  for (const l of rule.lines) {
    let code = pick(l.account_code, ctx); if (code === "1110" && ctx.cash_code) code = ctx.cash_code;
    const amt = l.amount in ctx.amounts ? ctx.amounts[l.amount] : Number(l.amount); if (!isFinite(amt) || Math.abs(amt) < 0.005) continue;
    const s = subFor(code, ctx); let side = l.side; let v = amt; if (v < 0) { v = -v; side = side === "debit" ? "credit" : "debit"; } // a loss on a gain line flips sides
    out.push({ account_code: code, debit: side === "debit" ? v : 0, credit: side === "credit" ? v : 0, sub_ledger_type: s?.type ?? null, sub_ledger_id: s?.id ?? null });
  }
  return out;
}

// ---------- event collection & auto-posting (FO-47, 62, 63, 113) ----------
export interface GlEvent { eventType: string; sourceType: string; sourceId: string; entityId: string; date: string; narration: string; instrumentClass?: string | null; ctx: EventCtx; amount: number }
const classOf = (type: string, assetClass: string, name: string) => /liquid|overnight/i.test(name) && type === "mf" ? "liquid" : type === "stock" || type === "etf" ? (assetClass.includes("gold") ? "gold" : assetClass.includes("reit") ? "reit" : assetClass.includes("foreign") || assetClass.startsWith("intl") ? "foreign" : "equity") : type === "mf" ? (assetClass.includes("gold") ? "gold" : "mf") : ["bond", "gsec", "tbill", "fd", "rd"].includes(type) ? "debt" : type === "pms" ? "pms" : type === "aif" ? "aif" : type === "sgb" || type === "gold" ? "gold" : "mf";
const assetCodeOf = (cls: string) => ({ equity: "1210", mf: "1220", pms: "1230", aif: "1240", debt: "1250", gold: "1270", reit: "1280", foreign: "1290", liquid: "1130" } as Record<string, string>)[cls] ?? "1220";
export async function collectEvents(c: pg.PoolClient, familyId: string, entityId: string, from: string, to: string, basis: string): Promise<GlEvent[]> {
  const ev: GlEvent[] = [];
  const bank = new Map((await c.query("select id, entity_id, type, bank, account_masked from bank_accounts where family_id=$1", [familyId])).rows.map((b) => [b.id, b]));
  const bankSub = (id: string | null) => (id && bank.get(id) ? { bank: { type: "bank_account", id } } : {});
  const cashCode = (id: string | null) => (id && bank.get(id)?.type === "card" ? "2210" : undefined);
  // a sale hand-entered as a realised gain and later imported as a transaction is one event: the transaction wins unless the gain already posted
  const saleKey = (instrument: string, d: any, amount: any) => `${instrument}|${iso(d)}|${r2(Number(amount))}`;
  const orphanGains = new Map((await c.query("select g.id, g.instrument_id, g.sell_date, g.proceeds, exists (select 1 from gl_journals j where j.source_type='realized_gain' and j.source_id=g.id and j.status='posted') posted from realized_gains g where g.family_id=$1 and g.entity_id=$2 and g.sell_txn_id is null and g.sell_date between $3 and $4", [familyId, entityId, from, to])).rows.map((g) => [saleKey(g.instrument_id, g.sell_date, g.proceeds), g]));
  const txnSales = new Set<string>();
  // investment transactions (buys, sells with FIFO cost and gain by term, income, calls, distributions, fees)
  for (const t of (await c.query(`select t.*, i.type itype, i.asset_class, i.name iname, h.id holding_id from investment_txns t join instruments i on i.id=t.instrument_id left join holdings h on h.entity_id=t.entity_id and h.instrument_id=t.instrument_id and (t.account_id is null or h.account_id=t.account_id) where t.family_id=$1 and t.entity_id=$2 and t.txn_date between $3 and $4 order by t.txn_date, t.created_at`, [familyId, entityId, from, to])).rows) {
    const cls = classOf(t.itype, t.asset_class ?? "", t.iname); const amt = Number(t.amount), ch = Number(t.charges ?? 0);
    if (["sell", "redemption", "switch_out", "maturity"].includes(t.type)) { const k = saleKey(t.instrument_id, t.txn_date, amt); txnSales.add(k); if (orphanGains.get(k)?.posted) continue; }
    const rg = (await c.query("select coalesce(sum(cost),0) cost, coalesce(sum(case when term='short' then gain else 0 end),0) sg, coalesce(sum(case when term='long' then gain else 0 end),0) lg from realized_gains where sell_txn_id=$1", [t.id])).rows[0];
    const gain = Number(rg.sg) + Number(rg.lg); const term: "short" | "long" = Math.abs(Number(rg.lg)) >= Math.abs(Number(rg.sg)) ? "long" : "short";
    const isSell = ["sell", "redemption", "switch_out", "maturity"].includes(t.type); const costSold = isSell ? (Number(rg.cost) || amt - gain) : 0;
    const amounts: Record<string, number> = { amount: amt, gross: amt, net: amt - ch, tds: ch, charges: ch, cost_incl_charges: amt + ch, net_paid: amt + ch, cost_inr: amt + ch, net_proceeds: amt - ch, cost_of_lots_sold: costSold, gain_by_term: isSell ? r2(amt - ch - costSold) : gain, income_component: amt, return_of_capital: 0 };
    if (t.type === "dividend" || t.type === "interest") { amounts.tds = ch; amounts.net = amt - ch; amounts.gross = amt; }
    ev.push({ eventType: `investment_txn.${t.type}`, sourceType: "investment_txn", sourceId: t.id, entityId, date: iso(t.txn_date)!, narration: `${t.type[0].toUpperCase()}${t.type.slice(1)} — ${t.iname}${t.quantity ? ` (${Number(t.quantity)} units)` : ""}`, instrumentClass: t.type === "capital_call" || t.type === "distribution" ? "private" : cls, amount: amt, ctx: { amounts, term, asset_code: assetCodeOf(cls), sub: { holding: t.holding_id ? { type: "holding", id: t.holding_id } : undefined as any, bank: undefined as any } } });
  }
  // realised gains recorded without a transaction row (hand-entered sales)
  for (const g of (await c.query("select g.*, i.name iname, i.type itype, h.id holding_id from realized_gains g join instruments i on i.id=g.instrument_id left join holdings h on h.entity_id=g.entity_id and h.instrument_id=g.instrument_id where g.family_id=$1 and g.entity_id=$2 and g.sell_txn_id is null and g.sell_date between $3 and $4", [familyId, entityId, from, to])).rows) {
    if (txnSales.has(saleKey(g.instrument_id, g.sell_date, g.proceeds)) && !orphanGains.get(saleKey(g.instrument_id, g.sell_date, g.proceeds))?.posted) continue;
    const cls = classOf(g.itype, g.asset_class ?? "", g.iname); const cost = Number(g.cost), proceeds = Number(g.proceeds), gain = Number(g.gain);
    ev.push({ eventType: "realized_gain", sourceType: "realized_gain", sourceId: g.id, entityId, date: iso(g.sell_date)!, narration: `${g.itype === "mf" ? "Redemption" : "Sale"} — ${g.iname} (${g.term}-term ${gain < 0 ? "loss" : "gain"})`, instrumentClass: cls === "debt" ? "debt" : "equity", amount: proceeds, ctx: { amounts: { net_proceeds: proceeds, cost_of_lots_sold: cost, gain_by_term: r2(proceeds - cost), charges: 0 }, term: g.term, asset_code: assetCodeOf(cls), sub: { holding: g.holding_id ? { type: "holding", id: g.holding_id } : undefined as any } } });
  }
  // rent: accrual books accrue on the due date and clear on receipt; cash books post income on receipt only
  for (const r of (await c.query(`select r.*, l.property_id, l.tenant_id, l.deposit, l.start_date, p.name pname, t.name tname from rent_schedule r join leases l on l.id=r.lease_id join properties p on p.id=l.property_id left join tenants t on t.id=l.tenant_id join property_owners o on o.property_id=p.id
      where p.family_id=$1 and o.entity_id=$2 and (r.due_date between $3 and $4 or r.received_on between $3 and $4)`, [familyId, entityId, from, to])).rows) {
    const rent = Number(r.expected_rent), gst = Number(r.expected_gst ?? 0), tds = Number(r.expected_tds ?? 0); const sub = { property: { type: "property", id: r.property_id }, tenant: r.tenant_id ? { type: "tenant", id: r.tenant_id } : { type: "property", id: r.property_id } };
    const month = new Date(iso(r.period_month)! + "T00:00:00Z").toLocaleDateString("en-IN", { month: "short", year: "numeric", timeZone: "UTC" });
    if (basis === "accrual" && iso(r.due_date)! >= from && iso(r.due_date)! <= to && r.status !== "waived") ev.push({ eventType: "rent.accrued", sourceType: "rent_schedule", sourceId: r.id, entityId, date: iso(r.due_date)!, narration: `Rent accrued — ${r.pname} (${month})`, amount: rent + gst, ctx: { amounts: { rent, gst, rent_plus_gst: rent + gst }, sub } });
    if (r.received_on && Number(r.received_amount) > 0 && iso(r.received_on)! >= from && iso(r.received_on)! <= to) { const received = Number(r.received_amount); const bt = r.bank_txn_id ? (await c.query("select bank_account_id from bank_txns where id=$1", [r.bank_txn_id])).rows[0]?.bank_account_id : null;
      ev.push({ eventType: "rent.received", sourceType: "rent_receipt", sourceId: r.id, entityId, date: iso(r.received_on)!, narration: `Rent received — ${r.tname ?? r.pname} (${month})${tds ? " net of TDS" : ""}`, amount: received, ctx: { amounts: { received, tds, received_plus_tds: received + tds, rent, gst }, sub: { ...sub, ...bankSub(bt) } } }); }
  }
  // deposits (fd/rd): the interest component of each maturity row, plus every periodic interest row, is income
  // earned regardless of whether the cash has actually arrived yet — accrued on its due date, same as rent. A
  // contribution (rd instalment) is a transfer, not income: it never accrues, and posts (bank -> deposit asset) only
  // once it is confirmed paid, by hand or by a statement match.
  // an fd opened inside the books' period moves its principal from the bank into the deposit asset (one already running at the
  // start is in the opening balances instead). Dates are selected as text so a journal is dated what the user entered.
  for (const d of (await c.query(`select d.id, d.bank, d.account_no, d.principal, d.start_date::text as start_date, d.payout_bank_account_id from deposits d
      where d.family_id=$1 and d.entity_id=$2 and d.kind='fd' and d.status in ('active','closed','premature_closed') and d.start_date between $3 and $4`, [familyId, entityId, from, to])).rows)
    ev.push({ eventType: "deposit.opened", sourceType: "deposit_open", sourceId: d.id, entityId, date: iso(d.start_date)!, narration: `FD opened — ${d.bank}${d.account_no ? ` ${d.account_no}` : ""}`, amount: Number(d.principal), ctx: { amounts: { amount: Number(d.principal) }, sub: d.payout_bank_account_id ? { bank: { type: "bank_account", id: d.payout_bank_account_id } } : {} } });
  for (const r of (await c.query(`select r.*, r.due_date::text as due_date, r.received_on::text as received_on, d.bank, d.kind as deposit_kind, d.principal, d.installment_amount, d.tenure_months, d.payout_frequency, d.payout_bank_account_id,
        (select coalesce(sum(x.received_amount), 0) from deposit_receipts x where x.deposit_id=d.id and x.kind='contribution') as paid_in
      from deposit_receipts r join deposits d on d.id=r.deposit_id
      where d.family_id=$1 and d.entity_id=$2 and d.status in ('active','closed','premature_closed') and (r.due_date between $3 and $4 or r.received_on between $3 and $4)`, [familyId, entityId, from, to])).rows) {
    const bankSubOf = r.payout_bank_account_id ? { bank: { type: "bank_account", id: r.payout_bank_account_id } } : {};
    if (r.kind === "maturity" && Number(r.received_amount) > 0 && r.received_on && iso(r.received_on)! >= from && iso(r.received_on)! <= to) {
      // the payout returns the principal (an fd's, or what an rd actually had paid in) and clears whatever interest was accrued at maturity
      const received = Number(r.received_amount); const base = r.deposit_kind === "fd" ? Number(r.principal ?? 0) : Number(r.paid_in ?? 0); const principal = Math.min(received, base);
      ev.push({ eventType: "deposit.matured", sourceType: "deposit_maturity", sourceId: r.id, entityId, date: iso(r.received_on)!, narration: `${r.deposit_kind.toUpperCase()} matured — ${r.bank}`, amount: received, ctx: { amounts: { received, principal, interest: r2(received - principal) }, sub: bankSubOf } });
    }
    if (r.kind === "foreclosure") {
      // closing early: the bank's credit returns the principal and settles every interest row it replaced; whatever is left over is interest earned
      // beyond (positive) or given back against (negative) what had been accrued, so the journal always balances
      if (Number(r.received_amount) > 0 && r.received_on && iso(r.received_on)! >= from && iso(r.received_on)! <= to) {
        const received = Number(r.received_amount), tds = Number(r.tds_component ?? 0), principal = Number(r.principal_component ?? 0);
        const accrued = Number((await c.query("select coalesce(sum(x.expected_amount), 0) v from deposit_receipts x where x.deposit_id=$1 and x.kind='interest' and x.status='cancelled' and exists (select 1 from gl_journals j where j.entity_id=$2 and j.source_type='deposit_receipt' and j.source_id=x.id)", [r.deposit_id, entityId])).rows[0].v);
        const bal = r2(received + tds - principal - accrued);
        ev.push({ eventType: "deposit.foreclosed", sourceType: "deposit_foreclosure", sourceId: r.id, entityId, date: iso(r.received_on)!, narration: `${r.deposit_kind.toUpperCase()} closed early — ${r.bank}`, amount: received, ctx: { amounts: { received, tds, principal, accrued, interest_up: bal > 0 ? bal : 0, interest_down: bal < 0 ? -bal : 0 }, sub: bankSubOf } });
      }
      continue;
    }
    if (r.kind === "contribution") {
      if (Number(r.received_amount) > 0 && r.received_on && iso(r.received_on)! >= from && iso(r.received_on)! <= to) { const paid = Number(r.received_amount);
        ev.push({ eventType: "deposit.contribution_paid", sourceType: "deposit_payment", sourceId: r.id, entityId, date: iso(r.received_on)!, narration: `Instalment paid — ${r.bank} RD`, amount: paid, ctx: { amounts: { amount: paid }, sub: bankSubOf } }); }
      continue;
    }
    let interestAmount = 0;
    if (r.kind === "interest") interestAmount = Number(r.expected_amount);
    else if (r.deposit_kind === "fd" && r.payout_frequency !== "at_maturity") continue; // periodic-payout fd: maturity is just the principal back, not new income
    else if (r.deposit_kind === "fd") interestAmount = Number(r.expected_amount) - Number(r.principal ?? 0); // cumulative fd: all the compounded interest lands here
    else interestAmount = Number(r.expected_amount) - Number(r.installment_amount ?? 0) * Number(r.tenure_months ?? 0); // rd: maturity value less what was actually paid in
    if (interestAmount <= 0) continue;
    const label = r.kind === "interest" ? "Interest" : "Maturity interest";
    if (basis === "accrual" && iso(r.due_date)! >= from && iso(r.due_date)! <= to && r.status !== "waived" && r.status !== "cancelled") ev.push({ eventType: "deposit.interest_accrued", sourceType: "deposit_receipt", sourceId: r.id, entityId, date: iso(r.due_date)!, narration: `${label} accrued — ${r.bank} ${r.deposit_kind.toUpperCase()}`, amount: interestAmount, ctx: { amounts: { amount: interestAmount }, sub: r.payout_bank_account_id ? { bank: { type: "bank_account", id: r.payout_bank_account_id } } : {} } });
    // only interest rows clear the receivable on receipt; a maturity receipt also returns principal, which needs its own rule (later step)
    if (r.kind === "interest" && r.received_on && Number(r.received_amount) > 0 && iso(r.received_on)! >= from && iso(r.received_on)! <= to) { const received = Number(r.received_amount);
      // a fully-received row credited below the expected amount is the bank's TDS cut: it clears the receivable too, parked as TDS receivable
      const tds = r.status === "received" ? Math.max(0, r2(Number(r.expected_amount) - received)) : 0;
      ev.push({ eventType: "deposit.interest_received", sourceType: "deposit_cash", sourceId: r.id, entityId, date: iso(r.received_on)!, narration: `${label} received — ${r.bank}${tds ? " net of TDS" : ""}`, amount: received, ctx: { amounts: { received, tds, received_plus_tds: received + tds }, sub: bankSubOf } }); }
  }
  // security deposits received with new leases
  for (const l of (await c.query("select l.id, l.deposit, l.start_date, p.name pname, l.tenant_id, l.property_id from leases l join properties p on p.id=l.property_id join property_owners o on o.property_id=p.id where p.family_id=$1 and o.entity_id=$2 and l.deposit > 0 and l.start_date between $3 and $4", [familyId, entityId, from, to])).rows) ev.push({ eventType: "rent.deposit_received", sourceType: "lease_deposit", sourceId: l.id, entityId, date: iso(l.start_date)!, narration: `Security deposit received — ${l.pname}`, amount: Number(l.deposit), ctx: { amounts: { amount: Number(l.deposit) }, sub: { tenant: l.tenant_id ? { type: "tenant", id: l.tenant_id } : { type: "property", id: l.property_id } } } });
  // property taxes paid and expenses
  for (const t of (await c.query("select t.*, p.name pname from property_taxes t join properties p on p.id=t.property_id join property_owners o on o.property_id=p.id where p.family_id=$1 and o.entity_id=$2 and t.paid_on between $3 and $4", [familyId, entityId, from, to])).rows) { const bt = t.bank_txn_id ? (await c.query("select bank_account_id from bank_txns where id=$1", [t.bank_txn_id])).rows[0]?.bank_account_id : null; ev.push({ eventType: "property_tax.paid", sourceType: "property_tax", sourceId: t.id, entityId, date: iso(t.paid_on)!, narration: `Property tax — ${t.authority ?? ""} ${t.pname}`.replace(/\s+/g, " "), amount: Number(t.amount), ctx: { amounts: { amount: Number(t.amount) }, cash_code: cashCode(bt), sub: { property: { type: "property", id: t.property_id }, ...bankSub(bt) } } }); }
  for (const e of (await c.query("select e.*, p.name pname from property_expenses e join properties p on p.id=e.property_id join property_owners o on o.property_id=p.id where p.family_id=$1 and o.entity_id=$2 and e.expense_date between $3 and $4", [familyId, entityId, from, to])).rows) { const bt = e.bank_txn_id ? (await c.query("select bank_account_id from bank_txns where id=$1", [e.bank_txn_id])).rows[0]?.bank_account_id : null; ev.push({ eventType: "property_expense", sourceType: "property_expense", sourceId: e.id, entityId, date: iso(e.expense_date)!, narration: `${e.capital_improvement ? "Capital improvement" : e.category[0].toUpperCase() + e.category.slice(1)} — ${e.pname}${e.vendor ? ` (${e.vendor})` : ""}`, amount: Number(e.amount), ctx: { amounts: { amount: Number(e.amount) }, capital_improvement: !!e.capital_improvement, expense_category: e.category, via_bank: true, cash_code: cashCode(bt), sub: { property: { type: "property", id: e.property_id }, ...bankSub(bt) } } }); }
  // liabilities, insurance, private investments, advance tax, fund cash flows
  for (const s of (await c.query("select s.*, l.kind, l.lender from liability_schedule s join liabilities l on l.id=s.liability_id where l.family_id=$1 and l.entity_id=$2 and s.paid_on between $3 and $4", [familyId, entityId, from, to])).rows) ev.push({ eventType: "liability.emi", sourceType: "liability_schedule", sourceId: s.id, entityId, date: iso(s.paid_on)!, narration: `EMI — ${s.lender}`, amount: Number(s.principal) + Number(s.interest), ctx: { amounts: { principal: Number(s.principal), interest: Number(s.interest), emi: Number(s.principal) + Number(s.interest) }, liability_code: s.kind === "home_loan" ? "2110" : /securit|property|lap/.test(s.kind ?? "") ? "2120" : "2130", sub: { liability: { type: "liability", id: s.liability_id } } } });
  for (const p of (await c.query("select pi.id, pi.amount, pi.invested_on, co.name from private_investments pi join private_companies co on co.id=pi.company_id where pi.family_id=$1 and pi.entity_id=$2 and pi.invested_on between $3 and $4", [familyId, entityId, from, to])).rows) ev.push({ eventType: "private.invested", sourceType: "private_investment", sourceId: p.id, entityId, date: iso(p.invested_on)!, narration: `Investment — ${p.name}`, amount: Number(p.amount), ctx: { amounts: { amount: Number(p.amount) }, sub: { private: { type: "private_investment", id: p.id } } } });
  for (const f of (await c.query("select f.*, co.name from fund_cashflows f join private_investments pi on pi.id=f.private_investment_id join private_companies co on co.id=pi.company_id where f.family_id=$1 and pi.entity_id=$2 and not f.forecast and f.kind in ('call','distribution','recallable') and f.flow_date between $3 and $4", [familyId, entityId, from, to])).rows) { const amt = Math.abs(Number(f.amount)); ev.push({ eventType: f.kind === "call" ? "investment_txn.capital_call" : "investment_txn.distribution", sourceType: "fund_cashflow", sourceId: f.id, entityId, date: iso(f.flow_date)!, narration: `${f.kind === "call" ? "Capital call" : f.kind === "recallable" ? "Return of capital" : "Distribution"} — ${f.name}`, instrumentClass: "private", amount: amt, ctx: { amounts: { amount: amt, income_component: f.kind === "distribution" ? amt : 0, return_of_capital: f.kind === "recallable" ? amt : 0 }, sub: { private: { type: "private_investment", id: f.private_investment_id } } } }); }
  for (const a of (await c.query("select * from advance_tax_payments where family_id=$1 and entity_id=$2 and paid_on between $3 and $4", [familyId, entityId, from, to])).rows) ev.push({ eventType: "advance_tax.paid", sourceType: "advance_tax_payment", sourceId: a.id, entityId, date: iso(a.paid_on)!, narration: `Advance tax — FY ${a.fy}${a.challan ? ` (${a.challan})` : ""}`, amount: Number(a.amount), ctx: { amounts: { amount: Number(a.amount) } } });
  // categorised bank transactions whose source is not a platform event that posts itself
  const skippedBank = new Set<string>();
  const linkedSources: Record<string, string[]> = { rent: ["rent_receipt"], property_tax: ["property_tax"], expense: ["property_expense"], sip: ["investment_txn"], redemption: ["investment_txn", "realized_gain"], dividend: ["investment_txn"], interest: ["investment_txn"], drawdown: ["fund_cashflow", "private_investment"] };
  // an event collected in this same run that will post the bank movement: same amount within three days, or the linked source type within fifteen
  const pendingSource = (t: any) => { const amt = Math.abs(Number(t.amount)); const d = Date.parse(iso(t.txn_date)!); const near = (e: GlEvent, days: number) => Math.abs(Date.parse(e.date) - d) <= days * 86400000; const linked = linkedSources[t.link_type ?? ""] ?? []; return ev.some((e) => Math.abs(e.amount - amt) < 0.01 && near(e, 3)) || (linked.length > 0 && ev.some((e) => linked.includes(e.sourceType) && near(e, 15))); };
  for (const t of (await c.query("select t.*, c.name cname, c.kind ckind, b.type btype from bank_txns t join bank_accounts b on b.id=t.bank_account_id left join categories c on c.id=t.category_id where t.family_id=$1 and b.entity_id=$2 and t.txn_date between $3 and $4 and t.category_id is not null order by t.txn_date", [familyId, entityId, from, to])).rows) {
    // a credit or debit already represented by a source-event journal (rent receipt, property tax, SIP, dividend …) within three days is not posted twice
    if ((await c.query("select 1 from gl_journals j join gl_lines l on l.journal_id=j.id join gl_accounts a on a.id=l.account_id where j.entity_id=$1 and j.status='posted' and j.source_type <> 'bank_txn' and a.code in ('1110','2210','1130') and j.entry_date between $2::date - 3 and $2::date + 3 and abs(greatest(l.debit, l.credit) - $3) < 0.01 limit 1", [entityId, iso(t.txn_date), Math.abs(Number(t.amount))])).rowCount) { skippedBank.add(t.id); continue; }
    if (linkedSources[t.link_type ?? ""] && (pendingSource(t) || (await c.query("select 1 from gl_journals where entity_id=$1 and status='posted' and source_type = any($2) and entry_date between $3::date - 15 and $3::date + 15 limit 1", [entityId, linkedSources[t.link_type], iso(t.txn_date)])).rowCount)) continue; // the linked source row posts it
    const amt = Math.abs(Number(t.amount)); const key = slug(t.cname);
    ev.push({ eventType: `bank_txn.${key}`, sourceType: "bank_txn", sourceId: t.id, entityId, date: iso(t.txn_date)!, narration: `${t.cname} — ${t.counterparty ?? t.narration}`.slice(0, 200), amount: amt, ctx: { amounts: { amount: amt, principal: amt, interest: 0, emi: amt }, cash_code: cashCode(t.bank_account_id), liability_code: "2130", sub: { bank: { type: "bank_account", id: t.bank_account_id } } } });
  }
  const primary = (await c.query("select coalesce(b.default_bank_account_id, (select id from bank_accounts x where x.entity_id=$1 and x.deleted_at is null and x.type in ('current','savings') order by (x.type='current') desc, x.balance desc limit 1)) id from gl_books b where b.entity_id=$1", [entityId])).rows[0]?.id;
  if (primary) for (const e of ev) { e.ctx.sub = e.ctx.sub ?? {}; if (!e.ctx.sub.bank && !e.ctx.cash_code) e.ctx.sub.bank = { type: "bank_account", id: primary }; } // cash lines always carry a bank sub-ledger so the account reconciles
  return ev.sort((a, b) => a.date.localeCompare(b.date));
}
/** Post every event that has no journal yet; anything that cannot post lands in gl_unposted with a reason. */
export async function autopost(c: pg.PoolClient, familyId: string, opts: { entityId?: string | null; from?: string; to?: string; notify?: boolean } = {}) {
  const books = (await c.query("select b.*, e.name entity_name from gl_books b join entities e on e.id=b.entity_id where b.family_id=$1 and ($2::uuid is null or b.entity_id=$2)", [familyId, opts.entityId ?? null])).rows;
  let posted = 0, queued = 0, skipped = 0, superseded = 0; const details: any[] = [];
  for (const b of books) {
    const from = opts.from ?? iso(b.books_start_date)!, to = opts.to ?? today();
    const done = new Set((await c.query("select source_type || ':' || source_id::text k from gl_journals where entity_id=$1 and source_id is not null and status <> 'reversed'", [b.entity_id])).rows.map((r) => r.k));
    for (const e of await collectEvents(c, familyId, b.entity_id, from, to, b.basis)) {
      if (done.has(`${e.sourceType}:${e.sourceId}`)) { skipped++; continue; }
      const queue = async (reason: string, detail: any = {}) => { queued++; details.push({ entity: b.entity_name, event: e.eventType, reason }); await c.query("insert into gl_unposted (family_id, entity_id, event_type, source_type, source_id, event_date, amount, reason, detail) values ($1,$2,$3,$4,$5,$6,$7,$8,$9) on conflict (entity_id, source_type, source_id) do update set reason=excluded.reason, detail=excluded.detail, amount=excluded.amount, created_at=now()", [familyId, b.entity_id, e.eventType, e.sourceType, e.sourceId, e.date, e.amount, reason, JSON.stringify({ narration: e.narration, ...detail })]); };
      const rule = await resolveRule(c, familyId, e.eventType, e.instrumentClass ?? null, b.basis);
      if (!rule) { await queue("no_rule", { instrument_class: e.instrumentClass ?? null }); continue; }
      if (!rule.lines.length) { skipped++; continue; } // e.g. bonus: quantity only, no money
      const lines = applyRule(rule, e.ctx);
      await c.query("savepoint ap");
      try { await postJournal(c, familyId, { entityId: b.entity_id, entryDate: e.date, source: "auto", sourceType: e.sourceType, sourceId: e.sourceId, narration: e.narration, lines }); await c.query("release savepoint ap"); posted++; await c.query("delete from gl_unposted where entity_id=$1 and source_type=$2 and source_id=$3", [b.entity_id, e.sourceType, e.sourceId]);
        // a bank-statement line posted earlier for this same movement (feed before CAS / rent record) is superseded by the source journal
        const cash = e.sourceType !== "bank_txn" ? lines.find((l) => ["1110", "2210"].includes(l.account_code ?? "") && (Number(l.debit) > 0 || Number(l.credit) > 0)) : null;
        if (cash) { const dup = (await c.query("select j.id, j.source_id from gl_journals j join gl_lines l on l.journal_id=j.id join gl_accounts a on a.id=l.account_id where j.entity_id=$1 and j.status='posted' and j.source_type='bank_txn' and a.code in ('1110','2210') and j.entry_date between $2::date - 3 and $2::date + 3 and abs(greatest(l.debit, l.credit) - $3) < 0.01 and (l.debit > 0) = $4 limit 1", [b.entity_id, e.date, r2(Number(cash.debit) || Number(cash.credit)), Number(cash.debit) > 0])).rows[0];
          if (dup) { await reverseJournal(c, familyId, dup.id, null, { entry_date: e.date, reason: `superseded by ${e.sourceType}` }); await c.query("delete from gl_unposted where entity_id=$1 and source_type='bank_txn' and source_id=$2", [b.entity_id, dup.source_id]); superseded++; } } }
      catch (err: any) { await c.query("rollback to savepoint ap"); const msg = String(err.message ?? err); await queue(/locked/.test(msg) ? "period_locked" : err instanceof GlError && err.extra && (err.extra as any).code ? (err.extra as any).code : `error:${msg.slice(0, 120)}`, { rule_id: rule.id, lines }); }
    }
  }
  return { posted, queued, skipped, superseded, details };
}

// ---------- opening balances (FO-110) ----------
/** Balanced opening journal from platform data as at `asOf`: holdings at lot cost, private investments at cost, property at cost + improvements,
 *  bank balances rolled back to the date (current balance − later movements), deposits held, liabilities outstanding; the difference is capital. */
export async function generateOpening(c: pg.PoolClient, familyId: string, entityId: string, asOf: string) {
  const lines: (LineIn & { label: string })[] = [];
  for (const h of (await c.query("select h.id, i.name, i.type, i.asset_class, coalesce((select sum(remaining_qty*unit_cost+charges) from lots l where l.holding_id=h.id and remaining_qty > 0 and l.buy_date < $2), case when not exists (select 1 from lots l where l.holding_id=h.id) then h.quantity*h.avg_cost else 0 end) cost from holdings h join instruments i on i.id=h.instrument_id where h.entity_id=$1 and h.quantity > 0", [entityId, asOf])).rows) { const cost = r2(Number(h.cost)); if (cost > 0) lines.push({ account_code: assetCodeOf(classOf(h.type, h.asset_class ?? "", h.name)), debit: cost, sub_ledger_type: "holding", sub_ledger_id: h.id, label: h.name }); }
  for (const p of (await c.query("select pi.id, pi.amount, co.name from private_investments pi join private_companies co on co.id=pi.company_id where pi.entity_id=$1 and pi.status in ('active','unconverted') and pi.invested_on < $2", [entityId, asOf])).rows) lines.push({ account_code: "1295", debit: r2(Number(p.amount)), sub_ledger_type: "private_investment", sub_ledger_id: p.id, label: p.name });
  for (const p of (await c.query("select p.id, p.name, (p.acquisition_cost+p.stamp_duty+p.registration)*o.ownership_pct/100 cost, coalesce((select sum(amount) from property_expenses x where x.property_id=p.id and x.capital_improvement and x.expense_date < $2),0)*o.ownership_pct/100 capex from properties p join property_owners o on o.property_id=p.id where o.entity_id=$1 and p.deleted_at is null and p.acquisition_date < $2", [entityId, asOf])).rows) { lines.push({ account_code: "1310", debit: r2(Number(p.cost)), sub_ledger_type: "property", sub_ledger_id: p.id, label: p.name }); if (Number(p.capex) > 0) lines.push({ account_code: "1320", debit: r2(Number(p.capex)), sub_ledger_type: "property", sub_ledger_id: p.id, label: `${p.name} improvements` }); }
  for (const b of (await c.query("select b.id, b.bank, b.type, b.balance - coalesce((select sum(amount) from bank_txns t where t.bank_account_id=b.id and t.txn_date >= $2),0) opening from bank_accounts b where b.entity_id=$1 and b.deleted_at is null", [entityId, asOf])).rows) { const v = r2(Number(b.opening)); if (b.type === "card") { if (v < 0) lines.push({ account_code: "2210", credit: -v, sub_ledger_type: "bank_account", sub_ledger_id: b.id, label: `${b.bank} card` }); } else if (v !== 0) lines.push({ account_code: "1110", debit: v > 0 ? v : 0, credit: v < 0 ? -v : 0, sub_ledger_type: "bank_account", sub_ledger_id: b.id, label: b.bank }); }
  for (const l of (await c.query("select l.id, l.deposit, l.tenant_id, l.property_id, p.name from leases l join properties p on p.id=l.property_id join property_owners o on o.property_id=p.id where o.entity_id=$1 and l.status='active' and l.deposit > 0 and l.start_date < $2", [entityId, asOf])).rows) lines.push({ account_code: "2230", credit: r2(Number(l.deposit)), sub_ledger_type: l.tenant_id ? "tenant" : "property", sub_ledger_id: l.tenant_id ?? l.property_id, label: `${l.name} deposit` });
  for (const l of (await c.query("select id, kind, lender, outstanding from liabilities where entity_id=$1 and status='active'", [entityId])).rows) lines.push({ account_code: l.kind === "home_loan" ? "2110" : /securit|property|lap/.test(l.kind ?? "") ? "2120" : "2130", credit: r2(Number(l.outstanding)), sub_ledger_type: "liability", sub_ledger_id: l.id, label: l.lender });
  for (const p of (await c.query("select id, insurer, coalesce(surrender_value, fund_value) v from insurance_policies where entity_id=$1 and status='active' and coalesce(surrender_value, fund_value) > 0", [entityId])).rows) lines.push({ account_code: "1298", debit: r2(Number(p.v)), label: p.insurer });
  // deposits already running at the books' start date: an fd at its principal, an rd at what had been paid in (at cost, like holdings)
  for (const dp of (await c.query(`select d.bank, d.kind, d.account_no, case when d.kind='fd' then d.principal else (select coalesce(sum(r.received_amount),0) from deposit_receipts r where r.deposit_id=d.id and r.kind='contribution' and coalesce(r.received_on, r.due_date) < $2::date) end v
      from deposits d where d.entity_id=$1 and d.status='active' and d.start_date < $2::date`, [entityId, asOf])).rows) if (Number(dp.v) > 0) lines.push({ account_code: "1260", debit: r2(Number(dp.v)), label: `${dp.bank} ${dp.kind.toUpperCase()}${dp.account_no ? ` ${dp.account_no}` : ""}` });
  const d = lines.reduce((s, l) => s + Number(l.debit ?? 0), 0), cr = lines.reduce((s, l) => s + Number(l.credit ?? 0), 0);
  lines.push({ account_code: "3100", credit: d > cr ? r2(d - cr) : 0, debit: cr > d ? r2(cr - d) : 0, label: "Opening capital (balancing)" });
  return lines;
}
export async function setOpening(c: pg.PoolClient, familyId: string, entityId: string, asOf: string, lines: LineIn[], userId: string, opts: { post?: boolean } = {}) {
  const book = (await c.query("select * from gl_books where entity_id=$1", [entityId])).rows[0]; if (!book) throw new GlError(404, "No book for this entity");
  const accts = await accountMap(c, entityId);
  await c.query("delete from gl_opening_balances where entity_id=$1 and as_of=$2", [entityId, asOf]);
  for (const l of lines) { const acc = l.account_id ?? accts.get(l.account_code ?? "")?.id; if (!acc) continue; await c.query("insert into gl_opening_balances (family_id, entity_id, account_id, as_of, debit, credit, sub_ledger_type, sub_ledger_id) values ($1,$2,$3,$4,$5,$6,$7,$8) on conflict (entity_id, account_id, as_of, sub_key) do update set debit=gl_opening_balances.debit+excluded.debit, credit=gl_opening_balances.credit+excluded.credit", [familyId, entityId, acc, asOf, Number(l.debit ?? 0), Number(l.credit ?? 0), l.sub_ledger_type ?? null, l.sub_ledger_id ?? null]); }
  const existing = (await c.query("select id, status from gl_journals where entity_id=$1 and source='opening' and status <> 'reversed'", [entityId])).rows[0];
  if (existing?.status === "posted") throw new GlError(409, "An opening journal is already posted — reverse it first", { journal_id: existing.id });
  if (existing) { await c.query("delete from gl_lines where journal_id=$1", [existing.id]); await c.query("delete from gl_journals where id=$1", [existing.id]); }
  const j = await postJournal(c, familyId, { entityId, entryDate: asOf, source: "opening", sourceType: "opening", sourceId: entityId, narration: `Opening balances as at ${asOf}`, lines: lines.map((l) => ({ ...l, narration: (l as any).label ?? l.narration })), status: opts.post === false || book.maker_checker ? "draft" : "posted", postedBy: userId });
  return journalView(c, j.id);
}

// ---------- statements (FO-115) ----------
const balancesSql = `select a.id, a.code, a.name, a.type, a.parent_code, a.tax_head, coalesce(sum(case when j.entry_date < $3 then l.debit - l.credit end),0) opening, coalesce(sum(case when j.entry_date between $3 and $4 then l.debit end),0) debit, coalesce(sum(case when j.entry_date between $3 and $4 then l.credit end),0) credit
  from gl_accounts a left join gl_lines l on l.account_id=a.id left join gl_journals j on j.id=l.journal_id and j.status in ('posted','reversed') and j.entry_date <= $4 and ($5::boolean or j.source <> 'closing')
  where a.entity_id = any($1::uuid[]) and not a.is_group and ($2::boolean or a.entity_id is not null) group by a.id order by a.code`;
export async function trialBalance(c: pg.PoolClient, entityIds: string[], fy: string, asOf?: string | null, opts: { includeClosing?: boolean } = {}) {
  const rows = (await c.query(balancesSql, [entityIds, true, fyStart(fy), asOf ?? fyEnd(fy), opts.includeClosing ?? false])).rows;
  const byCode = new Map<string, any>();
  for (const r of rows) { const k = r.code; const x = byCode.get(k) ?? { code: r.code, name: r.name, type: r.type, tax_head: r.tax_head, opening: 0, debit: 0, credit: 0, closing: 0 }; x.opening = r2(x.opening + Number(r.opening)); x.debit = r2(x.debit + Number(r.debit)); x.credit = r2(x.credit + Number(r.credit)); x.closing = r2(x.opening + x.debit - x.credit); byCode.set(k, x); }
  return [...byCode.values()].filter((x) => x.opening || x.debit || x.credit).sort((a, b) => a.code.localeCompare(b.code));
}
const sum = (rows: any[]) => r2(rows.reduce((s, r) => s + r.amount, 0));
/** Income & expenditure with the prior FY beside it; sign convention: income positive, expenses positive, surplus = income − expenses. */
export async function profitLoss(c: pg.PoolClient, entityIds: string[], fy: string, asOf?: string | null, elim: Set<string> = new Set()) {
  const cur = await trialBalance(c, entityIds, fy, asOf); const prior = await trialBalance(c, entityIds, `${Number(fy.slice(0, 4)) - 1}-${fy.slice(0, 4).slice(-2)}`);
  const line = (r: any) => ({ code: r.code, name: r.name, tax_head: r.tax_head, amount: r2(r.type === "income" ? r.credit - r.debit : r.debit - r.credit), prior: (() => { const p = prior.find((x) => x.code === r.code); return p ? r2(p.type === "income" ? p.credit - p.debit : p.debit - p.credit) : 0; })() });
  const income = cur.filter((r) => r.type === "income" && !elim.has(r.code)).map(line), expenses = cur.filter((r) => r.type === "expense" && !elim.has(r.code)).map(line);
  const priorIncome = prior.filter((r) => r.type === "income").reduce((s, r) => s + Number(r.credit - r.debit), 0), priorExp = prior.filter((r) => r.type === "expense").reduce((s, r) => s + Number(r.debit - r.credit), 0);
  return { fy, as_of: asOf ?? fyEnd(fy), sections: [{ title: "Income", rows: income, total: sum(income), prior: r2(priorIncome) }, { title: "Expenses", rows: expenses, total: sum(expenses), prior: r2(priorExp) }], total: r2(sum(income) - sum(expenses)), prior_total: r2(priorIncome - priorExp) };
}
export async function balanceSheet(c: pg.PoolClient, entityIds: string[], fy: string, asOf?: string | null, elim: Set<string> = new Set()) {
  const tb = await trialBalance(c, entityIds, fy, asOf); const pl = await profitLoss(c, entityIds, fy, asOf, elim);
  const grp = (type: string, sign: 1 | -1) => tb.filter((r) => r.type === type && !elim.has(r.code)).map((r) => ({ code: r.code, name: r.name, amount: r2(sign * r.closing) })).filter((r) => r.amount !== 0);
  const assets = grp("asset", 1), liabilities = grp("liability", -1), equity = grp("equity", -1);
  const eliminated = tb.filter((r) => elim.has(r.code)).reduce((s, r) => s + Math.abs(r.closing), 0);
  return { fy, as_of: asOf ?? fyEnd(fy), sections: [{ title: "Assets", rows: assets, total: sum(assets) }, { title: "Liabilities", rows: liabilities, total: sum(liabilities) }, { title: "Capital", rows: [...equity, { code: "—", name: `Surplus for the year (to date)`, amount: pl.total }], total: r2(sum(equity) + pl.total) }], total: sum(assets), balances: Math.abs(sum(assets) - sum(liabilities) - sum(equity) - pl.total) < 0.02, consolidated: entityIds.length > 1, eliminations: r2(eliminated / 2) };
}
export async function capitalAccount(c: pg.PoolClient, entityIds: string[], fy: string, asOf?: string | null) {
  const tb = await trialBalance(c, entityIds, fy, asOf); const pl = await profitLoss(c, entityIds, fy, asOf);
  const eq = tb.filter((r) => r.type === "equity").map((r) => ({ code: r.code, name: r.name, opening: r2(-r.opening), additions: r2(r.credit), drawings: r2(r.debit), closing: r2(-r.closing) }));
  const partners = (await c.query("select p.*, a.code from gl_partner_capital p join gl_accounts a on a.id=p.capital_account_id where p.entity_id = any($1::uuid[]) order by p.profit_share_pct desc", [entityIds])).rows.map((p) => ({ partner: p.partner_name, share_pct: Number(p.profit_share_pct), share_of_surplus: r2(pl.total * Number(p.profit_share_pct) / 100) }));
  return { fy, as_of: asOf ?? fyEnd(fy), sections: [{ title: "Capital accounts", rows: eq.map((e) => ({ code: e.code, name: e.name, amount: e.closing, opening: e.opening, additions: e.additions, drawings: e.drawings })), total: r2(eq.reduce((s, e) => s + e.closing, 0)) }, { title: "Surplus for the year", rows: [{ code: "—", name: "Income less expenses", amount: pl.total }], total: pl.total }], total: r2(eq.reduce((s, e) => s + e.closing, 0) + pl.total), partners };
}
/** Cash & fund flow: movements on cash accounts classified by the counter-accounts in the same journal. */
export async function cashFlow(c: pg.PoolClient, entityIds: string[], fy: string, asOf?: string | null) {
  const rows = (await c.query(`select j.id, ca.type ctype, ca.code ccode, sum(case when ac.code in ('1110','1120','1130') then l.debit - l.credit else 0 end) cash from gl_journals j join gl_lines l on l.journal_id=j.id join gl_accounts ac on ac.id=l.account_id
    join lateral (select a2.type, a2.code from gl_lines l2 join gl_accounts a2 on a2.id=l2.account_id where l2.journal_id=j.id and a2.code not in ('1110','1120','1130') order by greatest(l2.debit,l2.credit) desc limit 1) ca on true
    where j.entity_id = any($1::uuid[]) and j.status in ('posted','reversed') and j.source <> 'opening' and j.entry_date between $2 and $3 group by j.id, ca.type, ca.code having sum(case when ac.code in ('1110','1120','1130') then l.debit - l.credit else 0 end) <> 0`, [entityIds, fyStart(fy), asOf ?? fyEnd(fy)])).rows;
  const bucket = (r: any) => (["income", "expense"].includes(r.ctype) || ["1410", "1420", "1430", "1440", "2240", "2250"].includes(r.ccode) ? "Operating" : r.ccode.startsWith("12") || r.ccode.startsWith("13") || r.ccode === "1450" ? "Investing" : "Financing");
  const secs: { title: string; rows: { code: string; name: string; amount: number }[]; total: number }[] = [];
  for (const t of ["Operating", "Investing", "Financing"]) { const rs = rows.filter((r) => bucket(r) === t); const by = new Map<string, number>(); for (const r of rs) by.set(r.ccode, r2((by.get(r.ccode) ?? 0) + Number(r.cash))); const names = new Map((await await0(c, [...by.keys()], entityIds[0])).map((a: any) => [a.code, a.name])); secs.push({ title: t, rows: [...by.entries()].map(([code, amount]) => ({ code, name: names.get(code) ?? code, amount })), total: r2([...by.values()].reduce((s, v) => s + v, 0)) }); }
  const opening = (await trialBalance(c, entityIds, fy, asOf)).filter((r) => ["1110", "1120", "1130"].includes(r.code)).reduce((s, r) => s + r.opening, 0);
  return { fy, as_of: asOf ?? fyEnd(fy), sections: secs, total: r2(secs.reduce((s, x) => s + x.total, 0)), opening_cash: r2(opening), closing_cash: r2(opening + secs.reduce((s, x) => s + x.total, 0)) };
}
async function await0(c: pg.PoolClient, codes: string[], entityId: string) { return codes.length ? (await c.query("select code, name from gl_accounts where entity_id=$1 and code = any($2)", [entityId, codes])).rows : []; }
export async function ledger(c: pg.PoolClient, entityId: string, opts: { accountId?: string | null; subLedgerType?: string | null; subLedgerId?: string | null; from: string; to: string }) {
  const where = [] as string[]; const args: any[] = [entityId, opts.from, opts.to]; if (opts.accountId) { args.push(opts.accountId); where.push(`l.account_id=$${args.length}`); } if (opts.subLedgerType && opts.subLedgerId) { args.push(opts.subLedgerType, opts.subLedgerId); where.push(`l.sub_ledger_type=$${args.length - 1} and l.sub_ledger_id=$${args.length}`); }
  if (!where.length) throw new GlError(422, "account_id or sub_ledger_type + sub_ledger_id required");
  const opening = Number((await c.query(`select coalesce(sum(l.debit - l.credit),0) v from gl_lines l join gl_journals j on j.id=l.journal_id where j.entity_id=$1 and j.status in ('posted','reversed') and j.entry_date < $2::date and $3::date >= $2::date and ${where.join(" and ")}`, args)).rows[0].v);
  const rows = (await c.query(`select j.entry_date date, j.journal_no, j.id journal_id, j.narration, j.source, a.code account_code, a.name account_name, l.debit, l.credit from gl_lines l join gl_journals j on j.id=l.journal_id join gl_accounts a on a.id=l.account_id where j.entity_id=$1 and j.status in ('posted','reversed') and j.entry_date between $2 and $3 and ${where.join(" and ")} order by j.entry_date, j.journal_no, l.line_no`, args)).rows;
  let bal = opening; const out = rows.map((r) => { bal = r2(bal + Number(r.debit) - Number(r.credit)); return { ...r, date: iso(r.date), debit: Number(r.debit), credit: Number(r.credit), balance: bal }; });
  return { opening: r2(opening), rows: out, closing: r2(bal) };
}
export async function itrMapping(c: pg.PoolClient, entityId: string, fy: string, projection: any | null) {
  const tb = await trialBalance(c, [entityId], fy);
  const heads = ["salary", "house_property", "business", "capital_gains", "other_sources"];
  return heads.map((h) => {
    const gl = r2(tb.filter((r) => r.tax_head === h).reduce((s, r) => s + (r.type === "income" ? r.credit - r.debit : -(r.debit - r.credit)), 0));
    const p = projection?.heads; let engine: number | null = null; let note = "";
    if (p) { if (h === "capital_gains") engine = r2(Object.values(p.capital_gains ?? {}).filter((_, i, a) => true).reduce((s: number, v: any, i: number) => (i < 4 ? s + Number(v ?? 0) : s), 0)); else engine = Number(p[h] ?? 0);
      if (h === "house_property") note = "tax engine applies the 30% standard deduction and municipal taxes; the books carry gross rent less expenses"; if (h === "capital_gains") note = "engine nets the LTCG exemption and grandfathering; books carry gains as realised"; if (h === "other_sources") note = "engine includes accrued interest not yet received"; }
    return { tax_head: h, gl_amount: gl, tax_engine_amount: engine, difference: engine == null ? null : r2(engine - gl), note };
  });
}

// ---------- reconciliation (FO-62, FO-116) ----------
export async function reconcileBank(c: pg.PoolClient, familyId: string, bankAccountId: string, asOf = today()) {
  const b = (await c.query("select * from bank_accounts where id=$1 and family_id=$2", [bankAccountId, familyId])).rows[0]; if (!b) throw new GlError(404, "Bank account not found");
  const ledgerBal = Number((await c.query("select coalesce(sum(l.debit - l.credit),0) v from gl_lines l join gl_journals j on j.id=l.journal_id join gl_accounts a on a.id=l.account_id where j.entity_id=$1 and j.status in ('posted','reversed') and j.entry_date <= $3 and l.sub_ledger_type='bank_account' and l.sub_ledger_id=$2", [b.entity_id, bankAccountId, asOf])).rows[0].v) * (b.type === "card" ? -1 : 1);
  const stmt = Number(b.balance) - Number((await c.query("select coalesce(sum(amount),0) v from bank_txns where bank_account_id=$1 and txn_date > $2", [bankAccountId, asOf])).rows[0].v);
  const unmatchedStmt = (await c.query(`select t.id, t.txn_date, t.amount, t.narration, t.link_type from bank_txns t where t.bank_account_id=$1 and t.txn_date <= $2 and t.txn_date >= (select books_start_date from gl_books where entity_id=$3)
      and not exists (select 1 from gl_journals j where j.status='posted' and j.entity_id=$3 and (j.source_id = t.id or j.source_id = t.link_id or (j.source_type in ('rent_receipt','property_tax','property_expense') and j.source_id in (select id from rent_schedule where bank_txn_id=t.id union select id from property_taxes where bank_txn_id=t.id union select id from property_expenses where bank_txn_id=t.id)) or (j.source_type='investment_txn' and j.source_id in (select id from investment_txns x where x.entity_id=$3 and abs(x.amount - abs(t.amount)) < 1 and x.txn_date between t.txn_date - 3 and t.txn_date + 3))))`, [bankAccountId, asOf, b.entity_id])).rows;
  const unmatchedLedger = (await c.query("select j.id journal_id, j.journal_no, j.entry_date, j.narration, l.debit, l.credit from gl_lines l join gl_journals j on j.id=l.journal_id where j.entity_id=$1 and j.status='posted' and j.source in ('manual','recurring','tally_import') and l.sub_ledger_type='bank_account' and l.sub_ledger_id=$2 and j.entry_date <= $3", [b.entity_id, bankAccountId, asOf])).rows;
  return { bank_account_id: bankAccountId, bank: b.bank, account_masked: b.account_masked, as_of: asOf, ledger_balance: r2(ledgerBal), statement_balance: r2(stmt), difference: r2(stmt - ledgerBal), unmatched_in_statement: unmatchedStmt.map((t) => ({ ...t, txn_date: iso(t.txn_date), amount: Number(t.amount) })), unmatched_in_ledger: unmatchedLedger.map((l) => ({ ...l, entry_date: iso(l.entry_date), debit: Number(l.debit), credit: Number(l.credit) })), reconciled: Math.abs(stmt - ledgerBal) < 0.01 && !unmatchedStmt.length };
}
export async function reconcileInvestments(c: pg.PoolClient, entityId: string, asOf = today()) {
  const rows = (await c.query(`select h.id holding_id, i.name, i.type, h.quantity, coalesce((select sum(remaining_qty*unit_cost+charges) from lots l where l.holding_id=h.id and remaining_qty > 0), case when not exists (select 1 from lots l where l.holding_id=h.id) then h.quantity*h.avg_cost else 0 end) holdings_cost,
      coalesce((select sum(l.debit - l.credit) from gl_lines l join gl_journals j on j.id=l.journal_id where j.status in ('posted','reversed') and j.entry_date <= $2 and l.sub_ledger_type='holding' and l.sub_ledger_id=h.id),0) book_cost
      from holdings h join instruments i on i.id=h.instrument_id where h.entity_id=$1 order by i.name`, [entityId, asOf])).rows.map((r) => ({ ...r, quantity: Number(r.quantity), holdings_cost: r2(Number(r.holdings_cost) || 0), book_cost: r2(Number(r.book_cost)), difference: r2(Number(r.book_cost) - (Number(r.holdings_cost) || 0)) }));
  const priv = (await c.query(`select pi.id private_investment_id, co.name, pi.amount cost, coalesce((select sum(l.debit - l.credit) from gl_lines l join gl_journals j on j.id=l.journal_id where j.status in ('posted','reversed') and j.entry_date <= $2 and l.sub_ledger_type='private_investment' and l.sub_ledger_id=pi.id),0) book_cost from private_investments pi join private_companies co on co.id=pi.company_id where pi.entity_id=$1 and pi.status in ('active','unconverted')`, [entityId, asOf])).rows.map((r) => ({ ...r, quantity: null, holdings_cost: r2(Number(r.cost)), book_cost: r2(Number(r.book_cost)), difference: r2(Number(r.book_cost) - Number(r.cost)) }));
  const all = [...rows, ...priv]; return { as_of: asOf, rows: all, differences: all.filter((r) => Math.abs(r.difference) >= 0.01).length };
}

// ---------- periods, close, year-end (FO-114) ----------
export async function unpostedCount(c: pg.PoolClient, entityId: string, from?: string, to?: string) { return Number((await c.query("select count(*) n from gl_unposted where entity_id=$1 and ($2::date is null or event_date >= $2) and ($3::date is null or event_date <= $3) and reason <> 'reversed'", [entityId, from ?? null, to ?? null])).rows[0].n); }
export async function setPeriodStatus(c: pg.PoolClient, familyId: string, periodId: string, status: "open" | "soft_closed" | "locked", userId: string, role: string, reason?: string) {
  const p = (await c.query("select * from gl_periods where id=$1", [periodId])).rows[0]; if (!p) throw new GlError(404, "Period not found");
  if (status === "locked") { const n = await unpostedCount(c, p.entity_id, iso(p.period_start)!, iso(p.period_end)!); if (n) throw new GlError(409, `${n} unposted event${n > 1 ? "s" : ""} inside the period — post or resolve them first`);
    const drafts = Number((await c.query("select count(*) n from gl_journals where entity_id=$1 and status='draft' and entry_date between $2 and $3", [p.entity_id, p.period_start, p.period_end])).rows[0].n); if (drafts) throw new GlError(409, `${drafts} draft journal${drafts > 1 ? "s" : ""} inside the period`);
    const strict = (await c.query("select strict_reconciliation from gl_books where entity_id=$1", [p.entity_id])).rows[0]?.strict_reconciliation;
    if (strict) { const banks = (await c.query("select id from bank_accounts where entity_id=$1 and deleted_at is null and type <> 'card'", [p.entity_id])).rows; for (const b of banks) { const r = await reconcileBank(c, familyId, b.id, iso(p.period_end)!); if (!r.reconciled) throw new GlError(409, `Bank ${r.bank} not reconciled at ${iso(p.period_end)}: difference ${r.difference}, ${r.unmatched_in_statement.length} unmatched`, r); } } }
  if (status === "open" && p.status === "locked" && role !== "owner") throw new GlError(403, "Reopening a locked period needs an owner");
  if (status === "open" && p.status === "locked" && !reason) throw new GlError(422, "A reason is required to reopen a locked period");
  return (await c.query("update gl_periods set status=$2::period_status, closed_by=case when $2='open' then null else $3::uuid end, closed_at=case when $2='open' then null else now() end where id=$1 returning *", [periodId, status, userId])).rows[0];
}
/** Year-end: income and expense accounts close to capital (or partner capital by share); periods lock; next FY opens. */
export async function yearEndClose(c: pg.PoolClient, familyId: string, entityId: string, fy: string, userId: string) {
  const book = (await c.query("select * from gl_books where entity_id=$1", [entityId])).rows[0]; if (!book) throw new GlError(404, "No book for this entity");
  if ((await c.query("select 1 from gl_journals where entity_id=$1 and fy=$2 and source='closing' and status='posted'", [entityId, fy])).rowCount) throw new GlError(409, `FY ${fy} is already closed`);
  const n = await unpostedCount(c, entityId, fyStart(fy), fyEnd(fy)); if (n) throw new GlError(409, `${n} unposted events in FY ${fy}`);
  const tb = await trialBalance(c, [entityId], fy); const pl = tb.filter((r) => ["income", "expense"].includes(r.type) && r.closing !== 0);
  const lines: LineIn[] = pl.map((r) => ({ account_code: r.code, debit: r.closing < 0 ? -r.closing : 0, credit: r.closing > 0 ? r.closing : 0 }));
  const surplus = r2(pl.reduce((s, r) => s + (r.type === "income" ? -r.closing : -r.closing), 0)); // credit balances are negative in closing
  const partners = (await c.query("select p.*, a.code from gl_partner_capital p join gl_accounts a on a.id=p.capital_account_id where p.entity_id=$1", [entityId])).rows;
  if (partners.length) { let left = surplus; partners.forEach((p, i) => { const share = i === partners.length - 1 ? r2(left) : r2(surplus * Number(p.profit_share_pct) / 100); left = r2(left - share); lines.push({ account_code: p.code, credit: share > 0 ? share : 0, debit: share < 0 ? -share : 0, narration: `${p.partner_name} ${Number(p.profit_share_pct)}%`, sub_ledger_type: "partner", sub_ledger_id: p.id }); }); }
  else lines.push({ account_code: "3100", credit: surplus > 0 ? surplus : 0, debit: surplus < 0 ? -surplus : 0, narration: "Surplus for the year" });
  const j = lines.length >= 2 ? await postJournal(c, familyId, { entityId, entryDate: fyEnd(fy), source: "closing", sourceType: "closing", sourceId: null, narration: `Year-end close FY ${fy}: surplus ${surplus.toLocaleString("en-IN")} to ${partners.length ? "partner capital" : "capital"}`, lines, postedBy: userId }) : null;
  await c.query("update gl_periods set status='locked', closed_by=$3, closed_at=now() where entity_id=$1 and fy=$2", [entityId, fy, userId]);
  const nf = nextFy(fy); const y = Number(nf.slice(0, 4));
  for (const [s, e] of [[`${y}-04-01`, `${y}-06-30`], [`${y}-07-01`, `${y}-09-30`], [`${y}-10-01`, `${y}-12-31`], [`${y + 1}-01-01`, `${y + 1}-03-31`]]) await c.query("insert into gl_periods (family_id, entity_id, fy, period_start, period_end) values ($1,$2,$3,$4,$5) on conflict do nothing", [familyId, entityId, nf, s, e]);
  return { fy, surplus, journal: j ? await journalView(c, j.id) : null, partners: partners.map((p) => ({ partner: p.partner_name, share_pct: Number(p.profit_share_pct), amount: r2(surplus * Number(p.profit_share_pct) / 100) })), next_fy: nf };
}

// ---------- recurring, inter-entity (FO-111, FO-112) ----------
const addMonthsIso = (d: string, m: number) => { const x = new Date(d + "T00:00:00Z"); const day = x.getUTCDate(); x.setUTCDate(1); x.setUTCMonth(x.getUTCMonth() + m); const last = new Date(Date.UTC(x.getUTCFullYear(), x.getUTCMonth() + 1, 0)).getUTCDate(); x.setUTCDate(Math.min(day, last)); return x.toISOString().slice(0, 10); };
export async function runRecurring(c: pg.PoolClient, familyId: string, day = today()) {
  let posted = 0;
  for (const r of (await c.query("select * from gl_recurring where family_id=$1 and active and next_run is not null and next_run <= $2 order by next_run", [familyId, day])).rows) {
    let guard = 0;
    while (r.next_run && iso(r.next_run)! <= day && guard++ < 36) {
      const runDate = iso(r.next_run)!; const lines = (r.template as any[]).map((l) => ({ account_code: l.account_code, account_id: l.account_id, debit: Number(l.debit ?? 0), credit: Number(l.credit ?? 0), narration: l.narration, sub_ledger_type: l.sub_ledger_type, sub_ledger_id: l.sub_ledger_id }));
      const sid = (await c.query("select md5($1 || $2)::uuid id", [r.id, runDate])).rows[0].id;
      await c.query("savepoint rc"); try { await postJournal(c, familyId, { entityId: r.entity_id, entryDate: runDate, source: "recurring", sourceType: `recurring:${r.name}`, sourceId: sid, narration: `${r.narration ?? r.name} (${runDate})`, lines }); await c.query("release savepoint rc"); posted++; } catch (e: any) { await c.query("rollback to savepoint rc"); if (!/duplicate key/.test(e.message)) { await c.query("insert into gl_unposted (family_id, entity_id, event_type, source_type, source_id, event_date, reason, detail) values ($1,$2,'recurring',$3,$4,$5,$6,$7) on conflict (entity_id, source_type, source_id) do update set reason=excluded.reason", [familyId, r.entity_id, `recurring:${r.name}`, sid, runDate, `error:${String(e.message).slice(0, 120)}`, JSON.stringify({ recurring_id: r.id })]); } }
      const p = Object.fromEntries(r.rrule.split(";").map((x: string) => x.split("="))); const step = p.FREQ === "YEARLY" ? 12 : Number(p.INTERVAL ?? 1) * (p.FREQ === "MONTHLY" ? 1 : p.FREQ === "WEEKLY" ? 0 : 1);
      r.next_run = step ? addMonthsIso(runDate, step) : new Date(Date.parse(runDate) + 7 * 86400000).toISOString().slice(0, 10);
      await c.query("update gl_recurring set next_run=$2, last_run=$3 where id=$1", [r.id, r.next_run, runDate]);
    }
  }
  return { posted };
}
export async function interEntity(c: pg.PoolClient, familyId: string, userId: string, b: { kind: "gift" | "loan" | "reimbursement" | "shared_expense"; from_entity_id: string; to_entity_id: string; amount: number; entry_date: string; narration?: string; share_pct?: number; from_bank_account_id?: string | null; to_bank_account_id?: string | null }) {
  const rule = await resolveRule(c, familyId, `inter_entity.${b.kind}`, null, "accrual"); if (!rule) throw new GlError(422, `No posting rule for inter_entity.${b.kind}`);
  const group = (await c.query("select gen_random_uuid() id")).rows[0].id; const share = b.kind === "shared_expense" ? r2(b.amount * (b.share_pct ?? 50) / 100) : b.amount;
  const amounts = { amount: b.amount, share, other_share: r2(b.amount - share) }; const roles: Record<string, string> = { giver: b.from_entity_id, lender: b.from_entity_id, receiver: b.to_entity_id, borrower: b.to_entity_id };
  const out: any[] = [];
  for (const entityId of [b.from_entity_id, b.to_entity_id]) {
    const mine = (rule.lines as any[]).filter((l) => roles[l.entity] === entityId); if (!mine.length) continue;
    const lines = applyRule({ lines: mine }, { amounts, sub: { bank: entityId === b.from_entity_id && b.from_bank_account_id ? { type: "bank_account", id: b.from_bank_account_id } : entityId === b.to_entity_id && b.to_bank_account_id ? { type: "bank_account", id: b.to_bank_account_id } : undefined as any } });
    for (const l of lines) if (["1460", "2280"].includes(l.account_code!)) { l.sub_ledger_type = "entity"; l.sub_ledger_id = entityId === b.from_entity_id ? b.to_entity_id : b.from_entity_id; }
    const j = await postJournal(c, familyId, { entityId, entryDate: b.entry_date, source: "manual", sourceType: `inter_entity.${b.kind}`, sourceId: group, narration: b.narration ?? `Inter-entity ${b.kind.replace("_", " ")}`, lines, postedBy: userId, intercompanyGroup: group });
    out.push(await journalView(c, j.id));
  }
  return { intercompany_group: group, journals: out };
}

// ---------- Tally XML (FO-117) ----------
const xml = (s: any) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const tallyDate = (d: string) => d.replace(/-/g, "");
export async function tallyExport(c: pg.PoolClient, familyId: string, entityId: string, from: string, to: string, includeMasters = true) {
  const ent = (await c.query("select name from entities where id=$1", [entityId])).rows[0]; const accts = (await c.query("select * from gl_accounts where entity_id=$1 and not is_group order by code", [entityId])).rows;
  const journals = (await c.query("select * from gl_journals where entity_id=$1 and status='posted' and entry_date between $2 and $3 order by entry_date, journal_no", [entityId, from, to])).rows;
  const parts: string[] = [];
  if (includeMasters) for (const a of accts) parts.push(`<TALLYMESSAGE xmlns:UDF="TallyUDF"><LEDGER NAME="${xml(a.tally_ledger_name ?? a.name)}" ACTION="Create"><NAME.LIST><NAME>${xml(a.tally_ledger_name ?? a.name)}</NAME></NAME.LIST><PARENT>${xml(a.tally_parent_group ?? (a.type === "income" ? "Indirect Incomes" : a.type === "expense" ? "Indirect Expenses" : a.type === "asset" ? "Current Assets" : a.type === "liability" ? "Current Liabilities" : "Capital Account"))}</PARENT><ISBILLWISEON>No</ISBILLWISEON><AFFECTSSTOCK>No</AFFECTSSTOCK><GUID>fo-${a.id}</GUID></LEDGER></TALLYMESSAGE>`);
  let vouchers = 0;
  for (const j of journals) {
    const lines = (await c.query("select l.*, a.code, a.name, a.tally_ledger_name from gl_lines l join gl_accounts a on a.id=l.account_id where l.journal_id=$1 order by l.line_no", [j.id])).rows;
    const cashy = (l: any) => ["1110", "1120"].includes(l.code); const vtype = lines.some((l) => cashy(l) && Number(l.debit) > 0) && !lines.some((l) => cashy(l) && Number(l.credit) > 0) ? "Receipt" : lines.some((l) => cashy(l) && Number(l.credit) > 0) && !lines.some((l) => cashy(l) && Number(l.debit) > 0) ? "Payment" : lines.every(cashy) ? "Contra" : "Journal";
    parts.push(`<TALLYMESSAGE xmlns:UDF="TallyUDF"><VOUCHER REMOTEID="fo-${j.id}" VCHTYPE="${vtype}" ACTION="Create" OBJVIEW="Accounting Voucher View"><DATE>${tallyDate(iso(j.entry_date)!)}</DATE><GUID>fo-${j.id}</GUID><NARRATION>${xml(j.narration)}</NARRATION><VOUCHERTYPENAME>${vtype}</VOUCHERTYPENAME><VOUCHERNUMBER>${j.fy}/${j.journal_no}</VOUCHERNUMBER><PERSISTEDVIEW>Accounting Voucher View</PERSISTEDVIEW>${lines.map((l) => `<ALLLEDGERENTRIES.LIST><LEDGERNAME>${xml(l.tally_ledger_name ?? l.name)}</LEDGERNAME><ISDEEMEDPOSITIVE>${Number(l.debit) > 0 ? "Yes" : "No"}</ISDEEMEDPOSITIVE><AMOUNT>${Number(l.debit) > 0 ? "-" + Number(l.debit).toFixed(2) : Number(l.credit).toFixed(2)}</AMOUNT></ALLLEDGERENTRIES.LIST>`).join("")}</VOUCHER></TALLYMESSAGE>`); vouchers++;
  }
  const body = `<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER><BODY><IMPORTDATA><REQUESTDESC><REPORTNAME>${includeMasters ? "All Masters" : "Vouchers"}</REPORTNAME><STATICVARIABLES><SVCURRENTCOMPANY>${xml(ent?.name)}</SVCURRENTCOMPANY></STATICVARIABLES></REQUESTDESC><REQUESTDATA>${parts.join("")}</REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>`;
  const sync = (await c.query("insert into gl_tally_sync (family_id, entity_id, direction, fy, from_date, to_date, vouchers, status, log, xml) values ($1,$2,'export',$3,$4,$5,$6,'done',$7,$8) returning id", [familyId, entityId, fyOf(from), from, to, vouchers, JSON.stringify([{ masters: includeMasters ? accts.length : 0, vouchers }]), body])).rows[0];
  return { sync_id: sync.id, vouchers, masters: includeMasters ? accts.length : 0, xml: body };
}
/** Minimal Tally day-book reader: VOUCHER blocks with DATE, GUID, NARRATION and ALLLEDGERENTRIES.LIST (LEDGERNAME, AMOUNT; negative = debit). */
export function parseTallyVouchers(text: string) {
  const out: { guid: string | null; date: string; narration: string; vtype: string | null; lines: { ledger: string; debit: number; credit: number }[] }[] = [];
  const tag = (s: string, t: string) => { const m = s.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`, "i")); return m ? m[1].replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").trim() : null; };
  for (const v of text.match(/<VOUCHER[\s>][\s\S]*?<\/VOUCHER>/gi) ?? []) {
    const d = tag(v, "DATE") ?? ""; const date = /^\d{8}$/.test(d) ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : d;
    const lines = (v.match(/<(?:ALLLEDGERENTRIES|LEDGERENTRIES)\.LIST>[\s\S]*?<\/(?:ALLLEDGERENTRIES|LEDGERENTRIES)\.LIST>/gi) ?? []).map((e) => { const amt = Number(tag(e, "AMOUNT") ?? 0); const deemed = (tag(e, "ISDEEMEDPOSITIVE") ?? "").toLowerCase() === "yes"; const debit = deemed || amt < 0; return { ledger: tag(e, "LEDGERNAME") ?? "", debit: debit ? Math.abs(amt) : 0, credit: debit ? 0 : Math.abs(amt) }; });
    out.push({ guid: tag(v, "GUID") ?? (v.match(/REMOTEID="([^"]+)"/i)?.[1] ?? null), date, narration: tag(v, "NARRATION") ?? "Tally import", vtype: v.match(/VCHTYPE="([^"]+)"/i)?.[1] ?? tag(v, "VOUCHERTYPENAME"), lines });
  }
  return out;
}
export async function tallyImport(c: pg.PoolClient, familyId: string, entityId: string, text: string, userId: string, mapping: Record<string, string> = {}) {
  const vouchers = parseTallyVouchers(text); const accts = (await c.query("select id, code, name, tally_ledger_name from gl_accounts where entity_id=$1 and not is_group", [entityId])).rows;
  const byName = new Map<string, string>(); for (const a of accts) { byName.set(a.name.toLowerCase(), a.id); if (a.tally_ledger_name) byName.set(String(a.tally_ledger_name).toLowerCase(), a.id); byName.set(a.code, a.id); }
  for (const [k, v] of Object.entries(mapping)) byName.set(k.toLowerCase(), byName.get(String(v).toLowerCase()) ?? v);
  const unmapped = [...new Set(vouchers.flatMap((v) => v.lines.map((l) => l.ledger)).filter((n) => !byName.has(n.toLowerCase())))];
  if (unmapped.length) return { imported: 0, duplicates: 0, unmapped, vouchers: vouchers.length };
  let imported = 0, duplicates = 0; const log: any[] = [];
  for (const v of vouchers) {
    if (v.guid && (await c.query("select 1 from gl_journals where entity_id=$1 and tally_voucher_guid=$2", [entityId, v.guid])).rowCount) { duplicates++; continue; }
    await c.query("savepoint ti"); try { const j = await postJournal(c, familyId, { entityId, entryDate: v.date, source: "tally_import", sourceType: "tally_voucher", sourceId: v.guid ? (await c.query("select md5($1)::uuid id", [v.guid])).rows[0].id : null, narration: `${v.vtype ? `[${v.vtype}] ` : ""}${v.narration}`, lines: v.lines.map((l) => ({ account_id: byName.get(l.ledger.toLowerCase()), debit: l.debit, credit: l.credit })), postedBy: userId, tallyGuid: v.guid }); await c.query("release savepoint ti"); imported++; log.push({ guid: v.guid, journal_id: j.id }); }
    catch (e: any) { await c.query("rollback to savepoint ti"); if (/duplicate key/.test(e.message)) duplicates++; else log.push({ guid: v.guid, error: String(e.message).slice(0, 160) }); }
  }
  await c.query("insert into gl_tally_sync (family_id, entity_id, direction, fy, vouchers, status, log) values ($1,$2,'import',$3,$4,'done',$5)", [familyId, entityId, fyOf(vouchers[0]?.date ?? today()), imported, JSON.stringify(log)]);
  return { imported, duplicates, unmapped: [], vouchers: vouchers.length, errors: log.filter((l) => l.error) };
}
