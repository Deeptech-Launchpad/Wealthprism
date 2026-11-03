import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { buildApp } from "../src/server.js";
import { pool, withFamily } from "../src/lib/db.js";
import { setNavAllCache } from "../src/lib/wcfunds.js";
import { generateTasksFor } from "../src/jobs/tasks.js";

// Add asset: the catalogue, a hand-entered market holding (new security, repeat entry, unit-less PMS/AIF, a bond's extras, a mutual fund through the AMFI list),
// physical gold feeding the allocation lens, and the guards. AMFI is mocked; every row it creates is removed afterwards.
const FAMILY = "11111111-1111-1111-1111-111111111111";
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const amfi = (d: Date) => `${String(d.getUTCDate()).padStart(2, "0")}-${MON[d.getUTCMonth()]}-${d.getUTCFullYear()}`;
const mocked = vi.hoisted(() => ({ navAll: "" }));
vi.mock("../src/lib/feeds.js", async (importOriginal) => { const m = await importOriginal<any>(); return { ...m, feedFetch: async () => mocked.navAll }; });
mocked.navAll = ["Scheme Code;ISIN Div Payout/ ISIN Growth;ISIN Div Reinvestment;Scheme Name;Plan;Option;Net Asset Value;Date", "", "Open Ended Schemes(Equity Scheme - Large Cap Fund)", "", "Zeta Mutual Fund",
  `990101;INF990000101;-;Zeta Large Cap Fund;Direct Plan;Growth;50.0000;${amfi(new Date(Date.now() - 86400000))}`].join("\n");

let app: ReturnType<typeof buildApp>; let owner = "", viewer = ""; let entity = ""; const started = new Date(); const goldIds: string[] = [];
const h = (t = owner) => ({ authorization: `Bearer ${t}`, "x-family-id": FAMILY });
const get = async (url: string, t = owner) => { const r = await app.inject({ url: `/api/v1${url}`, headers: h(t) }); return { code: r.statusCode, body: r.json() }; };
const post = async (url: string, payload: any, t = owner) => { const r = await app.inject({ method: "POST", url: `/api/v1${url}`, headers: h(t), payload }); return { code: r.statusCode, body: r.body ? r.json() : null }; };
const TODAY = new Date().toISOString().slice(0, 10);

beforeAll(async () => {
  app = buildApp(); await app.ready(); setNavAllCache(null);
  const login = async (email: string) => (await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password: "Prototype!2026" } })).json().access_token;
  owner = await login("arjun@example.com"); viewer = await login("ca@example.com");
  entity = (await get("/entities")).body[0].id;
});
afterAll(async () => {
  let ids: string[] = [];
  await withFamily(FAMILY, async (c) => {
    ids = (await c.query("select id from instruments where name like 'ZZ Add %' or amfi_code='990101'")).rows.map((r: any) => r.id);
    if (ids.length) {
      await c.query("delete from realized_gains where instrument_id = any($1)", [ids]).catch(() => null);
      await c.query("delete from lots where holding_id in (select id from holdings where instrument_id = any($1))", [ids]);
      await c.query("delete from investment_txns where instrument_id = any($1)", [ids]);
      await c.query("delete from holdings where instrument_id = any($1)", [ids]);
    }
    await c.query("delete from tasks where title like '%ZZ Add%'");   // the succession check raises a No-nominee task for any new holding
    await c.query("delete from lifestyle_valuations where asset_id = any($1)", [goldIds]).catch(() => null);
    await c.query("delete from lifestyle_assets where id = any($1)", [goldIds]);
    await c.query("delete from accounts where provider='manual' and identifier_masked='MANUAL' and created_at >= $1", [started]).catch(() => null);
  });
  if (ids.length) { await pool.query("delete from prices where instrument_id = any($1)", [ids]).catch(() => null); await pool.query("delete from instruments where id = any($1)", [ids]).catch(() => null); }
  setNavAllCache(null); await app.close();
});

