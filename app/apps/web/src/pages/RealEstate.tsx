import { useState } from "react";
import { Plus, Send, Check } from "lucide-react";
import { useApi } from "../lib/useApi";
import { api, inr } from "../lib/api";
import { Card, Pill, Status, fmtDate } from "../components";

const TABS = ["Properties", "Rent ledger", "Taxes & GST", "Maintenance"] as const;
const thisMonth = new Date().toISOString().slice(0, 7);
const prevMonth = (() => { const d = new Date(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - 1); return d.toISOString().slice(0, 7); })();
const monthLabel = (m: string) => new Date(m + "-01T00:00:00Z").toLocaleDateString("en-IN", { month: "long", year: "numeric" });

export function RealEstate() {
  const [tab, setTab] = useState<(typeof TABS)[number]>("Properties");
  const [tick, setTick] = useState(0);
  const bump = () => setTick((t) => t + 1);
  return (<>
    <div className="tabs">{TABS.map((t) => <button key={t} className={tab === t ? "on" : ""} onClick={() => setTab(t)}>{t}</button>)}</div>
    {tab === "Properties" && <Properties key={tick} onChange={bump} />}
    {tab === "Rent ledger" && <RentLedger key={tick} onChange={bump} />}
    {tab === "Taxes & GST" && <TaxesGst key={tick} onChange={bump} />}
    {tab === "Maintenance" && <Maintenance key={tick} onChange={bump} />}
  </>);
}

function Field({ label, children }: { label: string; children: React.ReactNode }) { return <label className="field">{label}{children}</label>; }
function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return <div className="modal-bg" onClick={onClose}><div className="modal" onClick={(e) => e.stopPropagation()}><h3 style={{ margin: 0 }}>{title}</h3>{children}</div></div>;
}

