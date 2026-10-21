import { describe, it, expect } from "vitest";
import { simulate, type SimState, type TablesProvider, type SimAction } from "../src/index.js";

const NEW = [{ from: 0, to: 400000, rate: 0 }, { from: 400000, to: 800000, rate: 5 }, { from: 800000, to: 1200000, rate: 10 }, { from: 1200000, to: 1600000, rate: 15 }, { from: 1600000, to: 2000000, rate: 20 }, { from: 2000000, to: 2400000, rate: 25 }, { from: 2400000, to: null, rate: 30 }];
const OLD = [{ from: 0, to: 250000, rate: 0 }, { from: 250000, to: 500000, rate: 5 }, { from: 500000, to: 1000000, rate: 20 }, { from: 1000000, to: null, rate: 30 }];
const RULES = [
  { assetClass: "equity", term: "short" as const, rate: 20, taxedAtSlab: false, exemptionAmount: 0, holdingMonthsForLong: 12 }, { assetClass: "equity", term: "long" as const, rate: 12.5, taxedAtSlab: false, exemptionAmount: 125000, holdingMonthsForLong: 12 },
  { assetClass: "listed_bond", term: "short" as const, rate: 0, taxedAtSlab: true, exemptionAmount: 0, holdingMonthsForLong: 12 }, { assetClass: "listed_bond", term: "long" as const, rate: 12.5, taxedAtSlab: false, exemptionAmount: 0, holdingMonthsForLong: 12 },
  { assetClass: "real_estate", term: "short" as const, rate: 0, taxedAtSlab: true, exemptionAmount: 0, holdingMonthsForLong: 24 }, { assetClass: "real_estate", term: "long" as const, rate: 12.5, taxedAtSlab: false, exemptionAmount: 0, holdingMonthsForLong: 24 },
  { assetClass: "unlisted_equity", term: "long" as const, rate: 12.5, taxedAtSlab: false, exemptionAmount: 0, holdingMonthsForLong: 24 }, { assetClass: "unlisted_equity", term: "short" as const, rate: 0, taxedAtSlab: true, exemptionAmount: 0, holdingMonthsForLong: 24 },
];
const PARAMS = { CESS_PCT: 4, HP_STD_DED_PCT: 30, ADV_Q1_PCT: 15, ADV_Q2_PCT: 45, ADV_Q3_PCT: 75, ADV_Q4_PCT: 100, ADV_TAX_THRESHOLD: 10000, INT_234B_PCT_PM: 1, INT_234C_PCT_PM: 1, INT_234B_MIN_PAID_PCT: 90, INT_234B_MONTHS: 4, DED_80G_PCT: 50, DED_80G_GTI_CAP_PCT: 10, SEC54EC_MONTHS: 6, SEC54EC_LOCK_YEARS: 5, PROPERTY_INDEXATION_CUTOFF: 20240723, PROPERTY_INDEXED_RATE_PCT: 20 };
const tables: TablesProvider = (fy, regime, entityType) => {
  if (!["individual", "huf"].includes(entityType)) throw new Error(`no tax slabs for ${entityType}`);
  return { fy, regime, entityType, slabs: regime === "new" ? NEW : OLD, surcharge: [{ incomeFrom: 5000000, rate: 10, cappedOnGainsPct: 15 }],
    deductionLimits: regime === "new" ? { STD_DED: 75000, "54EC": 5000000 } : { STD_DED: 50000, "80C": 150000, "80CCD1B": 50000, "80D": 25000, "24B": 200000, "54EC": 5000000 },
    params: regime === "new" ? { ...PARAMS, REBATE_87A_LIMIT: 1200000, REBATE_87A_MAX: 60000, REBATE_87A_MARGINAL_RELIEF: 1 } : { ...PARAMS, REBATE_87A_LIMIT: 500000, REBATE_87A_MAX: 12500, REBATE_87A_MARGINAL_RELIEF: 0 }, rules: RULES };
};
const CII = { "2020-21": 301, "2024-25": 363, "2025-26": 376, "2026-27": 389, "2027-28": 402, "2028-29": 416 };
const ARJUN = "e1", HUF = "e2", SPOUSE = "e3";
const state = (): SimState => ({
  asOf: "2026-09-12",
  entities: [{ id: ARJUN, name: "Arjun", type: "individual", regime: "new" }, { id: HUF, name: "HUF", type: "huf", regime: "new" }, { id: SPOUSE, name: "Spouse", type: "individual", regime: "new" }],
  holdings: [
    { id: "h-tcs", entityId: SPOUSE, instrumentId: "i-tcs", name: "TCS", assetClass: "equity", bucket: "growth", price: 3800, lots: [{ id: "l1", buyDate: "2023-05-22", quantity: 300, remainingQty: 300, unitCost: 3044.44, charges: 0 }] },
    { id: "h-axis", entityId: HUF, instrumentId: "i-axis", name: "Axis Small Cap", assetClass: "equity", bucket: "growth", price: 110, lots: [{ id: "l2", buyDate: "2025-11-02", quantity: 1000, remainingQty: 1000, unitCost: 116.5, charges: 0 }] },
    { id: "h-bond", entityId: SPOUSE, instrumentId: "i-bond", name: "SBI bond", assetClass: "listed_bond", bucket: "income", price: 1020, lots: [{ id: "l3", buyDate: "2024-01-09", quantity: 100, remainingQty: 100, unitCost: 1000, charges: 0 }] },
  ],
  properties: [{ id: "p-anna", name: "Anna Nagar", entityId: SPOUSE, ownershipPct: 100, value: 3600000, cost: 2000000, acquisitionDate: "2020-11-10", annualRentGross: 240000, municipalTax: 3600, interest: 0, selfOccupied: false }],
  privates: [{ id: "pv1", entityId: ARJUN, name: "Cropsense", cost: 50000, mark: 121000, investedOn: "2023-06-15", bucket: "growth" }],
  cash: { [ARJUN]: 300000, [HUF]: 150000, [SPOUSE]: 200000 },
  incomes: [{ entityId: ARJUN, kind: "fees", annual: 1800000, growthPct: 5 }, { entityId: SPOUSE, kind: "interest", annual: 60000, growthPct: 0 }],
  deductions: [], advancePaid: [{ entityId: ARJUN, fy: "2026-27", date: "2026-06-14", amount: 20000 }], tds: [], realised: [{ entityId: ARJUN, fy: "2026-27", assetClass: "equity", term: "long", amount: 11000, sellDate: "2026-07-04" }],
  goals: [{ id: "g1", name: "Retirement", targetYear: 2036, amountToday: 9500000, inflationPct: 6, bucket: "income", linkedHoldingIds: ["h-bond"], linkedPropertyIds: ["p-anna"], linkedPrivateIds: [] }],
  targets: { liquidity: 8, income: 32, growth: 60, driftThresholdPp: 1.5 },
  commitments: [{ entityId: HUF, date: "2026-10-14", amount: 200000, label: "drawdown" }],
  liabilities: [{ entityId: ARJUN, outstanding: 1000000, ratePct: 8.5, section: "24b" }],
});
const A = { returns: { liquidity: 6.5, income: 8, growth: 12 }, inflation: 6 };
const act = (seq: number, kind: string, extra: Partial<SimAction> = {}): SimAction => ({ id: `a${seq}`, seq, kind, params: {}, plannedDate: "2026-10-01", ...extra });

