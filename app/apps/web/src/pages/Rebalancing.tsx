import { useState } from "react";
import { Plus, Play, Fingerprint, Scale, CalendarDays, RefreshCw } from "lucide-react";
import { useApi } from "../lib/useApi";
import { api, inr, session } from "../lib/api";
import { Card, Pill, Status, fmtDate } from "../components";
import { ExitLoadLoader } from "./Global";

const TABS = ["Programs & triggers", "Funding needs", "Plan", "Calendar", "History"] as const;
const inp = { background: "#fff", color: "var(--ink)", borderColor: "var(--line)" } as const;
const label = (s: string | null | undefined) => (s ?? "").replace(/_/g, " ");
const tone = (s?: string | null) => s === "funded" || s === "met" || s === "converted" || s === "completed" || s === "executed" || s === "in_band" ? "teal" : s === "partially_funded" || s === "in_review" || s === "due" || s === "plan_drafted" || s === "warning" ? "amber" : s === "planned" || s === "draft" || s === "approved" || s === "executing" || s === "intent_created" || s === "plan_approved" ? "blue" : s === "cancelled" || s === "breach" ? "red" : undefined;
function Field({ label: l, children }: { label: string; children: React.ReactNode }) { return <label className="field">{l}{children}</label>; }
const KIND_TONE = (k: string) => (k === "need" ? "amber" : k === "move" ? "blue" : k === "milestone" || k === "calendar_run" ? "teal" : undefined);

export function Rebalancing() {
  const [tab, setTab] = useState<(typeof TABS)[number]>("Plan"); const [tick, setTick] = useState(0); const bump = () => setTick((t) => t + 1);
  return (<>
    <div className="tabs">{TABS.map((t) => <button key={t} className={tab === t ? "on" : ""} onClick={() => setTab(t)}>{t}</button>)}</div>
    {tab === "Programs & triggers" && <Programs key={tick} onChange={bump} onPlan={() => { bump(); setTab("Plan"); }} />}
    {tab === "Funding needs" && <Needs key={tick} onChange={bump} />}
    {tab === "Plan" && <><Plan key={tick} onChange={bump} /><ExitLoadLoader /></>}
    {tab === "Calendar" && <Calendar key={tick} />}
    {tab === "History" && <History key={tick} onOpen={() => setTab("Plan")} />}
  </>);
}

