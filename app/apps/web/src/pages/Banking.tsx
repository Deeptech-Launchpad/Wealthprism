import { useState } from "react";
import { Upload, RefreshCw, Link2, Plus, Trash2, Play, Inbox, ShieldCheck, ShieldAlert } from "lucide-react";
import { useApi } from "../lib/useApi";
import { api, apiJson, inr, session } from "../lib/api";
import { Card, Pill, Status, fmtDate } from "../components";
import { ImportPanel } from "./Imports";

// Banking (PRD 3.4; FO-51, 52, 54, 57): accounts with sync state and the Account Aggregator flow, transactions with search / filters and inline
// re-categorisation that can learn a rule, the rule editor, the cash-flow view and the e-mail ingest inbox.
const inp = { background: "#fff", color: "var(--ink)", borderColor: "var(--line)" } as const;
const role = () => session.get()?.families.find((f) => f.id === session.family())?.role ?? "viewer";
const canWrite = () => ["owner", "member", "operator"].includes(role()); const isMember = () => ["owner", "member"].includes(role());
const R = { textAlign: "right" as const }; const label = (s?: string | null) => (s ?? "").replace(/_/g, " ");
function Field({ label, children }: { label: string; children: React.ReactNode }) { return <label className="field">{label}{children}</label>; }
function useAction(after?: () => void) {
  const [busy, setBusy] = useState(""); const [err, setErr] = useState(""); const [note, setNote] = useState("");
  const run = async (l: string, fn: () => Promise<string | void>) => { setBusy(l); setErr(""); setNote(""); try { const n = await fn(); if (n) setNote(n); after?.(); } catch (e: any) { setErr(e.message); } finally { setBusy(""); } };
  return { busy, err, note, run, msg: <>{err && <div className="err">{err}</div>}{note && <div className="small" style={{ color: "var(--teal)" }}>{note}</div>}</> };
}
const TABS = ["Accounts", "Transactions", "Rules", "Cash flow", "Inbox"] as const;

export function Banking() {
  const [tab, setTab] = useState<(typeof TABS)[number]>("Accounts");
  return (<>
    <div className="tabs">{TABS.map((t) => <button key={t} className={tab === t ? "on" : ""} onClick={() => setTab(t)}>{t}</button>)}</div>
    {tab === "Accounts" && <Accounts />}
    {tab === "Transactions" && <Transactions />}
    {tab === "Rules" && <Rules />}
    {tab === "Cash flow" && <Cashflow />}
    {tab === "Inbox" && <InboxPanel />}
  </>);
}

