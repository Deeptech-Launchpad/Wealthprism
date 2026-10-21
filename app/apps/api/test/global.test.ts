import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { buildApp } from "../src/server.js";
import { pool, withFamily } from "../src/lib/db.js";
import { ingestFxRates } from "../src/lib/global.js";

// Global module (PRD 3.13) + contract closure: FX rates, LRS against the limit with TCS from tax_params, foreign tax credits; the extraction
// and intent-edit contract aliases; and — now that the last stub is gone — every OpenAPI path answers something other than 501.
const FAMILY = "11111111-1111-1111-1111-111111111111", ARJUN = "33333333-0000-0000-0000-000000000001", HUF = "33333333-0000-0000-0000-000000000002", PPFAS = "44444444-0000-0000-0000-000000000003";
let app: ReturnType<typeof buildApp>; let owner = "", member = "";
const h = (t = owner) => ({ authorization: `Bearer ${t}`, "x-family-id": FAMILY });
const get = async (url: string, t = owner) => { const r = await app.inject({ url: `/api/v1${url}`, headers: h(t) }); return { code: r.statusCode, body: r.json() }; };
const send = async (method: "POST" | "PATCH" | "PUT" | "DELETE", url: string, payload: any = {}, t = owner) => { const r = await app.inject({ method, url: `/api/v1${url}`, headers: h(t), payload }); return { code: r.statusCode, body: r.statusCode === 204 ? null : r.json() }; };
const run = <T>(fn: (c: any) => Promise<T>) => withFamily(FAMILY, fn);
const upload = async (file: { name: string; mime: string; data: Buffer }) => { const b = "----fo" + Math.random().toString(16).slice(2); const parts = [Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: ${file.mime}\r\n\r\n`), file.data, Buffer.from(`\r\n--${b}--\r\n`)]; const r = await app.inject({ method: "POST", url: "/api/v1/documents", headers: { ...h(), "content-type": `multipart/form-data; boundary=${b}` }, payload: Buffer.concat(parts) }); return { code: r.statusCode, body: r.json() }; };

beforeAll(async () => {
  app = buildApp(); await app.ready();
  const login = async (email: string) => (await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password: "Prototype!2026" } })).json().access_token;
  owner = await login("arjun@example.com"); member = await login("priya@example.com"); await cleanup();
});
async function cleanup() {
  await pool.query("delete from fx_rates where source in ('manual','test-feed') or (ccy='EUR' and rate_date='2026-09-12')");
  await run(async (c) => { await c.query("delete from lrs_remittances where family_id=$1 and note like 'Test%'", [FAMILY]); await c.query("delete from foreign_tax_credits where family_id=$1 and note like 'Test%'", [FAMILY]);
    const docs = (await c.query("select id from documents where family_id=$1 and name='global-test.txt'", [FAMILY])).rows.map((r) => r.id); if (docs.length) { await c.query("delete from document_extractions where document_id = any($1::uuid[])", [docs]); await c.query("delete from documents where id = any($1::uuid[])", [docs]); }
    await c.query("delete from action_intents where family_id=$1 and rationale like 'Test edit%'", [FAMILY]); });
}
afterAll(async () => { await cleanup(); await app.close(); await pool.end(); });

describe("FX, LRS and foreign tax credits", () => {
  it("serves the latest reference rate on or before a date, accepts owner-entered rates, and ingests a daily feed", async () => {
    const all = (await get("/fx-rates")).body; expect(all.find((r: any) => r.ccy === "USD")).toMatchObject({ rate_date: "2026-09-11", rate_inr: "83.2600", source: "rbi" });
    expect((await get("/fx-rates?ccy=usd&date=2026-09-10")).body[0].rate_inr).toBe("83.2100"); expect((await get("/fx-rates?ccy=JPY")).code).toBe(404);
    expect((await send("PUT", "/fx-rates", { ccy: "EUR", rate_date: "2026-09-12", rate_inr: 91.5 }, member)).code).toBe(403);
    const put = await send("PUT", "/fx-rates", { ccy: "eur", rate_date: "2026-09-12", rate_inr: 91.5 }); expect(put.code).toBe(200); expect(put.body).toMatchObject({ ccy: "EUR", rate_inr: "91.5000", source: "manual" });
    const fed = await ingestFxRates({ base: "INR", date: "2026-09-12", rates: { USD: 0.012, JPY: 1.77 } }, "test-feed"); expect(fed.rows).toBe(2);
    expect((await get("/fx-rates?ccy=USD&date=2026-09-12&source=test-feed")).body[0].rate_inr).toBe("83.3333"); expect(Number((await get("/fx-rates?ccy=JPY")).body[0].rate_inr)).toBeCloseTo(0.565, 3);
    expect((await ingestFxRates({ base: "USD", date: "2026-09-12", rates: { INR: 83.4, EUR: 0.91 } }, "test-feed")).rows).toBe(2); expect((await get("/fx-rates?ccy=EUR&source=test-feed")).body[0].rate_inr).toBe("91.6484");
  });
  it("LRS: totals per entity against the limit, TCS above the threshold from tax_params, and a warning when a remittance breaches the limit", async () => {
    const s = (await get("/global/lrs?fy=2026-27")).body; expect(s).toMatchObject({ fy: "2026-27", limit_usd: 250000, tcs_threshold_inr: "1000000.00", tcs_rate_pct: 20, total_usd: 25000 });
    const a = s.by_entity.find((e: any) => e.entity_id === ARJUN); expect(a).toMatchObject({ total_usd: 25000, total_inr: "2080000.00", headroom_usd: 225000, tcs_expected: "216000.00", tcs_collected: "216000.00", over_limit: false });
    const r = await send("POST", "/global/lrs", { entity_id: ARJUN, remitted_on: "2026-09-11", ccy: "USD", amount_ccy: 230000, purpose: "overseas_investment", note: "Test — big" }); expect(r.code).toBe(201); expect(r.body.amount_inr).toBe((230000 * 83.26).toFixed(2)); expect(r.body.warning).toMatch(/above the LRS limit/);
    const eur = await send("POST", "/global/lrs", { entity_id: HUF, remitted_on: "2026-09-11", ccy: "EUR", amount_ccy: 1000, note: "Test — eur" }); expect(eur.body.amount_inr).toBe("91420.00"); expect(eur.body.warning).toBeNull();
    const s2 = (await get("/global/lrs?fy=2026-27")).body; expect(s2.by_entity.find((e: any) => e.entity_id === ARJUN).over_limit).toBe(true); expect(s2.items.length).toBe(3);
    expect((await send("POST", "/global/lrs", { entity_id: ARJUN, remitted_on: "2026-09-11", ccy: "CHF", amount_ccy: 100, note: "Test — no rate" })).code).toBe(422);
    expect((await send("DELETE", `/global/lrs/${r.body.id}`)).code).toBe(204); expect((await send("DELETE", `/global/lrs/${eur.body.id}`)).code).toBe(204);
  });
  it("foreign tax credits: list per entity and FY with Form 67 pending, create, mark filed, refuse tax above income", async () => {
    const l = (await get("/global/foreign-tax-credits?fy=2026-27")).body; expect(l.items[0]).toMatchObject({ country: "US", income_type: "dividend", income_inr: "42000.00", foreign_tax_inr: "10500.00", dtaa_article: "Article 10", form67_filed_on: null }); expect(l.by_entity_fy[0].form67_pending).toBe(1);
    const c = await send("POST", "/global/foreign-tax-credits", { entity_id: ARJUN, fy: "2026-27", country: "sg", income_type: "interest", income_inr: 12000, foreign_tax_inr: 1800, dtaa_article: "Article 11", note: "Test — sg" }); expect(c.code).toBe(201); expect(c.body.country).toBe("SG");
    expect((await send("PATCH", `/global/foreign-tax-credits/${c.body.id}`, { form67_filed_on: "2026-09-12" })).body.form67_filed_on).toBeTruthy();
    expect((await send("POST", "/global/foreign-tax-credits", { entity_id: ARJUN, fy: "2026-27", country: "US", income_type: "gains", income_inr: 1000, foreign_tax_inr: 2000, note: "Test — bad" })).code).toBe(422);
    expect((await send("DELETE", `/global/foreign-tax-credits/${c.body.id}`)).code).toBe(204);
  });
});

describe("contract closure", () => {
  it("/extractions aliases the review queue: corrected fields merge, a status decides through the same path", async () => {
    const d = await upload({ name: "global-test.txt", mime: "text/plain", data: Buffer.from("Premium notice\nPolicy No: TEST-1\nSum assured Rs. 5,00,000\nPremium due 05-Oct-2026 Rs. 1,800\n") }); expect(d.code).toBe(201);
    const x = await send("POST", `/documents/${d.body.id}/extract`); expect([200, 201, 202]).toContain(x.code); const id = x.body.id ?? x.body.extraction?.id;
    expect((await get("/extractions")).body.some((e: any) => e.id === id)).toBe(true);
    const m = await send("PATCH", `/extractions/${id}`, { extracted: { corrected_by: "test" } }); expect(m.code).toBe(200); expect(m.body.extracted.corrected_by).toBe("test");
    const r = await send("PATCH", `/extractions/${id}`, { status: "rejected", note: "not ours" }); expect(r.code).toBe(200); expect(r.body.extraction.status).toBe("rejected");
    expect((await send("PATCH", `/extractions/${id}`, { status: "approved" })).code).toBe(409);
  });
  it("PATCH /actions/:id edits a draft or policy_failed intent by superseding it, re-running the policy checks", async () => {
    const bad = await send("POST", "/actions", { entity_id: ARJUN, kind: "bank_transfer", amount: 450000, payload: { note: "test" }, rationale: "Test edit — cap" }); expect(bad.body.status).toBe("policy_failed");
    const fixed = await send("PATCH", `/actions/${bad.body.id}`, { amount: 45000, payload: { instrument_id: PPFAS }, kind: "mf_purchase", rationale: "Test edit — fixed" }); expect(fixed.code).toBe(200);
    expect(fixed.body.supersedes).toBe(bad.body.id); expect(fixed.body.status).toBe("pending_approval"); expect(Number(fixed.body.amount)).toBe(45000);
    expect((await get(`/actions/${bad.body.id}`)).body.status).toBe("cancelled");
    expect((await send("PATCH", `/actions/${fixed.body.id}`, { amount: 1 })).code).toBe(409);   // pending_approval is no longer editable
    await send("POST", `/actions/${fixed.body.id}/cancel`, { note: "test" });
  });
  it("every OpenAPI path is implemented — nothing answers 501 any more", async () => {
    // Checked against the router, not by calling the endpoints: a blanket POST {} to every path would run real jobs (optimiser, deliveries, syncs) against the demo family.
    const spec = parse(readFileSync(new URL("../../../../api/openapi.yaml", import.meta.url), "utf8")); const missing: string[] = [];
    for (const [p, item] of Object.entries<any>(spec.paths)) for (const m of ["get", "post", "put", "patch", "delete"]) { if (!item[m]) continue; if (!app.hasRoute({ method: m.toUpperCase() as any, url: "/api/v1" + p.replace(/\{(\w+)\}/g, ":$1") })) missing.push(`${m.toUpperCase()} ${p}`); }
    expect(missing).toEqual([]);
    const r = await app.inject({ url: "/api/v1/not-in-the-contract", headers: h() }); expect(r.statusCode).toBe(404);   // the 501 stub plugin is gone: unknown paths are plain 404s
  });
});
