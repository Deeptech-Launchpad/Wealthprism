import { describe, it, expect } from "vitest";
import { parseAmfiNavAll, parseAmfiHistory } from "../src/index.js";

describe("AMFI NAV list: the current layout with Plan and Option columns", () => {
  const NEW = [
    "Scheme Code;ISIN Div Payout/ ISIN Growth;ISIN Div Reinvestment;Scheme Name;Plan;Option;Net Asset Value;Date",
    "",
    "Open Ended Schemes(Debt Scheme - Liquid Fund)",
    "",
    "Axis Mutual Fund",
    "151833;INF0QA701011;-;Bajaj Finserv Liquid Fund;Direct Plan;Growth;1247.4637;21-Oct-2026",
    "118364;INF194K01I60;-;BANDHAN LIQUID Fund;Direct Plan;Growth;3450.0993;21-Oct-2026",
    "119369;INF761K01785;-;BANK OF INDIA LIQUID FUND;Regular Plan;N.A.;N.A.;21-Oct-2026",
  ].join("\n");

  it("reads the NAV and date from the right columns instead of rejecting every row", () => {
    const r = parseAmfiNavAll(NEW);
    expect(r.rows).toHaveLength(2);
    expect(r.rows[0]).toMatchObject({ amfiCode: "151833", name: "Bajaj Finserv Liquid Fund", nav: 1247.4637, date: "2026-10-21", plan: "Direct Plan", option: "Growth", isin: "INF0QA701011", assetClass: "debt_mf_post_apr23" });
    expect(r.errors).toHaveLength(1);   // the "N.A." NAV line is skipped, never turned into a price
  });

  it("still reads the older six-column layout", () => {
    const OLD = ["Scheme Code;ISIN Div Payout/ISIN Growth;ISIN Div Reinvestment;Scheme Name;Net Asset Value;Date", "Open Ended Schemes(Debt Scheme - Liquid Fund)", "Some Mutual Fund", "100001;INF000000001;-;Old Liquid Fund - Growth;1500.25;01-Sep-2026"].join("\n");
    const r = parseAmfiNavAll(OLD);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]).toMatchObject({ amfiCode: "100001", nav: 1500.25, date: "2026-09-01" });
  });

  it("parses the history report and can keep only the schemes asked for", () => {
    const H = [
      "Scheme Code;NAV Name;Plan;Option;ISIN Div Payout/ISIN Growth;ISIN Div Reinvestment;Net Asset Value;Date",
      "Open Ended Schemes ( Debt Scheme - Liquid Fund )",
      "151833;Bajaj Finserv Liquid Fund - Direct Plan - Growth;Direct Plan;Growth;INF0QA701011;;1240.10;15-Oct-2026",
      "151833;Bajaj Finserv Liquid Fund - Direct Plan - Growth;Direct Plan;Growth;INF0QA701011;;1241.00;16-Oct-2026",
      "999999;Another Fund;Direct Plan;Growth;INF9;;10.0;15-Oct-2026",
    ].join("\n");
    expect(parseAmfiHistory(H)).toHaveLength(3);
    const only = parseAmfiHistory(H, new Set(["151833"]));
    expect(only).toHaveLength(2);
    expect(only[1]).toMatchObject({ nav: 1241, date: "2026-10-16" });
  });
});
