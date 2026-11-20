import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildApp } from "../src/server.js";
import { pool, withFamily } from "../src/lib/db.js";

// Selling through a broker tradebook: the sale must find shares the family entered by hand, and a failed
// import must leave nothing behind, so fixing the cause and importing again just works.
let app: ReturnType<typeof buildApp>;
let token = "", family = "", entity = "";
const run = Date.now();
const h = () => ({ authorization: `Bearer ${token}`, "x-family-id": family });
const post = async (url: string, payload: any) => { const r = await app.inject({ method: "POST", url: `/api/v1${url}`, headers: h(), payload }); return { code: r.statusCode, body: r.body ? r.json() : null }; };
const HEAD = "symbol,isin,trade_date,exchange,segment,series,trade_type,auction,quantity,price,trade_id,order_id,order_execution_time";
const row = (sym: string, isin: string, date: string, type: "buy" | "sell", qty: number, price: number, id: string) => `${sym},${isin},${date},NSE,EQ,EQ,${type},false,${qty},${price.toFixed(2)},T${id},O${id},${date}T09:16:05`;
const book = (...rows: string[]) => [HEAD, ...rows].join("\n") + "\n";
const upload = (text: string) => post("/imports", { text, entity_id: entity });
const holdingsOf = async (symbol: string) => (await withFamily(family, async (c) => (await c.query("select h.quantity from holdings h join instruments i on i.id=h.instrument_id where i.symbol=$1", [symbol])).rows)).map((r: any) => Number(r.quantity));
const gains = async () => withFamily(family, async (c) => (await c.query("select quantity, gain, term from realized_gains order by sell_date")).rows);

const RETRY_SYM = `ZZRTRY${run % 100000}`;
const RETRY_ISIN = `INE${String(run).slice(-6)}ZZ01`.slice(0, 12).padEnd(12, "0");

beforeAll(async () => {
  app = buildApp(); await app.ready();
  const email = `reconcile-${run}@example.com`;
  expect((await app.inject({ method: "POST", url: "/api/v1/auth/register", payload: { email, password: "longenough1", name: "Reconcile Tester", family_name: `Reconcile ${run}` } })).statusCode).toBeLessThan(300);
  const login = (await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password: "longenough1" } })).json();
  token = login.access_token; family = login.families[0].id;
  const e = await post("/entities", { type: "individual", name: "Reconcile Owner" });
  expect(e.code).toBeLessThan(300); entity = e.body.id;
});

afterAll(async () => {
  await withFamily(family, async (c) => { for (const t of ["realized_gains", "lots", "investment_txns", "holdings", "accounts", "import_jobs"]) await c.query(`delete from ${t}`).catch(() => {}); });
  await pool.query("delete from instruments where symbol=$1", [RETRY_SYM]).catch(() => {});
  await app.close(); await pool.end();
});

describe("tradebook sells", () => {
  it("a sale finds shares that were entered by hand, and posts the capital gain", async () => {
    const add = await post("/assets/market", { type_code: "stock", entity_id: entity, txn_date: "2026-06-15", quantity: 50, price: 1500, current_price: 1620, instrument: { name: "Infosys", symbol: "INFY", isin: "INE009A01021" } });
    expect(add.code).toBe(201);
    const r = await upload(book(row("INFY", "INE009A01021", "2026-11-20", "sell", 25, 1620, "1001")));
    expect(r.body.status).toBe("done"); expect(r.body.rows_ok).toBe(1); expect(r.body.rows_error).toBe(0);
    // 50 held, 25 sold: 25 left in total, whichever account it is in, and no stray empty row
    expect((await holdingsOf("INFY")).reduce((s, q) => s + q, 0)).toBe(25);
    expect((await holdingsOf("INFY")).filter((q) => q === 0)).toHaveLength(0);
    const g = await gains(); expect(g).toHaveLength(1);
    expect(Number(g[0].gain)).toBe(3000); expect(g[0].term).toBe("short");   // bought 15 Jun, sold 20 Nov: under 12 months
  });
});

describe("a failed import leaves nothing behind", () => {
  it("a sale with no shares fails cleanly: no empty holding, and the same rows import after the purchase is added", async () => {
    const sell = row(RETRY_SYM, RETRY_ISIN, "2026-11-20", "sell", 10, 200, "2001");
    const first = await upload(book(sell));
    expect(first.body.status).toBe("failed"); expect(first.body.rows_error).toBe(1);
    expect(await holdingsOf(RETRY_SYM)).toHaveLength(0);                       // no empty duplicate row
    // the purchase comes in the same file as the very same sale: both must apply, none "already recorded"
    const second = await upload(book(row(RETRY_SYM, RETRY_ISIN, "2026-06-15", "buy", 10, 100, "2000"), sell));
    expect(second.body.status).toBe("done"); expect(second.body.rows_ok).toBe(2);
    expect((await holdingsOf(RETRY_SYM)).reduce((s, q) => s + q, 0)).toBe(0);
    expect((await gains()).some((x: any) => Number(x.gain) === 1000)).toBe(true);   // 10 x (200 - 100)
  });
});
