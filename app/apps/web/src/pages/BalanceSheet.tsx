import { useState } from "react";
import { Plus, Trash2, RefreshCw, CheckCircle2, ShieldAlert, Users } from "lucide-react";
import { useApi } from "../lib/useApi";
import { api, apiJson, inr, session } from "../lib/api";
import { Card, Pill, Status, fmtDate } from "../components";

// Balance sheet (PRD 3.11): net worth with look-through, liabilities and schedules, insurance adequacy, lifestyle assets, ownership graph, succession gaps.
const inp = { background: "#fff", color: "var(--ink)", borderColor: "var(--line)" } as const;
const role = () => session.get()?.families.find((f) => f.id === session.family())?.role ?? "viewer";
const canWrite = () => ["owner", "member", "operator"].includes(role());
const pct = (v: any) => (v == null ? "—" : `${Number(v).toFixed(1)}%`);
const label = (s?: string | null) => (s ?? "").replace(/_/g, " ");
function Field({ label, children }: { label: string; children: React.ReactNode }) { return <label className="field">{label}{children}</label>; }
function useAction(after?: () => void) {
  const [busy, setBusy] = useState(""); const [err, setErr] = useState(""); const [note, setNote] = useState("");
  const run = async (l: string, fn: () => Promise<string | void>) => { setBusy(l); setErr(""); setNote(""); try { const n = await fn(); if (n) setNote(n); after?.(); } catch (e: any) { setErr(e.message); } finally { setBusy(""); } };
  return { busy, err, note, run, msg: <>{err && <div className="err">{err}</div>}{note && <div className="small" style={{ color: "var(--teal)" }}>{note}</div>}</> };
}
const TABS = ["Net worth", "Liabilities", "Insurance", "Lifestyle assets", "Ownership", "Succession"] as const;

export function BalanceSheet() {
  const [tab, setTab] = useState<(typeof TABS)[number]>("Net worth");
  return (<>
    <div className="tabs">{TABS.map((t) => <button key={t} className={tab === t ? "on" : ""} onClick={() => setTab(t)}>{t}</button>)}</div>
    {tab === "Net worth" && <NetWorth />}
    {tab === "Liabilities" && <Liabilities />}
    {tab === "Insurance" && <Insurance />}
    {tab === "Lifestyle assets" && <Lifestyle />}
    {tab === "Ownership" && <Ownership />}
    {tab === "Succession" && <Succession />}
  </>);
}

