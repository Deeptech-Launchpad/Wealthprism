/** What-if simulation (PRD 3.12 / FO-73, FO-74): clone the state, apply actions in date order through the same lot /
 *  capital-gains functions used for actuals, roll forward at assumed returns, compute each entity's tax per FY, then
 *  allocation, drift, goal funding and a monthly cash ladder. Pure and deterministic: same inputs → identical result. */
import { consumeFifo, type Lot } from "./lots.js";
import { realiseSale, type TaxRule } from "./capitalGains.js";
import { computeTax, type TaxTables, type GainItem, type TaxComputation } from "./tax.js";
import { fyOf } from "./rent.js";
import type { Bucket } from "./buckets.js";

export const ENGINE_VERSION = "sim-2.0";
export interface SimEntity { id: string; name: string; type: string; regime: "old" | "new" }
export interface SimHolding { id: string; entityId: string; instrumentId: string; name: string; assetClass: string; bucket: Bucket; price: number; quantity?: number; lots: Lot[]; fmv31Jan2018?: number; clubbedTo?: string }
export interface SimProperty { id: string; name: string; entityId: string; ownershipPct: number; value: number; cost: number; acquisitionDate: string; annualRentGross: number; rentEndDate?: string | null; municipalTax: number; interest: number; selfOccupied: boolean; soldOn?: string | null }
export interface SimPrivate { id: string; entityId: string; name: string; cost: number; mark: number; investedOn: string; bucket: Bucket }
export interface SimIncome { entityId: string; kind: string; annual: number; growthPct: number }
export interface SimGoal { id: string; name: string; targetYear: number; amountToday: number; inflationPct: number; bucket: Bucket; linkedHoldingIds: string[]; linkedPropertyIds: string[]; linkedPrivateIds: string[] }
export interface SimState {
  asOf: string; entities: SimEntity[]; holdings: SimHolding[]; properties: SimProperty[]; privates: SimPrivate[];
  cash: Record<string, number>; incomes: SimIncome[];
  deductions: { entityId: string; fy: string; code: string; amount: number }[];
  advancePaid: { entityId: string; fy: string; date: string; amount: number }[];
  tds: { entityId: string; fy: string; amount: number }[];
  realised: { entityId: string; fy: string; assetClass: string; term: "short" | "long"; amount: number; sellDate: string }[];
  goals: SimGoal[]; targets: { liquidity: number; income: number; growth: number; driftThresholdPp: number };
  commitments: { entityId: string | null; date: string; amount: number; label: string }[];
  liabilities: { entityId: string; outstanding: number; ratePct: number; section: string | null }[];
}
export interface SimAction { id: string; seq: number; kind: string; entityId?: string | null; targetType?: string | null; targetId?: string | null; params: Record<string, any>; plannedDate: string; plannedAmount?: number | null }
export interface Assumptions { returns: { liquidity: number; income: number; growth: number }; inflation: number; regime?: Record<string, "old" | "new">; price_growth?: Record<string, number> }
export type TablesProvider = (fy: string, regime: "old" | "new", entityType: string) => TaxTables;
export interface ActionEffect { gain: number; term: string | null; tax: number; cash: number; warnings: string[]; detail?: string }
export interface TaxByFy extends Omit<TaxComputation, "entityType"> { entity_id: string; entity_name: string; entity_type: string }
export interface SimResult {
  engine_version: string; base_fy: string; fys: string[];
  summary: { tax_total: number; tax_vs_baseline: number | null; post_tax_cash: number; net_worth_end: number; net_worth_start: number; drift_max_pp: number; interest_234_total: number };
  by_fy: TaxByFy[]; allocation_after: { bucket: Bucket; value: number; pct: number; target_pct: number; drift_pp: number; breached: boolean }[];
  goals_after: { goal_id: string; name: string; funded_pct: number; delta_pp: number | null }[];
  cash_ladder: { month: string; cash: number; committed: number; excess: number }[];
  warnings: string[]; action_effects: Record<string, ActionEffect>;
}

const r2 = (n: number) => Math.round(n * 100) / 100 + 0;
const addMonths = (d: string, m: number) => { const x = new Date(d + "T00:00:00Z"); x.setUTCMonth(x.getUTCMonth() + m); return x.toISOString().slice(0, 10); };
const months = (a: string, b: string) => { const [ay, am, ad] = a.split("-").map(Number), [by, bm, bd] = b.split("-").map(Number); let m = (by - ay) * 12 + (bm - am); if (bd < ad) m--; return m; };
const yearsBetween = (a: string, b: string) => (Date.parse(b) - Date.parse(a)) / (365.25 * 86400000);
const fyStartOf = (fy: string) => `${fy.slice(0, 4)}-04-01`, fyEndOf = (fy: string) => `${Number(fy.slice(0, 4)) + 1}-03-31`;
const nextFy = (fy: string) => { const y = Number(fy.slice(0, 4)) + 1; return `${y}-${String(y + 1).slice(-2)}`; };
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

