import { useState } from "react";
import { Upload } from "lucide-react";
import { useApi } from "../lib/useApi";
import { inr } from "../lib/api";
import { Card, Pill, Status, fmtDate } from "../components";
import { api, apiUpload, session, API_URL } from "../lib/api";
import { ImportPanel, ImportJobs, ImportSources, CasRefresh } from "./Imports";
import { Performance } from "./Performance";
import { Harvest, Global, FmvLoader } from "./Global";

const TABS = ["Holdings", "Deposits", "Performance", "Capital gains", "Harvest", "Corporate actions", "Global", "Imports"] as const;
const FYS = ["2026-27", "2025-26", "2024-25"];

export function Investments() {
  const [tab, setTab] = useState<(typeof TABS)[number]>("Holdings");
  const [tick, setTick] = useState(0);
  return (<>
    <div className="tabs">{TABS.map((t) => <button key={t} className={tab === t ? "on" : ""} onClick={() => setTab(t)}>{t}</button>)}</div>
    {tab === "Holdings" && <Holdings key={tick} onImport={() => setTab("Imports")} />}
    {tab === "Deposits" && <Deposits key={tick} />}
    {tab === "Performance" && <Performance />}
    {tab === "Capital gains" && <><CapitalGains key={tick} /><FmvLoader /></>}
    {tab === "Harvest" && <Harvest />}
    {tab === "Global" && <Global />}
    {tab === "Corporate actions" && <CorporateActions onApplied={() => setTick((t) => t + 1)} />}
    {tab === "Imports" && <>
      <Card title="Import a statement" action={<span className="small mute">Holdings, lots, capital gains and bank rows update on import; re-uploads are no-ops</span>}>
        <ImportPanel onDone={() => setTick((t) => t + 1)} />
      </Card>
      <CasRefresh />
      <ImportJobs tick={tick} />
      <ImportSources />
    </>}
  </>);
}

const inp = { background: "#fff", color: "var(--ink)", borderColor: "var(--line)" } as const;
function Field({ label, children }: { label: string; children: React.ReactNode }) { return <label className="field">{label}{children}</label>; }
const EMPTY_DEPOSIT = { entity_id: "", kind: "fd", type_code: "fd_regular", bank: "", account_no: "", bucket: "liquidity", rate_pct: "", start_date: "", maturity_date: "", principal: "", payout_frequency: "at_maturity", installment_amount: "", tenure_months: "", payout_bank_account_id: "", tds_applicable: true };

/** "Add asset" step 1 (roadmap item): fixed & recurring deposits only for now — manual entry, generates its own
 *  expected-receipts schedule on save. Bank-statement matching against those receipts is a later step. */
