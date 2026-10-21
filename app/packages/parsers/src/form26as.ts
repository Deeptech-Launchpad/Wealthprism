import { parseDate, parseIndianNumber, ParsedTdsEntry, ParseResult } from "./types.js";
/** TRACES Form 26AS Part A text export (tab-separated). Deductor header rows are followed by section rows. */
export function parseForm26AS(text: string): ParseResult<ParsedTdsEntry> {
  const lines = text.split(/\r?\n/); const out: ParsedTdsEntry[] = []; const errors: { row: number; message: string }[] = [];
  let pan: string | undefined, fy: string | undefined, assessee: string | undefined, deductor: { name: string; tan: string } | undefined;
  lines.forEach((l, i) => {
    let m;
    if ((m = l.match(/Permanent Account Number:\s*([A-Z]{5}\d{4}[A-Z])/))) pan = m[1];
    if ((m = l.match(/Financial Year:\s*(\d{4}-\d{2})/))) fy = m[1];
    if ((m = l.match(/Name of Assessee:\s*([^\t]+)/))) assessee = m[1].trim();
    const cells = l.split("\t").map((x) => x.trim());
    if (cells.length >= 3 && /^[A-Z]{4}\d{5}[A-Z]$/.test(cells[2])) { deductor = { name: cells[1], tan: cells[2] }; return; }
    if (cells.length >= 9 && /^\d+$/.test(cells[0]) && /^\d{3}[A-Z]{0,2}$/.test(cells[1]) && deductor) {
      try { out.push({ deductorName: deductor.name, deductorTan: deductor.tan, section: cells[1], date: parseDate(cells[2]), amountPaid: parseIndianNumber(cells[6]), tdsDeducted: parseIndianNumber(cells[7]), tdsDeposited: parseIndianNumber(cells[8]), pan, fy, assessee }); }
      catch (e: any) { errors.push({ row: i + 1, message: e.message }); }
    }
  });
  return { rows: out, errors, provider: "traces" };
}
