import { describe, it, expect } from "vitest";
import { resolveEffective, diffClauses, validateClauses, scoreQuestionnaire, PROFILE_TEMPLATES, seriesMetrics, periodicReturns, concentration, expectedPortfolio, evaluateCompliance, checkIntent, allocClassOf, emptyClauses, type PolicyClauses, type Position } from "../src/policy.js";

const family: PolicyClauses = { ...emptyClauses(),
  objectives: { return_objective_pct: 6, return_basis: "real", horizon_years: 30 }, risk: { profile: "moderate", max_drawdown_pct: -20 },
  constraints: { liquidity_months: 24, tax: { prefer_direct_plans: true, ltcg_first: true } }, permitted: { prohibited: ["f&o", "crypto", "unrated_debt", "single_stocks > 5"], min_rating: "AA" },
  rebalancing: { method: "both", calendar: "quarterly", tolerance_pp: 5 }, guardrails: { approval_tiers: [{ up_to: 500000, approvers: 1 }] },
  allocations: [{ lens: "asset_class", key: "equity", target_pct: 60, min_pct: 50, max_pct: 70 }, { lens: "asset_class", key: "debt", target_pct: 25, min_pct: 20, max_pct: 35 }, { lens: "asset_class", key: "gold", target_pct: 5, min_pct: 3, max_pct: 10 }, { lens: "asset_class", key: "cash", target_pct: 10, min_pct: 5, max_pct: 15 }],
  risk_limits: [{ metric: "max_drawdown", operator: ">=", limit_value: -20, warn_value: -15 }, { metric: "volatility_1y", operator: "<=", limit_value: 18, warn_value: 15 }],
  ips_rules: [{ code: "max_single_issuer", params: { pct: 10 } }, { code: "max_illiquid_pct", params: { pct: 25 } }] };
const goal: PolicyClauses = { ...emptyClauses(),
  objectives: { return_objective_pct: 5, horizon_years: 10 }, risk: { profile: "moderately_conservative", max_drawdown_pct: -12 }, constraints: { liquidity_months: 36 }, permitted: { min_rating: "AA+" },
  allocations: [{ lens: "asset_class", key: "equity", target_pct: 45, min_pct: 35, max_pct: 55 }, { lens: "asset_class", key: "debt", target_pct: 40, min_pct: 30, max_pct: 50 }, { lens: "asset_class", key: "gold", target_pct: 5, min_pct: 3, max_pct: 10 }, { lens: "asset_class", key: "cash", target_pct: 10, min_pct: 3, max_pct: 15 }],
  risk_limits: [{ metric: "max_drawdown", operator: ">=", limit_value: -12, warn_value: -9 }], ips_rules: [{ code: "max_illiquid_pct", params: { pct: 10 } }],
  glide_path: { steps: [{ year: 2026, equity_pct: 45 }, { year: 2031, equity_pct: 42 }, { year: 2036, equity_pct: 27 }] } };

describe("inheritance, diff, validation (FO-140)", () => {
  it("resolves family ∘ goal clause by clause with origin", () => {
    const { clauses, items } = resolveEffective([{ id: "fam", name: "Family", clauses: family }, { id: "ret", name: "Retirement", clauses: goal }]);
    expect(clauses.objectives.return_objective_pct).toBe(5); expect(clauses.objectives.return_basis).toBe("real"); // merged scalar sections
    expect(clauses.permitted.prohibited).toEqual(family.permitted.prohibited); expect(clauses.permitted.min_rating).toBe("AA+");
    expect(clauses.allocations.find((a) => a.key === "equity")!.target_pct).toBe(45); expect(clauses.allocations.length).toBe(4);
    expect(clauses.risk_limits.find((l) => l.metric === "max_drawdown")!.limit_value).toBe(-12); expect(clauses.risk_limits.find((l) => l.metric === "volatility_1y")!.limit_value).toBe(18);
    expect(clauses.ips_rules.find((r) => r.code === "max_single_issuer")!.params.pct).toBe(10); expect(clauses.ips_rules.find((r) => r.code === "max_illiquid_pct")!.params.pct).toBe(10);
    const overrides = items.filter((i) => !i.inherited); const inherited = items.filter((i) => i.inherited);
    expect(overrides.map((i) => `${i.section}.${i.key}`).sort()).toEqual(["allocation.asset_class:cash", "allocation.asset_class:debt", "allocation.asset_class:equity", "constraints.liquidity_months", "glide_path.steps", "ips_rule.max_illiquid_pct", "objectives.horizon_years", "objectives.return_objective_pct", "permitted.min_rating", "risk.max_drawdown_pct", "risk.profile", "risk_limit.max_drawdown"]);
    expect(overrides.find((i) => i.key === "liquidity_months")!.parent_value).toBe(24); expect(inherited.find((i) => i.key === "prohibited")!.origin).toBe("Family");
    expect(items.find((i) => i.key === "asset_class:gold")!.inherited).toBe(true); // same value as the parent → shown as inherited
  });
  it("diff lists changed clauses only", () => {
    const v2 = { ...goal, constraints: { liquidity_months: 30 }, allocations: goal.allocations.map((a) => (a.key === "equity" ? { ...a, target_pct: 40, max_pct: 50 } : a)), ips_rules: [] };
    const d = diffClauses(goal, v2);
    expect(d.map((x) => `${x.section}.${x.key}`).sort()).toEqual(["allocation.asset_class:equity", "constraints.liquidity_months", "ips_rule.max_illiquid_pct"]);
    expect(d.find((x) => x.key === "liquidity_months")).toMatchObject({ before: 36, after: 30 }); expect(d.find((x) => x.section === "ips_rule")!.after).toBeNull();
  });
  it("validates lens sums and bands", () => {
    expect(validateClauses(goal)).toEqual([]);
    const bad = { ...goal, allocations: [{ lens: "asset_class" as const, key: "equity", target_pct: 60, min_pct: 65, max_pct: 70 }, { lens: "asset_class" as const, key: "debt", target_pct: 30 }], risk_limits: [{ metric: "volatility_1y", operator: "<=" as const, limit_value: 10, warn_value: 12 }], permitted: { min_rating: "ZZ" } };
    const errs = validateClauses(bad).map((e) => e.field);
    expect(errs).toContain("allocations.asset_class"); expect(errs).toContain("allocations.asset_class.equity"); expect(errs).toContain("risk_limits.volatility_1y"); expect(errs).toContain("permitted.min_rating");
  });
});