function Deposits() {
  const { data, error, loading, refetch } = useApi<any[]>("/deposits?status=all");
  const ents = useApi<any[]>("/entities"); const banks = useApi<any[]>("/bank-accounts"); const types = useApi<any[]>("/deposit-types"); const cats = useApi<any[]>("/deposit-exception-categories");
  const [open, setOpen] = useState<string | null>(null); const [add, setAdd] = useState(false); const [err, setErr] = useState("");
  const [f, setF] = useState<any>(EMPTY_DEPOSIT); const [editId, setEditId] = useState<string | null>(null); const [lockedWhy, setLockedWhy] = useState<string | null>(null);
  const [rcv, setRcv] = useState<{ id: string; label: string; amount: string; received_on: string; outflow: boolean; adjust: boolean } | null>(null); const [msg, setMsg] = useState(""); const [showClosed, setShowClosed] = useState(false);
  const [fc, setFc] = useState<any | null>(null);
  const isOwner = (session.get()?.families.find((x) => x.id === session.family())?.role ?? "viewer") === "owner";
  if (loading || error) return <Status loading={loading} error={error} />;
  const receive = async () => {
    if (!rcv) return; setErr(""); setMsg("");
    try { const r: any = await api(`/deposit-receipts/${rcv.id}/receive`, { method: "POST", body: JSON.stringify({ amount: Number(rcv.amount), received_on: rcv.received_on, adjust_balance: rcv.adjust }) }); setRcv(null); setMsg(r.balance_note ?? "Recorded"); refetch(); }
    catch (e: any) { setErr(e.message); }
  };
  const all = data!;
  // matured and early-closed deposits stay on record; an early closure still waiting for its credit is shown regardless
  const isHistory = (d: any) => d.status === "closed" || (d.status === "premature_closed" && d.closure?.credit_status === "received");
  const rows = showClosed ? all : all.filter((d) => !isHistory(d));
  const closedCount = all.filter(isHistory).length;
  const maturing = all.filter((d) => d.status === "active" && d.maturity_receipt_id && d.days_to_maturity <= 30).sort((a, b) => a.days_to_maturity - b.days_to_maturity);
  const save = async () => {
    setErr("");
    try {
      const body: any = { type_code: f.type_code, bank: f.bank, bucket: f.bucket, rate_pct: Number(f.rate_pct), start_date: f.start_date, tds_applicable: f.tds_applicable };
      if (editId) { body.account_no = f.account_no || null; body.payout_bank_account_id = f.payout_bank_account_id || null; } else { body.entity_id = f.entity_id; body.kind = f.kind; body.account_no = f.account_no || undefined; body.payout_bank_account_id = f.payout_bank_account_id || undefined; }
      if (f.kind === "fd") { body.principal = Number(f.principal); body.maturity_date = f.maturity_date; body.payout_frequency = f.payout_frequency; }
      else { body.installment_amount = Number(f.installment_amount); body.tenure_months = Number(f.tenure_months); }
      await api(editId ? `/deposits/${editId}` : "/deposits", { method: editId ? "PATCH" : "POST", body: JSON.stringify(body) });
      setMsg(editId ? "Deposit updated" : ""); setAdd(false); setEditId(null); setLockedWhy(null); setF(EMPTY_DEPOSIT); refetch();
    } catch (e: any) { setErr(e.message); }
  };
  const startEdit = (d: any) => {
    setErr(""); setMsg(""); setEditId(d.id); setLockedWhy(d.locked ? d.locked_reason : null); setAdd(true);
    setF({ entity_id: d.entity_id, kind: d.kind, type_code: d.type_code, bank: d.bank, account_no: d.account_no ?? "", bucket: d.bucket, rate_pct: String(d.rate_pct), start_date: d.start_date, maturity_date: d.maturity_date, principal: d.principal ?? "", payout_frequency: d.payout_frequency, installment_amount: d.installment_amount ?? "", tenure_months: d.tenure_months == null ? "" : String(d.tenure_months), payout_bank_account_id: d.payout_bank_account_id ?? "", tds_applicable: d.tds_applicable });
  };
  const remove = async (d: any) => {
    if (!confirm(`Delete ${d.bank} ${d.kind.toUpperCase()}${d.account_no ? ` ${d.account_no}` : ""}? Its schedule and reminders are removed too.`)) return;
    setErr(""); setMsg("");
    try { await api(`/deposits/${d.id}`, { method: "DELETE" }); if (open === d.id) setOpen(null); setMsg(`Deleted ${d.bank} ${d.kind.toUpperCase()}${d.account_no ? ` ${d.account_no}` : ""}`); refetch(); }
    catch (e: any) { setErr(e.message); }
  };
  const typeList = (types.data ?? []).filter((t) => t.kind === f.kind); const curType = (types.data ?? []).find((t) => t.code === f.type_code);
  const pickKind = (kind: string) => { const t = (types.data ?? []).find((x) => x.code === (kind === "fd" ? "fd_regular" : "rd_regular")); setF({ ...f, kind, type_code: t?.code ?? (kind === "fd" ? "fd_regular" : "rd_regular"), ...(t?.default_payout && kind === "fd" ? { payout_frequency: t.default_payout } : {}), tds_applicable: t ? t.default_tds : f.tds_applicable }); };
  const pickType = (code: string) => { const t = (types.data ?? []).find((x) => x.code === code); setF({ ...f, type_code: code, ...(t?.default_payout && f.kind === "fd" ? { payout_frequency: t.default_payout } : {}), ...(t && !editId ? { tds_applicable: t.default_tds } : {}), ...(t?.min_tenure_months && t.min_tenure_months === t.max_tenure_months ? (f.kind === "rd" ? { tenure_months: String(t.min_tenure_months) } : {}) : {}) }); };
  const todayStr = new Date().toISOString().slice(0, 10);
  const rs = (v: any) => "₹" + Number(v ?? 0).toLocaleString("en-IN", { maximumFractionDigits: 2 });
  const loadEstimate = async (n: any) => {
    try { const r: any = await api(`/deposits/${n.d.id}/foreclosure-estimate?date=${n.closure_date}&penalty=${encodeURIComponent(n.penalty || "0")}`); setFc((cur: any) => cur && cur.d.id === n.d.id ? { ...cur, est: r, estErr: "", amount: cur.amountTouched ? cur.amount : r.estimate.estimatedCredit.toFixed(2) } : cur); }
    catch (e: any) { setFc((cur: any) => cur && cur.d.id === n.d.id ? { ...cur, est: null, estErr: e.message } : cur); }
  };
  const openForeclose = (d: any) => { setErr(""); setMsg(""); const n = { d, cat: "", docs: [] as any[], upBusy: "", upErr: "", agreed: false, closure_date: todayStr, penalty: String(d.default_penalty_pct ?? 1), amount: "", amountTouched: false, tds: "0", bank: d.payout_bank_account_id ?? "", exception: "", est: null, estErr: "" }; setFc(n); loadEstimate(n); api<any[]>(`/deposits/${d.id}/exception-documents`).then((list) => setFc((cur: any) => cur && cur.d.id === d.id ? { ...cur, docs: list } : cur)).catch(() => null); };
  const patchFc = (patch: any) => { const n = { ...fc, ...patch }; setFc(n); if ("closure_date" in patch || "penalty" in patch) loadEstimate(n); };
  const submitForeclose = async () => {
    if (!fc) return; setErr("");
    try {
      const body: any = { closure_date: fc.closure_date, penalty_pct: Number(fc.penalty || 0), amount: Number(fc.amount), tds_deducted: Number(fc.tds || 0), reason: fc.exception.trim(), ...(fc.agreed ? { bank_agreed: true } : {}), ...(fc.cat ? { exception_category: fc.cat } : {}) };
      if (fc.bank) body.payout_bank_account_id = fc.bank;
      const r: any = await api(`/deposits/${fc.d.id}/foreclose`, { method: "POST", body: JSON.stringify(body) });
      setMsg(`${fc.d.bank} ${fc.d.kind.toUpperCase()} closed early. ${r.rows_removed} later payment row${r.rows_removed === 1 ? "" : "s"} removed${r.unpaid_instalments_dropped ? `, ${r.unpaid_instalments_dropped} unpaid instalment(s) dropped` : ""}. Waiting for the bank's credit of ${inr(fc.amount)}: import your bank statement and it is matched, or click Confirm credit when it arrives.`);
      setFc(null); refetch();
    } catch (e: any) { setErr(e.message); }
  };
  const pickCat = (code: string) => { const k = (cats.data ?? []).find((x) => x.code === code); patchFc({ cat: code, ...(k && k.default_penalty_pct != null ? { penalty: String(k.default_penalty_pct) } : {}) }); };
  const refreshProofs = async () => { const list = await api<any[]>(`/deposits/${fc.d.id}/exception-documents`); setFc((cur: any) => cur ? { ...cur, docs: list, upBusy: "" } : cur); };
  const uploadProof = async (docCode: string, file: File) => {
    setFc((cur: any) => ({ ...cur, upBusy: docCode, upErr: "" }));
    try { const fd = new FormData(); fd.append("entity_id", fc.d.entity_id); fd.append("linked_type", "deposit"); fd.append("linked_id", fc.d.id); fd.append("doc_type", `exception:${docCode}`); fd.append("name", file.name); fd.append("file", file); const up: any = await apiUpload("/documents", fd); await refreshProofs(); if (up?.duplicate) setFc((cur: any) => cur ? { ...cur, upErr: "This exact file is already in your Documents vault, so it was not attached again. Choose a different file for this proof (each proof needs its own file)." } : cur); }
    catch (e: any) { setFc((cur: any) => ({ ...cur, upBusy: "", upErr: e.message })); }
  };
  const removeProof = async (id: string) => { try { await api(`/documents/${id}`, { method: "DELETE" }); await refreshProofs(); } catch (e: any) { setFc((cur: any) => ({ ...cur, upErr: e.message })); } };
  const openDoc = async (id: string) => {
    try { const fam = session.family(); const r = await fetch(`${API_URL}/documents/${id}/download`, { headers: { Authorization: `Bearer ${session.get()?.access_token}`, ...(fam ? { "X-Family-Id": fam } : {}) } });
      if (!r.ok) throw new Error(`Could not open the document (HTTP ${r.status})`); window.open(URL.createObjectURL(await r.blob()), "_blank"); }
    catch (e: any) { setErr(e.message); }
  };
  const lockedTerm = !!editId && !!lockedWhy;
  const openRow = open ? rows.find((d) => d.id === open) : null;
  const closeForm = () => { setAdd(false); setEditId(null); setLockedWhy(null); setF(EMPTY_DEPOSIT); setErr(""); };
  return (<>
    {fc && (() => { const d = fc.d, el = fc.est?.eligibility, est = fc.est?.estimate; const blocked = el && !el.allowed;
      const curCat = (cats.data ?? []).find((k) => k.code === fc.cat); const missingProofs: any[] = curCat ? curCat.docs.filter((x: any) => x.required && !fc.docs.some((u: any) => u.doc_code === x.doc_code)) : [];
      const proofsReady = !!curCat && missingProofs.length === 0;
      return <Card title={`Foreclose ${d.bank} ${d.kind.toUpperCase()}${d.account_no ? " " + d.account_no : ""} — close before maturity`}>
        <div className="small mute" style={{ marginBottom: 8 }}>{d.type_label}. The deposit stops earning and its remaining schedule is removed. The money is recorded as expected until the bank's credit appears on an imported statement, or you confirm it.</div>
        {blocked && <div className="small" style={{ marginBottom: 8, padding: 10, border: "1px solid var(--amber)", borderRadius: 6, color: "var(--amber)" }}><b>{el.reason}.</b> {isOwner ? "Continue only if the bank has actually agreed to close it (for example the death of the holder or a court order). This records the closure as a bank exception: your reason is saved, shown on the deposit and kept in the audit log. It does not make the bank close it." : "Only an owner can record this as a bank exception."}</div>}
        {blocked && isOwner && <div style={{ marginTop: 10 }}>
          <div style={{ marginBottom: 6 }}><b>Step 1 of 2 — choose the category and upload the proof</b><div className="small mute">The closure details appear once every required proof is uploaded.</div></div>
          <Field label="Exception category (required)"><select style={inp} value={fc.cat} onChange={(e) => pickCat(e.target.value)}><option value="">Choose the reason category…</option>{(cats.data ?? []).map((k) => <option key={k.code} value={k.code}>{k.label}</option>)}</select></Field>
          {curCat && <div className="small mute" style={{ marginTop: 4 }}>{curCat.description}{curCat.default_penalty_pct === 0 ? " The penalty has been set to 0%; change it if your bank applied one." : ""}</div>}
          {curCat && <div style={{ marginTop: 8, padding: 10, border: "1px solid var(--line)", borderRadius: 6 }}>
            <b className="small">Proof to upload (PDF, JPG or PNG)</b>
            {curCat.docs.map((x: any) => { const up = fc.docs.filter((u: any) => u.doc_code === x.doc_code); return <div key={x.doc_code} className="small" style={{ marginTop: 8 }}>
              <div><b>{x.label}</b> <span style={{ color: x.required ? "var(--red, #b42318)" : "var(--mute, #6b7280)" }}>{x.required ? "· required" : "· optional"}</span>{up.length > 0 && <span style={{ color: "var(--teal)" }}> · ✓ uploaded</span>}</div>
              {up.map((u: any) => <div key={u.id} className="row gap" style={{ marginTop: 2 }}><span>{u.name}</span><button type="button" className="btn btn-s" onClick={() => removeProof(u.id)}>Remove</button></div>)}
              <input type="file" accept=".pdf,.jpg,.jpeg,.png" disabled={!!fc.upBusy} style={{ marginTop: 4 }} onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadProof(x.doc_code, f); e.target.value = ""; }} />
              {fc.upBusy === x.doc_code && <span className="mute"> uploading…</span>}</div>; })}
            {fc.upErr && <div className="err">{fc.upErr}</div>}
            {missingProofs.length > 0 && <div className="small" style={{ marginTop: 8, color: "var(--amber)" }}>Still needed before you can close it: {missingProofs.map((m: any) => m.label).join("; ")}.</div>}
            <div className="small mute" style={{ marginTop: 6 }}>The app stores the files in your Documents vault, linked to this deposit. It checks that the required proofs are attached, not that they are genuine — keep the originals.</div>
          </div>}
        </div>}
        {(!blocked || proofsReady) && <>
          {blocked && <div className="small" style={{ color: "var(--teal)", margin: "10px 0 4px" }}><b>✓ Required proof received. Step 2 of 2 — enter the closure details.</b></div>}
        <div className="grid-3">
          <Field label="Closure date"><input style={inp} type="date" min={d.start_date} max={todayStr} value={fc.closure_date} onChange={(e) => patchFc({ closure_date: e.target.value })} /></Field>
          <Field label="Penalty % off the rate"><input style={inp} type="number" step="0.01" min="0" value={fc.penalty} onChange={(e) => patchFc({ penalty: e.target.value })} onWheel={(e) => (e.target as HTMLInputElement).blur()} /></Field>
          <Field label="Payout bank account"><select style={inp} value={fc.bank} onChange={(e) => patchFc({ bank: e.target.value })}><option value="">—</option>{(banks.data ?? []).map((b) => <option key={b.id} value={b.id}>{b.bank} {b.account_masked}</option>)}</select></Field>
          <Field label="Amount the bank credits (₹)"><input style={inp} type="number" value={fc.amount} onChange={(e) => patchFc({ amount: e.target.value, amountTouched: true })} onWheel={(e) => (e.target as HTMLInputElement).blur()} /></Field>
          <Field label="TDS the bank deducted (₹, optional)"><input style={inp} type="number" value={fc.tds} onChange={(e) => patchFc({ tds: e.target.value })} onWheel={(e) => (e.target as HTMLInputElement).blur()} /></Field>
        </div>
        {est && <div className="small" style={{ marginTop: 10, padding: 10, background: "var(--soft, #f4f6fa)", border: "1px solid var(--line)", borderRadius: 6 }}>
          <b>Estimate</b> (the bank's own figure may differ — it uses its rate card for the period): ran {est.daysRun} days at {est.reducedRatePct}% (rate less penalty) · {d.kind === "fd" ? "principal" : "instalments paid"} {inr(est.principalReturned)} + interest {inr(est.interest)}{Number(est.interestAlreadyPaid) ? ` − interest already paid ${inr(est.interestAlreadyPaid)}` : ""} = <b>{rs(est.estimatedCredit)}</b>
          <div style={{ marginTop: 6 }}><b>Penalty cost ≈ {rs(est.penaltyCost)}</b> — the interest you give up because of the {fc.penalty || 0}% penalty. It is not paid to anyone: the bank simply pays you less interest. The government receives only tax (TDS), if the bank deducts any.</div>
          <div>{Number(fc.amount) === Number(est.estimatedCredit)
            ? <span style={{ color: "var(--teal)" }}>✓ The amount below already uses this estimate. Change it to what your bank actually credits if that differs.</span>
            : <button className="btn btn-s" style={{ marginTop: 6 }} onClick={() => patchFc({ amount: Number(est.estimatedCredit).toFixed(2), amountTouched: true })}>Use the estimate ({inr(est.estimatedCredit)}) as the amount</button>}</div></div>}
        {fc.estErr && <div className="err">{fc.estErr}</div>}
        <Field label={blocked ? "Reason for the bank exception (required — explain in a sentence)" : "Why are you closing this deposit early? (required)"}><textarea style={{ ...inp, width: "100%", minHeight: 56 }} value={fc.exception} onChange={(e) => patchFc({ exception: e.target.value })} placeholder={blocked ? "For example: death of the holder, court order, bank agreed in writing" : "For example: need the money for a purchase, medical expense, found a better rate, rebalancing"} /></Field>
        {blocked && isOwner && <label className="small row gap" style={{ marginTop: 8 }}><input type="checkbox" checked={!!fc.agreed} onChange={(e) => patchFc({ agreed: e.target.checked })} /> <b>The bank has agreed to close this deposit early</b> (this is a bank exception, not a normal early closure)</label>}
        <div className="row gap small" style={{ flexWrap: "wrap", marginTop: 4 }}>{["Need the money", "Medical / emergency", "Better rate elsewhere", "Rebalancing"].map((t) => <button key={t} type="button" className="btn btn-s" onClick={() => patchFc({ exception: fc.exception.trim() ? fc.exception.trim() + "; " + t : t })}>{t}</button>)}</div>
        </>}
        {err && <div className="err">{err}</div>}
        <div className="row gap" style={{ justifyContent: "flex-end", marginTop: 8 }}><button className="btn" onClick={() => { setFc(null); setErr(""); }}>Cancel</button>
          {(!blocked || proofsReady) && <button className="btn btn-p" disabled={!fc.amount || Number(fc.amount) <= 0 || fc.exception.trim().length < (blocked ? 15 : 5) || (blocked && (!isOwner || !fc.agreed || !fc.cat || missingProofs.length > 0))} onClick={() => { if (confirm(`Close ${d.bank} ${d.kind.toUpperCase()} early? This removes its remaining schedule and cannot be undone.`)) submitForeclose(); }}>Foreclose deposit</button>}</div>
      </Card>; })()}
    {add && <Card title={editId ? "Edit deposit" : "Add deposit"}>
      {lockedTerm && <div className="small" style={{ marginBottom: 8, color: "var(--amber)" }}>Amounts, rate and dates are locked because {lockedWhy}. You can still change the bank, account number, bucket, payout account and TDS.</div>}
      <div className="grid-3">
        <Field label="Entity"><select style={inp} disabled={!!editId} value={f.entity_id} onChange={(e) => setF({ ...f, entity_id: e.target.value })}><option value="">—</option>{(ents.data ?? []).map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}</select></Field>
        <Field label="Kind"><select style={inp} disabled={!!editId} value={f.kind} onChange={(e) => pickKind(e.target.value)}><option value="fd">Fixed deposit</option><option value="rd">Recurring deposit</option></select></Field>
        <Field label="Type"><select style={inp} disabled={lockedTerm} value={f.type_code} onChange={(e) => pickType(e.target.value)}>{typeList.map((t) => <option key={t.code} value={t.code}>{t.label}</option>)}</select></Field>
        <Field label="Bank"><input style={inp} value={f.bank} onChange={(e) => setF({ ...f, bank: e.target.value })} /></Field>
        <Field label="Account / certificate no."><input style={inp} value={f.account_no} onChange={(e) => setF({ ...f, account_no: e.target.value })} /></Field>
        <Field label="Rate % p.a."><input style={inp} type="number" step="0.01" disabled={lockedTerm} value={f.rate_pct} onChange={(e) => setF({ ...f, rate_pct: e.target.value })} onWheel={(e) => (e.target as HTMLInputElement).blur()} /></Field>
        <Field label="Start date"><input style={inp} type="date" disabled={lockedTerm} value={f.start_date} onChange={(e) => setF({ ...f, start_date: e.target.value })} /></Field>
        {f.kind === "fd" ? <>
          <Field label="Principal (₹)"><input style={inp} type="number" disabled={lockedTerm} value={f.principal} onChange={(e) => setF({ ...f, principal: e.target.value })} onWheel={(e) => (e.target as HTMLInputElement).blur()} /></Field>
          <Field label="Maturity date"><input style={inp} type="date" disabled={lockedTerm} value={f.maturity_date} onChange={(e) => setF({ ...f, maturity_date: e.target.value })} /></Field>
          <Field label="Payout"><select style={inp} disabled={lockedTerm} value={f.payout_frequency} onChange={(e) => setF({ ...f, payout_frequency: e.target.value })}><option value="monthly">Monthly</option><option value="quarterly">Quarterly</option><option value="at_maturity">Cumulative (at maturity)</option></select></Field>
        </> : <>
          <Field label="Monthly instalment (₹)"><input style={inp} type="number" disabled={lockedTerm} value={f.installment_amount} onChange={(e) => setF({ ...f, installment_amount: e.target.value })} onWheel={(e) => (e.target as HTMLInputElement).blur()} /></Field>
          <Field label="Tenure (months)"><input style={inp} type="number" disabled={lockedTerm} value={f.tenure_months} onChange={(e) => setF({ ...f, tenure_months: e.target.value })} onWheel={(e) => (e.target as HTMLInputElement).blur()} /></Field>
        </>}
        <Field label="Bucket"><select style={inp} value={f.bucket} onChange={(e) => setF({ ...f, bucket: e.target.value })}>{["liquidity", "income", "growth"].map((b) => <option key={b} value={b}>{b}</option>)}</select></Field>
        <Field label="Payout / linked bank account"><select style={inp} value={f.payout_bank_account_id} onChange={(e) => setF({ ...f, payout_bank_account_id: e.target.value })}><option value="">—</option>{(banks.data ?? []).map((b) => <option key={b.id} value={b.id}>{b.bank} {b.account_masked}</option>)}</select></Field>
      </div>
      {curType && <div className="small" style={{ marginTop: 8, color: curType.break_rule === "never" ? "var(--amber)" : "var(--mute, #6b7280)" }}><b>{curType.label}:</b> {curType.description}{curType.break_rule === "never" ? " It cannot be closed before maturity." : curType.break_rule === "after_lock_in" ? ` It can be closed only after ${curType.lock_in_months} months.` : ` Early-closure penalty is usually about ${curType.default_penalty_pct}% off the rate (you can adjust it when closing).`}{curType.min_tenure_months && curType.min_tenure_months === curType.max_tenure_months ? ` Fixed tenure: ${curType.min_tenure_months} months.` : ""}</div>}
      <label className="small row gap" style={{ marginTop: 8 }}><input type="checkbox" checked={f.tds_applicable} onChange={(e) => setF({ ...f, tds_applicable: e.target.checked })} /> TDS applicable</label>
      {editId && !lockedTerm && <div className="small mute" style={{ marginTop: 6 }}>Changing the amount, rate or dates rebuilds the schedule of expected payments from scratch.</div>}
      {err && <div className="err">{err}</div>}
      <div className="row gap" style={{ justifyContent: "flex-end", marginTop: 8 }}><button className="btn" onClick={closeForm}>Cancel</button><button className="btn btn-p" disabled={!f.entity_id || !f.bank || !f.rate_pct || !f.start_date} onClick={save}>{editId ? "Save changes" : "Save"}</button></div>
    </Card>}
    {msg && !add && <div className="small" style={{ color: "var(--teal)", marginBottom: 8 }}>{msg}</div>}
    {err && !add && <div className="err">{err}</div>}
    {maturing.length > 0 && <Card title={`Maturing soon — ${maturing.length} deposit${maturing.length === 1 ? "" : "s"}`}>
      {maturing.map((d) => <div key={d.id} className="row gap" style={{ justifyContent: "space-between", alignItems: "center", padding: "6px 0", borderBottom: "1px solid var(--line)" }}>
        <div><b>{d.bank}</b>{d.account_no ? <span className="mute"> · {d.account_no}</span> : null} <span className="mute">· {d.entity_name}</span><div className="small" style={{ color: d.days_to_maturity < 0 ? "var(--red)" : "var(--amber)" }}>{d.days_to_maturity < 0 ? `Matured ${-d.days_to_maturity} day${d.days_to_maturity === -1 ? "" : "s"} ago, not recorded yet` : d.days_to_maturity === 0 ? "Matures today" : `Matures in ${d.days_to_maturity} day${d.days_to_maturity === 1 ? "" : "s"}`} · {fmtDate(d.maturity_date)} · {rs(d.maturity_value)} due back</div><div className="small mute">Decide: renew, withdraw or reinvest. A task has been raised for it.</div></div>
        <button className="btn btn-s btn-p" onClick={() => { setOpen(d.id); setMsg(""); setRcv({ id: d.maturity_receipt_id, label: "maturity", amount: String(d.maturity_value), received_on: new Date().toISOString().slice(0, 10), outflow: false, adjust: !!d.payout_bank_account_id }); }}>Record maturity</button>
      </div>)}
    </Card>}
    <Card title="Fixed & recurring deposits" action={<div className="row gap">{closedCount > 0 && <label className="small" style={{ display: "flex", alignItems: "center", gap: 4 }}><input type="checkbox" checked={showClosed} onChange={(e) => setShowClosed(e.target.checked)} />Show closed ({closedCount})</label>}<button className="btn btn-s btn-p" onClick={() => { if (add && !editId) closeForm(); else { closeForm(); setAdd(true); } }}>+ Add deposit</button></div>}>
      <table className="tbl"><thead><tr><th>Bank</th><th>Kind</th><th>Entity</th><th className="num">Rate</th><th>Maturity</th><th className="num">Current value</th><th className="num">Maturity value</th><th></th></tr></thead>
        <tbody>{rows.map((d) => <tr key={d.id} onClick={() => setOpen(open === d.id ? null : d.id)} style={{ cursor: "pointer", background: open === d.id ? "var(--paper)" : undefined }}>
          <td><b>{d.bank}</b>{d.account_no ? <div className="small mute">{d.account_no}</div> : null}{d.status === "closed" && <div className="small" style={{ color: "var(--teal)" }}>Matured{d.matured_on ? ` · money received ${fmtDate(d.matured_on)}` : ""} · {rs(d.maturity_value)}</div>}{d.closure && <div className="small" style={{ color: d.closure.credit_status === "received" ? "var(--teal)" : "var(--amber)" }}>Closed early {fmtDate(d.closure.closed_on)} · {d.closure.credit_status === "received" ? (d.closure.verified_by_statement ? "credit verified by bank statement" : "credit confirmed by hand") : d.closure.credit_status === "variance" ? "credit differs from what you recorded" : "waiting for the bank's credit"}{d.closure.exception_reason ? " · bank exception" : ""}</div>}{d.closure?.reason && <div className="small mute">Reason: {d.closure.reason}</div>}{d.closure?.exception_category_label && <div className="small" style={{ color: "var(--amber)" }}>Bank exception · {d.closure.exception_category_label} · {d.closure.documents?.length ?? 0} document{(d.closure.documents?.length ?? 0) === 1 ? "" : "s"} on file</div>}{d.closure?.summary && <div className="small mute">Bank credit {rs(d.closure.summary.credited)}{d.closure.summary.credited_is_confirmed ? "" : " (expected)"} · penalty cost ≈ {rs(d.closure.summary.penalty_cost_estimate)} ({d.closure.summary.penalty_pct}% off the rate)</div>}</td>
          <td><Pill tone={d.kind === "fd" ? "blue" : "teal"}>{d.kind.toUpperCase()}</Pill><div className="small mute">{d.type_label}</div></td>
          <td>{d.entity_name}</td><td className="num">{d.rate_pct}%</td><td>{d.closure ? <span className="mute">was {fmtDate(d.maturity_date)}</span> : d.status === "closed" ? <span className="mute">{fmtDate(d.maturity_date)}</span> : fmtDate(d.maturity_date)}{d.status === "active" && d.maturity_receipt_id && d.days_to_maturity <= 30 && <div className="small" style={{ color: d.days_to_maturity < 0 ? "var(--red)" : "var(--amber)" }}>{d.days_to_maturity < 0 ? "matured — record it" : d.days_to_maturity === 0 ? "matures today" : `in ${d.days_to_maturity} day${d.days_to_maturity === 1 ? "" : "s"}`}</div>}</td>
          <td className="num">{d.closure || d.status === "closed" ? <span className="mute">—</span> : inr(d.current_value)}</td><td className="num">{d.closure ? <span className="mute">—</span> : inr(d.maturity_value)}</td>
          <td><div className="row gap" style={{ justifyContent: "flex-end" }}>
            {d.closure && d.closure.credit_status !== "received" && <button className="btn btn-s btn-p" onClick={(e) => { e.stopPropagation(); setOpen(d.id); setMsg(""); setRcv({ id: d.closure.credit_receipt_id, label: "closure credit", amount: String(d.closure.credit_status === "variance" ? d.closure.received_amount : d.closure.expected_amount), received_on: new Date().toISOString().slice(0, 10), outflow: false, adjust: !!d.payout_bank_account_id }); }}>{d.closure.credit_status === "variance" ? "Confirm amount" : "Confirm credit"}</button>}
            {!d.closure && d.status === "active" && <button className="btn btn-s" title={d.foreclose && !d.foreclose.allowed ? d.foreclose.reason + (isOwner ? " (an owner can close it as a bank exception)" : "") : "Close this deposit before its maturity date"} disabled={!!d.foreclose && !d.foreclose.allowed && !isOwner} onClick={(e) => { e.stopPropagation(); closeForm(); openForeclose(d); }}>Foreclose</button>}
            {d.status !== "closed" && <button className="btn btn-s" onClick={(e) => { e.stopPropagation(); startEdit(d); }}>Edit</button>}
            <button className="btn btn-s" disabled={!!d.closure || d.status === "closed"} title={d.closure || d.status === "closed" ? "A closed deposit stays on record" : d.locked ? `Can't delete: ${d.locked_reason}` : "Delete this deposit"} onClick={(e) => { e.stopPropagation(); remove(d); }}>Delete</button>
          </div></td></tr>)}
          {!rows.length && <tr><td colSpan={8} className="small mute">No deposits yet.</td></tr>}
        </tbody></table>
    </Card>
    {openRow && <Card title={`${openRow.bank} ${openRow.kind.toUpperCase()} — expected receipts`}>
      {rcv && <div className="row gap" style={{ marginBottom: 12, padding: 12, flexWrap: "wrap", alignItems: "flex-end", background: "var(--soft, #f4f6fa)", border: "1px solid var(--line)", borderRadius: 6 }}>
        <b className="small">{rcv.outflow ? "Mark paid" : "Record"} — {rcv.label}:</b>
        <Field label={rcv.outflow ? "Amount paid (₹)" : "Amount received (₹)"}><input style={inp} type="number" value={rcv.amount} onChange={(e) => setRcv({ ...rcv, amount: e.target.value })} /></Field>
        <Field label={rcv.outflow ? "Paid on" : "Received on"}><input style={inp} type="date" value={rcv.received_on} onChange={(e) => setRcv({ ...rcv, received_on: e.target.value })} /></Field>
        <label className="small row gap" title="Skip this if the bank statement you imported already includes this payment"><input type="checkbox" checked={rcv.adjust} disabled={!openRow.payout_bank_account_id} onChange={(e) => setRcv({ ...rcv, adjust: e.target.checked })} /> {openRow.payout_bank_account_id ? `${rcv.outflow ? "Deduct from" : "Add to"} ${openRow.payout_account_name} balance` : "No payout account linked — net worth won't change"}</label>
        <button className="btn" onClick={() => setRcv(null)}>Cancel</button><button className="btn btn-p" onClick={receive}>{rcv.outflow ? "Mark paid" : "Save receipt"}</button>
      </div>}
      {openRow.closure?.summary && (() => { const m = openRow.closure.summary; const c = openRow.closure; return <div style={{ marginBottom: 12, padding: 12, background: "var(--soft, #f4f6fa)", border: "1px solid var(--line)", borderRadius: 6 }}>
        <b>Closed early on {fmtDate(c.closed_on)} — where the money went</b>
        <table className="tbl tight" style={{ marginTop: 6 }}><tbody>
          <tr><td>{openRow.kind === "fd" ? "Principal returned" : "Instalments paid in, returned"}</td><td className="num">{rs(m.principal_returned)}</td></tr>
          <tr><td>Interest at the full contracted rate ({openRow.rate_pct}%) for {m.days_run} days</td><td className="num">≈ {rs(m.interest_at_full_rate)}</td></tr>
          <tr><td>Less: the {m.penalty_pct}% penalty, taken off the rate (the bank keeps this; it is not paid to anyone)</td><td className="num">− {rs(m.penalty_cost_estimate)}</td></tr>
          <tr><td>= Interest at the reduced rate ({Math.max(0, Number(openRow.rate_pct) - Number(m.penalty_pct)).toFixed(2)}%){Number(m.interest_in_credit) !== Number(m.interest_at_reduced_rate) ? " — the credit differs because of interest already paid out, or the bank's own rates" : ""}</td><td className="num">≈ {rs(m.interest_at_reduced_rate)}</td></tr>
          <tr><td>Interest actually in this credit (after recovering any interest already paid out)</td><td className="num">{rs(m.interest_in_credit)}</td></tr>
          <tr><td>Tax (TDS) the bank deducted — this is what goes to the government</td><td className="num">{rs(m.tds_deducted)}</td></tr>
          <tr><td><b>Credited to your bank</b> {c.credit_status === "received" ? (c.verified_by_statement ? "· verified by bank statement" : "· confirmed by hand") : c.credit_status === "variance" ? "· differs from what you recorded" : "· still expected"}</td><td className="num"><b>{rs(m.credited)}</b></td></tr>
          <tr><td>Credit at the full contracted rate would have been</td><td className="num">≈ {rs(m.credit_at_full_rate)}</td></tr>
          <tr><td>You received less than that by</td><td className="num">{rs(m.shortfall_vs_full_rate)}</td></tr>
        </tbody></table>
        {c.reason && <div className="small" style={{ marginTop: 6 }}><b>Reason given:</b> {c.reason}</div>}
        {c.exception_category_label && <div className="small" style={{ marginTop: 6 }}><b>Exception category:</b> {c.exception_category_label}</div>}
        {(c.documents ?? []).length > 0 && <div className="small" style={{ marginTop: 6 }}><b>Proofs on file:</b>{c.documents.map((u: any) => <div key={u.id} className="row gap" style={{ marginTop: 2 }}><span>{u.label ?? u.doc_code} — {u.name}</span><button type="button" className="btn btn-s" onClick={() => openDoc(u.id)}>Open</button></div>)}</div>}
        {c.exception_reason && <div className="small" style={{ marginTop: 4, color: "var(--amber)" }}>Closed as a bank exception (this type normally cannot be closed early).</div>}
        <div className="small mute" style={{ marginTop: 6 }}>The penalty cost is an estimate from the contracted rate. The shortfall is what the bank actually paid you less than the full-rate figure, so it also includes any difference in how the bank counts days or rates.</div>
      </div>; })()}
      {msg && <div className="small" style={{ color: "var(--teal)", marginBottom: 8 }}>{msg}</div>}
      <table className="tbl"><thead><tr><th>Due</th><th>Kind</th><th className="num">Expected</th><th className="num">Received / paid</th><th>Status</th><th></th></tr></thead>
        <tbody>{openRow.receipts.map((r: any) => { const out = r.kind === "contribution"; return <tr key={r.id}><td>{fmtDate(r.due_date)}</td><td>{out ? "instalment" : r.kind === "foreclosure" ? "closure credit" : r.kind}</td><td className="num">{r.kind === "foreclosure" ? rs(r.expected_amount) : inr(r.expected_amount)}</td><td className="num">{Number(r.received_amount) ? <>{r.kind === "foreclosure" ? rs(r.received_amount) : inr(r.received_amount)}{r.received_on && <div className="small mute">{fmtDate(r.received_on)}</div>}</> : "—"}</td>
          <td><Pill tone={r.status === "received" ? "teal" : r.status === "overdue" || r.status === "partial" ? "amber" : undefined}>{r.status === "received" && out ? "paid" : r.status === "variance" ? "differs" : r.status === "cancelled" ? "settled by closure" : r.status}</Pill>{r.status === "received" && <div className="small mute">{r.bank_txn_ref ? "matched from bank statement" : "marked by hand"}</div>}</td>
          <td>{r.status !== "received" && r.status !== "cancelled" && <button className="btn btn-s" onClick={() => { setMsg(""); setRcv({ id: r.id, label: `${out ? "instalment" : r.kind} due ${fmtDate(r.due_date)}`, amount: (Number(r.expected_amount) - Number(r.received_amount)).toFixed(2), received_on: new Date().toISOString().slice(0, 10), outflow: out, adjust: !!openRow.payout_bank_account_id }); }}>{out ? "Mark paid" : r.kind === "foreclosure" ? (r.status === "variance" ? "Confirm amount" : "Confirm credit") : "✓ Receive"}</button>}</td></tr>; })}</tbody></table>
      {err && <div className="err">{err}</div>}
      <div className="small mute" style={{ marginTop: 8 }}>When you import a bank statement, matching payments are marked automatically and their button disappears. Until then, mark them by hand. Interest credited after 10% TDS (e.g. ₹540 of ₹600) counts as received.</div>
    </Card>}
  </>);
}

