import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildApp } from "../src/server.js";
import { withFamily, pool } from "../src/lib/db.js";
import { tick } from "../src/worker.js";
import { sessionExpiry, PROVIDERS } from "@fo/connectors";
process.env.EXECUTOR_DATABASE_URL ??= "postgres://executor_user:exec@localhost:5432/familyoffice";   // the executor runs as its own DB role, as in production
process.env.CONNECTOR_JOB_WAIT_MS ??= "8000";
const { runOnce, adapterFor } = await import("../../executor/src/executor.js");

// Connectors in sandbox (FO-124..127, FO-134). The executor loop is driven by hand (`runOnce`), sometimes concurrently with an
// API call that waits for its job. Everything created here is removed in teardown; seeded connector / mandate / payee state is restored.
const FAMILY = "11111111-1111-1111-1111-111111111111", ARJUN = "33333333-0000-0000-0000-000000000001", HUF = "33333333-0000-0000-0000-000000000002", SPOUSE = "33333333-0000-0000-0000-000000000003";
const KITE = "c1000000-0000-0000-0000-000000000001", BREEZE = "c1000000-0000-0000-0000-000000000002", CIB = "c1000000-0000-0000-0000-000000000003", SETU = "c1000000-0000-0000-0000-000000000004", BSE = "c1000000-0000-0000-0000-000000000005";
const HDFC = "44444444-0000-0000-0000-000000000001", PPFAS = "44444444-0000-0000-0000-000000000003", TCS = "44444444-0000-0000-0000-000000000002";
const CCMC = "c2000000-0000-0000-0000-000000000001", SAFEGUARD = "c2000000-0000-0000-0000-000000000004", VARAHA = "c2000000-0000-0000-0000-000000000005";
const HUF_ICICI = "89898989-0000-0000-0000-000000000002", ARJUN_MANDATE = "c3000000-0000-0000-0000-000000000001";
let app: ReturnType<typeof buildApp>; let owner = "", member = "", operator = "", viewer = "";
const h = (t = owner) => ({ authorization: `Bearer ${t}`, "x-family-id": FAMILY });
const get = async (url: string, t = owner) => { const r = await app.inject({ url: `/api/v1${url}`, headers: h(t) }); return { code: r.statusCode, body: r.json() }; };
const send = async (method: "POST" | "PATCH" | "PUT" | "DELETE", url: string, payload: any = {}, t = owner) => { const r = await app.inject({ method, url: `/api/v1${url}`, headers: h(t), payload }); return { code: r.statusCode, body: r.statusCode === 204 ? null : r.json() }; };
/** Fire an API call that waits for its executor job, run the executor while it waits, return the call's result.
 *  The executor runs until the call settles rather than once after a fixed delay: on a slow runner the job row did not
 *  exist yet when that single run fired, so it found nothing and the call timed out at CONNECTOR_JOB_WAIT_MS. */
const withExecutor = async <T>(call: () => Promise<T>, delay = 100): Promise<T> => {
  let settled = false; const p = call().finally(() => { settled = true; });
  await new Promise((r) => setTimeout(r, delay));
  for (let i = 0; i < 40 && !settled; i++) { await runOnce({ familyId: FAMILY }); if (settled) break; await new Promise((r) => setTimeout(r, 150)); }
  return p;
};
const approve = (id: string, t = member) => send("POST", `/actions/${id}/approve`, { auth_method: "totp", auth_proof: "000000" }, t);
/** Equity orders placed outside 09:15–15:30 IST wait for the next session (trading_hours_only); the tests lift that hold as the worker would at 09:15. */
const openMarket = async (id: string) => { await withFamily(FAMILY, (c) => c.query("update action_intents set cooling_off_until=null where id=$1", [id])); await tick(); return (await get(`/actions/${id}`)).body; };
const intent = async (body: any, t = operator) => { const r = await send("POST", "/actions", body, t); expect(r.code, JSON.stringify(r.body)).toBe(201); return r.body; };
const TABLES = ["connectors", "connector_credentials", "connector_jobs", "nach_mandates", "payees", "execution_policies", "action_intents", "action_approvals", "action_executions", "tasks", "notifications", "audit_log"];
const before: Record<string, string[]> = {}; let connBefore: any[] = [], mandBefore: any[] = [], payeeBefore: any[] = [];

