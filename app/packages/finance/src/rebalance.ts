// Rebalancing & liquidity-timing engine (FO-160..165): triggers, lot constraints, and the deterministic solver that turns
// allocation clauses and dated cash needs into timed, tax-aware moves. Pure functions; the API builds the snapshot and persists plans.
import type { TaxRule } from "./capitalGains.js";
import type { AllocClass } from "./policy.js";

export type Objective = "back_to_target" | "to_band_edge" | "fund_needs_only" | "needs_plus_bands" | "glide_step";
export type TriggerKind = "calendar" | "band_breach" | "drift_threshold" | "milestone" | "funding_need" | "glide_step" | "large_flow" | "tax_year_end" | "policy_change" | "manual";
export interface RbLot { id: string; buyDate: string; qty: number; unitCost: number; lockInUntil?: string | null; exitLoadUntil?: string | null; exitLoadPct?: number | null; ltcgEligibleOn?: string | null; settlementDays: number }
export interface RbHolding { id: string; entityId: string; instrumentId: string; name: string; allocClass: AllocClass; bucket: string; price: number; assetClass: string; instrumentType: string; lots: RbLot[]; maturesOn?: string | null; liquidityClass?: string | null }
export interface RbCash { accountId: string; entityId: string; balance: number }
export interface RbNeed { id: string; label: string; date: string; amount: number; priority: 1 | 2 | 3; flexibilityDays: number; entityId: string; fundedAmount: number; bankAccountId?: string | null }
export interface RbTarget { key: AllocClass; target: number; min?: number | null; max?: number | null }
export interface RbSnapshot {
  asOf: string; holdings: RbHolding[]; cash: RbCash[]; floatRequired: number; needs: RbNeed[]; targets: RbTarget[]; glideGrowthPct?: number | null;
  contributions: { label: string; monthly: number; allocClass: AllocClass; instrumentId?: string | null; entityId: string }[];
  rules: TaxRule[]; slabRate: Record<string, number>; exemptionRemaining: Record<string, number>; fyEnd: string;
  buyInstrument: Partial<Record<AllocClass, { id: string; name: string; settlementDays: number }>>;
}
export interface RbConstraints { min_trade: number; max_turnover_pct: number; avoid_exit_load: boolean; respect_lock_in: boolean; prefer_new_cash: boolean; tax_aware: boolean; ltcg_wait_days: number; max_tax_cost?: number | null; settlement_buffer_days: number }
export const DEFAULT_CONSTRAINTS: RbConstraints = { min_trade: 2000, max_turnover_pct: 15, avoid_exit_load: true, respect_lock_in: true, prefer_new_cash: true, tax_aware: true, ltcg_wait_days: 45, max_tax_cost: null, settlement_buffer_days: 2 };
export interface RbMove { seq: number; kind: "sell" | "buy" | "switch" | "redeem" | "transfer_cash" | "hold_cash" | "sip_change"; entityId: string; fromHoldingId?: string | null; fromLotIds?: string[]; toInstrumentId?: string | null; toAllocClass?: AllocClass | null; toBankAccountId?: string | null; quantity?: number | null; amount: number; plannedDate: string; earliestDate: string; latestDate: string | null; settlesOn: string; reason: string; needId?: string | null; estGain: number; estTax: number; estCost: number; exitLoad: number; constraintsChecked: string[]; dependsOnSeq?: number | null; what: string }
export interface Coverage { needId: string; sources: { kind: "cash" | "move" | "maturity"; ref: string; amount: number; availableOn: string }[]; covered: number; shortfall: number }
export interface RbPlan { objective: Objective; moves: RbMove[]; allocationAfter: (RbTarget & { actual_pct: number; before_pct: number; status: "in_band" | "warning" | "breach" })[]; summary: { turnover: number; turnover_pct: number; est_tax: number; est_costs: number; exit_loads_avoided: number; needs_covered: number; needs_uncovered: number; drift_after_max_pp: number; drift_before_max_pp: number; total: number; idle_cash: number }; warnings: string[]; coverage: Coverage[]; cashTimeline: { date: string; event: string; delta: number; balance: number }[] }

const r2 = (n: number) => Math.round(n * 100) / 100 + 0;
const UNTRADEABLE = new Set(["alternatives", "real_estate"]); // private rounds and property are commitments, not orders
export const addDays = (d: string, n: number) => new Date(Date.parse(d + "T00:00:00Z") + n * 86400000).toISOString().slice(0, 10);
export const addMonths = (d: string, m: number) => { const x = new Date(d + "T00:00:00Z"); const day = x.getUTCDate(); x.setUTCDate(1); x.setUTCMonth(x.getUTCMonth() + m); const last = new Date(Date.UTC(x.getUTCFullYear(), x.getUTCMonth() + 1, 0)).getUTCDate(); x.setUTCDate(Math.min(day, last)); return x.toISOString().slice(0, 10); };
const daysBetween = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
const maxDate = (...ds: (string | null | undefined)[]) => ds.filter(Boolean).sort().pop() ?? null;
const inr = (n: number) => `₹${Math.round(n).toLocaleString("en-IN")}`;
const value = (h: RbHolding) => h.lots.reduce((s, l) => s + l.qty, 0) * h.price;

