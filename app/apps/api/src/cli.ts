import bcrypt from "bcryptjs";
import { readFileSync } from "node:fs";
import { pool, withFamily } from "./lib/db.js";
import { refreshBaselines, runOptimiserAll } from "./jobs/planning.js";
import { runComplianceAll, runReviewsAll } from "./jobs/policy.js";
import { rebalanceNeedsAll, rebalanceEvaluateAll } from "./jobs/rebalance.js";
import { glAutopostAll, glRecurringAll } from "./jobs/gl.js";
import { researchPipelineAll, researchTrackRecordAll, researchDigestAll } from "./jobs/research.js";
import { withFamilyClient } from "./jobs/market.js";
import { generateOpening, setOpening } from "./lib/gl.js";
import { runFeeds, ingestAmfiNav, ingestNseBhavcopy, ingestNseIndices, ingestCorporateActions, autoApplyCorporateActions, snapshotValuations, backfillValuations, refreshPerformanceCache, stalePriceTasks, recordRun, unzipSingle } from "./jobs/market.js";
const [cmd, ...rest] = process.argv.slice(2);
const arg = (k: string) => { const i = rest.indexOf(`--${k}`); return i >= 0 ? rest[i + 1] : undefined; };
if (cmd === "set-password") { await pool.query("update users set password_hash=$2 where email=$1", [arg("email"), await bcrypt.hash(arg("password")!, 10)]); console.log("password set"); }
else if (cmd === "create-owner") {
  const email = (arg("email") ?? "").toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { console.error("give a valid --email"); process.exit(1); }
  // an existing e-mail must stop us before anything is written (users.email is unique, and a half-created family would be left behind)
  if ((await pool.query("select 1 from users where email=$1", [email])).rowCount) { console.error(`a user with ${email} already exists`); process.exit(1); }
  const pw = arg("password") ?? Math.random().toString(36).slice(2, 12) + "!A1";
  const fam = await pool.query("insert into families (name, base_currency) values ($1,'INR') returning id", [arg("family") ?? "My Family"]);
  const u = await pool.query("insert into users (email, name, password_hash) values ($1,$2,$3) returning id", [email, arg("name") ?? "Owner", await bcrypt.hash(pw, 10)]);
  // family_members is row-level-secured by family: it can only be written with that family's context set, exactly as POST /auth/register does
  await withFamily(fam.rows[0].id, async (c) => {
    await c.query("insert into family_members (family_id, user_id, role, invited_at, accepted_at) values ($1,$2,'owner',now(),now())", [fam.rows[0].id, u.rows[0].id]);
    await c.query("insert into wc_settings (family_id) values ($1) on conflict do nothing", [fam.rows[0].id]);
    await c.query("insert into bucket_targets (family_id, liquidity_pct, income_pct, growth_pct) values ($1,8,32,60)", [fam.rows[0].id]);
    await c.query("insert into audit_log (family_id, user_id, action, table_name, row_id, after) values ($1,$2,'create','families',$1,$3)", [fam.rows[0].id, u.rows[0].id, JSON.stringify({ via: "cli_create_owner" })]);
  });
  console.log(JSON.stringify({ family_id: fam.rows[0].id, user_id: u.rows[0].id, one_time_password: pw }));
}
// market data: live feeds or a local file (--file), so history can be loaded without network access
else if (cmd === "prices:amfi") console.log(arg("file") ? await recordRun("amfi.nav", () => ingestAmfiNav(readFileSync(arg("file")!, "utf8"), { loadMaster: rest.includes("--load-master") })) : await runFeeds(["amfi"]));
else if (cmd === "prices:eod") console.log(arg("file") ? await recordRun("prices.eod", () => { const f = arg("file")!; return ingestNseBhavcopy(f.endsWith(".zip") ? unzipSingle(readFileSync(f)) : readFileSync(f, "utf8"), { loadMaster: rest.includes("--load-master") }); }) : await runFeeds(["eod"], undefined, arg("date")));
else if (cmd === "prices:indices") console.log(arg("file") ? await recordRun("benchmarks.eod", () => ingestNseIndices(JSON.parse(readFileSync(arg("file")!, "utf8")))) : await runFeeds(["indices"]));
else if (cmd === "ca:fetch") console.log(arg("file") ? await recordRun("corporate_actions.fetch", async () => { const r = await ingestCorporateActions(JSON.parse(readFileSync(arg("file")!, "utf8"))); const a = await autoApplyCorporateActions(); return { ...r, applied: a.rows }; }) : await runFeeds(["ca"]));
else if (cmd === "ca:apply") console.log(await autoApplyCorporateActions(arg("as-of")));
else if (cmd === "valuations:snapshot") console.log(await recordRun("valuations.daily", () => snapshotValuations(arg("date"))));
else if (cmd === "valuations:backfill") console.log(await recordRun("valuations.daily", () => backfillValuations(arg("from") ?? "2025-09-01", arg("to"), (arg("step") as any) ?? "month")));
else if (cmd === "performance:refresh") console.log(await recordRun("twr.refresh", () => refreshPerformanceCache(arg("as-of"))));
else if (cmd === "reminders:deliver") { const { dispatchReminders } = await import("./lib/delivery.js"); console.log(await dispatchReminders()); }
else if (cmd === "benchmarks:load") { const { ingestBenchmarkSeries } = await import("./lib/feeds.js"); console.log(await recordRun("benchmarks.series", () => ingestBenchmarkSeries(arg("code")!, readFileSync(arg("file")!, "utf8"), arg("name")))); }
else if (cmd === "feeds:run") { const { runFeeds } = await import("./jobs/market.js"); console.log(await runFeeds((arg("which") ?? "eod,indices,tri,series").split(",") as any, undefined, arg("date"))); }
else if (cmd === "feeds:health") { const { feedHealth } = await import("./lib/feeds.js"); console.log(JSON.stringify(await feedHealth(), null, 1)); }
else if (cmd === "aa:sync") { const { syncDueAll } = await import("./lib/aa.js"); console.log(await recordRun("aa.sync", () => syncDueAll())); }
else if (cmd === "prices:stale") console.log(await recordRun("prices.stale", () => stalePriceTasks()));
else if (cmd === "plan:baseline") console.log(await recordRun("plan.baseline", () => refreshBaselines()));
else if (cmd === "tax:optimise") console.log(await recordRun("tax.optimise", () => runOptimiserAll(arg("today"))));
else if (cmd === "policy:evaluate") console.log(await recordRun("policy.compliance", () => runComplianceAll(arg("as-of"))));
else if (cmd === "policy:reviews") console.log(await recordRun("policy.reviews", () => runReviewsAll(arg("today"))));
else if (cmd === "rebalance:needs") console.log(await recordRun("rebalance.needs", () => rebalanceNeedsAll(arg("today"))));
else if (cmd === "rebalance:evaluate") console.log(await recordRun("rebalance.evaluate", () => rebalanceEvaluateAll(arg("today"))));
else if (cmd === "research:run") console.log(await recordRun("research.cluster_assess", () => researchPipelineAll({ poll: rest.includes("--poll") })));
else if (cmd === "research:track-record") console.log(await recordRun("research.track_record", () => researchTrackRecordAll(arg("as-of"))));
else if (cmd === "research:digest") console.log(await recordRun("research.digest", () => researchDigestAll(new Date(), true)));
else if (cmd === "gl:autopost") console.log(await recordRun("gl.autopost", () => glAutopostAll()));
else if (cmd === "reports:run" || cmd === "reports:pack" || cmd === "reports:schedules") {
  const { buildApp } = await import("./server.js"); const { runReport, runPack, runDueSchedules, contextFor } = await import("./lib/reports.js"); const app = buildApp(); await app.ready();
  const fam = arg("family") ?? (await pool.query("select id from families order by created_at limit 1")).rows[0]?.id; const user = arg("user") ?? (await pool.query("select user_id from family_members where family_id=$1 and role='owner' limit 1", [fam])).rows[0]?.user_id;
  if (cmd === "reports:schedules") console.log(await runDueSchedules(app, { force: rest.includes("--force") }));
  else console.log(await withFamilyClient(fam, async (c) => { const ctx = await contextFor(c, fam, user); if (!ctx) throw new Error("no owner context"); if (cmd === "reports:pack") { const r = await runPack(app, c, ctx, arg("pack")!, { period_label: arg("period") }); return { run: r.run.id, version: r.run.version, document: r.document.name, failures: r.failures }; } const r = await runReport(app, c, ctx, arg("code") ?? "net_worth", { entity_id: arg("entity"), fy: arg("fy") }, (arg("format") as any) ?? "pdf"); return { job: r.job.id, document: r.document.name, size: Number(r.document.size) }; }));
  await app.close();
}
else if (cmd === "balance:nightly") { const { balanceNightlyAll } = await import("./jobs/balance.js"); console.log(await recordRun("balance.nightly", () => balanceNightlyAll())); }
else if (cmd === "fmv:load") { const { readFileSync } = await import("node:fs"); const file = arg("file"); if (!file) throw new Error("--file <csv: isin,fmv[,name]> is required"); const fam = arg("family") ?? (await pool.query("select id from families order by created_at limit 1")).rows[0]?.id;
  const rows = readFileSync(file, "utf8").split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !/^isin/i.test(l)).map((l) => { const [isin, fmv] = l.split(/[,;\t]/); return { isin: isin.trim().toUpperCase(), fmv: Number(fmv) }; }).filter((r) => r.fmv > 0);
  console.log(JSON.stringify(await withFamilyClient(fam, async (c) => { let matched = 0, lots = 0; const unknown: string[] = []; for (const r of rows) { const ins = (await c.query("update instruments set meta = coalesce(meta,'{}'::jsonb) || jsonb_build_object('fmv_31jan2018', $2::numeric) where upper(isin)=$1 returning id", [r.isin, r.fmv])).rows; if (!ins.length) { unknown.push(r.isin); continue; } matched++; for (const i of ins) lots += (await c.query("update lots l set grandfathered_fmv=$2 from holdings h where h.id=l.holding_id and h.instrument_id=$1 and l.buy_date < '2018-02-01'", [i.id, r.fmv])).rowCount ?? 0; } return { rows: rows.length, matched, lots_updated: lots, unknown }; }), null, 1)); }
