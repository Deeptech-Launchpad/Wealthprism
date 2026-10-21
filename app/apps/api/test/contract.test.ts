import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.STORAGE_DIR ??= mkdtempSync(join(tmpdir(), "fo-contract-"));
import { buildApp } from "../src/server.js";
import { pool, withFamily } from "../src/lib/db.js";
import { totp } from "../src/lib/auth.js";

// Contract residue (FO-10/13/28/30/37/38/44/45/60): MFA enrolment + second login step, families and invitations, entities with encrypted
// PAN and GSTINs, manual investment transactions through the lot engine, harvest candidates and CG export, CAS refresh, integrations
// health, and the start-up module's write paths (companies, rounds → re-marks, marks, commitments, exit scenario). Everything cleans up.
const FAMILY = "11111111-1111-1111-1111-111111111111", ARJUN = "33333333-0000-0000-0000-000000000001", HUF = "33333333-0000-0000-0000-000000000002";
const TCS = "44444444-0000-0000-0000-000000000002", VARAHA = "67676767-0000-0000-0000-000000000005", CROPSENSE_PI = "67676767-0000-0000-0000-000000000001";
let app: ReturnType<typeof buildApp>; let owner = "", member = "", viewer = "", ops = ""; const before: Record<string, string[]> = {};
const h = (t = owner) => ({ authorization: `Bearer ${t}`, "x-family-id": FAMILY });
const get = async (url: string, t = owner) => { const r = await app.inject({ url: `/api/v1${url}`, headers: h(t) }); return { code: r.statusCode, body: r.statusCode === 204 ? null : r.json() }; };
const send = async (method: "POST" | "PATCH" | "PUT" | "DELETE", url: string, payload: any = {}, t = owner) => { const r = await app.inject({ method, url: `/api/v1${url}`, headers: h(t), payload }); return { code: r.statusCode, body: r.statusCode === 204 ? null : r.json() }; };
const run = <T>(fn: (c: any) => Promise<T>) => withFamily(FAMILY, fn);
const login = async (email: string, password = "Prototype!2026") => (await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password } })).json();

beforeAll(async () => {
  app = buildApp(); await app.ready();
  owner = (await login("arjun@example.com")).access_token; member = (await login("priya@example.com")).access_token; viewer = (await login("ca@example.com")).access_token; ops = (await login("ops@example.com")).access_token;
  await run(async (c) => { for (const [k, sql] of Object.entries({ rg: "select id from realized_gains where family_id=$1 and entity_id=$2 and instrument_id=$3", h: "select id from holdings where family_id=$1 and entity_id=$2 and instrument_id=$3", t: "select id from investment_txns where family_id=$1 and entity_id=$2 and instrument_id=$3" })) before[k] = (await c.query(sql, [FAMILY, ARJUN, TCS])).rows.map((r) => r.id); });   // the seed has an Arjun / TCS realised gain: only rows this file adds are removed
  await cleanup();
});
async function cleanup() {
  await pool.query("update users set mfa_enabled=false, mfa_secret=null where email='ca@example.com'");
  await run(async (c) => {
    await c.query("delete from realized_gains where family_id=$1 and entity_id=$2 and instrument_id=$3 and id::text <> all($4::text[])", [FAMILY, ARJUN, TCS, before.rg ?? []]);
    await c.query("delete from lots where family_id=$1 and holding_id in (select id from holdings where family_id=$1 and entity_id=$2 and instrument_id=$3 and id::text <> all($4::text[]))", [FAMILY, ARJUN, TCS, before.h ?? []]);
    await c.query("delete from holdings where family_id=$1 and entity_id=$2 and instrument_id=$3 and id::text <> all($4::text[])", [FAMILY, ARJUN, TCS, before.h ?? []]);
    await c.query("delete from investment_txns where family_id=$1 and entity_id=$2 and instrument_id=$3 and id::text <> all($4::text[])", [FAMILY, ARJUN, TCS, before.t ?? []]);
    await c.query("delete from tasks where family_id=$1 and source_type='cas_refresh'", [FAMILY]); await c.query("delete from import_jobs where family_id=$1 and source='cas' and status='queued' and error_log::text like '%cas-refresh-%'", [FAMILY]);
    const cg = (await c.query("delete from report_jobs where family_id=$1 and report_code='capital_gains' and created_at > now() - interval '1 hour' returning document_id", [FAMILY])).rows.map((r) => r.document_id).filter(Boolean); if (cg.length) await c.query("delete from documents where family_id=$1 and id = any($2::uuid[])", [FAMILY, cg]);
    await c.query("delete from private_investments where family_id=$1 and company_id in (select id from private_companies where family_id=$1 and name like 'Test %')", [FAMILY]);
    await c.query("delete from private_rounds where company_id in (select id from private_companies where family_id=$1 and name like 'Test %')", [FAMILY]);
    await c.query("delete from private_companies where family_id=$1 and name like 'Test %'", [FAMILY]);
    await c.query("delete from private_marks where private_investment_id=$1 and note like 'Test %'", [CROPSENSE_PI]);
    await c.query("delete from entities where family_id=$1 and name like 'Test %'", [FAMILY]);
    await c.query("delete from family_members where family_id=$1 and user_id in (select id from users where email like 'test-%@example.com')", [FAMILY]);
  });
  await pool.query("delete from families where name like 'Test %'"); await pool.query("delete from users where email like 'test-%@example.com'");
}
afterAll(async () => { await cleanup(); await app.close(); await pool.end(); rmSync(process.env.STORAGE_DIR!, { recursive: true, force: true }); });

