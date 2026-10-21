import { csv, parseDate, ParseResult } from "./types.js";

/** One NAV line from AMFI's NAVAll.txt (https://www.amfiindia.com/spages/NAVAll.txt). */
export interface AmfiNav { amfiCode: string; isin?: string; isinReinvest?: string; name: string; nav: number; date: string; category: string; amc: string; assetClass: string }
/** Scheme category header → the platform's asset_class taxonomy (the tax rule key). */
export function amfiAssetClass(category: string): string {
  const c = category.toLowerCase();
  if (/arbitrage/.test(c)) return "arbitrage_fund";
  if (/multi asset/.test(c)) return "multi_asset";
  if (/conservative hybrid/.test(c)) return "debt_mf_post_apr23";
  if (/liquid|overnight|money market|ultra short|low duration|debt|gilt|bond|credit|duration|income|floater|banking and psu|corporate/.test(c)) return "debt_mf_post_apr23";
  if (/gold|silver|commodit/.test(c)) return "gold_fof";
  if (/international|overseas|global/.test(c)) return "intl_fund";
  return "equity"; // equity schemes and equity-oriented hybrids (aggressive, balanced advantage, equity savings) are taxed as equity
}
export function parseAmfiNavAll(text: string): ParseResult<AmfiNav> {
  const rows: AmfiNav[] = []; const errors: { row: number; message: string }[] = [];
  let category = "", amc = "";
  text.split(/\r?\n/).forEach((line, i) => {
    const l = line.trim(); if (!l) return;
    if (/^Scheme Code;/i.test(l)) return;
    if (!l.includes(";")) { if (/^open ended|^close ended|^interval/i.test(l)) category = l; else amc = l; return; }
    const c = l.split(";").map((x) => x.trim());
    if (c.length < 6) { errors.push({ row: i + 1, message: "short line" }); return; }
    const nav = Number(c[4]); if (!Number.isFinite(nav) || nav <= 0) { errors.push({ row: i + 1, message: `bad NAV ${c[4]}` }); return; }
    try { rows.push({ amfiCode: c[0], isin: /^INF/.test(c[1]) ? c[1] : undefined, isinReinvest: /^INF/.test(c[2]) ? c[2] : undefined, name: c[3], nav, date: parseDate(c[5]), category, amc, assetClass: amfiAssetClass(category) }); }
    catch (e: any) { errors.push({ row: i + 1, message: e.message }); }
  });
  return { rows, errors, provider: "amfi" };
}

/** One equity/debt close from an NSE bhavcopy — the UDiFF layout (2024+) or the legacy cm<ddMMMyyyy>bhav.csv. */
export interface BhavRow { symbol: string; series: string; isin?: string; name?: string; close: number; prevClose?: number; date: string; kind: "stock" | "bond" | "etf" | "other" }
const seriesKind = (s: string): BhavRow["kind"] => (/^(EQ|BE|BZ|SM|ST|BL|IV)$/.test(s) ? "stock" : /^(N|Y|Z)[0-9A-Z]$/.test(s) ? "bond" : /^(E)[0-9A-Z]?$/.test(s) ? "etf" : "other");
export function parseNseBhavcopy(text: string): ParseResult<BhavRow> {
  const rows = csv(text); const h = rows[0].map((x) => x.trim());
  const col = (r: string[], k: string) => { const i = h.indexOf(k); return i >= 0 ? (r[i] ?? "").trim() : ""; };
  const out: BhavRow[] = []; const errors: { row: number; message: string }[] = [];
  const udiff = h.includes("TckrSymb");
  rows.slice(1).forEach((r, i) => {
    try {
      if (udiff) {
        if (col(r, "Sgmt") !== "CM") return;
        const series = col(r, "SctySrs"); const close = Number(col(r, "ClsPric")); if (!series || !Number.isFinite(close)) return;
        out.push({ symbol: col(r, "TckrSymb"), series, isin: col(r, "ISIN") || undefined, name: col(r, "FinInstrmNm") || undefined, close, prevClose: Number(col(r, "PrvsClsgPric")) || undefined, date: parseDate(col(r, "TradDt")), kind: seriesKind(series) });
      } else {
        const series = col(r, "SERIES"); const close = Number(col(r, "CLOSE")); if (!series || !Number.isFinite(close)) return;
        out.push({ symbol: col(r, "SYMBOL"), series, isin: col(r, "ISIN") || undefined, close, prevClose: Number(col(r, "PREVCLOSE")) || undefined, date: parseDate(col(r, "TIMESTAMP")), kind: seriesKind(series) });
      }
    } catch (e: any) { errors.push({ row: i + 2, message: e.message }); }
  });
  return { rows: out, errors, provider: "nse_bhavcopy" };
}

