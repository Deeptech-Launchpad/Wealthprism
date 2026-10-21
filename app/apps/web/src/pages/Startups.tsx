import { useState } from "react";
import { Plus } from "lucide-react";
import { useApi } from "../lib/useApi";
import { api, inr, session } from "../lib/api";
import { Card, Pill, Status, fmtDate } from "../components";

// Start-ups & private investments (PRD 3.7; FO-40..43): the stake list with marks and MOIC, companies with round history (a round re-marks
// every stake and dilutes the %), commitments with the call schedule, manual marks, and the exit scenario priced from tax_rules.
const inp = { background: "#fff", color: "var(--ink)", borderColor: "var(--line)" } as const;
const role = () => session.get()?.families.find((f) => f.id === session.family())?.role ?? "viewer";
const canWrite = () => ["owner", "member", "operator"].includes(role());
const label = (s?: string | null) => (s ?? "").replace(/_/g, " ");
function Field({ label, children }: { label: string; children: React.ReactNode }) { return <label className="field">{label}{children}</label>; }
function useAction(after?: () => void) {
  const [busy, setBusy] = useState(""); const [err, setErr] = useState(""); const [note, setNote] = useState("");
  const run = async (l: string, fn: () => Promise<string | void>) => { setBusy(l); setErr(""); setNote(""); try { const n = await fn(); if (n) setNote(n); after?.(); } catch (e: any) { setErr(e.message); } finally { setBusy(""); } };
  return { busy, err, note, run, msg: <>{err && <div className="err">{err}</div>}{note && <div className="small" style={{ color: "var(--teal)" }}>{note}</div>}</> };
}
const INSTRUMENTS = ["equity", "ccps", "ccd", "safe_post", "safe_pre", "conv_note", "fund_units", "operating_business"];

