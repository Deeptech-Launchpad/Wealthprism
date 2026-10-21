/** MCP server (FO-104 v1.1): Model Context Protocol over JSON-RPC 2.0 — the same REST API, exposed as tools to Claude Desktop, Cursor and
 *  other MCP clients. Authentication is an ordinary API key (family-bound, scoped, rate-limited), so a key with read scopes gives a
 *  read-only assistant and nothing here can approve or execute: the separation-of-powers triggers still hold behind every write.
 *  `createMcp` is transport-agnostic (tested in-process); `src/mcp.ts` wires it to stdio. */
export const MCP_PROTOCOL = "2025-06-18";
type Json = Record<string, any>;
export type ApiCall = (method: string, path: string, body?: unknown) => Promise<{ status: number; body: any }>;
export interface Tool { name: string; description: string; method: "GET" | "POST"; path: string | ((a: Json) => string); scope: string; inputSchema: Json; body?: (a: Json) => unknown; query?: string[] }

const q = (a: Json, keys: string[]) => { const p = keys.filter((k) => a[k] != null && a[k] !== "").map((k) => `${k}=${encodeURIComponent(String(a[k]))}`); return p.length ? `?${p.join("&")}` : ""; };
const S = { entity: { type: "string", description: "Entity id (uuid); omit for the whole family" }, fy: { type: "string", description: "Financial year like 2026-27" }, date: { type: "string", description: "ISO date YYYY-MM-DD" } };
export const TOOLS: Tool[] = [
  { name: "family_dashboard", description: "Net worth by entity with month-on-month change, XIRR, bucket split and the needs-attention feed.", method: "GET", path: "/dashboard", scope: "read:dashboard", inputSchema: { type: "object", properties: {} } },
  { name: "list_holdings", description: "Holdings with quantity, average cost, latest price, value, unrealised gain and XIRR; optionally for one entity.", method: "GET", path: (a) => `/holdings${q(a, ["entity_id"])}`, scope: "read:investments", inputSchema: { type: "object", properties: { entity_id: S.entity } } },
  { name: "capital_gains", description: "Realised capital gains for a financial year by entity, asset class and term (FIFO lots, grandfathering, LTCG exemption).", method: "GET", path: (a) => `/capital-gains${q(a, ["fy", "entity_id"])}`, scope: "read:investments", inputSchema: { type: "object", properties: { fy: S.fy, entity_id: S.entity }, required: ["fy"] } },
  { name: "harvest_candidates", description: "Tax-loss harvesting candidates: unrealised losses first, then long-term gains that fit inside the LTCG exemption headroom.", method: "GET", path: (a) => `/harvest-candidates${q(a, ["fy", "entity_id"])}`, scope: "read:investments", inputSchema: { type: "object", properties: { fy: S.fy, entity_id: S.entity } } },
  { name: "performance", description: "Time-weighted and money-weighted returns against the benchmark for a scope and period.", method: "GET", path: (a) => `/performance${q(a, ["entity_id", "period"])}`, scope: "read:investments", inputSchema: { type: "object", properties: { entity_id: S.entity, period: { type: "string", description: "1y, 3y, 5y or si" } } } },
  { name: "net_worth", description: "Balance sheet: assets, liabilities and net worth per entity with the change since last month.", method: "GET", path: (a) => `/net-worth${q(a, ["as_of"])}`, scope: "read:balance_sheet", inputSchema: { type: "object", properties: { as_of: S.date } } },
  { name: "liabilities", description: "Loans with outstanding balance, EMI, rate, LTV and the next instalments.", method: "GET", path: "/liabilities", scope: "read:balance_sheet", inputSchema: { type: "object", properties: {} } },
  { name: "insurance", description: "Insurance policies with premiums due, cover and the adequacy view.", method: "GET", path: "/insurance-policies", scope: "read:balance_sheet", inputSchema: { type: "object", properties: {} } },
  { name: "exposure", description: "Look-through exposure by asset class, sector, geography, issuer, market cap and more.", method: "GET", path: (a) => `/exposure${q(a, ["dimension", "entity_id"])}`, scope: "read:analytics", inputSchema: { type: "object", properties: { dimension: { type: "string", description: "asset_class, sector, geography, issuer, market_cap, currency, rating, duration, instrument_type, manager" }, entity_id: S.entity } } },
  { name: "allocation_status", description: "Asset-class lens on the family's model portfolio: target, band, headline vs look-through, drift and breaches.", method: "GET", path: (a) => `/allocation/status${q(a, ["entity_id"])}`, scope: "read:goals", inputSchema: { type: "object", properties: { entity_id: S.entity } } },
  { name: "goals", description: "Goals with inflation-adjusted need, funded %, gap at target and monthly saving required.", method: "GET", path: "/goals", scope: "read:goals", inputSchema: { type: "object", properties: {} } },
  { name: "bucket_drift", description: "Three-bucket (liquidity / income / growth) targets vs actuals with drift.", method: "GET", path: "/buckets/drift", scope: "read:goals", inputSchema: { type: "object", properties: {} } },
  { name: "cash_flow", description: "Bank cash flow for the last N days by category, entity, month and counterparty (transfers excluded).", method: "GET", path: (a) => `/cashflow${q(a, ["days", "entity_id"])}`, scope: "read:analytics", inputSchema: { type: "object", properties: { days: { type: "integer", description: "30, 90 or 365" }, entity_id: S.entity } } },
  { name: "working_capital", description: "Cash across accounts, the required float, deployable excess and idle-cash drag.", method: "GET", path: "/working-capital/summary", scope: "read:banking", inputSchema: { type: "object", properties: {} } },
  { name: "committed_outflows", description: "Dated commitments ahead: capital calls, advance tax, GST, premiums, EMIs.", method: "GET", path: (a) => `/committed-outflows${q(a, ["days"])}`, scope: "read:banking", inputSchema: { type: "object", properties: { days: { type: "integer" } } } },
  { name: "tax_position", description: "Projected tax per entity for a financial year under both regimes with the advance-tax schedule.", method: "GET", path: (a) => `/tax/projection${q(a, ["fy", "entity_id"])}`, scope: "read:planning", inputSchema: { type: "object", properties: { fy: S.fy, entity_id: S.entity } } },
  { name: "tax_suggestions", description: "Optimiser suggestions (LTCG exemption use, harvesting, regime switch, timing) with estimated savings.", method: "GET", path: "/tax/suggestions", scope: "read:planning", inputSchema: { type: "object", properties: {} } },
  { name: "properties", description: "Real-estate register with owners, valuations, rent, yield and pending rent.", method: "GET", path: "/properties", scope: "read:real_estate", inputSchema: { type: "object", properties: {} } },
  { name: "private_investments", description: "Start-up and fund stakes with marks, MOIC, unfunded commitments and next events.", method: "GET", path: "/private-investments", scope: "read:startups", inputSchema: { type: "object", properties: {} } },
  { name: "open_tasks", description: "Open tasks from the task engine, optionally filtered by module or entity.", method: "GET", path: (a) => `/tasks${q(a, ["module", "entity_id", "status"])}`, scope: "read:tasks", inputSchema: { type: "object", properties: { module: { type: "string" }, entity_id: S.entity, status: { type: "string", description: "open, done or dismissed" } } } },
  { name: "trial_balance", description: "General-ledger trial balance for an entity and financial year.", method: "GET", path: (a) => `/gl/reports/trial-balance${q(a, ["entity_id", "fy", "as_of"])}`, scope: "read:books", inputSchema: { type: "object", properties: { entity_id: S.entity, fy: S.fy, as_of: S.date }, required: ["entity_id"] } },
  { name: "list_datasets", description: "Datasets available for bulk export (columns and description).", method: "GET", path: "/export/datasets", scope: "read:export", inputSchema: { type: "object", properties: {} } },
  { name: "run_export", description: "Export a dataset as csv, jsonl, xlsx or parquet; returns the job with a signed download link (needs write:export).", method: "POST", path: "/export", scope: "write:export", inputSchema: { type: "object", properties: { dataset: { type: "string" }, format: { type: "string", enum: ["csv", "jsonl", "xlsx", "parquet"] }, entity_id: S.entity, from: S.date, to: S.date }, required: ["dataset"] }, body: (a) => ({ dataset: a.dataset, format: a.format ?? "csv", entity_id: a.entity_id ?? null, from: a.from ?? null, to: a.to ?? null }) },
  { name: "create_task", description: "Raise a task for the family (needs write:tasks). Tasks are work items for people; nothing is executed.", method: "POST", path: "/tasks", scope: "write:tasks", inputSchema: { type: "object", properties: { title: { type: "string" }, reason: { type: "string" }, module: { type: "string" }, entity_id: S.entity, due_date: S.date, severity: { type: "integer", description: "1 urgent … 3 routine" } }, required: ["title"] }, body: (a) => ({ title: a.title, reason: a.reason ?? "Raised through MCP", module: a.module ?? "tasks", ...(a.entity_id ? { entity_id: a.entity_id } : {}), ...(a.due_date ? { due_date: a.due_date } : {}), severity: a.severity ?? 3 }) },
  { name: "propose_intent", description: "Draft an action intent (buy / sell / transfer / bill) for a human to approve with step-up auth (needs write:action_plane). MCP can propose, never approve or execute.", method: "POST", path: "/actions", scope: "write:action_plane", inputSchema: { type: "object", properties: { kind: { type: "string", enum: ["equity_order", "mf_purchase", "mf_redemption", "mf_switch", "mf_sip_mandate", "bank_transfer", "bill_payment", "tax_payment", "gst_payment", "capital_call_payment"] }, entity_id: S.entity, amount: { type: "number", description: "INR" }, payload: { type: "object" }, rationale: { type: "string" } }, required: ["kind", "entity_id", "amount", "payload"] }, body: (a) => ({ kind: a.kind, entity_id: a.entity_id, amount: a.amount, payload: a.payload, rationale: a.rationale ?? "Proposed through MCP", source_type: "mcp" }) },
];

