/**
 * Balance-sheet completeness and analytics (PRD 3.14, 3.15): loan amortisation and LTV, private-market metrics (DPI / RVPI / TVPI / MOIC /
 * IRR / PME) with a J-curve forecast, exposure by dimension over look-through positions, ownership look-through by ultimate owner,
 * insurance coverage adequacy, fee drag and the month-by-month cash-flow forecast. Pure functions; money is numbers here and strings in JSON.
 */
import { xirr } from "./xirr.js";

const r2 = (n: number) => Math.round(n * 100) / 100;
const addMonthsIso = (d: string, n: number, day?: number) => { const [y, m, dd] = d.split("-").map(Number); const t = new Date(Date.UTC(y, m - 1 + n, 1)); const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate(); t.setUTCDate(Math.min(day ?? dd, last)); return t.toISOString().slice(0, 10); };
const monthKey = (d: string) => d.slice(0, 7);

// ---------- A1 liabilities ----------
export interface AmortiseInput { principal: number; ratePct: number; emi?: number | null; months?: number | null; start: string; emiDay?: number | null; asOf?: string }
export interface ScheduleRow { due_date: string; principal: number; interest: number; emi: number; balance: number }
/** Reducing-balance EMI: emi = P·r·(1+r)^n / ((1+r)^n − 1); with `emi` given the tenure is derived (last instalment sweeps the rounding). */
export function emiFor(principal: number, ratePct: number, months: number): number { const r = ratePct / 1200; if (!months) return principal; if (r === 0) return r2(principal / months); const f = Math.pow(1 + r, months); return r2((principal * r * f) / (f - 1)); }
export function amortise(i: AmortiseInput): ScheduleRow[] {
  const r = i.ratePct / 1200; let months = i.months ?? null; let emi = i.emi ?? null;
  if (!emi && !months) throw new Error("emi or months required"); if (!emi) emi = emiFor(i.principal, i.ratePct, months!);
  if (!months) { months = r === 0 ? Math.ceil(i.principal / emi - 1e-6) : Math.ceil(-Math.log(1 - (i.principal * r) / emi) / Math.log(1 + r) - 1e-4); /* a rounded-down EMI must not add a phantom instalment */ if (!Number.isFinite(months) || months <= 0) throw new Error("EMI does not cover the interest — the loan never amortises"); }
  const rows: ScheduleRow[] = []; let bal = i.principal; const first = addMonthsIso(i.start, 1, i.emiDay ?? undefined);
  for (let k = 0; k < months && bal > 0.005 && k < 600; k++) { const interest = r2(bal * r); let principal = r2(Math.min(bal, emi - interest)); if (k === months - 1 || principal >= bal - 0.005) principal = r2(bal); const pay = r2(principal + interest); bal = r2(bal - principal); rows.push({ due_date: addMonthsIso(first, k, i.emiDay ?? undefined), principal, interest, emi: pay, balance: bal }); }
  return rows;
}
/** Outstanding as of a date from the schedule (principal falling due after the date), and the FY's interest for section 24(b) / 80E. */
export function outstandingAt(rows: ScheduleRow[], asOf: string, original: number): number { const paid = rows.filter((x) => x.due_date <= asOf).reduce((s, x) => s + x.principal, 0); return r2(Math.max(0, original - paid)); }
export function interestBetween(rows: ScheduleRow[], from: string, to: string): number { return r2(rows.filter((x) => x.due_date >= from && x.due_date <= to).reduce((s, x) => s + x.interest, 0)); }
export const ltv = (outstanding: number, securityValue: number | null | undefined) => (securityValue && securityValue > 0 ? r2((outstanding / securityValue) * 100) : null);
/** Match an EMI debit: same amount within tolerance, dated within the window of the due date. */
export function matchEmi(row: { due_date: string; emi: number }, debits: { id: string; txn_date: string; amount: number }[], opts: { tolerancePct?: number; windowDays?: number } = {}) {
  const tol = (opts.tolerancePct ?? 1) / 100, win = opts.windowDays ?? 5; const due = Date.parse(row.due_date);
  return debits.find((d) => Math.abs(Math.abs(d.amount) - row.emi) <= row.emi * tol && Math.abs(Date.parse(d.txn_date) - due) <= win * 86400000) ?? null;
}

