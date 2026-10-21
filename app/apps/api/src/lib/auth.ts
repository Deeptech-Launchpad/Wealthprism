import { createHmac } from "node:crypto";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import type { FastifyReply, FastifyRequest } from "fastify";
import { verifyAuthenticationResponse } from "@simplewebauthn/server";
import { pool } from "./db.js";
import { config } from "../config.js";
export interface AuthUser { id: string; email: string; name: string }
export interface FamilyCtx { familyId: string; role: "owner" | "member" | "operator" | "viewer"; entityScope: string[] | null; external?: { entities?: string[]; modules?: string[]; reports?: string[]; expires_on?: string; label?: string } | null }
declare module "fastify" { interface FastifyRequest { user?: AuthUser; family?: FamilyCtx; apiKey?: any } }
export async function verifyPassword(email: string, password: string): Promise<AuthUser | null> {
  const { rows } = await pool.query("select id, email, name, password_hash from users where email = $1", [email]);
  if (!rows[0]) return null;
  const ok = await bcrypt.compare(password, rows[0].password_hash);
  return ok ? { id: rows[0].id, email: rows[0].email, name: rows[0].name } : null;
}
export function issueTokens(u: AuthUser) {
  const access = jwt.sign({ sub: u.id, email: u.email, name: u.name }, config.jwtSecret, { expiresIn: config.accessTtl });
  const refresh = jwt.sign({ sub: u.id, typ: "refresh" }, config.refreshSecret, { expiresIn: config.refreshTtl });
  return { access_token: access, refresh_token: refresh, expires_in: 900 };
}
/** Short-lived token for the report engine's internal reads: same user, flagged so the external-viewer module gate does not apply (the report scope already did). */
export function issueInternalToken(u: AuthUser) { return jwt.sign({ sub: u.id, email: u.email, name: u.name, rpt: true }, config.jwtSecret, { expiresIn: 300 }); }
export async function familiesFor(userId: string) {
  const { rows } = await pool.query("select id, name, role from user_families($1)", [userId]);
  return rows;
}
/** preHandler: requires a Bearer token only (user-level resources such as the notification inbox). */
export async function requireAuth(req: FastifyRequest, reply: FastifyReply) {
  const h = req.headers.authorization ?? "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : null;
  if (!token) return reply.code(401).send({ title: "Unauthenticated", status: 401 });
  if (token.startsWith("fo_")) {   // open-data API key (FO-104): the key's family and scopes replace the session
    const { authenticateApiKey } = await import("./opendata.js"); const r = await authenticateApiKey(token);
    if ("error" in r) return reply.code(r.status).send({ title: r.error, status: r.status });
    req.user = r.user; req.apiKey = r.key; return;
  }
  let payload: any;
  try { payload = jwt.verify(token, config.jwtSecret); } catch { return reply.code(401).send({ title: "Invalid token", status: 401 }); }
  req.user = { id: payload.sub, email: payload.email, name: payload.name }; (req as any).internal = !!payload.rpt;
}
/** preHandler: requires Bearer token and X-Family-Id; loads the membership (role + entity scope). */
export async function requireFamily(req: FastifyRequest, reply: FastifyReply) {
  await requireAuth(req, reply);
  if (reply.sent || !req.user) return;
  if (req.apiKey) {   // a key is bound to one family; scopes decide read / write per module; role derives from the scopes
    const familyId = req.apiKey.family_id; const hdr = req.headers["x-family-id"]; if (typeof hdr === "string" && hdr !== familyId) return reply.code(403).send({ title: "This key belongs to another family", status: 403 });
    const { scopeAllows } = await import("./opendata.js"); if (!scopeAllows(req.apiKey.scopes, req.method, req.url)) return reply.code(403).send({ title: "Insufficient scope", status: 403, scopes: req.apiKey.scopes });
    const write = req.apiKey.scopes.some((s: string) => s.startsWith("write:")); req.headers["x-family-id"] = familyId; req.family = { familyId, role: write ? "operator" : "viewer", entityScope: null }; return;
  }
  const familyId = req.headers["x-family-id"];
  if (typeof familyId !== "string") return reply.code(400).send({ title: "X-Family-Id header required", status: 400 });
  const { rows } = await pool.query("select role, entity_scope from user_families($2) where id = $1", [familyId, req.user.id]);
  if (!rows[0]) return reply.code(403).send({ title: "Not a member of this family", status: 403 });
  req.family = { familyId, role: rows[0].role, entityScope: rows[0].entity_scope };
  if (rows[0].role === "viewer") {   // external viewers (FO-103): a viewer membership bounded by an external_access row — scope, expiry, revocation
    const x = (await pool.query("select scope, expires_on, revoked_at, label from external_access_for($1,$2)", [familyId, req.user.id])).rows[0];
    if (x) {
      if (x.revoked_at) return reply.code(403).send({ title: "External access revoked", status: 403 });
      if (new Date(x.expires_on) < new Date(new Date().toDateString())) return reply.code(403).send({ title: `External access expired on ${String(x.expires_on).slice(0, 10)}`, status: 403 });
      req.family.external = { ...x.scope, expires_on: x.expires_on, label: x.label };
      const { moduleOf } = await import("./opendata.js"); const mod = moduleOf(req.url); const mods: string[] = x.scope?.modules ?? [];
      if (!(req as any).internal && mods.length && mod && !["family", "notifications", "dashboard"].includes(mod) && !mods.includes(mod)) return reply.code(403).send({ title: `Your access does not include ${mod.replace(/_/g, " ")}`, status: 403 });
    }
  }
}
export function requireRole(...roles: FamilyCtx["role"][]) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.family || !roles.includes(req.family.role)) return reply.code(403).send({ title: "Insufficient role", status: 403 });
  };
}
/** RFC 6238 TOTP (SHA-1, 30 s, 6 digits) for step-up authentication. Secret is base32. */
export function totp(secretB32: string, at = Date.now()): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"; let bits = ""; for (const ch of secretB32.replace(/=+$/, "").toUpperCase()) bits += alphabet.indexOf(ch).toString(2).padStart(5, "0");
  const key = Buffer.from(bits.match(/.{8}/g)!.map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8); counter.writeBigUInt64BE(BigInt(Math.floor(at / 30000)));
  const h = createHmac("sha1", key).update(counter).digest(); const o = h[h.length - 1] & 0xf;
  return String(((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000)).padStart(6, "0");
}
/** Step-up check used by approvals and signatures. Dev bypass: proof "000000" when NODE_ENV !== production. */
export async function verifyStepUp(userId: string, method: string, proof: string): Promise<boolean> {
  if (process.env.NODE_ENV !== "production" && proof === "000000") return true;
  if (method === "totp") { const u = (await pool.query("select mfa_secret from users where id = $1", [userId])).rows[0]; return !!u?.mfa_secret && totp(u.mfa_secret) === proof; }
  if (method === "passkey") return verifyPasskeyStepUp(userId, proof);
  return false;
}
/** FO-122: proof is the browser's AuthenticationResponseJSON, JSON-stringified (call POST /auth/webauthn/challenge
 *  first). Checked against the in-flight challenge and the matching registered credential; the credential's counter
 *  is advanced on success (replay protection — a reused assertion fails the next time). */
async function verifyPasskeyStepUp(userId: string, proof: string): Promise<boolean> {
  let response: any; try { response = JSON.parse(proof); } catch { return false; }
  const u = (await pool.query("select webauthn_challenge, webauthn_challenge_expires from users where id=$1", [userId])).rows[0];
  if (!u?.webauthn_challenge || new Date(u.webauthn_challenge_expires) < new Date()) return false;
  const cred = (await pool.query("select id, credential_id, public_key, counter from webauthn_credentials where user_id=$1 and credential_id=$2", [userId, response.id])).rows[0];
  if (!cred) return false;
  let verification; try {
    verification = await verifyAuthenticationResponse({ response, expectedChallenge: u.webauthn_challenge, expectedOrigin: config.webauthnOrigin, expectedRPID: config.webauthnRpId, credential: { id: cred.credential_id, publicKey: new Uint8Array(cred.public_key), counter: Number(cred.counter) } });
  } catch { return false; }
  if (!verification.verified) return false;
  await pool.query("update users set webauthn_challenge=null, webauthn_challenge_expires=null where id=$1", [userId]);
  await pool.query("update webauthn_credentials set counter=$2, last_used_at=now() where id=$1", [cred.id, verification.authenticationInfo.newCounter]);
  return true;
}