function NetWorth() {
  const { data, error, loading } = useApi<any>("/net-worth");
  if (loading || error) return <Status loading={loading} error={error} />;
  const d = data!; const classes = d.by_class.map((c: any) => c.klass);
  return (<>
    <div className="kpis">
      <Card><div className="mute">Net worth</div><div className="big-num">{inr(d.net_worth)}</div><div className="small mute">as of {fmtDate(d.as_of)}</div></Card>
      <Card><div className="mute">Assets</div><div className="big-num">{inr(d.assets)}</div><div className="small mute">{d.asset_count} lines</div></Card>
      <Card><div className="mute">Liabilities</div><div className="big-num" style={{ color: "var(--red)" }}>{inr(d.liabilities)}</div><div className="small mute">{d.liabilities_detail.length} loans & balances</div></Card>
      <Card><div className="mute">Largest class</div><div className="big-num">{pct(d.by_class[0]?.pct)}</div><div className="small mute">{label(d.by_class[0]?.klass)}</div></Card>
    </div>
    <div className="grid-2">
      <Card title="Assets by class"><table className="tbl"><thead><tr><th>Class</th><th style={{ textAlign: "right" }}>Value</th><th style={{ textAlign: "right" }}>Share</th></tr></thead><tbody>
        {d.by_class.map((c: any) => <tr key={c.klass}><td>{label(c.klass)}</td><td style={{ textAlign: "right" }}>{inr(c.value)}</td><td style={{ textAlign: "right" }}>{pct(c.pct)}</td></tr>)}
      </tbody></table></Card>
      <Card title="Per entity — headline and look-through"><table className="tbl"><thead><tr><th>Entity</th><th style={{ textAlign: "right" }}>Assets</th><th style={{ textAlign: "right" }}>Liabilities</th><th style={{ textAlign: "right" }}>Net worth</th><th style={{ textAlign: "right" }}>Look-through</th></tr></thead><tbody>
        {d.by_entity.map((e: any) => <tr key={e.entity_id}><td>{e.name} <span className="small mute">{e.type}</span></td><td style={{ textAlign: "right" }}>{inr(e.assets)}</td><td style={{ textAlign: "right" }}>{inr(e.liabilities)}</td><td style={{ textAlign: "right" }}><b>{inr(e.net_worth)}</b></td><td style={{ textAlign: "right" }}>{inr(e.lookthrough_net_worth)}</td></tr>)}
      </tbody></table><div className="small mute" style={{ marginTop: 6 }}>{d.note}</div></Card>
    </div>
    <Card title="Class × entity"><div style={{ overflowX: "auto" }}><table className="tbl"><thead><tr><th>Entity</th>{classes.map((k: string) => <th key={k} style={{ textAlign: "right" }}>{label(k)}</th>)}</tr></thead><tbody>
      {d.by_entity.map((e: any) => <tr key={e.entity_id}><td>{e.name}</td>{classes.map((k: string) => <td key={k} style={{ textAlign: "right" }}>{e.by_class[k] ? inr(e.by_class[k]) : "—"}</td>)}</tr>)}
    </tbody></table></div></Card>
  </>);
}