function Programs({ onChange, onPlan }: { onChange: () => void; onPlan: () => void }) {
  const list = useApi<any[]>("/rebalance/programs"); const ents = useApi<any[]>("/entities"); const goals = useApi<any[]>("/goals");
  const [err, setErr] = useState(""); const [busy, setBusy] = useState(""); const [creating, setCreating] = useState(false); const [f, setF] = useState<any>({ scope: "goal", entity_id: "", goal_id: "" }); const [obj, setObj] = useState("needs_plus_bands");
  const call = async (l: string, fn: () => Promise<unknown>) => { setBusy(l); setErr(""); try { await fn(); list.refetch(); onChange(); } catch (e: any) { setErr(e.message); } finally { setBusy(""); } };
  const trig = (p: any) => [p.calendar_rrule ? `calendar ${p.calendar_rrule.replace("FREQ=", "").toLowerCase()}` : null, p.band_trigger ? "band breach" : null, p.drift_threshold_pp ? `drift > ${p.drift_threshold_pp} pp` : null, ...(p.milestone_triggers ?? []).map((m: any) => `${label(m.kind)}${m.value != null ? ` ${m.value}` : ""}`), `need in ${p.need_lookahead_days} d`, p.large_flow_pct ? `flow > ${p.large_flow_pct}%` : null, p.tax_year_end ? "tax year-end" : null].filter(Boolean).join(" · ");
  const cons = (c: any) => [c.min_trade ? `min ${inr(c.min_trade)}` : null, c.max_turnover_pct ? `turnover ≤ ${c.max_turnover_pct}%/run` : null, c.avoid_exit_load ? "avoid exit loads" : null, c.respect_lock_in ? "respect lock-ins" : null, c.prefer_new_cash ? "new cash first" : null, c.tax_aware ? "tax-aware" : null, c.ltcg_wait_days ? `LTCG wait ≤ ${c.ltcg_wait_days} d` : null].filter(Boolean).join(" · ");
  if (!list.data) return <Status loading={list.loading} error={list.error} />;
  return (<>
    {err && <div className="err">{err}</div>}
    <Card title="Rebalancing programs" action={<div className="row gap"><select className="entity" style={inp} value={obj} onChange={(e) => setObj(e.target.value)}>{["needs_plus_bands", "back_to_target", "to_band_edge", "fund_needs_only", "glide_step"].map((o) => <option key={o} value={o}>{label(o)}</option>)}</select><button className="btn btn-s" disabled={!!busy} onClick={() => call("eval", () => api("/rebalance/evaluate", { method: "POST", body: "{}" }))}><RefreshCw size={14} /> Evaluate triggers now</button><button className="btn btn-s btn-p" onClick={() => setCreating(!creating)}><Plus size={14} /> New program</button></div>}>
      {creating && <div className="row gap" style={{ flexWrap: "wrap", marginBottom: 12, alignItems: "flex-end" }}>
        <Field label="Scope"><select style={inp} value={f.scope} onChange={(e) => setF({ ...f, scope: e.target.value })}>{["family", "entity", "goal"].map((s) => <option key={s}>{s}</option>)}</select></Field>
        {f.scope === "entity" && <Field label="Entity"><select style={inp} value={f.entity_id} onChange={(e) => setF({ ...f, entity_id: e.target.value })}><option value="">—</option>{(ents.data ?? []).map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}</select></Field>}
        {f.scope === "goal" && <Field label="Goal"><select style={inp} value={f.goal_id} onChange={(e) => setF({ ...f, goal_id: e.target.value })}><option value="">—</option>{(goals.data ?? []).map((g) => <option key={g.id} value={g.id}>{g.name} ({g.target_year})</option>)}</select></Field>}
        <button className="btn btn-p" disabled={!!busy} onClick={() => call("create", async () => { await api("/rebalance/programs", { method: "POST", body: JSON.stringify({ scope: f.scope, entity_id: f.entity_id || undefined, goal_id: f.goal_id || undefined }) }); setCreating(false); })}>Create from the policy's rebalancing clause</button>
      </div>}
      <div style={{ overflowX: "auto" }}><table className="tbl"><thead><tr><th>Program</th><th>Scope</th><th>Triggers</th><th>Constraints</th><th>Next</th><th>Last run</th><th></th></tr></thead>
        <tbody>{list.data.map((p) => <tr key={p.id}><td><b>{p.name}</b><div className="small mute">{p.policy_name ?? "no policy"}{!p.active ? " · paused" : ""}</div></td><td><Pill>{p.scope}</Pill></td><td className="small">{trig(p)}</td><td className="small mute">{cons(p.constraints ?? {})}</td><td className="small">{p.next_calendar_run ? fmtDate(p.next_calendar_run) : "on trigger"}</td><td className="small mute">{p.last_run ? `${fmtDate(p.last_run.run_at)} · ${label(p.last_run.triggered_by)} · ${label(p.last_run.status)}` : "—"}</td>
          <td><div className="row gap"><button className="btn btn-s" disabled={!!busy} onClick={() => call("run", async () => { await api(`/rebalance/programs/${p.id}/run`, { method: "POST", body: JSON.stringify({ objective: obj }) }); onPlan(); })}><Play size={12} /> Run</button><button className="btn btn-s" disabled={!!busy} onClick={() => call("toggle", () => api(`/rebalance/programs/${p.id}`, { method: "PATCH", body: JSON.stringify({ active: !p.active }) }))}>{p.active ? "Pause" : "Resume"}</button></div></td></tr>)}</tbody></table></div>
      <div className="small mute" style={{ marginTop: 10 }}>Triggers: calendar (RRULE), band breach, drift threshold, milestones (years-to-go, funded %, glide step, life event, net-worth crossing, age), funding need inside the look-ahead, large inflow/outflow, tax year-end, policy change, manual. Programs are owned by the policy's rebalancing clause; the nightly job evaluates them at 23:55 IST.</div>
    </Card>
  </>);
}

