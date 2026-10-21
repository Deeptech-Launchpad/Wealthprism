// Provider adapters behind one interface (FO-123/125). Every adapter has a sandbox mode that runs against the deterministic
// simulators in @fo/connectors with its own persisted order book (connector_sandbox_orders), so submit / status / cancel /
// health / session / reads pass the same contract test without network. Live mode builds the exact request the approver
// saw, substitutes credentials, and goes out through the egress guard.
import type pg from "pg";
import { randomBytes, createHash } from "node:crypto";
import { PROVIDERS, capabilityFor, buildRequest, sandboxSubmit, sandboxHealth, sandboxBill, sessionExpiry, kiteChecksum, totp, redact, SANDBOX_MF_HOLDINGS, type Provider, type SubmitResult } from "@fo/connectors";
import { guardedFetch } from "./egress.js";

export interface Ctx { c: pg.PoolClient; familyId: string; connector: any; creds: Record<string, string>; sandbox: boolean; now?: Date }
export interface Adapter {
  submit(kind: string, payload: Record<string, any>, clientRef: string, ctx: Ctx): Promise<SubmitResult>;
  status(clientRef: string, providerRef: string | null, ctx: Ctx): Promise<SubmitResult | null>;
  cancel(clientRef: string, providerRef: string | null, ctx: Ctx): Promise<{ ok: boolean; response: any }>;
  health(ctx: Ctx): Promise<{ ok: boolean; latency_ms: number; detail: string }>;
  session(input: Record<string, any>, ctx: Ctx): Promise<{ access_token?: string; expires_at: Date | null; account_ref?: string | null; detail: string }>;
  read(what: string, ctx: Ctx): Promise<any>;
  mandate(action: "register" | "status" | "cancel", mandate: any, ctx: Ctx): Promise<{ status: string; umrn?: string | null; provider_ref?: string | null; auth_url?: string | null; detail?: string }>;
  bill(payload: Record<string, any>, ctx: Ctx): Promise<any>;
}
const priceOf = async (c: pg.PoolClient, instrumentId?: string | null) => instrumentId ? Number((await c.query("select close from prices where instrument_id=$1 order by price_date desc limit 1", [instrumentId])).rows[0]?.close ?? 0) || null : null;
const mandateOf = async (c: pg.PoolClient, id?: string | null) => (id ? (await c.query("select * from nach_mandates where id=$1 and status='active' and (end_date is null or end_date >= current_date)", [id])).rows[0] ?? null : null);

