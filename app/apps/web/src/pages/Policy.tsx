import { useEffect, useState } from "react";
import { Plus, GitBranch, ScrollText, Play, Fingerprint, RefreshCw, CheckCircle2, AlertTriangle } from "lucide-react";
import { useApi } from "../lib/useApi";
import { api, inr, session, API_URL } from "../lib/api";
import { Card, Pill, Status, fmtDate } from "../components";

const TABS = ["Policies", "Builder", "Allocation & bands", "Risk & guardrails", "Compliance", "Reviews", "Document"] as const;
const STEPS = ["Scope & start", "Risk profile", "Objectives", "Allocation", "Risk limits", "Permitted", "Rebalancing & review", "Guardrails", "Simulate", "Approve & sign"];
const CLASSES = ["equity", "debt", "gold", "real_estate", "cash", "global", "alternatives"];
const METRICS = ["volatility_1y", "max_drawdown", "var_95_1m", "beta", "tracking_error", "sharpe_min", "concentration_top5", "issuer_max", "manager_max", "sector_max", "illiquid_max", "liquidity_coverage_months_min", "unrated_debt_max", "leverage_max", "fx_exposure_max", "duration_max"];
const TYPES = ["stock", "etf", "mf", "pms", "aif", "bond", "sgb", "gsec", "tbill", "fd", "rd", "nps", "ppf"];
const RULES = ["max_single_issuer", "max_single_manager", "max_sector_pct", "max_illiquid_pct", "max_unrated_pct", "min_credit_rating", "min_liquidity_months", "max_leverage_pct", "max_fx_pct", "max_duration"];
const tone = (s?: string | null) => s === "compliant" || s === "in_band" || s === "active" ? "teal" : s === "warning" || s === "in_review" || s === "due" ? "amber" : s === "breach" || s === "archived" ? "red" : s === "draft" || s === "in_progress" ? "blue" : undefined;
const label = (s: string) => s.replace(/_/g, " ");
const val = (v: any) => (v == null ? "—" : typeof v === "object" ? ("target_pct" in v ? `${v.target_pct}%${v.min_pct != null || v.max_pct != null ? ` (${v.min_pct ?? "—"}–${v.max_pct ?? "—"})` : ""}` : "limit_value" in v ? `${v.operator} ${v.limit_value}${v.warn_value != null ? ` · warn ${v.warn_value}` : ""}` : "params" in v ? Object.entries(v.params).map(([k, x]) => `${k} ${x}`).join(", ") : Array.isArray(v) ? v.map((x) => (typeof x === "object" && x ? Object.entries(x).map(([k, y]) => `${label(k)} ${typeof y === "object" && y ? Object.entries(y).map(([a, b]) => `${a} ${b}`).join(" ") : y}`).join(" · ") : x)).join("; ") : Object.entries(v).map(([k, x]) => `${label(k)}: ${Array.isArray(x) ? x.join(", ") : String(x)}`).join(" · ")) : String(v));
const inp = { background: "#fff", color: "var(--ink)", borderColor: "var(--line)" } as const;
function Field({ label: l, children }: { label: string; children: React.ReactNode }) { return <label className="field">{l}{children}</label>; }
const authHeaders = () => ({ authorization: `Bearer ${session.get()!.access_token}`, "x-family-id": session.family()! });

export function Policy() {
  const [tab, setTab] = useState<(typeof TABS)[number]>("Policies");
  const [sel, setSel] = useState<string | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const [tick, setTick] = useState(0); const bump = () => setTick((t) => t + 1);
  const list = useApi<any[]>("/policies", [tick]);
  const selectedId = sel ?? list.data?.find((p) => p.scope === "goal" && p.compliance?.overall === "breach")?.id ?? list.data?.[0]?.id ?? null;
  const open = (id: string, t: (typeof TABS)[number]) => { setSel(id); setTab(t); };
  return (<>
    <div className="tabs">{TABS.map((t) => <button key={t} className={tab === t ? "on" : ""} onClick={() => setTab(t)}>{t}</button>)}</div>
    {!list.data ? <Status loading={list.loading} error={list.error} /> : <>
      {tab === "Policies" && <Policies key={tick} list={list.data} selectedId={selectedId} onSelect={setSel} onChange={bump} onDraft={(id, vid) => { setSel(id); setDraft(vid); setTab("Builder"); }} onOpen={open} />}
      {tab === "Builder" && <Builder key={tick + (draft ?? "")} list={list.data} draftId={draft} setDraft={setDraft} onChange={bump} />}
      {tab === "Allocation & bands" && <Allocation key={tick} list={list.data} selectedId={selectedId} onSelect={setSel} />}
      {tab === "Risk & guardrails" && <Risk key={tick} list={list.data} selectedId={selectedId} onSelect={setSel} />}
      {tab === "Compliance" && <Compliance key={tick} list={list.data} selectedId={selectedId} onSelect={setSel} onChange={bump} />}
      {tab === "Reviews" && <Reviews key={tick} list={list.data} onChange={bump} onDraft={(id, vid) => { setSel(id); setDraft(vid); setTab("Builder"); }} />}
      {tab === "Document" && <Document key={tick} list={list.data} selectedId={selectedId} onSelect={setSel} />}
    </>}
  </>);
}

function Picker({ list, selectedId, onSelect, filter }: { list: any[]; selectedId: string | null; onSelect: (id: string) => void; filter?: (p: any) => boolean }) {
  return <select className="entity" style={{ ...inp, marginBottom: 12 }} value={selectedId ?? ""} onChange={(e) => onSelect(e.target.value)}>{list.filter(filter ?? (() => true)).map((p) => <option key={p.id} value={p.id}>{p.name} · {p.scope}{p.current_version ? ` · v${p.current_version.version}` : ""}</option>)}</select>;
}

function Policies({ list, selectedId, onSelect, onChange, onDraft, onOpen }: { list: any[]; selectedId: string | null; onSelect: (id: string) => void; onChange: () => void; onDraft: (id: string, vid: string) => void; onOpen: (id: string, t: (typeof TABS)[number]) => void }) {
  const d = useApi<any>(selectedId ? `/policies/${selectedId}` : null); const [err, setErr] = useState(""); const [busy, setBusy] = useState("");
  const [creating, setCreating] = useState(false);
  const amend = async () => { if (!selectedId) return; setBusy("amend"); setErr(""); try { const p = list.find((x) => x.id === selectedId); if (p.open_draft) return onDraft(selectedId, p.open_draft.id); const v = await api<any>(`/policies/${selectedId}/versions`, { method: "POST", body: JSON.stringify({ change_summary: "Amendment" }) }); onDraft(selectedId, v.id); } catch (e: any) { setErr(e.message); } finally { setBusy(""); } };
  const evaluate = async () => { if (!selectedId) return; setBusy("eval"); setErr(""); try { await api(`/policies/${selectedId}/compliance`, { method: "POST", body: "{}" }); onChange(); } catch (e: any) { setErr(e.message); } finally { setBusy(""); } };
  const p = d.data; const items: any[] = (p?.effective?.items ?? []).filter((i: any) => !/_id$/.test(i.key)); // ids are plumbing, not clauses
  return (<>
    {err && <div className="err">{err}</div>}
    {creating && <NewPolicy onClose={() => setCreating(false)} onCreated={(id, vid) => { setCreating(false); onDraft(id, vid); }} />}
    <div className="grid-2" style={{ gridTemplateColumns: "minmax(280px, 1fr) 2fr" }}>
      <Card title="Investment policies" action={<button className="btn btn-s btn-p" onClick={() => setCreating(true)}><Plus size={14} /> New policy</button>}>
        {list.map((x) => <div key={x.id} className="attn" style={{ cursor: "pointer", background: x.id === selectedId ? "var(--paper, #F5F6F8)" : undefined }} onClick={() => onSelect(x.id)}>
          <div style={{ flex: 1 }}><b>{x.name}</b><div className="small mute">{x.scope} · {x.current_version ? `v${x.current_version.version} · ${x.current_version.status}` : "no active version"}{x.current_version?.risk?.profile ? ` · ${label(x.current_version.risk.profile)}${x.current_version.risk.score ? ` (${Math.round(x.current_version.risk.score)})` : ""}` : ""}{x.parent_name ? ` · inherits ${x.parent_name.split(" ")[1] ?? "family"}` : ""}{x.open_draft ? ` · draft v${x.open_draft.version} ${x.open_draft.status.replace("_", " ")}` : ""}</div></div>
          <Pill tone={tone(x.compliance?.overall)}>{x.compliance?.overall ?? "—"}</Pill>
        </div>)}
        <div className="small mute" style={{ marginTop: 10 }}>Entity and goal policies inherit the family policy and override only what differs. Editing any target, band, rule or guardrail elsewhere creates a policy amendment.</div>
      </Card>
      {!p ? <Status loading={d.loading} error={d.error} /> : <Card title={`${p.name} — effective clauses${p.current_version ? ` (v${p.current_version.version})` : ""}`} action={<div className="row gap"><button className="btn btn-s" disabled={!!busy} onClick={amend}><GitBranch size={14} /> {p.open_draft ? `Open draft v${p.open_draft.version}` : "Amend (new draft)"}</button><button className="btn btn-s" onClick={() => onOpen(p.id, "Document")}><ScrollText size={14} /> IPS document</button><button className="btn btn-s" disabled={!!busy || !p.current_version} onClick={evaluate}><RefreshCw size={14} /> Evaluate now</button></div>}>
        <div className="row gap small mute" style={{ marginBottom: 8, flexWrap: "wrap" }}><span>Effective {fmtDate(p.current_version?.effective_from ?? null)}</span><span>·</span><span>Next review {fmtDate(p.next_review_on)} (every {p.review_every_months} months)</span><span>·</span><span>Signed: {(p.current_version?.signed_by ?? []).map((s: any) => s.name).join(", ") || "—"}</span>{p.compliance && <><span>·</span><span>Compliance {fmtDate(p.compliance.as_of)}: <Pill tone={tone(p.compliance.overall)}>{p.compliance.overall}</Pill> {p.compliance.breaches} breach · {p.compliance.warnings} warning</span></>}</div>
        {p.description && <div className="small" style={{ marginBottom: 8 }}>{p.description}</div>}
        {!p.current_version ? <div className="small mute">No active version yet — open the Builder to finish the draft.</div> : <div style={{ overflowX: "auto" }}><table className="tbl"><thead><tr><th>Section</th><th>Clause</th><th>{p.parent_name ? "Parent value" : ""}</th><th>This policy</th><th></th></tr></thead>
          <tbody>{items.map((c, i) => <tr key={i}><td className="mute">{label(c.section)}</td><td>{label(c.key)}</td><td className="small mute">{c.inherited ? "" : val(c.parent_value)}</td><td className="small"><b>{val(c.value)}</b></td><td>{c.inherited ? <Pill>inherited</Pill> : <Pill tone="blue">{p.parent_name ? "override" : "family"}</Pill>}</td></tr>)}</tbody></table></div>}
        {p.versions?.length > 1 && <div className="small mute" style={{ marginTop: 8 }}>History: {p.versions.map((v: any) => `v${v.version} ${v.status}${v.effective_from ? ` from ${fmtDate(v.effective_from)}` : ""}`).join(" · ")}</div>}
      </Card>}
    </div>
  </>);
}

