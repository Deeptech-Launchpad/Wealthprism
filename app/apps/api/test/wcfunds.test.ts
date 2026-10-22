import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { buildApp } from "../src/server.js";
import { pool, withFamily } from "../src/lib/db.js";
import { setNavAllCache } from "../src/lib/wcfunds.js";

// Working capital live fund yields: search AMFI's list, link a bucket to a scheme, the yield comes from NAV growth, typing over it, going back to live,
// refresh, inflation, and the guards (bank FD cannot be linked, a viewer cannot change anything). AMFI is mocked; dates are relative to today so the
// test is the same on any day. Self-cleaning: the family's settings are put back and the test schemes are removed.
const FAMILY = "11111111-1111-1111-1111-111111111111";
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const day = (offset: number) => new Date(Date.now() + offset * 86400000);
const amfi = (d: Date) => `${String(d.getUTCDate()).padStart(2, "0")}-${MON[d.getUTCMonth()]}-${d.getUTCFullYear()}`;

const mocked = vi.hoisted(() => ({ urls: [] as string[], navAll: "", history: "" }));
vi.mock("../src/lib/feeds.js", async (importOriginal) => {
  const m = await importOriginal<any>();
  return { ...m, feedFetch: async (url: string) => { mocked.urls.push(url); return url.includes("NAVAll") ? mocked.navAll : mocked.history; } };
});

const LATEST = day(-1), MONTH_AGO = day(-31), YEAR_AGO = day(-366);
mocked.navAll = [
  "Scheme Code;ISIN Div Payout/ ISIN Growth;ISIN Div Reinvestment;Scheme Name;Plan;Option;Net Asset Value;Date", "", "Open Ended Schemes(Debt Scheme - Liquid Fund)", "", "Zeta Mutual Fund",
  `990001;INF990000001;-;Zeta Liquid Fund;Direct Plan;Growth;1005.0000;${amfi(LATEST)}`,
  `990002;INF990000002;-;Zeta Liquid Fund;Direct Plan;IDCW;1000.0000;${amfi(LATEST)}`,
  `990003;INF990000003;-;Zeta Liquid Fund;Regular Plan;Growth;990.0000;${amfi(LATEST)}`,
  "Open Ended Schemes(Other Scheme - Arbitrage Fund)", "",
  `990010;INF990000010;-;Zeta Arbitrage Fund;Direct Plan;Growth;120.0000;${amfi(LATEST)}`,
].join("\n");
mocked.history = [
  "Scheme Code;NAV Name;Plan;Option;ISIN Div Payout/ISIN Growth;ISIN Div Reinvestment;Net Asset Value;Date",
  `990001;Zeta Liquid Fund - Direct Plan - Growth;Direct Plan;Growth;INF990000001;;1000.00;${amfi(MONTH_AGO)}`,
  `990010;Zeta Arbitrage Fund - Direct Plan - Growth;Direct Plan;Growth;INF990000010;;112.00;${amfi(YEAR_AGO)}`,
].join("\n");

let app: ReturnType<typeof buildApp>; let owner = "", viewer = ""; let savedPrefs: any = null, hadRow = false;
const h = (t = owner) => ({ authorization: `Bearer ${t}`, "x-family-id": FAMILY });
const get = async (url: string, t = owner) => { const r = await app.inject({ url: `/api/v1${url}`, headers: h(t) }); return { code: r.statusCode, body: r.json() }; };
const send = async (method: "POST" | "PUT" | "DELETE", url: string, payload: any = {}, t = owner) => { const r = await app.inject({ method, url: `/api/v1${url}`, headers: h(t), payload }); return { code: r.statusCode, body: r.body ? r.json() : null }; };
const run = <T>(fn: (c: any) => Promise<T>) => withFamily(FAMILY, fn);

beforeAll(async () => {
  app = buildApp(); await app.ready(); setNavAllCache(null);
  const login = async (email: string) => (await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password: "Prototype!2026" } })).json().access_token;
  owner = await login("arjun@example.com"); viewer = await login("ca@example.com");
  await run(async (c) => { const r = (await c.query("select * from wc_settings where family_id=$1", [FAMILY])).rows[0]; hadRow = !!r; savedPrefs = r ?? null; });
});
afterAll(async () => {
  await run(async (c) => { if (hadRow) await c.query("update wc_settings set float_days=$2, buffer_months=$3, idle_days=$4, instrument_prefs=$5 where family_id=$1", [FAMILY, savedPrefs.float_days, savedPrefs.buffer_months, savedPrefs.idle_days, JSON.stringify(savedPrefs.instrument_prefs)]); else await c.query("delete from wc_settings where family_id=$1", [FAMILY]); });
  try { await pool.query("delete from prices where instrument_id in (select id from instruments where amfi_code = any($1))", [["990001", "990002", "990003", "990010"]]); await pool.query("delete from instruments where amfi_code = any($1)", [["990001", "990002", "990003", "990010"]]); } catch { /* the catalogue rows are harmless if this role may not delete them */ }
  setNavAllCache(null); await app.close();
});

