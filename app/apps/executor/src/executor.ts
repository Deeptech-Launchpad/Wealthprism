/**
 * Executor: the only process allowed to submit intents to connectors. Runs as DB role executor_user (read intents / policies /
 * credentials, write executions, update intent status). No LLM, no document access. Adapters and the loop live in lib/;
 * this entry point only schedules the loop and answers a health probe. Importing this module never starts the loop.
 */
import { createServer } from "node:http";
import { runOnce, lastRunAt } from "./lib/loop.js";
import { SANDBOX_ONLY } from "./lib/db.js";
export { runOnce } from "./lib/loop.js";
export { adapterFor } from "./lib/adapters.js";

const entry = process.argv[1] ?? "";
if (entry.endsWith("executor.ts") || entry.endsWith("executor.js")) {
  const poll = Number(process.env.EXECUTOR_POLL_SECONDS ?? 10);
  console.log(`executor started (sandbox_only=${SANDBOX_ONLY}, poll=${poll}s)`);
  await runOnce(); setInterval(() => runOnce().catch(console.error), poll * 1000);
  const port = Number(process.env.EXECUTOR_PORT ?? 4100);
  createServer((_req, res) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ ok: true, sandbox_only: SANDBOX_ONLY, last_run_at: lastRunAt, poll_seconds: poll })); }).listen(port, () => console.log(`executor health on :${port}/healthz`));
}
