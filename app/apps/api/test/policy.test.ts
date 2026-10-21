import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildApp } from "../src/server.js";
import { withFamily } from "../src/lib/db.js";

const FAMILY = "11111111-1111-1111-1111-111111111111";
const ARJUN = "33333333-0000-0000-0000-000000000001", HUF = "33333333-0000-0000-0000-000000000002", SPOUSE = "33333333-0000-0000-0000-000000000003";
const P_FAMILY = "9a000000-0000-0000-0000-000000000001", P_HUF = "9a000000-0000-0000-0000-000000000002", P_RET = "9a000000-0000-0000-0000-000000000003", P_MBA = "9a000000-0000-0000-0000-000000000004";
const V_FAM3 = "9b000000-0000-0000-0000-000000000013", V_FAM2 = "9b000000-0000-0000-0000-000000000012", V_RET1 = "9b000000-0000-0000-0000-000000000031";
const GOAL_HOME = "77777777-0000-0000-0000-000000000003", PPFAS = "44444444-0000-0000-0000-000000000003", LIQUID = "44444444-0000-0000-0000-000000000007";
let app: ReturnType<typeof buildApp>; let owner = "", operator = "", viewer = "";
const h = (t = owner) => ({ authorization: `Bearer ${t}`, "x-family-id": FAMILY });
const get = async (url: string, t = owner) => { const r = await app.inject({ url: `/api/v1${url}`, headers: h(t) }); return { code: r.statusCode, body: r.headers["content-type"]?.toString().includes("json") ? r.json() : r.body }; };
const send = async (method: "POST" | "PATCH" | "PUT" | "DELETE", url: string, payload: any = {}, t = owner) => { const r = await app.inject({ method, url: `/api/v1${url}`, headers: h(t), payload }); return { code: r.statusCode, body: r.statusCode === 204 ? null : r.json() }; };

const TABLES = ["investment_policies", "policy_versions", "policy_allocations", "policy_risk_limits", "policy_compliance", "policy_reviews", "risk_questionnaire_responses", "asset_class_targets", "execution_policies", "ips_rules", "glide_paths", "bucket_targets", "tasks", "notifications", "action_intents", "connectors", "goal_links"];
const before: Record<string, string[]> = {}; let versionsBefore: any[] = [], policiesBefore: any[] = [], flagsBefore: any[] = [], reviewsBefore: any[] = [];
beforeAll(async () => {
  app = buildApp(); await app.ready();
  const login = async (email: string) => (await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password: "Prototype!2026" } })).json().access_token;
  owner = await login("arjun@example.com"); operator = await login("ops@example.com"); viewer = await login("ca@example.com");
  await withFamily(FAMILY, async (c) => {
    for (const t of TABLES) before[t] = (await c.query(t === "goal_links" ? "select goal_id::text || ':' || coalesce(holding_id::text,'') k from goal_links" : `select id::text k from ${t}`)).rows.map((r) => r.k);
    versionsBefore = (await c.query("select id, status, effective_from, effective_to, signed_by, approved_by, approved_at, document_html, simulation from policy_versions")).rows;
    policiesBefore = (await c.query("select id, current_version_id, next_review_on, review_every_months, name from investment_policies")).rows;
    flagsBefore = (await c.query("select 'ips_rules' t, id, active from ips_rules union all select 'execution_policies', id, active from execution_policies")).rows;
    reviewsBefore = (await c.query("select * from policy_reviews")).rows;
  });
});
afterAll(async () => {
  await withFamily(FAMILY, async (c) => {
    // reviews first (they point at tasks and versions), then tasks, then the policy tree
    await c.query("delete from policy_reviews where id::text <> all($1::text[])", [before.policy_reviews]);
    for (const r of reviewsBefore) await c.query("update policy_reviews set status=$2, outcome=$3, resulting_version_id=$4, note=$5, findings=$6, completed_at=$7, started_at=$8, task_id=$9, reviewer_user_id=$10 where id=$1", [r.id, r.status, r.outcome, r.resulting_version_id, r.note, r.findings, r.completed_at, r.started_at, r.task_id, r.reviewer_user_id]);
    for (const t of ["policy_compliance", "policy_allocations", "policy_risk_limits", "tasks", "notifications", "action_intents", "risk_questionnaire_responses", "asset_class_targets", "execution_policies", "ips_rules", "glide_paths", "bucket_targets"]) await c.query(`delete from ${t} where id::text <> all($1::text[])`, [before[t]]);
    await c.query("delete from connectors where id::text <> all($1::text[])", [before.connectors]);
    await c.query("delete from goal_links where goal_id::text || ':' || coalesce(holding_id::text,'') <> all($1::text[])", [before.goal_links]);
    await c.query("delete from valuations_daily where scope_type='family' and scope_id=$1 and (as_of < '2026-09-01' or as_of > '2026-09-12')", [FAMILY]); // the month-end fixture, not the market suite's snapshots
    for (const p of policiesBefore) await c.query("update investment_policies set current_version_id=$2, next_review_on=$3, review_every_months=$4, name=$5, deleted_at=null where id=$1", [p.id, p.current_version_id, p.next_review_on, p.review_every_months, p.name]);
    await c.query("update investment_policies set current_version_id=null where id::text <> all($1::text[])", [before.investment_policies]);
    await c.query("delete from policy_versions where id::text <> all($1::text[])", [before.policy_versions]);
    await c.query("delete from investment_policies where id::text <> all($1::text[])", [before.investment_policies]);
    for (const v of versionsBefore) await c.query("update policy_versions set status=$2, effective_from=$3, effective_to=$4, signed_by=$5, approved_by=$6, approved_at=$7, document_html=$8, simulation=$9 where id=$1", [v.id, v.status, v.effective_from, v.effective_to, JSON.stringify(v.signed_by ?? []), v.approved_by, v.approved_at, v.document_html, v.simulation]);
    for (const f of flagsBefore) await c.query(`update ${f.t} set active=$2 where id=$1`, [f.id, f.active]);
  });
  await app.close();
});

