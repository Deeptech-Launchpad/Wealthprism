import { useState } from "react";
import { Plus } from "lucide-react";
import { useApi } from "../lib/useApi";
import { api, inr } from "../lib/api";
import { Card, Pill, Status, fmtDate } from "../components";

const MODULES = ["real_estate", "investments", "banking", "startups", "goals", "working_capital", "planning", "books", "policy"];
const SOURCE_LABEL: Record<string, string> = { rent_schedule: "rent", lease_expiry: "lease", property_tax: "property tax", gst_return: "GST", aa_consent: "AA consent", committed_outflow: "drawdown", bank_txn: "bank credit", import_job: "import", instrument: "price feed", corporate_action: "corporate action", tds_mismatch: "26AS" };

export function Tasks() {
  const [status, setStatus] = useState<"open" | "done" | "dismissed">("open");
  const [module, setModule] = useState(""); const [entity, setEntity] = useState(""); const [sort, setSort] = useState<"newest" | "urgent">("newest");
  const q = `/tasks?status=${status}${module ? `&module=${module}` : ""}${entity ? `&entity_id=${entity}` : ""}`;
  const { data, error, loading, refetch } = useApi<any[]>(q);
  const ents = useApi<any[]>("/entities"); const members = useApi<any[]>("/members");
  const [err, setErr] = useState(""); const [form, setForm] = useState<any | null>(null);
  const patch = async (id: string, body: any) => { setErr(""); try { await api(`/tasks/${id}`, { method: "PATCH", body: JSON.stringify(body) }); refetch(); } catch (e: any) { setErr(e.message); } };
  const create = async () => { setErr(""); try { await api("/tasks", { method: "POST", body: JSON.stringify({ ...form, amount: form.amount ? Number(form.amount) : undefined, entity_id: form.entity_id || undefined, due_date: form.due_date || undefined, severity: Number(form.severity) }) }); setForm(null); refetch(); } catch (e: any) { setErr(e.message); } };
  // newest first by default so a task that was just raised is at the top; "most urgent" keeps the server's order (severity, then due date)
  const shown = sort === "newest" ? [...(data ?? [])].sort((a, b) => +new Date(b.created_at) - +new Date(a.created_at)) : (data ?? []);
  const stamp = (v: string) => new Date(v).toLocaleString("en-IN", { day: "2-digit", month: "short", year: "numeric", hour: "numeric", minute: "2-digit", hour12: true });
  const fresh = (v: string) => Date.now() - new Date(v).getTime() < 24 * 3600 * 1000;
  const bySeverity = (n: number) => (data ?? []).filter((t) => t.severity === n).length;
  return (<>
    <div className="row gap" style={{ flexWrap: "wrap", justifyContent: "space-between" }}>
      <div className="tabs" style={{ borderBottom: 0 }}>{(["open", "done", "dismissed"] as const).map((s) => <button key={s} className={status === s ? "on" : ""} onClick={() => setStatus(s)}>{s}</button>)}</div>
      <div className="row gap">
        <select className="field" style={{ padding: 6 }} value={sort} onChange={(e) => setSort(e.target.value as any)} title="Order of the list"><option value="newest">Newest first</option><option value="urgent">Most urgent first</option></select>
        <select className="field" style={{ padding: 6 }} value={module} onChange={(e) => setModule(e.target.value)}><option value="">All modules</option>{MODULES.map((m) => <option key={m} value={m}>{m.replace("_", " ")}</option>)}</select>
        <select className="field" style={{ padding: 6 }} value={entity} onChange={(e) => setEntity(e.target.value)}><option value="">All entities</option>{(ents.data ?? []).map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}</select>
        <button className="btn btn-s btn-p" onClick={() => setForm({ module: "banking", title: "", reason: "", severity: 2, due_date: "", amount: "", entity_id: "" })}><Plus size={13} /> New task</button>
      </div>
    </div>
    {err && <div className="err">{err}</div>}
    {loading && !data ? <Status loading error={error} /> : error ? <Status loading={false} error={error} /> : (
      <Card title={`${data!.length} ${status}`} action={status === "open" && <span className="small mute"><span className="down">{bySeverity(1)} urgent</span> · {bySeverity(2)} soon · {bySeverity(3)} routine</span>}>
        {!data!.length && <div className="small mute">Nothing here. Generators run hourly: rent overdue, lease expiry, property tax, GST filing, AA consent expiry, drawdowns, unmatched credits, import failures, stale prices, TDS mismatches.</div>}
        {shown.map((t) => <div key={t.id} className="attn" style={{ flexWrap: "wrap" }}>
          <Pill tone={t.severity === 1 ? "red" : t.severity === 2 ? "amber" : undefined}>{t.module.replace("_", " ")}</Pill>
          <div style={{ flex: 1, minWidth: 260 }}><b>{t.title}</b>{status === "open" && fresh(t.created_at) && <span style={{ marginLeft: 6 }}><Pill tone="teal">new</Pill></span>}<div className="small mute">{t.reason}{t.entity_name ? ` · ${t.entity_name}` : ""}{t.due_date ? ` · due ${fmtDate(t.due_date)}` : ""}{t.amount ? ` · ${inr(t.amount)}` : ""}{t.source_type ? ` · from ${SOURCE_LABEL[t.source_type] ?? t.source_type}` : ""}{t.created_by === "user" ? " · manual" : ""}</div><div className="small mute">Raised {stamp(t.created_at)}{t.done_at && status !== "open" ? ` · closed ${stamp(t.done_at)}` : ""}</div></div>
          {t.verification !== "na" && <Pill tone={t.verification === "verified" ? "teal" : t.verification === "mismatch" ? "red" : "amber"}>{t.verification === "pending" ? "awaiting import" : t.verification}</Pill>}
          <select className="field" style={{ padding: 4, fontSize: 12 }} value={t.assignee_user_id ?? ""} onChange={(e) => patch(t.id, { assignee_user_id: e.target.value || null })} title="Assignee"><option value="">Unassigned</option>{(members.data ?? []).map((m) => <option key={m.user_id} value={m.user_id}>{m.name}</option>)}</select>
          {status === "open" ? <><button className="btn btn-s" onClick={() => patch(t.id, { status: "done" })}>Done</button><button className="btn btn-s" onClick={() => patch(t.id, { status: "dismissed" })}>Dismiss</button></> : <button className="btn btn-s" onClick={() => patch(t.id, { status: "open" })}>Reopen</button>}
        </div>)}
      </Card>
    )}
    {form && <div className="modal-bg" onClick={() => setForm(null)}><div className="modal" onClick={(e) => e.stopPropagation()}>
      <h3 style={{ margin: 0 }}>New task</h3>
      <div className="grid-2">
        <label className="field">Title<input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} /></label>
        <label className="field">Module<select value={form.module} onChange={(e) => setForm({ ...form, module: e.target.value })}>{MODULES.map((m) => <option key={m} value={m}>{m.replace("_", " ")}</option>)}</select></label>
        <label className="field">Why / notes<input value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} /></label>
        <label className="field">Entity<select value={form.entity_id} onChange={(e) => setForm({ ...form, entity_id: e.target.value })}><option value="">All</option>{(ents.data ?? []).map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}</select></label>
        <label className="field">Due<input type="date" value={form.due_date} onChange={(e) => setForm({ ...form, due_date: e.target.value })} /></label>
        <label className="field">Amount (₹)<input type="number" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} /></label>
        <label className="field">Severity<select value={form.severity} onChange={(e) => setForm({ ...form, severity: e.target.value })}><option value={1}>1 — urgent (push)</option><option value={2}>2 — soon</option><option value={3}>3 — routine</option></select></label>
      </div>
      <div className="row gap" style={{ justifyContent: "flex-end" }}><button className="btn" onClick={() => setForm(null)}>Cancel</button><button className="btn btn-p" disabled={!form.title} onClick={create}>Create</button></div>
    </div></div>}
  </>);
}
