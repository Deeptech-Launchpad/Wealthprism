/** Account Aggregator (RBI AA; PRD 3.4, FO-51): consent initiation, the signed webhook, FI fetch with ECDH/AES-GCM decryption (Rahasya-compatible key
 *  derivation), normalisation into bank_txns through the same pipeline as CSV imports, balance refresh and the 4-hourly sync.
 *  Providers implement one small interface; `mock` runs the whole flow in-process for development and tests, `finvu` (and the same HTTP shape for
 *  Onemoney / Setu behind their base URLs) talks to the AA over `fetch`, which is injectable. Nothing here ever moves money — AA is read-only. */
import type pg from "pg";
import { createHmac, createHash, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, createCipheriv, createDecipheriv, randomBytes, randomUUID, timingSafeEqual, createVerify } from "node:crypto";
import { encryptSecret, decryptSecret } from "@fo/connectors";
import { parseAaDeposit } from "@fo/parsers";
import { pool, withFamily, money } from "./db.js";
const KEY = () => process.env.FIELD_ENCRYPTION_KEY ?? "dev-only-field-key";
import { applyBankTxn, reconcileRent, reconcileDeposits } from "../routes/imports.js";
import { detectTransfers, BankingError } from "./banking.js";
import { notifyTask } from "./notify.js";
import { emitEvent } from "./opendata.js";

export const today = () => new Date().toISOString().slice(0, 10);
const iso = (d: any) => (d == null ? null : d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));
const addMonths = (iso: string, n: number) => { const d = new Date(iso + "T00:00:00Z"); d.setUTCMonth(d.getUTCMonth() + n); return d.toISOString().slice(0, 10); };

// ---------- key material (ECDH X25519 → HKDF-SHA256 → AES-256-GCM) ----------
export interface KeyMaterial { cryptoAlg: "ECDH"; curve: "Curve25519"; params: string; DHPublicKey: { expiry: string; Parameters: string; KeyValue: string }; Nonce: string }
export interface KeyPair { privateKeyPem: string; publicKeyB64: string; nonceB64: string; expiry: string }
export function generateKeyPair(days = 7): KeyPair {
  const { privateKey, publicKey } = generateKeyPairSync("x25519");
  return { privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(), publicKeyB64: publicKey.export({ type: "spki", format: "der" }).toString("base64"), nonceB64: randomBytes(32).toString("base64"), expiry: new Date(Date.now() + days * 86400000).toISOString() };
}
export const keyMaterialOf = (k: KeyPair): KeyMaterial => ({ cryptoAlg: "ECDH", curve: "Curve25519", params: "", DHPublicKey: { expiry: k.expiry, Parameters: "", KeyValue: k.publicKeyB64 }, Nonce: k.nonceB64 });
const xor = (a: Buffer, b: Buffer) => Buffer.from(a.map((x, i) => x ^ b[i % b.length]));
/** Session key and IV for one FI payload: shared secret from our private key and the FIP's public key, salted with the XOR of the two nonces. */
export function sessionKey(ourPrivateKeyPem: string, theirPublicKeyB64: string, ourNonceB64: string, theirNonceB64: string) {
  const shared = diffieHellman({ privateKey: createPrivateKey(ourPrivateKeyPem), publicKey: createPublicKey({ key: Buffer.from(theirPublicKeyB64, "base64"), format: "der", type: "spki" }) });
  const salt = xor(Buffer.from(ourNonceB64, "base64"), Buffer.from(theirNonceB64, "base64"));
  return { key: Buffer.from(hkdfSync("sha256", shared, salt, "", 32)), iv: salt.subarray(salt.length - 12) };
}
export function encryptFi(plain: string, key: Buffer, iv: Buffer): string { const c = createCipheriv("aes-256-gcm", key, iv); const body = Buffer.concat([c.update(plain, "utf8"), c.final()]); return Buffer.concat([body, c.getAuthTag()]).toString("base64"); }
export function decryptFi(b64: string, key: Buffer, iv: Buffer): string { const buf = Buffer.from(b64, "base64"); const d = createDecipheriv("aes-256-gcm", key, iv); d.setAuthTag(buf.subarray(buf.length - 16)); return Buffer.concat([d.update(buf.subarray(0, buf.length - 16)), d.final()]).toString("utf8"); }

