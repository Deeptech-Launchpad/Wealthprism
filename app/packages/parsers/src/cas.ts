import { dedupKey, parseDate, parseIndianNumber, ParsedInvestmentTxn, ParseResult } from "./types.js";
/**
 * CAMS/KFintech detailed CAS, from text extracted with `pdftotext -layout`.
 * Recognises investor blocks (name + PAN), folios, scheme lines "<amfi>-<name> ... ISIN: <isin>", and transaction lines
 * "dd-Mon-yyyy  <description>  <amount>  <units>  <nav>  <balance>" with parentheses for negatives.
 */
export function parseCasText(text: string): ParseResult<ParsedInvestmentTxn> {
  const lines = text.split(/\r?\n/); const out: ParsedInvestmentTxn[] = []; const errors: { row: number; message: string }[] = [];
  let pan: string | undefined, investor: string | undefined, folio: string | undefined, scheme: { amfi: string; name: string; isin?: string } | undefined;
  const txnRe = /^(\d{2}-[A-Za-z]{3}-\d{4})\s+(.+?)\s{2,}(\(?[\d,]+\.\d{2}\)?)\s+(\(?[\d,]+\.\d{3}\)?)\s+([\d,]+\.\d{4})\s+([\d,]+\.\d{3})\s*$/;
  lines.forEach((raw, i) => {
    const l = raw.trim(); if (!l) return;
    let m;
    if ((m = l.match(/PAN:\s*([A-Z]{5}\d{4}[A-Z])/))) { pan = m[1]; }
    if (/^[A-Z][A-Z .]+$/.test(l) && l.length < 60 && !l.startsWith("PAN")) investor = l;               // investor name line (upper-case)
    if ((m = l.match(/^Folio No:\s*([\w\/ ]+?)\s{2,}/)) || (m = l.match(/^Folio No:\s*([\w\/ ]+)$/))) { folio = m[1].trim(); return; }
    if ((m = l.match(/^(\d{5,6})-(.+?)(?:\s+\(Advisor:[^)]*\))?\s+ISIN:\s*([A-Z0-9]{12})/))) { scheme = { amfi: m[1], name: m[2].trim(), isin: m[3] }; return; }
    if ((m = l.match(/^(\d{5,6})-(.+?)\s{2,}/)) && !l.startsWith("Closing")) { scheme = { amfi: m[1], name: m[2].trim() }; return; }
    if ((m = l.match(txnRe))) {
      if (!scheme || !folio) { errors.push({ row: i + 1, message: "transaction before folio/scheme" }); return; }
      try {
        const desc = m[2].toLowerCase(); const amount = parseIndianNumber(m[3]); const units = parseIndianNumber(m[4]); const nav = parseIndianNumber(m[5]);
        const type = /redemption/.test(desc) ? "redemption" : /switch.?out/.test(desc) ? "switch_out" : /switch.?in/.test(desc) ? "switch_in" : /systematic|sip/.test(desc) ? "sip" : /dividend|idcw/.test(desc) ? "dividend" : "buy";
        out.push({ source: "cas", provider: "cams", entityHint: { pan, name: investor }, account: { kind: "mf_folio", identifier: folio },
          instrument: { name: scheme.name, amfiCode: scheme.amfi, isin: scheme.isin, type: "mf" }, type, date: parseDate(m[1]),
          quantity: Math.abs(units), price: nav, amount: Math.abs(amount), charges: 0, ref: dedupKey(["cas", folio, scheme.amfi, m[1], m[2].trim(), amount, units]) });
      } catch (e: any) { errors.push({ row: i + 1, message: e.message }); }
    }
  });
  return { rows: out, errors, provider: "cams" };
}