export function simulate(input: SimState, actionsIn: SimAction[], a: Assumptions, tables: TablesProvider, opts: { horizonFys?: number; cii?: Record<string, number>; baselineGoals?: Record<string, number>; baselineTax?: number } = {}): SimResult {
  const s = clone(input);
  const horizon = opts.horizonFys ?? 3;
  const baseFy = fyOf(s.asOf);
  const fys: string[] = []; for (let i = 0, f = baseFy; i < horizon; i++, f = nextFy(f)) fys.push(f);
  const lastFy = fys[fys.length - 1];
  const warnings: string[] = []; const effects: Record<string, ActionEffect> = {};
  const booked: { entityId: string; fy: string; assetClass: string; term: "short" | "long"; amount: number; sellDate: string; rate?: number; propertyId?: string; consideration?: number }[] = s.realised.map((r) => ({ ...r }));
  const regimeOverride: Record<string, Record<string, "old" | "new">> = {};
  const extraIncome: { entityId: string; fy: string; amount: number }[] = [];
  const cashEvents: { date: string; entityId: string; amount: number; label: string }[] = [];
  const entity = (id: string) => s.entities.find((e) => e.id === id);
  const rulesFor = (fy: string, e: SimEntity) => tables(fy, regimeFor(e, fy), e.type).rules;
  const regimeFor = (e: SimEntity, fy: string): "old" | "new" => regimeOverride[e.id]?.[fy] ?? regimeOverride[e.id]?.["*"] ?? a.regime?.[e.id] ?? e.regime;
  const cashOf = (id: string) => (s.cash[id] ?? 0);
  const moveCash = (id: string, amt: number, date: string, label: string) => { s.cash[id] = cashOf(id) + amt; cashEvents.push({ date, entityId: id, amount: amt, label }); };
  const growthTo = (bucket: Bucket, date: string) => Math.pow(1 + (a.returns[bucket] ?? 0) / 100, Math.max(0, yearsBetween(s.asOf, date)));
  const estimateTax = (lines: { gain: number; term: "short" | "long" }[], assetClass: string, rules: TaxRule[], slabPct: number) => lines.reduce((t, l) => { const r = rules.find((x) => x.assetClass === assetClass && x.term === l.term); const rate = !r ? slabPct : r.taxedAtSlab ? slabPct : r.rate; return t + Math.max(0, l.gain) * rate / 100; }, 0);

  /** Sell `qty` of a holding at `price` on `date`; books the gain lines and returns the effect. */
  const sell = (h: SimHolding, qty: number, price: number, date: string, label: string): ActionEffect => {
    const e = entity(h.clubbedTo ?? h.entityId)!; const fy = fyOf(date);
    const rules = rulesFor(fy, e);
    const avail = h.lots.reduce((t, l) => t + l.remainingQty, 0);
    const q = Math.min(qty, avail); const w: string[] = [];
    if (q <= 0) return { gain: 0, term: null, tax: 0, cash: 0, warnings: [`${label}: nothing left to sell in ${h.name}`] };
    if (q < qty) w.push(`${label}: only ${q} of ${qty} units available in ${h.name}`);
    const { lines, remaining } = realiseSale({ lots: h.lots, qty: q, price, sellDate: date, assetClass: h.assetClass, rules, fmv31Jan2018: h.fmv31Jan2018 });
    h.lots = remaining;
    const longRule = rules.find((r) => r.assetClass === h.assetClass && r.term === "long");
    for (const l of lines) {
      booked.push({ entityId: e.id, fy, assetClass: h.assetClass, term: l.term, amount: l.gain, sellDate: date });
      if (l.term === "short" && longRule && longRule.rate < 30) { const turns = addMonths(l.buyDate, longRule.holdingMonthsForLong); if (months(date, turns) <= 3) w.push(`${label}: lot bought ${l.buyDate} turns long-term on ${turns} — waiting saves the short-term rate`); }
    }
    if (h.clubbedTo) w.push(`${label}: gains taxed in ${entity(h.clubbedTo)!.name}'s hands (clubbing)`);
    const proceeds = r2(q * price); moveCash(h.entityId, proceeds, date, label);
    const gain = r2(lines.reduce((t, l) => t + l.gain, 0));
    const terms = new Set(lines.map((l) => l.term));
    return { gain, term: terms.size === 1 ? [...terms][0] : "mixed", tax: r2(estimateTax(lines, h.assetClass, rules, tables(fy, regimeFor(e, fy), e.type).slabs.slice(-1)[0]?.rate ?? 30)), cash: proceeds, warnings: w, detail: `${q} × ₹${price} → gain ₹${gain.toLocaleString("en-IN")}` };
  };
  const buy = (entityId: string, instrumentId: string | undefined, name: string, amount: number, price: number, date: string, bucket: Bucket, assetClass: string, label: string): ActionEffect => {
    const w: string[] = [];
    let h = s.holdings.find((x) => x.entityId === entityId && x.instrumentId === instrumentId && instrumentId);
    if (!h) { h = { id: `sim-${label}-${s.holdings.length}`, entityId, instrumentId: instrumentId ?? `sim-${name}`, name, assetClass, bucket, price, lots: [] }; s.holdings.push(h); }
    const qty = +(amount / price).toFixed(6);
    h.lots.push({ id: `sim-lot-${label}`, buyDate: date, quantity: qty, remainingQty: qty, unitCost: price, charges: 0 });
    moveCash(entityId, -amount, date, label);
    if (cashOf(entityId) < 0) w.push(`${label}: ${entity(entityId)?.name} cash goes negative by ₹${r2(-cashOf(entityId)).toLocaleString("en-IN")} — fund it first`);
    return { gain: 0, term: null, tax: 0, cash: -amount, warnings: w, detail: `${qty} units of ${name} @ ₹${price}` };
  };
  const holdingFor = (act: SimAction) => s.holdings.find((h) => h.id === act.targetId) ?? (act.params.instrument_id ? s.holdings.find((h) => h.instrumentId === act.params.instrument_id && (!act.entityId || h.entityId === act.entityId)) : undefined);
  const priceAt = (h: SimHolding, date: string) => r2(h.price * growthTo(h.bucket, date));

  // ---- actions in date order ----
  const actions = [...actionsIn].sort((x, y) => x.plannedDate.localeCompare(y.plannedDate) || x.seq - y.seq);
  for (const act of actions) {
    const label = `#${act.seq} ${act.kind}`; const date = act.plannedDate; const p = act.params ?? {};
    const eid = act.entityId ?? holdingFor(act)?.entityId ?? s.entities[0]?.id;
    let eff: ActionEffect;
    try {
      if (fyOf(date) < baseFy) { eff = { gain: 0, term: null, tax: 0, cash: 0, warnings: [`${label}: dated before the current FY — treated as already reflected in actuals`] }; effects[act.id] = eff; continue; }
      switch (act.kind) {
        case "sell_holding": case "harvest_loss": case "redeem_before_date": case "book_gain_within_exemption": case "defer_sale_to_fy": {
          const h = holdingFor(act); if (!h) throw new Error("holding not found");
          const when = act.kind === "defer_sale_to_fy" && p.fy && fyOf(date) !== p.fy ? fyStartOf(p.fy) : date;
          const price = p.price != null ? Number(p.price) : priceAt(h, when);
          let qty = p.quantity != null ? Number(p.quantity) : h.lots.reduce((t, l) => t + l.remainingQty, 0);
          if (act.kind === "book_gain_within_exemption" && p.quantity == null) {
            const e = entity(h.entityId)!; const fy = fyOf(when); const ex = rulesFor(fy, e).find((r) => r.assetClass === h.assetClass && r.term === "long")?.exemptionAmount ?? 0;
            const used = booked.filter((b) => b.entityId === e.id && b.fy === fy && b.assetClass === h.assetClass && b.term === "long" && b.amount > 0).reduce((t, b) => t + b.amount, 0);
            const target = Math.min(Number(p.target_gain ?? ex), Math.max(0, ex - used));
            const { consumed } = consumeFifo(h.lots, h.lots.reduce((t, l) => t + l.remainingQty, 0));
            let acc = 0; qty = 0; for (const c of consumed) { const unitGain = price - c.cost / c.qty; if (unitGain <= 0) continue; const take = Math.min(c.qty, (target - acc) / unitGain); if (take <= 0) break; qty += take; acc += take * unitGain; }
            qty = Math.floor(qty * 1e4) / 1e4;
          }
          eff = sell(h, qty, price, when, label);
          if (act.kind === "harvest_loss" && eff.gain > 0) eff.warnings.push(`${label}: this is a gain of ₹${eff.gain.toLocaleString("en-IN")} at the assumed price, not a loss`);
          if (act.kind === "defer_sale_to_fy" && when !== date) eff.detail = `deferred to ${when} (FY ${p.fy}); ${eff.detail}`;
          break;
        }
        case "buy_instrument": case "deploy_cash": {
          const amount = Number(p.amount ?? act.plannedAmount ?? 0); if (!amount) throw new Error("amount required");
          const ref = s.holdings.find((h) => h.instrumentId === p.instrument_id);
          eff = buy(eid!, p.instrument_id, p.name ?? ref?.name ?? "New investment", amount, p.price != null ? Number(p.price) : ref ? priceAt(ref, date) : 1, date, (p.bucket ?? ref?.bucket ?? "growth") as Bucket, p.asset_class ?? ref?.assetClass ?? "equity", label);
          break;
        }
        case "switch": {
          const h = holdingFor(act); if (!h) throw new Error("holding not found");
          const qty = p.quantity != null ? Number(p.quantity) : h.lots.reduce((t, l) => t + l.remainingQty, 0);
          const out = sell(h, qty, p.price != null ? Number(p.price) : priceAt(h, date), date, label);
          const ref = s.holdings.find((x) => x.instrumentId === p.to_instrument_id);
          const inn = buy(h.entityId, p.to_instrument_id, p.to_name ?? ref?.name ?? "Switch target", out.cash, ref ? priceAt(ref, date) : 1, date, (p.bucket ?? ref?.bucket ?? h.bucket) as Bucket, ref?.assetClass ?? h.assetClass, label);
          eff = { ...out, cash: 0, warnings: [...out.warnings, ...inn.warnings], detail: `${out.detail}; reinvested ₹${out.cash.toLocaleString("en-IN")}` };
          break;
        }
        case "transfer_to_entity": {
          const to = p.to_entity_id ?? act.targetId; if (!to || !entity(to)) throw new Error("to_entity_id required");
          const amount = Number(p.amount ?? (p.monthly ? Number(p.monthly) * 12 : act.plannedAmount ?? 0));
          const w: string[] = [];
          if (act.targetType === "holding" && p.holding_id) { const h = s.holdings.find((x) => x.id === p.holding_id); if (h) { h.entityId = to; h.clubbedTo = eid!; w.push(`${label}: s.64 — income from the transferred ${h.name} stays clubbed with ${entity(eid!)!.name}`); } }
          if (amount) { moveCash(eid!, -amount, date, label); moveCash(to, amount, date, label); }
          const from = entity(eid!)!, dest = entity(to)!;
          if (from.type === "individual" && (dest.type === "huf" || dest.type === "individual")) w.push(`${label}: gift from ${from.name} to ${dest.name} — s.64 clubbing: income on the transferred amount is taxed in ${from.name}'s hands; fund from ${dest.name}'s own income to avoid it`);
          eff = { gain: 0, term: null, tax: 0, cash: 0, warnings: w, detail: `₹${amount.toLocaleString("en-IN")} ${from.name} → ${dest.name}` };
          break;
        }
        case "change_tax_regime": { const e = entity(eid!)!; (regimeOverride[e.id] ??= {})[p.fy ?? "*"] = p.regime; eff = { gain: 0, term: null, tax: 0, cash: 0, warnings: [], detail: `${e.name} → ${p.regime} regime${p.fy ? ` for FY ${p.fy}` : ""}` }; break; }
        case "sell_property": {
          const pr = s.properties.find((x) => x.id === act.targetId && !x.soldOn); if (!pr) throw new Error("property not found (or already sold in this plan)");
          const e = entity(pr.entityId)!; const fy = fyOf(date); const t = tables(fy, regimeFor(e, fy), e.type);
          const gross = Number(p.price ?? act.plannedAmount ?? pr.value) * pr.ownershipPct / 100; const net = r2(gross * (1 - Number(p.brokerage_pct ?? 0) / 100));
          const cost = pr.cost * pr.ownershipPct / 100; const long = months(pr.acquisitionDate, date) >= (t.rules.find((r) => r.assetClass === "real_estate" && r.term === "long")?.holdingMonthsForLong ?? 24);
          let gain = r2(net - cost), rate: number | undefined, note = "";
          const cutoff = String(t.params.PROPERTY_INDEXATION_CUTOFF ?? "20240723"); const acq = pr.acquisitionDate.replace(/-/g, "");
          if (long && acq < cutoff && opts.cii) {
            const ciiAcq = opts.cii[fyOf(pr.acquisitionDate)], ciiSale = opts.cii[fy];
            if (ciiAcq && ciiSale) { const indexed = r2(net - cost * ciiSale / ciiAcq); const plainRate = t.rules.find((r) => r.assetClass === "real_estate" && r.term === "long")?.rate ?? 12.5; const idxRate = t.params.PROPERTY_INDEXED_RATE_PCT ?? 20;
              if (indexed * idxRate < gain * plainRate) { gain = indexed; rate = idxRate; note = ` (indexed cost, ${idxRate}%)`; } else note = ` (${plainRate}% without indexation)`; }
          }
          booked.push({ entityId: e.id, fy, assetClass: "real_estate", term: long ? "long" : "short", amount: gain, sellDate: date, rate, propertyId: pr.id, consideration: net });
          // the property stays in the state so rent up to the sale date is still taxed; it drops out of valuations from here
          const w = [`${label}: 54EC bonds must be bought within ${t.params.SEC54EC_MONTHS ?? 6} months (by ${addMonths(date, t.params.SEC54EC_MONTHS ?? 6)}) to shelter the gain`];
          if (pr.annualRentGross && !(pr.rentEndDate && pr.rentEndDate <= date)) w.push(`${label}: rent of ₹${r2(pr.annualRentGross / 12).toLocaleString("en-IN")}/month stops from ${date}`);
          pr.soldOn = date; pr.rentEndDate = pr.rentEndDate && pr.rentEndDate < date ? pr.rentEndDate : date; moveCash(pr.entityId, net, date, label);
          if (gross >= 5000000) w.push(`${label}: buyer deducts 1% TDS under 194-IA on ₹${gross.toLocaleString("en-IN")}`);
          eff = { gain, term: long ? "long" : "short", tax: r2(Math.max(0, gain) * (rate ?? (long ? (t.rules.find((r) => r.assetClass === "real_estate" && r.term === "long")?.rate ?? 12.5) : (t.slabs.slice(-1)[0]?.rate ?? 30))) / 100), cash: net, warnings: w, detail: `LTCG ₹${gain.toLocaleString("en-IN")}${note}` };
          break;
        }
        case "reinvest_54ec": case "reinvest_54f": {
          const amount = Number(p.amount ?? act.plannedAmount ?? 0); if (!amount) throw new Error("amount required");
          const e = entity(eid!)!; const w: string[] = [];
          const g = [...booked].reverse().find((b) => b.entityId === e.id && b.assetClass === "real_estate" && b.term === "long" && b.amount > 0) ?? [...booked].reverse().find((b) => b.entityId === e.id && b.term === "long" && b.amount > 0);
          let exempt = 0;
          if (!g) w.push(`${label}: no long-term gain to shelter`);
          else {
            const t = tables(g.fy, regimeFor(e, g.fy), e.type);
            if (act.kind === "reinvest_54ec") { const cap = t.deductionLimits["54EC"] ?? Infinity; const win = t.params.SEC54EC_MONTHS ?? 6; if (months(g.sellDate, date) > win) w.push(`${label}: outside the ${win}-month 54EC window from ${g.sellDate}`); else exempt = Math.min(amount, cap, g.amount); }
            else { const cons = g.consideration ?? g.amount; const maxCons = t.params.SEC54F_MAX_CONSIDERATION ?? Infinity; if (cons > maxCons) w.push(`${label}: consideration exceeds the 54F cap`); else exempt = Math.min(g.amount, g.amount * Math.min(1, amount / cons)); }
            g.amount = r2(g.amount - exempt);
            if (exempt) w.push(`${label}: ₹${r2(exempt).toLocaleString("en-IN")} of the gain sheltered; ${act.kind === "reinvest_54ec" ? `${t.params.SEC54EC_LOCK_YEARS ?? 5}-year lock-in` : "hold the new house 3 years"}`);
          }
          buy(e.id, undefined, act.kind === "reinvest_54ec" ? `${p.issuer ?? "54EC"} capital-gain bonds` : "Residential house (54F)", amount, 1, date, act.kind === "reinvest_54ec" ? "income" : "growth", act.kind === "reinvest_54ec" ? "listed_bond" : "real_estate", label);
          const rate = g?.rate ?? 12.5;
          eff = { gain: 0, term: null, tax: r2(-(exempt * rate) / 100), cash: -amount, warnings: w, detail: `exemption ₹${r2(exempt).toLocaleString("en-IN")}` };
          break;
        }
        case "prepay_loan": {
          const amount = Number(p.amount ?? act.plannedAmount ?? 0); const l = s.liabilities.find((x) => x.entityId === eid) ?? s.liabilities[0];
          const w: string[] = []; if (!l) w.push(`${label}: no liability on file`); else { const pay = Math.min(amount, l.outstanding); l.outstanding -= pay; const saved = r2(pay * l.ratePct / 100); w.push(`${label}: interest saved ≈ ₹${saved.toLocaleString("en-IN")}/year${l.section === "24b" ? " (reduces the 24(b) deduction by the same amount)" : ""}`); }
          moveCash(eid!, -amount, date, label);
          eff = { gain: 0, term: null, tax: 0, cash: -amount, warnings: w };
          break;
        }
        case "exit_private": {
          const pv = s.privates.find((x) => x.id === act.targetId); if (!pv) throw new Error("private investment not found");
          const proceeds = Number(p.proceeds ?? act.plannedAmount ?? pv.mark); const e = entity(pv.entityId)!; const fy = fyOf(date); const rules = rulesFor(fy, e);
          const long = months(pv.investedOn, date) >= (rules.find((r) => r.assetClass === "unlisted_equity" && r.term === "long")?.holdingMonthsForLong ?? 24);
          const gain = r2(proceeds - pv.cost);
          booked.push({ entityId: e.id, fy, assetClass: "unlisted_equity", term: long ? "long" : "short", amount: gain, sellDate: date });
          s.privates = s.privates.filter((x) => x.id !== pv.id); moveCash(pv.entityId, proceeds, date, label);
          eff = { gain, term: long ? "long" : "short", tax: r2(estimateTax([{ gain, term: long ? "long" : "short" }], "unlisted_equity", rules, 30)), cash: proceeds, warnings: [], detail: `${pv.name}: ₹${proceeds.toLocaleString("en-IN")} vs cost ₹${pv.cost.toLocaleString("en-IN")}` };
          break;
        }
        case "donate_80g": case "contribute_nps": case "contribute_ppf": {
          const amount = Number(p.amount ?? act.plannedAmount ?? 0); if (!amount) throw new Error("amount required");
          const code = act.kind === "donate_80g" ? (Number(p.pct ?? 50) >= 100 ? "80G_100" : "80G") : act.kind === "contribute_nps" ? "80CCD1B" : "80C";
          const fy = fyOf(date); s.deductions.push({ entityId: eid!, fy, code, amount });
          const e = entity(eid!)!; const w: string[] = [];
          if (regimeFor(e, fy) === "new") w.push(`${label}: ${e.name} is on the new regime for FY ${fy}, where ${code} gives no deduction`);
          if (act.kind !== "donate_80g") buy(eid!, undefined, act.kind === "contribute_nps" ? "NPS Tier I" : "PPF", amount, 1, date, "income", act.kind === "contribute_nps" ? "nps" : "ppf", label); else moveCash(eid!, -amount, date, label);
          const t = tables(fy, regimeFor(e, fy), e.type); const marginal = t.slabs.slice(-1)[0]?.rate ?? 30;
          eff = { gain: 0, term: null, tax: regimeFor(e, fy) === "new" ? 0 : -r2(Math.min(amount, t.deductionLimits[code] ?? amount) * marginal / 100), cash: -amount, warnings: w, detail: `${code} ₹${amount.toLocaleString("en-IN")}` };
          break;
        }
        case "change_rent": {
          const pr = s.properties.find((x) => x.id === act.targetId && !x.soldOn); if (!pr) throw new Error("property not found");
          const vacate = p.vacate === true || /vacate|do not renew|end lease/i.test(String(p.note ?? ""));
          const before = pr.annualRentGross;
          if (vacate) pr.rentEndDate = date; else if (p.new_rent != null) pr.annualRentGross = Number(p.new_rent) * 12;
          const delta = vacate ? -before / 12 : (pr.annualRentGross - before) / 12;
          eff = { gain: 0, term: null, tax: 0, cash: 0, warnings: vacate ? [`${label}: rent of ₹${r2(before / 12).toLocaleString("en-IN")}/month stops from ${date}`] : [], detail: `rent ${delta >= 0 ? "+" : ""}₹${r2(delta).toLocaleString("en-IN")}/month` };
          break;
        }
        case "custom": {
          const amount = Number(p.amount ?? act.plannedAmount ?? 0); const head = String(p.tax_head ?? "other");
          const fy = fyOf(date);
          if (head.startsWith("deduction:")) s.deductions.push({ entityId: eid!, fy, code: head.split(":")[1], amount: Math.abs(amount) });
          else if (head.startsWith("capital_gains_")) booked.push({ entityId: eid!, fy, assetClass: p.asset_class ?? "equity", term: head.endsWith("long") ? "long" : "short", amount, sellDate: date });
          else if (amount) extraIncome.push({ entityId: eid!, fy, amount });
          if (amount && p.cash !== false) moveCash(eid!, head.startsWith("deduction:") ? -Math.abs(amount) : amount, date, label);
          eff = { gain: head.startsWith("capital_gains_") ? amount : 0, term: null, tax: 0, cash: amount, warnings: [], detail: p.note };
          break;
        }
        default: throw new Error(`unsupported action kind ${act.kind}`);
      }
    } catch (e: any) { eff = { gain: 0, term: null, tax: 0, cash: 0, warnings: [`${label}: ${e.message}`] }; }
    effects[act.id] = eff; warnings.push(...eff.warnings);
  }

  // ---- tax per FY per entity ----
  const byFy: TaxByFy[] = []; let taxTotal = 0, interestTotal = 0;
  const taxDue: { entityId: string; fy: string; amount: number }[] = [];
  for (const fy of fys) {
    const yearIndex = fys.indexOf(fy);
    for (const e of s.entities) {
      const regime = regimeFor(e, fy); let t: TaxTables;
      try { t = tables(fy, regime, e.type); } catch (err: any) { warnings.push(`${e.name} FY ${fy}: ${err.message}`); continue; }
      const inc = (kind: RegExp) => s.incomes.filter((i) => i.entityId === e.id && kind.test(i.kind)).reduce((sum, i) => sum + i.annual * Math.pow(1 + i.growthPct / 100, yearIndex), 0);
      const hp = s.properties.filter((pr) => pr.entityId === e.id && !pr.selfOccupied && pr.annualRentGross > 0).map((pr) => {
        const start = fyStartOf(fy), end = fyEndOf(fy); const stop = pr.rentEndDate && pr.rentEndDate < end ? pr.rentEndDate : end;
        const frac = stop <= start ? 0 : Math.max(0, months(start, stop) + 1) / 12;
        return { grossRent: r2(pr.annualRentGross * Math.min(1, frac) * pr.ownershipPct / 100), municipalTax: r2(pr.municipalTax * pr.ownershipPct / 100), interest: r2(pr.interest * pr.ownershipPct / 100) };
      }).filter((h) => h.grossRent > 0);
      const gains: GainItem[] = booked.filter((b) => b.entityId === e.id && b.fy === fy).map((b) => ({ assetClass: b.assetClass, term: b.term, amount: b.amount, ...(b.rate != null ? { rate: b.rate } : {}) }));
      const ded: Record<string, number> = {}; for (const d of s.deductions.filter((d) => d.entityId === e.id && d.fy === fy)) ded[d.code] = (ded[d.code] ?? 0) + d.amount;
      const comp = computeTax(t, { salary: inc(/salary/), business: inc(/business|fees/), otherSources: inc(/interest|dividend|other/) + extraIncome.filter((x) => x.entityId === e.id && x.fy === fy).reduce((a2, x) => a2 + x.amount, 0), houseProperty: hp, gains, deductions: ded,
        advanceTaxPaid: s.advancePaid.filter((x) => x.entityId === e.id && x.fy === fy).map((x) => ({ date: x.date, amount: x.amount })), tdsCredit: s.tds.filter((x) => x.entityId === e.id && x.fy === fy).reduce((a2, x) => a2 + x.amount, 0) });
      const { entityType, ...rest } = comp;
      byFy.push({ ...rest, entity_id: e.id, entity_name: e.name, entity_type: entityType });
      taxTotal += comp.tax.total; interestTotal += comp.interest_234;
      const owed = comp.net_payable - s.advancePaid.filter((x) => x.entityId === e.id && x.fy === fy).reduce((a2, x) => a2 + x.amount, 0);
      if (owed > 0) taxDue.push({ entityId: e.id, fy, amount: owed });
    }
  }

  // ---- roll forward to the horizon end and value everything ----
  const endDate = fyEndOf(lastFy);
  const value = (bucket: Bucket) => s.holdings.filter((h) => h.bucket === bucket).reduce((t, h) => t + h.lots.reduce((q, l) => q + l.remainingQty, 0) * priceAt(h, endDate), 0)
    + (bucket === "income" ? s.properties.filter((p) => !p.selfOccupied && !p.soldOn).reduce((t, p) => t + p.value * p.ownershipPct / 100 * Math.pow(1 + (a.price_growth?.[p.id] ?? 0) / 100, yearsBetween(s.asOf, endDate)), 0) : 0)
    + (bucket === "growth" ? s.privates.reduce((t, p) => t + p.mark, 0) : 0)
    + (bucket === "liquidity" ? Object.values(s.cash).reduce((t, c) => t + Math.max(0, c), 0) * growthTo("liquidity", endDate) - taxDue.reduce((t, d) => t + d.amount, 0) : 0);
  const buckets: Bucket[] = ["liquidity", "income", "growth"];
  const vals = Object.fromEntries(buckets.map((b) => [b, Math.max(0, value(b))])) as Record<Bucket, number>;
  const total = buckets.reduce((t, b) => t + vals[b], 0);
  const allocation = buckets.map((b) => { const pct = total ? r2((vals[b] / total) * 100) : 0; const drift = r2(pct - s.targets[b]); return { bucket: b, value: r2(vals[b]), pct, target_pct: s.targets[b], drift_pp: drift, breached: Math.abs(drift) > s.targets.driftThresholdPp }; });
  const driftMax = Math.max(0, ...allocation.map((x) => Math.abs(x.drift_pp)));
  const startValue = (() => { const hv = s.holdings.reduce((t, h) => t + h.lots.reduce((q, l) => q + l.remainingQty, 0) * h.price, 0); return r2(hv + input.properties.reduce((t, p) => t + p.value * p.ownershipPct / 100, 0) + input.privates.reduce((t, p) => t + p.mark, 0) + Object.values(input.cash).reduce((t, c) => t + c, 0)); })();

  // ---- goals ----
  const yearNow = Number(s.asOf.slice(0, 4));
  const goals = s.goals.map((g) => {
    const linked = s.holdings.filter((h) => g.linkedHoldingIds.includes(h.id)).reduce((t, h) => t + h.lots.reduce((q, l) => q + l.remainingQty, 0) * priceAt(h, endDate), 0)
      + s.properties.filter((p) => g.linkedPropertyIds.includes(p.id) && !p.soldOn).reduce((t, p) => t + p.value * p.ownershipPct / 100, 0) + s.privates.filter((p) => g.linkedPrivateIds.includes(p.id)).reduce((t, p) => t + p.mark, 0);
    const need = g.amountToday * Math.pow(1 + g.inflationPct / 100, Math.max(0, g.targetYear - yearNow));
    const funded = need > 0 ? r2(Math.min(999, (linked / need) * 100)) : 0;
    return { goal_id: g.id, name: g.name, funded_pct: funded, delta_pp: opts.baselineGoals && g.id in opts.baselineGoals ? r2(funded - opts.baselineGoals[g.id]) : null };
  });

  // ---- monthly cash ladder ----
  const ladder: SimResult["cash_ladder"] = [];
  let cash = Object.values(input.cash).reduce((t, c) => t + c, 0);
  const monthlyIncome = s.incomes.reduce((t, i) => t + i.annual, 0) / 12;
  for (let m = s.asOf.slice(0, 7) + "-01", i = 0; m <= endDate && i < 60; m = addMonths(m, 1), i++) {
    const mEnd = addMonths(m, 1);
    const rent = s.properties.filter((p) => !p.selfOccupied && (!p.rentEndDate || p.rentEndDate >= m)).reduce((t, p) => t + (p.annualRentGross / 12) * p.ownershipPct / 100, 0);
    const committed = s.commitments.filter((c) => c.date >= m && c.date < mEnd).reduce((t, c) => t + c.amount, 0);
    const taxes = taxDue.filter((d) => { const q = [`${d.fy.slice(0, 4)}-06`, `${d.fy.slice(0, 4)}-09`, `${d.fy.slice(0, 4)}-12`, `${Number(d.fy.slice(0, 4)) + 1}-03`]; return q.includes(m.slice(0, 7)); }).reduce((t, d) => t + d.amount / 4, 0);
    const events = cashEvents.filter((ev) => ev.date >= m && ev.date < mEnd).reduce((t, ev) => t + ev.amount, 0);
    cash = cash + rent + monthlyIncome - committed - taxes + events;
    const next60 = s.commitments.filter((c) => c.date >= mEnd && c.date < addMonths(mEnd, 2)).reduce((t, c) => t + c.amount, 0);
    ladder.push({ month: m.slice(0, 7), cash: r2(cash), committed: r2(committed + taxes), excess: r2(cash - next60) });
    if (cash < 0 && !warnings.some((w) => w.startsWith("Cash goes negative"))) warnings.push(`Cash goes negative in ${m.slice(0, 7)} (₹${r2(cash).toLocaleString("en-IN")}) — sequence sales before purchases or draw the liquidity bucket`);
  }
  const closingCash = ladder.length ? ladder[ladder.length - 1].cash : cash;
  if (driftMax > s.targets.driftThresholdPp) warnings.push(`Bucket drift of ${driftMax} pp after the plan exceeds the ${s.targets.driftThresholdPp} pp threshold`);

  return {
    engine_version: ENGINE_VERSION, base_fy: baseFy, fys,
    summary: { tax_total: r2(taxTotal), tax_vs_baseline: opts.baselineTax != null ? r2(taxTotal - opts.baselineTax) : null, post_tax_cash: r2(closingCash - Object.values(input.cash).reduce((t, c) => t + c, 0)), net_worth_end: r2(total), net_worth_start: startValue, drift_max_pp: driftMax, interest_234_total: r2(interestTotal) },
    by_fy: byFy, allocation_after: allocation, goals_after: goals, cash_ladder: ladder, warnings: [...new Set(warnings)], action_effects: effects,
  };
}
