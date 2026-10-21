import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { buildApp } from "../src/server.js";
import { withFamily } from "../src/lib/db.js";
import { extractHeuristic, catalogue } from "../src/lib/research.js";

// Runs against the seeded week (db/022). Re-runnable: everything created here is removed in teardown and the seeded
// recommendations, item statuses and trust scores are put back exactly as the seed left them.
const FAMILY = "11111111-1111-1111-1111-111111111111", ARJUN = "33333333-0000-0000-0000-000000000001", HUF = "33333333-0000-0000-0000-000000000002";
const LT = "44444444-0000-0000-0000-000000000010", HDFC = "44444444-0000-0000-0000-000000000001", ARB = "44444444-0000-0000-0000-000000000009";
const EMAIL_CHANNEL = "a2000000-0000-0000-0000-000000000001", KOTAK = "a1000000-0000-0000-0000-000000000004";
const S = (f: string) => readFileSync(new URL(`../../../../samples/${f}`, import.meta.url), "utf8");
let app: ReturnType<typeof buildApp>; let owner = "", member = "", operator = "", viewer = "";
const h = (t = owner) => ({ authorization: `Bearer ${t}`, "x-family-id": FAMILY });
const get = async (url: string, t = owner) => { const r = await app.inject({ url: `/api/v1${url}`, headers: h(t) }); return { code: r.statusCode, body: r.headers["content-type"]?.toString().includes("json") ? r.json() : r.body }; };
const send = async (method: "POST" | "PATCH" | "PUT" | "DELETE", url: string, payload: any = {}, t = owner) => { const r = await app.inject({ method, url: `/api/v1${url}`, headers: h(t), payload }); return { code: r.statusCode, body: r.statusCode === 204 ? null : r.json() }; };
const TABLES = ["research_items", "research_recommendations", "recommendation_clusters", "recommendation_assessments", "investment_proposals", "research_digests", "research_sources", "research_channels", "action_intents", "tasks", "notifications", "agent_sessions"];
const before: Record<string, string[]> = {}; let recsBefore: any[] = [], itemsBefore: any[] = [], sourcesBefore: any[] = [];
const clusters = async (q = "") => (await get(`/research/clusters${q}`)).body as any[];
const clusterFor = async (instrumentId: string, direction: string) => (await clusters()).find((k) => k.instrument_id === instrumentId && k.direction === direction);

beforeAll(async () => {
  app = buildApp(); await app.ready();
  const login = async (email: string) => (await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password: "Prototype!2026" } })).json().access_token;
  owner = await login("arjun@example.com"); member = await login("priya@example.com"); operator = await login("ops@example.com"); viewer = await login("ca@example.com");
  await withFamily(FAMILY, async (c) => {
    for (const t of TABLES) before[t] = (await c.query(`select id::text k from ${t}`)).rows.map((r) => r.k);
    recsBefore = (await c.query("select id, status, cluster_id, instrument_id, source_id, review_note from research_recommendations")).rows;
    itemsBefore = (await c.query("select id, status, source_id, triage_note from research_items")).rows;
    sourcesBefore = (await c.query("select id, trust_score, trust_history from research_sources")).rows;
  });
});
afterAll(async () => {
  await withFamily(FAMILY, async (c) => {
    await c.query("delete from action_approvals where intent_id in (select id from action_intents where id::text <> all($1::text[]))", [before.action_intents]);
    for (const t of ["action_intents", "tasks", "notifications"]) await c.query(`delete from ${t} where id::text <> all($1::text[])`, [before[t]]);
    await c.query("update investment_proposals set digest_id=null where digest_id in (select id from research_digests where id::text <> all($1::text[]))", [before.research_digests]);
    for (const t of ["research_digests", "investment_proposals", "recommendation_assessments"]) await c.query(`delete from ${t} where id::text <> all($1::text[])`, [before[t]]);
    await c.query("update research_recommendations set cluster_id=null where cluster_id in (select id from recommendation_clusters where id::text <> all($1::text[]))", [before.recommendation_clusters]);
    await c.query("delete from recommendation_clusters where id::text <> all($1::text[])", [before.recommendation_clusters]);
    await c.query("delete from research_recommendations where id::text <> all($1::text[])", [before.research_recommendations]);
    await c.query("delete from research_items where id::text <> all($1::text[])", [before.research_items]);
    for (const t of ["research_channels", "research_sources", "agent_sessions"]) await c.query(`delete from ${t} where id::text <> all($1::text[])`, [before[t]]);
    for (const r of recsBefore) await c.query("update research_recommendations set status=$2, cluster_id=$3, instrument_id=$4, source_id=$5, review_note=$6 where id=$1", [r.id, r.status, r.cluster_id, r.instrument_id, r.source_id, r.review_note]);
    for (const i of itemsBefore) await c.query("update research_items set status=$2, source_id=$3, triage_note=$4 where id=$1", [i.id, i.status, i.source_id, i.triage_note]);
    for (const s of sourcesBefore) await c.query("update research_sources set trust_score=$2, trust_history=$3 where id=$1", [s.id, s.trust_score, JSON.stringify(s.trust_history)]);
  });
  await app.close();
});

