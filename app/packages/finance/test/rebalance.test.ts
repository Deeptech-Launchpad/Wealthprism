import { describe, it, expect } from "vitest";
import { solve, evaluateTriggers, nextCalendarRun, lotConstraintsFor, type RbSnapshot } from "../src/rebalance.js";
import type { TaxRule } from "../src/capitalGains.js";

const RULES: TaxRule[] = [
  { assetClass: "equity", term: "short", rate: 20, taxedAtSlab: false, exemptionAmount: 0, holdingMonthsForLong: 12 }, { assetClass: "equity", term: "long", rate: 12.5, taxedAtSlab: false, exemptionAmount: 125000, holdingMonthsForLong: 12 },
  { assetClass: "debt_mf_post_apr23", term: "short", rate: 0, taxedAtSlab: true, exemptionAmount: 0, holdingMonthsForLong: 9999 }, { assetClass: "listed_bond", term: "long", rate: 12.5, taxedAtSlab: false, exemptionAmount: 0, holdingMonthsForLong: 12 }, { assetClass: "listed_bond", term: "short", rate: 0, taxedAtSlab: true, exemptionAmount: 0, holdingMonthsForLong: 12 },
];
const HUF = "huf", ARJUN = "arjun";
// asOf 11 Sep 2026: ₹10,600 idle above float; the Varaha call of ₹20,000 falls due 14 Oct; equity sits far above its band
export const SNAP = (): RbSnapshot => ({
  asOf: "2026-09-11", fyEnd: "2027-03-31", floatRequired: 11000, rules: RULES, slabRate: { [HUF]: 30, [ARJUN]: 30 }, exemptionRemaining: { [HUF]: 125000, [ARJUN]: 125000 },
  cash: [{ accountId: "icici", entityId: HUF, balance: 21600 }],
  holdings: [
    { id: "baf", entityId: HUF, instrumentId: "i-baf", name: "HDFC Balanced Advantage", allocClass: "equity", bucket: "growth", price: 100, assetClass: "equity", instrumentType: "mf",
      lots: [{ id: "baf-2024", buyDate: "2024-01-10", qty: 300, unitCost: 80, ltcgEligibleOn: "2025-01-10", exitLoadUntil: "2025-01-10", exitLoadPct: 1, settlementDays: 3 }, { id: "baf-2025", buyDate: "2025-11-02", qty: 200, unitCost: 95, ltcgEligibleOn: "2026-11-02", exitLoadUntil: "2026-11-02", exitLoadPct: 1, settlementDays: 3 }] },
    { id: "elss", entityId: HUF, instrumentId: "i-elss", name: "Axis ELSS", allocClass: "equity", bucket: "growth", price: 50, assetClass: "equity", instrumentType: "mf", lots: [{ id: "elss-1", buyDate: "2025-03-20", qty: 400, unitCost: 40, lockInUntil: "2028-03-20", ltcgEligibleOn: "2026-03-20", settlementDays: 3 }] },
    { id: "hdfc", entityId: ARJUN, instrumentId: "i-hdfc", name: "HDFC Bank", allocClass: "equity", bucket: "growth", price: 1700, assetClass: "equity", instrumentType: "stock", lots: [{ id: "hdfc-2022", buyDate: "2022-03-14", qty: 21, unitCost: 700, ltcgEligibleOn: "2023-03-14", settlementDays: 1 }, { id: "hdfc-bonus", buyDate: "2026-08-28", qty: 21, unitCost: 0, ltcgEligibleOn: "2027-08-28", settlementDays: 1 }] },
    { id: "bond", entityId: HUF, instrumentId: "i-bond", name: "SBI 7.72% 2033", allocClass: "debt", bucket: "income", price: 1020, assetClass: "listed_bond", instrumentType: "bond", lots: [{ id: "bond-1", buyDate: "2024-01-09", qty: 15, unitCost: 1000, ltcgEligibleOn: "2025-01-09", settlementDays: 1 }] },
    { id: "tbill", entityId: HUF, instrumentId: "i-tbill", name: "91-day T-bill", allocClass: "cash", bucket: "liquidity", price: 100, assetClass: "debt_mf_post_apr23", instrumentType: "tbill", maturesOn: "2027-01-12", lots: [{ id: "tb-1", buyDate: "2026-09-01", qty: 50, unitCost: 98.5, settlementDays: 1 }] },
  ],
  needs: [{ id: "varaha", label: "Varaha Angel Fund II drawdown 4/6", date: "2026-10-14", amount: 20000, priority: 1, flexibilityDays: 0, entityId: HUF, fundedAmount: 0 }],
  targets: [{ key: "equity", target: 45, min: 35, max: 55 }, { key: "debt", target: 30, min: 20, max: 40 }, { key: "cash", target: 25, min: 10, max: 35 }],
  contributions: [{ label: "Flexi Cap SIP", monthly: 2000, allocClass: "equity", entityId: HUF }],
  buyInstrument: { debt: { id: "i-tmf", name: "Target maturity fund", settlementDays: 1 }, cash: { id: "i-liq", name: "ICICI Liquid", settlementDays: 1 } },
});
const PROGRAM = { calendar_rrule: "FREQ=MONTHLY;INTERVAL=3;BYMONTHDAY=1", band_trigger: true, drift_threshold_pp: null as number | null, milestone_triggers: [{ kind: "goal_years_to_go", value: 3 }, { kind: "goal_funded_pct", value: 90 }, { kind: "glide_step" }, { kind: "life_event", value: "retirement" }], need_lookahead_days: 120, large_flow_pct: 5, tax_year_end: true };

