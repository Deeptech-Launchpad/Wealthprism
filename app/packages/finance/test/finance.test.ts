import { describe, it, expect } from "vitest";
import { xirr, consumeFifo, applyBonus, realiseSale, taxOnGains, bucketDrift, requiredFloat, deployableExcess, postTaxYield } from "../src/index.js";

describe("xirr", () => {
  it("matches Excel on a simple two-flow case (10% over exactly one year)", () => {
    const r = xirr([{ date: new Date("2025-01-01"), amount: -1000 }, { date: new Date("2026-01-01"), amount: 1100 }]);
    expect(r).toBeCloseTo(0.1, 4);
  });
  it("handles SIP-style flows", () => {
    const flows = Array.from({ length: 12 }, (_, i) => ({ date: new Date(2025, i, 10), amount: -1000 }));
    flows.push({ date: new Date(2026, 0, 10), amount: 13000 });
    const r = xirr(flows);
    expect(r).toBeGreaterThan(0.14); expect(r).toBeLessThan(0.18);
  });
});

describe("lots", () => {
  const lots = [
    { id: "a", buyDate: "2022-03-14", quantity: 21, remainingQty: 21, unitCost: 1471.43, charges: 12 },
    { id: "b", buyDate: "2026-08-28", quantity: 21, remainingQty: 21, unitCost: 0, charges: 0 },
  ];
  it("consumes FIFO and keeps quantity invariant", () => {
    const { consumed, remaining } = consumeFifo(lots, 25);
    expect(consumed.map((c) => c.lotId)).toEqual(["a", "b"]);
    expect(consumed[1].qty).toBe(4);
    expect(remaining.reduce((s, l) => s + l.remainingQty, 0)).toBe(42 - 25);
  });
  it("bonus 1:1 doubles quantity at zero cost", () => {
    const out = applyBonus([lots[0]], 1, 1, "2026-08-28");
    expect(out.reduce((s, l) => s + l.remainingQty, 0)).toBe(42);
    expect(out[1].unitCost).toBe(0);
  });
  it("rejects oversell", () => { expect(() => consumeFifo(lots, 100)).toThrow(); });
});

describe("capital gains", () => {
  const rules = [
    { assetClass: "equity", term: "short" as const, rate: 20, taxedAtSlab: false, exemptionAmount: 0, holdingMonthsForLong: 12 },
    { assetClass: "equity", term: "long" as const, rate: 12.5, taxedAtSlab: false, exemptionAmount: 125000, holdingMonthsForLong: 12 },
  ];
  it("classifies term by holding period and applies grandfathering", () => {
    const lots = [{ id: "old", buyDate: "2016-06-01", quantity: 100, remainingQty: 100, unitCost: 500, charges: 0 }];
    const { lines } = realiseSale({ lots, qty: 100, price: 900, sellDate: "2026-07-04", assetClass: "equity", rules, fmv31Jan2018: 800 });
    expect(lines[0].term).toBe("long");
    expect(lines[0].grandfathered).toBe(true);
    expect(lines[0].cost).toBe(80000);
    expect(lines[0].gain).toBe(10000);
  });
  it("applies the LTCG exemption once and STCG at 20%", () => {
    const lines = [
      { lotId: "x", buyDate: "2025-11-02", sellDate: "2026-08-18", qty: 1, cost: 4800, proceeds: 4600, gain: -200, term: "short" as const, grandfathered: false },
      { lotId: "y", buyDate: "2022-02-12", sellDate: "2026-07-04", qty: 3, cost: 5100, proceeds: 6200, gain: 1100, term: "long" as const, grandfathered: false },
    ];
    const t = taxOnGains(lines, "equity", rules, 30);
    expect(t.ltcg).toBe(1100); expect(t.exemptionUsed).toBe(1100); expect(t.tax).toBe(0);
  });
});

describe("buckets and working capital", () => {
  it("computes drift and breach", () => {
    const s = bucketDrift({ liquidity: 6.2, income: 30.5, growth: 63.3 }, { liquidity: 8, income: 32, growth: 60, driftThresholdPp: 1.5 });
    expect(s.find((x) => x.bucket === "growth")!.breached).toBe(true);
    expect(s.find((x) => x.bucket === "income")!.breached).toBe(false);
  });
  it("derives required float and excess", () => {
    const i = { cash: 53600, outflows: [{ dueDate: "2026-09-15", amount: 9400 }, { dueDate: "2026-10-14", amount: 20000 }, { dueDate: "2027-03-01", amount: 99999 }], floatDays: 60, avgMonthlyOutflow: 5900, bufferMonths: 1, asOf: "2026-09-11" };
    expect(requiredFloat(i)).toBe(35300);
    expect(deployableExcess(i)).toBe(18300);
  });
  it("post-tax yield", () => { expect(postTaxYield(6.9, "slab", 30)).toBe(4.83); expect(postTaxYield(7.1, "equity_ltcg", 30)).toBe(6.21); });
});