describe("ingestion and extraction (FO-150, FO-151)", () => {
  it("the sample broker note yields six recommendations at ≥ 0.85 confidence; unresolved instruments stay as text and are flagged", async () => {
    const cat = await withFamily(FAMILY, (c) => catalogue(c));
    const recs = extractHeuristic(S("research_kotak_morning_note.txt"), cat, "2026-09-08");
    expect(recs.length).toBe(6); expect(recs.every((r) => r.confidence >= 0.85)).toBe(true); expect(recs.every((r) => r.published_on === "2026-09-08")).toBe(true);
    const lt = recs.find((r) => r.instrument_id === LT)!; expect(lt).toMatchObject({ action: "buy", target_price: 4150, stop_loss: 3350, horizon_months: 12, conviction: "high" }); expect(lt.thesis).toMatch(/Order inflow/);
    expect(recs.find((r) => r.instrument_text === "Bajaj Finance")).toMatchObject({ instrument_id: null, flags: ["instrument_unresolved"] });
    expect(recs.find((r) => r.instrument_id === HDFC)!.action).toBe("reduce");
  });
  it("same content twice is one item; an allow-listed sender is attributed to its source; an unknown sender lands in triage", async () => {
    const text = S("research_kotak_morning_note.txt").replace("Date: 2026-09-08", "Date: 2026-09-11") + "\n(re-sent copy)";
    const a = await send("POST", "/research/items", { body_text: text, title: "Kotak morning note (copy)", channel_id: EMAIL_CHANNEL, sender: "morningnote@kotaksecurities.example" }, operator);
    expect(a.code).toBe(202); expect(a.body.duplicate).toBe(false); expect(a.body.recommendation_count).toBe(6); expect(a.body.review_count).toBe(0); expect(a.body.source_name).toBe("Kotak Securities");
    const b = await send("POST", "/research/items", { body_text: text, title: "Kotak again" }, operator); expect(b.body.duplicate).toBe(true); expect(b.body.id).toBe(a.body.id);
    const listed = (await get("/research/items")).body.items; expect(listed.filter((i: any) => i.id === a.body.id).length).toBe(1);
    const inbound = await send("POST", `/research/channels/${EMAIL_CHANNEL}/inbound`, { sender: "research@motilaloswal.example", subject: "MOSL — Auto sector update", text: "Auto sector update\nDate: 2026-09-12\nBUY | Tata Motors (TATAMOTORS) | CMP 990 | TP 1,200 | SL 900 | 12M | High\nCV upcycle intact." });
    expect(inbound.code).toBe(202); expect(inbound.body.source_name).toBe("Motilal Oswal"); expect(inbound.body.channel_kind).toBe("email"); expect(inbound.body.recommendations[0]).toMatchObject({ action: "buy", instrument_id: "44444444-0000-0000-0000-000000000011" });
    const stranger = await send("POST", `/research/channels/${EMAIL_CHANNEL}/inbound`, { sender: "tips@unknown-newsletter.example", subject: "Hot pick", text: "Hot pick of the week\nDate: 2026-09-12\nBUY | Tata Consultancy Services (TCS) | CMP 3,790 | TP 4,200 | 12M | Medium\nDeal wins recovering." });
    expect(stranger.body.source_id).toBeNull(); expect(stranger.body.triage_note).toMatch(/unattributed/);
    const fixed = await send("PATCH", `/research/items/${stranger.body.id}`, { source_id: KOTAK }); expect(fixed.body.source_name).toBe("Kotak Securities"); expect(fixed.body.triage_note).toBeNull();
    expect((await send("POST", "/research/items", { body_text: "too short" })).code).toBeGreaterThanOrEqual(400);
    expect((await send("POST", "/research/items", { body_text: text }, viewer)).code).toBe(403);
  });
  it("a correction persists: resolving the unresolved instrument keeps the call and re-prices it at the publish date", async () => {
    const recs = (await get("/research/recommendations?status=extracted&limit=500")).body.items; const bajaj = recs.find((r: any) => r.instrument_text === "Bajaj Finance" && r.review_note?.includes("instrument_unresolved"));
    expect(bajaj).toBeTruthy(); expect(bajaj.instrument_id).toBeNull();
    const fixed = await send("PATCH", `/research/recommendations/${bajaj.id}`, { instrument_id: HDFC, review_note: "test: mapped to HDFC Bank" }, operator);
    expect(fixed.code).toBe(200); expect(fixed.body).toMatchObject({ instrument_id: HDFC, instrument_name: "HDFC Bank", confidence: 1 }); expect(fixed.body.price_at_publish).toBeGreaterThan(0);
    expect((await get("/research/recommendations?instrument_id=" + HDFC)).body.items.some((r: any) => r.id === bajaj.id)).toBe(true);
    await send("PATCH", `/research/recommendations/${bajaj.id}`, { instrument_id: null, instrument_text: "Bajaj Finance" }, operator);   // put it back for the clustering assertions
  });
});

