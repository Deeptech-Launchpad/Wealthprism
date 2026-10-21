import { useState } from "react";
import { Download } from "lucide-react";
import { useApi } from "../lib/useApi";
import { api, inr, session } from "../lib/api";
import { Card, Pill, Status, fmtDate } from "../components";

// Investments residue (FO-34, PRD 3.13): harvest candidates with the Schedule CG export, and the global module — LRS remittances against the
// USD limit with TCS from tax_params, foreign tax credits with Form 67 status, reference FX rates (owner-entered or the daily feed).
const inp = { background: "#fff", color: "var(--ink)", borderColor: "var(--line)" } as const;
const role = () => session.get()?.families.find((f) => f.id === session.family())?.role ?? "viewer";
const canWrite = () => ["owner", "member", "operator"].includes(role()); const isOwner = () => role() === "owner";
const label = (s?: string | null) => (s ?? "").replace(/_/g, " ");
const fyNow = () => { const d = new Date(); const y = d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1; return `${y}-${String(y + 1).slice(-2)}`; };
function Field({ label, children }: { label: string; children: React.ReactNode }) { return <label className="field">{label}{children}</label>; }
function useAction(after?: () => void) {
  const [busy, setBusy] = useState(""); const [err, setErr] = useState(""); const [note, setNote] = useState("");
  const run = async (l: string, fn: () => Promise<string | void>) => { setBusy(l); setErr(""); setNote(""); try { const n = await fn(); if (n) setNote(n); after?.(); } catch (e: any) { setErr(e.message); } finally { setBusy(""); } };
  return { busy, err, note, run, msg: <>{err && <div className="err">{err}</div>}{note && <div className="small" style={{ color: "var(--teal)" }}>{note}</div>}</> };
}

export function Harvest() {
  const [fy, setFy] = useState(fyNow()); const h = useApi<any>(`/harvest-candidates?fy=${fy}`, [fy]); const act = useAction(); const [link, setLink] = useState<any | null>(null);
  return (<Card title="Tax-loss harvesting candidates" action={<div className="row gap"><input style={{ ...inp, width: 80 }} value={fy} onChange={(e) => setFy(e.target.value)} />{["csv", "xlsx", "pdf"].map((f) => <button key={f} className="btn btn-s" disabled={!!act.busy} onClick={() => act.run(f, async () => { setLink(await api<any>(`/capital-gains/export?fy=${fy}&format=${f}`)); return `Schedule CG ${f.toUpperCase()} ready`; })}><Download size={14} /> {f.toUpperCase()}</button>)}</div>}>
    {link?.url && <div className="small" style={{ marginBottom: 8 }}><a href={link.url} target="_blank" rel="noreferrer">{link.name ?? "Download the capital-gains file"}</a> · {link.status}</div>}
    {h.loading || h.error ? <Status loading={h.loading} error={h.error} /> : <>
      <table className="tbl"><thead><tr><th>Holding</th><th>Entity</th><th>Term</th><th className="num">Value</th><th className="num">Unrealised</th><th className="num">Rate</th><th className="num">Tax saved / headroom</th><th>Why</th></tr></thead>
        <tbody>{(h.data.rows ?? []).map((r: any) => <tr key={`${r.holding_id}-${r.term}`}><td><b>{r.instrument}</b><div className="small mute">{label(r.asset_class)} · {r.lots} lot{r.lots === 1 ? "" : "s"} · {r.quantity}</div></td><td>{r.entity}</td><td>{r.term}</td><td className="num">{inr(r.value)}</td><td className={`num ${Number(r.unrealised_gain) < 0 ? "" : "up"}`}>{inr(r.unrealised_gain)}</td><td className="num">{r.tax_rate_pct ?? "slab"}%</td><td className="num">{r.kind === "loss" ? inr(r.tax_saved_if_harvested) : inr(r.exemption_headroom)}</td><td>{r.kind === "loss" ? <Pill tone="red">book loss</Pill> : <Pill tone="teal">exempt gain</Pill>}<div className="small mute" style={{ maxWidth: 320 }}>{r.note}</div></td></tr>)}
        {!(h.data.rows ?? []).length && <tr><td colSpan={8} className="mute">No losses to book and no long-term gains inside the exemption headroom for {fy}.</td></tr>}</tbody></table>
      <div className="small mute" style={{ marginTop: 8 }}>{h.data.note}</div></>}
    {act.msg}
  </Card>);
}