// ---------- webhook signatures ----------
export const webhookSecret = () => process.env.AA_WEBHOOK_SECRET || "aa-dev-secret";
export const signWebhook = (raw: string, secret = webhookSecret()) => createHmac("sha256", secret).update(raw, "utf8").digest("hex");
/** HMAC-SHA256 of the raw body (`x-aa-signature`), or a detached RS256 JWS (`x-jws-signature`) when the AA's public key is configured. */
export function verifyWebhook(raw: string, headers: Record<string, any>): boolean {
  const hm = headers["x-aa-signature"]; if (typeof hm === "string" && hm) { const exp = signWebhook(raw); return hm.length === exp.length && timingSafeEqual(Buffer.from(hm), Buffer.from(exp)); }
  const jws = headers["x-jws-signature"]; const pem = process.env.AA_PROVIDER_PUBLIC_KEY;
  if (typeof jws === "string" && pem) { const [h, , s] = jws.split("."); if (!h || !s) return false; const payload = Buffer.from(raw, "utf8").toString("base64url"); const v = createVerify("RSA-SHA256"); v.update(`${h}.${payload}`); try { return v.verify(pem, Buffer.from(s, "base64url")); } catch { return false; } }
  return false;
}

// ---------- providers ----------
export interface InitiateInput { consentDbId: string; entityName: string; mobile: string; purpose: string; fiTypes: string[]; from: string; to: string; expiresOn: string; redirectUrl: string; keys: KeyPair }
export interface FetchInput { consent: any; accounts: { id: string; bank: string; account_masked: string; type: string; balance: number }[]; keys: KeyPair | null; from: string; to: string; day: string }
export interface AaProvider { name: string; initiate(i: InitiateInput): Promise<{ handle: string; redirect_url: string }>; fetch(i: FetchInput): Promise<any[]>; revoke?(consent: any): Promise<void> }
type FetchFn = (url: string, init?: any) => Promise<{ ok: boolean; status: number; json(): Promise<any>; text(): Promise<string> }>;

/** In-process sandbox: the consent is approved by `POST /aa/consent/:id/simulate` (or the signed webhook) and every fetch returns a deposit
 *  account per linked account with the day's interest credit and a small UPI debit, so a re-fetch de-duplicates to nothing new. */
export const mockProvider: AaProvider = {
  name: "mock",
  async initiate(i) { const handle = `mock-${randomUUID().slice(0, 8)}`; return { handle, redirect_url: `${process.env.PUBLIC_WEB_URL ?? ""}/aa/mock?handle=${handle}&redirect=${encodeURIComponent(i.redirectUrl)}` }; },
  async fetch(i) {
    return i.accounts.filter((a) => a.type !== "card").map((a) => {
      const last4 = a.account_masked.replace(/\D/g, "").slice(-4) || "0000"; const interest = Math.max(1, Math.round((Number(a.balance) * 0.035) / 12));
      const txns = [
        { txnId: `mock-${last4}-${i.day}-1`, type: "CREDIT", mode: "OTHERS", amount: interest.toFixed(2), currentBalance: (Number(a.balance) + interest).toFixed(2), transactionTimestamp: `${i.day}T03:30:00.000Z`, valueDate: i.day, narration: `INT.PD:${i.day.slice(0, 7)}`, reference: `INT${last4}${i.day.replace(/-/g, "")}` },
        { txnId: `mock-${last4}-${i.day}-2`, type: "DEBIT", mode: "UPI", amount: "32.40", currentBalance: (Number(a.balance) + interest - 32.4).toFixed(2), transactionTimestamp: `${i.day}T05:12:00.000Z`, valueDate: i.day, narration: "UPI/APOLLO PHARMACY/PAY", reference: `UPI${last4}${i.day.replace(/-/g, "")}` },
      ];
      return { account: { type: "deposit", maskedAccNumber: `XXXXXXXX${last4}`, linkedAccRef: `mock-${a.id}`, Summary: { currentBalance: (Number(a.balance) + interest - 32.4).toFixed(2), currency: "INR", balanceDateTime: `${i.day}T05:12:00.000Z`, type: a.type.toUpperCase(), status: "ACTIVE" }, Transactions: { startDate: i.from, endDate: i.to, Transaction: txns } } };
    });
  },
};

/** Finvu-shaped HTTP provider (Onemoney and Setu expose the same steps behind other paths — configure the base URL and paths per deployment):
 *  login → ConsentRequestPlus → the customer approves on the AA's page → webhook → FIRequest with our key material → FIFetch → decrypt. */
