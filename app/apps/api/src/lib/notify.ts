/** Notifications: in-app inbox rows for every family member, Expo push for urgent tasks, and the daily e-mail digest.
 *  Delivery adapters are injectable; without credentials they log, so nothing is silently lost in dev. */
import type pg from "pg";
import { pool } from "./db.js";
import { emitEvent } from "./opendata.js";

export interface TaskLike { id: string; family_id: string; module: string; title: string; reason?: string | null; severity: number; due_date?: string | Date | null; amount?: string | number | null; entity_id?: string | null }
export type PushSender = (messages: { to: string; title: string; body: string; data: Record<string, unknown> }[]) => Promise<{ ok: number; failed: number }>;
export type EmailSender = (to: string, subject: string, text: string) => Promise<boolean>;

/** Expo push service; tokens that Expo reports as unregistered are dropped. */
export const expoPush: PushSender = async (messages) => {
  if (!messages.length) return { ok: 0, failed: 0 };
  const r = await fetch(process.env.EXPO_PUSH_URL ?? "https://exp.host/--/api/v2/push/send", { method: "POST", headers: { "content-type": "application/json", accept: "application/json", ...(process.env.EXPO_ACCESS_TOKEN ? { authorization: `Bearer ${process.env.EXPO_ACCESS_TOKEN}` } : {}) }, body: JSON.stringify(messages.map((m) => ({ ...m, sound: "default", priority: "high" }))) });
  if (!r.ok) return { ok: 0, failed: messages.length };
  const j: any = await r.json().catch(() => ({}));
  let ok = 0, failed = 0;
  for (const [i, t] of (j.data ?? []).entries()) {
    if (t.status === "ok") ok++; else { failed++; if (t.details?.error === "DeviceNotRegistered") await pool.query("delete from user_devices where push_token=$1", [messages[i].to]); }
  }
  return { ok, failed };
};
/** No mail provider is wired yet: the digest is stored on the inbox and logged; plug SES/SMTP in here. */
export const logEmail: EmailSender = async (to, subject) => { if (process.env.LOG_LEVEL !== "silent") console.log(`[email] to=${to} subject="${subject}"`); return process.env.EMAIL_TRANSPORT === "log"; };

let pushSender: PushSender = expoPush, emailSender: EmailSender = logEmail;
/** Send one e-mail through the configured adapter (reports, packs, exports). */
export const sendEmail = (to: string, subject: string, text: string) => emailSender(to, subject, text);
export function setSenders(s: { push?: PushSender; email?: EmailSender }) { if (s.push) pushSender = s.push; if (s.email) emailSender = s.email; }

const fmtAmt = (v: any) => (v == null ? "" : ` · ₹${Number(v).toLocaleString("en-IN", { maximumFractionDigits: 0 })}`);
const fmtDue = (d: any) => (d ? ` · due ${new Date(d).toLocaleDateString("en-IN", { day: "2-digit", month: "short" })}` : "");

/** Fan a new task out to the family's members: inbox row for everyone who wants it, push where the severity qualifies.
 *  Runs inside the caller's family transaction so the inbox commits with the task. */
