import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth } from "../lib/auth.js";
import { pool } from "../lib/db.js";

/** Notifications are per user (across families), so these routes need a token but not X-Family-Id. */
export default async function routes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);

  app.get("/notifications", async (req) => {
    const q = z.object({ unread: z.coerce.boolean().optional(), limit: z.coerce.number().min(1).max(200).default(50) }).parse(req.query);
    const rows = (await pool.query(`select n.id, n.family_id, f.name family_name, n.task_id, n.channel, n.title, n.body, n.payload, n.sent_at, n.read_at, n.created_at from notifications n left join families f on f.id=n.family_id
        where n.user_id=$1 and n.channel='inapp' and ($2::boolean is not true or n.read_at is null) order by n.created_at desc limit $3`, [req.user!.id, q.unread ?? null, q.limit])).rows;
    const unread = Number((await pool.query("select count(*) n from notifications where user_id=$1 and channel='inapp' and read_at is null", [req.user!.id])).rows[0].n);
    return { items: rows, unread };
  });
  app.post("/notifications/read", async (req) => {
    const b = z.object({ ids: z.array(z.string().uuid()).optional(), all: z.boolean().optional() }).parse(req.body ?? {});
    const r = b.all ? await pool.query("update notifications set read_at=now() where user_id=$1 and read_at is null", [req.user!.id])
      : await pool.query("update notifications set read_at=now() where user_id=$1 and id = any($2::uuid[]) and read_at is null", [req.user!.id, b.ids ?? []]);
    return { marked: r.rowCount ?? 0 };
  });

  app.get("/notification-preferences", async (req) => (await pool.query("select inapp, push_min_severity, email_digest, digest_hour_ist, whatsapp, last_digest_at from notification_prefs where user_id=$1", [req.user!.id])).rows[0] ?? { inapp: true, push_min_severity: 1, email_digest: "daily", digest_hour_ist: 8, whatsapp: false, last_digest_at: null });
  app.put("/notification-preferences", async (req) => {
    const b = z.object({ inapp: z.boolean().optional(), push_min_severity: z.number().int().min(1).max(3).optional(), email_digest: z.enum(["off", "daily", "weekly"]).optional(), digest_hour_ist: z.number().int().min(0).max(23).optional(), whatsapp: z.boolean().optional() }).parse(req.body);
    const r = (await pool.query(`insert into notification_prefs (user_id, inapp, push_min_severity, email_digest, digest_hour_ist, whatsapp) values ($1, coalesce($2,true), coalesce($3,1), coalesce($4,'daily'), coalesce($5,8), coalesce($6,false))
        on conflict (user_id) do update set inapp=coalesce($2, notification_prefs.inapp), push_min_severity=coalesce($3, notification_prefs.push_min_severity), email_digest=coalesce($4, notification_prefs.email_digest), digest_hour_ist=coalesce($5, notification_prefs.digest_hour_ist), whatsapp=coalesce($6, notification_prefs.whatsapp)
        returning inapp, push_min_severity, email_digest, digest_hour_ist, whatsapp, last_digest_at`, [req.user!.id, b.inapp ?? null, b.push_min_severity ?? null, b.email_digest ?? null, b.digest_hour_ist ?? null, b.whatsapp ?? null])).rows[0];
    return r;
  });

  /** Mobile registers its Expo push token after login; the same token moving to another user is re-owned. */
  app.post("/devices", async (req, reply) => {
    const b = z.object({ push_token: z.string().min(10), platform: z.enum(["ios", "android", "web"]) }).parse(req.body);
    const r = (await pool.query("insert into user_devices (user_id, platform, push_token) values ($1,$2,$3) on conflict (push_token) do update set user_id=excluded.user_id, platform=excluded.platform, last_seen_at=now() returning id, platform, created_at", [req.user!.id, b.platform, b.push_token])).rows[0];
    return void reply.code(201).send(r);
  });
  app.delete("/devices", async (req) => { const b = z.object({ push_token: z.string() }).parse(req.body); const r = await pool.query("delete from user_devices where user_id=$1 and push_token=$2", [req.user!.id, b.push_token]); return { removed: r.rowCount ?? 0 }; });
}
