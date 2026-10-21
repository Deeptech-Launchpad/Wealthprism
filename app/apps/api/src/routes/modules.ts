import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { withFamily, money } from "../lib/db.js";
import { requireFamily, requireRole, verifyStepUp } from "../lib/auth.js";
import { createIntent, tryQueue } from "../lib/actions.js";
import { resolveApprovalNotice } from "../lib/notify.js";

/** Planning, GL, action plane, investment policy, research, rebalancing — read paths and the safety-critical write paths. */
export default async function routes(app: FastifyInstance) {
  app.addHook("preHandler", requireFamily);
  // ---- action plane (safety-critical paths implemented; connectors/executor are separate services) ----
  const PROPOSERS = requireRole("owner", "member", "operator");   // a viewer (e.g. the family's CA) is read-only everywhere else — never lets them raise a proposal either
  app.get("/actions", async (req) => withFamily(req.family!.familyId, async (c) => {
    const q = req.query as any; const params: any[] = []; let w = "where 1=1";
    if (q.status) { params.push(q.status); w += ` and i.status=$${params.length}`; }
    const r = await c.query(`select i.*, e.name as entity_name, u.name as proposed_by_name, (select json_agg(json_build_object('approver_user_id', a.approver_user_id, 'name', au.name, 'decision', a.decision, 'auth_method', a.auth_method, 'decided_at', a.decided_at)) from action_approvals a join users au on au.id=a.approver_user_id where a.intent_id=i.id) as approvals
      from action_intents i join entities e on e.id=i.entity_id left join users u on u.id=i.proposed_by_user_id ${w} order by i.created_at desc limit 200`, params);
    return { items: r.rows, next_cursor: null };
  }));
  app.post("/actions", { preHandler: PROPOSERS }, async (req, reply) => withFamily(req.family!.familyId, async (c) => {
    const b = z.object({ entity_id: z.string().uuid(), kind: z.string(), connector_id: z.string().uuid().optional(), payload: z.record(z.any()), amount: z.coerce.number().positive(), rationale: z.string().optional(), source_type: z.string().optional(), source_id: z.string().uuid().optional(), batch_id: z.string().uuid().optional(), idempotency_key: z.string().optional() }).parse(req.body);
    return createIntent(c, req.family!.familyId, req.user!.id, b);
  }).then((row) => void reply.code(201).send(row)));
  /** Contract: edit a draft / policy_failed intent. Intents are immutable once checked, so the edit cancels the old one and re-creates it with the merged fields (policy re-run). */
  app.patch("/actions/:id", { preHandler: PROPOSERS }, async (req, reply) => {
    const b = z.object({ entity_id: z.string().uuid().optional(), kind: z.string().optional(), connector_id: z.string().uuid().nullable().optional(), payload: z.record(z.any()).optional(), amount: z.coerce.number().positive().optional(), rationale: z.string().nullable().optional() }).parse(req.body);
    return withFamily(req.family!.familyId, async (c) => {
      const cur = (await c.query("select * from action_intents where id=$1 and family_id=$2", [(req.params as any).id, req.family!.familyId])).rows[0]; if (!cur) return void reply.code(404).send({ title: "Intent not found", status: 404 });
      if (!["draft", "policy_failed"].includes(cur.status)) return void reply.code(409).send({ title: `Only draft or policy_failed intents can be edited (this one is ${cur.status})`, status: 409 });
      if (cur.proposed_by_user_id && cur.proposed_by_user_id !== req.user!.id && req.family!.role !== "owner") return void reply.code(403).send({ title: "Only the proposer or an owner can edit this intent", status: 403 });
      await c.query("update action_intents set status='cancelled', updated_at=now() where id=$1", [cur.id]);
      const next = await createIntent(c, req.family!.familyId, req.user!.id, { entity_id: b.entity_id ?? cur.entity_id, kind: b.kind ?? cur.kind, connector_id: b.connector_id === undefined ? cur.connector_id : b.connector_id, payload: { ...(cur.payload ?? {}), ...(b.payload ?? {}), ...(b.amount != null ? { amount: b.amount } : {}) }, amount: b.amount ?? Number(cur.amount), rationale: b.rationale === undefined ? cur.rationale : b.rationale, source_type: cur.source_type, source_id: cur.source_id, batch_id: cur.batch_id, idempotency_key: `${cur.idempotency_key ?? cur.id}:edit:${Date.now()}` });
      await c.query("insert into audit_log (family_id, user_id, action, table_name, row_id, before, after) values ($1,$2,'intent.edit','action_intents',$3,$4,$5)", [req.family!.familyId, req.user!.id, next.id, JSON.stringify({ supersedes: cur.id, status: cur.status }), JSON.stringify({ status: next.status })]);
      return void reply.send({ ...next, supersedes: cur.id });
    });
  });
  app.post("/actions/:id/approve", { preHandler: requireRole("owner", "member") }, async (req, reply) => withFamily(req.family!.familyId, async (c) => {
    const { id } = req.params as any; const b = z.object({ auth_method: z.enum(["totp", "biometric", "passkey"]), auth_proof: z.string(), note: z.string().optional() }).parse(req.body);
    if (!(await verifyStepUp(req.user!.id, b.auth_method, b.auth_proof))) return void reply.code(403).send({ title: "Step-up failed", status: 403 });
    try {
      await c.query("insert into action_approvals (family_id, intent_id, approver_user_id, decision, note, auth_method, ip, user_agent) values ($1,$2,$3,'approved',$4,$5,$6,$7)", [req.family!.familyId, id, req.user!.id, b.note ?? null, b.auth_method, req.ip, req.headers["user-agent"] ?? null]);
    } catch (e: any) { return void reply.code(403).send({ title: e.message, status: 403 }); }
    const it = (await c.query("select approvers_required, (select count(*) from action_approvals a where a.intent_id=$1 and decision='approved') as n from action_intents where id=$1", [id])).rows[0];
    if (Number(it.n) >= Number(it.approvers_required)) {
      await c.query("update action_intents set status='approved' where id=$1", [id]);
      await tryQueue(c, req.family!.familyId, id);   // cooling-off, kill switch or an unopened connector session keep it approved; the worker queues it later
      await resolveApprovalNotice(c, req.family!.familyId, id, "approved", req.user!.name).catch(() => null);
    }
    return (await c.query("select * from action_intents where id=$1", [id])).rows[0];
  }));
  app.post("/actions/:id/reject", { preHandler: requireRole("owner", "member") }, async (req) => withFamily(req.family!.familyId, async (c) => {
    const { id } = req.params as any; const b = z.object({ note: z.string().optional() }).parse(req.body ?? {});
    await c.query("insert into action_approvals (family_id, intent_id, approver_user_id, decision, note, auth_method) values ($1,$2,$3,'rejected',$4,'totp') on conflict do nothing", [req.family!.familyId, id, req.user!.id, b.note ?? null]);
    const r = (await c.query("update action_intents set status='rejected' where id=$1 returning *", [id])).rows[0];
    await resolveApprovalNotice(c, req.family!.familyId, id, "rejected", req.user!.name).catch(() => null);
    return r;
  }));
  app.get("/kill-switch", async (req) => withFamily(req.family!.familyId, async (c) => (await c.query("select * from kill_switches where family_id=$1", [req.family!.familyId])).rows[0] ?? { paused: false }));
  app.post("/kill-switch", { preHandler: requireRole("owner", "member") }, async (req, reply) => withFamily(req.family!.familyId, async (c) => {
    const b = z.object({ paused: z.boolean(), reason: z.string().optional() }).parse(req.body);
    if (!b.paused && req.family!.role !== "owner") return void reply.code(403).send({ title: "Only an owner can resume", status: 403 });
    return (await c.query("insert into kill_switches (family_id, paused, paused_by, paused_at, reason) values ($1,$2,$3,now(),$4) on conflict (family_id) do update set paused=$2, paused_by=$3, paused_at=now(), reason=$4 returning *", [req.family!.familyId, b.paused, req.user!.id, b.reason ?? null])).rows[0];
  }));
  app.get("/oversight", async (req) => withFamily(req.family!.familyId, async (c) => ({
    pending: (await c.query("select id, kind, amount, entity_id, status, created_at, expires_at from action_intents where status='pending_approval' order by created_at")).rows,
    in_flight: (await c.query("select id, kind, amount, status from action_intents where status in ('approved','queued','submitted','partially_filled')")).rows,
    failed_24h: (await c.query("select id, kind, amount, status from action_intents where status='failed' and updated_at > now()-interval '24 hours'")).rows,
    kill_switch: (await c.query("select * from kill_switches where family_id=$1", [req.family!.familyId])).rows[0] ?? { paused: false },
    connectors: (await c.query("select id, provider, label, status, session_expires_at, sandbox, last_health_at, last_error, (select count(*) from action_executions x where x.connector_id=connectors.id and x.status='failed' and x.submitted_at > now()-interval '24 hours') failures_24h from connectors where revoked_at is null order by created_at")).rows,
    limits: (await c.query("select code, intent_kind, params from execution_policies where family_id=$1 and active and code in ('max_single_amount','max_daily_amount','max_monthly_amount','max_orders_per_day')", [req.family!.familyId])).rows,
    used_today: (await c.query("select coalesce(sum(amount),0) amount, count(*) n from action_intents where family_id=$1 and status not in ('draft','policy_failed','rejected','expired','cancelled','failed') and created_at >= date_trunc('day', now())", [req.family!.familyId])).rows[0],
    anomalies: (await c.query(`select i.id, i.kind, i.amount, i.created_at, array_remove(array[
        case when (i.payload->>'payee_id') is not null and exists (select 1 from payees p where p.id::text = i.payload->>'payee_id' and (p.verified_at is null or p.verified_at > now() - interval '1 day')) then 'new_payee' end,
        case when i.amount > 3 * coalesce((select percentile_cont(0.5) within group (order by amount) from action_intents m where m.family_id=i.family_id and m.kind=i.kind and m.id <> i.id and m.created_at > now() - interval '90 days'), i.amount) then 'amount_3x_median' end,
        case when exists (select 1 from action_approvals a where a.intent_id=i.id and a.decided_at < i.created_at + interval '60 seconds') then 'rapid_approve' end,
        case when i.kind='equity_order' and not (extract(dow from i.created_at at time zone 'Asia/Kolkata') between 1 and 5 and (i.created_at at time zone 'Asia/Kolkata')::time between '09:15' and '15:30') then 'off_hours' end,
        case when (select count(*) from action_executions x where x.intent_id=i.id and x.status='failed') >= 2 then 'repeated_failures' end], null) signals
      from action_intents i where i.family_id=$1 and i.created_at > now() - interval '30 days' order by i.created_at desc limit 100`, [req.family!.familyId])).rows.filter((r) => r.signals.length),
    stats_30d: (await c.query("select status, count(*) n, coalesce(sum(amount),0) amount from action_intents where family_id=$1 and created_at > now() - interval '30 days' group by status order by status", [req.family!.familyId])).rows,
    policy_changes: (await c.query("select action, row_id, at, before, after, (select name from users u where u.id=a.user_id) by from audit_log a where a.family_id=$1 and a.action like 'execution_policy.%' order by at desc limit 20", [req.family!.familyId])).rows,
  })));

}
function fyOf(d: string) { const x = new Date(d); const y = x.getMonth() >= 3 ? x.getFullYear() : x.getFullYear() - 1; return `${y}-${String((y + 1) % 100).padStart(2, "0")}`; }
