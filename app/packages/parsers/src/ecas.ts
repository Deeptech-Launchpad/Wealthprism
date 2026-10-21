import { parseIndianNumber, ParseResult } from "./types.js";
/**
 * NSDL / CDSL consolidated account statement (e-CAS) text: one holder (name + PAN), demat accounts with ISIN-wise holdings, and the
 * mutual-fund folios the depository consolidates. Positions only — the reconciliation engine compares them with the platform.
 */
export interface EcasPosition { account: { kind: "demat" | "mf_folio"; dpId?: string; clientId?: string; folio?: string; provider?: string }; isin?: string; name: string; quantity: number; value?: number; nav?: number }
export interface EcasStatement { depository: "NSDL" | "CDSL"; holder?: string; pan?: string; asOf?: string; positions: EcasPosition[] }
export function isEcasText(text: string) { return /(NSDL|CDSL)/.test(text) && /Consolidated Account Statement|e-?CAS/i.test(text) && /ISIN/.test(text) && !/Folio No:/.test(text); }
export function parseEcas(text: string): ParseResult<EcasStatement> {
  const lines = text.split(/\r?\n/); const errors: { row: number; message: string }[] = []; const positions: EcasPosition[] = [];
  const depository: "NSDL" | "CDSL" = /CDSL/.test(text) && !/NSDL/.test(text) ? "CDSL" : "NSDL";
  const holder = text.match(/(?:Name|Holder|Account Holder)\s*:\s*([A-Z][A-Z .]+?)\s*(?:\n|\s{2,})/)?.[1]?.trim(); const pan = text.match(/PAN\s*:?\s*([A-Z]{5}\d{4}[A-Z])/)?.[1];
  const asOfM = text.match(/(?:as on|as at|Statement for the period[^\n]*to)\s*(\d{2}-[A-Za-z]{3}-\d{4})/i); const asOf = asOfM ? toIso(asOfM[1]) : undefined;
  let account: EcasPosition["account"] | null = null;
  lines.forEach((raw, i) => {
    const l = raw.trim(); if (!l) return; let m;
    if ((m = l.match(/DP ID\s*:?\s*(IN\d{6}|\d{8})\s+Client ID\s*:?\s*(\d{8})/i)) || (m = l.match(/Demat Account\s*:?\s*(IN\d{6}|\d{8})\s*[\/\-]?\s*(\d{8})/i))) { account = { kind: "demat", dpId: m[1], clientId: m[2], provider: (l.match(/\(([^)]+)\)/) ?? [])[1] }; return; }
    if ((m = l.match(/^Folio\s*(?:No\.?)?\s*:\s*([\w\/\-]+)\s*(?:\(([^)]+)\))?\s*$/i))) { account = { kind: "mf_folio", folio: m[1].trim(), provider: m[2] }; return; }
    if ((m = l.match(/^(?:Mutual Fund (?:Folios|Units)|Folios?)\b/i))) { account = { kind: "mf_folio" }; return; }
    if (!account) return;
    // "INE040A01034  HDFC Bank Limited  Equity  42.000  1,723.81  72,400.02"  or  "INF879O01027  Parag Parikh Flexi Cap - Direct Growth  382.100  55.2200  21,099.56"
    if ((m = l.match(/^(IN[EF][A-Z0-9]{9})\s{2,}(.+?)\s{2,}(?:(?:Equity|Bond|Debenture|ETF|MF|Units|Debt)\s{2,})?([\d,]+\.\d{1,4})\s{2,}([\d,]+\.\d{2,4})?\s*([\d,]+\.\d{2})?\s*$/))) {
      try { const qty = parseIndianNumber(m[3]); const a = m[4] ? parseIndianNumber(m[4]) : undefined, b = m[5] ? parseIndianNumber(m[5]) : undefined; positions.push({ account, isin: m[1], name: m[2].trim(), quantity: qty, nav: b != null ? a : undefined, value: b ?? (a != null && account.kind === "demat" ? a : undefined) }); } catch (e: any) { errors.push({ row: i + 1, message: e.message }); }
      return;
    }
    if (account.kind === "mf_folio" && (m = l.match(/^(.+?)\s{2,}([\d,]+\.\d{3})\s{2,}([\d,]+\.\d{2,4})\s{2,}([\d,]+\.\d{2})\s*$/)) && !/^Total/i.test(l)) { try { positions.push({ account, name: m[1].trim(), quantity: parseIndianNumber(m[2]), nav: parseIndianNumber(m[3]), value: parseIndianNumber(m[4]) }); } catch (e: any) { errors.push({ row: i + 1, message: e.message }); } }
  });
  return { rows: [{ depository, holder, pan, asOf, positions }], errors, provider: depository.toLowerCase() };
}
const toIso = (d: string) => { const [dd, mon, yyyy] = d.split("-"); const mm = ({ jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06", jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12" } as Record<string, string>)[mon.toLowerCase().slice(0, 3)]; return `${yyyy}-${mm}-${dd}`; };
