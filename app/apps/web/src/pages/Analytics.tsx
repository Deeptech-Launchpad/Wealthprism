import { useState } from "react";
import { Play, Trash2, Plus, GitCompare, ArrowDownUp } from "lucide-react";
import { useApi } from "../lib/useApi";
import { api, apiJson, inr, session } from "../lib/api";
import { Card, Pill, Status, fmtDate } from "../components";

// Analytics (PRD 3.12): look-through exposure, IPS rules, private-market metrics, all-in fees, cash-flow forecast, reconciliation.
const inp = { background: "#fff", color: "var(--ink)", borderColor: "var(--line)" } as const;
const role = () => session.get()?.families.find((f) => f.id === session.family())?.role ?? "viewer";
const canWrite = () => ["owner", "member", "operator"].includes(role()); const isMember = () => ["owner", "member"].includes(role());
const label = (s?: string | null) => (s ?? "").replace(/_/g, " ");
const R = { textAlign: "right" as const };
function Field({ label, children }: { label: string; children: React.ReactNode }) { return <label className="field">{label}{children}</label>; }
function useAction(after?: () => void) {
  const [busy, setBusy] = useState(""); const [err, setErr] = useState(""); const [note, setNote] = useState("");
  const run = async (l: string, fn: () => Promise<string | void>) => { setBusy(l); setErr(""); setNote(""); try { const n = await fn(); if (n) setNote(n); after?.(); } catch (e: any) { setErr(e.message); } finally { setBusy(""); } };
  return { busy, err, note, run, msg: <>{err && <div className="err">{err}</div>}{note && <div className="small" style={{ color: "var(--teal)" }}>{note}</div>}</> };
}
const TABS = ["Exposure", "IPS rules", "Private markets", "Fees", "Cash-flow forecast", "Reconciliation"] as const;

export function Analytics() {
  const [tab, setTab] = useState<(typeof TABS)[number]>("Exposure");
  return (<>
    <div className="tabs">{TABS.map((t) => <button key={t} className={tab === t ? "on" : ""} onClick={() => setTab(t)}>{t}</button>)}</div>
    {tab === "Exposure" && <Exposure />}
    {tab === "IPS rules" && <IpsRules />}
    {tab === "Private markets" && <PrivateMarkets />}
    {tab === "Fees" && <Fees />}
    {tab === "Cash-flow forecast" && <Forecast />}
    {tab === "Reconciliation" && <Reconciliation />}
  </>);
}

function Bar({ pct }: { pct: number }) { return <div style={{ background: "var(--line)", height: 6, borderRadius: 3, minWidth: 80 }}><div style={{ width: `${Math.min(100, pct)}%`, height: 6, borderRadius: 3, background: "var(--teal)" }} /></div>; }

function Exposure() {
  const [entity, setEntity] = useState(""); const ents = useApi<any[]>("/entities");
  const { data, error, loading } = useApi<any>(`/exposure/all${entity ? `?entity_id=${entity}` : ""}`);
  if (loading || error) return <Status loading={loading} error={error} />;
  const d = data!;
  return (<>
    <div className="row" style={{ marginBottom: 12, gap: 8 }}><select className="entity" style={inp} value={entity} onChange={(e) => setEntity(e.target.value)}><option value="">All entities</option>{(ents.data ?? []).map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}</select><span className="small mute">Funds and PMS are split through to their underlying; anything the factsheet does not classify is shown as <b>unclassified</b>.</span></div>
    <div className="grid-3">{d.dimensions.map((dim: string) => <Card key={dim} title={`By ${label(dim)}`}><table className="tbl"><tbody>
      {d.exposure[dim].slice(0, 8).map((r: any) => <tr key={r.key}><td style={{ width: "45%" }}>{r.key}<div className="small mute">{r.positions} position{r.positions === 1 ? "" : "s"}</div></td><td><Bar pct={r.pct} /></td><td style={R}>{Number(r.pct).toFixed(1)}%</td></tr>)}
      {d.exposure[dim].length > 8 && <tr><td colSpan={3} className="small mute">+{d.exposure[dim].length - 8} more</td></tr>}
    </tbody></table></Card>)}</div>
  </>);
}

