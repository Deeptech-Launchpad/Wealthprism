import { useEffect, useState } from "react";
import { useApi } from "../lib/useApi";
import { api, inr, session } from "../lib/api";
import { Card, Pill, Status, fmtDate } from "../components";

// Working capital (PRD 3.6; FO-60): float and excess from @fo/finance, the upcoming committed outflows, a deployment plan that ladders the
// excess by when it is needed and the entity's slab, the instrument ladder (gross vs post-tax yield) and the family's float / idle settings.
const inp = { background: "#fff", color: "var(--ink)", borderColor: "var(--line)" } as const;
const role = () => session.get()?.families.find((f) => f.id === session.family())?.role ?? "viewer";
const canWrite = () => ["owner", "member", "operator"].includes(role()); const isMember = () => ["owner", "member"].includes(role());
const KC: Record<string, string> = { overnight_fund: "var(--blue)", liquid_fund: "var(--blue)", arbitrage_fund: "var(--teal)", bank_fd: "var(--amber)", target_maturity_debt: "var(--amber)", tbill: "var(--amber)" };
const label = (s?: string | null) => (s ?? "").replace(/_/g, " ");
// how long the money is needed for, per bucket (the same horizons the plan uses); the settings table shows it next to the name
const PERIOD: Record<string, string> = { overnight_fund: "0–7 days", liquid_fund: "7–90 days", arbitrage_fund: "3–12 months", bank_fd: "1–3 years", target_maturity_debt: "3+ years" };
function Field({ label, children }: { label: string; children: React.ReactNode }) { return <label className="field">{label}{children}</label>; }
function useAction(after?: () => void) {
  const [busy, setBusy] = useState(""); const [err, setErr] = useState(""); const [note, setNote] = useState("");
  const run = async (l: string, fn: () => Promise<string | void>) => { setBusy(l); setErr(""); setNote(""); try { const n = await fn(); if (n) setNote(n); after?.(); } catch (e: any) { setErr(e.message); } finally { setBusy(""); } };
  return { busy, err, note, run, msg: <>{err && <div className="err">{err}</div>}{note && <div className="small" style={{ color: "var(--teal)" }}>{note}</div>}</> };
}

export function WorkingCapital() {
  const [tick, setTick] = useState(0); const refresh = () => setTick((t) => t + 1);
  const { data, error, loading } = useApi<any>("/working-capital/summary", [tick]); const out = useApi<any[]>("/committed-outflows?days=90", [tick]);
  if (loading || error) return <Status loading={loading} error={error} />;
  const d = data!;
  return (<>
    <div className="kpis">
      <Card><div className="mute">Cash across accounts</div><div className="big-num">{inr(d.cash_total)}</div></Card>
      <Card><div className="mute">Required float ({d.float_days} days)</div><div className="big-num">{inr(d.required_float)}</div><div className="small mute">{d.committed_outflows} committed outflows + buffer</div></Card>
      <Card><div className="mute">Deployable excess</div><div className="big-num" style={{ color: "var(--teal)" }}>{inr(d.deployable_excess)}</div></Card>
      <Card><div className="mute">Drag from idle cash</div><div className="big-num" style={{ color: "var(--red)" }}>{inr(d.drag_per_year)} / yr</div><div className="small mute">rough yearly gain missed (4.5% of the spare cash)</div>{d.inflation_loss_per_year != null && <div className="small mute" style={{ marginTop: 4 }}>At {d.inflation_pct}% inflation it also loses about {inr(d.inflation_loss_per_year)} of buying power a year, before any interest.</div>}</Card>
    </div>
    <div className="grid-2">
      <Card title="Upcoming committed outflows (next 90 days)">
        {(out.data ?? []).filter((o) => o.status === "pending" && new Date(o.due_date).getTime() >= Date.now() - 86400000).slice(0, 12).map((o) => <div key={o.id} className="attn"><span className="mute" style={{ width: 70 }}>{fmtDate(o.due_date)}</span><span style={{ flex: 1 }}>{o.label ?? label(o.kind)}<span className="small mute"> · {o.entity_name ?? ""}</span></span><span className="num">{inr(o.amount)}</span></div>)}
        {out.data && out.data.length === 0 && <div className="small mute">No pending outflows — capital calls, advance tax, GST and premiums land here from their modules.</div>}
      </Card>
      <Plan excess={Number(d.deployable_excess)} onChange={refresh} />
    </div>
    <Ladder />
    <Settings onChange={refresh} />
  </>);
}