export function Global() {
  const [tick, setTick] = useState(0); const refresh = () => setTick((t) => t + 1);
  return (<><div className="grid-2"><Lrs key={`l${tick}`} onChange={refresh} /><Ftc key={`f${tick}`} onChange={refresh} /></div><Fx key={`x${tick}`} onChange={refresh} /></>);
}

function Lrs({ onChange }: { onChange: () => void }) {
  const [fy, setFy] = useState(fyNow()); const s = useApi<any>(`/global/lrs?fy=${fy}`, [fy]); const ents = useApi<any[]>("/entities"); const act = useAction(onChange);
  const [f, setF] = useState<any | null>(null);
  if (s.loading || s.error) return <Status loading={s.loading} error={s.error} />;
  const d = s.data;
  return (<Card title={`LRS remittances — FY ${fy}`} action={<div className="row gap"><input style={{ ...inp, width: 80 }} value={fy} onChange={(e) => setFy(e.target.value)} />{canWrite() && <button className="btn btn-s" onClick={() => setF(f ? null : { entity_id: "", remitted_on: new Date().toISOString().slice(0, 10), ccy: "USD", amount_ccy: "", purpose: "overseas_investment", tcs_collected: "", note: "" })}>{f ? "Close" : "Record remittance"}</button>}</div>}>
    <div className="small mute" style={{ marginBottom: 6 }}>Limit USD {Number(d.limit_usd).toLocaleString("en-IN")} per resident individual per FY · TCS {d.tcs_rate_pct}% on the aggregate above {inr(d.tcs_threshold_inr)} (tax_params)</div>
    <table className="tbl tight"><thead><tr><th>Entity</th><th className="num">Remitted (USD)</th><th className="num">INR</th><th className="num">Headroom</th><th className="num">TCS expected</th><th className="num">TCS collected</th><th></th></tr></thead><tbody>{(d.by_entity ?? []).map((e: any) => <tr key={e.entity_id}><td><b>{e.entity}</b></td><td className="num">{Number(e.total_usd).toLocaleString("en-IN")}</td><td className="num">{inr(e.total_inr)}</td><td className="num">{Number(e.headroom_usd).toLocaleString("en-IN")}</td><td className="num">{inr(e.tcs_expected)}</td><td className="num">{inr(e.tcs_collected)}</td><td>{e.over_limit ? <Pill tone="red">over limit</Pill> : Number(e.tcs_expected) > Number(e.tcs_collected) ? <Pill tone="amber">TCS short</Pill> : <Pill tone="teal">ok</Pill>}</td></tr>)}{!(d.by_entity ?? []).length && <tr><td colSpan={7} className="mute">No remittances this FY.</td></tr>}</tbody></table>
    {f && <div className="row" style={{ gap: 8, flexWrap: "wrap", alignItems: "flex-end", marginTop: 8 }}>
      <Field label="Entity"><select style={inp} value={f.entity_id} onChange={(e) => setF({ ...f, entity_id: e.target.value })}><option value="">—</option>{(ents.data ?? []).filter((e) => e.type === "individual").map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}</select></Field>
      <Field label="Date"><input style={inp} type="date" value={f.remitted_on} onChange={(e) => setF({ ...f, remitted_on: e.target.value })} /></Field><Field label="Ccy"><input style={{ ...inp, width: 60 }} value={f.ccy} onChange={(e) => setF({ ...f, ccy: e.target.value.toUpperCase() })} /></Field><Field label="Amount"><input style={{ ...inp, width: 110 }} type="number" value={f.amount_ccy} onChange={(e) => setF({ ...f, amount_ccy: e.target.value })} /></Field>
      <Field label="Purpose"><select style={inp} value={f.purpose} onChange={(e) => setF({ ...f, purpose: e.target.value })}>{["overseas_investment", "education", "travel", "gift", "maintenance", "medical", "other"].map((p) => <option key={p} value={p}>{label(p)}</option>)}</select></Field>
      <Field label="TCS collected (₹)"><input style={{ ...inp, width: 100 }} type="number" value={f.tcs_collected} onChange={(e) => setF({ ...f, tcs_collected: e.target.value })} /></Field><Field label="Note"><input style={inp} value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></Field>
      <button className="btn" disabled={!f.entity_id || !f.amount_ccy || !!act.busy} onClick={() => act.run("lrs", async () => { const r = await api<any>("/global/lrs", { method: "POST", body: JSON.stringify({ ...f, amount_ccy: +f.amount_ccy, tcs_collected: f.tcs_collected === "" ? null : +f.tcs_collected, note: f.note || null }) }); setF(null); return r.warning ?? `Recorded at ${inr(r.amount_inr)}`; })}>Record</button></div>}
    <table className="tbl tight" style={{ marginTop: 8 }}><thead><tr><th>Date</th><th>Entity</th><th>Purpose</th><th className="num">Amount</th><th className="num">INR</th><th className="num">TCS</th><th></th></tr></thead><tbody>{(d.items ?? []).map((l: any) => <tr key={l.id}><td>{fmtDate(l.remitted_on)}</td><td>{l.entity_name}</td><td>{label(l.purpose)}</td><td className="num">{l.ccy} {Number(l.amount_ccy).toLocaleString("en-IN")}</td><td className="num">{inr(l.amount_inr)}</td><td className="num">{inr(l.tcs_collected)}</td><td>{canWrite() && <button className="btn btn-s" disabled={!!act.busy} onClick={() => act.run("del", async () => { await api(`/global/lrs/${l.id}`, { method: "DELETE" }); return "Removed"; })}>Remove</button>}</td></tr>)}</tbody></table>
    {act.msg}
  </Card>);
}

