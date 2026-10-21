import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.STORAGE_DIR ??= mkdtempSync(join(tmpdir(), "fo-reports-api-"));
import { buildApp } from "../src/server.js";
import { withFamily, pool } from "../src/lib/db.js";
import { setSenders } from "../src/lib/notify.js";
import { extractPdfText, unzip, fmtInr } from "@fo/reports";
import { cronMatches, nextCron, catalogue } from "../src/lib/reports.js";

// Reports (PRD 3.9; FO-33, 103, 115, 146): catalogue, runs in every format, packs with versions, schedules, external viewers.
const FAMILY = "11111111-1111-1111-1111-111111111111", HUF = "33333333-0000-0000-0000-000000000002", HUF_ICICI = "89898989-0000-0000-0000-000000000002";
let app: ReturnType<typeof buildApp>; let owner = "", member = "", operator = "", viewer = "";
const h = (t = owner) => ({ authorization: `Bearer ${t}`, "x-family-id": FAMILY });
const get = async (url: string, t = owner) => { const r = await app.inject({ url: `/api/v1${url}`, headers: h(t) }); return { code: r.statusCode, body: String(r.headers["content-type"]).includes("json") ? r.json() : r.body, raw: r.rawPayload }; };
const send = async (method: "POST" | "PATCH" | "DELETE", url: string, payload: any = {}, t = owner) => { const r = await app.inject({ method, url: `/api/v1${url}`, headers: h(t), payload }); return { code: r.statusCode, body: r.statusCode === 204 ? null : String(r.headers["content-type"]).includes("json") ? r.json() : r.body }; };
const fetchUrl = async (url: string) => { const u = new URL(url, "http://x"); const r = await app.inject({ url: u.pathname + u.search }); return { code: r.statusCode, raw: r.rawPayload, type: String(r.headers["content-type"]) }; };
const login = async (email: string, password = "Prototype!2026") => (await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password } })).json().access_token;
const emails: { to: string; subject: string; text: string }[] = [];
let packId = "", scheduleId = "", extId = "", extUser = "";

beforeAll(async () => {
  app = buildApp(); await app.ready(); setSenders({ email: async (to, subject, text) => { emails.push({ to, subject, text }); return true; } });
  owner = await login("arjun@example.com"); member = await login("priya@example.com"); operator = await login("ops@example.com"); viewer = await login("ca@example.com");
  await cleanup();
});
async function cleanup() {
  await withFamily(FAMILY, async (c) => {
    await c.query("delete from report_jobs where family_id=$1 and created_at > now() - interval '1 day' and (requested_by is null or true)", [FAMILY]);
    await c.query("delete from report_pack_runs where family_id=$1 and pack_id in (select id from report_packs where family_id=$1 and name like 'Test %')", [FAMILY]); await c.query("delete from report_packs where family_id=$1 and name like 'Test %'", [FAMILY]);
    await c.query("delete from report_schedules where family_id=$1 and name like 'Test %'", [FAMILY]);
    await c.query("update report_schedules set last_document_id=null where family_id=$1", [FAMILY]); await c.query("update report_pack_runs set document_id=null where family_id=$1", [FAMILY]);
    await c.query("delete from documents where family_id=$1 and source='report'", [FAMILY]);
    await c.query("delete from notifications where family_id=$1 and payload->>'module'='reports'", [FAMILY]);
    const ex = (await c.query("select id, user_id from external_access where family_id=$1 and email='ca2@example.com'", [FAMILY])).rows;
    for (const x of ex) { await c.query("delete from audit_log where family_id=$1 and user_id=$2", [FAMILY, x.user_id]); await c.query("delete from external_access where id=$1", [x.id]); await c.query("delete from family_members where family_id=$1 and user_id=$2", [FAMILY, x.user_id]); }
    await c.query("update external_access set expires_on='2027-06-30', revoked_at=null where id='d3000000-0000-0000-0000-000000000001'");
  });
  await pool.query("delete from users where email='ca2@example.com'");
}
afterAll(async () => { await cleanup(); setSenders({}); await app.close(); rmSync(process.env.STORAGE_DIR!, { recursive: true, force: true }); });

