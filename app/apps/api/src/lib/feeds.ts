/** Live-feed plumbing (FO-21 ops hardening): one fetch for every feed with timeouts, retries and backoff, the NSE cookie handshake (their JSON
 *  endpoints answer 401/403 without the cookies the home page sets), zip unpacking, and the extra series — BSE fallback, TRI history from
 *  niftyindices, licensed benchmark CSVs — plus the health view the ops screen reads. `fetchImpl` is injectable for tests. */
import { inflateRawSync } from "node:zlib";
import { parseNiftyTri, parseBenchmarkSeries } from "@fo/parsers";
import { ingestFxRates } from "./global.js";
import { pool } from "./db.js";

type FetchImpl = (url: string, init?: any) => Promise<{ ok: boolean; status: number; headers: { get(n: string): string | null; getSetCookie?: () => string[] }; arrayBuffer(): Promise<ArrayBuffer>; text(): Promise<string> }>;
let fetchImpl: FetchImpl = fetch as any;
export function setFeedFetch(f: FetchImpl | null) { fetchImpl = f ?? (fetch as any); cookieJar.clear(); }
export const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 WealthPrism/1.0";
const cookieJar = new Map<string, { cookie: string; at: number }>();
const COOKIE_TTL = () => Number(process.env.NSE_COOKIE_TTL_MS ?? 10 * 60_000);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const backoff = (attempt: number) => Number(process.env.FEED_RETRY_BASE_MS ?? 1000) * 3 ** attempt;

/** The NSE bhavcopy is a zip with one CSV inside; read the first local-file entry without a zip dependency. */
export function unzipSingle(buf: Buffer): string {
  if (buf.readUInt32LE(0) !== 0x04034b50) throw new Error("not a zip archive");
  const method = buf.readUInt16LE(8), size = buf.readUInt32LE(18), n = buf.readUInt16LE(26), e = buf.readUInt16LE(28);
  const start = 30 + n + e;
  const data = size ? buf.subarray(start, start + size) : buf.subarray(start, buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])));
  return (method === 8 ? inflateRawSync(data) : data).toString("utf8");
}
const hostOf = (url: string) => { try { return new URL(url).host; } catch { return ""; } };
const needsCookies = (url: string) => /nseindia\.com/.test(hostOf(url)) && /\/api\//.test(url);
/** Warm the NSE session: GET the home page with browser headers and keep its cookies for the API calls that follow. */
async function nseCookies(force = false): Promise<string> {
  const key = "nseindia"; const cached = cookieJar.get(key); if (!force && cached && Date.now() - cached.at < COOKIE_TTL()) return cached.cookie;
  const home = process.env.NSE_HOME_URL ?? "https://www.nseindia.com/";
  const r = await fetchImpl(home, { headers: { "user-agent": UA, accept: "text/html,application/xhtml+xml", "accept-language": "en-IN,en;q=0.9" }, redirect: "follow" });
  const set = r.headers.getSetCookie?.() ?? (r.headers.get("set-cookie") ? String(r.headers.get("set-cookie")).split(/,(?=\s*\w+=)/) : []);
  const cookie = set.map((c) => c.split(";")[0].trim()).filter(Boolean).join("; ");
  cookieJar.set(key, { cookie, at: Date.now() }); return cookie;
}
export interface FeedFetchOptions { method?: string; body?: string; headers?: Record<string, string>; retries?: number; timeoutMs?: number; accept?: string }
/** Fetch a feed as text: retries on network errors / 5xx / 429, refreshes NSE cookies once on 401/403, unzips `.zip` bodies. */
export async function feedFetch(url: string, o: FeedFetchOptions = {}): Promise<string> {
  const retries = o.retries ?? Number(process.env.FEED_RETRIES ?? 3); const timeoutMs = o.timeoutMs ?? Number(process.env.FEED_TIMEOUT_MS ?? 20_000); let refreshed = false; let lastErr = "";
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const headers: Record<string, string> = { "user-agent": UA, accept: o.accept ?? (url.endsWith(".zip") ? "*/*" : "application/json, text/plain, */*"), "accept-language": "en-IN,en;q=0.9", ...(o.headers ?? {}) };
      if (needsCookies(url)) { headers.cookie = await nseCookies(refreshed); headers.referer = "https://www.nseindia.com/"; }
      const r = await fetchImpl(url, { method: o.method ?? "GET", headers, body: o.body, signal: ctrl.signal, redirect: "follow" });
      if ((r.status === 401 || r.status === 403) && needsCookies(url) && !refreshed) { refreshed = true; lastErr = `HTTP ${r.status}`; continue; }
      if (r.status === 429 || r.status >= 500) { lastErr = `HTTP ${r.status}`; if (attempt < retries) await sleep(backoff(attempt)); continue; }
      if (!r.ok) throw new Error(`${url} → HTTP ${r.status}`);
      const buf = Buffer.from(await r.arrayBuffer());
      return url.toLowerCase().endsWith(".zip") || (buf.length >= 4 && buf.readUInt32LE(0) === 0x04034b50) ? unzipSingle(buf) : buf.toString("utf8");
    } catch (e: any) {
      if (/HTTP \d{3}$/.test(e.message) && !/HTTP (429|5\d\d)/.test(e.message)) throw e;
      lastErr = e.name === "AbortError" ? `timeout after ${timeoutMs} ms` : e.message; if (attempt < retries) await sleep(backoff(attempt));
    } finally { clearTimeout(t); }
  }
  throw new Error(`${url} → ${lastErr || "failed"} after ${retries + 1} attempt${retries ? "s" : ""}`);
}

