import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.STORAGE_DIR ??= mkdtempSync(join(tmpdir(), "fo-exports-mcp-"));
import { buildApp } from "../src/server.js";
import { pool, withFamily } from "../src/lib/db.js";
import { createMcp, TOOLS, MCP_PROTOCOL } from "../src/lib/mcp.js";

// FO-104 v1.1: scheduled exports (cron → export job → document + export.ready) and the MCP server (JSON-RPC handler over the REST API with an
// API key: tools filtered by scope, calls answered with the API's JSON, writes limited to tasks / exports / draft intents).
const FAMILY = "11111111-1111-1111-1111-111111111111", ARJUN = "33333333-0000-0000-0000-000000000001";
let app: ReturnType<typeof buildApp>; let owner = "", member = "", viewer = "";
const h = (t = owner) => ({ authorization: `Bearer ${t}`, "x-family-id": FAMILY });
const get = async (url: string, t = owner) => { const r = await app.inject({ url: `/api/v1${url}`, headers: h(t) }); return { code: r.statusCode, body: r.json() }; };
const send = async (method: "POST" | "PATCH" | "PUT" | "DELETE", url: string, payload: any = {}, t = owner) => { const r = await app.inject({ method, url: `/api/v1${url}`, headers: h(t), payload }); return { code: r.statusCode, body: r.statusCode === 204 ? null : r.json() }; };
const run = <T>(fn: (c: any) => Promise<T>) => withFamily(FAMILY, fn);

beforeAll(async () => {
  app = buildApp(); await app.ready();
  const login = async (email: string) => (await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password: "Prototype!2026" } })).json().access_token;
  owner = await login("arjun@example.com"); member = await login("priya@example.com"); viewer = await login("ca@example.com"); await cleanup();
});
async function cleanup() {
  await run(async (c) => {
    await c.query("delete from export_schedules where family_id=$1 and name like 'Test %'", [FAMILY]);
    const jobs = (await c.query("delete from export_jobs where family_id=$1 and (requested_by in (select id from users where email in ('arjun@example.com','priya@example.com')) and created_at > now() - interval '1 hour') returning document_id", [FAMILY])).rows.map((r) => r.document_id).filter(Boolean); if (jobs.length) await c.query("delete from documents where id = any($1::uuid[])", [jobs]);
    await c.query("delete from webhook_deliveries where family_id=$1 and webhook_id in (select id from webhooks where family_id=$1 and label like 'Test %')", [FAMILY]); await c.query("delete from webhooks where family_id=$1 and label like 'Test %'", [FAMILY]);
    await c.query("delete from api_keys where family_id=$1 and label like 'Test MCP%'", [FAMILY]); await c.query("delete from tasks where family_id=$1 and title like 'Test MCP%'", [FAMILY]); await c.query("delete from action_intents where family_id=$1 and rationale like 'Test MCP%'", [FAMILY]);
    await c.query("delete from notifications where family_id=$1 and title like 'Test MCP%'", [FAMILY]);
  });
}
afterAll(async () => { await cleanup(); await app.close(); await pool.end(); rmSync(process.env.STORAGE_DIR!, { recursive: true, force: true }); });