function Accounts() {
  const [tick, setTick] = useState(0); const [importing, setImporting] = useState<string | null>(null); const [connect, setConnect] = useState(false); const [add, setAdd] = useState(false); const [ed, setEd] = useState<any | null>(null);
  const a = useApi<any[]>("/bank-accounts", [tick]); const consents = useApi<any[]>("/aa/consents", [tick]); const ents = useApi<any[]>("/entities"); const act = useAction(() => setTick((t) => t + 1));
  const [c, setC] = useState({ entity_id: "", mobile: "", provider: "mock" }); const [n, setN] = useState({ entity_id: "", bank: "", account_masked: "", type: "savings", balance: "" });
  if (!a.data) return <Status loading={a.loading} error={a.error} />;
  const pending = (consents.data ?? []).filter((x) => x.status === "pending");
  return (<>
    <div className="kpis">
      <Card><div className="mute">Cash across accounts</div><div className="big-num">{inr(a.data.filter((x) => x.type !== "card").reduce((s, x) => s + Number(x.balance), 0))}</div><div className="small mute">{a.data.length} accounts</div></Card>
      <Card><div className="mute">Linked through AA</div><div className="big-num">{a.data.filter((x) => x.sync_mode === "aa").length}</div><div className="small mute">{(consents.data ?? []).filter((x) => x.status === "active").length} active consents</div></Card>
      <Card><div className="mute">Consents expiring ≤ 30 d</div><div className="big-num" style={{ color: a.data.some((x) => x.consent_expires_on && new Date(x.consent_expires_on).getTime() - Date.now() < 30 * 86400000) ? "var(--amber)" : "var(--teal)" }}>{a.data.filter((x) => x.consent_expires_on && new Date(x.consent_expires_on).getTime() - Date.now() < 30 * 86400000).length}</div></Card>
      <Card><div className="mute">Actions</div><div className="row" style={{ gap: 6, flexWrap: "wrap" }}>{canWrite() && <button className="btn btn-s" onClick={() => { setConnect(!connect); setAdd(false); }}><Link2 size={13} /> Connect via AA</button>}{canWrite() && <button className="btn btn-s" onClick={() => { setAdd(!add); setConnect(false); }}><Plus size={13} /> Manual account</button>}<button className="btn btn-s" onClick={() => setImporting(importing === null ? "" : null)}><Upload size={13} /> Import CSV</button></div>{act.msg}</Card>
    </div>
    {connect && <Card title="Connect bank accounts through the Account Aggregator"><div className="grid-3">
      <Field label="Entity"><select style={inp} value={c.entity_id} onChange={(e) => setC({ ...c, entity_id: e.target.value })}><option value="">—</option>{(ents.data ?? []).map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}</select></Field>
      <Field label="Mobile registered with the bank"><input style={inp} value={c.mobile} onChange={(e) => setC({ ...c, mobile: e.target.value })} placeholder="98400 00001" /></Field>
      <Field label="Aggregator"><select style={inp} value={c.provider} onChange={(e) => setC({ ...c, provider: e.target.value })}>{["finvu", "onemoney", "setu", "mock"].map((p) => <option key={p}>{p}</option>)}</select></Field>
    </div><button className="btn" disabled={!c.entity_id || !c.mobile} onClick={() => act.run("aa", async () => { const r = await apiJson<any>("/aa/consent/initiate", { ...c, mobile: c.mobile.replace(/\D/g, "") }); if (r.status_code >= 400) throw new Error(r.title ?? "Could not start the consent"); if (r.provider !== "mock") window.open(r.redirect_url, "_blank", "noopener"); setConnect(false); return r.provider === "mock" ? "Sandbox consent created — approve it below" : "Approve the consent on the aggregator's page; accounts link when it calls back"; })}>Start consent</button>
      <div className="small mute" style={{ marginTop: 8 }}>Read-only access under the RBI Account Aggregator framework; consents run twelve months and renew from a task 30 days before expiry. Balances and transactions refresh every four hours or on demand.</div></Card>}
    {add && <Card title="Add a manual / CSV account"><div className="grid-3">
      <Field label="Entity"><select style={inp} value={n.entity_id} onChange={(e) => setN({ ...n, entity_id: e.target.value })}><option value="">—</option>{(ents.data ?? []).map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}</select></Field>
      <Field label="Bank"><input style={inp} value={n.bank} onChange={(e) => setN({ ...n, bank: e.target.value })} /></Field><Field label="Account number (last digits kept)"><input style={inp} value={n.account_masked} onChange={(e) => setN({ ...n, account_masked: e.target.value })} /></Field>
      <Field label="Type"><select style={inp} value={n.type} onChange={(e) => setN({ ...n, type: e.target.value })}>{["savings", "current", "card", "od"].map((t) => <option key={t}>{t}</option>)}</select></Field><Field label="Balance"><input style={inp} type="number" value={n.balance} onChange={(e) => setN({ ...n, balance: e.target.value })} onWheel={(e) => (e.target as HTMLInputElement).blur()} /></Field>
    </div><button className="btn" disabled={!n.entity_id || !n.bank || !n.account_masked} onClick={() => act.run("add", async () => { const r = await apiJson<any>("/bank-accounts", { ...n, balance: Number(n.balance || 0), sync_mode: "csv" }); if (r.status_code >= 400) throw new Error(r.title ?? "Could not save"); setAdd(false); })}>Save</button></Card>}
    {ed && <Card title={`Edit account — ${ed.entity_name}`}>
      {ed.sync_mode === "aa" && <div className="small" style={{ marginBottom: 8, color: "var(--amber)" }}>This account is linked through the Account Aggregator, so its balance is refreshed from the bank on every sync and will overwrite a hand-typed value.</div>}
      <div className="grid-3">
        <Field label="Bank"><input style={inp} value={ed.bank} onChange={(e) => setEd({ ...ed, bank: e.target.value })} /></Field>
        <Field label="Account number (last digits kept)"><input style={inp} value={ed.account_masked} onChange={(e) => setEd({ ...ed, account_masked: e.target.value })} /></Field>
        <Field label="Type"><select style={inp} value={ed.type} onChange={(e) => setEd({ ...ed, type: e.target.value })}>{["savings", "current", "card", "od"].map((t) => <option key={t}>{t}</option>)}</select></Field>
        <Field label="Balance"><input style={inp} type="number" value={ed.balance} onChange={(e) => setEd({ ...ed, balance: e.target.value })} onWheel={(e) => (e.target as HTMLInputElement).blur()} /></Field>
      </div>
      <div className="small mute" style={{ marginTop: 6 }}>Changing the balance sets it to exactly this figure as of now; the next imported statement replaces it with the bank's own closing balance.</div>
      {act.msg}
      <div className="row gap" style={{ justifyContent: "flex-end", marginTop: 8 }}><button className="btn" onClick={() => setEd(null)}>Cancel</button><button className="btn btn-p" disabled={!ed.bank || !ed.account_masked || ed.balance === "" || !!act.busy} onClick={() => act.run("edit", async () => { await api(`/bank-accounts/${ed.id}`, { method: "PATCH", body: JSON.stringify({ bank: ed.bank, account_masked: ed.account_masked, type: ed.type, balance: Number(ed.balance) }) }); setEd(null); return "Account updated"; })}>Save changes</button></div>
    </Card>}
    {pending.length > 0 && <Card title="Consents awaiting approval">{pending.map((p) => <div key={p.id} className="attn"><div style={{ flex: 1 }}><b>{p.entity_name}</b> · {p.provider} · {p.mobile}<div className="small mute">{p.redirect_url}</div></div>{p.provider === "mock" && isMember() && <button className="btn btn-s" onClick={() => act.run("sim", async () => { await api(`/aa/consents/${p.id}/simulate`, { method: "POST", body: "{}" }); return "Sandbox consent approved and accounts linked"; })}><ShieldCheck size={13} /> Approve (sandbox)</button>}{isMember() && <button className="btn btn-s" onClick={() => act.run("rev", async () => { await api(`/aa/consents/${p.id}`, { method: "DELETE" }); })}><Trash2 size={13} /></button>}</div>)}</Card>}
    <Card title="Accounts"><table className="tbl"><thead><tr><th>Account</th><th>Entity</th><th>Type</th><th style={R}>Balance</th><th>As of</th><th>Sync</th><th></th></tr></thead><tbody>
      {a.data.map((x) => <tr key={x.id}><td><b>{x.bank} {x.account_masked}</b></td><td>{x.entity_name}</td><td>{x.type}</td><td style={{ ...R, color: Number(x.balance) < 0 ? "var(--red)" : undefined }}>{inr(x.balance)}</td><td className="small mute">{x.balance_as_of ? new Date(x.balance_as_of).toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : "—"}</td>
        <td>{x.sync_mode === "aa" ? <Pill tone={x.consent_expires_on && new Date(x.consent_expires_on).getTime() - Date.now() < 30 * 86400000 ? "amber" : "teal"}>AA · consent to {fmtDate(x.consent_expires_on)}</Pill> : <Pill>{x.sync_mode}</Pill>}</td>
        <td className="row" style={{ gap: 4 }}>{x.sync_mode === "aa" && canWrite() && <button className="btn btn-s" disabled={!!act.busy} onClick={() => act.run("sync", async () => { const r = await api<any>(`/bank-accounts/${x.id}/sync`, { method: "POST", body: "{}" }); return `${r.txns_new} new, ${r.txns_dup} already known${r.rent_matched ? `, ${r.rent_matched} rent matched` : ""}`; })}><RefreshCw size={12} /> Sync now</button>}<button className="btn btn-s" title="Import a statement" onClick={() => setImporting(x.id)}><Upload size={12} /></button>{canWrite() && <button className="btn btn-s" onClick={() => { setConnect(false); setAdd(false); setEd({ id: x.id, entity_name: x.entity_name, sync_mode: x.sync_mode, bank: x.bank, account_masked: String(x.account_masked ?? "").replace(/\D/g, ""), type: x.type, balance: String(Number(x.balance)) }); }}>Edit</button>}{isMember() && <button className="btn btn-s" disabled={!!act.busy} onClick={() => { if (confirm(`Delete ${x.bank} ${x.account_masked}?`)) act.run("del", async () => { await api(`/bank-accounts/${x.id}`, { method: "DELETE" }); return `Deleted ${x.bank} ${x.account_masked}`; }); }}>Delete</button>}</td></tr>)}
    </tbody></table></Card>
    {importing !== null && <Card title="Import a bank statement"><ImportPanel key={importing} kind="bank" bankAccountId={importing || undefined} onDone={() => setTick((t) => t + 1)} /></Card>}
    {(consents.data ?? []).filter((x) => x.status !== "pending").length > 0 && <Card title="Account Aggregator consents"><table className="tbl"><thead><tr><th>Entity</th><th>Provider</th><th>Status</th><th>Granted</th><th>Expires</th><th>Last fetch</th><th>Accounts</th><th></th></tr></thead><tbody>
      {(consents.data ?? []).filter((x) => x.status !== "pending").map((x) => <tr key={x.id}><td>{x.entity_name}</td><td>{x.provider}</td><td><Pill tone={x.status === "active" ? "teal" : x.status === "revoked" || x.status === "expired" ? "red" : "amber"}>{x.status}</Pill>{x.fetch_error && <div className="small" style={{ color: "var(--red)" }}>{x.fetch_error}</div>}</td><td>{fmtDate(x.granted_on)}</td><td>{fmtDate(x.expires_on)}</td><td className="small mute">{x.last_fetch ? `${new Date(x.last_fetch.fetched_at).toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })} · ${x.last_fetch.status}` : "never"}</td><td>{(x.linked_accounts ?? []).map((l: any) => `${l.bank} ${l.account_masked}`).join(", ")}</td>
        <td>{x.status === "active" && isMember() && <button className="btn btn-s" onClick={() => act.run("revoke", async () => { if (!confirm("Revoke this consent? Accounts fall back to manual / CSV.")) return; await api(`/aa/consents/${x.id}`, { method: "DELETE" }); })}>Revoke</button>}</td></tr>)}
    </tbody></table></Card>}
  </>);
}