describe("add asset", () => {
  it("lists the catalogue by category; the retirement accounts (EPF, NPS) are listed but not available yet", async () => {
    const r = await get("/asset-types"); expect(r.code).toBe(200);
    const cats = new Set(r.body.map((t: any) => t.category)); expect([...cats].sort()).toEqual(["insurance", "market", "physical", "savings"]);
    expect(r.body.filter((t: any) => ["scss", "nsc", "kvp", "ppf", "ssy", "epf", "nps"].includes(t.code)).every((t: any) => t.enabled === true)).toBe(true);
    expect(r.body.find((t: any) => t.code === "ins_term").counts_in_net_worth).toBe(false);
    expect(r.body.find((t: any) => t.code === "ins_ulip").counts_in_net_worth).toBe(true);
    expect(r.body.find((t: any) => t.code === "sgb").fields.map((f: any) => f.key)).toContain("maturity_date");
    const mode = (c: string) => r.body.find((t: any) => t.code === c).price_mode;   // how each price is kept: a feed, a feed only when it matches, or the user
    expect([mode("mf"), mode("stock"), mode("etf"), mode("bond"), mode("gsec"), mode("sgb"), mode("pms"), mode("gold_physical")]).toEqual(["feed", "feed", "feed", "partial", "accrued", "manual", "manual", "manual"]);
    expect(r.body.find((t: any) => t.code === "stock").price_help).toMatch(/NSE/);
  });

  it("a new listed stock: instrument created, holding built through the lot engine, value follows the typed current price", async () => {
    const r = await post("/assets/market", { type_code: "stock", entity_id: entity, txn_date: TODAY, quantity: 10, price: 100, current_price: 120, instrument: { name: "ZZ Add Stock Ltd", symbol: "ZZADDSTK" } });
    expect(r.code).toBe(201); expect(r.body.instrument.created).toBe(true); expect(r.body.holding.quantity).toBe(10); expect(r.body.holding.avg_cost).toBe(100);
    const row = (await get("/holdings")).body.items.find((x: any) => x.instrument === "ZZ Add Stock Ltd"); expect(row).toBeTruthy();
    expect(Number(row.value)).toBe(1200);
    const again = await post("/assets/market", { type_code: "stock", entity_id: entity, txn_date: TODAY, quantity: 10, price: 100, instrument: { name: "ZZ Add Stock Ltd", symbol: "ZZADDSTK" } });
    expect(again.code).toBe(409);
    const more = await post("/assets/market", { type_code: "stock", entity_id: entity, txn_date: TODAY, quantity: 5, price: 110, instrument: { name: "ZZ Add Stock Ltd", symbol: "zzaddstk" } });
    expect(more.code).toBe(201); expect(more.body.instrument.created).toBe(false); expect(more.body.holding.quantity).toBe(15);
  });

  it("a PMS needs only the amount; a bond stores its coupon and maturity on the instrument", async () => {
    const p = await post("/assets/market", { type_code: "pms", entity_id: entity, txn_date: TODAY, amount: 500000, current_price: 520000, instrument: { name: "ZZ Add PMS Strategy" } });
    expect(p.code).toBe(201); expect(p.body.holding.quantity).toBe(1);
    // NPS: units x NAV through the market engine; the scheme chosen sets its place in the allocation lens, the NAV is typed
    const nps = await post("/assets/market", { type_code: "nps", entity_id: entity, txn_date: TODAY, quantity: 1000, price: 30, current_price: 31.5, instrument: { name: "ZZ Add NPS Scheme G Tier I" }, extras: { tier: "Tier I", scheme_choice: "Government bond (G)", manager: "SBI Pension Funds" } });
    expect(nps.code).toBe(201); expect(nps.body.holding.quantity).toBe(1000);
    const ni = (await withFamily(FAMILY, (c) => c.query("select type, asset_class, alloc_class::text alloc_class, meta from instruments where name='ZZ Add NPS Scheme G Tier I'"))).rows[0];
    expect(ni).toMatchObject({ type: "nps", asset_class: "nps", alloc_class: "debt" }); expect(ni.meta.tier).toBe("Tier I");
    const nh = (await get("/holdings")).body.items.find((x: any) => x.instrument === "ZZ Add NPS Scheme G Tier I"); expect(nh.value).toBeCloseTo(31500, 0);   // 1000 units x the typed NAV
    expect((await post(`/holdings/${nps.body.holding.id}/price`, { price: 32 })).code).toBe(200);   // a new NAV from the statement
    const b = await post("/assets/market", { type_code: "bond", entity_id: entity, txn_date: TODAY, quantity: 50, amount: 50000, instrument: { name: "ZZ Add Bond 8.5% 2030" }, extras: { coupon_pct: 8.5, maturity_date: "2030-03-31" } });
    expect(b.code).toBe(201);
    const meta = (await withFamily(FAMILY, (c) => c.query("select type, asset_class, default_bucket, meta from instruments where name='ZZ Add Bond 8.5% 2030'"))).rows[0];
    expect(meta).toMatchObject({ type: "bond", asset_class: "listed_bond", default_bucket: "income" }); expect(meta.meta.coupon_pct).toBe(8.5);
  });

  it("a mutual fund is picked from the AMFI list and takes its NAV", async () => {
    const s = await get("/assets/fund-search?q=zeta%20large"); expect(s.code).toBe(200); expect(s.body[0].code).toBe("990101");
    const r = await post("/assets/market", { type_code: "mf", entity_id: entity, txn_date: TODAY, quantity: 100, price: 48, amfi_code: "990101" });
    expect(r.code).toBe(201); expect(r.body.holding.quantity).toBe(100);
    const px = (await withFamily(FAMILY, (c) => c.query("select close from prices p join instruments i on i.id=p.instrument_id where i.amfi_code='990101' order by price_date desc limit 1"))).rows[0];
    expect(Number(px.close)).toBe(50);
    expect((await post("/assets/market", { type_code: "mf", entity_id: entity, txn_date: TODAY, quantity: 1, price: 1, amfi_code: "123456" })).code).toBe(404);
  });

  it("physical gold is saved with its weight and counts in the allocation lens as gold; a vehicle does not", async () => {
    const before = (await get("/allocation/status")).body;
    const g = await post("/lifestyle-assets", { entity_id: entity, kind: "gold", name: "ZZ Add Gold bars", acquired_on: TODAY, cost: 100000, current_value: 120000, details: { weight_grams: 20, purity: "24K (999)" } });
    expect(g.code).toBe(201); goldIds.push(g.body.id); expect(g.body.details.weight_grams).toBe(20);
    const v = await post("/lifestyle-assets", { entity_id: entity, kind: "vehicle", name: "ZZ Add Car", acquired_on: TODAY, cost: 900000, current_value: 800000 }); expect(v.code).toBe(201); goldIds.push(v.body.id);
    const after = (await get("/allocation/status")).body;
    const goldOf = (s: any) => Number(s.rows.find((r: any) => r.alloc_class === "gold")?.value ?? 0);
    expect(Math.round(Number(after.total) - Number(before.total))).toBe(120000);   // the car is left out
    expect(Math.round(goldOf(after) - goldOf(before))).toBe(120000);
  });

  it("guards: a retirement account is not available yet, insurance is not a market type, a viewer cannot add, bad input is refused", async () => {
    expect((await post("/assets/market", { type_code: "ppf", entity_id: entity, txn_date: TODAY, amount: 1000 })).code).toBe(422);
    expect((await post("/assets/market", { type_code: "ins_term", entity_id: entity, txn_date: TODAY, amount: 1000 })).code).toBe(422);
    expect((await post("/assets/market", { type_code: "stock", entity_id: entity, txn_date: TODAY, quantity: 1, price: 1, instrument: { name: "ZZ Add Viewer" } }, viewer)).code).toBe(403);
    expect((await post("/assets/market", { type_code: "stock", entity_id: entity, txn_date: TODAY, instrument: { name: "ZZ Add NoQty" } })).code).toBe(422);
    expect((await post("/assets/market", { type_code: "stock", entity_id: entity, txn_date: TODAY, quantity: 1, price: 1 })).code).toBe(422);
  });
});

