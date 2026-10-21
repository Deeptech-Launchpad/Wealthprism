/** Normalised records every parser emits. Amounts are numbers in rupees; dates ISO yyyy-mm-dd. */
export interface ParsedInvestmentTxn {
  source: "cas" | "contract_note";
  provider: string;                 // cams | kfintech | zerodha | icicidirect | generic
  entityHint?: { pan?: string; name?: string };
  account: { kind: "mf_folio" | "demat"; identifier: string };
  instrument: { name: string; isin?: string; amfiCode?: string; symbol?: string; type: "mf" | "stock" | "bond" | "etf" };
  type: "buy" | "sell" | "sip" | "redemption" | "switch_in" | "switch_out" | "dividend";
  date: string;
  quantity: number;
  price: number;
  amount: number;
  charges: number;
  ref: string;                       // provider reference for de-dup
}
export interface ParsedBankTxn {
  source: "bank_csv" | "aa";
  provider: string;
  accountHint?: { masked?: string; ifsc?: string };
  date: string;
  valueDate?: string;
  narration: string;
  amount: number;                    // +credit / -debit
  balanceAfter?: number;
  ref: string;
}
export interface ParsedTdsEntry { deductorName: string; deductorTan: string; section: string; date: string; amountPaid: number; tdsDeducted: number; tdsDeposited: number; pan?: string; fy?: string; assessee?: string }
export interface ParseResult<T> { rows: T[]; errors: { row: number; message: string }[]; detectedHeaders?: string[]; provider: string }
export class ParseError extends Error {}
/** Stable hash for de-duplication: same source record always yields the same key. */
export function dedupKey(parts: (string | number | undefined)[]): string {
  const s = parts.map((p) => (p ?? "")).join("|");
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, "0") + ":" + s.length;
}
export function parseIndianNumber(v: string): number {
  const t = v.replace(/[,₹\s]/g, "").replace(/^\((.*)\)$/, "-$1");
  if (t === "" || t === "-") return 0;
  const n = Number(t);
  if (Number.isNaN(n)) throw new ParseError(`not a number: ${v}`);
  return n;
}
const MON: Record<string, string> = { jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06", jul: "07", aug: "08", sep: "09", sept: "09", oct: "10", nov: "11", dec: "12" };
/** Accepts dd/mm/yy, dd/mm/yyyy, dd-Mon-yyyy, yyyy-mm-dd, dd-mm-yyyy. */
export function parseDate(v: string): string {
  const s = v.trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/); if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{2,4})$/); if (m) { const y = m[3].length === 2 ? "20" + m[3] : m[3]; return `${y}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`; }
  m = s.match(/^(\d{1,2})[- ]([A-Za-z]{3,4})[- ](\d{4})$/); if (m) { const mm = MON[m[2].toLowerCase()]; if (mm) return `${m[3]}-${mm}-${m[1].padStart(2, "0")}`; }
  throw new ParseError(`unrecognised date: ${v}`);
}
export function csv(text: string): string[][] {
  const rows: string[][] = []; let row: string[] = []; let cell = ""; let q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch; }
    else if (ch === '"') q = true;
    else if (ch === ",") { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") { if (ch === "\r" && text[i + 1] === "\n") i++; row.push(cell); rows.push(row); row = []; cell = ""; }
    else cell += ch;
  }
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}