// ---------- calendar (RRULE subset: FREQ=MONTHLY|YEARLY, INTERVAL, BYMONTH, BYMONTHDAY) ----------
export function nextCalendarRun(rrule: string | null | undefined, after: string): string | null {
  if (!rrule) return null;
  const p = Object.fromEntries(rrule.split(";").map((x) => x.split("=") as [string, string]));
  const freq = p.FREQ ?? "MONTHLY", interval = Math.max(1, Number(p.INTERVAL ?? 1)), byDay = Number(p.BYMONTHDAY ?? 1);
  const byMonth = p.BYMONTH ? p.BYMONTH.split(",").map(Number) : freq === "YEARLY" ? [4] : null; // yearly defaults to the FY start
  const start = new Date(after + "T00:00:00Z"); const y = start.getUTCFullYear(), m = start.getUTCMonth();
  for (let i = 0; i < 48; i++) {
    const mm = (m + i) % 12, yy = y + Math.floor((m + i) / 12);
    if (byMonth && !byMonth.includes(mm + 1)) continue;
    if (!byMonth && interval > 1 && mm % interval !== 0) continue; // e.g. INTERVAL=3 → calendar quarters
    const last = new Date(Date.UTC(yy, mm + 1, 0)).getUTCDate(); const d = new Date(Date.UTC(yy, mm, Math.min(byDay, last))).toISOString().slice(0, 10);
    if (d > after) return d;
  }
  return null;
}

// ---------- lot constraints (FO-162) ----------
export interface LotConstraintInput { buyDate: string; instrumentType: string; assetClass: string; name?: string | null; meta?: Record<string, any> | null; liquidityClass?: string | null }
export interface LotConstraint { lock_in_until: string | null; exit_load_until: string | null; exit_load_pct: number | null; ltcg_eligible_on: string | null; settlement_days: number; liquidity_class: string; matures_on: string | null }
/** Lock-ins by product law (ELSS 3y, SGB 5y early-exit window, PPF 15y, AIF close-ended), exit loads from the scheme master (default 1% for 365 days on
 *  equity-oriented funds), LTCG eligibility from tax_rules, settlement by instrument type. `meta` on the instrument overrides every default. */
export function lotConstraintsFor(l: LotConstraintInput, rules: TaxRule[], today: string): LotConstraint {
  const t = l.instrumentType, a = l.assetClass, meta = l.meta ?? {}, name = (l.name ?? "").toLowerCase(); const eqFund = t === "mf" && (a === "equity" || a.includes("arbitrage") || a.includes("gold") || a.includes("intl"));
  const isElss = !!meta.elss || /\belss\b|tax ?saver|tax ?saving/.test(name); const isLiquid = /\b(liquid|overnight|money market|ultra short)\b/.test(name) || meta.sub_class === "liquid";
  const lock = meta.lock_in_until ?? (isElss ? addMonths(l.buyDate, 36) : t === "ppf" ? addMonths(l.buyDate, 180) : t === "sgb" ? addMonths(l.buyDate, 60) : t === "aif" ? addMonths(l.buyDate, 36) : t === "fd" || t === "rd" ? (meta.maturity_date ?? null) : null);
  const exitLoad = meta.exit_load ? { pct: Number(meta.exit_load.pct ?? 1), days: Number(meta.exit_load.days ?? 365) } : eqFund && !isLiquid ? { pct: 1, days: 365 } : t === "pms" ? { pct: 1, days: 365 } : null;
  const longRule = rules.find((r) => r.assetClass === a && r.term === "long");
  const ltcg = longRule && longRule.holdingMonthsForLong < 999 ? addMonths(l.buyDate, longRule.holdingMonthsForLong) : null;
  const settlement = meta.settlement_days ?? (t === "stock" || t === "etf" || t === "bond" || t === "gsec" || t === "tbill" ? 1 : t === "mf" ? (isLiquid || a.startsWith("debt") ? 1 : 3) : t === "pms" ? 7 : t === "aif" ? 90 : 0);
  const exitUntil = exitLoad ? addDays(l.buyDate, exitLoad.days) : null;
  const liquidity = l.liquidityClass ?? (lock && lock > today ? "locked" : t === "aif" ? "quarterly" : t === "pms" ? "quarterly" : settlement <= 1 ? "t1" : "t3");
  return { lock_in_until: lock, exit_load_until: exitUntil && exitUntil > today ? exitUntil : exitUntil, exit_load_pct: exitLoad?.pct ?? null, ltcg_eligible_on: ltcg, settlement_days: settlement, liquidity_class: liquidity, matures_on: meta.maturity_date ?? null };
}