describe("baseline", () => {
  it("projects tax for every entity and FY, allocation, goals and a cash ladder; deterministic", () => {
    const r1 = simulate(state(), [], A, tables, { horizonFys: 2, cii: CII }), r2 = simulate(state(), [], A, tables, { horizonFys: 2, cii: CII });
    expect(r1).toEqual(r2);
    expect(r1.fys).toEqual(["2026-27", "2027-28"]); expect(r1.by_fy.length).toBe(6);
    const arjun = r1.by_fy.find((x) => x.entity_id === ARJUN && x.fy === "2026-27")!;
    expect(arjun.heads.business).toBe(1800000); expect(arjun.heads.capital_gains.ltcg_equity).toBe(11000); expect(arjun.heads.capital_gains.exemption_used).toBe(11000); expect(arjun.tax.total).toBe(166400); // slab 1,60,000 on ₹18 L of fees + 4% cess; the ₹11,000 gain sits inside the exemption
    const spouse = r1.by_fy.find((x) => x.entity_id === SPOUSE && x.fy === "2026-27")!;
    expect(spouse.heads.house_property).toBe(r1.by_fy[2].heads.house_property); expect(spouse.heads.house_property).toBeCloseTo((240000 - 3600) * 0.7, 0);
    expect(r1.allocation_after.map((x) => x.bucket)).toEqual(["liquidity", "income", "growth"]); expect(r1.allocation_after.reduce((s, x) => s + x.pct, 0)).toBeCloseTo(100, 0);
    expect(r1.goals_after[0].funded_pct).toBeGreaterThan(0); expect(r1.cash_ladder.length).toBeGreaterThan(12); expect(r1.cash_ladder[0].month).toBe("2026-09");
    expect(r1.summary.net_worth_end).toBeGreaterThan(r1.summary.net_worth_start * 0.9); expect(r1.summary.tax_vs_baseline).toBeNull();
    expect(r1.action_effects).toEqual({});
  });
});