function Properties({ onChange }: { onChange: () => void }) {
  const p = useApi<any[]>("/properties"); const ents = useApi<any[]>("/entities"); const tenants = useApi<any[]>("/tenants"); const gstins = useApi<any[]>("/gstins");
  const [form, setForm] = useState<any | null>(null); const [lease, setLease] = useState<any | null>(null); const [open, setOpen] = useState<string | null>(null); const [err, setErr] = useState("");
  const detail = useApi<any>(open ? `/properties/${open}` : null);
  if (!p.data) return <Status loading={p.loading} error={p.error} />;
  const totalValue = p.data.reduce((s, x) => s + Number(x.current_value), 0), rent = p.data.reduce((s, x) => s + Number(x.active_lease?.rent ?? 0), 0), leased = p.data.filter((x) => x.active_lease).length;
  const save = async () => { setErr(""); try { const owners = (form.owners as any[]).filter((o) => o.entity_id); await api(form.id ? `/properties/${form.id}` : "/properties", { method: form.id ? "PATCH" : "POST", body: JSON.stringify({ ...form, owners: owners.length ? owners : undefined, id: undefined }) }); setForm(null); onChange(); } catch (e: any) { setErr(e.message); } };
  const saveLease = async () => { setErr(""); try { await api("/leases", { method: "POST", body: JSON.stringify({ ...lease, rent: Number(lease.rent), deposit: Number(lease.deposit || 0), due_day: Number(lease.due_day), escalation_pct: Number(lease.escalation_pct || 0), escalation_every_months: lease.escalation_every_months ? Number(lease.escalation_every_months) : null, notice_days: Number(lease.notice_days || 90), entity_gstin_id: lease.entity_gstin_id || null, tenant_id: lease.tenant_id }) }); setLease(null); onChange(); } catch (e: any) { setErr(e.message); } };
  const newTenant = async () => { const name = prompt("Tenant name"); if (!name) return; const phone = prompt("Phone (for reminders)") ?? undefined; const gstin = prompt("GSTIN (blank if unregistered)") || undefined; const t = await api<any>("/tenants", { method: "POST", body: JSON.stringify({ name, phone, gstin, type: gstin ? "company" : "individual" }) }); tenants.refetch(); setLease({ ...lease, tenant_id: t.id }); };
  return (<>
    <div className="kpis" style={{ gridTemplateColumns: "repeat(4,1fr)" }}>
      <Card><div className="mute">Portfolio value</div><div className="big-num">{inr(totalValue)}</div></Card>
      <Card><div className="mute">Gross rent / month</div><div className="big-num">{inr(rent)}</div></Card>
      <Card><div className="mute">Blended yield</div><div className="big-num">{totalValue ? ((rent * 12) / totalValue * 100).toFixed(1) : "—"}%</div></Card>
      <Card><div className="mute">Occupancy</div><div className="big-num">{leased} / {p.data.length}</div><div className="small mute">leased units</div></Card>
    </div>
    <Card title="Properties" action={<button className="btn btn-s btn-p" onClick={() => setForm({ type: "residential", name: "", address: {}, owners: [{ entity_id: ents.data?.[0]?.id ?? "", ownership_pct: 100 }] })}><Plus size={13} /> Add property</button>}>
      {p.data.map((x) => <div key={x.id} className="attn" style={{ cursor: "pointer", flexWrap: "wrap" }} onClick={() => setOpen(open === x.id ? null : x.id)}>
        <div style={{ flex: 1, minWidth: 220 }}><b>{x.name}</b><div className="small mute">{x.type} · {x.owners?.map((o: any) => `${o.name} ${Number(o.ownership_pct)}%`).join(", ")}{x.active_lease ? ` · Tenant: ${x.active_lease.tenant} · lease to ${fmtDate(x.active_lease.end_date)}` : " · vacant"}</div></div>
        <div className="num"><div className="mute small">Value</div>{inr(x.current_value)}</div><div className="num"><div className="mute small">Rent</div>{x.active_lease ? inr(x.active_lease.rent) : "—"}</div><div className="num"><div className="mute small">Yield</div>{x.gross_yield_pct ?? "—"}%</div>
        {x.active_lease?.gst_applicable ? <Pill tone="blue">GST 18%</Pill> : <Pill>No GST</Pill>}
        <button className="btn btn-s" onClick={(e) => { e.stopPropagation(); setForm({ ...x, owners: x.owners?.map((o: any) => ({ entity_id: o.entity_id, ownership_pct: Number(o.ownership_pct) })) ?? [] }); }}>Edit</button>
        {!x.active_lease && <button className="btn btn-s" onClick={(e) => { e.stopPropagation(); setLease({ property_id: x.id, tenant_id: tenants.data?.[0]?.id ?? "", start_date: `${thisMonth}-01`, end_date: "", rent: "", due_day: 5, grace_days: 3, escalation_pct: 5, escalation_every_months: 12, deposit: "", gst_applicable: x.type === "commercial", tds_applicable: x.type === "commercial", notice_days: 90, entity_gstin_id: "" }); }}>Add lease</button>}
      </div>)}
      {err && <div className="err">{err}</div>}
    </Card>
    {open && detail.data && (
      <Card title={`${detail.data.name} — FY to date`} action={<button className="btn btn-s" onClick={async () => { const v = prompt("New valuation (₹)"); if (!v) return; await api(`/properties/${open}/valuations`, { method: "POST", body: JSON.stringify({ valued_on: new Date().toISOString().slice(0, 10), value: Number(v), source: "manual" }) }); detail.refetch(); onChange(); }}>Add valuation</button>}>
        <div className="kpis" style={{ gridTemplateColumns: "repeat(5,1fr)" }}>
          <div><div className="mute small">Rent received</div><div className="big-num">{inr(detail.data.pnl_fytd.rent)}</div></div>
          <div><div className="mute small">Property tax</div><div className="big-num">{inr(detail.data.pnl_fytd.property_tax)}</div></div>
          <div><div className="mute small">Expenses</div><div className="big-num">{inr(detail.data.pnl_fytd.expenses)}</div></div>
          <div><div className="mute small">Net</div><div className={`big-num ${Number(detail.data.pnl_fytd.net) >= 0 ? "up" : "down"}`}>{inr(detail.data.pnl_fytd.net)}</div></div>
          <div><div className="mute small">Yield gross / net</div><div className="big-num">{detail.data.gross_yield_pct ?? "—"}% / {detail.data.net_yield_pct ?? "—"}%</div></div>
        </div>
        <div className="grid-2" style={{ marginTop: 12 }}>
          <div><div className="small mute" style={{ marginBottom: 6 }}>Valuations</div>{detail.data.valuations.map((v: any) => <div key={v.id} className="attn"><span style={{ flex: 1 }}>{fmtDate(v.valued_on)} <span className="mute small">· {v.source}</span></span><span className="num">{inr(v.value)}</span></div>)}<div className="small mute" style={{ marginTop: 6 }}>Cost of acquisition incl. stamp duty, registration and capital improvements: {inr(detail.data.cost_of_acquisition)}</div></div>
          <div><div className="small mute" style={{ marginBottom: 6 }}>Leases</div>{detail.data.leases.map((l: any) => <div key={l.id} className="attn"><span style={{ flex: 1 }}>{l.tenant} <span className="mute small">· {fmtDate(l.start_date)} – {fmtDate(l.end_date)}{Number(l.escalation_pct) ? ` · ${Number(l.escalation_pct)}% / ${l.escalation_every_months} m` : ""}</span></span><span className="num">{inr(l.rent)}/mo</span><Pill tone={l.status === "active" ? "teal" : undefined}>{l.status}</Pill>{l.status === "active" && <button className="btn btn-s" onClick={async () => { const r = prompt("New monthly rent (applies from next month)", l.rent); if (!r) return; await api(`/leases/${l.id}`, { method: "PATCH", body: JSON.stringify({ rent: Number(r) }) }); detail.refetch(); onChange(); }}>Revise rent</button>}</div>)}</div>
        </div>
      </Card>
    )}
    {form && <Modal title={form.id ? "Edit property" : "Add property"} onClose={() => setForm(null)}>
      <div className="grid-2">
        <Field label="Name"><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
        <Field label="Type"><select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>{["residential", "commercial", "land", "under_construction"].map((t) => <option key={t}>{t}</option>)}</select></Field>
        <Field label="City"><input value={form.address?.city ?? ""} onChange={(e) => setForm({ ...form, address: { ...form.address, city: e.target.value } })} /></Field>
        <Field label="State"><input value={form.address?.state ?? ""} onChange={(e) => setForm({ ...form, address: { ...form.address, state: e.target.value } })} /></Field>
        <Field label="Acquisition date"><input type="date" value={form.acquisition_date ?? ""} onChange={(e) => setForm({ ...form, acquisition_date: e.target.value || null })} /></Field>
        <Field label="Acquisition cost (₹)"><input type="number" value={form.acquisition_cost ?? ""} onChange={(e) => setForm({ ...form, acquisition_cost: Number(e.target.value) })} /></Field>
        <Field label="Stamp duty (₹)"><input type="number" value={form.stamp_duty ?? ""} onChange={(e) => setForm({ ...form, stamp_duty: Number(e.target.value) })} /></Field>
        <Field label="Registration (₹)"><input type="number" value={form.registration ?? ""} onChange={(e) => setForm({ ...form, registration: Number(e.target.value) })} /></Field>
      </div>
      <div className="field">Owners (must total 100%)
        {(form.owners as any[]).map((o, i) => <div key={i} className="row gap"><select value={o.entity_id} onChange={(e) => { const owners = [...form.owners]; owners[i] = { ...o, entity_id: e.target.value }; setForm({ ...form, owners }); }}><option value="">—</option>{(ents.data ?? []).map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}</select><input type="number" style={{ width: 90 }} value={o.ownership_pct} onChange={(e) => { const owners = [...form.owners]; owners[i] = { ...o, ownership_pct: Number(e.target.value) }; setForm({ ...form, owners }); }} />%</div>)}
        <button className="btn btn-s" style={{ alignSelf: "flex-start" }} onClick={() => setForm({ ...form, owners: [...form.owners, { entity_id: "", ownership_pct: 0 }] })}>+ owner</button>
      </div>
      <label className="small row gap"><input type="checkbox" checked={!!form.self_occupied} onChange={(e) => setForm({ ...form, self_occupied: e.target.checked })} /> Self-occupied (no rent expected)</label>
      {err && <div className="err">{err}</div>}
      <div className="row gap" style={{ justifyContent: "flex-end" }}><button className="btn" onClick={() => setForm(null)}>Cancel</button><button className="btn btn-p" disabled={!form.name} onClick={save}>Save</button></div>
    </Modal>}
    {lease && <Modal title="Add lease" onClose={() => setLease(null)}>
      <div className="small mute">The rent schedule for the whole term is generated on save: GST at the FY rate when applicable, TDS under 194-I when the tenant deducts, escalation compounding at the interval.</div>
      <div className="grid-2">
        <Field label="Tenant"><div className="row gap"><select value={lease.tenant_id} onChange={(e) => setLease({ ...lease, tenant_id: e.target.value })}>{(tenants.data ?? []).map((t) => <option key={t.id} value={t.id}>{t.name}{t.gstin ? ` · ${t.gstin}` : ""}</option>)}</select><button className="btn btn-s" onClick={newTenant}>New</button></div></Field>
        <Field label="Monthly rent (₹)"><input type="number" value={lease.rent} onChange={(e) => setLease({ ...lease, rent: e.target.value })} /></Field>
        <Field label="Start"><input type="date" value={lease.start_date} onChange={(e) => setLease({ ...lease, start_date: e.target.value })} /></Field>
        <Field label="End"><input type="date" value={lease.end_date} onChange={(e) => setLease({ ...lease, end_date: e.target.value })} /></Field>
        <Field label="Due day"><input type="number" min={1} max={28} value={lease.due_day} onChange={(e) => setLease({ ...lease, due_day: e.target.value })} /></Field>
        <Field label="Deposit (₹)"><input type="number" value={lease.deposit} onChange={(e) => setLease({ ...lease, deposit: e.target.value })} /></Field>
        <Field label="Escalation %"><input type="number" value={lease.escalation_pct} onChange={(e) => setLease({ ...lease, escalation_pct: e.target.value })} /></Field>
        <Field label="…every (months)"><input type="number" value={lease.escalation_every_months} onChange={(e) => setLease({ ...lease, escalation_every_months: e.target.value })} /></Field>
        <Field label="Landlord GSTIN (for GST leases)"><select value={lease.entity_gstin_id} onChange={(e) => setLease({ ...lease, entity_gstin_id: e.target.value })}><option value="">—</option>{(gstins.data ?? []).map((g) => <option key={g.id} value={g.id}>{g.entity_name} · {g.gstin}</option>)}</select></Field>
        <Field label="Notice period (days)"><input type="number" value={lease.notice_days} onChange={(e) => setLease({ ...lease, notice_days: e.target.value })} /></Field>
      </div>
      <div className="row gap"><label className="small row gap"><input type="checkbox" checked={lease.gst_applicable} onChange={(e) => setLease({ ...lease, gst_applicable: e.target.checked })} /> GST applicable (commercial, SAC 997212)</label><label className="small row gap"><input type="checkbox" checked={lease.tds_applicable} onChange={(e) => setLease({ ...lease, tds_applicable: e.target.checked })} /> Tenant deducts TDS (194-I)</label></div>
      {err && <div className="err">{err}</div>}
      <div className="row gap" style={{ justifyContent: "flex-end" }}><button className="btn" onClick={() => setLease(null)}>Cancel</button><button className="btn btn-p" disabled={!lease.tenant_id || !lease.rent || !lease.end_date} onClick={saveLease}>Create lease</button></div>
    </Modal>}
  </>);
}

