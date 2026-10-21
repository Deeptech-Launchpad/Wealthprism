/** Income-tax computation for one entity and one FY (PRD 3.12 / FO-70). Every rate, slab, limit and threshold comes in
 *  through `TaxTables` (loaded from tax_slabs, tax_surcharge, tax_deduction_limits, tax_rules, tax_params); nothing is
 *  hard-coded here. Heads → set-off → deductions → slab tax + special-rate tax → 87A rebate → surcharge with marginal
 *  relief (15% cap on 111A/112/112A) → cess → advance-tax instalments → 234B/234C interest. */
import type { TaxRule } from "./capitalGains.js";

export interface Slab { from: number; to: number | null; rate: number }
export interface SurchargeBand { incomeFrom: number; rate: number; cappedOnGainsPct: number }
export interface TaxTables {
  fy: string; regime: "old" | "new"; entityType: string;
  slabs: Slab[]; surcharge: SurchargeBand[];
  deductionLimits: Record<string, number | null>;   // 80C, 80CCD1B, 80D, 24B, 80G, STD_DED, 80TTA, 54EC, 112A_EXEMPT …
  params: Record<string, number>;                    // CESS_PCT, REBATE_87A_LIMIT, REBATE_87A_MAX, REBATE_87A_MARGINAL_RELIEF, HP_STD_DED_PCT, ADV_Q1..Q4_PCT, ADV_TAX_THRESHOLD, INT_234B_PCT_PM, INT_234C_PCT_PM, INT_234B_MIN_PAID_PCT, INT_234B_MONTHS, DED_80G_PCT, DED_80G_GTI_CAP_PCT
  rules: TaxRule[];                                   // capital-gains rates per asset class / term
}
export interface GainItem { assetClass: string; term: "short" | "long"; amount: number; rate?: number /* overrides the rule, e.g. indexed property gain at 20% */ }
export interface HouseProperty { grossRent: number; municipalTax?: number; interest?: number; selfOccupied?: boolean }
export interface TaxInput {
  salary?: number; business?: number; otherSources?: number;
  houseProperty?: HouseProperty[];
  gains?: GainItem[];
  deductions?: Record<string, number>;               // claimed amounts before caps: 80C, 80D, 80CCD1B, 80G (donation), 80TTA, 80CCD2 …
  advanceTaxPaid?: { date: string; amount: number }[];
  tdsCredit?: number;
  asOf?: string;                                     // for 234B months (default: 4 months after FY end)
}
export interface Instalment { due: string; cumulative_pct: number; amount: number; paid: number; shortfall: number; interest: number }
export interface TaxComputation {
  fy: string; regime: "old" | "new"; entityType: string;
  heads: { salary: number; house_property: number; business: number; capital_gains: { stcg_equity: number; ltcg_equity: number; stcg_other: number; ltcg_other: number; exemption_used: number; slab_taxed: number; special_taxed: number }; other_sources: number; gross_total: number };
  deductions: Record<string, number>; deductions_total: number;
  taxable_income: number; normal_income: number; special_income: number;
  losses_carried_forward: { short: number; long: number };
  tax: { slab: number; special_rate: number; rebate: number; surcharge: number; cess: number; total: number };
  tds_credit: number; net_payable: number;
  advance_tax: Instalment[]; interest_234: number; interest_234b: number; interest_234c: number;
  effective_rate_pct: number; marginal_rate_pct: number; basic_exemption: number;
  notes: string[];
}

const r2 = (n: number) => Math.round(n * 100) / 100 + 0; // + 0 turns -0 into 0
const r0 = (n: number) => Math.round(n);
const p = (t: TaxTables, code: string, dflt = 0) => (t.params[code] ?? dflt);
const lim = (t: TaxTables, code: string) => (code in t.deductionLimits ? t.deductionLimits[code] : undefined);

/** Slab tax on an amount of normal income. */
export function slabTax(slabs: Slab[], income: number): number {
  let tax = 0;
  for (const s of [...slabs].sort((a, b) => a.from - b.from)) {
    if (income <= s.from) break;
    const upper = s.to == null ? income : Math.min(income, s.to);
    tax += (upper - s.from) * s.rate / 100;
  }
  return tax;
}
export const basicExemption = (slabs: Slab[]) => [...slabs].sort((a, b) => a.from - b.from).find((s) => s.rate === 0)?.to ?? 0;
export const marginalRate = (slabs: Slab[], income: number) => [...slabs].sort((a, b) => b.from - a.from).find((s) => income > s.from)?.rate ?? 0;

