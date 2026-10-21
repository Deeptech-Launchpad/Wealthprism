// The executor loop (FO-123): jobs first (sessions, health, reads, mandates, bills, cancels, polls), then queued intents —
// kill switch honoured, one intent per connector per pass, connector readiness checked, the execution row written before the
// provider is called so a crash mid-submit resumes by status lookup instead of a second submit.
import type pg from "pg";
import { redact, buildRequest, sessionOk, capabilityFor, assistedInstruction } from "@fo/connectors";
import { pool, withFamily, SANDBOX_ONLY } from "./db.js";
import { credentialsFor } from "./crypto.js";
import { adapterFor, type Ctx } from "./adapters.js";
import { encryptSecret } from "@fo/connectors";
import { fieldKey } from "./crypto.js";

const log = (...a: any[]) => { if (process.env.LOG_LEVEL !== "silent") console.log(new Date().toISOString(), ...a); };
export let lastRunAt: string | null = null;
async function ctxFor(c: pg.PoolClient, familyId: string, connector: any, now?: Date): Promise<Ctx & { adapter: ReturnType<typeof adapterFor>["adapter"] }> {
  const { adapter, sandbox } = adapterFor(connector, SANDBOX_ONLY); const creds = sandbox && connector.provider === "manual" ? {} : await credentialsFor(c, connector.id);
  return { c, familyId, connector, creds, sandbox, now, adapter };
}
async function runJobs(c: pg.PoolClient, familyId: string, now?: Date) {
  let n = 0;
  for (const job of (await c.query("select j.*, (select row_to_json(k) from connectors k where k.id=j.connector_id) connector from connector_jobs j where j.family_id=$1 and j.status='queued' order by j.created_at limit 10 for update of j skip locked", [familyId])).rows) {
    await c.query("update connector_jobs set status='running', started_at=now() where id=$1", [job.id]); n++;
    await c.query("savepoint job");
    try {
      if (!job.connector && !["status_poll", "cancel"].includes(job.kind)) throw new Error("connector missing");
      const x = job.connector ? await ctxFor(c, familyId, job.connector, now) : null; let result: any = {};
      switch (job.kind) {
        case "health": { result = await x!.adapter.health(x!); await c.query("update connectors set last_health_at=now(), last_error=$2, status=(case when $3::boolean and status='error' then 'active' when not $3::boolean and status in ('active','sandbox') and not $4::boolean then 'error' else status::text end)::connector_status where id=$1", [job.connector.id, result.ok ? null : result.detail, result.ok, x!.sandbox]); break; }
        case "session_refresh": { result = await x!.adapter.session(job.payload ?? {}, x!); if (result.access_token) await c.query("insert into connector_credentials (family_id, connector_id, name, ciphertext) values ($1,$2,'access_token',$3) on conflict (connector_id, name) do update set ciphertext=excluded.ciphertext, rotated_at=now()", [familyId, job.connector.id, encryptSecret(result.access_token, fieldKey())]); await c.query("update connectors set status=(case when $3::boolean then 'sandbox' else 'active' end)::connector_status, session_expires_at=$2, last_error=null, last_health_at=now(), account_ref=coalesce($4, account_ref) where id=$1", [job.connector.id, result.expires_at, x!.sandbox, result.account_ref ?? null]); result = { ...result, access_token: undefined, vault: result.access_token ? "access_token stored" : null }; break; }
        case "mf_read": case "positions_read": case "holdings_read": case "balance_read": { result = await x!.adapter.read(job.payload?.what ?? (job.kind === "mf_read" ? "mf_holdings" : job.kind.replace("_read", "")), x!); break; }
        case "mandate_register": case "mandate_status": case "mandate_cancel": {
          const m = (await c.query("select * from nach_mandates where id=$1", [job.payload.mandate_id])).rows[0]; if (!m) throw new Error("mandate not found");
          result = await x!.adapter.mandate(job.kind === "mandate_register" ? "register" : job.kind === "mandate_status" ? "status" : "cancel", m, x!);
          await c.query("update nach_mandates set status=$2, umrn=coalesce($3, umrn), provider_ref=coalesce($4, provider_ref), auth_url=coalesce($5, auth_url), registered_at=case when $2='active' and registered_at is null then now() else registered_at end, last_status_at=now() where id=$1", [m.id, result.status, result.umrn ?? null, result.provider_ref ?? null, result.auth_url ?? null]); break; }
        case "bill_fetch": { result = await x!.adapter.bill(job.payload ?? {}, x!); break; }
        case "beneficiary_register": { result = x!.sandbox ? { status: "registered", beneficiary_ref: `BEN${job.payload.payee_id?.slice(0, 8).toUpperCase()}`, detail: "sandbox: beneficiary registered at the bank" } : { status: "pending", detail: "live beneficiary registration is submitted through the bank's own API; approve it on the bank portal" }; break; }
        case "status_poll": case "cancel": {
          const it = (await c.query("select i.*, (select row_to_json(k) from connectors k where k.id=i.connector_id) connector from action_intents i where i.id=$1", [job.payload.intent_id])).rows[0]; if (!it) throw new Error("intent not found");
          const ex = (await c.query("select * from action_executions where intent_id=$1 order by attempt desc limit 1", [it.id])).rows[0]; const xi = await ctxFor(c, familyId, it.connector, now);
          if (job.kind === "cancel") { result = await xi.adapter.cancel(ex?.client_ref ?? it.idempotency_key, ex?.provider_ref ?? null, xi); if (result.ok && ["queued", "submitted", "partially_filled"].includes(it.status)) await c.query("update action_intents set status='cancelled' where id=$1", [it.id]); if (ex) await c.query("update action_executions set response = coalesce(response,'{}'::jsonb) || jsonb_build_object('cancel', $2::jsonb) where id=$1", [ex.id, JSON.stringify(result.response ?? {})]); }
          else { const r = await xi.adapter.status(ex?.client_ref ?? it.idempotency_key, ex?.provider_ref ?? null, xi); result = r ?? { note: "nothing at the provider" }; if (r && ex) { await c.query("update action_executions set response=$2, status=$3::intent_status, filled_qty=coalesce($4, filled_qty), avg_price=coalesce($5, avg_price), provider_ref=coalesce($6, provider_ref), completed_at=case when $3 in ('filled','failed') then now() else completed_at end where id=$1", [ex.id, JSON.stringify(r.response), r.status, r.filled_qty ?? null, r.avg_price ?? null, r.provider_ref]); if (r.status !== it.status && ["filled", "failed", "partially_filled"].includes(r.status) && ["submitted", "partially_filled"].includes(it.status)) await c.query("update action_intents set status=$2::intent_status where id=$1", [it.id, r.status]); } }
          break; }
        default: throw new Error(`unknown job kind ${job.kind}`);
      }
      await c.query("update connector_jobs set status='done', result=$2, finished_at=now() where id=$1", [job.id, JSON.stringify(redact(result))]); await c.query("release savepoint job");
    } catch (e: any) { await c.query("rollback to savepoint job"); await c.query("update connector_jobs set status='failed', error=$2, finished_at=now() where id=$1", [job.id, String(e.message ?? e).slice(0, 500)]); console.error("executor job failed", job.kind, e.message ?? e); }
  }
  return n;
}
async function runIntents(c: pg.PoolClient, familyId: string, now?: Date) {
  const busy = new Set<string>(); let n = 0;
  for (const intent of (await c.query("select i.*, (select row_to_json(k) from connectors k where k.id=i.connector_id) as connector from action_intents i where i.family_id=$1 and i.status='queued' order by i.created_at limit 5 for update of i skip locked", [familyId])).rows) {
    if (!intent.connector) { await c.query("update action_intents set status='failed' where id=$1", [intent.id]); log("no connector attached", intent.id); continue; }
    if (busy.has(intent.connector.id)) continue; busy.add(intent.connector.id);   // single-flight per connector
    const x = await ctxFor(c, familyId, intent.connector, now);
    if (!x.sandbox && !sessionOk(intent.connector)) { log("connector not ready", intent.connector.label, intent.id); continue; }   // stays queued; the API raised the login task
    const clientRef = intent.idempotency_key; const last = (await c.query("select * from action_executions where intent_id=$1 order by attempt desc limit 1", [intent.id])).rows[0];
    const capability = capabilityFor(intent.connector.provider, intent.kind); const route = intent.route ?? (capability === "executable" ? "executable" : "assisted");
    const request = route === "assisted" ? { method: "MANUAL", instruction: assistedInstruction(intent.kind, { ...intent.payload, client_ref: clientRef }) } : buildRequest(intent.connector.provider, intent.kind, intent.payload, { connector: intent.connector, client_ref: clientRef, sandbox: x.sandbox });   // placeholders only — credentials are substituted at send time and never written
    let exId: string; let attempt: number;
    if (last && last.status === "submitted" && last.response == null) { exId = last.id; attempt = last.attempt; log("recovering interrupted submit", intent.id, clientRef); }   // crash between the insert and the provider's answer
    else { attempt = Number(last?.attempt ?? 0) + 1; exId = (await c.query("insert into action_executions (family_id, intent_id, attempt, connector_id, request, status, client_ref) values ($1,$2,$3,$4,$5,'submitted',$6) returning id", [familyId, intent.id, attempt, intent.connector.id, JSON.stringify({ kind: intent.kind, route, idempotency_key: clientRef, provider_request: request }), clientRef])).rows[0].id; }
    await c.query("update action_intents set status='submitted', route=$2 where id=$1", [intent.id, route]);
    await c.query("savepoint intent");
    try {
      const recovered = last && last.id === exId ? await x.adapter.status(clientRef, last.provider_ref, x) : null;   // if the provider already has it, never submit twice
      const r = recovered ?? (route === "assisted" ? { provider_ref: `ASSISTED-${clientRef.slice(0, 10)}`, status: "submitted" as const, response: { assisted: true, instruction: (request as any).instruction } } : await x.adapter.submit(intent.kind, { ...intent.payload, client_ref: clientRef }, clientRef, x));
      await c.query("update action_executions set response=$2, provider_ref=$3, status=$4::intent_status, filled_qty=$5, avg_price=$6, fees=$7, error=$8, completed_at=case when $4 in ('filled','failed') then now() else null end where id=$1", [exId, JSON.stringify(redact({ ...(r.response ?? {}), ...(r.message ? { note: r.message } : {}) })), r.provider_ref, r.status, r.filled_qty ?? null, r.avg_price ?? null, r.fees ?? null, r.status === "failed" ? (r.message ?? "provider rejected") : null]);
      if (r.status !== "submitted") await c.query("update action_intents set status=$2::intent_status where id=$1", [intent.id, r.status]);
      await c.query("release savepoint intent"); log(recovered ? "recovered" : "executed", intent.id, intent.kind, route, r.status, r.provider_ref);
    } catch (e: any) {
      await c.query("rollback to savepoint intent"); console.error("executor submit failed", intent.id, e.message ?? e);
      await c.query("update action_executions set status='failed', error=$2, completed_at=now(), response=coalesce(response,'{}'::jsonb) where id=$1", [exId, String(e.message ?? e).slice(0, 500)]);
      await c.query("update action_intents set status='failed' where id=$1", [intent.id]);
    }
    n++;
  }
  return n;
}
/** Re-checks orders already sent to an executable connector that are still waiting on the provider's own confirmation
 *  (MF allotment, trade settlement) — without this, "submitted" never moves to "filled" on its own; someone has to
 *  remember to click Poll. Assisted-route intents are skipped: those wait on a human to confirm, not the provider. */
