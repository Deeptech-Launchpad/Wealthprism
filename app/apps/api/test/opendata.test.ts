import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
process.env.STORAGE_DIR ??= mkdtempSync(join(tmpdir(), "fo-opendata-"));
import { buildApp } from "../src/server.js";
import { withFamily, pool } from "../src/lib/db.js";
import { unzip } from "@fo/reports";

// Open data (PRD 3.16, FO-104): API keys with scopes and limits, HMAC-signed webhooks with retries and a dead letter, bulk exports.
const FAMILY = "11111111-1111-1111-1111-111111111111", HUF = "33333333-0000-0000-0000-000000000002";
let app: ReturnType<typeof buildApp>; let owner = "", member = "", viewer = "";
const h = (t = owner, extra: Record<string, string> = {}) => ({ authorization: `Bearer ${t}`, "x-family-id": FAMILY, ...extra });
const get = async (url: string, t = owner, headers: Record<string, string> = h(t)) => { const r = await app.inject({ url: `/api/v1${url}`, headers }); return { code: r.statusCode, body: String(r.headers["content-type"]).includes("json") ? r.json() : r.body, raw: r.rawPayload }; };
const send = async (method: "POST" | "PATCH" | "DELETE", url: string, payload: any = {}, t = owner, headers: Record<string, string> = h(t)) => { const r = await app.inject({ method, url: `/api/v1${url}`, headers, payload }); return { code: r.statusCode, body: r.statusCode === 204 ? null : r.json() }; };
const fetchUrl = async (url: string) => { const u = new URL(url, "http://x"); const r = await app.inject({ url: u.pathname + u.search }); return { code: r.statusCode, raw: r.rawPayload, type: String(r.headers["content-type"]) }; };
const py = (code: string) => spawnSync("python3", ["-c", code]); const HAS_ARROW = py("import pyarrow").status === 0;
let server: Server; let port = 0; const received: { headers: Record<string, any>; body: string }[] = []; let respondWith = 200;

beforeAll(async () => {
  app = buildApp(); await app.ready();
  const login = async (email: string) => (await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password: "Prototype!2026" } })).json().access_token;
  owner = await login("arjun@example.com"); member = await login("priya@example.com"); viewer = await login("ca@example.com");
  server = createServer((req, res) => { let body = ""; req.on("data", (c) => (body += c)); req.on("end", () => { received.push({ headers: req.headers, body }); res.statusCode = respondWith; res.end(respondWith === 200 ? "ok" : "nope"); }); }); await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r())); port = (server.address() as any).port;
  await cleanup();
});
async function cleanup() {
  await withFamily(FAMILY, async (c) => {
    await c.query("delete from api_keys where family_id=$1 and label like 'Test %'", [FAMILY]); await c.query("delete from webhook_deliveries where family_id=$1", [FAMILY]); await c.query("delete from webhooks where family_id=$1", [FAMILY]);
    await c.query("delete from export_jobs where family_id=$1", [FAMILY]); await c.query("delete from documents where family_id=$1 and source='export'", [FAMILY]); await c.query("delete from tasks where family_id=$1 and title like 'Test webhook%'", [FAMILY]);
    await c.query("delete from notifications where family_id=$1 and (payload->>'module'='admin' or title like 'Test webhook%')", [FAMILY]); await c.query("delete from audit_log where family_id=$1 and table_name='api_keys'", [FAMILY]);
  });
}
afterAll(async () => { await cleanup(); await new Promise<void>((r) => server.close(() => r())); await app.close(); rmSync(process.env.STORAGE_DIR!, { recursive: true, force: true }); });