describe("clustering, consensus and policy fit (FO-152, FO-153)", () => {
  it("clusters the seeded week: three bullish L&T calls are one '3 of 3' cluster; a later sell from one source supersedes its buy and flips the consensus", async () => {
    const run = await send("POST", "/research/run", {}, operator); expect(run.code).toBe(202); expect(run.body.clusters.created + run.body.clusters.updated).toBeGreaterThanOrEqual(5);
    const lt = await clusterFor(LT, "bullish"); expect(lt).toBeTruthy(); expect(lt.source_count).toBe(3); expect(lt.consensus).toMatch(/^3 of 3 sources bullish/);
    expect([...new Set(lt.calls.map((x: any) => x.source))].sort()).toEqual(["Kotak Securities", "Marcellus", "Motilal Oswal"]); expect(lt.weighted_conviction).toBeGreaterThan(60);
    const flip = await send("POST", "/research/items", { body_text: "Dalal Street Morning Note\nDate: 2026-09-12\nSELL | Larsen & Toubro (LT) | CMP 3,720 | TP 3,300 | SL 3,900 | 6M | Medium\nWe reverse our call: order inflow guidance withdrawn.", title: "Kotak — L&T downgrade", sender: "morningnote@kotaksecurities.example", channel_id: EMAIL_CHANNEL });
    expect(flip.body.source_name).toBe("Kotak Securities");
    const run2 = await send("POST", "/research/run", {}, operator); expect(run2.body.clusters.superseded).toBeGreaterThanOrEqual(1);
    const lt2 = await clusterFor(LT, "bullish"); expect(lt2.source_count).toBe(2); expect(lt2.consensus).toMatch(/^2 of 3 sources bullish/); expect(lt2.consensus).toMatch(/Kotak Securities sell/);
    const bear = await clusterFor(LT, "bearish"); expect(bear).toBeTruthy(); expect(bear.source_count).toBe(1);
    const superseded = (await get("/research/recommendations?status=superseded&instrument_id=" + LT)).body.items; expect(superseded.some((r: any) => r.source_name === "Kotak Securities" && r.action === "buy")).toBe(true);
  });
  it("verdicts reproduce the prototype on the seed: fits / fits with conditions / prohibited with the clause / conflicts on a held position (surfaced)", async () => {
    for (const k of await clusters()) await send("POST", `/research/clusters/${k.id}/assess`, {}, operator);   // fresh assessments regardless of what an earlier run left behind
    const all = await clusters("?include_archive=1"); expect(all.map((k) => `${k.instrument_text}|${k.direction}|${k.status}|${k.instrument_id}`)).toEqual(expect.arrayContaining(["XYZ Small Cap Infra Ltd|bullish|dismissed|null", `Kotak Equity Arbitrage Fund - Direct Growth|bullish|assessed|${ARB}`]));
    const arb = all.find((k) => k.instrument_id === ARB); expect(arb.verdict).toBe("fits"); expect(arb.status).toBe("assessed"); expect(arb.fit_score).toBeGreaterThanOrEqual(85);
    const lt = all.find((k) => k.instrument_id === LT && k.direction === "bullish"); expect(lt.verdict).toBe("fits_with_conditions"); expect(lt.checks.some((c: any) => c.clause === "sources.conflicts" && c.status === "warning")).toBe(true); expect(lt.checks.find((c: any) => c.clause === "permitted.instrument_types").status).toBe("pass");
    const xyz = all.find((k) => /XYZ Small Cap/.test(k.instrument_text)); expect(xyz.verdict).toBe("prohibited"); expect(xyz.status).toBe("dismissed"); expect(xyz.dismissed_reason).toMatch(/prohibited: small-cap single stocks are prohibited/); expect(xyz.checks.some((c: any) => c.clause === "conduct" && /non-public/.test(c.detail))).toBe(true); expect(xyz.checks.some((c: any) => c.clause === "sources.independent_thesis")).toBe(true);
    const hdfc = all.find((k) => k.instrument_id === HDFC && k.direction === "bearish"); expect(hdfc.verdict).toBe("conflicts"); expect(hdfc.status).toBe("assessed"); expect(hdfc.already_held).toMatchObject({ entity_id: ARJUN, surface: true }); expect(hdfc.checks.some((c: any) => c.clause === "constraints.tax.ltcg_first" && c.status === "fail")).toBe(true); expect(Number(hdfc.sizing.tax.stcg)).toBeGreaterThan(0);
    const rel = all.find((k) => /Reliance/.test(k.instrument_text)); expect(rel.verdict).toBe("insufficient_info"); expect(rel.status).toBe("dismissed"); expect(rel.dismissed_reason).toMatch(/not in the instruments master/);
  });
  it("sizing equals the smallest headroom (issuer cap, band, liquidity floor, cash above float); an entity override re-assesses; dismiss and restore are reversible", async () => {
    const lt = await clusterFor(LT, "bullish"); const s = lt.sizing;
    const cands = [s.issuer_headroom, s.manager_headroom, s.sector_headroom, s.liquidity_headroom, s.cash_available, s.band_headroom > 0 ? s.band_headroom : null].filter((v) => v != null) as number[];
    expect(s.suggested).toBe(Math.floor(Math.min(...cands) / 100) * 100); expect(s.max_by_policy).toBeGreaterThanOrEqual(s.suggested); expect(s.entity_id).toBe(HUF);   // the HUF holds the most deployable cash
    const a = await send("POST", `/research/clusters/${lt.id}/assess`, { entity_id: ARJUN }, operator); expect(a.code).toBe(200); expect(a.body.entity_id).toBe(ARJUN); expect(["fits", "fits_with_conditions"]).toContain(a.body.verdict); expect(a.body.sizing.suggested).toBeGreaterThan(0);
    expect((await get(`/research/clusters/${lt.id}`)).body.assessment.entity_id).toBe(ARJUN);
    const d = await send("POST", `/research/clusters/${lt.id}/dismiss`, { reason: "not now" }); expect(d.body.status).toBe("dismissed"); expect(d.body.dismissed_reason).toBe("not now");
    const r = await send("POST", `/research/clusters/${lt.id}/restore`, {}); expect(r.code).toBe(200); expect((await get(`/research/clusters/${lt.id}`)).body.status).toBe("assessed");
    expect((await send("POST", `/research/clusters/${lt.id}/assess`, {}, viewer)).code).toBe(403);
  });
});

