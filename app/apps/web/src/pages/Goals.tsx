import { useState } from "react";
import { Plus, RefreshCw } from "lucide-react";
import { useApi } from "../lib/useApi";
import { api, inr, session } from "../lib/api";
import { Card, Pill, Status } from "../components";

// Goals & buckets (PRD 3.5; FO-44, 45): the three-bucket strategy with editable targets, the asset-class lens on the model with bands and
// look-through, goals with inflation-adjusted need / funded % / monthly required, glide paths that only de-risk, and the rebalance proposal.
const BC: Record<string, string> = { liquidity: "var(--blue)", income: "var(--teal)", growth: "var(--violet)" };
const inp = { background: "#fff", color: "var(--ink)", borderColor: "var(--line)" } as const;
const role = () => session.get()?.families.find((f) => f.id === session.family())?.role ?? "viewer";
const canWrite = () => ["owner", "member", "operator"].includes(role()); const isMember = () => ["owner", "member"].includes(role());
const label = (s?: string | null) => (s ?? "").replace(/_/g, " ");
function Field({ label, children }: { label: string; children: React.ReactNode }) { return <label className="field">{label}{children}</label>; }
function useAction(after?: () => void) {
  const [busy, setBusy] = useState(""); const [err, setErr] = useState(""); const [note, setNote] = useState("");
  const run = async (l: string, fn: () => Promise<string | void>) => { setBusy(l); setErr(""); setNote(""); try { const n = await fn(); if (n) setNote(n); after?.(); } catch (e: any) { setErr(e.message); } finally { setBusy(""); } };
  return { busy, err, note, run, msg: <>{err && <div className="err">{err}</div>}{note && <div className="small" style={{ color: "var(--teal)" }}>{note}</div>}</> };
}

export function Goals() {
  const [tick, setTick] = useState(0); const refresh = () => setTick((t) => t + 1);
  return (<>
    <div className="grid-2"><Buckets key={`b${tick}`} onChange={refresh} /><AssetClassLens key={`a${tick}`} onChange={refresh} /></div>
    <div className="grid-2"><GoalList key={`g${tick}`} onChange={refresh} /><Proposal key={`p${tick}`} onChange={refresh} /></div>
    <GlidePaths key={`gp${tick}`} />
  </>);
}

function Buckets({ onChange }: { onChange: () => void }) {
  const t = useApi<any>("/bucket-targets"); const d = useApi<any[]>("/buckets/drift"); const [edit, setEdit] = useState(false); const [f, setF] = useState<any>(null); const act = useAction(onChange);
  if (t.loading || t.error) return <Status loading={t.loading} error={t.error} />;
  const cur = f ?? { liquidity_pct: t.data.liquidity_pct, income_pct: t.data.income_pct, growth_pct: t.data.growth_pct, drift_threshold_pp: t.data.drift_threshold_pp };
  const sum = Number(cur.liquidity_pct) + Number(cur.income_pct) + Number(cur.growth_pct);
  return (<Card title="Strategy: how the three buckets are funded" action={isMember() ? <button className="btn btn-s" onClick={() => setEdit(!edit)}>{edit ? "Close" : "Edit targets"}</button> : undefined}>
    <div className="bucket-bar">{(d.data ?? []).map((b) => <div key={b.bucket} className="bucket-seg" style={{ width: `${Math.max(b.actualPct, 3)}%`, background: BC[b.bucket] }}>{b.bucket} {b.actualPct}%</div>)}</div>
    <div className="bucket-target">{(d.data ?? []).map((b) => <div key={b.bucket} style={{ width: `${b.targetPct}%`, borderColor: BC[b.bucket] }} />)}</div>
    <table className="tbl tight" style={{ marginTop: 10 }}><thead><tr><th>Bucket</th><th className="num">Target</th><th className="num">Actual</th><th className="num">Drift</th><th className="num">Value</th></tr></thead><tbody>{(d.data ?? []).map((b) => <tr key={b.bucket}><td style={{ textTransform: "capitalize" }}><span className="dot sm" style={{ background: BC[b.bucket] }} />{b.bucket}</td><td className="num">{b.targetPct}%</td><td className="num">{b.actualPct}%</td><td className="num"><Pill tone={b.breached ? "amber" : "teal"}>{b.driftPp > 0 ? "+" : ""}{b.driftPp} pp</Pill></td><td className="num">{inr(b.value)}</td></tr>)}</tbody></table>
    <div className="small mute" style={{ marginTop: 6 }}>Targets effective {String(t.data.effective_from).slice(0, 10)} · drift threshold {t.data.drift_threshold_pp} pp{t.data.inherited ? " · inherited from the family" : ""}</div>
    {edit && <div style={{ marginTop: 10 }}>
      <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>{(["liquidity_pct", "income_pct", "growth_pct", "drift_threshold_pp"] as const).map((k) => <Field key={k} label={label(k.replace("_pct", " %").replace("_pp", " pp"))}><input style={{ ...inp, width: 90 }} type="number" step="0.5" value={cur[k]} onChange={(e) => setF({ ...cur, [k]: e.target.value })} /></Field>)}</div>
      <div className="row gap" style={{ marginTop: 8 }}><button className="btn" disabled={Math.abs(sum - 100) > 0.01 || !!act.busy} onClick={() => act.run("save", async () => { await api("/bucket-targets", { method: "PUT", body: JSON.stringify({ liquidity_pct: +cur.liquidity_pct, income_pct: +cur.income_pct, growth_pct: +cur.growth_pct, drift_threshold_pp: +cur.drift_threshold_pp }) }); setEdit(false); setF(null); return "Targets saved — the drift view and the nightly generators use them from today"; })}>Save targets</button><span className="small mute">{Math.abs(sum - 100) > 0.01 ? `adds to ${sum}% — must total 100` : "totals 100%"}</span></div>
    </div>}
    {act.msg}
  </Card>);
}

