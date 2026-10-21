import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.STORAGE_DIR ??= mkdtempSync(join(tmpdir(), "fo-itr-ocr-"));
import { buildApp } from "../src/server.js";
import { pool, withFamily } from "../src/lib/db.js";

// Milestone 15 residue: scanned documents through an OCR command (FO-28), Section 112A grandfathering from a 31 Jan 2018 FMV per ISIN
// (FO-34), and the ITR schedules HP / OS / AL / FA built from the books (FO-70..81). Everything cleans up; lots and gains are snapshot-based.
const FAMILY = "11111111-1111-1111-1111-111111111111", ARJUN = "33333333-0000-0000-0000-000000000001", HUF = "33333333-0000-0000-0000-000000000002", TCS = "44444444-0000-0000-0000-000000000002";
let app: ReturnType<typeof buildApp>; let owner = "", viewer = ""; const before: Record<string, string[]> = {}; let ocrDir = "";
const h = (t = owner) => ({ authorization: `Bearer ${t}`, "x-family-id": FAMILY });
const get = async (url: string, t = owner) => { const r = await app.inject({ url: `/api/v1${url}`, headers: h(t) }); return { code: r.statusCode, body: r.json() }; };
const send = async (method: "POST" | "PATCH" | "PUT" | "DELETE", url: string, payload: any = {}, t = owner) => { const r = await app.inject({ method, url: `/api/v1${url}`, headers: h(t), payload }); return { code: r.statusCode, body: r.statusCode === 204 ? null : r.json() }; };
const run = <T>(fn: (c: any) => Promise<T>) => withFamily(FAMILY, fn);
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082", "hex");   // 1×1 PNG
const upload = async (name: string, mime: string, data: Buffer) => { const b = "----fo" + Math.random().toString(16).slice(2); const body = Buffer.concat([Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: ${mime}\r\n\r\n`), data, Buffer.from(`\r\n--${b}--\r\n`)]); const r = await app.inject({ method: "POST", url: "/api/v1/documents", headers: { ...h(), "content-type": `multipart/form-data; boundary=${b}` }, payload: body }); return { code: r.statusCode, body: r.json() }; };

beforeAll(async () => {
  app = buildApp(); await app.ready();
  const login = async (email: string) => (await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password: "Prototype!2026" } })).json().access_token;
  owner = await login("arjun@example.com"); viewer = await login("ca@example.com");
  ocrDir = mkdtempSync(join(tmpdir(), "fo-fake-ocr-")); writeFileSync(join(ocrDir, "ocr.sh"), "#!/bin/sh\nprintf 'CAMS CONSOLIDATED ACCOUNT STATEMENT (scanned)\\nFolio 9182/12  Parag Parikh Flexi Cap Fund  Units 382.100\\nPAN ABCDE1234H\\n'\n"); chmodSync(join(ocrDir, "ocr.sh"), 0o755);
  await run(async (c) => { for (const [k, sql] of Object.entries({ rg: "select id from realized_gains where family_id=$1 and entity_id=$2 and instrument_id=$3", h: "select id from holdings where family_id=$1 and entity_id=$2 and instrument_id=$3", t: "select id from investment_txns where family_id=$1 and entity_id=$2 and instrument_id=$3" })) before[k] = (await c.query(sql, [FAMILY, ARJUN, TCS])).rows.map((r) => r.id); });
  await cleanup();
});
async function cleanup() {
  delete process.env.OCR_COMMAND;
  await run(async (c) => {
    await c.query("delete from realized_gains where family_id=$1 and entity_id=$2 and instrument_id=$3 and id::text <> all($4::text[])", [FAMILY, ARJUN, TCS, before.rg ?? []]);
    await c.query("delete from lots where family_id=$1 and holding_id in (select id from holdings where family_id=$1 and entity_id=$2 and instrument_id=$3 and id::text <> all($4::text[]))", [FAMILY, ARJUN, TCS, before.h ?? []]);
    await c.query("delete from holdings where family_id=$1 and entity_id=$2 and instrument_id=$3 and id::text <> all($4::text[])", [FAMILY, ARJUN, TCS, before.h ?? []]);
    await c.query("delete from investment_txns where family_id=$1 and entity_id=$2 and instrument_id=$3 and id::text <> all($4::text[])", [FAMILY, ARJUN, TCS, before.t ?? []]);
    await c.query("update instruments set meta = meta - 'fmv_31jan2018' where isin in ('INE467B01029','INE040A01034','INE018A01030','INE155A01022','INF879O01027','INF846K01K35')");
    const docs = (await c.query("select id from documents where family_id=$1 and name like 'itr-test-%'", [FAMILY])).rows.map((r) => r.id); if (docs.length) { await c.query("delete from document_extractions where document_id = any($1::uuid[])", [docs]); await c.query("delete from documents where id = any($1::uuid[])", [docs]); }
    await c.query("delete from report_jobs where family_id=$1 and report_code like 'itr_schedule_%'", [FAMILY]);
  });
}
afterAll(async () => { await cleanup(); await app.close(); await pool.end(); rmSync(process.env.STORAGE_DIR!, { recursive: true, force: true }); rmSync(ocrDir, { recursive: true, force: true }); });

describe("scanned documents (FO-28)", () => {
  it("without OCR an image is stored and flagged needs-ocr; extraction says so; with OCR_COMMAND the text is read at upload and on retry", async () => {
    delete process.env.OCR_COMMAND;
    const d1 = await upload("itr-test-scan-1.png", "image/png", PNG); expect(d1.code).toBe(201); expect(d1.body.tags).toContain("needs-ocr"); expect(d1.body.text ?? null).toBeNull();
    const ex = await send("POST", `/documents/${d1.body.id}/extract`, {}); expect(ex.code).toBe(422); expect(ex.body.code ?? ex.body.extra?.code).toBe("needs_ocr");
    process.env.OCR_COMMAND = `${join(ocrDir, "ocr.sh")} {in}`;
    const ex2 = await send("POST", `/documents/${d1.body.id}/extract`, {}); expect([200, 201, 202]).toContain(ex2.code); const doc = (await get(`/documents/${d1.body.id}`)).body; expect(doc.tags).toContain("ocr"); expect(doc.tags).not.toContain("needs-ocr"); expect((await get(`/documents/${d1.body.id}/text`)).body.text).toMatch(/CONSOLIDATED ACCOUNT STATEMENT/);
    const d2 = await upload("itr-test-scan-2.png", "image/png", Buffer.concat([PNG, Buffer.from([1])])); expect(d2.code).toBe(201); expect(d2.body.tags).toContain("ocr"); expect((await get(`/documents/${d2.body.id}/text`)).body.text).toMatch(/Parag Parikh/);
    process.env.OCR_COMMAND = "/nonexistent/ocr-binary"; const d3 = await upload("itr-test-scan-3.png", "image/png", Buffer.concat([PNG, Buffer.from([2])])); expect(d3.body.tags).toContain("needs-ocr");
    delete process.env.OCR_COMMAND;
  });
});

describe("grandfathering FMV per ISIN (FO-34)", () => {
  it("loads FMVs, a sale of a pre-Feb-2018 equity lot steps the cost up to the lower of FMV and sale price, Schedule CG marks it", async () => {
    expect((await send("POST", "/instruments/fmv", { csv: "isin,fmv\nINE467B01029,3105.50" }, viewer)).code).toBe(403);
    const load = await send("POST", "/instruments/fmv", { csv: "isin,fmv,name\nINE467B01029,3105.50,TCS\nINE000000000,10,Unknown" }); expect(load.code).toBe(200); expect(load.body).toMatchObject({ rows: 2, matched: 1, unknown: ["INE000000000"] });
    expect(Number((await run((c) => c.query("select meta->>'fmv_31jan2018' v from instruments where id=$1", [TCS]))).rows[0].v)).toBe(3105.5);
    const buy = await send("POST", "/investment-txns", { entity_id: ARJUN, instrument_id: TCS, type: "buy", txn_date: "2017-06-01", quantity: 5, price: 2400, amount: 12000 }); expect(buy.code, JSON.stringify(buy.body)).toBe(201);
    const reload = await send("POST", "/instruments/fmv", { rows: [{ isin: "INE467B01029", fmv: 3105.5 }] }); expect(reload.body.lots_updated).toBeGreaterThanOrEqual(1);   // the 2017 lot now carries the FMV
    const sell = await send("POST", "/investment-txns", { entity_id: ARJUN, instrument_id: TCS, type: "sell", txn_date: "2026-09-01", quantity: 5, price: 4000, amount: 20000 }); expect(sell.code).toBe(201);
    const g = (await run((c) => c.query("select cost, proceeds, gain, term, grandfathered, fmv_31jan2018 from realized_gains where family_id=$1 and entity_id=$2 and instrument_id=$3 and id::text <> all($4::text[]) order by sell_date desc limit 1", [FAMILY, ARJUN, TCS, before.rg]))).rows[0];
    expect(g.grandfathered).toBe(true); expect(Number(g.cost)).toBe(15527.5); expect(Number(g.gain)).toBe(4472.5); expect(g.term).toBe("long"); expect(Number(g.fmv_31jan2018)).toBe(3105.5);
    const cg = (await get("/capital-gains?fy=2026-27")).body; const line = cg.lots.find((l: any) => l.entity_name === "Arjun Mehta" && /Tata Consultancy/.test(l.instrument) && Number(l.cost) === 15527.5); expect(line).toBeTruthy();
    // a lot bought after 31 Jan 2018 is untouched
    const buy2 = await send("POST", "/investment-txns", { entity_id: ARJUN, instrument_id: TCS, type: "buy", txn_date: "2020-01-10", quantity: 2, price: 2000, amount: 4000 }); expect(buy2.code).toBe(201);
    const sell2 = await send("POST", "/investment-txns", { entity_id: ARJUN, instrument_id: TCS, type: "sell", txn_date: "2026-09-02", quantity: 2, price: 4000, amount: 8000 }); expect(sell2.code).toBe(201);
    const g2 = (await run((c) => c.query("select cost, gain, grandfathered from realized_gains where family_id=$1 and entity_id=$2 and instrument_id=$3 and sell_date='2026-09-02'", [FAMILY, ARJUN, TCS]))).rows[0]; expect(g2.grandfathered).toBe(false); expect(Number(g2.cost)).toBe(4000);
  });
});

describe("ITR schedules (FO-70..81)", () => {
  it("HP, OS, AL and FA render from the books for the FY, per entity and for the family", async () => {
    const codes = ["itr_schedule_hp", "itr_schedule_os", "itr_schedule_al", "itr_schedule_fa"]; const cat = (await get("/reports")).body; const list = Array.isArray(cat) ? cat : cat.reports ?? cat.items;
    for (const code of codes) expect(list.some((r: any) => r.code === code)).toBe(true);
    for (const code of codes) { const r = await app.inject({ method: "POST", url: `/api/v1/reports/${code}/preview`, headers: h(), payload: { params: { fy: "2026-27" } } }); expect(r.statusCode, `${code}: ${r.body.slice(0, 200)}`).toBe(200); expect(r.body).toMatch(/Schedule (HP|OS|AL|FA)/); }
    const hp = await app.inject({ method: "POST", url: "/api/v1/reports/itr_schedule_hp/preview", headers: h(), payload: { params: { fy: "2026-27", entity_id: HUF } } }); expect(hp.body).toMatch(/Race Course Road|let out/); expect(hp.body).toMatch(/Mehta HUF/);
    const al = await app.inject({ method: "POST", url: "/api/v1/reports/itr_schedule_al/preview", headers: h(), payload: { params: { fy: "2026-27", entity_id: ARJUN } } }); expect(al.body).toMatch(/Immovable property|Financial assets/); expect(al.body).toMatch(/Hyundai Creta/);
    const fa = await app.inject({ method: "POST", url: "/api/v1/reports/itr_schedule_fa/preview", headers: h(), payload: { params: { fy: "2026-27", entity_id: ARJUN } } }); expect(fa.body).toMatch(/LRS remittances/); expect(fa.body).toMatch(/25,000|2,080,000|20\.80/);
    const runr = await app.inject({ method: "POST", url: "/api/v1/reports/itr_schedule_os/run", headers: h(), payload: { params: { fy: "2026-27" }, format: "xlsx" } }); expect([200, 201, 202]).toContain(runr.statusCode); expect(runr.json().document_id ?? runr.json().document?.id).toBeTruthy();
  });
});