function Ftc({ onChange }: { onChange: () => void }) {
  const [fy, setFy] = useState(""); const d = useApi<any>(`/global/foreign-tax-credits${fy ? `?fy=${fy}` : ""}`, [fy]); const ents = useApi<any[]>("/entities"); const act = useAction(onChange);
  const [f, setF] = useState<any | null>(null);
  if (d.loading || d.error) return <Status loading={d.loading} error={d.error} />;
  return (<Card title="Foreign tax credits (DTAA, Form 67)" action={<div className="row gap"><input style={{ ...inp, width: 80 }} placeholder="all FYs" value={fy} onChange={(e) => setFy(e.target.value)} />{canWrite() && <button className="btn btn-s" onClick={() => setF(f ? null : { entity_id: "", fy: fyNow(), country: "US", income_type: "dividend", income_inr: "", foreign_tax_inr: "", dtaa_article: "", note: "" })}>{f ? "Close" : "Add credit"}</button>}</div>}>
    {(d.data.by_entity_fy ?? []).map((t: any) => <div key={`${t.entity_id}${t.fy}`} className="attn"><div style={{ flex: 1 }}><b>{t.entity}</b> · FY {t.fy}<div className="small mute">income {inr(t.income_inr)} · foreign tax {inr(t.foreign_tax_inr)}</div></div>{t.form67_pending ? <Pill tone="amber">Form 67 pending ({t.form67_pending})</Pill> : <Pill tone="teal">Form 67 filed</Pill>}</div>)}
    {f && <div className="row" style={{ gap: 8, flexWrap: "wrap", alignItems: "flex-end", marginTop: 8 }}>
      <Field label="Entity"><select style={inp} value={f.entity_id} onChange={(e) => setF({ ...f, entity_id: e.target.value })}><option value="">—</option>{(ents.data ?? []).map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}</select></Field>
      <Field label="FY"><input style={{ ...inp, width: 80 }} value={f.fy} onChange={(e) => setF({ ...f, fy: e.target.value })} /></Field><Field label="Country"><input style={{ ...inp, width: 50 }} value={f.country} onChange={(e) => setF({ ...f, country: e.target.value.toUpperCase() })} /></Field>
      <Field label="Income type"><select style={inp} value={f.income_type} onChange={(e) => setF({ ...f, income_type: e.target.value })}>{["dividend", "interest", "gains"].map((p) => <option key={p}>{p}</option>)}</select></Field>
      <Field label="Income (₹)"><input style={{ ...inp, width: 110 }} type="number" value={f.income_inr} onChange={(e) => setF({ ...f, income_inr: e.target.value })} /></Field><Field label="Foreign tax (₹)"><input style={{ ...inp, width: 110 }} type="number" value={f.foreign_tax_inr} onChange={(e) => setF({ ...f, foreign_tax_inr: e.target.value })} /></Field><Field label="DTAA article"><input style={{ ...inp, width: 80 }} value={f.dtaa_article} onChange={(e) => setF({ ...f, dtaa_article: e.target.value })} /></Field>
      <button className="btn" disabled={!f.entity_id || !f.income_inr || !!act.busy} onClick={() => act.run("ftc", async () => { await api("/global/foreign-tax-credits", { method: "POST", body: JSON.stringify({ ...f, income_inr: +f.income_inr, foreign_tax_inr: +f.foreign_tax_inr, dtaa_article: f.dtaa_article || null, note: f.note || null }) }); setF(null); return "Credit recorded — file Form 67 before the return"; })}>Add</button></div>}
    <table className="tbl tight" style={{ marginTop: 8 }}><thead><tr><th>Entity</th><th>FY</th><th>Country</th><th>Type</th><th className="num">Income</th><th className="num">Foreign tax</th><th>Form 67</th><th></th></tr></thead><tbody>{(d.data.items ?? []).map((x: any) => <tr key={x.id}><td>{x.entity_name}</td><td>{x.fy}</td><td>{x.country}{x.dtaa_article ? <span className="small mute"> · art. {x.dtaa_article}</span> : ""}</td><td>{x.income_type}</td><td className="num">{inr(x.income_inr)}</td><td className="num">{inr(x.foreign_tax_inr)}</td><td>{x.form67_filed_on ? <Pill tone="teal">filed {fmtDate(x.form67_filed_on)}</Pill> : <Pill tone="amber">pending</Pill>}</td><td className="row gap">{canWrite() && !x.form67_filed_on && <button className="btn btn-s" disabled={!!act.busy} onClick={() => act.run("filed", async () => { await api(`/global/foreign-tax-credits/${x.id}`, { method: "PATCH", body: JSON.stringify({ form67_filed_on: new Date().toISOString().slice(0, 10) }) }); return "Marked filed"; })}>Mark filed</button>}{canWrite() && <button className="btn btn-s" disabled={!!act.busy} onClick={() => act.run("del", async () => { await api(`/global/foreign-tax-credits/${x.id}`, { method: "DELETE" }); return "Removed"; })}>Remove</button>}</td></tr>)}{!(d.data.items ?? []).length && <tr><td colSpan={8} className="mute">No foreign tax credits recorded.</td></tr>}</tbody></table>
    {act.msg}
  </Card>);
}

