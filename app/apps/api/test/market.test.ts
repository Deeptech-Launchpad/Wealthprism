import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { buildApp } from "../src/server.js";
import { pool, withFamily } from "../src/lib/db.js";
import { ingestAmfiNav, ingestNseBhavcopy, ingestNseIndices, ingestCorporateActions, autoApplyCorporateActions, snapshotValuations, backfillValuations, refreshPerformanceCache, stalePriceTasks, recordRun, unzipSingle, BUCKET_SCOPE } from "../src/jobs/market.js";
import { deflateRawSync } from "node:zlib";

const FAMILY = "11111111-1111-1111-1111-111111111111";
const S = (f: string) => readFileSync(new URL(`../../../../samples/${f}`, import.meta.url), "utf8");
const HDFC = "44444444-0000-0000-0000-000000000001", TCS = "44444444-0000-0000-0000-000000000002", PPFAS = "44444444-0000-0000-0000-000000000003", SBI_BOND = "44444444-0000-0000-0000-000000000006";
let app: ReturnType<typeof buildApp>;
let token = "";
const h = () => ({ authorization: `Bearer ${token}`, "x-family-id": FAMILY });
const get = async (url: string) => { const r = await app.inject({ url: `/api/v1${url}`, headers: h() }); return { code: r.statusCode, body: r.json() }; };

/** Global market tables are cleaned by id; family rows the jobs touch are snapshotted and restored. */
const GLOBAL = ["corporate_actions", "prices", "benchmark_prices", "benchmarks", "feed_runs", "instruments"];
const FAMILY_TABLES = ["corporate_action_applications", "investment_txns", "lots", "holdings", "tasks", "valuations_daily", "twr_cache", "xirr_cache"];
const before: Record<string, any[]> = {};
let lotsBefore: any[] = [], holdingsBefore: any[] = [];
const key = (t: string) => (t === "prices" ? "instrument_id::text || price_date::text" : t === "benchmark_prices" ? "benchmark_id::text || price_date::text" : t === "valuations_daily" ? "scope_type::text || scope_id::text || as_of::text" : ["twr_cache", "xirr_cache"].includes(t) ? "scope_type::text || scope_id::text || period::text" : "id::text");

beforeAll(async () => {
  app = buildApp(); await app.ready();
  token = (await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: "arjun@example.com", password: "Prototype!2026" } })).json().access_token;
  for (const t of GLOBAL) before[t] = (await pool.query(`select ${key(t)} k from ${t}`)).rows.map((r) => r.k);
  await withFamily(FAMILY, async (c) => {
    for (const t of FAMILY_TABLES) before[t] = (await c.query(`select ${key(t)} k from ${t}`)).rows.map((r) => r.k);
    lotsBefore = (await c.query("select id, quantity, remaining_qty, unit_cost, charges from lots")).rows;
    holdingsBefore = (await c.query("select id, quantity, avg_cost, last_valued_at from holdings")).rows;
  });
});
afterAll(async () => {
  await withFamily(FAMILY, async (c) => {
    for (const t of FAMILY_TABLES) await c.query(`delete from ${t} where (${key(t)}) <> all($1::text[])`, [before[t]]);
    for (const l of lotsBefore) await c.query("update lots set quantity=$2, remaining_qty=$3, unit_cost=$4, charges=$5 where id=$1", [l.id, l.quantity, l.remaining_qty, l.unit_cost, l.charges]);
    for (const x of holdingsBefore) await c.query("update holdings set quantity=$2, avg_cost=$3, last_valued_at=$4 where id=$1", [x.id, x.quantity, x.avg_cost, x.last_valued_at]);
  });
  for (const t of GLOBAL) await pool.query(`delete from ${t} where (${key(t)}) <> all($1::text[])`, [before[t]]);
  await app.close(); await pool.end();
});