describe("working capital: live fund yields", () => {
  it("searches the AMFI list: every word must match, direct growth schemes first, short queries return nothing", async () => {
    const r = await get("/working-capital/fund-search?q=zeta%20liquid");
    expect(r.code).toBe(200); expect(r.body.map((x: any) => x.code)).toEqual(["990001", "990003", "990002"]);
    expect(r.body[0]).toMatchObject({ name: "Zeta Liquid Fund", plan: "Direct Plan", option: "Growth" });
    expect((await get("/working-capital/fund-search?q=a")).body).toEqual([]);
    expect((await get("/working-capital/fund-search?q=zeta%20nonexistent")).body).toEqual([]);
  });

  it("linking a liquid bucket to a scheme makes its yield the 30-day annualised NAV growth", async () => {
    const r = await send("POST", "/working-capital/fund-link", { bucket: "liquid_fund", code: "990001" });
    expect(r.code).toBe(200);
    const expected = (Math.pow(1005 / 1000, 365 / 30) - 1) * 100;
    expect(r.body.yield_source.liquid_fund).toBe("live");
    expect(r.body.instrument_prefs.yields.liquid_fund).toBeCloseTo(expected, 1);
    expect(r.body.live_yields.liquid_fund).toMatchObject({ basisDays: 30, code: "990001" });
    expect(r.body.instrument_prefs.instruments.liquid_fund).toMatch(/Zeta Liquid Fund/);
    expect(r.body.instrument_prefs.funds.liquid_fund.code).toBe("990001");
  });

  it("an arbitrage bucket uses a 1-year basis", async () => {
    const r = await send("POST", "/working-capital/fund-link", { bucket: "arbitrage_fund", code: "990010" });
    expect(r.code).toBe(200);
    expect(r.body.live_yields.arbitrage_fund.basisDays).toBe(365);
    expect(r.body.instrument_prefs.yields.arbitrage_fund).toBeCloseTo((Math.pow(120 / 112, 365 / 365) - 1) * 100, 0);
  });

  it("the history is downloaded once per basis, not once per fund", async () => {
    const hist = mocked.urls.filter((u) => u.includes("DownloadNAVHistoryReport"));
    expect(hist.length).toBe(2);   // one window for the 30-day point, one for the 1-year point
  });

  it("typing a yield overrides the live one, the live figure stays visible, and 'use live' goes back", async () => {
    const typed = await send("PUT", "/working-capital/settings", { instrument_prefs: { yields: { liquid_fund: 7.1 }, yield_mode: { liquid_fund: "manual" } } });
    expect(typed.code).toBe(200);
    expect(typed.body.instrument_prefs.yields.liquid_fund).toBe(7.1); expect(typed.body.yield_source.liquid_fund).toBe("manual");
    expect(typed.body.live_yields.liquid_fund.pct).toBeGreaterThan(6); expect(typed.body.instrument_prefs.manual_yields.liquid_fund).toBe(7.1);
    const back = await send("PUT", "/working-capital/settings", { instrument_prefs: { yield_mode: { liquid_fund: "live" } } });
    expect(back.body.yield_source.liquid_fund).toBe("live"); expect(back.body.instrument_prefs.yields.liquid_fund).toBeCloseTo(6.26, 1);
    expect(back.body.instrument_prefs.manual_yields.liquid_fund).toBe(7.1);   // the typed number was kept, never overwritten by the live one
  });

  it("refresh re-fetches the linked funds", async () => {
    const r = await send("POST", "/working-capital/yields/refresh");
    expect(r.code).toBe(200); expect(r.body.refreshed).toBe(2);
  });

  it("inflation is a setting; the plan lines and the ladder carry the after-inflation yield", async () => {
    const s = await send("PUT", "/working-capital/settings", { instrument_prefs: { inflation_pct: 5 } });
    expect(s.body.instrument_prefs.inflation_pct).toBe(5);
    const lad = await get("/working-capital/ladder"); expect(lad.body.inflation_pct).toBe(5);
    for (const row of lad.body.rows) expect(row.real_yield_pct).toBeCloseTo(row.post_tax_yield_pct - 5, 1);
    const plan = await send("POST", "/working-capital/plan", { amount: 100000 });
    expect(plan.code).toBe(201); expect(plan.body.inflation_pct).toBe(5);
    for (const l of plan.body.lines) { expect(l.real_yield_pct).toBeCloseTo(l.post_tax_yield_pct - 5, 1); expect(["live", "manual"]).toContain(l.yield_source); }
    const sum = await get("/working-capital/summary"); expect(sum.body.inflation_pct).toBe(5);
    expect(Number(sum.body.inflation_loss_per_year)).toBeCloseTo(Number(sum.body.deployable_excess) * 0.05, 0);
  });

  it("guards: a bank FD cannot be linked, a yield must be sensible, an unknown fund is refused, a viewer cannot change anything", async () => {
    expect((await send("POST", "/working-capital/fund-link", { bucket: "bank_fd", code: "990001" })).code).toBe(422);
    expect((await send("PUT", "/working-capital/settings", { instrument_prefs: { yields: { liquid_fund: 45 } } })).code).toBe(422);
    expect((await send("PUT", "/working-capital/settings", { instrument_prefs: { inflation_pct: 80 } })).code).toBe(422);
    expect((await send("POST", "/working-capital/fund-link", { bucket: "liquid_fund", code: "123456" })).code).toBe(404);
    expect((await send("POST", "/working-capital/fund-link", { bucket: "liquid_fund", code: "990001" }, viewer)).code).toBe(403);
    expect((await send("PUT", "/working-capital/settings", { float_days: 90 }, viewer)).code).toBe(403);
  });

  it("unlinking returns the bucket to its typed yield", async () => {
    const r = await send("DELETE", "/working-capital/fund-link/liquid_fund");
    expect(r.code).toBe(200); expect(r.body.yield_source.liquid_fund).toBe("manual"); expect(r.body.instrument_prefs.funds.liquid_fund).toBeUndefined();
    expect(r.body.instrument_prefs.yields.liquid_fund).toBe(7.1);
  });
});