function Needs({ onChange }: { onChange: () => void }) {
  const needs = useApi<any[]>("/funding-needs"); const ents = useApi<any[]>("/entities");
  const [err, setErr] = useState(""); const [busy, setBusy] = useState(""); const [adding, setAdding] = useState(false); const [f, setF] = useState<any>({ entity_id: "", kind: "planned_expense", label: "", need_date: "", amount: "", priority: 2, flexibility_days: 0 });
  const call = async (l: string, fn: () => Promise<unknown>) => { setBusy(l); setErr(""); try { await fn(); needs.refetch(); onChange(); } catch (e: any) { setErr(e.message); } finally { setBusy(""); } };
  if (!needs.data) return <Status loading={needs.loading} error={needs.error} />;
  const partly = needs.data.filter((n) => n.status === "partially_funded").length, open = needs.data.filter((n) => n.shortfall > 0 && !["met", "funded"].includes(n.status)).length;
  const cov = (n: any) => { const parts = (n.coverage ?? []).map((c: any) => (c.source === "cash" ? `cash ${inr(c.amount)}` : `move ${c.what ? `“${c.what.slice(0, 40)}”` : ""} ${inr(c.amount)} (${fmtDate(c.available_on)})`)); if (n.funded_amount > 0) parts.unshift(`funded ${inr(n.funded_amount)}`); if (n.shortfall > 0) parts.push(`shortfall ${inr(n.shortfall)}`); return parts.join(" + ") || "—"; };
  return (<>
    {err && <div className="err">{err}</div>}
    <Card title="Dated funding needs — auto-gathered + manual" action={<div className="row gap">{partly > 0 && <Pill tone="amber">{partly} partially funded</Pill>}{open > 0 && <Pill tone="red">{open} with a gap</Pill>}<button className="btn btn-s" disabled={!!busy} onClick={() => call("gather", () => api("/funding-needs/gather", { method: "POST", body: "{}" }))}><RefreshCw size={14} /> Gather</button><button className="btn btn-s btn-p" onClick={() => setAdding(!adding)}><Plus size={14} /> Add need</button></div>}>
      {adding && <div className="row gap" style={{ flexWrap: "wrap", marginBottom: 12, alignItems: "flex-end" }}>
        <Field label="Entity"><select style={inp} value={f.entity_id} onChange={(e) => setF({ ...f, entity_id: e.target.value })}><option value="">—</option>{(ents.data ?? []).map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}</select></Field>
        <Field label="Kind"><select style={inp} value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>{["planned_expense", "distribution_to_family", "tax_instalment", "capital_call", "liability_payment", "insurance_premium", "goal_drawdown", "buffer_rebuild", "other"].map((k) => <option key={k} value={k}>{label(k)}</option>)}</select></Field>
        <Field label="Label"><input style={inp} value={f.label} onChange={(e) => setF({ ...f, label: e.target.value })} /></Field><Field label="Date"><input style={inp} type="date" value={f.need_date} onChange={(e) => setF({ ...f, need_date: e.target.value })} /></Field><Field label="Amount"><input style={{ ...inp, width: 110 }} type="number" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} /></Field>
        <Field label="Priority"><select style={inp} value={f.priority} onChange={(e) => setF({ ...f, priority: Number(e.target.value) })}><option value={1}>hard</option><option value={2}>firm</option><option value={3}>soft</option></select></Field><Field label="Flexibility (days)"><input style={{ ...inp, width: 80 }} type="number" value={f.flexibility_days} onChange={(e) => setF({ ...f, flexibility_days: Number(e.target.value) })} /></Field>
        <button className="btn btn-p" disabled={!!busy || !f.entity_id || !f.label || !f.need_date || !f.amount} onClick={() => call("add", async () => { await api("/funding-needs", { method: "POST", body: JSON.stringify({ ...f, amount: Number(f.amount) }) }); setAdding(false); })}>Add</button>
      </div>}
      <div style={{ overflowX: "auto" }}><table className="tbl"><thead><tr><th>Need date</th><th>Kind</th><th>Need</th><th className="num">Amount</th><th>Priority</th><th>Coverage</th><th>Status</th><th></th></tr></thead>
        <tbody>{needs.data.map((n) => <tr key={n.id}><td>{fmtDate(n.need_date)}{n.flexibility_days ? <span className="small mute"> +{n.flexibility_days} d</span> : null}</td><td><Pill>{label(n.kind)}</Pill></td><td><b>{n.label}</b><div className="small mute">{n.entity_name}{n.goal_name ? ` · ${n.goal_name}` : ""} · {label(n.source_type)}</div></td><td className="num">{inr(n.amount)}</td><td>{n.priority === 1 ? "hard" : n.priority === 2 ? "firm" : "soft"}</td><td className="small">{cov(n)}</td><td><Pill tone={tone(n.status)}>{label(n.status)}</Pill></td>
          <td>{!["met", "cancelled"].includes(n.status) && <div className="row gap"><button className="btn btn-s" disabled={!!busy} onClick={() => call("met", () => api(`/funding-needs/${n.id}`, { method: "PATCH", body: JSON.stringify({ status: "met", funded_amount: n.amount }) }))}>Met</button>{n.source_type === "manual" && <button className="btn btn-s" disabled={!!busy} onClick={() => call("del", () => api(`/funding-needs/${n.id}`, { method: "DELETE" }))}>×</button>}</div>}</td></tr>)}</tbody></table></div>
      <div className="small mute" style={{ marginTop: 10 }}>Sources: committed outflows (advance tax, GST, drawdowns, EMIs), fund commitment schedules, liability schedules, premiums, goals inside three years, working-capital float rebuilds, manual. The engine funds needs in priority order — idle cash → maturities → redirected SIPs → tax-aware sales — timed to settle before the date.</div>
    </Card>
  </>);
}