function Liabilities() {
  const [tick, setTick] = useState(0); const [sel, setSel] = useState<string | null>(null); const [add, setAdd] = useState(false);
  const { data, error, loading } = useApi<any[]>("/liabilities", [tick]); const ents = useApi<any[]>("/entities"); const banks = useApi<any[]>("/bank-accounts");
  const detail = useApi<any>(sel ? `/liabilities/${sel}` : null, [tick]); const act = useAction(() => setTick((t) => t + 1));
  const [f, setF] = useState<any>({ kind: "home_loan", lender: "", principal_original: "", rate_pct: "", emi: "", emi_day: 5, start_date: "", tax_section: "none", bank_account_id: "", entity_id: "" });
  if (loading || error) return <Status loading={loading} error={error} />;
  const rows = data!; const total = rows.reduce((s, l) => s + Number(l.outstanding), 0);
  return (<>
    <div className="kpis">
      <Card><div className="mute">Outstanding</div><div className="big-num" style={{ color: "var(--red)" }}>{inr(total)}</div><div className="small mute">{rows.length} liabilities</div></Card>
      <Card><div className="mute">Monthly EMIs</div><div className="big-num">{inr(rows.reduce((s, l) => s + Number(l.emi ?? 0), 0))}</div></Card>
      <Card><div className="mute">LTV breaches</div><div className="big-num" style={{ color: rows.some((l) => l.ltv_breach) ? "var(--red)" : "var(--teal)" }}>{rows.filter((l) => l.ltv_breach).length}</div></Card>
      <Card><div className="mute">Actions</div><div className="row" style={{ gap: 6, flexWrap: "wrap" }}>{canWrite() && <button className="btn btn-s" disabled={!!act.busy} onClick={() => act.run("match", async () => { const r = await api<any>("/liabilities/match-emis", { method: "POST", body: "{}" }); return `${r.matched} EMI(s) matched, ${r.outflows_added} outflows added`; })}><RefreshCw size={13} /> Match EMIs</button>}{canWrite() && <button className="btn btn-s" onClick={() => setAdd(!add)}><Plus size={13} /> Loan</button>}</div>{act.msg}</Card>
    </div>
    {add && <Card title="New liability"><div className="grid-3">
      <Field label="Entity"><select style={inp} value={f.entity_id} onChange={(e) => setF({ ...f, entity_id: e.target.value })}><option value="">—</option>{(ents.data ?? []).map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}</select></Field>
      <Field label="Kind"><select style={inp} value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>{["home_loan", "loan_against_securities", "loan_against_property", "personal_loan", "vehicle_loan", "education_loan", "credit_line", "other"].map((k) => <option key={k} value={k}>{label(k)}</option>)}</select></Field>
      <Field label="Lender"><input style={inp} value={f.lender} onChange={(e) => setF({ ...f, lender: e.target.value })} /></Field>
      <Field label="Principal"><input style={inp} type="number" value={f.principal_original} onChange={(e) => setF({ ...f, principal_original: e.target.value })} /></Field>
      <Field label="Rate % p.a."><input style={inp} type="number" step="0.01" value={f.rate_pct} onChange={(e) => setF({ ...f, rate_pct: e.target.value })} /></Field>
      <Field label="EMI (blank for interest-only)"><input style={inp} type="number" step="0.01" value={f.emi} onChange={(e) => setF({ ...f, emi: e.target.value })} /></Field>
      <Field label="EMI day"><input style={inp} type="number" min={1} max={31} value={f.emi_day} onChange={(e) => setF({ ...f, emi_day: Number(e.target.value) })} /></Field>
      <Field label="Start date"><input style={inp} type="date" value={f.start_date} onChange={(e) => setF({ ...f, start_date: e.target.value })} /></Field>
      <Field label="Tax section"><select style={inp} value={f.tax_section} onChange={(e) => setF({ ...f, tax_section: e.target.value })}>{["none", "24b", "80C", "80E"].map((k) => <option key={k}>{k}</option>)}</select></Field>
      <Field label="Debited from"><select style={inp} value={f.bank_account_id} onChange={(e) => setF({ ...f, bank_account_id: e.target.value })}><option value="">—</option>{(banks.data ?? []).map((b) => <option key={b.id} value={b.id}>{b.bank} {b.account_masked}</option>)}</select></Field>
    </div><button className="btn" disabled={!f.entity_id || !f.lender || !f.principal_original} onClick={() => act.run("create", async () => { const r = await apiJson<any>("/liabilities", { ...f, principal_original: Number(f.principal_original), rate_pct: f.rate_pct === "" ? null : Number(f.rate_pct), emi: f.emi === "" ? null : Number(f.emi), interest_only: f.emi === "", start_date: f.start_date || null, bank_account_id: f.bank_account_id || null }); if (r.status_code >= 400) throw new Error(r.title ?? "Could not save"); setAdd(false); return "Liability added and schedule generated"; })}>Save</button></Card>}
    <div className="grid-2" style={{ gridTemplateColumns: "1.3fr 1fr" }}>
      <Card title="Register"><table className="tbl"><thead><tr><th>Lender</th><th>Entity</th><th style={{ textAlign: "right" }}>Outstanding</th><th style={{ textAlign: "right" }}>Rate</th><th style={{ textAlign: "right" }}>EMI</th><th>Next due</th><th>Security / LTV</th></tr></thead><tbody>
        {rows.map((l) => <tr key={l.id} onClick={() => setSel(l.id)} style={{ cursor: "pointer", background: sel === l.id ? "var(--soft, #f4f6fa)" : undefined }}>
          <td>{l.lender}<div className="small mute">{label(l.kind)}{l.tax_section && l.tax_section !== "none" ? ` · ${l.tax_section}` : ""}</div></td><td>{l.entity_name ?? ""}</td><td style={{ textAlign: "right" }}>{inr(l.outstanding)}</td><td style={{ textAlign: "right" }}>{l.rate_pct != null ? `${l.rate_pct}%` : "—"}</td><td style={{ textAlign: "right" }}>{l.emi ? inr(l.emi) : <span className="mute">interest-only</span>}</td><td>{l.next_due ? `${fmtDate(l.next_due.d)} · ${inr(l.next_due.a)}` : "—"}</td>
          <td>{l.security_name ?? (l.secured_by_type ? label(l.secured_by_type) : "unsecured")}{l.ltv_pct != null && <> <Pill tone={l.ltv_breach ? "red" : "teal"}>LTV {pct(l.ltv_pct)}{l.ltv_alert_pct != null ? ` / ${pct(l.ltv_alert_pct)}` : ""}</Pill></>}</td></tr>)}
      </tbody></table></Card>
      <Card title={detail.data ? `${detail.data.lender} — schedule` : "Schedule"}>{!sel && <div className="small mute">Pick a liability to see its amortisation schedule and mark instalments paid.</div>}
        {detail.data && <>
          <div className="small mute" style={{ marginBottom: 6 }}>Principal {inr(detail.data.principal_original)} · outstanding {inr(detail.data.outstanding)} as of {fmtDate(detail.data.outstanding_as_of)} · {detail.data.schedule_rows} instalments{canWrite() && <> · <button className="btn btn-s" onClick={() => act.run("regen", async () => { await api(`/liabilities/${sel}/schedule/regenerate`, { method: "POST", body: "{}" }); return "Schedule rebuilt from the terms"; })}>Regenerate</button> <button className="btn btn-s" onClick={() => act.run("del", async () => { if (!confirm("Remove this liability?")) return; await api(`/liabilities/${sel}`, { method: "DELETE" }); setSel(null); })}><Trash2 size={12} /></button></>}</div>
          <div style={{ maxHeight: 420, overflowY: "auto" }}><table className="tbl"><thead><tr><th>Due</th><th style={{ textAlign: "right" }}>Principal</th><th style={{ textAlign: "right" }}>Interest</th><th style={{ textAlign: "right" }}>EMI</th><th>Paid</th></tr></thead><tbody>
            {detail.data.schedule.map((r: any) => <tr key={r.id}><td>{fmtDate(r.due_date)}</td><td style={{ textAlign: "right" }}>{inr(r.principal)}</td><td style={{ textAlign: "right" }}>{inr(r.interest)}</td><td style={{ textAlign: "right" }}>{inr(r.emi)}</td><td>{r.paid_on ? <Pill tone="teal">{fmtDate(r.paid_on)}{r.bank_txn_id ? " · bank" : ""}</Pill> : canWrite() ? <button className="btn btn-s" onClick={() => act.run("pay", async () => { await api(`/liabilities/${sel}/schedule/${r.id}/pay`, { method: "POST", body: "{}" }); })}><CheckCircle2 size={12} /> Paid</button> : <span className="mute">due</span>}</td></tr>)}
          </tbody></table></div></>}
      </Card>
    </div>
  </>);
}