function IpsRules() {
  const [tick, setTick] = useState(0); const { data, error, loading } = useApi<any[]>("/ips-rules", [tick]); const breaches = useApi<any[]>("/ips-breaches?all=1", [tick]); const act = useAction(() => setTick((t) => t + 1));
  const [f, setF] = useState<any>({ code: "max_single_issuer", value: 15, severity: 2 }); const [last, setLast] = useState<any[] | null>(null);
  if (loading || error) return <Status loading={loading} error={error} />;
  const paramKey = (code: string) => (code === "min_credit_rating" ? "rating" : code === "min_liquidity_months" ? "months" : "pct");
  return (<>
    <div className="grid-2" style={{ gridTemplateColumns: "1.4fr 1fr" }}>
      <Card title="Rules" action={canWrite() && <button className="btn btn-s" disabled={!!act.busy} onClick={() => act.run("eval", async () => { const r = await api<any>("/ips-rules/evaluate", { method: "POST", body: "{}" }); setLast(r.results); return r.note; })}><Play size={12} /> Evaluate now</button>}>
        {act.msg}
        <table className="tbl"><thead><tr><th>Rule</th><th>Scope</th><th>Limit</th><th>Latest</th><th>Sev.</th><th></th></tr></thead><tbody>
          {data!.map((r) => { const res = last?.find((x) => x.rule_id === r.id); return <tr key={r.id}><td>{label(r.code)}</td><td>{r.entity_name ?? "family"}</td><td>{Object.entries(r.params).map(([k, v]) => `${k} ${v}`).join(", ")}</td><td>{res ? <Pill tone={res.ok ? "teal" : "red"}>{res.ok ? "ok" : "breach"} · {String(res.actual)}</Pill> : r.active ? <span className="small mute">—</span> : <Pill>inactive</Pill>}</td><td>{r.severity}</td><td>{isMember() && <button className="btn btn-s" onClick={() => act.run("del", async () => { await api(`/ips-rules/${r.id}`, { method: "DELETE" }); })}><Trash2 size={12} /></button>}</td></tr>; })}
        </tbody></table>
        {isMember() && <div className="row" style={{ gap: 8, marginTop: 10, alignItems: "flex-end", flexWrap: "wrap" }}>
          <Field label="New rule"><select style={inp} value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })}>{["max_single_issuer", "max_single_manager", "min_credit_rating", "max_illiquid_pct", "max_sector_pct", "max_unrated_pct", "min_liquidity_months", "max_leverage_pct"].map((c) => <option key={c} value={c}>{label(c)}</option>)}</select></Field>
          <Field label={paramKey(f.code)}><input style={{ ...inp, width: 90 }} value={f.value} onChange={(e) => setF({ ...f, value: e.target.value })} /></Field>
          <Field label="Severity"><select style={inp} value={f.severity} onChange={(e) => setF({ ...f, severity: Number(e.target.value) })}>{[1, 2, 3].map((s) => <option key={s} value={s}>{s}</option>)}</select></Field>
          <button className="btn" onClick={() => act.run("add", async () => { const r = await apiJson<any>("/ips-rules", { code: f.code, params: { [paramKey(f.code)]: paramKey(f.code) === "rating" ? String(f.value) : Number(f.value) }, severity: f.severity }); if (r.status_code >= 400) throw new Error(r.title ?? "Could not save"); })}><Plus size={12} /> Add</button>
        </div>}
      </Card>
      <Card title="Breaches"><table className="tbl"><thead><tr><th>Detected</th><th>Rule</th><th>Detail</th><th>Resolved</th></tr></thead><tbody>
        {(breaches.data ?? []).map((b) => <tr key={b.id}><td>{fmtDate(b.detected_on)}</td><td>{label(b.code)}</td><td className="small">{b.detail?.detail}</td><td>{b.resolved_on ? <Pill tone="teal">{fmtDate(b.resolved_on)}</Pill> : <Pill tone="red">open</Pill>}</td></tr>)}
        {!(breaches.data ?? []).length && <tr><td colSpan={4} className="small mute">No breaches recorded.</td></tr>}
      </tbody></table></Card>
    </div>
  </>);
}