describe("catalogue and runs (FO-33, FO-115, FO-146)", () => {
  it("lists the catalogue with formats and parameters; the external CA sees only the reports in scope", async () => {
    const all = (await get("/reports")).body; expect(all.length).toBeGreaterThanOrEqual(28); const cg = all.find((r: any) => r.code === "capital_gains"); expect(cg.formats).toEqual(expect.arrayContaining(["xlsx", "pdf"])); expect(cg.params.map((p: any) => p.name)).toEqual(["entity_id", "fy"]);
    const mine = (await get("/reports", viewer)).body; expect(mine.map((r: any) => r.code).sort()).toEqual(["books_balance_sheet", "books_bank_recon", "books_capital_account", "books_cash_flow", "books_itr_mapping", "books_ledger", "books_profit_loss", "books_trial_balance", "capital_gains", "rent_gst", "tax_computation", "tds_recon"]);
  });
  it("Schedule CG as XLSX: a stored workbook whose totals equal the capital-gains API", async () => {
    const fy = (await get("/capital-gains?fy=2026-27")).body; const run = await send("POST", "/reports/capital_gains/run", { format: "xlsx", fy: "2026-27" }); expect(run.code, JSON.stringify(run.body)).toBe(202);
    expect(run.body).toMatchObject({ report_code: "capital_gains", format: "xlsx", status: "done" }); expect(run.body.url).toContain("/files/"); expect(run.body.name).toMatch(/^capital_gains-FY_2026_27-.*\.xlsx$/);
    const dl = await fetchUrl(run.body.url); expect(dl.code).toBe(200); const files = unzip(dl.raw); expect(files["xl/workbook.xml"].toString()).toContain('name="Schedule CG"'); const sheet = files["xl/worksheets/sheet2.xml"].toString();
    const stcg = fy.summary.reduce((s: number, r: any) => s + Number(r.stcg), 0); expect(sheet).toContain(`<v>${stcg}</v>`);
    const job = (await get(`/reports/jobs/${run.body.id}`)).body; expect(job.status).toBe("done"); expect(job.document_id).toBe(run.body.document_id);
    const doc = (await get(`/documents/${run.body.document_id}`)).body; expect(doc).toMatchObject({ source: "report", report_code: "capital_gains", folder_name: "Reports", doc_type: "report" });
    expect((await get("/reports/jobs?code=capital_gains")).body.some((j: any) => j.id === run.body.id)).toBe(true);
  });
  it("the net worth statement as PDF carries the family watermark, the page count and the dashboard's figure", async () => {
    const d = (await get("/dashboard")).body; const run = await send("POST", "/reports/net_worth/run", { format: "pdf" }); expect(run.code, JSON.stringify(run.body)).toBe(202);
    const pdf = (await fetchUrl(run.body.url)).raw; const text = extractPdfText(pdf); expect(text).toContain("Consolidated net worth statement"); expect(text).toContain("Mehta Family"); expect(text).toMatch(/Page 1 of \d+/); expect(text).toContain(fmtInr(d.net_worth)); expect(text).toContain("Assets by class");
    const html = await app.inject({ method: "POST", url: "/api/v1/reports/net_worth/preview", headers: h(), payload: {} }); expect(html.statusCode).toBe(200); expect(html.body).toContain("<h1>Consolidated net worth statement</h1>");
    expect((await send("POST", "/reports/net_worth/run", { format: "xml" })).code).toBe(422); expect((await send("POST", "/reports/nope/run", {})).code).toBe(404); expect((await send("POST", "/reports/ips_document/run", { format: "xlsx" })).code).toBe(422);
  });
  it("every report in the catalogue renders as HTML on the seeded family", async () => {
    const accounts = (await get(`/gl/accounts?entity_id=${HUF}`)).body; const acct = (Array.isArray(accounts) ? accounts : accounts.items)[0];
    const extra: Record<string, any> = { books_ledger: { entity_id: HUF, account_id: acct.id }, books_bank_recon: { bank_account_id: HUF_ICICI }, performance: { scope_type: "family", period: "1y" } };
    const failures: string[] = []; const skipped: string[] = [];
    for (const r of catalogue()) { if (r.code === "investment_proposal") continue; const res = await send("POST", `/reports/${r.code}/run`, { format: "html", ...(extra[r.code] ?? {}) }); if (res.code === 404 && r.code === "research_digest") { skipped.push(r.code); continue; } if (res.code !== 202) failures.push(`${r.code}: ${res.code} ${JSON.stringify(res.body).slice(0, 160)}`); else { const body = (await fetchUrl(res.body.url)).raw.toString("utf8"); if (!body.includes(`<h1>`)) failures.push(`${r.code}: no title`); } }
    expect(failures, failures.join("\n")).toEqual([]);
    const jobs = (await get("/reports/jobs?limit=100")).body; expect(jobs.filter((j: any) => j.status === "done").length).toBeGreaterThanOrEqual(catalogue().length - 2 - skipped.length);
    expect((await get("/reports/jobs")).body.every((j: any) => j.status !== "failed")).toBe(true);
  });
  it("viewer and role rules: the CA can run a scoped report (audited) but not another; operators cannot manage packs or schedules", async () => {
    const ok = await send("POST", "/reports/capital_gains/run", { format: "pdf", entity_id: HUF }, viewer); expect(ok.code, JSON.stringify(ok.body)).toBe(202);
    expect((await send("POST", "/reports/net_worth/run", { format: "pdf" }, viewer)).code).toBe(403);
    const views = await withFamily(FAMILY, (c) => c.query("select count(*) n from audit_log where family_id=$1 and action='view' and table_name='report_jobs' and row_id=$2", [FAMILY, ok.body.id])); expect(Number(views.rows[0].n)).toBe(1);
    expect((await get("/external-access")).body.find((x: any) => x.id === "d3000000-0000-0000-0000-000000000001").views).toBeGreaterThanOrEqual(1);
    expect((await send("POST", "/report-packs", { name: "Test nope", audience: "ca", sections: [{ report_code: "net_worth" }] }, operator)).code).toBe(403);
    expect((await send("POST", "/report-schedules", { report_code: "net_worth", cron: "0 8 1 * *" }, operator)).code).toBe(403);
  });
});

