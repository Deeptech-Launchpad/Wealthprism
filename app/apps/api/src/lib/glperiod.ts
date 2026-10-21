/** GL period-end residue (FO-118 / 119): mark-to-market of listed holdings against the unrealised reserve (or P&L), and depreciation of
 *  lifestyle assets / capital improvements at the rates in `depreciation_rates` (data, WDV). Both post idempotently per period, through
 *  postJournal, so the books stay balanced and immutable; a period-end that is re-run returns the journal it already posted. */
import type pg from "pg";
import { fyOf } from "@fo/finance";
import { GlError, postJournal, journalView, trialBalance, fyStart, fyEnd } from "./gl.js";
import { money } from "./db.js";

const r2 = (n: number) => Math.round(n * 100) / 100 + 0;
const iso = (d: any) => (d instanceof Date ? d.toISOString().slice(0, 10) : d ? String(d).slice(0, 10) : null);
const classOf = (type: string, assetClass: string, name: string) => /liquid|overnight/i.test(name) && type === "mf" ? "liquid" : type === "stock" || type === "etf" ? (assetClass.includes("gold") ? "gold" : assetClass.includes("reit") ? "reit" : assetClass.includes("foreign") || assetClass.startsWith("intl") ? "foreign" : "equity") : type === "mf" ? (assetClass.includes("gold") ? "gold" : "mf") : type === "pms" ? "pms" : type === "aif" ? "aif" : type === "bond" || type === "gsec" || type === "tbill" || type === "fd" ? "debt" : "mf";
const codeOf = (cls: string) => ({ equity: "1210", mf: "1220", pms: "1230", aif: "1240", debt: "1250", gold: "1270", reit: "1280", foreign: "1290", liquid: "1130" } as Record<string, string>)[cls] ?? "1220";

async function period(c: pg.PoolClient, periodId: string) { const p = (await c.query("select * from gl_periods where id=$1", [periodId])).rows[0]; if (!p) throw new GlError(404, "Period not found"); return { ...p, period_start: iso(p.period_start)!, period_end: iso(p.period_end)! }; }
async function book(c: pg.PoolClient, entityId: string) { const b = (await c.query("select * from gl_books where entity_id=$1", [entityId])).rows[0]; if (!b) throw new GlError(404, "No book for this entity"); return b; }

// ---------- mark-to-market ----------
/** Per investment account: market value of the holdings that map to it (latest price on or before as_of, cost when unpriced) vs the book
 *  balance (which already carries earlier MTM), so the adjustment is the delta. Reserve treatment moves it against 3400; P&L treatment
 *  against 4420 / 5900. */