function Plan({ excess, onChange }: { excess: number; onChange: () => void }) {
  const plans = useApi<any[]>("/working-capital/plans"); const [p, setP] = useState<any | null>(null); const [amt, setAmt] = useState(""); const act = useAction(() => { plans.refetch(); onChange(); });
  const cur = p ?? plans.data?.find((x) => x.status === "proposed") ?? null;
  return (<Card title={`Deployment plan${cur ? ` for ${inr(cur.excess_amount)}` : excess > 0 ? ` for ${inr(excess)}` : ""}`} action={canWrite() ? <div className="row gap"><input style={{ ...inp, width: 110 }} placeholder={excess > 0 ? String(Math.round(excess)) : "amount"} value={amt} onChange={(e) => setAmt(e.target.value)} /><button className="btn btn-s" disabled={!!act.busy || (excess <= 0 && !amt)} onClick={() => act.run("plan", async () => { setP(await api<any>("/working-capital/plan", { method: "POST", body: JSON.stringify(amt ? { amount: +amt } : {}) })); })}>Build plan</button>{cur && cur.status === "proposed" && <button className="btn" disabled={!!act.busy} onClick={() => act.run("tasks", async () => { const r = await api<any>(`/working-capital/plan/${cur.id}/tasks`, { method: "POST", body: "{}" }); setP(null); const n = Array.isArray(r) ? r.length : 0; return `${n} task${n === 1 ? "" : "s"} created — execute on MF Central or the bank; they verify on the next import`; })}>Create tasks</button>}</div> : undefined}>
    <div className="small mute" style={{ marginBottom: 8 }}>Ladder matches each rupee to when it is needed, then picks the most tax-efficient instrument for that horizon and the entity's slab.</div>
    {!cur && <div className="small mute">{excess > 0 ? "No plan yet for the current excess." : "Nothing to deploy: cash is within the float."}</div>}
    {cur && (cur.lines ?? []).map((l: any) => <div key={l.seq} className="attn"><span className="dot" style={{ background: KC[l.kind] ?? "var(--blue)" }} /><div style={{ flex: 1 }}><b>{l.instrument}</b><div className="small mute">{l.horizon} · {l.tax_treatment} · post-tax {l.post_tax_yield_pct}% (gross {l.gross_yield_pct}%{l.yield_source === "live" ? ", live" : ""}){l.real_yield_pct != null && <> · <span style={{ color: Number(l.real_yield_pct) < 0 ? "var(--red)" : "var(--teal)" }}>after inflation {l.real_yield_pct}%</span></>}</div></div><span className="num">{inr(l.amount)}</span></div>)}
    {cur && <div className="small mute" style={{ marginTop: 6 }}>{cur.status}{cur.tasked_at ? ` · tasks raised ${fmtDate(cur.tasked_at)}` : ""}{cur.blended_post_tax_yield_pct != null ? ` · blended post-tax ${cur.blended_post_tax_yield_pct}%` : ""} · built {fmtDate(cur.created_at)}</div>}
    {(plans.data ?? []).length > 1 && <details style={{ marginTop: 8 }}><summary className="small mute">Earlier plans ({plans.data!.length - 1})</summary>{plans.data!.slice(1).map((x) => <div key={x.id} className="small mute">{fmtDate(x.created_at)} · {inr(x.excess_amount)} · {x.status}</div>)}</details>}
    {act.msg}
  </Card>);
}