/** NSE corporate-actions feed (https://www.nseindia.com/api/corporates-corporateActions?index=equities), subject text decoded. */
export interface CorporateActionRow { symbol: string; isin?: string; company?: string; type: "bonus" | "split" | "dividend" | "rights" | "demerger" | "merger" | "buyback"; exDate: string; recordDate?: string; ratioNum?: number; ratioDen?: number; cashPerUnit?: number; faceValueFrom?: number; faceValueTo?: number; subject: string; autoApply: boolean }
const rupees = (s: string) => { const m = s.match(/R(?:s|e)\.?\s*([\d.,]+)/i); return m ? Number(m[1].replace(/,/g, "")) : undefined; };
export function decodeCorporateAction(subject: string): Omit<CorporateActionRow, "symbol" | "exDate" | "subject"> | null {
  const s = subject.trim(); let m;
  if ((m = s.match(/^bonus\s+(\d+)\s*:\s*(\d+)/i))) return { type: "bonus", ratioNum: Number(m[1]), ratioDen: Number(m[2]), autoApply: true };
  if (/split|sub-?division/i.test(s)) {
    const fv = [...s.matchAll(/R(?:s|e)\.?\s*([\d.]+)/gi)].map((x) => Number(x[1]));
    if (fv.length >= 2 && fv[1] > 0) return { type: "split", faceValueFrom: fv[0], faceValueTo: fv[1], ratioNum: fv[0] / fv[1], ratioDen: 1, autoApply: true };
    return { type: "split", autoApply: false };
  }
  if (/dividend/i.test(s)) { const cash = rupees(s); return { type: "dividend", cashPerUnit: cash, autoApply: cash != null }; }
  if ((m = s.match(/^rights\s+(\d+)\s*:\s*(\d+)/i))) return { type: "rights", ratioNum: Number(m[1]), ratioDen: Number(m[2]), cashPerUnit: rupees(s), autoApply: false };
  if (/demerger|de-merger|scheme of arrangement/i.test(s)) return { type: "demerger", autoApply: false };
  if (/merger|amalgamation/i.test(s)) return { type: "merger", autoApply: false };
  if (/buy ?back/i.test(s)) return { type: "buyback", autoApply: false };
  return null;
}
export function parseNseCorporateActions(json: any): ParseResult<CorporateActionRow> {
  const list: any[] = Array.isArray(json) ? json : json?.data ?? [];
  const rows: CorporateActionRow[] = []; const errors: { row: number; message: string }[] = [];
  list.forEach((x, i) => {
    const d = decodeCorporateAction(String(x.subject ?? "")); if (!d) return; // AGMs, board meetings and other notices are not actions
    try { rows.push({ symbol: x.symbol, isin: x.isin || undefined, company: x.comp, exDate: parseDate(x.exDate), recordDate: x.recDate && x.recDate !== "-" ? parseDate(x.recDate) : undefined, subject: x.subject, ...d }); }
    catch (e: any) { errors.push({ row: i + 1, message: e.message }); }
  });
  return { rows, errors, provider: "nse" };
}

/** NSE index closes (https://www.nseindia.com/api/allIndices) → benchmark codes used in `benchmarks`. */
export interface IndexClose { code: string; name: string; value: number; date: string }
const INDEX_CODES: Record<string, string> = { "NIFTY 50": "NIFTY50", "NIFTY 500": "NIFTY500", "NIFTY MIDCAP 150": "NIFTYMID150", "NIFTY SMALLCAP 250": "NIFTYSML250" };
export function parseNseIndices(json: any): ParseResult<IndexClose> {
  const list: any[] = json?.data ?? []; const date = json?.timestamp ? parseDate(String(json.timestamp).split(" ")[0]) : new Date().toISOString().slice(0, 10);
  const rows: IndexClose[] = [];
  for (const x of list) { const code = INDEX_CODES[String(x.index ?? x.indexSymbol).toUpperCase()]; if (code && Number.isFinite(Number(x.last))) rows.push({ code, name: x.index, value: Number(x.last), date }); }
  return { rows, errors: [], provider: "nse_indices" };
}

/** BSE's legacy equity bhavcopy (EQ_ISINCODE_ddmmyy.csv): SC_CODE, SC_NAME, SC_GROUP, ..., CLOSE, ..., ISIN_CODE, TRADING_DATE. The newer BSE
 *  file uses the same UDiFF layout as NSE, which `parseNseBhavcopy` already reads; `parseBhavcopy` picks the parser from the header. */