describe("price feeds", () => {
  it("ingests AMFI NAVs for known schemes and loads the master on request", async () => {
    const r = await recordRun("amfi.nav", () => ingestAmfiNav(S("amfi_navall_sample.txt")));
    expect(r.rows).toBe(4); expect(r.created).toBe(0); // PPFAS, Axis Small Cap, ICICI Liquid, Kotak Arbitrage are seeded
    const nav = (await pool.query("select close, source from prices where instrument_id=$1 and price_date='2026-09-11'", [PPFAS])).rows[0];
    expect(Number(nav.close)).toBe(55.9312); expect(nav.source).toBe("amfi");
    const r2 = await ingestAmfiNav(S("amfi_navall_sample.txt"), { loadMaster: true });
    expect(r2.created).toBe(3); expect(r2.rows).toBe(7);
    const uti = (await pool.query("select type, asset_class, default_bucket, meta->>'amc' amc from instruments where amfi_code='120716'")).rows[0];
    expect(uti).toMatchObject({ type: "mf", asset_class: "equity", default_bucket: "growth", amc: "UTI Mutual Fund" });
    expect((await pool.query("select status, rows from feed_runs where job='amfi.nav' order by started_at desc limit 1")).rows[0]).toMatchObject({ status: "ok", rows: 4 });
  });
  it("ingests the NSE bhavcopy by ISIN, prices the listed bond, and can create instruments", async () => {
    const r = await ingestNseBhavcopy(S("nse_bhavcopy_sample.csv"));
    expect(r.rows).toBe(3); // HDFCBANK, TCS, SBI bond are seeded; INFY/RELIANCE/LICI unknown; warrant skipped
    expect(Number((await pool.query("select close from prices where instrument_id=$1 and price_date='2026-09-11'", [HDFC])).rows[0].close)).toBe(1735.4);
    expect(Number((await pool.query("select close from prices where instrument_id=$1 and price_date='2026-09-11'", [SBI_BOND])).rows[0].close)).toBe(1023.1);
    const r2 = await ingestNseBhavcopy(S("nse_bhavcopy_sample.csv"), { loadMaster: true });
    expect(r2.created).toBe(3);
    expect((await pool.query("select type, asset_class, symbol from instruments where isin='INE002A01018'")).rows[0]).toMatchObject({ type: "stock", asset_class: "equity", symbol: "RELIANCE" });
    // the zip wrapper NSE ships is unpacked without a dependency
    const csv = S("nse_bhavcopy_sample.csv"); const data = deflateRawSync(Buffer.from(csv)); const name = Buffer.from("bhav.csv");
    const head = Buffer.alloc(30); head.writeUInt32LE(0x04034b50, 0); head.writeUInt16LE(8, 8); head.writeUInt32LE(data.length, 18); head.writeUInt32LE(csv.length, 22); head.writeUInt16LE(name.length, 26); head.writeUInt16LE(0, 28);
    expect(unzipSingle(Buffer.concat([head, name, data]))).toBe(csv);
  });
  it("stores index closes as benchmarks", async () => {
    const r = await ingestNseIndices(JSON.parse(S("nse_all_indices_sample.json")));
    expect(r.rows).toBe(2);
    expect(Number((await pool.query("select p.value from benchmark_prices p join benchmarks b on b.id=p.benchmark_id where b.code='NIFTY50' and p.price_date='2026-09-11'")).rows[0].value)).toBe(25412.35);
  });
  it("holdings now carry the new close and an XIRR", async () => {
    const { body } = await get("/holdings");
    const hdfc = body.items.find((x: any) => x.instrument_id === HDFC);
    expect(Number(hdfc.price)).toBe(1735.4); expect(hdfc.price_date.startsWith("2026-09-11")).toBe(true);
    expect(typeof hdfc.xirr_pct).toBe("number");
  });
  it("searches instruments by name, symbol and ISIN with held ones first", async () => {
    const parag = (await get("/instruments/search?q=parag")).body;
    expect(parag[0].amfi_code).toBe("122639"); expect(parag[0].held).toBe(true); expect(parag.length).toBe(2);
    expect((await get("/instruments/search?q=INE040A01034")).body[0].symbol).toBe("HDFCBANK");
    expect((await get("/instruments/search?q=RELI")).body[0].symbol).toBe("RELIANCE");
    expect((await get("/instruments/search?q=x")).code).toBe(422);
  });
});