// ---------- C7 private markets ----------
export interface FundFlow { date: string; kind: "call" | "distribution" | "recallable" | "fee" | "nav"; amount: number }
export interface PrivateMetrics { paid_in: number; distributed: number; nav: number; dpi: number | null; rvpi: number | null; tvpi: number | null; moic: number | null; irr_pct: number | null; pme: number | null; flows: number }
/** DPI = distributions / paid-in; RVPI = NAV / paid-in; TVPI = DPI + RVPI; MOIC = (distributions + NAV) / paid-in; IRR over calls (−) distributions (+) and the NAV as a terminal flow;
 *  PME (Kaplan–Schoar): PV of distributions + NAV over PV of calls, each discounted with the benchmark's return to the as-of date. */
export function privateMetrics(flows: FundFlow[], nav: number, asOf: string, benchmark: { date: string; value: number }[] = []): PrivateMetrics {
  const calls = flows.filter((f) => f.kind === "call" || f.kind === "fee"); const dists = flows.filter((f) => f.kind === "distribution" || f.kind === "recallable");
  const paidIn = r2(calls.reduce((s, f) => s + f.amount, 0)); const distributed = r2(dists.reduce((s, f) => s + f.amount, 0));
  const dpi = paidIn ? r2(distributed / paidIn * 100) / 100 : null, rvpi = paidIn ? r2(nav / paidIn * 100) / 100 : null;
  const cash = [...calls.map((f) => ({ date: f.date, amount: -f.amount })), ...dists.map((f) => ({ date: f.date, amount: f.amount })), ...(nav > 0 ? [{ date: asOf, amount: nav }] : [])].sort((a, b) => a.date.localeCompare(b.date));
  let irr: number | null = null; try { if (cash.some((c) => c.amount < 0) && cash.some((c) => c.amount > 0)) { const v = xirr(cash.map((c) => ({ date: new Date(c.date + "T00:00:00Z"), amount: c.amount }))); irr = v == null || !Number.isFinite(v) ? null : r2(v * 100); } } catch { irr = null; }
  let pme: number | null = null;
  if (benchmark.length >= 2 && paidIn) { const at = (d: string) => { const sorted = [...benchmark].sort((a, b) => a.date.localeCompare(b.date)); let v = sorted[0].value; for (const b of sorted) { if (b.date <= d) v = b.value; else break; } return v; }; const end = at(asOf); const pv = (f: { date: string; amount: number }) => f.amount * (end / at(f.date)); const pvCalls = calls.reduce((s, f) => s + pv({ date: f.date, amount: f.amount }), 0); const pvDist = dists.reduce((s, f) => s + pv({ date: f.date, amount: f.amount }), 0) + nav; pme = pvCalls ? r2(pvDist / pvCalls * 100) / 100 : null; }
  return { paid_in: paidIn, distributed, nav: r2(nav), dpi, rvpi, tvpi: dpi != null && rvpi != null ? r2((dpi + rvpi) * 100) / 100 : null, moic: paidIn ? r2((distributed + nav) / paidIn * 100) / 100 : null, irr_pct: irr, pme, flows: flows.length };
}
/** J-curve forecast: remaining commitment called on the schedule (or evenly over `callMonths`), distributions from `expectedMultiple` × paid-in spread over the harvest window after the investment period. */
export function forecastFundFlows(i: { commitment: number; drawn: number; schedule?: { due: string; amount: number }[]; asOf: string; callMonths?: number; investmentYears?: number; harvestYears?: number; expectedMultiple?: number; months?: number }): { month: string; calls: number; distributions: number }[] {
  const months = i.months ?? 36; const out = new Map<string, { calls: number; distributions: number }>(); const key = (m: number) => monthKey(addMonthsIso(i.asOf.slice(0, 7) + "-01", m));
  for (let m = 0; m < months; m++) out.set(key(m), { calls: 0, distributions: 0 });
  const remaining = Math.max(0, i.commitment - i.drawn); const sched = (i.schedule ?? []).filter((s) => s.due >= i.asOf);
  if (sched.length) { for (const s of sched) { const k = monthKey(s.due); if (out.has(k)) out.get(k)!.calls += s.amount; } } else if (remaining > 0) { const n = i.callMonths ?? 18; for (let m = 1; m <= n && m < months; m++) out.get(key(m))!.calls += remaining / n; }
  const total = i.commitment * (i.expectedMultiple ?? 1.8); const startM = Math.round((i.investmentYears ?? 4) * 12), endM = startM + Math.round((i.harvestYears ?? 4) * 12);
  for (let m = startM; m < endM && m < months; m++) out.get(key(m))!.distributions += total / (endM - startM);
  return [...out.entries()].map(([month, v]) => ({ month, calls: r2(v.calls), distributions: r2(v.distributions) }));
}

