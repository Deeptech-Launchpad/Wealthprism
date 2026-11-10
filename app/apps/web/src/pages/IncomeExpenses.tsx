import { useState } from "react";
import { Plus } from "lucide-react";
import { useApi } from "../lib/useApi";
import { api, inr } from "../lib/api";
import { Card } from "../components";

// Income and household expenses are entered once, here. They feed the tax position, the cash projection and the working-capital float.
function Field({ label, children }: { label: string; children: React.ReactNode }) { return <label className="field">{label}{children}</label>; }
function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) { return <div className="modal-bg" onClick={onClose}><div className="modal" onClick={(e) => e.stopPropagation()}><h3 style={{ margin: 0 }}>{title}</h3>{children}</div></div>; }

const CATEGORIES = ["housing", "food", "transport", "school", "health", "insurance", "entertainment", "other"];

export function IncomeExpenses() {
  const inputs = useApi<any>("/tax/inputs");
  const ents = useApi<any[]>("/entities");
  const [inc, setInc] = useState<any | null>(null);
  const [hh, setHh] = useState<any | null>(null);
  const [err, setErr] = useState("");
  const refresh = () => { inputs.refetch(); };

  const saveIncome = async () => {
    setErr("");
    try { await api("/tax/inputs/income", { method: "POST", body: JSON.stringify({ ...inc, annual_amount: Number(inc.annual_amount), growth_pct: Number(inc.growth_pct || 0) }) }); setInc(null); refresh(); }
    catch (e: any) { setErr(e.message); }
  };
  const saveHousehold = async () => {
    setErr("");
    try { await api("/tax/inputs/household", { method: "POST", body: JSON.stringify({ entity_id: hh.entity_id, category: hh.category, label: hh.label, monthly_amount: Number(hh.monthly_amount), growth_pct: Number(hh.growth_pct || 0), deduction_code: hh.deduction_code || null }) }); setHh(null); refresh(); }
    catch (e: any) { setErr(e.message); }
  };
  const removeHousehold = async (id: string) => {
    try { await api(`/tax/inputs/household/${id}`, { method: "DELETE" }); } finally { refresh(); }
  };

  const incomes = inputs.data?.income_sources ?? [];
  const households = inputs.data?.household_expenses ?? [];
  const monthlyHousehold = households.reduce((s: number, h: any) => s + Number(h.monthly_amount || 0), 0);
  const yearlyIncome = incomes.reduce((s: number, i: any) => s + Number(i.annual_amount || 0), 0);

  return (
    <div>
      <h2 style={{ marginBottom: 4 }}>Income & expenses</h2>
      <div className="small mute" style={{ marginBottom: 12 }}>Enter money coming in and going out once, here. It is used by the tax position, the cash projection and the working-capital float. Rent, EMIs and property costs stay on Real estate and the Balance sheet.</div>

      <Card title={`Income (${inr(yearlyIncome)} a year)`} action={<button className="btn btn-s" onClick={() => setInc({ entity_id: ents.data?.[0]?.id ?? "", kind: "salary", label: "", annual_amount: "", growth_pct: "0" })}><Plus size={13} /> Income source</button>}>
        {incomes.length ? incomes.map((s: any) => <div key={s.id} className="attn"><span style={{ flex: 1 }}>{s.entity_name} · {s.label} <span className="mute small">({s.kind}{Number(s.growth_pct) ? `, +${s.growth_pct}%/yr` : ""})</span></span><span className="num">{inr(s.annual_amount)}/yr</span></div>) : <div className="small mute">No income yet. Add salary, fees, business income, interest or dividends.</div>}
        <div className="small mute" style={{ marginTop: 8 }}>Used for: gross total income on the tax position. It does not change your bank balance.</div>
      </Card>

      <Card title={`Household expenses (${inr(monthlyHousehold)} a month)`} action={<button className="btn btn-s" onClick={() => setHh({ entity_id: ents.data?.[0]?.id ?? "", category: "food", label: "", monthly_amount: "", growth_pct: "6", deduction_code: "" })}><Plus size={13} /> Household expense</button>}>
        {households.length ? households.map((h: any) => <div key={h.id} className="attn"><span style={{ flex: 1 }}>{h.entity_name} · {h.label} <span className="mute small">({h.category}{Number(h.growth_pct) ? `, +${h.growth_pct}%/yr` : ""}{h.deduction_code ? `, deduction ${h.deduction_code}` : ""})</span></span><span className="num">{inr(h.monthly_amount)}/mo</span><button className="btn btn-s" onClick={() => removeHousehold(h.id)}>Remove</button></div>) : <div className="small mute">No household expenses yet. Add groceries, school fees, travel and other monthly spending.</div>}
        <div className="small mute" style={{ marginTop: 8 }}>Used for: monthly cash out in the projection, and the working-capital float. An expense with a deduction code (for example 80C) also reduces taxable income.</div>
      </Card>

      {err && <div className="err" style={{ marginTop: 8 }}>{err}</div>}

      {inc && <Modal title="Add income source" onClose={() => setInc(null)}>
        <div className="grid-2">
          <Field label="Entity"><select value={inc.entity_id} onChange={(e) => setInc({ ...inc, entity_id: e.target.value })}>{(ents.data ?? []).map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}</select></Field>
          <Field label="Kind"><select value={inc.kind} onChange={(e) => setInc({ ...inc, kind: e.target.value })}>{["salary", "fees", "business", "interest", "dividend", "other"].map((k) => <option key={k}>{k}</option>)}</select></Field>
          <Field label="Label"><input value={inc.label} onChange={(e) => setInc({ ...inc, label: e.target.value })} /></Field>
          <Field label="Annual amount (₹)"><input type="number" value={inc.annual_amount} onChange={(e) => setInc({ ...inc, annual_amount: e.target.value })} /></Field>
          <Field label="Grows each year (%)"><input type="number" value={inc.growth_pct} onChange={(e) => setInc({ ...inc, growth_pct: e.target.value })} /></Field>
        </div>
        <div className="row gap" style={{ justifyContent: "flex-end" }}><button className="btn" onClick={() => setInc(null)}>Cancel</button><button className="btn btn-p" disabled={!inc.label || !inc.annual_amount} onClick={saveIncome}>Save</button></div>
      </Modal>}

      {hh && <Modal title="Add household expense" onClose={() => setHh(null)}>
        <div className="grid-2">
          <Field label="Entity"><select value={hh.entity_id} onChange={(e) => setHh({ ...hh, entity_id: e.target.value })}>{(ents.data ?? []).map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}</select></Field>
          <Field label="Category"><select value={hh.category} onChange={(e) => setHh({ ...hh, category: e.target.value })}>{CATEGORIES.map((k) => <option key={k}>{k}</option>)}</select></Field>
          <Field label="What (label)"><input value={hh.label} onChange={(e) => setHh({ ...hh, label: e.target.value })} /></Field>
          <Field label="Monthly amount (₹)"><input type="number" value={hh.monthly_amount} onChange={(e) => setHh({ ...hh, monthly_amount: e.target.value })} /></Field>
          <Field label="Grows each year (%)"><input type="number" value={hh.growth_pct} onChange={(e) => setHh({ ...hh, growth_pct: e.target.value })} /></Field>
          <Field label="Tax deduction code (optional, e.g. 80C)"><input value={hh.deduction_code} onChange={(e) => setHh({ ...hh, deduction_code: e.target.value })} /></Field>
        </div>
        <div className="row gap" style={{ justifyContent: "flex-end" }}><button className="btn" onClick={() => setHh(null)}>Cancel</button><button className="btn btn-p" disabled={!hh.label || !hh.monthly_amount} onClick={saveHousehold}>Save</button></div>
      </Modal>}
    </div>
  );
}