function Holdings({ onImport }: { onImport: () => void }) {
  const [open, setOpen] = useState<string | null>(null);
  const { data, error, loading } = useApi<any>("/holdings");
  const lots = useApi<any[]>(open ? `/holdings/${open}/lots` : null);
  const openRow = open ? data?.items.find((h: any) => h.id === open) : null;
  const exposure = useApi<any>(openRow ? `/instruments/${openRow.instrument_id}/exposure` : null);
  if (loading || error) return <Status loading={loading} error={error} />;
  return (<>
    <Card title="Holdings across entities" action={<div className="row gap"><span className="small mute">NSE close and AMFI NAV from the nightly feeds; unpriced instruments at cost; XIRR on open lots</span><button className="btn btn-s" onClick={onImport}><Upload size={13} /> Import CAS / contract note</button></div>}>
      <table className="tbl"><thead><tr><th>Asset</th><th>Type</th><th>Entity</th><th>Bucket</th><th className="num">Qty</th><th className="num">Cost</th><th className="num">Value</th><th className="num">Gain</th><th className="num">XIRR</th><th className="num">Priced</th></tr></thead>
        <tbody>{data!.items.map((h: any) => <tr key={h.id} onClick={() => setOpen(open === h.id ? null : h.id)} style={{ cursor: "pointer", background: open === h.id ? "var(--paper)" : undefined }}><td><b>{h.instrument}</b></td><td>{h.type}</td><td>{h.entity_name}</td><td><Pill tone={h.bucket === "growth" ? "blue" : h.bucket === "income" ? "teal" : undefined}>{h.bucket}</Pill></td><td className="num">{Number(h.quantity).toLocaleString("en-IN")}</td><td className="num">{inr(h.cost)}</td><td className="num">{inr(h.value)}</td><td className={`num ${Number(h.unrealised_gain) >= 0 ? "up" : "down"}`}>{h.unrealised_gain_pct}%</td><td className="num">{h.xirr_pct == null ? <span className="mute">—</span> : `${h.xirr_pct}%`}</td><td className="num small mute">{h.price ? fmtDate(h.price_date) : "cost"}</td></tr>)}
          <tr className="total"><td>Total</td><td colSpan={4}></td><td className="num">{inr(data!.totals.cost)}</td><td className="num">{inr(data!.totals.value)}</td><td colSpan={3}></td></tr></tbody></table>
    </Card>
    {open && <Card title="Lots (FIFO order)">{lots.loading ? "Loading…" : <table className="tbl"><thead><tr><th>Buy date</th><th className="num">Qty</th><th className="num">Remaining</th><th className="num">Unit cost</th><th className="num">Charges</th><th>Term now</th></tr></thead><tbody>{(lots.data ?? []).map((l: any) => <tr key={l.id}><td>{fmtDate(l.buy_date)}</td><td className="num">{l.quantity}</td><td className="num">{l.remaining_qty}</td><td className="num">₹{Number(l.unit_cost).toFixed(2)}</td><td className="num">₹{l.charges}</td><td><Pill tone={l.term_now === "long" ? "teal" : "amber"}>{l.term_now}</Pill></td></tr>)}</tbody></table>}</Card>}
    {open && <LookThrough value={Number(openRow?.value ?? 0)} exposure={exposure} />}
  </>);
}