function RentLedger({ onChange }: { onChange: () => void }) {
  const [month, setMonth] = useState(thisMonth);
  const r = useApi<any[]>(`/rent-schedule?month=${month}`); const reminders = useApi<any[]>("/rent-reminders");
  const [err, setErr] = useState(""); const [receipt, setReceipt] = useState<any | null>(null);
  const receive = async (id: string, body: any) => { setErr(""); try { await api(`/rent-schedule/${id}/receive`, { method: "POST", body: JSON.stringify(body) }); setReceipt(null); r.refetch(); onChange(); } catch (e: any) { setErr(e.message); } };
  const remind = async (id: string) => { setErr(""); try { const q = await api<any>(`/rent-schedule/${id}/remind`, { method: "POST", body: JSON.stringify({ channel: "whatsapp" }) }); reminders.refetch(); alert(`Reminder queued to ${q.to}:\n\n${q.message}`); } catch (e: any) { setErr(e.message); } };
  const shift = (n: number) => { const d = new Date(month + "-01T00:00:00Z"); d.setUTCMonth(d.getUTCMonth() + n); setMonth(d.toISOString().slice(0, 7)); };
  const tot = (k: string) => (r.data ?? []).reduce((s, x) => s + Number(x[k]), 0);
  return (<>
    <Card title={`${monthLabel(month)} rent`} action={<div className="row gap"><button className="btn btn-s" onClick={() => shift(-1)}>‹</button><span className="small mute">{month}</span><button className="btn btn-s" onClick={() => shift(1)}>›</button></div>}>
      {!r.data ? "Loading…" : <table className="tbl"><thead><tr><th>Due</th><th>Property</th><th>Tenant</th><th className="num">Rent</th><th className="num">GST</th><th className="num">TDS</th><th className="num">Net due</th><th className="num">Received</th><th>Status</th><th></th></tr></thead>
        <tbody>{r.data.map((x) => <tr key={x.id}><td>{fmtDate(x.due_date)}</td><td>{x.property}</td><td>{x.tenant}</td><td className="num">{inr(x.expected_rent)}</td><td className="num">{Number(x.expected_gst) ? inr(x.expected_gst) : "—"}</td><td className="num">{Number(x.expected_tds) ? inr(x.expected_tds) : "—"}</td><td className="num">{inr(x.net_due)}</td><td className="num">{inr(x.received_amount)}{x.received_on && <div className="small mute">{fmtDate(x.received_on)}</div>}</td>
          <td><Pill tone={x.status === "received" ? "teal" : x.status === "overdue" ? "red" : x.status === "partial" ? "amber" : undefined}>{x.status}{x.status === "overdue" ? ` ${x.overdue_days} d` : ""}</Pill></td>
          <td className="row gap" style={{ justifyContent: "flex-end" }}>{!["received", "waived"].includes(x.status) && <><button className="btn btn-s" title="Record receipt" onClick={() => setReceipt({ id: x.id, amount: (Number(x.net_due) - Number(x.received_amount)).toFixed(2), received_on: new Date().toISOString().slice(0, 10), tenant: x.tenant })}><Check size={12} /> Receive</button>{x.status !== "due" && <button className="btn btn-s" title="Send reminder" onClick={() => remind(x.id)}><Send size={12} /> Remind</button>}</>}</td></tr>)}
          <tr className="total"><td colSpan={3}>Total</td><td className="num">{inr(tot("expected_rent"))}</td><td className="num">{inr(tot("expected_gst"))}</td><td className="num">{inr(tot("expected_tds"))}</td><td className="num">{inr(tot("net_due"))}</td><td className="num">{inr(tot("received_amount"))}</td><td colSpan={2}></td></tr></tbody></table>}
      {err && <div className="err">{err}</div>}
      <div className="small mute" style={{ marginTop: 10 }}>Rent receipts are auto-matched to bank credits by tenant name, amount and date window on every bank import; TDS under 194-I reconciles with Form 26AS. Overdue = due day + grace period.</div>
    </Card>
    {!!reminders.data?.length && <Card title="Reminders sent">{reminders.data.slice(0, 8).map((q) => <div key={q.id} className="attn"><span style={{ flex: 1 }}>{q.tenant} · {q.channel} · {q.to_contact}</span><span className="small mute">{fmtDate(q.queued_at)}</span><Pill tone={q.status === "sent" ? "teal" : "amber"}>{q.status}</Pill></div>)}</Card>}
    {receipt && <Modal title={`Record rent from ${receipt.tenant}`} onClose={() => setReceipt(null)}>
      <div className="grid-2"><Field label="Amount received (₹)"><input type="number" value={receipt.amount} onChange={(e) => setReceipt({ ...receipt, amount: e.target.value })} /></Field><Field label="Received on"><input type="date" value={receipt.received_on} onChange={(e) => setReceipt({ ...receipt, received_on: e.target.value })} /></Field></div>
      <div className="small mute">Amounts short of the net due stay open as partial. To link a bank credit instead, import the statement — matching is automatic.</div>
      <div className="row gap" style={{ justifyContent: "flex-end" }}><button className="btn" onClick={() => receive(receipt.id, { waive: true })}>Waive</button><button className="btn btn-p" onClick={() => receive(receipt.id, { amount: Number(receipt.amount), received_on: receipt.received_on })}>Save receipt</button></div>
    </Modal>}
  </>);
}