beforeAll(async () => {
  app = buildApp(); await app.ready();
  const login = async (email: string) => (await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password: "Prototype!2026" } })).json().access_token;
  owner = await login("arjun@example.com"); member = await login("priya@example.com"); operator = await login("ops@example.com"); viewer = await login("ca@example.com");
  await withFamily(FAMILY, async (c) => {
    for (const t of TABLES) before[t] = (await c.query(`select id::text k from ${t}`)).rows.map((r) => r.k);
    connBefore = (await c.query("select id, status, session_expires_at, sandbox, last_health_at, last_error, account_ref from connectors")).rows;
    mandBefore = (await c.query("select id, status, umrn, provider_ref, auth_url, registered_at from nach_mandates")).rows;
    payeeBefore = (await c.query("select id, verified_by, verified_at, first_used_at, active, beneficiary_status from payees")).rows;
    await c.query("update kill_switches set paused=false where family_id=$1", [FAMILY]);
  });
});
afterAll(async () => {
  await withFamily(FAMILY, async (c) => {
    await c.query("delete from connector_sandbox_orders where connector_id in (select id from connectors where family_id=$1)", [FAMILY]);
    for (const t of ["action_executions", "action_approvals", "action_intents", "connector_jobs", "nach_mandates", "connector_credentials", "tasks", "notifications", "audit_log"]) await c.query(`delete from ${t} where id::text <> all($1::text[])`, [before[t]]);
    await c.query("delete from connectors where id::text <> all($1::text[]) and not exists (select 1 from action_intents i where i.connector_id=connectors.id)", [before.connectors]);
    await c.query("delete from payees where id::text <> all($1::text[])", [before.payees]); await c.query("delete from execution_policies where id::text <> all($1::text[])", [before.execution_policies]);
    for (const k of connBefore) await c.query("update connectors set status=$2, session_expires_at=$3, sandbox=$4, last_health_at=$5, last_error=$6, account_ref=$7 where id=$1", [k.id, k.status, k.session_expires_at, k.sandbox, k.last_health_at, k.last_error, k.account_ref]);
    for (const m of mandBefore) await c.query("update nach_mandates set status=$2, umrn=$3, provider_ref=$4, auth_url=$5, registered_at=$6 where id=$1", [m.id, m.status, m.umrn, m.provider_ref, m.auth_url, m.registered_at]);
    for (const p of payeeBefore) await c.query("update payees set verified_by=$2, verified_at=$3, first_used_at=$4, active=$5, beneficiary_status=$6 where id=$1", [p.id, p.verified_by, p.verified_at, p.first_used_at, p.active, p.beneficiary_status]);
    await c.query("update kill_switches set paused=false where family_id=$1", [FAMILY]);
  });
  await app.close(); await pool.end();
});

