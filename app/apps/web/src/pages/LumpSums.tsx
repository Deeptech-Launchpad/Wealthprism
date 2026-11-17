import { useState } from "react";
import { useApi } from "../lib/useApi";
import { api, inr, session } from "../lib/api";
import { Card, Pill, fmtDate } from "../components";

// One-time sums of money (bonus, gift, sale, inheritance, refund). They are NOT income and are not taxed: they change the
// bank balance once, so net worth rises once. When the bank statement arrives with the same credit, the entry is verified.
const role = () => session.get()?.families.find((f) => f.id === session.family())?.role ?? "viewer";
const canWrite = () => ["owner", "member", "operator"].includes(role());
const REASONS: Record<string, string> = { bonus: "Bonus", gift: "Gift", sale: "Sale proceeds", inheritance: "Inheritance", refund: "Refund", other: "Other" };
const today = () => new Date().toISOString().slice(0, 10);
const inp = { background: "#fff", color: "var(--ink)", borderColor: "var(--line)" } as const;

export function LumpSums() {
  const list = useApi<any[]>("/lump-sums");
  const accounts = useApi<any[]>("/bank-accounts");
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ bank_account_id: "", entry_date: today(), amount: "", reason: "bonus", note: "" });
  const [err, setErr] = useState(""); const [busy, setBusy] = useState(false);
  const set = (k: string, v: string) => setF((s) => ({ ...s, [k]: v }));

  const save = async () => {
    setBusy(true); setErr("");
    try {
      await api("/lump-sums", { method: "POST", body: JSON.stringify({ bank_account_id: f.bank_account_id, entry_date: f.entry_date, amount: Number(f.amount), reason: f.reason, note: f.note || undefined }) });
      setOpen(false); setF({ bank_account_id: "", entry_date: today(), amount: "", reason: "bonus", note: "" }); list.refetch();
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };
  const remove = async (r: any) => {
    const warn = r.status === "pending" ? " The bank balance will go back down by the same amount." : "";
    if (!confirm(`Delete this lump sum of ${inr(r.amount)} on ${fmtDate(r.entry_date)}?${warn}`)) return;
    try { await api(`/lump-sums/${r.id}`, { method: "DELETE" }); list.refetch(); } catch (e: any) { setErr(e.message); }
  };

  const rows = list.data ?? [];
  return (
    <Card title="Lump sums (one-time money)" action={<span className="row gap">
      <span className="small mute">not income · raises net worth once · verified when the bank statement arrives</span>
      {canWrite() && <button className="btn btn-s btn-p" onClick={() => setOpen(true)}>+ Add lump sum</button>}</span>}>
      {err && <div className="err" style={{ marginBottom: 8 }}>{err}</div>}
      {rows.length === 0 ? <div className="small mute">No lump sums entered.</div> : (
        <table className="tbl"><thead><tr><th>Date</th><th>Account</th><th>Reason</th><th className="num">Amount</th><th>Status</th><th></th></tr></thead>
          <tbody>{rows.map((r: any) => <tr key={r.id}>
            <td>{fmtDate(r.entry_date)}</td>
            <td>{r.bank} {r.account_masked}{r.note ? <div className="small mute">{r.note}</div> : null}</td>
            <td>{REASONS[r.reason] ?? r.reason}</td>
            <td className="num">{inr(r.amount)}</td>
            <td>{r.status === "verified" ? <Pill tone="teal">verified by bank statement{r.verified_on ? ` · ${fmtDate(r.verified_on)}` : ""}</Pill> : <Pill tone="amber">pending · not yet in a bank statement</Pill>}</td>
            <td>{canWrite() && <button className="btn btn-s" onClick={() => remove(r)}>Delete</button>}</td>
          </tr>)}</tbody></table>
      )}
      {open && <div className="modal-bg" onClick={() => setOpen(false)}><div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3 style={{ margin: 0 }}>Add a lump sum</h3>
        <div className="small mute">Money that arrived once, into a bank account. It raises the bank balance, and so net worth, once. It is not income and is not taxed here.</div>
        <div className="grid-2" style={{ marginTop: 10 }}>
          <label className="field">Bank account<select style={inp} value={f.bank_account_id} onChange={(e) => set("bank_account_id", e.target.value)}><option value="">—</option>{(accounts.data ?? []).map((a: any) => <option key={a.id} value={a.id}>{a.bank} {a.account_masked}</option>)}</select></label>
          <label className="field">Date received<input style={inp} type="date" max={today()} value={f.entry_date} onChange={(e) => set("entry_date", e.target.value)} /></label>
          <label className="field">Amount (₹)<input style={inp} type="number" min="1" step="any" value={f.amount} onChange={(e) => set("amount", e.target.value)} /></label>
          <label className="field">Reason<select style={inp} value={f.reason} onChange={(e) => set("reason", e.target.value)}>{Object.entries(REASONS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
          <label className="field" style={{ gridColumn: "1 / -1" }}>Note (optional)<input style={inp} value={f.note} onChange={(e) => set("note", e.target.value)} placeholder="e.g. annual bonus, paid by employer" /></label>
        </div>
        {err && <div className="err">{err}</div>}
        <div className="row gap" style={{ justifyContent: "flex-end", marginTop: 10 }}>
          <button className="btn" onClick={() => setOpen(false)}>Cancel</button>
          <button className="btn btn-p" disabled={busy || !f.bank_account_id || !(Number(f.amount) > 0)} onClick={save}>{busy ? "Saving…" : "Save"}</button>
        </div>
      </div></div>}
    </Card>
  );
}