function PrivateMarkets() {
  const { data, error, loading } = useApi<any[]>("/private-metrics"); const [sel, setSel] = useState<string | null>(null);
  if (loading || error) return <Status loading={loading} error={error} />;
  const rows = data!; const cur = rows.find((r) => r.id === sel) ?? rows[0];
  const x = (v: any) => (v == null ? "—" : `${Number(v).toFixed(2)}×`);
  return (<>
    <Card title="Funds and stakes — DPI / RVPI / TVPI / IRR / PME"><table className="tbl"><thead><tr><th>Investment</th><th style={R}>Commitment</th><th style={R}>Paid-in</th><th style={R}>Distributed</th><th style={R}>NAV</th><th style={R}>DPI</th><th style={R}>RVPI</th><th style={R}>TVPI</th><th style={R}>IRR</th><th style={R}>KS-PME</th></tr></thead><tbody>
      {rows.map((r) => <tr key={r.id} onClick={() => setSel(r.id)} style={{ cursor: "pointer", background: cur?.id === r.id ? "var(--soft, #f4f6fa)" : undefined }}><td>{r.name}<div className="small mute">{label(r.instrument)}{r.valuation_basis ? ` · ${r.valuation_basis}` : ""}</div></td><td style={R}>{r.commitment ? inr(r.commitment) : "—"}</td><td style={R}>{inr(r.paid_in)}</td><td style={R}>{inr(r.distributed)}</td><td style={R}>{inr(r.nav)}</td><td style={R}>{x(r.dpi)}</td><td style={R}>{x(r.rvpi)}</td><td style={R}><b>{x(r.tvpi)}</b></td><td style={R}>{r.irr_pct != null ? `${r.irr_pct}%` : "—"}</td><td style={R}>{r.pme != null ? Number(r.pme).toFixed(2) : "—"}</td></tr>)}
    </tbody></table></Card>
    {cur && <div className="grid-2">
      <Card title={`${cur.name} — cash flows`}><table className="tbl"><thead><tr><th>Date</th><th>Kind</th><th style={R}>Amount</th><th>Source</th></tr></thead><tbody>
        {cur.flows.map((f: any) => <tr key={f.id ?? f.date + f.kind}><td>{fmtDate(f.date)}</td><td>{f.kind}{f.forecast ? <Pill>forecast</Pill> : ""}</td><td style={R}>{inr(f.amount)}</td><td className="small mute">{f.source ?? ""}</td></tr>)}
        {!cur.flows.length && <tr><td colSpan={4} className="small mute">No flows recorded; the investment amount stands as the only call.</td></tr>}
      </tbody></table></Card>
      <Card title="Forecast calls and distributions"><table className="tbl"><thead><tr><th>Month</th><th style={R}>Calls</th><th style={R}>Distributions</th></tr></thead><tbody>
        {(cur.forecast ?? []).filter((f: any) => Number(f.calls) || Number(f.distributions)).slice(0, 18).map((f: any) => <tr key={f.month}><td>{f.month}</td><td style={R}>{Number(f.calls) ? inr(f.calls) : ""}</td><td style={R}>{Number(f.distributions) ? inr(f.distributions) : ""}</td></tr>)}
      </tbody></table><div className="small mute" style={{ marginTop: 6 }}>Scheduled drawdowns first, then the unfunded balance over the investment period; distributions follow the expected multiple through the harvest years.</div></Card>
    </div>}
  </>);
}

