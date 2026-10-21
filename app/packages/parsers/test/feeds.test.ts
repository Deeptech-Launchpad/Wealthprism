import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { parseAmfiNavAll, parseNseBhavcopy, parseNseCorporateActions, parseNseIndices, decodeCorporateAction, amfiAssetClass } from "../src/index.js";
const S = (f: string) => readFileSync(new URL(`../../../../samples/${f}`, import.meta.url), "utf8");

describe("AMFI NAVAll", () => {
  it("parses schemes under their category and AMC headers", () => {
    const r = parseAmfiNavAll(S("amfi_navall_sample.txt"));
    expect(r.errors).toEqual([]); expect(r.rows.length).toBe(7);
    const ppfas = r.rows.find((x) => x.amfiCode === "122639")!;
    expect(ppfas.isin).toBe("INF879O01027"); expect(ppfas.nav).toBe(55.9312); expect(ppfas.date).toBe("2026-09-11"); expect(ppfas.amc).toBe("PPFAS Mutual Fund"); expect(ppfas.assetClass).toBe("equity");
    expect(r.rows.find((x) => x.amfiCode === "125353")!.isinReinvest).toBe("INF846K01K43");
    expect(r.rows.find((x) => x.amfiCode === "120598")!.assetClass).toBe("debt_mf_post_apr23");
    expect(r.rows.find((x) => x.amfiCode === "119809")!.assetClass).toBe("arbitrage_fund");
  });
  it("maps categories to the tax asset classes", () => {
    expect(amfiAssetClass("Open Ended Schemes(Debt Scheme - Gilt Fund)")).toBe("debt_mf_post_apr23");
    expect(amfiAssetClass("Open Ended Schemes(Hybrid Scheme - Balanced Advantage)")).toBe("equity");
    expect(amfiAssetClass("Open Ended Schemes(Hybrid Scheme - Multi Asset Allocation)")).toBe("multi_asset");
    expect(amfiAssetClass("Open Ended Schemes(Hybrid Scheme - Conservative Hybrid Fund)")).toBe("debt_mf_post_apr23");
    expect(amfiAssetClass("Open Ended Schemes(Other Scheme - FoF Overseas)")).toBe("intl_fund");
    expect(amfiAssetClass("Open Ended Schemes(Other Scheme - Gold ETF)")).toBe("gold_fof");
  });
});

describe("NSE bhavcopy", () => {
  it("parses the UDiFF layout and classifies series", () => {
    const r = parseNseBhavcopy(S("nse_bhavcopy_sample.csv"));
    expect(r.errors).toEqual([]); expect(r.rows.length).toBe(7);
    const hdfc = r.rows.find((x) => x.symbol === "HDFCBANK")!;
    expect(hdfc.close).toBe(1735.4); expect(hdfc.isin).toBe("INE040A01034"); expect(hdfc.date).toBe("2026-09-11"); expect(hdfc.kind).toBe("stock"); expect(hdfc.prevClose).toBe(1723.81);
    expect(r.rows.find((x) => x.symbol === "SBIBOND")!.kind).toBe("bond");
    expect(r.rows.find((x) => x.symbol === "LICI")!.kind).toBe("stock");
    expect(r.rows.find((x) => x.symbol === "FOOWARR")!.kind).toBe("other");
  });
  it("parses the legacy layout", () => {
    const legacy = "SYMBOL,SERIES,OPEN,HIGH,LOW,CLOSE,LAST,PREVCLOSE,TOTTRDQTY,TOTTRDVAL,TIMESTAMP,TOTALTRADES,ISIN,\nHDFCBANK,EQ,1725,1741.9,1719.1,1735.4,1735,1723.81,18234561,31569345678.1,11-SEP-2026,412345,INE040A01034,\n";
    const r = parseNseBhavcopy(legacy);
    expect(r.rows[0]).toMatchObject({ symbol: "HDFCBANK", close: 1735.4, date: "2026-09-11", isin: "INE040A01034", kind: "stock" });
  });
});

describe("NSE corporate actions", () => {
  it("decodes subjects into typed actions and skips notices", () => {
    const r = parseNseCorporateActions(JSON.parse(S("nse_corporate_actions_sample.json")));
    expect(r.errors).toEqual([]); expect(r.rows.length).toBe(5);
    expect(r.rows[0]).toMatchObject({ symbol: "HDFCBANK", type: "bonus", ratioNum: 1, ratioDen: 1, exDate: "2026-08-28", autoApply: true });
    expect(r.rows[1]).toMatchObject({ type: "dividend", cashPerUnit: 11, autoApply: true });
    expect(r.rows[2]).toMatchObject({ type: "split", faceValueFrom: 5, faceValueTo: 1, ratioNum: 5, ratioDen: 1, autoApply: true });
    expect(r.rows[3]).toMatchObject({ symbol: "ITC", type: "demerger", autoApply: false });
    expect(r.rows[4]).toMatchObject({ type: "rights", ratioNum: 1, ratioDen: 15, cashPerUnit: 1247, autoApply: false });
  });
  it("handles more subject spellings", () => {
    expect(decodeCorporateAction("Final Dividend Rs 22 Per Share")).toMatchObject({ type: "dividend", cashPerUnit: 22 });
    expect(decodeCorporateAction("Dividend - Rs 5.50 Per Share")).toMatchObject({ type: "dividend", cashPerUnit: 5.5 });
    expect(decodeCorporateAction("Face Value Split From Rs 10/- Per Share To Rs 2/- Per Share")).toMatchObject({ type: "split", ratioNum: 5 });
    expect(decodeCorporateAction("Bonus 3:2")).toMatchObject({ type: "bonus", ratioNum: 3, ratioDen: 2 });
    expect(decodeCorporateAction("Amalgamation")).toMatchObject({ type: "merger", autoApply: false });
    expect(decodeCorporateAction("Buyback of Shares")).toMatchObject({ type: "buyback" });
    expect(decodeCorporateAction("Annual General Meeting")).toBeNull();
  });
});

describe("NSE indices", () => {
  it("maps the broad indices to benchmark codes with the feed date", () => {
    const r = parseNseIndices(JSON.parse(S("nse_all_indices_sample.json")));
    expect(r.rows).toEqual([{ code: "NIFTY50", name: "NIFTY 50", value: 25412.35, date: "2026-09-11" }, { code: "NIFTY500", name: "NIFTY 500", value: 23120.8, date: "2026-09-11" }]);
  });
});
