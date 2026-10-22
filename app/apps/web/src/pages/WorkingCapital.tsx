import { useState } from "react";
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
      <Card><div className="mute">Drag from idle cash</div><div className="big-num" style={{ color: "var(--red)" }}>{inr(d.drag_per_year)} / yr</div><div className="small mute">vs arbitrage after tax</div></Card>
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
    {cur && (cur.lines ?? []).map((l: any) => <div key={l.seq} className="attn"><span className="dot" style={{ background: KC[l.kind] ?? "var(--blue)" }} /><div style={{ flex: 1 }}><b>{l.instrument}</b><div className="small mute">{l.horizon} · {l.tax_treatment} · post-tax {l.post_tax_yield_pct}% (gross {l.gross_yield_pct}%)</div></div><span className="num">{inr(l.amount)}</span></div>)}
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
    <div className="scroll"><table className="tbl"><thead><tr><th>Instrument</th><th>Entity</th><th>Horizon</th><th className="num">Deployed</th><th className="num">Gross yield</th><th>Tax treatment</th><th className="num">Post-tax</th><th>Weight</th></tr></thead>
      <tbody>{rows.map((w) => <tr key={w.holding_id}><td><b>{w.instrument}</b></td><td>{w.entity}</td><td>{w.horizon}</td><td className="num">{inr(w.deployed)}</td><td className="num">{w.gross_yield_pct}%</td><td>{w.tax_treatment}</td><td className="num up">{w.post_tax_yield_pct}%</td><td><div className="prog" style={{ margin: 0, width: 90 }}><div style={{ width: `${Number(w.deployed) / total * 100}%`, background: KC[w.kind] ?? "var(--blue)" }} /></div></td></tr>)}
      {rows.length === 0 && <tr><td colSpan={8} className="mute">Nothing deployed in short-term instruments yet.</td></tr>}</tbody></table></div>
    <div className="small mute" style={{ marginTop: 10 }}>Deployed {inr(l.data.total)} · blended post-tax {l.data.blended_post_tax_yield_pct}% · by horizon: {(l.data.by_horizon ?? []).map((h: any) => `${h.horizon} ${inr(h.deployed)}`).join(" · ") || "—"}. Rules: hold the float in overnight / liquid; anything idle in savings past the idle threshold is flagged; arbitrage for 12-month-plus money in the 30% slab; dated commitments in FDs or target-maturity funds.</div>
  </Card>);
}

function Settings({ onChange }: { onChange: () => void }) {
  const st = useApi<any>("/working-capital/settings"); const [f, setF] = useState<any | null>(null); const act = useAction(() => { st.refetch(); onChange(); });
  if (st.loading || st.error) return <Status loading={st.loading} error={st.error} />;
  const cur = f ?? st.data; const prefs = cur.instrument_prefs ?? { instruments: {}, yields: {} };
  return (<Card title="Float and idle-cash settings" action={isMember() ? <button className="btn btn-s" onClick={() => setF(f ? null : { ...st.data })}>{f ? "Close" : "Edit"}</button> : undefined}>
    <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
      {(["float_days", "buffer_months", "idle_days"] as const).map((k) => <Field key={k} label={label(k)}>{f ? <input style={{ ...inp, width: 80 }} type="number" value={cur[k]} onChange={(e) => setF({ ...cur, [k]: e.target.value })} /> : <div><b>{cur[k]}</b></div>}</Field>)}
    </div>
    <table className="tbl tight" style={{ marginTop: 8 }}><thead><tr><th>Horizon bucket (how long the money is needed)</th><th>Preferred instrument (name shown in the plan)</th><th className="num">Assumed yield (your estimate for new money)</th></tr></thead><tbody>{Object.keys(prefs.instruments ?? {}).map((k) => <tr key={k}><td><b style={{ textTransform: "capitalize" }}>{PERIOD[k] ?? label(k)}</b><div className="small mute" style={{ textTransform: "capitalize" }}>{label(k)}</div></td><td>{f ? <input style={inp} value={prefs.instruments[k] ?? ""} onChange={(e) => setF({ ...cur, instrument_prefs: { ...prefs, instruments: { ...prefs.instruments, [k]: e.target.value } } })} /> : prefs.instruments[k]}</td><td className="num">{f ? <input style={{ ...inp, width: 60 }} type="number" step="0.1" value={prefs.yields?.[k] ?? ""} onChange={(e) => setF({ ...cur, instrument_prefs: { ...prefs, yields: { ...prefs.yields, [k]: e.target.value } } })} /> : `${prefs.yields?.[k] ?? "—"}%`}</td></tr>)}</tbody></table>
    <div className="small mute" style={{ marginTop: 6 }}>The yields are your own estimates for <b>new</b> money, because fund returns are not guaranteed and a new deposit's rate is not known until you book it. Deposits you already hold (the FDs and RDs in the ladder below) use their own fixed rate, not these numbers. The plan uses these figures, after tax, to choose where idle cash should go.</div>
    {f && <div className="row gap" style={{ marginTop: 8 }}><button className="btn" disabled={!!act.busy} onClick={() => act.run("save", async () => { await api("/working-capital/settings", { method: "PUT", body: JSON.stringify({ float_days: +cur.float_days, buffer_months: +cur.buffer_months, idle_days: +cur.idle_days, instrument_prefs: { instruments: prefs.instruments, yields: Object.fromEntries(Object.entries(prefs.yields ?? {}).map(([k, v]) => [k, Number(v)])) } }) }); setF(null); return "Settings saved — the float, excess and future plans use them"; })}>Save</button></div>}
    {act.msg}
  </Card>);
}