export function Startups() {
  const [tick, setTick] = useState(0); const refresh = () => setTick((t) => t + 1);
  const list = useApi<any[]>("/private-investments", [tick]); const cos = useApi<any[]>("/private-companies", [tick]); const ents = useApi<any[]>("/entities");
  const [sel, setSel] = useState<string | null>(null); const [add, setAdd] = useState<"company" | "stake" | null>(null);
  const [co, setCo] = useState({ name: "", sector: "", cin: "" }); const [pi, setPi] = useState<any>({ entity_id: "", company_id: "", instrument: "ccps", stage: "", invested_on: new Date().toISOString().slice(0, 10), amount: "", shares_or_units: "", holding_pct: "", bucket: "growth" });
  const act = useAction(refresh);
  if (list.loading || list.error) return <Status loading={list.loading} error={list.error} />;
  return (<>
    <Card title="Private investments" action={canWrite() ? <div className="row gap"><button className="btn btn-s" onClick={() => setAdd(add === "company" ? null : "company")}><Plus size={14} /> Company</button><button className="btn btn-s" onClick={() => setAdd(add === "stake" ? null : "stake")}><Plus size={14} /> Investment</button></div> : undefined}>
      {add === "company" && <div className="row" style={{ gap: 8, flexWrap: "wrap", alignItems: "flex-end", marginBottom: 8 }}>
        <Field label="Company"><input style={inp} value={co.name} onChange={(e) => setCo({ ...co, name: e.target.value })} /></Field><Field label="Sector"><input style={inp} value={co.sector} onChange={(e) => setCo({ ...co, sector: e.target.value })} /></Field><Field label="CIN"><input style={inp} value={co.cin} onChange={(e) => setCo({ ...co, cin: e.target.value })} /></Field>
        <button className="btn" disabled={!co.name || !!act.busy} onClick={() => act.run("co", async () => { await api("/private-companies", { method: "POST", body: JSON.stringify({ name: co.name, sector: co.sector || null, cin: co.cin || null }) }); setAdd(null); setCo({ name: "", sector: "", cin: "" }); return "Company added"; })}>Add</button></div>}
      {add === "stake" && <div className="row" style={{ gap: 8, flexWrap: "wrap", alignItems: "flex-end", marginBottom: 8 }}>
        <Field label="Entity"><select style={inp} value={pi.entity_id} onChange={(e) => setPi({ ...pi, entity_id: e.target.value })}><option value="">—</option>{(ents.data ?? []).map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}</select></Field>
        <Field label="Company"><select style={inp} value={pi.company_id} onChange={(e) => setPi({ ...pi, company_id: e.target.value })}><option value="">—</option>{(cos.data ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
        <Field label="Instrument"><select style={inp} value={pi.instrument} onChange={(e) => setPi({ ...pi, instrument: e.target.value })}>{INSTRUMENTS.map((i) => <option key={i} value={i}>{label(i)}</option>)}</select></Field>
        <Field label="Stage"><input style={{ ...inp, width: 90 }} value={pi.stage} onChange={(e) => setPi({ ...pi, stage: e.target.value })} /></Field>
        <Field label="Invested on"><input style={inp} type="date" value={pi.invested_on} onChange={(e) => setPi({ ...pi, invested_on: e.target.value })} /></Field>
        <Field label="Amount (₹)"><input style={{ ...inp, width: 110 }} type="number" value={pi.amount} onChange={(e) => setPi({ ...pi, amount: e.target.value })} /></Field>
        <Field label="Shares / units"><input style={{ ...inp, width: 90 }} type="number" value={pi.shares_or_units} onChange={(e) => setPi({ ...pi, shares_or_units: e.target.value })} /></Field>
        <Field label="Holding %"><input style={{ ...inp, width: 70 }} type="number" step="0.001" value={pi.holding_pct} onChange={(e) => setPi({ ...pi, holding_pct: e.target.value })} /></Field>
        <button className="btn" disabled={!pi.entity_id || !pi.company_id || !pi.amount || !!act.busy} onClick={() => act.run("pi", async () => { await api("/private-investments", { method: "POST", body: JSON.stringify({ ...pi, stage: pi.stage || null, amount: +pi.amount, shares_or_units: pi.shares_or_units === "" ? null : +pi.shares_or_units, holding_pct: pi.holding_pct === "" ? null : +pi.holding_pct }) }); setAdd(null); return "Investment recorded"; })}>Add</button></div>}
      <table className="tbl"><thead><tr><th>Company</th><th>Stage</th><th>Instrument</th><th>Entity</th><th className="num">Invested</th><th className="num">Mark</th><th className="num">MOIC</th><th className="num">Unfunded</th><th>Status</th></tr></thead><tbody>{list.data!.map((s) => <tr key={s.id} onClick={() => setSel(sel === s.id ? null : s.id)} style={{ cursor: "pointer", background: sel === s.id ? "#F3F6F9" : undefined }}><td><b>{s.company}</b><div className="small mute">{fmtDate(s.invested_on)} · {s.next_event}</div></td><td>{s.stage}</td><td>{label(s.instrument)}</td><td>{s.entity_name}</td><td className="num">{inr(s.amount)}</td><td className="num">{inr(s.mark)}</td><td className="num">{s.moic}x</td><td className="num">{Number(s.unfunded) ? inr(s.unfunded) : "—"}</td><td><Pill tone={s.status === "active" ? "teal" : s.status === "written_off" ? "red" : "amber"}>{s.status}</Pill></td></tr>)}</tbody></table>
      <div className="small mute" style={{ marginTop: 6 }}>Click a stake for rounds, marks, the commitment schedule and an exit scenario. Marks use the last priced round; Sec 54GB / 80-IAC eligibility and the 24-month holding for LTCG on unlisted shares are tracked per stake.</div>
      {act.msg}
    </Card>
    {sel && <Detail key={sel} id={sel} onChange={refresh} />}
    <Companies key={`c${tick}`} data={cos.data ?? []} onChange={refresh} />
  </>);
}

function Detail({ id, onChange }: { id: string; onChange: () => void }) {
  const d = useApi<any>(`/private-investments/${id}`); const act = useAction(() => { d.refetch(); onChange(); }); const sim = useAction();   // the scenario records nothing: no refetch
  const [mark, setMark] = useState({ marked_on: new Date().toISOString().slice(0, 10), value: "", basis: "manual", note: "" });
  const [sc, setSc] = useState({ price_per_unit: "", units: "", exit_on: new Date().toISOString().slice(0, 10) }); const [res, setRes] = useState<any | null>(null);
  const [cm, setCm] = useState<{ total_commitment: string; drawn: string; schedule: string } | null>(null);
  if (d.loading || d.error) return <Status loading={d.loading} error={d.error} />;
  const p = d.data;
  return (<div className="grid-2">
    <Card title={`${p.company} — round history`}>
      <table className="tbl tight"><thead><tr><th>Round</th><th className="num">Pre-money</th><th className="num">Post-money</th><th className="num">Price / share</th></tr></thead><tbody>{(p.rounds ?? []).map((r: any) => <tr key={r.id}><td>{r.round_name} ({fmtDate(r.closed_on)})</td><td className="num">{inr(r.pre_money)}</td><td className="num">{inr(r.post_money)}</td><td className="num">{r.price_per_share == null ? "—" : `₹${Number(r.price_per_share).toLocaleString("en-IN")}`}</td></tr>)}{!(p.rounds ?? []).length && <tr><td colSpan={4} className="mute">No priced rounds recorded.</td></tr>}</tbody></table>
      <div className="small mute" style={{ marginTop: 8 }}>Your stake: {p.holding_pct == null ? "—" : `${p.holding_pct}%`}{p.shares_or_units ? ` · ${p.shares_or_units} ${p.instrument === "fund_units" ? "units" : "shares"}` : ""} · mark {inr(p.mark)} ({p.moic}x)</div>
      <table className="tbl tight" style={{ marginTop: 8 }}><thead><tr><th>Marked on</th><th className="num">Value</th><th>Basis</th><th>Note</th></tr></thead><tbody>{(p.marks ?? []).slice(0, 6).map((m: any) => <tr key={m.id}><td>{fmtDate(m.marked_on)}</td><td className="num">{inr(m.value)}</td><td>{label(m.basis)}</td><td className="small mute">{m.note}</td></tr>)}</tbody></table>
      {canWrite() && <div className="row" style={{ gap: 8, flexWrap: "wrap", alignItems: "flex-end", marginTop: 8 }}><Field label="Mark on"><input style={inp} type="date" value={mark.marked_on} onChange={(e) => setMark({ ...mark, marked_on: e.target.value })} /></Field><Field label="Value (₹)"><input style={{ ...inp, width: 110 }} type="number" value={mark.value} onChange={(e) => setMark({ ...mark, value: e.target.value })} /></Field><Field label="Basis"><select style={inp} value={mark.basis} onChange={(e) => setMark({ ...mark, basis: e.target.value })}>{["manual", "last_round", "nav"].map((b) => <option key={b} value={b}>{label(b)}</option>)}</select></Field><Field label="Note"><input style={inp} value={mark.note} onChange={(e) => setMark({ ...mark, note: e.target.value })} /></Field><button className="btn btn-s" disabled={!mark.value || !!act.busy} onClick={() => act.run("mark", async () => { await api(`/private-investments/${id}/marks`, { method: "POST", body: JSON.stringify({ ...mark, value: +mark.value, note: mark.note || null }) }); setMark({ ...mark, value: "", note: "" }); return "Mark recorded"; })}>Add mark</button></div>}
      {p.commitment && <div style={{ marginTop: 10 }}><b>Commitment</b> {inr(p.commitment.total_commitment)} · drawn {inr(p.commitment.drawn)} · unfunded {inr(p.commitment.unfunded)}<div className="small mute">Calls: {(p.commitment.schedule ?? []).map((s: any) => `${fmtDate(s.due)} ${inr(s.amount)}`).join(" · ") || "none scheduled"}</div>
        {canWrite() && (cm ? <div className="row" style={{ gap: 8, flexWrap: "wrap", alignItems: "flex-end", marginTop: 6 }}><Field label="Commitment"><input style={{ ...inp, width: 110 }} value={cm.total_commitment} onChange={(e) => setCm({ ...cm, total_commitment: e.target.value })} /></Field><Field label="Drawn"><input style={{ ...inp, width: 110 }} value={cm.drawn} onChange={(e) => setCm({ ...cm, drawn: e.target.value })} /></Field><Field label="Schedule (YYYY-MM-DD:amount, …)"><input style={{ ...inp, width: 260 }} value={cm.schedule} onChange={(e) => setCm({ ...cm, schedule: e.target.value })} /></Field><button className="btn btn-s" disabled={!!act.busy} onClick={() => act.run("cm", async () => { const schedule = cm.schedule.split(",").map((s) => s.trim()).filter(Boolean).map((s) => { const [due, amount] = s.split(":"); return { due, amount: +amount }; }); await api(`/private-investments/${id}/commitments`, { method: "PUT", body: JSON.stringify({ total_commitment: +cm.total_commitment, drawn: +cm.drawn, schedule }) }); setCm(null); return "Commitment saved — calls feed committed outflows and the working-capital float"; })}>Save</button><button className="btn btn-s" onClick={() => setCm(null)}>Cancel</button></div> : <button className="btn btn-s" style={{ marginTop: 6 }} onClick={() => setCm({ total_commitment: String(Number(p.commitment.total_commitment)), drawn: String(Number(p.commitment.drawn)), schedule: (p.commitment.schedule ?? []).map((s: any) => `${s.due}:${Number(s.amount)}`).join(", ") })}>Edit commitment</button>)}</div>}
      {act.msg}
    </Card>
    <Card title={`Exit scenario — ${p.company}`}>
      <div className="row" style={{ gap: 8, flexWrap: "wrap", alignItems: "flex-end" }}><Field label="Price per share / unit (₹)"><input style={{ ...inp, width: 120 }} type="number" value={sc.price_per_unit} onChange={(e) => setSc({ ...sc, price_per_unit: e.target.value })} /></Field><Field label={`Units (held ${p.shares_or_units ?? "—"})`}><input style={{ ...inp, width: 90 }} type="number" value={sc.units} onChange={(e) => setSc({ ...sc, units: e.target.value })} /></Field><Field label="Exit on"><input style={inp} type="date" value={sc.exit_on} onChange={(e) => setSc({ ...sc, exit_on: e.target.value })} /></Field>
        <button className="btn" disabled={!sc.price_per_unit || !!sim.busy} onClick={() => sim.run("sc", async () => { setRes(await api<any>(`/private-investments/${id}/exit-scenario`, { method: "POST", body: JSON.stringify({ price_per_unit: +sc.price_per_unit, units: sc.units === "" ? undefined : +sc.units, exit_on: sc.exit_on }) })); })}>Model full exit</button>
        {p.shares_or_units && <button className="btn btn-s" disabled={!sc.price_per_unit || !!sim.busy} onClick={() => sim.run("sc2", async () => { setRes(await api<any>(`/private-investments/${id}/exit-scenario`, { method: "POST", body: JSON.stringify({ price_per_unit: +sc.price_per_unit, units: Number(p.shares_or_units) / 2, exit_on: sc.exit_on }) })); })}>Partial 50%</button>}</div>
      {res && <table className="tbl tight" style={{ marginTop: 10 }}><tbody>
        <tr><td>Offer</td><td className="num">{inr(res.proceeds)} · {res.units} @ ₹{Number(res.price_per_unit).toLocaleString("en-IN")}</td></tr>
        <tr><td>Cost</td><td className="num">{inr(res.cost)}</td></tr>
        <tr><td>Gain ({res.term === "long" ? "LTCG" : "STCG"}, {label(p.instrument === "fund_units" ? "equity" : "unlisted equity")} {res.tax_rate}%)</td><td className={`num ${Number(res.gain) >= 0 ? "up" : ""}`}>{inr(res.gain)} → tax {inr(res.tax)}</td></tr>
        <tr><td>Net proceeds · MOIC</td><td className="num">{inr(res.net_proceeds)} · {res.moic}x</td></tr>
        <tr><td>Effect on Growth bucket</td><td className="num">{res.bucket_effect_pp > 0 ? "+" : ""}{res.bucket_effect_pp} pp{Math.abs(res.bucket_effect_pp) < 0.5 ? " (immaterial)" : ""}</td></tr>
      </tbody></table>}
      {res && <div className="small mute" style={{ marginTop: 6 }}>{res.note}</div>}
      {!res && <div className="small mute" style={{ marginTop: 6 }}>Nothing is recorded — the scenario prices the gain with the term and rate from tax_rules for the exit year and shows what the growth bucket would lose.</div>}
      {sim.msg}
    </Card>
  </div>);
}

function Companies({ data, onChange }: { data: any[]; onChange: () => void }) {
  const act = useAction(onChange); const [round, setRound] = useState<any | null>(null);
  return (<Card title="Companies">
    <table className="tbl"><thead><tr><th>Company</th><th>Sector</th><th className="num">Stakes</th><th>Rounds</th><th></th></tr></thead><tbody>{data.map((c) => <tr key={c.id}><td><b>{c.name}</b><div className="small mute">{c.cin ?? ""}</div></td><td>{c.sector}</td><td className="num">{c.investments}</td><td className="small">{(c.rounds ?? []).map((r: any) => `${r.round_name} ${inr(r.post_money)}`).join(" · ") || "—"}</td><td>{canWrite() && <button className="btn btn-s" onClick={() => setRound(round?.company_id === c.id ? null : { company_id: c.id, company: c.name, round_name: "", closed_on: new Date().toISOString().slice(0, 10), pre_money: "", raised: "", total_shares_post: "" })}>Add round</button>}</td></tr>)}</tbody></table>
    {round && <div className="row" style={{ gap: 8, flexWrap: "wrap", alignItems: "flex-end", marginTop: 8 }}><b style={{ alignSelf: "center" }}>{round.company}</b><Field label="Round"><input style={{ ...inp, width: 100 }} value={round.round_name} onChange={(e) => setRound({ ...round, round_name: e.target.value })} /></Field><Field label="Closed on"><input style={inp} type="date" value={round.closed_on} onChange={(e) => setRound({ ...round, closed_on: e.target.value })} /></Field><Field label="Pre-money (₹)"><input style={{ ...inp, width: 120 }} type="number" value={round.pre_money} onChange={(e) => setRound({ ...round, pre_money: e.target.value })} /></Field><Field label="Raised (₹)"><input style={{ ...inp, width: 110 }} type="number" value={round.raised} onChange={(e) => setRound({ ...round, raised: e.target.value })} /></Field><Field label="Shares post"><input style={{ ...inp, width: 100 }} type="number" value={round.total_shares_post} onChange={(e) => setRound({ ...round, total_shares_post: e.target.value })} /></Field>
      <button className="btn" disabled={!round.round_name || !round.pre_money || !round.raised || !!act.busy} onClick={() => act.run("round", async () => { const r = await api<any>(`/private-companies/${round.company_id}/rounds`, { method: "POST", body: JSON.stringify({ round_name: round.round_name, closed_on: round.closed_on, pre_money: +round.pre_money, raised: +round.raised, total_shares_post: round.total_shares_post === "" ? null : +round.total_shares_post }) }); setRound(null); return `Round recorded at ${inr(r.post_money)} post-money — ${r.marked.length} stake${r.marked.length === 1 ? "" : "s"} re-marked`; })}>Record round</button></div>}
    {act.msg}
  </Card>);
}