describe("delete a holding", () => {
  const del = async (id: string, t = owner) => { const r = await app.inject({ method: "DELETE", url: `/api/v1/holdings/${id}`, headers: h(t) }); return { code: r.statusCode, body: r.body ? r.json() : null }; };
  it("removes a wrong entry with its lots and transactions; a viewer cannot; an unknown holding is 404", async () => {
    const a = await post("/assets/market", { type_code: "stock", entity_id: entity, txn_date: TODAY, quantity: 3, price: 50, instrument: { name: "ZZ Add Delete Me", symbol: "ZZDEL" } }); expect(a.code).toBe(201);
    expect((await del(a.body.holding.id, viewer)).code).toBe(403);
    const r = await del(a.body.holding.id); expect(r.code).toBe(200); expect(r.body.deleted).toBe("ZZ Add Delete Me");
    expect((await get("/holdings")).body.items.some((x: any) => x.instrument === "ZZ Add Delete Me")).toBe(false);
    const left = (await withFamily(FAMILY, (c) => c.query("select (select count(*) from lots where holding_id=$1) lots, (select count(*) from investment_txns t join instruments i on i.id=t.instrument_id where i.name='ZZ Add Delete Me') txns", [a.body.holding.id]))).rows[0];
    expect(Number(left.lots)).toBe(0); expect(Number(left.txns)).toBe(0);
    expect((await del(a.body.holding.id)).code).toBe(404);
  });
  it("a holding with sales on record cannot be deleted, because its gains already feed the tax reports", async () => {
    const a = await post("/assets/market", { type_code: "stock", entity_id: entity, txn_date: "2026-04-10", quantity: 10, price: 100, instrument: { name: "ZZ Add Sold Some", symbol: "ZZSOLD" } }); expect(a.code).toBe(201);
    const s = await post("/investment-txns", { entity_id: entity, instrument_id: a.body.instrument.id, type: "sell", txn_date: TODAY, quantity: 4, price: 130, amount: 520 }); expect(s.code).toBe(201);
    const r = await del(a.body.holding.id); expect(r.code).toBe(409); expect(r.body.title).toMatch(/sold/i);
  });
});