function AssetClassLens({ onChange }: { onChange: () => void }) {
  const [lt, setLt] = useState(true); const st = useApi<any>(`/allocation/status?look_through=${lt}`); const pol = useApi<any>("/allocation/policy"); const models = useApi<any[]>("/model-portfolios"); const act = useAction(onChange);
  const [bands, setBands] = useState<Record<string, { target_pct: string; min_pct: string; max_pct: string }> | null>(null); const [model, setModel] = useState("");
  if (st.loading || st.error) return <Status loading={st.loading} error={st.error} />;
  const s = st.data; const rows: any[] = s.rows ?? [];
  const startEdit = () => setBands(Object.fromEntries(rows.map((r) => [r.alloc_class, { target_pct: String(r.target_pct ?? ""), min_pct: String(r.min_pct ?? ""), max_pct: String(r.max_pct ?? "") }])));
  return (<Card title={`Asset-class lens — ${s.model ?? "no model"}${s.strategy ? `, ${s.strategy}` : ""}, ${lt ? "look-through" : "headline"}`} action={<div className="row gap"><button className="btn btn-s" onClick={() => setLt(!lt)}>{lt ? "Headline" : "Look-through"}</button>{isMember() && <button className="btn btn-s" onClick={() => (bands ? setBands(null) : startEdit())}>{bands ? "Close" : "Edit bands"}</button>}</div>}>
    <table className="tbl tight"><thead><tr><th>Class</th><th className="num">Target</th><th className="num">Band</th><th className="num">Headline</th><th className="num">Look-through</th><th>Status</th></tr></thead>
      <tbody>{rows.map((r) => <tr key={r.alloc_class}><td><b style={{ textTransform: "capitalize" }}>{label(r.alloc_class)}</b></td>
        <td className="num">{bands ? <input style={{ ...inp, width: 60 }} value={bands[r.alloc_class].target_pct} onChange={(e) => setBands({ ...bands, [r.alloc_class]: { ...bands[r.alloc_class], target_pct: e.target.value } })} /> : r.target_pct == null ? "—" : `${r.target_pct}%`}</td>
        <td className="num mute">{bands ? <span className="row gap"><input style={{ ...inp, width: 50 }} value={bands[r.alloc_class].min_pct} onChange={(e) => setBands({ ...bands, [r.alloc_class]: { ...bands[r.alloc_class], min_pct: e.target.value } })} />–<input style={{ ...inp, width: 50 }} value={bands[r.alloc_class].max_pct} onChange={(e) => setBands({ ...bands, [r.alloc_class]: { ...bands[r.alloc_class], max_pct: e.target.value } })} /></span> : r.min_pct == null ? "—" : `${r.min_pct}–${r.max_pct}%`}</td>
        <td className="num">{r.actual_pct}%</td><td className="num">{r.look_through_pct}%</td>
        <td>{r.status === "untargeted" ? <Pill>no target</Pill> : r.status === "breach" ? <Pill tone="amber">band breached</Pill> : r.status === "drift" ? <Pill tone="blue">drift {r.drift_pp > 0 ? "+" : ""}{r.drift_pp} pp</Pill> : <Pill tone="teal">in band</Pill>}</td></tr>)}</tbody></table>
    {bands && <div className="row gap" style={{ marginTop: 8 }}><button className="btn" disabled={!!act.busy} onClick={() => act.run("bands", async () => { const targets = Object.entries(bands).filter(([, v]) => v.target_pct !== "").map(([alloc_class, v]) => ({ alloc_class, target_pct: +v.target_pct, min_pct: v.min_pct === "" ? null : +v.min_pct, max_pct: v.max_pct === "" ? null : +v.max_pct })); await api("/asset-class-targets", { method: "PUT", body: JSON.stringify({ targets }) }); setBands(null); return "Bands saved"; })}>Save bands</button><span className="small mute">targets must total 100%; real estate held for income by design gets a wider band, not a higher target</span></div>}
    <div className="small mute" style={{ marginTop: 8 }}>Look-through decomposes fund-of-funds, balanced and international schemes and REITs into their underlying classes. Satellite holdings: {s.satellite_pct}% · {s.breaches} band breach{s.breaches === 1 ? "" : "es"} · total {inr(s.total)}{pol.data?.next_review_on ? ` · next policy review ${String(pol.data.next_review_on).slice(0, 10)}` : ""}</div>
    {isMember() && <div className="row gap" style={{ marginTop: 8, flexWrap: "wrap" }}>
      <select style={inp} value={model} onChange={(e) => setModel(e.target.value)}><option value="">Apply a model portfolio…</option>{(models.data ?? []).map((m) => <option key={m.id} value={m.id}>{m.name}{m.risk_profile ? ` · ${m.risk_profile}` : ""}{m.system ? " (system)" : ""}</option>)}</select>
      <button className="btn btn-s" disabled={!model || !!act.busy} onClick={() => act.run("model", async () => { await api("/allocation/policy", { method: "PUT", body: JSON.stringify({ model_portfolio_id: model }) }); setModel(""); return "Model applied — targets and bands now follow it"; })}>Apply model</button>
      {pol.data && <button className="btn btn-s" disabled={!!act.busy} onClick={() => act.run("review", async () => { await api("/allocation/policy/review", { method: "POST", body: JSON.stringify({ outcome: "confirmed", note: "Reviewed from the Goals page" }) }); return "Review recorded"; })}>Record review</button>}
    </div>}
    {act.msg}
  </Card>);
}

