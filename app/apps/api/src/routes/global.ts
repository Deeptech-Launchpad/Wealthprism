/** Global module (PRD 3.13): FX reference rates, LRS remittances against the limit, foreign tax credits. */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireFamily, requireRole } from "../lib/auth.js";
import { withFamily } from "../lib/db.js";
import { AllocError } from "../lib/allocation.js";
import { fxRates, putFxRate, lrsSummary, createLrs, ftcList, createFtc, fyOf } from "../lib/global.js";

const WRITERS = requireRole("owner", "member", "operator"), OWNERS = requireRole("owner");
const num = z.union([z.number(), z.string().regex(/^-?\d+(\.\d+)?$/)]).transform(Number); const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/); const FY = z.string().regex(/^\d{4}-\d{2}$/);
const problem = (reply: any, e: any) => { if (e instanceof AllocError) return void reply.code(e.status).send({ title: e.message, status: e.status, ...(e.extra ?? {}) }); if (e?.name === "ZodError") return void reply.code(422).send({ title: "Validation failed", status: 422, errors: e.errors }); throw e; };
const today = () => new Date().toISOString().slice(0, 10);

export default async function globalRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireFamily);
  const fam = (req: any) => req.family!.familyId as string;
  const tx = async (req: any, reply: any, fn: (c: any) => Promise<any>, code = 200) => { try { const r = await withFamily(fam(req), fn); return void reply.code(code).send(r); } catch (e) { return problem(reply, e); } };
  app.get("/fx-rates", async (req, reply) => { const q = z.object({ ccy: z.string().length(3).optional(), date: date.optional(), source: z.string().optional() }).parse(req.query); try { return void reply.send(await fxRates({ ccy: q.ccy, date: q.date, source: q.source ?? null })); } catch (e) { return problem(reply, e); } });
  app.put("/fx-rates", { preHandler: OWNERS }, async (req, reply) => { const b = z.object({ ccy: z.string().length(3), rate_date: date.default(today()), rate_inr: num, source: z.string().max(20).optional() }).parse(req.body); try { return void reply.send(await putFxRate(b)); } catch (e) { return problem(reply, e); } });
  app.get("/global/lrs", async (req, reply) => { const q = z.object({ fy: FY.default(fyOf(today())), entity_id: z.string().uuid().optional() }).parse(req.query); return tx(req, reply, (c) => lrsSummary(c, fam(req), q.fy, q.entity_id ?? null)); });
  app.post("/global/lrs", { preHandler: WRITERS }, async (req, reply) => { const b = z.object({ entity_id: z.string().uuid(), remitted_on: date, ccy: z.string().length(3), amount_ccy: num, amount_inr: num.nullable().optional(), purpose: z.string().max(60).nullable().optional(), tcs_collected: num.nullable().optional(), bank_txn_id: z.string().uuid().nullable().optional(), note: z.string().max(300).nullable().optional() }).parse(req.body); return tx(req, reply, (c) => createLrs(c, fam(req), b), 201); });
  app.delete("/global/lrs/:id", { preHandler: WRITERS }, async (req, reply) => tx(req, reply, async (c) => { const r = await c.query("delete from lrs_remittances where id=$1 and family_id=$2 returning id", [(req.params as any).id, fam(req)]); if (!r.rowCount) throw new AllocError(404, "Remittance not found"); return null; }, 204));
  app.get("/global/foreign-tax-credits", async (req, reply) => { const q = z.object({ fy: FY.optional(), entity_id: z.string().uuid().optional() }).parse(req.query); return tx(req, reply, (c) => ftcList(c, fam(req), q.fy ?? null, q.entity_id ?? null)); });
  app.post("/global/foreign-tax-credits", { preHandler: WRITERS }, async (req, reply) => { const b = z.object({ entity_id: z.string().uuid(), fy: FY, country: z.string().length(2), income_type: z.enum(["dividend", "interest", "gains"]), income_inr: num, foreign_tax_inr: num, dtaa_article: z.string().max(40).nullable().optional(), form67_filed_on: date.nullable().optional(), note: z.string().max(300).nullable().optional() }).parse(req.body); return tx(req, reply, (c) => createFtc(c, fam(req), b), 201); });
  app.patch("/global/foreign-tax-credits/:id", { preHandler: WRITERS }, async (req, reply) => { const b = z.object({ form67_filed_on: date.nullable().optional(), dtaa_article: z.string().max(40).nullable().optional(), note: z.string().max(300).nullable().optional() }).parse(req.body); return tx(req, reply, async (c) => { const r = (await c.query("update foreign_tax_credits set form67_filed_on=case when $3::boolean then $4 else form67_filed_on end, dtaa_article=coalesce($5, dtaa_article), note=coalesce($6, note) where id=$1 and family_id=$2 returning *", [(req.params as any).id, fam(req), b.form67_filed_on !== undefined, b.form67_filed_on ?? null, b.dtaa_article ?? null, b.note ?? null])).rows[0]; if (!r) throw new AllocError(404, "Credit not found"); return r; }); });
  app.delete("/global/foreign-tax-credits/:id", { preHandler: WRITERS }, async (req, reply) => tx(req, reply, async (c) => { const r = await c.query("delete from foreign_tax_credits where id=$1 and family_id=$2 returning id", [(req.params as any).id, fam(req)]); if (!r.rowCount) throw new AllocError(404, "Credit not found"); return null; }, 204));
}