describe("packs, versions and corrections (FO-103)", () => {
  it("generates a CA pack as one PDF with cover and contents; a corrected v2 supersedes v1 and both are retained", async () => {
    const pk = await send("POST", "/report-packs", { name: "Test CA pack Q2", audience: "ca", sections: [{ report_code: "capital_gains", params: { fy: "2026-27" } }, { report_code: "rent_gst", params: { from: "2026-07-01", to: "2026-09-30" } }, { report_code: "books_trial_balance", params: { entity_id: HUF } }], recipients: ["ca@example.com"] }, member); expect(pk.code, JSON.stringify(pk.body)).toBe(201); packId = pk.body.id; expect(pk.body.runs).toEqual([]);
    emails.length = 0; const v1 = await send("POST", `/report-packs/${packId}/run`, { period_label: "Jul–Sep 2026" }, operator); expect(v1.code, JSON.stringify(v1.body)).toBe(202);
    expect(v1.body).toMatchObject({ version: 1, period_label: "Jul–Sep 2026", status: "done", failures: [], report_codes: ["capital_gains", "rent_gst", "books_trial_balance"] }); expect(v1.body.page_count).toBeGreaterThanOrEqual(4); expect(v1.body.delivered_to).toEqual(["ca@example.com"]); expect(emails[0].subject).toContain("Test CA pack Q2 v1");
    const pdf = (await fetchUrl(v1.body.url)).raw; const text = extractPdfText(pdf); expect(text).toContain("Contents"); expect(text).toContain("Test CA pack Q2"); expect(text).toContain("Capital gains"); expect(text).toContain("Trial balance"); expect(text).toContain(`Page ${v1.body.page_count} of ${v1.body.page_count}`);
    expect((await send("POST", `/report-packs/${packId}/run`, { supersedes_run_id: v1.body.id })).code).toBe(422);   // a correction needs its note
    const v2 = await send("POST", `/report-packs/${packId}/run`, { period_label: "Jul–Sep 2026", supersedes_run_id: v1.body.id, correction_note: "TDS on the Kovai rent restated after the tenant's revised certificate" }); expect(v2.code).toBe(202); expect(v2.body).toMatchObject({ version: 2, supersedes_run_id: v1.body.id, correction_note: expect.stringContaining("TDS") });
    expect(extractPdfText((await fetchUrl(v2.body.url)).raw)).toContain("Correction: TDS on the Kovai rent");
    const runs = (await get(`/report-packs/${packId}/runs`)).body; expect(runs.map((r: any) => r.version)).toEqual([2, 1]); expect(runs[1].superseded_by).toMatchObject({ version: 2 }); expect(runs[1].url).toBeTruthy();   // v1 retained
    const notes = (await get("/notifications", owner)).body; expect((notes.items ?? notes).some((n: any) => /Test CA pack Q2 v2 ready/.test(n.title))).toBe(true);
    const list = (await get("/report-packs?audience=ca")).body; expect(list.some((p: any) => p.id === packId && p.runs.length === 2)).toBe(true); expect(list.some((p: any) => p.name === "CA quarterly pack")).toBe(true);   // the seeded pack
    const patched = await send("PATCH", `/report-packs/${packId}`, { sections: [{ report_code: "capital_gains" }], cron: "0 9 5 1,4,7,10 *" }, member); expect(patched.body.sections).toHaveLength(1);
  });
  it("a pack section that cannot be built is reported, not silently dropped", async () => {
    const pk = await send("POST", "/report-packs", { name: "Test broken", audience: "principal", sections: [{ report_code: "net_worth" }, { report_code: "investment_proposal", params: { proposal_id: "00000000-0000-0000-0000-000000000001" } }] }); const r = await send("POST", `/report-packs/${pk.body.id}/run`, { deliver: false });
    expect(r.code).toBe(202); expect(r.body.failures).toHaveLength(1); expect(r.body.failures[0]).toMatch(/investment_proposal/); expect(extractPdfText((await fetchUrl(r.body.url)).raw)).toContain("could not be generated");
    expect((await send("DELETE", `/report-packs/${pk.body.id}`)).code).toBe(204); expect((await get(`/report-packs/${pk.body.id}`)).code).toBe(404);
    expect((await send("POST", "/report-packs", { name: "Test bad", audience: "ca", sections: [{ report_code: "nope" }] })).code).toBe(422);
  });
});

