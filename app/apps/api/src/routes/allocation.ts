/** Goals & buckets write paths, the asset-class lens and working capital (PRD 3.5, 3.6; FO-44, 45, 60): every path here answered 501 until now. */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireFamily, requireRole } from "../lib/auth.js";
import { withFamily } from "../lib/db.js";
import { AllocError, createGoal, updateGoal, setGoalLinks, goalView, bucketTargets, putBucketTargets, glidePaths, putGlidePath, rebalanceProposal, modelPortfolios, createModelPortfolio, assetClassTargets, putAssetClassTargets, allocationPolicy, putAllocationPolicy, allocationStatus, recordAllocationReview } from "../lib/allocation.js";
import { wcSettings, putWcSettings, buildPlan, plans, planTasks, ladder, wcSummary } from "../lib/workingcap.js";

const WRITERS = requireRole("owner", "member", "operator"), MEMBERS = requireRole("owner", "member");
const num = z.union([z.number(), z.string().regex(/^-?\d+(\.\d+)?$/)]).transform(Number); const uuid = z.string().uuid();
const problem = (reply: any, e: any) => { if (e instanceof AllocError) return void reply.code(e.status).send({ title: e.message, status: e.status, ...(e.extra ?? {}) }); if (e?.name === "ZodError") return void reply.code(422).send({ title: "Validation failed", status: 422, errors: e.errors }); if (e?.code === "23505") return void reply.code(409).send({ title: "Already exists", status: 409 }); throw e; };
const GOAL = z.object({ entity_id: uuid.nullable().optional(), name: z.string().min(1).max(120), target_year: z.number().int().min(2000).max(2100), amount_today: num, inflation_pct: num.optional(), bucket: z.enum(["liquidity", "income", "growth"]), assumed_return_pct: num.optional(), status: z.enum(["active", "achieved", "paused", "dropped"]).optional() });

