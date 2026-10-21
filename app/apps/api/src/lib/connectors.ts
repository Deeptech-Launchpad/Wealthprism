// Connectors, payees, execution policies and NACH mandates on the API side (FO-124..127, FO-134). The API registers
// connectors and encrypts their credentials, enqueues executor jobs (session refresh, health, reads, mandate status, bill
// fetch, cancel) and reads their results; it never decrypts a secret. Capability routing and payload schemas come from
// @fo/connectors so the executor agrees with what the approver saw.
import type pg from "pg";
import { PROVIDERS, PAYLOAD_SCHEMAS, INTENT_KINDS, capabilityFor, capabilityMatrix, routeFor, validatePayload, sessionExpiry, sessionOk, loginUrl, buildRequest, assistedInstruction, encryptSecret, tradingWindow, type IntentKind, type Provider } from "@fo/connectors";
import { notifyTask } from "./notify.js";

export class ConnectorError extends Error { constructor(public status: number, message: string, public extra?: unknown) { super(message); } }
export const iso = (d: any) => (d ? new Date(d).toISOString().slice(0, 10) : null);
const KEY = () => process.env.FIELD_ENCRYPTION_KEY ?? "dev-only-field-key";
// ---------- vault-backed credential storage (FO-124 roadmap gap) ----------
// HashiCorp Vault's Transit engine does envelope encryption as a service: the app holds only a scoped token,
// never the raw key, and every encrypt/decrypt is logged by Vault itself. Selected by SECRETS_BACKEND=vault
// (VAULT_ADDR, VAULT_TOKEN, VAULT_TRANSIT_KEY); the default stays the existing local AES-256-GCM, so local/dev
// needs no extra service running. Vault's own ciphertext is self-describing ("vault:v1:…"), distinct from the
// local format's "v1." prefix, so credentials already encrypted under one backend keep decrypting after a
// switch — no bulk re-encryption required the moment SECRETS_BACKEND flips (see rotatekey.ts for a rotation
// sweep when one is wanted).
const vaultAddr = () => process.env.VAULT_ADDR ?? "http://127.0.0.1:8200";
const vaultToken = () => process.env.VAULT_TOKEN ?? "";
const vaultTransitKey = () => process.env.VAULT_TRANSIT_KEY ?? "wealthprism-connector-credentials";
async function secretEncrypt(plain: string): Promise<string> {
  if ((process.env.SECRETS_BACKEND ?? "local") !== "vault") return encryptSecret(plain, KEY());
  const r = await fetch(`${vaultAddr()}/v1/transit/encrypt/${vaultTransitKey()}`, { method: "POST", headers: { "X-Vault-Token": vaultToken(), "content-type": "application/json" }, body: JSON.stringify({ plaintext: Buffer.from(plain, "utf8").toString("base64") }) });
  if (!r.ok) throw new ConnectorError(502, `Vault encrypt failed (HTTP ${r.status}): ${await r.text()}`);
  const j: any = await r.json(); return j.data.ciphertext as string;
}
const CONNECTOR_COLS = "id, family_id, entity_id, kind, provider, label, account_ref, linked_account_id, linked_bank_account_id, status, scopes, session_expires_at, static_ip, sandbox, last_health_at, last_error, created_by, created_at, revoked_at, config";