const QUESTIONS = [
  ...[1, 2, 3, 4].map((i) => ({ id: `q${i}`, dimension: "capacity" as const, text: "", options: [{ label: "low", score: 1 }, { label: "mid", score: 3 }, { label: "high", score: 5 }] })),
  ...[5, 6, 7, 8].map((i) => ({ id: `q${i}`, dimension: "tolerance" as const, text: "", options: [{ label: "low", score: 1 }, { label: "mid", score: 3 }, { label: "high", score: 5 }] })),
  ...[9, 10].map((i) => ({ id: `q${i}`, dimension: "horizon" as const, text: "", options: [{ label: "low", score: 1 }, { label: "mid", score: 3 }, { label: "high", score: 5 }] })),
  ...[11, 12].map((i) => ({ id: `q${i}`, dimension: "knowledge" as const, text: "", options: [{ label: "low", score: 1 }, { label: "mid", score: 3 }, { label: "high", score: 5 }] })),
];
const SCORING = { weights: { capacity: 0.45, tolerance: 0.3, horizon: 0.15, knowledge: 0.1 }, bands: [{ max: 28, profile: "conservative" as const }, { max: 44, profile: "moderately_conservative" as const }, { max: 60, profile: "moderate" as const }, { max: 76, profile: "moderately_aggressive" as const }, { max: 100, profile: "aggressive" as const }] };
describe("risk profiling (FO-141)", () => {
  it("reproduces the prototype retirement profile: weighted 44, moderately conservative, capacity caps tolerance", () => {
    const answers = { q1: "mid", q2: "mid", q3: "mid", q4: "low", q5: "mid", q6: "mid", q7: "mid", q8: "mid", q9: "mid", q10: "mid", q11: "mid", q12: "mid" };
    const r = scoreQuestionnaire(QUESTIONS, SCORING, answers);
    expect(Math.round(r.score)).toBe(44); expect(r.capacity_score).toBe(37.5); expect(r.tolerance_score).toBe(50);
    expect(r.profile).toBe("moderately_conservative"); expect(r.notes).toContain("capacity caps tolerance");
    expect(PROFILE_TEMPLATES[r.profile].max_drawdown_pct).toBe(-12); expect(PROFILE_TEMPLATES[r.profile].liquidity_months).toBe(36);
  });
  it("high tolerance with low capacity profiles to the capacity band; a short horizon steps down", () => {
    const low = Object.fromEntries(QUESTIONS.map((q) => [q.id, q.dimension === "capacity" ? "low" : "high"]));
    expect(scoreQuestionnaire(QUESTIONS, SCORING, low).profile).toBe("conservative");
    const short = Object.fromEntries(QUESTIONS.map((q) => [q.id, q.dimension === "horizon" ? "low" : "high"]));
    const r = scoreQuestionnaire(QUESTIONS, SCORING, short); expect(r.profile).toBe("moderately_aggressive"); expect(r.notes).toContain("short horizon pulls the band down");
  });
});