const EMPTY_GOAL = { name: "", entity_id: "", target_year: new Date().getFullYear() + 5, amount_today: "", inflation_pct: 6, bucket: "growth", assumed_return_pct: 11 };
function GoalList({ onChange }: { onChange: () => void }) {
  const g = useApi<any[]>("/goals"); const ents = useApi<any[]>("/entities"); const [form, setForm] = useState<any | null>(null); const [open, setOpen] = useState<string | null>(null); const act = useAction(onChange);
  if (g.loading || g.error) return <Status loading={g.loading} error={g.error} />;
  const save = () => act.run("goal", async () => { const body = { ...form, entity_id: form.entity_id || null, target_year: +form.target_year, amount_today: +form.amount_today, inflation_pct: +form.inflation_pct, assumed_return_pct: +form.assumed_return_pct }; if (form.id) await api(`/goals/${form.id}`, { method: "PATCH", body: JSON.stringify(body) }); else await api("/goals", { method: "POST", body: JSON.stringify(body) }); setForm(null); return form.id ? "Goal updated" : "Goal added"; });
  return (<Card title="Goals" action={canWrite() ? <button className="btn btn-s" onClick={() => setForm(form ? null : { ...EMPTY_GOAL })}><Plus size={14} /> Add goal</button> : undefined}>
    {form && <div className="attn" style={{ display: "block" }}>
      <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
        <Field label="Name"><input style={inp} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
        <Field label="Entity"><select style={inp} value={form.entity_id ?? ""} onChange={(e) => setForm({ ...form, entity_id: e.target.value })}><option value="">Family</option>{(ents.data ?? []).map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}</select></Field>
        <Field label="Target year"><input style={{ ...inp, width: 80 }} type="number" value={form.target_year} onChange={(e) => setForm({ ...form, target_year: e.target.value })} /></Field>
        <Field label="Amount today (₹)"><input style={{ ...inp, width: 120 }} type="number" value={form.amount_today} onChange={(e) => setForm({ ...form, amount_today: e.target.value })} /></Field>
        <Field label="Inflation %"><input style={{ ...inp, width: 60 }} type="number" step="0.5" value={form.inflation_pct} onChange={(e) => setForm({ ...form, inflation_pct: e.target.value })} /></Field>
        <Field label="Return %"><input style={{ ...inp, width: 60 }} type="number" step="0.5" value={form.assumed_return_pct} onChange={(e) => setForm({ ...form, assumed_return_pct: e.target.value })} /></Field>
        <Field label="Bucket"><select style={inp} value={form.bucket} onChange={(e) => setForm({ ...form, bucket: e.target.value })}>{["liquidity", "income", "growth"].map((b) => <option key={b}>{b}</option>)}</select></Field>
        {form.id && <Field label="Status"><select style={inp} value={form.status ?? "active"} onChange={(e) => setForm({ ...form, status: e.target.value })}>{["active", "achieved", "paused", "dropped"].map((b) => <option key={b}>{b}</option>)}</select></Field>}
      </div>
      <div className="row gap" style={{ marginTop: 8 }}><button className="btn" disabled={!form.name || !form.amount_today || !!act.busy} onClick={save}>{form.id ? "Save" : "Add"}</button><button className="btn btn-s" onClick={() => setForm(null)}>Cancel</button></div>
    </div>}
    {g.data!.map((x) => <div key={x.id} style={{ padding: "10px 0", borderBottom: "1px solid #EFF1F4" }}>
      <div className="row" style={{ justifyContent: "space-between" }}><div><b>{x.name}</b><div className="small mute">{x.target_year} · {x.entity_name ?? "Family"} · needs {inr(x.inflated_need)} (today {inr(x.amount_today)}){x.status && x.status !== "active" ? ` · ${x.status}` : ""}</div></div><div className="row gap"><Pill tone={x.on_track ? "teal" : "amber"}>{x.bucket}</Pill>{canWrite() && <button className="btn btn-s" onClick={() => setForm({ id: x.id, name: x.name, entity_id: x.entity_id ?? "", target_year: x.target_year, amount_today: Number(x.amount_today), inflation_pct: Number(x.inflation_pct ?? 6), assumed_return_pct: Number(x.assumed_return_pct ?? 11), bucket: x.bucket, status: x.status ?? "active" })}>Edit</button>}<button className="btn btn-s" onClick={() => setOpen(open === x.id ? null : x.id)}>{open === x.id ? "Less" : "More"}</button></div></div>
      <div className="prog"><div style={{ width: `${Math.min(100, x.funded_pct ?? 0)}%`, background: BC[x.bucket] }} /></div>
      <div className="small mute">{x.funded_pct ?? 0}% funded · {x.on_track ? "on track" : "behind"} · linked {inr(x.linked_value)}{Number(x.gap_at_target) > 0 ? ` · gap ${inr(x.gap_at_target)} · ${inr(x.monthly_required)} / month to close` : " · fully funded"}</div>
      {open === x.id && <GoalDetail id={x.id} onChange={onChange} />}
    </div>)}
    {act.msg}
  </Card>);
}
const linkKey = (l: any) => l.holding_id ? `holding_id:${l.holding_id}` : l.property_id ? `property_id:${l.property_id}` : l.private_investment_id ? `private_investment_id:${l.private_investment_id}` : `deposit_id:${l.deposit_id}`;
function GoalDetail({ id, onChange }: { id: string; onChange: () => void }) {
  const d = useApi<any>(`/goals/${id}`);
  const [edit, setEdit] = useState(false); const [sel, setSel] = useState<Record<string, string>>({}); const [err, setErr] = useState("");
  const hold = useApi<any>(edit ? "/holdings" : null); const props = useApi<any[]>(edit ? "/properties" : null); const priv = useApi<any[]>(edit ? "/private-investments" : null); const deps = useApi<any[]>(edit ? "/deposits" : null);
  if (d.loading || d.error) return <div className="small mute">{d.loading ? "Loading…" : d.error}</div>;
  const g = d.data;
  const options = [
    ...(hold.data?.items ?? []).map((h: any) => ({ key: `holding_id:${h.id}`, kind: "Holding", name: `${h.instrument} · ${h.entity_name}`, value: h.value })),
    ...(props.data ?? []).map((p: any) => ({ key: `property_id:${p.id}`, kind: "Property", name: p.name, value: p.current_value })),
    ...(priv.data ?? []).map((p: any) => ({ key: `private_investment_id:${p.id}`, kind: "Private stake", name: p.company, value: p.mark ?? p.amount })),
    ...(deps.data ?? []).map((x: any) => ({ key: `deposit_id:${x.id}`, kind: "Deposit", name: `${x.bank} ${x.kind.toUpperCase()}${x.account_no ? ` ${x.account_no}` : ""}`, value: x.current_value })),
  ];
  const startEdit = () => { setErr(""); setSel(Object.fromEntries((g.links ?? []).map((l: any) => [linkKey(l), String(l.allocation_pct)]))); setEdit(true); };
  const toggle = (k: string) => { const n = { ...sel }; if (k in n) delete n[k]; else n[k] = "100"; setSel(n); };
  const save = async () => {
    setErr("");
    try { await api(`/goals/${id}/links`, { method: "PUT", body: JSON.stringify(Object.entries(sel).map(([k, pct]) => { const [col, val] = k.split(":"); return { [col]: val, allocation_pct: Number(pct || 100) }; })) }); setEdit(false); d.refetch(); onChange(); }
    catch (e: any) { setErr(e.message); }
  };
  return (<div className="small" style={{ marginTop: 6 }}>
    <div>Years left {g.years_left} · assumed return {g.assumed_return_pct ?? 11}% · inflation {g.inflation_pct ?? 6}%</div>
    <div className="mute">Funded by: {(g.links ?? []).length ? g.links.map((l: any) => `${l.name ?? "asset"} (${l.allocation_pct}%)`).join(", ") : "nothing linked yet"} {canWrite() && !edit && <button className="btn btn-s" style={{ marginLeft: 6 }} onClick={startEdit}>Link assets</button>}</div>
    {edit && <div style={{ marginTop: 8, padding: 10, border: "1px solid var(--line)", borderRadius: 6, background: "var(--soft, #f4f6fa)" }}>
      <div className="mute" style={{ marginBottom: 6 }}>Tick the assets that fund this goal. The % is how much of that asset's value counts toward this goal (use less than 100 if it also funds another goal).</div>
      {!options.length && <div className="mute">Loading…</div>}
      {options.map((o) => <div key={o.key} className="row gap" style={{ alignItems: "center", marginBottom: 4 }}>
        <input type="checkbox" checked={o.key in sel} onChange={() => toggle(o.key)} />
        <span style={{ flex: 1 }}><Pill>{o.kind}</Pill> {o.name}</span><span className="mute">{inr(o.value)}</span>
        {o.key in sel && <><input style={{ ...inp, width: 64 }} type="number" min={1} max={100} value={sel[o.key]} onChange={(e) => setSel({ ...sel, [o.key]: e.target.value })} onWheel={(e) => (e.target as HTMLInputElement).blur()} />%</>}
      </div>)}
      {err && <div className="err">{err}</div>}
      <div className="row gap" style={{ justifyContent: "flex-end", marginTop: 8 }}><button className="btn btn-s" onClick={() => setEdit(false)}>Cancel</button><button className="btn btn-s btn-p" onClick={save}>Save links</button></div>
    </div>}
  </div>);
}