export function httpProvider(name: string, fetchFn: FetchFn = fetch as any): AaProvider {
  const base = (process.env.AA_BASE_URL ?? "https://aauat.finvu.in/API/V1").replace(/\/$/, ""); const hdr = () => ({ "content-type": "application/json", accept: "application/json" });
  const rid = () => randomUUID(); const ts = () => new Date().toISOString();
  async function token() {
    if (!process.env.AA_CLIENT_ID) throw new BankingError(503, `${name}: AA_CLIENT_ID / AA_CLIENT_SECRET are not configured`);
    const r = await fetchFn(`${base}${process.env.AA_LOGIN_PATH ?? "/User/Login"}`, { method: "POST", headers: hdr(), body: JSON.stringify({ header: { rid: rid(), ts: ts(), channelId: "finsense" }, body: { userId: process.env.AA_CLIENT_ID, password: process.env.AA_CLIENT_SECRET } }) });
    if (!r.ok) throw new BankingError(502, `${name} login failed (HTTP ${r.status})`); const j = await r.json(); return j.body?.token ?? j.token;
  }
  return {
    name,
    async initiate(i) {
      const t = await token();
      const body = { header: { rid: rid(), ts: ts(), channelId: "finsense" }, body: { custId: `${i.mobile}@${process.env.AA_HANDLE_SUFFIX ?? "finvu"}`, consentDescription: i.purpose, templateName: process.env.AA_CONSENT_TEMPLATE ?? "WEALTHPRISM_DEPOSIT_12M", userSessionId: i.consentDbId, redirectUrl: i.redirectUrl, fip: [], ConsentDetails: { consentStart: ts(), consentExpiry: `${i.expiresOn}T23:59:59.000Z`, consentMode: "STORE", fetchType: "PERIODIC", consentTypes: ["TRANSACTIONS", "PROFILE", "SUMMARY"], fiTypes: i.fiTypes, DataConsumer: { id: process.env.AA_FIU_ID ?? "wealthprism" }, Purpose: { code: "101", text: i.purpose }, FIDataRange: { from: `${i.from}T00:00:00.000Z`, to: `${i.to}T23:59:59.000Z` }, DataLife: { unit: "MONTH", value: 12 }, Frequency: { unit: "HOUR", value: 4 } } } };
      const r = await fetchFn(`${base}${process.env.AA_INITIATE_PATH ?? "/ConsentRequestPlus"}`, { method: "POST", headers: { ...hdr(), authorization: `Bearer ${t}` }, body: JSON.stringify(body) });
      if (!r.ok) throw new BankingError(502, `${name} consent request failed (HTTP ${r.status})`); const j = await r.json(); const handle = j.body?.consentHandle ?? j.consentHandle; if (!handle) throw new BankingError(502, `${name}: no consent handle in the response`);
      const web = (process.env.AA_WEB_URL ?? "https://webvwdev.finvu.in/consent").replace(/\/$/, "");
      return { handle, redirect_url: `${web}?consentHandle=${encodeURIComponent(handle)}&custId=${encodeURIComponent(body.body.custId)}&redirectUrl=${encodeURIComponent(i.redirectUrl)}` };
    },
    async fetch(i) {
      const t = await token(); const keys = i.keys ?? generateKeyPair();
      const req = await fetchFn(`${base}${process.env.AA_FI_REQUEST_PATH ?? "/FIRequest"}`, { method: "POST", headers: { ...hdr(), authorization: `Bearer ${t}` }, body: JSON.stringify({ header: { rid: rid(), ts: ts(), channelId: "finsense" }, body: { custId: `${i.consent.mobile}@${process.env.AA_HANDLE_SUFFIX ?? "finvu"}`, consentId: i.consent.consent_id, consentHandleId: i.consent.consent_handle, dateTimeRangeFrom: `${i.from}T00:00:00.000Z`, dateTimeRangeTo: `${i.to}T23:59:59.000Z`, keyMaterial: keyMaterialOf(keys) } }) });
      if (!req.ok) throw new BankingError(502, `${name} FI request failed (HTTP ${req.status})`); const sess = (await req.json()); const sessionId = sess.body?.sessionId ?? sess.sessionId; if (!sessionId) throw new BankingError(502, `${name}: no session id`);
      let data: any = null;
      for (let attempt = 0; attempt < 6; attempt++) {
        const r = await fetchFn(`${base}${process.env.AA_FI_FETCH_PATH ?? "/FIFetch"}/${encodeURIComponent(sessionId)}`, { method: "GET", headers: { ...hdr(), authorization: `Bearer ${t}` } });
        if (r.status === 202 || r.status === 404) { await new Promise((res) => setTimeout(res, Number(process.env.AA_POLL_MS ?? 1500))); continue; }
        if (!r.ok) throw new BankingError(502, `${name} FI fetch failed (HTTP ${r.status})`); data = await r.json(); break;
      }
      if (!data) throw new BankingError(504, `${name}: FI data not ready`);
      const out: any[] = [];
      for (const fi of data.body?.FI ?? data.FI ?? []) {
        const km = fi.KeyMaterial ?? fi.keyMaterial; const { key, iv } = sessionKey(keys.privateKeyPem, km.DHPublicKey.KeyValue, keys.nonceB64, km.Nonce);
        for (const d of fi.data ?? []) { const plain = decryptFi(d.encryptedFI, key, iv); const j = JSON.parse(plain); out.push({ account: j.account ?? j.Account ?? j, linkRefNumber: d.linkRefNumber, maskedAccNumber: d.maskedAccNumber, fipId: fi.fipID ?? fi.fipId }); }
      }
      return out;
    },
  };
}
let injected: AaProvider | null = null;
/** Tests and the CLI can pin a provider; otherwise AA_PROVIDER decides, with `mock` outside production. */
export function setProvider(p: AaProvider | null) { injected = p; }
export function providerFor(name?: string | null): AaProvider {
  if (injected) return injected;
  const n = (name ?? process.env.AA_PROVIDER ?? (process.env.NODE_ENV === "production" ? "finvu" : "mock")).toLowerCase();
  if (n === "mock") return mockProvider;
  return httpProvider(n);
}