export async function mtmPreview(c: pg.PoolClient, familyId: string, entityId: string, asOf: string) {
  const b = await book(c, entityId);
  const holdings = (await c.query(`select h.id, i.name, i.type, i.asset_class, h.quantity, h.avg_cost,
      (select close from prices p where p.instrument_id=i.id and p.price_date <= $2 order by p.price_date desc limit 1) px,
      (select price_date from prices p where p.instrument_id=i.id and p.price_date <= $2 order by p.price_date desc limit 1) px_date
      from holdings h join instruments i on i.id=h.instrument_id where h.entity_id=$1 and h.quantity > 0 and i.type in ('stock','etf','mf','bond','gsec','pms','aif')`, [entityId, asOf])).rows;
  const byCode: Record<string, { code: string; market: number; cost: number; holdings: any[] }> = {};
  for (const h of holdings) { const code = codeOf(classOf(h.type, h.asset_class ?? "", h.name)); const qty = Number(h.quantity), cost = r2(qty * Number(h.avg_cost)), market = h.px == null ? cost : r2(qty * Number(h.px)); const x = (byCode[code] ??= { code, market: 0, cost: 0, holdings: [] }); x.market = r2(x.market + market); x.cost = r2(x.cost + cost); x.holdings.push({ holding_id: h.id, instrument: h.name, quantity: qty, cost: money(cost), market: money(market), priced_on: iso(h.px_date), unpriced: h.px == null }); }
  const tb = await trialBalance(c, [entityId], fyOf(asOf), asOf); const bal = (code: string) => Number(tb.find((r) => r.code === code)?.closing ?? 0);
  const rows = Object.values(byCode).map((x) => ({ account_code: x.code, book_balance: money(bal(x.code)), market_value: money(x.market), cost: money(x.cost), adjustment: money(r2(x.market - bal(x.code))), unpriced: x.holdings.filter((h) => h.unpriced).length, holdings: x.holdings })).filter((r) => Number(r.adjustment) !== 0 || Number(r.market_value) !== 0).sort((a, z) => a.account_code.localeCompare(z.account_code));
  const total = r2(rows.reduce((s, r) => s + Number(r.adjustment), 0));
  return { entity_id: entityId, as_of: asOf, treatment: b.mtm_treatment ?? "reserve", enabled: !!b.mark_to_market, rows, total_adjustment: money(total), note: b.mtm_treatment === "pnl" ? "Gains credit 4420 Unrealised gains (MTM), losses debit 5900 Unrealised losses (MTM); the investment accounts move to market." : "The investment accounts move to market against 3400 Unrealised gain/loss reserve (equity); nothing touches income or expense." };
}
export async function postMtm(c: pg.PoolClient, familyId: string, entityId: string, periodId: string, userId: string | null) {
  const p = await period(c, periodId); if (p.entity_id !== entityId) throw new GlError(422, "Period belongs to another entity");
  const existing = (await c.query("select id from gl_journals where entity_id=$1 and source_type='mtm' and source_id=$2 and status='posted'", [entityId, periodId])).rows[0]; if (existing) return { posted: false, already: true, journal: await journalView(c, existing.id) };
  const pv = await mtmPreview(c, familyId, entityId, p.period_end); const lines: any[] = []; let gains = 0, losses = 0;
  for (const r of pv.rows) { const adj = Number(r.adjustment); if (!adj) continue; lines.push({ account_code: r.account_code, debit: adj > 0 ? adj : 0, credit: adj < 0 ? -adj : 0, narration: `MTM ${adj > 0 ? "gain" : "loss"} to ${p.period_end}` }); if (adj > 0) gains = r2(gains + adj); else losses = r2(losses - adj); }
  if (!lines.length) return { posted: false, already: false, journal: null, note: "Nothing to mark: the books already carry the holdings at market." };
  if (pv.treatment === "pnl") { if (gains) lines.push({ account_code: "4420", credit: gains, narration: "Unrealised gains for the period" }); if (losses) lines.push({ account_code: "5900", debit: losses, narration: "Unrealised losses for the period" }); }
  else { const net = r2(gains - losses); lines.push({ account_code: "3400", credit: net > 0 ? net : 0, debit: net < 0 ? -net : 0, narration: "Movement in the unrealised reserve" }); }   // one reserve line: the net movement
  const j = await postJournal(c, familyId, { entityId, entryDate: p.period_end, source: "auto", sourceType: "mtm", sourceId: periodId, narration: `Mark-to-market at ${p.period_end} (${pv.treatment === "pnl" ? "through P&L" : "unrealised reserve"}): ${Number(pv.total_adjustment) >= 0 ? "+" : ""}${Number(pv.total_adjustment).toLocaleString("en-IN")}`, lines, postedBy: userId ?? undefined });
  return { posted: true, already: false, journal: await journalView(c, j.id) };
}

// ---------- depreciation ----------
async function rateFor(c: pg.PoolClient, kind: string, fy: string) { return (await c.query("select method, rate_pct, notes from depreciation_rates where asset_kind=$1 and fy_from <= $2 order by fy_from desc limit 1", [kind, fy])).rows[0] ?? null; }
/** Schedule for the FY: opening WDV (cost less depreciation posted so far), rate from data, full-year charge, and what each period carries
 *  (pro-rata by days; assets acquired in the FY start from their acquisition date; sold or written-off assets stop). */