function Insurance() {
  const [tick, setTick] = useState(0); const { data, error, loading } = useApi<any[]>("/insurance-policies", [tick]); const ad = useApi<any>("/insurance/adequacy", [tick]); const act = useAction(() => setTick((t) => t + 1));
  if (loading || error) return <Status loading={loading} error={error} />;
  const rows = data!; const a = ad.data;
  return (<>
    {a && <div className="kpis">
      <Card><div className="mute">Active policies</div><div className="big-num">{rows.filter((p) => p.status === "active").length}</div><div className="small mute">{inr(a.annual_premiums)} premiums / yr</div></Card>
      {a.life.map((l: any) => <Card key={l.entity_id}><div className="mute">{l.name} — life cover</div><div className="big-num" style={{ color: l.gap > 0 ? "var(--amber)" : "var(--teal)" }}>{inr(l.life_cover)}</div><div className="small mute">need {inr(l.need)} · gap {inr(l.gap)} · {l.adequacy_pct != null ? `${l.adequacy_pct}%` : "—"}</div></Card>)}
      <Card><div className="mute">Uninsured assets</div><div className="big-num" style={{ color: a.uninsured.length ? "var(--red)" : "var(--teal)" }}>{a.uninsured.length}</div><div className="small mute">{a.uninsured.map((u: any) => u.name).join(", ") || "everything insurable is covered"}</div></Card>
    </div>}
    {act.msg}
    <Card title="Policies"><table className="tbl"><thead><tr><th>Insurer</th><th>Kind</th><th>Entity</th><th style={{ textAlign: "right" }}>Sum assured</th><th style={{ textAlign: "right" }}>Premium</th><th>Next due</th><th>Nominee</th><th></th></tr></thead><tbody>
      {rows.map((p) => <tr key={p.id}><td>{p.insurer}<div className="small mute">{p.policy_no_masked ?? ""}</div></td><td>{label(p.kind)}{p.fund_value && <div className="small mute">fund {inr(p.fund_value)}</div>}</td><td>{p.entity_name}</td><td style={{ textAlign: "right" }}>{inr(p.sum_assured)}</td><td style={{ textAlign: "right" }}>{inr(p.premium)} <span className="small mute">{label(p.premium_frequency)}</span></td><td>{p.next_premium_due ? <Pill tone={p.next_premium_due <= new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10) ? "amber" : undefined}>{fmtDate(p.next_premium_due)}</Pill> : "—"}</td><td>{p.nominee ?? <span className="mute">—</span>}</td>
        <td>{canWrite() && p.next_premium_due && <button className="btn btn-s" onClick={() => act.run("paid", async () => { await api(`/insurance-policies/${p.id}/premium-paid`, { method: "POST", body: "{}" }); return "Premium recorded; next due rolled forward"; })}>Premium paid</button>}</td></tr>)}
    </tbody></table></Card>
    {a && <div className="grid-2">
      <Card title="Health cover per member"><table className="tbl"><thead><tr><th>Member</th><th style={{ textAlign: "right" }}>Cover</th><th>Policies</th></tr></thead><tbody>{a.health.map((h: any) => <tr key={h.member}><td>{h.member}</td><td style={{ textAlign: "right" }}>{inr(h.health_cover)}</td><td className="small mute">{h.policies.join(", ") || "none"}</td></tr>)}</tbody></table></Card>
      <Card title="Premium calendar — next 12 months"><table className="tbl"><thead><tr><th>Due</th><th>Policy</th><th style={{ textAlign: "right" }}>Amount</th></tr></thead><tbody>{a.premium_calendar.map((c: any, i: number) => <tr key={i}><td>{fmtDate(c.due)}</td><td>{c.insurer} {label(c.kind)}</td><td style={{ textAlign: "right" }}>{inr(c.amount)}</td></tr>)}</tbody></table></Card>
    </div>}
  </>);
}