function Fees() {
  const [fy, setFy] = useState(""); const { data, error, loading } = useApi<any>(`/fees${fy ? `?fy=${fy}` : ""}`);
  if (loading || error) return <Status loading={loading} error={error} />;
  const f = data!;
  return (<>
    <div className="kpis">
      <Card><div className="mute">Fees FY {f.fy}</div><div className="big-num" style={{ color: "var(--red)" }}>{inr(f.total)}</div><div className="small mute">{f.from} → {f.to}</div></Card>
      <Card><div className="mute">% of AUM</div><div className="big-num">{f.pct_of_aum ?? "—"}%</div><div className="small mute">{f.annualised_pct_of_aum ?? "—"}% annualised · AUM {inr(f.aum)}</div></Card>
      <Card><div className="mute">Drag on 1y return</div><div className="big-num">{f.drag_share_of_return_pct != null ? `${f.drag_share_of_return_pct}%` : "—"}</div><div className="small mute">share of the gross return paid away</div></Card>
      <Card><div className="mute">FY</div><select style={inp} value={fy || f.fy} onChange={(e) => setFy(e.target.value)}>{[f.fy, `${Number(f.fy.slice(0, 4)) - 1}-${String(Number(f.fy.slice(5)) - 1).padStart(2, "0")}`].map((y) => <option key={y}>{y}</option>)}</select></Card>
    </div>
    <div className="grid-3">
      {(["by_kind", "by_instrument", "by_entity"] as const).map((k) => <Card key={k} title={label(k)}><table className="tbl"><tbody>{f[k].map((r: any) => <tr key={r.key}><td>{label(r.key)}</td><td><Bar pct={r.pct_of_total} /></td><td style={R}>{inr(r.amount)}</td></tr>)}</tbody></table></Card>)}
    </div>
    <Card title="Detail"><table className="tbl"><thead><tr><th>Date</th><th>Entity</th><th>Instrument</th><th>Kind</th><th style={R}>Amount</th><th>Source</th></tr></thead><tbody>
      {f.rows.map((r: any, i: number) => <tr key={i}><td>{fmtDate(r.fee_date)}</td><td>{r.entity}</td><td>{r.instrument ?? ""}</td><td>{label(r.kind)}{r.implied === false ? "" : <Pill>derived</Pill>}</td><td style={R}>{inr(r.amount)}</td><td className="small mute">{r.source ?? r.note ?? ""}</td></tr>)}
    </tbody></table></Card>
  </>);
}

function Forecast() {
  const [tick, setTick] = useState(0); const [months, setMonths] = useState(12); const { data, error, loading } = useApi<any>(`/cashflow/forecast?full=1&months=${months}`, [tick]); const act = useAction(() => setTick((t) => t + 1));
  if (loading || error) return <Status loading={loading} error={error} />;
  const f = data!; const kinds = Array.from(new Set(f.rows.flatMap((r: any) => Object.keys(r.by_kind)))) as string[];
  return (<>
    <div className="kpis">
      <Card><div className="mute">Opening cash</div><div className="big-num">{inr(f.opening_cash)}</div></Card>
      <Card><div className="mute">Required float</div><div className="big-num">{inr(f.float_required)}</div></Card>
      <Card><div className="mute">First month below float</div><div className="big-num" style={{ color: f.first_below_float ? "var(--red)" : "var(--teal)" }}>{f.first_below_float ?? "none"}</div><div className="small mute">tasks are raised 45 days ahead</div></Card>
      <Card><div className="mute">Horizon</div><div className="row" style={{ gap: 6 }}>{[6, 12, 24].map((m) => <button key={m} className={`btn btn-s ${months === m ? "on" : ""}`} onClick={() => setMonths(m)}>{m}m</button>)}{canWrite() && <button className="btn btn-s" onClick={() => act.run("run", async () => { const r = await api<any>("/cashflow/forecast/run", { method: "POST", body: JSON.stringify({ months }) }); return `Rebuilt · first below float ${r.first_below_float ?? "none"}`; })}><Play size={12} /></button>}</div>{act.msg}</Card>
    </div>
    <Card title="Month by month"><div style={{ overflowX: "auto" }}><table className="tbl"><thead><tr><th>Month</th><th style={R}>Inflows</th><th style={R}>Outflows</th><th style={R}>Net</th><th style={R}>Cash</th>{kinds.map((k) => <th key={k} style={R}>{label(k)}</th>)}</tr></thead><tbody>
      {f.rows.map((r: any) => <tr key={r.month} style={{ background: r.below_float ? "rgba(185,59,49,0.06)" : undefined }}><td>{r.month}{r.below_float && <> <Pill tone="red">below float</Pill></>}</td><td style={R}>{inr(r.inflows)}</td><td style={R}>{inr(r.outflows)}</td><td style={{ ...R, color: Number(r.net) < 0 ? "var(--red)" : "var(--teal)" }}>{inr(r.net)}</td><td style={R}><b>{inr(r.cumulative_cash)}</b></td>{kinds.map((k) => <td key={k} style={R} className="small">{r.by_kind[k] ? inr(r.by_kind[k]) : ""}</td>)}</tr>)}
    </tbody></table></div></Card>
    <Card title="Line items"><div style={{ maxHeight: 360, overflowY: "auto" }}><table className="tbl"><thead><tr><th>Month</th><th>Kind</th><th>Item</th><th style={R}>Amount</th></tr></thead><tbody>
      {f.items.map((i: any, n: number) => <tr key={n}><td>{i.month}</td><td>{label(i.kind)}</td><td>{i.label}</td><td style={{ ...R, color: Number(i.amount) < 0 ? "var(--red)" : "var(--teal)" }}>{inr(i.amount)}</td></tr>)}
    </tbody></table></div></Card>
  </>);
}

