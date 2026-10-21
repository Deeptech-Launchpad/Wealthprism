import { describe, it, expect } from "vitest";
import { amortise, emiFor, outstandingAt, interestBetween, ltv, matchEmi, privateMetrics, forecastFundFlows, exposure, ultimateOwners, lifeCoverAdequacy, impliedTer, feeDrag, foldForecast, monthsFrom, premiumDates } from "../src/index.js";

describe("liabilities (FO-90)", () => {
  it("amortises a home loan with the standard EMI formula and sweeps the rounding in the last instalment", () => {
    expect(emiFor(5000000, 8.5, 240)).toBe(43391.16);   // ₹50 L at 8.5% over 20 years — matches the bank calculators
    const rows = amortise({ principal: 5000000, ratePct: 8.5, months: 240, start: "2024-03-05", emiDay: 5 });
    expect(rows).toHaveLength(240); expect(rows[0]).toMatchObject({ due_date: "2024-04-05", interest: 35416.67, principal: 7974.49 }); expect(rows[239].balance).toBe(0);
    expect(Math.abs(rows.reduce((s, r) => s + r.principal, 0) - 5000000)).toBeLessThan(0.01);
    const paid = rows.filter((r) => r.due_date <= "2026-09-12").reduce((s, r) => s + r.principal, 0); expect(outstandingAt(rows, "2026-09-12", 5000000)).toBeCloseTo(5000000 - paid, 1); expect(outstandingAt(rows, "2026-09-12", 5000000)).toBeGreaterThan(4700000); expect(outstandingAt(rows, "2026-09-12", 5000000)).toBeLessThan(4760000); expect(interestBetween(rows, "2026-04-01", "2027-03-31")).toBeGreaterThan(390000);
  });
  it("derives the tenure from a given EMI, refuses an EMI below the interest, and handles zero-rate loans", () => {
    const rows = amortise({ principal: 1000000, ratePct: 10, emi: 21247.04, start: "2026-01-01" }); expect(rows.length).toBe(60); expect(rows[59].balance).toBe(0);
    expect(() => amortise({ principal: 1000000, ratePct: 12, emi: 5000, start: "2026-01-01" })).toThrow(/never amortises/);
    expect(amortise({ principal: 12000, ratePct: 0, months: 12, start: "2026-01-31", emiDay: 31 }).map((r) => r.due_date).slice(0, 3)).toEqual(["2026-02-28", "2026-03-31", "2026-04-30"]);
  });
  it("computes LTV and matches EMI debits by amount and date window", () => {
    expect(ltv(2750000, 5000000)).toBe(55); expect(ltv(100, null)).toBeNull();
    const row = { due_date: "2026-09-05", emi: 43391.16 }; const debits = [{ id: "a", txn_date: "2026-09-04", amount: -43391 }, { id: "b", txn_date: "2026-09-20", amount: -43391.16 }, { id: "c", txn_date: "2026-09-06", amount: -40000 }];
    expect(matchEmi(row, debits)?.id).toBe("a"); expect(matchEmi({ due_date: "2026-09-19", emi: 43391.16 }, debits)?.id).toBe("b"); expect(matchEmi({ due_date: "2026-07-05", emi: 43391.16 }, debits)).toBeNull();
  });
});

describe("private-market metrics (FO-98)", () => {
  const flows = [{ date: "2024-04-14", kind: "call" as const, amount: 40000 }, { date: "2024-10-14", kind: "call" as const, amount: 40000 }, { date: "2025-04-14", kind: "call" as const, amount: 40000 }, { date: "2026-02-10", kind: "distribution" as const, amount: 30000 }];
  it("DPI, RVPI, TVPI, MOIC and IRR from calls, distributions and NAV", () => {
    const m = privateMetrics(flows, 150000, "2026-09-12"); expect(m).toMatchObject({ paid_in: 120000, distributed: 30000, dpi: 0.25, rvpi: 1.25, tvpi: 1.5, moic: 1.5 }); expect(m.irr_pct).toBeGreaterThan(20); expect(m.irr_pct).toBeLessThan(40);
    expect(privateMetrics([], 0, "2026-09-12").tvpi).toBeNull();
  });
  it("PME against a listed benchmark: a fund that merely tracked the index scores 1.0", () => {
    const bench = [{ date: "2024-04-14", value: 100 }, { date: "2024-10-14", value: 110 }, { date: "2025-04-14", value: 120 }, { date: "2026-02-10", value: 130 }, { date: "2026-09-12", value: 140 }];
    const tracking = privateMetrics([{ date: "2024-04-14", kind: "call", amount: 1000 }], 1400, "2026-09-12", bench); expect(tracking.pme).toBe(1);
    const m = privateMetrics(flows, 150000, "2026-09-12", bench); expect(m.pme).toBeGreaterThan(1.1); expect(m.pme).toBeLessThan(1.4);
  });
  it("forecasts the J-curve: remaining calls on the schedule, distributions in the harvest window", () => {
    const f = forecastFundFlows({ commitment: 160000, drawn: 120000, schedule: [{ due: "2026-10-14", amount: 20000 }, { due: "2027-04-14", amount: 20000 }], asOf: "2026-09-12", months: 36, investmentYears: 1, harvestYears: 2, expectedMultiple: 1.8 });
    expect(f).toHaveLength(36); expect(f.find((x) => x.month === "2026-10")?.calls).toBe(20000); expect(f.find((x) => x.month === "2027-04")?.calls).toBe(20000); expect(f.reduce((s, x) => s + x.calls, 0)).toBe(40000);
    expect(f.reduce((s, x) => s + x.distributions, 0)).toBeCloseTo(288000, 0); expect(f[0].distributions).toBe(0); expect(f[12].distributions).toBeGreaterThan(0);
  });
});