describe("timing calendar and lot constraints (FO-160, FO-162)", () => {
  it("computes the next calendar run from an RRULE subset", () => {
    expect(nextCalendarRun("FREQ=MONTHLY;INTERVAL=3;BYMONTHDAY=1", "2026-09-11")).toBe("2026-10-01");
    expect(nextCalendarRun("FREQ=MONTHLY;BYMONTHDAY=1", "2026-09-11")).toBe("2026-10-01"); expect(nextCalendarRun("FREQ=MONTHLY;BYMONTHDAY=31", "2026-01-31")).toBe("2026-02-28");
    expect(nextCalendarRun("FREQ=YEARLY;BYMONTH=4;BYMONTHDAY=1", "2026-09-11")).toBe("2027-04-01"); expect(nextCalendarRun("FREQ=YEARLY", "2026-03-31")).toBe("2026-04-01"); expect(nextCalendarRun(null, "2026-01-01")).toBeNull();
  });
  it("derives lock-in, exit load, LTCG date and settlement per lot", () => {
    const baf = lotConstraintsFor({ buyDate: "2025-11-02", instrumentType: "mf", assetClass: "equity", name: "HDFC Balanced Advantage" }, RULES, "2026-09-11");
    expect(baf).toMatchObject({ exit_load_until: "2026-11-02", exit_load_pct: 1, ltcg_eligible_on: "2026-11-02", settlement_days: 3, lock_in_until: null, liquidity_class: "t3" });
    expect(lotConstraintsFor({ buyDate: "2025-03-20", instrumentType: "mf", assetClass: "equity", name: "Axis ELSS Tax Saver" }, RULES, "2026-09-11").lock_in_until).toBe("2028-03-20");
    expect(lotConstraintsFor({ buyDate: "2026-07-01", instrumentType: "mf", assetClass: "debt_mf_post_apr23", name: "ICICI Prudential Liquid Fund" }, RULES, "2026-09-11")).toMatchObject({ exit_load_until: null, ltcg_eligible_on: null, settlement_days: 1, liquidity_class: "t1" });
    expect(lotConstraintsFor({ buyDate: "2024-01-09", instrumentType: "bond", assetClass: "listed_bond", meta: { maturity_date: "2033-01-09" } }, RULES, "2026-09-11")).toMatchObject({ ltcg_eligible_on: "2025-01-09", settlement_days: 1, matures_on: "2033-01-09" });
    expect(lotConstraintsFor({ buyDate: "2024-06-01", instrumentType: "aif", assetClass: "debt_mf_post_apr23" }, RULES, "2026-09-11")).toMatchObject({ lock_in_until: "2027-06-01", settlement_days: 90, liquidity_class: "locked" });
    expect(lotConstraintsFor({ buyDate: "2022-01-01", instrumentType: "stock", assetClass: "equity", meta: { exit_load: { pct: 2, days: 730 } } }, RULES, "2026-09-11").exit_load_pct).toBe(2);
  });
});