function NewPolicy({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string, vid: string) => void }) {
  const ents = useApi<any[]>("/entities"); const goals = useApi<any[]>("/goals"); const responses = useApi<any[]>("/risk-questionnaire-responses");
  const [f, setF] = useState<any>({ scope: "goal", name: "", start_from: "risk_profile", review_every_months: 6, entity_id: "", goal_id: "", model_portfolio_id: "moderate", questionnaire_response_id: "" }); const [err, setErr] = useState("");
  const create = async () => { setErr(""); try { const body: any = { scope: f.scope, name: f.name || (f.scope === "family" ? "Family Investment Policy" : f.scope === "entity" ? ents.data?.find((e) => e.id === f.entity_id)?.name : goals.data?.find((g) => g.id === f.goal_id)?.name), start_from: f.start_from, review_every_months: Number(f.review_every_months) }; if (f.scope === "entity") body.entity_id = f.entity_id || ents.data?.[0]?.id; if (f.scope === "goal") body.goal_id = f.goal_id || goals.data?.[0]?.id; if (f.start_from === "model_portfolio") body.model_portfolio_id = f.model_portfolio_id; if (f.start_from === "risk_profile" && f.questionnaire_response_id) body.questionnaire_response_id = f.questionnaire_response_id; const p = await api<any>("/policies", { method: "POST", body: JSON.stringify(body) }); onCreated(p.id, p.draft_version_id); } catch (e: any) { setErr(e.message); } };
  return <div className="modal-bg" onClick={onClose}><div className="modal" onClick={(e) => e.stopPropagation()}><h3 style={{ margin: 0 }}>New policy — step 1 · scope & starting point</h3>
    {err && <div className="err">{err}</div>}
    <div className="grid-2">
      <Field label="Scope"><select style={inp} value={f.scope} onChange={(e) => setF({ ...f, scope: e.target.value })}>{["family", "entity", "goal"].map((s) => <option key={s}>{s}</option>)}</select></Field>
      {f.scope === "entity" && <Field label="Entity"><select style={inp} value={f.entity_id} onChange={(e) => setF({ ...f, entity_id: e.target.value })}>{(ents.data ?? []).map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}</select></Field>}
      {f.scope === "goal" && <Field label="Goal"><select style={inp} value={f.goal_id} onChange={(e) => setF({ ...f, goal_id: e.target.value })}>{(goals.data ?? []).map((g) => <option key={g.id} value={g.id}>{g.name} ({g.target_year})</option>)}</select></Field>}
      <Field label="Name"><input style={inp} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="defaults to the scope's name" /></Field>
      <Field label="Start from"><select style={inp} value={f.start_from} onChange={(e) => setF({ ...f, start_from: e.target.value })}><option value="risk_profile">risk questionnaire</option><option value="model_portfolio">model portfolio</option><option value="copy_parent">copy of parent</option><option value="blank">blank</option></select></Field>
      {f.start_from === "model_portfolio" && <Field label="Model"><select style={inp} value={f.model_portfolio_id} onChange={(e) => setF({ ...f, model_portfolio_id: e.target.value })}>{["conservative", "moderate", "aggressive", "growth_70_15_15", "multi_asset"].map((m) => <option key={m}>{m}</option>)}</select></Field>}
      {f.start_from === "risk_profile" && <Field label="Questionnaire response"><select style={inp} value={f.questionnaire_response_id} onChange={(e) => setF({ ...f, questionnaire_response_id: e.target.value })}><option value="">latest for this scope (or answer in step 2)</option>{(responses.data ?? []).map((r) => <option key={r.id} value={r.id}>{fmtDate(r.completed_at)} · {r.goal_name ?? r.entity_name ?? "family"} · {label(r.profile)} ({Math.round(r.score)})</option>)}</select></Field>}
      <Field label="Review every (months)"><input style={inp} type="number" value={f.review_every_months} onChange={(e) => setF({ ...f, review_every_months: e.target.value })} /></Field>
    </div>
    <div className="row gap" style={{ justifyContent: "flex-end", marginTop: 12 }}><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-p" onClick={create}>Create draft</button></div>
  </div></div>;
}