export async function notifyTask(c: pg.PoolClient, task: TaskLike, opts: { push?: boolean } = { push: true }) {
  await emitEvent(c, task.family_id, "task.created", { task_id: task.id, module: task.module, title: task.title, severity: task.severity, due_date: task.due_date ?? null, amount: task.amount ?? null, entity_id: task.entity_id ?? null }).catch(() => null);   // open-data webhooks (FO-104)
  const members = (await c.query(`select u.id, u.email, u.name, coalesce(p.inapp, true) inapp, coalesce(p.push_min_severity, 1) push_min
      from family_members fm join users u on u.id=fm.user_id left join notification_prefs p on p.user_id=u.id where fm.family_id=$1 and fm.accepted_at is not null`, [task.family_id])).rows;
  const body = `${task.reason ?? ""}${fmtAmt(task.amount)}${fmtDue(task.due_date)}`.replace(/^ · /, "");
  const pushes: { to: string; title: string; body: string; data: Record<string, unknown> }[] = [];
  for (const m of members) {
    if (m.inapp) await c.query("insert into notifications (user_id, family_id, task_id, channel, title, body, payload, sent_at) values ($1,$2,$3,'inapp',$4,$5,$6,now())", [m.id, task.family_id, task.id, task.title, body, JSON.stringify({ module: task.module, severity: task.severity, task_id: task.id })]);
    if (opts.push && task.severity <= Number(m.push_min)) {
      const devices = (await c.query("select push_token from user_devices where user_id=$1", [m.id])).rows;
      for (const d of devices) pushes.push({ to: d.push_token, title: task.title, body, data: { task_id: task.id, module: task.module, family_id: task.family_id } });
      if (devices.length) await c.query("insert into notifications (user_id, family_id, task_id, channel, title, body, payload) values ($1,$2,$3,'push',$4,$5,$6)", [m.id, task.family_id, task.id, task.title, body, JSON.stringify({ devices: devices.length })]);
    }
  }
  if (pushes.length) {
    const r = await pushSender(pushes).catch(() => ({ ok: 0, failed: pushes.length }));
    await c.query("update notifications set sent_at = now() where task_id=$1 and channel='push' and sent_at is null", [task.id]);
    return { inbox: members.filter((m) => m.inapp).length, push: r };
  }
  return { inbox: members.filter((m) => m.inapp).length, push: { ok: 0, failed: 0 } };
}

/** Fan a new action-plane proposal out to whoever can actually approve it (owner/member, never the proposer —
 *  four-eyes means they couldn't act on it anyway). Without this, a pending approval was invisible until someone
 *  happened to open the Approvals tab — including through its own 24-hour expiry window. */
export async function notifyApproval(c: pg.PoolClient, intent: { id: string; family_id: string; kind: string; amount: number | string; entity_name?: string | null; proposed_by_user_id?: string | null }, opts: { push?: boolean } = { push: true }) {
  const approvers = (await c.query(`select u.id, u.name, coalesce(p.inapp, true) inapp, coalesce(p.push_min_severity, 1) push_min
      from family_members fm join users u on u.id=fm.user_id left join notification_prefs p on p.user_id=u.id
      where fm.family_id=$1 and fm.accepted_at is not null and fm.role in ('owner','member') and u.id is distinct from $2`, [intent.family_id, intent.proposed_by_user_id ?? null])).rows;
  const title = `Approval needed: ${intent.kind.replace(/_/g, " ")}`;
  const body = `₹${Number(intent.amount).toLocaleString("en-IN")}${intent.entity_name ? ` · ${intent.entity_name}` : ""} · expires in 24 h`;
  const pushes: { to: string; title: string; body: string; data: Record<string, unknown> }[] = [];
  for (const m of approvers) {
    if (m.inapp) await c.query("insert into notifications (user_id, family_id, channel, title, body, payload, sent_at) values ($1,$2,'inapp',$3,$4,$5,now())", [m.id, intent.family_id, title, body, JSON.stringify({ module: "actions", intent_id: intent.id, severity: 1 })]);
    if (opts.push && 1 <= Number(m.push_min)) {
      const devices = (await c.query("select push_token from user_devices where user_id=$1", [m.id])).rows;
      for (const d of devices) pushes.push({ to: d.push_token, title, body, data: { intent_id: intent.id, module: "actions", family_id: intent.family_id } });
      if (devices.length) await c.query("insert into notifications (user_id, family_id, channel, title, body, payload) values ($1,$2,'push',$3,$4,$5)", [m.id, intent.family_id, title, body, JSON.stringify({ devices: devices.length })]);
    }
  }
  if (pushes.length) {
    const r = await pushSender(pushes).catch(() => ({ ok: 0, failed: pushes.length }));
    await c.query("update notifications set sent_at = now() where family_id=$1 and payload->>'intent_id'=$2 and channel='push' and sent_at is null", [intent.family_id, intent.id]);
    return { inbox: approvers.filter((m) => m.inapp).length, push: r };
  }
  return { inbox: approvers.filter((m) => m.inapp).length, push: { ok: 0, failed: 0 } };
}
/** Rewrites every "Approval needed" notice already sent for this intent once it's decided, so the inbox never keeps
 *  telling someone something is still waiting on them after it's actually been approved, rejected or expired. */
