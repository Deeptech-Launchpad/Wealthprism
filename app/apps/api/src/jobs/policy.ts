// Nightly policy jobs (FO-143/144/145): risk metrics + compliance per active version, then scheduled and trigger reviews.
import type pg from "pg";
import { pool } from "../lib/db.js";
import { withFamilyClient } from "./market.js";
import { evaluatePolicy, effectiveFor, iso } from "../lib/policy.js";
import { notifyTask } from "../lib/notify.js";

const today = () => new Date().toISOString().slice(0, 10);
const addDays = (d: string, n: number) => new Date(Date.parse(d) + n * 86400000).toISOString().slice(0, 10);
const addMonths = (d: string, m: number) => { const x = new Date(d + "T00:00:00Z"); x.setUTCMonth(x.getUTCMonth() + m); return x.toISOString().slice(0, 10); };

export async function runCompliance(c: pg.PoolClient, familyId: string, asOf = today()) {
  const policies = (await c.query("select id from investment_policies where deleted_at is null and current_version_id is not null order by scope, created_at")).rows;
  let breach = 0, warning = 0, compliant = 0; const results: any[] = [];
  for (const p of policies) { const r = await evaluatePolicy(c, familyId, p.id, { asOf, persist: true }); if (!r) continue; results.push({ policy_id: p.id, overall: r.compliance.overall }); if (r.compliance.overall === "breach") breach++; else if (r.compliance.overall === "warning") warning++; else compliant++; }
  return { rows: results.length, note: `${compliant} compliant · ${warning} warning · ${breach} breach`, results };
}
export async function runComplianceAll(asOf?: string) {
  let n = 0, note: string[] = [];
  for (const f of (await pool.query("select id from families")).rows) await withFamilyClient(f.id, async (c) => { const r = await runCompliance(c, f.id, asOf); n += r.rows; note.push(r.note); });
  return { rows: n, note: note.join(" | ") };
}

/** Scheduled reviews 30 days ahead of next_review_on; trigger reviews on a breach persisting 30 days, a drawdown beyond the clause,
 *  a goal change, or a new entity since the version took effect. Each open review carries a task. Findings are pre-filled. */