export async function connectorView(c: pg.PoolClient, id: string) {
  const k = (await c.query(`select ${CONNECTOR_COLS}, (select name from entities e where e.id=connectors.entity_id) entity_name from connectors where id=$1`, [id])).rows[0]; if (!k) throw new ConnectorError(404, "Connector not found");
  const creds = (await c.query("select name, created_at, rotated_at from connector_credentials where connector_id=$1 order by name", [id])).rows;
  const jobs = (await c.query("select id, kind, status, result, error, created_at, finished_at from connector_jobs where connector_id=$1 order by created_at desc limit 10", [id])).rows;
  const mandates = k.kind === "mf_platform" ? (await c.query("select m.id, m.entity_id, e.name entity_name, m.status, m.amount_limit, m.umrn, m.end_date from nach_mandates m join entities e on e.id=m.entity_id where m.connector_id=$1 order by e.name", [id])).rows.map((m) => ({ ...m, amount_limit: Number(m.amount_limit), end_date: iso(m.end_date) })) : [];
  const spec = PROVIDERS[k.provider as Provider];
  return { ...k, provider_name: spec?.name ?? k.provider, auth: spec?.auth ?? "none", session_ok: sessionOk(k), capabilities: Object.fromEntries(INTENT_KINDS.map((x) => [x, capabilityFor(k.provider, x)])), reads: spec?.reads ?? [], credentials: creds.map((x) => x.name), credential_fields: spec?.credential_fields ?? [], jobs, mandates, executions: Number((await c.query("select count(*) n from action_executions where connector_id=$1", [id])).rows[0].n), login_url: k.status === "pending_auth" || (k.session_expires_at && !sessionOk(k)) ? loginUrl(k.provider, { api_key: "" }, k.config) : null };
}
export async function listConnectors(c: pg.PoolClient, familyId: string) {
  const rows = (await c.query(`select ${CONNECTOR_COLS}, (select name from entities e where e.id=connectors.entity_id) entity_name, (select count(*) from action_executions x where x.connector_id=connectors.id) executions, (select max(finished_at) from connector_jobs j where j.connector_id=connectors.id and j.kind='health' and j.status='done') last_health_job from connectors where family_id=$1 and revoked_at is null order by created_at`, [familyId])).rows;
  return rows.map((k) => ({ ...k, provider_name: PROVIDERS[k.provider as Provider]?.name ?? k.provider, auth: PROVIDERS[k.provider as Provider]?.auth ?? "none", session_ok: sessionOk(k), capabilities: Object.fromEntries(INTENT_KINDS.filter((x) => capabilityFor(k.provider, x) !== "unsupported").map((x) => [x, capabilityFor(k.provider, x)])), executions: Number(k.executions) }));
}
/** Register a connector: the row carries no secret; each credential is AES-256-GCM encrypted under FIELD_ENCRYPTION_KEY. */
export async function registerConnector(c: pg.PoolClient, familyId: string, userId: string, b: { entity_id: string; provider: string; label?: string; account_ref?: string | null; linked_account_id?: string | null; linked_bank_account_id?: string | null; scopes?: string[]; sandbox?: boolean; config?: Record<string, any>; credentials?: Record<string, string> }) {
  const spec = PROVIDERS[b.provider as Provider]; if (!spec) throw new ConnectorError(422, `Unknown provider ${b.provider}`);
  const creds = Object.fromEntries(Object.entries(b.credentials ?? {}).filter(([, v]) => v != null && String(v).trim() !== ""));
  const missing = spec.credential_fields.filter((f) => !creds[f] && !["totp_seed", "access_token", "client_certificate", "private_key", "aes_key", "aggr_id", "member_code", "can"].includes(f));
  if (!b.sandbox && missing.length) throw new ConnectorError(422, `Missing credentials for ${spec.name}: ${missing.join(", ")}`);
  const status = b.sandbox ? "sandbox" : ["none", "api_key", "certificate", "static_token"].includes(spec.auth) ? "active" : "pending_auth";
  const row = (await c.query("insert into connectors (family_id, entity_id, kind, provider, label, account_ref, linked_account_id, linked_bank_account_id, status, scopes, sandbox, config, created_by, session_expires_at) values ($1,$2,$3::connector_kind,$4,$5,$6,$7,$8,$9::connector_status,$10,$11,$12,$13,$14) returning id", [familyId, b.entity_id, spec.kind, b.provider, b.label ?? spec.name, b.account_ref ?? null, b.linked_account_id ?? null, b.linked_bank_account_id ?? null, status, b.scopes ?? Object.keys(spec.capabilities).filter((k) => spec.capabilities[k as IntentKind] === "executable").map((k) => `place:${k}`).concat(spec.reads.map((r) => `read:${r}`)), !!b.sandbox, JSON.stringify(b.config ?? {}), userId, spec.auth === "static_token" && creds.access_token ? sessionExpiry(b.provider) : null])).rows[0];
  for (const [name, value] of Object.entries(creds)) await c.query("insert into connector_credentials (family_id, connector_id, name, ciphertext) values ($1,$2,$3,$4)", [familyId, row.id, name, await secretEncrypt(String(value))]);
  return { connector: await connectorView(c, row.id), auth_url: loginUrl(b.provider, creds, b.config ?? {}) };
}
export async function enqueueJob(c: pg.PoolClient, familyId: string, connectorId: string | null, kind: string, payload: Record<string, any> = {}, userId?: string | null) {
  return (await c.query("insert into connector_jobs (family_id, connector_id, kind, payload, requested_by) values ($1,$2,$3,$4,$5) returning *", [familyId, connectorId, kind, JSON.stringify(payload), userId ?? null])).rows[0];
}
/** Wait briefly for the executor to finish a job (it polls every few seconds); returns the row either way. */
export async function waitJob(c: pg.PoolClient, jobId: string, ms = Number(process.env.CONNECTOR_JOB_WAIT_MS ?? 2500)) {
  const until = Date.now() + ms;
  for (;;) { const j = (await c.query("select * from connector_jobs where id=$1", [jobId])).rows[0]; if (!j || j.status === "done" || j.status === "failed" || Date.now() >= until) return j; await new Promise((r) => setTimeout(r, 250)); }
}
/** Connector session expired or auth pending: one task per connector asking the user to log in (FO-124). */
export async function loginTask(c: pg.PoolClient, familyId: string, connector: any) {
  const t = (await c.query("insert into tasks (family_id, entity_id, module, title, reason, severity, source_type, source_id, verification) select $1,$2,'actions',$3,$4,2,'connector_session',$5,'na' where not exists (select 1 from tasks where family_id=$1 and source_type='connector_session' and source_id=$5 and status='open') returning *", [familyId, connector.entity_id, `Log in to ${connector.label} — session ${connector.status === "pending_auth" ? "not opened" : "expired"}`, "Approved intents on this connector stay queued until the daily login (request token + TOTP) is completed", connector.id])).rows[0];
  if (t) await notifyTask(c, t, { push: true }).catch(() => null); return t;
}
export async function schemas(c: pg.PoolClient, familyId: string) {
  const connectors = (await c.query("select id, entity_id, provider, label, status, session_expires_at, sandbox, config from connectors where family_id=$1 and revoked_at is null", [familyId])).rows;
  const entities = (await c.query("select id, name from entities where deleted_at is null order by name")).rows;
  const mandates = (await c.query("select entity_id, status, amount_limit, end_date from nach_mandates where family_id=$1", [familyId])).rows;
  const routes = entities.map((e) => ({ entity_id: e.id, entity: e.name, kinds: Object.fromEntries(INTENT_KINDS.map((k) => { const r = routeFor(k, connectors.filter((x) => x.entity_id === e.id || x.provider === "manual" || x.config?.all_entities === true)); const mandate = mandates.find((m) => m.entity_id === e.id && m.status === "active"); const mfNeedsMandate = ["mf_purchase", "mf_sip_mandate"].includes(k) && r?.capability === "executable" && !mandate; const kc: any = r?.connector; return [k, { connector_id: kc?.id ?? null, connector: kc?.label ?? "Assisted / sandbox", provider: kc?.provider ?? "manual", capability: r ? (mfNeedsMandate ? "assisted" : r.capability) : "assisted", session_ok: r?.session_ok ?? true, note: mfNeedsMandate ? "no active NACH mandate — runs as assisted until one is registered" : r?.capability === "read_only" ? "read-only at this provider" : null }]; })) }));
  return { kinds: PAYLOAD_SCHEMAS, providers: capabilityMatrix(), routes };
}