function Lifestyle() {
  const [tick, setTick] = useState(0); const { data, error, loading } = useApi<any[]>("/lifestyle-assets", [tick]); const act = useAction(() => setTick((t) => t + 1)); const [val, setVal] = useState<{ id: string; value: string; on: string } | null>(null);
  if (loading || error) return <Status loading={loading} error={error} />;
  return (<Card title="Lifestyle assets" action={<span className="small mute">counted in net worth only when included · insured via a linked policy</span>}>
    {act.msg}
    <table className="tbl"><thead><tr><th>Asset</th><th>Kind</th><th>Entity</th><th style={{ textAlign: "right" }}>Cost</th><th style={{ textAlign: "right" }}>Value</th><th>Valued</th><th>Insured</th><th>In net worth</th><th></th></tr></thead><tbody>
      {data!.map((a) => <tr key={a.id}><td>{a.name}<div className="small mute">{a.location ?? ""}</div></td><td>{a.kind}</td><td>{a.entity_name}</td><td style={{ textAlign: "right" }}>{a.cost ? inr(a.cost) : "—"}</td><td style={{ textAlign: "right" }}>{a.current_value ? inr(a.current_value) : "—"}</td><td>{fmtDate(a.valued_on)}<div className="small mute">{a.valuation_source ?? ""}</div></td><td>{a.insurer ? <Pill tone="teal">{a.insurer}</Pill> : <Pill tone="amber">uninsured</Pill>}</td>
        <td>{canWrite() ? <input type="checkbox" checked={!!a.include_in_net_worth} onChange={(e) => act.run("inc", async () => { await api(`/lifestyle-assets/${a.id}`, { method: "PATCH", body: JSON.stringify({ include_in_net_worth: e.target.checked }) }); })} /> : a.include_in_net_worth ? "yes" : "no"}</td>
        <td>{canWrite() && (val && val.id === a.id ? <span className="row" style={{ gap: 4 }}><input style={{ ...inp, width: 110 }} type="number" value={val.value} onChange={(e) => setVal({ id: a.id, on: val.on, value: e.target.value })} /><input style={{ ...inp, width: 140 }} type="date" value={val.on} onChange={(e) => setVal({ id: a.id, value: val.value, on: e.target.value })} /><button className="btn btn-s" onClick={() => act.run("val", async () => { const v = val; await api(`/lifestyle-assets/${a.id}/valuations`, { method: "POST", body: JSON.stringify({ valued_on: v.on, value: Number(v.value), source: "manual" }) }); setVal(null); })}>Save</button></span> : <button className="btn btn-s" onClick={() => setVal({ id: a.id, value: a.current_value ?? "", on: new Date().toISOString().slice(0, 10) })}>Revalue</button>)}</td></tr>)}
    </tbody></table>
  </Card>);
}