export function parseBseBhavcopyLegacy(text: string): ParseResult<BhavRow> {
  const rows = csv(text); const h = rows[0].map((x) => x.trim().toUpperCase()); const col = (r: string[], k: string) => { const i = h.indexOf(k); return i >= 0 ? (r[i] ?? "").trim() : ""; };
  const out: BhavRow[] = []; const errors: { row: number; message: string }[] = [];
  rows.slice(1).forEach((r, i) => { try {
    const close = Number(col(r, "CLOSE")); const isin = col(r, "ISIN_CODE"); if (!Number.isFinite(close) || !isin) return;
    const group = col(r, "SC_GROUP"); const type = col(r, "SC_TYPE"); const name = col(r, "SC_NAME"); const kind: BhavRow["kind"] = /^F$/i.test(group) || /^B$/i.test(type) || /debenture|\bbond\b|\bNCD\b/i.test(name) ? "bond" : /\bETF\b|BEES\b/i.test(name) ? "etf" : /^Q$/i.test(type) || /^(A|B|T|X|XT|Z|M|MT|IP)$/i.test(group) ? "stock" : "other";   // BSE: SC_TYPE Q = equity, B = debt; group F = fixed income
    const d = col(r, "TRADING_DATE") || col(r, "DATE"); out.push({ symbol: col(r, "SC_CODE"), series: group || "EQ", isin, name: col(r, "SC_NAME") || undefined, close, prevClose: Number(col(r, "PREVCLOSE")) || undefined, date: d ? parseDate(d) : new Date().toISOString().slice(0, 10), kind });
  } catch (e: any) { errors.push({ row: i + 2, message: e.message }); } });
  return { rows: out, errors, provider: "bse_bhavcopy" };
}
export function parseBhavcopy(text: string): ParseResult<BhavRow> { const head = text.slice(0, 600).toUpperCase(); return head.includes("SC_CODE") && head.includes("ISIN_CODE") ? parseBseBhavcopyLegacy(text) : parseNseBhavcopy(text); }

/** Total-return index history from niftyindices.com (getTotalReturnIndexString): `{"d":"[{\"Index Name\":..,\"Date\":\"12 Sep 2026\",\"TotalReturnsIndex\":\"35,123.45\"}]"}`. TRI series carry a `_TRI` suffix. */
const TRI_CODES: Record<string, string> = { "NIFTY 50": "NIFTY50_TRI", "NIFTY 500": "NIFTY500_TRI", "NIFTY MIDCAP 150": "NIFTYMID150_TRI", "NIFTY SMALLCAP 250": "NIFTYSML250_TRI", "NIFTY NEXT 50": "NIFTYNXT50_TRI" };
const MON: Record<string, string> = { jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06", jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12" };
export function parseNiftyTri(json: any): ParseResult<IndexClose> {
  let list: any[] = []; const raw = json?.d ?? json; try { list = typeof raw === "string" ? JSON.parse(raw) : Array.isArray(raw) ? raw : []; } catch { list = []; }
  const rows: IndexClose[] = []; const errors: { row: number; message: string }[] = [];
  list.forEach((x, i) => { try {
    const name = String(x["Index Name"] ?? x.indexName ?? x.index ?? "").toUpperCase(); const code = TRI_CODES[name] ?? (name ? `${name.replace(/[^A-Z0-9]+/g, "")}_TRI` : ""); const v = Number(String(x.TotalReturnsIndex ?? x.tri ?? x.value ?? "").replace(/,/g, ""));
    const ds = String(x.Date ?? x.date ?? ""); const m = ds.match(/^(\d{1,2})[ -]([A-Za-z]{3})[ -](\d{4})$/); const date = m ? `${m[3]}-${MON[m[2].toLowerCase()]}-${m[1].padStart(2, "0")}` : /^\d{4}-\d{2}-\d{2}/.test(ds) ? ds.slice(0, 10) : parseDate(ds);
    if (code && Number.isFinite(v) && v > 0) rows.push({ code, name: `${x["Index Name"] ?? name} TRI`, value: v, date });
  } catch (e: any) { errors.push({ row: i + 1, message: e.message }); } });
  return { rows, errors, provider: "nifty_tri" };
}
/** A benchmark series as CSV (`date,value` with a header) or JSON `[{date, value}]` — the CRISIL indices and anything else licensed arrive this way. */
export function parseBenchmarkSeries(text: string): ParseResult<{ date: string; value: number }> {
  const rows: { date: string; value: number }[] = []; const errors: { row: number; message: string }[] = [];
  if (/^\s*[\[{]/.test(text)) { try { const j = JSON.parse(text); const list: any[] = Array.isArray(j) ? j : j.data ?? j.rows ?? []; list.forEach((x, i) => { const v = Number(String(x.value ?? x.close ?? x.index ?? "").replace(/,/g, "")); const d = String(x.date ?? x.Date ?? ""); if (Number.isFinite(v) && d) rows.push({ date: /^\d{4}-\d{2}-\d{2}/.test(d) ? d.slice(0, 10) : parseDate(d), value: v }); else errors.push({ row: i + 1, message: "unreadable row" }); }); } catch (e: any) { errors.push({ row: 1, message: e.message }); } return { rows, errors, provider: "benchmark_json" }; }
  const lines = csv(text); const h = lines[0].map((x) => x.trim().toLowerCase()); const di = Math.max(0, h.findIndex((x) => /date/.test(x))), vi = h.findIndex((x) => /value|close|index|tri|nav/.test(x));
  lines.slice(1).forEach((r, i) => { try { const v = Number(String(r[vi >= 0 ? vi : 1] ?? "").replace(/,/g, "")); const d = (r[di] ?? "").trim(); if (!d || !Number.isFinite(v)) return; rows.push({ date: /^\d{4}-\d{2}-\d{2}/.test(d) ? d.slice(0, 10) : parseDate(d), value: v }); } catch (e: any) { errors.push({ row: i + 2, message: e.message }); } });
  return { rows, errors, provider: "benchmark_csv" };
}