describe("Zerodha Kite Connect (FO-124) and the capability matrix (FO-125)", () => {
  let kite: any;
  it("registers a connector: credentials are encrypted and never returned; the login URL is handed back; the API cannot read the ciphertext", async () => {
    const r = await send("POST", "/connectors", { entity_id: ARJUN, provider: "zerodha_kite", label: "Kite (test account)", account_ref: "ZX9999", sandbox: true, credentials: { api_key: "kite_key_x", api_secret: "kite_secret_y", totp_seed: "JBSWY3DPEHPK3PXP" } }, operator);
    expect(r.code).toBe(201); kite = r.body.connector; expect(kite.status).toBe("sandbox"); expect(kite.credentials.sort()).toEqual(["api_key", "api_secret", "totp_seed"]); expect(r.body.auth_url).toContain("kite.zerodha.com/connect/login"); expect(r.body.auth_url).toContain("kite_key_x");
    const detail = await get(`/connectors/${kite.id}`); expect(JSON.stringify(detail.body)).not.toMatch(/kite_secret_y|JBSWY3DPEHPK3PXP/); expect(detail.body.capabilities.equity_order).toBe("executable"); expect(detail.body.capabilities.mf_purchase).toBe("assisted"); expect(detail.body.reads).toContain("mf_holdings");
    const priv = (await withFamily(FAMILY, (c) => c.query("select has_column_privilege('app_user','connector_credentials','ciphertext','SELECT') app_ct, has_column_privilege('app_user','connector_credentials','name','SELECT') app_name, has_column_privilege('executor_user','connector_credentials','ciphertext','SELECT') exec_ct"))).rows[0];
    expect(priv.app_ct).toBe(false); expect(priv.app_name).toBe(true); expect(priv.exec_ct).toBe(true);
    await expect(withFamily(FAMILY, (c) => c.query("select ciphertext from connector_credentials limit 1"))).rejects.toThrow(/permission denied/);
    expect((await send("POST", "/connectors", { entity_id: ARJUN, provider: "zerodha_kite", sandbox: false, credentials: { api_key: "k" } }, operator)).code).toBe(422);   // live registration needs the secret
    expect((await send("POST", "/connectors", { entity_id: ARJUN, provider: "zerodha_kite", sandbox: true }, viewer)).code).toBe(403);
  });
  it("the daily session: request_token + TOTP exchanged by the executor, active until 06:00 IST; a wrong TOTP is refused; the health ping runs as a job", async () => {
    const s = await withExecutor(() => send("POST", `/connectors/${KITE}/session`, { request_token: "rt_abc123", totp: "000000" }, owner));
    expect(s.code, JSON.stringify(s.body)).toBe(200); expect(s.body.status).toBe("sandbox"); expect(s.body.session_ok).toBe(true); expect(s.body.credentials).toContain("access_token"); expect(s.body.job.result.vault).toBe("access_token stored"); expect(JSON.stringify(s.body)).not.toMatch(/sbx_/);
    expect(new Date(s.body.session_expires_at).getTime()).toBeCloseTo(sessionExpiry("zerodha_kite")!.getTime(), -4);
    const bad = await withExecutor(() => send("POST", `/connectors/${kite.id}/session`, { request_token: "rt_abc123", totp: "123456" }, owner)); expect(bad.code).toBe(422); expect(bad.body.title).toMatch(/TOTP does not match/);
    const hp = await withExecutor(() => send("POST", `/connectors/${KITE}/health`, {}, operator)); expect(hp.body.ok).toBe(true); expect(hp.body.detail).toMatch(/sandbox reachable/);
    expect((await get(`/connectors/${KITE}`)).body.last_health_at).toBeTruthy();
  });
  it("MF holdings read from Kite is a reconciliation source: it matches the CAS folios", async () => {
    const r = await withExecutor(() => send("POST", `/connectors/${KITE}/read`, { what: "mf_holdings" }, operator));
    expect(r.code).toBe(200); expect(r.body.job.status).toBe("done"); expect(r.body.reconciliation.rows.length).toBe(2); expect(r.body.reconciliation.rows.every((x: any) => x.matches)).toBe(true); expect(r.body.reconciliation.all_match).toBe(true);
  });
  it("an equity order round-trips in sandbox with the quantity capped at one; an expired session keeps the approved intent out of the queue with a login task until the login is done", async () => {
    await withFamily(FAMILY, (c) => c.query("update connectors set session_expires_at=now()-interval '1 hour', sandbox=false where id=$1", [KITE]));
    const i = await intent({ entity_id: ARJUN, kind: "equity_order", connector_id: KITE, amount: 5200, payload: { instrument_id: HDFC, side: "buy", quantity: 3, order_type: "limit", limit_price: 1730 }, rationale: "test order" });
    expect(i.status).toBe("pending_approval"); expect(i.route).toBe("executable"); expect(i.payload.instrument.symbol).toBe("HDFCBANK"); expect(i.policy_result.some((x: any) => x.code === "connector_session")).toBe(true);
    const detail = (await get(`/actions/${i.id}`)).body; expect(detail.provider_request.url).toBe("https://api.kite.trade/orders/regular"); expect(detail.provider_request.body).toMatchObject({ tradingsymbol: "HDFCBANK", transaction_type: "BUY", quantity: 3, price: 1730 }); expect(detail.provider_request.headers.Authorization).toBe("token <api_key>:<access_token>");
    const a = await approve(i.id); expect(a.code).toBe(200); expect(a.body.status).toBe("approved");   // threshold met, but the session is closed
    expect((await get("/tasks?module=actions")).body.some((t: any) => t.source_type === "connector_session" && t.source_id === KITE)).toBe(true);
    await runOnce({ familyId: FAMILY }); expect((await get(`/actions/${i.id}`)).body.status).toBe("approved");
    await withExecutor(() => send("POST", `/connectors/${KITE}/session`, { request_token: "rt_new", totp: "000000" }, owner));
    expect((await openMarket(i.id)).status).toBe("queued");
    await withFamily(FAMILY, (c) => c.query("update connectors set sandbox=true where id=$1", [KITE]));
    await runOnce({ familyId: FAMILY }); const done = (await get(`/actions/${i.id}`)).body;
    expect(done.status).toBe("filled"); expect(done.executions.length).toBe(1); expect(done.executions[0].provider_ref).toMatch(/^26091200/); expect(Number(done.executions[0].filled_qty)).toBe(1); expect(done.executions[0].response.quantity_capped).toBe(true); expect(done.executions[0].client_ref).toBe(done.idempotency_key);
    expect(JSON.stringify(done.executions[0].request)).not.toMatch(/kite_secret|sbx_/);
  });
  it("/actions/schemas serves the payload schemas, the provider capability matrix and each entity's route per kind", async () => {
    const s = (await get("/actions/schemas")).body;
    expect(Object.keys(s.kinds).length).toBe(12); expect(s.kinds.bank_transfer.required).toEqual(["payee_id", "amount"]);
    expect(s.providers.zerodha_kite.capabilities).toMatchObject({ equity_order: "executable", mf_purchase: "assisted" }); expect(s.providers.bse_star_mf.capabilities.mf_purchase).toBe("executable"); expect(s.providers.icici_cib.capabilities.bill_payment).toBe("unsupported"); expect(s.providers.setu_bbps.capabilities.bill_payment).toBe("executable");
    const arjun = s.routes.find((r: any) => r.entity_id === ARJUN), huf = s.routes.find((r: any) => r.entity_id === HUF);
    expect(arjun.kinds.mf_purchase, JSON.stringify(arjun.kinds.mf_purchase)).toMatchObject({ provider: "bse_star_mf", capability: "executable" }); expect(huf.kinds.mf_purchase).toMatchObject({ provider: "bse_star_mf", capability: "assisted" }); expect(huf.kinds.mf_purchase.note).toMatch(/no active NACH mandate/);
    expect(huf.kinds.bank_transfer.provider).toBe("icici_cib"); expect(huf.kinds.bill_payment.provider).toBe("setu_bbps"); expect(arjun.kinds.bank_transfer.capability).toBe("assisted");
  });
  it("every adapter passes the shared contract test in sandbox: health, session, submit, idempotent re-submit, status, cancel", async () => {
    const extra: Record<string, string> = {};
    for (const p of ["upstox", "angel_smartapi", "dhan", "razorpayx"]) extra[p] = (await send("POST", "/connectors", { entity_id: SPOUSE, provider: p, sandbox: true, credentials: { api_key: "k", api_secret: "s", client_code: "C1", pin: "1234", client_id: "D1", access_token: "t", key_id: "rzp", key_secret: "x", totp_seed: "JBSWY3DPEHPK3PXP" } }, operator)).body.connector.id;
    const ids: Record<string, string> = { zerodha_kite: KITE, icici_breeze: BREEZE, icici_cib: CIB, setu_bbps: SETU, bse_star_mf: BSE, ...extra };
    await withFamily(FAMILY, async (c) => {
      for (const [provider, id] of Object.entries(ids)) {
        const connector = (await c.query("select * from connectors where id=$1", [id])).rows[0]; const { adapter, sandbox } = adapterFor(connector, true); expect(sandbox).toBe(true);
        const ctx: any = { c, familyId: FAMILY, connector, creds: { api_key: "k", api_secret: "s", totp_seed: "JBSWY3DPEHPK3PXP" }, sandbox: true };
        const hp = await adapter.health(ctx); expect(hp.ok, provider).toBe(true);
        const se = await adapter.session({ request_token: "rt", totp: "000000", code: "c" }, ctx); const want = sessionExpiry(provider); if (want == null) expect(se.expires_at, provider).toBeNull(); else expect(Math.abs(se.expires_at!.getTime() - want.getTime()), provider).toBeLessThan(5000);   // rolling (now + hours) expiries differ by the clock between the two calls
        const kind = PROVIDERS[provider as keyof typeof PROVIDERS].kind === "broker" ? "equity_order" : provider === "bse_star_mf" ? "mf_purchase" : provider === "setu_bbps" ? "bill_payment" : "bank_transfer";
        const payload: any = kind === "equity_order" ? { instrument_id: TCS, instrument: { symbol: "TCS" }, side: "buy", quantity: 2, limit_price: 3800 } : kind === "mf_purchase" ? { instrument_id: PPFAS, amount: 5000, mandate_id: ARJUN_MANDATE } : kind === "bill_payment" ? { biller_id: "CCMC00000COIMB", consumer_number: "CCMC/SB/4471", amount: 114, category: "property_tax" } : { payee: { name: "Safeguard", account_masked: "••4410", ifsc: "HDFC0001234" }, amount: 1200, mode: "NEFT" };
        const ref = `contract-${provider}-${Date.now()}`; const r1 = await adapter.submit(kind, payload, ref, ctx); expect(["filled", "submitted"], provider).toContain(r1.status); expect(r1.provider_ref).toBeTruthy();
        const r2 = await adapter.submit(kind, payload, ref, ctx); expect(r2.provider_ref).toBe(r1.provider_ref); expect(r2.message).toMatch(/duplicate submit refused/);
        const st = await adapter.status(ref, r1.provider_ref, ctx); expect(st?.provider_ref).toBe(r1.provider_ref); expect(["filled", "submitted"]).toContain(st!.status);
        const cn = await adapter.cancel(ref, r1.provider_ref, ctx); expect(typeof cn.ok).toBe("boolean");
        expect(Number((await c.query("select count(*) n from connector_sandbox_orders where connector_id=$1 and client_ref=$2", [id, ref])).rows[0].n)).toBe(1);
      }
      const bse = (await c.query("select * from connectors where id=$1", [BSE])).rows[0]; const noMandate = await adapterFor(bse, true).adapter.submit("mf_purchase", { instrument_id: PPFAS, amount: 5000 }, `nomandate-${Date.now()}`, { c, familyId: FAMILY, connector: bse, creds: {}, sandbox: true } as any); expect(noMandate.status).toBe("failed"); expect(noMandate.message).toMatch(/no active mandate/);
    });
  });
});

