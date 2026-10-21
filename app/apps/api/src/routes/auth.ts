import type { FastifyInstance } from "fastify";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { createHash, randomBytes } from "node:crypto";
import { verifyPassword, issueTokens, familiesFor } from "../lib/auth.js";
import { pool } from "../lib/db.js";
import { withFamily } from "../lib/db.js";
import { config } from "../config.js";
import { mfaToken } from "./auth_mfa.js";
import { deliver } from "../lib/delivery.js";
export default async function routes(app: FastifyInstance) {
  app.post("/auth/login", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req, reply) => {
    const body = z.object({ email: z.string().email(), password: z.string().min(1) }).parse(req.body);
    const user = await verifyPassword(body.email, body.password);
    if (!user) return void reply.code(401).send({ title: "Invalid credentials", status: 401 });
    const mfa = (await pool.query("select mfa_enabled from users where id=$1", [user.id])).rows[0]; if (mfa?.mfa_enabled) return { mfa_required: true, mfa_token: mfaToken(user.id), user: { id: user.id, name: user.name } };   // second step: /auth/mfa/verify
    await pool.query("update users set last_login_at = now() where id = $1", [user.id]);
    return { ...issueTokens(user), user, families: await familiesFor(user.id) };
  });
  /** Self-service sign-up (FEAT: open signup — revert by removing this route and its web form if invite-only is wanted
   *  again): a brand-new email creates its own user, its own family, and becomes that family's owner in one step. */
  app.post("/auth/register", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req, reply) => {
    const body = z.object({ email: z.string().email(), password: z.string().min(8), name: z.string().min(1).max(120), family_name: z.string().min(2).max(120) }).parse(req.body);
    const email = body.email.toLowerCase();
    const existing = (await pool.query("select id from users where email = $1", [email])).rows[0];
    if (existing) return void reply.code(409).send({ title: "An account with this email already exists", status: 409 });
    const hash = await bcrypt.hash(body.password, 10);
    const user = (await pool.query("insert into users (email, name, password_hash) values ($1,$2,$3) returning id, email, name", [email, body.name, hash])).rows[0];
    const f = (await pool.query("insert into families (name, base_currency) values ($1,'INR') returning id, name", [body.family_name])).rows[0];
    await withFamily(f.id, async (c) => {
      await c.query("insert into family_members (family_id, user_id, role, invited_at, accepted_at) values ($1,$2,'owner',now(),now())", [f.id, user.id]);
      await c.query("insert into wc_settings (family_id) values ($1) on conflict do nothing", [f.id]);
      await c.query("insert into bucket_targets (family_id, liquidity_pct, income_pct, growth_pct) values ($1,8,32,60)", [f.id]);
      await c.query("insert into audit_log (family_id, user_id, action, table_name, row_id, after) values ($1,$2,'create','families',$1,$3)", [f.id, user.id, JSON.stringify({ name: f.name, via: "self_register" })]);
    });
    reply.code(201);
    return { ...issueTokens(user), user, families: await familiesFor(user.id) };
  });
  /** Always replies {ok:true} whether or not the e-mail exists, so this can't be used to probe for registered accounts. */
  app.post("/auth/forgot-password", { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } }, async (req) => {
    const body = z.object({ email: z.string().email() }).parse(req.body);
    const email = body.email.toLowerCase();
    const user = (await pool.query("select id, name from users where email=$1", [email])).rows[0];
    let token: string | undefined;
    if (user) {
      token = randomBytes(24).toString("base64url"); const hash = createHash("sha256").update(token).digest("hex");
      await pool.query("update users set reset_token_hash=$2, reset_expires_at=now() + interval '1 hour' where id=$1", [user.id, hash]);
      const link = `${process.env.PUBLIC_WEB_URL ?? ""}/reset-password?email=${encodeURIComponent(email)}&token=${token}`;
      await deliver({ channel: "email", to: email, subject: "Reset your WealthPrism password", text: `${user.name}, reset your password within 1 hour: ${link}` });
    }
    return { ok: true, ...(process.env.NODE_ENV !== "production" && token ? { reset_token: token } : {}) };
  });
  /** Public: sets a new password from the e-mailed token, then logs the user in. */
  app.post("/auth/reset-password", async (req, reply) => {
    const body = z.object({ email: z.string().email(), token: z.string().min(10), password: z.string().min(10).max(200) }).parse(req.body);
    const email = body.email.toLowerCase(); const hash = createHash("sha256").update(body.token).digest("hex");
    const user = (await pool.query("select id, email, name from users where email=$1 and reset_token_hash=$2 and reset_expires_at >= now()", [email, hash])).rows[0];
    if (!user) return void reply.code(403).send({ title: "Reset link not found, used or expired", status: 403 });
    await pool.query("update users set password_hash=$2, reset_token_hash=null, reset_expires_at=null where id=$1", [user.id, await bcrypt.hash(body.password, 10)]);
    return { ...issueTokens(user), user, families: await familiesFor(user.id) };
  });
  app.post("/auth/refresh", async (req, reply) => {
    const body = z.object({ refresh_token: z.string() }).parse(req.body);
    try {
      const p: any = jwt.verify(body.refresh_token, config.refreshSecret);
      const { rows } = await pool.query("select id, email, name from users where id = $1", [p.sub]);
      if (!rows[0]) throw new Error();
      return { ...issueTokens(rows[0]), families: await familiesFor(rows[0].id) };
    } catch { return void reply.code(401).send({ title: "Invalid refresh token", status: 401 }); }
  });
}