async function repollSubmitted(c: pg.PoolClient, familyId: string, now?: Date) {
  let n = 0;
  for (const intent of (await c.query(`select i.*, (select row_to_json(k) from connectors k where k.id=i.connector_id) as connector from action_intents i
      where i.family_id=$1 and i.status in ('submitted','partially_filled') and i.route='executable' order by i.updated_at limit 10 for update of i skip locked`, [familyId])).rows) {
    if (!intent.connector) continue;
    const ex = (await c.query("select * from action_executions where intent_id=$1 order by attempt desc limit 1", [intent.id])).rows[0]; if (!ex) continue;
    const x = await ctxFor(c, familyId, intent.connector, now);
    await c.query("savepoint poll");
    try {
      const r = await x.adapter.status(ex.client_ref, ex.provider_ref, x);
      if (r) {
        await c.query("update action_executions set response=$2, status=$3::intent_status, filled_qty=coalesce($4, filled_qty), avg_price=coalesce($5, avg_price), provider_ref=coalesce($6, provider_ref), completed_at=case when $3 in ('filled','failed') then now() else completed_at end where id=$1", [ex.id, JSON.stringify(redact(r.response ?? {})), r.status, r.filled_qty ?? null, r.avg_price ?? null, r.provider_ref]);
        if (r.status !== intent.status && ["filled", "failed", "partially_filled"].includes(r.status)) { await c.query("update action_intents set status=$2::intent_status where id=$1", [intent.id, r.status]); n++; log("auto-polled", intent.id, intent.kind, r.status); }
      }
      await c.query("release savepoint poll");
    } catch (e: any) { await c.query("rollback to savepoint poll"); console.error("executor auto-poll failed", intent.id, e.message ?? e); }
  }
  return n;
}
/** One pass over every family. Returns counts; safe to call from tests. */
export async function runOnce(opts: { now?: Date; familyId?: string } = {}) {
  let jobs = 0, intents = 0, paused = 0, polled = 0;
  for (const { id } of (await pool.query(opts.familyId ? "select id from families where id=$1" : "select id from families", opts.familyId ? [opts.familyId] : [])).rows) {
    await withFamily(id, async (c) => {
      jobs += await runJobs(c, id, opts.now);
      polled += await repollSubmitted(c, id, opts.now);   // checking on what's already out doesn't move new money, so it runs even while paused
      const ks = (await c.query("select paused from kill_switches where family_id=$1", [id])).rows[0];
      if (ks?.paused) { paused++; return; }   // queued intents stay queued while the switch is on
      intents += await runIntents(c, id, opts.now);
    }).catch((e) => console.error("executor", id, e.message ?? e));
  }
  lastRunAt = new Date().toISOString();
  return { jobs, intents, paused, polled };
}