function Ownership() {
  const { data, error, loading } = useApi<any>("/ownership");
  if (loading || error) return <Status loading={loading} error={error} />;
  const g = data!; const name = (id: string) => g.nodes.find((n: any) => n.id === id)?.name ?? id.slice(0, 8);
  return (<div className="grid-2">
    <Card title="Ownership links" action={<Pill>{g.edges.length} live</Pill>}><table className="tbl"><thead><tr><th>Owner</th><th>Owns</th><th style={{ textAlign: "right" }}>%</th><th>Role</th><th>Since</th></tr></thead><tbody>
      {g.edges.map((e: any) => <tr key={e.id}><td>{name(e.owner_entity_id)}</td><td>{name(e.owned_id)} <span className="small mute">{label(e.owned_type)}</span></td><td style={{ textAlign: "right" }}>{Number(e.pct).toFixed(1)}</td><td>{e.role ?? ""}</td><td>{fmtDate(e.effective_from)}</td></tr>)}
    </tbody></table><div className="small mute" style={{ marginTop: 6 }}>Links are effective-dated; the graph as of {fmtDate(g.as_of)}. Edit via PUT /ownership (owners and members).</div></Card>
    <Card title="Look-through net worth" action={<Users size={14} />}><table className="tbl"><thead><tr><th>Individual / entity</th><th style={{ textAlign: "right" }}>Headline</th><th style={{ textAlign: "right" }}>Look-through</th></tr></thead><tbody>
      {g.lookthrough_net_worth.map((r: any) => <tr key={r.entity_id}><td>{r.name} <span className="small mute">{r.type}</span></td><td style={{ textAlign: "right" }}>{inr(r.headline)}</td><td style={{ textAlign: "right" }}><b>{inr(r.value)}</b></td></tr>)}
    </tbody></table><div className="small mute" style={{ marginTop: 6 }}>HUF and LLP stakes flow through to the individuals who ultimately own them.</div></Card>
  </div>);
}