describe("triggers (FO-160)", () => {
  const s = SNAP();
  it("fires funding need and band breach; the calendar only on its date; nothing when nothing is due", () => {
    const fired = evaluateTriggers(PROGRAM, s, { today: "2026-09-11", lastRunAt: "2026-07-01" });
    const kinds = fired.map((f) => f.kind); expect(kinds).toContain("funding_need"); expect(kinds).toContain("band_breach"); expect(kinds).not.toContain("calendar");
    expect(fired.find((f) => f.kind === "funding_need")!.detail.needs[0]).toMatchObject({ id: "varaha", shortfall: 20000 }); expect(fired.find((f) => f.kind === "funding_need")!.detail.idle_cash).toBe(10600);
    expect(evaluateTriggers(PROGRAM, s, { today: "2026-10-01", lastRunAt: "2026-07-01" }).some((f) => f.kind === "calendar" && f.detail.scheduled_for === "2026-10-01")).toBe(true);
    const quiet = { ...s, needs: [], targets: s.targets.map((t) => ({ ...t, min: 0, max: 100 })) };
    expect(evaluateTriggers(PROGRAM, quiet, { today: "2026-09-11", lastRunAt: "2026-09-10" })).toEqual([]);
    expect(evaluateTriggers({ ...PROGRAM, drift_threshold_pp: 20 }, quiet, { today: "2026-09-11", lastRunAt: "2026-09-10" }).map((f) => f.kind)).toEqual(["drift_threshold"]);
  });
  it("fires milestones once (3 years to go for the MBA goal), glide steps, life events, large flows, tax year-end and policy changes", () => {
    const g = { targetYear: 2029, fundedPct: 68, glideStepYears: [2026, 2031] }; const p = { ...PROGRAM, band_trigger: false, calendar_rrule: null }; const q = { ...s, needs: [] };
    expect(evaluateTriggers(p, q, { today: "2026-08-12", goal: g, lastRunAt: "2026-08-01" }).map((x) => x.detail.milestone)).toEqual(["goal_years_to_go:3", "glide_step:"]);
    expect(evaluateTriggers(p, q, { today: "2026-08-12", goal: g, lastRunAt: "2026-08-01", firedMilestones: ["goal_years_to_go:3", "glide_step:"] })).toEqual([]);
    expect(evaluateTriggers(p, q, { today: "2026-09-11", lastRunAt: "2026-09-10", lifeEvents: ["retirement"], flowPct: 6, policyChangedAt: "2026-09-11T08:00:00Z" }).map((x) => x.kind).sort()).toEqual(["large_flow", "milestone", "policy_change"]);
    expect(evaluateTriggers(p, q, { today: "2027-03-02", lastRunAt: "2027-03-01" }).map((x) => x.kind)).toEqual(["tax_year_end"]);
    expect(evaluateTriggers(p, q, { today: "2027-03-02", lastRunAt: "2027-03-01", lastTaxYearEndRunFy: "2026-27" })).toEqual([]);
  });
});