function Proposal({ onChange }: { onChange: () => void }) {
  const [p, setP] = useState<any | null>(null); const act = useAction();   // proposing changes nothing, so the page is not refreshed (that would remount this card and drop the proposal)
  const build = (createTasks: boolean) => act.run("prop", async () => { const r = await api<any>("/buckets/rebalance-proposal", { method: "POST", body: JSON.stringify({ create_tasks: createTasks }) }); setP(r); if (createTasks) onChange(); return createTasks ? `${r.tasks_created} task${r.tasks_created === 1 ? "" : "s"} created — execution happens on MF Central, broker or bank` : undefined; });
  return (<Card title="Rebalance proposal" action={canWrite() ? <div className="row gap"><button className="btn btn-s" disabled={!!act.busy} onClick={() => build(false)}><RefreshCw size={14} /> Propose</button>{p?.moves?.length ? <button className="btn btn-s" disabled={!!act.busy} onClick={() => build(true)}>Create tasks</button> : null}</div> : undefined}>
    {!p && <div className="small mute">Sells are ordered by the smallest taxable gain (rates from tax_rules); the destination is the under-target bucket's preferred instrument. Nothing is executed here — tasks are raised for the operator and reconcile on the next import.</div>}
    {p && <>
      {p.moves.length === 0 && <div className="small mute">{p.note}</div>}
      {p.moves.map((m: any, i: number) => <div key={i} className="attn"><span className="dot" style={{ background: BC[m.to_bucket] }} /><div style={{ flex: 1 }}><b>{inr(m.amount)} {m.from} → {m.to_instrument}</b><div className="small mute">{m.entity} · {m.from_bucket} → {m.to_bucket} · {m.term}-term gain {inr(m.est_gain)} · tax {inr(m.tax_impact)}</div><div className="small mute">{m.reason}</div></div></div>)}
      {p.moves.length > 0 && <div className="small mute" style={{ marginTop: 6 }}>Estimated tax on the proposal {inr(p.est_tax_total)} · as of {p.as_of}</div>}
    </>}
    {act.msg}
  </Card>);
}

function GlidePaths() {
  const gp = useApi<any[]>("/glide-paths"); const goals = useApi<any[]>("/goals"); const act = useAction(() => gp.refetch()); const [f, setF] = useState<{ goal_id: string; steps: string } | null>(null);
  if (gp.loading || gp.error) return <Status loading={gp.loading} error={gp.error} />;
  return (<Card title="Glide paths — growth exposure by year" action={isMember() ? <button className="btn btn-s" onClick={() => setF(f ? null : { goal_id: goals.data?.[0]?.id ?? "", steps: "2026:60, 2028:55, 2030:50" })}>{f ? "Close" : "Set glide path"}</button> : undefined}>
    {f && <div className="row" style={{ gap: 8, flexWrap: "wrap", alignItems: "flex-end" }}>
      <Field label="Goal"><select style={inp} value={f.goal_id} onChange={(e) => setF({ ...f, goal_id: e.target.value })}>{(goals.data ?? []).map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}</select></Field>
      <Field label="Steps (year:growth %, …)"><input style={{ ...inp, width: 260 }} value={f.steps} onChange={(e) => setF({ ...f, steps: e.target.value })} /></Field>
      <button className="btn" disabled={!f.goal_id || !!act.busy} onClick={() => act.run("gp", async () => { const steps = f.steps.split(",").map((s) => s.trim()).filter(Boolean).map((s) => { const [y, g] = s.split(":"); return { year: +y, growth_pct: +g }; }); await api("/glide-paths", { method: "PUT", body: JSON.stringify({ goal_id: f.goal_id, steps }) }); setF(null); return "Glide path saved"; })}>Save</button>
    </div>}
    {gp.data!.length === 0 && <div className="small mute">No glide paths yet. A glide path steps the growth share down as a goal approaches; the income bucket absorbs the difference. Steps may only de-risk.</div>}
    {gp.data!.map((g) => <div key={g.id} className="attn"><div style={{ flex: 1 }}><b>{g.goal}</b><div className="small mute">{(g.steps ?? []).map((s: any) => `${s.year}: ${s.growth_pct}%`).join(" → ")}</div></div></div>)}
    {act.msg}
  </Card>);
}
