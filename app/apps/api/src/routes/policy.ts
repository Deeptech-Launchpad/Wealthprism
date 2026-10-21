import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireFamily, requireRole, verifyStepUp } from "../lib/auth.js";
import { withFamily } from "../lib/db.js";
import { PolicyError, versionClauses, effectiveFor, evaluatePolicy, writeClauses, startingClauses, createVersion, activateVersion, simulateDraft, renderDocument, respond, iso, seriesFor, snapshotFor, governingPolicy } from "../lib/policy.js";
import { runReviews, reviewFindings } from "../jobs/policy.js";
import { diffClauses, PROFILE_TEMPLATES } from "@fo/finance";

const WRITERS = requireRole("owner", "member", "operator");
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const alloc = z.object({ lens: z.enum(["bucket", "asset_class", "sub_class", "geography", "currency"]), key: z.string().min(1), target_pct: z.number(), min_pct: z.number().nullable().optional(), max_pct: z.number().nullable().optional() });
const limit = z.object({ metric: z.string().min(1), operator: z.enum(["<=", ">="]), limit_value: z.number(), warn_value: z.number().nullable().optional(), severity: z.number().int().min(1).max(3).optional() });
const rule = z.object({ code: z.string().min(1), params: z.record(z.any()).default({}), severity: z.number().int().min(1).max(3).optional() });
const versionInput = z.object({ objectives: z.record(z.any()).optional(), risk: z.record(z.any()).optional(), constraints: z.record(z.any()).optional(), permitted: z.record(z.any()).optional(), rebalancing: z.record(z.any()).optional(), monitoring: z.record(z.any()).optional(), guardrails: z.record(z.any()).optional(),
  allocations: z.array(alloc).optional(), risk_limits: z.array(limit).optional(), ips_rules: z.array(rule).optional(), glide_path: z.object({ steps: z.array(z.object({ year: z.number().int(), growth_pct: z.number().optional(), equity_pct: z.number().optional() })) }).nullable().optional(), change_summary: z.string().max(1000).optional() });
const TRANSITIONS: Record<string, string[]> = { draft: ["in_review", "archived", "active"], in_review: ["draft", "active", "archived"], active: [], superseded: [], archived: ["draft"] };
const POLICY_SQL = `select p.*, e.name entity_name, g.name goal_name, pp.name parent_name,
  (select row_to_json(v) from (select id, version, status, effective_from, effective_to, risk, objectives, change_summary, approved_at, signed_by, created_at from policy_versions v where v.id=p.current_version_id) v) as current_version,
  (select row_to_json(x) from (select overall, breaches, warnings, as_of from policy_compliance pc where pc.policy_version_id=p.current_version_id order by as_of desc limit 1) x) as compliance,
  (select count(*) from policy_versions v where v.policy_id=p.id) as version_count,
  (select row_to_json(d) from (select id, version, status from policy_versions v where v.policy_id=p.id and v.status in ('draft','in_review') order by version desc limit 1) d) as open_draft,
  (select count(*) from policy_reviews r where r.policy_id=p.id and r.status in ('due','in_progress')) as open_reviews
  from investment_policies p left join entities e on e.id=p.entity_id left join goals g on g.id=p.goal_id left join investment_policies pp on pp.id=p.parent_policy_id where p.deleted_at is null`;
const view = (p: any) => ({ ...p, next_review_on: iso(p.next_review_on), version_count: Number(p.version_count ?? 0), open_reviews: Number(p.open_reviews ?? 0), current_version: p.current_version ? { ...p.current_version, effective_from: iso(p.current_version.effective_from), effective_to: iso(p.current_version.effective_to) } : null });
const versionView = (cl: any) => { const { version: v, ...clauses } = cl; return { ...clauses, id: v.id, policy_id: v.policy_id, version: v.version, status: v.status, effective_from: iso(v.effective_from), effective_to: iso(v.effective_to), change_summary: v.change_summary, created_by: v.created_by, approved_by: v.approved_by, approved_at: v.approved_at, signed_by: v.signed_by ?? [], simulation: v.simulation ?? null, has_document: !!v.document_html, document_url: v.document_html ? `/api/v1/policy-versions/${v.id}/document` : null, created_at: v.created_at, updated_at: v.updated_at }; };
const problem = (reply: any, e: any) => { if (e instanceof PolicyError) return void reply.code(e.status).send({ title: e.message, status: e.status, errors: e.errors }); throw e; };

