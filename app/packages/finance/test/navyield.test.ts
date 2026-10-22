import { describe, it, expect } from "vitest";
import { navYield } from "../src/index.js";

describe("navYield: annualised return from NAV history", () => {
  it("annualises a 30-day return: 0.5% in 30 days is about 6.17% a year", () => {
    const y = navYield([{ date: "2026-09-21", nav: 1000 }, { date: "2026-10-21", nav: 1005 }], 30)!;
    expect(y.days).toBe(30); expect(y.from).toBe("2026-09-21"); expect(y.to).toBe("2026-10-21");
    expect(y.pct).toBeCloseTo((Math.pow(1.005, 365 / 30) - 1) * 100, 2);   // 6.17
  });
  it("uses the last NAV on or before the target day when the exact day was a holiday", () => {
    const y = navYield([{ date: "2026-09-18", nav: 1000 }, { date: "2026-10-01", nav: 1002 }, { date: "2026-10-21", nav: 1006 }], 30)!;
    expect(y.from).toBe("2026-09-18"); expect(y.days).toBe(33);
  });
  it("a 1-year return of 7% reads as 7%", () => {
    const y = navYield([{ date: "2025-10-21", nav: 100 }, { date: "2026-10-21", nav: 107 }], 365)!;
    expect(y.pct).toBeCloseTo(7, 1);
  });
  it("refuses to guess when the history is too short or has no early enough point", () => {
    expect(navYield([{ date: "2026-10-14", nav: 100 }, { date: "2026-10-21", nav: 100.2 }], 30)).toBeNull();            // only a week of history
    expect(navYield([{ date: "2026-10-21", nav: 100 }], 365)).toBeNull();
    expect(navYield([{ date: "2025-01-01", nav: 90 }, { date: "2026-10-21", nav: 100 }], 365)).toBeNull();            // the nearest earlier point is far older than a year
    expect(navYield([], 30)).toBeNull();
  });
  it("ignores unsorted input and bad rows", () => {
    const y = navYield([{ date: "2026-10-21", nav: 1005 }, { date: "bad", nav: 5 }, { date: "2026-09-21", nav: 1000 }, { date: "2026-09-25", nav: 0 }], 30)!;
    expect(y.from).toBe("2026-09-21");
  });
});