// ---------- extra series ----------
export async function ingestNiftyTri(json: any) {
  const parsed = parseNiftyTri(json); let n = 0;
  for (const r of parsed.rows) { const b = (await pool.query("insert into benchmarks (code, name) values ($1,$2) on conflict (code) do update set name = benchmarks.name returning id", [r.code, r.name])).rows[0]; await pool.query("insert into benchmark_prices (benchmark_id, price_date, value) values ($1,$2,$3) on conflict (benchmark_id, price_date) do update set value = excluded.value", [b.id, r.date, r.value]); n++; }
  const codes = [...new Set(parsed.rows.map((r) => r.code))]; return { rows: n, note: `${n} TRI closes for ${codes.join(", ") || "no index"}`, codes };
}
/** A licensed series (CRISIL CBI and the like) from a CSV / JSON file or URL into `benchmarks` under its code. */
export async function ingestBenchmarkSeries(code: string, text: string, name?: string) {
  const parsed = parseBenchmarkSeries(text); if (!parsed.rows.length) throw new Error(`no rows read for ${code}${parsed.errors[0] ? `: ${parsed.errors[0].message}` : ""}`);
  const b = (await pool.query("insert into benchmarks (code, name) values ($1,$2) on conflict (code) do update set name = coalesce($3, benchmarks.name) returning id", [code, name ?? code, name ?? null])).rows[0]; let n = 0;
  for (const r of parsed.rows) { await pool.query("insert into benchmark_prices (benchmark_id, price_date, value) values ($1,$2,$3) on conflict (benchmark_id, price_date) do update set value = excluded.value", [b.id, r.date, r.value]); n++; }
  return { rows: n, note: `${n} values for ${code} (${parsed.rows[0].date} → ${parsed.rows[parsed.rows.length - 1].date})` };
}
/** `BENCHMARK_SERIES_URLS="CRISIL_CBI=https://…/cbi.csv;CRISIL_LIQ=https://…"` — each fetched and loaded. */
export function benchmarkSeriesUrls(): { code: string; url: string }[] { return (process.env.BENCHMARK_SERIES_URLS ?? "").split(";").map((s) => s.trim()).filter(Boolean).map((s) => { const i = s.indexOf("="); return { code: s.slice(0, i).trim(), url: s.slice(i + 1).trim() }; }).filter((x) => x.code && x.url); }
/** TRI request body for niftyindices (last `days`). */
export function triRequest(index = "NIFTY 50", days = 10, asOf = new Date()) {
  const fmt = (d: Date) => `${String(d.getUTCDate()).padStart(2, "0")}-${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getUTCMonth()]}-${d.getUTCFullYear()}`;
  const start = new Date(asOf.getTime() - days * 86400000);
  return { url: process.env.NIFTY_TRI_URL ?? "https://www.niftyindices.com/Backpage.aspx/getTotalReturnIndexString", body: JSON.stringify({ cinfo: `{'name':'${index}','startDate':'${fmt(start)}','endDate':'${fmt(asOf)}','indexName':'${index}'}` }) };
}

