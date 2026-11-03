import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildApp } from "../src/server.js";
import { pool, withFamily } from "../src/lib/db.js";

// Government savings round 1: SCSS, NSC and KVP ride on the deposit engine, with the scheme's own rate, term, payout and compounding.
const FAMILY = "11111111-1111-1111-1111-111111111111";
let app: ReturnType<typeof buildApp>; let owner = "", viewer = ""; let entity = "";
const h = (t = owner) => ({ authorization: `Bearer ${t}`, "x-family-id": FAMILY });
const get = async (url: string, t = owner) => { const r = await app.inject({ url: `/api/v1${url}`, headers: h(t) }); return { code: r.statusCode, body: r.json() }; };
const post = async (url: string, payload: any, t = owner) => { const r = await app.inject({ method: "POST", url: `/api/v1${url}`, headers: h(t), payload }); return { code: r.statusCode, body: r.body ? r.json() : null }; };
const BANK = "ZZ Govt Savings Post Office";

beforeAll(async () => {
  app = buildApp(); await app.ready();
  const login = async (email: string) => (await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password: "Prototype!2026" } })).json().access_token;
  owner = await login("arjun@example.com"); viewer = await login("ca@example.com");
  entity = (await get("/entities")).body[0].id;
});
afterAll(async () => {
  await withFamily(FAMILY, async (c) => {
    await c.query("delete from tasks where title like '%ZZ Govt%' or reason like '%ZZ Govt%'");
    await c.query("delete from deposits where bank=$1", [BANK]);
  });
  await app.close(); await pool.end();
});

describe("government savings types", () => {
  it("the catalogue carries the scheme rules and the starting rate", async () => {
    const t = (await get("/deposit-types")).body; const by = (c: string) => t.find((x: any) => x.code === c);
    expect(by("scss")).toMatchObject({ kind: "fd", min_tenure_months: 60, max_tenure_months: 60, default_payout: "quarterly", govt_scheme: true, compounding: "quarterly" });
    expect(by("nsc")).toMatchObject({ break_rule: "never", compounding: "yearly", default_tds: false });
    expect(by("kvp")).toMatchObject({ min_tenure_months: 115, compounding: "yearly" });
    expect(by("nsc").default_rate_pct).toBeGreaterThan(0); expect(by("nsc").rate_note).toMatch(/indiapost/);
    const a = (await get("/asset-types")).body; expect(a.find((x: any) => x.code === "nsc")).toMatchObject({ enabled: true, deposit_type_code: "nsc" }); expect(a.find((x: any) => x.code === "nps")).toMatchObject({ enabled: true, instrument_type: "nps" });
  });
  it("NSC grows once a year and is paid at maturity; SCSS pays every quarter; KVP doubles in its term", async () => {
    const nsc = await post("/deposits", { entity_id: entity, kind: "fd", type_code: "nsc", bank: BANK, rate_pct: 7.7, start_date: "2026-04-01", maturity_date: "2031-04-01", principal: 100000, payout_frequency: "at_maturity", tds_applicable: false });
    expect(nsc.code).toBe(201); const m = nsc.body.receipts.filter((r: any) => r.kind === "maturity"); expect(m).toHaveLength(1);
    expect(Number(m[0].expected_amount)).toBeCloseTo(100000 * Math.pow(1.077, 5), 0);   // 144,903 (yearly compounding)
    expect(nsc.body.receipts.filter((r: any) => r.kind === "interest")).toHaveLength(0);
    const scss = await post("/deposits", { entity_id: entity, kind: "fd", type_code: "scss", bank: BANK, rate_pct: 8.2, start_date: "2026-04-01", maturity_date: "2031-04-01", principal: 1000000, payout_frequency: "quarterly", tds_applicable: true });
    expect(scss.code).toBe(201); const ints = scss.body.receipts.filter((r: any) => r.kind === "interest"); expect(ints).toHaveLength(20); expect(Number(ints[0].expected_amount)).toBe(20500);   // 10 lakh x 8.2% / 4
    expect(Number(scss.body.receipts.find((r: any) => r.kind === "maturity").expected_amount)).toBe(1000000);
    const kvp = await post("/deposits", { entity_id: entity, kind: "fd", type_code: "kvp", bank: BANK, rate_pct: 7.5, start_date: "2026-04-01", maturity_date: "2035-11-01", principal: 100000, payout_frequency: "at_maturity", tds_applicable: false });
    expect(kvp.code).toBe(201); expect(Number(kvp.body.receipts.find((r: any) => r.kind === "maturity").expected_amount)).toBeGreaterThan(199000);
    expect(Number(kvp.body.receipts.find((r: any) => r.kind === "maturity").expected_amount)).toBeLessThan(201500);
  });
  it("the fixed term is enforced, an NSC cannot be closed early, a viewer cannot add, the rate and amounts stay editable until money is recorded", async () => {
    expect((await post("/deposits", { entity_id: entity, kind: "fd", type_code: "nsc", bank: BANK, rate_pct: 7.7, start_date: "2026-04-01", maturity_date: "2029-04-01", principal: 50000, payout_frequency: "at_maturity" })).code).toBe(422);   // not 5 years
    expect((await post("/deposits", { entity_id: entity, kind: "fd", type_code: "nsc", bank: BANK, rate_pct: 7.7, start_date: "2026-04-01", maturity_date: "2031-04-01", principal: 50000 }, viewer)).code).toBe(403);
    const d = (await get("/deposits")).body.find((x: any) => x.bank === BANK && x.type_code === "nsc"); expect(d.foreclose.allowed).toBe(false);
    const r = await app.inject({ method: "PATCH", url: `/api/v1/deposits/${d.id}`, headers: h(), payload: { rate_pct: 7.5 } }); expect(r.statusCode).toBe(200);
    expect(Number(r.json().receipts.find((x: any) => x.kind === "maturity").expected_amount)).toBeCloseTo(100000 * Math.pow(1.075, 5), 0);   // the schedule follows the edited rate
  });
});
