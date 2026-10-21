import { csv, dedupKey, parseDate, parseIndianNumber, ParsedInvestmentTxn, ParseResult } from "./types.js";
/** Mapping assistant: user maps required fields to column headers once; saved per header signature. */
export interface ContractNoteMapping { date: string; instrument: string; isin?: string; side: string; quantity: string; price: string; charges?: string[]; ref?: string; buyValues?: string[]; sellValues?: string[] }
export function headerSignature(text: string): string { return csv(text)[0].map((x) => x.trim().toLowerCase()).join("|"); }
export function parseMappedContractNote(text: string, m: ContractNoteMapping, provider = "generic"): ParseResult<ParsedInvestmentTxn> {
  const rows = csv(text); const h = rows[0].map((x) => x.trim());
  const idx = (name?: string) => (name ? h.findIndex((x) => x.toLowerCase() === name.toLowerCase()) : -1);
  const req = { date: idx(m.date), instrument: idx(m.instrument), side: idx(m.side), quantity: idx(m.quantity), price: idx(m.price) };
  const missing = Object.entries(req).filter(([, v]) => v < 0).map(([k]) => k);
  if (missing.length) return { rows: [], errors: [{ row: 0, message: "mapping refers to missing columns: " + missing.join(", ") }], detectedHeaders: h, provider };
  const buys = (m.buyValues ?? ["B", "BUY", "PURCHASE"]).map((s) => s.toUpperCase()); const sells = (m.sellValues ?? ["S", "SELL", "SALE"]).map((s) => s.toUpperCase());
  const out: ParsedInvestmentTxn[] = []; const errors: { row: number; message: string }[] = [];
  rows.slice(1).forEach((r, i) => {
    try {
      const side = (r[req.side] ?? "").trim().toUpperCase(); const type = buys.includes(side) ? "buy" : sells.includes(side) ? "sell" : null;
      if (!type) throw new Error(`unknown side "${side}"`);
      const qty = parseIndianNumber(r[req.quantity]), price = parseIndianNumber(r[req.price]);
      const charges = (m.charges ?? []).reduce((s, c) => { const k = idx(c); return s + (k >= 0 ? parseIndianNumber(r[k] || "0") : 0); }, 0);
      const isin = m.isin ? r[idx(m.isin)] : undefined;
      out.push({ source: "contract_note", provider, account: { kind: "demat", identifier: provider }, instrument: { name: r[req.instrument].trim(), isin: isin?.trim() || undefined, type: "stock" },
        type, date: parseDate(r[req.date]), quantity: qty, price, amount: +(qty * price).toFixed(2), charges: +charges.toFixed(2), ref: dedupKey([provider, m.ref ? r[idx(m.ref)] : "", r[req.date], r[req.instrument], side, qty, price]) });
    } catch (e: any) { errors.push({ row: i + 2, message: e.message }); }
  });
  return { rows: out, errors, detectedHeaders: h, provider };
}