describe("accrued value (no market price)", () => {
  const day = (n: number) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
  const value = async (name: string) => Number((await get("/holdings")).body.items.find((x: any) => x.instrument === name)?.value);
  const gsec = (name: string, o: any = {}) => post("/assets/market", { type_code: o.type ?? "gsec", entity_id: entity, txn_date: day(-100), quantity: o.qty ?? 1000, price: o.price ?? 99, instrument: { name }, extras: { coupon_pct: 7.1, face_value: 100, maturity_date: day(100), ...(o.extras ?? {}) }, current_price: o.current });
  it("a G-Sec is worth its cost moving evenly to face value by maturity; a typed price is not kept", async () => {
    const before = Number((await get("/net-worth")).body.assets);
    const r = await gsec("ZZ Add G-Sec 7.1% 2027", { current: 50 }); expect(r.code).toBe(201);
    const v = await value("ZZ Add G-Sec 7.1% 2027"); expect(Math.abs(v - 99500)).toBeLessThan(3);   // halfway: 99 + (100 - 99) x 0.5 = 99.5 a unit
    const after = Number((await get("/net-worth")).body.assets); expect(Math.abs(after - before - v)).toBeLessThan(3);   // net worth counts the same value
    expect((await get("/holdings")).body.items.find((x: any) => x.instrument === "ZZ Add G-Sec 7.1% 2027").price_source).toBeNull();
  });
  it("a T-bill bought at a discount rises to face; a bond past its maturity is worth its face value", async () => {
    await gsec("ZZ Add T-bill", { type: "tbill", qty: 100, price: 97, extras: { coupon_pct: undefined, maturity_date: day(100) } });
    expect(Math.abs((await value("ZZ Add T-bill")) - 9850)).toBeLessThan(3);   // 97 + 3 x 0.5 = 98.5 a unit
    await post("/assets/market", { type_code: "bond", entity_id: entity, txn_date: day(-300), quantity: 10, price: 950, instrument: { name: "ZZ Add Matured Bond" }, extras: { coupon_pct: 8, face_value: 1000, coupon_frequency: "yearly", maturity_date: day(-2) } });
    expect(await value("ZZ Add Matured Bond")).toBe(10000);
  });
  it("a bond with a price on record uses that price, not the accrual", async () => {
    await post("/assets/market", { type_code: "bond", entity_id: entity, txn_date: day(-100), quantity: 10, price: 1000, current_price: 1100, instrument: { name: "ZZ Add Priced Bond" }, extras: { coupon_pct: 8, face_value: 1000, coupon_frequency: "yearly", maturity_date: day(100) } });
    expect(await value("ZZ Add Priced Bond")).toBe(11000);
  });
});