// ---------- C3 exposure ----------
export type Dimension = "asset_class" | "sector" | "market_cap" | "geography" | "currency" | "issuer" | "rating" | "duration" | "manager" | "liquidity";
export interface ExposurePosition { name: string; value: number; asset_class?: string | null; alloc_class?: string | null; sector?: string | null; market_cap_band?: string | null; country?: string | null; currency?: string | null; issuer?: string | null; credit_rating?: string | null; modified_duration?: number | null; manager?: string | null; liquidity_class?: string | null; lookthrough?: { alloc_class?: string; country?: string; sector?: string; pct: number }[] | null }
const durationBand = (d?: number | null) => (d == null ? "unclassified" : d < 1 ? "< 1 y" : d < 3 ? "1–3 y" : d < 7 ? "3–7 y" : "> 7 y");
const capBand = (b?: string | null) => (b ? b : "unclassified");
/** Group positions by a dimension; funds with a look-through table split into their underlying rows; what cannot be classified is shown explicitly (never dropped) so the view always sums to 100%. */
export function exposure(positions: ExposurePosition[], by: Dimension): { key: string; value: number; pct: number; positions: number }[] {
  const acc = new Map<string, { value: number; n: number }>(); const total = positions.reduce((s, p) => s + p.value, 0);
  const add = (k: string, v: number) => { const e = acc.get(k) ?? { value: 0, n: 0 }; e.value += v; e.n += 1; acc.set(k, e); };
  const keyOf = (p: ExposurePosition, lt?: { alloc_class?: string; country?: string; sector?: string }) => {
    switch (by) {
      case "asset_class": return lt?.alloc_class ?? p.alloc_class ?? p.asset_class ?? "unclassified";
      case "sector": return lt?.sector ?? p.sector ?? (["cash", "debt", "gold", "real_estate"].includes(String(p.alloc_class)) ? p.alloc_class! : "unclassified");
      case "market_cap": return p.alloc_class && !["equity", "equity_intl", "international_equity"].includes(String(p.alloc_class)) && !p.market_cap_band ? "n/a (non-equity)" : capBand(p.market_cap_band);
      case "geography": return lt?.country ?? p.country ?? "IN";
      case "currency": return p.currency ?? "INR";
      case "issuer": return p.issuer ?? p.manager ?? p.name;
      case "rating": return p.credit_rating ?? (p.alloc_class === "debt" || /debt|bond|liquid|credit/i.test(String(p.asset_class)) ? "unrated" : "n/a (non-debt)");
      case "duration": return p.alloc_class === "debt" || /debt|bond|liquid|credit/i.test(String(p.asset_class)) ? durationBand(p.modified_duration) : "n/a (non-debt)";
      case "manager": return p.manager ?? "direct";
      case "liquidity": return p.liquidity_class ?? "unclassified";
    }
  };
  for (const p of positions) { if (p.lookthrough?.length && (by === "asset_class" || by === "geography" || by === "sector")) { let used = 0; for (const lt of p.lookthrough) { add(keyOf(p, lt), (p.value * lt.pct) / 100); used += lt.pct; } if (used < 99.9) add(keyOf(p), (p.value * (100 - used)) / 100); } else add(keyOf(p), p.value); }
  return [...acc.entries()].map(([key, e]) => ({ key, value: r2(e.value), pct: total ? r2((e.value / total) * 100) : 0, positions: e.n })).sort((a, b) => b.value - a.value);
}