function Plan({ onChange }: { onChange: () => void }) {
  const runs = useApi<any[]>("/rebalance/runs?limit=30");
  const [pick, setPick] = useState<string | null>(null);
  const openRuns = runs.data?.filter((r) => r.plan_id) ?? []; const runId = pick ?? openRuns.find((r) => ["draft", "in_review", "approved"].includes(r.plan_status))?.id ?? openRuns[0]?.id ?? null;
  const run = runs.data?.find((r) => r.id === runId); const plan = useApi<any>(run?.plan_id ? `/rebalance/plans/${run.plan_id}` : null);
  const [sel, setSel] = useState<string | null>(null); const [err, setErr] = useState(""); const [busy, setBusy] = useState(""); const [proof, setProof] = useState("000000"); const [note, setNote] = useState(""); const [excluded, setExcluded] = useState<string[]>([]); const [dates, setDates] = useState<Record<string, string>>({});
  const role = session.get()?.families.find((f) => f.id === session.family())?.role;
  const call = async (l: string, fn: () => Promise<unknown>) => { setBusy(l); setErr(""); try { await fn(); runs.refetch(); plan.refetch(); onChange(); } catch (e: any) { setErr(e.message); } finally { setBusy(""); } };
  if (!runs.data) return <Status loading={runs.loading} error={runs.error} />;
  if (!run) return <Card title="Plan"><div className="small mute">No plan yet. Run a program from Programs & triggers or wait for the nightly evaluation.</div></Card>;
  const p = plan.data; const mv = p?.moves.find((m: any) => m.id === sel) ?? p?.moves.find((m: any) => m.kind !== "hold_cash") ?? p?.moves[0];
  const editable = p && ["draft", "in_review"].includes(p.status); const sim = p?.simulation;
  return (<>
    {err && <div className="err">{err}</div>}
    <div className="row gap" style={{ marginBottom: 10, flexWrap: "wrap" }}><select className="entity" style={inp} value={runId ?? ""} onChange={(e) => { setPick(e.target.value); setSel(null); setExcluded([]); setDates({}); }}>{openRuns.map((r) => <option key={r.id} value={r.id}>{fmtDate(r.run_at)} · {r.program_name} · {label(r.triggered_by)} · plan v{r.plan_version} {label(r.plan_status)}</option>)}</select></div>
    {!p ? <Status loading={plan.loading} error={plan.error} /> : <>
      <div className="kpis" style={{ gridTemplateColumns: "repeat(5, 1fr)" }}>
        <Card><div className="mute small">Run · {fmtDate(p.run_at)}</div><div className="small" style={{ marginTop: 6 }}>Trigger: <b>{label(p.triggered_by)}</b>{p.trigger_detail?.also?.length ? ` + ${p.trigger_detail.also.map(label).join(", ")}` : ""}{p.trigger_detail?.needs?.length ? ` (${p.trigger_detail.needs[0].label} in ${Math.round((Date.parse(p.trigger_detail.needs[0].date) - Date.parse(p.run_at)) / 86400000)} d)` : ""}</div></Card>
        <Card><div className="mute small">Objective</div><div className="hero-num" style={{ fontSize: 16 }}>{label(p.objective)}</div><div className="small mute">{p.program_name}</div></Card>
        <Card><div className="mute small">Turnover</div><div className="hero-num">{inr(p.summary.turnover)}</div><div className="small mute">{p.summary.turnover_pct}% of scope</div></Card>
        <Card><div className="mute small">Est. tax</div><div className={`hero-num ${Number(p.summary.est_tax) === 0 ? "up" : ""}`}>{inr(p.summary.est_tax)}</div><div className="small mute">costs {inr(p.summary.est_costs)}{p.summary.exit_loads_avoided ? ` · ${p.summary.exit_loads_avoided} exit load${p.summary.exit_loads_avoided > 1 ? "s" : ""} avoided` : ""}</div></Card>
        <Card><div className="mute small">After plan</div><div className="small" style={{ marginTop: 6 }}>Needs covered {p.summary.needs_covered}/{p.summary.needs_covered + p.summary.needs_uncovered} · max drift {p.summary.drift_after_max_pp} pp (was {p.summary.drift_before_max_pp}) {sim?.compliance_after && <Pill tone={tone(sim.compliance_after.overall)}>{sim.compliance_after.overall}</Pill>}</div></Card>
      </div>
      <div className="grid-2">
        <Card title={`Plan v${p.version} — timed moves`} action={<div className="row gap" style={{ flexWrap: "wrap" }}><Pill tone={tone(p.status)}>{label(p.status)}</Pill>
          {editable && (excluded.length > 0 || Object.keys(dates).length > 0) && <button className="btn btn-s" disabled={!!busy} onClick={() => call("edit", async () => { const r = await api<any>(`/rebalance/plans/${p.id}`, { method: "PATCH", body: JSON.stringify({ exclude_move_ids: excluded, moves: Object.entries(dates).map(([id, d]) => ({ id, planned_date: d })) }) }); setExcluded([]); setDates({}); setPick(r.run_id); })}>Re-solve → v{p.version + 1}</button>}
          {p.status === "draft" && <button className="btn btn-s" disabled={!!busy} onClick={() => call("review", () => api(`/rebalance/plans/${p.id}/status`, { method: "POST", body: JSON.stringify({ status: "in_review" }) }))}>Send for review</button>}
          {p.status === "in_review" && <><input className="entity" style={{ ...inp, width: 90 }} value={proof} onChange={(e) => setProof(e.target.value)} title="step-up code" /><button className="btn btn-s btn-p" disabled={!!busy || !["owner", "member"].includes(role ?? "")} onClick={() => call("approve", () => api(`/rebalance/plans/${p.id}/status`, { method: "POST", body: JSON.stringify({ status: "approved", auth_method: "totp", auth_proof: proof, note: note || undefined, override_breach: !!note }) }))}><Fingerprint size={14} /> Approve</button></>}
          {p.status === "approved" && <button className="btn btn-s btn-p" disabled={!!busy} onClick={() => call("convert", () => api(`/rebalance/plans/${p.id}/status`, { method: "POST", body: JSON.stringify({ status: "converted" }) }))}>Convert → scheduled intents</button>}
          {editable && <button className="btn btn-s" disabled={!!busy} onClick={() => call("cancel", () => api(`/rebalance/plans/${p.id}/status`, { method: "POST", body: JSON.stringify({ status: "cancelled" }) }))}>Cancel</button>}
          <button className="btn btn-s" disabled={!!busy} onClick={() => call("sim", () => api(`/rebalance/plans/${p.id}/simulate`, { method: "POST", body: "{}" }))}>Simulate</button></div>}>
          {p.moves.map((m: any) => <div key={m.id} className="attn" style={{ cursor: "pointer", background: mv?.id === m.id ? "var(--paper, #F5F6F8)" : undefined, opacity: excluded.includes(m.id) ? 0.5 : 1 }} onClick={() => setSel(m.id)}>
            <div style={{ flex: 1 }}><div className="row" style={{ justifyContent: "space-between" }}><b>#{m.seq} · {m.what}</b><span className="num">{inr(m.amount)}</span></div><div className="row gap small mute" style={{ flexWrap: "wrap" }}><Pill>{label(m.kind)}</Pill><span>{m.entity_name}</span><span>·</span><span><CalendarDays size={11} /> {fmtDate(m.planned_date)}{m.settles_on !== m.planned_date ? ` → settles ${fmtDate(m.settles_on)}` : ""}</span><span>·</span><span>{m.reason}</span><Pill tone={tone(m.status)}>{label(m.status)}</Pill></div></div>
            {editable && m.kind !== "hold_cash" && <label className="small mute" onClick={(e) => e.stopPropagation()}><input type="checkbox" checked={excluded.includes(m.id)} onChange={(e) => setExcluded(e.target.checked ? [...excluded, m.id] : excluded.filter((x) => x !== m.id))} /> exclude</label>}
          </div>)}
          {p.warnings?.length > 0 && <div className="small" style={{ marginTop: 8, color: "var(--amber, #B7791F)" }}>{p.warnings.map((w: string, i: number) => <div key={i}>⚠ {w}</div>)}</div>}
          {p.status === "in_review" && <Field label="Approval note (required to override a new breach)"><input style={{ ...inp, width: "100%" }} value={note} onChange={(e) => setNote(e.target.value)} /></Field>}
          <div className="small mute" style={{ marginTop: 8 }}>Approving needs step-up auth; converting creates action-plane intents held by the executor until each planned date (09:00 IST); moves without a connector become assisted instructions dated the same way. Versions: {p.versions.map((v: any) => `v${v.version} ${label(v.status)}`).join(" · ")}.</div>
        </Card>
        {mv && <Card title={`Move #${mv.seq} — ${mv.what}`}>
          <table className="tbl"><tbody>
            <tr><td className="mute">Planned date · settles</td><td>{fmtDate(mv.planned_date)} · {fmtDate(mv.settles_on)}{editable && mv.kind !== "hold_cash" && <> <input type="date" style={{ ...inp, marginLeft: 8 }} value={dates[mv.id] ?? mv.planned_date} min={mv.earliest_date} max={mv.latest_date ?? undefined} onChange={(e) => setDates({ ...dates, [mv.id]: e.target.value })} /></>}</td></tr>
            <tr><td className="mute">Window</td><td className="small">earliest {fmtDate(mv.earliest_date)} · latest {mv.latest_date ? fmtDate(mv.latest_date) : "open"} — planned = latest feasible so money stays invested longest</td></tr>
            <tr><td className="mute">Reason</td><td>{mv.reason}{mv.need_label ? ` · ${mv.need_label} (${fmtDate(mv.need_date)})` : ""}</td></tr>
            <tr><td className="mute">Tax</td><td>{mv.est_gain ? `${mv.est_gain >= 0 ? "gain" : "loss"} ${inr(Math.abs(mv.est_gain))} → tax ${inr(mv.est_tax)}` : "none"}{mv.exit_load ? ` · exit load ${inr(mv.exit_load)}` : ""}{mv.est_cost ? ` · costs ${inr(mv.est_cost)}` : ""}</td></tr>
            {mv.intent_id && <tr><td className="mute">Intent</td><td>{label(mv.intent_status)} · <a href="/action-plane">action plane</a></td></tr>}
            {mv.executed_on && <tr><td className="mute">Executed</td><td>{fmtDate(mv.executed_on)} · {label(mv.executed_ref_type)}</td></tr>}
          </tbody></table>
          <b className="small">Constraint checks (solver trace)</b>
          {(mv.constraints_checked ?? []).map((c: string, i: number) => <div key={i} className="attn"><Scale size={13} color={/skipped|✗|outside|cannot/.test(c) ? "var(--amber, #B7791F)" : "var(--teal, #0E7C6B)"} /><span className="small">{c}</span></div>)}
          {sim?.cash_timeline?.length > 0 && <div className="small mute" style={{ marginTop: 8 }}>Cash timeline: {sim.cash_timeline.slice(0, 8).map((t: any) => `${fmtDate(t.date)} ${t.event} → ${inr(t.balance)}`).join(" · ")}</div>}
        </Card>}
      </div>
      {p.allocation_after?.length > 0 && <Card title="Allocation after the plan"><table className="tbl"><thead><tr><th>Class</th><th className="num">Before</th><th className="num">After</th><th className="num">Target</th><th className="num">Band</th><th></th></tr></thead><tbody>{p.allocation_after.map((a: any) => <tr key={a.key}><td>{label(a.key)}</td><td className="num">{a.before_pct}%</td><td className="num"><b>{a.actual_pct}%</b></td><td className="num">{a.target}%</td><td className="num">{a.min ?? "—"}–{a.max ?? "—"}</td><td><Pill tone={tone(a.status)}>{label(a.status)}</Pill></td></tr>)}</tbody></table></Card>}
    </>}
  </>);
}