/** Net capital gains after intra-year set-off: short-term losses against any gain, long-term losses only against long-term gains. */
export function setOffGains(gains: GainItem[]) {
  const net = new Map<string, number>(); const rates = new Map<string, number>();
  for (const g of gains) { const k = `${g.assetClass}|${g.term}|${g.rate ?? ""}`; net.set(k, (net.get(k) ?? 0) + g.amount); if (g.rate != null) rates.set(k, g.rate); }
  const items = [...net.entries()].map(([k, amount]) => { const [assetClass, term] = k.split("|"); return { assetClass, term: term as "short" | "long", amount, rate: rates.get(k) }; });
  let ltLoss = -items.filter((i) => i.term === "long" && i.amount < 0).reduce((s, i) => s + i.amount, 0);
  let stLoss = -items.filter((i) => i.term === "short" && i.amount < 0).reduce((s, i) => s + i.amount, 0);
  const pos = items.filter((i) => i.amount > 0).map((i) => ({ ...i }));
  const absorb = (pool: number, pred: (i: typeof pos[number]) => boolean) => { for (const i of pos) { if (!pred(i) || pool <= 0) continue; const take = Math.min(i.amount, pool); i.amount -= take; pool -= take; } return pool; };
  // losses are applied where they save the most tax: long losses to long gains; short losses to short gains first, then long
  ltLoss = absorb(ltLoss, (i) => i.term === "long");
  stLoss = absorb(stLoss, (i) => i.term === "short");
  stLoss = absorb(stLoss, (i) => i.term === "long");
  const out: GainItem[] = pos.filter((i) => i.amount > 0.005).map((i) => ({ assetClass: i.assetClass, term: i.term, amount: i.amount, ...(i.rate != null ? { rate: i.rate } : {}) }));
  return { gains: out, carriedForward: { short: r2(stLoss), long: r2(ltLoss) } };
}

