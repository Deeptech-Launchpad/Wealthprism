import { useState } from "react";
import { useApi } from "../lib/useApi";
import { api, inr, session } from "../lib/api";
import { Card, Pill, fmtDate } from "../components";

// Interest and maturity payments expected from the bonds, G-Secs, SGBs and T-bills held. A bank-statement import matches the credits by itself;
// until then (or when it cannot) the payment is recorded here by hand, and the bank balance goes up by the amount.
const role = () => session.get()?.families.find((f) => f.id === session.family())?.role ?? "viewer";
const canWrite = () => ["owner", "member", "operator"].includes(role());
const KIND: Record<string, string> = { interest: "Interest", maturity: "Maturity" };

export function BondPayments({ onChange }: { onChange?: () => void }) {
  const [all, setAll] = useState(false); const [tick, setTick] = useState(0);
  const { data, error } = useApi<any[]>(`/holding-receipts?status=${all ? "all" : "open"}`, [tick, all]);
  const accts = useApi<any[]>("/bank-accounts");
  const [rcv, setRcv] = useState<any | null>(null); const [err, setErr] = useState(""); const [msg, setMsg] = useState(""); const [busy, setBusy] = useState(false);
  if (error || !data) return null;
  if (!data.length && !all) return null;
  const open = (r: any) => r.status === "expected" || r.status === "overdue" || r.status === "partial";
  const start = (r: any) => { setErr(""); setMsg(""); const mine = (accts.data ?? []).filter((a) => a.entity_id === r.entity_id && a.type !== "card"); setRcv({ r, amount: String(Math.max(0, Number(r.expected_amount) - Number(r.received_amount))), on: new Date().toISOString().slice(0, 10), account: mine[0]?.id ?? "", mine }); };
  const save = async () => {
    setBusy(true); setErr("");
    try { const r: any = await api(`/holding-receipts/${rcv.r.id}/receive`, { method: "POST", body: JSON.stringify({ amount: Number(rcv.amount), received_on: rcv.on, bank_account_id: rcv.account || null }) }); setMsg(`Recorded ${inr(rcv.amount)}${r.status === "partial" ? " — part of the payment; the rest is still expected" : ""}.${r.balance_note ? " " + r.balance_note + "." : ""}${r.note ? " " + r.note : ""}`); setRcv(null); setTick((t) => t + 1); onChange?.(); }
    catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };
  const overdue = data.filter((r) => r.status === "overdue").length;
  return (<>
    <Card title="Bond interest and maturities" action={<span className="row gap">{overdue > 0 && <Pill tone="red">{overdue} overdue</Pill>}<label className="small" style={{ display: "flex", alignItems: "center", gap: 4 }}><input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} />Show received</label></span>}>
      {msg && <div className="small" style={{ color: "var(--teal)", marginBottom: 6 }}>{msg}</div>}
      <table className="tbl"><thead><tr><th>Due</th><th>Security</th><th>Payment</th><th className="num">Expected</th><th className="num">Received</th><th>Status</th><th></th></tr></thead>
        <tbody>{data.map((r) => <tr key={r.id}>
          <td>{fmtDate(r.due_date)}{open(r) && <div className="small" style={{ color: r.days < 0 ? "var(--red)" : r.days <= 30 ? "var(--amber)" : undefined }}>{r.days < 0 ? `${-r.days} day${r.days === -1 ? "" : "s"} late` : r.days === 0 ? "today" : `in ${r.days} day${r.days === 1 ? "" : "s"}`}</div>}</td>
          <td><b>{r.instrument}</b><div className="small mute">{r.entity_name}</div></td><td>{KIND[r.kind]}{r.instrument_type === "sgb" && r.kind === "maturity" ? <div className="small mute">paid at the gold price on the day</div> : null}</td>
          <td className="num">{inr(r.expected_amount)}</td><td className="num">{Number(r.received_amount) ? inr(r.received_amount) : "—"}{r.received_on && <div className="small mute">{fmtDate(r.received_on)}</div>}</td>
          <td>{r.status === "received" ? <Pill tone="teal">{r.bank_txn_ref ? "verified by bank statement" : "confirmed by hand"}</Pill> : r.status === "overdue" ? <Pill tone="red">overdue</Pill> : r.status === "partial" ? <Pill tone="amber">part received</Pill> : <Pill>expected</Pill>}</td>
          <td>{canWrite() && open(r) && <button className="btn btn-s" onClick={() => start(r)}>Record</button>}</td></tr>)}</tbody></table>
      <div className="small mute" style={{ marginTop: 6 }}>Built from each bond's coupon, how often it is paid, its maturity date and the units you hold. When you import a bank statement, matching credits are marked received automatically. Interest after 10% TDS counts as received.</div>
    </Card>
    {rcv && <div className="modal-bg" onClick={() => setRcv(null)}><div className="modal" onClick={(e) => e.stopPropagation()}>
      <h3 style={{ margin: 0 }}>Record {KIND[rcv.r.kind].toLowerCase()} — {rcv.r.instrument}</h3>
      <div className="small mute">Due {fmtDate(rcv.r.due_date)} · expected {inr(rcv.r.expected_amount)}{rcv.r.instrument_type === "sgb" && rcv.r.kind === "maturity" ? " · an SGB is redeemed at the gold price on the day, so enter what the bank credited" : ""}</div>
      <div className="grid-2">
        <label className="field">Amount credited (₹)<input type="number" step="any" value={rcv.amount} onChange={(e) => setRcv({ ...rcv, amount: e.target.value })} /></label>
        <label className="field">Received on<input type="date" value={rcv.on} onChange={(e) => setRcv({ ...rcv, on: e.target.value })} /></label>
        <label className="field">Credited to<select value={rcv.account} onChange={(e) => setRcv({ ...rcv, account: e.target.value })}><option value="">— don't change any balance —</option>{rcv.mine.map((a: any) => <option key={a.id} value={a.id}>{a.bank} {a.account_masked}</option>)}</select></label>
      </div>
      {rcv.r.kind === "maturity" && <div className="small mute">Recording the full maturity redeems the units and closes this holding; the gain or loss is worked out for tax.</div>}
      {err && <div className="err">{err}</div>}
      <div className="row gap" style={{ justifyContent: "flex-end", marginTop: 8 }}><button className="btn" onClick={() => setRcv(null)}>Cancel</button><button className="btn btn-p" disabled={busy || !(Number(rcv.amount) > 0)} onClick={save}>{busy ? "Saving…" : "Save"}</button></div>
    </div></div>}
  </>);
}