// ---------- sandbox: one implementation, provider-specific behaviour comes from the simulators ----------
const sandbox: Adapter = {
  async submit(kind, payload, clientRef, ctx) {
    const seen = (await ctx.c.query("select provider_ref, status, body from connector_sandbox_orders where connector_id=$1 and client_ref=$2", [ctx.connector.id, clientRef])).rows[0];
    if (seen) return { ...(seen.body as SubmitResult), message: "duplicate submit refused by the sandbox — same client reference already on the book" };
    const r = sandboxSubmit(ctx.connector.provider, kind, payload, { client_ref: clientRef, connector: ctx.connector, mandate: await mandateOf(ctx.c, payload.mandate_id), price: payload.price_ref ?? await priceOf(ctx.c, payload.instrument_id), nav: payload.nav_ref ?? await priceOf(ctx.c, payload.instrument_id) });
    await ctx.c.query("insert into connector_sandbox_orders (connector_id, client_ref, provider_ref, status, body) values ($1,$2,$3,$4,$5)", [ctx.connector.id, clientRef, r.provider_ref, r.status, JSON.stringify(r)]);
    return r;
  },
  async status(clientRef, _providerRef, ctx) {
    const row = (await ctx.c.query("select provider_ref, status, body from connector_sandbox_orders where connector_id=$1 and client_ref=$2", [ctx.connector.id, clientRef])).rows[0]; if (!row) return null;
    const r = row.body as SubmitResult;
    // the bank's portal checker (or the MF platform's allotment) completes on the first poll after submission
    if (r.status === "submitted" && !r.response?.assisted) { const done: SubmitResult = { ...r, status: "filled", response: { ...r.response, STATUS: "SUCCESS", UTR: r.provider_ref, order_status: r.response?.order_status ? "ALLOTTED" : undefined, completed_by: "sandbox poll" } }; await ctx.c.query("update connector_sandbox_orders set status='filled', body=$3 where connector_id=$1 and client_ref=$2", [ctx.connector.id, clientRef, JSON.stringify(done)]); return done; }
    return r;
  },
  async cancel(clientRef, _providerRef, ctx) {
    const row = (await ctx.c.query("select status from connector_sandbox_orders where connector_id=$1 and client_ref=$2", [ctx.connector.id, clientRef])).rows[0];
    if (!row) return { ok: true, response: { sandbox: true, note: "nothing at the provider to cancel" } };
    if (row.status === "filled") return { ok: false, response: { sandbox: true, error: "already filled" } };
    await ctx.c.query("update connector_sandbox_orders set status='cancelled' where connector_id=$1 and client_ref=$2", [ctx.connector.id, clientRef]); return { ok: true, response: { sandbox: true, status: "CANCELLED" } };
  },
  async health(ctx) { return sandboxHealth(ctx.connector.provider); },
  async session(input, ctx) {
    const p = ctx.connector.provider as Provider; const spec = PROVIDERS[p];
    if (spec.auth === "daily_request_token" && !input.request_token) throw new Error("request_token from the Kite login redirect is required");
    if (["daily_request_token", "totp_session"].includes(spec.auth) && ctx.creds.totp_seed && input.totp && input.totp !== "000000" && totp(ctx.creds.totp_seed) !== String(input.totp)) throw new Error("TOTP does not match the enrolled seed");
    if (spec.auth === "oauth" && !input.code && !input.request_token) throw new Error("authorisation code is required");
    const token = `sbx_${randomBytes(12).toString("hex")}`;
    return { access_token: token, expires_at: sessionExpiry(p, ctx.now), account_ref: ctx.connector.account_ref ?? null, detail: `${spec.name} sandbox session opened${p === "zerodha_kite" ? ` (checksum ${kiteChecksum(ctx.creds.api_key ?? "", input.request_token, ctx.creds.api_secret ?? "").slice(0, 8)}…)` : ""}` };
  },
  async read(what) { if (what === "mf_holdings") return { holdings: SANDBOX_MF_HOLDINGS }; if (what === "mf_sips") return { sips: [{ fund: "Parag Parikh Flexi Cap Fund - Direct Growth", amount: 2000, frequency: "monthly", day: 10, status: "ACTIVE" }] }; if (what === "positions" || what === "holdings") return { positions: [] }; if (what === "balance") return { balance: null, note: "sandbox: balance comes from the AA feed" }; return { note: `sandbox has no ${what}` }; },
  async mandate(action, mandate) {
    if (action === "register") return { status: "pending", provider_ref: `mand_${createHash("sha1").update(mandate.id).digest("hex").slice(0, 8)}`, auth_url: `https://s.finprim.com/mandates/${mandate.id.slice(0, 8)}/authorise`, detail: "sandbox: authorise via the link (net-banking / debit card); the next status poll activates it" };
    if (action === "status") return mandate.status === "pending" ? { status: "active", umrn: `SBX${createHash("sha1").update(mandate.id).digest("hex").replace(/\D/g, "").slice(0, 17).padEnd(17, "1")}`, provider_ref: mandate.provider_ref, detail: "sandbox: authorised by the investor" } : { status: mandate.status, umrn: mandate.umrn, provider_ref: mandate.provider_ref, detail: "unchanged" };
    return { status: "cancelled", detail: "sandbox: mandate cancelled" };
  },
  async bill(payload) { return sandboxBill(payload); },
};