function Ladder() {
  const l = useApi<any>("/working-capital/ladder");
  if (l.loading || l.error) return <Status loading={l.loading} error={l.error} />;
  const rows: any[] = l.data.rows ?? []; const total = Number(l.data.total) || 1;
  return (<Card title="Instrument ladder — yield vs. post-tax yield">
    <div className="scroll"><table className="tbl"><thead><tr><th>Instrument</th><th>Entity</th><th>Horizon</th><th className="num">Deployed</th><th className="num">Gross yield</th><th>Tax treatment</th><th className="num">Post-tax</th><th className="num">After inflation</th><th>Weight</th></tr></thead>
      <tbody>{rows.map((w) => <tr key={w.holding_id}><td><b>{w.instrument}</b></td><td>{w.entity}</td><td>{w.horizon}</td><td className="num">{inr(w.deployed)}</td><td className="num">{w.gross_yield_pct}%</td><td>{w.tax_treatment}</td><td className="num up">{w.post_tax_yield_pct}%</td><td className="num" style={{ color: Number(w.real_yield_pct) < 0 ? "var(--red)" : undefined }}>{w.real_yield_pct}%</td><td><div className="prog" style={{ margin: 0, width: 90 }}><div style={{ width: `${Number(w.deployed) / total * 100}%`, background: KC[w.kind] ?? "var(--blue)" }} /></div></td></tr>)}
      {rows.length === 0 && <tr><td colSpan={9} className="mute">Nothing deployed in short-term instruments yet.</td></tr>}</tbody></table></div>
    <div className="small mute" style={{ marginTop: 10 }}>Deployed {inr(l.data.total)} · blended post-tax {l.data.blended_post_tax_yield_pct}% · after {l.data.inflation_pct}% inflation {l.data.blended_real_yield_pct}% · by horizon: {(l.data.by_horizon ?? []).map((h: any) => `${h.horizon} ${inr(h.deployed)}`).join(" · ") || "—"}. Rules: hold the float in overnight / liquid; anything idle in savings past the idle threshold is flagged; arbitrage for 12-month-plus money in the 30% slab; dated commitments in FDs or target-maturity funds.</div>
  </Card>);
}

const FUND_BUCKETS = ["overnight_fund", "liquid_fund", "arbitrage_fund", "target_maturity_debt"];
const BASIS: Record<string, string> = { overnight_fund: "30-day", liquid_fund: "30-day", arbitrage_fund: "1-year", target_maturity_debt: "1-year" };

/** Search AMFI's scheme list and link a bucket to one scheme: the bucket's yield then comes from that scheme's own NAV growth. */
function FundPicker({ bucket, onLinked }: { bucket: string; onLinked: (settings: any) => void }) {
  const [q, setQ] = useState(""); const [hits, setHits] = useState<any[] | null>(null); const [busy, setBusy] = useState(""); const [err, setErr] = useState("");
  useEffect(() => {
    if (q.trim().length < 3) { setHits(null); return; }
    let alive = true; setBusy("search"); setErr("");
    const t = setTimeout(async () => {
      try { const r = await api<any[]>(`/working-capital/fund-search?q=${encodeURIComponent(q.trim())}`); if (alive) setHits(r); }
      catch (e: any) { if (alive) { setErr(e.message); setHits(null); } }
      finally { if (alive) setBusy(""); }
    }, 350);
    return () => { alive = false; clearTimeout(t); };
  }, [q]);
  const link = async (code: string) => {
    setBusy(code); setErr("");
    try { onLinked(await api<any>("/working-capital/fund-link", { method: "POST", body: JSON.stringify({ bucket, code }) })); setQ(""); setHits(null); }
    catch (e: any) { setErr(e.message); } finally { setBusy(""); }
  };
  return (<div>
    <input style={{ ...inp, width: "100%", boxSizing: "border-box" }} placeholder="Search a fund, e.g. HDFC liquid direct growth" value={q} onChange={(e) => setQ(e.target.value)} />
    {busy === "search" && <div className="small mute">Searching the AMFI fund list…</div>}
    {err && <div className="err">{err}</div>}
    {hits && hits.length === 0 && <div className="small mute">No fund matches every word you typed.</div>}
    {hits && hits.length > 0 && <div style={{ border: "1px solid var(--line)", borderRadius: 6, marginTop: 4, background: "#fff" }}>{hits.map((h) => <div key={h.code} className="small" style={{ padding: "6px 8px", cursor: "pointer", borderBottom: "1px solid var(--line)" }} onClick={() => !busy && link(h.code)}><b>{h.name}</b> <span className="mute">· {h.plan}{h.option ? `, ${h.option}` : ""}</span><div className="mute">NAV {h.nav} on {fmtDate(h.date)}{busy === h.code ? " · linking and fetching history…" : ""}</div></div>)}</div>}
  </div>);
}

