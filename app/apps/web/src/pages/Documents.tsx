import { useState } from "react";
import { Upload, FolderPlus, FileText, Check, X, Sparkles, ExternalLink, Trash2, Lock } from "lucide-react";
import { useApi } from "../lib/useApi";
import { api, apiJson, apiUpload, session } from "../lib/api";
import { Card, Pill, Status, fmtDate } from "../components";

const inp = { background: "#fff", color: "var(--ink)", borderColor: "var(--line)" } as const;
const role = () => session.get()?.families.find((f) => f.id === session.family())?.role ?? "viewer";
const kb = (n: number) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const tone = (s?: string | null) => (s === "approved" || s === "extracted" || s === "clean" ? "teal" : s === "needs_review" || s === "skipped" ? "amber" : s === "rejected" || s === "infected" ? "red" : undefined);
const openUrl = (u?: string | null) => { if (u) window.open(u, "_blank", "noopener"); };
function Field({ label, children }: { label: string; children: React.ReactNode }) { return <label className="field">{label}{children}</label>; }
function useAction(after?: () => void) {
  const [busy, setBusy] = useState(""); const [err, setErr] = useState(""); const [note, setNote] = useState("");
  const run = async (l: string, fn: () => Promise<string | void>) => { setBusy(l); setErr(""); setNote(""); try { const n = await fn(); if (n) setNote(n); after?.(); } catch (e: any) { setErr(e.message); } finally { setBusy(""); } };
  return { busy, err, note, run, msg: <>{err && <div className="err">{err}</div>}{note && <div className="small" style={{ color: "var(--teal)" }}>{note}</div>}</> };
}
const TABS = ["Library", "Review queue"] as const;

export function Documents() {
  const [tab, setTab] = useState<(typeof TABS)[number]>("Library");
  return (<>
    <div className="tabs">{TABS.map((t) => <button key={t} className={tab === t ? "on" : ""} onClick={() => setTab(t)}>{t}</button>)}</div>
    {tab === "Library" && <Library />}
    {tab === "Review queue" && <Queue />}
  </>);
}

