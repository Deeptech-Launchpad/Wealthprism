import { useState } from "react";
import { Plus, Play, Upload, FileText, Check, X, Clock, RotateCcw, Fingerprint } from "lucide-react";
import { useApi } from "../lib/useApi";
import { api, apiJson, inr, session, API_URL } from "../lib/api";
import { Card, Pill, Status, fmtDate } from "../components";

const TABS = ["Inbox", "Recommendations", "Proposals", "Digest", "Sources & track record"] as const;
const inp = { background: "#fff", color: "var(--ink)", borderColor: "var(--line)" } as const;
const label = (s?: string | null) => (s ?? "").replace(/_/g, " ");
const vt = (v?: string | null) => (v === "fits" ? "teal" : v === "fits_with_conditions" ? "amber" : v === "prohibited" || v === "conflicts" ? "red" : undefined);
const st = (s?: string | null) => (s === "approved" || s === "converted" || s === "assessed" || s === "extracted" ? "teal" : s === "in_review" || s === "deferred" || s === "new" || s === "clustered" ? "amber" : s === "rejected" || s === "dismissed" || s === "expired" ? "red" : undefined);
function Field({ label: l, children }: { label: string; children: React.ReactNode }) { return <label className="field">{l}{children}</label>; }
function useAction(after?: () => void) {
  const [busy, setBusy] = useState(""); const [err, setErr] = useState(""); const [note, setNote] = useState("");
  const run = async (l: string, fn: () => Promise<string | void>) => { setBusy(l); setErr(""); setNote(""); try { const n = await fn(); if (n) setNote(n); after?.(); } catch (e: any) { setErr(e.message); } finally { setBusy(""); } };
  return { busy, err, note, run, msg: <>{err && <div className="err">{err}</div>}{note && <div className="small" style={{ color: "var(--teal)" }}>{note}</div>}</> };
}
const openDoc = async (url: string) => { const s = session.get(); const r = await fetch(`${API_URL}${url.replace(/^\/api\/v1/, "")}`, { headers: { Authorization: `Bearer ${s?.access_token}`, "X-Family-Id": session.family() ?? "" } }); const b = await r.blob(); window.open(URL.createObjectURL(b), "_blank"); };
const role = () => session.get()?.families.find((f) => f.id === session.family())?.role ?? "viewer";

export function Research() {
  const [tab, setTab] = useState<(typeof TABS)[number]>("Digest"); const bump = () => undefined; const [focus, setFocus] = useState<string | null>(null);
  return (<>
    <div className="tabs">{TABS.map((t) => <button key={t} className={tab === t ? "on" : ""} onClick={() => setTab(t)}>{t}</button>)}</div>
    {tab === "Inbox" && <Inbox onChange={bump} />}
    {tab === "Recommendations" && <Clusters onChange={bump} onProposal={(id) => { setFocus(id); setTab("Proposals"); }} />}
    {tab === "Proposals" && <Proposals key={focus ?? ""} focus={focus} onChange={bump} />}
    {tab === "Digest" && <Digest onChange={bump} onProposal={(id) => { setFocus(id); setTab("Proposals"); }} />}
    {tab === "Sources & track record" && <Sources onChange={bump} />}
  </>);
}

