/** Scheduler: releases approved intents after cooling-off, expires stale ones, refreshes GL balances, flags overdue rent,
 *  and runs the market-data jobs on their IST windows. Runs every 60 s. */
import { pool } from "./lib/db.js";
import { runFeeds, snapshotValuations, refreshPerformanceCache, stalePriceTasks, recordRun } from "./jobs/market.js";
import { generateTasks } from "./jobs/tasks.js";
import { refreshBaselines, runOptimiserAll } from "./jobs/planning.js";
import { runComplianceAll, runReviewsAll } from "./jobs/policy.js";
import { rebalanceNeedsAll, rebalanceEvaluateAll } from "./jobs/rebalance.js";
import { glAutopostAll, glRecurringAll } from "./jobs/gl.js";
import { researchPipelineAll, researchTrackRecordAll, researchDigestAll } from "./jobs/research.js";
import { sendDigests, resolveApprovalNotice } from "./lib/notify.js";
import { tryQueue } from "./lib/actions.js";
import { sessionTasks, mandateExpiryTasks } from "./lib/connectors.js";
import { deliverDue, emitEvent } from "./lib/opendata.js";
import { purgeExpired } from "./lib/documents.js";
import { runDueSchedules, runDuePacks } from "./lib/reports.js";
import { balanceNightlyAll } from "./jobs/balance.js";
import { syncDueAll } from "./lib/aa.js";
import { dispatchReminders, installDelivery } from "./lib/delivery.js";
import type { FastifyInstance } from "fastify";
/** Report schedules render through the API itself (app.inject), so the worker holds an in-process app that never listens. */
let reportApp: FastifyInstance | null = null;
async function apiApp() { if (!reportApp) { const { buildApp } = await import("./server.js"); reportApp = buildApp(); await reportApp.ready(); } return reportApp; }
let lastHousekeeping = 0;

export async function tick() {
  const fams = await pool.query("select id from families");   // RLS needs the family context: a pooled connection carries '' after a transaction-local set_config
  for (const f of fams.rows) {
    const c = await pool.connect();
    try {
      await c.query("begin"); await c.query("select set_config('app.family_id',$1,true)", [f.id]);
      const expired = await c.query("update action_intents set status='expired' where status in ('pending_approval','approved') and expires_at < now() returning id");
      for (const i of expired.rows) await resolveApprovalNotice(c, f.id, i.id, "expired").catch(() => null);
      const due = await c.query("select id from action_intents where status='approved' and (cooling_off_until is null or cooling_off_until <= now())");
      for (const i of due.rows) await tryQueue(c, f.id, i.id);   // cooling-off passed; connector session and kill switch still decide
      if (!lastHousekeeping || Date.now() - lastHousekeeping > 3600_000) { await sessionTasks(c, f.id); await mandateExpiryTasks(c, f.id); await purgeExpired(c, f.id); }
      // intents filled since the last tick → intent.executed for subscribed webhooks (the executor role cannot write deliveries itself)
      const filled = await c.query("select i.id, i.kind, i.entity_id, i.amount, i.status, i.confirmed_ref from action_intents i where i.status in ('filled','reconciled','posted') and i.updated_at > now() - interval '3 minutes' and not exists (select 1 from webhook_deliveries d where d.family_id=i.family_id and d.event='intent.executed' and d.payload->'data'->>'intent_id' = i.id::text)");
      for (const i of filled.rows) await emitEvent(c, f.id, "intent.executed", { intent_id: i.id, kind: i.kind, entity_id: i.entity_id, amount: i.amount, status: i.status, reference: i.confirmed_ref });
      await c.query("commit");
    } catch (e) { await c.query("rollback"); console.error("worker", f.id, e); } finally { c.release(); }
  }
  await deliverDue({ timeoutMs: 10_000 }).catch((e) => console.error("webhooks", e));
  await dispatchReminders().catch((e) => console.error("reminders", e));
  if (!lastHousekeeping || Date.now() - lastHousekeeping > 3600_000) { lastHousekeeping = Date.now(); try { const app = await apiApp(); await runDueSchedules(app); await runDuePacks(app); } catch (e) { console.error("report schedules", e); } try { const { runDueExports } = await import("./lib/opendata.js"); await runDueExports(); } catch (e) { console.error("export schedules", e); } }
  await pool.query("select refresh_gl_balances()").catch((e) => console.error("gl_balances", e));   // app_user cannot refresh the matview itself (db/030)
}