// ---------- live: request built by the shared builder, credentials substituted, response mapped ----------
const substitute = (s: any, creds: Record<string, string>, extra: Record<string, string> = {}): any => { const all = { ...creds, ...extra }; if (typeof s === "string") return s.replace(/<([a-z_:]+)>/g, (_, k) => k.split(":").map((x: string) => all[x] ?? "").join(":")); if (Array.isArray(s)) return s.map((x) => substitute(x, creds, extra)); if (s && typeof s === "object") return Object.fromEntries(Object.entries(s).map(([k, v]) => [k, substitute(v, creds, extra)])); return s; };
const mapStatus = (provider: string, j: any): SubmitResult["status"] => { const s = String(j?.status ?? j?.data?.status ?? j?.state ?? j?.STATUS ?? j?.order_status ?? "").toUpperCase(); if (/COMPLETE|FILLED|SUCCESS|ALLOTTED|PROCESSED|REGISTERED/.test(s)) return "filled"; if (/REJECT|FAIL|ERROR|CANCEL/.test(s)) return "failed"; if (/PARTIAL/.test(s)) return "partially_filled"; return provider === "razorpayx" && j?.id ? "submitted" : "submitted"; };
const refOf = (j: any): string | null => j?.data?.order_id ?? j?.order_id ?? j?.orderid ?? j?.data?.orderid ?? j?.Success?.order_id ?? j?.id ?? j?.UTR ?? j?.UNIQUEID ?? j?.orderId ?? null;
const live: Adapter = {
  async submit(kind, payload, clientRef, ctx) {
    const req = buildRequest(ctx.connector.provider, kind, payload, { connector: ctx.connector, client_ref: clientRef, sandbox: false });
    if (req.method === "MANUAL") return { provider_ref: `ASSISTED-${clientRef.slice(0, 10)}`, status: "submitted", response: { assisted: true, instruction: req.body } };
    const headers = substitute(req.headers ?? {}, ctx.creds, { access_token: ctx.creds.access_token ?? "", session: ctx.creds.access_token ?? "", jwt: ctx.creds.access_token ?? "", token: ctx.creds.access_token ?? "", static_ip: ctx.connector.static_ip ?? "" });
    const body = substitute(req.body, ctx.creds, { debit_account: ctx.connector.account_ref ?? "" });
    const isForm = ctx.connector.provider === "zerodha_kite";
    const r = await guardedFetch(ctx.connector.provider, req.url, { method: req.method, headers: { ...(isForm ? { "content-type": "application/x-www-form-urlencoded" } : { "content-type": "application/json" }), ...headers }, body: isForm ? new URLSearchParams(Object.fromEntries(Object.entries(body ?? {}).filter(([, v]) => v != null).map(([k, v]) => [k, String(v)]))).toString() : JSON.stringify(body) });
    const j: any = await r.json().catch(() => ({ raw: "non-JSON response", http: r.status }));
    if (!r.ok) return { provider_ref: refOf(j) ?? `HTTP-${r.status}`, status: "failed", response: redact(j), message: j?.message ?? j?.error ?? `HTTP ${r.status}` };
    return { provider_ref: refOf(j) ?? clientRef, status: mapStatus(ctx.connector.provider, j), response: redact(j), filled_qty: j?.data?.filled_quantity ?? null, avg_price: j?.data?.average_price ?? null };
  },
  async status(clientRef, providerRef, ctx) {
    const p = ctx.connector.provider; const spec = PROVIDERS[p as Provider]; if (!providerRef) return null;
    const url = p === "zerodha_kite" ? `https://api.kite.trade/orders/${providerRef}` : p === "bse_star_mf" ? `https://api.fintechprimitives.com/v2/mf_purchases/${providerRef}` : p === "setu_bbps" ? `https://api.setu.co/api/v2/bills/payment/${providerRef}` : p === "razorpayx" ? `https://api.razorpay.com/v1/payouts/${providerRef}` : `https://${spec.hosts[0]}/api/v1/composite-status/${providerRef}`;
    const r = await guardedFetch(p, url, { headers: substitute({ Authorization: p === "zerodha_kite" ? "token <api_key>:<access_token>" : p === "razorpayx" ? "Basic <key_id:key_secret>" : "Bearer <access_token>", "X-Kite-Version": "3" }, ctx.creds) });
    const j: any = await r.json().catch(() => ({})); const last = Array.isArray(j?.data) ? j.data[j.data.length - 1] : j;
    return { provider_ref: providerRef, status: mapStatus(p, last), response: redact(last), filled_qty: last?.filled_quantity ?? null, avg_price: last?.average_price ?? null };
  },
  async cancel(_clientRef, providerRef, ctx) { const p = ctx.connector.provider; if (!providerRef) return { ok: false, response: { error: "no provider reference" } }; const url = p === "zerodha_kite" ? `https://api.kite.trade/orders/regular/${providerRef}` : p === "bse_star_mf" ? `https://api.fintechprimitives.com/v2/mf_purchases/${providerRef}/cancel` : `https://${PROVIDERS[p as Provider].hosts[0]}/cancel/${providerRef}`; const r = await guardedFetch(p, url, { method: p === "zerodha_kite" ? "DELETE" : "POST", headers: substitute({ Authorization: "token <api_key>:<access_token>", "X-Kite-Version": "3" }, ctx.creds) }); return { ok: r.ok, response: redact(await r.json().catch(() => ({}))) }; },
  async health(ctx) { const p = ctx.connector.provider; const spec = PROVIDERS[p as Provider]; const t0 = Date.now(); try { const url = p === "zerodha_kite" ? "https://api.kite.trade/user/profile" : `https://${spec.hosts[0]}/`; const r = await guardedFetch(p, url, { headers: substitute({ Authorization: "token <api_key>:<access_token>", "X-Kite-Version": "3" }, ctx.creds) }, 8000); return { ok: r.ok, latency_ms: Date.now() - t0, detail: `HTTP ${r.status}` }; } catch (e: any) { return { ok: false, latency_ms: Date.now() - t0, detail: String(e.message ?? e) }; } },
  async session(input, ctx) {
    const p = ctx.connector.provider as Provider;
    if (p === "zerodha_kite") { const r = await guardedFetch(p, "https://api.kite.trade/session/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "X-Kite-Version": "3" }, body: new URLSearchParams({ api_key: ctx.creds.api_key, request_token: input.request_token, checksum: kiteChecksum(ctx.creds.api_key, input.request_token, ctx.creds.api_secret) }).toString() }); const j: any = await r.json(); if (!r.ok || !j?.data?.access_token) throw new Error(j?.message ?? "Kite session exchange failed"); return { access_token: j.data.access_token, expires_at: sessionExpiry(p), account_ref: j.data.user_id ?? null, detail: "Kite session opened" }; }
    if (p === "upstox") { const r = await guardedFetch(p, "https://api.upstox.com/v2/login/authorization/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ code: input.code ?? input.request_token, client_id: ctx.creds.api_key, client_secret: ctx.creds.api_secret, redirect_uri: ctx.connector.config?.redirect_uri ?? "", grant_type: "authorization_code" }).toString() }); const j: any = await r.json(); if (!j?.access_token) throw new Error(j?.message ?? "Upstox token exchange failed"); return { access_token: j.access_token, expires_at: sessionExpiry(p), detail: "Upstox session opened" }; }
    if (p === "angel_smartapi") { const r = await guardedFetch(p, "https://apiconnect.angelbroking.com/rest/auth/angelbroking/user/v1/loginByPassword", { method: "POST", headers: { "content-type": "application/json", "X-PrivateKey": ctx.creds.api_key, "X-ClientLocalIP": ctx.connector.static_ip ?? "127.0.0.1", "X-ClientPublicIP": ctx.connector.static_ip ?? "127.0.0.1", "X-MACAddress": "00:00:00:00:00:00", "X-UserType": "USER", "X-SourceID": "WEB" }, body: JSON.stringify({ clientcode: ctx.creds.client_code, password: ctx.creds.pin, totp: input.totp ?? (ctx.creds.totp_seed ? totp(ctx.creds.totp_seed) : "") }) }); const j: any = await r.json(); if (!j?.data?.jwtToken) throw new Error(j?.message ?? "Angel login failed"); return { access_token: j.data.jwtToken, expires_at: sessionExpiry(p), detail: "Angel session opened" }; }
    if (p === "icici_breeze") { const r = await guardedFetch(p, "https://api.icicidirect.com/breezeapi/api/v1/customerdetails", { method: "GET", headers: { "content-type": "application/json", SessionToken: input.request_token ?? input.api_session ?? "", AppKey: ctx.creds.api_key } }); const j: any = await r.json(); if (!j?.Success?.session_token) throw new Error(j?.Error ?? "Breeze session failed"); return { access_token: j.Success.session_token, expires_at: sessionExpiry(p), detail: "Breeze session opened" }; }
    if (p === "dhan") return { access_token: input.access_token ?? ctx.creds.access_token, expires_at: sessionExpiry(p), detail: "Dhan token recorded" };
    return { expires_at: null, detail: `${PROVIDERS[p].name}: certificate / API-key auth needs no session` };
  },
  async read(what, ctx) { const p = ctx.connector.provider as Provider; if (p !== "zerodha_kite") return { note: `${what} read not implemented live for ${p}` }; const url = what === "mf_holdings" ? "https://api.kite.trade/mf/holdings" : what === "mf_sips" ? "https://api.kite.trade/mf/sips" : what === "mf_orders" ? "https://api.kite.trade/mf/orders" : what === "positions" ? "https://api.kite.trade/portfolio/positions" : "https://api.kite.trade/portfolio/holdings"; const r = await guardedFetch(p, url, { headers: substitute({ Authorization: "token <api_key>:<access_token>", "X-Kite-Version": "3" }, ctx.creds) }); const j: any = await r.json(); return { [what]: j?.data ?? j }; },
  async mandate(action, mandate, ctx) { const base = "https://api.fintechprimitives.com/v2/mandates"; const headers = { "content-type": "application/json", Authorization: `Basic ${Buffer.from(`${ctx.creds.tenant}:${ctx.creds.api_key}`).toString("base64")}`, "x-tenant-id": ctx.creds.tenant ?? "" }; if (action === "register") { const r = await guardedFetch("bse_star_mf", base, { method: "POST", headers, body: JSON.stringify({ bank_account: mandate.bank_account_ref, mandate_type: "E_MANDATE", mandate_limit: Number(mandate.amount_limit), valid_from: mandate.start_date, valid_to: mandate.end_date }) }); const j: any = await r.json(); return { status: r.ok ? "pending" : "rejected", provider_ref: j?.id ?? null, auth_url: j?.auth_url ?? null, detail: j?.status ?? `HTTP ${r.status}` }; } if (action === "status") { const r = await guardedFetch("bse_star_mf", `${base}/${mandate.provider_ref}`, { headers }); const j: any = await r.json(); const st = String(j?.status ?? "").toLowerCase(); return { status: st.includes("approv") || st === "active" ? "active" : st.includes("reject") ? "rejected" : "pending", umrn: j?.umrn ?? null, provider_ref: mandate.provider_ref, detail: j?.status }; } const r = await guardedFetch("bse_star_mf", `${base}/${mandate.provider_ref}/cancel`, { method: "POST", headers }); return { status: r.ok ? "cancelled" : mandate.status, detail: `HTTP ${r.status}` }; },
  async bill(payload, ctx) { const r = await guardedFetch("setu_bbps", "https://api.setu.co/api/v2/bills/fetch", { method: "POST", headers: { "content-type": "application/json", "X-Setu-Product-Instance-ID": ctx.creds.product_instance_id ?? "", Authorization: `Bearer ${ctx.creds.access_token ?? ""}` }, body: JSON.stringify({ billerId: payload.biller_id, customerParams: [{ name: payload.category === "property_tax" ? "Assessment Number" : "Consumer Number", value: payload.consumer_number }] }) }); return redact(await r.json().catch(() => ({}))); },
};
export function adapterFor(connector: any, sandboxOnly: boolean): { adapter: Adapter; sandbox: boolean } {
  const sandboxMode = sandboxOnly || !!connector.sandbox || connector.provider === "manual";
  return { adapter: sandboxMode ? sandbox : live, sandbox: sandboxMode };
}
export const isExecutable = (provider: string, kind: string) => capabilityFor(provider, kind) === "executable";