// ---------- consent lifecycle ----------
export const consentView = (r: any) => ({ id: r.id, entity_id: r.entity_id, entity_name: r.entity_name ?? null, provider: r.provider, status: r.status, consent_handle: r.consent_handle, consent_id: r.consent_id, redirect_url: r.status === "pending" ? r.redirect_url : null, mobile: r.mobile ? String(r.mobile).replace(/\d(?=\d{4})/g, "•") : null, fi_types: r.fi_types, granted_on: iso(r.granted_on), expires_on: iso(r.expires_on), revoked_on: iso(r.revoked_on), last_fetch_at: r.last_fetch_at, next_fetch_at: r.next_fetch_at, fetch_error: r.fetch_error, accounts: r.accounts ?? [], linked_accounts: r.linked_accounts ?? undefined, created_at: r.created_at });

export async function initiateConsent(c: pg.PoolClient, familyId: string, userId: string, b: { entity_id: string; mobile: string; provider?: string; fi_types?: string[]; months?: number; purpose?: string }) {
  const ent = (await c.query("select id, name from entities where id=$1 and family_id=$2 and deleted_at is null", [b.entity_id, familyId])).rows[0]; if (!ent) throw new BankingError(404, "Entity not found");
  const provider = providerFor(b.provider); const keys = generateKeyPair(); const from = addMonths(today(), -(b.months ?? 12)), to = today(), expiresOn = addMonths(today(), 12);
  const row = (await c.query("insert into aa_consents (family_id, entity_id, provider, consent_handle, status, mobile, fi_types, purpose, data_from, data_to, key_material, expires_on) values ($1,$2,$3,$4,'pending',$5,$6,$7,$8,$9,$10,$11) returning *", [familyId, ent.id, provider.name, `pending-${randomUUID()}`, b.mobile, b.fi_types ?? ["DEPOSIT"], b.purpose ?? "Wealth management — consolidated view of bank balances and transactions", from, to, encryptSecret(JSON.stringify(keys), KEY()), expiresOn])).rows[0];
  const redirectUrl = `${process.env.PUBLIC_WEB_URL ?? ""}/banking?consent=${row.id}`;
  const r = await provider.initiate({ consentDbId: row.id, entityName: ent.name, mobile: b.mobile, purpose: row.purpose, fiTypes: row.fi_types, from, to, expiresOn, redirectUrl, keys });
  const upd = (await c.query("update aa_consents set consent_handle=$2, redirect_url=$3, updated_at=now() where id=$1 returning *", [row.id, r.handle, r.redirect_url])).rows[0];
  await c.query("insert into audit_log (family_id, user_id, action, table_name, row_id, after) values ($1,$2,'aa.initiate','aa_consents',$3,$4)", [familyId, userId, row.id, JSON.stringify({ provider: provider.name, entity: ent.name, fi_types: row.fi_types })]);
  return { consent_id: upd.id, redirect_url: upd.redirect_url, provider: provider.name, status: upd.status, consent_handle: upd.consent_handle };
}

