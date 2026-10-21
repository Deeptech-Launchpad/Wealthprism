import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { deflateRawSync } from "node:zlib";
import { buildApp } from "../src/server.js";
import { pool } from "../src/lib/db.js";
import { feedFetch, setFeedFetch, ingestNiftyTri, ingestBenchmarkSeries, triRequest } from "../src/lib/feeds.js";
import { runFeeds } from "../src/jobs/market.js";
import { parseNiftyTri, parseBhavcopy, parseBenchmarkSeries } from "@fo/parsers";

// Live-feed hardening (FO-21 ops): NSE cookie handshake, retries with backoff, zip bodies, the BSE fallback for the day's closes, TRI history,
// licensed benchmark series and the health view. Every fetch is faked; rows written here are removed.
const FAMILY = "11111111-1111-1111-1111-111111111111", HDFC = "44444444-0000-0000-0000-000000000001";
let app: ReturnType<typeof buildApp>; let token = "";
const h = () => ({ authorization: `Bearer ${token}`, "x-family-id": FAMILY });
const calls: { url: string; init: any }[] = [];
const res = (status: number, body: string | Buffer = "", headers: Record<string, string | string[]> = {}) => ({ ok: status < 300, status, headers: { get: (n: string) => { const v = headers[n.toLowerCase()]; return v == null ? null : Array.isArray(v) ? v.join(", ") : v; }, getSetCookie: () => { const v = headers["set-cookie"]; return v == null ? [] : Array.isArray(v) ? v : [v]; } }, arrayBuffer: async () => { const b = Buffer.isBuffer(body) ? body : Buffer.from(body); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); }, text: async () => String(body) });
const BSE_CSV = "SC_CODE,SC_NAME,SC_GROUP,SC_TYPE,OPEN,HIGH,LOW,CLOSE,LAST,PREVCLOSE,NO_TRADES,NO_OF_SHRS,NET_TURNOV,TDCLOINDI,ISIN_CODE,TRADING_DATE\n500180,HDFC BANK LTD,A,Q,1720.00,1740.00,1715.00,1730.50,1731.00,1723.81,120000,5000000,8650000000,,INE040A01034,12-Sep-2026\n532540,TATA CONSULTANCY,A,Q,3790,3800,3780,3795.25,3795,3788.89,90000,200000,759000000,,INE467B01029,12-Sep-2026\n";
const TRI = { d: JSON.stringify([{ "Index Name": "Nifty 50", Date: "12 Sep 2026", TotalReturnsIndex: "35,123.45" }, { "Index Name": "Nifty 50", Date: "11 Sep 2026", TotalReturnsIndex: "35,001.10" }]) };
let t0 = new Date();

beforeAll(async () => { app = buildApp(); await app.ready(); token = (await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: "arjun@example.com", password: "Prototype!2026" } })).json().access_token; process.env.FEED_RETRY_BASE_MS = "0"; t0 = new Date(); await cleanup(); });
async function cleanup() {
  await pool.query("delete from prices where price_date='2026-09-12' and source='bse_bhavcopy'");
  await pool.query("delete from benchmark_prices where benchmark_id in (select id from benchmarks where code in ('NIFTY50_TRI','NIFTY500_TRI','TEST_SERIES'))"); await pool.query("delete from benchmarks where code in ('NIFTY50_TRI','NIFTY500_TRI','TEST_SERIES')");
  await pool.query("delete from benchmark_prices where benchmark_id=(select id from benchmarks where code='CRISIL_CBI') and price_date in ('2026-09-11','2026-09-12') and value in (4567.89, 4570.10, 4571.00)");
  await pool.query("delete from feed_runs where job in ('prices.eod','benchmarks.tri','benchmarks.series') and started_at >= $1", [t0.toISOString()]);
  setFeedFetch(null); calls.length = 0;
}
afterAll(async () => { await cleanup(); await app.close(); await pool.end(); });