function Builder({ list, draftId, setDraft, onChange }: { list: any[]; draftId: string | null; setDraft: (id: string | null) => void; onChange: () => void }) {
  const drafts = list.filter((p) => p.open_draft);
  const vid = draftId ?? drafts[0]?.open_draft?.id ?? null;
  const v = useApi<any>(vid ? `/policy-versions/${vid}` : null);
  const [step, setStep] = useState(2); const [form, setForm] = useState<any | null>(null); const [err, setErr] = useState(""); const [busy, setBusy] = useState(""); const [sim, setSim] = useState<any | null>(null); const [proof, setProof] = useState("000000"); const [eff, setEff] = useState(new Date().toISOString().slice(0, 10)); const [creating, setCreating] = useState(false); const [savedAt, setSavedAt] = useState("");
  useEffect(() => { if (v.data && !form) { setForm({ objectives: v.data.objectives, risk: v.data.risk, constraints: v.data.constraints, permitted: v.data.permitted, rebalancing: v.data.rebalancing, monitoring: v.data.monitoring, guardrails: v.data.guardrails, allocations: v.data.allocations, risk_limits: v.data.risk_limits, ips_rules: v.data.ips_rules, glide_path: v.data.glide_path }); setSim(v.data.simulation); } }, [v.data, form]);
  const policy = list.find((p) => p.open_draft?.id === vid || p.id === v.data?.policy_id);
  const role = session.get()?.families.find((f) => f.id === session.family())?.role;
  const call = async (l: string, fn: () => Promise<unknown>, refresh = true) => { setBusy(l); setErr(""); try { await fn(); if (refresh) { v.refetch(); onChange(); } } catch (e: any) { setErr(e.message); } finally { setBusy(""); } };
  const save = (patch?: any) => call("save", async () => { const body = { ...(patch ?? form) }; const r = await api<any>(`/policy-versions/${vid}`, { method: "PATCH", body: JSON.stringify(body) }); setForm({ objectives: r.objectives, risk: r.risk, constraints: r.constraints, permitted: r.permitted, rebalancing: r.rebalancing, monitoring: r.monitoring, guardrails: r.guardrails, allocations: r.allocations, risk_limits: r.risk_limits, ips_rules: r.ips_rules, glide_path: r.glide_path }); setSavedAt(new Date().toLocaleTimeString("en-IN")); }, false);
  if (creating) return <NewPolicy onClose={() => setCreating(false)} onCreated={(id, nvid) => { setCreating(false); setDraft(nvid); onChange(); }} />;
  if (!vid) return <Card title="Policy builder"><div className="small mute">No open draft. Amend a policy from the Policies tab or start a new one.</div><button className="btn btn-p" style={{ marginTop: 10 }} onClick={() => setCreating(true)}><Plus size={14} /> New policy</button></Card>;
  if (!v.data || !form) return <Status loading={v.loading} error={v.error} />;
  const d = v.data; const editable = ["draft", "in_review"].includes(d.status);
  const set = (k: string, patch: any) => setForm({ ...form, [k]: { ...(form[k] ?? {}), ...patch } });
  const lensRows = (lens: string) => (form.allocations as any[]).filter((a) => a.lens === lens);
  const setAlloc = (lens: string, rows: any[]) => setForm({ ...form, allocations: [...(form.allocations as any[]).filter((a) => a.lens !== lens), ...rows.map((r) => ({ ...r, lens }))] });
  const actualOf = (lens: string, key: string) => sim?.compliance?.checks?.find((c: any) => c.kind === "allocation" && c.key === `${lens}:${key}`)?.actual ?? (sim?.allocation_now && lens === "asset_class" ? `${sim.allocation_now[key] ?? 0}%` : "—");
  const num = (x: any) => (x === "" || x == null ? null : Number(x));
  return (<>
    {err && <div className="err">{err}</div>}
    {savedAt && !err && <div className="small" style={{ color: "var(--teal)", marginBottom: 6 }}>Saved at {savedAt}</div>}
    <Card title={`Policy builder — ${policy?.name ?? d.policy_id} · ${d.status.replace("_", " ")} v${d.version}`} action={<div className="row gap small mute">{drafts.length > 1 && <select className="entity" style={inp} value={vid} onChange={(e) => { setDraft(e.target.value); setForm(null); }}>{drafts.map((p) => <option key={p.id} value={p.open_draft.id}>{p.name} v{p.open_draft.version}</option>)}</select>}<button className="btn btn-s" onClick={() => setCreating(true)}><Plus size={14} /> New policy</button>{editable && <button className="btn btn-s btn-p" disabled={!!busy} onClick={() => save()}>Save</button>}</div>}>
      <div className="row" style={{ gap: 4, flexWrap: "wrap", marginBottom: 14 }}>{STEPS.map((x, i) => <button key={x} className="btn btn-s" style={{ background: i === step ? "var(--navy, #12213A)" : undefined, color: i === step ? "#fff" : undefined }} onClick={() => setStep(i)}>{i + 1}. {x}</button>)}</div>
      {!editable && <div className="small mute" style={{ marginBottom: 10 }}>This version is {d.status}; clauses are read-only. Amend from the Policies tab.</div>}
      {step === 0 && <div className="grid-2">
        <div><b>Scope</b><div className="small">{policy?.scope} · {policy?.entity_name ?? policy?.goal_name ?? "whole family"}{policy?.parent_name ? ` · inherits ${policy.parent_name}` : ""}</div><div className="small mute" style={{ marginTop: 6 }}>{d.change_summary}</div>
          <div className="small mute" style={{ marginTop: 10 }}>Inherited clauses (from {d.effective?.chain?.slice(0, -1).map((c: any) => c.name).join(" → ") || "—"}): {d.effective?.items?.filter((i: any) => i.inherited).length ?? 0} · overridden here: {d.effective?.items?.filter((i: any) => !i.inherited).length ?? 0}</div></div>
        <div><b>Change summary</b><textarea style={{ ...inp, width: "100%", minHeight: 70, marginTop: 6 }} value={form.change_summary ?? d.change_summary ?? ""} onChange={(e) => setForm({ ...form, change_summary: e.target.value })} disabled={!editable} /></div>
      </div>}
      {step === 1 && <Questionnaire scope={policy} current={form.risk} onApply={(patch) => { const next = { ...form, ...patch }; setForm(next); save(next); }} editable={editable} />}
      {step === 2 && <div className="grid-2">
        <div><b>Objectives</b>
          <Field label="Purpose"><textarea style={{ ...inp, width: "100%", minHeight: 60 }} value={form.objectives.purpose ?? ""} onChange={(e) => set("objectives", { purpose: e.target.value })} disabled={!editable} /></Field>
          <div className="row gap"><Field label="Return objective %"><input style={inp} type="number" step="0.5" value={form.objectives.return_objective_pct ?? ""} onChange={(e) => set("objectives", { return_objective_pct: num(e.target.value) })} disabled={!editable} /></Field><Field label="Basis"><select style={inp} value={form.objectives.return_basis ?? "real"} onChange={(e) => set("objectives", { return_basis: e.target.value })} disabled={!editable}><option>real</option><option>nominal</option></select></Field><Field label="Horizon (years)"><input style={inp} type="number" value={form.objectives.horizon_years ?? ""} onChange={(e) => set("objectives", { horizon_years: num(e.target.value) })} disabled={!editable} /></Field></div>
          <Field label="Spending need per annum (₹, today's money)"><input style={inp} type="number" value={form.objectives.spending_need_pa ?? ""} onChange={(e) => set("objectives", { spending_need_pa: num(e.target.value) })} disabled={!editable} /></Field>
        </div>
        <div><b>Constraints</b>
          <Field label="Liquidity coverage (months of spending in liquid assets)"><input style={inp} type="number" value={form.constraints.liquidity_months ?? ""} onChange={(e) => set("constraints", { liquidity_months: num(e.target.value) })} disabled={!editable} /></Field>
          <div className="row gap small" style={{ flexWrap: "wrap", margin: "8px 0" }}>{[["prefer_direct_plans", "direct plans"], ["ltcg_first", "LTCG first"], ["use_exemptions", "use every entity's exemption"]].map(([k, l]) => <label key={k} className="row gap"><input type="checkbox" checked={!!form.constraints.tax?.[k]} onChange={(e) => set("constraints", { tax: { ...(form.constraints.tax ?? {}), [k]: e.target.checked } })} disabled={!editable} />{l}</label>)}<label className="row gap"><input type="checkbox" checked={!!form.constraints.include_real_estate} onChange={(e) => set("constraints", { include_real_estate: e.target.checked })} disabled={!editable} />count property in the allocation</label></div>
          <Field label="Legal (one per line)"><textarea style={{ ...inp, width: "100%", minHeight: 50 }} value={(form.constraints.legal ?? []).join("\n")} onChange={(e) => set("constraints", { legal: e.target.value.split("\n").filter(Boolean) })} disabled={!editable} /></Field>
          <Field label="Unique circumstances (one per line)"><textarea style={{ ...inp, width: "100%", minHeight: 50 }} value={(form.constraints.unique ?? []).join("\n")} onChange={(e) => set("constraints", { unique: e.target.value.split("\n").filter(Boolean) })} disabled={!editable} /></Field>
        </div>
      </div>}
      {step === 3 && <div>{["asset_class", "bucket"].map((lens) => <div key={lens} style={{ marginBottom: 14 }}>
        <div className="row gap" style={{ justifyContent: "space-between" }}><b>{label(lens)} lens {lens === "bucket" && <span className="small mute">(optional — written to bucket targets on activation)</span>}</b><span className="small mute">sum {lensRows(lens).reduce((s, a) => s + Number(a.target_pct || 0), 0)}%</span></div>
        <table className="tbl"><thead><tr><th>Key</th><th className="num">Target %</th><th className="num">Min</th><th className="num">Max</th><th className="num">Actual now</th><th></th></tr></thead><tbody>
          {lensRows(lens).map((a, i) => <tr key={i}><td>{lens === "asset_class" ? <select style={inp} value={a.key} onChange={(e) => setAlloc(lens, lensRows(lens).map((x, j) => (j === i ? { ...x, key: e.target.value } : x)))} disabled={!editable}>{CLASSES.map((c) => <option key={c}>{c}</option>)}</select> : <select style={inp} value={a.key} onChange={(e) => setAlloc(lens, lensRows(lens).map((x, j) => (j === i ? { ...x, key: e.target.value } : x)))} disabled={!editable}>{["liquidity", "income", "growth"].map((c) => <option key={c}>{c}</option>)}</select>}</td>
            {(["target_pct", "min_pct", "max_pct"] as const).map((k) => <td key={k} className="num"><input style={{ ...inp, width: 70 }} type="number" value={a[k] ?? ""} onChange={(e) => setAlloc(lens, lensRows(lens).map((x, j) => (j === i ? { ...x, [k]: num(e.target.value) } : x)))} disabled={!editable} /></td>)}
            <td className="num">{actualOf(lens, a.key)}</td><td>{editable && <button className="btn btn-s" onClick={() => setAlloc(lens, lensRows(lens).filter((_, j) => j !== i))}>×</button>}</td></tr>)}
        </tbody></table>
        {editable && <button className="btn btn-s" style={{ marginTop: 6 }} onClick={() => setAlloc(lens, [...lensRows(lens), { key: lens === "bucket" ? "liquidity" : CLASSES.find((c) => !lensRows(lens).some((a) => a.key === c)) ?? "equity", target_pct: 0, min_pct: null, max_pct: null }])}><Plus size={12} /> row</button>}
      </div>)}
        <b>Glide path</b> <span className="small mute">growth % by year (optional)</span>
        <input style={{ ...inp, width: "100%", marginTop: 6 }} placeholder="2026:60, 2031:50, 2036:27" value={(form.glide_path?.steps ?? []).map((s: any) => `${s.year}:${s.growth_pct ?? s.equity_pct}`).join(", ")} onChange={(e) => setForm({ ...form, glide_path: e.target.value.trim() ? { steps: e.target.value.split(",").map((x) => x.trim().split(":")).filter((x) => x.length === 2).map(([y, p]) => ({ year: Number(y), growth_pct: Number(p) })) } : null })} disabled={!editable} />
        <div className="small mute" style={{ marginTop: 8 }}>Actual-now comes from the last simulation (step 9). Each lens must sum to 100 ± 0.5; min ≤ target ≤ max.</div>
      </div>}
      {step === 4 && <div>
        <table className="tbl"><thead><tr><th>Metric</th><th>Op</th><th className="num">Limit</th><th className="num">Warn</th><th className="num">Severity</th><th className="num">Now</th><th></th></tr></thead><tbody>
          {(form.risk_limits as any[]).map((l, i) => <tr key={i}><td><select style={inp} value={l.metric} onChange={(e) => setForm({ ...form, risk_limits: form.risk_limits.map((x: any, j: number) => (j === i ? { ...x, metric: e.target.value } : x)) })} disabled={!editable}>{METRICS.map((m) => <option key={m}>{m}</option>)}</select></td><td><select style={inp} value={l.operator} onChange={(e) => setForm({ ...form, risk_limits: form.risk_limits.map((x: any, j: number) => (j === i ? { ...x, operator: e.target.value } : x)) })} disabled={!editable}><option>{"<="}</option><option>{">="}</option></select></td>
            {(["limit_value", "warn_value", "severity"] as const).map((k) => <td key={k} className="num"><input style={{ ...inp, width: 70 }} type="number" step="0.1" value={l[k] ?? ""} onChange={(e) => setForm({ ...form, risk_limits: form.risk_limits.map((x: any, j: number) => (j === i ? { ...x, [k]: num(e.target.value) } : x)) })} disabled={!editable} /></td>)}
            <td className="num">{sim?.compliance?.checks?.find((c: any) => c.kind === "risk_limit" && c.key === l.metric)?.actual ?? "—"}</td><td>{editable && <button className="btn btn-s" onClick={() => setForm({ ...form, risk_limits: form.risk_limits.filter((_: any, j: number) => j !== i) })}>×</button>}</td></tr>)}
        </tbody></table>
        {editable && <button className="btn btn-s" style={{ marginTop: 6 }} onClick={() => setForm({ ...form, risk_limits: [...form.risk_limits, { metric: METRICS.find((m) => !form.risk_limits.some((x: any) => x.metric === m)) ?? "volatility_1y", operator: "<=", limit_value: 0, warn_value: null, severity: 2 }] })}><Plus size={12} /> limit</button>}
        <div style={{ marginTop: 14 }}><b>Concentration & structure (IPS rules)</b>
          <table className="tbl"><thead><tr><th>Rule</th><th>Parameter</th><th className="num">Severity</th><th></th></tr></thead><tbody>
            {(form.ips_rules as any[]).map((r, i) => <tr key={i}><td><select style={inp} value={r.code} onChange={(e) => setForm({ ...form, ips_rules: form.ips_rules.map((x: any, j: number) => (j === i ? { ...x, code: e.target.value } : x)) })} disabled={!editable}>{RULES.map((m) => <option key={m}>{m}</option>)}</select></td><td><input style={inp} value={String(Object.values(r.params ?? {})[0] ?? "")} onChange={(e) => { const k = r.code === "min_credit_rating" ? "rating" : r.code === "min_liquidity_months" ? "months" : r.code === "max_duration" ? "years" : "pct"; setForm({ ...form, ips_rules: form.ips_rules.map((x: any, j: number) => (j === i ? { ...x, params: { [k]: k === "rating" ? e.target.value : Number(e.target.value) } } : x)) }); }} disabled={!editable} /></td><td className="num"><input style={{ ...inp, width: 60 }} type="number" value={r.severity ?? 2} onChange={(e) => setForm({ ...form, ips_rules: form.ips_rules.map((x: any, j: number) => (j === i ? { ...x, severity: Number(e.target.value) } : x)) })} disabled={!editable} /></td><td>{editable && <button className="btn btn-s" onClick={() => setForm({ ...form, ips_rules: form.ips_rules.filter((_: any, j: number) => j !== i) })}>×</button>}</td></tr>)}
          </tbody></table>
          {editable && <button className="btn btn-s" style={{ marginTop: 6 }} onClick={() => setForm({ ...form, ips_rules: [...form.ips_rules, { code: "max_single_issuer", params: { pct: 10 }, severity: 2 }] })}><Plus size={12} /> rule</button>}
        </div>
      </div>}
      {step === 5 && <div className="grid-2">
        <div><b>Permitted instrument types</b><div className="row gap small" style={{ flexWrap: "wrap", marginTop: 6 }}>{TYPES.map((t) => <label key={t} className="row gap"><input type="checkbox" checked={(form.permitted.instrument_types ?? []).includes(t)} onChange={(e) => set("permitted", { instrument_types: e.target.checked ? [...(form.permitted.instrument_types ?? []), t] : (form.permitted.instrument_types ?? []).filter((x: string) => x !== t) })} disabled={!editable} />{t}</label>)}</div>
          <Field label="Minimum rating on debt"><select style={inp} value={form.permitted.min_rating ?? ""} onChange={(e) => set("permitted", { min_rating: e.target.value || null })} disabled={!editable}><option value="">none</option>{["AAA", "AA+", "AA", "AA-", "A+", "A", "BBB"].map((r) => <option key={r}>{r}</option>)}</select></Field></div>
        <div><Field label="Prohibited (comma separated; e.g. f&o, crypto, unrated_debt, single_stocks > 5)"><textarea style={{ ...inp, width: "100%", minHeight: 60 }} value={(form.permitted.prohibited ?? []).join(", ")} onChange={(e) => set("permitted", { prohibited: e.target.value.split(",").map((x) => x.trim()).filter(Boolean) })} disabled={!editable} /></Field>
          <Field label="Approved managers (comma separated; empty = any)"><textarea style={{ ...inp, width: "100%", minHeight: 60 }} value={(form.permitted.managers ?? []).join(", ")} onChange={(e) => set("permitted", { managers: e.target.value.split(",").map((x) => x.trim()).filter(Boolean) })} disabled={!editable} /></Field></div>
      </div>}
      {step === 6 && <div className="grid-2">
        <div><b>Rebalancing</b>
          <div className="row gap"><Field label="Method"><select style={inp} value={form.rebalancing.method ?? "both"} onChange={(e) => set("rebalancing", { method: e.target.value })} disabled={!editable}><option>bands</option><option>calendar</option><option>both</option></select></Field><Field label="Calendar"><select style={inp} value={form.rebalancing.calendar ?? "quarterly"} onChange={(e) => set("rebalancing", { calendar: e.target.value })} disabled={!editable}><option>monthly</option><option>quarterly</option><option>half-yearly</option><option>annual</option></select></Field><Field label="Tolerance pp"><input style={inp} type="number" value={form.rebalancing.tolerance_pp ?? ""} onChange={(e) => set("rebalancing", { tolerance_pp: num(e.target.value) })} disabled={!editable} /></Field></div>
          <div className="row gap small"><label className="row gap"><input type="checkbox" checked={form.rebalancing.use_new_cash_first ?? true} onChange={(e) => set("rebalancing", { use_new_cash_first: e.target.checked })} disabled={!editable} />new cash first</label><label className="row gap"><input type="checkbox" checked={form.rebalancing.tax_aware ?? true} onChange={(e) => set("rebalancing", { tax_aware: e.target.checked })} disabled={!editable} />tax-aware</label></div>
        </div>
        <div><b>Monitoring & review</b>
          <div className="row gap"><Field label="Benchmark"><select style={inp} value={form.monitoring.benchmark_code ?? ""} onChange={(e) => set("monitoring", { benchmark_code: e.target.value || null })} disabled={!editable}><option value="">none</option>{["NIFTY50", "NIFTY500", "CRISIL_CBI", "BLEND_6040"].map((b) => <option key={b}>{b}</option>)}</select></Field><Field label="Tracking error max %"><input style={inp} type="number" step="0.5" value={form.monitoring.tracking_error_max_pct ?? ""} onChange={(e) => set("monitoring", { tracking_error_max_pct: num(e.target.value) })} disabled={!editable} /></Field><Field label="Review every (months)"><input style={inp} type="number" value={form.monitoring.review_every_months ?? policy?.review_every_months ?? 12} onChange={(e) => set("monitoring", { review_every_months: num(e.target.value) })} disabled={!editable} /></Field></div>
          <div className="row gap small" style={{ flexWrap: "wrap" }}>Report to: {["principal", "ca", "members"].map((r) => <label key={r} className="row gap"><input type="checkbox" checked={(form.monitoring.report_to ?? []).includes(r)} onChange={(e) => set("monitoring", { report_to: e.target.checked ? [...(form.monitoring.report_to ?? []), r] : (form.monitoring.report_to ?? []).filter((x: string) => x !== r) })} disabled={!editable} />{r}</label>)}</div>
          <div className="row gap small" style={{ flexWrap: "wrap", marginTop: 6 }}>Triggers: {["breach_persisting", "drawdown", "goal_change", "new_entity", "regulation"].map((r) => <label key={r} className="row gap"><input type="checkbox" checked={(form.monitoring.triggers ?? []).includes(r)} onChange={(e) => set("monitoring", { triggers: e.target.checked ? [...(form.monitoring.triggers ?? []), r] : (form.monitoring.triggers ?? []).filter((x: string) => x !== r) })} disabled={!editable} />{label(r)}</label>)}</div>
        </div>
      </div>}
      {step === 7 && <div className="grid-2">
        <div><b>Execution policies</b> <span className="small mute">written to the action plane on activation</span>
          <table className="tbl"><thead><tr><th>Code</th><th>Params (JSON)</th><th></th></tr></thead><tbody>{((form.guardrails.execution_policies ?? []) as any[]).map((g, i) => <tr key={i}><td><select style={inp} value={g.code} onChange={(e) => set("guardrails", { execution_policies: form.guardrails.execution_policies.map((x: any, j: number) => (j === i ? { ...x, code: e.target.value } : x)) })} disabled={!editable}>{["max_single_amount", "max_daily_amount", "max_monthly_amount", "approvers_required", "cooling_off_minutes", "require_ips_pass", "require_tax_check", "block_new_payee_days", "trading_hours_only"].map((c) => <option key={c}>{c}</option>)}</select></td><td><input style={{ ...inp, width: "100%" }} defaultValue={JSON.stringify(g.params ?? {})} onBlur={(e) => { try { set("guardrails", { execution_policies: form.guardrails.execution_policies.map((x: any, j: number) => (j === i ? { ...x, params: JSON.parse(e.target.value || "{}") } : x)) }); } catch { setErr("params must be JSON"); } }} disabled={!editable} /></td><td>{editable && <button className="btn btn-s" onClick={() => set("guardrails", { execution_policies: form.guardrails.execution_policies.filter((_: any, j: number) => j !== i) })}>×</button>}</td></tr>)}</tbody></table>
          {editable && <button className="btn btn-s" style={{ marginTop: 6 }} onClick={() => set("guardrails", { execution_policies: [...(form.guardrails.execution_policies ?? []), { code: "max_single_amount", params: { amount: 500000 } }] })}><Plus size={12} /> guardrail</button>}</div>
        <div><b>Approval tiers</b>
          <table className="tbl"><thead><tr><th className="num">Up to ₹</th><th className="num">Approvers</th><th className="num">Cooling-off min</th><th></th></tr></thead><tbody>{((form.guardrails.approval_tiers ?? []) as any[]).map((t, i) => <tr key={i}>{(["up_to", "approvers", "cooling_off_minutes"] as const).map((k) => <td key={k} className="num"><input style={{ ...inp, width: 90 }} type="number" value={t[k] ?? ""} placeholder={k === "up_to" ? "above" : ""} onChange={(e) => set("guardrails", { approval_tiers: form.guardrails.approval_tiers.map((x: any, j: number) => (j === i ? { ...x, [k]: num(e.target.value) } : x)) })} disabled={!editable} /></td>)}<td>{editable && <button className="btn btn-s" onClick={() => set("guardrails", { approval_tiers: form.guardrails.approval_tiers.filter((_: any, j: number) => j !== i) })}>×</button>}</td></tr>)}</tbody></table>
          {editable && <button className="btn btn-s" style={{ marginTop: 6 }} onClick={() => set("guardrails", { approval_tiers: [...(form.guardrails.approval_tiers ?? []), { up_to: null, approvers: 2 }] })}><Plus size={12} /> tier</button>}
          <div className="small mute" style={{ marginTop: 8 }}>Guardrails cannot be loosened in Action plane settings; they change only through a policy amendment with approval and signature.</div></div>
      </div>}
      {step === 8 && <div className="grid-2">
        <Card title="Draft vs current portfolio" action={<button className="btn btn-s btn-p" disabled={!!busy} onClick={() => call("sim", async () => { await save(); setSim(await api(`/policy-versions/${vid}/simulate`, { method: "POST", body: "{}" })); }, false)}><Play size={14} /> Simulate</button>}>
          {!sim ? <div className="small mute">Run the simulation to see compliance if activated today, the moves required (tax-aware) and expected return vs objective.</div> : <>
            <table className="tbl"><tbody>
              <tr><td>Compliance if activated today</td><td><Pill tone={tone(sim.compliance.overall)}>{sim.compliance.breaches} breach · {sim.compliance.warnings} warning</Pill></td></tr>
              <tr><td>Expected return ({form.objectives.horizon_years ?? "—"} yr)</td><td className="num">{sim.expected_return_pct}% vs objective {sim.objective_nominal_pct}% nominal <span className={sim.objective_gap_pct >= 0 ? "up" : "down"}>gap {sim.objective_gap_pct > 0 ? "+" : ""}{sim.objective_gap_pct} pp</span></td></tr>
              <tr><td>Expected volatility</td><td className="num">{sim.expected_vol_pct}%{sim.vol_limit_pct != null ? ` (limit ${sim.vol_limit_pct}%)` : ""}</td></tr>
              <tr><td>Moves to comply</td><td className="small">{sim.moves.length ? sim.moves.map((m: any, i: number) => <div key={i}>{m.kind === "sell" ? `Sell ${inr(m.amount)} of ${m.name} (${m.from}) — gain ${inr(m.estimated_gain)}, tax ${inr(m.estimated_tax)}${m.term ? `, ${m.term}` : ""}` : `Buy ${inr(m.amount)} into ${m.to} — ${m.note}`}</div>) : "none — already within every band"}</td></tr>
              <tr><td>Tax cost of compliance</td><td className="num">{inr(sim.tax_cost_to_comply)}</td></tr>
            </tbody></table>
            <div className="small mute" style={{ marginTop: 8 }}>A return gap is a finding, not a blocker: lower the objective, extend the horizon or raise the contribution.</div></>}
        </Card>
        <Card title="Checks against the draft">{!sim ? <span className="small mute">—</span> : <div style={{ maxHeight: 360, overflow: "auto" }}><table className="tbl"><thead><tr><th>Check</th><th className="num">Target</th><th className="num">Actual</th><th></th></tr></thead><tbody>{sim.compliance.checks.map((c: any, i: number) => <tr key={i}><td className="small">{label(c.kind)} · {label(c.key)}</td><td className="num small">{c.target}</td><td className="num small">{c.actual}</td><td><Pill tone={tone(c.status)}>{label(c.status)}</Pill></td></tr>)}</tbody></table></div>}</Card>
      </div>}
      {step === 9 && <div className="grid-2">
        <Card title="Workflow">
          {[["Draft complete", ["in_review", "active"].includes(d.status) || d.status === "draft"], [`Submitted for review`, d.status !== "draft"], [`Signed (${(d.signed_by ?? []).length})`, (d.signed_by ?? []).length > 0], ["Activated — writes targets, bands, rules, guardrails", d.status === "active"]].map(([a, ok]) => <div key={String(a)} className="attn">{ok ? <CheckCircle2 size={16} color="var(--teal, #0E7C6B)" /> : <AlertTriangle size={16} className="mute" />}<span>{a as string}</span></div>)}
          <div className="row gap" style={{ marginTop: 10, flexWrap: "wrap" }}>
            {d.status === "draft" && <button className="btn btn-s btn-p" disabled={!!busy} onClick={() => call("status", async () => { await save(); await api(`/policy-versions/${vid}/status`, { method: "POST", body: JSON.stringify({ status: "in_review" }) }); })}>Submit for review</button>}
            {d.status === "in_review" && <button className="btn btn-s" disabled={!!busy} onClick={() => call("status", () => api(`/policy-versions/${vid}/status`, { method: "POST", body: JSON.stringify({ status: "draft" }) }))}>Back to draft</button>}
            {editable && <button className="btn btn-s" disabled={!!busy} onClick={() => call("status", () => api(`/policy-versions/${vid}/status`, { method: "POST", body: JSON.stringify({ status: "archived" }) }))}>Archive draft</button>}
          </div>
          <div className="small mute" style={{ marginTop: 8 }}>Signatures: {(d.signed_by ?? []).map((s: any) => `${s.name} (${s.role}, ${fmtDate(s.signed_at)})`).join(" · ") || "none yet"}</div>
        </Card>
        <Card title="Sign and activate">
          <div className="row gap" style={{ flexWrap: "wrap" }}><Field label="Step-up code"><input style={{ ...inp, width: 100 }} value={proof} onChange={(e) => setProof(e.target.value)} /></Field><button className="btn btn-s" disabled={!!busy || !["owner", "member"].includes(role ?? "")} onClick={() => call("sign", () => api(`/policy-versions/${vid}/sign`, { method: "POST", body: JSON.stringify({ auth_method: "totp", auth_proof: proof }) }))}><Fingerprint size={14} /> Sign</button></div>
          <div className="row gap" style={{ flexWrap: "wrap", marginTop: 8 }}><Field label="Effective from"><input style={inp} type="date" value={eff} onChange={(e) => setEff(e.target.value)} /></Field><button className="btn btn-s btn-p" disabled={!!busy || role !== "owner" || d.status === "active"} onClick={() => call("activate", () => api(`/policy-versions/${vid}/status`, { method: "POST", body: JSON.stringify({ status: "active", effective_from: eff, auth_method: "totp", auth_proof: proof }) }))}>Approve and activate</button></div>
          <div className="small mute" style={{ marginTop: 8 }}>Activation needs an owner and at least one signature; it supersedes the current version, writes bucket targets, asset-class bands, IPS rules, execution guardrails and the glide path, schedules the next review and renders the IPS. Dev step-up code is 000000.</div>
        </Card>
      </div>}
    </Card>
  </>);
}

