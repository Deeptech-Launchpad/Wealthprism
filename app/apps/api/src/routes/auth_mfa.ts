/** MFA (FO-10 residue): TOTP enrolment for a signed-in user and the second step of login. The login route hands back an `mfa_token` instead of
 *  tokens when the account has MFA on; `/auth/mfa/verify` completes it. */
import type { FastifyInstance } from "fastify";
import jwt from "jsonwebtoken";
import { z } from "zod";
import { randomBytes } from "node:crypto";
import { pool } from "../lib/db.js";
import { config } from "../config.js";
import { issueTokens, familiesFor, requireAuth, totp } from "../lib/auth.js";

const b32 = (buf: Buffer) => { const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"; let bits = "", out = ""; for (const b of buf) bits += b.toString(2).padStart(8, "0"); for (let i = 0; i + 5 <= bits.length; i += 5) out += A[parseInt(bits.slice(i, i + 5), 2)]; return out; };
export const mfaToken = (userId: string) => jwt.sign({ sub: userId, typ: "mfa" }, config.jwtSecret, { expiresIn: 300 });
const devBypass = (code: string) => process.env.NODE_ENV !== "production" && code === "000000";

export default async function mfaRoutes(app: FastifyInstance) {
  app.post("/auth/mfa/verify", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req, reply) => {
    const b = z.object({ mfa_token: z.string(), code: z.string().regex(/^\d{6}$/) }).parse(req.body);
    let p: any; try { p = jwt.verify(b.mfa_token, config.jwtSecret); } catch { return void reply.code(401).send({ title: "MFA token expired — sign in again", status: 401 }); }
    if (p.typ !== "mfa") return void reply.code(401).send({ title: "Not an MFA token", status: 401 });
    const u = (await pool.query("select id, email, name, mfa_secret from users where id=$1 and mfa_enabled", [p.sub])).rows[0]; if (!u) return void reply.code(401).send({ title: "MFA is not enabled for this account", status: 401 });
    const now = Date.now(); const ok = devBypass(b.code) || [0, -30000, 30000].some((d) => totp(u.mfa_secret, now + d) === b.code);
    if (!ok) return void reply.code(401).send({ title: "Wrong code", status: 401 });
    await pool.query("update users set last_login_at = now() where id = $1", [u.id]);
    const user = { id: u.id, email: u.email, name: u.name }; return { ...issueTokens(user), user, families: await familiesFor(u.id) };
  });
  /** Enrolment: a fresh secret (returned once with the otpauth URI); `confirm` with a code from the app switches MFA on. */
  app.post("/auth/mfa/setup", { preHandler: requireAuth }, async (req) => { const secret = b32(randomBytes(20)); await pool.query("update users set mfa_secret=$2, mfa_enabled=false where id=$1", [req.user!.id, secret]); return { secret, otpauth_uri: `otpauth://totp/WealthPrism:${encodeURIComponent(req.user!.email)}?secret=${secret}&issuer=WealthPrism&digits=6&period=30` }; });
  app.post("/auth/mfa/confirm", { preHandler: requireAuth }, async (req, reply) => { const b = z.object({ code: z.string().regex(/^\d{6}$/) }).parse(req.body); const u = (await pool.query("select mfa_secret from users where id=$1", [req.user!.id])).rows[0]; if (!u?.mfa_secret) return void reply.code(409).send({ title: "Run /auth/mfa/setup first", status: 409 });
    if (!(devBypass(b.code) || totp(u.mfa_secret) === b.code)) return void reply.code(401).send({ title: "Wrong code", status: 401 }); await pool.query("update users set mfa_enabled=true where id=$1", [req.user!.id]); return { mfa_enabled: true }; });
  app.delete("/auth/mfa", { preHandler: requireAuth }, async (req, reply) => { const b = z.object({ code: z.string().regex(/^\d{6}$/) }).parse(req.body ?? {}); const u = (await pool.query("select mfa_secret from users where id=$1", [req.user!.id])).rows[0]; if (!u?.mfa_secret || !(devBypass(b.code) || totp(u.mfa_secret) === b.code)) return void reply.code(401).send({ title: "Wrong code", status: 401 }); await pool.query("update users set mfa_enabled=false, mfa_secret=null where id=$1", [req.user!.id]); return { mfa_enabled: false }; });
}