function Transactions() {
  const [tick, setTick] = useState(0); const [f, setF] = useState({ q: "", account_id: "", category_id: "", kind: "", uncategorised: false, transfers: false }); const [edit, setEdit] = useState<{ id: string; category_id: string; learn: boolean } | null>(null);
  const qs = `/bank-txns?limit=100${f.q ? `&q=${encodeURIComponent(f.q)}` : ""}${f.account_id ? `&account_id=${f.account_id}` : ""}${f.category_id ? `&category_id=${f.category_id}` : ""}${f.kind ? `&kind=${f.kind}` : ""}${f.uncategorised ? "&uncategorised=1" : ""}${f.transfers ? "&include_transfers=1" : ""}`;
  const t = useApi<any>(qs, [tick]); const accts = useApi<any[]>("/bank-accounts"); const cats = useApi<any[]>("/categories"); const act = useAction(() => setTick((n) => n + 1));
  return (<>
    <Card><div className="row" style={{ gap: 8, flexWrap: "wrap", alignItems: "flex-end" }}>
      <Field label="Search"><input style={inp} value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} placeholder="narration or counterparty" /></Field>
      <Field label="Account"><select style={inp} value={f.account_id} onChange={(e) => setF({ ...f, account_id: e.target.value })}><option value="">all</option>{(accts.data ?? []).map((a) => <option key={a.id} value={a.id}>{a.bank} {a.account_masked}</option>)}</select></Field>
      <Field label="Category"><select style={inp} value={f.category_id} onChange={(e) => setF({ ...f, category_id: e.target.value })}><option value="">all</option>{(cats.data ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
      <Field label="Kind"><select style={inp} value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}><option value="">both</option><option value="credit">credits</option><option value="debit">debits</option></select></Field>
      <label className="small" style={{ display: "flex", gap: 4, alignItems: "center" }}><input type="checkbox" checked={f.uncategorised} onChange={(e) => setF({ ...f, uncategorised: e.target.checked })} /> uncategorised only</label>
      <label className="small" style={{ display: "flex", gap: 4, alignItems: "center" }}><input type="checkbox" checked={f.transfers} onChange={(e) => setF({ ...f, transfers: e.target.checked })} /> show internal transfers</label>
      {canWrite() && <button className="btn btn-s" onClick={() => act.run("tr", async () => { const r = await api<any>("/bank-txns/detect-transfers", { method: "POST", body: "{}" }); return r.note; })}>Detect transfers</button>}
    </div>{act.msg}</Card>
    <Card title={`Transactions${t.data ? ` · ${t.data.total}` : ""}`}>{t.loading && !t.data ? "Loading…" : <table className="tbl"><thead><tr><th>Date</th><th>Narration</th><th>Account</th><th>Category</th><th>Link</th><th style={R}>Amount</th></tr></thead><tbody>
      {(t.data?.items ?? []).map((x: any) => <tr key={x.id} style={{ opacity: x.is_transfer ? 0.6 : 1 }}><td>{fmtDate(x.txn_date)}</td><td>{x.narration}{x.note && <div className="small mute">{x.note}</div>}</td><td className="small">{x.account_label}</td>
        <td>{edit && edit.id === x.id ? <span className="row" style={{ gap: 4 }}><select style={inp} value={edit.category_id} onChange={(e) => setEdit({ id: x.id, learn: !!edit?.learn, category_id: e.target.value })}>{(cats.data ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select><label className="small" style={{ display: "flex", gap: 3, alignItems: "center" }}><input type="checkbox" checked={edit.learn} onChange={(e) => setEdit({ id: x.id, category_id: edit?.category_id ?? "", learn: e.target.checked })} /> learn rule</label><button className="btn btn-s" onClick={() => act.run("cat", async () => { const ed = edit!; const r = await api<any>(`/bank-txns/${x.id}`, { method: "PATCH", body: JSON.stringify({ category_id: ed.category_id, learn_rule: ed.learn }) }); setEdit(null); return r.learned_rule ? `Rule learned: ${r.learned_rule.pattern.replace(/\\s\+/g, " ")}` : undefined; })}>Save</button><button className="btn btn-s" onClick={() => setEdit(null)}>×</button></span>
          : <span style={{ cursor: canWrite() ? "pointer" : undefined }} onClick={() => canWrite() && setEdit({ id: x.id, category_id: x.category_id ?? "", learn: true })}>{x.category ?? <span className="mute">—</span>}{x.is_transfer && <> <Pill>transfer</Pill></>}</span>}</td>
        <td className="small mute">{x.link_type !== "none" ? label(x.link_type) : ""}</td><td style={{ ...R, color: Number(x.amount) < 0 ? "var(--red)" : "var(--teal)" }}>{inr(x.amount)}</td></tr>)}
      {t.data && !t.data.items.length && <tr><td colSpan={6} className="small mute">No transactions match.</td></tr>}
    </tbody></table>}</Card>
  </>);
}

function Rules() {
  const [tick, setTick] = useState(0); const rules = useApi<any[]>("/categorisation-rules", [tick]); const cats = useApi<any[]>("/categories"); const act = useAction(() => setTick((n) => n + 1));
  const [f, setF] = useState({ pattern: "", name: "", category_id: "", link_type: "none", priority: 50 }); const [test, setTest] = useState(""); const [hit, setHit] = useState<any>(null);
  if (!rules.data) return <Status loading={rules.loading} error={rules.error} />;
  return (<div className="grid-2" style={{ gridTemplateColumns: "1.4fr 1fr" }}>
    <Card title="Categorisation rules" action={canWrite() && <button className="btn btn-s" onClick={() => act.run("apply", async () => (await api<any>("/categorisation-rules/apply", { method: "POST", body: JSON.stringify({ all: false }) })).note)}><Play size={12} /> Re-run on uncategorised</button>}>
      {act.msg}
      <table className="tbl"><thead><tr><th>Rule</th><th>Pattern</th><th>Category</th><th>Link</th><th style={R}>Priority</th><th style={R}>Hits</th><th></th></tr></thead><tbody>
        {rules.data.map((r) => <tr key={r.id} style={{ opacity: r.active ? 1 : 0.5 }}><td>{r.name ?? r.pattern}{r.learned && <> <Pill tone="blue">learned</Pill></>}</td><td><code className="small">{r.pattern}</code> <span className="small mute">{r.field}</span></td><td>{r.category ?? "—"}</td><td className="small mute">{r.link_type !== "none" ? label(r.link_type) : ""}</td><td style={R}>{r.priority}</td><td style={R}>{r.hits}</td>
          <td className="row" style={{ gap: 4 }}>{canWrite() && <button className="btn btn-s" onClick={() => act.run("tog", async () => { await api(`/categorisation-rules/${r.id}`, { method: "PATCH", body: JSON.stringify({ active: !r.active }) }); })}>{r.active ? "Pause" : "Resume"}</button>}{canWrite() && <button className="btn btn-s" onClick={() => act.run("del", async () => { await api(`/categorisation-rules/${r.id}`, { method: "DELETE" }); })}><Trash2 size={12} /></button>}</td></tr>)}
      </tbody></table>
    </Card>
    <div>
      {canWrite() && <Card title="New rule"><Field label="Name"><input style={inp} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field><Field label="Pattern (regular expression on the narration)"><input style={inp} value={f.pattern} onChange={(e) => setF({ ...f, pattern: e.target.value })} placeholder="SWIGGY|ZOMATO" /></Field>
        <div className="grid-2"><Field label="Category"><select style={inp} value={f.category_id} onChange={(e) => setF({ ...f, category_id: e.target.value })}><option value="">—</option>{(cats.data ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field><Field label="Priority (lower wins)"><input style={inp} type="number" value={f.priority} onChange={(e) => setF({ ...f, priority: Number(e.target.value) })} /></Field></div>
        <button className="btn" disabled={!f.pattern} onClick={() => act.run("new", async () => { const r = await apiJson<any>("/categorisation-rules", { ...f, category_id: f.category_id || null, apply: true }); if (r.status_code >= 400) throw new Error(r.title ?? "Could not save"); setF({ pattern: "", name: "", category_id: "", link_type: "none", priority: 50 }); return r.applied ? r.applied.note : undefined; })}>Save and apply</button></Card>}
      <Card title="Try a narration"><Field label="Narration"><input style={inp} value={test} onChange={(e) => setTest(e.target.value)} placeholder="UPI/APOLLO PHARMACY/PAY" /></Field><button className="btn btn-s" disabled={!test} onClick={() => act.run("test", async () => { setHit(await api<any>("/categorisation-rules/test", { method: "POST", body: JSON.stringify({ narration: test }) })); })}>Test</button>
        {hit && <div className="small" style={{ marginTop: 6 }}>{hit.matched ? <>Matches <code>{hit.matched.pattern}</code> → {(cats.data ?? []).find((c) => c.id === hit.matched.category_id)?.name ?? "—"}</> : "No rule matches; the keyword defaults apply."}</div>}</Card>
    </div>
  </div>);
}

function Bar({ pct, tone = "var(--teal)" }: { pct: number; tone?: string }) { return <div style={{ background: "var(--line)", height: 6, borderRadius: 3, minWidth: 80 }}><div style={{ width: `${Math.min(100, pct)}%`, height: 6, borderRadius: 3, background: tone }} /></div>; }
function Cashflow() {
  const [days, setDays] = useState(30); const [entity, setEntity] = useState(""); const ents = useApi<any[]>("/entities");
  const { data, error, loading } = useApi<any>(`/cashflow?days=${days}${entity ? `&entity_id=${entity}` : ""}`);
  if (loading || error) return <Status loading={loading} error={error} />;
  const f = data!; const max = Math.max(1, ...f.by_category.map((c: any) => Number(c.amount)));
  return (<>
    <div className="row" style={{ marginBottom: 12, gap: 8 }}>{[30, 90, 365].map((d) => <button key={d} className={`btn btn-s ${days === d ? "on" : ""}`} onClick={() => setDays(d)}>{d} days</button>)}<select className="entity" style={inp} value={entity} onChange={(e) => setEntity(e.target.value)}><option value="">All entities</option>{(ents.data ?? []).map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}</select><span className="small mute">Internal transfers between own accounts are excluded ({inr(f.transfers_excluded)} in this window).</span></div>
    <div className="kpis">
      <Card><div className="mute">Inflows</div><div className="big-num" style={{ color: "var(--teal)" }}>{inr(f.inflows)}</div></Card>
      <Card><div className="mute">Outflows</div><div className="big-num" style={{ color: "var(--red)" }}>{inr(f.outflows)}</div></Card>
      <Card><div className="mute">Net</div><div className="big-num">{inr(f.net)}</div><div className="small mute">{f.savings_rate_pct != null ? `${f.savings_rate_pct}% of inflows kept` : ""}</div></Card>
      <Card><div className="mute">Transactions</div><div className="big-num">{f.txns}</div><div className="small mute">{f.from} → {f.to}</div></Card>
    </div>
    <div className="grid-2">
      <Card title="By category"><table className="tbl"><tbody>{f.by_category.map((c: any) => <tr key={c.category + c.kind}><td style={{ width: "40%" }}>{c.category} <span className="small mute">{c.kind}</span></td><td><Bar pct={(Number(c.amount) / max) * 100} tone={c.kind === "inflow" ? "var(--teal)" : "var(--red)"} /></td><td style={R}>{inr(c.amount)}</td></tr>)}</tbody></table></Card>
      <div>
        <Card title="By entity"><table className="tbl"><thead><tr><th>Entity</th><th style={R}>In</th><th style={R}>Out</th><th style={R}>Net</th></tr></thead><tbody>{f.by_entity.map((e: any) => <tr key={e.entity}><td>{e.entity}</td><td style={R}>{inr(e.inflows)}</td><td style={R}>{inr(e.outflows)}</td><td style={R}>{inr(e.net)}</td></tr>)}</tbody></table></Card>
        {f.by_month.length > 1 && <Card title="By month"><table className="tbl"><thead><tr><th>Month</th><th style={R}>In</th><th style={R}>Out</th><th style={R}>Net</th></tr></thead><tbody>{f.by_month.map((m: any) => <tr key={m.month}><td>{m.month}</td><td style={R}>{inr(m.inflows)}</td><td style={R}>{inr(m.outflows)}</td><td style={R}>{inr(m.net)}</td></tr>)}</tbody></table></Card>}
        <Card title="Largest counterparties"><table className="tbl"><tbody>{f.top_counterparties.map((c: any) => <tr key={c.counterparty}><td>{c.counterparty}</td><td className="small mute">{c.n} txns</td><td style={R}>{inr(c.amount)}</td></tr>)}</tbody></table></Card>
      </div>
    </div>
  </>);
}

function InboxPanel() {
  const [tick, setTick] = useState(0); const mails = useApi<any[]>("/ingest/email", [tick]); const settings = useApi<any>("/ingest/settings", [tick]); const act = useAction(() => setTick((n) => n + 1)); const [senders, setSenders] = useState<string | null>(null);
  if (!mails.data) return <Status loading={mails.loading} error={mails.error} />;
  const tone = (s: string) => (s === "imported" ? "teal" : s === "quarantined" || s === "partial" ? "amber" : s === "failed" || s === "rejected" ? "red" : undefined) as any;
  return (<div className="grid-2" style={{ gridTemplateColumns: "1.5fr 1fr" }}>
    <Card title="E-mailed statements" action={<Inbox size={14} />}>
      {act.msg}
      <table className="tbl"><thead><tr><th>Received</th><th>From</th><th>Subject</th><th>Attachments</th><th>Status</th><th></th></tr></thead><tbody>
        {mails.data.map((m) => <tr key={m.id}><td>{fmtDate(m.received_at)}</td><td>{m.sender}</td><td>{m.subject ?? <span className="mute">—</span>}</td><td className="small">{m.attachments.map((a: any) => <div key={a.name}>{a.name} <span className="mute">{a.status}{a.note ? ` · ${a.note}` : ""}</span></div>)}</td><td><Pill tone={tone(m.status)}>{m.status}</Pill>{m.reason && <div className="small mute">{m.reason}</div>}</td>
          <td className="row" style={{ gap: 4 }}>{m.status === "quarantined" && isMember() && <><button className="btn btn-s" onClick={() => act.run("rel", async () => { await api(`/ingest/email/${m.id}/release`, { method: "POST", body: JSON.stringify({ allow_sender: true }) }); return "Released and sender trusted"; })}><ShieldCheck size={12} /> Release & trust</button><button className="btn btn-s" onClick={() => act.run("rej", async () => { await api(`/ingest/email/${m.id}/reject`, { method: "POST", body: "{}" }); })}><ShieldAlert size={12} /> Reject</button></>}</td></tr>)}
        {!mails.data.length && <tr><td colSpan={6} className="small mute">Nothing received yet. Forward statements to the ingest address.</td></tr>}
      </tbody></table>
    </Card>
    <Card title="Ingest settings">{settings.data && <>
      <div className="small mute">Ingest address</div><div><code>{settings.data.ingest_address}</code></div>
      <div className="small mute" style={{ marginTop: 10 }}>Allowed senders (one per line; <code>@domain.com</code> allows a whole domain)</div>
      <textarea style={{ ...inp, width: "100%", minHeight: 120 }} value={senders ?? settings.data.allow_senders.join("\n")} onChange={(e) => setSenders(e.target.value)} readOnly={!isMember()} />
      {isMember() && <button className="btn btn-s" style={{ marginTop: 6 }} onClick={() => act.run("save", async () => { await api("/ingest/settings", { method: "PATCH", body: JSON.stringify({ allow_senders: (senders ?? settings.data.allow_senders.join("\n")).split(/\n/).map((s: string) => s.trim()).filter(Boolean) }) }); setSenders(null); return "Allow-list saved"; })}>Save</button>}
      <div className="small mute" style={{ marginTop: 10 }}>{settings.data.note}</div></>}</Card>
  </div>);
}