describe("feedFetch", () => {
  it("warms NSE cookies from the home page, retries the API once with fresh cookies on 401, and sends them on every call", async () => {
    let apiHits = 0; setFeedFetch(async (url, init) => { calls.push({ url, init }); if (url === "https://www.nseindia.com/") return res(200, "<html>", { "set-cookie": ["nsit=abc; Path=/; HttpOnly", "bm_sv=xyz; Path=/"] }); apiHits++; return apiHits === 1 ? res(401, "denied") : res(200, JSON.stringify({ data: [] })); });
    const text = await feedFetch("https://www.nseindia.com/api/allIndices"); expect(JSON.parse(text)).toEqual({ data: [] });
    expect(calls.map((c) => c.url)).toEqual(["https://www.nseindia.com/", "https://www.nseindia.com/api/allIndices", "https://www.nseindia.com/", "https://www.nseindia.com/api/allIndices"]);
    expect(calls[1].init.headers.cookie).toBe("nsit=abc; bm_sv=xyz"); expect(calls[1].init.headers.referer).toBe("https://www.nseindia.com/"); expect(calls[1].init.headers["user-agent"]).toMatch(/Mozilla/);
    calls.length = 0; await feedFetch("https://www.nseindia.com/api/allIndices"); expect(calls.map((c) => c.url)).toEqual(["https://www.nseindia.com/api/allIndices"]);   // cookies cached
  });
  it("retries 5xx / 429 with backoff, gives up after the configured attempts, and does not retry a 404", async () => {
    let n = 0; setFeedFetch(async (url) => { calls.push({ url, init: null }); if (url.endsWith("/flaky")) return ++n < 3 ? res(503, "busy") : res(200, "ok"); if (url.endsWith("/dead")) return res(502, "bad gateway"); if (url.endsWith("/missing")) return res(404, "no"); if (url.endsWith("/file.zip")) { const data = deflateRawSync(Buffer.from("a,b\n1,2\n")); const name = Buffer.from("x.csv"); const head = Buffer.alloc(30); head.writeUInt32LE(0x04034b50, 0); head.writeUInt16LE(8, 8); head.writeUInt32LE(data.length, 18); head.writeUInt32LE(8, 22); head.writeUInt16LE(name.length, 26); head.writeUInt16LE(0, 28); return res(200, Buffer.concat([head, name, data])); } return res(200, "?"); });
    expect(await feedFetch("https://feeds.example/flaky")).toBe("ok"); expect(calls.filter((c) => c.url.endsWith("/flaky")).length).toBe(3);
    await expect(feedFetch("https://feeds.example/dead", { retries: 2 })).rejects.toThrow(/HTTP 502 after 3 attempts/); expect(calls.filter((c) => c.url.endsWith("/dead")).length).toBe(3);
    await expect(feedFetch("https://feeds.example/missing")).rejects.toThrow(/HTTP 404/); expect(calls.filter((c) => c.url.endsWith("/missing")).length).toBe(1);
    expect(await feedFetch("https://feeds.example/file.zip")).toBe("a,b\n1,2\n");
  });
});