describe("policies, inheritance and compliance (FO-140, FO-144)", () => {
  it("lists the seeded policies with their compliance and resolves the retirement goal's effective clauses with origin", async () => {
    const list = (await get("/policies")).body; expect(list.length).toBe(4);
    const fam = list.find((p: any) => p.id === P_FAMILY); expect(fam.current_version.version).toBe(3); expect(fam.version_count).toBe(3);
    const d = (await get(`/policies/${P_RET}`)).body;
    expect(d.parent_name).toBe("Mehta Family Investment Policy"); expect(d.effective.chain.map((l: any) => l.name)).toEqual(["Mehta Family Investment Policy", "Retirement income floor (2036)"]);
    const items = d.effective.items; const overrides = items.filter((i: any) => !i.inherited);
    expect(overrides.some((i: any) => i.section === "allocation" && i.key === "asset_class:equity" && i.value.target_pct === 45 && i.parent_value.target_pct === 30)).toBe(true);
    expect(items.find((i: any) => i.section === "permitted" && i.key === "prohibited")).toMatchObject({ inherited: true, origin: "Mehta Family Investment Policy" });
    expect(items.find((i: any) => i.key === "min_rating")).toMatchObject({ inherited: false, value: "AA+", parent_value: "AA" });
    expect(d.effective.clauses.risk_limits.find((l: any) => l.metric === "max_drawdown").limit_value).toBe(-12); expect(d.effective.clauses.risk_limits.find((l: any) => l.metric === "volatility_1y").limit_value).toBe(14);
    expect(d.effective.clauses.ips_rules.find((r: any) => r.code === "max_single_issuer").params.pct).toBe(15); // inherited from the family
    expect(overrides.length).toBeGreaterThanOrEqual(6);
  });
  it("one active version per policy is enforced by the database", async () => {
    await expect(withFamily(FAMILY, (c) => c.query("update policy_versions set status='active' where id=$1", [V_FAM2]))).rejects.toThrow(/policy_versions_one_active/);
  });
  it("evaluates compliance: the retirement sleeve breaches its equity band and raises one task; the HUF is compliant and closes nothing", async () => {
    const r = (await send("POST", `/policies/${P_RET}/compliance`)).body;
    expect(r.overall).toBe("breach"); const by = Object.fromEntries(r.checks.map((x: any) => [x.key, x]));
    expect(by["asset_class:equity"]).toMatchObject({ status: "breach", target: "45% (35–55)" }); expect(Number(by["asset_class:equity"].actual.replace("%", ""))).toBeCloseTo(67.85, 1);
    expect(by["growth_vs_glide"].status).toBe("warning"); expect(by["growth_vs_glide"].target).toBe("60% (2026)");
    expect(by["prohibited"].status).toBe("in_band"); expect(by["manager_max"].status).toBe("n/a"); expect(by["max_drawdown"].status).toBe("n/a"); // two positions, no valuation history
    expect(r.task_ids.length).toBe(1); const tasks = (await get("/tasks?status=open&module=policy")).body; expect(tasks.some((t: any) => t.source_id === P_RET && /Policy breach: Retirement/.test(t.title))).toBe(true);
    expect((await send("POST", `/policies/${P_RET}/compliance`)).body.task_ids).toEqual(r.task_ids); // re-evaluation does not duplicate the task
    const huf = (await send("POST", `/policies/${P_HUF}/compliance`)).body; expect(huf.overall).toBe("compliant"); expect(huf.metrics.allocation.asset_class.alternatives).toBeCloseTo(79.87, 1); expect(huf.metrics.liquidity_months).toBeCloseTo(15.16, 1);
    const fam = (await send("POST", `/policies/${P_FAMILY}/compliance`)).body; expect(fam.overall).toBe("warning"); expect(fam.warnings).toBe(4); expect(fam.metrics.issuer_top).toBe("HDFC Bank");
    expect((await get(`/policies/${P_FAMILY}/compliance?history=1`)).body.length).toBeGreaterThanOrEqual(1);
    expect((await get(`/policies/${P_FAMILY}/compliance`)).body.overall).toBe("warning");
  });
  it("serves the governing policy for an entity: HUF clauses over family defaults", async () => {
    const e = (await get(`/policies/effective?entity_id=${HUF}`)).body; expect(e.policy_name).toBe("Mehta HUF");
    expect(e.clauses.constraints.liquidity_months).toBe(12); expect(e.clauses.permitted.prohibited).toContain("crypto"); expect(e.clauses.permitted.min_rating).toBe("AA+");
    expect((await get(`/policies/effective?entity_id=${SPOUSE}`)).body.policy_name).toBe("Mehta Family Investment Policy");
  });
});