export function computeTax(t: TaxTables, input: TaxInput): TaxComputation {
  if (!t.slabs.length) throw new Error(`no tax slabs for ${t.entityType} / ${t.regime} / ${t.fy}`);
  const notes: string[] = [];
  const isNew = t.regime === "new";
  // ---- heads ----
  const stdDed = Math.min(input.salary ?? 0, lim(t, "STD_DED") ?? 0);
  const salary = Math.max(0, (input.salary ?? 0) - stdDed);
  const hpPct = p(t, "HP_STD_DED_PCT", 30);
  let hp = 0, hpLoss = 0;
  for (const h of input.houseProperty ?? []) {
    const nav = Math.max(0, h.grossRent - (h.municipalTax ?? 0));
    const income = h.selfOccupied ? -(h.interest ?? 0) : nav - nav * hpPct / 100 - (h.interest ?? 0);
    if (income >= 0) hp += income; else hpLoss += -income;
  }
  // loss from house property sets off against other heads only up to the 24(b) limit, and not at all in the new regime
  const hpCap = isNew ? 0 : (lim(t, "24B") ?? Infinity);
  const hpSetOff = Math.min(hpLoss, hpCap);
  if (hpLoss > hpSetOff) notes.push(`House-property loss of ₹${r0(hpLoss - hpSetOff).toLocaleString("en-IN")} carried forward (set-off capped${isNew ? " at nil in the new regime" : ""})`);
  const houseProperty = hp - hpSetOff;
  const business = input.business ?? 0, other = input.otherSources ?? 0;

  // ---- capital gains: set-off, exemption, slab vs special ----
  const { gains, carriedForward } = setOffGains(input.gains ?? []);
  const rule = (ac: string, term: string) => t.rules.find((r) => r.assetClass === ac && r.term === term);
  let exemptionUsed = 0;
  const specials: { assetClass: string; term: string; amount: number; rate: number; isEquity: boolean }[] = [];
  let slabTaxedGains = 0;
  const cg = { stcg_equity: 0, ltcg_equity: 0, stcg_other: 0, ltcg_other: 0 };
  for (const g of gains) {
    const r = rule(g.assetClass, g.term);
    let amount = g.amount;
    if (g.term === "long" && r && r.exemptionAmount > 0) { const ex = Math.min(amount, Math.max(0, r.exemptionAmount - exemptionUsed)); exemptionUsed += ex; amount -= ex; }
    const eq = g.assetClass === "equity" || g.assetClass === "reit_invit";
    cg[`${g.term === "short" ? "stcg" : "ltcg"}_${eq ? "equity" : "other"}` as keyof typeof cg] += g.amount;
    if (!r) { notes.push(`No tax rule for ${g.assetClass}/${g.term}; taxed at slab`); slabTaxedGains += amount; continue; }
    if (g.rate == null && (r.taxedAtSlab || (r.rate === 0 && g.term === "short"))) slabTaxedGains += amount;
    else if (amount > 0) specials.push({ assetClass: g.assetClass, term: g.term, amount, rate: g.rate ?? r.rate, isEquity: eq });
  }
  const specialIncomeRaw = specials.reduce((s, x) => s + x.amount, 0);
  const grossTotal = salary + houseProperty + business + other + slabTaxedGains + specialIncomeRaw;

  // ---- deductions (Chapter VI-A) against normal income only ----
  const ded: Record<string, number> = {};
  const claimed = input.deductions ?? {};
  const normalBefore = salary + houseProperty + business + other + slabTaxedGains;
  const allowNew = new Set(["80CCD2"]);
  for (const [code, amt] of Object.entries(claimed)) {
    if (!amt || amt <= 0) continue;
    if (isNew && !allowNew.has(code)) continue;
    const l = lim(t, code);
    if (code === "80G") { const cap = normalBefore * p(t, "DED_80G_GTI_CAP_PCT", 10) / 100; ded[code] = r2(Math.min(amt, cap) * p(t, "DED_80G_PCT", 50) / 100); continue; }
    if (code === "80G_100") { ded[code] = r2(amt); continue; }
    ded[code] = l == null ? amt : Math.min(amt, l);
  }
  if (stdDed) ded.STD_DED = stdDed;
  const dedTotal = Object.entries(ded).filter(([k]) => k !== "STD_DED").reduce((s, [, v]) => s + v, 0);
  const normalIncome = Math.max(0, normalBefore - dedTotal);
  const dedUnused = Math.max(0, dedTotal - normalBefore);
  if (dedUnused > 0) notes.push(`₹${r0(dedUnused).toLocaleString("en-IN")} of deductions exceed normal income and lapse`);

  // ---- unused basic exemption absorbs special-rate gains (long-term first) ----
  const be = basicExemption(t.slabs);
  let unusedBe = Math.max(0, be - normalIncome);
  for (const s of [...specials].sort((a, b) => (a.term === "long" ? -1 : 1) - (b.term === "long" ? -1 : 1))) { if (unusedBe <= 0) break; const take = Math.min(s.amount, unusedBe); s.amount -= take; unusedBe -= take; }
  const specialIncome = specials.reduce((s, x) => s + x.amount, 0);
  const totalIncome = normalIncome + specialIncome;

  // ---- tax ----
  let slab = slabTax(t.slabs, normalIncome);
  const special = specials.reduce((s, x) => s + x.amount * x.rate / 100, 0);
  const specialOnGains = special; // all special-rate items here are 111A/112/112A gains
  // 87A rebate on slab tax when total income is within the limit; new-regime marginal relief just above it
  let rebate = 0;
  const rl = p(t, "REBATE_87A_LIMIT"), rm = p(t, "REBATE_87A_MAX");
  if (rl > 0 && totalIncome <= rl) rebate = Math.min(slab, rm);
  else if (rl > 0 && p(t, "REBATE_87A_MARGINAL_RELIEF") && specialIncome === 0 && slab > totalIncome - rl) { rebate = slab - (totalIncome - rl); notes.push("87A marginal relief: tax limited to the income above the rebate threshold"); }
  const taxBefore = slab + special - rebate;
  // surcharge by total income, capped on capital-gains tax, with marginal relief at the band threshold
  const band = [...t.surcharge].sort((a, b) => b.incomeFrom - a.incomeFrom).find((b) => totalIncome > b.incomeFrom);
  let surcharge = 0;
  if (band) {
    const onGains = Math.min(band.rate, band.cappedOnGainsPct ?? band.rate);
    surcharge = (slab - rebate) * band.rate / 100 + specialOnGains * onGains / 100;
    // marginal relief: tax + surcharge may not exceed the tax at the threshold (previous band's surcharge) plus the excess income
    const prev = t.surcharge.filter((b) => b.incomeFrom < band.incomeFrom).sort((a, b) => b.incomeFrom - a.incomeFrom)[0];
    const taxAt = slabTax(t.slabs, band.incomeFrom) * (1 + (prev ? prev.rate / 100 : 0));
    const excess = totalIncome - band.incomeFrom;
    if (taxBefore + surcharge > taxAt + excess) { surcharge = Math.max(0, taxAt + excess - taxBefore); notes.push(`Surcharge marginal relief applied at the ₹${(band.incomeFrom / 1e5).toFixed(0)} L threshold`); }
  }
  const cess = (taxBefore + surcharge) * p(t, "CESS_PCT") / 100;
  const total = Math.max(0, r0(taxBefore + surcharge + cess));

  // ---- advance tax and interest ----
  const tds = input.tdsCredit ?? 0;
  const netPayable = Math.max(0, total - tds);
  const fyStart = Number(t.fy.slice(0, 4));
  const dues = [["ADV_Q1_PCT", `${fyStart}-06-15`, 3], ["ADV_Q2_PCT", `${fyStart}-09-15`, 3], ["ADV_Q3_PCT", `${fyStart}-12-15`, 3], ["ADV_Q4_PCT", `${fyStart + 1}-03-15`, 1]] as const;
  const paid = [...(input.advanceTaxPaid ?? [])].sort((a, b) => a.date.localeCompare(b.date));
  const instalments: Instalment[] = []; let i234c = 0;
  const applies = netPayable >= p(t, "ADV_TAX_THRESHOLD", 0);
  for (const [code, due, months] of dues) {
    const pct = p(t, code); const amount = applies ? r0(netPayable * pct / 100) : 0;
    const cum = paid.filter((x) => x.date <= due).reduce((s, x) => s + x.amount, 0);
    const shortfall = Math.max(0, amount - cum);
    const interest = applies ? r0(shortfall * p(t, "INT_234C_PCT_PM") / 100 * months) : 0;
    i234c += interest;
    instalments.push({ due, cumulative_pct: pct, amount, paid: r2(cum), shortfall: r2(shortfall), interest });
  }
  const paidByYearEnd = paid.filter((x) => x.date <= `${fyStart + 1}-03-31`).reduce((s, x) => s + x.amount, 0);
  let i234b = 0;
  if (applies && paidByYearEnd < netPayable * p(t, "INT_234B_MIN_PAID_PCT", 90) / 100) {
    const months = input.asOf ? Math.max(1, (Number(input.asOf.slice(0, 4)) - (fyStart + 1)) * 12 + Number(input.asOf.slice(5, 7)) - 3) : p(t, "INT_234B_MONTHS", 4);
    i234b = r0((netPayable - paidByYearEnd) * p(t, "INT_234B_PCT_PM") / 100 * months);
  }

  return {
    fy: t.fy, regime: t.regime, entityType: t.entityType,
    heads: { salary: r2(salary), house_property: r2(houseProperty), business: r2(business), capital_gains: { stcg_equity: r2(cg.stcg_equity), ltcg_equity: r2(cg.ltcg_equity), stcg_other: r2(cg.stcg_other), ltcg_other: r2(cg.ltcg_other), exemption_used: r2(exemptionUsed), slab_taxed: r2(slabTaxedGains), special_taxed: r2(specialIncome) }, other_sources: r2(other), gross_total: r2(grossTotal) },
    deductions: Object.fromEntries(Object.entries(ded).map(([k, v]) => [k, r2(v)])), deductions_total: r2(dedTotal),
    taxable_income: r2(totalIncome), normal_income: r2(normalIncome), special_income: r2(specialIncome),
    losses_carried_forward: carriedForward,
    tax: { slab: r2(slab), special_rate: r2(special), rebate: r2(rebate), surcharge: r2(surcharge), cess: r2(cess), total },
    tds_credit: r2(tds), net_payable: r2(netPayable),
    advance_tax: instalments, interest_234: i234b + i234c, interest_234b: i234b, interest_234c: i234c,
    effective_rate_pct: totalIncome > 0 ? r2((total / totalIncome) * 100) : 0, marginal_rate_pct: marginalRate(t.slabs, normalIncome), basic_exemption: be,
    notes,
  };
}

/** Old vs new for the same facts: deductions apply only where the regime allows them. */
export function compareRegimes(oldT: TaxTables, newT: TaxTables, input: TaxInput) {
  const o = computeTax(oldT, input), n = computeTax(newT, input);
  const saving = r2(Math.abs(o.tax.total - n.tax.total));
  return { old: o, new: n, recommended: (o.tax.total < n.tax.total ? "old" : "new") as "old" | "new", saving, notes: [...(o.tax.total < n.tax.total ? [`Old regime saves ₹${saving.toLocaleString("en-IN")} because deductions of ₹${o.deductions_total.toLocaleString("en-IN")} outweigh the wider new slabs`] : [`New regime saves ₹${saving.toLocaleString("en-IN")} with these deductions`])] };
}