function Fx({ onChange }: { onChange: () => void }) {
  const fx = useApi<any[]>("/fx-rates"); const act = useAction(() => { fx.refetch(); onChange(); }); const [f, setF] = useState({ ccy: "USD", rate_date: new Date().toISOString().slice(0, 10), rate_inr: "" });
  if (fx.loading || fx.error) return <Status loading={fx.loading} error={fx.error} />;
  return (<Card title="Reference FX rates (INR per unit)" action={isOwner() ? <div className="row gap"><input style={{ ...inp, width: 60 }} value={f.ccy} onChange={(e) => setF({ ...f, ccy: e.target.value.toUpperCase() })} /><input style={inp} type="date" value={f.rate_date} onChange={(e) => setF({ ...f, rate_date: e.target.value })} /><input style={{ ...inp, width: 90 }} type="number" step="0.0001" placeholder="rate" value={f.rate_inr} onChange={(e) => setF({ ...f, rate_inr: e.target.value })} /><button className="btn btn-s" disabled={!f.rate_inr || !!act.busy} onClick={() => act.run("fx", async () => { await api("/fx-rates", { method: "PUT", body: JSON.stringify({ ...f, rate_inr: +f.rate_inr }) }); setF({ ...f, rate_inr: "" }); return "Rate saved (source manual)"; })}>Set rate</button></div> : undefined}>
    <div className="row" style={{ gap: 14, flexWrap: "wrap" }}>{fx.data!.map((r) => <div key={r.ccy}><b>{r.ccy}</b> {Number(r.rate_inr).toFixed(4)}<div className="small mute">{r.rate_date} · {r.source}</div></div>)}</div>
    <div className="small mute" style={{ marginTop: 8 }}>The latest rate on or before a date converts remittances and foreign income; the daily feed (`FX_RATES_URL`) or an owner-entered rate fills gaps.</div>
    {act.msg}
  </Card>);
}

