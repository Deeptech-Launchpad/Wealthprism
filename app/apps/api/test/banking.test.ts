import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { buildApp } from "../src/server.js";
import { pool, withFamily } from "../src/lib/db.js";
import { signWebhook, syncConsent, httpProvider, setProvider, generateKeyPair, sessionKey, encryptFi, decryptFi } from "../src/lib/aa.js";
import { patternFromNarration } from "../src/lib/banking.js";

// Banking (PRD 3.4; FO-51, 52, 54): Account Aggregator consent → webhook → fetch → bank_txns through the import pipeline; learned rules;
// internal transfers; the cash-flow view; manual accounts and committed outflows. Self-cleaning; seeded accounts are restored.
const FAMILY = "11111111-1111-1111-1111-111111111111", ARJUN = "33333333-0000-0000-0000-000000000001", HUF = "33333333-0000-0000-0000-000000000002", SPOUSE = "33333333-0000-0000-0000-000000000003";
const HDFC = "89898989-0000-0000-0000-000000000001", KOTAK = "89898989-0000-0000-0000-000000000003", ICICI = "89898989-0000-0000-0000-000000000002", SEED_CONSENT_ARJUN = "88888888-0000-0000-0000-000000000001";
const TODAY = new Date().toISOString().slice(0, 10);
let app: ReturnType<typeof buildApp>; let owner = "";
const h = (t = owner) => ({ authorization: `Bearer ${t}`, "x-family-id": FAMILY });
const get = async (url: string, t = owner) => { const r = await app.inject({ url: `/api/v1${url}`, headers: h(t) }); return { code: r.statusCode, body: r.json() }; };
const send = async (method: "POST" | "PATCH" | "DELETE", url: string, payload: any = {}, t = owner) => { const r = await app.inject({ method, url: `/api/v1${url}`, headers: h(t), payload }); return { code: r.statusCode, body: r.statusCode === 204 ? null : r.json() }; };
const run = <T>(fn: (c: any) => Promise<T>) => withFamily(FAMILY, fn);
const SAMPLE = JSON.parse(readFileSync(new URL("../../../../samples/aa_fi_data_deposit_sample.json", import.meta.url), "utf8"));
const SAMPLE_REFS: string[] = SAMPLE.account.Transactions.Transaction.map((t: any) => t.reference); const SAMPLE_NARR: string[] = SAMPLE.account.Transactions.Transaction.map((t: any) => t.narration);
let before: any = {};

beforeAll(async () => {
  app = buildApp(); await app.ready();
  owner = (await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: "arjun@example.com", password: "Prototype!2026" } })).json().access_token;
  await run(async (c) => { before.accounts = (await c.query("select id, balance, balance_as_of, sync_mode, aa_consent_id from bank_accounts where id = any($1::uuid[])", [[HDFC, KOTAK, ICICI]])).rows; before.apollo = (await c.query("select id, category_id, link_type, link_id from bank_txns where hash='h002'")).rows[0]; });
  await cleanup();
  before.txnIds = await run(async (c) => (await c.query("select id from bank_txns where family_id=$1", [FAMILY])).rows.map((r) => r.id));
});
async function cleanup() {
  await run(async (c) => {
    if (before.txnIds) await c.query("delete from bank_txns where family_id=$1 and id::text <> all($2::text[])", [FAMILY, before.txnIds]);   // precise after a run
    await c.query("delete from bank_txns where family_id=$1 and (hash like 'bank-test-%' or (source='aa' and hash not like 'h00%' and (narration like 'INT.PD:%' or narration = 'UPI/APOLLO PHARMACY/PAY' or narration = any($2::text[]))))", [FAMILY, SAMPLE_NARR]);   // leftovers of an interrupted run
    await c.query("delete from tasks where family_id=$1 and source_type='aa_consent' and source_id in (select id from aa_consents where provider in ('mock','finvu-test'))", [FAMILY]);
    await c.query("delete from aa_fetches where family_id=$1 and consent_id in (select id from aa_consents where provider in ('mock','finvu-test'))", [FAMILY]);
    for (const a of before.accounts ?? []) await c.query("update bank_accounts set balance=$2, balance_as_of=$3, sync_mode=$4, aa_consent_id=$5 where id=$1", [a.id, a.balance, a.balance_as_of, a.sync_mode, a.aa_consent_id]);
    await c.query("delete from bank_accounts where family_id=$1 and (account_masked in ('••9001','••7890') or bank='Test Bank')", [FAMILY]);
    await c.query("delete from aa_consents where family_id=$1 and provider in ('mock','finvu-test')", [FAMILY]);
    await c.query("delete from categorisation_rules where family_id=$1 and (learned or name like 'Test rule%')", [FAMILY]);
    await c.query("delete from committed_outflows where family_id=$1 and label like 'Test outflow%'", [FAMILY]);
    if (before.apollo) await c.query("update bank_txns set category_id=$2, link_type=$3, link_id=$4, is_transfer=false where id=$1", [before.apollo.id, before.apollo.category_id, before.apollo.link_type, before.apollo.link_id]);
    await c.query("update bank_txns set is_transfer=false, transfer_txn_id=null where family_id=$1 and is_transfer and txn_date >= current_date - 60", [FAMILY]);
  });
  setProvider(null);
}
afterAll(async () => { await cleanup(); await app.close(); await pool.end(); });