describe("update a manual price", () => {
  const upd = async (id: string, payload: any, t = owner) => post(`/holdings/${id}/price`, payload, t);
  const row = async (name: string) => (await get("/holdings")).body.items.find((x: any) => x.instrument === name);
  it("a security nobody prices takes a new price; a PMS takes a value; the holdings list shows it as manual", async () => {
    const s = await post("/assets/market", { type_code: "stock", entity_id: entity, txn_date: TODAY, quantity: 10, price: 90, current_price: 100, instrument: { name: "ZZ Add Price Me", symbol: "ZZPRICE" } }); expect(s.code).toBe(201);
    const r = await upd(s.body.holding.id, { price: 120 }); expect(r.code).toBe(200); expect(Number(r.body.value)).toBe(1200);
    const x = await row("ZZ Add Price Me"); expect(Number(x.value)).toBe(1200); expect(x.price_source).toBe("manual");
    const p = await post("/assets/market", { type_code: "pms", entity_id: entity, txn_date: TODAY, amount: 100000, current_price: 110000, instrument: { name: "ZZ Add Price PMS" } });
    expect((await upd(p.body.holding.id, { value: 125000 })).code).toBe(200); expect(Number((await row("ZZ Add Price PMS")).value)).toBe(125000);
  });
  it("refused: a price a feed supplies, a G-Sec (its value is worked out), a viewer, a future date, a zero price", async () => {
    const s = await post("/assets/market", { type_code: "stock", entity_id: entity, txn_date: TODAY, quantity: 5, price: 10, instrument: { name: "ZZ Add Feed Priced", symbol: "ZZFEED" } });
    await withFamily(FAMILY, (c) => c.query("insert into prices (instrument_id, price_date, close, source) values ($1, current_date - 1, 11, 'nse_bhavcopy')", [s.body.instrument.id]));
    const f = await upd(s.body.holding.id, { price: 12 }); expect(f.code).toBe(409); expect(f.body.title).toMatch(/NSE/);
    const g = await post("/assets/market", { type_code: "gsec", entity_id: entity, txn_date: TODAY, quantity: 10, price: 99, instrument: { name: "ZZ Add Price G-Sec" }, extras: { coupon_pct: 7, face_value: 100, maturity_date: "2035-01-01" } });
    expect((await upd(g.body.holding.id, { price: 100 })).code).toBe(409);
    const m = await post("/assets/market", { type_code: "stock", entity_id: entity, txn_date: TODAY, quantity: 1, price: 5, instrument: { name: "ZZ Add Price Guard", symbol: "ZZGUARD" } });
    expect((await upd(m.body.holding.id, { price: 7 }, viewer)).code).toBe(403);
    expect((await upd(m.body.holding.id, { price: 7, price_date: "2099-01-01" })).code).toBe(422);
    expect((await upd(m.body.holding.id, { price: 0 })).code).toBe(422);
    expect((await upd("00000000-0000-4000-8000-000000000000", { price: 7 })).code).toBe(404);
  });
});