describe("BSE StAR MF and NACH e-mandates (FO-126, FO-134)", () => {
  let hufMandate: any;
  it("an investor without an active mandate gets an assisted intent and a task; a purchase above the mandate headroom is flagged; an expiring mandate raises a task", async () => {
    const assisted = await intent({ entity_id: HUF, kind: "mf_purchase", amount: 5000, payload: { instrument_id: PPFAS, amount: 5000 }, rationale: "HUF buys PPFAS" });
    expect(assisted.status).toBe("pending_approval"); expect(assisted.route).toBe("assisted"); expect(assisted.policy_result.find((x: any) => x.code === "nach_mandate").detail).toMatch(/no active NACH mandate/);
    expect((await get("/tasks?module=actions")).body.some((t: any) => t.source_type === "mandate_missing" && t.entity_id === HUF)).toBe(true);
    const big = await intent({ entity_id: ARJUN, kind: "mf_purchase", amount: 60000, payload: { instrument_id: PPFAS, amount: 60000 } });
    expect(big.status).toBe("policy_failed"); expect(big.policy_result.find((x: any) => x.code === "mandate_limit").detail).toMatch(/exceeds the mandate headroom/); expect((await get("/tasks?module=actions")).body.some((t: any) => t.source_type === "mandate_limit")).toBe(true);
    const chk = await send("POST", "/mandates/check", {}, operator); expect(chk.code).toBe(200);   // the task may already exist from the worker's housekeeping
    expect((await get("/tasks?module=actions")).body.some((t: any) => t.source_type === "mandate_expiry" && /Spouse/.test(t.title))).toBe(true);
    const list = (await get("/mandates")).body; expect(list.find((m: any) => m.id === ARJUN_MANDATE)).toMatchObject({ status: "active", amount_limit: 50000 }); expect(list.find((m: any) => m.entity_id === SPOUSE).expires_in_days).toBeLessThanOrEqual(30);
  });
  it("registers a mandate in the test market (limit capped to the policy), activates it on the status poll, and the purchase then allots units and reconciles on poll", async () => {
    const reg = await withExecutor(() => send("POST", "/mandates", { entity_id: HUF, bank_account_id: HUF_ICICI, amount_limit: 900000, auth_mode: "netbanking" }, operator));
    expect(reg.code, JSON.stringify(reg.body)).toBe(201); hufMandate = reg.body; expect(hufMandate.amount_limit).toBe(500000); expect(hufMandate.capped_to_policy).toBe(true); expect(hufMandate.status).toBe("pending"); expect(hufMandate.auth_url).toMatch(/authorise/);
    const st = await withExecutor(() => send("POST", `/mandates/${hufMandate.id}/status`, {}, operator)); expect(st.body.status).toBe("active"); expect(st.body.umrn).toMatch(/^SBX/);
    expect((await get("/actions/schemas")).body.routes.find((r: any) => r.entity_id === HUF).kinds.mf_purchase.capability).toBe("executable");
    const buy = await intent({ entity_id: HUF, kind: "mf_purchase", amount: 7000, payload: { instrument_id: PPFAS, amount: 7000 } });
    expect(buy.route).toBe("executable"); expect(buy.payload.mandate_id).toBe(hufMandate.id); expect(buy.policy_result.find((x: any) => x.code === "nach_mandate").pass).toBe(true);
    expect((await approve(buy.id)).body.status).toBe("queued"); await runOnce({ familyId: FAMILY });
    const sub = (await get(`/actions/${buy.id}`)).body; expect(sub.status).toBe("submitted"); expect(sub.executions[0].response.order_status).toBe("ACCEPTED"); expect(Number(sub.executions[0].filled_qty)).toBeCloseTo(7000 / 55.22, 2); expect(sub.provider_request.url).toMatch(/mf_purchases/); expect(sub.provider_request.body.payment_method).toBe("mandate");
    const polled = await withExecutor(() => send("POST", `/actions/${buy.id}/poll`, {}, operator)); expect(polled.body.status).toBe("filled"); expect(polled.body.poll.result.response.order_status).toBe("ALLOTTED");
    expect((await get("/mandates")).body.find((m: any) => m.id === hufMandate.id).used_this_month).toBe(7000);
  });
});