describe("Account Aggregator", () => {
  let consentId = "", handle = "";
  it("initiates a consent, refuses a bad webhook signature, and links the accounts the signed webhook names", async () => {
    const r = await send("POST", "/aa/consent/initiate", { entity_id: ARJUN, mobile: "9876543210", provider: "mock" }); expect(r.code).toBe(200);
    expect(r.body.provider).toBe("mock"); expect(r.body.status).toBe("pending"); expect(r.body.redirect_url).toContain(`handle=${r.body.consent_handle}`); consentId = r.body.consent_id; handle = r.body.consent_handle;
    expect((await get("/aa/consents")).body.find((x: any) => x.id === consentId)).toMatchObject({ status: "pending", entity_name: "Arjun Mehta", mobile: "••••••3210" });
    const payload = JSON.stringify({ consentHandle: handle, consentId: "mock-consent-1", consentStatus: "ACTIVE", accounts: [{ maskedAccNumber: "XXXXXXXX4471", accType: "SAVINGS", fipId: "HDFC-FIP" }, { maskedAccNumber: "XXXXXXXX9001", accType: "SAVINGS", fipId: "fipmock" }] });
    const bad = await app.inject({ method: "POST", url: "/api/v1/aa/consent/callback", headers: { "content-type": "application/json", "x-aa-signature": "deadbeef" }, payload }); expect(bad.statusCode).toBe(401);
    const ok = await app.inject({ method: "POST", url: "/api/v1/aa/consent/callback", headers: { "content-type": "application/json", "x-aa-signature": signWebhook(payload) }, payload }); expect(ok.statusCode).toBe(200); expect(ok.json().linked.length).toBe(2);
    const c = (await get(`/aa/consents/${consentId}`)).body; expect(c.status).toBe("active"); expect(c.consent_id).toBe("mock-consent-1"); expect(c.expires_on.slice(0, 4)).toBe(String(Number(TODAY.slice(0, 4)) + 1)); expect(c.accounts.length).toBe(2);
    const accts = (await get("/bank-accounts")).body; expect(accts.find((a: any) => a.id === HDFC).consent_expires_on.slice(0, 10)).toBe(c.expires_on);
    const created = accts.find((a: any) => a.account_masked === "••9001"); expect(created).toMatchObject({ bank: "Finvu Sandbox Bank", sync_mode: "aa", entity_id: ARJUN });
    expect((await app.inject({ method: "POST", url: "/api/v1/aa/consent/callback", headers: { "content-type": "application/json", "x-aa-signature": signWebhook("{}") }, payload: "{}" })).statusCode).toBe(422);
  });
  it("sync fetches FI data through the import pipeline, updates balances and de-duplicates the next fetch", async () => {
    const bal0 = Number((await get("/bank-accounts")).body.find((a: any) => a.id === HDFC).balance);
    const s = await send("POST", `/bank-accounts/${HDFC}/sync`); expect(s.code).toBe(202); expect(s.body).toMatchObject({ provider: "mock", accounts: 2, txns_new: 4, txns_dup: 0 });
    const interest = Math.max(1, Math.round((bal0 * 0.035) / 12)); const bal1 = Number((await get("/bank-accounts")).body.find((a: any) => a.id === HDFC).balance); expect(Math.abs(bal1 - (bal0 + interest - 32.4))).toBeLessThan(0.01);
    const again = await send("POST", `/aa/consents/${consentId}/sync`); expect(again.body).toMatchObject({ txns_new: 0, txns_dup: 4 });
    const detail = (await get(`/aa/consents/${consentId}`)).body; expect(detail.fetches.length).toBeGreaterThanOrEqual(4); expect(detail.last_fetch_at).toBeTruthy(); expect(detail.next_fetch_at).toBeTruthy();
    const tx = (await get(`/bank-txns?account_id=${HDFC}&from=${TODAY}`)).body.items; expect(tx.find((t: any) => t.narration.startsWith("INT.PD")).category).toBe("Interest"); expect(tx.find((t: any) => t.narration.includes("APOLLO")).category).toBe("Medical"); expect(tx.every((t: any) => t.source === "aa")).toBe(true);
  });
  it("re-categorising with learn_rule writes a rule the next fetch applies", async () => {
    const household = (await get("/categories")).body.find((c: any) => c.name === "Household").id; const apollo = await run(async (c) => (await c.query("select id from bank_txns where hash='h002'")).rows[0].id);
    const p = await send("PATCH", `/bank-txns/${apollo}`, { category_id: household, learn_rule: true }); expect(p.code).toBe(200); expect(p.body.category).toBe("Household"); expect(p.body.learned_rule.pattern).toBe("APOLLO\\s+PHARMACY");
    const rules = (await get("/categorisation-rules")).body; const learned = rules.find((r: any) => r.pattern === "APOLLO\\s+PHARMACY"); expect(learned).toMatchObject({ learned: true, priority: 5, category: "Household", active: true });
    expect((await send("POST", "/categorisation-rules/test", { narration: "UPI/APOLLO PHARMACY/PAY 2026" })).body.matched.id).toBe(learned.id);
    const nextDay = new Date(Date.now() + 86400000).toISOString().slice(0, 10);   // the mock AA keys its transactions by day; the first sync used today
    const next = await run((c) => syncConsent(c, FAMILY, consentId, { day: nextDay })); expect(next.txns_new).toBe(4);
    const tx = (await get(`/bank-txns?account_id=${HDFC}&from=${nextDay}&to=${nextDay}`)).body.items; expect(tx.find((t: any) => t.narration.includes("APOLLO")).category).toBe("Household");
    expect(Number((await get("/categorisation-rules")).body.find((r: any) => r.id === learned.id).hits)).toBeGreaterThanOrEqual(2);
    expect(patternFromNarration("NEFT KOVAI ANALYTICS PVT LTD RENT SEP 12/09/2026 N2542609")).toBe("KOVAI\\s+ANALYTICS\\s+RENT");
  });
  it("revoking a consent stops the sync and the accounts fall back to manual", async () => {
    const r = await send("DELETE", `/aa/consents/${consentId}`); expect(r.code).toBe(200); expect(r.body.status).toBe("revoked");
    expect((await send("POST", `/bank-accounts/${HDFC}/sync`)).code).toBe(409);
    expect((await get("/bank-accounts")).body.find((a: any) => a.id === HDFC).sync_mode).toBe("manual");
  });
  it("the Finvu-shaped provider logs in, raises the consent request and decrypts FI data with the session key", async () => {
    process.env.AA_CLIENT_ID = "fiu-test"; process.env.AA_CLIENT_SECRET = "secret"; const calls: { url: string; body?: any }[] = []; let ourKm: any = null;
    const fip = generateKeyPair(); const plain = JSON.stringify(SAMPLE);
    const fetchFn: any = async (url: string, init: any) => { const body = init?.body ? JSON.parse(init.body) : undefined; calls.push({ url, body }); const ok = (j: any, status = 200) => ({ ok: status < 300, status, json: async () => j, text: async () => JSON.stringify(j) });
      if (url.endsWith("/User/Login")) return ok({ body: { token: "tok" } });
      if (url.endsWith("/ConsentRequestPlus")) return ok({ body: { consentHandle: "fv-handle-1" } });
      if (url.endsWith("/FIRequest")) { ourKm = body.body.keyMaterial; return ok({ body: { sessionId: "sess-1" } }); }
      if (url.includes("/FIFetch/")) { if (calls.filter((c) => c.url.includes("/FIFetch/")).length === 1) return ok({}, 202); const { key, iv } = sessionKey(fip.privateKeyPem, ourKm.DHPublicKey.KeyValue, fip.nonceB64, ourKm.Nonce); return ok({ body: { FI: [{ fipID: "ICICI-FIP", KeyMaterial: { DHPublicKey: { KeyValue: fip.publicKeyB64 }, Nonce: fip.nonceB64 }, data: [{ linkRefNumber: "ref-huf-0928", maskedAccNumber: "XXXXXXXX0928", encryptedFI: encryptFi(plain, key, iv) }] }] } }); }
      return ok({ title: "unexpected" }, 500); };
    process.env.AA_POLL_MS = "10"; const p = httpProvider("finvu-test", fetchFn);
    const keys = generateKeyPair(); const init = await p.initiate({ consentDbId: "c1", entityName: "Mehta HUF", mobile: "9000000001", purpose: "test", fiTypes: ["DEPOSIT"], from: "2025-09-12", to: TODAY, expiresOn: "2027-09-12", redirectUrl: "http://localhost/banking", keys });
    expect(init.handle).toBe("fv-handle-1"); expect(init.redirect_url).toContain("consentHandle=fv-handle-1"); const cr = calls.find((c) => c.url.endsWith("/ConsentRequestPlus"))!.body.body; expect(cr.custId).toBe("9000000001@finvu"); expect(cr.ConsentDetails.fiTypes).toEqual(["DEPOSIT"]); expect(cr.ConsentDetails.Frequency).toEqual({ unit: "HOUR", value: 4 });
    const consentId2 = await run(async (c) => (await c.query("insert into aa_consents (family_id, entity_id, provider, consent_handle, consent_id, status, mobile, granted_on, expires_on, data_from) values ($1,$2,'finvu-test','fv-handle-1','fv-consent-1','active','9000000001',current_date,current_date + 365,current_date - 365) returning id", [FAMILY, HUF])).rows[0].id);
    const bal0 = await run(async (c) => Number((await c.query("select balance from bank_accounts where id=$1", [ICICI])).rows[0].balance)); expect(bal0).not.toBe(Number(SAMPLE.account.Summary.currentBalance) + 1);
    const s = await run((c) => syncConsent(c, FAMILY, consentId2, { provider: p })); expect(s.accounts).toBe(1); expect(s.txns_new).toBe(SAMPLE_REFS.length); expect(s.balances[0]).toEqual({ bank_account_id: ICICI, balance: Number(SAMPLE.account.Summary.currentBalance).toFixed(2) });
    expect(calls.filter((c) => c.url.includes("/FIFetch/")).length).toBe(2);   // one 202, then the data
    const linked = await run(async (c) => (await c.query("select aa_consent_id from bank_accounts where id=$1", [ICICI])).rows[0].aa_consent_id); expect(linked).toBe(consentId2);
    // the key schedule is symmetric and tamper-evident
    const a = sessionKey(keys.privateKeyPem, fip.publicKeyB64, keys.nonceB64, fip.nonceB64), b = sessionKey(fip.privateKeyPem, keys.publicKeyB64, fip.nonceB64, keys.nonceB64); expect(a.key.equals(b.key)).toBe(true); expect(a.iv.equals(b.iv)).toBe(true);
    expect(decryptFi(encryptFi("hello", a.key, a.iv), b.key, b.iv)).toBe("hello"); expect(() => decryptFi(encryptFi("hello", a.key, a.iv).replace(/.$/, "A"), b.key, b.iv)).toThrow();
    delete process.env.AA_CLIENT_ID; delete process.env.AA_CLIENT_SECRET;
  });
});

