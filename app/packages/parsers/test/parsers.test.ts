import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { parseZerodhaTradebook, parseCasText, parseBankCsv, parseAaDeposit, parseForm26AS, parseMappedContractNote, detect, parseDate, dedupKey } from "../src/index.js";
const S = (f: string) => readFileSync(new URL(`../../../../samples/${f}`, import.meta.url), "utf8");
describe("helpers", () => {
  it("parses Indian date formats", () => { expect(parseDate("11/09/26")).toBe("2026-09-11"); expect(parseDate("01-Sep-2026")).toBe("2026-09-01"); expect(parseDate("2026-09-01")).toBe("2026-09-01"); expect(parseDate("14-03-2022")).toBe("2022-03-14"); });
  it("dedup keys are stable", () => { expect(dedupKey(["a", 1])).toBe(dedupKey(["a", 1])); expect(dedupKey(["a", 1])).not.toBe(dedupKey(["a", 2])); });
});
describe("zerodha", () => {
  it("parses the sample tradebook", () => {
    const r = parseZerodhaTradebook(S("zerodha_tradebook_FY2026-27.csv"));
    expect(r.errors).toEqual([]); expect(r.rows.length).toBe(4);
    const sell = r.rows.find((x) => x.type === "sell")!; expect(sell.instrument.symbol).toBe("INFY"); expect(sell.amount).toBeCloseTo(6200, 0); expect(sell.date).toBe("2026-07-04");
  });
});
describe("cas", () => {
  it("parses folios, schemes, SIPs and redemptions with PAN attribution", () => {
    const r = parseCasText(S("cams_cas_extracted_text_sample.txt"));
    expect(r.errors).toEqual([]); expect(r.rows.length).toBe(6);
    const ppfas = r.rows.filter((x) => x.instrument.amfiCode === "122639"); expect(ppfas.length).toBe(3); expect(ppfas[1].type).toBe("sip"); expect(ppfas[0].entityHint?.pan).toBe("ABCDE1234H");
    const red = r.rows.find((x) => x.type === "redemption")!; expect(red.quantity).toBe(41.2); expect(red.amount).toBe(4600);
    expect(r.rows[0].entityHint?.pan).toBe("ABCDE1234A"); expect(r.rows[0].account.identifier).toBe("5566123456 / 33");
  });
});
describe("bank", () => {
  it("detects HDFC layout and signs amounts", () => {
    const r = parseBankCsv(S("hdfc_bank_statement_sep2026.csv"), "4471");
    expect(r.provider).toBe("hdfc"); expect(r.errors).toEqual([]); expect(r.rows.length).toBe(6);
    expect(r.rows.find((x) => /KOVAI/.test(x.narration))!.amount).toBe(2565); expect(r.rows.find((x) => /PROPERTY TAX/.test(x.narration))!.amount).toBe(-482);
  });
  it("parses AA deposit data with balance", () => {
    const r = parseAaDeposit(JSON.parse(S("aa_fi_data_deposit_sample.json")));
    expect(r.rows.length).toBe(3); expect(r.balance).toBe(18623); expect(r.rows[1].amount).toBe(-2000);
  });
});
describe("26AS", () => {
  it("attributes section rows to deductors", () => {
    const r = parseForm26AS(S("form26as_mehta_huf_FY2026-27.txt"));
    expect(r.errors).toEqual([]); expect(r.rows.length).toBe(7);
    expect(r.rows.filter((x) => x.section === "194I").reduce((s, x) => s + x.tdsDeducted, 0)).toBe(1710); expect(r.rows[6].deductorTan).toBe("MUMS12345B"); expect(r.rows[0].fy).toBe("2026-27");
  });
});
describe("mapping assistant", () => {
  it("parses ICICI Direct with a user mapping and sums charges", () => {
    const r = parseMappedContractNote(S("icicidirect_contract_note_sample.csv"), { date: "Trade Date", instrument: "Scrip", isin: "ISIN", side: "Buy/Sell", quantity: "Quantity", price: "Rate", charges: ["Brokerage", "STT", "Exchange Txn Charges", "GST", "SEBI Fee", "Stamp Duty"], ref: "Contract Note No" }, "icicidirect");
    expect(r.errors).toEqual([]); expect(r.rows[0].type).toBe("buy"); expect(r.rows[0].charges).toBeCloseTo(18.01, 2); expect(r.rows[1].type).toBe("sell");
  });
});
describe("detect", () => {
  it("recognises each sample", () => {
    expect(detect(S("zerodha_tradebook_FY2026-27.csv"))).toBe("zerodha"); expect(detect(S("cams_cas_extracted_text_sample.txt"))).toBe("cas");
    expect(detect(S("hdfc_bank_statement_sep2026.csv"))).toBe("bank_csv"); expect(detect(S("form26as_mehta_huf_FY2026-27.txt"))).toBe("form26as");
    expect(detect(S("aa_fi_data_deposit_sample.json"))).toBe("aa"); expect(detect(S("icicidirect_contract_note_sample.csv"))).toBe(null);
  });
});
