import { useState } from "react";
import { Play, Eye, Download, Plus, Trash2, Send, RefreshCw, Key, Webhook, Table2, UserPlus, Ban } from "lucide-react";
import { useApi } from "../lib/useApi";
import { api, apiJson, session } from "../lib/api";
import { Card, Pill, Status, fmtDate } from "../components";

const inp = { background: "#fff", color: "var(--ink)", borderColor: "var(--line)" } as const;
const role = () => session.get()?.families.find((f) => f.id === session.family())?.role ?? "viewer";
const label = (s?: string | null) => (s ?? "").replace(/_/g, " ");
const tone = (s?: string | null) => (s === "done" || s === "active" || s === "delivered" ? "teal" : s === "running" || s === "queued" || s === "invited" || s === "failed" ? "amber" : s === "dead" || s === "revoked" || s === "expired" ? "red" : undefined);
const openUrl = (u?: string | null) => { if (u) window.open(u, "_blank", "noopener"); };
const fmtTs = (d?: string | null) => (d ? new Date(d).toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : "—");
function Field({ label: l, children }: { label: string; children: React.ReactNode }) { return <label className="field">{l}{children}</label>; }
function useAction(after?: () => void) {
  const [busy, setBusy] = useState(""); const [err, setErr] = useState(""); const [note, setNote] = useState("");
  const run = async (l: string, fn: () => Promise<string | void>) => { setBusy(l); setErr(""); setNote(""); try { const n = await fn(); if (n) setNote(n); after?.(); } catch (e: any) { setErr(e.message); } finally { setBusy(""); } };
  return { busy, err, note, run, msg: <>{err && <div className="err">{err}</div>}{note && <div className="small" style={{ color: "var(--teal)" }}>{note}</div>}</> };
}
const post = async (url: string, body: any) => { const r: any = await apiJson(url, body); if (r.status_code >= 400) throw new Error(r.title ?? `HTTP ${r.status_code}`); return r; };
const TABS = ["Reports", "Packs", "Schedules", "External viewers", "Open data"] as const;

export function Reports() {
  const [tab, setTab] = useState<(typeof TABS)[number]>("Reports"); const ext = !!session.get()?.families.find((f) => f.id === session.family()) && role() === "viewer";
  const tabs = ext ? (["Reports"] as const) : TABS;
  return (<>
    <div className="tabs">{tabs.map((t) => <button key={t} className={tab === t ? "on" : ""} onClick={() => setTab(t)}>{t}</button>)}</div>
    {tab === "Reports" && <Catalogue />}
    {tab === "Packs" && <Packs />}
    {tab === "Schedules" && <Schedules />}
    {tab === "External viewers" && <External />}
    {tab === "Open data" && <OpenData />}
  </>);
}