// ---------- payees ----------
export async function payeeSync(c: pg.PoolClient, familyId: string, userId: string) {
  let created = 0; const add = async (name: string, kind: string, extra: Record<string, any>) => { const r = await c.query("insert into payees (family_id, name, kind, account_masked, ifsc, vpa, bbps_biller_id, linked_type, linked_id, created_by, active) select $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,true where not exists (select 1 from payees p where p.family_id=$1 and lower(p.name)=lower($2)) returning id", [familyId, name, kind, extra.account_masked ?? null, extra.ifsc ?? null, extra.vpa ?? null, extra.bbps_biller_id ?? null, extra.linked_type ?? null, extra.linked_id ?? null, userId]); if (r.rowCount) created++; };
  for (const t of (await c.query("select distinct authority from property_taxes t join properties p on p.id=t.property_id where p.family_id=$1", [familyId])).rows) await add(t.authority, "tax_authority", { linked_type: "property_tax_authority" });
  for (const v of (await c.query("select distinct vendor from property_expenses e join properties p on p.id=e.property_id where p.family_id=$1 and vendor is not null", [familyId])).rows) await add(v.vendor, "vendor", { linked_type: "vendor" });
  for (const t of (await c.query("select id, name from tenants where family_id=$1", [familyId])).rows) await add(`${t.name} (deposit refund)`, "tenant_refund", { linked_type: "tenant", linked_id: t.id });
  // a commitment hangs off the private investment, which is what carries the company and the family — fund_commitments has neither column
  for (const f of (await c.query("select fc.id, co.name from fund_commitments fc join private_investments pi on pi.id=fc.private_investment_id join private_companies co on co.id=pi.company_id where pi.family_id=$1", [familyId])).rows) await add(`${f.name} — capital calls`, "fund_house", { linked_type: "fund_commitment", linked_id: f.id });
  for (const b of (await c.query("select b.id, b.bank, b.account_masked, e.name ename from bank_accounts b join entities e on e.id=b.entity_id where b.family_id=$1 and b.deleted_at is null and b.type <> 'card'", [familyId])).rows) await add(`${b.ename} — ${b.bank} ${b.account_masked ?? ""}`.trim(), "own_account", { account_masked: b.account_masked, linked_type: "bank_account", linked_id: b.id });
  return { created };
}
export async function payeeCheck(c: pg.PoolClient, familyId: string, payeeId: string | null | undefined, policies: any[]): Promise<{ code: string; pass: boolean; detail: string; payee?: any }[]> {
  if (!payeeId) return [];
  const p = (await c.query("select * from payees where id=$1 and family_id=$2", [payeeId, familyId])).rows[0]; if (!p) return [{ code: "allowed_payees", pass: false, detail: "payee not found" }];
  const out: any[] = []; const view = { id: p.id, name: p.name, kind: p.kind, account_masked: p.account_masked, ifsc: p.ifsc, vpa: p.vpa, bbps_biller_id: p.bbps_biller_id, verified: !!p.verified_at };
  if (policies.some((x) => x.code === "allowed_payees")) out.push({ code: "allowed_payees", pass: !!p.verified_at && p.active, detail: p.verified_at ? `${p.name} verified` : `${p.name} is unverified — a second user must verify it`, payee: view });
  const block = policies.find((x) => x.code === "block_new_payee_days"); if (block && p.verified_at) { const lifts = new Date(new Date(p.verified_at).getTime() + Number(block.params?.days ?? 1) * 86400000); out.push({ code: "block_new_payee_days", pass: lifts.getTime() <= Date.now(), detail: lifts.getTime() <= Date.now() ? `payee older than ${block.params?.days ?? 1} day(s)` : `new payee — block lifts ${lifts.toISOString().slice(0, 16).replace("T", " ")} UTC`, payee: view }); }
  if (!out.length) out.push({ code: "payee", pass: true, detail: p.name, payee: view });
  return out;
}

