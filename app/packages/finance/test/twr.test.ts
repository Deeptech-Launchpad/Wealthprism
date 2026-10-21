import { describe, it, expect } from "vitest";
import { modifiedDietz, linkReturns, twr, annualise, xirrFlowsFor, divergenceNote, xirr, applyDemerger, applyMerger, applyBonus, applySplit, consumeFifo } from "../src/index.js";

describe("modified dietz", () => {
  it("no flows is plain growth", () => { expect(modifiedDietz(100, 110, [], "2026-01-01", "2026-12-31")).toBeCloseTo(0.10, 10); });
  it("weights a mid-period contribution by time remaining", () => {
    // 100 → +50 at day 182.5/365 → 165: (165-100-50)/(100+0.5*50) = 15/125 = 12%
    expect(modifiedDietz(100, 165, [{ date: "2026-07-02", amount: 50 }], "2026-01-01", "2027-01-01")).toBeCloseTo(0.12, 3);
  });
  it("a withdrawal on the last day has zero weight", () => {
    expect(modifiedDietz(100, 90, [{ date: "2026-12-31", amount: -20 }], "2026-01-01", "2026-12-31")).toBeCloseTo(0.10, 10);
  });
  it("ignores flows outside the window", () => {
    expect(modifiedDietz(100, 110, [{ date: "2025-12-31", amount: 999 }, { date: "2027-01-01", amount: 999 }], "2026-01-01", "2026-12-31")).toBeCloseTo(0.10, 10);
  });
});

describe("linking and annualising", () => {
  it("links geometrically", () => { expect(linkReturns([0.10, -0.05])).toBeCloseTo(0.045, 10); expect(linkReturns([])).toBe(0); });
  it("annualises only at a year or more", () => { expect(annualise(0.21, 730)).toBeCloseTo(0.10, 6); expect(annualise(0.05, 180)).toBeNull(); expect(annualise(0.10, 365)).toBeCloseTo(0.10, 10); });
});

describe("twr from a valuation series", () => {
  const monthly = [
    { date: "2026-01-31", value: 1000 }, { date: "2026-02-28", value: 1050 }, { date: "2026-03-31", value: 1600 }, { date: "2026-04-30", value: 1520 },
  ];
  it("matches the Excel reference: sub-period returns link regardless of flow size", () => {
    // Feb: 1000 → 1050 (+5%). Mar: +500 on 15 Mar (w = 16/31), 1050 → 1600: (1600-1050-500)/(1050+500*16/31)= 50/1308.06 = 3.822%. Apr: 1600 → 1520 (−5%).
    const r = twr(monthly, [{ date: "2026-03-15", amount: 500 }]);
    expect(r.subPeriods.map((s) => +s.ret.toFixed(5))).toEqual([0.05, 0.03822, -0.05]);
    expect(r.total).toBeCloseTo(1.05 * 1.03822 * 0.95 - 1, 4);
    expect(r.annualised).toBeNull(); // 89 days
    expect(r.days).toBe(89);
  });
  it("is unaffected by the size of a flow that lands exactly on a valuation date", () => {
    const a = twr([{ date: "2026-01-31", value: 100 }, { date: "2026-02-28", value: 110 }, { date: "2026-03-31", value: 121 }]);
    const b = twr([{ date: "2026-01-31", value: 100 }, { date: "2026-02-28", value: 1110 }, { date: "2026-03-31", value: 1221 }], [{ date: "2026-02-28", amount: 1000 }]);
    expect(a.total).toBeCloseTo(0.21, 10); expect(b.total).toBeCloseTo(0.21, 10);
  });
  it("handles a scope that starts empty and a daily series with end-of-day flows", () => {
    const daily = [{ date: "2026-09-01", value: 0 }, { date: "2026-09-02", value: 1000 }, { date: "2026-09-03", value: 1010 }, { date: "2026-09-04", value: 1515 }];
    const r = twr(daily, [{ date: "2026-09-02", amount: 1000 }, { date: "2026-09-04", amount: 500 }]);
    expect(r.subPeriods[0].ret).toBe(0);
    expect(r.subPeriods[1].ret).toBeCloseTo(0.01, 10);
    expect(r.subPeriods[2].ret).toBeCloseTo((1515 - 500) / 1010 - 1, 10);
  });
  it("shows the classic divergence: a large late contribution before a fall drags XIRR below TWR", () => {
    const vals = [{ date: "2025-01-01", value: 100 }, { date: "2025-07-01", value: 1120 }, { date: "2026-01-01", value: 1020 }]; // 1 Jul valuation includes that day's 1,000 contribution
    const flows = [{ date: "2025-07-01", amount: 1000 }];
    const r = twr(vals, flows);
    expect(r.subPeriods.map((s) => +s.ret.toFixed(4))).toEqual([0.2, -0.0893]);
    const x = xirr(xirrFlowsFor(vals, flows));
    expect(x).toBeLessThan(r.total);
    expect(divergenceNote(r.total * 100, x * 100, vals, flows)).toMatch(/TWR measures the manager/);
    expect(divergenceNote(10, 10.4, vals, [])).toBeNull();
  });
});

describe("corporate actions on lots", () => {
  const lots = [{ id: "a", buyDate: "2022-03-14", quantity: 21, remainingQty: 21, unitCost: 1471.43, charges: 12 }];
  it("bonus 1:1 doubles quantity at zero cost and halves the average", () => {
    const out = applyBonus(lots, 1, 1, "2026-08-28");
    const qty = out.reduce((s, l) => s + l.remainingQty, 0), cost = out.reduce((s, l) => s + l.remainingQty * l.unitCost, 0);
    expect(qty).toBe(42); expect(cost / qty).toBeCloseTo(1471.43 / 2, 6); expect(out[1].buyDate).toBe("2026-08-28");
  });
  it("split 1:10 rescales without changing cost", () => {
    const out = applySplit(lots, 10, 1);
    expect(out[0].remainingQty).toBe(210); expect(out[0].unitCost * out[0].remainingQty).toBeCloseTo(1471.43 * 21, 2);
  });
  it("demerger moves the cost split to the child and keeps buy dates", () => {
    const { parent, child } = applyDemerger(lots, 6.4, 1, 1);
    expect(parent[0].unitCost).toBeCloseTo(1471.43 * 0.936, 4);
    expect(child[0].buyDate).toBe("2022-03-14"); expect(child[0].remainingQty).toBe(21); expect(child[0].unitCost).toBeCloseTo(1471.43 * 0.064, 4);
    const before = lots[0].unitCost * 21, after = parent[0].unitCost * 21 + child[0].unitCost * 21;
    expect(after).toBeCloseTo(before, 2);
    expect(consumeFifo(child, 21).consumed[0].cost).toBeCloseTo(21 * child[0].unitCost + child[0].charges, 2);
  });
  it("merger 2 new for 3 old carries total cost", () => {
    const out = applyMerger(lots, 2, 3);
    expect(out[0].remainingQty).toBe(14); expect(out[0].unitCost * 14).toBeCloseTo(1471.43 * 21, 2); expect(out[0].charges).toBe(12);
  });
});