describe("API keys", () => {
  it("issues a scoped key once, enforces read/write scopes, family binding, revocation, expiry and the per-key rate limit", async () => {
    expect((await send("POST", "/api-keys", { label: "Test nope", scopes: ["read:investments"] }, member)).code).toBe(403);
    expect((await send("POST", "/api-keys", { label: "Test bad", scopes: ["read:everything"] })).code).toBe(422);
    const k = await send("POST", "/api-keys", { label: "Test Power BI", scopes: ["read:investments", "read:export", "write:export"], expires_on: "2027-03-31", rate_limit_per_min: 600 }); expect(k.code, JSON.stringify(k.body)).toBe(201);
    expect(k.body.secret).toMatch(/^fo_[0-9a-f]{12}\.[A-Za-z0-9_-]{32}$/); expect(k.body.status).toBe("active"); const secret = k.body.secret as string;
    const listed = (await get("/api-keys")).body; expect(listed.keys.find((x: any) => x.id === k.body.id).secret).toBeUndefined(); expect(listed.scopes).toContain("read:books");
    const asKey = { authorization: `Bearer ${secret}` };   // no X-Family-Id needed: the key is bound to the family
    const hold = await get("/holdings", "", asKey); expect(hold.code).toBe(200); expect(hold.body.items.length).toBeGreaterThan(0);
    expect((await get("/tasks", "", asKey)).code).toBe(403); expect((await send("POST", "/tasks", { title: "x" }, "", asKey)).code).toBe(403);   // scope
    expect((await get("/holdings", "", { ...asKey, "x-family-id": "00000000-0000-0000-0000-000000000009" })).code).toBe(403);
    const me = (await get("/api-keys/whoami", "", asKey)).body; expect(me.api_key.label).toBe("Test Power BI"); expect(me.family.role).toBe("operator"); expect(me.user.name).toContain("API key");
    expect((await send("POST", "/api-keys", { label: "Test via key", scopes: ["read:all"] }, "", asKey)).code).toBe(403);   // keys never mint keys
    const exp = await send("POST", "/export", { dataset: "holdings", format: "csv" }, "", asKey); expect(exp.code).toBe(202);   // write:export
    // rate limit
    const tight = await send("POST", "/api-keys", { label: "Test tight", scopes: ["read:dashboard"], rate_limit_per_min: 3 }); const codes: number[] = []; for (let i = 0; i < 5; i++) codes.push((await get("/dashboard", "", { authorization: `Bearer ${tight.body.secret}` })).code); expect(codes).toEqual([200, 200, 200, 429, 429]);
    // expiry and revocation
    const old = await send("POST", "/api-keys", { label: "Test expired", scopes: ["read:all"], expires_on: "2026-01-01" }); expect((await get("/dashboard", "", { authorization: `Bearer ${old.body.secret}` })).code).toBe(401);
    expect((await send("DELETE", `/api-keys/${k.body.id}`)).code).toBe(204); const gone = await get("/holdings", "", asKey); expect(gone.code).toBe(401); expect(gone.body.title).toMatch(/revoked/);
    expect((await get("/dashboard", "", { authorization: "Bearer fo_deadbeefcafe.notarealsecretvaluexxxxxxxxxxxxxx" })).code).toBe(401);
    expect((await withFamily(FAMILY, (c) => c.query("select count(*) n from audit_log where family_id=$1 and table_name='api_keys' and action in ('create','revoke')", [FAMILY]))).rows[0].n).toBe("4");   // three keys created, one revoked
  });
});

describe("webhooks", () => {
  it("registers a hook with a one-time secret, signs every delivery, retries with backoff and dead-letters after five failures", async () => {
    expect((await send("POST", "/webhooks", { url: `http://127.0.0.1:${port}/hook`, events: ["task.created"] }, member)).code).toBe(403);
    expect((await send("POST", "/webhooks", { url: `http://127.0.0.1:${port}/hook`, events: ["nope"] })).code).toBe(422);
    const w = await send("POST", "/webhooks", { url: `http://127.0.0.1:${port}/hook`, events: ["task.created", "report.ready", "export.ready", "ping"], label: "Test receiver" }); expect(w.code, JSON.stringify(w.body)).toBe(201); const secret = w.body.secret as string; expect(secret).toMatch(/^whsec_/);
    expect((await get("/webhooks")).body.webhooks.find((x: any) => x.id === w.body.id).secret).toBeUndefined(); expect((await get("/webhooks", viewer)).code).toBe(403);
    // ping: synchronous, signed
    received.length = 0; const ping = await send("POST", `/webhooks/${w.body.id}/test`); expect(ping.body.status).toBe("delivered"); expect(received).toHaveLength(1);
    const r = received[0]; const [t, v1] = String(r.headers["x-fo-signature"]).split(","); const ts = t.slice(2); expect(createHmac("sha256", secret).update(`${ts}.${r.body}`).digest("hex")).toBe(v1.slice(3)); expect(r.headers["x-fo-event"]).toBe("ping"); expect(JSON.parse(r.body).data.message).toContain("hello");
    // a real event: creating a task fans out; the worker path delivers
    received.length = 0; const task = await send("POST", "/tasks", { title: "Test webhook task", module: "tasks", severity: 3 }); expect(task.code).toBe(201);
    const del = await send("POST", "/webhooks/deliver-due", {}); expect(del.body.some((d: any) => d.status === "delivered")).toBe(true); expect(received.some((x) => x.headers["x-fo-event"] === "task.created" && JSON.parse(x.body).data.task_id === task.body.id)).toBe(true);
    const list = (await get(`/webhooks/${w.body.id}/deliveries`)).body; expect(list.filter((d: any) => d.event === "task.created" && d.status === "delivered").length).toBeGreaterThanOrEqual(1);
    // an export.ready lands too (the receiver is subscribed)
    await send("POST", "/export", { dataset: "tasks", format: "jsonl" }); await send("POST", "/webhooks/deliver-due", {}); expect(received.some((x) => x.headers["x-fo-event"] === "export.ready")).toBe(true);
    // failures back off and finally dead-letter with an owner notification
    respondWith = 500; received.length = 0; const emit = await send("POST", "/webhooks/emit", { event: "ping", data: { n: 1 } }); expect(emit.body.queued).toBe(1);
    const first = (await send("POST", "/webhooks/deliver-due", {})).body.find((d: any) => d.status === "failed"); expect(first).toBeTruthy(); expect(first.code).toBe(500);
    const row = (await get(`/webhooks/${w.body.id}/deliveries`)).body.find((d: any) => d.id === first.id); expect(row.attempts).toBe(1); expect(new Date(row.next_attempt_at).getTime()).toBeGreaterThan(Date.now() + 30_000);
    await withFamily(FAMILY, (c) => c.query("update webhook_deliveries set attempts=4, next_attempt_at=now() where id=$1", [first.id])); const dead = (await send("POST", "/webhooks/deliver-due", {})).body.find((d: any) => d.id === first.id); expect(dead.status).toBe("dead");
    const notes = (await get("/notifications")).body; expect((notes.items ?? notes).some((n: any) => /Webhook .* failing/.test(n.title))).toBe(true);
    expect((await get("/webhooks")).body.webhooks.find((x: any) => x.id === w.body.id).failures).toBeGreaterThanOrEqual(2);
    // retry by hand once the receiver is back
    respondWith = 200; const retry = await send("POST", `/webhooks/deliveries/${first.id}/retry`); expect(retry.body.status).toBe("delivered");
    expect((await send("PATCH", `/webhooks/${w.body.id}`, { active: false })).body.active).toBe(false); expect((await send("POST", "/webhooks/emit", { event: "ping", data: {} })).body.queued).toBe(0);
    expect((await send("DELETE", `/webhooks/${w.body.id}`)).code).toBe(204);
  });
});

