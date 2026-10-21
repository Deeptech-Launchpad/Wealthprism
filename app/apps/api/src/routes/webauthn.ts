/** WebAuthn / passkey step-up (FO-122 roadmap gap): registration for a signed-in user, and a fresh challenge before an
 *  approval that wants auth_method:"passkey". verifyStepUp() in lib/auth.ts does the actual assertion check; every
 *  approval route (action plane, policy, research, connectors, rebalance) already accepts any auth_method/auth_proof
 *  pair unchanged — db/008's approvals.auth_method already anticipated 'passkey' as a value. */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { generateRegistrationOptions, verifyRegistrationResponse, generateAuthenticationOptions } from "@simplewebauthn/server";
import { pool } from "../lib/db.js";
import { requireAuth } from "../lib/auth.js";
import { config } from "../config.js";

export default async function webauthnRoutes(app: FastifyInstance) {
  app.post("/auth/webauthn/register/options", { preHandler: requireAuth }, async (req) => {
    const existing = (await pool.query("select credential_id from webauthn_credentials where user_id=$1", [req.user!.id])).rows;
    const options = await generateRegistrationOptions({
      rpName: config.webauthnRpName, rpID: config.webauthnRpId,
      userName: req.user!.email, userDisplayName: req.user!.name,
      attestationType: "none",
      excludeCredentials: existing.map((c) => ({ id: c.credential_id })),
      authenticatorSelection: { residentKey: "preferred", userVerification: "preferred" },
    });
    await pool.query("update users set webauthn_challenge=$2, webauthn_challenge_expires=now() + interval '5 minutes' where id=$1", [req.user!.id, options.challenge]);
    return options;
  });
  app.post("/auth/webauthn/register/verify", { preHandler: requireAuth }, async (req, reply) => {
    const b = z.object({ response: z.any(), device_name: z.string().max(80).optional() }).parse(req.body);
    const u = (await pool.query("select webauthn_challenge, webauthn_challenge_expires from users where id=$1", [req.user!.id])).rows[0];
    if (!u?.webauthn_challenge || new Date(u.webauthn_challenge_expires) < new Date()) return void reply.code(409).send({ title: "Challenge expired — request new registration options", status: 409 });
    let verification; try { verification = await verifyRegistrationResponse({ response: b.response, expectedChallenge: u.webauthn_challenge, expectedOrigin: config.webauthnOrigin, expectedRPID: config.webauthnRpId }); }
    catch (e: any) { return void reply.code(400).send({ title: `Passkey registration failed: ${e.message}`, status: 400 }); }
    if (!verification.verified || !verification.registrationInfo) return void reply.code(400).send({ title: "Passkey registration failed", status: 400 });
    const { credential } = verification.registrationInfo;
    await pool.query("insert into webauthn_credentials (user_id, credential_id, public_key, counter, device_name) values ($1,$2,$3,$4,$5)", [req.user!.id, credential.id, Buffer.from(credential.publicKey), credential.counter, b.device_name ?? null]);
    await pool.query("update users set webauthn_challenge=null, webauthn_challenge_expires=null where id=$1", [req.user!.id]);
    return { registered: true };
  });
  app.get("/auth/webauthn/credentials", { preHandler: requireAuth }, async (req) => ({ credentials: (await pool.query("select id, device_name, created_at, last_used_at from webauthn_credentials where user_id=$1 order by created_at desc", [req.user!.id])).rows }));
  app.delete("/auth/webauthn/credentials/:id", { preHandler: requireAuth }, async (req, reply) => { const r = await pool.query("delete from webauthn_credentials where id=$1 and user_id=$2 returning id", [(req.params as any).id, req.user!.id]); if (!r.rowCount) return void reply.code(404).send({ title: "Not found", status: 404 }); return null; });
  /** Fresh challenge for a step-up approval: call this first, then pass the resulting assertion JSON-stringified as
   *  auth_proof with auth_method:"passkey" to whichever approval endpoint. */
  app.post("/auth/webauthn/challenge", { preHandler: requireAuth }, async (req, reply) => {
    const creds = (await pool.query("select credential_id from webauthn_credentials where user_id=$1", [req.user!.id])).rows;
    if (!creds.length) return void reply.code(409).send({ title: "No passkey registered — add one in Settings first", status: 409 });
    const options = await generateAuthenticationOptions({ rpID: config.webauthnRpId, userVerification: "preferred", allowCredentials: creds.map((c) => ({ id: c.credential_id })) });
    await pool.query("update users set webauthn_challenge=$2, webauthn_challenge_expires=now() + interval '5 minutes' where id=$1", [req.user!.id, options.challenge]);
    return options;
  });
}