describe("MFA, families, members and entities", () => {
  it("MFA: setup → confirm turns it on, login then needs the second step (TOTP or the dev bypass), and it can be switched off", async () => {
    const setup = await send("POST", "/auth/mfa/setup", {}, viewer); expect(setup.code).toBe(200); expect(setup.body.otpauth_uri).toMatch(/^otpauth:\/\/totp\/WealthPrism:/);
    expect((await send("POST", "/auth/mfa/confirm", { code: "123456" }, viewer)).code).toBe(401);
    expect((await send("POST", "/auth/mfa/confirm", { code: totp(setup.body.secret) }, viewer)).body).toEqual({ mfa_enabled: true });
    const first = await login("ca@example.com"); expect(first).toMatchObject({ mfa_required: true }); expect(first.access_token).toBeUndefined();
    expect((await app.inject({ method: "POST", url: "/api/v1/auth/mfa/verify", payload: { mfa_token: first.mfa_token, code: "111111" } })).statusCode).toBe(401);
    const second = (await app.inject({ method: "POST", url: "/api/v1/auth/mfa/verify", payload: { mfa_token: first.mfa_token, code: totp(setup.body.secret) } })).json(); expect(second.access_token).toBeTruthy(); expect(second.families.some((f: any) => f.family_id === FAMILY || f.id === FAMILY)).toBe(true);
    const third = (await app.inject({ method: "POST", url: "/api/v1/auth/mfa/verify", payload: { mfa_token: first.mfa_token, code: "000000" } })).json(); expect(third.access_token).toBeTruthy();
    expect((await app.inject({ method: "DELETE", url: "/api/v1/auth/mfa", headers: { authorization: `Bearer ${second.access_token}` }, payload: { code: "000000" } })).statusCode).toBe(200);
    expect((await login("ca@example.com")).access_token).toBeTruthy();
  });
  it("a signed-in user can create a family and becomes its owner with working-capital and bucket defaults", async () => {
    const r = await app.inject({ method: "POST", url: "/api/v1/families", headers: { authorization: `Bearer ${member}` }, payload: { name: "Test Family Two", base_currency: "inr" } }); expect(r.statusCode).toBe(201);
    const f = r.json(); expect(f).toMatchObject({ name: "Test Family Two", base_currency: "INR", role: "owner" }); expect(f.families.some((x: any) => (x.family_id ?? x.id) === f.id)).toBe(true);
    const wc = await app.inject({ url: "/api/v1/working-capital/settings", headers: { authorization: `Bearer ${member}`, "x-family-id": f.id } }); expect(wc.statusCode).toBe(200);
    const bt = await app.inject({ url: "/api/v1/bucket-targets", headers: { authorization: `Bearer ${member}`, "x-family-id": f.id } }); expect(bt.json()).toMatchObject({ liquidity_pct: 8, income_pct: 32, growth_pct: 60 });
    expect((await app.inject({ url: "/api/v1/entities", headers: { authorization: `Bearer ${owner}`, "x-family-id": f.id } })).statusCode).toBe(403);   // arjun is not a member of the new family
  });
  it("invite → accept with the token → login; owners change roles and remove members; nobody removes themselves", async () => {
    expect((await send("POST", "/auth/invite", { email: "test-invitee@example.com", role: "viewer" }, member)).code).toBe(403);
    const inv = await send("POST", "/auth/invite", { email: "Test-Invitee@example.com", role: "viewer", name: "Test Invitee" }); expect(inv.code).toBe(201); expect(inv.body).toMatchObject({ email: "test-invitee@example.com", role: "viewer" }); expect(inv.body.invite_token).toBeTruthy();
    expect((await get("/members")).body.find((m: any) => m.email === "test-invitee@example.com")).toMatchObject({ role: "viewer", accepted_at: null });
    expect((await app.inject({ method: "POST", url: "/api/v1/auth/invite/accept", payload: { email: "test-invitee@example.com", token: "wrong-token-value", password: "Invitee!20261" } })).statusCode).toBe(403);
    const acc = await app.inject({ method: "POST", url: "/api/v1/auth/invite/accept", payload: { email: "test-invitee@example.com", token: inv.body.invite_token, password: "Invitee!20261" } }); expect(acc.statusCode).toBe(200); expect(acc.json().family_id).toBe(FAMILY);
    expect((await app.inject({ method: "POST", url: "/api/v1/auth/invite/accept", payload: { email: "test-invitee@example.com", token: inv.body.invite_token, password: "Invitee!20261" } })).statusCode).toBe(403);   // single use
    const li = await login("test-invitee@example.com", "Invitee!20261"); expect(li.access_token).toBeTruthy();
    expect((await get("/entities", li.access_token)).code).toBe(200); expect((await send("POST", "/goals", { name: "Test goal", target_year: 2030, amount_today: 1, bucket: "growth" }, li.access_token)).code).toBe(403);
    expect((await send("POST", "/auth/invite", { email: "test-invitee@example.com", role: "member" })).code).toBe(409);
    expect((await send("PATCH", `/members/${inv.body.user_id}`, { role: "member" })).body).toMatchObject({ role: "member" }); const g = await send("POST", "/goals", { name: "Test goal", target_year: 2030, amount_today: 1, bucket: "growth" }, li.access_token); expect(g.code).toBe(201);   // the role is read per request, not from the token
    await run((c) => c.query("delete from goals where id=$1", [g.body.id]));
    expect((await send("DELETE", `/members/22222222-0000-0000-0000-000000000001`)).code).toBe(409);
    expect((await send("DELETE", `/members/${inv.body.user_id}`)).code).toBe(204); expect((await get("/members")).body.some((m: any) => m.email === "test-invitee@example.com")).toBe(false);
    expect((await get("/entities", li.access_token)).code).toBe(403);
  });
  it("entities: PAN is stored encrypted with only the last four visible; GSTINs must carry the entity's PAN", async () => {
    expect((await send("POST", "/entities", { type: "llp", name: "Test LLP", pan: "abcde1234f" }, viewer)).code).toBe(403); expect((await send("POST", "/entities", { type: "llp", name: "Test LLP", pan: "12345" })).code).toBe(422);
    const e = await send("POST", "/entities", { type: "llp", name: "Test Ventures LLP", pan: "AAFFT1234K", tax_regime: "old", slab_rate: 30, dob_or_incorp: "2019-04-01" }); expect(e.code).toBe(201); expect(e.body).toMatchObject({ type: "llp", pan_last4: "234K", tax_regime: "old", slab_rate: 30, gstins: [] }); expect(e.body.pan).toBeUndefined();
    const raw = (await run((c) => c.query("select pan_enc, pan_last4 from entities where id=$1", [e.body.id]))).rows[0]; expect(raw.pan_last4).toBe("234K"); expect(Buffer.from(raw.pan_enc).toString("utf8")).not.toContain("AAFFT1234K");
    expect((await get(`/entities/${e.body.id}`)).body.name).toBe("Test Ventures LLP"); expect((await get("/entities")).body.some((x: any) => x.id === e.body.id)).toBe(true);
    expect((await send("PATCH", `/entities/${e.body.id}`, { name: "Test Ventures LLP (renamed)", slab_rate: 25 })).body).toMatchObject({ name: "Test Ventures LLP (renamed)", slab_rate: 25, pan_last4: "234K" });
    expect((await send("POST", `/entities/${e.body.id}/gstins`, { gstin: "33ABCDE1234F1Z5" })).code).toBe(422); expect((await send("POST", `/entities/${e.body.id}/gstins`, { gstin: "bad" })).code).toBe(422);
    const g = await send("POST", `/entities/${e.body.id}/gstins`, { gstin: "33aafft1234k1z5", registered_on: "2020-07-01" }); expect(g.code).toBe(201); expect(g.body).toMatchObject({ gstin: "33AAFFT1234K1Z5", state_code: "33", active: true });
    expect((await get(`/entities/${e.body.id}`)).body.gstins).toHaveLength(1); expect((await get("/entities/00000000-0000-0000-0000-000000000000")).code).toBe(404);
  });
});