describe("add a transaction to a holding", () => {
  const tx = async (id: string, payload: any, t = owner) => post(`/holdings/${id}/txn`, payload, t);
  const row = async (name: string) => (await get("/holdings")).body.items.find((x: any) => x.instrument === name);
  const OLD = "2025-01-10";
  it("buy more adds a lot; sell takes the oldest first with the gain; a preview keeps nothing; the bank balance follows", async () => {
    const s = await post("/assets/market", { type_code: "stock", entity_id: entity, txn_date: OLD, quantity: 10, price: 100, current_price: 150, instrument: { name: "ZZ Add Txn Stock", symbol: "ZZTXN" } }); expect(s.code).toBe(201);
    const id = s.body.holding.id;
    const b = await tx(id, { kind: "buy", date: TODAY, quantity: 10, price: 200 }); expect(b.code).toBe(200); expect(b.body.units_after).toBe(20); expect(b.body.avg_cost_after).toBe(150);
    const pv = await tx(id, { kind: "sell", date: TODAY, quantity: 5, price: 180, preview: true }); expect(pv.code).toBe(200); expect(pv.body.preview).toBe(true);
    expect(pv.body.gains).toHaveLength(1); expect(pv.body.gains[0].buy_date).toBe(OLD); expect(pv.body.total_gain).toBe(400); expect(pv.body.gains[0].term).toBe("long");
    expect(Number((await row("ZZ Add Txn Stock")).quantity)).toBe(20);   // the preview changed nothing
    const acct = (await get("/bank-accounts")).body.find((a: any) => a.entity_id === entity && a.type !== "card"); const bal0 = Number(acct.balance);
    const sl = await tx(id, { kind: "sell", date: TODAY, quantity: 12, price: 180, charges: 10, bank_account_id: acct.id }); expect(sl.code).toBe(200);
    expect(sl.body.gains).toHaveLength(2); expect(sl.body.units_after).toBe(8); expect(sl.body.bank_change).toBe(2150);
    expect(Number((await get("/bank-accounts")).body.find((a: any) => a.id === acct.id).balance)).toBe(bal0 + 2150);
    await withFamily(FAMILY, (c) => c.query("update bank_accounts set balance=$2 where id=$1", [acct.id, bal0]));
    expect(Number((await row("ZZ Add Txn Stock")).quantity)).toBe(8);
  });
  it("income is recorded without touching the units; a PMS works in amounts; guards", async () => {
    const s = await post("/assets/market", { type_code: "stock", entity_id: entity, txn_date: OLD, quantity: 10, price: 100, instrument: { name: "ZZ Add Txn Div", symbol: "ZZTXNDIV" } }); const id = s.body.holding.id;
    const d = await tx(id, { kind: "income", date: TODAY, amount: 250 }); expect(d.code).toBe(200); expect(d.body.recorded_as).toBe("dividend"); expect(d.body.units_after).toBe(10);
    expect((await tx(id, { kind: "income", date: TODAY, amount: 250 })).code).toBe(409);   // identical entry
    const p = await post("/assets/market", { type_code: "pms", entity_id: entity, txn_date: OLD, amount: 100000, current_price: 120000, instrument: { name: "ZZ Add Txn PMS" } }); const pid = p.body.holding.id;
    const add = await tx(pid, { kind: "buy", date: TODAY, amount: 60000 }); expect(add.code).toBe(200);
    expect(Number((await row("ZZ Add Txn PMS")).value)).toBe(180000);   // the money added is worth itself at once
    expect((await tx(pid, { kind: "fee", date: TODAY, amount: 500 })).body.recorded_as).toBe("fee");
    expect((await tx(id, { kind: "sell", date: TODAY, quantity: 11, price: 100 })).code).toBe(422);   // more than held
    expect((await tx(id, { kind: "sell", date: "2024-01-01", quantity: 1, price: 100 })).code).toBe(422);   // before it was bought
    expect((await tx(id, { kind: "buy", date: "2099-01-01", quantity: 1, price: 100 })).code).toBe(422);
    expect((await tx(id, { kind: "fee", date: TODAY, amount: 5 })).code).toBe(422);   // a fee is for a PMS or AIF
    expect((await tx(id, { kind: "buy", date: TODAY, quantity: 1, price: 100 }, viewer)).code).toBe(403);
    expect((await tx("00000000-0000-4000-8000-000000000000", { kind: "buy", date: TODAY, quantity: 1, price: 1 })).code).toBe(404);
  });
});

