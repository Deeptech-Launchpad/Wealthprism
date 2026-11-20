import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildApp } from "../src/server.js";
import { pool, withFamily } from "../src/lib/db.js";

// Orders that came from a research proposal are matched to the broker's fills when the tradebook / contract note is imported,
// so a confirmed ("filled") order becomes "reconciled" and is tied to the trade it produced.
let app: ReturnType<typeof buildApp>;
let token = "", family = "", entity = "", instrument = "";
const run = Date.now();
const TODAY = new Date().toISOString().slice(0, 10);
const h = () => ({ authorization: `Bearer ${token}`, "x-family-id": family });
const post = async (url: string, payload: any) => { const r = await app.inject({ method: "POST", url: `/api/v1${url}`, headers: h(), payload }); return { code: r.statusCode, body: r.body ? r.json() : null }; };
const HEAD = "symbol,isin,trade_date,exchange,segment,series,trade_type,auction,quantity,price,trade_id,order_id,order_execution_time";
const row = (date: string, type: "buy" | "sell", qty: number, price: number, id: string) => `INFY,INE009A01021,${date},NSE,EQ,EQ,${type},false,${qty},${price.toFixed(2)},T${id},O${id},${date}T09:16:05`;
const book = (...rows: string[]) => [HEAD, ...rows].join("\n") + "\n";
const upload = (text: string) => post("/imports", { text, entity_id: entity });

async function addOrder(side: "sell" | "buy", qty: number, ref: string, status = "filled") {
  return withFamily(family, async (c) => (await c.query(
    `insert into action_intents (family_id, entity_id, kind, status, payload, amount, rationale, proposed_by_kind, source_type, source_id, approvers_required, route, confirmed_ref, expires_at, idempotency_key)
     values ($1,$2,'equity_order',$3,$4,$5,'test order','agent','investment_proposal',gen_random_uuid(),1,'assisted',$6, now() + interval '1 day', gen_random_uuid()::text) returning id`,
    [family, entity, status, JSON.stringify({ side, quantity: qty, price_ref: 1620, instrument_id: instrument, instrument: { id: instrument, symbol: "INFY", name: "Infosys", type: "stock" } }), qty * 1620, ref])).rows[0].id);
}
const intent = async (id: string) => withFamily(family, async (c) => (await c.query("select status, payload from action_intents where id=$1", [id])).rows[0]);

beforeAll(async () => {
  app = buildApp(); await app.ready();
  const email = `fills-${run}@example.com`;
  expect((await app.inject({ method: "POST", url: "/api/v1/auth/register", payload: { email, password: "longenough1", name: "Fills Tester", family_name: `Fills ${run}` } })).statusCode).toBeLessThan(300);
  const login = (await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password: "longenough1" } })).json();
  token = login.access_token; family = login.families[0].id;
  const e = await post("/entities", { type: "individual", name: "Fills Owner" }); entity = e.body.id;
  expect((await post("/assets/market", { type_code: "stock", entity_id: entity, txn_date: "2026-06-15", quantity: 100, price: 1500, current_price: 1620, instrument: { name: "Infosys", symbol: "INFY", isin: "INE009A01021" } })).code).toBe(201);
  instrument = (await withFamily(family, async (c) => (await c.query("select id from instruments where symbol='INFY'")).rows[0])).id;
});

afterAll(async () => {
  await withFamily(family, async (c) => { for (const t of ["action_executions", "action_intents", "realized_gains", "lots", "investment_txns", "holdings", "accounts", "import_jobs"]) await c.query(`delete from ${t}`).catch(() => {}); });
  await app.close(); await pool.end();
});

describe("proposal orders reconcile against imported fills", () => {
  it("two filled sale orders are each matched to their own fill; an order of another size stays filled", async () => {
    const a = await addOrder("sell", 25, "ORD-A"), b = await addOrder("sell", 25, "ORD-B"), other = await addOrder("sell", 40, "ORD-C");
    const r = await upload(book(row(TODAY, "sell", 25, 1620, "1"), row(TODAY, "sell", 25, 1620, "2")));
    expect(r.body.status).toBe("done"); expect(r.body.rows_ok).toBe(2);
    const [ia, ib, ic] = [await intent(a), await intent(b), await intent(other)];
    expect(ia.status).toBe("reconciled"); expect(ib.status).toBe("reconciled");
    expect(ia.payload.fill_txn_id).toBeTruthy(); expect(ib.payload.fill_txn_id).toBeTruthy();
    expect(ia.payload.fill_txn_id).not.toBe(ib.payload.fill_txn_id);          // one fill per order, never shared
    expect(ic.status).toBe("filled");                                          // 40 shares were never traded
  });

  it("a buy fill does not reconcile a sale order, and an order not yet confirmed is left alone", async () => {
    const sale = await addOrder("sell", 10, "ORD-D");
    const unconfirmed = await addOrder("sell", 10, "ORD-E", "submitted");
    await upload(book(row(TODAY, "buy", 10, 1600, "3")));
    expect((await intent(sale)).status).toBe("filled");
    expect((await intent(unconfirmed)).status).toBe("submitted");
  });
});