// ---------- Inbox ----------
function Inbox({ onChange }: { onChange: () => void }) {
  const items = useApi<any>("/research/items?limit=200"); const channels = useApi<any[]>("/research/channels"); const sources = useApi<any[]>("/research/sources");
  const [open, setOpen] = useState<any>(null); const [adding, setAdding] = useState(false); const [f, setF] = useState<any>({ title: "", sender: "", body_text: "", channel_id: "" });
  const act = useAction(() => { items.refetch(); onChange(); });
  const show = async (id: string) => setOpen(await api(`/research/items/${id}`));
  if (!items.data) return <Status loading={items.loading} error={items.error} />;
  const list = items.data.items as any[];
  return (<div className="grid-2" style={{ alignItems: "start" }}>
    <Card title={`Inbox — ${list.length} items · ${list.reduce((s, i) => s + i.recommendation_count, 0)} recommendations`} action={<div className="row gap"><button className="btn btn-s" disabled={!!act.busy} onClick={() => act.run("run", async () => { const r: any = await apiJson("/research/run", {}); return r.note; })}><Play size={14} /> Run pipeline</button><button className="btn btn-p" onClick={() => { setAdding(true); setOpen(null); }}><Upload size={14} /> Upload / paste</button></div>}>
      {act.msg}
      <table className="tbl"><thead><tr><th>Received</th><th>Channel</th><th>Item</th><th>Source</th><th className="num">Recs</th><th>Status</th></tr></thead><tbody>
        {list.map((i) => <tr key={i.id} style={{ cursor: "pointer", background: open?.id === i.id ? "#F6F8FB" : undefined }} onClick={() => { setAdding(false); show(i.id); }}><td className="small mute">{new Date(i.received_at).toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}</td><td className="small">{i.channel_kind}</td><td>{i.title}</td><td className="small">{i.source_name ? `${i.source_name} (${label(i.source_kind)})` : <Pill tone="amber">triage</Pill>}</td><td className="num">{i.recommendation_count}</td><td className="small"><Pill tone={st(i.status)}>{label(i.status)}</Pill>{i.review_count ? ` · ${i.review_count} to review` : ""}{i.dismissed_count ? ` · ${i.dismissed_count} dismissed` : ""}{i.proposal_count ? " · proposal drafted" : ""}</td></tr>)}
      </tbody></table>
      <div className="small mute" style={{ marginTop: 8 }}>Channels: {(channels.data ?? []).map((c) => `${c.label}${c.config?.address ? ` (${c.config.address})` : c.config?.url ? " (RSS)" : ""}`).join(" · ")}. Duplicates are dropped by content hash; unattributed senders go to triage.</div>
    </Card>
    {adding && <Card title="Upload / paste research">
      <div className="row gap" style={{ flexWrap: "wrap", alignItems: "flex-end" }}><Field label="Channel"><select style={inp} value={f.channel_id} onChange={(e) => setF({ ...f, channel_id: e.target.value })}><option value="">paste</option>{(channels.data ?? []).map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}</select></Field><Field label="Sender"><input style={inp} value={f.sender} onChange={(e) => setF({ ...f, sender: e.target.value })} placeholder="e-mail / phone (maps to a source)" /></Field><Field label="Title"><input style={{ ...inp, minWidth: 220 }} value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></Field></div>
      <Field label="Text (or choose a file)"><textarea style={{ ...inp, width: "100%", minHeight: 140, fontFamily: "monospace", fontSize: 12 }} value={f.body_text} onChange={(e) => setF({ ...f, body_text: e.target.value })} placeholder={"BUY | Larsen & Toubro (LT) | CMP 3,640 | TP 4,300 | SL 3,300 | 24M | High\nThesis on the next line…"} /></Field>
      <input type="file" accept=".txt,.md,.csv,.eml,text/plain" onChange={(e) => { const file = e.target.files?.[0]; if (!file) return; file.text().then((t) => setF({ ...f, body_text: t, title: f.title || file.name })); }} />
      <div className="row gap" style={{ marginTop: 8 }}><button className="btn btn-p" disabled={!!act.busy || f.body_text.length < 10} onClick={() => act.run("ingest", async () => { const r: any = await apiJson("/research/items", { ...f, channel_id: f.channel_id || undefined, sender: f.sender || undefined, title: f.title || undefined }); setAdding(false); setOpen(await api(`/research/items/${r.id}`)); return r.duplicate ? "Already in the inbox (same content)" : `${r.recommendation_count} recommendation${r.recommendation_count === 1 ? "" : "s"} extracted`; })}>Ingest</button><button className="btn btn-s" onClick={() => setAdding(false)}>Cancel</button></div>
    </Card>}
    {open && !adding && <Card title={open.title} action={<Pill tone={st(open.status)}>{label(open.status)}</Pill>}>
      <div className="small mute">{fmtDate(open.received_at)} · {open.channel_label ?? open.channel_kind} · {open.sender ?? "—"} · {open.source_name ? `${open.source_name} (trust ${Math.round(open.trust_score)})` : "unattributed"}</div>
      {open.triage_note && <div className="row gap" style={{ marginTop: 8 }}><Pill tone="amber">{open.triage_note}</Pill><select style={inp} defaultValue="" onChange={(e) => e.target.value && act.run("attr", async () => { setOpen(await api(`/research/items/${open.id}`, { method: "PATCH", body: JSON.stringify({ source_id: e.target.value }) })); })}><option value="">attribute to…</option>{(sources.data ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></div>}
      <pre className="small" style={{ whiteSpace: "pre-wrap", background: "#F6F8FB", padding: 10, borderRadius: 8, maxHeight: 200, overflow: "auto", marginTop: 8 }}>{open.body_text}</pre>
      <b className="small">Recommendations</b>
      {open.recommendations.map((r: any) => <RecRow key={r.id} r={r} onChange={async () => { setOpen(await api(`/research/items/${open.id}`)); onChange(); }} />)}
      {!open.recommendations.length && <div className="small mute">No recommendation in this item.</div>}
      <div className="row gap" style={{ marginTop: 8 }}><button className="btn btn-s" disabled={!!act.busy} onClick={() => act.run("re", async () => { setOpen(await api(`/research/items/${open.id}`, { method: "PATCH", body: JSON.stringify({ re_extract: true }) })); return "Re-extracted"; })}><RotateCcw size={12} /> Re-extract</button></div>
    </Card>}
  </div>);
}
function RecRow({ r, onChange }: { r: any; onChange: () => void }) {
  const [q, setQ] = useState(""); const [hits, setHits] = useState<any[]>([]); const [err, setErr] = useState("");
  const patch = async (body: any) => { setErr(""); try { await api(`/research/recommendations/${r.id}`, { method: "PATCH", body: JSON.stringify(body) }); onChange(); } catch (e: any) { setErr(e.message); } };
  const search = async (s: string) => { setQ(s); if (s.length < 2) return setHits([]); const res: any = await api(`/instruments/search?q=${encodeURIComponent(s)}`); setHits((res.items ?? res).slice(0, 6)); };
  return (<div className="attn" style={{ alignItems: "flex-start", flexWrap: "wrap" }}>
    <span style={{ flex: 1, minWidth: 240 }}><b>{r.action}</b> {r.instrument_name ?? r.instrument_text}{!r.instrument_id && <Pill tone="amber">unresolved</Pill>} <span className="small mute">· {r.conviction} · {r.horizon_months ? `${r.horizon_months}M` : ""}{r.target_price ? ` · target ${inr(r.target_price)}` : ""}{r.stop_loss ? ` · stop ${inr(r.stop_loss)}` : ""} · conf {Math.round((r.confidence ?? 0) * 100)}%{r.review_note ? ` · ${r.review_note}` : ""}</span><div className="small">{r.thesis}</div>
      {!r.instrument_id && <div style={{ position: "relative", marginTop: 4 }}><input style={{ ...inp, width: 260 }} placeholder="resolve instrument…" value={q} onChange={(e) => search(e.target.value)} />{hits.length > 0 && <div style={{ position: "absolute", background: "#fff", border: "1px solid var(--line)", borderRadius: 6, zIndex: 5, width: 320 }}>{hits.map((h) => <div key={h.id} className="small" style={{ padding: "4px 8px", cursor: "pointer" }} onClick={() => { setHits([]); setQ(""); patch({ instrument_id: h.id }); }}>{h.name} <span className="mute">{h.symbol ?? h.type}</span></div>)}</div>}</div>}
      {err && <div className="err">{err}</div>}</span>
    <span className="row gap"><Pill tone={st(r.status)}>{label(r.status)}</Pill>{r.status === "new" && <button className="btn btn-s" onClick={() => patch({ status: "extracted" })}><Check size={12} /> Accept</button>}{r.status !== "dismissed" && r.status !== "proposal_drafted" && <button className="btn btn-s" onClick={() => patch({ status: "dismissed", review_note: "dismissed by reviewer" })}><X size={12} /></button>}</span>
  </div>);
}

// ---------- Recommendations (clusters) ----------
function Clusters({ onChange, onProposal }: { onChange: () => void; onProposal: (id: string) => void }) {
  const list = useApi<any[]>("/research/clusters"); const ents = useApi<any[]>("/entities"); const [sel, setSel] = useState<string | null>(null); const [ent, setEnt] = useState("");
  const act = useAction(() => { list.refetch(); onChange(); });
  if (!list.data) return <Status loading={list.loading} error={list.error} />;
  const cl = list.data.find((k) => k.id === sel) ?? list.data[0];
  return (<div className="grid-2" style={{ alignItems: "start" }}>
    <Card title={`Clusters — ${list.data.length}`} action={<button className="btn btn-s" disabled={!!act.busy} onClick={() => act.run("cluster", async () => { const r: any = await apiJson("/research/cluster", {}); return `${r.note}; ${r.assessments.note}`; })}><Play size={14} /> Re-cluster & assess</button>}>
      {act.msg}
      {list.data.map((k) => <div key={k.id} className="attn" style={{ cursor: "pointer", background: cl?.id === k.id ? "#F6F8FB" : undefined, opacity: k.status === "dismissed" ? 0.7 : 1 }} onClick={() => setSel(k.id)}>
        <span style={{ flex: 1 }}><b>{k.instrument_name ?? k.instrument_text}</b> <span className="small mute">{k.direction} · {k.source_count} source{k.source_count > 1 ? "s" : ""} · conviction {Math.round(k.weighted_conviction ?? 0)}{k.fit_score != null ? ` · fit ${Math.round(k.fit_score)}` : ""}</span></span>
        {k.verdict && <Pill tone={vt(k.verdict)}>{label(k.verdict)}</Pill>}{k.status === "dismissed" && <Pill tone="red">dismissed</Pill>}{k.proposal_status && <Pill tone={st(k.proposal_status)}>proposal {label(k.proposal_status)}</Pill>}</div>)}
    </Card>
    {cl && <Card title={cl.instrument_name ?? cl.instrument_text} action={<div className="row gap"><select style={inp} value={ent} onChange={(e) => setEnt(e.target.value)}><option value="">assess for…</option>{(ents.data ?? []).map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}</select><button className="btn btn-s" disabled={!!act.busy} onClick={() => act.run("assess", async () => { await api(`/research/clusters/${cl.id}/assess`, { method: "POST", body: JSON.stringify({ entity_id: ent || undefined }) }); return "Assessed"; })}>Assess</button>
      {cl.status !== "dismissed" && ["fits", "fits_with_conditions", "conflicts"].includes(cl.verdict) && !cl.proposal_id && <button className="btn btn-p" disabled={!!act.busy} onClick={() => act.run("draft", async () => { const r: any = await apiJson("/research/proposals", { cluster_id: cl.id, entity_id: ent || undefined }); if (r.status_code >= 400) throw new Error(r.title); onProposal(r.proposal.id); })}><FileText size={14} /> Draft proposal</button>}
      {cl.proposal_id && <button className="btn btn-s" onClick={() => onProposal(cl.proposal_id)}>Open proposal</button>}
      {cl.status !== "dismissed" ? <button className="btn btn-s" disabled={!!act.busy} onClick={() => { const reason = window.prompt("Reason for dismissing"); if (reason) act.run("dismiss", async () => { await api(`/research/clusters/${cl.id}/dismiss`, { method: "POST", body: JSON.stringify({ reason }) }); }); }}>Dismiss</button> : <button className="btn btn-s" disabled={!!act.busy} onClick={() => act.run("restore", async () => { await api(`/research/clusters/${cl.id}/restore`, { method: "POST" }); })}><RotateCcw size={12} /> Restore</button>}</div>}>
      <div className="attn"><span style={{ flex: 1 }}>Consensus</span><b>{cl.consensus}</b></div>
      <div className="attn"><span style={{ flex: 1 }}>Trust-weighted conviction</span><b>{Math.round(cl.weighted_conviction ?? 0)} / 100</b></div>
      <div className="attn"><span style={{ flex: 1 }}>Policy-fit assessment{cl.entity_name ? ` · ${cl.entity_name}` : ""}</span>{cl.verdict ? <><Pill tone={vt(cl.verdict)}>{label(cl.verdict)}</Pill><b>score {Math.round(cl.fit_score)}</b></> : <span className="mute">not assessed</span>}</div>
      {cl.dismissed_reason && <div className="attn"><span style={{ flex: 1 }}>Declined</span><span className="small">{cl.dismissed_reason}</span></div>}
      {cl.already_held && <div className="attn"><span style={{ flex: 1 }}>Already held</span><span className="small">{inr(cl.already_held.value)} · {cl.already_held.weight_pct}% of the portfolio{cl.already_held.surface ? " · sell on a held position — always surfaced" : ""}</span></div>}
      {cl.sizing?.suggested != null && <div className="attn"><span style={{ flex: 1 }}>Sizing</span><span className="small"><b>{inr(cl.sizing.suggested)}</b> · {cl.sizing.basis}{cl.sizing.max_by_policy != null ? ` · policy max ${inr(cl.sizing.max_by_policy)}` : ""}{cl.sizing.cash_available != null ? ` · cash above float ${inr(cl.sizing.cash_available)}` : ""}</span></div>}
      {cl.checks && <table className="tbl" style={{ marginTop: 8 }}><thead><tr><th>Clause</th><th>Status</th><th>Detail</th></tr></thead><tbody>{cl.checks.map((c: any, i: number) => <tr key={i}><td className="small">{c.clause}</td><td><Pill tone={c.status === "pass" ? "teal" : c.status === "warning" ? "amber" : c.status === "fail" ? "red" : undefined}>{c.status}</Pill></td><td className="small">{c.detail}</td></tr>)}</tbody></table>}
      <b className="small" style={{ display: "block", marginTop: 8 }}>Calls</b>{(cl.calls ?? []).map((x: any, i: number) => <div key={i} className="attn small"><span style={{ flex: 1 }}>{x.source ?? "unattributed"} <span className="mute">({label(x.kind)} · trust {Math.round(x.trust ?? 50)})</span></span><span>{x.action} · {x.conviction} · {fmtDate(x.published_on)}</span></div>)}
      <div className="small mute" style={{ marginTop: 8 }}>{cl.verdict === "prohibited" ? "Dismissed automatically and recorded in the digest's declined list with the clause. The agent cannot draft a proposal for a prohibited instrument." : cl.direction === "bearish" && cl.already_held ? "Sell calls on held positions always surface; the proposal sizes the sale inside the exemption headroom." : "Assessed against the effective investment policy of the entity that holds the most deployable cash unless you pick one."}</div>
    </Card>}
  </div>);
}

// ---------- Proposals ----------
function Proposals({ focus, onChange }: { focus: string | null; onChange: () => void }) {
  const list = useApi<any[]>("/research/proposals"); const [sel, setSel] = useState<string | null>(focus); const [amt, setAmt] = useState(""); const [defer, setDefer] = useState("");
  const id = sel ?? list.data?.[0]?.id ?? null; const p = useApi<any>(id ? `/research/proposals/${id}` : null);
  const act = useAction(() => { list.refetch(); p.refetch(); onChange(); }); const canDecide = ["owner", "member"].includes(role());
  const decide = (decision: string, extra: any = {}) => act.run(decision, async () => { const r: any = await api(`/research/proposals/${id}/decide`, { method: "POST", body: JSON.stringify({ decision, ...extra }) }); return `${label(r.status)}${r.intents?.length ? ` · ${r.intents.length} intents in the Action plane` : ""}`; });
  if (!list.data) return <Status loading={list.loading} error={list.error} />;
  const s = p.data?.sections;
  return (<div className="grid-2" style={{ alignItems: "start", gridTemplateColumns: "1fr 2fr" }}>
    <Card title={`Proposals — ${list.data.length}`}>{list.data.map((x) => <div key={x.id} className="attn" style={{ cursor: "pointer", background: id === x.id ? "#F6F8FB" : undefined }} onClick={() => setSel(x.id)}><span style={{ flex: 1 }}><b>{x.title}</b><div className="small mute">{fmtDate(x.created_at)} · {x.entity_name} · fit {Math.round(x.fit_score ?? 0)} · {label(x.verdict)}</div></span><Pill tone={st(x.status)}>{label(x.status)}</Pill></div>)}{!list.data.length && <div className="small mute">No proposals yet — draft one from a cluster that fits.</div>}</Card>
    {p.data && s && <Card title={p.data.title} action={<div className="row gap" style={{ flexWrap: "wrap" }}><Pill tone={st(p.data.status)}>{label(p.data.status)} · v{p.data.version}</Pill><button className="btn btn-s" onClick={() => act.run("doc", async () => { const r: any = await apiJson(`/research/proposals/${id}/document`, {}); await openDoc(r.document_url); })}><FileText size={14} /> Memo</button>
      {canDecide && ["in_review", "deferred", "draft"].includes(p.data.status) && <><button className="btn btn-s" disabled={!!act.busy} onClick={() => decide("reject", { note: window.prompt("Reason") ?? undefined })}><X size={14} /> Reject</button><input type="date" style={inp} value={defer} onChange={(e) => setDefer(e.target.value)} /><button className="btn btn-s" disabled={!!act.busy} onClick={() => decide("defer", { defer_until: defer || undefined })}><Clock size={14} /> Defer</button><input type="number" style={{ ...inp, width: 110 }} placeholder={String(p.data.amount)} value={amt} onChange={(e) => setAmt(e.target.value)} /><button className="btn btn-p" disabled={!!act.busy} onClick={() => decide("approve", { convert: true, amount_override: amt ? Number(amt) : undefined })}><Check size={14} /> Approve → intents</button></>}</div>}>
      {act.msg}
      <div className="small mute">{p.data.entity_name} · {inr(p.data.amount)} · expires {fmtDate(p.data.expires_at)}{p.data.decided_by_name ? ` · decided by ${p.data.decided_by_name}${p.data.decision_note ? ` — ${p.data.decision_note}` : ""}` : ""}{p.data.defer_until ? ` · deferred to ${fmtDate(p.data.defer_until)}` : ""}</div>
      <Sec t="Summary">{s.summary}</Sec><Sec t="Thesis">{s.thesis}</Sec>
      <Sec t="Counter-view"><div style={{ background: "#F6F8FB", padding: 10, borderRadius: 8 }}>{s.counter_view}</div></Sec>
      <Sec t="Sources"><table className="tbl"><tbody>{s.sources.map((x: any) => <tr key={x.name}><td>{x.name} <span className="small mute">{label(x.kind)}</span></td><td>{x.action}</td><td className="small">trust {Math.round(x.trust_score)}</td><td className="small">{x.conflict_of_interest ?? "—"}</td><td className="small">{x.track_record_12m ? `${x.track_record_12m.hit_rate_pct}% · ${x.track_record_12m.avg_excess_pct > 0 ? "+" : ""}${x.track_record_12m.avg_excess_pct}% (n=${x.track_record_12m.n})` : "no record"}</td></tr>)}</tbody></table></Sec>
      <Sec t={`Policy fit — ${s.policy_fit.policy} · ${label(s.policy_fit.verdict)} ${Math.round(s.policy_fit.fit_score)}`}>{s.policy_fit.checks.map((c: any, i: number) => <div key={i} className="attn small"><span style={{ flex: 1 }}>{c.clause}</span><Pill tone={c.status === "pass" ? "teal" : c.status === "warning" ? "amber" : c.status === "fail" ? "red" : undefined}>{c.status}</Pill><span style={{ flex: 2 }}>{c.detail}</span></div>)}</Sec>
      <Sec t="Portfolio & tax impact"><div className="small">{s.portfolio_impact.asset_class.key} {s.portfolio_impact.asset_class.before_pct}% → {s.portfolio_impact.asset_class.after_pct}%{s.portfolio_impact.sector ? ` · ${s.portfolio_impact.sector.key} ${s.portfolio_impact.sector.before_pct}% → ${s.portfolio_impact.sector.after_pct}%` : ""} · top-5 {s.portfolio_impact.top5_before_pct ?? "—"}% → {s.portfolio_impact.top5_after_pct ?? "—"}% · cash after {inr(s.portfolio_impact.cash_after)}{s.portfolio_impact.liquidity_months_after != null ? ` · liquidity ${s.portfolio_impact.liquidity_months_after} months` : ""} · tax: {s.tax_impact.note}{s.tax_impact.ltcg != null ? ` (LTCG ${inr(s.tax_impact.ltcg)}, STCG ${inr(s.tax_impact.stcg)})` : ""}</div></Sec>
      <Sec t="Sizing">{s.sizing.rationale}{s.sizing.max_by_policy != null ? ` · policy max ${inr(s.sizing.max_by_policy)}` : ""}</Sec>
      <Sec t="Execution plan"><ul className="small">{s.execution_plan.map((t: any) => <li key={t.tranche}>Tranche {t.tranche}: {inr(t.amount)} · {t.entity} · {t.connector} ({t.kind}) — {t.instruction}</li>)}</ul></Sec>
      <Sec t="Exit plan">Target {s.exit_plan.target_price ?? "—"} · stop {s.exit_plan.stop_loss ?? "—"} · horizon {s.exit_plan.horizon_months} months · review: {s.exit_plan.review_trigger}</Sec>
      <Sec t="Risks & monitoring"><ul className="small">{s.risks.map((r: string, i: number) => <li key={i}>{r}</li>)}</ul><ul className="small">{s.monitoring.map((r: string, i: number) => <li key={i}>• {r}</li>)}</ul></Sec>
      {p.data.intents?.length > 0 && <Sec t="Intents">{p.data.intents.map((i: any) => <div key={i.id} className="attn small"><span style={{ flex: 1 }}>{i.kind} · {inr(i.amount)}</span><Pill tone={st(i.status)}>{label(i.status)}</Pill></div>)}</Sec>}
      <div className="small mute" style={{ marginTop: 10 }}>Drafted by {s.drafted_by} from {s.sources.length} source{s.sources.length === 1 ? "" : "s"}, the effective policy and the portfolio snapshot; every figure cites its tool result ({s.citations.length} citations). {s.disclaimer}</div>
    </Card>}
    {id && !p.data && <Status loading={p.loading} error={p.error} />}
  </div>);
}
const Sec = ({ t, children }: { t: string; children: React.ReactNode }) => <div style={{ marginTop: 10 }}><b className="small" style={{ color: "var(--teal)" }}>{t}</b><div>{children}</div></div>;

// ---------- Digest ----------
function Digest({ onChange, onProposal }: { onChange: () => void; onProposal: (id: string) => void }) {
  const list = useApi<any[]>("/research/digests"); const [sel, setSel] = useState<string | null>(null); const id = sel ?? list.data?.[0]?.id ?? null; const d = useApi<any>(id ? `/research/digests/${id}` : null);
  const [dec, setDec] = useState<Record<string, { decision: string; amount?: string; note?: string }>>({}); const act = useAction(() => { list.refetch(); d.refetch(); onChange(); }); const canDecide = ["owner", "member"].includes(role());
  if (!list.data) return <Status loading={list.loading} error={list.error} />;
  const s = d.data?.summary;
  return (<>
    <div className="row gap" style={{ justifyContent: "space-between", margin: "8px 0", flexWrap: "wrap" }}><div className="row gap">{list.data.slice(0, 6).map((x) => <button key={x.id} className={`btn btn-s ${id === x.id ? "btn-p" : ""}`} onClick={() => setSel(x.id)}>{fmtDate(x.period_start)} – {fmtDate(x.period_end)} · {x.awaiting ?? 0} to decide</button>)}</div><button className="btn btn-s" disabled={!!act.busy} onClick={() => act.run("gen", async () => { const r: any = await apiJson("/research/digests", {}); setSel(r.digest.id); return `Digest for ${r.digest.period_start} – ${r.digest.period_end}`; })}><Plus size={14} /> Generate digest now</button></div>
    {act.msg}
    {!d.data && <Status loading={d.loading} error={d.error ?? (list.data.length ? null : "No digest yet — generate one, or wait for Sunday 07:00 IST.")} />}
    {d.data && s && <>
      <div className="kpis"><div className="card"><div className="small mute">Week of {fmtDate(d.data.period_start)}</div><div className="big-num">{s.items} items</div><div className="small mute">{s.recommendations} recommendations · {s.clusters} clusters</div></div><div className="card"><div className="small mute">Declined</div><div className="big-num">{s.declined_count}</div><div className="small mute">with reasons, below</div></div><div className="card"><div className="small mute">Proposals</div><div className="big-num">{s.proposals.length}</div><div className="small mute">{s.awaiting} to decide · {s.deferred} deferred</div></div><div className="card"><div className="small mute">Themes</div><div className="small">{(s.themes ?? []).join(" · ") || "—"}</div></div><div className="card"><div className="small mute">Source movement</div><div className="small">{(s.source_leaderboard ?? []).filter((x: any) => x.moved_from != null).map((x: any) => `${x.source} ${x.moved_from > x.moved_to ? "↓" : "↑"} ${x.moved_from}→${x.moved_to}`).join(" · ") || "no change"}</div></div></div>
      <Card title="Proposals awaiting decision" action={<div className="row gap"><Pill tone={d.data.status === "open" ? "amber" : "teal"}>{d.data.status}</Pill><button className="btn btn-s" onClick={() => openDoc(d.data.document_url)}><FileText size={14} /> Digest</button>{canDecide && d.data.status === "open" && <button className="btn btn-p" disabled={!!act.busy || !Object.keys(dec).length} onClick={() => { const code = window.prompt("Step-up code (authenticator)"); if (!code) return; act.run("decide", async () => { const r: any = await api(`/research/digests/${id}/decide`, { method: "POST", body: JSON.stringify({ decisions: Object.entries(dec).map(([proposal_id, v]) => ({ proposal_id, decision: v.decision, convert: v.decision === "approve", amount_override: v.amount ? Number(v.amount) : undefined, note: v.note })), auth_method: "totp", auth_proof: code }) }); setDec({}); return `${r.length} decided`; }); }}><Fingerprint size={14} /> Submit decisions</button>}</div>}>
        {d.data.proposals.map((p: any) => <div key={p.id} className="attn" style={{ flexWrap: "wrap" }}><span style={{ flex: 1, minWidth: 260, cursor: "pointer" }} onClick={() => onProposal(p.id)}><b>{p.title}</b><div className="small mute">fit {Math.round(p.policy_fit?.fit_score ?? 0)} · {label(p.policy_fit?.verdict)} · {p.entity_name}{p.defer_until ? ` · deferred to ${fmtDate(p.defer_until)}` : ""}</div></span>
          <Pill tone={st(p.status)}>{label(p.status)}</Pill>
          {canDecide && ["in_review", "deferred"].includes(p.status) && d.data.status === "open" && <span className="row gap">{["approve", "reject", "defer"].map((k) => <button key={k} className={`btn btn-s ${dec[p.id]?.decision === k ? "btn-p" : ""}`} onClick={() => setDec({ ...dec, [p.id]: { ...(dec[p.id] ?? {}), decision: k } })}>{k}</button>)}{dec[p.id]?.decision === "approve" && <input type="number" style={{ ...inp, width: 100 }} placeholder={String(p.amount)} value={dec[p.id]?.amount ?? ""} onChange={(e) => setDec({ ...dec, [p.id]: { ...dec[p.id], amount: e.target.value } })} />}</span>}</div>)}
        {!d.data.proposals.length && <div className="small mute">Nothing to decide this period.</div>}
        <div className="small mute" style={{ marginTop: 8 }}>One step-up decides the batch. Approved proposals become intent batches in the Action plane; deferred ones return next digest. Sent to {(d.data.sent_to ?? []).join(", ")}.</div>
      </Card>
      <div className="grid-2" style={{ alignItems: "start" }}>
        <Card title="Declined, with reasons">{s.dismissed.map((x: any) => <div key={x.cluster_id} className="attn small"><span style={{ flex: 1 }}><b>{x.instrument}</b> · {x.direction}</span><Pill tone={vt(x.verdict)}>{label(x.verdict)}</Pill><span style={{ flex: 2 }}>{x.reason}</span></div>)}{!s.dismissed.length && <div className="small mute">Nothing declined.</div>}<div className="small mute" style={{ marginTop: 8 }}>Declined items are listed with reasons so nothing is silently dropped.</div></Card>
        <Card title="What arrived"><table className="tbl"><tbody>{(s.items_list ?? []).map((i: any) => <tr key={i.id}><td>{i.title}</td><td className="small">{i.channel}</td><td className="small">{i.source ?? "unattributed"}</td><td className="num">{i.recommendations}</td></tr>)}</tbody></table></Card>
      </div>
    </>}
  </>);
}

// ---------- Sources & track record ----------
function Sources({ onChange }: { onChange: () => void }) {
  const [hz, setHz] = useState(12); const board = useApi<any[]>(`/research/track-record?horizon_months=${hz}`); const channels = useApi<any[]>("/research/channels"); const settings = useApi<any>("/research/settings");
  const [adding, setAdding] = useState(false); const [f, setF] = useState<any>({ kind: "broker", name: "", organisation: "", conflict_of_interest: "none", contact: "" }); const [ch, setCh] = useState<any>({ kind: "rss", label: "", url: "", host: "", port: "993", secure: true, user: "", password: "", mock: false });
  const act = useAction(() => { board.refetch(); channels.refetch(); settings.refetch(); onChange(); }); const owner = role() === "owner";
  return (<>
    {act.msg}
    <Card title="Source leaderboard" action={<div className="row gap"><select style={inp} value={hz} onChange={(e) => setHz(Number(e.target.value))}>{[3, 6, 12, 24].map((h) => <option key={h} value={h}>{h} months</option>)}</select><button className="btn btn-s" disabled={!!act.busy} onClick={() => act.run("eval", async () => { const r: any = await apiJson("/research/track-record/evaluate", {}); return r.note; })}><Play size={14} /> Re-score</button><button className="btn btn-p" onClick={() => setAdding(true)}><Plus size={14} /> Add source</button></div>}>
      {adding && <div className="row gap" style={{ flexWrap: "wrap", alignItems: "flex-end", marginBottom: 10 }}><Field label="Kind"><select style={inp} value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>{["research_house", "broker", "advisor", "pms_manager", "newsletter", "friend", "media", "other"].map((k) => <option key={k} value={k}>{label(k)}</option>)}</select></Field><Field label="Name"><input style={inp} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field><Field label="Organisation"><input style={inp} value={f.organisation} onChange={(e) => setF({ ...f, organisation: e.target.value })} /></Field><Field label="Contact (e-mail / phone)"><input style={inp} value={f.contact} onChange={(e) => setF({ ...f, contact: e.target.value })} /></Field><Field label="Conflict of interest"><input style={inp} value={f.conflict_of_interest} onChange={(e) => setF({ ...f, conflict_of_interest: e.target.value })} /></Field><button className="btn btn-p" disabled={!f.name || !!act.busy} onClick={() => act.run("src", async () => { await api("/research/sources", { method: "POST", body: JSON.stringify(f) }); setAdding(false); })}>Save</button></div>}
      {board.data ? <table className="tbl"><thead><tr><th>Source</th><th>Conflict of interest</th><th className="num">Trust</th><th className="num">Calls</th><th className="num">Hit rate</th><th className="num">Excess vs benchmark</th><th>Best / worst</th></tr></thead><tbody>{board.data.map((r) => <tr key={r.source_id}><td>{r.source} <span className="small mute">({label(r.kind)}{r.sebi_registration ? ` · ${r.sebi_registration}` : ""})</span></td><td className="small">{r.conflict_of_interest ?? "—"}</td><td className="num">{r.trust_score}</td><td className="num">{r.n}</td><td className="num">{r.hit_rate_pct == null ? "—" : `${r.hit_rate_pct}%`}</td><td className="num" style={{ color: (r.avg_excess_pct ?? 0) >= 0 ? "var(--teal)" : "var(--red)" }}>{r.avg_excess_pct == null ? "—" : `${r.avg_excess_pct > 0 ? "+" : ""}${r.avg_excess_pct}%`}</td><td className="small">{r.best ? `${r.best.instrument} ${r.best.excess_pct > 0 ? "+" : ""}${r.best.excess_pct}% / ${r.worst.instrument} ${r.worst.excess_pct > 0 ? "+" : ""}${r.worst.excess_pct}%` : "—"}</td></tr>)}</tbody></table> : <Status loading={board.loading} error={board.error} />}
      <div className="small mute" style={{ marginTop: 8 }}>Every recommendation is scored at 3, 6, 12 and 24 months against price and a benchmark (Nifty 50 for equity, CRISIL CBI for debt); trust scores weight the consensus, move at most ±5 per run and are shown on every proposal. Friends start at low trust, stay capped at 40, and are never proposed without an independent thesis.</div>
    </Card>
    <div className="grid-2" style={{ alignItems: "start" }}>
      <Card title="Channels" action={<div className="row gap" style={{ flexWrap: "wrap", alignItems: "flex-end" }}>
          <select style={inp} value={ch.kind} onChange={(e) => setCh({ ...ch, kind: e.target.value })}>{["rss", "email", "whatsapp", "web", "api"].map((k) => <option key={k}>{k}</option>)}</select>
          <input style={inp} placeholder="label" value={ch.label} onChange={(e) => setCh({ ...ch, label: e.target.value })} />
          {["rss", "web"].includes(ch.kind) && <input style={inp} placeholder="https://…/feed.xml" value={ch.url} onChange={(e) => setCh({ ...ch, url: e.target.value })} />}
          {ch.kind === "email" && !ch.mock && <>
            <input style={{ ...inp, width: 150 }} placeholder="imap.host.com" value={ch.host} onChange={(e) => setCh({ ...ch, host: e.target.value })} />
            <input style={{ ...inp, width: 60 }} placeholder="993" value={ch.port} onChange={(e) => setCh({ ...ch, port: e.target.value })} />
            <input style={{ ...inp, width: 150 }} placeholder="mailbox@domain.com" value={ch.user} onChange={(e) => setCh({ ...ch, user: e.target.value })} />
            <input style={inp} type="password" placeholder="password" value={ch.password} onChange={(e) => setCh({ ...ch, password: e.target.value })} />
          </>}
          {ch.kind === "email" && <label className="row gap small"><input type="checkbox" checked={ch.mock} onChange={(e) => setCh({ ...ch, mock: e.target.checked })} /> demo mailbox (no real inbox)</label>}
          <button className="btn btn-s" disabled={!ch.label || !!act.busy || (ch.kind === "email" && !ch.mock && (!ch.host || !ch.user || !ch.password))} onClick={() => act.run("ch", async () => {
            const config = ch.kind === "email" ? (ch.mock ? { mock: true } : { host: ch.host, port: Number(ch.port) || 993, secure: true, user: ch.user, password: ch.password }) : ch.url ? { url: ch.url } : {};
            await api("/research/channels", { method: "POST", body: JSON.stringify({ kind: ch.kind, label: ch.label, config }) });
            setCh({ kind: "rss", label: "", url: "", host: "", port: "993", secure: true, user: "", password: "", mock: false });
          })}><Plus size={12} /></button>
        </div>}>
        {(channels.data ?? []).map((c) => <div key={c.id} className="attn small"><span style={{ flex: 1 }}><b>{c.label}</b> · {c.kind}{c.config?.address ? ` · ${c.config.address}` : ""}{c.config?.number ? ` · ${c.config.number}` : ""}{c.config?.url ? ` · ${c.config.url}` : ""}{c.config?.host ? ` · ${c.config.host}` : ""}{c.config?.mock ? " · demo mailbox" : ""}{c.config?.sender_allowlist ? ` · ${Object.keys(c.config.sender_allowlist).length} allow-listed senders` : ""}</span><span className="mute">{c.items} items</span>{c.kind === "email" && <button className="btn btn-s" disabled={!!act.busy} onClick={() => act.run(`poll${c.id}`, async () => { const r: any = await api(`/research/channels/${c.id}/poll`, { method: "POST" }); channels.refetch(); return r.error ? r.error : `${r.fetched} seen, ${r.ingested} new`; })}><Play size={12} /></button>}<Pill tone={c.active ? "teal" : undefined}>{c.active ? "active" : "paused"}</Pill></div>)}
        <div className="small mute" style={{ marginTop: 8 }}>WhatsApp arrives through the inbound hook (a BSP posts to it); RSS is polled hourly by the worker; e-mail can be a real IMAP mailbox (polled hourly, or click ▶ to check now) or a demo mailbox that needs no server.</div>
      </Card>
      <Card title="Digest & decisions">
        {settings.data ? <div className="row gap" style={{ flexWrap: "wrap", alignItems: "flex-end" }}><Field label="Cadence"><select style={inp} disabled={!owner} value={settings.data.digest_cadence} onChange={(e) => act.run("set", async () => { await api("/research/settings", { method: "PUT", body: JSON.stringify({ digest_cadence: e.target.value }) }); })}>{["weekly", "fortnightly", "monthly"].map((k) => <option key={k}>{k}</option>)}</select></Field><Field label="Day"><select style={inp} disabled={!owner} value={settings.data.digest_weekday} onChange={(e) => act.run("set", async () => { await api("/research/settings", { method: "PUT", body: JSON.stringify({ digest_weekday: Number(e.target.value) }) }); })}>{["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d, i) => <option key={d} value={i}>{d}</option>)}</select></Field><Field label="Hour (IST)"><input type="number" style={{ ...inp, width: 70 }} disabled={!owner} defaultValue={settings.data.digest_hour} onBlur={(e) => act.run("set", async () => { await api("/research/settings", { method: "PUT", body: JSON.stringify({ digest_hour: Number(e.target.value) }) }); })} /></Field><Field label="Who decides"><select style={inp} disabled={!owner} value={settings.data.decide_roles.join(",")} onChange={(e) => act.run("set", async () => { await api("/research/settings", { method: "PUT", body: JSON.stringify({ decide_roles: e.target.value.split(",") }) }); })}><option value="owner,member">owner & members</option><option value="owner">owner only</option></select></Field><label className="row gap small"><input type="checkbox" disabled={!owner} checked={settings.data.ca_monthly_copy} onChange={(e) => act.run("set", async () => { await api("/research/settings", { method: "PUT", body: JSON.stringify({ ca_monthly_copy: e.target.checked }) }); })} /> monthly copy to the CA</label></div> : <Status loading={settings.loading} error={settings.error} />}
        <div className="small mute" style={{ marginTop: 8 }}>Sent to {(settings.data?.send_to ?? []).join(", ") || "every owner and member"} · proposals expire after {settings.data?.proposal_expiry_days ?? 30} days unless deferred · clusters span {settings.data?.cluster_window_days ?? 45} days.</div>
      </Card>
    </div>
  </>);
}