export async function resolveApprovalNotice(c: pg.PoolClient, familyId: string, intentId: string, outcome: "approved" | "rejected" | "expired", by?: string | null) {
  const word = outcome === "approved" ? "Approved" : outcome === "rejected" ? "Rejected" : "Expired";
  const suffix = ` · ${word.toLowerCase()}${by ? ` by ${by}` : ""}`;
  await c.query(`update notifications set title=regexp_replace(title, '^Approval needed', $3), body=body || $4
      where family_id=$1 and payload->>'intent_id'=$2 and channel='inapp' and title like 'Approval needed%'`,
    [familyId, intentId, word, suffix]);
}
/** Daily digest: open tasks grouped by module, per user across their families. Returns the digests built. */
export async function sendDigests(now = new Date()) {
  const due = (await pool.query(`select u.id, u.email, u.name, coalesce(p.email_digest,'daily') cadence, p.last_digest_at from users u left join notification_prefs p on p.user_id=u.id
      where coalesce(p.email_digest,'daily') <> 'off' and (p.last_digest_at is null or p.last_digest_at < $1::timestamptz - case when coalesce(p.email_digest,'daily')='weekly' then interval '6 days 20 hours' else interval '20 hours' end)`, [now.toISOString()])).rows;
  const out: { user: string; families: number; tasks: number; sent: boolean }[] = [];
  for (const u of due) {
    const fams = (await pool.query("select id, name from user_families($1)", [u.id])).rows; // security definer: no family context needed
    const lines: string[] = []; let total = 0;
    for (const f of fams) {
      const c = await pool.connect();
      try {
        await c.query("begin"); await c.query("select set_config('app.family_id',$1,true)", [f.id]);
        const tasks = (await c.query("select module, title, severity, due_date, amount from tasks where status='open' order by module, severity, due_date nulls last")).rows;
        await c.query("commit");
        if (!tasks.length) continue;
        lines.push(`${f.name} — ${tasks.length} open`);
        let mod = "";
        for (const t of tasks) { if (t.module !== mod) { mod = t.module; lines.push(`  [${mod}]`); } lines.push(`   ${"!".repeat(4 - Math.min(3, t.severity))} ${t.title}${fmtAmt(t.amount)}${fmtDue(t.due_date)}`); total += 1; }
      } catch (e) { await c.query("rollback"); throw e; } finally { c.release(); }
    }
    if (!total) { await pool.query("insert into notification_prefs (user_id, last_digest_at) values ($1,$2) on conflict (user_id) do update set last_digest_at = excluded.last_digest_at", [u.id, now.toISOString()]); continue; }
    const subject = `WealthPrism digest: ${total} open task${total === 1 ? "" : "s"}`;
    const text = `Hello ${u.name},\n\n${lines.join("\n")}\n\nOpen the Tasks inbox to act on them.`;
    const sent = await emailSender(u.email, subject, text).catch(() => false);
    await pool.query("insert into notifications (user_id, channel, title, body, payload, sent_at) values ($1,'email',$2,$3,$4,$5)", [u.id, subject, text, JSON.stringify({ digest: true, tasks: total, cadence: u.cadence }), sent ? now.toISOString() : null]);
    await pool.query("insert into notification_prefs (user_id, last_digest_at) values ($1,$2) on conflict (user_id) do update set last_digest_at = excluded.last_digest_at", [u.id, now.toISOString()]);
    out.push({ user: u.email, families: fams.length, tasks: total, sent });
  }
  return out;
}