describe("schedules", () => {
  it("cron runs on the IST clock", () => {
    expect(cronMatches("0 8 1 * *", new Date("2026-10-01T02:30:00Z"))).toBe(true); expect(cronMatches("0 8 1 * *", new Date("2026-10-01T08:00:00Z"))).toBe(false); expect(cronMatches("*/15 9-17 * * 1-5", new Date("2026-09-14T04:15:00Z"))).toBe(true); expect(cronMatches("*/15 9-17 * * 1-5", new Date("2026-09-13T04:15:00Z"))).toBe(false);
    expect(nextCron("0 9 5 1,4,7,10 *", new Date("2026-09-12T10:00:00Z"))?.toISOString()).toBe("2026-10-05T03:30:00.000Z"); expect(nextCron("0 0 31 2 *")).toBeNull();
  });
  it("creates a schedule with its next run, runs it on demand with e-mail delivery and an inbox note, and the worker path runs it when due", async () => {
    expect((await send("POST", "/report-schedules", { report_code: "net_worth", cron: "nope" })).code).toBe(422);
    const s = await send("POST", "/report-schedules", { name: "Test monthly net worth", report_code: "net_worth", cron: "0 8 1 * *", recipients: ["priya@example.com"], format: "pdf" }, member); expect(s.code, JSON.stringify(s.body)).toBe(201); scheduleId = s.body.id;
    expect(new Date(s.body.next_run_at).getUTCHours()).toBe(2); expect(new Date(s.body.next_run_at).getUTCMinutes()).toBe(30); expect(new Date(s.body.next_run_at).getUTCDate()).toBe(1);
    emails.length = 0; const r = await send("POST", `/report-schedules/${scheduleId}/run`, {}, member); expect(r.code).toBe(202); expect(r.body.job_id).toBeTruthy(); expect(r.body.delivered).toEqual(["priya@example.com"]); expect(emails[0]).toMatchObject({ to: "priya@example.com" }); expect(emails[0].text).toContain("/files/");
    const after = (await get("/report-schedules")).body.find((x: any) => x.id === scheduleId); expect(after.last_document_id).toBe(r.body.document_id); expect(after.last_error).toBeNull();
    expect(((await get("/notifications", member)).body.items ?? (await get("/notifications", member)).body).some((n: any) => n.title === "Consolidated net worth statement ready")).toBe(true);
    // due-run path: a schedule whose next_run_at is in the past runs once and rolls forward
    await withFamily(FAMILY, (c) => c.query("update report_schedules set next_run_at=now() - interval '1 minute' where id=$1", [scheduleId])); const due = await send("POST", "/report-schedules/run-due", {}); expect(due.code).toBe(200); expect(due.body.some((x: any) => x.id === scheduleId && x.job_id)).toBe(true);
    const rolled = (await get("/report-schedules")).body.find((x: any) => x.id === scheduleId); expect(new Date(rolled.next_run_at).getTime()).toBeGreaterThan(Date.now());
    expect((await send("PATCH", `/report-schedules/${scheduleId}`, { active: false }, member)).body.active).toBe(false); expect((await send("POST", "/report-schedules/run-due", {})).body.some((x: any) => x.id === scheduleId)).toBe(false);
    expect((await get("/report-schedules")).body.some((x: any) => x.name === "Monthly net worth to the family")).toBe(true);   // seeded
  });
});