describe("edit a holding", () => {
  const patch = async (url: string, payload: any, t = owner) => { const r = await app.inject({ method: "PATCH", url: `/api/v1${url}`, headers: h(t), payload }); return { code: r.statusCode, body: r.body ? r.json() : null }; };
  const del = async (url: string, t = owner) => { const r = await app.inject({ method: "DELETE", url: `/api/v1${url}`, headers: h(t) }); return { code: r.statusCode, body: r.body ? r.json() : null }; };
  const row = async (name: string) => (await get("/holdings")).body.items.find((x: any) => x.instrument === name);
  it("a purchase can be corrected or removed until something is sold from it; the details can be renamed; a bond's maturity moves its payments", async () => {
    const s = await post("/assets/market", { type_code: "stock", entity_id: entity, txn_date: "2025-02-01", quantity: 10, price: 100, current_price: 100, instrument: { name: "ZZ Add Edit Stock", symbol: "ZZEDIT" } }); const id = s.body.holding.id;
    await post(`/holdings/${id}/txn`, { kind: "buy", date: "2025-03-01", quantity: 10, price: 200 });
    const e = (await get(`/holdings/${id}/edit`)).body; expect(e.lots).toHaveLength(2); expect(e.lots.every((l: any) => !l.locked)).toBe(true); expect(e.name_locked).toBe(false);
    const fix = await patch(`/lots/${e.lots[0].id}`, { quantity: 20, price: 90, buy_date: "2025-01-15" }); expect(fix.code).toBe(200); expect(fix.body.units).toBe(30); expect(Math.round(fix.body.avg_cost * 100) / 100).toBe(126.67);
    expect(Number((await row("ZZ Add Edit Stock")).quantity)).toBe(30);
    expect((await patch(`/lots/${e.lots[0].id}`, { quantity: 0 })).code).toBe(422);
    expect((await patch(`/lots/${e.lots[0].id}`, { buy_date: "2099-01-01" })).code).toBe(422);
    expect((await patch(`/lots/${e.lots[0].id}`, { quantity: 5 }, viewer)).code).toBe(403);
    expect((await patch(`/holdings/${id}`, { name: "ZZ Add Edit Renamed", bucket: "income" })).body.changed).toBe(true);
    expect((await row("ZZ Add Edit Renamed")).bucket).toBe("income");
    await post(`/holdings/${id}/txn`, { kind: "sell", date: TODAY, quantity: 5, price: 150 });   // takes from the oldest lot
    const e2 = (await get(`/holdings/${id}/edit`)).body; expect(e2.lots[0].locked).toBe(true);
    expect((await patch(`/lots/${e2.lots[0].id}`, { quantity: 3 })).code).toBe(409);
    expect((await del(`/lots/${e2.lots[0].id}`)).code).toBe(409);
    expect((await del(`/lots/${e2.lots[1].id}`)).code).toBe(200); expect(Number((await row("ZZ Add Edit Renamed")).quantity)).toBe(15);
    expect((await del(`/lots/${e2.lots[0].id}`)).code).toBe(409);
    const b = await post("/assets/market", { type_code: "bond", entity_id: entity, txn_date: "2026-01-10", quantity: 10, price: 1000, instrument: { name: "ZZ Add Edit Bond" }, extras: { coupon_pct: 8, coupon_frequency: "yearly", maturity_date: "2028-01-10" } });
    expect((await patch(`/holdings/${b.body.holding.id}`, { extras: { maturity_date: "2025-12-01" } })).code).toBe(422);   // before it was bought
    expect((await patch(`/holdings/${b.body.holding.id}`, { extras: { maturity_date: "2029-01-10" } })).body.changed).toBe(true);
    expect((await get(`/holdings/${b.body.holding.id}/edit`)).body.values.maturity_date).toBe("2029-01-10");
  });
});

