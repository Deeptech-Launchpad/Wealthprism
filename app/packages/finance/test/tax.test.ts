import { describe, it, expect } from "vitest";
import { computeTax, compareRegimes, setOffGains, slabTax, type TaxTables, type TaxInput } from "../src/index.js";

// FY 2026-27 tables as seeded in db/003 and db/018 (illustrative Finance Act values)
const NEW = [{ from: 0, to: 400000, rate: 0 }, { from: 400000, to: 800000, rate: 5 }, { from: 800000, to: 1200000, rate: 10 }, { from: 1200000, to: 1600000, rate: 15 }, { from: 1600000, to: 2000000, rate: 20 }, { from: 2000000, to: 2400000, rate: 25 }, { from: 2400000, to: null, rate: 30 }];
const OLD = [{ from: 0, to: 250000, rate: 0 }, { from: 250000, to: 500000, rate: 5 }, { from: 500000, to: 1000000, rate: 20 }, { from: 1000000, to: null, rate: 30 }];
const SUR = [{ incomeFrom: 5000000, rate: 10, cappedOnGainsPct: 15 }, { incomeFrom: 10000000, rate: 15, cappedOnGainsPct: 15 }, { incomeFrom: 20000000, rate: 25, cappedOnGainsPct: 15 }];
const RULES = [
  { assetClass: "equity", term: "short" as const, rate: 20, taxedAtSlab: false, exemptionAmount: 0, holdingMonthsForLong: 12 }, { assetClass: "equity", term: "long" as const, rate: 12.5, taxedAtSlab: false, exemptionAmount: 125000, holdingMonthsForLong: 12 },
  { assetClass: "debt_mf_post_apr23", term: "short" as const, rate: 0, taxedAtSlab: true, exemptionAmount: 0, holdingMonthsForLong: 9999 },
  { assetClass: "listed_bond", term: "short" as const, rate: 0, taxedAtSlab: true, exemptionAmount: 0, holdingMonthsForLong: 12 }, { assetClass: "listed_bond", term: "long" as const, rate: 12.5, taxedAtSlab: false, exemptionAmount: 0, holdingMonthsForLong: 12 },
  { assetClass: "real_estate", term: "long" as const, rate: 12.5, taxedAtSlab: false, exemptionAmount: 0, holdingMonthsForLong: 24 },
];
const PARAMS = { CESS_PCT: 4, HP_STD_DED_PCT: 30, ADV_Q1_PCT: 15, ADV_Q2_PCT: 45, ADV_Q3_PCT: 75, ADV_Q4_PCT: 100, ADV_TAX_THRESHOLD: 10000, INT_234B_PCT_PM: 1, INT_234C_PCT_PM: 1, INT_234B_MIN_PAID_PCT: 90, INT_234B_MONTHS: 4, DED_80G_PCT: 50, DED_80G_GTI_CAP_PCT: 10 };
const T = (regime: "old" | "new", entityType = "individual"): TaxTables => ({
  fy: "2026-27", regime, entityType, slabs: regime === "new" ? NEW : OLD, surcharge: regime === "old" ? [...SUR, { incomeFrom: 50000000, rate: 37, cappedOnGainsPct: 15 }] : SUR,
  deductionLimits: regime === "new" ? { STD_DED: 75000, "80CCD2": null, "24B": 0, "54EC": 5000000 } : { STD_DED: 50000, "80C": 150000, "80CCD1B": 50000, "80D": 25000, "24B": 200000, "80G": null, "80TTA": 10000, "54EC": 5000000 },
  params: regime === "new" ? { ...PARAMS, REBATE_87A_LIMIT: 1200000, REBATE_87A_MAX: 60000, REBATE_87A_MARGINAL_RELIEF: 1 } : { ...PARAMS, REBATE_87A_LIMIT: 500000, REBATE_87A_MAX: 12500, REBATE_87A_MARGINAL_RELIEF: 0 },
  rules: RULES,
});
const tax = (t: TaxTables, i: TaxInput) => computeTax(t, i).tax;