describe("proposals, decisions and digests (FO-154, FO-155, FO-156)", () => {
  let ltProposal: any, arbProposal: any, tmProposal: any, digest: any;
  it("drafts a proposal with every section and cited numbers; a prohibited cluster is refused; a memo without a counter-view fails validation; the memo renders", async () => {
    const lt = await clusterFor(LT, "bullish");
    const r = await send("POST", "/research/proposals", { cluster_id: lt.id, entity_id: HUF }, member); expect(r.code).toBe(202); ltProposal = r.body.proposal;
    expect(ltProposal.status).toBe("in_review"); expect(ltProposal.amount).toBeGreaterThan(0); expect(ltProposal.title).toMatch(/Add Larsen & Toubro/);
    const s = ltProposal.sections; for (const k of ["summary", "thesis", "sources", "counter_view", "policy_fit", "portfolio_impact", "tax_impact", "risks", "sizing", "execution_plan", "exit_plan", "monitoring", "citations", "disclaimer"]) expect(s[k], k).toBeTruthy();
    expect(s.sources.length).toBeGreaterThanOrEqual(2); expect(new Set(s.sources.map((x: any) => x.name)).size).toBe(s.sources.length); expect(s.sources.every((x: any) => x.track_record_12m == null || typeof x.track_record_12m.hit_rate_pct === "number")).toBe(true); expect(s.sources.some((x: any) => /brokerage|PMS/.test(x.conflict_of_interest))).toBe(true);
    expect(s.counter_view).toMatch(/Kotak Securities: sell|Bear case/); expect(s.policy_fit.checks.length).toBeGreaterThan(3); expect(s.exit_plan.target_price).toBe(4300); expect(s.exit_plan.horizon_months).toBe(24);
    expect(s.execution_plan.reduce((a: number, t: any) => a + t.amount, 0)).toBeCloseTo(ltProposal.amount, 2); expect(s.execution_plan[0].kind).toBe("equity_order"); expect(s.citations.some((c: any) => c.tool === "policy.effective")).toBe(true);
    expect(s.portfolio_impact.asset_class.after_pct).toBeGreaterThan(s.portfolio_impact.asset_class.before_pct); expect(s.disclaimer).toMatch(/not investment advice/);
    const xyz = (await clusters()).find((k) => /XYZ Small Cap/.test(k.instrument_text)); const bad = await send("POST", "/research/proposals", { cluster_id: xyz.id }); expect(bad.code).toBe(422); expect(bad.body.verdict).toBe("prohibited");
    const noCounter = await send("PATCH", `/research/proposals/${ltProposal.id}`, { sections: { counter_view: "" } }); expect(noCounter.code).toBe(422); expect(noCounter.body.errors.join()).toMatch(/counter_view/);
    const edited = await send("PATCH", `/research/proposals/${ltProposal.id}`, { amount: 3000 }); expect(edited.body.version).toBe(2); expect(edited.body.amount).toBe(3000); expect(edited.body.title).toMatch(/₹3,000/);
    const doc = await send("POST", `/research/proposals/${ltProposal.id}/document`, {}); expect(doc.code).toBe(202); const html = await get(doc.body.document_url.replace("/api/v1", "")); expect(html.code).toBe(200); expect(String(html.body)).toContain("Counter-view"); expect(String(html.body)).toContain("Larsen");
    const arb = (await clusters()).find((k) => k.instrument_id === ARB); const arbR = await send("POST", "/research/proposals", { cluster_id: arb.id }); expect(arbR.code, JSON.stringify(arbR.body)).toBe(202); arbProposal = arbR.body.proposal; expect(arbProposal.sections.execution_plan[0].kind).toBe("mf_purchase");
    const tm = await clusterFor("44444444-0000-0000-0000-000000000011", "bullish"); tmProposal = (await send("POST", "/research/proposals", { cluster_id: tm.id })).body.proposal; expect(tmProposal.status).toBe("in_review");
    expect((await get("/research/proposals?status=in_review")).body.length).toBeGreaterThanOrEqual(3);
  });
  it("approve with a reduced amount and convert creates two intents in pending_approval; operators and viewers cannot decide; illegal transitions are 409", async () => {
    expect((await send("POST", `/research/proposals/${ltProposal.id}/decide`, { decision: "approve" }, operator)).code).toBe(403);
    expect((await send("POST", `/research/proposals/${ltProposal.id}/decide`, { decision: "approve" }, viewer)).code).toBe(403);
    const ok = await send("POST", `/research/proposals/${ltProposal.id}/decide`, { decision: "approve", convert: true, amount_override: 2500, note: "smaller, staged" }, member);
    expect(ok.code).toBe(200); expect(ok.body.status).toBe("converted"); expect(ok.body.amount).toBe(2500); expect(ok.body.intent_batch_id).toBeTruthy(); expect(ok.body.decided_by_name).toBe("Priya Mehta");
    expect(ok.body.intents.length).toBe(2); expect(ok.body.intents.every((i: any) => i.status === "pending_approval" && i.kind === "equity_order")).toBe(true); expect(ok.body.intents.reduce((a: number, i: any) => a + Number(i.amount), 0)).toBeCloseTo(2500, 2);
    const inbox = (await get("/actions?status=pending_approval")).body.items; expect(inbox.filter((i: any) => i.batch_id === ok.body.intent_batch_id).length).toBe(2); expect(inbox.find((i: any) => i.batch_id === ok.body.intent_batch_id).source_type).toBe("investment_proposal");
    expect((await send("POST", `/research/proposals/${ltProposal.id}/decide`, { decision: "approve" })).code).toBe(409);
    const def = await send("POST", `/research/proposals/${tmProposal.id}/decide`, { decision: "defer", defer_until: "2026-09-10", note: "bear case first" }); expect(def.body.status).toBe("deferred"); expect(def.body.defer_until).toBe("2026-09-10");
  });
  it("the digest lists what arrived, every declined cluster with its reason, deferred proposals that are due again, and notifies; one step-up decides the batch", async () => {
    const r = await send("POST", "/research/digests", { period_start: "2026-09-05", period_end: "2026-09-12" }, operator); expect(r.code).toBe(202); digest = r.body.digest;
    const s = digest.summary; expect(s.items).toBeGreaterThanOrEqual(6); expect(s.recommendations).toBeGreaterThanOrEqual(14); expect(s.clusters).toBeGreaterThanOrEqual(5);
    expect(s.dismissed.some((d: any) => /XYZ/.test(d.instrument) && /prohibited/.test(d.reason))).toBe(true); expect(s.dismissed.some((d: any) => /Reliance/.test(d.instrument) && /insufficient_info/.test(d.reason))).toBe(true); expect(s.declined_count).toBe(s.dismissed.length);
    expect(digest.proposals.map((p: any) => p.id)).toEqual(expect.arrayContaining([arbProposal.id, tmProposal.id])); expect(digest.proposals.some((p: any) => p.id === ltProposal.id)).toBe(false);
    expect(s.awaiting).toBeGreaterThanOrEqual(1); expect(s.deferred).toBeGreaterThanOrEqual(1); expect(s.themes.length).toBeGreaterThan(0); expect(s.source_leaderboard.length).toBeGreaterThanOrEqual(5); expect(digest.sent_to).toEqual(expect.arrayContaining(["arjun@example.com", "priya@example.com"]));
    const doc = await get(`/research/digests/${digest.id}/document`); expect(doc.code).toBe(200); expect(String(doc.body)).toContain("Declined, with reasons");
    const task = (await get("/tasks?module=research")).body.find((t: any) => t.source_id === digest.id); expect(task).toBeTruthy(); expect(task.title).toMatch(/Research digest/);
    expect((await get("/notifications", member)).body.items.some((n: any) => /Research digest/.test(n.title ?? n.body ?? ""))).toBe(true);
    const badAuth = await send("POST", `/research/digests/${digest.id}/decide`, { decisions: [{ proposal_id: arbProposal.id, decision: "approve" }], auth_method: "totp", auth_proof: "123456" }); expect(badAuth.code).toBe(403);
    const batch = await send("POST", `/research/digests/${digest.id}/decide`, { decisions: [{ proposal_id: arbProposal.id, decision: "reject", note: "spreads narrowed" }, { proposal_id: tmProposal.id, decision: "approve", convert: false }], auth_method: "totp", auth_proof: "000000" });
    expect(batch.code).toBe(200); expect(batch.body.map((p: any) => p.status).sort()).toEqual(["approved", "rejected"]);
    expect((await get(`/research/digests/${digest.id}`)).body.status).toBe("actioned");
    expect((await clusters("?include_archive=1")).find((k) => k.instrument_id === ARB).dismissed_reason).toMatch(/rejected: spreads narrowed/);
    expect((await get("/research/digests")).body[0].id).toBe(digest.id);
  });
});

