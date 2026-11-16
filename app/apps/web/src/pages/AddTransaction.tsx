import { useEffect, useState } from "react";
import { useApi } from "../lib/useApi";
import { api, inr } from "../lib/api";
import { Pill, fmtDate } from "../components";

// One more entry on a holding that is already there: buy more, sell, income received, a fee. The grey box below the form is a preview from the server;
// nothing is saved until Save is pressed.
const UNITLESS = ["pms", "aif"];
const INCOME: Record<string, string> = { stock: "Dividend received", etf: "Dividend received", reit: "Distribution received", mf: "Dividend received", bond: "Interest received", gsec: "Interest received", tbill: "Interest received", sgb: "Interest received", pms: "Distribution received", aif: "Distribution received" };
const NAMES: Record<string, string> = { buy: "Bought", sell: "Sold", sip: "SIP", dividend: "Dividend", interest: "Interest", distribution: "Distribution", fee: "Fee", redemption: "Redeemed", maturity: "Matured", bonus: "Bonus", split: "Split", capital_call: "Capital call", switch_in: "Switch in", switch_out: "Switch out" };
const today = () => new Date().toISOString().slice(0, 10);

export function choicesFor(type: string): { kind: string; label: string }[] {
  const unitless = UNITLESS.includes(type);
  const out = [{ kind: "buy", label: type === "aif" ? "Capital call" : unitless ? "Add money" : "Buy more" }, { kind: "sell", label: unitless ? "Withdraw" : "Sell" }, { kind: "income", label: INCOME[type] ?? "Income received" }];
  if (unitless) out.push({ kind: "fee", label: "Fee" });
  return out;
}