describe("risk profiling (FO-141)", () => {
  it("reproduces the seeded retirement questionnaire (44 → moderately conservative) and caps tolerance by capacity", async () => {
    const qs = (await get("/risk-questionnaires")).body; const q = qs.find((x: any) => x.system);
    const seeded = { q1: "50–100%", q2: "6–24", q3: "20–50%", q4: "Over 30%", q5: "Hold and wait", q6: "10–15%", q7: "Balanced", q8: "Held through", q9: "5–15", q10: "3–10 years", q11: "Moderate", q12: "Joint" };
    const r = (await send("POST", `/risk-questionnaires/${q.id}/respond`, { goal_id: "77777777-0000-0000-0000-000000000002", answers: seeded })).body;
    expect(Math.round(r.score)).toBe(44); expect(r.profile).toBe("moderately_conservative"); expect(r.notes).toContain("capacity caps tolerance");
    expect(r.suggested_max_drawdown_pct).toBe(-12); expect(r.suggested_liquidity_months).toBe(36); expect(r.suggested_limits.some((l: any) => l.metric === "volatility_1y" && l.limit_value === 14)).toBe(true); expect(r.suggested_model.mix.equity).toBe(45);
    const low: Record<string, string> = {}; for (const qu of q.questions) low[qu.id] = qu.dimension === "capacity" ? qu.options[0].label : qu.options[2].label;
    const r2 = (await send("POST", `/risk-questionnaires/${q.id}/respond`, { entity_id: HUF, answers: low })).body; expect(r2.profile).toBe("conservative"); expect(r2.suggested_model_portfolio_id).toBeTruthy();
    expect((await get("/risk-questionnaire-responses")).body[0].response_id ?? (await get("/risk-questionnaire-responses")).body[0].id).toBeTruthy();
  });
});