describe("solver (FO-163)", () => {
  it("funds the Varaha call: idle cash, one month of redirected SIP, then a tax-aware redemption timed to settle before the need", () => {
    const p = solve(SNAP(), "fund_needs_only");
    expect(p.warnings).toEqual([]); expect(p.summary.needs_covered).toBe(1); expect(p.summary.idle_cash).toBe(10600); expect(p.summary.est_tax).toBe(0);
    expect(p.moves.map((m) => m.kind)).toEqual(["hold_cash", "sip_change", "redeem"]);
    const hold = p.moves[0]; expect(hold.amount).toBe(10600); expect(hold.needId).toBe("varaha");
    expect(p.moves[1]).toMatchObject({ amount: 2000, plannedDate: "2026-10-01" });
    const sale = p.moves[2];
    expect(sale.fromHoldingId).toBe("baf"); expect(sale.fromLotIds).toEqual(["baf-2024"]); expect(sale.amount).toBe(7400); expect(sale.quantity).toBe(74); // LTCG-eligible lot without exit load, lowest gain ratio
    expect(sale.latestDate).toBe("2026-10-09"); expect(sale.plannedDate).toBe("2026-10-09"); expect(sale.settlesOn).toBe("2026-10-12"); // need 14 Oct − 2 d buffer − T+3
    expect(sale.constraintsChecked.join(" | ")).toMatch(/LTCG-eligible since 2025-01-10/); expect(sale.constraintsChecked.join(" | ")).toMatch(/settles 2026-10-12 ≤ need 2026-10-14/); expect(sale.constraintsChecked.join(" | ")).toMatch(/within exemption → tax ₹0/);
    const cov = p.coverage[0]; expect(cov.covered).toBe(20000); expect(cov.sources.map((x) => x.kind)).toEqual(["cash", "move", "move"]);
    expect(p.cashTimeline[p.cashTimeline.length - 1].balance).toBe(0);
  });
  it("never sells a lot under lock-in and warns when a hard need stays uncovered", () => {
    const s = SNAP(); s.needs = [{ id: "big", label: "Land purchase", date: "2026-09-25", amount: 200000, priority: 1, flexibilityDays: 0, entityId: HUF, fundedAmount: 0 }];
    const p = solve(s, "fund_needs_only", { prefer_new_cash: false });
    const soldLots = p.moves.flatMap((m) => m.fromLotIds ?? []); expect(soldLots).not.toContain("elss-1"); expect(soldLots).not.toContain("baf-2025"); // lock-in; exit load until Nov cannot wait for a 25 Sep need
    expect(p.summary.exit_loads_avoided).toBeGreaterThanOrEqual(1); expect(p.summary.needs_uncovered).toBe(1); expect(p.warnings[0]).toMatch(/Land purchase.*uncovered — hard need/);
    expect(p.coverage[0].shortfall).toBeGreaterThan(0); expect(p.coverage[0].covered + p.coverage[0].shortfall).toBe(200000);
  });
  it("brings bands back to target within the turnover cap, funding under-weights after the sells settle", () => {
    const s = SNAP(); s.needs = [];
    const p = solve(s, "back_to_target");
    const sells = p.moves.filter((m) => m.kind === "sell" || m.kind === "redeem"), buys = p.moves.filter((m) => m.kind === "buy");
    expect(sells.length).toBeGreaterThan(0); expect(sells.reduce((x, m) => x + m.amount, 0)).toBeLessThanOrEqual(p.summary.total * 0.15 + 1700); // sells capped at 15% of the book (+ whole-share rounding); buys also draw on idle cash
    expect(p.warnings.some((w) => /turnover cap 15%/.test(w))).toBe(true);
    expect(buys.every((b) => b.dependsOnSeq != null && b.plannedDate >= p.moves.find((m) => m.seq === b.dependsOnSeq)!.settlesOn)).toBe(true);
    expect(buys.map((b) => b.toAllocClass).sort()).toEqual(["debt"]); expect(buys[0].toInstrumentId).toBe("i-tmf");
    expect(p.allocationAfter.find((a) => a.key === "equity")!.actual_pct).toBeLessThan(p.allocationAfter.find((a) => a.key === "equity")!.before_pct);
    expect(sells.every((m) => m.quantity! % 1 === 0 || m.kind === "redeem")).toBe(true); // whole shares for listed stock
  });
  it("to_band_edge trims only to the edge; needs_plus_bands leaves in-band classes alone", () => {
    const s = SNAP(); s.needs = [];
    const edge = solve(s, "to_band_edge", { max_turnover_pct: 50 }); expect(edge.allocationAfter.find((a) => a.key === "equity")!.actual_pct).toBeCloseTo(55, 0);
    const wide = SNAP(); wide.needs = []; wide.targets = wide.targets.map((t) => ({ ...t, min: 0, max: 100 }));
    expect(solve(wide, "needs_plus_bands").moves).toEqual([]);
  });
  it("defers a taxed long-term trim inside 60 days of the FY end to next year's exemption", () => {
    const s = SNAP(); s.asOf = "2027-02-15"; s.needs = []; s.exemptionRemaining = { [HUF]: 0, [ARJUN]: 0 }; s.contributions = [];
    const p = solve(s, "to_band_edge", { max_turnover_pct: 50 });
    const deferred = p.moves.filter((m) => m.plannedDate === "2027-04-03"); expect(deferred.length).toBeGreaterThan(0);
    expect(deferred[0].constraintsChecked.join(" | ")).toMatch(/deferred to 2027-04-03/); expect(deferred[0].estTax).toBe(0); // gain falls inside next FY's ₹1.25 L exemption
  });
  it("tax year-end run books gains within the exemption and harvests losses before 31 March, dated by hand where the operator says so", () => {
    const s = SNAP(); s.asOf = "2027-02-20"; s.needs = []; s.contributions = []; s.targets = s.targets.map((t) => ({ ...t, min: 0, max: 100 })); s.exemptionRemaining = { [HUF]: 125000, [ARJUN]: 3000 };
    s.holdings.push({ id: "axis-sc", entityId: HUF, instrumentId: "i-axis", name: "Axis Small Cap", allocClass: "equity", bucket: "growth", price: 50, assetClass: "equity", instrumentType: "mf", lots: [{ id: "axis-1", buyDate: "2025-08-01", qty: 100, unitCost: 62, ltcgEligibleOn: "2026-08-01", exitLoadUntil: "2026-08-01", settlementDays: 3 }] });
    const p = solve(s, "needs_plus_bands", {}, { taxYearEnd: true });
    const book = p.moves.find((m) => /use ₹3,000 LTCG exemption/.test(m.reason))!; expect(book.fromHoldingId).toBe("hdfc"); expect(book.estGain).toBeLessThanOrEqual(3000); expect(book.estTax).toBe(0); expect(book.plannedDate <= "2027-03-31").toBe(true);
    const harvest = p.moves.find((m) => m.reason === "tax year-end: harvest loss")!; expect(harvest.fromHoldingId).toBe("axis-sc"); expect(harvest.estGain).toBe(-1200); expect(harvest.plannedDate).toBe("2027-03-20");
    const dated = solve(s, "needs_plus_bands", {}, { taxYearEnd: true, dateOverrides: { [harvest.seq]: "2027-03-25" } }); const h2 = dated.moves.find((m) => m.reason === "tax year-end: harvest loss")!;
    expect(h2.plannedDate).toBe("2027-03-25"); expect(h2.constraintsChecked.join(" | ")).toMatch(/date set by hand to 2027-03-25 \(inside/);
    expect(solve(s, "needs_plus_bands", {}, { taxYearEnd: true, excludeHoldingIds: ["axis-sc"] }).moves.some((m) => m.fromHoldingId === "axis-sc")).toBe(false);
  });
});
