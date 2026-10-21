/** E-mail ingest (FO-30): the public gateway hook (signed over the raw body) and the family's inbox / allow-list management. */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireFamily, requireRole } from "../lib/auth.js";
import { withFamily } from "../lib/db.js";
import { IngestError, normaliseInbound, processInbound, releaseInbound, rejectInbound, ingestSettings, ingestView, verifyIngest } from "../lib/ingest.js";

const MEMBERS = requireRole("owner", "member");
const problem = (reply: any, e: any) => { if (e instanceof IngestError) return void reply.code(e.status).send({ title: e.message, status: e.status }); if (e?.name === "ZodError") return void reply.code(422).send({ title: "Validation failed", status: 422, errors: e.errors }); throw e; };

export async function ingestPublicRoutes(app: FastifyInstance) {
  app.addContentTypeParser("application/json", { parseAs: "string", bodyLimit: 40 * 1024 * 1024 }, (req, body, done) => { (req as any).rawBody = body; try { done(null, body ? JSON.parse(body as string) : {}); } catch (e) { done(e as Error); } });
  app.post("/ingest/email", { bodyLimit: 40 * 1024 * 1024, config: { rateLimit: { max: 60, timeWindow: "1 minute" } } }, async (req, reply) => {
    const raw = (req as any).rawBody ?? JSON.stringify(req.body ?? {});
    if (!verifyIngest(raw, req.headers as any)) return void reply.code(401).send({ title: "Bad signature", status: 401 });
    try { const r = await processInbound(normaliseInbound(req.body ?? {})); return void reply.code(202).send(r); } catch (e) { return problem(reply, e); }
  });
}
export default async function ingestRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireFamily);
  const fam = (req: any) => req.family!.familyId as string;
  const tx = async (req: any, reply: any, fn: (c: any) => Promise<any>, code = 200) => { try { const r = await withFamily(fam(req), fn); return void reply.code(code).send(r); } catch (e) { return problem(reply, e); } };
  app.get("/ingest/email", async (req, reply) => { const q = z.object({ status: z.string().optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }).parse(req.query); return tx(req, reply, async (c) => (await c.query("select * from email_ingest where family_id=$1 and ($2::text is null or status=$2) order by received_at desc limit $3", [fam(req), q.status ?? null, q.limit])).rows.map(ingestView)); });
  app.get("/ingest/email/:id", async (req, reply) => tx(req, reply, async (c) => { const r = (await c.query("select * from email_ingest where id=$1 and family_id=$2", [(req.params as any).id, fam(req)])).rows[0]; if (!r) throw new IngestError(404, "Message not found"); return ingestView(r); }));
  app.post("/ingest/email/:id/release", { preHandler: MEMBERS }, async (req, reply) => { const b = z.object({ allow_sender: z.boolean().default(false) }).parse(req.body ?? {}); return tx(req, reply, (c) => releaseInbound(c, fam(req), (req.params as any).id, req.user!.id, b)); });
  app.post("/ingest/email/:id/reject", { preHandler: MEMBERS }, async (req, reply) => tx(req, reply, (c) => rejectInbound(c, fam(req), (req.params as any).id, req.user!.id)));
  app.get("/ingest/settings", async (req, reply) => tx(req, reply, (c) => ingestSettings(c, fam(req))));
  app.patch("/ingest/settings", { preHandler: MEMBERS }, async (req, reply) => { const b = z.object({ allow_senders: z.array(z.string().min(3).max(120)).max(100).optional(), quarantine_unknown: z.boolean().optional() }).parse(req.body); return tx(req, reply, async (c) => { await c.query("update families set ingest_allow_senders=coalesce($2, ingest_allow_senders), ingest_quarantine_unknown=coalesce($3, ingest_quarantine_unknown) where id=$1", [fam(req), b.allow_senders?.map((s) => s.toLowerCase()) ?? null, b.quarantine_unknown ?? null]); await c.query("insert into audit_log (family_id, user_id, action, table_name, row_id, after) values ($1,$2,'ingest.settings','families',$1,$3)", [fam(req), req.user!.id, JSON.stringify(b)]); return ingestSettings(c, fam(req)); }); });
}
