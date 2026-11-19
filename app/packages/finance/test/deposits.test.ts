import { describe, it, expect } from "vitest";
import { estimateForeclosure, foreclosureEligibility, foreclosureCreditMatches } from "../src/index.js";

describe("deposit foreclosure", () => {
  it("fd paying out: principal plus reduced-rate interest for the days run, less interest already paid", () => {
    // ₹1L at 7.2%, closed after 61 days with a 1% penalty (6.2%): 100000 x 6.2% x 61/365 = 1036.16; ₹600 already paid out
    const e = estimateForeclosure({ kind: "fd", startDate: "2026-09-10", closeDate: "2026-11-10", ratePct: 7.2, penaltyPct: 1, principal: 100000, payoutFrequency: "monthly", interestAlreadyPaid: 600 });
    expect(e.daysRun).toBe(61); expect(e.reducedRatePct).toBe(6.2); expect(e.principalReturned).toBe(100000);
    expect(e.interest).toBeCloseTo(1036.16, 1); expect(e.estimatedCredit).toBeCloseTo(100436.16, 1);
  });
  it("closing inside 7 days earns nothing, and the bank recovers interest it already paid", () => {
    const e = estimateForeclosure({ kind: "fd", startDate: "2026-09-10", closeDate: "2026-09-14", ratePct: 7.2, penaltyPct: 1, principal: 100000, payoutFrequency: "monthly", interestAlreadyPaid: 100 });
    expect(e.interest).toBe(0); expect(e.estimatedCredit).toBe(99900);
  });
  it("cumulative fd compounds quarterly on the reduced rate", () => {
    const e = estimateForeclosure({ kind: "fd", startDate: "2026-01-01", closeDate: "2026-07-01", ratePct: 8, penaltyPct: 1, principal: 100000, payoutFrequency: "at_maturity" });
    expect(e.interest).toBeCloseTo(3530.63, 1);   // two full quarters at 7%: 100000 x 1.0175^2 - 100000
  });
  it("cumulative fd adds simple interest for the days after the last full quarter", () => {
    const e = estimateForeclosure({ kind: "fd", startDate: "2026-01-01", closeDate: "2026-04-11", ratePct: 8, penaltyPct: 1, principal: 100000, payoutFrequency: "at_maturity" });
    expect(e.interest).toBeCloseTo(100000 * 1.0175 * (1 + 0.07 * 10 / 365) - 100000, 1);
  });
  it("rd: interest on each paid instalment for the days it was held", () => {
    const e = estimateForeclosure({ kind: "rd", startDate: "2026-01-10", closeDate: "2026-07-10", ratePct: 6.5, penaltyPct: 1, contributions: [{ a: 5000, on: "2026-01-10" }, { a: 5000, on: "2026-02-10" }] });
    expect(e.principalReturned).toBe(10000);
    expect(e.interest).toBeCloseTo(5000 * 0.055 * 181 / 365 + 5000 * 0.055 * 150 / 365, 1);
  });
  it("the penalty cost is the interest given up: full-rate interest minus reduced-rate interest", () => {
    // ₹10,000 for 15 days: 7% would earn 28.77, 6% earns 24.66, so the 1% penalty costs 4.11
    const e = estimateForeclosure({ kind: "fd", startDate: "2026-10-01", closeDate: "2026-10-16", ratePct: 7, penaltyPct: 1, principal: 10000, payoutFrequency: "monthly" });
    expect(e.interest).toBeCloseTo(24.66, 2); expect(e.penaltyCost).toBeCloseTo(4.11, 2);
    expect(estimateForeclosure({ kind: "fd", startDate: "2026-10-01", closeDate: "2026-10-16", ratePct: 7, penaltyPct: 0, principal: 10000, payoutFrequency: "monthly" }).penaltyCost).toBe(0);
    expect(estimateForeclosure({ kind: "fd", startDate: "2026-10-01", closeDate: "2026-10-04", ratePct: 7, penaltyPct: 1, principal: 10000, payoutFrequency: "monthly" }).penaltyCost).toBe(0);   // inside 7 days nothing is earned either way
  });
  it("a penalty above the rate cannot make the rate negative", () => {
    expect(estimateForeclosure({ kind: "fd", startDate: "2026-01-01", closeDate: "2026-06-01", ratePct: 0.5, penaltyPct: 2, principal: 1000, payoutFrequency: "monthly" }).interest).toBe(0);
  });
  it("eligibility follows the type's rule", () => {
    expect(foreclosureEligibility({ break_rule: "allowed", lock_in_months: 0 }, "2026-01-01", "2026-02-01").allowed).toBe(true);
    const never = foreclosureEligibility({ break_rule: "never", lock_in_months: 60, label: "Tax-saver FD" }, "2026-01-01", "2027-01-01");
    expect(never.allowed).toBe(false); expect(never.needsException).toBe(true); expect(never.reason).toMatch(/cannot be closed/);
    expect(foreclosureEligibility({ break_rule: "after_lock_in", lock_in_months: 6 }, "2026-01-01", "2026-05-01").allowed).toBe(false);
    expect(foreclosureEligibility({ break_rule: "after_lock_in", lock_in_months: 6 }, "2026-01-01", "2026-07-01").allowed).toBe(true);
  });
  it("a credit within 10 rupees or 0.5% counts as matching; further apart is a variance", () => {
    expect(foreclosureCreditMatches(100436, 100440)).toBe(true); expect(foreclosureCreditMatches(100436, 101000)).toBe(false);
    expect(foreclosureCreditMatches(1000, 1008)).toBe(true); expect(foreclosureCreditMatches(1000, 1020)).toBe(false);
  });
});

import { depositCurrentValue, fdMaturityValue, generateDepositSchedule } from "../src/index.js";

describe("fd value: maturity vs current", () => {
  // a 1,00,000 regular fd at 8% paying interest monthly for 1 year: 12 interest payments of 666.67 plus the principal back
  const terms = { kind: "fd" as const, startDate: "2026-01-01", maturityDate: "2027-01-01", ratePct: 8, principal: 100000, payoutFrequency: "monthly" as const };
  const sched = generateDepositSchedule(terms);
  it("maturity value is the principal plus all the interest, not the principal alone", () => {
    const m = fdMaturityValue(sched);
    expect(m).toBeCloseTo(100000 + 12 * 666.67, 0);
    expect(m).toBeGreaterThan(100000);
  });
  it("current value grows through the year and does not equal the maturity value until maturity", () => {
    const m = fdMaturityValue(sched);
    const mid = depositCurrentValue({ ...terms, interestPaid: 0 }, m, "2026-07-01");
    expect(mid).toBeGreaterThan(100000); expect(mid).toBeLessThan(m);
  });
  it("interest already paid out is not counted twice: value falls back to about the principal", () => {
    const m = fdMaturityValue(sched);
    const paid = depositCurrentValue({ ...terms, interestPaid: 6 * 666.67 }, m, "2026-07-01");
    const unpaid = depositCurrentValue({ ...terms, interestPaid: 0 }, m, "2026-07-01");
    expect(paid).toBeLessThan(unpaid); expect(Math.abs(paid - 100000)).toBeLessThan(100);
  });
  it("a cumulative fd's value still grows from principal toward its compounded maturity", () => {
    const cum = { ...terms, payoutFrequency: "at_maturity" as const };
    const rows = generateDepositSchedule(cum);
    const m = fdMaturityValue(rows);
    expect(m).toBeGreaterThan(108000);
    expect(depositCurrentValue({ ...cum, interestPaid: 0 }, m, "2027-01-01")).toBe(m);
  });
});