describe("builder, activation, amendment (FO-142, FO-146)", () => {
  let policyId = "", v1 = "", v2 = "";
  it("creates a goal policy pre-filled from the risk profile, validates edits, simulates, signs and activates", async () => {
    expect((await send("POST", "/policies", { scope: "goal", goal_id: GOAL_HOME, name: "Second home (2031)" }, viewer)).code).toBe(403);
    const created = await send("POST", "/policies", { scope: "goal", goal_id: GOAL_HOME, name: "Second home (2031)", start_from: "risk_profile" });
    expect(created.code).toBe(201); policyId = created.body.id; v1 = created.body.draft_version_id; expect(created.body.parent_policy_id).toBe(P_FAMILY); expect(created.body.open_draft.version).toBe(1);
    expect((await send("POST", "/policies", { scope: "goal", goal_id: GOAL_HOME, name: "dup" })).code).toBe(409);
    const draft = (await get(`/policy-versions/${v1}`)).body; expect(draft.status).toBe("draft"); expect(draft.allocations.filter((a: any) => a.lens === "asset_class").reduce((s: number, a: any) => s + a.target_pct, 0)).toBe(100); expect(draft.risk.profile).toBeTruthy();
    expect(draft.effective.clauses.permitted.prohibited).toContain("crypto"); // inherited from the family while the draft is edited
    const bad = await send("PATCH", `/policy-versions/${v1}`, { allocations: [{ lens: "asset_class", key: "equity", target_pct: 60, min_pct: 65, max_pct: 70 }, { lens: "asset_class", key: "debt", target_pct: 30 }] });
    expect(bad.code).toBe(422); expect(bad.body.errors.map((e: any) => e.field)).toContain("allocations.asset_class");
    const ok = await send("PATCH", `/policy-versions/${v1}`, { objectives: { purpose: "Kodaikanal home by 2031", return_objective_pct: 4, return_basis: "real", horizon_years: 5, spending_need_pa: 0 }, constraints: { liquidity_months: 0 },
      allocations: [{ lens: "asset_class", key: "equity", target_pct: 50, min_pct: 40, max_pct: 60 }, { lens: "asset_class", key: "debt", target_pct: 40, min_pct: 30, max_pct: 50 }, { lens: "asset_class", key: "cash", target_pct: 10, min_pct: 0, max_pct: 20 }],
      risk_limits: [{ metric: "max_drawdown", operator: ">=", limit_value: -15, warn_value: -12 }], glide_path: { steps: [{ year: 2026, equity_pct: 50 }, { year: 2031, equity_pct: 20 }] }, change_summary: "targets set" });
    expect(ok.code).toBe(200); expect(ok.body.allocations.length).toBe(3); expect(ok.body.effective.clauses.risk_limits.find((l: any) => l.metric === "volatility_1y").limit_value).toBe(18); // family limit still inherited
    const sim = (await send("POST", `/policy-versions/${v1}/simulate`)).body;
    expect(sim.compliance.overall).toBeTruthy(); expect(sim.expected_return_pct).toBeCloseTo(0.5 * 12 + 0.4 * 7 + 0.1 * 5.5, 1); expect(sim.objective_nominal_pct).toBe(10); expect(typeof sim.tax_cost_to_comply).toBe("string");
    expect((await send("POST", `/policy-versions/${v1}/status`, { status: "active" })).code).toBe(409); // unsigned
    expect((await send("POST", `/policy-versions/${v1}/status`, { status: "in_review" })).body.status).toBe("in_review");
    expect((await send("POST", `/policy-versions/${v1}/sign`, { auth_method: "totp", auth_proof: "999999" })).code).toBe(403);
    const signed = (await send("POST", `/policy-versions/${v1}/sign`, { auth_method: "totp", auth_proof: "000000" })).body; expect(signed.signed_by[0]).toMatchObject({ name: "Arjun Mehta", role: "principal", auth_method: "totp" });
    expect((await send("POST", `/policy-versions/${v1}/status`, { status: "active" }, operator)).code).toBe(403);
    const act = await send("POST", `/policy-versions/${v1}/status`, { status: "active", effective_from: "2026-10-01" });
    expect(act.code).toBe(200); expect(act.body.status).toBe("active"); expect(act.body.effective_from).toBe("2026-10-01"); expect(act.body.next_review_on).toBe("2027-04-01"); expect(act.body.has_document).toBe(true);
    const p = (await get(`/policies/${policyId}`)).body; expect(p.current_version.id).toBe(v1); expect(p.next_review_on).toBe("2027-04-01");
    await withFamily(FAMILY, async (c) => { expect((await c.query("select steps from glide_paths where goal_id=$1 and policy_version_id=$2", [GOAL_HOME, v1])).rows[0].steps.length).toBe(2); });
    const doc = await get(`/policy-versions/${v1}/document`); expect(doc.code).toBe(200); expect(String(doc.body)).toMatch(/Investment Policy Statement — Second home \(2031\) · v1/); expect(String(doc.body)).toMatch(/Kodaikanal home by 2031/); expect(String(doc.body)).toMatch(/Signed: Arjun Mehta/); expect(String(doc.body)).toMatch(/inherited from Mehta Family Investment Policy/);
    expect((await get(`/policy-versions/${v1}/diff`)).body).toEqual([]);
    expect((await send("PATCH", `/policy-versions/${v1}`, { constraints: { liquidity_months: 6 } })).code).toBe(409); // active versions are immutable
  });
  it("amends through a new draft whose diff lists only the changed clauses, then supersedes v1 on activation", async () => {
    const d = await send("POST", `/policies/${policyId}/versions`, { change_summary: "tighten drawdown" }); expect(d.code).toBe(201); v2 = d.body.id; expect(d.body.version).toBe(2); expect(d.body.status).toBe("draft");
    expect((await send("POST", `/policies/${policyId}/versions`)).code).toBe(409); // one open draft at a time
    await send("PATCH", `/policy-versions/${v2}`, { risk_limits: [{ metric: "max_drawdown", operator: ">=", limit_value: -10, warn_value: -8 }], constraints: { liquidity_months: 3 } });
    const diff = (await get(`/policy-versions/${v2}/diff`)).body;
    expect(diff.map((x: any) => `${x.section}.${x.key}`).sort()).toEqual(["constraints.liquidity_months", "risk_limit.max_drawdown"]); expect(diff.find((x: any) => x.section === "risk_limit")).toMatchObject({ before: { limit_value: -15 }, after: { limit_value: -10 } });
    await send("POST", `/policy-versions/${v2}/sign`, { auth_method: "biometric", auth_proof: "000000" });
    const act = await send("POST", `/policy-versions/${v2}/status`, { status: "active", effective_from: "2026-11-01" }); expect(act.code).toBe(200); expect(act.body.previous_version_id).toBe(v1);
    const versions = (await get(`/policies/${policyId}/versions`)).body; expect(versions.find((v: any) => v.id === v1)).toMatchObject({ status: "superseded", effective_to: "2026-10-31" }); expect(versions.find((v: any) => v.id === v2).status).toBe("active");
    await withFamily(FAMILY, async (c) => { expect((await c.query("select count(*) n from glide_paths where goal_id=$1", [GOAL_HOME])).rows[0].n).toBe("1"); });
    expect((await send("DELETE", `/policies/${P_FAMILY}`)).code).toBe(409); // children inherit it
    expect((await send("DELETE", `/policies/${policyId}`)).code).toBe(204);
  });
  it("activating a family amendment rewrites the live targets, IPS rules and execution guardrails atomically", async () => {
    const d = (await send("POST", `/policies/${P_FAMILY}/versions`, { change_summary: "equity 30 → 32; cap 4 L" })).body; expect(d.version).toBe(4);
    const allocations = d.allocations.map((a: any) => (a.key === "equity" ? { ...a, target_pct: 32 } : a.key === "alternatives" ? { ...a, target_pct: 53 } : a));
    const guardrails = { ...d.guardrails, execution_policies: [{ code: "max_single_amount", params: { amount: 400000 } }, { code: "approvers_required", params: { count: 2, above: 2500000 } }] };
    expect((await send("PATCH", `/policy-versions/${d.id}`, { allocations, guardrails, ips_rules: [{ code: "max_single_issuer", params: { pct: 12 } }] })).code).toBe(200);
    await send("POST", `/policy-versions/${d.id}/sign`, { auth_method: "totp", auth_proof: "000000" });
    const act = await send("POST", `/policy-versions/${d.id}/status`, { status: "active", effective_from: "2026-10-01" }); expect(act.code).toBe(200);
    await withFamily(FAMILY, async (c) => {
      const t = (await c.query("select alloc_class, target_pct from asset_class_targets where family_id=$1 and entity_id is null and policy_version_id=$2 order by alloc_class", [FAMILY, d.id])).rows; expect(t.find((x) => x.alloc_class === "equity").target_pct).toBe("32.00"); expect(t.length).toBe(4);
      expect((await c.query("select count(*) n from asset_class_targets where policy_version_id=$1", [V_FAM3])).rows[0].n).toBe("0");
      expect((await c.query("select params from execution_policies where active and code='max_single_amount' and policy_version_id=$1", [d.id])).rows[0].params.amount).toBe(400000);
      expect((await c.query("select count(*) n from execution_policies where active and policy_version_id=$1", [V_FAM3])).rows[0].n).toBe("0");
      expect((await c.query("select params from ips_rules where active and policy_version_id=$1", [d.id])).rows[0].params.pct).toBe(12); expect((await c.query("select count(*) n from ips_rules where active and policy_version_id=$1", [V_FAM3])).rows[0].n).toBe("0");
      expect((await c.query("select status, effective_to from policy_versions where id=$1", [V_FAM3])).rows[0]).toMatchObject({ status: "superseded" });
    });
    // the live guardrail now binds the action plane: ₹4.5 L fails the single-amount cap that used to be ₹5 L
    const intent = (await send("POST", "/actions", { entity_id: ARJUN, kind: "bank_transfer", amount: 450000, payload: { note: "test" }, rationale: "cap check" })).body;
    expect(intent.status).toBe("policy_failed"); expect(intent.policy_result.find((x: any) => x.code === "max_single_amount").pass).toBe(false);
  });
});