describe("scheduled exports", () => {
  it("creates a schedule with a valid cron, runs it into an export job + document, emits export.ready, and patches / deletes", async () => {
    expect((await send("POST", "/export-schedules", { dataset: "holdings", cron: "0 6 * * 1" }, viewer)).code).toBe(403);
    expect((await send("POST", "/export-schedules", { dataset: "nope", cron: "0 6 * * 1" })).code).toBe(422); expect((await send("POST", "/export-schedules", { dataset: "holdings", cron: "every monday" })).code).toBe(422);
    const wh = await send("POST", "/webhooks", { url: "https://example.invalid/hook", events: ["export.ready"], label: "Test export hook" }); expect(wh.code).toBe(201);
    const s = await send("POST", "/export-schedules", { name: "Test weekly holdings", dataset: "holdings", format: "csv", cron: "0 6 * * 1", filters: { entity_id: ARJUN } }); expect(s.code).toBe(201); expect(s.body).toMatchObject({ name: "Test weekly holdings", dataset: "holdings", format: "csv", active: true, webhook: true }); expect(s.body.next_run_at).toBeTruthy();
    expect((await get("/export-schedules")).body.some((x: any) => x.id === s.body.id)).toBe(true);
    const ran = await send("POST", `/export-schedules/${s.body.id}/run`); expect(ran.code).toBe(202); expect(ran.body.export_id).toBeTruthy(); expect(ran.body.rows).toBeGreaterThan(0);
    const job = (await get(`/export/${ran.body.export_id}`)).body; expect(job).toMatchObject({ dataset: "holdings", format: "csv", status: "done" }); expect(job.url).toMatch(/\/api\/v1\/(files|documents)\//);
    expect((await run((c) => c.query("select schedule_id from export_jobs where id=$1", [ran.body.export_id]))).rows[0].schedule_id).toBe(s.body.id);
    const after = (await get("/export-schedules")).body.find((x: any) => x.id === s.body.id); expect(after.last_export_id).toBe(ran.body.export_id); expect(after.last_error).toBeNull(); expect(new Date(after.next_run_at).getTime()).toBeGreaterThan(Date.now());
    const deliveries = (await get(`/webhooks/${wh.body.id}/deliveries`)).body; const d = (Array.isArray(deliveries) ? deliveries : deliveries.items).find((x: any) => x.event === "export.ready" && (x.payload?.export_id ?? x.payload?.data?.export_id) === ran.body.export_id); expect(d).toBeTruthy();
    // due-run honours next_run_at: nothing is due right after a run; forcing a far-future clock runs it again
    expect((await send("POST", "/export-schedules/run-due", {})).body.filter((x: any) => x.id === s.body.id)).toHaveLength(0);
    const later = await send("POST", "/export-schedules/run-due", { now: new Date(Date.now() + 8 * 86400000).toISOString() }); expect(later.body.some((x: any) => x.id === s.body.id && x.export_id)).toBe(true);
    expect((await send("PATCH", `/export-schedules/${s.body.id}`, { active: false, cron: "30 5 1 * *" })).body).toMatchObject({ active: false, cron: "30 5 1 * *" });
    expect((await send("POST", "/export-schedules/run-due", { now: new Date(Date.now() + 40 * 86400000).toISOString() })).body.filter((x: any) => x.id === s.body.id)).toHaveLength(0);   // inactive
    expect((await send("DELETE", `/export-schedules/${s.body.id}`)).code).toBe(204);
  });
});

describe("MCP server", () => {
  const rpc = (handle: (m: any) => Promise<any>, id: number, method: string, params?: any) => handle({ jsonrpc: "2.0", id, method, params });
  it("initialize / tools/list filtered by the key's scopes / tools/call answers with the API's JSON; writes need write scopes", async () => {
    const key = await send("POST", "/api-keys", { label: "Test MCP read", scopes: ["read:investments", "read:goals", "read:tasks", "read:export", "read:dashboard"] }); expect(key.code).toBe(201); const secret = key.body.secret;
    const call = async (method: string, path: string, body?: unknown) => { const r = await app.inject({ method: method as any, url: `/api/v1${path}`, headers: { authorization: `Bearer ${secret}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, payload: body === undefined ? undefined : JSON.stringify(body) }); let j: any = r.body; try { j = r.json(); } catch { /* text */ } return { status: r.statusCode, body: j }; };
    const handle = createMcp(call);
    const init = await rpc(handle, 1, "initialize", { protocolVersion: MCP_PROTOCOL, capabilities: {}, clientInfo: { name: "test", version: "0" } }); expect(init.result.protocolVersion).toBe(MCP_PROTOCOL); expect(init.result.serverInfo.name).toBe("wealthprism"); expect(init.result.capabilities.tools).toBeTruthy();
    expect((await rpc(handle, 2, "initialize", { protocolVersion: "2024-11-05" })).result.protocolVersion).toBe("2024-11-05");
    expect(await handle({ jsonrpc: "2.0", method: "notifications/initialized" })).toBeNull(); expect((await rpc(handle, 3, "ping")).result).toEqual({});
    const list = (await rpc(handle, 4, "tools/list")).result.tools; const names = list.map((t: any) => t.name);
    expect(names).toEqual(expect.arrayContaining(["family_dashboard", "list_holdings", "goals", "open_tasks", "list_datasets"])); expect(names).not.toContain("net_worth"); expect(names).not.toContain("run_export"); expect(names).not.toContain("propose_intent");
    for (const t of list) { expect(t.inputSchema.type).toBe("object"); expect(t.description.length).toBeGreaterThan(20); }
    const hold = await rpc(handle, 5, "tools/call", { name: "list_holdings", arguments: { entity_id: ARJUN } }); expect(hold.result.isError).toBeUndefined(); const parsed = JSON.parse(hold.result.content[0].text); const items = Array.isArray(parsed) ? parsed : parsed.items ?? parsed; expect(items.length).toBeGreaterThan(0);
    expect((await rpc(handle, 6, "tools/call", { name: "capital_gains", arguments: {} })).result).toMatchObject({ isError: true });   // fy required
    expect((await rpc(handle, 7, "tools/call", { name: "run_export", arguments: { dataset: "holdings" } })).result).toMatchObject({ isError: true });   // no write:export
    expect((await rpc(handle, 8, "tools/call", { name: "nope" })).error.code).toBe(-32602); expect((await rpc(handle, 9, "unknown/method")).error.code).toBe(-32601); expect((await handle({ foo: 1 })).error.code).toBe(-32600);
    const dash = await rpc(handle, 10, "tools/call", { name: "family_dashboard", arguments: {} }); expect(dash.result.structuredContent).toBeTruthy();
  });
  it("a write-scoped key can raise a task, run an export and draft an intent — never approve or execute", async () => {
    const key = await send("POST", "/api-keys", { label: "Test MCP write", scopes: ["write:tasks", "write:export", "write:action_plane", "read:investments"] }); const secret = key.body.secret;
    const call = async (method: string, path: string, body?: unknown) => { const r = await app.inject({ method: method as any, url: `/api/v1${path}`, headers: { authorization: `Bearer ${secret}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, payload: body === undefined ? undefined : JSON.stringify(body) }); let j: any = r.body; try { j = r.json(); } catch { /* text */ } return { status: r.statusCode, body: j }; };
    const handle = createMcp(call); const names = (await rpc(handle, 1, "tools/list")).result.tools.map((t: any) => t.name); expect(names).toEqual(expect.arrayContaining(["create_task", "run_export", "propose_intent", "open_tasks"]));
    const task = await rpc(handle, 2, "tools/call", { name: "create_task", arguments: { title: "Test MCP task", reason: "raised by the assistant", module: "tasks", severity: 3 } }); expect(task.result.isError).toBeUndefined(); expect(task.result.structuredContent.title).toBe("Test MCP task");
    const exp = await rpc(handle, 3, "tools/call", { name: "run_export", arguments: { dataset: "holdings", format: "jsonl" } }); expect(exp.result.isError).toBeUndefined(); expect(exp.result.structuredContent).toMatchObject({ dataset: "holdings", format: "jsonl" });
    const intent = await rpc(handle, 4, "tools/call", { name: "propose_intent", arguments: { kind: "mf_purchase", entity_id: ARJUN, amount: 5000, payload: { side: "buy", instrument_id: "44444444-0000-0000-0000-000000000007", amount: 5000 }, rationale: "Test MCP: park idle cash" } });
    if (!intent.result.isError) { expect(["draft", "policy_failed", "pending_approval"]).toContain(intent.result.structuredContent.status); expect(names).not.toContain("approve_intent"); expect(TOOLS.some((t) => /approve|execute|confirm/.test(t.name))).toBe(false); }
    else expect(intent.result.content[0].text).toMatch(/status/);   // policy or payload validation refused it — still nothing executed
    expect((await run((c) => c.query("select count(*)::int n from action_intents where family_id=$1 and rationale like 'Test MCP%' and status::text in ('approved','released','executing','executed','filled','done')", [FAMILY]))).rows[0].n).toBe(0);
  });
});