/** Section 112A: 31 Jan 2018 FMV per ISIN (FO-34). Stored on the instrument and every pre-Feb-2018 lot; the next sale of such a lot steps its cost up. */
export function FmvLoader() {
  const [csv, setCsv] = useState("isin,fmv\nINE467B01029,3105.50"); const act = useAction(); const [res, setRes] = useState<any | null>(null);
  if (!canWrite()) return null;
  return (<Card title="31 Jan 2018 fair market values (grandfathering)">
    <div className="small mute" style={{ marginBottom: 6 }}>Paste `isin,fmv` lines (exchange high of 31 Jan 2018 for shares, NAV of that day for funds; split-adjust to the units your lots carry). Sales of equity lots bought before 1 Feb 2018 then take the higher of cost and the lower of FMV × units and the sale price.</div>
    <textarea style={{ ...inp, width: "100%", minHeight: 70, fontFamily: "ui-monospace, monospace", fontSize: 12 }} value={csv} onChange={(e) => setCsv(e.target.value)} />
    <div className="row gap" style={{ marginTop: 6 }}><button className="btn" disabled={!!act.busy || csv.trim().length < 15} onClick={() => act.run("fmv", async () => { const r = await api<any>("/instruments/fmv", { method: "POST", body: JSON.stringify({ csv }) }); setRes(r); return `${r.matched} instrument${r.matched === 1 ? "" : "s"} updated · ${r.lots_updated} pre-2018 lot${r.lots_updated === 1 ? "" : "s"} carry the FMV${r.unknown.length ? ` · unknown ISINs: ${r.unknown.join(", ")}` : ""}`; })}>Load FMVs</button><span className="small mute">sample file: samples/fmv_31jan2018_sample.csv · CLI: fmv:load --file</span></div>
    {res && <div className="small mute" style={{ marginTop: 6 }}>{res.note}</div>}
    {act.msg}
  </Card>);
}

/** Scheme-master exit loads per ISIN: the API already overrides the generic 1%/365-day equity-fund guess that the
 *  rebalancing engine falls back to, but had no screen to feed it real data — this is that screen. */
export function ExitLoadLoader() {
  const [csv, setCsv] = useState("isin,pct,days,note\nINF879O01027,1,365,standard equity exit load"); const act = useAction(); const [res, setRes] = useState<any | null>(null);
  if (!canWrite()) return null;
  return (<Card title="Scheme exit loads">
    <div className="small mute" style={{ marginBottom: 6 }}>Paste `isin,pct,days[,note]` lines — pct=0 explicitly records "no exit load" (e.g. overnight funds) so that fund stops using the generic guess; otherwise the rebalancing engine assumes 1% for 365 days on equity-oriented funds and PMS. Overriding a fund here takes effect on the next rebalance plan — nothing else to re-run.</div>
    <textarea style={{ ...inp, width: "100%", minHeight: 70, fontFamily: "ui-monospace, monospace", fontSize: 12 }} value={csv} onChange={(e) => setCsv(e.target.value)} />
    <div className="row gap" style={{ marginTop: 6 }}><button className="btn" disabled={!!act.busy || csv.trim().length < 10} onClick={() => act.run("exitload", async () => { const r = await api<any>("/instruments/exit-load", { method: "POST", body: JSON.stringify({ csv }) }); setRes(r); return `${r.matched} instrument${r.matched === 1 ? "" : "s"} updated${r.unknown.length ? ` · unknown ISINs: ${r.unknown.join(", ")}` : ""}`; })}>Load exit loads</button></div>
    {res && <div className="small mute" style={{ marginTop: 6 }}>{res.note}</div>}
    {act.msg}
  </Card>);
}