const BANK_BY_FIP: Record<string, string> = { "HDFC-FIP": "HDFC Bank", "ICICI-FIP": "ICICI Bank", "SBI-FIP": "SBI", "KOTAK-FIP": "Kotak Bank", "AXIS-FIP": "Axis Bank", "IDFC-FIP": "IDFC First Bank", "fipmock": "Finvu Sandbox Bank" };
/** The AA's status webhook: ACTIVE links the accounts it names (matching an existing account by its last four digits, else creating one) and
 *  schedules the first fetch; REJECTED / REVOKED / EXPIRED / PAUSED are recorded as such. Idempotent per (handle, status). */
export async function handleCallback(payload: any) {
  const handle = payload.consentHandle ?? payload.consent_handle ?? payload.ConsentHandle ?? payload.consentId ?? payload.consent_id; if (!handle) throw new BankingError(422, "consentHandle missing");
  const found = (await pool.query("select id, family_id from aa_consent_lookup($1)", [handle])).rows[0]; if (!found) throw new BankingError(404, "Unknown consent handle");
  const status = String(payload.consentStatus ?? payload.status ?? "").toUpperCase(); const consentId = payload.consentId ?? payload.consent_id ?? null;
  return withFamily(found.family_id, async (c) => {
    const cur = (await c.query("select * from aa_consents where id=$1", [found.id])).rows[0]; const accounts: any[] = payload.accounts ?? payload.Accounts ?? [];
    if (status === "ACTIVE" || status === "APPROVED" || status === "READY") {
      const expires = payload.consentExpiry ? String(payload.consentExpiry).slice(0, 10) : iso(cur.expires_on) ?? addMonths(today(), 12);
      await c.query("update aa_consents set status='active', consent_id=coalesce($2, consent_id), granted_on=coalesce(granted_on, current_date), expires_on=$3, accounts=$4, next_fetch_at=now(), fetch_error=null, updated_at=now() where id=$1", [found.id, consentId, expires, JSON.stringify(accounts)]);
      const linked: string[] = [];
      for (const a of accounts) {
        const last4 = String(a.maskedAccNumber ?? a.masked ?? "").replace(/\D/g, "").slice(-4); if (!last4) continue;
        const ex = (await c.query("select id from bank_accounts where family_id=$1 and entity_id=$2 and deleted_at is null and right(regexp_replace(account_masked, '\\D', '', 'g'), 4)=$3 limit 1", [found.family_id, cur.entity_id, last4])).rows[0];
        if (ex) { await c.query("update bank_accounts set aa_consent_id=$2, sync_mode='aa' where id=$1", [ex.id, found.id]); linked.push(ex.id); continue; }
        const type = /CURRENT/i.test(a.accType ?? a.type ?? "") ? "current" : /CARD/i.test(a.accType ?? a.FIType ?? "") ? "card" : "savings";
        const r = (await c.query("insert into bank_accounts (family_id, entity_id, bank, account_masked, type, aa_consent_id, balance, balance_as_of, sync_mode) values ($1,$2,$3,$4,$5,$6,0,now(),'aa') returning id", [found.family_id, cur.entity_id, a.bank ?? BANK_BY_FIP[a.fipId ?? a.fipID ?? ""] ?? a.fipName ?? a.fipId ?? "Bank", `••${last4}`, type, found.id])).rows[0];
        linked.push(r.id);
      }
      await c.query("insert into audit_log (family_id, action, table_name, row_id, after) values ($1,'aa.active','aa_consents',$2,$3)", [found.family_id, found.id, JSON.stringify({ accounts: accounts.length, linked })]);
      await emitEvent(c, found.family_id, "aa.consent", { consent_id: found.id, status: "active", accounts: linked.length }).catch(() => null);
      return { id: found.id, status: "active", linked };
    }
    const map: Record<string, string> = { REJECTED: "rejected", REVOKED: "revoked", EXPIRED: "expired", PAUSED: "paused", DENIED: "rejected" };
    const next = map[status]; if (!next) throw new BankingError(422, `Unknown consent status ${status || "(blank)"}`);
    await c.query("update aa_consents set status=$2, revoked_on=case when $2 in ('revoked','expired') then current_date else revoked_on end, updated_at=now() where id=$1", [found.id, next]);
    if (next === "revoked" || next === "expired") { const t = (await c.query("insert into tasks (family_id, entity_id, module, title, reason, severity, source_type, source_id, verification) values ($1,$2,'banking',$3,$4,2,'aa_consent',$5,'na') on conflict do nothing returning *", [found.family_id, cur.entity_id, `Account Aggregator consent ${next} — re-link the bank accounts`, `${cur.provider} reported the consent as ${next}; balances and transactions stop updating until a new consent is granted`, found.id])).rows[0]; if (t) await notifyTask(c, t).catch(() => null); }
    return { id: found.id, status: next, linked: [] };
  });
}