function Calendar() {
  const [from, setFrom] = useState(new Date(Date.now() - 14 * 86400000).toISOString().slice(0, 10)); const [to, setTo] = useState(new Date(Date.now() + 400 * 86400000).toISOString().slice(0, 10));
  const cal = useApi<any[]>(`/rebalance/calendar?from=${from}&to=${to}`, [from, to]);
  return <Card title="Timing calendar — moves, settlements, needs, runs, milestones, lot gates" action={<div className="row gap small"><input type="date" style={inp} value={from} onChange={(e) => setFrom(e.target.value)} /><input type="date" style={inp} value={to} onChange={(e) => setTo(e.target.value)} /></div>}>
    {!cal.data ? <Status loading={cal.loading} error={cal.error} /> : <table className="tbl"><thead><tr><th style={{ width: 110 }}>Date</th><th>Kind</th><th>Item</th><th className="num">Amount</th></tr></thead><tbody>{cal.data.map((r, i) => <tr key={i}><td>{fmtDate(r.date)}</td><td><Pill tone={KIND_TONE(r.kind)}>{label(r.kind)}</Pill></td><td>{r.label}</td><td className="num">{r.amount != null ? inr(r.amount) : ""}</td></tr>)}{!cal.data.length && <tr><td colSpan={4} className="small mute">Nothing dated in this window.</td></tr>}</tbody></table>}
  </Card>;
}
function History({ onOpen }: { onOpen: () => void }) {
  const runs = useApi<any[]>("/rebalance/runs?limit=100");
  return <Card title="Runs — history">{!runs.data ? <Status loading={runs.loading} error={runs.error} /> : <table className="tbl"><thead><tr><th>Run</th><th>Program</th><th>Trigger</th><th>Outcome</th><th className="num">Turnover</th><th className="num">Tax</th></tr></thead><tbody>{runs.data.map((r) => <tr key={r.id} style={{ cursor: r.plan_id ? "pointer" : undefined }} onClick={() => r.plan_id && onOpen()}><td>{fmtDate(r.run_at)}</td><td>{r.program_name}</td><td className="small">{label(r.triggered_by)}{r.trigger_detail?.also?.length ? ` + ${r.trigger_detail.also.map(label).join(", ")}` : ""}</td><td><Pill tone={tone(r.plan_status ?? r.status)}>{r.plan_id ? `plan v${r.plan_version} ${label(r.plan_status)}${r.moves ? ` · ${r.executed}/${r.moves} executed` : ""}` : `${label(r.status)}${r.drift?.max_pp != null ? ` · drift ${r.drift.max_pp} pp` : ""}`}</Pill>{r.note && <div className="small mute">{r.note}</div>}</td><td className="num">{r.plan_summary ? inr(r.plan_summary.turnover) : "—"}</td><td className="num">{r.plan_summary ? inr(r.plan_summary.est_tax) : "—"}</td></tr>)}</tbody></table>}</Card>;
}