function Settings({ onChange }: { onChange: () => void }) {
  const st = useApi<any>("/working-capital/settings");
  const [srv, setSrv] = useState<any | null>(null);          // the settings as the server has them; link / refresh replies update it too
  const [f, setF] = useState<any | null>(null);               // the draft while editing
  const [picking, setPicking] = useState<string | null>(null);
  const act = useAction(() => onChange());
  useEffect(() => { if (st.data) setSrv(st.data); }, [st.data]);
  if (!srv) return <Status loading={st.loading} error={st.error} />;
  const prefs = srv.instrument_prefs; const live = srv.live_yields ?? {}; const source = srv.yield_source ?? {}; const linkedAny = Object.keys(prefs.funds ?? {}).length > 0;
  const startEdit = () => setF({ float_days: srv.float_days, buffer_months: srv.buffer_months, idle_days: srv.idle_days, inflation_pct: prefs.inflation_pct, names: { ...prefs.instruments }, typed: { ...prefs.manual_yields }, mode: { ...(prefs.yield_mode ?? {}) } });
  const closeEdit = () => { setF(null); setPicking(null); };
  const applyServer = (s: any) => { setSrv(s); if (f) setF({ ...f, names: { ...f.names, ...s.instrument_prefs.instruments }, mode: { ...(s.instrument_prefs.yield_mode ?? {}) } }); setPicking(null); onChange(); };
  const liveOf = (k: string) => live[k]?.pct as number | null | undefined;
  /** What the yield box shows and how it is labelled, for one bucket. */
  const yieldCell = (k: string) => {
    const linked = prefs.funds?.[k]; const lv = live[k]; const editing = !!f;
    const manualNow = editing ? (f.mode[k] === "manual" || !linked) : source[k] === "manual";
    const shown = editing ? (!manualNow && liveOf(k) != null ? liveOf(k) : f.typed[k]) : prefs.yields[k];
    let tag: React.ReactNode;
    if (!linked) tag = <span className="small mute">{FUND_BUCKETS.includes(k) ? "typed by you — link a fund to make it live" : "typed by you — banks publish no rate feed"}</span>;
    else if (!manualNow && liveOf(k) != null) tag = <span className="small" style={{ color: "var(--teal)" }}>live · {BASIS[k]} · {fmtDate(lv.from)} → {fmtDate(lv.to)}</span>;
    else if (!manualNow) tag = <span className="small" style={{ color: "var(--amber)" }}>waiting for enough NAV history — using your typed {editing ? f.typed[k] : prefs.manual_yields[k]}%</span>;
    else tag = <span className="small mute">typed by you{liveOf(k) != null ? <> · live would be {liveOf(k)}% {editing && <button type="button" className="btn btn-s" style={{ marginLeft: 6 }} onClick={() => setF({ ...f, mode: { ...f.mode, [k]: "live" } })}>Use live</button>}</> : null}</span>;
    return (<div style={{ textAlign: "right" }}>
      {editing ? <input style={{ ...inp, width: 70, textAlign: "right" }} type="number" step="0.01" value={shown ?? ""} onWheel={(e) => (e.target as HTMLInputElement).blur()} onChange={(e) => setF({ ...f, typed: { ...f.typed, [k]: e.target.value }, mode: linked ? { ...f.mode, [k]: "manual" } : f.mode })} /> : <b>{shown ?? "—"}%</b>}
      <div>{tag}</div></div>);
  };
  const nameCell = (k: string) => {
    const linked = prefs.funds?.[k];
    if (!f) return (<div>{prefs.instruments[k]}{linked && <div className="small mute">linked to AMFI scheme {linked.code}</div>}</div>);
    if (!FUND_BUCKETS.includes(k)) return <input style={inp} value={f.names[k] ?? ""} onChange={(e) => setF({ ...f, names: { ...f.names, [k]: e.target.value } })} />;
    if (picking === k || !linked) return (<div><FundPicker bucket={k} onLinked={applyServer} />{linked && <button type="button" className="btn btn-s" style={{ marginTop: 4 }} onClick={() => setPicking(null)}>Keep {String(linked.name).split(" — ")[0]}</button>}</div>);
    return (<div><b>{prefs.instruments[k]}</b><div className="small mute">AMFI scheme {linked.code}</div>
      <div className="row gap" style={{ marginTop: 4 }}><button type="button" className="btn btn-s" onClick={() => setPicking(k)}>Change fund</button><button type="button" className="btn btn-s" disabled={!!act.busy} onClick={() => act.run("unlink", async () => { applyServer(await api<any>(`/working-capital/fund-link/${k}`, { method: "DELETE" })); })}>Unlink</button></div></div>);
  };
  const refreshYields = () => act.run("refresh", async () => { const r = await api<any>("/working-capital/yields/refresh", { method: "POST" }); setSrv(r); onChange(); return r.refreshed ? `Refreshed ${r.refreshed} linked fund${r.refreshed === 1 ? "" : "s"} from AMFI` : "No fund is linked yet"; });
  const save = () => act.run("save", async () => {
    const mode: Record<string, string> = {}; for (const k of Object.keys(f.mode)) if (prefs.funds?.[k] || f.mode[k] === "manual") mode[k] = f.mode[k];
    const r = await api<any>("/working-capital/settings", { method: "PUT", body: JSON.stringify({ float_days: +f.float_days, buffer_months: +f.buffer_months, idle_days: +f.idle_days, instrument_prefs: { instruments: f.names, yields: Object.fromEntries(Object.entries(f.typed ?? {}).map(([k, v]) => [k, Number(v)])), yield_mode: mode, inflation_pct: Number(f.inflation_pct) } }) });
    setSrv(r); closeEdit(); onChange(); return "Settings saved — the float, excess and future plans use them";
  });
  const top = f ?? { float_days: srv.float_days, buffer_months: srv.buffer_months, idle_days: srv.idle_days, inflation_pct: prefs.inflation_pct };
  return (<Card title="Float and idle-cash settings" action={<div className="row gap">{linkedAny && canWrite() && <button className="btn btn-s" disabled={!!act.busy} onClick={refreshYields}>Refresh yields</button>}{isMember() && <button className="btn btn-s" onClick={() => (f ? closeEdit() : startEdit())}>{f ? "Close" : "Edit"}</button>}</div>}>
    <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
      {([["float_days", "float days"], ["buffer_months", "buffer months"], ["idle_days", "idle days"], ["inflation_pct", "inflation %"]] as const).map(([k, lab]) => <Field key={k} label={lab}>{f ? <input style={{ ...inp, width: 80 }} type="number" step="0.1" value={(top as any)[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} /> : <div><b>{(top as any)[k]}</b></div>}</Field>)}
    </div>
    <table className="tbl tight" style={{ marginTop: 8 }}><thead><tr><th>Horizon bucket (how long the money is needed)</th><th>Preferred instrument (name shown in the plan)</th><th className="num">Yield (live for a linked fund, else your estimate)</th></tr></thead>
      <tbody>{Object.keys(prefs.instruments ?? {}).map((k) => <tr key={k}><td style={{ verticalAlign: "top" }}><b style={{ textTransform: "capitalize" }}>{PERIOD[k] ?? label(k)}</b><div className="small mute" style={{ textTransform: "capitalize" }}>{label(k)}</div></td><td style={{ verticalAlign: "top" }}>{nameCell(k)}</td><td className="num" style={{ verticalAlign: "top" }}>{yieldCell(k)}</td></tr>)}</tbody></table>
    <div className="small mute" style={{ marginTop: 6 }}>For a <b>fund</b> bucket, link an actual scheme: its yield is then worked out from that scheme&apos;s own NAV history (about 30 days for overnight and liquid funds, one year for arbitrage and target-maturity funds, annualised) and refreshed every night — past growth, not a promise. You can still type your own number; it then wins until you press <b>Use live</b>. A <b>bank FD</b> has no public rate feed, so its yield is always yours to type. Deposits you already hold use their own fixed rate in the ladder, not these numbers. After inflation = after-tax yield − the inflation % above.</div>
    {f && <div className="row gap" style={{ marginTop: 8 }}><button className="btn" disabled={!!act.busy} onClick={save}>Save</button></div>}
    {act.msg}
  </Card>);
}
