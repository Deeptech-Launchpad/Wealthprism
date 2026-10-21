import { parseDate, parseIndianNumber, ParseResult } from "./types.js";
/**
 * PMS and AIF statements from text extracted with `pdftotext -layout` (FO-31). Managers differ in layout but not in vocabulary: the
 * parser reads labelled lines (opening / closing value, capital contributed, fees, commitment, drawn, NAV, calls, distributions) and a
 * holdings table when one follows a "Holdings" heading. Only the figures the platform needs are required; the rest is informational.
 */
export interface PmsHolding { name: string; qty?: number; avgCost?: number; price?: number; value: number; weightPct?: number }
export interface PmsStatement { kind: "pms"; manager: string; strategy?: string; clientName?: string; clientCode?: string; period: string; periodEnd: string; openingValue?: number; closingValue: number; contributed?: number; withdrawn?: number; fees: { management?: number; performance?: number; other?: number }; xirrPct?: number; holdings: PmsHolding[]; cash?: number }
export interface AifStatement { kind: "aif"; fund: string; manager?: string; investorName?: string; pan?: string; unitId?: string; period?: string; periodEnd: string; commitment?: number; drawn?: number; unfunded?: number; nav?: number; units?: number; navPerUnit?: number; calls: { due: string; amount: number; ref?: string; number?: string }[]; distributions: { date: string; amount: number; note?: string }[]; fees: { management?: number; other?: number } }
const MONTHS: Record<string, string> = { jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06", jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12" };
const num = (s?: string | null) => (s == null ? undefined : parseIndianNumber(s.replace(/₹|Rs\.?|INR/gi, "").trim()));
const grab = (t: string, re: RegExp) => { const m = t.match(re); return m ? m[1] : undefined; };
const date = (s?: string) => { if (!s) return undefined; try { return parseDate(s.trim()); } catch { return undefined; } };
const lastDay = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
/** "August 2026" → ["2026-08", "2026-08-31"] */
function periodOf(t: string): [string, string] | undefined {
  const m = t.match(/(?:Statement for|Period|Month|For the (?:month|quarter))\s*[:\-]?\s*(?:the\s+)?(?:(?:month|quarter)\s+(?:of|ended|ending)\s+)?([A-Za-z]{3,9})[\s\-']+(\d{4})/i) ?? t.match(/\b(\d{2}-[A-Za-z]{3}-\d{4})\b(?=[^\n]*\)?\s*:?\s*[\d,]+\.\d{2})/);
  if (!m) return undefined; if (m[2]) { const mm = MONTHS[m[1].slice(0, 3).toLowerCase()]; if (!mm) return undefined; const y = Number(m[2]); return [`${y}-${mm}`, `${y}-${mm}-${lastDay(y, Number(mm))}`]; }
  const d = date(m[1])!; return [d.slice(0, 7), d];
}
export function isPmsText(text: string) { return /(Portfolio Value|Portfolio Management|\bPMS\b)/i.test(text) && /(Client Code|Client ID|Capital Contributed|Management Fee)/i.test(text); }
export function isAifText(text: string) { return /(AIF|Alternative Investment Fund|Category (?:I|II|III))/i.test(text) && /(Commitment|Drawdown|Capital Call|Contribution)/i.test(text); }

export function parsePmsStatement(text: string): ParseResult<PmsStatement> {
  const errors: { row: number; message: string }[] = []; const lines = text.split(/\r?\n/);
  const header = lines.find((l) => l.trim())?.trim() ?? "PMS"; const [manager, strategy] = header.split(/\s+-\s+|\s+–\s+|\s+—\s+/);
  const per = periodOf(text); if (!per) errors.push({ row: 1, message: "statement period not found" });
  const closing = num(grab(text, /Closing (?:Portfolio )?Value[^:\n]*:\s*([\d,]+\.?\d*)/i)) ?? num(grab(text, /Portfolio Value(?: as on [^:\n]*)?:\s*([\d,]+\.?\d*)/i));
  if (closing == null) errors.push({ row: 1, message: "closing portfolio value not found" });
  const holdings: PmsHolding[] = []; let inTable = false, cash: number | undefined;
  for (const raw of lines) {
    const l = raw.trim(); if (/^Holdings\b/i.test(l)) { inTable = true; continue; } if (!inTable || !l) continue; if (/^Security\s+Qty/i.test(l)) continue;
    const cashM = l.match(/^Cash(?: & equivalents)?\s+([\d,]+\.\d{2})\s+([\d.]+)%$/i); if (cashM) { cash = num(cashM[1]); continue; }
    const m = l.match(/^(.+?)\s{2,}([\d.]+)\s+([\d,]+\.\d{2})\s+([\d,]+\.\d{2})\s+([\d,]+\.\d{2})\s+([\d.]+)%$/); if (m) { holdings.push({ name: m[1].trim(), qty: Number(m[2]), avgCost: num(m[3]), price: num(m[4]), value: num(m[5])!, weightPct: Number(m[6]) }); continue; }
    if (/^[A-Z]/.test(l) && !/\d/.test(l)) inTable = false;
  }
  const row: PmsStatement = { kind: "pms", manager: manager.trim(), strategy: strategy?.trim(), clientName: grab(text, /Client(?: Name)?:\s*([A-Z][A-Za-z .]+?)\s{2,}/), clientCode: grab(text, /Client (?:Code|ID):\s*([A-Z0-9\-\/]+)/i), period: per?.[0] ?? "", periodEnd: per?.[1] ?? "",
    openingValue: num(grab(text, /Opening (?:Portfolio )?Value[^:\n]*:\s*([\d,]+\.?\d*)/i)), closingValue: closing ?? 0, contributed: num(grab(text, /Capital Contributed[^:\n]*:\s*([\d,]+\.?\d*)/i)), withdrawn: num(grab(text, /(?:Capital )?Withdrawn[^:\n]*:\s*([\d,]+\.?\d*)/i)),
    fees: { management: num(grab(text, /Management Fee[^:\n]*:\s*([\d,]+\.?\d*)/i)), performance: num(grab(text, /Performance Fee[^:\n]*:\s*([\d,]+\.?\d*)/i)), other: num(grab(text, /Other Charges[^:\n]*:\s*([\d,]+\.?\d*)/i)) },
    xirrPct: num(grab(text, /XIRR[^:\n]*:\s*(-?[\d.]+)%/i)), holdings, cash };
  return { rows: closing == null || !per ? [] : [row], errors, provider: manager.trim().split(" ")[0].toLowerCase() };
}

export function parseAifStatement(text: string): ParseResult<AifStatement> {
  const errors: { row: number; message: string }[] = [];
  const fund = grab(text, /^(.+?(?:Fund|AIF|Trust)[^\n]*?)(?:\s+-\s+|\s*\n)/m)?.trim() ?? grab(text, /(?:Fund|Scheme)\s*(?:Name)?:\s*([^\n]+)/i)?.trim(); if (!fund) errors.push({ row: 1, message: "fund name not found" });
  const per = periodOf(text); const periodEnd = per?.[1] ?? date(grab(text, /as (?:on|at)\s+(\d{2}-[A-Za-z]{3}-\d{4})/i)) ?? "";
  if (!periodEnd) errors.push({ row: 1, message: "statement date not found" });
  const calls: AifStatement["calls"] = []; const dist: AifStatement["distributions"] = [];
  for (const m of text.matchAll(/(?:Capital Call|Drawdown)(?: Notice)?\s*(?:No\.?|#)?\s*([\w\/\-]+)?[^\n]*?(?:of|amount|for)\s*(?:₹|Rs\.?|INR)?\s*([\d,]+\.?\d*)[^\n]*?(?:due|payable)\s*(?:on|by|date)?:?\s*(\d{2}-[A-Za-z]{3}-\d{4}|\d{4}-\d{2}-\d{2})/gi)) { const due = date(m[3]); if (due) calls.push({ number: m[1], amount: num(m[2])!, due }); }
  for (const m of text.matchAll(/Distribution(?: paid)?[^\n]*?(?:on|dated)\s*(\d{2}-[A-Za-z]{3}-\d{4}|\d{4}-\d{2}-\d{2})[^\n]*?(?:₹|Rs\.?|INR)?\s*([\d,]+\.\d{2})(?:[^\n]*?[—\-–]\s*([^\n]+))?/gi)) { const d = date(m[1]); if (d) dist.push({ date: d, amount: num(m[2])!, note: m[3]?.trim() }); }
  const commitment = num(grab(text, /(?:Total )?Commitment[^:\n]*:\s*([\d,]+\.?\d*)/i)), drawn = num(grab(text, /(?:Drawn(?: Down)?|Contributed|Paid[- ]in)(?: Capital)?[^:\n]*:\s*([\d,]+\.?\d*)/i));
  const row: AifStatement = { kind: "aif", fund: fund ?? "", manager: grab(text, /(?:Manager|Investment Manager|Sponsor):\s*(.+?)(?:\s{2,}|\n|$)/i)?.trim(), investorName: grab(text, /(?:Investor|Contributor|Unit ?holder)(?: Name)?:\s*([A-Z][A-Za-z .]+?)(?:\s{2,}|\s*\n)/i)?.trim(), pan: grab(text, /PAN:\s*([A-Z]{5}\d{4}[A-Z])/), unitId: grab(text, /(?:Folio|Unit(?:holder)? ID|Investor ID):\s*([\w\/\-]+)/i), period: per?.[0], periodEnd,
    commitment, drawn, unfunded: num(grab(text, /Unfunded(?: Commitment)?[^:\n]*:\s*([\d,]+\.?\d*)/i)) ?? (commitment != null && drawn != null ? Math.round((commitment - drawn) * 100) / 100 : undefined), nav: num(grab(text, /(?:NAV|Net Asset Value)(?: of (?:your )?(?:holding|units))?(?: as on [^:\n]*)?:\s*([\d,]+\.?\d*)/i)), units: num(grab(text, /Units(?: held)?[^:\n]*:\s*([\d,]+\.?\d*)/i)), navPerUnit: num(grab(text, /NAV per unit[^:\n]*:\s*([\d,]+\.?\d*)/i)),
    calls, distributions: dist, fees: { management: num(grab(text, /Management Fee[^:\n]*:\s*([\d,]+\.?\d*)/i)), other: num(grab(text, /(?:Other Charges|Expenses)[^:\n]*:\s*([\d,]+\.?\d*)/i)) } };
  return { rows: fund && periodEnd ? [row] : [], errors, provider: (row.manager ?? fund ?? "aif").split(" ")[0].toLowerCase() };
}