describe("transactions and cash flow", () => {
  it("flags internal transfers between own accounts and keeps them out of the cash flow", async () => {
    const base = (await get("/cashflow?days=30")).body; expect(Number(base.inflows) - Number(base.outflows)).toBeCloseTo(Number(base.net), 1);
    await run((c) => c.query("insert into bank_txns (family_id, bank_account_id, txn_date, narration, amount, hash, source) values ($1,$2,current_date,'IMPS TO OWN KOTAK 7715',-5000,'bank-test-t1','csv'), ($1,$3,current_date,'IMPS FROM HDFC 4471',5000,'bank-test-t2','csv')", [FAMILY, HDFC, KOTAK]));
    const d = await send("POST", "/bank-txns/detect-transfers", { days: 10 }); expect(d.body.rows).toBe(1);
    const after = (await get("/cashflow?days=30")).body; expect(Math.abs(Number(after.outflows) - Number(base.outflows))).toBeLessThan(0.01); expect(Number(after.transfers_excluded)).toBeGreaterThanOrEqual(5000);
    const hidden = (await get(`/bank-txns?account_id=${HDFC}&q=OWN KOTAK`)).body; expect(hidden.items.length).toBe(0);
    const shown = (await get(`/bank-txns?account_id=${HDFC}&q=OWN KOTAK&include_transfers=1`)).body; expect(shown.items[0]).toMatchObject({ is_transfer: true, link_type: "transfer", category: "Internal transfer" });
  });
  it("reports inflows, outflows, net, kinds by category, entities and months; only 30 / 90 / 365 days", async () => {
    const f = (await get("/cashflow?days=90")).body; expect(f.days).toBe(90); expect(f.txns).toBeGreaterThan(5);
    expect(f.by_category.every((c: any) => ["inflow", "outflow"].includes(c.kind))).toBe(true);
    expect(Math.abs(f.by_category.filter((c: any) => c.kind === "inflow").reduce((s: number, c: any) => s + Number(c.amount), 0) - Number(f.inflows))).toBeLessThan(0.01);
    expect(f.by_category.find((c: any) => c.category === "Rental income")).toBeTruthy(); expect(f.by_entity.length).toBe(3); expect(f.top_counterparties.length).toBeGreaterThan(0);
    expect((await get("/cashflow?days=365")).body.by_month.length).toBeGreaterThanOrEqual(1); expect((await get("/cashflow?days=7")).code).toBe(422);
    const huf = (await get(`/cashflow?days=90&entity_id=${HUF}`)).body; expect(huf.by_entity.length).toBe(1); expect(huf.by_entity[0].entity).toBe("Mehta HUF");
    const search = (await get("/bank-txns?q=KOVAI&kind=credit")).body; expect(search.items.length).toBeGreaterThanOrEqual(1); expect(search.total).toBe(search.items.length);
  });
  it("manual accounts and committed outflows are created, updated and removed", async () => {
    const a = await send("POST", "/bank-accounts", { entity_id: SPOUSE, bank: "Test Bank", account_masked: "1234567890", type: "savings", balance: 1000 }); expect(a.code).toBe(201); expect(a.body.account_masked).toBe("••7890"); expect(a.body.sync_mode).toBe("manual");
    expect((await send("PATCH", `/bank-accounts/${a.body.id}`, { balance: 1500 })).body.balance).toBe("1500.00");
    const due = new Date(Date.now() + 20 * 86400000).toISOString().slice(0, 10);
    const o = await send("POST", "/committed-outflows", { entity_id: SPOUSE, label: "Test outflow — school fees", due_date: due, amount: 3000 }); expect(o.code).toBe(201); expect(o.body).toMatchObject({ kind: "manual", source: "manual", amount: "3000.00", due_date: due });
    expect((await get("/committed-outflows?days=30")).body.some((x: any) => x.id === o.body.id)).toBe(true);
    expect((await send("PATCH", `/committed-outflows/${o.body.id}`, { status: "done" })).body.status).toBe("done");
    expect((await send("DELETE", `/committed-outflows/${o.body.id}`)).code).toBe(204); expect((await send("DELETE", `/bank-accounts/${a.body.id}`)).code).toBe(204);
    expect((await send("POST", "/categorisation-rules", { pattern: "(", name: "Test rule bad" })).code).toBe(422);
    const r = await send("POST", "/categorisation-rules", { pattern: "SWIGGY|ZOMATO", name: "Test rule dining", category_id: (await get("/categories")).body.find((c: any) => c.name === "Dining").id, priority: 8 }); expect(r.code).toBe(201);
    expect((await send("PATCH", `/categorisation-rules/${r.body.id}`, { active: false })).body.active).toBe(false); expect((await send("DELETE", `/categorisation-rules/${r.body.id}`)).code).toBe(204);
  });
});