// ---------- fetch / sync ----------
/** Fetch FI data for one consent and run every account through the import pipeline (de-duplication on the AA reference, categorisation, rent
 *  reconciliation, internal transfers); balances move to the AA's summary. */
export async function syncConsent(c: pg.PoolClient, familyId: string, consentId: string, opts: { provider?: AaProvider; day?: string } = {}) {
  const consent = (await c.query("select * from aa_consents where id=$1 and family_id=$2", [consentId, familyId])).rows[0]; if (!consent) throw new BankingError(404, "Consent not found");
  if (consent.status !== "active") throw new BankingError(409, `Consent is ${consent.status}`);
  if (consent.expires_on && iso(consent.expires_on)! < today()) { await c.query("update aa_consents set status='expired', updated_at=now() where id=$1", [consentId]); throw new BankingError(409, "Consent has expired"); }
  const accounts = (await c.query("select id, bank, account_masked, type, balance, entity_id from bank_accounts where family_id=$1 and aa_consent_id=$2 and deleted_at is null", [familyId, consentId])).rows.map((a) => ({ ...a, balance: Number(a.balance) }));
  const provider = opts.provider ?? providerFor(consent.provider); const day = opts.day ?? today();
  const keys: KeyPair | null = consent.key_material ? JSON.parse(decryptSecret(consent.key_material, KEY())) : null;
  const from = consent.last_fetch_at ? new Date(new Date(consent.last_fetch_at).getTime() - 3 * 86400000).toISOString().slice(0, 10) : consent.data_from ? iso(consent.data_from)! : addMonths(day, -12);
  const out = { consent_id: consentId, provider: provider.name, accounts: 0, txns_new: 0, txns_dup: 0, rent_matched: 0, deposits_matched: 0, transfers: 0, balances: [] as { bank_account_id: string; balance: string }[], errors: [] as string[] };
  await c.query("savepoint aa_sync");
  try {
    const fis = await provider.fetch({ consent, accounts, keys, from, to: day, day });
    for (const fi of fis) {
      const parsed = parseAaDeposit(fi); const last4 = String(parsed.masked ?? fi.maskedAccNumber ?? "").replace(/\D/g, "").slice(-4);
      let acct = accounts.find((a) => a.account_masked.replace(/\D/g, "").slice(-4) === last4) ?? (await c.query("select id, bank, account_masked, type, balance, entity_id from bank_accounts where family_id=$1 and entity_id=$2 and deleted_at is null and right(regexp_replace(account_masked, '\\D', '', 'g'), 4)=$3 limit 1", [familyId, consent.entity_id, last4])).rows[0];
      if (!acct) { const r = (await c.query("insert into bank_accounts (family_id, entity_id, bank, account_masked, type, aa_consent_id, balance, balance_as_of, sync_mode) values ($1,$2,$3,$4,$5,$6,0,now(),'aa') returning id, bank, account_masked, type, balance, entity_id", [familyId, consent.entity_id, BANK_BY_FIP[fi.fipId ?? ""] ?? "Bank", `••${last4}`, /CURRENT/i.test(fi.account?.Summary?.type ?? "") ? "current" : "savings", consentId])).rows[0]; acct = r; }
      else if (!(await c.query("select 1 from bank_accounts where id=$1 and aa_consent_id=$2", [acct.id, consentId])).rowCount) await c.query("update bank_accounts set aa_consent_id=$2, sync_mode='aa' where id=$1", [acct.id, consentId]);
      let added = 0, dup = 0;
      for (const t of parsed.rows) { const r = await applyBankTxn(c, familyId, acct.id, t); if (r === "ok") added++; else dup++; }
      if (parsed.balance != null) await c.query("update bank_accounts set balance=$2, balance_as_of=$3, sync_mode='aa' where id=$1", [acct.id, parsed.balance, parsed.balanceAsOf ?? new Date().toISOString()]);
      await c.query("insert into aa_fetches (family_id, consent_id, bank_account_id, from_date, to_date, txns_new, txns_dup, balance, status) values ($1,$2,$3,$4,$5,$6,$7,$8,'ok')", [familyId, consentId, acct.id, from, day, added, dup, parsed.balance ?? null]);
      out.accounts++; out.txns_new += added; out.txns_dup += dup; out.balances.push({ bank_account_id: acct.id, balance: money(parsed.balance ?? acct.balance) });
    }
    if (out.txns_new) { out.rent_matched = await reconcileRent(c, familyId); out.deposits_matched = await reconcileDeposits(c, familyId); out.transfers = (await detectTransfers(c, familyId)).rows; }
    await c.query("update aa_consents set last_fetch_at=now(), next_fetch_at=now() + interval '4 hours', fetch_error=null, updated_at=now() where id=$1", [consentId]);
    if (out.txns_new) await emitEvent(c, familyId, "bank.synced", { consent_id: consentId, accounts: out.accounts, txns_new: out.txns_new }).catch(() => null);
  } catch (e: any) {
    await c.query("rollback to savepoint aa_sync");
    await c.query("insert into aa_fetches (family_id, consent_id, from_date, to_date, status, error) values ($1,$2,$3,$4,'failed',$5)", [familyId, consentId, from, day, String(e.message).slice(0, 500)]);
    await c.query("update aa_consents set fetch_error=$2, next_fetch_at=now() + interval '1 hour', updated_at=now() where id=$1", [consentId, String(e.message).slice(0, 500)]);
    if (e instanceof BankingError) throw e; throw new BankingError(502, `AA fetch failed: ${e.message}`);
  }
  return out;
}
export async function syncAccount(c: pg.PoolClient, familyId: string, bankAccountId: string, opts: { provider?: AaProvider; day?: string } = {}) {
  const a = (await c.query("select id, aa_consent_id, sync_mode from bank_accounts where id=$1 and family_id=$2 and deleted_at is null", [bankAccountId, familyId])).rows[0]; if (!a) throw new BankingError(404, "Bank account not found");
  if (!a.aa_consent_id) throw new BankingError(409, "This account has no Account Aggregator consent — import a statement or connect it first");
  return syncConsent(c, familyId, a.aa_consent_id, opts);
}
/** Worker: every active consent whose next fetch is due (4-hourly), all families. */
export async function syncDueAll(opts: { provider?: AaProvider } = {}) {
  const fams = (await pool.query("select id from families")).rows; let consents = 0, txns = 0, failed = 0;
  for (const f of fams) {
    const due = await withFamily(f.id, async (c) => (await c.query("select id from aa_consents where status='active' and (next_fetch_at is null or next_fetch_at <= now()) and (expires_on is null or expires_on >= current_date)")).rows);
    for (const d of due) { try { const r = await withFamily(f.id, (c) => syncConsent(c, f.id, d.id, opts)); consents++; txns += r.txns_new; } catch { failed++; } }
  }
  return { rows: txns, note: `${consents} consent${consents === 1 ? "" : "s"} fetched, ${txns} new transactions${failed ? `, ${failed} failed` : ""}` };
}
export async function revokeConsent(c: pg.PoolClient, familyId: string, id: string, userId: string) {
  const cur = (await c.query("select * from aa_consents where id=$1 and family_id=$2", [id, familyId])).rows[0]; if (!cur) throw new BankingError(404, "Consent not found");
  const p = providerFor(cur.provider); if (p.revoke) await p.revoke(cur).catch(() => null);
  const r = (await c.query("update aa_consents set status='revoked', revoked_on=current_date, updated_at=now() where id=$1 returning *", [id])).rows[0];
  await c.query("update bank_accounts set sync_mode='manual' where aa_consent_id=$1", [id]);
  await c.query("insert into audit_log (family_id, user_id, action, table_name, row_id, before, after) values ($1,$2,'aa.revoke','aa_consents',$3,$4,$5)", [familyId, userId, id, JSON.stringify({ status: cur.status }), JSON.stringify({ status: "revoked" })]);
  return consentView(r);
}
export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