// ---------- triggers (FO-160) ----------
export interface ProgramLike { calendar_rrule?: string | null; band_trigger: boolean; drift_threshold_pp?: number | null; milestone_triggers: { kind: string; value?: any }[]; need_lookahead_days: number; large_flow_pct?: number | null; tax_year_end: boolean }
export interface TriggerCtx { today: string; lastRunAt?: string | null; lastTaxYearEndRunFy?: string | null; goal?: { targetYear: number; fundedPct: number | null; glideStepYears?: number[] } | null; flowPct?: number | null; policyChangedAt?: string | null; netWorth?: number | null; age?: number | null; lifeEvents?: string[]; firedMilestones?: string[] }
export interface Fired { kind: TriggerKind; detail: Record<string, any>; objective: Objective }
export const fyOfDate = (d: string) => { const y = Number(d.slice(0, 4)), m = Number(d.slice(5, 7)); const fy = m >= 4 ? y : y - 1; return `${fy}-${String(fy + 1).slice(-2)}`; };
export function evaluateTriggers(p: ProgramLike, snap: Pick<RbSnapshot, "asOf" | "holdings" | "cash" | "floatRequired" | "needs" | "targets">, ctx: TriggerCtx): Fired[] {
  const out: Fired[] = []; const alloc = allocation(snap);
  const inWindow = snap.needs.filter((n) => n.date <= addDays(ctx.today, p.need_lookahead_days) && n.date >= ctx.today);
  const idle = Math.max(0, snap.cash.reduce((s, c) => s + c.balance, 0) - snap.floatRequired); let cover = idle;
  const unmet = inWindow.filter((n) => { const short = n.amount - n.fundedAmount; const c = Math.min(cover, short); cover -= c; return short - c > 0.5; });
  if (unmet.length) out.push({ kind: "funding_need", detail: { needs: unmet.map((n) => ({ id: n.id, label: n.label, date: n.date, shortfall: r2(n.amount - n.fundedAmount) })), idle_cash: r2(idle) }, objective: "needs_plus_bands" });
  const breached = p.band_trigger ? alloc.filter((a) => (a.min != null && a.actual_pct < a.min) || (a.max != null && a.actual_pct > a.max)) : [];
  if (breached.length) out.push({ kind: "band_breach", detail: { bands: breached.map((b) => ({ key: b.key, actual: b.actual_pct, min: b.min, max: b.max })) }, objective: "needs_plus_bands" });
  for (const m of p.milestone_triggers ?? []) {
    const key = `${m.kind}:${m.value ?? ""}`; if ((ctx.firedMilestones ?? []).includes(key)) continue;
    const yearsToGo = ctx.goal ? ctx.goal.targetYear - Number(ctx.today.slice(0, 4)) : null;
    if (m.kind === "goal_years_to_go" && yearsToGo != null && yearsToGo <= Number(m.value)) out.push({ kind: "milestone", detail: { milestone: key, years_to_go: yearsToGo }, objective: "glide_step" });
    if (m.kind === "goal_funded_pct" && ctx.goal?.fundedPct != null && ctx.goal.fundedPct >= Number(m.value)) out.push({ kind: "milestone", detail: { milestone: key, funded_pct: ctx.goal.fundedPct }, objective: "to_band_edge" });
    if (m.kind === "glide_step" && ctx.goal?.glideStepYears?.includes(Number(ctx.today.slice(0, 4)))) out.push({ kind: "glide_step", detail: { milestone: key, year: Number(ctx.today.slice(0, 4)) }, objective: "glide_step" });
    if (m.kind === "life_event" && (ctx.lifeEvents ?? []).includes(String(m.value))) out.push({ kind: "milestone", detail: { milestone: key }, objective: "back_to_target" });
    if (m.kind === "net_worth_crosses" && ctx.netWorth != null && ctx.netWorth >= Number(m.value)) out.push({ kind: "milestone", detail: { milestone: key, net_worth: ctx.netWorth }, objective: "back_to_target" });
    if (m.kind === "age" && ctx.age != null && ctx.age >= Number(m.value)) out.push({ kind: "milestone", detail: { milestone: key, age: ctx.age }, objective: "glide_step" });
  }
  if (ctx.policyChangedAt && (!ctx.lastRunAt || ctx.policyChangedAt > ctx.lastRunAt)) out.push({ kind: "policy_change", detail: { policy_changed_at: ctx.policyChangedAt }, objective: "back_to_target" });
  const month = Number(ctx.today.slice(5, 7));
  if (p.tax_year_end && (month === 2 || month === 3) && ctx.lastTaxYearEndRunFy !== fyOfDate(ctx.today)) out.push({ kind: "tax_year_end", detail: { fy: fyOfDate(ctx.today) }, objective: "needs_plus_bands" });
  if (ctx.flowPct != null && p.large_flow_pct != null && Math.abs(ctx.flowPct) >= Number(p.large_flow_pct)) out.push({ kind: "large_flow", detail: { flow_pct: r2(ctx.flowPct) }, objective: "back_to_target" });
  const drift = alloc.reduce((s, a) => s + Math.abs(a.actual_pct - a.target), 0);
  if (p.drift_threshold_pp != null && drift > Number(p.drift_threshold_pp)) out.push({ kind: "drift_threshold", detail: { drift_pp: r2(drift), threshold: p.drift_threshold_pp }, objective: "back_to_target" });
  const next = nextCalendarRun(p.calendar_rrule, ctx.lastRunAt ? ctx.lastRunAt.slice(0, 10) : addDays(ctx.today, -1));
  if (next && next <= ctx.today) out.push({ kind: "calendar", detail: { scheduled_for: next }, objective: "to_band_edge" });
  return out;
}

// ---------- allocation ----------
export function allocation(snap: Pick<RbSnapshot, "holdings" | "cash" | "targets">, adj: Partial<Record<string, number>> = {}, totalAdj = 0) {
  const byClass: Record<string, number> = {}; for (const h of snap.holdings) byClass[h.allocClass] = (byClass[h.allocClass] ?? 0) + value(h);
  byClass.cash = (byClass.cash ?? 0) + snap.cash.reduce((s, c) => s + c.balance, 0);
  for (const [k, v] of Object.entries(adj)) byClass[k] = (byClass[k] ?? 0) + (v ?? 0);
  const total = Object.values(byClass).reduce((s, v) => s + v, 0) + totalAdj;
  const keys = new Set([...snap.targets.map((t) => t.key), ...Object.keys(byClass)]);
  return [...keys].map((k) => { const t = snap.targets.find((x) => x.key === k); const pct = total ? r2((byClass[k] ?? 0) / total * 100) : 0; const min = t?.min ?? null, max = t?.max ?? null; const miss = min != null && pct < min ? min - pct : max != null && pct > max ? pct - max : 0;
    return { key: k as AllocClass, target: t?.target ?? 0, min, max, actual_pct: pct, value: r2(byClass[k] ?? 0), status: (miss === 0 ? "in_band" : miss <= 1 ? "warning" : "breach") as "in_band" | "warning" | "breach", total: r2(total) }; });
}

