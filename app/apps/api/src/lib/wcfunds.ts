/** Live fund yields for working capital. A bucket (overnight, liquid, arbitrage, target-maturity) can be linked to one real mutual fund scheme; its yield is then the
 *  annualised growth of that scheme's NAV, worked out from AMFI's own data instead of a number someone typed:
 *    - the scheme list and the latest NAVs come from AMFI NAVAll (the same file the nightly price feed reads),
 *    - the earlier NAV (about 30 days or one year back) comes from AMFI's NAV history report, fetched only for the schemes that are linked.
 *  Everything lands in the ordinary instruments / prices tables, so the nightly feed keeps extending the history and nothing here is a second copy of the data. */
import type pg from "pg";
import { parseAmfiNavAll, parseAmfiHistory, type AmfiNav } from "@fo/parsers";
import { navYield, type NavYield } from "@fo/finance";
import { feedFetch } from "./feeds.js";

export class FundFeedError extends Error { constructor(public status: number, message: string) { super(message); } }
type Db = Pick<pg.Pool, "query">;

/** The buckets that can be linked to a fund, and how far back each one looks. Overnight and liquid funds move steadily, so a recent 30 days annualised is a fair guide;
 *  arbitrage and target-maturity returns move more, so a full year is steadier. Bank FD has no market feed and stays a typed number. */
export const FUND_BASIS_DAYS: Record<string, number> = { overnight_fund: 30, liquid_fund: 30, arbitrage_fund: 365, target_maturity_debt: 365 };
export const FUND_BUCKETS = Object.keys(FUND_BASIS_DAYS);

const NAV_ALL = "https://www.amfiindia.com/spages/NAVAll.txt";
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const amfiDate = (iso: string) => `${iso.slice(8, 10)}-${MON[Number(iso.slice(5, 7)) - 1]}-${iso.slice(0, 4)}`;
const historyUrl = (fromIso: string, toIso: string) => `https://portal.amfiindia.com/DownloadNAVHistoryReport_Po.aspx?frmdt=${amfiDate(fromIso)}&todt=${amfiDate(toIso)}`;
const addDays = (iso: string, n: number) => new Date(Date.parse(iso + "T00:00:00Z") + n * 86400000).toISOString().slice(0, 10);

// ---------- the scheme list (cached: it is 1.5 MB and changes once a day) ----------
let navAllCache: { at: number; rows: AmfiNav[] } | null = null;
const NAV_TTL_MS = 6 * 3600 * 1000;
export async function loadNavAll(force = false): Promise<AmfiNav[]> {
  if (!force && navAllCache && Date.now() - navAllCache.at < NAV_TTL_MS) return navAllCache.rows;
  let text: string;
  try { text = await feedFetch(NAV_ALL, { timeoutMs: 60_000, retries: 2, accept: "text/plain, */*" }); }
  catch (e: any) { if (navAllCache) return navAllCache.rows; throw new FundFeedError(502, `The AMFI fund list could not be reached (${String(e.message ?? e).slice(0, 120)}). Try again in a few minutes.`); }
  const rows = parseAmfiNavAll(text).rows;
  if (!rows.length) { if (navAllCache) return navAllCache.rows; throw new FundFeedError(502, "The AMFI fund list came back empty or in a layout this app does not read."); }
  navAllCache = { at: Date.now(), rows }; return rows;
}
/** Test hook: seed or clear the scheme-list cache. */
export function setNavAllCache(rows: AmfiNav[] | null) { navAllCache = rows ? { at: Date.now(), rows } : null; }

export interface FundHit { code: string; name: string; plan: string | null; option: string | null; nav: number; date: string; category: string }
/** Every word typed must appear in the scheme's name, plan or option. Direct-plan growth schemes sort first: they are what a family office buys. */
export async function searchFunds(q: string, limit = 15): Promise<FundHit[]> {
  const tokens = q.toLowerCase().split(/[\s,]+/).filter((t) => t.length >= 2);
  if (!tokens.length) return [];
  const rows = await loadNavAll();
  const scored: { r: AmfiNav; score: number }[] = [];
  for (const r of rows) {
    const hay = `${r.name} ${r.plan ?? ""} ${r.option ?? ""}`.toLowerCase();
    if (!tokens.every((t) => hay.includes(t))) continue;
    const idcw = /idcw|dividend|payout|reinvest/i.test(`${r.option ?? ""} ${r.name}`);
    scored.push({ r, score: (/direct/i.test(r.plan ?? r.name) ? 4 : 0) + (/growth/i.test(r.option ?? r.name) ? 2 : 0) - (idcw ? 3 : 0) - r.name.length / 1000 });
  }
  scored.sort((a, b) => b.score - a.score);
  const seen = new Set<string>(); const out: FundHit[] = [];
  for (const { r } of scored) { if (seen.has(r.amfiCode)) continue; seen.add(r.amfiCode); out.push({ code: r.amfiCode, name: r.name, plan: r.plan ?? null, option: r.option ?? null, nav: r.nav, date: r.date, category: r.category }); if (out.length >= limit) break; }
  return out;
}
export const fundLabel = (h: { name: string; plan?: string | null; option?: string | null }) => [h.name, [h.plan, h.option].filter((x) => x && x !== "N.A.").join(", ")].filter(Boolean).join(" — ");