/** What a single holding actually holds underneath — the same split the asset-class lens's "Look-through" column
 *  totals up across every holding, but shown here per instrument so you can see where a class's number comes from. */
function LookThrough({ value, exposure }: { value: number; exposure: { data: any; loading: boolean; error: string | null } }) {
  if (exposure.loading) return <Card title="Look-through composition">Loading…</Card>;
  if (exposure.error || !exposure.data) return null;
  const rows: { alloc_class: string | null; country: string | null; sector: string | null; pct: number }[] = exposure.data.rows;
  const single = exposure.data.source === "own class";
  const srcLabel = exposure.data.source === "factsheet (seeded)" ? "from the fund's factsheet" : exposure.data.source === "manual" ? "entered manually" : single ? "a single security — nothing to open up" : `as of ${fmtDate(exposure.data.as_of)}`;
  return (
    <Card title="Look-through composition" action={<span className="small mute">{srcLabel}</span>}>
      {single ? (
        <div className="small mute">The full value counts as {rows[0].alloc_class?.replace("_", " ")}{rows[0].country && rows[0].country !== "IN" ? ` (${rows[0].country})` : ""} — there's no fund wrapper here to look inside.</div>
      ) : (<>
        <table className="tbl tight"><thead><tr><th>Underlying</th><th className="num">% of this holding</th><th className="num">Value</th></tr></thead>
          <tbody>{rows.map((r, i) => <tr key={i}><td style={{ textTransform: "capitalize" }}>{r.alloc_class?.replace("_", " ") ?? "—"}{r.country && r.country !== "IN" ? ` (${r.country})` : ""}{r.sector ? ` · ${r.sector}` : ""}</td><td className="num">{r.pct}%</td><td className="num">{inr((value * r.pct) / 100)}</td></tr>)}</tbody>
        </table>
        <div className="small mute" style={{ marginTop: 8 }}>Headline counts the full {inr(value)} under one class, by this instrument's own label. Look-through splits it as above — this is what moves money between classes on the Goals page's asset-class lens.</div>
      </>)}
    </Card>
  );
}