describe("bulk export", () => {
  it("exports datasets as CSV, XLSX, JSONL and Parquet behind a signed URL, filtered by entity, expiring after a week", async () => {
    const ds = (await get("/export/datasets")).body; expect(ds.map((d: any) => d.dataset)).toEqual(expect.arrayContaining(["holdings", "lots", "investment_txns", "bank_txns", "properties", "rent_schedule", "private_investments", "valuations_daily", "realized_gains", "liabilities", "insurance_policies", "tasks"]));
    expect((await send("POST", "/export", { dataset: "nope" })).code).toBe(422);
    const n = Number((await withFamily(FAMILY, (c) => c.query("select count(*) n from holdings where quantity>0"))).rows[0].n); const nHuf = Number((await withFamily(FAMILY, (c) => c.query("select count(*) n from holdings where quantity>0 and entity_id=$1", [HUF]))).rows[0].n);
    const csv = await send("POST", "/export", { dataset: "holdings", format: "csv" }); expect(csv.code, JSON.stringify(csv.body)).toBe(202); expect(csv.body).toMatchObject({ status: "done", row_count: n, format: "csv" }); expect(new Date(csv.body.expires_at).getTime()).toBeGreaterThan(Date.now() + 6 * 86400_000);
    const text = (await fetchUrl(csv.body.url)).raw.toString("utf8"); expect(text.charCodeAt(0)).toBe(0xfeff); expect(text.slice(1).split("\r\n")[0]).toBe("Holding id,Entity,Instrument,Symbol,ISIN,Asset class,Bucket,Quantity,Average cost,Cost,Price,Price date,Value"); expect(text.trim().split("\r\n")).toHaveLength(n + 1);
    const huf = await send("POST", "/export", { dataset: "holdings", format: "xlsx", entity_id: HUF }); expect(huf.body.row_count).toBe(nHuf); const files = unzip((await fetchUrl(huf.body.url)).raw); expect(files["xl/worksheets/sheet1.xml"].toString()).toContain("Mehta HUF");
    const jl = await send("POST", "/export", { dataset: "bank_txns", format: "jsonl", from: "2026-04-01", to: "2026-09-30" }); const lines = (await fetchUrl(jl.body.url)).raw.toString("utf8").trim().split("\n"); expect(lines).toHaveLength(jl.body.row_count); expect(JSON.parse(lines[0])).toHaveProperty("narration");
    const pq = await send("POST", "/export", { dataset: "realized_gains", format: "parquet" }); const bytes = (await fetchUrl(pq.body.url)).raw; expect(bytes.subarray(0, 4).toString()).toBe("PAR1");
    if (HAS_ARROW) { const f = join(process.env.STORAGE_DIR!, "rg.parquet"); writeFileSync(f, bytes); const r = py(`import pyarrow.parquet as pq;t=pq.read_table(${JSON.stringify(f)});print(t.num_rows, ",".join(t.schema.names), str(t.schema.field("gain").type), str(t.schema.field("sell_date").type))`); expect(r.status, r.stderr.toString()).toBe(0); expect(r.stdout.toString().trim()).toBe(`${pq.body.row_count} id,entity,instrument,fy,buy_date,sell_date,quantity,cost,proceeds,gain,term,asset_class,exemption_used double date32[day]`); }
    const docs = (await get("/documents?source=export")).body; expect(docs.length).toBeGreaterThanOrEqual(4); expect(docs[0].folder_name).toBe("Exports"); expect(docs[0].expires_at).toBeTruthy();
    expect((await get("/export")).body.length).toBeGreaterThanOrEqual(4); expect((await get(`/export/${csv.body.id}`)).body.status).toBe("done");
    expect((await send("POST", "/export", { dataset: "holdings" }, viewer)).code).toBe(403);
  });
});