/** A job is due when the IST clock is past its window and it has not succeeded today. */
const IST = () => new Date(Date.now() + 5.5 * 3600 * 1000);
async function ranToday(job: string) { return !!(await pool.query("select 1 from feed_runs where job=$1 and status='ok' and started_at >= (now() at time zone 'Asia/Kolkata')::date", [job])).rows[0]; }
const hhmm = () => { const d = IST(); return d.getUTCHours() * 100 + d.getUTCMinutes(); };
export async function marketTick() {
  if (process.env.FEEDS_ENABLED === "false") return;
  const t = hhmm(); const day = IST().getUTCDay(); const weekday = day >= 1 && day <= 5;
  const safe = async (job: string, fn: () => Promise<unknown>) => { try { await fn(); } catch (e: any) { console.error("job", job, e.message ?? e); } };
  if (weekday && t >= 1830 && !(await ranToday("prices.eod"))) await safe("prices.eod", () => runFeeds(["eod", "indices", "tri", "series", "fx"]));
  if (t >= 2315 && !(await ranToday("amfi.nav"))) await safe("amfi.nav", () => runFeeds(["amfi"]));
  if (t >= 800 && !(await ranToday("corporate_actions.fetch"))) await safe("corporate_actions.fetch", () => runFeeds(["ca"]));
  if (t >= 2330 && !(await ranToday("valuations.daily"))) await safe("valuations.daily", () => recordRun("valuations.daily", async () => { const r = await snapshotValuations(); await recordRun("twr.refresh", () => refreshPerformanceCache()); return r; }));
  if (t >= 900 && !(await ranToday("prices.stale"))) await safe("prices.stale", () => recordRun("prices.stale", () => stalePriceTasks()));
  if (t >= 2345 && !(await ranToday("plan.baseline"))) await safe("plan.baseline", () => recordRun("plan.baseline", async () => { const r = await refreshBaselines(); await recordRun("tax.optimise", () => runOptimiserAll()); return r; }));
  if (t >= 2350 && !(await ranToday("policy.compliance"))) await safe("policy.compliance", () => recordRun("policy.compliance", async () => { const r = await runComplianceAll(); await recordRun("policy.reviews", () => runReviewsAll()); return r; }));
  if (t >= 2355 && !(await ranToday("rebalance.evaluate"))) await safe("rebalance.evaluate", () => recordRun("rebalance.evaluate", async () => { await recordRun("rebalance.needs", () => rebalanceNeedsAll()); return rebalanceEvaluateAll(); }));
  if (t >= 2200 && !(await ranToday("gl.autopost"))) await safe("gl.autopost", () => recordRun("gl.autopost", async () => { await recordRun("gl.recurring", () => glRecurringAll()); return glAutopostAll(); }));
  if (t >= 2320 && !(await ranToday("balance.nightly"))) await safe("balance.nightly", () => recordRun("balance.nightly", () => balanceNightlyAll()));
  if (t >= 2340 && !(await ranToday("research.track_record"))) await safe("research.track_record", () => recordRun("research.track_record", () => researchTrackRecordAll()));
  const lastResearch = (await pool.query("select max(started_at) t from feed_runs where job='research.cluster_assess' and status='ok'")).rows[0].t;
  if (!lastResearch || Date.now() - new Date(lastResearch).getTime() > 3600_000) await safe("research.cluster_assess", () => recordRun("research.cluster_assess", () => researchPipelineAll()));
  if (!(await ranToday("research.digest"))) await safe("research.digest", async () => { const r = await researchDigestAll(); if (r.rows) await recordRun("research.digest", async () => r); });
  // Account Aggregator: every active consent is fetched four-hourly (its own next_fetch_at), checked every 15 minutes
  const lastAa = (await pool.query("select max(started_at) t from feed_runs where job='aa.sync' and status='ok'")).rows[0].t;
  if (process.env.AA_SYNC_ENABLED !== "false" && (!lastAa || Date.now() - new Date(lastAa).getTime() > 900_000)) await safe("aa.sync", () => recordRun("aa.sync", () => syncDueAll()));
  // task generators every hour, the e-mail digest once a day at 08:00 IST
  const lastGen = (await pool.query("select max(started_at) t from feed_runs where job='tasks.generate' and status='ok'")).rows[0].t;
  if (!lastGen || Date.now() - new Date(lastGen).getTime() > 3600_000) await safe("tasks.generate", () => recordRun("tasks.generate", () => generateTasks()));
  if (t >= 800 && !(await ranToday("notify.digest"))) await safe("notify.digest", () => recordRun("notify.digest", async () => { const d = await sendDigests(); return { rows: d.length, note: `${d.length} digests` }; }));
}

const entry = process.argv[1] ?? "";
if (entry.endsWith("worker.ts") || entry.endsWith("worker.js")) {
  installDelivery(); console.log("worker started");
  await tick(); await marketTick();
  setInterval(() => tick().then(marketTick).catch(console.error), Number(process.env.WORKER_INTERVAL_MS ?? 60000));
}
