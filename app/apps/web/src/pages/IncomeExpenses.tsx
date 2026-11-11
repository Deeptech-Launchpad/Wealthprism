import { useState } from "react";
import { Plus } from "lucide-react";
import { useApi } from "../lib/useApi";
import { api, inr } from "../lib/api";
import { Card } from "../components";

// Income and household expenses are entered once, here. The summary card shows the monthly picture, including the items the app
// already knows about (rent, loan EMIs, insurance premiums, property running costs). Each entry can be linked to an asset.
function Field({ label, children }: { label: string; children: React.ReactNode }) { return <label className="field">{label}{children}</label>; }
function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) { return <div className="modal-bg" onClick={onClose}><div className="modal" onClick={(e) => e.stopPropagation()}><h3 style={{ margin: 0 }}>{title}</h3>{children}</div></div>; }

const CATEGORIES = ["housing", "food", "transport", "school", "health", "insurance", "entertainment", "other"];
const FREQ_LABEL: Record<string, string> = { monthly: "per month", yearly: "per year", once: "one-off" };

export function IncomeExpenses() {
  const summary = useApi<any>("/cashflow/summary");
  const inputs = useApi<any>("/tax/inputs");
  const ents = useApi<any[]>("/entities");
  const props = useApi<any[]>("/properties");
  const hold = useApi<any[]>("/holdings");
  const life = useApi<any[]>("/lifestyle-assets");
  const ins = useApi<any[]>("/insurance-policies");
  const sav = useApi<any[]>("/savings-accounts");
  const [inc, setInc] = useState<any | null>(null);
  const [hh, setHh] = useState<any | null>(null);
  const [err, setErr] = useState("");

  // every asset the app knows about, as one list; the value says what kind it is
  const assetOptions: { v: string; t: string }[] = [
    ...(props.data ?? []).map((p: any) => ({ v: `property:${p.id}`, t: `Flat / land · ${p.name}` })),
    ...(hold.data ?? []).map((h: any) => ({ v: `holding:${h.id}`, t: `Investment · ${h.instrument}` })),
    ...(life.data ?? []).map((l: any) => ({ v: `lifestyle_asset:${l.id}`, t: `Physical · ${l.name}` })),
    ...(ins.data ?? []).map((p: any) => ({ v: `insurance_policy:${p.id}`, t: `Insurance · ${p.insurer} (${p.kind})` })),
    ...(sav.data ?? []).map((s: any) => ({ v: `savings_account:${s.id}`, t: `Savings · ${s.institution} (${String(s.scheme).toUpperCase()})` })),
  ];
  const split = (v: string) => { if (!v) return { linked_type: null, linked_id: null }; const [t, id] = v.split(":"); return { linked_type: t, linked_id: id }; };

  const refresh = () => { summary.refetch(); inputs.refetch(); };
  const saveIncome = async () => {
    setErr("");
    try {
      const body: any = { entity_id: inc.entity_id, kind: inc.kind, label: inc.label, frequency: inc.frequency, growth_pct: Number(inc.growth_pct || 0), ...split(inc.asset) };
      if (inc.frequency === "monthly") body.monthly_amount = Number(inc.amount); else body.annual_amount = Number(inc.amount);
      await api("/tax/inputs/income", { method: "POST", body: JSON.stringify(body) }); setInc(null); refresh();
    } catch (e: any) { setErr(e.message); }
  };
  const saveHousehold = async () => {
    setErr("");
    try {
      const body: any = { entity_id: hh.entity_id, category: hh.category, label: hh.label, monthly_amount: Number(hh.amount), frequency: hh.frequency, growth_pct: Number(hh.growth_pct || 0), deduction_code: hh.deduction_code || null, ...split(hh.asset) };
      if (hh.frequency === "once") body.once_on = hh.once_on;
      await api("/tax/inputs/household", { method: "POST", body: JSON.stringify(body) }); setHh(null); refresh();
    } catch (e: any) { setErr(e.message); }
  };
  const removeHousehold = async (id: string) => { try { await api(`/tax/inputs/household/${id}`, { method: "DELETE" }); } finally { refresh(); } };
  const removeIncome = async (id: string) => { try { await api(`/tax/inputs/income/${id}`, { method: "DELETE" }); } finally { refresh(); } };

  const s = summary.data;
  const lines: any[] = s?.lines ?? [];
  const manualIncome = (inputs.data?.income_sources ?? []);
  const manualHousehold = (inputs.data?.household_expenses ?? []);

  return (
    <div>
      <h2 style={{ marginBottom: 4 }}>Income & expenses</h2>
      <div className="small mute" style={{ marginBottom: 12 }}>Enter money coming in and going out once, here. The card below is the monthly picture. It feeds the tax position, the cash projection and the working-capital float.</div>

      <Card title="Monthly summary">
        <div className="grid-2" style={{ gridTemplateColumns: "repeat(3, minmax(0,1fr))" }}>
          <div><div className="small mute">Income per month</div><div className="num" style={{ fontSize: 22 }}>{inr(s?.monthly_income ?? 0)}</div></div>
          <div><div className="small mute">Expenses per month</div><div className="num" style={{ fontSize: 22 }}>{inr(s?.monthly_expenses ?? 0)}</div></div>
          <div><div className="small mute">Left over per month</div><div className="num" style={{ fontSize: 22, color: Number(s?.surplus ?? 0) < 0 ? "#B3261E" : "#0F766E" }}>{inr(s?.surplus ?? 0)}</div></div>
        </div>
        {summary.error && <div className="err" style={{ marginTop: 8 }}>Could not load the summary. Try again.</div>}
      </Card>

      <Card title="By asset" action={<span className="small mute">which flat, investment or policy the money belongs to</span>}>
        {(s?.by_asset ?? []).length ? <table className="tbl"><thead><tr><th>Asset</th><th className="num">Income / month</th><th className="num">Expenses / month</th><th className="num">Left over</th></tr></thead><tbody>
          {(s?.by_asset ?? []).map((a: any) => <tr key={a.asset}><td>{a.asset}</td><td className="num">{inr(a.income)}</td><td className="num">{inr(a.expenses)}</td><td className="num">{inr(a.income - a.expenses)}</td></tr>)}
        </tbody></table> : <div className="small mute">Nothing yet. Add an income or expense below, or add a loan or a flat, and it appears here.</div>}
      </Card>

      <Card title="Every line in the monthly picture">
        {lines.length ? <table className="tbl"><thead><tr><th>Type</th><th>Item</th><th>Where it comes from</th><th>Asset</th><th>How often</th><th className="num">Per month</th></tr></thead><tbody>
          {lines.map((l: any) => <tr key={`${l.source}-${l.id}`}><td>{l.group === "income" ? "Income" : "Expense"}</td><td>{l.label}</td><td className="small mute">{l.auto ? "Automatic" : "You entered it"} · {l.detail}</td><td>{l.asset ?? <span className="mute">—</span>}</td><td className="small">{FREQ_LABEL[l.frequency] ?? l.frequency}</td><td className="num">{inr(l.monthly)}</td></tr>)}
        </tbody></table> : <div className="small mute">No lines yet.</div>}
        {(s?.one_off ?? []).length > 0 && <div className="small mute" style={{ marginTop: 8 }}>One-off payments (not in the monthly figure): {(s.one_off as any[]).map((o) => `${o.label} ${inr(o.amount)} on ${o.on}`).join(" · ")}</div>}
      </Card>

      <Card title="Your entries" action={<div className="row gap"><button className="btn btn-s" onClick={() => setInc({ entity_id: ents.data?.[0]?.id ?? "", kind: "salary", label: "", frequency: "monthly", amount: "", growth_pct: "0", asset: "" })}><Plus size={13} /> Income</button><button className="btn btn-s" onClick={() => setHh({ entity_id: ents.data?.[0]?.id ?? "", category: "food", label: "", frequency: "monthly", amount: "", once_on: "", growth_pct: "6", deduction_code: "", asset: "" })}><Plus size={13} /> Expense</button></div>}>
        {manualIncome.length + manualHousehold.length === 0 && <div className="small mute">No entries yet. Use Income or Expense above.</div>}
        {manualIncome.map((s2: any) => <div key={s2.id} className="attn"><span style={{ flex: 1 }}>Income · {s2.label} <span className="mute small">({s2.kind}, {s2.frequency === "monthly" ? "monthly" : "yearly"}{Number(s2.growth_pct) ? `, +${s2.growth_pct}%/yr` : ""}{s2.linked_type ? ", linked to an asset" : ""})</span></span><span className="num">{inr(Number(s2.annual_amount) / 12)}/mo</span><button className="btn btn-s" onClick={() => removeIncome(s2.id)}>Remove</button></div>)}
        {manualHousehold.map((h: any) => <div key={h.id} className="attn"><span style={{ flex: 1 }}>Expense · {h.label} <span className="mute small">({h.category}, {FREQ_LABEL[h.frequency] ?? h.frequency}{h.frequency === "once" && h.once_on ? ` on ${h.once_on}` : ""}{Number(h.growth_pct) ? `, +${h.growth_pct}%/yr` : ""}{h.deduction_code ? `, deduction ${h.deduction_code}` : ""}{h.linked_type ? ", linked to an asset" : ""})</span></span><span className="num">{inr(h.monthly_amount)}{h.frequency === "monthly" ? "/mo" : h.frequency === "yearly" ? "/yr" : ""}</span><button className="btn btn-s" onClick={() => removeHousehold(h.id)}>Remove</button></div>)}
      </Card>

      {err && <div className="err" style={{ marginTop: 8 }}>{err}</div>}

      {inc && <Modal title="Add income" onClose={() => setInc(null)}>
        <div className="grid-2">
          <Field label="Entity"><select value={inc.entity_id} onChange={(e) => setInc({ ...inc, entity_id: e.target.value })}>{(ents.data ?? []).map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}</select></Field>
          <Field label="Kind"><select value={inc.kind} onChange={(e) => setInc({ ...inc, kind: e.target.value })}>{["salary", "fees", "business", "interest", "dividend", "other"].map((k) => <option key={k}>{k}</option>)}</select></Field>
          <Field label="Label"><input value={inc.label} onChange={(e) => setInc({ ...inc, label: e.target.value })} /></Field>
          <Field label="How often"><select value={inc.frequency} onChange={(e) => setInc({ ...inc, frequency: e.target.value })}><option value="monthly">every month</option><option value="yearly">every year</option></select></Field>
          <Field label={inc.frequency === "monthly" ? "Amount per month (₹)" : "Amount per year (₹)"}><input type="number" value={inc.amount} onChange={(e) => setInc({ ...inc, amount: e.target.value })} /></Field>
          <Field label="Grows each year (%)"><input type="number" value={inc.growth_pct} onChange={(e) => setInc({ ...inc, growth_pct: e.target.value })} /></Field>
          <Field label="Linked to (optional)"><select value={inc.asset} onChange={(e) => setInc({ ...inc, asset: e.target.value })}><option value="">— not linked to an asset</option>{assetOptions.map((o) => <option key={o.v} value={o.v}>{o.t}</option>)}</select></Field>
        </div>
        <div className="row gap" style={{ justifyContent: "flex-end" }}><button className="btn" onClick={() => setInc(null)}>Cancel</button><button className="btn btn-p" disabled={!inc.label || !inc.amount} onClick={saveIncome}>Save</button></div>
      </Modal>}

      {hh && <Modal title="Add expense" onClose={() => setHh(null)}>
        <div className="grid-2">
          <Field label="Entity"><select value={hh.entity_id} onChange={(e) => setHh({ ...hh, entity_id: e.target.value })}>{(ents.data ?? []).map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}</select></Field>
          <Field label="Category"><select value={hh.category} onChange={(e) => setHh({ ...hh, category: e.target.value })}>{CATEGORIES.map((k) => <option key={k}>{k}</option>)}</select></Field>
          <Field label="What (label)"><input value={hh.label} onChange={(e) => setHh({ ...hh, label: e.target.value })} /></Field>
          <Field label="How often"><select value={hh.frequency} onChange={(e) => setHh({ ...hh, frequency: e.target.value })}><option value="monthly">every month</option><option value="yearly">every year</option><option value="once">one-off</option></select></Field>
          <Field label={hh.frequency === "monthly" ? "Amount per month (₹)" : hh.frequency === "yearly" ? "Amount per year (₹)" : "Amount (₹)"}><input type="number" value={hh.amount} onChange={(e) => setHh({ ...hh, amount: e.target.value })} /></Field>
          {hh.frequency === "once" && <Field label="Date paid"><input type="date" value={hh.once_on} onChange={(e) => setHh({ ...hh, once_on: e.target.value })} /></Field>}
          <Field label="Grows each year (%)"><input type="number" value={hh.growth_pct} onChange={(e) => setHh({ ...hh, growth_pct: e.target.value })} /></Field>
          <Field label="Tax deduction code (optional, e.g. 80C)"><input value={hh.deduction_code} onChange={(e) => setHh({ ...hh, deduction_code: e.target.value })} /></Field>
          <Field label="Linked to (optional)"><select value={hh.asset} onChange={(e) => setHh({ ...hh, asset: e.target.value })}><option value="">— not linked to an asset</option>{assetOptions.map((o) => <option key={o.v} value={o.v}>{o.t}</option>)}</select></Field>
        </div>
        <div className="row gap" style={{ justifyContent: "flex-end" }}><button className="btn" onClick={() => setHh(null)}>Cancel</button><button className="btn btn-p" disabled={!hh.label || !hh.amount || (hh.frequency === "once" && !hh.once_on)} onClick={saveHousehold}>Save</button></div>
      </Modal>}
    </div>
  );
}