function Questionnaire({ scope, current, onApply, editable }: { scope: any; current: any; onApply: (patch: any) => void; editable: boolean }) {
  const qs = useApi<any[]>("/risk-questionnaires"); const q = qs.data?.find((x) => x.system) ?? qs.data?.[0];
  const [answers, setAnswers] = useState<Record<string, string>>({}); const [res, setRes] = useState<any | null>(null); const [err, setErr] = useState("");
  const submit = async () => { setErr(""); try { setRes(await api(`/risk-questionnaires/${q.id}/respond`, { method: "POST", body: JSON.stringify({ answers, entity_id: scope?.entity_id ?? undefined, goal_id: scope?.goal_id ?? undefined }) })); } catch (e: any) { setErr(e.message); } };
  const apply = () => { if (!res) return; const mix = res.suggested_model.mix as Record<string, number>, bands = (res.suggested_model.bands ?? {}) as Record<string, number[]>; onApply({ risk: { ...current, profile: res.profile, score: res.score, capacity_score: res.capacity_score, tolerance_score: res.tolerance_score, capacity: res.capacity_score >= 60 ? "high" : res.capacity_score >= 40 ? "moderate" : "low", tolerance: res.tolerance_score >= 60 ? "high" : res.tolerance_score >= 40 ? "moderate" : "low", max_drawdown_pct: res.suggested_max_drawdown_pct, questionnaire_response_id: res.response_id }, allocations: Object.entries(mix).map(([k, t]) => ({ lens: "asset_class", key: k, target_pct: t, min_pct: bands[k]?.[0] ?? null, max_pct: bands[k]?.[1] ?? null })), risk_limits: res.suggested_limits, constraints: { liquidity_months: res.suggested_liquidity_months } }); };
  if (!q) return <Status loading={qs.loading} error={qs.error} />;
  return <div className="grid-2">
    <div><b>{q.name} — {q.questions.length} questions, 4 dimensions</b>{err && <div className="err">{err}</div>}
      {q.questions.map((qu: any) => <div key={qu.id} style={{ margin: "8px 0" }}><div className="small"><span className="mute">{qu.dimension}</span> · {qu.text}</div><div className="row gap" style={{ flexWrap: "wrap", marginTop: 4 }}>{qu.options.map((o: any) => <button key={o.label} className="btn btn-s" style={{ background: answers[qu.id] === o.label ? "var(--navy, #12213A)" : undefined, color: answers[qu.id] === o.label ? "#fff" : undefined }} onClick={() => setAnswers({ ...answers, [qu.id]: o.label })}>{o.label}</button>)}</div></div>)}
      <button className="btn btn-p" style={{ marginTop: 8 }} disabled={Object.keys(answers).length < q.questions.length} onClick={submit}>Score</button>
    </div>
    <div className="src" style={{ alignSelf: "start" }}><b>Result</b>
      {current?.profile && !res && <div className="small mute" style={{ marginTop: 6 }}>Current draft: {label(current.profile)}{current.score ? ` (score ${Math.round(current.score)})` : ""}{current.max_drawdown_pct != null ? ` · max drawdown ${current.max_drawdown_pct}%` : ""}</div>}
      {res && <>
        <table className="tbl"><tbody><tr><td>Capacity</td><td className="num">{Math.round(res.capacity_score)} / 100</td></tr><tr><td>Tolerance</td><td className="num">{Math.round(res.tolerance_score)} / 100</td></tr><tr><td>Horizon</td><td className="num">{Math.round(res.horizon_score)} / 100</td></tr><tr><td>Knowledge</td><td className="num">{Math.round(res.knowledge_score)} / 100</td></tr><tr><td><b>Weighted score</b></td><td className="num"><b>{Math.round(res.score)}</b></td></tr></tbody></table>
        <Pill tone="amber">{label(res.profile)}</Pill>
        <div className="small mute" style={{ margin: "6px 0" }}>{res.notes.join("; ") || "capacity and tolerance agree"}. Suggested model: {Object.entries(res.suggested_model.mix).map(([k, v]) => `${k} ${v}`).join(" / ")} with {res.suggested_max_drawdown_pct}% drawdown limit and {res.suggested_liquidity_months}-month liquidity.</div>
        {editable && <button className="btn btn-s btn-p" onClick={apply}>Use suggestion</button>}
      </>}
    </div>
  </div>;
}

