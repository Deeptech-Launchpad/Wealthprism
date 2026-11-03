import { useEffect, useState } from "react";
import { useApi } from "../lib/useApi";
import { api, inr } from "../lib/api";
import { Pill, fmtDate } from "../components";

// Edit a holding: its details (name, bucket, the type's own fields such as a maturity date) and each purchase on its own.
// A purchase that has been sold from, or came from a statement import, is shown locked with the reason.
const BUCKETS = ["growth", "income", "liquidity"];

export function EditHolding({ h, onClose, onSaved }: { h: any; onClose: () => void; onSaved: (msg: string) => void }) {
  const { data, error, refetch } = useApi<any>(`/holdings/${h.id}/edit`); const cc = useApi<any>(h.type === "aif" ? `/holdings/${h.id}/capital-calls` : null); const [nc, setNc] = useState<any>({ due: "", amount: "" });
  const [d, setD] = useState<any | null>(null); const [x, setX] = useState<any>({});
  const [lot, setLot] = useState<any | null>(null);
  const [err, setErr] = useState(""); const [msg, setMsg] = useState(""); const [busy, setBusy] = useState(false); const [changed, setChanged] = useState(false);
  useEffect(() => { if (data) { setD((s: any) => s ?? { name: data.name, bucket: data.bucket }); setX((s: any) => Object.keys(s).length ? s : Object.fromEntries((data.fields ?? []).map((f: any) => [f.key, data.values?.[f.key] == null ? "" : f.type === "date" ? String(data.values[f.key]).slice(0, 10) : data.values[f.key]]))); } }, [data]);
  if (error) return <div className="modal-bg" onClick={onClose}><div className="modal" onClick={(e) => e.stopPropagation()}><div className="err">{error}</div><button className="btn" onClick={onClose}>Close</button></div></div>;
  if (!data || !d) return null;
  const unitless = data.unitless;

  const run = async (fn: () => Promise<any>, ok: string) => { setBusy(true); setErr(""); setMsg(""); try { const r = await fn(); setMsg(typeof ok === "string" ? ok : ""); setChanged(true); await refetch(); return r; } catch (e: any) { setErr(e.message); } finally { setBusy(false); } };
  const saveDetails = () => {
    const extras = Object.fromEntries(Object.entries(x).filter(([k, v]) => v !== "" && v != null && String(v) !== String(data.values?.[k] ?? "").slice(0, (data.fields ?? []).find((f: any) => f.key === k)?.type === "date" ? 10 : undefined)).map(([k, v]) => [k, (data.fields ?? []).find((f: any) => f.key === k)?.type === "number" ? Number(v) : v]));
    const body: any = {}; if (d.name.trim() !== data.name) body.name = d.name.trim(); if (d.bucket !== data.bucket) body.bucket = d.bucket; if (Object.keys(extras).length) body.extras = extras;
    if (!Object.keys(body).length) { setMsg("Nothing to change."); return; }
    return run(() => api(`/holdings/${h.id}`, { method: "PATCH", body: JSON.stringify(body) }), "Details saved.");
  };
  const saveLot = async () => {
    const body: any = { buy_date: lot.date, charges: lot.charges === "" ? 0 : Number(lot.charges) };
    if (unitless) body.amount = Number(lot.amount); else { body.quantity = Number(lot.quantity); body.price = Number(lot.price); }
    const r = await run(() => api(`/lots/${lot.id}`, { method: "PATCH", body: JSON.stringify(body) }), "Purchase corrected.");
    if (r) { setLot(null); setMsg(`Purchase corrected. The holding now has ${Number(r.units).toLocaleString("en-IN")} units at an average cost of ${inr(r.avg_cost)}. ${r.note}`); }
  };
  const removeLot = async (l: any) => { if (!confirm(`Remove the purchase of ${fmtDate(l.buy_date)} (${inr(l.amount)})?`)) return; await run(() => api(`/lots/${l.id}`, { method: "DELETE" }), "Purchase removed."); };
  const field = (f: any) => f.type === "select"
    ? <select value={x[f.key] ?? ""} onChange={(e) => setX({ ...x, [f.key]: e.target.value })}><option value="">—</option>{(f.options ?? []).map((o: string) => <option key={o}>{o}</option>)}</select>
    : <input type={f.type === "number" ? "number" : f.type === "date" ? "date" : "text"} step="any" value={x[f.key] ?? ""} onChange={(e) => setX({ ...x, [f.key]: e.target.value })} />;

  return <div className="modal-bg" onClick={() => { if (changed) onSaved(msg || "Saved."); else onClose(); }}><div className="modal" style={{ maxWidth: 720, maxHeight: "90vh", overflow: "auto" }} onClick={(e) => e.stopPropagation()}>
    <h3 style={{ margin: 0 }}>Edit — {data.name}</h3>
    <div className="small mute">{data.type_label}</div>
    {msg && <div className="small" style={{ color: "var(--teal)", margin: "6px 0" }}>{msg}</div>}{err && <div className="err">{err}</div>}

    <h4 style={{ marginBottom: 4 }}>Details</h4>
    <div className="grid-2">
      <label className="field">Name<input value={d.name} disabled={data.name_locked} title={data.name_locked_why ?? ""} onChange={(e) => setD({ ...d, name: e.target.value })} />{data.name_locked && <span className="small mute">{data.name_locked_why}</span>}</label>
      <label className="field">Bucket<select value={d.bucket} onChange={(e) => setD({ ...d, bucket: e.target.value })}>{BUCKETS.map((b) => <option key={b}>{b}</option>)}</select></label>
      {(data.fields ?? []).map((f: any) => <label key={f.key} className="field">{f.label}{f.required ? " *" : ""}{field(f)}</label>)}
    </div>
    <div className="small mute">Name and these fields belong to the security, so they apply wherever it appears.</div>
    <div className="row gap" style={{ justifyContent: "flex-end", marginTop: 6 }}><button className="btn btn-p" disabled={busy || d.name.trim().length < 2} onClick={saveDetails}>Save details</button></div>

    {cc.data?.is_aif && <>
      <h4 style={{ marginBottom: 4 }}>Capital calls</h4>
      <div className="small">{cc.data.commitment ? <>Called {inr(cc.data.called)} of {inr(cc.data.commitment)} ({cc.data.pct}%) · still to pay <b>{inr(cc.data.remaining)}</b></> : "Save the total commitment above to see how much is still to pay."}</div>
      {cc.data.calls.map((c: any) => <div key={c.id} className="row gap small" style={{ alignItems: "center", marginTop: 4 }}>
        <span>{fmtDate(c.due_date)} · {inr(c.amount)}</span>{c.status === "paid" ? <Pill tone="teal">paid {fmtDate(c.paid_on)}</Pill> : <><Pill tone={c.days < 0 ? "red" : "amber"}>{c.days < 0 ? `${-c.days} d late` : `in ${c.days} d`}</Pill><button className="btn btn-s" disabled={busy} onClick={() => run(() => api(`/capital-calls/${c.id}`, { method: "DELETE" }), "Call cancelled.").then(() => cc.refetch())}>Cancel call</button></>}</div>)}
      <div className="grid-2" style={{ marginTop: 6 }}>
        <label className="field">The manager announced a call due on<input type="date" value={nc.due} onChange={(e) => setNc({ ...nc, due: e.target.value })} /></label>
        <label className="field">Amount (₹)<input type="number" step="any" value={nc.amount} onChange={(e) => setNc({ ...nc, amount: e.target.value })} /></label>
      </div>
      <div className="row gap" style={{ justifyContent: "flex-end" }}><button className="btn btn-s" disabled={busy || !nc.due || !(Number(nc.amount) > 0)} onClick={() => run(() => api(`/holdings/${h.id}/capital-calls`, { method: "POST", body: JSON.stringify({ due_date: nc.due, amount: Number(nc.amount) }) }), "Call added. A reminder will appear 10 days before it is due.").then((r) => { if (r) { setNc({ due: "", amount: "" }); cc.refetch(); } })}>Add call reminder</button></div>
    </>}

    <h4 style={{ marginBottom: 4 }}>Purchases</h4>
    <table className="tbl"><thead><tr><th>Bought on</th><th className="num">{unitless ? "Amount" : "Qty"}</th>{!unitless && <th className="num">Price</th>}<th className="num">Charges</th><th></th></tr></thead>
      <tbody>{data.lots.map((l: any) => <tr key={l.id}>
        <td>{fmtDate(l.buy_date)}</td><td className="num">{unitless ? inr(l.amount) : l.quantity.toLocaleString("en-IN")}</td>{!unitless && <td className="num">{inr(l.unit_cost)}</td>}<td className="num">{inr(l.charges)}</td>
        <td>{l.locked ? <span className="small mute" title={l.locked_why}><Pill tone="amber">locked</Pill> {l.locked_why}</span> : <span className="row gap"><button className="btn btn-s" disabled={busy} onClick={() => setLot({ id: l.id, date: l.buy_date, quantity: String(l.quantity), price: String(l.unit_cost), amount: String(l.amount), charges: String(l.charges) })}>Edit</button><button className="btn btn-s" disabled={busy} onClick={() => removeLot(l)}>Remove</button></span>}</td></tr>)}</tbody></table>

    {lot && <div style={{ background: "var(--paper)", borderRadius: 8, padding: 10, marginTop: 8 }}>
      <b>Correct this purchase</b>
      <div className="grid-2">
        <label className="field">Bought on<input type="date" max={new Date().toISOString().slice(0, 10)} value={lot.date} onChange={(e) => setLot({ ...lot, date: e.target.value })} /></label>
        {unitless
          ? <label className="field">Amount (₹)<input type="number" step="any" value={lot.amount} onChange={(e) => setLot({ ...lot, amount: e.target.value })} /></label>
          : <><label className="field">Quantity<input type="number" step="any" value={lot.quantity} onChange={(e) => setLot({ ...lot, quantity: e.target.value })} /></label>
            <label className="field">Price per unit (₹)<input type="number" step="any" value={lot.price} onChange={(e) => setLot({ ...lot, price: e.target.value })} /></label></>}
        <label className="field">Charges (₹)<input type="number" step="any" value={lot.charges} onChange={(e) => setLot({ ...lot, charges: e.target.value })} /></label>
      </div>
      <div className="row gap" style={{ justifyContent: "flex-end" }}><button className="btn" onClick={() => setLot(null)}>Cancel</button><button className="btn btn-p" disabled={busy || !lot.date || !(unitless ? Number(lot.amount) > 0 : Number(lot.quantity) > 0 && Number(lot.price) > 0)} onClick={saveLot}>Save purchase</button></div>
    </div>}
    <div className="small mute" style={{ marginTop: 8 }}>Editing never changes a bank balance. If the money moved, adjust it on the Banking page.</div>
    <div className="row gap" style={{ justifyContent: "flex-end", marginTop: 8 }}><button className="btn" onClick={() => { if (changed) onSaved(msg || "Saved."); else onClose(); }}>Close</button></div>
  </div></div>;
}