// ---------- solver (FO-163) ----------
interface Ctx { snap: RbSnapshot; c: RbConstraints; usedLotQty: Map<string, number>; exemption: Record<string, number>; seq: number; moves: RbMove[]; warnings: string[]; exitLoadsAvoided: number }
const remainingQty = (ctx: Ctx, l: RbLot) => l.qty - (ctx.usedLotQty.get(l.id) ?? 0);
function ruleFor(rules: TaxRule[], assetClass: string, term: "short" | "long") { return rules.find((r) => r.assetClass === assetClass && r.term === term) ?? null; }
/** Tax on selling `qty` of a lot on `date`; consumes the entity's long-term exemption when `commit`. */
function taxFor(ctx: Ctx, h: RbHolding, l: RbLot, qty: number, date: string, commit: boolean) {
  const gain = r2(qty * (h.price - l.unitCost)); const long = !!l.ltcgEligibleOn && l.ltcgEligibleOn <= date; const rule = ruleFor(ctx.snap.rules, h.assetClass, long ? "long" : "short");
  if (!rule || gain <= 0) return { gain, tax: 0, term: long ? "long" : "short", exempted: 0 };
  let taxable = gain, exempted = 0;
  if (long && rule.exemptionAmount > 0) { const rem = ctx.exemption[h.entityId] ?? rule.exemptionAmount; exempted = Math.min(rem, gain); taxable = gain - exempted; if (commit) ctx.exemption[h.entityId] = rem - exempted; }
  const rate = rule.taxedAtSlab ? (ctx.snap.slabRate[h.entityId] ?? 30) : rule.rate;
  return { gain, tax: r2(taxable * rate / 100), term: long ? "long" : "short", exempted: r2(exempted) };
}
interface Candidate { h: RbHolding; l: RbLot; qty: number; earliest: string; deadline: string | null; notes: string[]; unitTax: number; unitGain: number; exitLoadPct: number }
/** Sell candidates from the given classes for a sale that must settle by `latest` (null = no deadline): loss lots first, then long-term within exemption, then highest cost. */
function candidates(ctx: Ctx, classes: AllocClass[], latest: string | null, entityId?: string | null): Candidate[] {
  const out: Candidate[] = []; const { c, snap } = ctx;
  for (const h of snap.holdings) {
    if (!classes.includes(h.allocClass) || (entityId && h.entityId !== entityId) || h.allocClass === "cash") continue;
    for (const l of h.lots) {
      const qty = remainingQty(ctx, l); if (qty <= 0) continue;
      const notes: string[] = []; let earliest = snap.asOf; let exitLoadPct = 0;
      if (l.lockInUntil && l.lockInUntil > snap.asOf) { if (c.respect_lock_in) { notes.push(`lock-in until ${l.lockInUntil} — never sold`); continue; } }
      if (l.exitLoadUntil && l.exitLoadUntil > snap.asOf) {
        if (c.avoid_exit_load) { const after = addDays(l.exitLoadUntil, 1); if (latest && after > latest) { ctx.exitLoadsAvoided++; notes.push(`exit load ${l.exitLoadPct ?? 1}% until ${l.exitLoadUntil} — cannot wait for this need, skipped`); continue; } earliest = maxDate(earliest, after)!; notes.push(`exit load ${l.exitLoadPct ?? 1}% until ${l.exitLoadUntil} → wait`); ctx.exitLoadsAvoided++; }
        else { exitLoadPct = Number(l.exitLoadPct ?? 1); notes.push(`exit load ${exitLoadPct}% paid`); }
      }
      const deadline = latest ? addDays(latest, -l.settlementDays) : null; // last planned date that still settles in time
      if (l.ltcgEligibleOn && l.ltcgEligibleOn > earliest && c.tax_aware) {
        const wait = daysBetween(earliest, l.ltcgEligibleOn);
        if (wait <= c.ltcg_wait_days && (!deadline || l.ltcgEligibleOn <= deadline)) { earliest = l.ltcgEligibleOn; notes.push(`LTCG eligible ${l.ltcgEligibleOn} — waiting ${wait} d`); }
        else notes.push(`LTCG eligible ${l.ltcgEligibleOn} — short-term if sold now`);
      } else if (l.ltcgEligibleOn) notes.push(`LTCG-eligible since ${l.ltcgEligibleOn}`);
      if (deadline && earliest > deadline) { notes.push(`earliest ${earliest} after the latest feasible date ${deadline} (T+${l.settlementDays}) — skipped`); continue; }
      const probe = taxFor(ctx, h, l, 1, earliest, false);
      out.push({ h, l, qty, earliest, deadline, notes, unitTax: probe.tax + h.price * exitLoadPct / 100, unitGain: h.price - l.unitCost, exitLoadPct });
    }
  }
  // loss lots first, then cheapest tax per rupee, then highest cost basis, then oldest
  return out.sort((a, b) => (a.unitGain < 0 ? -1 : 0) - (b.unitGain < 0 ? -1 : 0) || a.unitTax / a.h.price - b.unitTax / b.h.price || b.l.unitCost / b.h.price - a.l.unitCost / a.h.price || a.l.buyDate.localeCompare(b.l.buyDate));
}
function sellFrom(ctx: Ctx, cands: Candidate[], amount: number, reasonIn: string | ((k: Candidate) => string), need: RbNeed | null, latest: string | null): { moves: RbMove[]; raised: number } {
  const moves: RbMove[] = []; let left = amount;
  for (const k of cands) {
    const reason = typeof reasonIn === "function" ? reasonIn(k) : reasonIn;
    if (left < 1) break;
    const maxAmt = k.qty * k.h.price; const whole = ["stock", "etf", "bond", "sgb", "gsec"].includes(k.h.instrumentType); // listed units are indivisible
    const qty = whole ? Math.min(k.qty, Math.ceil(Math.min(left, maxAmt) / k.h.price)) : r2(Math.min(left, maxAmt) / k.h.price * 10000) / 10000; const amt = r2(qty * k.h.price);
    if (amt < ctx.c.min_trade && amt < left) continue; // too small unless it finishes the job
    const planned = need ? k.deadline! : k.earliest; const settles = addDays(planned, k.l.settlementDays);
    const t = taxFor(ctx, k.h, k.l, qty, planned, true); const exitLoad = r2(amt * k.exitLoadPct / 100); const cost = r2(amt * 0.001);
    const checks = [...k.notes, need ? `settles ${settles} ≤ need ${need.date}${need.flexibilityDays ? ` (+${need.flexibilityDays} d)` : ""} − ${ctx.c.settlement_buffer_days} d buffer ✓` : `earliest ${k.earliest}`, t.exempted ? `LTCG ${inr(t.gain)} — ${inr(t.exempted)} within exemption → tax ${inr(t.tax)}` : t.gain > 0 ? `${t.term === "long" ? "LTCG" : "STCG"} ${inr(t.gain)} → tax ${inr(t.tax)}` : t.gain < 0 ? `loss ${inr(-t.gain)} booked` : "no gain"];
    const existing = moves.find((m) => m.fromHoldingId === k.h.id && m.plannedDate === planned);
    ctx.usedLotQty.set(k.l.id, (ctx.usedLotQty.get(k.l.id) ?? 0) + qty);
    if (existing) { existing.amount = r2(existing.amount + amt); existing.quantity = r2((existing.quantity ?? 0) + qty); existing.fromLotIds!.push(k.l.id); existing.estGain = r2(existing.estGain + t.gain); existing.estTax = r2(existing.estTax + t.tax); existing.estCost = r2(existing.estCost + cost); existing.exitLoad = r2(existing.exitLoad + exitLoad); existing.constraintsChecked.push(...checks.map((x) => `lot ${k.l.buyDate}: ${x}`)); existing.what = `${k.h.instrumentType === "mf" ? "Redeem" : "Sell"} ${existing.quantity} ${k.h.instrumentType === "mf" ? "u" : "×"} ${k.h.name}`; }
    else moves.push({ seq: ++ctx.seq, kind: k.h.instrumentType === "mf" ? "redeem" : "sell", entityId: k.h.entityId, fromHoldingId: k.h.id, fromLotIds: [k.l.id], quantity: qty, amount: r2(amt), plannedDate: planned, earliestDate: k.earliest, latestDate: k.deadline, settlesOn: settles, reason, needId: need?.id ?? null, estGain: t.gain, estTax: t.tax, estCost: cost, exitLoad, constraintsChecked: checks.map((x) => `lot ${k.l.buyDate}: ${x}`), what: `${k.h.instrumentType === "mf" ? "Redeem" : "Sell"} ${qty} ${k.h.instrumentType === "mf" ? "u" : "×"} ${k.h.name} (lot ${k.l.buyDate})` });
    left -= amt;
  }
  return { moves, raised: r2(amount - Math.max(0, left)) };
}