function useLatest(list: any[], selectedId: string | null) {
  const p = list.find((x) => x.id === selectedId); const d = useApi<any>(selectedId ? `/policies/${selectedId}` : null); const comp = useApi<any>(selectedId && p?.current_version ? `/policies/${selectedId}/compliance` : null);
  return { p, d, comp };
}
function Allocation({ list, selectedId, onSelect }: { list: any[]; selectedId: string | null; onSelect: (id: string) => void }) {
  const { p, d, comp } = useLatest(list, selectedId); const eff = d.data?.effective?.clauses; const checks: any[] = comp.data?.checks ?? [];
  const actual = (lens: string, key: string) => checks.find((c) => c.kind === "allocation" && c.key === `${lens}:${key}`);
  const glide = eff?.glide_path?.steps ?? []; const growthNow = comp.data?.metrics?.allocation?.bucket?.growth ?? comp.data?.metrics?.allocation?.asset_class?.equity;
  return <>
    <Picker list={list} selectedId={selectedId} onSelect={onSelect} />
    {!d.data ? <Status loading={d.loading} error={d.error} /> : <div className="grid-2">
      <Card title={`${p?.name} — allocation clauses${p?.current_version ? ` (v${p.current_version.version} ${p.current_version.status})` : ""}`}>
        {!eff ? <div className="small mute">No active version.</div> : <table className="tbl"><thead><tr><th>Lens · key</th><th className="num">Target</th><th className="num">Band</th><th className="num">Actual</th><th>Status</th></tr></thead><tbody>
          {eff.allocations.map((a: any) => { const c = actual(a.lens, a.key); return <tr key={`${a.lens}${a.key}`}><td>{label(a.lens)} · {label(a.key)}</td><td className="num">{a.target_pct}%</td><td className="num">{a.min_pct ?? "—"}–{a.max_pct ?? "—"}</td><td className="num">{c?.actual ?? "—"}</td><td>{c ? <Pill tone={tone(c.status)}>{label(c.status)}</Pill> : <span className="small mute">evaluate</span>}</td></tr>; })}
        </tbody></table>}
        {eff && <div className="small mute" style={{ marginTop: 8 }}>Rebalancing: {eff.rebalancing?.method ?? "—"}{eff.rebalancing?.calendar ? ` · ${eff.rebalancing.calendar}` : ""}{eff.rebalancing?.tolerance_pp ? ` · tolerance ${eff.rebalancing.tolerance_pp} pp` : ""}{eff.rebalancing?.use_new_cash_first ? " · new cash first" : ""}{eff.rebalancing?.tax_aware ? " · tax-aware" : ""}. Portfolio {inr(comp.data?.metrics?.total)} as of {fmtDate(comp.data?.as_of ?? null)}.</div>}
      </Card>
      <Card title="Glide path (clause) vs actual">
        {!glide.length ? <div className="small mute">No glide path on this policy.</div> : <>
          <div style={{ display: "flex", gap: 8, alignItems: "flex-end", height: 160, padding: "0 4px" }}>{glide.map((s: any) => { const t = Number(s.growth_pct ?? s.equity_pct); return <div key={s.year} style={{ flex: 1, textAlign: "center" }}><div className="small mute">{t}%</div><div style={{ height: t * 1.2, background: "var(--teal, #0E7C6B)", borderRadius: 4 }} /><div className="small">{s.year}</div></div>; })}</div>
          <div className="small mute" style={{ marginTop: 8 }}>Growth now {growthNow != null ? `${growthNow}%` : "—"} vs {checks.find((c) => c.kind === "glide_path")?.target ?? "—"} on the path {checks.find((c) => c.kind === "glide_path") && <Pill tone={tone(checks.find((c) => c.kind === "glide_path").status)}>{label(checks.find((c) => c.kind === "glide_path").status)}</Pill>}</div>
        </>}
        {eff?.objectives && <div className="small" style={{ marginTop: 10 }}><b>Objective:</b> {eff.objectives.return_objective_pct != null ? `${eff.objectives.return_objective_pct}% ${eff.objectives.return_basis ?? ""}` : "—"} over {eff.objectives.horizon_years ?? "—"} years{Number(eff.objectives.spending_need_pa) > 0 ? ` · spending ${inr(eff.objectives.spending_need_pa)} p.a.` : ""}</div>}
      </Card>
    </div>}
  </>;
}
function Risk({ list, selectedId, onSelect }: { list: any[]; selectedId: string | null; onSelect: (id: string) => void }) {
  const { p, d, comp } = useLatest(list, selectedId); const eff = d.data?.effective?.clauses; const checks: any[] = comp.data?.checks ?? [];
  const find = (kind: string, key: string) => checks.find((c) => c.kind === kind && c.key === key);
  return <>
    <Picker list={list} selectedId={selectedId} onSelect={onSelect} />
    {!d.data ? <Status loading={d.loading} error={d.error} /> : !eff ? <Card title="Risk limits"><span className="small mute">No active version.</span></Card> : <div className="grid-2">
      <Card title={`Risk limits — ${p?.name}`}>
        <table className="tbl"><thead><tr><th>Metric</th><th className="num">Limit</th><th className="num">Warn</th><th className="num">Now</th><th>Status</th></tr></thead><tbody>{eff.risk_limits.map((l: any) => { const c = find("risk_limit", l.metric); return <tr key={l.metric}><td>{label(l.metric)}</td><td className="num">{l.operator} {l.limit_value}</td><td className="num">{l.warn_value ?? "—"}</td><td className="num">{c?.actual ?? "—"}</td><td>{c ? <Pill tone={tone(c.status)}>{label(c.status)}</Pill> : null}</td></tr>; })}</tbody></table>
        <div style={{ marginTop: 12 }}><b>Concentration & structure</b><table className="tbl"><tbody>{eff.ips_rules.map((r: any) => { const c = find("ips_rule", r.code); return <tr key={r.code}><td>{label(r.code)}</td><td className="num">{c?.target ?? Object.values(r.params).join(" ")}</td><td className="num">{c?.actual ?? "—"}</td><td>{c ? <Pill tone={tone(c.status)}>{label(c.status)}</Pill> : null}</td></tr>; })}{find("liquidity", "liquidity_coverage") && <tr><td>liquidity coverage</td><td className="num">{find("liquidity", "liquidity_coverage").target}</td><td className="num">{find("liquidity", "liquidity_coverage").actual}</td><td><Pill tone={tone(find("liquidity", "liquidity_coverage").status)}>{label(find("liquidity", "liquidity_coverage").status)}</Pill></td></tr>}</tbody></table></div>
        <div className="small mute" style={{ marginTop: 8 }}>Risk profile {label(eff.risk?.profile ?? "—")}{eff.risk?.score ? ` (score ${Math.round(eff.risk.score)})` : ""} · max drawdown accepted {eff.risk?.max_drawdown_pct ?? "—"}% · series metrics need month-end valuations ({comp.data?.metrics?.series_periods ?? 0} periods available).</div>
      </Card>
      <Card title="Guardrails written to the action plane">
        {[[`Prohibited: ${(eff.permitted?.prohibited ?? []).join(", ") || "—"}`, "assistant refuses; approval blocked", find("permitted", "prohibited")], [`Permitted types: ${(eff.permitted?.instrument_types ?? []).join(", ") || "any"}`, "checked on every intent", find("permitted", "instrument_types")], [`Min rating ${eff.permitted?.min_rating ?? "—"} on debt`, "checked on instrument attributes at proposal", find("permitted", "min_rating")], ...eff.allocations.filter((a: any) => a.lens === "asset_class" && a.max_pct != null).map((a: any) => [`${label(a.key)} band ${a.min_pct ?? 0}–${a.max_pct}%`, "an intent that worsens a breach fails the policy check", find("allocation", `asset_class:${a.key}`)])].map(([a, b, c]: any, i) => <div key={i} className="attn"><div style={{ flex: 1 }}><b>{a}</b><div className="small mute">{b}</div></div>{c && <Pill tone={tone(c.status)}>{label(c.status)}</Pill>}</div>)}
        <div className="small" style={{ marginTop: 10 }}><b>Approval tiers:</b> {(eff.guardrails?.approval_tiers ?? []).map((t: any) => `${t.up_to ? `≤ ${inr(t.up_to)}` : "above"}: ${t.approvers}${t.cooling_off_minutes ? ` + ${t.cooling_off_minutes} min` : ""}`).join(" · ") || "family defaults"}</div>
        <div className="small" style={{ marginTop: 4 }}><b>Execution policies:</b> {(eff.guardrails?.execution_policies ?? []).map((g: any) => `${g.code} ${JSON.stringify(g.params)}`).join(" · ") || "—"}</div>
        <div className="small mute" style={{ marginTop: 8 }}>Guardrails cannot be loosened in Action plane settings; they change only through a policy amendment with approval and signature.</div>
      </Card>
    </div>}
  </>;
}
function Compliance({ list, selectedId, onSelect, onChange }: { list: any[]; selectedId: string | null; onSelect: (id: string) => void; onChange: () => void }) {
  const p = list.find((x) => x.id === selectedId); const latest = useApi<any>(selectedId && p?.current_version ? `/policies/${selectedId}/compliance` : null); const hist = useApi<any[]>(selectedId && p?.current_version ? `/policies/${selectedId}/compliance?history=1` : null);
  const [busy, setBusy] = useState(false); const [err, setErr] = useState("");
  const run = async () => { setBusy(true); setErr(""); try { await api(`/policies/${selectedId}/compliance`, { method: "POST", body: "{}" }); latest.refetch(); hist.refetch(); onChange(); } catch (e: any) { setErr(e.message); } finally { setBusy(false); } };
  const c = latest.data;
  return <>
    <Picker list={list} selectedId={selectedId} onSelect={onSelect} />
    {err && <div className="err">{err}</div>}
    {!p?.current_version ? <Card title="Compliance"><span className="small mute">No active version.</span></Card> : !c ? <Status loading={latest.loading} error={latest.error} /> : <Card title={`Nightly compliance — ${p.name} · ${fmtDate(c.as_of)}`} action={<div className="row gap"><Pill tone={tone(c.overall)}>{c.overall}</Pill><button className="btn btn-s" disabled={busy} onClick={run}><RefreshCw size={14} /> Evaluate now</button></div>}>
      <table className="tbl"><thead><tr><th>Check</th><th>Clause</th><th className="num">Target</th><th className="num">Actual</th><th>Status</th><th>Detail</th></tr></thead><tbody>{c.checks.map((x: any, i: number) => <tr key={i}><td className="mute">{label(x.kind)}</td><td>{label(x.key)}</td><td className="num">{x.target}</td><td className="num">{x.actual}</td><td><Pill tone={tone(x.status)}>{label(x.status)}</Pill></td><td className="small mute">{x.detail}</td></tr>)}</tbody></table>
      <div className="small mute" style={{ marginTop: 10 }}>{c.breaches} breach · {c.warnings} warning · {c.task_ids?.length ?? 0} open task{(c.task_ids?.length ?? 0) === 1 ? "" : "s"}. Portfolio {inr(c.metrics?.total)} over {c.metrics?.positions ?? "—"} positions; look-through: {Object.entries(c.metrics?.allocation?.asset_class ?? {}).map(([k, v]) => `${k} ${v}%`).join(" · ")}.</div>
      {hist.data && hist.data.length > 1 && <div className="small mute" style={{ marginTop: 6 }}>History: {hist.data.slice(0, 14).map((h: any) => `${fmtDate(h.as_of)} ${h.overall}`).join(" · ")}</div>}
    </Card>}
  </>;
}
function Reviews({ list, onChange, onDraft }: { list: any[]; onChange: () => void; onDraft: (id: string, vid: string) => void }) {
  const reviews = useApi<any[]>("/policy-reviews"); const [err, setErr] = useState(""); const [busy, setBusy] = useState(""); const [sel, setSel] = useState<string | null>(null); const [note, setNote] = useState(""); const [outcome, setOutcome] = useState("no_change"); const [adhoc, setAdhoc] = useState(list[0]?.id ?? "");
  const call = async (l: string, fn: () => Promise<unknown>) => { setBusy(l); setErr(""); try { await fn(); reviews.refetch(); onChange(); } catch (e: any) { setErr(e.message); } finally { setBusy(""); } };
  const r = reviews.data?.find((x) => x.id === sel) ?? null; const f = r?.findings;
  return <>
    {err && <div className="err">{err}</div>}
    <div className="grid-2">
      <Card title="Reviews" action={<div className="row gap"><select className="entity" style={inp} value={adhoc} onChange={(e) => setAdhoc(e.target.value)}>{list.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select><button className="btn btn-s" disabled={!!busy} onClick={() => call("adhoc", () => api(`/policies/${adhoc}/reviews`, { method: "POST", body: JSON.stringify({ kind: "ad_hoc" }) }))}><Plus size={14} /> Ad-hoc review</button><button className="btn btn-s" disabled={!!busy} onClick={() => call("run", () => api("/policy-reviews/run", { method: "POST", body: "{}" }))}>Run scheduler</button></div>}>
        {!reviews.data ? <Status loading={reviews.loading} error={reviews.error} /> : <table className="tbl"><thead><tr><th>Kind</th><th>Review</th><th>Due / done</th><th>Status</th><th>Reviewer</th></tr></thead><tbody>{reviews.data.map((x) => <tr key={x.id} style={{ cursor: "pointer", background: x.id === sel ? "var(--paper, #F5F6F8)" : undefined }} onClick={() => setSel(x.id)}><td><Pill tone={x.kind === "trigger" ? "amber" : undefined}>{x.kind}</Pill></td><td><b>{x.policy_name}</b><div className="small mute">{label(x.trigger_reason ?? "")}</div></td><td>{x.status === "completed" ? `Completed ${fmtDate(x.completed_at)}` : fmtDate(x.due_on)}</td><td className="small"><Pill tone={tone(x.status)}>{label(x.status)}</Pill>{x.outcome ? ` ${label(x.outcome)}` : ""}</td><td className="small mute">{x.reviewer_name ?? "—"}</td></tr>)}</tbody></table>}
        <div className="small mute" style={{ marginTop: 10 }}>Findings are pre-filled: compliance history, drift and metric trends, goal progress, life events since the last review. Outcome: no change (resets the date), amended (new draft with diff), or superseded. Triggers: breach persisting 30 days, drawdown beyond clause, goal change, new entity.</div>
      </Card>
      {r && <Card title={`${r.policy_name} — ${r.kind} review`} action={<Pill tone={tone(r.status)}>{label(r.status)}</Pill>}>
        <div className="small"><b>Findings.</b> {f?.summary ?? "—"}</div>
        {f?.drift?.length > 0 && <div className="small" style={{ marginTop: 6 }}><b>Drift:</b> {f.drift.map((d: any) => `${label(d.key)} ${d.actual} vs ${d.target} (${label(d.status)})`).join(" · ")}</div>}
        {f?.metric_trends?.length > 0 && <div className="small" style={{ marginTop: 6 }}><b>Metrics since {fmtDate(f.since)}:</b> {f.metric_trends.slice(0, 8).map((m: any) => `${label(m.metric)} ${m.first} → ${m.last}`).join(" · ")}</div>}
        {f?.goal_progress && <div className="small" style={{ marginTop: 6 }}><b>Goal:</b> {f.goal_progress.name} ({f.goal_progress.target_year}) {f.goal_progress.funded_pct ?? "—"}% funded</div>}
        {f?.life_events?.length > 0 && <div className="small" style={{ marginTop: 6 }}><b>Life events:</b> {f.life_events.slice(0, 6).map((e: any) => `${label(e.kind)} ${e.what ?? ""}`).join(" · ")}</div>}
        {f?.compliance_history?.length > 0 && <div className="small mute" style={{ marginTop: 6 }}>Compliance: {f.compliance_history.filter((h: any) => h.overall !== "breach").length}/{f.compliance_history.length} snapshots clean</div>}
        {r.note && <div className="small" style={{ marginTop: 6 }}><b>Note:</b> {r.note}</div>}
        {r.status !== "completed" && r.status !== "skipped" ? <div style={{ marginTop: 10 }}>
          <div className="row gap" style={{ flexWrap: "wrap" }}><Field label="Outcome"><select style={inp} value={outcome} onChange={(e) => setOutcome(e.target.value)}><option value="no_change">no change (reset date)</option><option value="amended">amended (open draft)</option><option value="superseded">superseded</option></select></Field><Field label="Note"><input style={{ ...inp, width: 260 }} value={note} onChange={(e) => setNote(e.target.value)} /></Field></div>
          <div className="row gap" style={{ marginTop: 8 }}>{r.status === "due" && <button className="btn btn-s" disabled={!!busy} onClick={() => call("start", () => api(`/policy-reviews/${r.id}`, { method: "PATCH", body: JSON.stringify({ status: "in_progress" }) }))}>Start</button>}<button className="btn btn-s btn-p" disabled={!!busy} onClick={() => call("done", async () => { const res = await api<any>(`/policy-reviews/${r.id}`, { method: "PATCH", body: JSON.stringify({ outcome, note: note || undefined }) }); if (outcome === "amended" && res.resulting_version_id) onDraft(r.policy_id, res.resulting_version_id); })}>Complete</button><button className="btn btn-s" disabled={!!busy} onClick={() => call("skip", () => api(`/policy-reviews/${r.id}`, { method: "PATCH", body: JSON.stringify({ status: "skipped", note: note || undefined }) }))}>Skip</button></div>
        </div> : r.resulting_version_id && <button className="btn btn-s" style={{ marginTop: 10 }} onClick={() => onDraft(r.policy_id, r.resulting_version_id)}>Open resulting version</button>}
      </Card>}
    </div>
  </>;
}
function Document({ list, selectedId, onSelect }: { list: any[]; selectedId: string | null; onSelect: (id: string) => void }) {
  const p = list.find((x) => x.id === selectedId); const d = useApi<any>(selectedId ? `/policies/${selectedId}` : null);
  const versions: any[] = d.data?.versions ?? []; const [vid, setVid] = useState<string | null>(null); const v = vid ?? p?.current_version?.id ?? versions[0]?.id ?? null;
  const [html, setHtml] = useState(""); const [diff, setDiff] = useState<any[] | null>(null); const [err, setErr] = useState("");
  useEffect(() => { setHtml(""); setDiff(null); if (!v) return; fetch(`${API_URL}/policy-versions/${v}/document`, { headers: authHeaders() }).then(async (r) => { if (!r.ok) throw new Error(await r.text()); return r.text(); }).then((t) => setHtml(t.slice(t.indexOf("<article")))).catch((e) => setErr(e.message)); }, [v]);
  const regen = async () => { setErr(""); try { await api(`/policy-versions/${v}/document`, { method: "POST", body: "{}" }); const r = await fetch(`${API_URL}/policy-versions/${v}/document`, { headers: authHeaders() }); const t = await r.text(); setHtml(t.slice(t.indexOf("<article"))); } catch (e: any) { setErr(e.message); } };
  const showDiff = async () => { setErr(""); try { setDiff(await api(`/policy-versions/${v}/diff`)); } catch (e: any) { setErr(e.message); } };
  return <>
    <Picker list={list} selectedId={selectedId} onSelect={onSelect} />
    {err && <div className="err">{err}</div>}
    <Card title={`Investment Policy Statement — ${p?.name ?? ""}`} action={<div className="row gap">{versions.length > 0 && <select className="entity" style={inp} value={v ?? ""} onChange={(e) => setVid(e.target.value)}>{versions.map((x) => <option key={x.id} value={x.id}>v{x.version} · {x.status}</option>)}</select>}<button className="btn btn-s" onClick={regen} disabled={!v}><RefreshCw size={14} /> Regenerate</button><button className="btn btn-s" onClick={showDiff} disabled={!v}><GitBranch size={14} /> Diff vs previous</button><a className="btn btn-s" href={`${API_URL}/policy-versions/${v}/document`} target="_blank" rel="noreferrer" onClick={(e) => { e.preventDefault(); const w = window.open("", "_blank"); if (w) { w.document.write(`<!doctype html><title>IPS</title><style>body{font-family:Georgia,serif;max-width:860px;margin:32px auto;line-height:1.6;padding:0 16px}table{border-collapse:collapse;width:100%;font-family:system-ui;font-size:12.5px}th,td{border-bottom:1px solid #E3E6EB;padding:6px 8px;text-align:left}</style>${html}`); w.document.close(); w.print(); } }}><ScrollText size={14} /> Print / PDF</a></div>}>
      {diff && <div style={{ marginBottom: 12 }}><b>Changed clauses</b>{!diff.length ? <div className="small mute">No differences from the previous version.</div> : <table className="tbl"><thead><tr><th>Section</th><th>Clause</th><th>Before</th><th>After</th></tr></thead><tbody>{diff.map((x, i) => <tr key={i}><td className="mute">{label(x.section)}</td><td>{label(x.key)}</td><td className="small">{val(x.before)}</td><td className="small"><b>{val(x.after)}</b></td></tr>)}</tbody></table>}</div>}
      {!html ? <div className="small mute">Rendering…</div> : <div className="src" style={{ fontFamily: "Georgia, serif", lineHeight: 1.6 }} dangerouslySetInnerHTML={{ __html: html }} />}
    </Card>
  </>;
}