export function AddTransaction({ h, onClose, onSaved }: { h: any; onClose: () => void; onSaved: (msg: string) => void }) {
  const unitless = UNITLESS.includes(h.type); const choices = choicesFor(h.type);
  const accts = useApi<any[]>("/bank-accounts"); const hist = useApi<any[]>(`/holdings/${h.id}/transactions`); const calls = useApi<any>(h.type === "aif" ? `/holdings/${h.id}/capital-calls` : null);
  const [f, setF] = useState<any>({ kind: "buy", date: today(), quantity: "", price: "", amount: "", charges: "", bank: "" });
  const [callId, setCallId] = useState<string | null>(null); const [pv, setPv] = useState<any | null>(null); const [err, setErr] = useState(""); const [busy, setBusy] = useState(false); const [note, setNote] = useState("");
  const set = (k: string, v: any) => setF((s: any) => ({ ...s, [k]: v }));
  const mine = (accts.data ?? []).filter((a) => a.entity_id === h.entity_id && a.type !== "card");
  const byAmount = unitless || f.kind === "income" || f.kind === "fee";
  const n = (v: any) => (v === "" || v == null ? undefined : Number(v));
  const body = (preview: boolean) => ({ kind: f.kind, date: f.date, quantity: byAmount ? undefined : n(f.quantity), price: byAmount ? undefined : n(f.price), amount: byAmount || f.amount ? n(f.amount) : undefined, charges: n(f.charges), bank_account_id: f.bank || null, preview, capital_call_id: f.kind === "buy" && callId ? callId : undefined });
  const ready = byAmount ? Number(f.amount) > 0 : Number(f.quantity) > 0 && (Number(f.price) > 0 || Number(f.amount) > 0);

  useEffect(() => {
    setPv(null); setErr("");
    if (!ready) return;
    let alive = true;
    const t = setTimeout(async () => { try { const r = await api<any>(`/holdings/${h.id}/txn`, { method: "POST", body: JSON.stringify(body(true)) }); if (alive) setPv(r); } catch (e: any) { if (alive) setErr(e.message); } }, 400);
    return () => { alive = false; clearTimeout(t); };
  }, [f.kind, f.date, f.quantity, f.price, f.amount, f.charges, f.bank, callId]);   // eslint-disable-line react-hooks/exhaustive-deps

  const save = async () => {
    setBusy(true); setErr("");
    try { const r: any = await api(`/holdings/${h.id}/txn`, { method: "POST", body: JSON.stringify(body(false)) }); onSaved(`${choices.find((c) => c.kind === f.kind)?.label}: ${inr(r.amount)} recorded for ${h.instrument}.${r.closes_holding ? " All units are sold, so the holding is closed." : ""}${r.bank_change ? ` Bank balance ${r.bank_change > 0 ? "+" : ""}${inr(r.bank_change)}.` : ""}`); }
    catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };
  const bankLabel = f.kind === "buy" || f.kind === "fee" ? "Paid from" : "Credited to";
  // Removes an earlier entry (manual or from a statement). The server puts the units back, or refuses if a later sale used them.
  const remove = async (t: any) => {
    if (!window.confirm(`Delete this ${NAMES[t.type] ?? t.type} entry of ${t.quantity ? Number(t.quantity).toLocaleString("en-IN") + " units" : inr(t.amount)} on ${fmtDate(t.date)}? The holding will be recalculated.`)) return;
    setBusy(true); setErr(""); setNote("");
    try { await api(`/investment-txns/${t.id}`, { method: "DELETE" }); setNote(`${NAMES[t.type] ?? t.type} entry deleted. Holding recalculated.`); hist.refetch(); }
    catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };

  return <div className="modal-bg" onClick={onClose}><div className="modal" onClick={(e) => e.stopPropagation()}>
    <h3 style={{ margin: 0 }}>Add transaction — {h.instrument}</h3>
    <div className="small mute">You hold {Number(h.quantity).toLocaleString("en-IN")}{unitless ? " units of money invested" : " units"} · worth {inr(h.value)}.</div>
    {calls.data?.is_aif && <div className="small" style={{ background: "var(--paper)", borderRadius: 8, padding: 8, marginTop: 6 }}>
      {calls.data.commitment ? <div>Called {inr(calls.data.called)} of {inr(calls.data.commitment)} ({calls.data.pct}%) · still to pay {inr(calls.data.remaining)}</div> : <div>No commitment saved for this fund. Add it under Edit.</div>}
      {calls.data.calls.filter((c: any) => c.status === "expected").map((c: any) => <div key={c.id} className="row gap" style={{ alignItems: "center" }}>
        <span style={{ color: c.days < 0 ? "var(--red)" : c.days <= 10 ? "var(--amber)" : undefined }}>Call of {inr(c.amount)} due {fmtDate(c.due_date)}{c.days < 0 ? ` (${-c.days} d late)` : ` (in ${c.days} d)`}</span>
        <button className="btn btn-s" onClick={() => { setCallId(c.id); setF((s: any) => ({ ...s, kind: "buy", amount: String(c.amount) })); }}>Pay this call</button></div>)}
    </div>}
    <div className="row gap" style={{ margin: "8px 0", flexWrap: "wrap" }}>{choices.map((c) => <button key={c.kind} className={`btn btn-s ${f.kind === c.kind ? "btn-p" : ""}`} onClick={() => { set("kind", c.kind); }}>{c.label}</button>)}</div>
    <div className="grid-2">
      <label className="field">Date<input type="date" max={today()} value={f.date} onChange={(e) => set("date", e.target.value)} /></label>
      {byAmount
        ? <label className="field">{unitless && (f.kind === "buy" || f.kind === "sell") ? "Amount (₹)" : "Amount (₹)"}<input type="number" step="any" value={f.amount} onChange={(e) => set("amount", e.target.value)} /></label>
        : <>
          <label className="field">Quantity<input type="number" step="any" value={f.quantity} onChange={(e) => set("quantity", e.target.value)} /></label>
          <label className="field">Price per unit (₹)<input type="number" step="any" value={f.price} onChange={(e) => set("price", e.target.value)} /></label>
        </>}
      {!byAmount && <label className="field">Charges (₹, optional)<input type="number" step="any" value={f.charges} onChange={(e) => set("charges", e.target.value)} /></label>}
      <label className="field">{bankLabel} (optional)<select value={f.bank} onChange={(e) => set("bank", e.target.value)}><option value="">— don't change any balance —</option>{mine.map((a: any) => <option key={a.id} value={a.id}>{a.bank} {a.account_masked}</option>)}</select></label>
    </div>
    {unitless && (f.kind === "buy" || f.kind === "sell") && <div className="small mute">This holding has no units: the amount is turned into units at its latest value, so update the value first if the statement says it has changed.</div>}
    {pv && <div className="small" style={{ background: "var(--paper)", borderRadius: 8, padding: 8, marginTop: 8 }}>
      <b>Preview</b> (nothing is saved yet)
      {f.kind === "sell" && <>
        {pv.gains.map((g: any, i: number) => <div key={i}>Sells {g.quantity} from your {fmtDate(g.buy_date)} lot · cost {inr(g.cost)} · sale {inr(g.proceeds)} · <span style={{ color: g.gain >= 0 ? "var(--teal)" : "var(--red)" }}>{g.gain >= 0 ? "gain" : "loss"} {inr(Math.abs(g.gain))}</span> <Pill tone={g.term === "long" ? "teal" : "amber"}>{g.term}-term</Pill></div>)}
        <div>Total: cost {inr(pv.total_cost)} · sale {inr(pv.total_proceeds)} · {pv.total_gain >= 0 ? "gain" : "loss"} <b>{inr(Math.abs(pv.total_gain))}</b>. Units left: {pv.units_after}{pv.closes_holding ? " (the holding will be closed)" : ""}.</div>
      </>}
      {f.kind === "buy" && <div>Adds {pv.quantity} at {inr(pv.price)}. You will hold {pv.units_after}; average cost {inr(pv.avg_cost_after)}.</div>}
      {(f.kind === "income" || f.kind === "fee") && <div>{f.kind === "fee" ? "A fee of" : "Records"} {inr(pv.amount)} as {pv.recorded_as}. Units stay at {pv.units_after}.</div>}
      {pv.bank_change ? <div>Bank balance {pv.bank_change > 0 ? "+" : ""}{inr(pv.bank_change)}.</div> : null}
    </div>}
    {err && <div className="err">{err}</div>}
    {hist.data && hist.data.length > 0 && <div style={{ marginTop: 10 }}>
      <b className="small">Earlier entries</b>
      <div style={{ maxHeight: 170, overflow: "auto" }}><table className="tbl"><thead><tr><th>Date</th><th>Entry</th><th className="num">Qty</th><th className="num">Price</th><th className="num">Amount</th><th></th></tr></thead>
        <tbody>{hist.data.map((t: any) => <tr key={t.id}><td>{fmtDate(t.date)}</td><td>{NAMES[t.type] ?? t.type}{t.source !== "manual" ? <span className="small mute"> · {t.source}</span> : null}</td><td className="num">{t.quantity ? t.quantity.toLocaleString("en-IN") : "—"}</td><td className="num">{t.price ? inr(t.price) : "—"}</td><td className="num">{inr(t.amount)}</td><td><button className="btn btn-s" style={{ color: "var(--red)" }} disabled={busy} onClick={() => remove(t)}>Delete</button></td></tr>)}</tbody></table></div>
      {note && <div className="small" style={{ color: "var(--teal)", marginTop: 4 }}>{note}</div>}
    </div>}
    <div className="row gap" style={{ justifyContent: "flex-end", marginTop: 8 }}><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-p" disabled={busy || !ready} onClick={save}>{busy ? "Saving…" : "Save"}</button></div>
  </div></div>;
}