/** Daily FX reference rates; `FX_RATES_URL` defaults to the ECB-backed frankfurter feed with INR as the base (inverted to INR per unit). */
export const fxFeedUrl = () => process.env.FX_RATES_URL ?? "https://api.frankfurter.app/latest?from=INR&to=USD,EUR,GBP,AED,SGD,JPY,CHF";
export async function runFxFeed(fetchText: (url: string) => Promise<string> = feedFetch) { return ingestFxRates(JSON.parse(await fetchText(fxFeedUrl())), process.env.FX_RATES_SOURCE ?? "ecb"); }

// ---------- health ----------
export const FEED_JOBS: { job: string; label: string; window: string; source: string }[] = [
  { job: "prices.eod", label: "Equity & bond closes", window: "18:30 IST, trading days", source: "NSE bhavcopy (BSE fallback)" }, { job: "amfi.nav", label: "Mutual fund NAVs", window: "23:15 IST", source: "AMFI NAVAll" },
  { job: "benchmarks.eod", label: "Index closes", window: "18:30 IST", source: "NSE allIndices" }, { job: "benchmarks.tri", label: "Total-return indices", window: "18:30 IST", source: "niftyindices TRI" }, { job: "benchmarks.series", label: "Licensed series (CRISIL)", window: "18:30 IST", source: "BENCHMARK_SERIES_URLS" },
  { job: "corporate_actions.fetch", label: "Corporate actions", window: "08:00 IST", source: "NSE corporate actions" }, { job: "fx.daily", label: "FX reference rates", window: "18:30 IST", source: "FX_RATES_URL (ECB / frankfurter)" }, { job: "valuations.daily", label: "Valuation snapshots", window: "23:30 IST", source: "internal" }, { job: "prices.stale", label: "Stale-price tasks", window: "09:00 IST", source: "internal" }, { job: "aa.sync", label: "Bank sync (AA)", window: "every 4 h", source: "Account Aggregator" },
];
export async function feedHealth(db: { query: (sql: string, params?: any[]) => Promise<{ rows: any[] }> } = pool) {
  const last = (await db.query("select distinct on (job) job, status, started_at, finished_at, rows, note from feed_runs where job = any($1) order by job, started_at desc", [FEED_JOBS.map((j) => j.job)])).rows;
  const lastOk = (await db.query("select distinct on (job) job, started_at from feed_runs where status='ok' and job = any($1) order by job, started_at desc", [FEED_JOBS.map((j) => j.job)])).rows;
  const stale = (await db.query("select count(distinct h.instrument_id)::int n from holdings h join instruments i on i.id=h.instrument_id where h.quantity > 0 and i.type in ('stock','mf','etf','bond') and coalesce((select max(price_date) from prices p where p.instrument_id=i.id), '1900-01-01') < current_date - 4")).rows[0].n;
  const latest = (await db.query("select i.type, max(p.price_date)::text d from prices p join instruments i on i.id=p.instrument_id group by i.type order by i.type")).rows;
  const bench = (await db.query("select b.code, max(p.price_date)::text d, count(*)::int n from benchmarks b left join benchmark_prices p on p.benchmark_id=b.id group by b.code order by b.code")).rows;
  return { as_of: new Date().toISOString(), jobs: FEED_JOBS.map((j) => { const l = last.find((x) => x.job === j.job), ok = lastOk.find((x) => x.job === j.job); return { ...j, last_status: l?.status ?? "never", last_run_at: l?.started_at ?? null, last_ok_at: ok?.started_at ?? null, rows: l?.rows ?? null, note: l?.note ?? null, healthy: !!ok && Date.now() - new Date(ok.started_at).getTime() < (j.job === "aa.sync" ? 6 : 26) * 3600_000 * (j.job === "prices.eod" || j.job === "benchmarks.eod" ? 3.5 : 1) }; }), stale_priced_holdings: stale, latest_prices: latest, benchmarks: bench, config: { nse_bhavcopy_url: process.env.NSE_BHAVCOPY_URL ?? "default", bse_fallback: process.env.BSE_BHAVCOPY_URL ?? "default", tri: process.env.NIFTY_TRI_ENABLED !== "false", series: benchmarkSeriesUrls().map((s) => s.code), feeds_enabled: process.env.FEEDS_ENABLED !== "false" } };
}