describe("investments residue", () => {
  it("manual transactions run through the lot engine: a buy opens the holding, a later sell realises a long-term gain FIFO, and duplicates are refused", async () => {
    expect((await send("POST", "/investment-txns", { entity_id: ARJUN, instrument_id: TCS, type: "buy", txn_date: "2025-01-10", quantity: 10, price: 3500, amount: 35000 }, viewer)).code).toBe(403);
    expect((await send("POST", "/investment-txns", { entity_id: ARJUN, instrument_id: TCS, type: "buy", txn_date: "2025-01-10", amount: 35000 })).code).toBe(422);
    const buy = await send("POST", "/investment-txns", { entity_id: ARJUN, instrument_id: TCS, type: "buy", txn_date: "2025-01-10", quantity: 10, price: 3500, amount: 35000, charges: 20, note: "Test buy" }, ops); expect(buy.code).toBe(201);
    expect(buy.body).toMatchObject({ source: "manual", quantity: 10, price: 3500, amount: "35000.00", holding: { quantity: 10 } }); expect(buy.body.holding.avg_cost).toBeCloseTo(3502, 0);
    expect((await send("POST", "/investment-txns", { entity_id: ARJUN, instrument_id: TCS, type: "buy", txn_date: "2025-01-10", quantity: 10, price: 3500, amount: 35000, charges: 20 })).code).toBe(409);
    const sell = await send("POST", "/investment-txns", { entity_id: ARJUN, instrument_id: TCS, type: "sell", txn_date: "2026-06-10", quantity: 4, price: 4000, amount: 16000 }); expect(sell.code).toBe(201); expect(sell.body.holding.quantity).toBe(6);
    const rg = (await run((c) => c.query("select term, gain, fy from realized_gains where family_id=$1 and entity_id=$2 and instrument_id=$3 and id::text <> all($4::text[])", [FAMILY, ARJUN, TCS, before.rg]))).rows; expect(rg).toHaveLength(1); expect(rg[0]).toMatchObject({ term: "long", fy: "2026-27" }); expect(Number(rg[0].gain)).toBeCloseTo(4 * (4000 - 3502), 0);
    const list = (await get(`/investment-txns?entity_id=${ARJUN}&instrument_id=${TCS}`)).body; expect(list.total).toBe(2); expect(list.items[0]).toMatchObject({ type: "sell", instrument: expect.stringMatching(/TCS|Tata/) });
    expect((await get(`/investment-txns?type=sell&from=2026-06-01&to=2026-06-30`)).body.items.some((t: any) => t.id === sell.body.id)).toBe(true);
    expect((await send("POST", "/investment-txns", { entity_id: ARJUN, instrument_id: TCS, type: "sell", txn_date: "2026-06-11", quantity: 60, price: 4000, amount: 240000 })).code).toBe(422);   // more than held
  });
  it("harvest candidates rank losses first and fit exempt long-term gains inside the exemption headroom from tax_rules", async () => {
    const r = await get("/harvest-candidates?fy=2026-27"); expect(r.code).toBe(200); expect(r.body.fy).toBe("2026-27"); expect(Array.isArray(r.body.rows)).toBe(true);
    for (const row of r.body.rows) { expect(["loss", "exempt_gain"]).toContain(row.kind); expect(row.tax_rate_pct == null || typeof row.tax_rate_pct === "number").toBe(true); }
    const kinds = r.body.rows.map((x: any) => x.kind); expect(kinds.lastIndexOf("loss")).toBeLessThan(kinds.includes("exempt_gain") ? kinds.indexOf("exempt_gain") : Infinity);
    const one = r.body.rows.find((x: any) => x.kind === "exempt_gain"); if (one) { expect(Number(one.exemption_headroom)).toBeGreaterThan(0); expect(one.term).toBe("long"); }
    expect((await get(`/harvest-candidates?entity_id=${HUF}`)).body.rows.every((x: any) => x.entity === "Mehta HUF")).toBe(true);
  });
  it("capital-gains export runs the report and answers with the job and a signed document link", async () => {
    const r = await get("/capital-gains/export?fy=2026-27&format=csv"); expect(r.code).toBe(202); expect(r.body).toMatchObject({ report_code: "capital_gains", format: "csv" }); expect(r.body.document_id).toBeTruthy(); expect(r.body.url).toMatch(/\/api\/v1\/(files|documents)\//);
    expect(["done", "queued", "running"]).toContain(r.body.status); expect((await get("/capital-gains/export?fy=26-27")).code).toBe(422);
  });
  it("CAS refresh queues an import with a task to forward the statement; integrations health lists every source", async () => {
    const r = await send("POST", "/imports/cas/refresh", { entity_id: ARJUN }, ops); expect(r.code).toBe(202); expect(r.body).toMatchObject({ source: "cas", status: "queued", provider_ref: null }); expect(r.body.task_id).toBeTruthy();
    const t = (await get("/tasks?module=imports")).body; const task = (Array.isArray(t) ? t : t.items).find((x: any) => x.id === r.body.task_id); expect(task).toBeTruthy(); expect(task.title).toMatch(/CAS refresh for Arjun/);
    expect((await send("POST", "/imports/cas/refresh", { entity_id: "00000000-0000-0000-0000-000000000000" })).code).toBe(404);
    const hlth = await get("/integrations/health"); expect(hlth.code).toBe(200); const kinds = new Set(hlth.body.map((x: any) => x.kind)); for (const k of ["feed", "account_aggregator", "ingest", "delivery", "data"]) expect(kinds.has(k)).toBe(true);
    for (const x of hlth.body) expect(["healthy", "needs_review", "manual", "failed"]).toContain(x.status);
  });
});

describe("start-ups and private investments (PRD 3.7)", () => {
  it("company → investment → round re-marks every stake at the round price and dilutes the holding %; marks and detail read back", async () => {
    const co = await send("POST", "/private-companies", { name: "Test Robotics Pvt Ltd", sector: "deeptech", cin: "U72900KA2021PTC000001" }); expect(co.code).toBe(201);
    expect((await send("PATCH", `/private-companies/${co.body.id}`, { website: "https://test-robotics.example" })).body.website).toBe("https://test-robotics.example");
    const pi = await send("POST", "/private-investments", { entity_id: ARJUN, company_id: co.body.id, instrument: "ccps", stage: "seed", invested_on: "2024-06-01", amount: 40000, shares_or_units: 400, holding_pct: 4, bucket: "growth" }); expect(pi.code).toBe(201); expect(pi.body).toMatchObject({ company: "Test Robotics Pvt Ltd", amount: "40000.00", shares_or_units: 400, holding_pct: 4, mark: "40000.00" });
    expect((await send("POST", "/private-investments", { entity_id: ARJUN, company_id: "00000000-0000-0000-0000-000000000000", instrument: "ccps", invested_on: "2024-06-01", amount: 1 })).code).toBe(404);
    const round = await send("POST", `/private-companies/${co.body.id}/rounds`, { round_name: "Series A", closed_on: "2026-03-01", pre_money: 1800000, raised: 600000, total_shares_post: 12000 }); expect(round.code).toBe(201);
    expect(round.body).toMatchObject({ post_money: "2400000.00", price_per_share: 200 }); expect(round.body.marked).toEqual([{ private_investment_id: pi.body.id, holding_pct: 3.333, mark: "80000.00" }]);
    const d = (await get(`/private-investments/${pi.body.id}`)).body; expect(d).toMatchObject({ holding_pct: 3.333, mark: "80000.00", moic: 2 }); expect(d.rounds).toHaveLength(1); expect(d.marks[0]).toMatchObject({ basis: "last_round", value: "80000.00" });
    const mk = await send("POST", `/private-investments/${pi.body.id}/marks`, { marked_on: "2026-09-01", value: 70000, basis: "manual", note: "Test secondary quote" }); expect(mk.code).toBe(201);
    expect((await get(`/private-investments/${pi.body.id}`)).body.mark).toBe("70000.00"); expect((await send("PATCH", `/private-investments/${pi.body.id}`, { status: "exited" })).body.status).toBe("exited");
    expect((await get("/private-companies")).body.find((x: any) => x.id === co.body.id)).toMatchObject({ investments: 1 }); expect((await send("POST", "/private-companies", { name: "Test X" }, viewer)).code).toBe(403);
  });
  it("commitments keep scheduled calls inside the unfunded amount; the exit scenario prices tax from tax_rules and shows the bucket effect without recording anything", async () => {
    const before = (await get(`/private-investments/${VARAHA}`)).body; expect(before.commitment).toMatchObject({ total_commitment: "160000.00", drawn: "120000.00", unfunded: "40000.00" });
    expect((await send("PUT", `/private-investments/${VARAHA}/commitments`, { total_commitment: 160000, drawn: 120000, schedule: [{ due: "2026-10-14", amount: 30000 }, { due: "2027-04-14", amount: 30000 }] })).code).toBe(422);
    expect((await send("PUT", `/private-investments/${VARAHA}/commitments`, { total_commitment: 100000, drawn: 120000, schedule: [] })).code).toBe(422);
    const put = await send("PUT", `/private-investments/${VARAHA}/commitments`, { total_commitment: 160000, drawn: 120000, schedule: [{ due: "2027-04-14", amount: 20000 }, { due: "2026-10-14", amount: 20000 }] }); expect(put.code).toBe(200); expect(put.body.schedule.map((s: any) => s.due)).toEqual(["2026-10-14", "2027-04-14"]); expect(put.body.unfunded).toBe("40000.00");
    const sc = await send("POST", `/private-investments/${CROPSENSE_PI}/exit-scenario`, { price_per_unit: 1000, units: 120, exit_on: "2026-09-30" }); expect(sc.code).toBe(200);
    expect(sc.body).toMatchObject({ proceeds: "120000.00", cost: "50000.00", gain: "70000.00", term: "long" }); expect(Number(sc.body.tax)).toBeGreaterThan(0); expect(Number(sc.body.tax)).toBeLessThan(70000); expect(sc.body.moic).toBe(2.4); expect(typeof sc.body.bucket_effect_pp).toBe("number");
    const rule = (await run((c) => c.query("select rate, taxed_at_slab from tax_rules where asset_class='unlisted_equity' and term='long' and fy <= '2026-27' order by fy desc limit 1"))).rows[0]; const slab = Number((await run((c) => c.query("select slab_rate from entities where id=$1", [ARJUN]))).rows[0].slab_rate);
    expect(Number(sc.body.tax)).toBeCloseTo(70000 * (rule.taxed_at_slab ? slab : Number(rule.rate)) / 100, 0);
    expect((await send("POST", `/private-investments/${CROPSENSE_PI}/exit-scenario`, { price_per_unit: 1000, units: 500 })).code).toBe(422);
    expect((await run((c) => c.query("select count(*)::int n from private_exits where private_investment_id=$1", [CROPSENSE_PI]))).rows[0].n).toBe(0);
  });
});