describe("action plane consults the effective policy (FO-144)", () => {
  it("refuses a prohibited instrument and a buy that worsens a band breach, citing the clause; a permitted buy passes", async () => {
    const bad = (await send("POST", "/actions", { entity_id: ARJUN, kind: "equity_order", amount: 5000, payload: { instrument_type: "f&o", name: "NIFTY 24000 CE" }, rationale: "punt" })).body;
    expect(bad.status).toBe("policy_failed"); const pc = bad.policy_result.find((x: any) => x.code === "investment_policy"); expect(pc.pass).toBe(false); expect(pc.clause).toBe("permitted.prohibited"); expect(pc.policy).toBe("Mehta Family Investment Policy");
    const band = (await send("POST", "/actions", { entity_id: HUF, kind: "mf_purchase", amount: 40000, payload: { instrument_id: PPFAS }, rationale: "top up" })).body;
    expect(band.status).toBe("policy_failed"); const bc = band.policy_result.find((x: any) => x.code === "investment_policy"); expect(bc.clause).toBe("allocation.asset_class:equity"); expect(bc.policy).toBe("Mehta HUF"); expect(bc.detail).toMatch(/above the 20% band/);
    const ok = (await send("POST", "/actions", { entity_id: ARJUN, kind: "mf_purchase", amount: 7000, payload: { instrument_id: LIQUID }, rationale: "park cash" })).body;
    expect(ok.status).toBe("pending_approval"); expect(ok.policy_result.find((x: any) => x.code === "investment_policy").pass).toBe(true);
  });
});

