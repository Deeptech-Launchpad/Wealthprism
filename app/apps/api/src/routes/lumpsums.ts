// One-time sums of money (bonus, gift, sale, inheritance, refund). See lib/lumpsums.ts for how they are counted.
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireFamily, requireRole } from "../lib/auth.js";
import { withFamily } from "../lib/db.js";
import { LUMP_REASONS, lumpSumView } from "../lib/lumpsums.js";

const WRITERS = requireRole("owner", "member", "operator");
const BODY = z.object({
  bank_account_id: z.string().uuid(),
  entry_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  amount: z.union([z.number(), z.string().regex(/^\d+(\.\d+)?$/)]).transform(Number).refine((n) => n > 0, "The amount must be more than zero"),
  reason: z.enum(LUMP_REASONS),
  note: z.string().max(200).optional(),
});

const VIEW_SQL = `select l.*, l.entry_date::text entry_date, b.bank, b.account_masked, b.entity_id, e.name entity_name, t.txn_date::text verified_on
  from lump_sums l join bank_accounts b on b.id=l.bank_account_id join entities e on e.id=b.entity_id left join bank_txns t on t.id=l.bank_txn_id`;

// Work inside the transaction, return the outcome, and send the reply after it commits (sending inside the transaction would wait on itself).
type Outcome = { code: number; body: any };
const fail = (code: number, title: string): Outcome => ({ code, body: { title, status: code } });

export default async function lumpSumRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireFamily);

  app.get("/lump-sums", async (req) => withFamily(req.family!.familyId, async (c) => {
    const rows = (await c.query(`${VIEW_SQL} where l.deleted_at is null order by l.entry_date desc, l.created_at desc`)).rows;
    return rows.map(lumpSumView);
  }));

  app.post("/lump-sums", { preHandler: WRITERS }, async (req, reply) => {
    const b = BODY.safeParse(req.body ?? {});
    if (!b.success) return reply.code(422).send({ title: "Check the lump sum", detail: b.error.issues.map((i) => i.message).join("; "), status: 422 });
    const fam = req.family!.familyId;
    const out: Outcome = await withFamily(fam, async (c): Promise<Outcome> => {
      const acct = (await c.query("select id, entity_id from bank_accounts where id=$1 and family_id=$2 and deleted_at is null", [b.data.bank_account_id, fam])).rows[0];
      if (!acct) return fail(404, "Bank account not found");
      if ((await c.query("select ($1::date > app_today()) future", [b.data.entry_date])).rows[0].future) return fail(422, "The date cannot be in the future");

      // The money may already be in a statement uploaded earlier. Then the bank balance already includes it: verify, do not add again.
      const existing = (await c.query(
        `select t.id from bank_txns t where t.family_id=$1 and t.bank_account_id=$2 and t.amount > 0
           and abs(t.amount - $3::numeric) <= greatest(1, $3::numeric * 0.005) and t.txn_date between $4::date - 5 and $4::date + 5
           and not exists (select 1 from lump_sums x where x.bank_txn_id = t.id)
         order by abs(t.txn_date - $4::date) limit 1`, [fam, acct.id, b.data.amount, b.data.entry_date])).rows[0];

      const row = (await c.query(
        `insert into lump_sums (family_id, bank_account_id, entry_date, amount, reason, note, status, bank_txn_id)
         values ($1,$2,$3,$4,$5,$6,$7,$8) returning id`,
        [fam, acct.id, b.data.entry_date, b.data.amount, b.data.reason, b.data.note ?? null, existing ? "verified" : "pending", existing?.id ?? null])).rows[0];
      if (!existing) await c.query("update bank_accounts set balance = balance + $2 where id=$1", [acct.id, b.data.amount]);
      await c.query("insert into audit_log (family_id, user_id, action, table_name, row_id, after) values ($1,$2,'create','lump_sums',$3,$4)", [fam, req.user!.id, row.id, JSON.stringify({ amount: b.data.amount, status: existing ? "verified" : "pending" })]);
      const view = (await c.query(`${VIEW_SQL} where l.id=$1`, [row.id])).rows[0];
      return { code: 201, body: lumpSumView(view) };
    });
    return reply.code(out.code).send(out.body);
  });

  app.delete("/lump-sums/:id", { preHandler: WRITERS }, async (req, reply) => {
    const id = (req.params as any).id;
    const out: Outcome = await withFamily(req.family!.familyId, async (c): Promise<Outcome> => {
      const l = (await c.query("select * from lump_sums where id=$1 and family_id=$2 and deleted_at is null", [id, req.family!.familyId])).rows[0];
      if (!l) return fail(404, "Lump sum not found");
      // a pending entry put money into the balance when it was entered: take it back. A verified one is already in the statement's balance.
      if (l.status === "pending") await c.query("update bank_accounts set balance = balance - $2 where id=$1", [l.bank_account_id, l.amount]);
      await c.query("update lump_sums set deleted_at=now() where id=$1", [id]);
      await c.query("insert into audit_log (family_id, user_id, action, table_name, row_id, before) values ($1,$2,'delete','lump_sums',$3,$4)", [req.family!.familyId, req.user!.id, id, JSON.stringify({ amount: l.amount, status: l.status })]);
      return { code: 204, body: null };
    });
    if (out.code === 204) return reply.code(204).send();
    return reply.code(out.code).send(out.body);
  });
}