describe("exposure and look-through (FO-93, FO-96)", () => {
  const positions = [
    { name: "HDFC Bank", value: 100, alloc_class: "equity", sector: "Financials", market_cap_band: "large", issuer: "HDFC Bank", liquidity_class: "t1", country: "IN" },
    { name: "PPFAS Flexi Cap", value: 200, alloc_class: "equity", manager: "PPFAS", liquidity_class: "t3", lookthrough: [{ alloc_class: "equity", country: "IN", pct: 65 }, { alloc_class: "equity", country: "US", pct: 30 }, { alloc_class: "cash", country: "IN", pct: 5 }] },
    { name: "SBI Bond", value: 100, alloc_class: "debt", credit_rating: "AAA", modified_duration: 5.2, issuer: "State Bank of India", liquidity_class: "t1" },
    { name: "Neo Credit AIF", value: 100, alloc_class: "debt", manager: "Neo", liquidity_class: "locked", modified_duration: 2.1 },
  ];
  it("every dimension sums to 100% and the unclassified remainder is explicit", () => {
    for (const by of ["asset_class", "sector", "market_cap", "geography", "currency", "issuer", "rating", "duration", "manager", "liquidity"] as const) { const rows = exposure(positions, by); expect(rows.reduce((s, r) => s + r.pct, 0)).toBeCloseTo(100, 1); }
    expect(exposure(positions, "geography").find((r) => r.key === "US")?.value).toBe(60); expect(exposure(positions, "asset_class").find((r) => r.key === "cash")?.value).toBe(10);
    expect(exposure(positions, "rating").find((r) => r.key === "unrated")?.value).toBe(100); expect(exposure(positions, "sector").find((r) => r.key === "unclassified")?.value).toBe(200);
    expect(exposure(positions, "duration").map((r) => r.key).sort()).toEqual(["1–3 y", "3–7 y", "n/a (non-debt)"]); expect(exposure(positions, "liquidity").find((r) => r.key === "locked")?.pct).toBe(20);
  });
  it("look-through ownership: trust 100% → LLP 60% → property gives the beneficiary 60% of the property; history is date-effective", () => {
    const edges = [{ owner_entity_id: "trust", owned_type: "entity", owned_id: "llp", pct: 60 }, { owner_entity_id: "beneficiary", owned_type: "entity", owned_id: "trust", pct: 100 }, { owner_entity_id: "llp", owned_type: "property", owned_id: "prop", pct: 100 }, { owner_entity_id: "partner2", owned_type: "entity", owned_id: "llp", pct: 40, effective_from: "2026-10-01" }];
    expect(ultimateOwners(edges, "property", "prop", "2026-09-12", { individuals: new Set(["beneficiary", "partner2"]) })).toEqual({ beneficiary: 60, llp: 40 });
    expect(ultimateOwners(edges, "property", "prop", "2026-10-15", { individuals: new Set(["beneficiary", "partner2"]) })).toEqual({ beneficiary: 60, partner2: 40 });
    expect(ultimateOwners([], "property", "solo", "2026-09-12")).toEqual({});
  });
});

describe("insurance, fees and forecast (FO-91, FO-99, FO-102)", () => {
  it("life cover adequacy against liabilities, goals and income replacement", () => {
    const a = lifeCoverAdequacy([{ kind: "term_life", sum_assured: 20000000 }, { kind: "health", sum_assured: 1000000 }, { kind: "endowment", sum_assured: 500000, status: "lapsed" }], 4700000, 9000000, 1200000, 10);
    expect(a).toEqual({ life_cover: 20000000, need: 25700000, gap: 5700000, adequacy_pct: 77.82 });
  });
  it("implied TER and fee drag", () => { expect(impliedTer(1000000, 0.63, 365)).toBe(6300); expect(impliedTer(1000000, 1.5, 90)).toBe(3698.63); expect(feeDrag(12000, 1000000, 12)).toEqual({ pct_of_aum: 1.2, drag_share_of_return_pct: 10 }); });
  it("folds dated items into months with running cash and float flags; premium dates follow the frequency", () => {
    const months = monthsFrom("2026-09-12", 4); expect(months).toEqual(["2026-09", "2026-10", "2026-11", "2026-12"]);
    const rows = foldForecast([{ month: "2026-09", kind: "rent", amount: 5000 }, { month: "2026-10", kind: "capital_call", amount: -20000 }, { month: "2026-10", kind: "rent", amount: 5000 }, { month: "2026-12", kind: "emi", amount: -3000 }], 10000, 4000, months);
    expect(rows.map((r) => r.cumulative_cash)).toEqual([15000, 0, 0, -3000]); expect(rows.map((r) => r.below_float)).toEqual([false, true, true, true]); expect(rows[1].by_kind).toEqual({ capital_call: -20000, rent: 5000 });
    expect(premiumDates("2026-10-05", "quarterly", "2027-06-30")).toEqual(["2026-10-05", "2027-01-05", "2027-04-05"]); expect(premiumDates("2026-10-05", "single", "2030-01-01")).toEqual(["2026-10-05"]); expect(premiumDates("2026-10-05", "yearly", "2028-12-31")).toHaveLength(3);
  });
});