const rpcError = (id: any, code: number, message: string, data?: unknown) => ({ jsonrpc: "2.0", id, error: { code, message, ...(data === undefined ? {} : { data }) } });
const text = (v: unknown) => ({ type: "text", text: typeof v === "string" ? v : JSON.stringify(v, null, 1) });
export function createMcp(call: ApiCall, opts: { serverName?: string; version?: string; tools?: Tool[] } = {}) {
  const tools = opts.tools ?? TOOLS; let scopes: string[] | null = null;
  const allowed = (t: Tool) => !scopes || scopes.includes(t.scope) || scopes.includes(t.scope.startsWith("write:") ? "write:all" : "read:all") || (t.scope.startsWith("read:") && scopes.includes(t.scope.replace("read:", "write:")));
  async function loadScopes() { if (scopes) return; try { const r = await call("GET", "/api-keys/whoami"); scopes = r.status === 200 ? (r.body?.api_key?.scopes ?? []) : []; } catch { scopes = []; } }
  return async function handle(msg: any): Promise<any | null> {
    if (!msg || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") return rpcError(msg?.id ?? null, -32600, "Invalid request");
    const id = msg.id; const isNotification = id === undefined;
    switch (msg.method) {
      case "initialize": return { jsonrpc: "2.0", id, result: { protocolVersion: msg.params?.protocolVersion === "2024-11-05" ? "2024-11-05" : MCP_PROTOCOL, capabilities: { tools: { listChanged: false } }, serverInfo: { name: opts.serverName ?? "wealthprism", version: opts.version ?? "1.1.0" }, instructions: "WealthPrism family-office data for one family, scoped by the API key. Amounts are INR decimal strings; dates are ISO. Tools read the books of record; write tools only raise tasks, exports or draft intents that a person approves." } };
      case "notifications/initialized": case "notifications/cancelled": return null;
      case "ping": return { jsonrpc: "2.0", id, result: {} };
      case "tools/list": { await loadScopes(); return { jsonrpc: "2.0", id, result: { tools: tools.filter(allowed).map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) } }; }
      case "tools/call": {
        const name = msg.params?.name; const args = (msg.params?.arguments ?? {}) as Json; const t = tools.find((x) => x.name === name); if (!t) return rpcError(id, -32602, `Unknown tool ${name}`);
        await loadScopes(); if (!allowed(t)) return { jsonrpc: "2.0", id, result: { isError: true, content: [text(`This key lacks the ${t.scope} scope`)] } };
        for (const k of t.inputSchema.required ?? []) if (args[k] == null || args[k] === "") return { jsonrpc: "2.0", id, result: { isError: true, content: [text(`${k} is required`)] } };
        try { const path = typeof t.path === "function" ? t.path(args) : t.path; const r = await call(t.method, path, t.body ? t.body(args) : undefined); if (r.status >= 400) return { jsonrpc: "2.0", id, result: { isError: true, content: [text({ status: r.status, ...(typeof r.body === "object" ? r.body : { body: r.body }) })] } }; return { jsonrpc: "2.0", id, result: { content: [text(r.body)], structuredContent: typeof r.body === "object" && !Array.isArray(r.body) ? r.body : { items: r.body } } }; }
        catch (e: any) { return { jsonrpc: "2.0", id, result: { isError: true, content: [text(`API call failed: ${e.message}`)] } }; }
      }
      case "resources/list": return { jsonrpc: "2.0", id, result: { resources: [] } };
      case "prompts/list": return { jsonrpc: "2.0", id, result: { prompts: [] } };
      default: return isNotification ? null : rpcError(id, -32601, `Method not found: ${msg.method}`);
    }
  };
}
/** HTTP client for a running API: `FO_API_URL` (default http://localhost:4000/api/v1) with `FO_API_KEY` as the bearer. */
export function httpApiCall(baseUrl = process.env.FO_API_URL ?? "http://localhost:4000/api/v1", apiKey = process.env.FO_API_KEY ?? ""): ApiCall {
  return async (method, path, body) => { const r = await fetch(`${baseUrl}${path}`, { method, headers: { authorization: `Bearer ${apiKey}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }); const t = await r.text(); let j: any = t; try { j = JSON.parse(t); } catch { /* text body */ } return { status: r.status, body: j }; };
}
/** In-process client for the HTTP transport (FO-104 v1.2): routes through the same Fastify instance via `app.inject`, so a remote MCP client
 *  authenticates with its own bearer API key per request — no server-wide `FO_API_KEY`, and the full auth / RLS / scope pipeline runs exactly
 *  as it would for a real HTTP call, just without the network hop. */
export function injectApiCall(app: { inject: (opts: { method: string; url: string; headers: Record<string, string>; payload?: unknown }) => Promise<{ statusCode: number; json(): any; payload: string }> }, apiKey: string): ApiCall {
  return async (method, path, body) => {
    const res = await app.inject({ method, url: `/api/v1${path}`, headers: { authorization: `Bearer ${apiKey}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, payload: body });
    let json: any; try { json = res.json(); } catch { json = res.payload; }
    return { status: res.statusCode, body: json };
  };
}