describe("corporate actions", () => {
  it("registers feed actions for known instruments, pending when mechanical and review otherwise", async () => {
    const r = await ingestCorporateActions(JSON.parse(S("nse_corporate_actions_sample.json")));
    expect(r.rows).toBe(4); // HDFC bonus, TCS dividend, INFY split, RELIANCE rights; ITC is unknown and the TCS AGM is not an action (INFY/RELIANCE exist since the master load)
    const infy = (await pool.query("select status, ratio_num, face_value_from, auto_apply from corporate_actions ca join instruments i on i.id=ca.instrument_id where i.symbol='INFY' and ca.type='split'")).rows[0];
    expect(infy).toMatchObject({ status: "pending", auto_apply: true }); expect(Number(infy.ratio_num)).toBe(5); expect(Number(infy.face_value_from)).toBe(5);
    expect((await pool.query("select status from corporate_actions ca join instruments i on i.id=ca.instrument_id where i.symbol='RELIANCE'")).rows[0].status).toBe("review");
    // the seeded, already-applied HDFC bonus is not reset by the feed
    expect((await pool.query("select status from corporate_actions where instrument_id=$1 and type='bonus'", [HDFC])).rows[0].status).toBe("applied");
  });
  it("lists only actions on held instruments, with the family's applied state", async () => {
    const list = (await get("/corporate-actions")).body;
    expect(list.every((x: any) => [HDFC, TCS].includes(x.instrument.id))).toBe(true);
    const bonus = list.find((x: any) => x.type === "bonus");
    expect(bonus.ratio).toBe("1:1"); expect(bonus.status).toBe("applied"); expect(bonus.effect).toMatch(/bonus share/);
    expect((await get("/corporate-actions?status=pending")).body.length).toBe(0);
  });
  it("applies a split to the family's lots and holding, once", async () => {
    const ca = (await pool.query("insert into corporate_actions (instrument_id, type, ex_date, ratio_num, ratio_den, status, source, auto_apply) values ($1,'split','2026-09-01',5,1,'pending','test',true) returning id", [TCS])).rows[0];
    const r = await app.inject({ method: "POST", url: `/api/v1/corporate-actions/${ca.id}/apply`, headers: h(), payload: {} });
    expect(r.statusCode).toBe(200); expect(r.json().holdings.length).toBe(1);
    const holding = (await get("/holdings")).body.items.find((x: any) => x.instrument_id === TCS);
    expect(Number(holding.quantity)).toBe(45); expect(Number(holding.avg_cost)).toBeCloseTo(3044.44 / 5 + 8 / 45, 3);
    const lots = (await get(`/holdings/${holding.id}/lots`)).body;
    expect(lots.length).toBe(1); expect(Number(lots[0].remaining_qty)).toBe(45); expect(Number(lots[0].unit_cost)).toBeCloseTo(608.888, 3);
    expect((await get("/corporate-actions")).body.find((x: any) => x.id === ca.id)).toMatchObject({ status: "applied", applied_holdings: 1 });
    // a second apply finds nothing left to do
    expect((await app.inject({ method: "POST", url: `/api/v1/corporate-actions/${ca.id}/apply`, headers: h(), payload: {} })).json().holdings).toEqual([]);
    // the viewer cannot apply
    const viewer = (await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: "ca@example.com", password: "Prototype!2026" } })).json().access_token;
    expect((await app.inject({ method: "POST", url: `/api/v1/corporate-actions/${ca.id}/apply`, headers: { authorization: `Bearer ${viewer}`, "x-family-id": FAMILY }, payload: {} })).statusCode).toBe(403);
  });
  it("auto-applies a past-dated dividend as a transaction on the ex-date quantity", async () => {
    await pool.query("insert into corporate_actions (instrument_id, type, ex_date, cash_per_unit, status, source, auto_apply) values ($1,'dividend','2026-09-10',11,'pending','test',true)", [TCS]);
    const r = await autoApplyCorporateActions("2026-09-12");
    expect(r.rows).toBeGreaterThanOrEqual(1);
    const txn = await withFamily(FAMILY, async (c) => (await c.query("select quantity, amount, source from investment_txns where instrument_id=$1 and type='dividend' and txn_date='2026-09-10'", [TCS])).rows[0]);
    expect(Number(txn.quantity)).toBe(45); expect(Number(txn.amount)).toBe(495); expect(txn.source).toBe("corporate_action");
  });
  it("applies a demerger with a cost split into a new holding, keeping buy dates", async () => {
    const child = (await pool.query("insert into instruments (type, isin, symbol, name, exchange, default_bucket, asset_class) values ('stock','INE0TEST0001','HDFCDEMO','HDFC Demerged Co','NSE','growth','equity') returning id")).rows[0];
    const ca = (await pool.query("insert into corporate_actions (instrument_id, type, ex_date, status, source) values ($1,'demerger','2026-09-05','review','test') returning id", [HDFC])).rows[0];
    const bad = await app.inject({ method: "POST", url: `/api/v1/corporate-actions/${ca.id}/apply`, headers: h(), payload: {} });
    expect(bad.statusCode).toBe(422); expect(bad.json().title).toMatch(/new_instrument_id/);
    const r = await app.inject({ method: "POST", url: `/api/v1/corporate-actions/${ca.id}/apply`, headers: h(), payload: { new_instrument_id: child.id, cost_split_pct: 6.4 } });
    expect(r.statusCode).toBe(200);
    const items = (await get("/holdings")).body.items;
    const parent = items.find((x: any) => x.instrument_id === HDFC), kid = items.find((x: any) => x.instrument_id === child.id);
    expect(Number(kid.quantity)).toBe(42);
    const kidLots = (await get(`/holdings/${kid.id}/lots`)).body;
    expect(kidLots.map((l: any) => l.buy_date.slice(0, 10)).sort()).toEqual(["2022-03-14", "2026-08-28"]);
    // total cost is conserved across parent and child
    const parentCost = Number(parent.cost), kidCost = Number(kid.cost);
    expect(parentCost + kidCost).toBeCloseTo(21 * 1471.43 + 12, 0);
    expect(kidCost).toBeCloseTo((21 * 1471.43 + 12) * 0.064, 0);
  });
});