describe("track record and trust (FO-157)", () => {
  it("scores the 40-call archive at 3/6/12/24 months against price and benchmark within 1 pp of an independent recomputation; trust moves within ±5 and friends stay capped", async () => {
    const trustBefore = Object.fromEntries((await get("/research/sources")).body.map((s: any) => [s.id, s.trust_score]));
    const r = await send("POST", "/research/track-record/evaluate", { as_of: "2026-09-12" }, operator); expect(r.code).toBe(202); expect(r.body.rows).toBeGreaterThanOrEqual(100);
    const board = (await get("/research/track-record?horizon_months=12")).body; expect(board.length).toBeGreaterThanOrEqual(5);
    // reference sheet: straight SQL over the archive with the same definitions (return vs benchmark; bullish hit = excess > 0, bearish hit = excess < 0)
    const ref = await withFamily(FAMILY, async (c) => (await c.query(`with x as (
        select r.source_id, r.action, r.price_at_publish p0,
          (select close from prices p where p.instrument_id=r.instrument_id and p.price_date <= (r.published_on + interval '12 months')::date order by price_date desc limit 1) p1,
          (select value from benchmark_prices b join benchmarks k on k.id=b.benchmark_id where k.code=case when i.asset_class in ('debt_mf_post_apr23','listed_bond') then 'CRISIL_CBI' else 'NIFTY50' end and b.price_date <= r.published_on order by price_date desc limit 1) b0,
          (select value from benchmark_prices b join benchmarks k on k.id=b.benchmark_id where k.code=case when i.asset_class in ('debt_mf_post_apr23','listed_bond') then 'CRISIL_CBI' else 'NIFTY50' end and b.price_date <= (r.published_on + interval '12 months')::date order by price_date desc limit 1) b1
        from research_recommendations r join instruments i on i.id=r.instrument_id where r.id::text like 'a6%' and r.published_on + interval '12 months' <= date '2026-09-12')
      select s.name, count(*) n, round(avg(case when (case when action in ('buy','accumulate','subscribe') then (p1/p0-1)-(b1/b0-1) > 0 when action in ('sell','reduce','avoid','redeem') then (p1/p0-1)-(b1/b0-1) < 0 else (p1/p0-1)-(b1/b0-1) >= -0.03 end) then 100.0 else 0 end),1) hit_rate
      from x join research_sources s on s.id=x.source_id group by s.name`)).rows);
    for (const row of ref) { const b = board.find((x: any) => x.source === row.name); expect(b, row.name).toBeTruthy(); expect(b.n).toBeGreaterThanOrEqual(Number(row.n)); expect(Math.abs(b.hit_rate_pct - Number(row.hit_rate)), `${row.name} hit rate`).toBeLessThanOrEqual(1); expect(b.by_horizon["3"]).toBeTruthy(); }
    const kotak = board.find((x: any) => x.source === "Kotak Securities"); expect(kotak.conflict_of_interest).toBe("earns brokerage"); expect(kotak.best.excess_pct).toBeGreaterThanOrEqual(kotak.worst.excess_pct);
    const after = (await get("/research/sources")).body; for (const s of after) { expect(Math.abs(s.trust_score - trustBefore[s.id])).toBeLessThanOrEqual(5); if (s.kind === "friend") expect(s.trust_score).toBeLessThanOrEqual(40); }
    const ravi = (await get(`/research/sources/${after.find((s: any) => s.kind === "friend").id}`)).body; expect(ravi.track_record.n).toBeGreaterThanOrEqual(4);
  });
  it("sources, channels and settings: owners configure, others read; a friend starts at low trust", async () => {
    const src = await send("POST", "/research/sources", { kind: "friend", name: "Meera", notes: "gym" }, operator); expect(src.code).toBe(201); expect(src.body.trust_score).toBe(25);
    expect((await send("PATCH", `/research/sources/${src.body.id}`, { conflict_of_interest: "works at a broker" })).body.conflict_of_interest).toBe("works at a broker");
    const ch = await send("POST", "/research/channels", { kind: "rss", label: "Exchange announcements", config: { url: "https://example.invalid/feed.xml" } }); expect(ch.code).toBe(201);
    const em = await send("POST", "/research/channels", { kind: "email", label: "Second inbox" }); expect(em.body.config.address).toMatch(/@ingest/);
    expect((await get("/research/channels")).body.some((c: any) => c.id === ch.body.id)).toBe(true);
    expect((await send("PUT", "/research/settings", { digest_cadence: "monthly" }, operator)).code).toBe(403);
    expect((await send("PUT", "/research/settings", { digest_cadence: "fortnightly", decide_roles: ["owner"] })).body.digest_cadence).toBe("fortnightly");
    expect((await send("POST", `/research/proposals/${"00000000-0000-0000-0000-000000000000"}/decide`, { decision: "reject" }, member)).code).toBe(403);   // members no longer decide
    expect((await send("PUT", "/research/settings", { digest_cadence: "weekly", decide_roles: ["owner", "member"] })).body.decide_roles).toEqual(["owner", "member"]);
  });
});