export async function depreciationSchedule(c: pg.PoolClient, familyId: string, entityId: string, fy: string) {
  const b = await book(c, entityId); const start = fyStart(fy), end = fyEnd(fy);
  const assets: { id: string; kind: string; name: string; cost: number; acquired_on: string; sub_ledger_type: string }[] = [];
  for (const a of (await c.query("select id, kind::text kind, name, cost, acquired_on from lifestyle_assets where entity_id=$1 and deleted_at is null and cost > 0 and acquired_on <= $2 order by acquired_on", [entityId, end])).rows) assets.push({ id: a.id, kind: a.kind, name: a.name, cost: Number(a.cost), acquired_on: iso(a.acquired_on)!, sub_ledger_type: "lifestyle_asset" });
  for (const x of (await c.query("select x.id, coalesce(x.note, x.vendor, x.category::text) description, x.amount, x.expense_date, p.name from property_expenses x join properties p on p.id=x.property_id join property_owners o on o.property_id=p.id where o.entity_id=$1 and x.capital_improvement and x.expense_date <= $2 order by x.expense_date", [entityId, end])).rows) assets.push({ id: x.id, kind: "capital_improvement", name: `${x.name}: ${x.description ?? "improvement"}`, cost: Number(x.amount), acquired_on: iso(x.expense_date)!, sub_ledger_type: "property_expense" });
  // buildings (held at cost): land is never depreciable, so the base excludes land_value; land / under-construction properties are skipped entirely
  for (const pr of (await c.query("select p.id, p.name, p.type::text type, p.acquisition_cost, p.stamp_duty, p.registration, p.land_value, p.acquisition_date from properties p join property_owners o on o.property_id=p.id where o.entity_id=$1 and p.deleted_at is null and p.type in ('residential','commercial') and p.acquisition_date is not null and p.acquisition_date <= $2", [entityId, end])).rows) {
    const depreciableCost = r2(Math.max(0, Number(pr.acquisition_cost) + Number(pr.stamp_duty) + Number(pr.registration) - Number(pr.land_value)));
    if (depreciableCost > 0) assets.push({ id: pr.id, kind: pr.type === "commercial" ? "building_commercial" : "building", name: `Building — ${pr.name}`, cost: depreciableCost, acquired_on: iso(pr.acquisition_date)!, sub_ledger_type: "property" });
  }
  const posted = (await c.query("select l.sub_ledger_id, sum(l.credit - l.debit) dep, max(j.entry_date) last from gl_lines l join gl_journals j on j.id=l.journal_id join gl_accounts a on a.id=l.account_id where j.entity_id=$1 and j.status='posted' and j.source_type='depreciation' and a.code='1340' group by l.sub_ledger_id", [entityId])).rows;
  const postedFy = (await c.query("select l.sub_ledger_id, sum(l.credit - l.debit) dep from gl_lines l join gl_journals j on j.id=l.journal_id join gl_accounts a on a.id=l.account_id where j.entity_id=$1 and j.status='posted' and j.source_type='depreciation' and a.code='1340' and j.fy=$2 group by l.sub_ledger_id", [entityId, fy])).rows;
  const rows = []; for (const a of assets) {
    const rate = await rateFor(c, a.kind, fy); const pct = Number(rate?.rate_pct ?? 0); const method = rate?.method ?? "wdv";
    const accum = Number(posted.find((p) => p.sub_ledger_id === a.id)?.dep ?? 0), thisFy = Number(postedFy.find((p) => p.sub_ledger_id === a.id)?.dep ?? 0); const openingWdv = r2(a.cost - (accum - thisFy));
    const from = a.acquired_on > start ? a.acquired_on : start; const days = Math.max(0, Math.round((new Date(end).getTime() - new Date(from).getTime()) / 86400000) + 1); const yearDays = Math.round((new Date(end).getTime() - new Date(start).getTime()) / 86400000) + 1;
    const base = method === "slm" ? a.cost : openingWdv; const full = pct > 0 ? r2(Math.min(openingWdv, base * pct / 100 * days / yearDays)) : 0;
    rows.push({ asset_id: a.id, sub_ledger_type: a.sub_ledger_type, name: a.name, kind: a.kind, acquired_on: a.acquired_on, cost: money(a.cost), method, rate_pct: pct, opening_wdv: money(openingWdv), depreciable_days: days, charge_for_year: money(full), posted_this_fy: money(thisFy), remaining_for_year: money(r2(full - thisFy)), closing_wdv: money(r2(openingWdv - full)), depreciable: pct > 0, note: rate?.notes ?? "no rate for this kind — add a row to depreciation_rates" });
  }
  return { entity_id: entityId, fy, enabled: !!b.depreciation, rows, total_for_year: money(r2(rows.reduce((s, r) => s + Number(r.charge_for_year), 0))), source: "depreciation_rates (Income-tax Act blocks, WDV) — rates are data, not code" };
}
/** Post the period's share of the year's charge: Dr 5800 Depreciation / Cr 1340 Accumulated depreciation per asset (sub-ledger), pro-rata by the period's days. */
export async function postDepreciation(c: pg.PoolClient, familyId: string, entityId: string, periodId: string, userId: string | null) {
  const p = await period(c, periodId); if (p.entity_id !== entityId) throw new GlError(422, "Period belongs to another entity");
  const existing = (await c.query("select id from gl_journals where entity_id=$1 and source_type='depreciation' and source_id=$2 and status='posted'", [entityId, periodId])).rows[0]; if (existing) return { posted: false, already: true, journal: await journalView(c, existing.id) };
  const s = await depreciationSchedule(c, familyId, entityId, p.fy); const lines: any[] = []; let total = 0;
  const pStart = new Date(p.period_start).getTime(), pEnd = new Date(p.period_end).getTime();
  for (const r of s.rows) { if (!r.depreciable || Number(r.charge_for_year) <= 0) continue;
    const from = Math.max(pStart, new Date(r.acquired_on).getTime()); if (from > pEnd) continue; const days = Math.round((pEnd - from) / 86400000) + 1; const share = r2(Math.min(Number(r.remaining_for_year), Number(r.charge_for_year) * days / r.depreciable_days)); if (share <= 0) continue;
    total = r2(total + share); lines.push({ account_code: "5800", debit: share, narration: r.name, sub_ledger_type: r.sub_ledger_type, sub_ledger_id: r.asset_id }); lines.push({ account_code: "1340", credit: share, narration: r.name, sub_ledger_type: r.sub_ledger_type, sub_ledger_id: r.asset_id }); }
  if (!lines.length) return { posted: false, already: false, journal: null, note: "Nothing to depreciate in this period." };
  const j = await postJournal(c, familyId, { entityId, entryDate: p.period_end, source: "auto", sourceType: "depreciation", sourceId: periodId, narration: `Depreciation ${p.period_start} to ${p.period_end} (WDV, rates from depreciation_rates): ${total.toLocaleString("en-IN")}`, lines, postedBy: userId ?? undefined });
  return { posted: true, already: false, journal: await journalView(c, j.id) };
}
/** Everything a period close carries when the book asks for it. Called when a period leaves `open`; safe to call again. */
export async function periodEndPostings(c: pg.PoolClient, familyId: string, periodId: string, userId: string | null) {
  const p = await period(c, periodId); const b = await book(c, p.entity_id); const out: Record<string, any> = { period_id: periodId, period_end: p.period_end };
  if (b.depreciation) out.depreciation = await postDepreciation(c, familyId, p.entity_id, periodId, userId);
  if (b.mark_to_market) out.mtm = await postMtm(c, familyId, p.entity_id, periodId, userId);   // after depreciation so the trial balance the MTM reads is final
  return out;
}