describe("ICICI Corporate API Suite, BBPS and assisted UPI (FO-127)", () => {
  it("an unregistered beneficiary is rejected before submission; a freshly verified payee is blocked for a day; a NEFT to a verified payee returns a UTR after the portal checker", async () => {
    const rej = await intent({ entity_id: HUF, kind: "bank_transfer", amount: 20000, payload: { payee_id: VARAHA, amount: 20000, mode: "RTGS" } });
    expect(rej.status).toBe("policy_failed"); expect(rej.policy_result.find((x: any) => x.code === "allowed_payees")).toMatchObject({ pass: false }); expect(rej.policy_result.find((x: any) => x.code === "allowed_payees").detail).toMatch(/unverified/);
    expect((await send("POST", `/payees/${VARAHA}/verify`, {}, operator)).code).toBe(403);   // ops added it
    const v = await send("POST", `/payees/${VARAHA}/verify`, {}, member); expect(v.body.verified).toBe(true);
    const blocked = await intent({ entity_id: HUF, kind: "bank_transfer", amount: 20000, payload: { payee_id: VARAHA, amount: 20000, mode: "RTGS" } }); expect(blocked.status).toBe("policy_failed"); expect(blocked.policy_result.find((x: any) => x.code === "block_new_payee_days").detail).toMatch(/block lifts/);
    const neft = await intent({ entity_id: HUF, kind: "bank_transfer", amount: 1200, payload: { payee_id: SAFEGUARD, amount: 1200, mode: "NEFT", remarks: "AMC Q2" } });
    expect(neft.status).toBe("pending_approval"); expect(neft.route).toBe("executable"); expect(neft.payload.payee.ifsc).toBe("HDFC0001234");
    const d = (await get(`/actions/${neft.id}`)).body; expect(d.connector.provider).toBe("icici_cib"); expect(d.provider_request.body).toMatchObject({ AMOUNT: "1200", TXNTYPE: "NEFT", IFSC: "HDFC0001234", WORKFLOW_REQD: "Y" }); expect(d.provider_request.headers.apikey).toBe("<api_key>");
    expect((await approve(neft.id)).body.status).toBe("queued"); await runOnce({ familyId: FAMILY });
    const sub = (await get(`/actions/${neft.id}`)).body; expect(sub.status).toBe("submitted"); expect(sub.executions[0].response.STATUS).toBe("PENDING_PORTAL_AUTHORISATION");
    const polled = await withExecutor(() => send("POST", `/actions/${neft.id}/poll`, {}, operator)); expect(polled.body.status).toBe("filled"); expect(polled.body.poll.result.response.UTR).toMatch(/^ICICR\d{16}$/);
    expect((await get(`/actions/${neft.id}/executions`)).body[0].provider_ref).toMatch(/^ICICR/);
  });
  it("a BBPS bill is fetched by assessment number and paid with a receipt; an individual's payment becomes a UPI intent the person confirms", async () => {
    const bill = await withExecutor(() => send("POST", `/connectors/${SETU}/bill`, { payee_id: CCMC, consumer_number: "CCMC/SB/4471" }, operator));
    expect(bill.body.bill).toMatchObject({ billerId: "CCMC00000COIMB", consumer: "CCMC/SB/4471", amount: 114 });
    const pay = await intent({ entity_id: HUF, kind: "bill_payment", amount: 114, payload: { payee_id: CCMC, consumer_number: "CCMC/SB/4471", amount: 114, category: "property_tax", bill_ref: bill.body.bill.billRef } });
    expect(pay.route).toBe("executable"); const pd = (await get(`/actions/${pay.id}`)).body; expect(pd.connector.provider).toBe("setu_bbps"); expect(pd.provider_request.body.billerId).toBe("CCMC00000COIMB");
    expect((await approve(pay.id)).body.status).toBe("queued"); await runOnce({ familyId: FAMILY }); const paid = (await get(`/actions/${pay.id}`)).body; expect(paid.status).toBe("filled"); expect(paid.executions[0].response.receipt.consumer).toBe("CCMC/SB/4471");
    const upi = await intent({ entity_id: ARJUN, kind: "bank_transfer", amount: 1200, payload: { payee_id: SAFEGUARD, amount: 1200, mode: "UPI", remarks: "AMC" } });
    expect(upi.route).toBe("assisted"); const ud = (await get(`/actions/${upi.id}`)).body; expect(ud.instruction.url).toMatch(/^upi:\/\/pay\?pa=safeguard%40upi/); expect(ud.instruction.url).toContain("am=1200.00"); expect(ud.instruction.steps.length).toBe(3);
    expect((await approve(upi.id)).body.status).toBe("queued"); await runOnce({ familyId: FAMILY }); expect((await get(`/actions/${upi.id}`)).body.status).toBe("submitted");
    const conf = await send("POST", `/actions/${upi.id}/confirm`, { reference: "UPI426112345678", note: "paid from GPay" }, owner); expect(conf.body.status).toBe("filled"); expect(conf.body.confirmed_ref).toBe("UPI426112345678");
    expect((await get(`/actions/${upi.id}/executions`)).body[0].provider_ref).toBe("UPI426112345678");
  });
});