describe("external viewers (FO-103)", () => {
  it("an invited banker sees only the scoped reports and modules, every view is audited, and revocation ends it", async () => {
    const inv = await send("POST", "/external-access", { email: "ca2@example.com", label: "Banker – Kotak wealth", scope: { entities: [HUF], modules: ["reports", "documents"], reports: ["capital_gains", "net_worth"] }, expires_on: "2027-03-31" }); expect(inv.code, JSON.stringify(inv.body)).toBe(201); extId = inv.body.id; extUser = inv.body.user_id;
    expect(inv.body.invite_token).toBeTruthy(); expect(inv.body.status).toBe("invited"); expect((await get("/external-access")).body.find((x: any) => x.id === extId).invite_token).toBeUndefined();
    expect((await send("POST", "/external-access", { email: "priya@example.com", label: "x", expires_on: "2027-01-01" })).code).toBe(409);   // full members are not externals
    expect((await app.inject({ method: "POST", url: "/api/v1/external-access/accept", payload: { email: "ca2@example.com", token: "wrong-token-value", password: "Str0ngPassw0rd!" } })).statusCode).toBe(403);
    const acc = await app.inject({ method: "POST", url: "/api/v1/external-access/accept", payload: { email: "ca2@example.com", token: inv.body.invite_token, password: "Str0ngPassw0rd!" } }); expect(acc.statusCode).toBe(200);
    const banker = await login("ca2@example.com", "Str0ngPassw0rd!"); expect(banker).toBeTruthy();
    expect((await get("/reports", banker)).body.map((r: any) => r.code).sort()).toEqual(["capital_gains", "net_worth"]);
    expect((await get("/holdings", banker)).code).toBe(403); expect((await get("/gl/books", banker)).code).toBe(403); expect((await get("/documents", banker)).code).toBe(200); expect((await get("/entities", banker)).code).toBe(200);
    const run = await send("POST", "/reports/capital_gains/run", { format: "pdf", fy: "2026-27" }, banker); expect(run.code, JSON.stringify(run.body)).toBe(202); expect((await send("POST", "/reports/rent_gst/run", {}, banker)).code).toBe(403);
    expect(extractPdfText((await fetchUrl(run.body.url)).raw)).not.toContain("Arjun Mehta");   // entity scope: HUF only
    const act = (await get(`/external-access/${extId}/activity`)).body; expect(act.some((a: any) => a.action === "view" && a.table_name === "report_jobs")).toBe(true); expect((await get("/external-access")).body.find((x: any) => x.id === extId)).toMatchObject({ status: "active", views: 1 });
    expect((await send("DELETE", `/external-access/${extId}`, {}, member)).code).toBe(403); expect((await send("DELETE", `/external-access/${extId}`)).code).toBe(204);
    expect((await get("/reports", banker)).code).toBe(403);
    await withFamily(FAMILY, (c) => c.query("update external_access set expires_on='2026-01-01' where id='d3000000-0000-0000-0000-000000000001'")); const exp = await get("/reports", viewer); expect(exp.code).toBe(403); expect(exp.body.title).toMatch(/expired/);
    await withFamily(FAMILY, (c) => c.query("update external_access set expires_on='2027-06-30' where id='d3000000-0000-0000-0000-000000000001'")); expect((await get("/reports", viewer)).code).toBe(200);
  });
});
