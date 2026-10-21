/** Family & entities (PRD 3.1; FO-10, 11): entities with PAN (encrypted, last four kept), GSTINs, members and invitations; a signed-in user can
 *  create a further family and becomes its owner. */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { createHash, randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { encryptSecret } from "@fo/connectors";
import { requireFamily, requireRole, requireAuth, familiesFor } from "../lib/auth.js";
import { withFamily, pool } from "../lib/db.js";
import { deliver } from "../lib/delivery.js";

const KEY = () => process.env.FIELD_ENCRYPTION_KEY ?? "dev-only-field-key";
const PAN = /^[A-Z]{5}\d{4}[A-Z]$/, GSTIN = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const ENTITY = z.object({ type: z.enum(["individual", "huf", "trust", "llp", "company"]), name: z.string().min(1).max(120), pan: z.string().regex(PAN, "PAN must look like ABCDE1234F").optional(), dob_or_incorp: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(), tax_regime: z.enum(["old", "new"]).optional(), slab_rate: z.coerce.number().min(0).max(50).optional(), residential_status: z.string().max(40).optional() });
const view = (e: any) => ({ id: e.id, type: e.type, name: e.name, pan_last4: e.pan_last4, dob_or_incorp: e.dob_or_incorp ? new Date(e.dob_or_incorp).toISOString().slice(0, 10) : null, tax_regime: e.tax_regime, slab_rate: e.slab_rate == null ? null : Number(e.slab_rate), residential_status: e.residential_status, gstins: e.gstins ?? [] });

/** Routes that need a user but not a family header. */
export async function accountRoutes(app: FastifyInstance) {
  app.post("/families", { preHandler: requireAuth }, async (req, reply) => {
    const b = z.object({ name: z.string().min(2).max(120), base_currency: z.string().length(3).default("INR") }).parse(req.body);
    const f = (await pool.query("insert into families (name, base_currency) values ($1,$2) returning id, name, base_currency, created_at", [b.name, b.base_currency.toUpperCase()])).rows[0];
    await withFamily(f.id, async (c) => { await c.query("insert into family_members (family_id, user_id, role, invited_at, accepted_at) values ($1,$2,'owner',now(),now())", [f.id, req.user!.id]); await c.query("insert into wc_settings (family_id) values ($1) on conflict do nothing", [f.id]); await c.query("insert into bucket_targets (family_id, liquidity_pct, income_pct, growth_pct) values ($1,8,32,60)", [f.id]); await c.query("insert into audit_log (family_id, user_id, action, table_name, row_id, after) values ($1,$2,'create','families',$1,$3)", [f.id, req.user!.id, JSON.stringify({ name: f.name })]); });
    return void reply.code(201).send({ ...f, role: "owner", families: await familiesFor(req.user!.id) });
  });
  /** Public: an invited member sets a password with the token from the invitation e-mail. */
  app.post("/auth/invite/accept", async (req, reply) => {
    const b = z.object({ email: z.string().email(), token: z.string().min(10), password: z.string().min(10).max(200) }).parse(req.body); const hash = createHash("sha256").update(b.token).digest("hex");
    const m = (await pool.query("select id, user_id, family_id from member_invite_lookup($1,$2)", [b.email.toLowerCase(), hash])).rows[0]; if (!m) return void reply.code(403).send({ title: "Invitation not found, used or expired", status: 403 });
    await pool.query("update users set password_hash=$2 where id=$1", [m.user_id, await bcrypt.hash(b.password, 10)]);
    await withFamily(m.family_id, (c) => c.query("update family_members set accepted_at=now(), invite_token_hash=null where id=$1", [m.id]));
    return { ok: true, family_id: m.family_id };
  });
}

export default async function routes(app: FastifyInstance) {
  app.addHook("preHandler", requireFamily);
  const fam = (req: any) => req.family!.familyId as string; const MEMBERS = requireRole("owner", "member"), OWNERS = requireRole("owner");
  const audit = (c: any, req: any, action: string, table: string, id: string, after: any) => c.query("insert into audit_log (family_id, user_id, action, table_name, row_id, after) values ($1,$2,$3,$4,$5,$6)", [fam(req), req.user!.id, action, table, id, JSON.stringify(after)]);
  const ENT_SQL = `select e.id, e.type, e.name, e.pan_last4, e.dob_or_incorp, e.tax_regime, e.slab_rate, e.residential_status,
      coalesce(json_agg(json_build_object('id', g.id, 'gstin', g.gstin, 'state_code', g.state_code, 'registered_on', g.registered_on, 'active', g.active)) filter (where g.id is not null), '[]') as gstins
      from entities e left join entity_gstins g on g.entity_id = e.id where e.deleted_at is null`;
  app.get("/entities", async (req) => withFamily(fam(req), async (c) => (await c.query(`${ENT_SQL} group by e.id order by e.name`)).rows.map(view)));
  app.get("/entities/:id", async (req, reply) => withFamily(fam(req), async (c) => { const e = (await c.query(`${ENT_SQL} and e.id=$1 group by e.id`, [(req.params as any).id])).rows[0]; if (!e) return void reply.code(404).send({ title: "Entity not found", status: 404 }); return view(e); }));
  app.post("/entities", { preHandler: MEMBERS }, async (req, reply) => { const b = ENTITY.parse(req.body); return withFamily(fam(req), async (c) => {
    const r = (await c.query("insert into entities (family_id, type, name, pan_enc, pan_last4, dob_or_incorp, tax_regime, slab_rate, residential_status) values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning *", [fam(req), b.type, b.name, b.pan ? Buffer.from(encryptSecret(b.pan, KEY())) : null, b.pan ? b.pan.slice(-4) : null, b.dob_or_incorp ?? null, b.tax_regime ?? "new", b.slab_rate ?? 30, b.residential_status ?? "resident"])).rows[0];
    await audit(c, req, "create", "entities", r.id, { type: r.type, name: r.name }); return void reply.code(201).send(view({ ...r, gstins: [] })); }); });
  app.patch("/entities/:id", { preHandler: MEMBERS }, async (req, reply) => { const b = ENTITY.partial().parse(req.body); return withFamily(fam(req), async (c) => {
    const r = (await c.query("update entities set type=coalesce($3,type), name=coalesce($4,name), pan_enc=case when $5::bytea is null then pan_enc else $5 end, pan_last4=coalesce($6,pan_last4), dob_or_incorp=coalesce($7,dob_or_incorp), tax_regime=coalesce($8,tax_regime), slab_rate=coalesce($9,slab_rate), residential_status=coalesce($10,residential_status), updated_at=now() where id=$1 and family_id=$2 and deleted_at is null returning *", [(req.params as any).id, fam(req), b.type ?? null, b.name ?? null, b.pan ? Buffer.from(encryptSecret(b.pan, KEY())) : null, b.pan ? b.pan.slice(-4) : null, b.dob_or_incorp ?? null, b.tax_regime ?? null, b.slab_rate ?? null, b.residential_status ?? null])).rows[0];
    if (!r) return void reply.code(404).send({ title: "Entity not found", status: 404 }); await audit(c, req, "update", "entities", r.id, b); const g = (await c.query("select id, gstin, state_code, registered_on, active from entity_gstins where entity_id=$1", [r.id])).rows; return view({ ...r, gstins: g }); }); });
  app.post("/entities/:id/gstins", { preHandler: MEMBERS }, async (req, reply) => { const b = z.object({ gstin: z.string().toUpperCase().regex(GSTIN, "GSTIN must be 15 characters, e.g. 33ABCDE1234F1Z5"), registered_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional() }).parse(req.body); return withFamily(fam(req), async (c) => {
    const e = (await c.query("select id, pan_last4 from entities where id=$1 and family_id=$2 and deleted_at is null", [(req.params as any).id, fam(req)])).rows[0]; if (!e) return void reply.code(404).send({ title: "Entity not found", status: 404 });
    if (e.pan_last4 && b.gstin.slice(2, 12).slice(-4) !== e.pan_last4) return void reply.code(422).send({ title: "The GSTIN's PAN does not match this entity", status: 422 });
    const r = (await c.query("insert into entity_gstins (family_id, entity_id, gstin, state_code, registered_on, active) values ($1,$2,$3,$4,$5,true) returning id, gstin, state_code, registered_on, active", [fam(req), e.id, b.gstin, b.gstin.slice(0, 2), b.registered_on ?? null])).rows[0];
    await audit(c, req, "gstin", "entity_gstins", r.id, { gstin: r.gstin }); return void reply.code(201).send(r); }); });
  app.get("/members", async (req) => withFamily(fam(req), async (c) => (await c.query(`select u.id as user_id, u.name, u.email, m.role, m.entity_scope, m.invited_at, m.accepted_at from family_members m join users u on u.id = m.user_id where m.family_id = $1 order by m.role, u.name`, [fam(req)])).rows));
  /** Owner invites a member: the user row is created (or found), the membership stays pending until the invitation is accepted with a password. */
  app.post("/auth/invite", { preHandler: OWNERS }, async (req, reply) => { const b = z.object({ email: z.string().email(), role: z.enum(["owner", "member", "operator", "viewer"]), entity_scope: z.array(z.string().uuid()).nullable().optional(), name: z.string().max(120).optional() }).parse(req.body); const email = b.email.toLowerCase();
    let user = (await pool.query("select id, name from users where email=$1", [email])).rows[0]; const token = randomBytes(24).toString("base64url"); const hash = createHash("sha256").update(token).digest("hex");
    if (!user) user = (await pool.query("insert into users (email, name, password_hash) values ($1,$2,$3) returning id, name", [email, b.name ?? email.split("@")[0], await bcrypt.hash(randomBytes(24).toString("hex"), 10)])).rows[0];
    const m = await withFamily(fam(req), async (c) => { if ((await c.query("select 1 from family_members where family_id=$1 and user_id=$2 and accepted_at is not null", [fam(req), user.id])).rowCount) return null;
      const r = (await c.query("insert into family_members (family_id, user_id, role, entity_scope, invited_at, invite_token_hash, invite_expires_on) values ($1,$2,$3,$4,now(),$5,current_date + 14) on conflict (family_id, user_id) do update set role=excluded.role, entity_scope=excluded.entity_scope, invited_at=now(), invite_token_hash=excluded.invite_token_hash, invite_expires_on=excluded.invite_expires_on returning *", [fam(req), user.id, b.role, b.entity_scope ?? null, hash]).catch(async () => { await c.query("update family_members set role=$3, entity_scope=$4, invited_at=now(), invite_token_hash=$5, invite_expires_on=current_date + 14 where family_id=$1 and user_id=$2", [fam(req), user.id, b.role, b.entity_scope ?? null, hash]); return c.query("select * from family_members where family_id=$1 and user_id=$2", [fam(req), user.id]); })).rows[0];
      await audit(c, req, "invite", "family_members", r.id, { email, role: b.role }); return r; });
    if (!m) return void reply.code(409).send({ title: "Already a member of this family", status: 409 });
    const link = `${process.env.PUBLIC_WEB_URL ?? ""}/invite?email=${encodeURIComponent(email)}&token=${token}`; const fname = (await pool.query("select name from families where id=$1", [fam(req)])).rows[0]?.name ?? "the family";
    const sent = await deliver({ channel: "email", to: email, subject: `You are invited to ${fname} on WealthPrism`, text: `${req.user!.name} invited you as ${b.role}. Set your password within 14 days: ${link}`, familyId: fam(req), refType: "member_invite", refId: m.id });
    return void reply.code(201).send({ membership_id: m.id, user_id: user.id, email, role: b.role, entity_scope: b.entity_scope ?? null, expires_on: m.invite_expires_on, email_sent: sent.ok, ...(process.env.NODE_ENV === "production" ? {} : { invite_token: token }) }); });
  app.patch("/members/:userId", { preHandler: OWNERS }, async (req, reply) => { const b = z.object({ role: z.enum(["owner", "member", "operator", "viewer"]).optional(), entity_scope: z.array(z.string().uuid()).nullable().optional() }).parse(req.body); return withFamily(fam(req), async (c) => { const r = (await c.query("update family_members set role=coalesce($3,role), entity_scope=case when $4::boolean then $5 else entity_scope end where family_id=$1 and user_id=$2 returning *", [fam(req), (req.params as any).userId, b.role ?? null, b.entity_scope !== undefined, b.entity_scope ?? null])).rows[0]; if (!r) return void reply.code(404).send({ title: "Member not found", status: 404 }); await audit(c, req, "member.update", "family_members", r.id, b); return r; }); });
  app.delete("/members/:userId", { preHandler: OWNERS }, async (req, reply) => withFamily(fam(req), async (c) => { if ((req.params as any).userId === req.user!.id) return void reply.code(409).send({ title: "An owner cannot remove themselves", status: 409 }); const r = await c.query("delete from family_members where family_id=$1 and user_id=$2 returning id", [fam(req), (req.params as any).userId]); if (!r.rowCount) return void reply.code(404).send({ title: "Member not found", status: 404 }); await audit(c, req, "member.remove", "family_members", r.rows[0].id, null); return void reply.code(204).send(); }));
}
