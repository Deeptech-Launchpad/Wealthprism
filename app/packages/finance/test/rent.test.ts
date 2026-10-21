import { describe, it, expect } from "vitest";
import { generateRentSchedule, gstSplit, fyOf, fyStart, propertyPnl } from "../src/index.js";

describe("rent schedule", () => {
  it("emits one row per month with due day, GST and TDS on the escalated rent", () => {
    const rows = generateRentSchedule({ startDate: "2025-03-01", endDate: "2028-02-29", rent: 2850, dueDay: 1, escalationPct: 5, escalationEveryMonths: 12, gstApplicable: true, gstRate: 18, tdsApplicable: true, tdsRate: 10 });
    expect(rows.length).toBe(36);
    expect(rows[0]).toEqual({ periodMonth: "2025-03-01", dueDate: "2025-03-01", expectedRent: 2850, expectedGst: 513, expectedTds: 285 });
    expect(rows[11].expectedRent).toBe(2850);
    expect(rows[12]).toMatchObject({ periodMonth: "2026-03-01", expectedRent: 2992.5, expectedGst: 538.65, expectedTds: 299.25 });
    expect(rows[24].expectedRent).toBe(3142.13); // 2850 × 1.05²
    expect(rows[35].periodMonth).toBe("2028-02-01");
  });
  it("clamps the due day to short months and skips GST/TDS when not applicable", () => {
    const rows = generateRentSchedule({ startDate: "2026-01-01", endDate: "2026-03-31", rent: 420, dueDay: 31 });
    expect(rows.map((r) => r.dueDate)).toEqual(["2026-01-31", "2026-02-28", "2026-03-31"]);
    expect(rows[0]).toMatchObject({ expectedGst: 0, expectedTds: 0 });
  });
});

describe("gst", () => {
  it("splits intra-state supply into CGST/SGST and inter-state into IGST", () => {
    expect(gstSplit(2850, 18, "33", "33")).toEqual({ cgst: 256.5, sgst: 256.5, igst: 0, total: 513 });
    expect(gstSplit(2850, 18, "33", "29")).toEqual({ cgst: 0, sgst: 0, igst: 513, total: 513 });
    expect(gstSplit(1650, 18, "33", null).cgst).toBe(148.5);
    expect(gstSplit(101, 18, "33", "33")).toEqual({ cgst: 9.09, sgst: 9.09, igst: 0, total: 18.18 });
  });
  it("labels the financial year", () => { expect(fyOf("2026-09-01")).toBe("2026-27"); expect(fyOf("2026-03-31")).toBe("2025-26"); expect(fyStart("2026-27")).toBe("2026-04-01"); });
});

describe("property p&l", () => {
  it("computes net and yields on valuation", () => {
    const r = propertyPnl({ rentReceived: 17100, propertyTax: 482, expenses: 220, currentValue: 475000, annualRent: 34200 });
    expect(r.net).toBe(16398); expect(r.grossYieldPct).toBe(7.2); expect(r.netYieldPct).toBe(6.9); // costs annualised at the rent-received ratio
    expect(propertyPnl({ rentReceived: 0, propertyTax: 32, expenses: 0, currentValue: 130000, annualRent: 0 })).toEqual({ net: -32, grossYieldPct: 0, netYieldPct: null });
  });
});