describe("risk metrics and reviews (FO-143, FO-145)", () => {
  it("computes series metrics once month-end valuations exist and feeds the risk-limit checks", async () => {
    const vals = [100, 103, 99.5, 101, 106, 104.5, 105.5, 99.5, 102.5, 104.4, 102.1, 104.9, 106.05];
    await withFamily(FAMILY, async (c) => { for (let i = 0; i < vals.length; i++) { const d = new Date(Date.UTC(2025, 8 + i, 28)).toISOString().slice(0, 10); await c.query("insert into valuations_daily (family_id, scope_type, scope_id, as_of, value, net_flow) values ($1,'family',$1,$2,$3,0) on conflict do nothing", [FAMILY, d, vals[i] * 5000]); } });
    const m = (await get(`/risk-metrics?scope_type=family&as_of=2026-09-28`)).body;
    expect(m.periods).toBe(12); expect(m.metrics.volatility_1y).toBeCloseTo(10.72, 1); expect(m.metrics.max_drawdown).toBeCloseTo(-6.13, 1); expect(m.metrics.var_95_1m).toBeCloseTo(4.43, 1); // reference values computed independently from the same month-end series expect(m.metrics.beta).toBeUndefined(); // no benchmark prices loaded
    expect(m.history.volatility_1y.length).toBeGreaterThanOrEqual(1);
    const fam = (await send("POST", `/policies/${P_FAMILY}/compliance`, { as_of: "2026-09-28" })).body; const vol = fam.checks.find((x: any) => x.key === "volatility_1y"); expect(vol.status).toBe("in_band"); expect(vol.actual).toBe("10.72%");
    expect(["in_band", "warning", "breach"]).toContain(fam.checks.find((x: any) => x.key === "beta").status);   // db/022 seeds a monthly NIFTY50 history, so beta is computable
  });
  it("schedules a review 30 days ahead, opens a trigger review for a breach persisting 30 days with pre-filled findings, and records outcomes", async () => {
    const none = (await send("POST", "/policy-reviews/run", { today: "2026-10-01" })).body; expect(none.rows).toBe(0); // retirement's quarterly review is already seeded as due
    await withFamily(FAMILY, async (c) => { for (let d = 40; d >= 0; d -= 5) await c.query("insert into policy_compliance (family_id, policy_version_id, as_of, overall, checks, breaches, warnings) values ($1,$2,current_date - $3::int,'breach','[{\"kind\":\"allocation\",\"key\":\"asset_class:equity\",\"target\":\"45% (35–55)\",\"actual\":\"67%\",\"status\":\"breach\"}]',1,0) on conflict (policy_version_id, as_of) do update set overall='breach'", [FAMILY, V_RET1, d]); });
    const run = (await send("POST", "/policy-reviews/run", {})).body; const trig = run.reviews.find((r: any) => r.policy_id === P_RET && r.trigger_reason === "breach_persisting");
    expect(trig).toBeTruthy(); expect(trig.findings.compliance_history.length).toBeGreaterThanOrEqual(8); expect(trig.findings.drift[0].key).toBe("asset_class:equity"); expect(trig.findings.goal_progress.name).toBe("Retirement income floor"); expect(trig.findings.summary).toMatch(/snapshots compliant/);
    const task = (await get("/tasks?status=open&module=policy")).body.find((t: any) => t.source_id === trig.id); expect(task.title).toMatch(/breach persisting 30 days/);
    expect((await send("POST", "/policy-reviews/run", {})).body.reviews.some((r: any) => r.trigger_reason === "breach_persisting" && r.policy_id === P_RET)).toBe(false); // no duplicate while open
    const mba = (await send("POST", "/policy-reviews/run", { today: "2027-02-10" })).body.reviews.find((r: any) => r.policy_id === P_MBA); expect(mba).toMatchObject({ kind: "scheduled", due_on: "2027-02-28" });
    // amended → a draft is opened and linked; the task closes
    const done = (await send("PATCH", `/policy-reviews/${trig.id}`, { outcome: "amended", note: "widen the equity band while the AIF is drawn down" })).body;
    expect(done.status).toBe("completed"); expect(done.resulting_version_id).toBeTruthy(); expect((await get(`/policy-versions/${done.resulting_version_id}`)).body).toMatchObject({ status: "draft", version: 2 });
    expect((await get("/tasks?status=done&module=policy")).body.some((t: any) => t.source_id === trig.id)).toBe(true);
    const nc = (await send("PATCH", `/policy-reviews/${mba.id}`, { outcome: "no_change" })).body; expect(nc.outcome).toBe("no_change");
    expect((await get(`/policies/${P_MBA}`)).body.next_review_on > "2027-02-28").toBe(true);
    const adhoc = await send("POST", `/policies/${P_HUF}/reviews`, { kind: "ad_hoc", note: "CA asked" }); expect(adhoc.code).toBe(201); expect(adhoc.body.findings.summary).toBeTruthy();
    expect((await get("/policy-reviews")).body.some((r: any) => r.id === adhoc.body.id && r.policy_name === "Mehta HUF")).toBe(true);
  });
});