function Library() {
  const [folder, setFolder] = useState<string | null>(null); const [q, setQ] = useState(""); const [sel, setSel] = useState<string | null>(null); const [tick, setTick] = useState(0);
  const folders = useApi<any[]>("/folders", [tick]); const ents = useApi<any[]>("/entities");
  const list = useApi<any[]>(`/documents?${folder ? `folder_id=${folder}&` : ""}${q ? `q=${encodeURIComponent(q)}&` : ""}limit=200`, [tick]);
  const detail = useApi<any>(sel ? `/documents/${sel}` : null, [tick]); const extractions = useApi<any[]>(sel ? `/documents/${sel}/extractions` : null, [tick]);
  const act = useAction(() => setTick((t) => t + 1)); const writer = ["owner", "member", "operator"].includes(role()); const [adding, setAdding] = useState(false); const [newFolder, setNewFolder] = useState("");
  const [form, setForm] = useState<any>({ entity_id: "", linked_type: "", linked_id: "", password: "" }); const [file, setFile] = useState<File | null>(null);
  const upload = () => act.run("upload", async () => { if (!file) throw new Error("Choose a file"); const fd = new FormData(); fd.append("file", file); if (folder) fd.append("folder_id", folder); for (const k of ["entity_id", "linked_type", "linked_id", "password"]) if (form[k]) fd.append(k, form[k]); const r: any = await apiUpload("/documents", fd); if (r.status_code >= 400) throw new Error(r.title ?? "Upload failed"); setFile(null); setSel(r.id); return r.duplicate ? "Already in the library — the same file was stored earlier" : `Stored ${r.name}`; });
  if (folders.loading || folders.error) return <Status loading={folders.loading} error={folders.error} />;
  const d = detail.data;
  return (<div className="grid-2" style={{ gridTemplateColumns: "260px 1fr" }}>
    <Card title="Folders" action={writer && <button className="btn btn-s" onClick={() => setAdding((v) => !v)}><FolderPlus size={14} /> New</button>}>
      <div className={`attn small ${folder === null ? "on" : ""}`} style={{ cursor: "pointer", fontWeight: folder === null ? 600 : 400 }} onClick={() => { setFolder(null); setSel(null); }}><span style={{ flex: 1 }}>All documents</span></div>
      {(folders.data ?? []).map((f) => <div key={f.id} className="attn small" style={{ cursor: "pointer", fontWeight: folder === f.id ? 600 : 400 }} onClick={() => { setFolder(f.id); setSel(null); }}><span style={{ flex: 1 }}>{f.name}{!f.system && <span className="mute"> · custom</span>}</span><span className="mute">{f.count}</span></div>)}
      {adding && <div className="row gap" style={{ marginTop: 8 }}><input style={inp} placeholder="Folder name" value={newFolder} onChange={(e) => setNewFolder(e.target.value)} /><button className="btn btn-p" disabled={!newFolder || !!act.busy} onClick={() => act.run("folder", async () => { await apiJson("/folders", { name: newFolder }); setNewFolder(""); setAdding(false); })}>Add</button></div>}
      <div className="small mute" style={{ marginTop: 10 }}>System folders per family (deeds, tax filings, statements, SHAs, bank statements, insurance, wills, reports, exports). Documents link to the property, lease, holding or investment they belong to.</div>
    </Card>
    <div style={{ display: "grid", gap: 12 }}>
      <Card title={folder ? folders.data!.find((f) => f.id === folder)?.name : "All documents"} action={<div className="row gap"><input style={inp} placeholder="Search name, text or tag" value={q} onChange={(e) => setQ(e.target.value)} /></div>}>
        {writer && <div className="row gap" style={{ flexWrap: "wrap", alignItems: "flex-end", marginBottom: 10 }}>
          <Field label="File (PDF, JPG, PNG, XLS(X), DOCX, CSV, TXT · 25 MB)"><input type="file" onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></Field>
          <Field label="Entity"><select style={inp} value={form.entity_id} onChange={(e) => setForm({ ...form, entity_id: e.target.value })}><option value="">—</option>{(ents.data ?? []).map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}</select></Field>
          <Field label="Link to"><select style={inp} value={form.linked_type} onChange={(e) => setForm({ ...form, linked_type: e.target.value })}><option value="">—</option>{["property", "lease", "holding", "private_investment", "insurance_policy", "liability", "plan_scenario", "policy_version"].map((t) => <option key={t} value={t}>{t.replace(/_/g, " ")}</option>)}</select></Field>
          <Field label="Linked id"><input style={{ ...inp, width: 250 }} placeholder="uuid" value={form.linked_id} onChange={(e) => setForm({ ...form, linked_id: e.target.value })} /></Field>
          <Field label="PDF password"><input style={{ ...inp, width: 120 }} type="password" placeholder="PAN for CAS" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} /></Field>
          <button className="btn btn-p" disabled={!file || !!act.busy} onClick={upload}><Upload size={14} /> Upload</button>
        </div>}
        {act.msg}
        {list.loading ? <div className="mute small">Loading…</div> : <table className="tbl"><thead><tr><th>Name</th><th>Type</th><th>Entity</th><th>Linked</th><th>Size</th><th>Uploaded</th><th></th></tr></thead><tbody>
          {(list.data ?? []).map((x) => <tr key={x.id} style={{ cursor: "pointer", background: sel === x.id ? "#F6F8FB" : undefined }} onClick={() => setSel(x.id)}><td><b>{x.name}</b>{x.tags?.length ? <div className="small mute">{x.tags.join(" · ")}</div> : null}</td><td className="small">{x.doc_type ?? x.mime.split("/")[1]}{x.source !== "upload" && <span className="mute"> · {x.source}</span>}</td><td className="small">{x.entity_name ?? "—"}</td><td className="small">{x.linked_type ? `${x.linked_type.replace(/_/g, " ")}` : "—"}</td><td className="num small">{kb(x.size)}</td><td className="small">{fmtDate(x.created_at)}</td><td>{x.tags?.includes("password-protected") && <Lock size={13} />}</td></tr>)}
          {!list.data?.length && <tr><td colSpan={7} className="mute small">Nothing here yet.</td></tr>}
        </tbody></table>}
      </Card>
      {d && <Card title={d.name} action={<div className="row gap">
        <button className="btn btn-s" onClick={() => openUrl(d.url)}><ExternalLink size={14} /> Open</button>
        {writer && d.mime === "application/pdf" && d.tags?.includes("password-protected") && <button className="btn btn-s" onClick={() => { const p = prompt("PDF password (the holder's PAN for CAS statements)"); if (p) act.run("unlock", async () => { await apiJson(`/documents/${d.id}/unlock`, { password: p }); return "Unlocked — text extracted"; }); }}><Lock size={14} /> Unlock</button>}
        {writer && <button className="btn btn-s" disabled={!!act.busy} onClick={() => act.run("extract", async () => { const r: any = await apiJson(`/documents/${d.id}/extract`, {}); if (r.status_code >= 400) throw new Error(r.title); return r.status === "extracted" ? "Extracted with high confidence — approve to apply" : "In the review queue"; })}><Sparkles size={14} /> Extract</button>}
        {["owner", "member"].includes(role()) && <button className="btn btn-s" disabled={!!act.busy} onClick={() => { if (confirm("Delete this document?")) act.run("delete", async () => { await api(`/documents/${d.id}`, { method: "DELETE" }); setSel(null); }); }}><Trash2 size={14} /></button>}
      </div>}>
        <div className="row gap small mute" style={{ flexWrap: "wrap" }}><span>{d.mime}</span><span>· {kb(d.size)}</span><span>· sha-256 {d.sha256.slice(0, 12)}…</span><span>· scan {d.scan_status}</span><span>· {d.has_text ? `${d.text_chars.toLocaleString("en-IN")} chars of text` : "no text"}</span>{d.folder_name && <span>· {d.folder_name}</span>}{d.entity_name && <span>· {d.entity_name}</span>}{d.linked_type && <span>· linked to {d.linked_type.replace(/_/g, " ")} {d.linked_id.slice(0, 8)}</span>}{d.report_code && <span>· report {d.report_code}</span>}{d.expires_at && <span>· expires {fmtDate(d.expires_at)}</span>}</div>
        {(extractions.data ?? []).map((x) => <ExtractionRow key={x.id} x={x} onChange={() => setTick((t) => t + 1)} ents={ents.data ?? []} />)}
        <div className="small mute" style={{ marginTop: 8 }}>Links are signed and expire in 15 minutes; every download by an external viewer is audit-logged. Extraction classifies with the importers first; an optional model call sees PII-masked text only. Nothing is written to the books until a person approves.</div>
      </Card>}
    </div>
  </div>);
}
function ExtractionRow({ x, onChange, ents }: { x: any; onChange: () => void; ents: any[] }) {
  const act = useAction(onChange); const [entity, setEntity] = useState(x.entity_id ?? ""); const [note, setNote] = useState(""); const open = !["approved", "rejected"].includes(x.status); const writer = ["owner", "member", "operator"].includes(role());
  return (<div className="attn" style={{ alignItems: "flex-start", flexDirection: "column", gap: 6 }}>
    <div className="row gap" style={{ width: "100%" }}><FileText size={14} /><b style={{ flex: 1 }}>{(x.doc_type ?? "other").replace(/_/g, " ")}</b><Pill tone={tone(x.status)}>{x.status.replace(/_/g, " ")}</Pill><span className="small mute">confidence {(Number(x.confidence) * 100).toFixed(0)}% · {x.model}{x.redactions ? ` · ${x.redactions} PII spans masked` : ""}</span></div>
    <div className="small">{x.summary}</div>
    {x.extracted && Object.keys(x.extracted).length > 0 && <pre className="small" style={{ margin: 0, whiteSpace: "pre-wrap", maxHeight: 160, overflow: "auto", background: "#F6F8FB", padding: 8, borderRadius: 6, width: "100%" }}>{JSON.stringify(x.extracted, null, 1).slice(0, 2500)}</pre>}
    {x.review_note && <div className="small mute">Note: {x.review_note}{x.reviewed_by_name ? ` — ${x.reviewed_by_name}` : ""}</div>}
    {x.applied_import_job_id && <div className="small">Applied as import job {x.applied_import_job_id.slice(0, 8)} — see Investments › Imports.</div>}
    {open && writer && <div className="row gap" style={{ flexWrap: "wrap" }}>
      {x.source_kind && <select style={inp} value={entity} onChange={(e) => setEntity(e.target.value)}><option value="">Entity from the file</option>{ents.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}</select>}
      <input style={inp} placeholder="Review note" value={note} onChange={(e) => setNote(e.target.value)} />
      <button className="btn btn-p" disabled={!!act.busy} onClick={() => act.run("approve", async () => { const r: any = await apiJson(`/documents/extractions/${x.id}/decide`, { decision: "approve", note: note || undefined, entity_id: entity || undefined }); if (r.status_code >= 400) throw new Error(r.title); return r.import_job ? `Import ${r.import_job.status}: ${r.import_job.rows_ok ?? 0} rows` : r.task ? `Task created: ${r.task.title}` : "Approved"; })}><Check size={14} /> Approve{x.source_kind ? " & import" : ""}</button>
      <button className="btn btn-s" disabled={!!act.busy} onClick={() => act.run("reject", async () => { await apiJson(`/documents/extractions/${x.id}/decide`, { decision: "reject", note: note || undefined }); })}><X size={14} /> Reject</button>
    </div>}
    {act.msg}
  </div>);
}
function Queue() {
  const [tick, setTick] = useState(0); const q = useApi<any[]>("/documents/extractions", [tick]); const ents = useApi<any[]>("/entities");
  if (q.loading || q.error) return <Status loading={q.loading} error={q.error} />;
  const pending = (q.data ?? []).filter((x) => ["needs_review", "extracted"].includes(x.status)); const done = (q.data ?? []).filter((x) => !["needs_review", "extracted"].includes(x.status));
  return (<div className="grid-2">
    <Card title={`Awaiting review · ${pending.length}`}>{pending.map((x) => <div key={x.id}><div className="small mute" style={{ marginTop: 8 }}>{x.document_name}</div><ExtractionRow x={x} onChange={() => setTick((t) => t + 1)} ents={ents.data ?? []} /></div>)}{!pending.length && <div className="mute small">Nothing waiting. Upload a CAS, contract note, bank statement, 26AS or capital-call notice and press Extract.</div>}</Card>
    <Card title="Decided">{done.slice(0, 30).map((x) => <div key={x.id} className="attn small"><span style={{ flex: 1 }}><b>{x.document_name}</b> · {(x.doc_type ?? "other").replace(/_/g, " ")}</span><Pill tone={tone(x.status)}>{x.status}</Pill><span className="mute">{x.reviewed_by_name ?? ""} {fmtDate(x.reviewed_at)}</span></div>)}{!done.length && <div className="mute small">No decisions yet.</div>}</Card>
  </div>);
}