describe("risk metrics (FO-143)", () => {
  const R = [0.021, -0.034, 0.015, 0.048, -0.012, 0.009, -0.057, 0.031, 0.018, -0.022, 0.027, 0.011];
  const B = [0.018, -0.028, 0.012, 0.041, -0.015, 0.007, -0.049, 0.026, 0.02, -0.018, 0.024, 0.009];
  it("matches reference calculations to 2 dp", () => {
    const m = seriesMetrics(R, { benchmark: B, riskFreePct: 6.5 });
    expect(m.volatility_1y).toBe(10.43); expect(m.max_drawdown).toBe(-5.99); expect(m.var_95_1m).toBe(4.44); expect(m.annual_return).toBe(5.11);
    expect(m.sharpe).toBe(-0.13); expect(m.beta).toBe(1.15); expect(m.tracking_error).toBe(1.59); expect(m.periods).toBe(12);
  });
  it("needs enough history and derives periodic returns from valuations", () => {
    expect(seriesMetrics(R.slice(0, 4)).volatility_1y).toBeNull();
    const vals = [100, 103, 99.5, 101, 106, 104.5, 105.5, 99.5, 102.5, 104.4, 102.1, 104.9, 106.05].map((v, i) => ({ date: `2025-${String(i + 1).padStart(2, "0")}-28`.replace("2025-13", "2026-01"), value: v }));
    const rets = periodicReturns(vals); expect(rets.length).toBe(12); expect(rets[0].ret).toBeCloseTo(0.03, 6); expect(rets[6].ret).toBeCloseTo(-0.056872, 6);
    const withFlow = periodicReturns([{ date: "2026-01-31", value: 100 }, { date: "2026-02-28", value: 160 }], [{ date: "2026-02-14", amount: 50 }]);
    expect(withFlow[0].ret).toBeCloseTo(10 / 125, 4); // Modified Dietz: +50 mid-month weighted 0.5
  });
  const P: Position[] = [
    { id: "hdfc", name: "HDFC Bank", value: 8100, allocClass: "equity", instrumentType: "stock", issuer: "HDFC Bank", sector: "Financials", liquidityClass: "t1", currency: "INR" },
    { id: "tcs", name: "TCS", value: 4200, allocClass: "equity", instrumentType: "stock", issuer: "TCS", sector: "IT", liquidityClass: "t1" },
    { id: "ppfas", name: "PPFAS Flexi", value: 20000, allocClass: "equity", instrumentType: "mf", manager: "PPFAS", sector: null, liquidityClass: "t3" },
    { id: "pms", name: "Marcellus PMS", value: 15000, allocClass: "equity", instrumentType: "pms", manager: "Marcellus", liquidityClass: "quarterly" },
    { id: "sbi", name: "SBI 7.72% 2033", value: 9900, allocClass: "debt", instrumentType: "bond", issuer: "SBI", rating: "AAA", modifiedDuration: 5.2, sector: "Financials" },
    { id: "neo", name: "Neo Credit AIF", value: 12000, allocClass: "alternatives", instrumentType: "aif", manager: "Neo", liquidityClass: "locked" },
    { id: "liq", name: "ICICI Liquid", value: 18000, allocClass: "cash", instrumentType: "mf", manager: "ICICI Pru", liquidityClass: "t1" },
    { id: "gsec", name: "GOI 2030", value: 6000, allocClass: "debt", instrumentType: "gsec", modifiedDuration: 3.8 },
    { id: "usd", name: "Nasdaq 100 FoF", value: 6800, allocClass: "global", instrumentType: "mf", manager: "Motilal", currency: "USD", liquidityClass: "t3" },
  ];
  it("computes concentration, illiquidity, unrated, fx and duration", () => {
    const c = concentration(P); expect(c.total).toBe(100000);
    expect(c.concentration_top5).toBe(74.9); expect(c.issuer_max).toBe(9.9); expect(c.issuer_top).toBe("SBI"); expect(c.manager_max).toBe(20); expect(c.manager_top).toBe("PPFAS");
    expect(c.sector_max).toBe(18); expect(c.illiquid_max).toBe(27); expect(c.unrated_debt_max).toBe(0); expect(c.fx_exposure_max).toBe(6.8); expect(c.duration_max).toBe(4.67); expect(c.single_stock_max).toBe(8.1);
  });
  it("expected return and volatility of a target mix", () => { expect(expectedPortfolio({ equity: 45, debt: 40, gold: 10, cash: 5 })).toEqual({ ret: 9.28, vol: 8.22 }); });
  it("maps tax asset classes to allocation classes", () => {
    expect(allocClassOf("equity", "mf")).toBe("equity"); expect(allocClassOf("debt_mf_post_apr23", "aif")).toBe("alternatives"); expect(allocClassOf("listed_bond", "bond")).toBe("debt");
    expect(allocClassOf("arbitrage_fund", "mf")).toBe("cash"); expect(allocClassOf("gold_etf", "etf")).toBe("gold"); expect(allocClassOf("intl_equity", "mf")).toBe("global"); expect(allocClassOf("reit", "etf")).toBe("real_estate");
  });
});