describe("actions", () => {
  it("sell_holding books FIFO gains in the FY of the sale and credits cash; a short-term lot near the threshold warns", () => {
    const r = simulate(state(), [act(1, "sell_holding", { targetId: "h-tcs", entityId: SPOUSE, params: { quantity: 40, price: 3800 }, plannedDate: "2026-11-01" })], A, tables, { horizonFys: 2 });
    const e = r.action_effects.a1; expect(e.gain).toBeCloseTo(40 * (3800 - 3044.44), 0); expect(e.term).toBe("long"); expect(e.cash).toBe(152000); expect(e.tax).toBeCloseTo(e.gain * 0.125, 0);
    const sp = r.by_fy.find((x) => x.entity_id === SPOUSE && x.fy === "2026-27")!; expect(sp.heads.capital_gains.ltcg_equity).toBeCloseTo(e.gain, 0); expect(sp.tax.total).toBe(0); // within the 1.25 L exemption
    const near = simulate({ ...state(), holdings: [{ id: "h", entityId: SPOUSE, instrumentId: "i", name: "Recent", assetClass: "equity", bucket: "growth", price: 200, lots: [{ id: "l", buyDate: "2025-12-01", quantity: 10, remainingQty: 10, unitCost: 100, charges: 0 }] }] }, [act(1, "sell_holding", { targetId: "h", params: { quantity: 10 }, plannedDate: "2026-10-15" })], A, tables, {});
    expect(near.action_effects.a1.term).toBe("short"); expect(near.action_effects.a1.warnings.join()).toMatch(/turns long-term on 2026-12-01/);
  });
  it("harvest_loss offsets a booked gain; book_gain_within_exemption sizes the sale to the headroom; defer moves it to the next FY", () => {
    const r = simulate(state(), [act(1, "harvest_loss", { targetId: "h-axis", entityId: HUF, params: { quantity: 1000, price: 110 }, plannedDate: "2026-09-20" }), act(2, "book_gain_within_exemption", { targetId: "h-tcs", entityId: SPOUSE, params: { price: 3800 }, plannedDate: "2027-03-20" }), act(3, "defer_sale_to_fy", { targetId: "h-tcs", entityId: SPOUSE, params: { quantity: 20, fy: "2027-28", price: 3800 }, plannedDate: "2027-03-25" })], A, tables, { horizonFys: 2 });
    expect(r.action_effects.a1.gain).toBe(-6500); expect(r.action_effects.a1.term).toBe("short");
    const huf = r.by_fy.find((x) => x.entity_id === HUF && x.fy === "2026-27")!; expect(huf.losses_carried_forward.short).toBe(6500); // no gain to absorb it in the HUF
    const booked = r.action_effects.a2; expect(booked.gain).toBeGreaterThan(120000); expect(booked.gain).toBeLessThanOrEqual(125000);
    const sp27 = r.by_fy.find((x) => x.entity_id === SPOUSE && x.fy === "2026-27")!; expect(sp27.heads.capital_gains.exemption_used).toBeCloseTo(booked.gain, 0); expect(sp27.tax.special_rate).toBe(0);
    expect(r.action_effects.a3.detail).toMatch(/deferred to 2027-04-01/);
    const sp28 = r.by_fy.find((x) => x.entity_id === SPOUSE && x.fy === "2027-28")!; expect(sp28.heads.capital_gains.ltcg_equity).toBeGreaterThan(0);
  });
  it("sell_property picks the lower of plain and indexed tax, stops rent, and 54EC shelters the gain inside the window", () => {
    const plan = [act(1, "change_rent", { targetId: "p-anna", entityId: SPOUSE, params: { note: "do not renew; vacate" }, plannedDate: "2026-11-30" }), act(2, "sell_property", { targetId: "p-anna", entityId: SPOUSE, params: { price: 3700000, brokerage_pct: 1 }, plannedDate: "2027-01-15" }), act(3, "reinvest_54ec", { entityId: SPOUSE, params: { amount: 850000, issuer: "REC" }, plannedDate: "2027-03-31" })];
    const r = simulate(state(), plan, A, tables, { horizonFys: 2, cii: CII });
    const sale = r.action_effects.a2; const net = 3700000 * 0.99;
    const plainGain = net - 2000000, indexedGain = net - 2000000 * 389 / 301;
    expect(sale.gain).toBeCloseTo(Math.min(plainGain * 12.5, indexedGain * 20) === indexedGain * 20 ? indexedGain : plainGain, 0); expect(sale.term).toBe("long"); expect(sale.cash).toBeCloseTo(net, 0);
    expect(sale.warnings.join()).toMatch(/54EC bonds must be bought within 6 months \(by 2027-07-15\)/);
    expect(r.action_effects.a1.warnings.join()).toMatch(/rent of ₹20,000\/month stops from 2026-11-30/); expect(sale.warnings.join()).not.toMatch(/rent of/); // the vacate action already said so
    expect(r.action_effects.a3.warnings.join()).toMatch(/sheltered/); expect(r.action_effects.a3.tax).toBeLessThan(0);
    const sp = r.by_fy.find((x) => x.entity_id === SPOUSE && x.fy === "2026-27")!;
    expect(sp.heads.capital_gains.ltcg_other).toBeCloseTo(sale.gain - 850000, 0); // gain net of the 54EC exemption reaches the computation
    expect(sp.heads.house_property).toBe((240000 * 8 / 12 - 3600) * 0.7); // April–November rent, the full year's municipal tax
    const sp28 = r.by_fy.find((x) => x.entity_id === SPOUSE && x.fy === "2027-28")!; expect(sp28.heads.house_property).toBe(0);
    expect(r.allocation_after.find((x) => x.bucket === "income")!.value).toBeGreaterThan(0); expect(r.warnings.some((w) => /Bucket drift/.test(w))).toBe(true);
    const late = simulate(state(), [plan[1], { ...plan[2], plannedDate: "2027-09-01" }], A, tables, { horizonFys: 2, cii: CII });
    expect(late.action_effects.a3.warnings.join()).toMatch(/outside the 6-month 54EC window/); expect(late.action_effects.a3.tax).toBe(0);
  });
  it("transfer_to_entity warns about clubbing; change_tax_regime and contribute_ppf change the HUF computation", () => {
    const r = simulate(state(), [act(1, "transfer_to_entity", { entityId: ARJUN, targetId: HUF, params: { monthly: 20000 }, plannedDate: "2026-10-10" }), act(2, "change_tax_regime", { entityId: HUF, targetId: HUF, params: { regime: "old", fy: "2026-27" } }), act(3, "contribute_ppf", { entityId: HUF, params: { amount: 150000 }, plannedDate: "2027-03-25" })], A, tables, { horizonFys: 2 });
    expect(r.action_effects.a1.warnings.join()).toMatch(/s\.64 clubbing/); expect(r.action_effects.a1.detail).toMatch(/2,40,000/);
    const huf = r.by_fy.find((x) => x.entity_id === HUF && x.fy === "2026-27")!; expect(huf.regime).toBe("old"); expect(huf.deductions["80C"]).toBe(150000);
    expect(r.by_fy.find((x) => x.entity_id === HUF && x.fy === "2027-28")!.regime).toBe("new");
    const onNew = simulate(state(), [act(3, "contribute_ppf", { entityId: HUF, params: { amount: 150000 } })], A, tables, { horizonFys: 1 });
    expect(onNew.action_effects.a3.warnings.join()).toMatch(/new regime.*80C gives no deduction/); expect(onNew.action_effects.a3.tax).toBe(0);
  });
  it("buy / deploy_cash / switch / exit_private / donate / prepay / custom each move cash and warn when cash runs out", () => {
    const r = simulate(state(), [
      act(1, "deploy_cash", { entityId: HUF, params: { amount: 100000, name: "Liquid fund", bucket: "liquidity", asset_class: "debt_mf_post_apr23" } }),
      act(2, "switch", { targetId: "h-bond", entityId: SPOUSE, params: { quantity: 50, to_instrument_id: "i-tcs" } }),
      act(3, "exit_private", { targetId: "pv1", entityId: ARJUN, params: { proceeds: 150000 }, plannedDate: "2026-12-01" }),
      act(4, "donate_80g", { entityId: ARJUN, params: { amount: 40000 } }),
      act(5, "prepay_loan", { entityId: ARJUN, params: { amount: 200000 } }),
      act(6, "custom", { entityId: SPOUSE, params: { amount: 50000, tax_head: "other", note: "consulting" } }),
      act(7, "buy_instrument", { entityId: HUF, params: { amount: 500000, name: "Too big" }, plannedDate: "2026-10-02" }),
    ], A, tables, { horizonFys: 1 });
    expect(r.action_effects.a1.cash).toBe(-100000); expect(r.action_effects.a2.cash).toBe(0); expect(r.action_effects.a2.detail).toMatch(/reinvested/);
    expect(r.action_effects.a3.gain).toBe(100000); expect(r.action_effects.a3.term).toBe("long");
    expect(r.action_effects.a4.warnings.join()).toMatch(/80G gives no deduction/);
    expect(r.action_effects.a5.warnings.join()).toMatch(/interest saved ≈ ₹17,000/);
    expect(r.by_fy.find((x) => x.entity_id === SPOUSE)!.heads.other_sources).toBe(110000);
    expect(r.action_effects.a7.warnings.join()).toMatch(/cash goes negative/);
    expect(r.warnings.some((w) => /Cash goes negative/.test(w))).toBe(true);
  });
  it("unknown kinds and missing targets become warnings rather than failures", () => {
    const r = simulate(state(), [act(1, "sell_holding", { targetId: "nope" }), act(2, "teleport")], A, tables, { horizonFys: 1 });
    expect(r.action_effects.a1.warnings[0]).toMatch(/holding not found/); expect(r.action_effects.a2.warnings[0]).toMatch(/unsupported action kind/);
  });
});