export default async function routes(app: FastifyInstance) {
  app.addHook("preHandler", requireFamily);
  const fam = (req: any) => req.family!.familyId as string;

  // ---------- policies ----------
  app.get("/policies", async (req) => withFamily(fam(req), async (c) => {
    const q = z.object({ scope: z.enum(["family", "entity", "goal"]).optional() }).parse(req.query);
    // an active policy without a snapshot yet (fresh install, new activation) is evaluated on first sight so the list is never blank
    for (const p of (await c.query("select p.id from investment_policies p where p.deleted_at is null and p.current_version_id is not null and not exists (select 1 from policy_compliance pc where pc.policy_version_id=p.current_version_id)")).rows) await evaluatePolicy(c, fam(req), p.id, { persist: true, notify: false }).catch(() => null);
    return (await c.query(`${POLICY_SQL} ${q.scope ? "and p.scope=$1::policy_scope" : ""} order by case p.scope when 'family' then 0 when 'entity' then 1 else 2 end, p.name`, q.scope ? [q.scope] : [])).rows.map(view);
  }));
  app.post("/policies", { preHandler: WRITERS }, async (req, reply) => {
    const b = z.object({ scope: z.enum(["family", "entity", "goal"]), entity_id: z.string().uuid().optional(), goal_id: z.string().uuid().optional(), name: z.string().min(1).max(160), description: z.string().max(2000).optional(), review_every_months: z.number().int().min(1).max(60).optional(),
      start_from: z.enum(["blank", "model_portfolio", "risk_profile", "copy_parent"]).default("risk_profile"), model_portfolio_id: z.string().optional(), questionnaire_response_id: z.string().uuid().optional(), parent_policy_id: z.string().uuid().optional() }).parse(req.body);
    if (b.scope === "entity" && !b.entity_id) return void reply.code(422).send({ title: "entity_id required for an entity policy", status: 422 });
    if (b.scope === "goal" && !b.goal_id) return void reply.code(422).send({ title: "goal_id required for a goal policy", status: 422 });
    return withFamily(fam(req), async (c) => {
      try {
        const parent = b.scope === "family" ? null : b.parent_policy_id ?? (await c.query("select id from investment_policies where scope='family' and deleted_at is null order by created_at limit 1")).rows[0]?.id ?? null;
        const months = b.review_every_months ?? (b.scope === "goal" ? 6 : 12);
        const p = (await c.query("insert into investment_policies (family_id, scope, entity_id, goal_id, name, description, parent_policy_id, review_every_months) values ($1,$2::policy_scope,$3,$4,$5,$6,$7,$8) returning *", [fam(req), b.scope, b.scope === "entity" ? b.entity_id : null, b.scope === "goal" ? b.goal_id : null, b.name, b.description ?? null, parent, months])).rows[0];
        const clauses = await startingClauses(c, p, b.start_from, { model_portfolio_id: b.model_portfolio_id ?? null, questionnaire_response_id: b.questionnaire_response_id ?? null });
        const vid = await createVersion(c, fam(req), p.id, req.user!.id, clauses, `Initial draft (${b.start_from.replace("_", " ")})`);
        return void reply.code(201).send({ ...view((await c.query(`${POLICY_SQL} and p.id=$1`, [p.id])).rows[0]), draft_version_id: vid });
      } catch (e: any) { if (e.code === "23505") return void reply.code(409).send({ title: "A policy already exists for this scope", status: 409 }); return problem(reply, e); }
    });
  });
  app.get("/policies/:id", async (req, reply) => withFamily(fam(req), async (c) => {
    const p = (await c.query(`${POLICY_SQL} and p.id=$1`, [(req.params as any).id])).rows[0]; if (!p) return void reply.code(404).send({ title: "Not found", status: 404 });
    const versions = (await c.query("select id, version, status, effective_from, effective_to, change_summary, approved_at, signed_by, created_at from policy_versions where policy_id=$1 order by version desc", [p.id])).rows.map((v) => ({ ...v, effective_from: iso(v.effective_from), effective_to: iso(v.effective_to) }));
    const current = p.current_version_id ? versionView(await versionClauses(c, p.current_version_id)) : null;
    const eff = p.current_version_id ? await effectiveFor(c, p) : null;
    const reviews = (await c.query("select id, kind, trigger_reason, due_on, status, outcome, completed_at from policy_reviews where policy_id=$1 order by due_on desc limit 5", [p.id])).rows.map((r) => ({ ...r, due_on: iso(r.due_on) }));
    return { ...view(p), current_version: current, versions, effective: eff ? { clauses: eff.clauses, items: eff.items, chain: eff.chain.map((l) => ({ id: l.id, name: l.name })) } : null, reviews };
  }));
  app.patch("/policies/:id", { preHandler: WRITERS }, async (req, reply) => {
    const b = z.object({ name: z.string().min(1).max(160).optional(), description: z.string().max(2000).nullable().optional(), review_every_months: z.number().int().min(1).max(60).optional(), next_review_on: date.optional() }).parse(req.body);
    return withFamily(fam(req), async (c) => { const r = await c.query("update investment_policies set name=coalesce($2,name), description=coalesce($3,description), review_every_months=coalesce($4,review_every_months), next_review_on=coalesce($5,next_review_on) where id=$1 and deleted_at is null returning id", [(req.params as any).id, b.name ?? null, b.description ?? null, b.review_every_months ?? null, b.next_review_on ?? null]); if (!r.rowCount) return void reply.code(404).send({ title: "Not found", status: 404 }); return view((await c.query(`${POLICY_SQL} and p.id=$1`, [(req.params as any).id])).rows[0]); });
  });
  app.delete("/policies/:id", { preHandler: requireRole("owner") }, async (req, reply) => withFamily(fam(req), async (c) => {
    const p = (await c.query("select * from investment_policies where id=$1 and deleted_at is null", [(req.params as any).id])).rows[0]; if (!p) return void reply.code(404).send({ title: "Not found", status: 404 });
    if ((await c.query("select 1 from investment_policies where parent_policy_id=$1 and deleted_at is null", [p.id])).rowCount) return void reply.code(409).send({ title: "Child policies inherit this one — archive them first", status: 409 });
    await c.query("update investment_policies set deleted_at=now() where id=$1", [p.id]); await c.query("update policy_versions set status='archived' where policy_id=$1 and status in ('draft','in_review')", [p.id]);
    return void reply.code(204).send();
  }));
  /** Effective policy for an entity or goal — what the action plane and the assistant consult. */
  app.get("/policies/effective", async (req, reply) => withFamily(fam(req), async (c) => {
    const q = z.object({ entity_id: z.string().uuid().optional(), goal_id: z.string().uuid().optional() }).parse(req.query);
    const p = await governingPolicy(c, q.entity_id ?? null, q.goal_id ?? null); if (!p) return void reply.code(404).send({ title: "No active policy", status: 404 });
    const eff = await effectiveFor(c, p); return { policy_id: p.id, policy_name: p.name, scope: p.scope, version_id: p.current_version_id, clauses: eff.clauses, items: eff.items, chain: eff.chain.map((l) => ({ id: l.id, name: l.name })) };
  }));

  // ---------- versions ----------
  app.get("/policies/:id/versions", async (req) => withFamily(fam(req), async (c) => { const rows = (await c.query("select id from policy_versions where policy_id=$1 order by version desc", [(req.params as any).id])).rows; const out = []; for (const r of rows) out.push(versionView(await versionClauses(c, r.id))); return out; }));
  app.post("/policies/:id/versions", { preHandler: WRITERS }, async (req, reply) => {
    const b = versionInput.parse(req.body ?? {});
    return withFamily(fam(req), async (c) => {
      const p = (await c.query("select * from investment_policies where id=$1 and deleted_at is null", [(req.params as any).id])).rows[0]; if (!p) return void reply.code(404).send({ title: "Not found", status: 404 });
      const open = (await c.query("select id, version from policy_versions where policy_id=$1 and status in ('draft','in_review')", [p.id])).rows[0]; if (open) return void reply.code(409).send({ title: `Draft v${open.version} is already open — edit or archive it`, status: 409, version_id: open.id });
      try {
        const base = p.current_version_id ? await versionClauses(c, p.current_version_id) : await startingClauses(c, p, "blank", {});
        const { version: _v, ...baseClauses } = base as any;
        const vid = await createVersion(c, fam(req), p.id, req.user!.id, { ...baseClauses, ...Object.fromEntries(Object.entries(b).filter(([k, v]) => v !== undefined && k !== "change_summary")) } as any, b.change_summary ?? (p.current_version_id ? "Amendment" : "Initial draft"));
        return void reply.code(201).send(versionView(await versionClauses(c, vid)));
      } catch (e) { return problem(reply, e); }
    });
  });
  app.get("/policy-versions/:id", async (req, reply) => withFamily(fam(req), async (c) => { try { const cl = await versionClauses(c, (req.params as any).id); const p = (await c.query("select * from investment_policies where id=$1", [cl.version.policy_id])).rows[0]; const eff = await effectiveFor(c, p, cl.version.id); return { ...versionView(cl), effective: { clauses: eff.clauses, items: eff.items, chain: eff.chain.map((l) => ({ id: l.id, name: l.name })) } }; } catch (e) { return problem(reply, e); } }));
  app.patch("/policy-versions/:id", { preHandler: WRITERS }, async (req, reply) => {
    const b = versionInput.parse(req.body ?? {});
    return withFamily(fam(req), async (c) => { try {
      const cl = await versionClauses(c, (req.params as any).id); if (!["draft", "in_review"].includes(cl.version.status)) return void reply.code(409).send({ title: `A ${cl.version.status} version is immutable — open a new draft`, status: 409 });
      const out = versionView(await writeClauses(c, fam(req), cl.version.id, b as any)); const p = (await c.query("select * from investment_policies where id=$1", [cl.version.policy_id])).rows[0]; const eff = await effectiveFor(c, p, cl.version.id);
      return { ...out, effective: { clauses: eff.clauses, items: eff.items, chain: eff.chain.map((l) => ({ id: l.id, name: l.name })) } };
    } catch (e) { return problem(reply, e); } });
  });
  app.post("/policy-versions/:id/simulate", { preHandler: WRITERS }, async (req, reply) => withFamily(fam(req), async (c) => { try { return await simulateDraft(c, fam(req), (req.params as any).id, (req.body as any)?.as_of); } catch (e) { return problem(reply, e); } }));
  app.post("/policy-versions/:id/status", { preHandler: WRITERS }, async (req, reply) => {
    const b = z.object({ status: z.enum(["in_review", "active", "archived", "draft"]), effective_from: date.optional(), auth_method: z.enum(["totp", "biometric", "passkey"]).optional(), auth_proof: z.string().optional(), note: z.string().max(1000).optional() }).parse(req.body);
    return withFamily(fam(req), async (c) => { try {
      const id = (req.params as any).id; const v = (await c.query("select * from policy_versions where id=$1", [id])).rows[0]; if (!v) return void reply.code(404).send({ title: "Not found", status: 404 });
      if (!TRANSITIONS[v.status]?.includes(b.status)) return void reply.code(409).send({ title: `Cannot move from ${v.status} to ${b.status}`, status: 409, allowed: TRANSITIONS[v.status] });
      if (b.status === "active") {
        if (req.family!.role !== "owner") return void reply.code(403).send({ title: "Only an owner can activate a policy version", status: 403 });
        if (b.auth_proof && !(await verifyStepUp(req.user!.id, b.auth_method ?? "totp", b.auth_proof))) return void reply.code(403).send({ title: "Step-up failed", status: 403 });
        const r = await activateVersion(c, fam(req), id, req.user!.id, b.effective_from);
        return { ...versionView(await versionClauses(c, id)), ...r };
      }
      await c.query("update policy_versions set status=$2::policy_status, change_summary = case when $3::text is null then change_summary else coalesce(change_summary,'') || case when change_summary is null or change_summary='' then '' else ' · ' end || $3 end, updated_at=now() where id=$1", [id, b.status, b.note ?? null]);
      return versionView(await versionClauses(c, id));
    } catch (e) { return problem(reply, e); } });
  });
  app.post("/policy-versions/:id/sign", { preHandler: requireRole("owner", "member") }, async (req, reply) => {
    const b = z.object({ auth_method: z.enum(["totp", "biometric", "passkey"]), auth_proof: z.string(), role: z.string().max(40).optional() }).parse(req.body);
    if (!(await verifyStepUp(req.user!.id, b.auth_method, b.auth_proof))) return void reply.code(403).send({ title: "Step-up failed", status: 403 });
    return withFamily(fam(req), async (c) => {
      const v = (await c.query("select * from policy_versions where id=$1", [(req.params as any).id])).rows[0]; if (!v) return void reply.code(404).send({ title: "Not found", status: 404 });
      if (!["draft", "in_review", "active"].includes(v.status)) return void reply.code(409).send({ title: `Cannot sign a ${v.status} version`, status: 409 });
      const signed = (v.signed_by ?? []).filter((s: any) => s.user_id !== req.user!.id);
      signed.push({ user_id: req.user!.id, name: req.user!.name, role: b.role ?? (req.family!.role === "owner" ? "principal" : "member"), signed_at: new Date().toISOString(), auth_method: b.auth_method });
      await c.query("update policy_versions set signed_by=$2, updated_at=now() where id=$1", [v.id, JSON.stringify(signed)]);
      if (v.status === "active") await renderDocument(c, v.id);
      return { id: v.id, signed_by: signed };
    });
  });
  app.post("/policy-versions/:id/document", { preHandler: WRITERS }, async (req, reply) => withFamily(fam(req), async (c) => { try { await renderDocument(c, (req.params as any).id); return void reply.code(202).send({ job_id: (req.params as any).id, status: "done", url: `/api/v1/policy-versions/${(req.params as any).id}/document` }); } catch (e) { return problem(reply, e); } }));
  app.get("/policy-versions/:id/document", async (req, reply) => withFamily(fam(req), async (c) => {
    const v = (await c.query("select document_html from policy_versions where id=$1", [(req.params as any).id])).rows[0]; if (!v) return void reply.code(404).send({ title: "Not found", status: 404 });
    const html = v.document_html ?? (await renderDocument(c, (req.params as any).id));
    return void reply.type("text/html; charset=utf-8").send(`<!doctype html><meta charset="utf-8"><title>Investment Policy Statement</title><style>body{font-family:Georgia,serif;max-width:860px;margin:32px auto;line-height:1.6;color:#1B2A41;padding:0 16px}h2{font-family:system-ui,sans-serif;color:#12213A}.meta,.sign,.log{color:#6B7686;font-size:13px}table{border-collapse:collapse;width:100%;font-family:system-ui,sans-serif;font-size:12.5px;margin:16px 0}th,td{border-bottom:1px solid #E3E6EB;padding:6px 8px;text-align:left;vertical-align:top}th{color:#6B7686;font-weight:600}</style>${html}`);
  }));
  app.get("/policy-versions/:id/diff", async (req, reply) => withFamily(fam(req), async (c) => { try {
    const cl = await versionClauses(c, (req.params as any).id); const against = (req.query as any).against as string | undefined;
    const other = against ? await versionClauses(c, against) : (await c.query("select id from policy_versions where policy_id=$1 and version < $2 order by version desc limit 1", [cl.version.policy_id, cl.version.version])).rows[0];
    if (!other) return [];
    const o = "version" in other ? other : await versionClauses(c, other.id);
    return diffClauses(o as any, cl as any);
  } catch (e) { return problem(reply, e); } }));

  // ---------- compliance ----------
  app.get("/policies/:id/compliance", async (req, reply) => withFamily(fam(req), async (c) => {
    const p = (await c.query("select * from investment_policies where id=$1 and deleted_at is null", [(req.params as any).id])).rows[0]; if (!p) return void reply.code(404).send({ title: "Not found", status: 404 });
    const history = ["1", "true"].includes(String((req.query as any).history ?? ""));
    const rows = (await c.query(`select * from policy_compliance where policy_version_id=$1 order by as_of desc ${history ? "limit 120" : "limit 1"}`, [p.current_version_id])).rows.map((r) => ({ ...r, as_of: iso(r.as_of) }));
    if (history) return rows;
    if (rows[0]) return rows[0];
    try { const e = await evaluatePolicy(c, fam(req), p.id, { persist: true }); return e ? { policy_version_id: e.policy_version_id, as_of: e.as_of, overall: e.compliance.overall, checks: e.compliance.checks, breaches: e.compliance.breaches, warnings: e.compliance.warnings, task_ids: e.task_ids, metrics: { ...e.metrics, ...e.snapshot } } : null; } catch (e) { return problem(reply, e); }
  }));
  app.post("/policies/:id/compliance", { preHandler: WRITERS }, async (req, reply) => withFamily(fam(req), async (c) => { try {
    const e = await evaluatePolicy(c, fam(req), (req.params as any).id, { persist: true, asOf: (req.body as any)?.as_of }); if (!e) return void reply.code(409).send({ title: "No active version to evaluate", status: 409 });
    return { policy_version_id: e.policy_version_id, as_of: e.as_of, overall: e.compliance.overall, checks: e.compliance.checks, breaches: e.compliance.breaches, warnings: e.compliance.warnings, task_ids: e.task_ids, metrics: { ...e.metrics, ...e.snapshot } };
  } catch (e) { return problem(reply, e); } }));

  // ---------- reviews ----------
  app.get("/policies/:id/reviews", async (req) => withFamily(fam(req), async (c) => (await c.query("select r.*, u.name reviewer_name, v.version resulting_version from policy_reviews r left join users u on u.id=r.reviewer_user_id left join policy_versions v on v.id=r.resulting_version_id where r.policy_id=$1 order by case r.status when 'in_progress' then 0 when 'due' then 1 else 2 end, r.due_on desc", [(req.params as any).id])).rows.map((r) => ({ ...r, due_on: iso(r.due_on) }))));
  app.get("/policy-reviews", async (req) => withFamily(fam(req), async (c) => (await c.query("select r.*, p.name policy_name, p.scope, u.name reviewer_name from policy_reviews r join investment_policies p on p.id=r.policy_id left join users u on u.id=r.reviewer_user_id where p.deleted_at is null order by case r.status when 'in_progress' then 0 when 'due' then 1 else 2 end, r.due_on desc limit 100")).rows.map((r) => ({ ...r, due_on: iso(r.due_on) }))));
  app.post("/policies/:id/reviews", { preHandler: WRITERS }, async (req, reply) => {
    const b = z.object({ kind: z.enum(["trigger", "ad_hoc"]).default("ad_hoc"), trigger_reason: z.string().max(80).optional(), due_on: date.optional(), note: z.string().max(2000).optional() }).parse(req.body ?? {});
    return withFamily(fam(req), async (c) => {
      const p = (await c.query("select p.*, v.effective_from, v.risk from investment_policies p left join policy_versions v on v.id=p.current_version_id where p.id=$1 and p.deleted_at is null", [(req.params as any).id])).rows[0]; if (!p) return void reply.code(404).send({ title: "Not found", status: 404 });
      const findings = await reviewFindings(c, fam(req), p); const due = b.due_on ?? new Date().toISOString().slice(0, 10);
      const r = (await c.query("insert into policy_reviews (family_id, policy_id, kind, trigger_reason, due_on, status, findings, note, reviewer_user_id) values ($1,$2,$3::review_kind,$4,$5,'due',$6,$7,$8) returning *", [fam(req), p.id, b.kind, b.trigger_reason ?? b.kind, due, JSON.stringify(findings), b.note ?? null, req.user!.id])).rows[0];
      const t = (await c.query("insert into tasks (family_id, entity_id, module, title, reason, due_date, severity, source_type, source_id, verification) values ($1,$2,'policy',$3,$4,$5,2,'policy_review',$6,'na') returning id", [fam(req), p.entity_id ?? null, `${p.name}: ${b.kind === "trigger" ? b.trigger_reason ?? "trigger" : "ad-hoc"} review`, findings.summary, due, r.id])).rows[0];
      await c.query("update policy_reviews set task_id=$2 where id=$1", [r.id, t.id]);
      return void reply.code(201).send({ ...r, due_on: iso(r.due_on), task_id: t.id });
    });
  });
  app.patch("/policy-reviews/:id", { preHandler: WRITERS }, async (req, reply) => {
    const b = z.object({ status: z.enum(["in_progress", "completed", "skipped"]).optional(), outcome: z.enum(["no_change", "amended", "superseded"]).optional(), resulting_version_id: z.string().uuid().optional(), note: z.string().max(2000).optional(), findings: z.record(z.any()).optional() }).parse(req.body ?? {});
    return withFamily(fam(req), async (c) => {
      const r = (await c.query("select r.*, p.review_every_months, p.current_version_id from policy_reviews r join investment_policies p on p.id=r.policy_id where r.id=$1", [(req.params as any).id])).rows[0]; if (!r) return void reply.code(404).send({ title: "Not found", status: 404 });
      let resulting = b.resulting_version_id ?? r.resulting_version_id ?? null; let status = b.status ?? (b.outcome ? "completed" : r.status);
      if (b.outcome === "amended" && !resulting) { // open the amendment draft and link it
        const open = (await c.query("select id from policy_versions where policy_id=$1 and status in ('draft','in_review') order by version desc limit 1", [r.policy_id])).rows[0];
        if (open) resulting = open.id; else { const base = r.current_version_id ? await versionClauses(c, r.current_version_id) : null; const { version: _v, ...cl } = (base ?? {}) as any; resulting = await createVersion(c, fam(req), r.policy_id, req.user!.id, base ? cl : await startingClauses(c, (await c.query("select * from investment_policies where id=$1", [r.policy_id])).rows[0], "blank", {}), `Amendment from review ${iso(r.due_on)}${b.note ? `: ${b.note}` : ""}`); }
      }
      const done = status === "completed" || status === "skipped";
      const u = (await c.query("update policy_reviews set status=$2::review_status, outcome=coalesce($3,outcome), resulting_version_id=$4, note=coalesce($5,note), findings=coalesce($6,findings), reviewer_user_id=coalesce(reviewer_user_id,$7), started_at=coalesce(started_at, case when $2 <> 'due' then now() end), completed_at=case when $8 then now() else completed_at end where id=$1 returning *", [r.id, status, b.outcome ?? null, resulting, b.note ?? null, b.findings ? JSON.stringify(b.findings) : null, req.user!.id, done])).rows[0];
      if (done && r.task_id) await c.query("update tasks set status=$2, done_at=now() where id=$1 and status='open'", [r.task_id, status === "completed" ? "done" : "dismissed"]);
      if (b.outcome === "no_change") await c.query("update investment_policies set next_review_on = current_date + ($2 || ' months')::interval where id=$1", [r.policy_id, String(r.review_every_months ?? 12)]);
      const diff = resulting && r.current_version_id && resulting !== r.current_version_id ? diffClauses((await versionClauses(c, r.current_version_id)) as any, (await versionClauses(c, resulting)) as any) : [];
      return { ...u, due_on: iso(u.due_on), diff };
    });
  });
  app.post("/policy-reviews/run", { preHandler: WRITERS }, async (req) => withFamily(fam(req), async (c) => runReviews(c, fam(req), (req.body as any)?.today)));

  // ---------- questionnaires & risk metrics ----------
  app.get("/risk-questionnaires", async (req) => withFamily(fam(req), async (c) => (await c.query("select id, name, version, questions, scoring, family_id is null as system from risk_questionnaires order by family_id nulls first, name")).rows));
  app.post("/risk-questionnaires", { preHandler: WRITERS }, async (req, reply) => {
    const b = z.object({ name: z.string().min(1).max(120), questions: z.array(z.object({ id: z.string(), dimension: z.enum(["capacity", "tolerance", "horizon", "knowledge"]), text: z.string(), options: z.array(z.object({ label: z.string(), score: z.number() })).min(2) })).min(1), scoring: z.object({ weights: z.record(z.number()), bands: z.array(z.object({ max: z.number(), profile: z.enum(["conservative", "moderately_conservative", "moderate", "moderately_aggressive", "aggressive"]) })).min(1) }).optional() }).parse(req.body);
    const sys = (await withFamily(fam(req), (c) => c.query("select scoring from risk_questionnaires where family_id is null order by version desc limit 1"))).rows[0]?.scoring;
    return withFamily(fam(req), async (c) => { const v = Number((await c.query("select coalesce(max(version),0)+1 v from risk_questionnaires where family_id=$1 and name=$2", [fam(req), b.name])).rows[0].v); return void reply.code(201).send((await c.query("insert into risk_questionnaires (family_id, name, version, questions, scoring) values ($1,$2,$3,$4,$5) returning id, name, version, questions, scoring, false as system", [fam(req), b.name, v, JSON.stringify(b.questions), JSON.stringify(b.scoring ?? sys)])).rows[0]); });
  });
  app.post("/risk-questionnaires/:id/respond", async (req, reply) => {
    const b = z.object({ entity_id: z.string().uuid().optional(), goal_id: z.string().uuid().optional(), answers: z.record(z.string()) }).parse(req.body);
    return withFamily(fam(req), async (c) => { try { return await respond(c, fam(req), req.user!.id, (req.params as any).id, b); } catch (e) { return problem(reply, e); } });
  });
  app.get("/risk-questionnaire-responses", async (req) => withFamily(fam(req), async (c) => (await c.query("select r.id, r.entity_id, r.goal_id, e.name entity_name, g.name goal_name, u.name respondent, r.score, r.capacity_score, r.tolerance_score, r.horizon_score, r.knowledge_score, r.profile, r.completed_at from risk_questionnaire_responses r left join entities e on e.id=r.entity_id left join goals g on g.id=r.goal_id left join users u on u.id=r.respondent_user_id order by r.completed_at desc limit 50")).rows));
  app.get("/risk-profiles/templates", async () => PROFILE_TEMPLATES);
  app.get("/risk-metrics", async (req, reply) => withFamily(fam(req), async (c) => {
    const q = z.object({ scope_type: z.enum(["asset", "entity", "bucket", "family", "goal"]), scope_id: z.string().uuid().optional(), as_of: date.optional(), history_months: z.coerce.number().int().min(1).max(60).default(12) }).parse(req.query);
    const scopeId = q.scope_id ?? (q.scope_type === "family" ? fam(req) : null); if (!scopeId) return void reply.code(422).send({ title: "scope_id required", status: 422 });
    const asOf = q.as_of ?? new Date().toISOString().slice(0, 10);
    let rows = (await c.query("select as_of, metric, value, lookback from risk_metrics where family_id=$1 and scope_type=$2::scope_type and scope_id=$3 and as_of <= $4 and as_of >= ($4::date - ($5 || ' months')::interval) order by as_of", [fam(req), q.scope_type, scopeId, asOf, String(q.history_months)])).rows;
    if (!rows.some((r) => iso(r.as_of) === asOf) && ["family", "entity", "goal"].includes(q.scope_type)) { // nothing stored for that date: compute on demand through the governing policy's snapshot
      const p = await governingPolicy(c, q.scope_type === "entity" ? scopeId : null, q.scope_type === "goal" ? scopeId : null);
      if (p) { await evaluatePolicy(c, fam(req), p.id, { asOf, persist: true }); rows = (await c.query("select as_of, metric, value, lookback from risk_metrics where family_id=$1 and scope_type=$2::scope_type and scope_id=$3 and as_of <= $4 and as_of >= ($4::date - ($5 || ' months')::interval) order by as_of", [fam(req), q.scope_type, scopeId, asOf, String(q.history_months)])).rows; }
    }
    const latest: Record<string, number> = {}; const history: Record<string, { as_of: string; value: number }[]> = {};
    for (const r of rows) { latest[r.metric] = Number(r.value); (history[r.metric] ??= []).push({ as_of: iso(r.as_of)!, value: Number(r.value) }); }
    const series = await seriesFor(c, fam(req), q.scope_type, scopeId, null, asOf, q.history_months);
    return { scope_type: q.scope_type, scope_id: scopeId, as_of: rows.length ? iso(rows[rows.length - 1].as_of) : asOf, metrics: latest, history, valuations: series.valuations, periods: series.metrics.periods };
  }));
}