describe("valuations and performance", () => {
  it("snapshots every scope for a date and backfills month-ends", async () => {
    const r = await backfillValuations("2026-05-01", "2026-09-12", "month", [FAMILY]);
    expect(r.dates).toBe(5); // 31 May, 30 Jun, 31 Jul, 31 Aug, 12 Sep
    const fam = await withFamily(FAMILY, async (c) => (await c.query("select as_of, value, net_flow from valuations_daily where scope_type='family' and scope_id=$1 order by as_of", [FAMILY])).rows);
    expect(fam.length).toBe(5);
    const dates = fam.map((x) => new Date(x.as_of).toISOString().slice(0, 10));
    expect(dates).toEqual(["2026-05-31", "2026-06-30", "2026-07-31", "2026-08-31", "2026-09-12"]);
    // the July snapshot predates the 1 Jul liquid-fund lot? no — it includes it; June does not
    expect(Number(fam[2].value)).toBeGreaterThan(Number(fam[1].value));
    // today's family value equals the holdings total (same prices, same quantities)
    const totals = (await get("/holdings")).body.totals;
    expect(Number(fam[4].value)).toBeCloseTo(Number(totals.value), 0);
    const buckets = await withFamily(FAMILY, async (c) => (await c.query("select scope_id, value from valuations_daily where scope_type='bucket' and as_of='2026-09-12'")).rows);
    expect(buckets.map((b) => b.scope_id).sort()).toEqual(Object.values(BUCKET_SCOPE).sort());
    expect(buckets.reduce((s, b) => s + Number(b.value), 0)).toBeCloseTo(Number(totals.value), 0);
  });
  it("reports TWR, XIRR and a benchmark for the family scope, and feeds the dashboard trend", async () => {
    // a second benchmark point so the benchmark return can be computed
    await pool.query("insert into benchmark_prices (benchmark_id, price_date, value) select id, '2026-05-31', 24000 from benchmarks where code='NIFTY50' on conflict do nothing");
    const b0 = Number((await pool.query("select p.value from benchmark_prices p join benchmarks b on b.id=p.benchmark_id where b.code='NIFTY50' and p.price_date='2026-05-31'")).rows[0].value);   // db/022 seeds a monthly history, so read the value that is actually there
    const p = (await get("/performance?scope_type=family&period=si")).body;
    expect(p.scope_label).toBe("Family"); expect(p.valuations).toBe(5); expect(p.from).toBe("2026-05-31"); expect(p.to).toBe("2026-09-12");
    expect(typeof p.twr_cumulative_pct).toBe("number"); expect(p.annualised).toBe(false);
    expect(p.benchmark).toBe("NIFTY50"); expect(p.benchmark_pct).toBeCloseTo((25412.35 / b0 - 1) * 100, 1);
    expect(p.series.length).toBe(5); expect(p.series[0].benchmark).toBe(p.series[0].value);
    expect(Number(p.closing_value)).toBeCloseTo(Number((await get("/holdings")).body.totals.value), 0);
    const income = (await get("/performance?scope_type=bucket&scope_id=income&period=si")).body;
    expect(income.scope_label).toBe("income"); expect(income.benchmark).toBe("CRISIL_CBI"); expect(typeof income.benchmark_pct).toBe("number");   // CRISIL CBI history is seeded by db/022
    const ent = (await get("/performance?scope_type=entity&scope_id=33333333-0000-0000-0000-000000000003&period=1y")).body;
    expect(ent.scope_label).toBe("Spouse (Individual)");
    expect((await get("/performance?scope_type=entity")).code).toBe(422);

    await refreshPerformanceCache("2026-09-12");
    const cached = await withFamily(FAMILY, async (c) => (await c.query("select period, twr, benchmark_return from twr_cache where scope_type='family' order by period")).rows);
    expect(cached.map((x) => x.period)).toEqual(["1y", "3y", "5y", "si"]);
    const dash = (await get("/dashboard")).body;
    expect(dash.trend.length).toBe(5); expect(dash.trend[4].month).toBe("2026-09"); expect(typeof dash.net_worth_mom_pct).toBe("number");
    if (dash.xirr_si_pct != null) expect(typeof dash.xirr_si_pct).toBe("number");
  });
  it("raises stale-price tasks for held listed instruments and closes them once prices arrive", async () => {
    const r = await stalePriceTasks(0); // nothing is priced today, so every listed holding is stale
    expect(r.rows).toBeGreaterThanOrEqual(4);
    const open = (await get("/tasks?status=open&module=investments")).body;
    expect(open.some((t: any) => /Price stale: HDFC Bank/.test(t.title))).toBe(true);
    expect(open.some((t: any) => /Marcellus/.test(t.title))).toBe(false); // PMS is marked from statements, never a feed
    const again = await stalePriceTasks(0); expect(again.rows).toBe(0); // no duplicates
    const relaxed = await stalePriceTasks(4);
    expect(relaxed.closed).toBeGreaterThanOrEqual(4);
    // only the demerged company, which has never been priced, stays flagged
    const left = (await get("/tasks?status=open&module=investments")).body.filter((t: any) => /Price stale/.test(t.title));
    expect(left.map((t: any) => t.title)).toEqual(["Price stale: HDFC Demerged Co"]);
  });
});
