// Action-plane intent creation shared by POST /actions, research proposal conversion, rebalancing and any other proposer.
// The proposer never approves: the intent lands in pending_approval (or policy_failed) and the approval routes,
// step-up and four-eyes rules in db/008 take over from there. Connector routing and the 14 policy codes live here.
import type pg from "pg";
import { intentPolicyCheck } from "./policy.js";
import { validatePayload, routeFor, tradingWindow, capabilityFor, payeeCheck, mandateFor, loginTask } from "./connectors.js";
import { notifyTask, notifyApproval } from "./notify.js";

export interface IntentInput { entity_id: string; kind: string; connector_id?: string | null; payload: Record<string, any>; amount: number; rationale?: string | null; source_type?: string | null; source_id?: string | null; batch_id?: string | null; idempotency_key?: string | null; proposed_by_kind?: string }
const MONEY_KINDS = ["equity_order", "mf_purchase", "mf_redemption", "mf_switch", "mf_sip_mandate", "bank_transfer", "bill_payment", "tax_payment", "gst_payment", "capital_call_payment"];
export async function createIntent(c: pg.PoolClient, familyId: string, userId: string, b: IntentInput) {
  const payload: Record<string, any> = { ...(b.payload ?? {}) };
  if (payload.amount == null && b.amount != null) payload.amount = Number(b.amount);   // the intent's amount is canonical; the provider payload carries the same figure
  // enrich the payload with the instrument / payee the executor will name in the provider request (no free-text amounts or payees)
  const instKey = payload.instrument_id ? ["id", payload.instrument_id] : payload.isin ? ["isin", payload.isin] : payload.amfi_code ? ["amfi_code", payload.amfi_code] : payload.symbol ? ["symbol", payload.symbol] : null;
  const inst = instKey ? (await c.query(`select i.id, i.name, i.symbol, i.isin, i.amfi_code, i.type, i.asset_class, (select close from prices p where p.instrument_id=i.id order by price_date desc limit 1) price from instruments i where i.${instKey[0]}=$1`, [instKey[1]])).rows[0] : null;
  if (inst) { payload.instrument_id = inst.id; payload.instrument = { id: inst.id, name: inst.name, symbol: inst.symbol, isin: inst.isin, amfi_code: inst.amfi_code, type: inst.type }; if (inst.price) { payload.price_ref = Number(inst.price); payload.nav_ref = Number(inst.price); } if (b.kind === "equity_order" && !payload.quantity && payload.amount && inst.price) payload.quantity = Math.max(1, Math.floor(Number(payload.amount) / Number(inst.price))); }
  // policy check: tiers and caps from execution_policies (family defaults if none)
  const pol = (await c.query("select code, params, intent_kind from execution_policies where active and (entity_id is null or entity_id=$1) and (intent_kind is null or intent_kind=$2::intent_kind)", [b.entity_id, b.kind])).rows;
  const checks: any[] = []; let approvers = 1; let cooling: Date | null = null; let fail = false; const warnings: string[] = [];
  const schemaErrors = validatePayload(b.kind, payload); checks.push({ code: "payload_schema", pass: !schemaErrors.length, detail: schemaErrors.length ? `does not match the ${b.kind} schema: ${schemaErrors.join("; ")}` : `valid ${b.kind} payload` }); fail ||= schemaErrors.length > 0;
  for (const p of pol) {
    if (p.code === "max_single_amount") { const ok = b.amount <= Number(p.params.amount); checks.push({ code: p.code, pass: ok, limit: p.params.amount, detail: ok ? undefined : `₹${b.amount.toLocaleString("en-IN")} proposed, max ₹${Number(p.params.amount).toLocaleString("en-IN")} per transaction` }); fail ||= !ok; }
    if (p.code === "approvers_required" && (!p.params.above || b.amount > Number(p.params.above))) approvers = Math.max(approvers, Number(p.params.count));
    if (p.code === "cooling_off_minutes" && b.amount > Number(p.params.above ?? 0)) cooling = new Date(Date.now() + Number(p.params.minutes) * 60000);
    if (p.code === "max_daily_amount" || p.code === "max_monthly_amount") { const win = p.code === "max_daily_amount" ? "day" : "month"; const used = Number((await c.query("select coalesce(sum(amount),0) v from action_intents where family_id=$1 and entity_id=$2 and ($3::intent_kind is null or kind=$3::intent_kind) and status not in ('draft','policy_failed','rejected','expired','cancelled','failed') and created_at >= date_trunc($4, now())", [familyId, b.entity_id, p.intent_kind ?? null, win])).rows[0].v); const ok = used + b.amount <= Number(p.params.amount); checks.push({ code: p.code, pass: ok, limit: p.params.amount, used, detail: `₹${used.toLocaleString("en-IN")} used this ${win} of ₹${Number(p.params.amount).toLocaleString("en-IN")}` }); fail ||= !ok; }
    if (p.code === "max_orders_per_day" && MONEY_KINDS.includes(b.kind)) { const n = Number((await c.query("select count(*) n from action_intents where family_id=$1 and status not in ('draft','policy_failed','rejected','cancelled') and created_at >= date_trunc('day', now())", [familyId])).rows[0].n); const ok = n < Number(p.params.count); checks.push({ code: p.code, pass: ok, limit: p.params.count, used: n }); fail ||= !ok; }
    if (p.code === "trading_hours_only" && b.kind === "equity_order") { const w = tradingWindow(); if (!w.open) { if (p.params?.queue_at_next_open !== false) { cooling = cooling && cooling > w.next_open ? cooling : w.next_open; checks.push({ code: p.code, pass: true, detail: `market closed — queued for ${w.next_open.toISOString()} (09:15 IST next session)` }); } else { checks.push({ code: p.code, pass: false, detail: "outside 09:15–15:30 IST" }); fail = true; } } else checks.push({ code: p.code, pass: true, detail: "market open" }); }
    if (p.code === "allowed_instruments" && inst && Array.isArray(p.params.instrument_ids) && !p.params.instrument_ids.includes(inst.id)) { checks.push({ code: p.code, pass: false, detail: `${inst.name} is not on the allowed list` }); fail = true; }
    if (p.code === "blocked_instruments" && inst && Array.isArray(p.params.instrument_ids) && p.params.instrument_ids.includes(inst.id)) { checks.push({ code: p.code, pass: false, detail: `${inst.name} is blocked` }); fail = true; }
  }
  if (!pol.some((p) => p.code === "max_single_amount")) { const ok = b.amount <= 500000; checks.push({ code: "max_single_amount", pass: ok, limit: "500000 (default)", detail: ok ? undefined : `₹${b.amount.toLocaleString("en-IN")} proposed, max ₹5,00,000 per transaction (default)` }); fail ||= !ok; }
  // payees: allow-list, verification by a second user, new-payee block
  const pc = await payeeCheck(c, familyId, payload.payee_id, pol); for (const x of pc) { if (x.payee) payload.payee = x.payee; checks.push({ code: x.code, pass: x.pass, detail: x.detail }); fail ||= !x.pass; }
  // the effective investment policy (FO-144): a prohibited instrument or a band the intent would worsen fails with the clause cited
  const ipc = await intentPolicyCheck(c, familyId, b.entity_id, b.kind, b.amount, payload).catch(() => null);
  if (ipc) { checks.push(ipc); fail ||= !ipc.pass; }
  // connector routing by capability (FO-125); MF kinds need an active NACH mandate to be executable (FO-126 / FO-134)
  let connectorId = b.connector_id ?? null; let route = "executable";
  const connectors = (await c.query("select id, entity_id, provider, label, status, session_expires_at, sandbox from connectors where family_id=$1 and revoked_at is null and (entity_id=$2 or provider='manual' or (config->>'all_entities')='true') order by created_at", [familyId, b.entity_id])).rows;
  const chosen = connectorId ? connectors.find((k) => k.id === connectorId) : routeFor(b.kind as any, connectors)?.connector;
  if (chosen) { connectorId = chosen.id; route = capabilityFor(chosen.provider, b.kind) === "executable" ? "executable" : "assisted"; }
  if (["mf_purchase", "mf_sip_mandate"].includes(b.kind) && chosen && capabilityFor(chosen.provider, b.kind) === "executable") {
    const m = await mandateFor(c, b.entity_id, b.amount);
    if (!m.mandate) { route = "assisted"; checks.push({ code: "nach_mandate", pass: true, detail: "no active NACH mandate — runs as an assisted instruction; register a mandate to execute MF purchases" }); const t = (await c.query("insert into tasks (family_id, entity_id, module, title, reason, severity, source_type, source_id, verification) select $1,$2,'actions','Register a NACH e-mandate for MF purchases',$3,2,'mandate_missing',$2,'na' where not exists (select 1 from tasks where family_id=$1 and source_type='mandate_missing' and source_id=$2 and status='open') returning *", [familyId, b.entity_id, "MF purchases through BSE StAR MF draw on a mandate; without one every purchase is assisted"])).rows[0]; if (t) await notifyTask(c, t, { push: false }).catch(() => null); }
    else if (!m.ok) { checks.push({ code: "mandate_limit", pass: false, detail: m.reason }); fail = true; const t = (await c.query("insert into tasks (family_id, entity_id, module, title, reason, severity, source_type, source_id, verification) select $1,$2,'actions',$3,$4,2,'mandate_limit',$5,'na' where not exists (select 1 from tasks where family_id=$1 and source_type='mandate_limit' and source_id=$5 and status='open') returning *", [familyId, b.entity_id, `MF purchase ₹${b.amount.toLocaleString("en-IN")} exceeds the NACH mandate headroom`, m.reason, m.mandate.id])).rows[0]; if (t) await notifyTask(c, t, { push: false }).catch(() => null); }
    else { payload.mandate_id = m.mandate.id; payload.mandate_ref = m.mandate.umrn ?? m.mandate.provider_ref; checks.push({ code: "nach_mandate", pass: true, detail: m.reason }); }
  }
  if (!connectorId) {   // assisted / sandbox route until a real connector is linked
    const m = await c.query("select id from connectors where entity_id=$1 and provider='manual' and revoked_at is null limit 1", [b.entity_id]);
    connectorId = m.rowCount ? m.rows[0].id : (await c.query("insert into connectors (family_id, entity_id, kind, provider, label, status, sandbox, created_by) values ($1,$2,'custom','manual','Assisted / sandbox','sandbox',true,$3) returning id", [familyId, b.entity_id, userId])).rows[0].id; route = "assisted";
  }
  if (chosen && chosen.provider !== "manual" && route === "executable" && !(["active", "sandbox"].includes(chosen.status) && (!chosen.session_expires_at || new Date(chosen.session_expires_at) > new Date()))) { warnings.push(`${chosen.label}: session not open — the intent will wait in approved until the login is done`); await loginTask(c, familyId, chosen); }
  const ks = (await c.query("select paused from kill_switches where family_id=$1", [familyId])).rows[0];
  checks.push({ code: "kill_switch", pass: !ks?.paused, detail: ks?.paused ? "execution paused" : "running" });
  if (warnings.length) checks.push({ code: "connector_session", pass: true, detail: warnings.join("; ") });
  const r = await c.query(`insert into action_intents (family_id, entity_id, kind, status, connector_id, payload, amount, rationale, proposed_by_kind, proposed_by_user_id, source_type, source_id, policy_result, approvers_required, cooling_off_until, expires_at, batch_id, idempotency_key, route)
    values ($1,$2,$3::intent_kind,$4::intent_status,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15, now() + interval '24 hours', $16, $17, $18) returning *`,
    [familyId, b.entity_id, b.kind, "draft", connectorId, JSON.stringify(payload), b.amount, b.rationale ?? null, b.proposed_by_kind ?? "user", userId, b.source_type ?? null, b.source_id ?? null, JSON.stringify(checks), approvers, cooling, b.batch_id ?? null, b.idempotency_key ?? `${userId}-${Date.now()}-${Math.random()}`, route]);
  const next = fail ? "policy_failed" : "pending_approval";
  const saved = (await c.query("update action_intents set status=$2::intent_status where id=$1 returning *", [r.rows[0].id, next])).rows[0];
  if (next === "pending_approval") {
    const entity = (await c.query("select name from entities where id=$1", [b.entity_id])).rows[0];
    await notifyApproval(c, { id: saved.id, family_id: familyId, kind: b.kind, amount: b.amount, entity_name: entity?.name ?? null, proposed_by_user_id: userId }).catch(() => null);
  }
  return saved;
}
/** After approvals reach the threshold: queue now unless cooling-off, kill switch or an unopened connector session holds it. */
export async function tryQueue(c: pg.PoolClient, familyId: string, intentId: string) {
  const it = (await c.query("select i.*, (select row_to_json(k) from connectors k where k.id=i.connector_id) connector from action_intents i where i.id=$1", [intentId])).rows[0]; if (!it || it.status !== "approved") return false;
  if (it.cooling_off_until && new Date(it.cooling_off_until) > new Date()) return false;
  const k = it.connector; if (k && k.provider !== "manual" && !k.sandbox && !(["active", "sandbox"].includes(k.status) && (!k.session_expires_at || new Date(k.session_expires_at) > new Date()))) { await loginTask(c, familyId, k); return false; }
  await c.query("savepoint q"); try { await c.query("update action_intents set status='queued' where id=$1", [intentId]); await c.query("release savepoint q"); return true; } catch { await c.query("rollback to savepoint q"); return false; }
}