export async function runReviews(c: pg.PoolClient, familyId: string, day = today(), opts: { notify?: boolean } = {}) {
  const policies = (await c.query("select p.*, v.effective_from, v.risk, g.name goal_name from investment_policies p join policy_versions v on v.id=p.current_version_id left join goals g on g.id=p.goal_id where p.deleted_at is null")).rows;
  let opened = 0; const openedRows: any[] = [];
  const open = async (p: any, kind: "scheduled" | "trigger", reason: string, dueOn: string, title: string) => {
    const exists = (await c.query("select 1 from policy_reviews where policy_id=$1 and status in ('due','in_progress') and kind=$2::review_kind and trigger_reason=$3", [p.id, kind, reason])).rowCount;
    if (exists) return;
    const findings = await reviewFindings(c, familyId, p, day);
    const r = (await c.query("insert into policy_reviews (family_id, policy_id, kind, trigger_reason, due_on, status, findings) values ($1,$2,$3::review_kind,$4,$5,'due',$6) returning *", [familyId, p.id, kind, reason, dueOn, JSON.stringify(findings)])).rows[0];
    const t = (await c.query("insert into tasks (family_id, entity_id, module, title, reason, due_date, severity, source_type, source_id, verification) values ($1,$2,'policy',$3,$4,$5,$6,'policy_review',$7,'na') returning *", [familyId, p.entity_id ?? null, title, findings.summary, dueOn, kind === "trigger" ? 2 : 3, r.id])).rows[0];
    await c.query("update policy_reviews set task_id=$2 where id=$1", [r.id, t.id]); if (opts.notify !== false) await notifyTask(c, t);
    opened++; openedRows.push({ ...r, due_on: iso(r.due_on), task_id: t.id });
  };
  for (const p of policies) {
    if (p.next_review_on && iso(p.next_review_on)! <= addDays(day, 30)) await open(p, "scheduled", "scheduled", iso(p.next_review_on)!, `${p.name}: ${p.review_every_months <= 3 ? "quarterly" : p.review_every_months <= 6 ? "half-yearly" : "annual"} policy review`);
    // breach persisting: every snapshot in the last 30 days is a breach and the streak started ≥ 30 days ago
    const snaps = (await c.query("select as_of, overall from policy_compliance where policy_version_id=$1 and as_of >= $2 order by as_of", [p.current_version_id, addDays(day, -45)])).rows;
    const recent = snaps.filter((s) => iso(s.as_of)! >= addDays(day, -30));
    if (recent.length >= 2 && recent.every((s) => s.overall === "breach") && iso(recent[0].as_of)! <= addDays(day, -30)) await open(p, "trigger", "breach_persisting", day, `${p.name}: breach persisting 30 days`);
    const dd = (await c.query("select value from risk_metrics where family_id=$1 and scope_type=$2::scope_type and scope_id=$3 and metric='max_drawdown' order by as_of desc limit 1", [familyId, p.scope === "goal" ? "goal" : p.scope === "entity" ? "entity" : "family", p.goal_id ?? p.entity_id ?? familyId])).rows[0];
    if (dd && p.risk?.max_drawdown_pct != null && Number(dd.value) < Number(p.risk.max_drawdown_pct)) await open(p, "trigger", "market_move", day, `${p.name}: drawdown ${Number(dd.value).toFixed(1)}% beyond the ${p.risk.max_drawdown_pct}% clause`);
    if (p.goal_id) { const ch = (await c.query("select 1 from audit_log where family_id=$1 and table_name='goals' and row_id=$2 and at > greatest($3::timestamptz, coalesce((select max(coalesce(completed_at, started_at, due_on::timestamptz)) from policy_reviews where policy_id=$4), '1970-01-01'::timestamptz)) limit 1", [familyId, p.goal_id, p.effective_from ?? "1970-01-01", p.id])).rowCount; if (ch) await open(p, "trigger", "goal_change", day, `${p.name}: goal changed since the policy took effect`); }
    if (p.scope === "family") { const ne = (await c.query("select name from entities where deleted_at is null and created_at > $1::date and created_at > coalesce((select max(coalesce(completed_at, started_at)) from policy_reviews where policy_id=$2), '1970-01-01'::timestamptz)", [p.effective_from ?? "1970-01-01", p.id])).rows; if (ne.length) await open(p, "trigger", "new_entity", day, `${p.name}: new entity ${ne.map((e) => e.name).join(", ")} — extend the policy`); }
  }
  return { rows: opened, note: `${opened} reviews opened`, reviews: openedRows };
}
export async function runReviewsAll(day?: string) {
  let n = 0;
  for (const f of (await pool.query("select id from families")).rows) await withFamilyClient(f.id, async (c) => { n += (await runReviews(c, f.id, day)).rows; });
  return { rows: n, note: `${n} reviews opened` };
}
/** Pre-filled findings: compliance history, drift, metric trends, goal progress, life events since the last review. */
export async function reviewFindings(c: pg.PoolClient, familyId: string, p: any, day = today()) {
  const since = iso((await c.query("select max(coalesce(completed_at, started_at)) t from policy_reviews where policy_id=$1 and status='completed'", [p.id])).rows[0].t) ?? addMonths(day, -12);
  const hist = (await c.query("select as_of, overall, breaches, warnings, checks from policy_compliance where policy_version_id=$1 and as_of >= $2 order by as_of", [p.current_version_id, since])).rows;
  const last = hist[hist.length - 1];
  const scope = p.scope === "goal" ? ["goal", p.goal_id] : p.scope === "entity" ? ["entity", p.entity_id] : ["family", familyId];
  const metrics = (await c.query("select metric, min(as_of) first_on, max(as_of) last_on, (array_agg(value order by as_of))[1] first, (array_agg(value order by as_of desc))[1] last from risk_metrics where family_id=$1 and scope_type=$2::scope_type and scope_id=$3 and as_of >= $4 group by metric", [familyId, scope[0], scope[1], since])).rows;
  const goal = p.goal_id ? (await c.query("select name, target_year, amount_today, funded_pct from goals where id=$1", [p.goal_id])).rows[0] : null;
  const events = (await c.query("select table_name, action, at from audit_log where family_id=$1 and at >= $2 and table_name in ('goals','entities','properties','liabilities','private_investments') order by at desc limit 20", [familyId, since])).rows;
  const newEntities = (await c.query("select name, created_at from entities where deleted_at is null and created_at >= $1", [since])).rows;
  const breachDays = hist.filter((h) => h.overall === "breach").length, months = Math.max(1, Math.round((Date.parse(day) - Date.parse(since)) / (30.44 * 86400000)));
  const { clauses } = await effectiveFor(c, p);
  const summary = [`${hist.length ? `${hist.length - breachDays} of ${hist.length} snapshots compliant over ${months} month${months === 1 ? "" : "s"}` : "no compliance snapshots yet"}`, last ? `latest ${last.overall} (${last.breaches} breach, ${last.warnings} warning)` : null, goal ? `goal ${goal.name} ${goal.funded_pct ?? "—"}% funded` : null, newEntities.length ? `${newEntities.length} new entit${newEntities.length === 1 ? "y" : "ies"}` : null].filter(Boolean).join(" · ");
  return { since, summary, compliance_history: hist.map((h) => ({ as_of: iso(h.as_of), overall: h.overall, breaches: h.breaches, warnings: h.warnings })),
    drift: last ? (last.checks as any[]).filter((x) => x.kind === "allocation").map((x) => ({ key: x.key, target: x.target, actual: x.actual, status: x.status })) : [],
    metric_trends: metrics.map((m) => ({ metric: m.metric, first: Number(m.first), last: Number(m.last), first_on: iso(m.first_on), last_on: iso(m.last_on) })),
    goal_progress: goal ? { name: goal.name, target_year: goal.target_year, amount_today: Number(goal.amount_today), funded_pct: goal.funded_pct == null ? null : Number(goal.funded_pct) } : null,
    life_events: [...newEntities.map((e) => ({ kind: "new_entity", what: e.name, at: e.created_at })), ...events.map((e) => ({ kind: `${e.table_name}.${e.action}`, what: e.table_name, at: e.at }))],
    objective: clauses.objectives ?? {}, next_review_on: iso(p.next_review_on) };
}