/** Parameter form driven by the catalogue's param definitions. */
function Params({ def, value, onChange, ents }: { def: any; value: any; onChange: (v: any) => void; ents: any[] }) {
  return (<div className="row gap" style={{ flexWrap: "wrap", alignItems: "flex-end" }}>
    {def.params.map((p: any) => <Field key={p.name} label={`${p.label ?? label(p.name)}${p.required ? " *" : ""}`}>
      {p.type === "entity" ? <select style={inp} value={value[p.name] ?? ""} onChange={(e) => onChange({ ...value, [p.name]: e.target.value })}><option value="">All entities</option>{ents.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}</select>
        : p.type === "enum" ? <select style={inp} value={value[p.name] ?? p.default ?? ""} onChange={(e) => onChange({ ...value, [p.name]: e.target.value })}>{(p.options ?? []).map((o: string) => <option key={o} value={o}>{o}</option>)}</select>
        : p.type === "fy" ? <input style={{ ...inp, width: 90 }} placeholder="2026-27" value={value[p.name] ?? ""} onChange={(e) => onChange({ ...value, [p.name]: e.target.value })} />
        : p.type === "date" ? <input style={inp} type="date" value={value[p.name] ?? ""} onChange={(e) => onChange({ ...value, [p.name]: e.target.value })} />
        : <input style={{ ...inp, width: p.type === "uuid" ? 260 : 160 }} placeholder={p.description ?? ""} value={value[p.name] ?? ""} onChange={(e) => onChange({ ...value, [p.name]: e.target.value })} />}
    </Field>)}
  </div>);
}
function Catalogue() {
  const [tick, setTick] = useState(0); const cat = useApi<any[]>("/reports"); const jobs = useApi<any[]>("/reports/jobs?limit=40", [tick]); const ents = useApi<any[]>("/entities");
  const [sel, setSel] = useState<string | null>(null); const [params, setParams] = useState<any>({}); const [format, setFormat] = useState("pdf"); const [preview, setPreview] = useState(""); const act = useAction(() => setTick((t) => t + 1));
  if (cat.loading || cat.error) return <Status loading={cat.loading} error={cat.error} />;
  const def = cat.data!.find((r) => r.code === sel); const byModule: Record<string, any[]> = {}; for (const r of cat.data!) (byModule[r.module] ??= []).push(r);
  const clean = (o: any) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== "" && v != null));
  return (<div className="grid-2" style={{ gridTemplateColumns: "300px 1fr" }}>
    <Card title={`Catalogue · ${cat.data!.length}`}>
      {Object.entries(byModule).map(([m, rs]) => <div key={m}><div className="small mute" style={{ marginTop: 8, textTransform: "uppercase", letterSpacing: 0.4 }}>{label(m)}</div>{rs.map((r) => <div key={r.code} className="attn small" style={{ cursor: "pointer", fontWeight: sel === r.code ? 600 : 400 }} onClick={() => { setSel(r.code); setParams({}); setPreview(""); setFormat(r.formats[0]); }}><span style={{ flex: 1 }}>{r.name}</span><span className="mute">{r.formats.join("/")}</span></div>)}</div>)}
    </Card>
    <div style={{ display: "grid", gap: 12 }}>
      {def ? <Card title={def.name} action={<div className="row gap">
        {def.formats.map((f: string) => <button key={f} className={`btn btn-s ${format === f ? "on" : ""}`} style={format === f ? { borderColor: "var(--navy)", fontWeight: 600 } : undefined} onClick={() => setFormat(f)}>{f.toUpperCase()}</button>)}
        <button className="btn btn-s" disabled={!!act.busy} onClick={() => act.run("preview", async () => { const s = session.get(); const r = await fetch(`${(import.meta as any).env.VITE_API_URL ?? "/api/v1"}/reports/${def.code}/preview`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${s?.access_token}`, "X-Family-Id": session.family() ?? "" }, body: JSON.stringify(clean(params)) }); if (!r.ok) throw new Error((await r.json().catch(() => ({}))).title ?? `HTTP ${r.status}`); setPreview(await r.text()); })}><Eye size={14} /> Preview</button>
        <button className="btn btn-p" disabled={!!act.busy} onClick={() => act.run("run", async () => { const r = await post(`/reports/${def.code}/run`, { ...clean(params), format }); openUrl(r.url); return `${r.name} ready — link valid for an hour`; })}><Play size={14} /> Generate</button>
      </div>}>
        <div className="small mute" style={{ marginBottom: 8 }}>{def.description}</div>
        <Params def={def} value={params} onChange={setParams} ents={ents.data ?? []} />
        {act.msg}
        {preview && <iframe title="preview" srcDoc={preview} style={{ width: "100%", height: 560, border: "1px solid var(--line)", borderRadius: 8, marginTop: 10, background: "#fff" }} />}
      </Card> : <Card title="Reports"><div className="small mute">Pick a report. Every report takes an entity and period filter, renders to PDF (watermarked with the family name and generation time), Excel, CSV or HTML, and is stored in Documents › Reports. Packs bind reports for an audience into one versioned PDF; schedules deliver them by e-mail.</div></Card>}
      <Card title="Recent runs" action={<button className="btn btn-s" onClick={() => setTick((t) => t + 1)}><RefreshCw size={14} /></button>}>
        <table className="tbl"><thead><tr><th>Report</th><th>Format</th><th>Status</th><th>When</th><th></th></tr></thead><tbody>
          {(jobs.data ?? []).map((j) => <tr key={j.id}><td><b>{cat.data!.find((r) => r.code === j.report_code)?.name ?? j.report_code}</b><div className="small mute">{Object.entries(j.params ?? {}).filter(([k]) => k !== "format").map(([k, v]) => `${label(k)} ${String(v).slice(0, 12)}`).join(" · ")}</div></td><td className="small">{j.format}</td><td><Pill tone={tone(j.status)}>{j.status}</Pill>{j.error && <div className="err">{j.error}</div>}</td><td className="small">{fmtTs(j.created_at)}</td><td>{j.url && <button className="btn btn-s" onClick={() => openUrl(j.url)}><Download size={14} /></button>}</td></tr>)}
          {!jobs.data?.length && <tr><td colSpan={5} className="mute small">No runs yet.</td></tr>}
        </tbody></table>
      </Card>
    </div>
  </div>);
}
function Packs() {
  const [tick, setTick] = useState(0); const packs = useApi<any[]>("/report-packs", [tick]); const cat = useApi<any[]>("/reports"); const ents = useApi<any[]>("/entities"); const act = useAction(() => setTick((t) => t + 1));
  const [form, setForm] = useState<any>({ name: "", audience: "ca", recipients: "", sections: [] as any[] }); const [sec, setSec] = useState<any>({ report_code: "", entity_id: "" }); const [runOpts, setRunOpts] = useState<Record<string, any>>({}); const member = ["owner", "member"].includes(role()); const writer = ["owner", "member", "operator"].includes(role());
  if (packs.loading || packs.error) return <Status loading={packs.loading} error={packs.error} />;
  return (<div className="grid-2">
    <div style={{ display: "grid", gap: 12 }}>
      {packs.data!.map((p) => { const ro = runOpts[p.id] ?? {}; return <Card key={p.id} title={`${p.name} · ${p.audience}`} action={member && <button className="btn btn-s" onClick={() => { if (confirm("Delete this pack?")) act.run("del", async () => { await api(`/report-packs/${p.id}`, { method: "DELETE" }); }); }}><Trash2 size={14} /></button>}>
        {p.description && <div className="small mute">{p.description}</div>}
        <div className="small" style={{ marginTop: 6 }}>{p.sections.map((s: any, i: number) => <span key={i}>{i ? " · " : ""}{cat.data?.find((r) => r.code === s.report_code)?.name ?? s.report_code}{s.params?.entity_id ? ` (${ents.data?.find((e) => e.id === s.params.entity_id)?.name ?? "entity"})` : ""}</span>)}</div>
        <div className="small mute">{p.cron ? `cron ${p.cron} (IST)` : "on demand"} · recipients {p.recipients?.length ? p.recipients.join(", ") : "—"}</div>
        {writer && <div className="row gap" style={{ flexWrap: "wrap", alignItems: "flex-end", marginTop: 8 }}>
          <Field label="Period label"><input style={inp} placeholder="Jul–Sep 2026" value={ro.period ?? ""} onChange={(e) => setRunOpts({ ...runOpts, [p.id]: { ...ro, period: e.target.value } })} /></Field>
          <Field label="Supersedes"><select style={inp} value={ro.supersedes ?? ""} onChange={(e) => setRunOpts({ ...runOpts, [p.id]: { ...ro, supersedes: e.target.value } })}><option value="">— new version —</option>{p.runs.filter((r: any) => !r.superseded_by).map((r: any) => <option key={r.id} value={r.id}>v{r.version} · {r.period_label}</option>)}</select></Field>
          {ro.supersedes && <Field label="Correction note *"><input style={{ ...inp, width: 260 }} value={ro.note ?? ""} onChange={(e) => setRunOpts({ ...runOpts, [p.id]: { ...ro, note: e.target.value } })} /></Field>}
          <button className="btn btn-p" disabled={!!act.busy} onClick={() => act.run("run", async () => { const r = await post(`/report-packs/${p.id}/run`, { period_label: ro.period || undefined, supersedes_run_id: ro.supersedes || undefined, correction_note: ro.note || undefined }); openUrl(r.url); return `v${r.version} generated (${r.page_count} pages)${r.failures?.length ? ` — ${r.failures.length} section(s) could not be built` : ""}${r.delivered_to?.length ? ` · sent to ${r.delivered_to.join(", ")}` : ""}`; })}><Play size={14} /> Generate</button>
        </div>}
        {p.runs.length > 0 && <table className="tbl" style={{ marginTop: 8 }}><thead><tr><th>Version</th><th>Period</th><th>Generated</th><th>Pages</th><th>Status</th><th></th></tr></thead><tbody>
          {p.runs.map((r: any) => <tr key={r.id}><td><b>v{r.version}</b>{r.supersedes_run_id && <div className="small mute">corrects an earlier version</div>}{r.superseded_by && <div className="small mute">superseded by v{r.superseded_by.version}</div>}</td><td className="small">{r.period_label}{r.correction_note && <div className="small" style={{ color: "var(--amber)" }}>{r.correction_note}</div>}</td><td className="small">{fmtTs(r.generated_at)}</td><td className="num small">{r.page_count ?? "—"}</td><td><Pill tone={tone(r.status)}>{r.status}</Pill>{r.error && <div className="small err">{r.error}</div>}</td><td>{r.url && <button className="btn btn-s" onClick={() => openUrl(r.url)}><Download size={14} /></button>}</td></tr>)}
        </tbody></table>}
      </Card>; })}
      {act.msg}
    </div>
    {member && <Card title="New pack">
      <div className="row gap" style={{ flexWrap: "wrap", alignItems: "flex-end" }}>
        <Field label="Name"><input style={inp} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
        <Field label="Audience"><select style={inp} value={form.audience} onChange={(e) => setForm({ ...form, audience: e.target.value })}>{["principal", "family", "ca", "advisor", "trustee"].map((a) => <option key={a}>{a}</option>)}</select></Field>
        <Field label="Recipients (comma-separated)"><input style={{ ...inp, width: 260 }} value={form.recipients} onChange={(e) => setForm({ ...form, recipients: e.target.value })} /></Field>
        <Field label="Cron (IST, optional)"><input style={inp} placeholder="0 9 5 1,4,7,10 *" value={form.cron ?? ""} onChange={(e) => setForm({ ...form, cron: e.target.value })} /></Field>
      </div>
      <div className="row gap" style={{ flexWrap: "wrap", alignItems: "flex-end", marginTop: 8 }}>
        <Field label="Add report"><select style={inp} value={sec.report_code} onChange={(e) => setSec({ ...sec, report_code: e.target.value })}><option value="">—</option>{(cat.data ?? []).filter((r) => r.formats.includes("pdf")).map((r) => <option key={r.code} value={r.code}>{r.name}</option>)}</select></Field>
        <Field label="Entity"><select style={inp} value={sec.entity_id} onChange={(e) => setSec({ ...sec, entity_id: e.target.value })}><option value="">All</option>{(ents.data ?? []).map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}</select></Field>
        <button className="btn btn-s" disabled={!sec.report_code} onClick={() => setForm({ ...form, sections: [...form.sections, { report_code: sec.report_code, params: sec.entity_id ? { entity_id: sec.entity_id } : {} }] })}><Plus size={14} /> Add</button>
      </div>
      <ol className="small">{form.sections.map((s: any, i: number) => <li key={i}>{cat.data?.find((r) => r.code === s.report_code)?.name}{s.params.entity_id ? ` · ${ents.data?.find((e) => e.id === s.params.entity_id)?.name}` : ""} <button className="btn btn-s" onClick={() => setForm({ ...form, sections: form.sections.filter((_: any, j: number) => j !== i) })}>×</button></li>)}</ol>
      <button className="btn btn-p" disabled={!form.name || !form.sections.length || !!act.busy} onClick={() => act.run("create", async () => { await post("/report-packs", { name: form.name, audience: form.audience, sections: form.sections, recipients: form.recipients.split(",").map((s: string) => s.trim()).filter(Boolean), cron: form.cron || null }); setForm({ name: "", audience: "ca", recipients: "", sections: [] }); return "Pack created"; })}>Create pack</button>
      <div className="small mute" style={{ marginTop: 8 }}>A pack is one PDF with a cover and contents, versioned per period. A corrected pack supersedes the earlier version with a note; both are retained. Scheduled packs run on their cron and go to the recipients.</div>
    </Card>}
  </div>);
}
function Schedules() {
  const [tick, setTick] = useState(0); const rows = useApi<any[]>("/report-schedules", [tick]); const cat = useApi<any[]>("/reports"); const act = useAction(() => setTick((t) => t + 1)); const member = ["owner", "member"].includes(role());
  const [form, setForm] = useState<any>({ report_code: "net_worth", cron: "0 8 1 * *", recipients: "", format: "pdf", name: "" });
  if (rows.loading || rows.error) return <Status loading={rows.loading} error={rows.error} />;
  return (<div className="grid-2">
    <Card title="Schedules">
      <table className="tbl"><thead><tr><th>Schedule</th><th>Cron (IST)</th><th>Next</th><th>Last</th><th></th></tr></thead><tbody>
        {rows.data!.map((s) => <tr key={s.id}><td><b>{s.name ?? s.report_code}</b><div className="small mute">{cat.data?.find((r) => r.code === s.report_code)?.name} · {s.format} · {s.recipients?.join(", ") || "no recipients"}</div></td><td className="small">{s.cron}{!s.active && <Pill tone="amber">paused</Pill>}</td><td className="small">{fmtTs(s.next_run_at)}</td><td className="small">{fmtTs(s.last_run_at)}{s.last_error && <div className="err">{s.last_error}</div>}</td><td className="row gap">{member && <><button className="btn btn-s" disabled={!!act.busy} onClick={() => act.run("run", async () => { const r = await post(`/report-schedules/${s.id}/run`, {}); return r.error ? `Failed: ${r.error}` : `Ran — delivered to ${r.delivered?.length ? r.delivered.join(", ") : "nobody (no recipients)"}`; })}><Send size={14} /></button><button className="btn btn-s" onClick={() => act.run("toggle", async () => { await api(`/report-schedules/${s.id}`, { method: "PATCH", body: JSON.stringify({ active: !s.active }) }); })}>{s.active ? "Pause" : "Resume"}</button><button className="btn btn-s" onClick={() => act.run("del", async () => { await api(`/report-schedules/${s.id}`, { method: "DELETE" }); })}><Trash2 size={14} /></button></>}</td></tr>)}
        {!rows.data!.length && <tr><td colSpan={5} className="mute small">No schedules.</td></tr>}
      </tbody></table>
      {act.msg}
    </Card>
    {member && <Card title="New schedule">
      <div className="row gap" style={{ flexWrap: "wrap", alignItems: "flex-end" }}>
        <Field label="Report"><select style={inp} value={form.report_code} onChange={(e) => setForm({ ...form, report_code: e.target.value })}>{(cat.data ?? []).map((r) => <option key={r.code} value={r.code}>{r.name}</option>)}</select></Field>
        <Field label="Format"><select style={inp} value={form.format} onChange={(e) => setForm({ ...form, format: e.target.value })}>{(cat.data?.find((r) => r.code === form.report_code)?.formats ?? ["pdf"]).map((f: string) => <option key={f}>{f}</option>)}</select></Field>
        <Field label="Cron (min hour dom month dow, IST)"><input style={inp} value={form.cron} onChange={(e) => setForm({ ...form, cron: e.target.value })} /></Field>
        <Field label="Recipients"><input style={{ ...inp, width: 240 }} value={form.recipients} onChange={(e) => setForm({ ...form, recipients: e.target.value })} /></Field>
        <Field label="Name"><input style={inp} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
        <button className="btn btn-p" disabled={!!act.busy} onClick={() => act.run("create", async () => { await post("/report-schedules", { ...form, name: form.name || undefined, recipients: form.recipients.split(",").map((s: string) => s.trim()).filter(Boolean) }); return "Scheduled"; })}>Create</button>
      </div>
      <div className="small mute" style={{ marginTop: 8 }}>Examples: <code>0 8 1 * *</code> monthly on the 1st at 08:00 · <code>0 9 5 1,4,7,10 *</code> quarterly to the CA · <code>30 18 * * 5</code> Fridays. The report runs with the creator's role and scope; recipients get a link valid for 7 days.</div>
    </Card>}
  </div>);
}
function External() {
  const [tick, setTick] = useState(0); const rows = useApi<any[]>("/external-access", [tick]); const cat = useApi<any[]>("/reports"); const ents = useApi<any[]>("/entities"); const act = useAction(() => setTick((t) => t + 1)); const owner = role() === "owner";
  const [form, setForm] = useState<any>({ email: "", label: "", expires_on: "", entities: [] as string[], modules: ["reports", "documents"], reports: [] as string[] }); const [invite, setInvite] = useState<any>(null); const [activity, setActivity] = useState<{ id: string; rows: any[] } | null>(null);
  const MODULES = ["reports", "documents", "books", "investments", "real_estate", "planning", "policy", "banking", "tasks", "goals", "startups", "imports", "research", "rebalancing", "action_plane"];
  const toggle = (k: "entities" | "modules" | "reports", v: string) => setForm({ ...form, [k]: form[k].includes(v) ? form[k].filter((x: string) => x !== v) : [...form[k], v] });
  if (rows.loading || rows.error) return <Status loading={rows.loading} error={rows.error} />;
  return (<div className="grid-2">
    <Card title="External viewers">
      {rows.data!.map((x) => <div key={x.id} className="attn" style={{ alignItems: "flex-start" }}><div style={{ flex: 1 }}><b>{x.label}</b> <span className="small mute">{x.email}</span><div className="small mute">modules {x.scope?.modules?.join(", ") || "all"} · reports {x.scope?.reports?.length ? x.scope.reports.join(", ") : "all in modules"} · entities {x.scope?.entities?.length ? x.scope.entities.map((id: string) => ents.data?.find((e) => e.id === id)?.name ?? id.slice(0, 8)).join(", ") : "all"}</div><div className="small mute">expires {fmtDate(x.expires_on)} · {x.views} views · last {fmtTs(x.last_viewed_at)} · invited by {x.invited_by_name ?? "—"}</div></div><Pill tone={tone(x.status)}>{x.status}</Pill><button className="btn btn-s" onClick={() => act.run("act", async () => { setActivity({ id: x.id, rows: await api(`/external-access/${x.id}/activity`) }); })}>Activity</button>{owner && !x.revoked_at && <button className="btn btn-s" onClick={() => { if (confirm(`Revoke ${x.label}?`)) act.run("revoke", async () => { await api(`/external-access/${x.id}`, { method: "DELETE" }); }); }}><Ban size={14} /></button>}</div>)}
      {activity && <div style={{ marginTop: 8 }}><div className="small mute">Audit trail</div>{activity.rows.slice(0, 40).map((a, i) => <div key={i} className="small">{fmtTs(a.at)} · {a.action} {a.table_name} {a.after?.report_code ?? a.after?.name ?? ""}</div>)}{!activity.rows.length && <div className="small mute">No activity yet.</div>}</div>}
      {invite && <div className="attn" style={{ flexDirection: "column", alignItems: "flex-start", background: "#FBF6E8", padding: 10, borderRadius: 8 }}><b>Invitation for {invite.email}</b><div className="small">Share this once — it is not shown again. The viewer sets a password with it at <code>POST /external-access/accept</code> (web: {invite.accept_url}).</div><code className="small" style={{ wordBreak: "break-all" }}>{invite.invite_token}</code></div>}
      {act.msg}
    </Card>
    {owner && <Card title="Invite an external viewer">
      <div className="row gap" style={{ flexWrap: "wrap", alignItems: "flex-end" }}>
        <Field label="E-mail"><input style={inp} value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></Field>
        <Field label="Label"><input style={inp} placeholder="CA – S. Krishnan" value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} /></Field>
        <Field label="Expires on"><input style={inp} type="date" value={form.expires_on} onChange={(e) => setForm({ ...form, expires_on: e.target.value })} /></Field>
      </div>
      <div className="small mute" style={{ marginTop: 8 }}>Entities (none = all)</div><div className="row gap" style={{ flexWrap: "wrap" }}>{(ents.data ?? []).map((e) => <label key={e.id} className="small"><input type="checkbox" checked={form.entities.includes(e.id)} onChange={() => toggle("entities", e.id)} /> {e.name}</label>)}</div>
      <div className="small mute" style={{ marginTop: 8 }}>Modules</div><div className="row gap" style={{ flexWrap: "wrap" }}>{MODULES.map((m) => <label key={m} className="small"><input type="checkbox" checked={form.modules.includes(m)} onChange={() => toggle("modules", m)} /> {label(m)}</label>)}</div>
      <div className="small mute" style={{ marginTop: 8 }}>Reports (none = every report in the modules above)</div><div className="row gap" style={{ flexWrap: "wrap" }}>{(cat.data ?? []).map((r) => <label key={r.code} className="small"><input type="checkbox" checked={form.reports.includes(r.code)} onChange={() => toggle("reports", r.code)} /> {r.name}</label>)}</div>
      <button className="btn btn-p" style={{ marginTop: 10 }} disabled={!form.email || !form.label || !form.expires_on || !!act.busy} onClick={() => act.run("invite", async () => { const r = await post("/external-access", { email: form.email, label: form.label, expires_on: form.expires_on, scope: { entities: form.entities, modules: form.modules, reports: form.reports } }); setInvite(r); setForm({ ...form, email: "", label: "" }); })}><UserPlus size={14} /> Invite</button>
      <div className="small mute" style={{ marginTop: 8 }}>An external viewer is a viewer membership bounded by scope and expiry: read-only, only the listed modules and reports, only the listed entities, every report view audit-logged. Revocation ends the membership.</div>
    </Card>}
  </div>);
}
function OpenData() {
  const [tick, setTick] = useState(0); const keys = useApi<any>("/api-keys", [tick]); const hooks = useApi<any>("/webhooks", [tick]); const exps = useApi<any[]>("/export", [tick]); const ds = useApi<any[]>("/export/datasets"); const ents = useApi<any[]>("/entities"); const act = useAction(() => setTick((t) => t + 1)); const owner = role() === "owner";
  const [kf, setKf] = useState<any>({ label: "", scopes: ["read:investments"], expires_on: "", rate: 120 }); const [secret, setSecret] = useState<{ kind: string; value: string } | null>(null); const [wf, setWf] = useState<any>({ url: "", events: ["task.created"], label: "" }); const [deliv, setDeliv] = useState<{ id: string; rows: any[] } | null>(null);
  const [ef, setEf] = useState<any>({ dataset: "holdings", format: "csv", entity_id: "", from: "", to: "" });
  if (keys.loading || keys.error) return <Status loading={keys.loading} error={keys.error} />;
  const tog = (arr: string[], v: string) => (arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v]);
  return (<div className="grid-2">
    <div style={{ display: "grid", gap: 12 }}>
      <Card title="API keys">
        {secret && <div className="attn" style={{ flexDirection: "column", alignItems: "flex-start", background: "#FBF6E8", padding: 10, borderRadius: 8 }}><b>{secret.kind} — shown once</b><code className="small" style={{ wordBreak: "break-all" }}>{secret.value}</code><div className="small">Send it as <code>Authorization: Bearer …</code>; no X-Family-Id needed.</div></div>}
        {(keys.data?.keys ?? []).map((k: any) => <div key={k.id} className="attn"><Key size={14} /><span style={{ flex: 1 }}><b>{k.label}</b> <span className="small mute">{k.key_prefix}… · {k.scopes.join(" ")} · {k.rate_limit_per_min}/min{k.expires_on ? ` · expires ${fmtDate(k.expires_on)}` : ""} · last used {fmtTs(k.last_used_at)}</span></span><Pill tone={tone(k.status)}>{k.status}</Pill>{owner && k.status === "active" && <button className="btn btn-s" onClick={() => act.run("revoke", async () => { await api(`/api-keys/${k.id}`, { method: "DELETE" }); })}><Ban size={14} /></button>}</div>)}
        {owner && <div style={{ marginTop: 8 }}>
          <div className="row gap" style={{ flexWrap: "wrap", alignItems: "flex-end" }}><Field label="Label"><input style={inp} value={kf.label} onChange={(e) => setKf({ ...kf, label: e.target.value })} /></Field><Field label="Expires"><input style={inp} type="date" value={kf.expires_on} onChange={(e) => setKf({ ...kf, expires_on: e.target.value })} /></Field><Field label="Requests / min"><input style={{ ...inp, width: 80 }} type="number" value={kf.rate} onChange={(e) => setKf({ ...kf, rate: Number(e.target.value) })} /></Field><button className="btn btn-p" disabled={!kf.label || !kf.scopes.length || !!act.busy} onClick={() => act.run("key", async () => { const r = await post("/api-keys", { label: kf.label, scopes: kf.scopes, expires_on: kf.expires_on || null, rate_limit_per_min: kf.rate }); setSecret({ kind: `API key ${r.label}`, value: r.secret }); setKf({ ...kf, label: "" }); })}><Plus size={14} /> Create key</button></div>
          <div className="row gap small" style={{ flexWrap: "wrap", marginTop: 6 }}>{(keys.data?.scopes ?? []).map((s: string) => <label key={s}><input type="checkbox" checked={kf.scopes.includes(s)} onChange={() => setKf({ ...kf, scopes: tog(kf.scopes, s) })} /> {s}</label>)}</div>
        </div>}
      </Card>
      <Card title="Webhooks">
        {(hooks.data?.webhooks ?? []).map((w: any) => <div key={w.id} className="attn" style={{ alignItems: "flex-start" }}><Webhook size={14} /><span style={{ flex: 1 }}><b>{w.label}</b> <span className="small mute">{w.url}</span><div className="small mute">{w.events.join(", ")} · last delivery {fmtTs(w.last_delivery_at)} · {w.failures} consecutive failures</div></span><Pill tone={w.active ? "teal" : "amber"}>{w.active ? "active" : "paused"}</Pill><button className="btn btn-s" onClick={() => act.run("test", async () => { const r = await post(`/webhooks/${w.id}/test`, {}); return `Ping ${r.status}${r.code ? ` (HTTP ${r.code})` : ""}${r.error ? `: ${r.error}` : ""}`; })}>Ping</button><button className="btn btn-s" onClick={() => act.run("d", async () => { setDeliv({ id: w.id, rows: await api(`/webhooks/${w.id}/deliveries`) }); })}>Deliveries</button>{owner && <><button className="btn btn-s" onClick={() => act.run("toggle", async () => { await api(`/webhooks/${w.id}`, { method: "PATCH", body: JSON.stringify({ active: !w.active }) }); })}>{w.active ? "Pause" : "Resume"}</button><button className="btn btn-s" onClick={() => act.run("del", async () => { await api(`/webhooks/${w.id}`, { method: "DELETE" }); })}><Trash2 size={14} /></button></>}</div>)}
        {deliv && <div style={{ marginTop: 8 }}><div className="small mute">Recent deliveries</div>{deliv.rows.slice(0, 25).map((d) => <div key={d.id} className="attn small"><span style={{ flex: 1 }}>{d.event} · {fmtTs(d.created_at)}</span><Pill tone={tone(d.status)}>{d.status}</Pill><span className="mute">{d.attempts} attempt(s){d.last_status_code ? ` · HTTP ${d.last_status_code}` : ""}{d.last_error ? ` · ${d.last_error}` : ""}</span>{d.status !== "delivered" && <button className="btn btn-s" onClick={() => act.run("retry", async () => { const r = await post(`/webhooks/deliveries/${d.id}/retry`, {}); return `Retry: ${r.status}`; })}>Retry</button>}</div>)}</div>}
        {owner && <div style={{ marginTop: 8 }}>
          <div className="row gap" style={{ flexWrap: "wrap", alignItems: "flex-end" }}><Field label="URL"><input style={{ ...inp, width: 300 }} placeholder="https://…" value={wf.url} onChange={(e) => setWf({ ...wf, url: e.target.value })} /></Field><Field label="Label"><input style={inp} value={wf.label} onChange={(e) => setWf({ ...wf, label: e.target.value })} /></Field><button className="btn btn-p" disabled={!wf.url || !wf.events.length || !!act.busy} onClick={() => act.run("hook", async () => { const r = await post("/webhooks", { url: wf.url, events: wf.events, label: wf.label || null }); setSecret({ kind: `Webhook secret for ${r.label}`, value: r.secret }); setWf({ ...wf, url: "" }); })}><Plus size={14} /> Add webhook</button></div>
          <div className="row gap small" style={{ flexWrap: "wrap", marginTop: 6 }}>{(hooks.data?.events ?? []).map((e: string) => <label key={e}><input type="checkbox" checked={wf.events.includes(e)} onChange={() => setWf({ ...wf, events: tog(wf.events, e) })} /> {e}</label>)}</div>
          <div className="small mute" style={{ marginTop: 6 }}>Deliveries are signed <code>X-FO-Signature: t=…,v1=HMAC-SHA256(secret, t.body)</code>, retried at 1, 5, 30, 120 and 720 minutes, then dead-lettered with a notification.</div>
        </div>}
      </Card>
    </div>
    <Card title="Bulk export">
      <div className="row gap" style={{ flexWrap: "wrap", alignItems: "flex-end" }}>
        <Field label="Dataset"><select style={inp} value={ef.dataset} onChange={(e) => setEf({ ...ef, dataset: e.target.value })}>{(ds.data ?? []).map((d) => <option key={d.dataset} value={d.dataset}>{d.dataset}</option>)}</select></Field>
        <Field label="Format"><select style={inp} value={ef.format} onChange={(e) => setEf({ ...ef, format: e.target.value })}>{["csv", "xlsx", "jsonl", "parquet"].map((f) => <option key={f}>{f}</option>)}</select></Field>
        <Field label="Entity"><select style={inp} value={ef.entity_id} onChange={(e) => setEf({ ...ef, entity_id: e.target.value })}><option value="">All</option>{(ents.data ?? []).map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}</select></Field>
        <Field label="From"><input style={inp} type="date" value={ef.from} onChange={(e) => setEf({ ...ef, from: e.target.value })} /></Field>
        <Field label="To"><input style={inp} type="date" value={ef.to} onChange={(e) => setEf({ ...ef, to: e.target.value })} /></Field>
        <button className="btn btn-p" disabled={!!act.busy} onClick={() => act.run("export", async () => { const r = await post("/export", { dataset: ef.dataset, format: ef.format, entity_id: ef.entity_id || null, from: ef.from || null, to: ef.to || null }); openUrl(r.url); return `${r.row_count} rows → ${r.name}`; })}><Table2 size={14} /> Export</button>
      </div>
      <div className="small mute" style={{ marginTop: 6 }}>{ds.data?.find((d) => d.dataset === ef.dataset)?.description} · columns: {ds.data?.find((d) => d.dataset === ef.dataset)?.columns.map((c: any) => c.key).join(", ")}</div>
      {act.msg}
      <table className="tbl" style={{ marginTop: 8 }}><thead><tr><th>Export</th><th>Rows</th><th>When</th><th>Expires</th><th></th></tr></thead><tbody>
        {(exps.data ?? []).map((x) => <tr key={x.id}><td><b>{x.dataset}</b> <span className="small mute">{x.format}{x.filters?.entity_id ? ` · ${ents.data?.find((e) => e.id === x.filters.entity_id)?.name ?? "entity"}` : ""}</span>{x.error && <div className="err">{x.error}</div>}</td><td className="num small">{x.row_count ?? "—"}</td><td className="small">{fmtTs(x.created_at)}</td><td className="small">{fmtDate(x.expires_at)}</td><td>{x.url && <button className="btn btn-s" onClick={() => openUrl(x.url)}><Download size={14} /></button>}</td></tr>)}
        {!exps.data?.length && <tr><td colSpan={5} className="mute small">No exports yet.</td></tr>}
      </tbody></table>
      <div className="small mute" style={{ marginTop: 8 }}>Files land in Documents › Exports behind a signed link and are purged after 7 days. Parquet opens in Power BI, pandas and DuckDB; the same datasets are readable live through an API key with <code>read:*</code> scopes.</div>
    </Card>
    <ExportSchedules />
  </div>);
}

/** Scheduled exports (FO-104 v1.1): a dataset on a cron → export job → document + export.ready webhook; Power BI / Sheets pull the file. */
function ExportSchedules() {
  const list = useApi<any[]>("/export-schedules"); const ds = useApi<any[]>("/export/datasets"); const ents = useApi<any[]>("/entities"); const act = useAction(() => list.refetch());
  const [f, setF] = useState<any | null>(null);
  return (<Card title="Scheduled exports" action={<button className="btn btn-s" onClick={() => setF(f ? null : { name: "", dataset: "holdings", format: "csv", cron: "0 6 * * 1", entity_id: "" })}><Plus size={14} /> Schedule</button>}>
    {act.msg}
    {f && <div className="row gap" style={{ flexWrap: "wrap", alignItems: "flex-end", marginBottom: 8 }}>
      <Field label="Name"><input style={inp} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Weekly holdings to Power BI" /></Field>
      <Field label="Dataset"><select style={inp} value={f.dataset} onChange={(e) => setF({ ...f, dataset: e.target.value })}>{(ds.data ?? []).map((d) => <option key={d.dataset} value={d.dataset}>{d.dataset}</option>)}</select></Field>
      <Field label="Format"><select style={inp} value={f.format} onChange={(e) => setF({ ...f, format: e.target.value })}>{["csv", "xlsx", "jsonl", "parquet"].map((x) => <option key={x}>{x}</option>)}</select></Field>
      <Field label="Entity"><select style={inp} value={f.entity_id} onChange={(e) => setF({ ...f, entity_id: e.target.value })}><option value="">All</option>{(ents.data ?? []).map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}</select></Field>
      <Field label="Cron (UTC, 5 fields)"><input style={{ ...inp, width: 120 }} value={f.cron} onChange={(e) => setF({ ...f, cron: e.target.value })} /></Field>
      <button className="btn btn-p" disabled={!!act.busy} onClick={() => act.run("sched", async () => { await api("/export-schedules", { method: "POST", body: JSON.stringify({ name: f.name || undefined, dataset: f.dataset, format: f.format, cron: f.cron, filters: f.entity_id ? { entity_id: f.entity_id } : {} }) }); setF(null); return "Schedule created"; })}>Create</button></div>}
    <table className="tbl"><thead><tr><th>Schedule</th><th>Cron</th><th>Next run</th><th>Last run</th><th></th></tr></thead><tbody>
      {(list.data ?? []).map((s) => <tr key={s.id}><td><b>{s.name}</b><div className="small mute">{s.dataset} · {s.format}{s.filters?.entity_id ? " · one entity" : ""}{s.webhook ? " · export.ready webhook" : ""}</div></td><td><code>{s.cron}</code></td><td className="small">{s.active ? fmtDate(s.next_run_at) : <Pill>paused</Pill>}</td><td className="small">{s.last_run_at ? `${fmtDate(s.last_run_at)}${s.last_error ? ` · ${s.last_error}` : ""}` : "—"}</td>
        <td className="row gap" style={{ justifyContent: "flex-end" }}><button className="btn btn-s" disabled={!!act.busy} onClick={() => act.run(s.id, async () => { const r: any = await api(`/export-schedules/${s.id}/run`, { method: "POST", body: "{}" }); return r?.export_id ? `${r.rows} rows exported` : r?.error ?? "ran"; })}><Play size={12} /> Run now</button><button className="btn btn-s" disabled={!!act.busy} onClick={() => act.run(s.id + "t", async () => { await api(`/export-schedules/${s.id}`, { method: "PATCH", body: JSON.stringify({ active: !s.active }) }); })}>{s.active ? "Pause" : "Resume"}</button><button className="btn btn-s" disabled={!!act.busy} onClick={() => act.run(s.id + "d", async () => { await api(`/export-schedules/${s.id}`, { method: "DELETE" }); })}><Trash2 size={12} /></button></td></tr>)}
      {!list.data?.length && <tr><td colSpan={5} className="mute small">No schedules. Each run is an ordinary export: the file lands in Documents › Exports and export.ready fires for every webhook that subscribes.</td></tr>}
    </tbody></table>
    <div className="small mute" style={{ marginTop: 8 }}>The worker runs due schedules hourly; MCP clients (Claude Desktop, Cursor) can read the same data live with an API key — see DEV-SETUP.</div>
  </Card>);
}