function Succession() {
  const [tick, setTick] = useState(0); const { data, error, loading } = useApi<any>("/succession/summary", [tick]); const noms = useApi<any[]>("/nominations", [tick]); const act = useAction(() => setTick((t) => t + 1));
  const [addNom, setAddNom] = useState<{ asset_type: string; asset_id: string; name: string } | null>(null);
  const [nomForm, setNomForm] = useState({ nominee_name: "", nominee_relation: "", share_pct: "100", registered_with: "", registered_on: "" });
  const [addWill, setAddWill] = useState<{ entity_id: string; name: string } | null>(null);
  const [willForm, setWillForm] = useState({ executed_on: "", executor: "", storage_location: "", review_due: "" });
  if (loading || error) return <Status loading={loading} error={error} />;
  const s = data!; const sev = (n: number) => (n === 3 ? "red" : n === 2 ? "amber" : undefined) as any;
  const saveNom = () => act.run("addnom", async () => {
    if (!addNom) return;
    await api("/nominations", { method: "POST", body: JSON.stringify({ asset_type: addNom.asset_type, asset_id: addNom.asset_id, nominee_name: nomForm.nominee_name, nominee_relation: nomForm.nominee_relation || null, share_pct: Number(nomForm.share_pct || 100), registered_with: nomForm.registered_with || null, registered_on: nomForm.registered_on || null }) });
    setAddNom(null); setNomForm({ nominee_name: "", nominee_relation: "", share_pct: "100", registered_with: "", registered_on: "" });
    return "Nomination recorded — the matching gap closes itself.";
  });
  const saveWill = () => act.run("addwill", async () => {
    if (!addWill) return;
    await api("/succession/documents", { method: "POST", body: JSON.stringify({ entity_id: addWill.entity_id, kind: "will", executed_on: willForm.executed_on || null, executor: willForm.executor || null, storage_location: willForm.storage_location || null, review_due: willForm.review_due || null }) });
    setAddWill(null); setWillForm({ executed_on: "", executor: "", storage_location: "", review_due: "" });
    return "Will recorded — the matching gap closes itself.";
  });
  return (<>
    <div className="kpis">
      <Card><div className="mute">Assets of individuals</div><div className="big-num">{s.assets}</div><div className="small mute">{s.nominated} with a nomination</div></Card>
      <Card><div className="mute">Gaps</div><div className="big-num" style={{ color: s.gaps.length ? "var(--red)" : "var(--teal)" }}>{s.gaps.length}</div><div className="small mute">{s.gaps.filter((g: any) => g.severity === 3).length} high</div></Card>
      <Card><div className="mute">Documents</div><div className="big-num">{s.documents.length}</div><div className="small mute">{s.documents.filter((d: any) => d.overdue).length} review overdue</div></Card>
    </div>
    {act.msg}
    {addNom && <Card title={`Add nomination — ${addNom.name}`}><div className="grid-3">
      <Field label="Nominee name"><input style={inp} value={nomForm.nominee_name} onChange={(e) => setNomForm({ ...nomForm, nominee_name: e.target.value })} /></Field>
      <Field label="Relation"><input style={inp} placeholder="spouse, child, …" value={nomForm.nominee_relation} onChange={(e) => setNomForm({ ...nomForm, nominee_relation: e.target.value })} /></Field>
      <Field label="Share %"><input style={inp} type="number" value={nomForm.share_pct} onChange={(e) => setNomForm({ ...nomForm, share_pct: e.target.value })} /></Field>
      <Field label="Registered with"><input style={inp} placeholder="AMC / registrar / bank" value={nomForm.registered_with} onChange={(e) => setNomForm({ ...nomForm, registered_with: e.target.value })} /></Field>
      <Field label="Registered on"><input style={inp} type="date" value={nomForm.registered_on} onChange={(e) => setNomForm({ ...nomForm, registered_on: e.target.value })} /></Field>
    </div><div className="row gap" style={{ marginTop: 8 }}><button className="btn btn-p" disabled={!nomForm.nominee_name} onClick={saveNom}>Save</button><button className="btn" onClick={() => setAddNom(null)}>Cancel</button></div></Card>}
    {addWill && <Card title={`Add will — ${addWill.name}`}><div className="grid-3">
      <Field label="Executed on"><input style={inp} type="date" value={willForm.executed_on} onChange={(e) => setWillForm({ ...willForm, executed_on: e.target.value })} /></Field>
      <Field label="Executor"><input style={inp} value={willForm.executor} onChange={(e) => setWillForm({ ...willForm, executor: e.target.value })} /></Field>
      <Field label="Storage location"><input style={inp} placeholder="bank locker, with family lawyer, …" value={willForm.storage_location} onChange={(e) => setWillForm({ ...willForm, storage_location: e.target.value })} /></Field>
      <Field label="Review due"><input style={inp} type="date" value={willForm.review_due} onChange={(e) => setWillForm({ ...willForm, review_due: e.target.value })} /></Field>
    </div><div className="row gap" style={{ marginTop: 8 }}><button className="btn btn-p" onClick={saveWill}>Save</button><button className="btn" onClick={() => setAddWill(null)}>Cancel</button></div></Card>}
    <div className="grid-2">
      <Card title="Gaps" action={<ShieldAlert size={14} />}><table className="tbl"><thead><tr><th>Asset</th><th>Entity</th><th>Issue</th><th style={{ textAlign: "right" }}>Value</th><th></th></tr></thead><tbody>
        {s.gaps.map((g: any, i: number) => <tr key={i}><td>{g.name}<div className="small mute">{label(g.asset_type)}</div></td><td>{g.entity}</td><td><Pill tone={sev(g.severity)}>{label(g.issue)}</Pill><div className="small mute">{g.detail}</div></td><td style={{ textAlign: "right" }}>{Number(g.value) ? inr(g.value) : ""}</td>
          <td>{canWrite() && g.issue === "no_nominee" && <button className="btn btn-s" onClick={() => { setAddNom({ asset_type: g.asset_type, asset_id: g.asset_id, name: g.name }); setAddWill(null); }}>Add nominee</button>}
            {canWrite() && g.issue === "will_missing" && <button className="btn btn-s" onClick={() => { setAddWill({ entity_id: g.entity_id, name: g.name }); setAddNom(null); }}>Add will</button>}</td></tr>)}
      </tbody></table></Card>
      <div>
        <Card title="Nominations register"><table className="tbl"><thead><tr><th>Asset</th><th>Nominee</th><th style={{ textAlign: "right" }}>Share</th><th>Verified</th><th></th></tr></thead><tbody>
          {(noms.data ?? []).map((n) => <tr key={n.id}><td>{n.asset_name ?? label(n.asset_type)}</td><td>{n.nominee_name} <span className="small mute">{n.nominee_relation ?? ""}</span></td><td style={{ textAlign: "right" }}>{n.share_pct}%</td><td>{n.verified_on ? <Pill tone="teal">{fmtDate(n.verified_on)}</Pill> : canWrite() ? <button className="btn btn-s" onClick={() => act.run("verify", async () => { await api(`/nominations/${n.id}`, { method: "PATCH", body: JSON.stringify({ verified_on: new Date().toISOString().slice(0, 10) }) }); })}>Mark verified</button> : <Pill tone="amber">unverified</Pill>}</td><td>{canWrite() && <button className="btn btn-s" onClick={() => act.run("del", async () => { await api(`/nominations/${n.id}`, { method: "DELETE" }); })}><Trash2 size={12} /></button>}</td></tr>)}
        </tbody></table></Card>
        <Card title="Wills & deeds"><table className="tbl"><thead><tr><th>Kind</th><th>Entity</th><th>Executed</th><th>Review due</th></tr></thead><tbody>
          {s.documents.map((d: any) => <tr key={d.id}><td>{label(d.kind)}</td><td>{d.entity_name ?? "family"}</td><td>{fmtDate(d.executed_on)}</td><td>{d.review_due ? <Pill tone={d.overdue ? "red" : undefined}>{fmtDate(d.review_due)}</Pill> : "—"}</td></tr>)}
        </tbody></table></Card>
      </div>
    </div>
  </>);
}
