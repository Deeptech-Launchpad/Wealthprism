/** stdio transport for the MCP server: one JSON-RPC message per line on stdin, answers on stdout, logs on stderr.
 *  Claude Desktop / Cursor config:  { "mcpServers": { "wealthprism": { "command": "pnpm", "args": ["--filter", "@fo/api", "mcp"], "env": { "FO_API_URL": "https://…/api/v1", "FO_API_KEY": "fo_…" } } } } */
import { createInterface } from "node:readline";
import { createMcp, httpApiCall } from "./lib/mcp.js";

if (!process.env.FO_API_KEY) console.error("FO_API_KEY is not set — create one under Reports → API keys (read scopes for a read-only assistant)");
const handle = createMcp(httpApiCall());
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity }); let queue: Promise<void> = Promise.resolve();   // answers in order; exit only after the last one is written
rl.on("line", (line) => { const s = line.trim(); if (!s) return; queue = queue.then(async () => { let msg: any; try { msg = JSON.parse(s); } catch { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }) + "\n"); return; }
  for (const m of Array.isArray(msg) ? msg : [msg]) { const out = await handle(m); if (out) process.stdout.write(JSON.stringify(out) + "\n"); } }); });
rl.on("close", () => { queue.then(() => process.exit(0)); });