function TaxesGst({ onChange }: { onChange: () => void }) {
  const [month, setMonth] = useState(prevMonth);
  const reg = useApi<any[]>(`/gst/register?month=${month}`); const returns = useApi<any[]>("/gst/returns"); const taxes = useApi<any[]>("/property-taxes"); const props = useApi<any[]>("/properties");
  const [err, setErr] = useState(""); const [taxForm, setTaxForm] = useState<any | null>(null);
  const file = async (id: string) => { const arn = prompt("ARN (acknowledgement reference)") ?? undefined; try { await api(`/gst/returns/${id}`, { method: "PATCH", body: JSON.stringify({ filed_on: new Date().toISOString().slice(0, 10), arn }) }); returns.refetch(); reg.refetch(); onChange(); } catch (e: any) { setErr(e.message); } };
  const pay = async (id: string) => { try { await api(`/property-taxes/${id}/pay`, { method: "POST", body: JSON.stringify({ paid_on: new Date().toISOString().slice(0, 10) }) }); taxes.refetch(); onChange(); } catch (e: any) { setErr(e.message); } };
  const addTax = async () => { setErr(""); try { await api("/property-taxes", { method: "POST", body: JSON.stringify({ ...taxForm, amount: Number(taxForm.amount) }) }); setTaxForm(null); taxes.refetch(); } catch (e: any) { setErr(e.message); } };
  const ret = (g: any, form: string) => g.returns?.find((r: any) => r.form === form);
  return (<>
    <div className="grid-2">
      <Card title="GST on rent — per GSTIN" action={<label className="field" style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>Month <input type="month" value={month} onChange={(e) => setMonth(e.target.value)} /></label>}>
        {!reg.data ? "Loading…" : <table className="tbl"><thead><tr><th>GSTIN holder</th><th>SAC</th><th className="num">Taxable</th><th className="num">GST</th><th>GSTR-1</th><th>GSTR-3B</th><th className="num">Turnover FYTD</th></tr></thead>
          <tbody>{reg.data.map((g) => { const r1 = ret(g, "gstr1"), r3 = ret(g, "gstr3b"); const pill = (r: any) => !r ? <Pill>—</Pill> : <Pill tone={r.status === "filed" ? "teal" : r.status === "late" ? "red" : "amber"}>{r.status === "due" ? `Due ${fmtDate(r.due_date)}` : `${r.status === "late" ? "Late" : "Filed"} ${fmtDate(r.filed_on)}`}</Pill>;
            return (<tr key={g.gstin_id}><td>{g.entity}<div className="small mute">{g.gstin}</div></td><td>{g.rows[0]?.sac ?? "997212"}</td><td className="num">{inr(g.taxable_total)}</td><td className="num">{inr(g.gstr3b_liability)}</td><td>{pill(r1)}{r1?.status === "due" && <button className="btn btn-s" style={{ marginLeft: 4 }} onClick={() => file(r1.id)}>Filed</button>}</td><td>{pill(r3)}{r3?.status === "due" && <button className="btn btn-s" style={{ marginLeft: 4 }} onClick={() => file(r3.id)}>Filed</button>}</td><td className="num">{inr(g.turnover_fytd)}<div className="small mute">{g.threshold_pct}% of {inr(g.threshold)}</div></td></tr>); })}</tbody></table>}
        {!!reg.data?.some((g) => g.rows.length) && <details style={{ marginTop: 10 }}><summary className="small mute" style={{ cursor: "pointer" }}>GSTR-1 B2B rows</summary><table className="tbl"><thead><tr><th>Tenant</th><th>GSTIN</th><th>POS</th><th className="num">Taxable</th><th className="num">CGST</th><th className="num">SGST</th><th className="num">IGST</th><th>Type</th></tr></thead><tbody>{reg.data.flatMap((g) => g.rows.map((r: any) => <tr key={r.rent_schedule_id}><td>{r.tenant}<div className="small mute">{r.property}</div></td><td className="small">{r.tenant_gstin ?? "—"}</td><td>{r.place_of_supply}</td><td className="num">{inr(r.taxable_value)}</td><td className="num">{inr(r.cgst)}</td><td className="num">{inr(r.sgst)}</td><td className="num">{inr(r.igst)}</td><td><Pill>{r.invoice_type}</Pill></td></tr>))}</tbody></table></details>}
        <div className="small mute" style={{ marginTop: 10 }}>Residential rent to individuals is exempt; commercial rent at the FY rate under SAC 997212. Same-state tenants split CGST/SGST, other states IGST. Threshold tracking per GSTIN.</div>
      </Card>
      <Card title="Property tax calendar" action={<button className="btn btn-s" onClick={() => setTaxForm({ property_id: props.data?.[0]?.id ?? "", authority: "", assessment_no: "", period: "2026-27 H2", amount: "", due_date: "" })}><Plus size={13} /> Add bill</button>}>
        {(taxes.data ?? []).map((t) => <div key={t.id} className="attn"><div style={{ flex: 1 }}><b>{t.authority} — {t.property}</b><div className="small mute">{t.period}{t.assessment_no ? ` · ${t.assessment_no}` : ""}</div></div><span className="num">{inr(t.amount)}</span><Pill tone={t.status === "paid" ? "teal" : new Date(t.due_date) < new Date() ? "red" : "amber"}>{t.status === "paid" ? `Paid ${fmtDate(t.paid_on)}` : `Due ${fmtDate(t.due_date)}`}</Pill>{t.status !== "paid" && <button className="btn btn-s" onClick={() => pay(t.id)}>Mark paid</button>}</div>)}
        {err && <div className="err">{err}</div>}
      </Card>
    </div>
    {!!returns.data?.length && <Card title="GST filings"><table className="tbl"><thead><tr><th>Period</th><th>Entity</th><th>Form</th><th className="num">Taxable</th><th className="num">Tax</th><th>Due</th><th>Status</th></tr></thead><tbody>{returns.data.slice(0, 12).map((r) => <tr key={r.id}><td>{r.period_month}</td><td>{r.entity_name}<div className="small mute">{r.gstin}</div></td><td>{r.form.toUpperCase().replace("GSTR", "GSTR-")}</td><td className="num">{inr(r.taxable_value)}</td><td className="num">{inr(r.tax_amount)}</td><td>{fmtDate(r.due_date)}</td><td><Pill tone={r.status === "filed" ? "teal" : r.status === "late" ? "red" : "amber"}>{r.status}{r.arn ? ` · ${r.arn}` : ""}</Pill></td></tr>)}</tbody></table></Card>}
    {taxForm && <Modal title="Add property tax bill" onClose={() => setTaxForm(null)}>
      <div className="grid-2">
        <Field label="Property"><select value={taxForm.property_id} onChange={(e) => setTaxForm({ ...taxForm, property_id: e.target.value })}>{(props.data ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></Field>
        <Field label="Authority"><input value={taxForm.authority} onChange={(e) => setTaxForm({ ...taxForm, authority: e.target.value })} /></Field>
        <Field label="Assessment no."><input value={taxForm.assessment_no} onChange={(e) => setTaxForm({ ...taxForm, assessment_no: e.target.value })} /></Field>
        <Field label="Period"><input value={taxForm.period} onChange={(e) => setTaxForm({ ...taxForm, period: e.target.value })} /></Field>
        <Field label="Amount (₹)"><input type="number" value={taxForm.amount} onChange={(e) => setTaxForm({ ...taxForm, amount: e.target.value })} /></Field>
        <Field label="Due date"><input type="date" value={taxForm.due_date} onChange={(e) => setTaxForm({ ...taxForm, due_date: e.target.value })} /></Field>
      </div>
      {err && <div className="err">{err}</div>}
      <div className="row gap" style={{ justifyContent: "flex-end" }}><button className="btn" onClick={() => setTaxForm(null)}>Cancel</button><button className="btn btn-p" disabled={!taxForm.authority || !taxForm.amount || !taxForm.due_date} onClick={addTax}>Save</button></div>
    </Modal>}
  </>);
}

function Maintenance({ onChange }: { onChange: () => void }) {
  const x = useApi<any[]>("/property-expenses"); const props = useApi<any[]>("/properties");
  const [form, setForm] = useState<any | null>(null); const [err, setErr] = useState("");
  const save = async () => { setErr(""); try { await api("/property-expenses", { method: "POST", body: JSON.stringify({ ...form, amount: Number(form.amount) }) }); setForm(null); x.refetch(); onChange(); } catch (e: any) { setErr(e.message); } };
  return (<>
    <Card title="Maintenance & repairs log" action={<button className="btn btn-s btn-p" onClick={() => setForm({ property_id: props.data?.[0]?.id ?? "", expense_date: new Date().toISOString().slice(0, 10), category: "maintenance", vendor: "", amount: "", note: "", capital_improvement: false })}><Plus size={13} /> Log expense</button>}>
      {!x.data ? "Loading…" : <table className="tbl"><thead><tr><th>Date</th><th>Property</th><th>Item</th><th>Vendor</th><th>Category</th><th className="num">Amount</th></tr></thead><tbody>{x.data.map((m) => <tr key={m.id}><td>{fmtDate(m.expense_date)}</td><td>{m.property}</td><td>{m.note ?? "—"}</td><td>{m.vendor ?? "—"}</td><td><Pill tone={m.capital_improvement ? "blue" : undefined}>{m.capital_improvement ? "capital improvement" : m.category}</Pill></td><td className="num">{inr(m.amount)}</td></tr>)}</tbody></table>}
      <div className="small mute" style={{ marginTop: 10 }}>Capital improvements are excluded from the P&L and added to the cost of acquisition for future capital gains.</div>
    </Card>
    {form && <Modal title="Log property expense" onClose={() => setForm(null)}>
      <div className="grid-2">
        <Field label="Property"><select value={form.property_id} onChange={(e) => setForm({ ...form, property_id: e.target.value })}>{(props.data ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></Field>
        <Field label="Date"><input type="date" value={form.expense_date} onChange={(e) => setForm({ ...form, expense_date: e.target.value })} /></Field>
        <Field label="Category"><select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>{["maintenance", "repair", "society", "insurance", "loan_interest", "brokerage", "other"].map((c) => <option key={c}>{c}</option>)}</select></Field>
        <Field label="Vendor"><input value={form.vendor} onChange={(e) => setForm({ ...form, vendor: e.target.value })} /></Field>
        <Field label="Amount (₹)"><input type="number" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} /></Field>
        <Field label="Item / note"><input value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} /></Field>
      </div>
      <label className="small row gap"><input type="checkbox" checked={form.capital_improvement} onChange={(e) => setForm({ ...form, capital_improvement: e.target.checked })} /> Capital improvement (adds to cost of acquisition)</label>
      {err && <div className="err">{err}</div>}
      <div className="row gap" style={{ justifyContent: "flex-end" }}><button className="btn" onClick={() => setForm(null)}>Cancel</button><button className="btn btn-p" disabled={!form.amount} onClick={save}>Save</button></div>
    </Modal>}
  </>);
}