// ---------- instruments and prices ----------
export async function ensureInstrument(db: Db, r: AmfiNav): Promise<string> {
  const ex = (await db.query("select id from instruments where amfi_code=$1 or (isin is not null and isin=$2) limit 1", [r.amfiCode, r.isin ?? ""])).rows[0];
  if (ex) return ex.id;
  const bucket = r.assetClass === "equity" || r.assetClass === "intl_fund" ? "growth" : r.assetClass === "debt_mf_post_apr23" && /liquid|overnight|money market/i.test(r.category) ? "liquidity" : "income";
  return (await db.query("insert into instruments (type, isin, name, amfi_code, default_bucket, asset_class, meta) values ('mf',$1,$2,$3,$4,$5,$6) on conflict (amfi_code) do update set name = excluded.name returning id",
    [r.isin ?? null, fundLabel(r), r.amfiCode, bucket, r.assetClass, JSON.stringify({ category: r.category, amc: r.amc, plan: r.plan, option: r.option })])).rows[0].id;
}
const storeNav = (db: Db, instrumentId: string, date: string, nav: number, source: string) =>
  db.query("insert into prices (instrument_id, price_date, close, source) values ($1,$2,$3,$4) on conflict (instrument_id, price_date) do update set close = excluded.close, source = excluded.source", [instrumentId, date, nav, source]);

/** Make sure each linked scheme has its latest NAV and a NAV from about `basis` days earlier in the prices table. One history download serves every scheme still missing that early point. */
export async function refreshFundHistory(db: Db, codes: string[], bases: number[]): Promise<{ instruments: Record<string, string>; missing: string[]; stored: number }> {
  const want = [...new Set(codes)]; const ids: Record<string, string> = {}; let stored = 0;
  if (!want.length) return { instruments: ids, missing: [], stored };
  const all = await loadNavAll(); const byCode = new Map(all.map((r) => [r.amfiCode, r]));
  let latestDate = "";
  for (const code of want) { const r = byCode.get(code); if (!r) continue; ids[code] = await ensureInstrument(db, r); await storeNav(db, ids[code], r.date, r.nav, "amfi"); stored++; if (r.date > latestDate) latestDate = r.date; }
  for (const basis of [...new Set(bases)]) {
    if (!latestDate) break;
    const target = addDays(latestDate, -basis), from = addDays(target, -7);
    const have = new Set((await db.query("select instrument_id from prices where instrument_id = any($1::uuid[]) and price_date between $2::date and $3::date", [Object.values(ids), from, target])).rows.map((r: any) => r.instrument_id as string));
    const lacking = want.filter((c) => ids[c] && !have.has(ids[c])); if (!lacking.length) continue;
    let text: string;
    try { text = await feedFetch(historyUrl(from, target), { timeoutMs: 120_000, retries: 2, accept: "text/plain, */*" }); }
    catch (e: any) { throw new FundFeedError(502, `AMFI's NAV history could not be reached (${String(e.message ?? e).slice(0, 120)}). The linked fund keeps your typed yield until it can.`); }
    for (const h of parseAmfiHistory(text, new Set(lacking))) { await storeNav(db, ids[h.amfiCode], h.date, h.nav, "amfi_hist"); stored++; }
  }
  return { instruments: ids, missing: want.filter((c) => !ids[c]), stored };
}

/** The live yield of one stored instrument, or null while its history is too short to say. */
export async function liveYieldFor(db: Db, instrumentId: string, basisDays: number): Promise<NavYield | null> {
  const rows = (await db.query("select price_date::text d, close from prices where instrument_id=$1 and price_date >= current_date - $2::int order by price_date", [instrumentId, basisDays + 45])).rows;
  return navYield(rows.map((r: any) => ({ date: r.d, nav: Number(r.close) })), basisDays);
}