describe("extra series and the fallback", () => {
  it("falls back to the BSE bhavcopy when NSE fails and prices the ISINs from it", async () => {
    const fetchText = async (url: string) => { calls.push({ url, init: null }); if (/nsearchives|nseindia/.test(url)) throw new Error("https://nsearchives.nseindia.com/… → HTTP 403 after 4 attempts"); if (/bseindia/.test(url)) return BSE_CSV; throw new Error("unexpected " + url); };
    const out = await runFeeds(["eod"], fetchText, "2026-09-12"); expect(out.eod.rows).toBe(2); expect(out.eod.source).toBe("bse_bhavcopy"); expect(out.eod.note).toMatch(/BSE fallback used/);
    expect((await pool.query("select close, source from prices where instrument_id=$1 and price_date='2026-09-12'", [HDFC])).rows[0]).toEqual({ close: "1730.5000", source: "bse_bhavcopy" });
    expect((await pool.query("select status, note from feed_runs where job='prices.eod' order by started_at desc limit 1")).rows[0].note).toMatch(/2 closes from BSE/);
    const p = parseBhavcopy(BSE_CSV); expect(p.provider).toBe("bse_bhavcopy"); expect(p.rows[1]).toMatchObject({ isin: "INE467B01029", close: 3795.25, date: "2026-09-12", kind: "stock" });
  });
  it("reads total-return index history from niftyindices and licensed series from CSV / JSON", async () => {
    const parsed = parseNiftyTri(TRI); expect(parsed.rows).toEqual([{ code: "NIFTY50_TRI", name: "Nifty 50 TRI", value: 35123.45, date: "2026-09-12" }, { code: "NIFTY50_TRI", name: "Nifty 50 TRI", value: 35001.1, date: "2026-09-11" }]);
    const q = triRequest("NIFTY 50", 10, new Date("2026-09-12T00:00:00Z")); expect(q.url).toMatch(/niftyindices/); expect(JSON.parse(q.body).cinfo).toContain("'endDate':'12-Sep-2026'");
    calls.length = 0; const out = await runFeeds(["tri"], async (url, init) => { calls.push({ url, init }); expect(init.method).toBe("POST"); return JSON.stringify(TRI); }, "2026-09-12"); expect(out.tri.rows).toBe(4); expect(calls.length).toBe(2);   // two indices requested, the fake answers Nifty 50 for both
    expect((await pool.query("select count(*)::int n from benchmark_prices p join benchmarks b on b.id=p.benchmark_id where b.code='NIFTY50_TRI'")).rows[0].n).toBe(2);
    const csv = await ingestBenchmarkSeries("CRISIL_CBI", "Date,Index Value\n11-Sep-2026,4567.89\n12-Sep-2026,4570.10\n"); expect(csv.rows).toBe(2); expect(csv.note).toMatch(/2026-09-11 → 2026-09-12/);
    const json = await ingestBenchmarkSeries("TEST_SERIES", JSON.stringify([{ date: "2026-09-12", value: "4,571.00" }]), "Test series"); expect(json.rows).toBe(1);
    expect(parseBenchmarkSeries("date,value\n2026-09-12,1\nbad,row\n").rows.length).toBe(1); await expect(ingestBenchmarkSeries("X", "nothing here")).rejects.toThrow(/no rows/);
    process.env.BENCHMARK_SERIES_URLS = "TEST_SERIES=https://vendor.example/series.csv"; const s = await runFeeds(["series"], async () => "date,value\n2026-09-11,4560\n", "2026-09-12"); expect(s.series.rows).toBe(1); delete process.env.BENCHMARK_SERIES_URLS;
  });
  it("the health view lists every job with its last run, stale holdings and benchmark coverage; owners can run a feed", async () => {
    const r = await app.inject({ url: "/api/v1/feeds/health", headers: h() }); expect(r.statusCode).toBe(200); const b = r.json();
    const eod = b.jobs.find((j: any) => j.job === "prices.eod"); expect(eod).toMatchObject({ last_status: "ok", source: "NSE bhavcopy (BSE fallback)" }); expect(eod.note).toMatch(/BSE/);
    expect(typeof b.stale_priced_holdings).toBe("number"); expect(b.benchmarks.some((x: any) => x.code === "NIFTY50")).toBe(true); expect(b.jobs.find((j: any) => j.job === "aa.sync")).toBeTruthy();
    const run = await app.inject({ method: "POST", url: "/api/v1/feeds/run", headers: h(), payload: { which: ["series"] } }); expect(run.statusCode).toBe(200); expect(run.json()).toEqual({});   // no series configured → nothing to do
    setFeedFetch(async (url) => (/bseindia/.test(url) ? res(200, BSE_CSV) : res(503, "archive not ready")));   // NSE down, BSE answers
    const eodRun = await app.inject({ method: "POST", url: "/api/v1/feeds/run", headers: h(), payload: { which: ["eod"], date: "2026-09-12" } }); expect(eodRun.statusCode).toBe(200); expect(eodRun.json().eod.source).toBe("bse_bhavcopy");
    setFeedFetch(async () => res(503, "down")); const dead = await app.inject({ method: "POST", url: "/api/v1/feeds/run", headers: h(), payload: { which: ["indices"] } }); expect(dead.statusCode).toBe(502); expect(dead.json().title).toMatch(/HTTP 503 after/);
  });
});
