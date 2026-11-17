import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildApp } from "../src/server.js";
import { withFamily, pool } from "../src/lib/db.js";

const FAMILY = "11111111-1111-1111-1111-111111111111";
const TEST_BANK = "89898989-0000-0000-0000-000000000002";   // seeded ICICI Bank ••0928 (the seed has no other accounts for this test)
const NOTE = "lumptest";
// the app skips a file whose contents were already imported, so each run needs contents of its own
const RUN = String(Date.now());
let app: ReturnType<typeof buildApp>; let token = "";
const h = () => ({ authorization: `Bearer ${token}`, "x-family-id": FAMILY });
const get = async (url: string) => { const r = await app.inject({ url: `/api/v1${url}`, headers: h() }); return { code: r.statusCode, body: r.json() }; };
const send = async (method: "POST" | "DELETE", url: string, payload: any = {}) => { const r = await app.inject({ method, url: `/api/v1${url}`, headers: h(), payload }); return { code: r.statusCode, body: r.statusCode === 204 ? null : r.json() }; };
const balance = () => withFamily(FAMILY, async (c) => Number((await c.query("select balance from bank_accounts where id=$1", [TEST_BANK])).rows[0].balance));

let b0 = 0; let balanceAsOf: any = null;
const csv = (rows: { date: string; narration: string; ref: string; amount: number; closing: number }[]) =>
  ["Date,Narration,Chq./Ref.No.,Value Dt,Withdrawal Amt.,Deposit Amt.,Closing Balance",
    ...rows.map((r) => `${r.date},${r.narration},${r.ref},${r.date},,${r.amount.toFixed(2)},${r.closing.toFixed(2)}`), ""].join("\n");

beforeAll(async () => {
  app = buildApp(); await app.ready();
  token = (await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: "arjun@example.com", password: "Prototype!2026" } })).json().access_token;
  await withFamily(FAMILY, async (c) => { const r = (await c.query("select balance, balance_as_of from bank_accounts where id=$1", [TEST_BANK])).rows[0]; b0 = Number(r.balance); balanceAsOf = r.balance_as_of; });
});
afterAll(async () => {
  await withFamily(FAMILY, async (c) => {
    await c.query("update lump_sums set bank_txn_id=null where note=$1", [NOTE]);
    await c.query("delete from lump_sums where note=$1", [NOTE]);
    await c.query("delete from bank_txns where bank_account_id=$1 and narration like 'LUMP TEST%'", [TEST_BANK]);
    await c.query("update bank_accounts set balance=$2, balance_as_of=$3 where id=$1", [TEST_BANK, b0, balanceAsOf]);
  });
  await app.close(); await pool.end();
});

describe("lump sums: one-time money into a bank account", () => {
  it("a new lump sum raises the bank balance once and is pending until a statement arrives", async () => {
    const r = await send("POST", "/lump-sums", { bank_account_id: TEST_BANK, entry_date: "2026-11-10", amount: 100000, reason: "bonus", note: NOTE });
    expect(r.code).toBe(201); expect(r.body).toMatchObject({ status: "pending", amount: "100000.00", reason: "bonus", bank: expect.any(String) });
    expect(await balance()).toBeCloseTo(b0 + 100000, 2);
    expect((await get("/lump-sums")).body.some((x: any) => x.id === r.body.id && x.status === "pending")).toBe(true);
  });

  it("the bank statement with the same credit verifies it, and the balance is not added again", async () => {
    const before = await balance();
    const closing = b0 + 100000;   // the statement's closing balance already includes the lump sum
    const up = await app.inject({ method: "POST", url: "/api/v1/imports", headers: h(), payload: { text: csv([{ date: "10/11/26", narration: `LUMP TEST NEFT CR EMPLOYER BONUS ${RUN}`, ref: `LUMP-A-${RUN}`, amount: 100000, closing }]), filename: "lump_a.csv", source: "bank_csv", bank_account_id: TEST_BANK, entity_id: "0b620494-d932-4ed7-95b5-cc258f9b47cb" } });
    expect(up.statusCode).toBeLessThan(300);
    const row = (await get("/lump-sums")).body.find((x: any) => x.note === NOTE && x.amount === "100000.00");
    expect(row.status).toBe("verified"); expect(row.bank_txn_id).toBeTruthy(); expect(row.verified_on).toBe("2026-11-10");
    expect(await balance()).toBeCloseTo(closing, 2);       // statement balance, not closing + 100000 again
    expect(before).toBeCloseTo(closing, 2);
  });

  it("an entry for money that is already in an earlier statement is verified at once, with no balance change", async () => {
    const closing = b0 + 105000;
    const up = await app.inject({ method: "POST", url: "/api/v1/imports", headers: h(), payload: { text: csv([{ date: "12/11/26", narration: `LUMP TEST NEFT CR GIFT ${RUN}`, ref: `LUMP-B-${RUN}`, amount: 5000, closing }]), filename: "lump_b.csv", source: "bank_csv", bank_account_id: TEST_BANK, entity_id: "0b620494-d932-4ed7-95b5-cc258f9b47cb" } });
    expect(up.statusCode).toBeLessThan(300);
    const before = await balance();
    const r = await send("POST", "/lump-sums", { bank_account_id: TEST_BANK, entry_date: "2026-11-12", amount: 5000, reason: "gift", note: NOTE });
    expect(r.code).toBe(201); expect(r.body.status).toBe("verified");
    expect(await balance()).toBeCloseTo(before, 2);
  });

  it("deleting a pending lump sum takes its money back out of the balance", async () => {
    const before = await balance();
    const r = await send("POST", "/lump-sums", { bank_account_id: TEST_BANK, entry_date: "2026-11-01", amount: 2000, reason: "refund", note: NOTE });
    expect(r.body.status).toBe("pending"); expect(await balance()).toBeCloseTo(before + 2000, 2);
    expect((await send("DELETE", `/lump-sums/${r.body.id}`)).code).toBe(204);
    expect(await balance()).toBeCloseTo(before, 2);
    expect((await get("/lump-sums")).body.some((x: any) => x.id === r.body.id)).toBe(false);
  });

  it("refuses a future date, an unknown account and a zero amount", async () => {
    expect((await send("POST", "/lump-sums", { bank_account_id: TEST_BANK, entry_date: "2099-01-01", amount: 1000, reason: "other", note: NOTE })).code).toBe(422);
    expect((await send("POST", "/lump-sums", { bank_account_id: "00000000-0000-4000-8000-000000000000", entry_date: "2026-11-10", amount: 1000, reason: "other", note: NOTE })).code).toBe(404);
    expect((await send("POST", "/lump-sums", { bank_account_id: TEST_BANK, entry_date: "2026-11-10", amount: 0, reason: "other", note: NOTE })).code).toBe(422);
  });
});