describe("slabs and rebate", () => {
  it("A: new regime, ₹10 L salary is fully rebated", () => { const r = computeTax(T("new"), { salary: 1000000 }); expect(r.heads.salary).toBe(925000); expect(r.tax.slab).toBe(32500); expect(r.tax.rebate).toBe(32500); expect(r.tax.total).toBe(0); });
  it("B: new regime, ₹15 L salary", () => { const r = tax(T("new"), { salary: 1500000 }); expect(r.slab).toBe(93750); expect(r.cess).toBe(3750); expect(r.total).toBe(97500); });
  it("C: old regime, ₹15 L salary with 80C and 80D", () => { const r = computeTax(T("old"), { salary: 1500000, deductions: { "80C": 200000, "80D": 25000 } }); expect(r.deductions["80C"]).toBe(150000); expect(r.taxable_income).toBe(1275000); expect(r.tax.total).toBe(202800); });
  it("D: new regime, ₹12.5 L salary lands under the rebate limit after standard deduction", () => { expect(tax(T("new"), { salary: 1250000 }).total).toBe(0); });
  it("E: new regime marginal relief just above ₹12 L", () => { const r = computeTax(T("new"), { salary: 1280000 }); expect(r.tax.slab).toBe(60750); expect(r.tax.rebate).toBe(55750); expect(r.tax.total).toBe(5200); expect(r.notes.join()).toMatch(/marginal relief/); });
  it("V: old regime rebate up to ₹5 L", () => { expect(tax(T("old"), { salary: 530000 }).total).toBe(0); expect(tax(T("old"), { salary: 560000 }).total).toBe(15080); });
  it("Y: reports marginal and effective rates", () => { const r = computeTax(T("new"), { salary: 1500000 }); expect(r.marginal_rate_pct).toBe(15); expect(r.effective_rate_pct).toBeCloseTo(6.84, 1); expect(r.basic_exemption).toBe(400000); });
  it("W: entity types without slab tables are rejected", () => { expect(() => computeTax({ ...T("new", "company"), slabs: [] }, { salary: 1 })).toThrow(/no tax slabs/); });
});

describe("house property", () => {
  it("F: HUF rent under the basic exemption", () => { const r = computeTax(T("old", "huf"), { houseProperty: [{ grossRent: 34200 }] }); expect(r.heads.house_property).toBe(23940); expect(r.tax.total).toBe(0); });
  it("S: municipal tax, 30% and interest", () => { const r = computeTax(T("old"), { houseProperty: [{ grossRent: 600000, municipalTax: 20000, interest: 300000 }] }); expect(r.heads.house_property).toBe(106000); });
  it("T: self-occupied interest loss is capped in the old regime and disallowed in the new", () => {
    const o = computeTax(T("old"), { salary: 1500000, houseProperty: [{ grossRent: 0, interest: 300000, selfOccupied: true }] }); expect(o.heads.house_property).toBe(-200000); expect(o.notes.join()).toMatch(/carried forward/);
    const n = computeTax(T("new"), { salary: 1500000, houseProperty: [{ grossRent: 0, interest: 300000, selfOccupied: true }] }); expect(n.heads.house_property).toBe(0);
  });
  it("U: HUF on the new regime uses the same slabs", () => { expect(tax(T("new", "huf"), { houseProperty: [{ grossRent: 2400000 }] }).total).toBe(141440); });
});

describe("capital gains", () => {
  it("G: LTCG alone is sheltered by the exemption and the unused basic exemption", () => { const r = computeTax(T("new"), { gains: [{ assetClass: "equity", term: "long", amount: 300000 }] }); expect(r.heads.capital_gains.exemption_used).toBe(125000); expect(r.special_income).toBe(0); expect(r.tax.total).toBe(0); });
  it("H: salary plus LTCG — rebate applies to slab tax only", () => { const r = computeTax(T("new"), { salary: 900000, gains: [{ assetClass: "equity", term: "long", amount: 300000 }] }); expect(r.tax.special_rate).toBe(21875); expect(r.tax.rebate).toBe(22500); expect(r.tax.total).toBe(22750); });
  it("I: STCG 111A at 20% beside salary", () => { expect(tax(T("new"), { salary: 2000000, gains: [{ assetClass: "equity", term: "short", amount: 200000 }] }).total).toBe(234000); });
  it("O: debt-fund gains are slab income", () => { const r = computeTax(T("new"), { salary: 1500000, gains: [{ assetClass: "debt_mf_post_apr23", term: "short", amount: 100000 }] }); expect(r.heads.capital_gains.slab_taxed).toBe(100000); expect(r.tax.total).toBe(113100); });
  it("P: short-term loss offsets long-term gain before the exemption", () => { const r = computeTax(T("new"), { salary: 900000, gains: [{ assetClass: "equity", term: "short", amount: -50000 }, { assetClass: "equity", term: "long", amount: 300000 }] }); expect(r.tax.special_rate).toBe(15625); expect(r.tax.total).toBe(16250); });
  it("Q: long-term loss cannot offset short-term gain and is carried forward", () => { const r = computeTax(T("new"), { salary: 1500000, gains: [{ assetClass: "equity", term: "long", amount: -50000 }, { assetClass: "equity", term: "short", amount: 100000 }] }); expect(r.tax.special_rate).toBe(20000); expect(r.losses_carried_forward).toEqual({ short: 0, long: 50000 }); });
  it("set-off pools losses across classes by term", () => { const s = setOffGains([{ assetClass: "equity", term: "long", amount: -30000 }, { assetClass: "listed_bond", term: "long", amount: 20000 }, { assetClass: "equity", term: "short", amount: 5000 }]); expect(s.gains).toEqual([{ assetClass: "equity", term: "short", amount: 5000 }]); expect(s.carriedForward.long).toBe(10000); });
});