function CapitalGains() {
  const [fy, setFy] = useState(FYS[0]);
  const { data, error, loading } = useApi<any>(`/capital-gains?fy=${fy}`);
  if (loading || error) return <Status loading={loading} error={error} />;
  const sum = (k: string) => data!.summary.reduce((s: number, r: any) => s + Number(r[k]), 0);
  return (<>
    <Card title="Capital gains summary (FIFO)" action={<label className="field row gap" style={{ flexDirection: "row", alignItems: "center" }}>FY <select value={fy} onChange={(e) => setFy(e.target.value)}>{FYS.map((f) => <option key={f}>{f}</option>)}</select></label>}>
      {!data!.summary.length ? <div className="small mute">No realised gains in FY {fy}. Import a contract note or CAS with sells / redemptions.</div> : (
        <table className="tbl"><thead><tr><th>Entity</th><th>Asset class</th><th className="num">STCG</th><th className="num">LTCG</th><th className="num">Exemption used</th><th className="num">Taxable</th><th className="num">Est. tax</th></tr></thead>
          <tbody>{data!.summary.map((s: any) => <tr key={s.entity_id + s.asset_class}><td><b>{s.entity_name}</b></td><td><Pill>{s.asset_class.replace("_", " ")}</Pill></td><td className={`num ${Number(s.stcg) < 0 ? "down" : ""}`}>{inr(s.stcg)}</td><td className={`num ${Number(s.ltcg) < 0 ? "down" : ""}`}>{inr(s.ltcg)}</td><td className="num">{inr(s.exemption_used)}</td><td className="num">{inr(s.taxable)}</td><td className="num">{inr(s.est_tax)}</td></tr>)}
            <tr className="total"><td>Total</td><td></td><td className="num">{inr(sum("stcg"))}</td><td className="num">{inr(sum("ltcg"))}</td><td className="num">{inr(sum("exemption_used"))}</td><td className="num">{inr(sum("taxable"))}</td><td className="num">{inr(sum("est_tax"))}</td></tr></tbody></table>
      )}
      <div className="small mute" style={{ marginTop: 10 }}>Rates, holding periods and the LTCG exemption come from the tax_rules table for the FY; the estimate ignores set-off across heads and surcharge.</div>
    </Card>
    {!!data!.lots.length && (
      <Card title="Realised lots">
        <table className="tbl"><thead><tr><th>Entity</th><th>Instrument</th><th>Bought</th><th>Sold</th><th className="num">Qty</th><th className="num">Cost</th><th className="num">Proceeds</th><th className="num">Gain</th><th>Term</th></tr></thead>
          <tbody>{data!.lots.map((l: any, i: number) => <tr key={i}><td>{l.entity_name}</td><td><b>{l.instrument}</b></td><td>{fmtDate(l.buy_date)}</td><td>{fmtDate(l.sell_date)}</td><td className="num">{l.quantity}</td><td className="num">{inr(l.cost)}</td><td className="num">{inr(l.proceeds)}</td><td className={`num ${Number(l.gain) >= 0 ? "up" : "down"}`}>{inr(l.gain)}</td><td><Pill tone={l.term === "long" ? "teal" : "amber"}>{l.term}</Pill></td></tr>)}</tbody></table>
      </Card>
    )}
  </>);
}