describe("compliance (FO-144)", () => {
  const eff = resolveEffective([{ id: "fam", name: "Family", clauses: family }, { id: "ret", name: "Retirement", clauses: goal }]).clauses;
  const positions: Position[] = [
    { id: "a", name: "Balanced fund", value: 58900, allocClass: "equity", instrumentType: "mf", manager: "HDFC AMC", liquidityClass: "t3" },
    { id: "b", name: "HDFC Bank", value: 8100, allocClass: "equity", instrumentType: "stock", issuer: "HDFC Bank", sector: "Financials" },
    { id: "c", name: "Target maturity", value: 21000, allocClass: "debt", instrumentType: "mf", manager: "Edelweiss", rating: "AAA" },
    { id: "d", name: "Gold ETF", value: 2700, allocClass: "gold", instrumentType: "etf" }, { id: "e", name: "Liquid", value: 9300, allocClass: "cash", instrumentType: "mf" },
  ];
  const snap = { allocation: { asset_class: { equity: 67, debt: 21, gold: 2.7, cash: 9.3 } }, metrics: { max_drawdown: -9.4, volatility_1y: 12.6, issuer_max: 8.1, issuer_top: "HDFC Bank", illiquid_max: 0 } as any, positions, liquidityMonths: 41, year: 2026 };
  it("reproduces the prototype snapshot: equity breach, gold warning, drawdown warning, issuer and liquidity in band, glide in band", () => {
    const c = evaluateCompliance(eff, snap);
    const by = Object.fromEntries(c.checks.map((x) => [x.key, x]));
    expect(by["asset_class:equity"].status).toBe("breach"); expect(by["asset_class:equity"].detail).toMatch(/12 pp above/);
    expect(by["asset_class:gold"].status).toBe("warning"); expect(by["asset_class:debt"].status).toBe("breach"); expect(by["asset_class:cash"].status).toBe("in_band");
    expect(by["max_drawdown"].status).toBe("warning"); expect(by["volatility_1y"].status).toBe("in_band");
    expect(by["liquidity_coverage"].status).toBe("in_band"); expect(by["max_single_issuer"].status).toBe("in_band"); expect(by["max_single_issuer"].detail).toBe("HDFC Bank");
    expect(by["prohibited"].status).toBe("breach"); expect(by["prohibited"].detail).toMatch(/HDFC Bank 8.1% > 5%/); // single stocks > 5% clause
    expect(by["min_rating"].status).toBe("in_band"); expect(by["growth_vs_glide"].status).toBe("breach"); expect(by["growth_vs_glide"].target).toBe("45% (2026)");
    expect(c.overall).toBe("breach"); expect(c.breaches).toBe(4); expect(c.warnings).toBe(2);
  });
  it("interpolates the glide path and marks metrics without history n/a", () => {
    const c = evaluateCompliance(eff, { ...snap, year: 2033, metrics: {}, allocation: { asset_class: { equity: 36, debt: 50, gold: 5, cash: 9 } } });
    const g = c.checks.find((x) => x.kind === "glide_path")!; expect(g.target).toBe("36% (2033)"); expect(g.status).toBe("in_band");
    expect(c.checks.find((x) => x.key === "max_drawdown")!.status).toBe("n/a"); expect(c.overall).toBe("breach"); // the single-stock clause still bites
  });
  it("refuses a prohibited or band-worsening intent and cites the clause", () => {
    expect(checkIntent(eff, snap, { instrumentType: "crypto", name: "BTC", amount: 1000, direction: "buy" })).toMatchObject({ pass: false, clause: "permitted.prohibited" });
    expect(checkIntent(eff, snap, { instrumentType: "bond", name: "XYZ NCD", allocClass: "debt", rating: "A+", amount: 1000, direction: "buy" })).toMatchObject({ pass: false, clause: "permitted.min_rating" });
    const eq = checkIntent(eff, snap, { instrumentType: "mf", name: "Nifty index", allocClass: "equity", amount: 5000, direction: "buy" }); expect(eq.pass).toBe(false); expect(eq.clause).toBe("allocation.asset_class:equity");
    expect(checkIntent(eff, snap, { instrumentType: "mf", name: "Target maturity 2029", allocClass: "debt", rating: "AAA", amount: 5000, direction: "buy" }).pass).toBe(true);
  });
});
