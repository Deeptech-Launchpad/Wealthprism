import { csv, dedupKey, parseDate, ParsedInvestmentTxn, ParseResult } from "./types.js";
/** Zerodha Console tradebook CSV. Charges arrive on the contract note, not here (charges = 0). */
export function parseZerodhaTradebook(text: string): ParseResult<ParsedInvestmentTxn> {
  const rows = csv(text); const h = rows[0].map((x) => x.trim().toLowerCase());
  const need = ["symbol", "isin", "trade_date", "trade_type", "quantity", "price", "trade_id"];
  if (!need.every((n) => h.includes(n))) return { rows: [], errors: [{ row: 0, message: "not a Zerodha tradebook: missing " + need.filter((n) => !h.includes(n)).join(", ") }], detectedHeaders: h, provider: "zerodha" };
  const col = (r: string[], k: string) => r[h.indexOf(k)] ?? "";
  const out: ParsedInvestmentTxn[] = []; const errors: { row: number; message: string }[] = [];
  rows.slice(1).forEach((r, i) => {
    try {
      const qty = Number(col(r, "quantity")), price = Number(col(r, "price"));
      out.push({ source: "contract_note", provider: "zerodha", account: { kind: "demat", identifier: "zerodha" },
        instrument: { name: col(r, "symbol"), isin: col(r, "isin") || undefined, symbol: col(r, "symbol"), type: /^(EQ|BE|BZ)$/i.test(col(r, "series")) || true ? "stock" : "stock" },
        type: col(r, "trade_type").toLowerCase() === "buy" ? "buy" : "sell", date: parseDate(col(r, "trade_date")), quantity: qty, price, amount: +(qty * price).toFixed(2), charges: 0,
        ref: dedupKey(["zerodha", col(r, "trade_id"), col(r, "order_id")]) });
    } catch (e: any) { errors.push({ row: i + 2, message: e.message }); }
  });
  return { rows: out, errors, detectedHeaders: h, provider: "zerodha" };
}