function CorporateActions({ onApplied }: { onApplied: () => void }) {
  const { data, error, loading, refetch } = useApi<any[]>("/corporate-actions");
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState("");
  const [form, setForm] = useState<{ id: string; q: string; results: any[]; new_instrument_id?: string; cost_split_pct?: string; ratio_num?: string; ratio_den?: string } | null>(null);
  if (loading || error) return <Status loading={loading} error={error} />;
  const apply = async (id: string, body: Record<string, unknown> = {}) => {
    setBusy(id); setErr("");
    try { await api(`/corporate-actions/${id}/apply`, { method: "POST", body: JSON.stringify(body) }); setForm(null); refetch(); onApplied(); }
    catch (e: any) { setErr(e.message); } finally { setBusy(null); }
  };
  const search = async (q: string) => { setForm((f) => f && { ...f, q }); if (q.length >= 2) setForm((f) => f && { ...f, results: [] }); if (q.length >= 2) { const r = await api<any[]>(`/instruments/search?q=${encodeURIComponent(q)}`); setForm((f) => (f && f.q === q ? { ...f, results: r } : f)); } };
  return (<>
    <Card title="Corporate actions on your holdings" action={<span className="small mute">Bonus, split and dividend apply automatically on the ex-date; demergers, mergers and rights wait for review</span>}>
      {!data!.length && <div className="small mute">No actions on file for instruments you hold. The worker fetches the NSE feed every morning.</div>}
      {!!data!.length && <table className="tbl"><thead><tr><th>Ex-date</th><th>Security</th><th>Action</th><th>Effect</th><th className="num">Held</th><th>Status</th><th></th></tr></thead>
        <tbody>{data!.map((ca) => (<tr key={ca.id}>
          <td>{fmtDate(ca.ex_date)}</td><td><b>{ca.instrument.name}</b><div className="small mute">{ca.instrument.symbol ?? ca.instrument.isin}</div></td>
          <td style={{ textTransform: "capitalize" }}>{ca.type}{ca.ratio ? ` ${ca.ratio}` : ""}{ca.cash_per_unit != null ? ` ₹${ca.cash_per_unit}` : ""}</td>
          <td className="small">{ca.effect}{ca.subject && <div className="mute">{ca.subject}</div>}</td>
          <td className="num">{ca.quantity_held.toLocaleString("en-IN")}</td>
          <td><Pill tone={ca.status === "applied" ? "teal" : ca.status === "review" ? "amber" : "blue"}>{ca.status === "applied" ? (ca.applied_at ? `Applied ${fmtDate(ca.applied_at)}` : "Applied") : ca.status === "review" ? "Review" : "Pending"}</Pill></td>
          <td>{ca.status !== "applied" && (["demerger", "merger"].includes(ca.type)
            ? <button className="btn btn-s" onClick={() => setForm({ id: ca.id, q: "", results: [], cost_split_pct: ca.cost_split_pct ?? "", ratio_num: "1", ratio_den: "1" })}>Review…</button>
            : ["bonus", "split", "dividend"].includes(ca.type) ? <button className="btn btn-s btn-p" disabled={busy === ca.id} onClick={() => apply(ca.id)}>{busy === ca.id ? "Applying…" : "Apply"}</button>
            : <span className="small mute">via import</span>)}</td>
        </tr>))}</tbody></table>}
      {err && <div className="err" style={{ marginTop: 8 }}>{err}</div>}
    </Card>
    {form && (() => { const ca = data!.find((x) => x.id === form.id)!; return (
      <div className="modal-bg" onClick={() => setForm(null)}><div className="modal" onClick={(e) => e.stopPropagation()}>
        <div><h3 style={{ margin: 0 }}>{ca.type === "demerger" ? "Apply demerger" : "Apply merger"} — {ca.instrument.name}</h3><div className="small mute">{ca.type === "demerger" ? "The cost of each lot is split between the parent and the new company in the ratio the company announced; buy dates carry over." : "Lots move to the new company at the swap ratio; total cost and buy dates carry over."}</div></div>
        <label className="field">New company / instrument<input value={form.q} placeholder="Search by name, symbol or ISIN" onChange={(e) => search(e.target.value)} />
          {!!form.results.length && <div style={{ border: "1px solid var(--line)", borderRadius: 6, maxHeight: 160, overflow: "auto" }}>{form.results.map((r) => <div key={r.id} className="attn" style={{ padding: "6px 8px", cursor: "pointer", background: form.new_instrument_id === r.id ? "var(--tealSoft)" : undefined }} onClick={() => setForm({ ...form, new_instrument_id: r.id, q: r.name, results: [] })}><span style={{ flex: 1 }}>{r.name}</span><span className="small mute">{r.symbol ?? r.isin}</span></div>)}</div>}
        </label>
        <div className="grid-2">
          {ca.type === "demerger" && <label className="field">Cost split to new company (%)<input type="number" min={0} max={100} step={0.001} value={form.cost_split_pct} onChange={(e) => setForm({ ...form, cost_split_pct: e.target.value })} /></label>}
          <label className="field">New shares per old (ratio)<div className="row gap"><input type="number" style={{ width: 80 }} value={form.ratio_num} onChange={(e) => setForm({ ...form, ratio_num: e.target.value })} /> : <input type="number" style={{ width: 80 }} value={form.ratio_den} onChange={(e) => setForm({ ...form, ratio_den: e.target.value })} /></div></label>
        </div>
        {err && <div className="err">{err}</div>}
        <div className="row gap" style={{ justifyContent: "flex-end" }}><button className="btn" onClick={() => setForm(null)}>Cancel</button>
          <button className="btn btn-p" disabled={!form.new_instrument_id || (ca.type === "demerger" && !form.cost_split_pct) || busy === form.id} onClick={() => apply(form.id, { new_instrument_id: form.new_instrument_id, ...(ca.type === "demerger" ? { cost_split_pct: Number(form.cost_split_pct) } : {}), ratio_num: Number(form.ratio_num || 1), ratio_den: Number(form.ratio_den || 1) })}>Apply to lots</button></div>
      </div></div>); })()}
  </>);
}