function Reconciliation() {
  const [tick, setTick] = useState(0); const [status, setStatus] = useState(""); const { data, error, loading } = useApi<any[]>(`/reconciliation${status ? `?status=${status}` : ""}`, [tick]); const act = useAction(() => setTick((t) => t + 1));
  if (loading || error) return <Status loading={loading} error={error} />;
  return (<Card title="Reconciliation exceptions" action={<span className="row" style={{ gap: 6 }}><select style={inp} value={status} onChange={(e) => setStatus(e.target.value)}><option value="">open & resolved</option>{["mismatch", "missing_in_platform", "missing_in_source", "resolved"].map((s) => <option key={s} value={s}>{label(s)}</option>)}</select>{canWrite() && <button className="btn btn-s" disabled={!!act.busy} onClick={() => act.run("run", async () => { const r = await apiJson<any>("/reconciliation", {}); return r.note; })}><GitCompare size={12} /> Run lots + bank</button>}</span>}>
    {act.msg}
    <table className="tbl"><thead><tr><th>Run</th><th>Source</th><th>Item</th><th style={R}>Platform</th><th style={R}>Source</th><th>Status</th><th></th></tr></thead><tbody>
      {data!.map((r) => <tr key={r.id}><td>{fmtDate(r.run_at)}</td><td>{r.source}</td><td>{r.instrument_name ?? r.bank_account ?? ""}<div className="small mute">{r.entity_name ?? ""} {r.note}</div></td><td style={R}>{r.platform_qty ?? (r.platform_amt ? inr(r.platform_amt) : "—")}</td><td style={R}>{r.source_qty ?? (r.source_amt ? inr(r.source_amt) : "—")}</td><td><Pill tone={r.status === "resolved" ? "teal" : "amber"}>{label(r.status)}{r.resolution ? ` · ${label(r.resolution)}` : ""}</Pill></td>
        <td>{r.status !== "resolved" && canWrite() && <span className="row" style={{ gap: 4 }}>{(["accept_source", "keep_platform", "ignore"] as const).map((a) => <button key={a} className="btn btn-s" onClick={() => act.run(a, async () => { await api(`/reconciliation/${r.id}/resolve`, { method: "POST", body: JSON.stringify({ action: a }) }); })}><ArrowDownUp size={11} /> {label(a)}</button>)}</span>}</td></tr>)}
      {!data!.length && <tr><td colSpan={7} className="small mute">Nothing to reconcile.</td></tr>}
    </tbody></table>
  </Card>);
}