describe("executor safety (FO-123) and policies & payees", () => {
  it("the kill switch stops pick-up; a provider that already holds the client reference is never submitted twice; cancel before fill; the executor role cannot touch documents or policies", async () => {
    const order = await intent({ entity_id: SPOUSE, kind: "equity_order", amount: 3800, payload: { instrument_id: TCS, side: "buy", quantity: 1, order_type: "limit", limit_price: 3800 } });
    expect((await get(`/actions/${order.id}`)).body.connector.provider).toBe("icici_breeze");
    await approve(order.id); expect((await openMarket(order.id)).status).toBe("queued");
    expect((await send("POST", "/kill-switch", { paused: true, reason: "drill" }, member)).body.paused).toBe(true);
    const r1 = await runOnce({ familyId: FAMILY }); expect(r1.paused).toBe(1); expect((await get(`/actions/${order.id}`)).body.status).toBe("queued");
    expect((await send("POST", "/kill-switch", { paused: false }, owner)).body.paused).toBe(false);
    // the provider received the order just before a crash: the sandbox book already carries our client reference
    await withFamily(FAMILY, (c) => c.query("insert into connector_sandbox_orders (connector_id, client_ref, provider_ref, status, body) values ($1,$2,'BRZPRIOR12345','filled',$3)", [BREEZE, order.idempotency_key, JSON.stringify({ provider_ref: "BRZPRIOR12345", status: "filled", filled_qty: 1, avg_price: 3800, response: { sandbox: true, status: "COMPLETE" } })]));
    await runOnce({ familyId: FAMILY }); const done = (await get(`/actions/${order.id}`)).body;
    expect(done.status).toBe("filled"); expect(done.executions.length).toBe(1); expect(done.executions[0].provider_ref).toBe("BRZPRIOR12345"); expect(done.executions[0].response.note).toMatch(/duplicate submit refused/);
    expect(Number((await withFamily(FAMILY, (c) => c.query("select count(*) n from connector_sandbox_orders where connector_id=$1 and client_ref=$2", [BREEZE, order.idempotency_key]))).rows[0].n)).toBe(1);
    const cancelMe = await intent({ entity_id: SPOUSE, kind: "equity_order", amount: 3800, payload: { instrument_id: TCS, side: "sell", quantity: 1, order_type: "limit", limit_price: 3900 } }); await approve(cancelMe.id); await openMarket(cancelMe.id);
    expect((await send("POST", `/actions/${cancelMe.id}/cancel`, {}, operator)).body.status).toBe("cancelled"); await runOnce({ familyId: FAMILY }); expect((await get(`/actions/${cancelMe.id}`)).body.executions.length).toBe(0);
    const g = (await withFamily(FAMILY, (c) => c.query("select has_table_privilege('executor_user','documents','SELECT') docs, has_table_privilege('executor_user','execution_policies','UPDATE') pol_upd, has_table_privilege('executor_user','execution_policies','SELECT') pol_sel, has_table_privilege('executor_user','action_intents','INSERT') int_ins, has_table_privilege('executor_user','action_intents','SELECT') int_sel"))).rows[0];
    expect(g).toEqual({ docs: false, pol_upd: false, pol_sel: true, int_ins: false, int_sel: true });
  });
  it("owners manage execution policies (audit-logged) and see limits usage; payees sync from taxes, vendors, tenants and own accounts; batch approval takes one step-up", async () => {
    expect((await send("POST", "/execution-policies", { code: "max_monthly_amount", params: { amount: 2000000 } }, operator)).code).toBe(403);
    const p = await send("POST", "/execution-policies", { code: "max_monthly_amount", params: { amount: 2000000 } }); expect(p.code).toBe(201);
    expect((await send("PATCH", `/execution-policies/${p.body.id}`, { params: { amount: 2500000 } })).body.params.amount).toBe(2500000);
    const ov = (await get("/oversight")).body; expect(ov.policy_changes.some((x: any) => x.row_id === p.body.id)).toBe(true); expect(ov.connectors.length).toBeGreaterThanOrEqual(5); expect(Array.isArray(ov.anomalies)).toBe(true); expect(ov.limits.length).toBeGreaterThanOrEqual(3);
    const usage = (await get("/execution-policies/usage")).body; expect(usage.some((u: any) => u.code === "max_daily_amount" && u.entity_id === HUF && u.amount_used > 0)).toBe(true); expect(usage.some((u: any) => u.window === "month")).toBe(true);
    expect((await send("DELETE", `/execution-policies/${p.body.id}`)).code).toBe(204);
    const sync = await send("POST", "/payees/sync", {}, operator); expect(sync.code).toBe(202); expect(sync.body.created).toBeGreaterThanOrEqual(3);
    const payees = (await get("/payees")).body; expect(payees.some((x: any) => x.kind === "own_account" && /Kotak/.test(x.name))).toBe(true); expect(payees.some((x: any) => x.kind === "tenant_refund")).toBe(true); expect(payees.find((x: any) => x.id === VARAHA).verified).toBe(true);
    const batch = crypto.randomUUID();
    const a = await intent({ entity_id: HUF, kind: "bill_payment", amount: 360, batch_id: batch, payload: { payee_id: "c2000000-0000-0000-0000-000000000002", consumer_number: "GCC/AN/77210", amount: 360, category: "property_tax" } }); const b = await intent({ entity_id: HUF, kind: "bank_transfer", amount: 500, batch_id: batch, payload: { payee_id: SAFEGUARD, amount: 500, mode: "IMPS" } });
    expect((await send("POST", "/actions/batch/approve", { batch_id: batch, auth_method: "totp", auth_proof: "111111" }, member)).code).toBe(403);
    const ok = await send("POST", "/actions/batch/approve", { batch_id: batch, auth_method: "totp", auth_proof: "000000" }, member); expect(ok.code).toBe(200); expect(ok.body.map((x: any) => x.status).sort()).toEqual(["queued", "queued"]);
    expect((await send("POST", "/actions/batch/approve", { batch_id: batch, auth_method: "totp", auth_proof: "000000" }, operator)).code).toBe(403);
    await runOnce({ familyId: FAMILY }); expect((await get(`/actions/${a.id}`)).body.status).toBe("filled"); expect((await get(`/actions/${b.id}`)).body.status).toBe("submitted");
  });
});