// ---------- B1 ownership look-through ----------
export interface OwnershipEdge { owner_entity_id: string; owned_type: string; owned_id: string; pct: number; effective_from?: string; effective_to?: string | null }
/** Ultimate individual owners of an asset: follow entity → entity edges (e.g. trust 100% → LLP 60% → property) multiplying percentages; entities without an upstream owner are ultimate owners of what they hold. Returns {entity_id: pct}. */
export function ultimateOwners(edges: OwnershipEdge[], ownedType: string, ownedId: string, asOf: string, opts: { individuals?: Set<string>; maxDepth?: number } = {}): Record<string, number> {
  const live = edges.filter((e) => (!e.effective_from || e.effective_from <= asOf) && (!e.effective_to || e.effective_to > asOf));
  const out: Record<string, number> = {};
  const walk = (type: string, id: string, share: number, depth: number, seen: Set<string>) => {
    const owners = live.filter((e) => e.owned_type === type && e.owned_id === id); if (!owners.length || depth > (opts.maxDepth ?? 8)) { if (type === "entity") out[id] = (out[id] ?? 0) + share; return; }
    let covered = 0; for (const o of owners) { covered += o.pct; if (seen.has(o.owner_entity_id)) continue; const s = share * (o.pct / 100); if (opts.individuals && opts.individuals.has(o.owner_entity_id)) out[o.owner_entity_id] = (out[o.owner_entity_id] ?? 0) + s; else walk("entity", o.owner_entity_id, s, depth + 1, new Set([...seen, o.owner_entity_id])); }
    if (type === "entity" && covered < 99.9) out[id] = (out[id] ?? 0) + share * ((100 - covered) / 100);   // the unowned remainder stays with the entity itself
  };
  walk(ownedType, ownedId, 100, 0, new Set()); for (const k of Object.keys(out)) out[k] = r2(out[k]); return out;
}

// ---------- A2 insurance adequacy ----------
export interface Cover { kind: string; sum_assured: number; life_assured?: string | null; covers_type?: string | null; covers_id?: string | null; entity_id?: string | null; status?: string }
export function lifeCoverAdequacy(covers: Cover[], liabilities: number, goalsNeed: number, annualExpenses = 0, yearsOfIncome = 10) {
  const life = covers.filter((c) => c.status !== "lapsed" && ["term_life", "endowment", "ulip"].includes(c.kind)).reduce((s, c) => s + c.sum_assured, 0);
  const need = r2(liabilities + goalsNeed + annualExpenses * yearsOfIncome); return { life_cover: r2(life), need, gap: r2(Math.max(0, need - life)), adequacy_pct: need ? r2((life / need) * 100) : null };
}

// ---------- C8 fees ----------
/** Implied TER for the period: average value × expense ratio × days / 365. */
export const impliedTer = (avgValue: number, expenseRatioPct: number, days: number) => r2((avgValue * expenseRatioPct) / 100 * (days / 365));
export const feeDrag = (fees: number, aum: number, returnPct: number | null) => ({ pct_of_aum: aum ? r2((fees / aum) * 100) : null, drag_share_of_return_pct: returnPct && aum ? r2(((fees / aum) * 100) / returnPct * 100) : null });

// ---------- D3 cash-flow forecast ----------
export interface ForecastItem { month: string; kind: string; amount: number; entity_id?: string | null; source_type?: string | null; source_id?: string | null }
/** Fold dated items into months with running cash and the float threshold; inflows positive, outflows negative. */
export function foldForecast(items: ForecastItem[], opening: number, floatRequired: number, months: string[]) {
  let cash = opening; return months.map((m) => { const rows = items.filter((i) => i.month === m); const inflows = rows.filter((r) => r.amount > 0).reduce((s, r) => s + r.amount, 0), outflows = rows.filter((r) => r.amount < 0).reduce((s, r) => s - r.amount, 0); cash = r2(cash + inflows - outflows); const by: Record<string, number> = {}; for (const r of rows) by[r.kind] = r2((by[r.kind] ?? 0) + r.amount); return { month: m, inflows: r2(inflows), outflows: r2(outflows), net: r2(inflows - outflows), cumulative_cash: cash, below_float: cash < floatRequired, float_required: floatRequired, by_kind: by }; });
}
export const monthsFrom = (start: string, n: number) => Array.from({ length: n }, (_, k) => monthKey(addMonthsIso(start.slice(0, 7) + "-01", k)));
/** Next premium dates from a frequency, up to the horizon. */
export function premiumDates(nextDue: string, frequency: string, until: string): string[] { const step = frequency === "monthly" ? 1 : frequency === "quarterly" ? 3 : frequency === "half_yearly" ? 6 : frequency === "single" ? 0 : 12; const out: string[] = []; let d = nextDue; while (d <= until && out.length < 60) { out.push(d); if (!step) break; d = addMonthsIso(d, step); } return out; }
export { addMonthsIso };
