import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildApp } from "../src/server.js";
import { withFamily, pool } from "../src/lib/db.js";

// Premium paid: the bank account the premium left goes down once, and net worth falls by the premium.
const FAMILY = "11111111-1111-1111-1111-111111111111";
const ICICI = "89898989-0000-0000-0000-000000000002";
let app: ReturnType<typeof buildApp>; let token = "";
let policyId = ""; let premium = 0; let dueBefore = ""; let originalBalance = 0;
const h = () => ({ authorization: `Bearer ${token}`, "x-family-id": FAMILY });
const get = async (url: string) => { const r = await app.inject({ url: `/api/v1${url}`, headers: h() }); return { code: r.statusCode, body: r.json() }; };
const post = async (url: string, payload: any) => { const r = await app.inject({ method: "POST", url: `/api/v1${url}`, headers: h(), payload }); return { code: r.statusCode, body: r.json() }; };
const balance = () => withFamily(FAMILY, async (c) => Number((await c.query("select balance from bank_accounts where id=$1", [ICICI])).rows[0].balance));

beforeAll(async () => {
  app = buildApp(); await app.ready();
  token = (await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: "arjun@example.com", password: "Prototype!2026" } })).json().access_token;
  await withFamily(FAMILY, async (c) => {
    originalBalance = Number((await c.query("select balance from bank_accounts where id=$1", [ICICI])).rows[0].balance);
    // a known, positive starting balance, so the test does not depend on what earlier tests left behind
    await c.query("update bank_accounts set balance=100000 where id=$1", [ICICI]);
    const p = (await c.query("select id, premium, next_premium_due::text due from insurance_policies where family_id=$1 and deleted_at is null and status='active' and premium > 0 and next_premium_due is not null order by next_premium_due limit 1", [FAMILY])).rows[0];
    policyId = p.id; premium = Number(p.premium); dueBefore = p.due;
  });
});
afterAll(async () => {
  await withFamily(FAMILY, async (c) => {
    await c.query("update insurance_policies set next_premium_due=$2 where id=$1", [policyId, dueBefore]);
    await c.query("update bank_accounts set balance=$2 where id=$1", [ICICI, originalBalance]);
    await c.query("delete from audit_log where table_name='insurance_policies' and action='premium_paid' and row_id=$1", [policyId]);
  });
  await app.close(); await pool.end();
});

describe("premium paid reduces the bank balance once", () => {
  it("refuses without a bank account, and an unknown account is not found", async () => {
    expect((await post(`/insurance-policies/${policyId}/premium-paid`, {})).code).toBe(422);
    expect((await post(`/insurance-policies/${policyId}/premium-paid`, { bank_account_id: "00000000-0000-4000-8000-000000000000" })).code).toBe(404);
    expect(await balance()).toBeCloseTo(100000, 2);
  });

  it("with the account chosen: the balance goes down by the premium, the next due date moves on, and net worth falls by the same amount", async () => {
    const assetsBefore = Number((await get("/dashboard")).body.assets);
    const r = await post(`/insurance-policies/${policyId}/premium-paid`, { bank_account_id: ICICI });
    expect(r.code).toBe(200);
    expect(await balance()).toBeCloseTo(100000 - premium, 2);
    expect(r.body.next_premium_due).not.toBe(dueBefore);
    const assetsAfter = Number((await get("/dashboard")).body.assets);
    expect(Math.abs((assetsBefore - assetsAfter) - premium)).toBeLessThan(1);
  });
});