// ---------- mandates (FO-134) ----------
export async function mandateFor(c: pg.PoolClient, entityId: string, amount: number) {
  const m = (await c.query("select * from nach_mandates where entity_id=$1 and status='active' and (end_date is null or end_date >= current_date) order by amount_limit desc limit 1", [entityId])).rows[0]; if (!m) return { mandate: null, ok: false, reason: "no active NACH mandate for this investor" };
  const used = Number((await c.query("select coalesce(sum(amount),0) v from action_intents where entity_id=$1 and kind in ('mf_purchase','mf_sip_mandate') and status in ('pending_approval','approved','queued','submitted','partially_filled','filled','reconciled','posted') and created_at >= date_trunc('month', now()) and payload->>'mandate_id' = $2", [entityId, m.id])).rows[0].v);
  const room = Number(m.amount_limit) - used; return { mandate: m, ok: amount <= room, reason: amount <= room ? `mandate ${m.umrn ?? m.provider_ref} limit ₹${Number(m.amount_limit).toLocaleString("en-IN")}, ₹${room.toLocaleString("en-IN")} left this month` : `₹${amount.toLocaleString("en-IN")} exceeds the mandate headroom ₹${room.toLocaleString("en-IN")} (limit ₹${Number(m.amount_limit).toLocaleString("en-IN")}) — split the purchase or raise the mandate`, room };
}
export async function mandateExpiryTasks(c: pg.PoolClient, familyId: string) {
  let n = 0;
  for (const m of (await c.query("select m.*, e.name ename from nach_mandates m join entities e on e.id=m.entity_id where m.family_id=$1 and m.status='active' and m.end_date is not null and m.end_date <= current_date + 30", [familyId])).rows) {
    const t = (await c.query("insert into tasks (family_id, entity_id, module, title, reason, severity, due_date, source_type, source_id, verification) select $1,$2,'actions',$3,$4,2,$5,'mandate_expiry',$6,'na' where not exists (select 1 from tasks where family_id=$1 and source_type='mandate_expiry' and source_id=$6 and status='open') returning *", [familyId, m.entity_id, `NACH mandate for ${m.ename} expires ${iso(m.end_date)} — re-register`, `Limit ₹${Number(m.amount_limit).toLocaleString("en-IN")} · UMRN ${m.umrn ?? "—"} · MF purchases fall back to assisted after expiry`, m.end_date, m.id])).rows[0];
    if (t) { n++; await notifyTask(c, t, { push: true }).catch(() => null); }
  }
  await c.query("update nach_mandates set status='expired' where family_id=$1 and status='active' and end_date < current_date", [familyId]);
  return n;
}
/** Connector sessions that expired or never opened: a login task each (idempotent). */
export async function sessionTasks(c: pg.PoolClient, familyId: string) {
  let n = 0;
  for (const k of (await c.query(`select ${CONNECTOR_COLS} from connectors where family_id=$1 and revoked_at is null and provider <> 'manual' and (status='pending_auth' or (status in ('active','sandbox') and session_expires_at is not null and session_expires_at < now()))`, [familyId])).rows) { if (k.status !== "pending_auth") await c.query("update connectors set status='expired' where id=$1", [k.id]); if (await loginTask(c, familyId, k)) n++; }
  return n;
}

// ---------- what the approver sees ----------
export function providerRequestFor(intent: any, connector: any) {
  if (!connector) return null; const route = intent.route ?? (capabilityFor(connector.provider, intent.kind) === "executable" ? "executable" : "assisted");
  return route === "assisted" ? { method: "MANUAL", instruction: assistedInstruction(intent.kind, { ...intent.payload, client_ref: intent.idempotency_key }) } : buildRequest(connector.provider, intent.kind, intent.payload, { connector, client_ref: intent.idempotency_key, sandbox: !!connector.sandbox });   // placeholders (<api_key>) only
}
export { validatePayload, tradingWindow, capabilityFor, routeFor, sessionOk };