describe("deductions", () => {
  it("R: 80G is 50% of the amount within 10% of gross total income", () => { const r = computeTax(T("old"), { salary: 1050000, deductions: { "80G": 100000 } }); expect(r.deductions["80G"]).toBe(50000); });
  it("new regime ignores Chapter VI-A except employer NPS", () => { const r = computeTax(T("new"), { salary: 1500000, deductions: { "80C": 150000, "80CCD2": 60000 } }); expect(r.deductions["80C"]).toBeUndefined(); expect(r.deductions["80CCD2"]).toBe(60000); });
  it("N: regime comparison — old wins only when deductions are large; a fully-rebated HUF is a tie that defaults to new", () => {
    const huf = compareRegimes(T("old", "huf"), T("new", "huf"), { houseProperty: [{ grossRent: 900000 }], deductions: { "80C": 150000 } });
    expect(huf.old.taxable_income).toBe(480000); expect(huf.old.tax.total).toBe(0); expect(huf.new.tax.total).toBe(0); expect(huf.recommended).toBe("new");
    const heavy = compareRegimes(T("old"), T("new"), { salary: 2000000, houseProperty: [{ grossRent: 0, interest: 200000, selfOccupied: true }], deductions: { "80C": 150000, "80CCD1B": 50000, "80D": 25000, "80G_100": 300000 } });
    expect(heavy.old.taxable_income).toBe(1225000); expect(heavy.old.tax.total).toBe(187200); expect(heavy.new.tax.total).toBe(192400); expect(heavy.recommended).toBe("old"); expect(heavy.saving).toBe(5200);
    expect(compareRegimes(T("old"), T("new"), { salary: 1500000 }).recommended).toBe("new");
  });
});

describe("surcharge", () => {
  it("J: 10% band with cess", () => { const r = tax(T("new"), { salary: 6000000 }); expect(r.slab).toBe(1357500); expect(r.surcharge).toBe(135750); expect(r.total).toBe(1552980); });
  it("K: marginal relief just above ₹50 L", () => { const r = computeTax(T("new"), { salary: 5080000 }); expect(r.tax.surcharge).toBe(3500); expect(r.tax.total).toBe(1128400); expect(r.notes.join()).toMatch(/Surcharge marginal relief/); });
  it("L: surcharge on LTCG capped at 15% inside the 25% band", () => { const r = computeTax(T("new"), { salary: 25000000, gains: [{ assetClass: "equity", term: "long", amount: 1000000 }] }); expect(r.tax.slab).toBe(7057500); expect(r.tax.special_rate).toBe(109375); expect(r.tax.surcharge).toBe(1780781.25); expect(r.tax.total).toBe(9305563); });
  it("below the first band there is no surcharge", () => { expect(tax(T("new"), { salary: 5000000 }).surcharge).toBe(0); });
});

describe("advance tax and interest", () => {
  it("M: instalment shortfalls accrue 234C; 234B when under 90% by year end", () => {
    const paid = [{ date: "2026-06-10", amount: 10000 }, { date: "2026-09-10", amount: 20000 }, { date: "2026-12-10", amount: 30000 }, { date: "2027-03-10", amount: 30000 }];
    const r = computeTax(T("new"), { salary: 1600000, advanceTaxPaid: paid, tdsCredit: 3100 });
    expect(r.tax.total).toBe(113100); expect(r.net_payable).toBe(110000);
    expect(r.advance_tax.map((i) => [i.amount, i.paid, i.shortfall, i.interest])).toEqual([[16500, 10000, 6500, 195], [49500, 30000, 19500, 585], [82500, 60000, 22500, 675], [110000, 90000, 20000, 200]]);
    expect(r.interest_234c).toBe(1655); expect(r.interest_234b).toBe(800); expect(r.interest_234).toBe(2455);
  });
  it("no advance tax below the threshold, none when 90% is paid", () => {
    const small = computeTax(T("new"), { salary: 1300000 }); expect(small.tax.total).toBe(26000); expect(small.advance_tax[3].amount).toBe(26000); expect(small.advance_tax[0].amount).toBe(3900);
    const tiny = computeTax(T("old", "huf"), { houseProperty: [{ grossRent: 34200 }] }); expect(tiny.advance_tax.every((i) => i.amount === 0 && i.interest === 0)).toBe(true);
    const ok = computeTax(T("new"), { salary: 1600000, advanceTaxPaid: [{ date: "2026-06-01", amount: 113100 }] }); expect(ok.interest_234).toBe(0);
  });
  it("X: TDS credit shrinks the advance-tax base under the threshold", () => { const r = computeTax(T("new"), { salary: 1300000, tdsCredit: 20000 }); expect(r.net_payable).toBe(6000); expect(r.advance_tax[0].amount).toBe(0); });
  it("an explicit rate on a gain (indexed property) overrides the rule", () => { const r = computeTax(T("new"), { salary: 1500000, gains: [{ assetClass: "real_estate", term: "long", amount: 100000, rate: 20 }] }); expect(r.tax.special_rate).toBe(20000); });
  it("slabTax helper", () => { expect(slabTax(NEW, 1425000)).toBe(93750); expect(slabTax(OLD, 1275000)).toBe(195000); });
});