export default async function allocationRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireFamily);
  const fam = (req: any) => req.family!.familyId as string;
  const tx = async (req: any, reply: any, fn: (c: any) => Promise<any>, code = 200) => { try { const r = await withFamily(fam(req), fn); return void reply.code(code).send(r); } catch (e) { return problem(reply, e); } };
  const audit = (c: any, req: any, action: string, table: string, id: string, after: any) => c.query("insert into audit_log (family_id, user_id, action, table_name, row_id, after) values ($1,$2,$3,$4,$5,$6)", [fam(req), req.user!.id, action, table, id, JSON.stringify(after)]);

  // ---------- goals ----------
  app.post("/goals", { preHandler: WRITERS }, async (req, reply) => { const b = GOAL.parse(req.body); return tx(req, reply, async (c) => { const g = await createGoal(c, fam(req), b); await audit(c, req, "create", "goals", g.id, { name: g.name }); return g; }, 201); });
  app.get("/goals/:id", async (req, reply) => tx(req, reply, async (c) => { const g = (await c.query("select g.*, e.name entity_name from goals g left join entities e on e.id=g.entity_id where g.id=$1 and g.family_id=$2", [(req.params as any).id, fam(req)])).rows[0]; if (!g) throw new AllocError(404, "Goal not found"); return goalView(c, fam(req), g); }));
  app.patch("/goals/:id", { preHandler: WRITERS }, async (req, reply) => { const b = GOAL.partial().parse(req.body); return tx(req, reply, async (c) => { const g = await updateGoal(c, fam(req), (req.params as any).id, b); await audit(c, req, "update", "goals", g.id, b); return g; }); });
  app.put("/goals/:id/links", { preHandler: WRITERS }, async (req, reply) => { const b = z.array(z.object({ holding_id: uuid.nullable().optional(), private_investment_id: uuid.nullable().optional(), property_id: uuid.nullable().optional(), deposit_id: uuid.nullable().optional(), allocation_pct: num.optional() })).parse(req.body); return tx(req, reply, async (c) => { const g = await setGoalLinks(c, fam(req), (req.params as any).id, b); await audit(c, req, "links", "goals", g.id, { links: b.length }); return g; }); });

  // ---------- buckets & glide paths ----------
  app.get("/bucket-targets", async (req, reply) => tx(req, reply, (c) => bucketTargets(c, fam(req), (req.query as any)?.entity_id ?? null)));
  app.put("/bucket-targets", { preHandler: MEMBERS }, async (req, reply) => { const b = z.object({ entity_id: uuid.nullable().optional(), liquidity_pct: num, income_pct: num, growth_pct: num, drift_threshold_pp: num.optional() }).parse(req.body); return tx(req, reply, async (c) => { const t = await putBucketTargets(c, fam(req), b); await audit(c, req, "bucket_targets", "bucket_targets", fam(req), b); return t; }); });
  app.get("/glide-paths", async (req, reply) => tx(req, reply, (c) => glidePaths(c, fam(req))));
  app.put("/glide-paths", { preHandler: MEMBERS }, async (req, reply) => { const b = z.object({ goal_id: uuid, steps: z.array(z.object({ year: z.number().int(), growth_pct: num })).min(1) }).parse(req.body); return tx(req, reply, (c) => putGlidePath(c, fam(req), b)); });
  app.post("/buckets/rebalance-proposal", { preHandler: WRITERS }, async (req, reply) => { const b = z.object({ entity_id: uuid.optional(), create_tasks: z.boolean().default(false) }).parse(req.body ?? {}); return tx(req, reply, (c) => rebalanceProposal(c, fam(req), { entityId: b.entity_id ?? null, createTasks: b.create_tasks, userId: req.user!.id })); });

  // ---------- asset-class lens ----------
  app.get("/model-portfolios", async (req, reply) => tx(req, reply, (c) => modelPortfolios(c, fam(req))));
  app.post("/model-portfolios", { preHandler: MEMBERS }, async (req, reply) => { const b = z.object({ code: z.string().min(2).max(40).regex(/^[a-z0-9_]+$/), name: z.string().min(1).max(80), risk_profile: z.string().max(40).nullable().optional(), mix: z.record(num), bands: z.record(z.tuple([num, num])).optional(), notes: z.string().max(400).nullable().optional() }).parse(req.body); return tx(req, reply, (c) => createModelPortfolio(c, fam(req), b), 201); });
  app.get("/asset-class-targets", async (req, reply) => tx(req, reply, (c) => assetClassTargets(c, fam(req), (req.query as any)?.entity_id ?? null)));
  app.put("/asset-class-targets", { preHandler: MEMBERS }, async (req, reply) => { const b = z.object({ entity_id: uuid.nullable().optional(), model_portfolio_id: uuid.nullable().optional(), targets: z.array(z.object({ alloc_class: z.string(), target_pct: num, min_pct: num.nullable().optional(), max_pct: num.nullable().optional() })).optional() }).parse(req.body); return tx(req, reply, async (c) => { const t = await putAssetClassTargets(c, fam(req), b); await audit(c, req, "asset_class_targets", "asset_class_targets", fam(req), b); return t; }); });
  app.get("/allocation/policy", async (req, reply) => tx(req, reply, (c) => allocationPolicy(c, fam(req))));
  app.put("/allocation/policy", { preHandler: MEMBERS }, async (req, reply) => { const b = z.object({ strategy: z.enum(["strategic", "tactical", "dynamic", "core_satellite", "goal_based"]).optional(), model_portfolio_id: uuid.nullable().optional(), review_every_months: z.number().int().min(1).max(36).optional(), next_review_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(), rebalance_trigger_pp: num.optional(), include_self_occupied: z.boolean().optional(), include_epf_ppf: z.boolean().optional() }).parse(req.body); return tx(req, reply, async (c) => { const p = await putAllocationPolicy(c, fam(req), b); await audit(c, req, "allocation_policy", "allocation_policies", fam(req), b); return p; }); });
  app.post("/allocation/policy/review", { preHandler: MEMBERS }, async (req, reply) => tx(req, reply, (c) => recordAllocationReview(c, fam(req), req.user!.id, (req.body as any)?.note)));
  app.get("/allocation/status", async (req, reply) => { const q = z.object({ entity_id: uuid.optional(), look_through: z.string().optional() }).parse(req.query); return tx(req, reply, (c) => allocationStatus(c, fam(req), { entityId: q.entity_id ?? null, lookThrough: q.look_through !== "false" && q.look_through !== "0" })); });

  // ---------- working capital ----------
  app.get("/working-capital/settings", async (req, reply) => tx(req, reply, (c) => wcSettings(c, fam(req))));
  app.put("/working-capital/settings", { preHandler: MEMBERS }, async (req, reply) => { const b = z.object({ float_days: z.number().int().min(7).max(365).optional(), buffer_months: num.optional(), idle_days: z.number().int().min(1).max(365).optional(), instrument_prefs: z.object({ instruments: z.record(z.string()).optional(), yields: z.record(num).optional() }).optional() }).parse(req.body); return tx(req, reply, (c) => putWcSettings(c, fam(req), b)); });
  app.get("/working-capital/plans", async (req, reply) => tx(req, reply, (c) => plans(c, fam(req))));
  app.post("/working-capital/plan", { preHandler: WRITERS }, async (req, reply) => { const b = z.object({ amount: num.optional(), entity_id: uuid.optional() }).parse(req.body ?? {}); return tx(req, reply, (c) => buildPlan(c, fam(req), { amount: b.amount ?? null, entityId: b.entity_id ?? null, userId: req.user!.id }), 201); });
  app.post("/working-capital/plan/:id/tasks", { preHandler: WRITERS }, async (req, reply) => tx(req, reply, (c) => planTasks(c, fam(req), (req.params as any).id, req.user!.id), 201));
  app.get("/working-capital/ladder", async (req, reply) => tx(req, reply, (c) => ladder(c, fam(req), (req.query as any)?.entity_id ?? null)));
  app.get("/working-capital/excess", async (req, reply) => tx(req, reply, async (c) => { const s = await wcSummary(c, fam(req), (req.query as any)?.entity_id ?? null); return { cash: s.cash, required_float: s.requiredFloat, deployable_excess: s.excess, outflows: s.outflows.length }; }));
}