describe("history of a holding", () => {
  it("lists every entry newest first", async () => {
    const s = await post("/assets/market", { type_code: "stock", entity_id: entity, txn_date: "2025-02-01", quantity: 10, price: 100, instrument: { name: "ZZ Add Hist Stock", symbol: "ZZHIST" } }); const id = s.body.holding.id;
    await post(`/holdings/${id}/txn`, { kind: "income", date: "2025-06-01", amount: 50 });
    await post(`/holdings/${id}/txn`, { kind: "sell", date: "2025-07-01", quantity: 2, price: 120 });
    const r = await get(`/holdings/${id}/transactions`); expect(r.code).toBe(200);
    expect(r.body.map((t: any) => t.type)).toEqual(["sell", "dividend", "buy"]); expect(r.body[0].amount).toBe(240);
    expect((await get(`/holdings/00000000-0000-4000-8000-000000000000/transactions`)).code).toBe(404);
  });
});

describe("AIF commitment and capital calls", () => {
  it("tracks how much of the commitment is called, reminds before a call, and a paid call marks itself", async () => {
    const s = await post("/assets/market", { type_code: "aif", entity_id: entity, txn_date: "2026-01-10", amount: 1000000, current_price: 1050000, instrument: { name: "ZZ Add AIF Calls" }, extras: { aif_category: "Cat II", commitment: 5000000 } }); const id = s.body.holding.id;
    const v = (await get(`/holdings/${id}/capital-calls`)).body; expect(v.is_aif).toBe(true); expect(v.commitment).toBe(5000000); expect(v.called).toBe(1000000); expect(v.remaining).toBe(4000000); expect(v.pct).toBe(20);
    const row = (await get("/holdings")).body.items.find((x: any) => x.instrument === "ZZ Add AIF Calls"); expect(Number(row.commitment)).toBe(5000000); expect(Number(row.called)).toBe(1000000);
    const soon = new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10);
    const c1 = await post(`/holdings/${id}/capital-calls`, { due_date: soon, amount: 500000 }); expect(c1.code).toBe(200); const cid = c1.body.calls[0].id;
    expect((await post(`/holdings/${id}/capital-calls`, { due_date: soon, amount: 4000000 })).code).toBe(422);   // more than is left to call
    expect((await post(`/holdings/${id}/capital-calls`, { due_date: soon, amount: 1000 }, viewer)).code).toBe(403);
    await withFamily(FAMILY, (c) => generateTasksFor(c, FAMILY, TODAY, { notify: false }));
    expect((await get("/tasks?status=open&module=investments")).body.some((x: any) => /^Capital call in \d+ d: ZZ Add AIF Calls/.test(x.title))).toBe(true);
    const paid = await post(`/holdings/${id}/txn`, { kind: "buy", date: TODAY, amount: 500000, capital_call_id: cid }); expect(paid.code).toBe(200);
    const v2 = (await get(`/holdings/${id}/capital-calls`)).body; expect(v2.calls[0].status).toBe("paid"); expect(v2.called).toBe(1500000);
    await withFamily(FAMILY, (c) => generateTasksFor(c, FAMILY, TODAY, { notify: false }));
    expect((await get("/tasks?status=open&module=investments")).body.some((x: any) => /Capital call.*ZZ Add AIF Calls/.test(x.title))).toBe(false);   // the reminder closed with the payment
    const plain = await post("/assets/market", { type_code: "stock", entity_id: entity, txn_date: TODAY, quantity: 1, price: 5, instrument: { name: "ZZ Add Not AIF", symbol: "ZZNOTAIF" } });
    expect((await get(`/holdings/${plain.body.holding.id}/capital-calls`)).body.is_aif).toBe(false);
  });
});