else if (cmd === "exitload:load") { const { readFileSync } = await import("node:fs"); const file = arg("file"); if (!file) throw new Error("--file <csv: isin,pct,days[,note]> is required"); const fam = arg("family") ?? (await pool.query("select id from families order by created_at limit 1")).rows[0]?.id;
  const rows = readFileSync(file, "utf8").split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !/^isin/i.test(l)).map((l) => { const [isin, pct, days, ...note] = l.split(/[,;\t]/); return { isin: isin.trim().toUpperCase(), pct: Number(pct), days: Number(days), note: note.join(",").trim() || null }; }).filter((r) => r.pct >= 0 && Number.isFinite(r.days));
  console.log(JSON.stringify(await withFamilyClient(fam, async (c) => { let matched = 0; const unknown: string[] = []; for (const r of rows) { const ins = (await c.query("update instruments set meta = coalesce(meta,'{}'::jsonb) || jsonb_build_object('exit_load', jsonb_build_object('pct', $2::numeric, 'days', $3::int, 'note', $4::text)) where upper(isin)=$1 returning id", [r.isin, r.pct, r.days, r.note])).rows; if (!ins.length) { unknown.push(r.isin); continue; } matched++; } return { rows: rows.length, matched, unknown }; }), null, 1)); }
else if (cmd === "exports:schedules") { const { runDueExports } = await import("./lib/opendata.js"); console.log(await runDueExports({ force: rest.includes("--force") })); }
else if (cmd === "gl:period-end") { const { periodEndPostings } = await import("./lib/glperiod.js"); const fam = arg("family") ?? (await pool.query("select id from families order by created_at limit 1")).rows[0]?.id; const periodId = arg("period"); if (!periodId) throw new Error("--period <gl_periods.id> is required"); console.log(JSON.stringify(await withFamilyClient(fam, (c) => periodEndPostings(c, fam, periodId, null)), null, 1)); }
else if (cmd === "gl:tally-push" || cmd === "gl:tally-pull") { const { tallyPush, tallyPull } = await import("./lib/tally.js"); const fam = arg("family") ?? (await pool.query("select id from families order by created_at limit 1")).rows[0]?.id; const entity = arg("entity"); const from = arg("from"), to = arg("to"); if (!entity || !from || !to) throw new Error("--entity, --from and --to are required"); const user = (await pool.query("select user_id from family_members where family_id=$1 and role='owner' limit 1", [fam])).rows[0]?.user_id; console.log(JSON.stringify(await withFamilyClient(fam, (c): Promise<unknown> => cmd === "gl:tally-push" ? tallyPush(c, fam, entity, from, to) : tallyPull(c, fam, entity, from, to, user)), null, 1)); }
else if (cmd === "webhooks:deliver") { const { deliverDue } = await import("./lib/opendata.js"); console.log(await deliverDue()); }
else if (cmd === "export") { const { runExport } = await import("./lib/opendata.js"); const fam = arg("family") ?? (await pool.query("select id from families order by created_at limit 1")).rows[0]?.id; const user = (await pool.query("select user_id from family_members where family_id=$1 and role='owner' limit 1", [fam])).rows[0]?.user_id; console.log(await withFamilyClient(fam, (c) => runExport(c, fam, user, { dataset: arg("dataset") ?? "holdings", format: (arg("format") as any) ?? "csv", entity_id: arg("entity") ?? null, from: arg("from") ?? null, to: arg("to") ?? null }))); }
else if (cmd === "gl:recurring") console.log(await recordRun("gl.recurring", () => glRecurringAll(arg("today"))));
else if (cmd === "gl:opening") { const fam = arg("family") ?? (await pool.query("select id from families order by created_at limit 1")).rows[0]?.id; const user = (await pool.query("select user_id from family_members where family_id=$1 and role='owner' limit 1", [fam])).rows[0]?.user_id; console.log(await withFamilyClient(fam, async (c) => { const j = await setOpening(c, fam, arg("entity")!, arg("as-of") ?? "2026-04-01", await generateOpening(c, fam, arg("entity")!, arg("as-of") ?? "2026-04-01"), user, { post: !rest.includes("--draft") }); return { journal: j.journal_no, lines: j.lines.length, status: j.status }; })); }
else console.log(`usage: cli set-password --email x --password y | create-owner --email x --name n [--family f]
  prices:amfi [--file NAVAll.txt] [--load-master] | prices:eod [--file bhav.csv|.zip] [--date yyyy-mm-dd] [--load-master] | prices:indices [--file allIndices.json]
  ca:fetch [--file ca.json] | ca:apply [--as-of d] | valuations:snapshot [--date d] | valuations:backfill --from d [--to d] [--step month|day] | performance:refresh | prices:stale
  balance:nightly | reports:run --code c [--format pdf|xlsx|csv|html] [--entity e] [--fy fy] | reports:pack --pack id [--period p] | reports:schedules [--force] | webhooks:deliver | export --dataset d [--format csv|xlsx|jsonl|parquet]
  fmv:load --file f.csv | exitload:load --file f.csv (isin,pct,days[,note] — overrides the generic 1%/365d equity-fund guess per ISIN)
  plan:baseline | tax:optimise [--today d] | policy:evaluate [--as-of d] | policy:reviews [--today d] | rebalance:needs [--today d] | rebalance:evaluate [--today d] | gl:autopost | gl:recurring [--today d] | gl:opening --entity id [--as-of d] [--draft] | research:run [--poll] | research:track-record [--as-of d] | research:digest`);
await pool.end();