export function solve(snap: RbSnapshot, objective: Objective, constraintsIn: Partial<RbConstraints> = {}, opts: { taxYearEnd?: boolean; excludeHoldingIds?: string[]; excludeNeedIds?: string[]; dateOverrides?: Record<string, string> } = {}): RbPlan {
  const c = { ...DEFAULT_CONSTRAINTS, ...Object.fromEntries(Object.entries(constraintsIn).filter(([, v]) => v !== undefined && v !== null)) } as RbConstraints;
  const holdings = snap.holdings.filter((h) => !(opts.excludeHoldingIds ?? []).includes(h.id));
  const s: RbSnapshot = { ...snap, holdings, needs: snap.needs.filter((n) => !(opts.excludeNeedIds ?? []).includes(n.id)).sort((a, b) => a.priority - b.priority || a.date.localeCompare(b.date)) };
  const ctx: Ctx = { snap: s, c, usedLotQty: new Map(), exemption: { ...s.exemptionRemaining }, seq: 0, moves: [], warnings: [], exitLoadsAvoided: 0 };
  const before = allocation(s); const total = before[0]?.total ?? 0;
  const cashTotal = s.cash.reduce((x, k) => x + k.balance, 0); let idle = Math.max(0, cashTotal - s.floatRequired);
  const coverage: Coverage[] = []; const classAdj: Record<string, number> = {}; let needsPaid = 0; const usedMaturity = new Set<string>();
  // 1. needs, by priority then date: idle cash → maturities → redirected contributions → tax-aware sales
  for (const n of s.needs) {
    let short = r2(n.amount - n.fundedAmount); const cov: Coverage = { needId: n.id, sources: [], covered: 0, shortfall: 0 };
    const latest = addDays(n.date, n.flexibilityDays - c.settlement_buffer_days);
    if (short > 0 && idle > 0) { const amt = r2(Math.min(short, idle)); idle = r2(idle - amt); short = r2(short - amt); const acct = s.cash.find((k) => k.entityId === n.entityId && k.balance > 0) ?? s.cash[0];
      ctx.moves.push({ seq: ++ctx.seq, kind: "hold_cash", entityId: n.entityId, toBankAccountId: acct?.accountId ?? null, amount: amt, plannedDate: s.asOf, earliestDate: s.asOf, latestDate: n.date, settlesOn: s.asOf, reason: `need: ${n.label} ${n.date}`, needId: n.id, estGain: 0, estTax: 0, estCost: 0, exitLoad: 0, constraintsChecked: ["idle cash above float · reserved"], what: `Keep ${inr(amt)} in cash for ${n.label}` });
      cov.sources.push({ kind: "cash", ref: acct?.accountId ?? "cash", amount: amt, availableOn: s.asOf }); needsPaid += amt; }
    for (const h of s.holdings) { if (short <= 0) break; if (!h.maturesOn || usedMaturity.has(h.id) || h.maturesOn > addDays(latest, 0) || h.maturesOn < s.asOf) continue; const v = value(h); const amt = r2(Math.min(short, v)); usedMaturity.add(h.id); short = r2(short - amt); classAdj[h.allocClass] = (classAdj[h.allocClass] ?? 0) - amt;
      ctx.moves.push({ seq: ++ctx.seq, kind: "redeem", entityId: h.entityId, fromHoldingId: h.id, amount: amt, plannedDate: h.maturesOn, earliestDate: h.maturesOn, latestDate: latest, settlesOn: h.maturesOn, reason: `need: ${n.label} ${n.date} · maturity`, needId: n.id, estGain: 0, estTax: 0, estCost: 0, exitLoad: 0, constraintsChecked: [`matures ${h.maturesOn} before the need ✓`], what: `${h.name} matures — ${inr(amt)} to ${n.label}` });
      cov.sources.push({ kind: "maturity", ref: h.id, amount: amt, availableOn: h.maturesOn }); needsPaid += amt; }
    if (short > 0 && c.prefer_new_cash) { const months = Math.floor(daysBetween(s.asOf, latest) / 30); for (const k of s.contributions) { if (short <= 0 || months < 1) break; const amt = r2(Math.min(short, k.monthly * months)); if (amt < c.min_trade) continue; short = r2(short - amt); classAdj[k.allocClass] = (classAdj[k.allocClass] ?? 0) - amt;
      ctx.moves.push({ seq: ++ctx.seq, kind: "sip_change", entityId: k.entityId, toInstrumentId: null, amount: amt, plannedDate: addMonths(s.asOf.slice(0, 8) + "01", 1), earliestDate: s.asOf, latestDate: latest, settlesOn: latest, reason: `need: ${n.label} ${n.date} · new cash first`, needId: n.id, estGain: 0, estTax: 0, estCost: 0, exitLoad: 0, constraintsChecked: [`policy: prefer_new_cash ✓ — ${months} month${months > 1 ? "s" : ""} of ${k.label} (${inr(k.monthly)}/month) parked in cash`, "no sale needed"], what: `Redirect ${k.label} ${inr(k.monthly)}/month to cash for ${months} month${months > 1 ? "s" : ""}` });
      cov.sources.push({ kind: "move", ref: String(ctx.seq), amount: amt, availableOn: latest }); needsPaid += amt; } }
    if (short > 0) {
      const over = before.filter((a) => a.key !== "cash" && a.actual_pct > a.target).sort((a, b) => (b.actual_pct - b.target) - (a.actual_pct - a.target)).map((a) => a.key);
      const donors = [...over, ...before.filter((a) => a.key !== "cash" && !over.includes(a.key)).map((a) => a.key)];
      const sold = sellFrom(ctx, candidates(ctx, donors, latest, null), short, (k) => `need: ${n.label} ${n.date} · from ${k.h.allocClass}${over.includes(k.h.allocClass) ? " (above target)" : ""}`, n, latest);
      for (const m of sold.moves) { ctx.moves.push(m); cov.sources.push({ kind: "move", ref: String(m.seq), amount: m.amount, availableOn: m.settlesOn }); const h = s.holdings.find((x) => x.id === m.fromHoldingId)!; classAdj[h.allocClass] = (classAdj[h.allocClass] ?? 0) - m.amount; }
      short = r2(short - sold.raised); needsPaid += sold.raised;
    }
    cov.covered = r2(n.amount - n.fundedAmount - Math.max(0, short)); cov.shortfall = r2(Math.max(0, short)); coverage.push(cov);
    if (short > 0.5) ctx.warnings.push(`${n.label} (${n.date}): ${inr(short)} uncovered — ${n.priority === 1 ? "hard need, constraints block every source" : "no source clears its constraints in time"}`);
  }
  // 2. bands (objective-driven targets) funded from remaining idle cash and over-weight sales, within the turnover cap
  let desired: Record<string, number> = {};
  const mid = allocation(s, classAdj, -needsPaid);
  if (objective !== "fund_needs_only") {
    for (const a of mid) { if (a.key === "cash" && objective !== "back_to_target") continue;
      const out = (a.min != null && a.actual_pct < a.min) || (a.max != null && a.actual_pct > a.max);
      if (objective === "back_to_target") desired[a.key] = a.target;
      else if (objective === "to_band_edge") { if (out) desired[a.key] = a.actual_pct < (a.min ?? 0) ? a.min! : a.max!; }
      else if (out) desired[a.key] = a.target; }
    if (objective === "glide_step" && s.glideGrowthPct != null) desired.equity = s.glideGrowthPct;
  }
  const totalAfterNeeds = mid[0]?.total ?? total;
  const sellCap = r2(totalAfterNeeds * c.max_turnover_pct / 100); let sold = ctx.moves.filter((m) => m.kind === "sell" || m.kind === "redeem").reduce((x, m) => x + m.amount, 0);
  let pool = idle; const pooled: { seq: number; settles: string }[] = [];
  for (const [k, d] of Object.entries(desired)) { const a = mid.find((x) => x.key === k)!; if (a.actual_pct <= d + 0.05 || k === "cash") continue;
    let amt = r2((a.actual_pct - d) / 100 * totalAfterNeeds); if (sold + amt > sellCap) { const room = Math.max(0, sellCap - sold); if (room < c.min_trade) { ctx.warnings.push(`turnover cap ${c.max_turnover_pct}% reached — ${k} trim of ${inr(amt)} left for the next run`); continue; } ctx.warnings.push(`turnover cap ${c.max_turnover_pct}% — ${k} trim reduced from ${inr(amt)} to ${inr(room)}`); amt = r2(room); }
    const res = sellFrom(ctx, candidates(ctx, [k as AllocClass], null, null), amt, `band: ${k} ${a.actual_pct}% → ${d}%`, null, null);
    for (const m of res.moves) { // a taxed long-term gain inside 60 days of FY end waits for next year's exemption
      const near = daysBetween(m.plannedDate, s.fyEnd); if (m.estTax > 0 && near >= 0 && near <= 60 && m.plannedDate <= s.fyEnd) { const h = s.holdings.find((x) => x.id === m.fromHoldingId)!; const l = h.lots.find((x) => m.fromLotIds?.includes(x.id))!; const nxt = addDays(s.fyEnd, 3); const rule = ruleFor(s.rules, h.assetClass, "long"); const t = rule ? r2(Math.max(0, m.estGain - rule.exemptionAmount) * rule.rate / 100) : 0; m.constraintsChecked.push(`this FY's exemption is exhausted → deferred to ${nxt} (next FY's ${inr(rule?.exemptionAmount ?? 0)} exemption): tax ${inr(m.estTax)} → ${inr(t)}`); m.plannedDate = nxt; m.settlesOn = addDays(nxt, l.settlementDays); m.estTax = t; }
      ctx.moves.push(m); pool += m.amount; pooled.push({ seq: m.seq, settles: m.settlesOn }); classAdj[k] = (classAdj[k] ?? 0) - m.amount; classAdj.cash = (classAdj.cash ?? 0) + m.amount; sold += m.amount; } // proceeds sit in cash until a buy uses them
  }
  for (const [k, d] of Object.entries(desired)) { const a = mid.find((x) => x.key === k)!; if (a.actual_pct >= d - 0.05 || k === "cash" || pool < c.min_trade) continue;
    if (UNTRADEABLE.has(k)) { ctx.warnings.push(`${k} below target (${a.actual_pct}% vs ${d}%) — needs a new commitment, not an order`); continue; }
    const amt = r2(Math.min((d - a.actual_pct) / 100 * totalAfterNeeds, pool)); if (amt < c.min_trade) continue; const inst = s.buyInstrument[k as AllocClass]; const dep = pooled.length ? pooled.reduce((x, p) => (p.settles > x.settles ? p : x)) : null;
    const planned = dep ? dep.settles : s.asOf; const settles = addDays(planned, inst?.settlementDays ?? 1);
    ctx.moves.push({ seq: ++ctx.seq, kind: "buy", entityId: s.holdings.find((h) => h.allocClass === k)?.entityId ?? s.cash[0]?.entityId ?? "", toInstrumentId: inst?.id ?? null, toAllocClass: k as AllocClass, amount: amt, plannedDate: planned, earliestDate: planned, latestDate: null, settlesOn: settles, reason: `band: ${k} ${a.actual_pct}% → ${d}%`, estGain: 0, estTax: 0, estCost: r2(amt * 0.001), exitLoad: 0, constraintsChecked: [dep ? `after move #${dep.seq} settles ${dep.settles}` : "funded from idle cash", inst ? `into ${inst.name}` : `no default instrument for ${k} — pick one before converting`], dependsOnSeq: dep?.seq ?? null, what: `Buy ${inr(amt)} of ${inst?.name ?? k}` });
    pool = r2(pool - amt); classAdj[k] = (classAdj[k] ?? 0) + amt; classAdj.cash = (classAdj.cash ?? 0) - amt; }
  // 3. tax year-end: book long-term gains inside the exemption, harvest losses — both before 31 March
  if (opts.taxYearEnd) {
    for (const ent of [...new Set(s.holdings.map((h) => h.entityId))]) {
      const rem = ctx.exemption[ent] ?? 0; if (rem <= 0) continue;
      const cands = candidates(ctx, ["equity"], s.fyEnd, ent).filter((k) => k.unitGain > 0 && k.l.ltcgEligibleOn && k.l.ltcgEligibleOn <= addDays(s.fyEnd, -7) && k.earliest <= addDays(s.fyEnd, -7));
      let gainLeft = rem;
      for (const k of cands.sort((a, b) => b.unitGain - a.unitGain)) { if (gainLeft <= 0) break; const qty = Math.min(k.qty, Math.floor(gainLeft / k.unitGain * 10000) / 10000); if (qty * k.h.price < c.min_trade) continue; const planned = maxDate(k.earliest, addDays(s.fyEnd, -11))!; const t = taxFor(ctx, k.h, k.l, qty, planned, true); ctx.usedLotQty.set(k.l.id, (ctx.usedLotQty.get(k.l.id) ?? 0) + qty); gainLeft -= t.gain;
        ctx.moves.push({ seq: ++ctx.seq, kind: k.h.instrumentType === "mf" ? "redeem" : "sell", entityId: ent, fromHoldingId: k.h.id, fromLotIds: [k.l.id], quantity: qty, amount: r2(qty * k.h.price), plannedDate: planned, earliestDate: k.earliest, latestDate: s.fyEnd, settlesOn: addDays(planned, k.l.settlementDays), reason: `tax year-end: use ${inr(rem)} LTCG exemption`, estGain: t.gain, estTax: t.tax, estCost: r2(qty * k.h.price * 0.001), exitLoad: 0, constraintsChecked: [`lot ${k.l.buyDate} LTCG-eligible ✓`, `gain ${inr(t.gain)} within exemption → tax ${inr(t.tax)}`, `re-buy the next day to reset cost (plan action)`], what: `Sell ${qty} × ${k.h.name} within the LTCG exemption` }); }
      for (const k of candidates(ctx, ["equity", "debt", "gold", "global"], s.fyEnd, ent).filter((x) => x.unitGain < 0 && x.earliest <= addDays(s.fyEnd, -7))) { const amt = k.qty * k.h.price; if (amt < c.min_trade) continue; const planned = maxDate(k.earliest, addDays(s.fyEnd, -11))!; ctx.usedLotQty.set(k.l.id, k.l.qty);
        ctx.moves.push({ seq: ++ctx.seq, kind: k.h.instrumentType === "mf" ? "redeem" : "sell", entityId: ent, fromHoldingId: k.h.id, fromLotIds: [k.l.id], quantity: k.qty, amount: r2(amt), plannedDate: planned, earliestDate: k.earliest, latestDate: s.fyEnd, settlesOn: addDays(planned, k.l.settlementDays), reason: "tax year-end: harvest loss", estGain: r2(k.qty * k.unitGain), estTax: 0, estCost: r2(amt * 0.001), exitLoad: 0, constraintsChecked: [`loss ${inr(-k.qty * k.unitGain)} offsets gains this FY`, "re-buy after 1 day if the position is still wanted"], what: `Harvest loss: sell ${k.qty} × ${k.h.name}` }); }
    }
  }
  for (const [seqStr, d] of Object.entries(opts.dateOverrides ?? {})) { const m = ctx.moves.find((x) => x.seq === Number(seqStr)); if (!m) continue; const ok = (!m.latestDate || d <= m.latestDate) && d >= m.earliestDate; m.constraintsChecked.push(ok ? `date set by hand to ${d} (inside ${m.earliestDate}–${m.latestDate ?? "open"})` : `date set by hand to ${d} — outside the window ${m.earliestDate}–${m.latestDate ?? "open"}`); if (!ok) ctx.warnings.push(`move #${m.seq}: ${d} is outside its window`); m.settlesOn = addDays(d, daysBetween(m.plannedDate, m.settlesOn)); m.plannedDate = d; }
  const moves = ctx.moves.sort((a, b) => a.plannedDate.localeCompare(b.plannedDate) || a.seq - b.seq).map((m, i) => ({ ...m, seq: i + 1, _old: m.seq } as RbMove & { _old: number }));
  for (const m of moves) if (m.dependsOnSeq != null) { const old = m.dependsOnSeq; m.dependsOnSeq = moves.find((x) => x._old === old)?.seq ?? null; m.constraintsChecked = m.constraintsChecked.map((x) => x.replace(new RegExp(`^after move #${old} `), `after move #${m.dependsOnSeq} `)); }
  for (const cv of coverage) for (const src of cv.sources) if (src.kind === "move") src.ref = String(moves.find((x) => x._old === Number(src.ref))?.seq ?? src.ref);
  const after = allocation(s, classAdj, -needsPaid).filter((a) => s.targets.some((t) => t.key === a.key) || a.value > 0);
  for (const a of after) if (a.status === "breach" && desired[a.key] != null) ctx.warnings.push(`${a.key} still outside its band after the plan (${a.actual_pct}%)`);
  const estTax = r2(moves.reduce((x, m) => x + m.estTax, 0)); if (c.max_tax_cost != null && estTax > c.max_tax_cost) ctx.warnings.push(`estimated tax ${inr(estTax)} above the ${inr(c.max_tax_cost)} cap`);
  const turnover = r2(moves.filter((m) => m.kind !== "hold_cash").reduce((x, m) => x + m.amount, 0));
  let bal = r2(idle + moves.filter((m) => m.kind === "hold_cash").reduce((x, m) => x + m.amount, 0)); const timeline = [{ date: s.asOf, event: "idle cash above float", delta: bal, balance: bal }];
  const events = [...moves.filter((m) => m.kind !== "hold_cash").map((m) => ({ date: m.settlesOn, event: `#${m.seq} ${m.what}`, delta: m.kind === "buy" ? -m.amount : m.kind === "sip_change" ? m.amount : m.amount })), ...s.needs.map((n) => ({ date: n.date, event: `need: ${n.label}`, delta: -(n.amount - n.fundedAmount) }))].sort((a, b) => a.date.localeCompare(b.date));
  for (const e of events) { bal = r2(bal + e.delta); timeline.push({ ...e, balance: bal }); }
  const cleaned = moves.map(({ _old, ...m }) => m);
  return { objective, moves: cleaned, allocationAfter: after.map((a) => ({ key: a.key, target: a.target, min: a.min, max: a.max, actual_pct: a.actual_pct, before_pct: before.find((b) => b.key === a.key)?.actual_pct ?? 0, status: a.status })), coverage, cashTimeline: timeline,
    summary: { turnover, turnover_pct: total ? r2(turnover / total * 100) : 0, est_tax: estTax, est_costs: r2(moves.reduce((x, m) => x + m.estCost + m.exitLoad, 0)), exit_loads_avoided: ctx.exitLoadsAvoided, needs_covered: coverage.filter((x) => x.shortfall <= 0.5).length, needs_uncovered: coverage.filter((x) => x.shortfall > 0.5).length, drift_after_max_pp: r2(Math.max(0, ...after.filter((a) => s.targets.some((t) => t.key === a.key)).map((a) => Math.abs(a.actual_pct - a.target)))), drift_before_max_pp: r2(Math.max(0, ...before.filter((a) => s.targets.some((t) => t.key === a.key)).map((a) => Math.abs(a.actual_pct - a.target)))), total: r2(total), idle_cash: r2(Math.max(0, cashTotal - s.floatRequired)) },
    warnings: [...new Set(ctx.warnings)] };
}
