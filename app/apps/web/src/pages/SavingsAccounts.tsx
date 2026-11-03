import { useEffect, useState } from "react";
import { useApi } from "../lib/useApi";
import { api, inr, session } from "../lib/api";
import { Card, Pill, Status, fmtDate } from "../components";

// PPF, Sukanya Samriddhi and EPF accounts: money goes in through the year (EPF: from the salary, every month, added by the app), the interest is added once a year on 31 March by the scheme's own rule.
// The interest is worked out for you and stays an estimate until the passbook figure is entered. The balance feeds net worth.
const role = () => session.get()?.families.find((f) => f.id === session.family())?.role ?? "viewer";
const canWrite = () => ["owner", "member", "operator"].includes(role());
const isOwner = () => role() === "owner";
const today = () => new Date().toISOString().slice(0, 10);
const inp = { background: "#fff", color: "var(--ink)", borderColor: "var(--line)" } as const;
const maturityFor = (scheme: string, opened: string) => {
  if (!opened || scheme === "epf") return null; const [y, m, d] = opened.split("-").map(Number);
  if (scheme === "ppf") return `${(m >= 4 ? y : y - 1) + 16}-03-31`;
  const last = new Date(Date.UTC(y + 21, m, 0)).getUTCDate(); return `${y + 21}-${String(m).padStart(2, "0")}-${String(Math.min(d, last)).padStart(2, "0")}`;
};
const EMPTY = { entity_id: "", scheme: "ppf", institution: "", account_no: "", holder_name: "", holder_dob: "", opened_on: "", rate_pct: "", opening_balance: "", tracked_from: "", bucket: "income", employee_monthly: "", employer_monthly: "" };

export function SavingsAccounts({ startScheme, onStarted }: { startScheme?: string | null; onStarted?: () => void }) {
  const [tick, setTick] = useState(0);
  const { data, error, loading } = useApi<any[]>("/savings-accounts", [tick]);
  const schemes = useApi<any[]>("/savings-schemes"); const ents = useApi<any[]>("/entities"); const banks = useApi<any[]>("/bank-accounts");
  const [open, setOpen] = useState<string | null>(null); const detail = useApi<any>(open ? `/savings-accounts/${open}` : null, [open, tick]);
  const [f, setF] = useState<any | null>(null); const [editId, setEditId] = useState<string | null>(null);
  const [dep, setDep] = useState<any | null>(null); const [bal, setBal] = useState<any | null>(null); const [conf, setConf] = useState<any | null>(null);
  const [wd, setWd] = useState<any | null>(null);   // the Withdraw / Close window
  const rules = useApi<any>(wd ? `/savings-accounts/${wd.a.id}/withdraw-rules?date=${wd.date}` : null, [wd?.a?.id, wd?.date]);
  const [err, setErr] = useState(""); const [msg, setMsg] = useState(""); const [busy, setBusy] = useState(false);
  const scheme = (code: string) => (schemes.data ?? []).find((s) => s.code === code);
  const refresh = () => setTick((t) => t + 1);

  useEffect(() => {
    if (!startScheme || !schemes.data || !ents.data) return; const s = scheme(startScheme); onStarted?.(); if (!s) return;
    setErr(""); setMsg(""); setEditId(null);
    setF({ ...EMPTY, entity_id: ents.data[0]?.id ?? "", scheme: s.code, rate_pct: String(s.default_rate) });
  }, [startScheme, schemes.data, ents.data]);   // eslint-disable-line react-hooks/exhaustive-deps

  if (loading && !data) return <Status loading={loading} error={error} />;
  if (error) return <Status loading={false} error={error} />;

  const run = async (fn: () => Promise<any>, ok: (r: any) => string, done: () => void) => { setBusy(true); setErr(""); try { const r = await fn(); setMsg(ok(r)); done(); refresh(); } catch (e: any) { setErr(e.message); } finally { setBusy(false); } };
  const saveAccount = () => {
    const body: any = { institution: f.institution, account_no: f.account_no || null, rate_pct: Number(f.rate_pct), opened_on: f.opened_on, bucket: f.bucket };
    if (f.opening_balance !== "") body.opening_balance = Number(f.opening_balance); if (f.tracked_from) body.tracked_from = f.tracked_from;
    if (f.scheme === "epf") { body.employee_monthly = Number(f.employee_monthly || 0); body.employer_monthly = Number(f.employer_monthly || 0); }
    if (f.scheme === "ssy") { body.holder_name = f.holder_name || null; body.holder_dob = f.holder_dob || null; }
    if (!editId) { body.entity_id = f.entity_id; body.scheme = f.scheme; }
    return run(() => api(editId ? `/savings-accounts/${editId}` : "/savings-accounts", { method: editId ? "PATCH" : "POST", body: JSON.stringify(body) }), () => editId ? "Account updated. The yearly interest was worked out again at the new rate." : "Account added. Its yearly interest is worked out for you.", () => { setF(null); setEditId(null); });
  };
  const startEdit = (a: any) => { setErr(""); setMsg(""); setEditId(a.id); setF({ entity_id: a.entity_id, scheme: a.scheme, institution: a.institution, account_no: a.account_no ?? "", holder_name: a.holder_name ?? "", holder_dob: a.holder_dob ?? "", opened_on: a.opened_on, rate_pct: String(a.rate_pct), opening_balance: String(a.opening_balance), tracked_from: a.tracked_from, bucket: a.bucket, employee_monthly: String(a.employee_monthly ?? 0), employer_monthly: String(a.employer_monthly ?? 0) }); };
  const remove = async (a: any) => { if (!confirm(`Delete ${a.scheme_label} ${a.account_no ?? ""} at ${a.institution}? Its deposits and interest entries are deleted too.`)) return; setErr(""); setMsg(""); try { const r: any = await api(`/savings-accounts/${a.id}`, { method: "DELETE" }); setMsg(`Deleted. ${r.note}`); setOpen(null); refresh(); } catch (e: any) { setErr(e.message); } };

  const list = data ?? []; const mine = (entityId: string) => (banks.data ?? []).filter((b) => b.entity_id === entityId && b.type !== "card");
  const fs = f ? scheme(f.scheme) : null;
  return (<>
    {msg && <div className="small" style={{ color: "var(--teal)", margin: "6px 0" }}>{msg}</div>}{err && !f && !dep && !bal && !conf && <div className="err">{err}</div>}
    <Card title="PPF, EPF and Sukanya Samriddhi accounts" action={<span className="row gap"><span className="small mute">Interest is added once a year on 31 March, worked out from the scheme's rule</span>{canWrite() && <button className="btn btn-s btn-p" onClick={() => { setErr(""); setMsg(""); setEditId(null); setF({ ...EMPTY, entity_id: ents.data?.[0]?.id ?? "", rate_pct: String(scheme("ppf")?.default_rate ?? "") }); }}>+ Add account</button>}</span>}>
      {!list.length ? <div className="small mute">No PPF, EPF or Sukanya account yet. Use <b>+ Add account</b>, or Add asset → Government savings.</div> :
        <table className="tbl"><thead><tr><th>Account</th><th>Entity</th><th className="num">Balance</th><th className="num">This year</th><th className="num">Rate</th><th>Matures</th><th></th></tr></thead>
          <tbody>{list.map((a) => <tr key={a.id} onClick={() => setOpen(open === a.id ? null : a.id)} style={{ cursor: "pointer", background: open === a.id ? "var(--paper)" : undefined }}>
            <td><Pill tone="blue">{a.scheme_label}</Pill> <b>{a.institution}</b>{a.account_no ? <span className="mute"> · {a.account_no}</span> : null}{a.holder_name ? <div className="small mute">for {a.holder_name}</div> : null}</td>
            <td>{a.entity_name}</td><td className="num">{a.status === "closed" ? <><span className="mute">closed</span><div className="small mute">{fmtDate(a.closed_on)}</div></> : <>{inr(a.balance)}{a.withdrawn_total > 0 ? <div className="small mute">{inr(a.withdrawn_total)} taken out</div> : null}</>}</td>
            <td className="num">{inr(a.fy_deposited)} {a.fy_limit ? <span className="small mute">of {inr(a.fy_limit)}</span> : null}<div className="small mute">{a.fy} · {a.fy_limit ? `${inr(a.fy_limit_left)} left` : "put in so far"}</div></td>
            <td className="num">{a.rate_pct}%</td><td>{a.matures_on ? <>{fmtDate(a.matures_on)}<div className="small mute">{a.days_to_maturity > 0 ? `in ${Math.round(a.days_to_maturity / 365.25 * 10) / 10} yrs` : "matured"}</div></> : <span className="mute">no end date{a.employee_monthly + a.employer_monthly > 0 ? <div className="small">{inr(a.employee_monthly + a.employer_monthly)} a month goes in</div> : null}</span>}</td>
            <td>{canWrite() && a.status === "closed" && <div className="row gap" onClick={(e) => e.stopPropagation()}><button className="btn btn-s" onClick={() => remove(a)}>Delete</button></div>}
              {canWrite() && a.status === "active" && <div className="row gap" onClick={(e) => e.stopPropagation()}>
              <button className="btn btn-s" onClick={() => { setErr(""); setMsg(""); setDep({ a, amount: "", date: today(), bank: "" }); }}>{a.scheme === "epf" ? "Add contribution" : "Add deposit"}</button>
              <button className="btn btn-s" onClick={() => startEdit(a)}>Edit</button>
              {a.scheme !== "epf" && <button className="btn btn-s" onClick={() => { setErr(""); setMsg(""); setWd({ a, kind: "part", date: today(), amount: "", bank: "", reason: "", override: false, ovReason: "" }); }}>Withdraw / Close</button>}
              <button className="btn btn-s" onClick={() => { setErr(""); setMsg(""); setBal({ a, value: String(a.balance) }); }}>Update balance</button>
              <button className="btn btn-s" onClick={() => remove(a)}>Delete</button></div>}</td></tr>)}</tbody></table>}
    </Card>

    {open && detail.data && <Card title={`${detail.data.scheme_label} ${detail.data.account_no ?? ""} — year by year`}>
      <table className="tbl"><thead><tr><th>Financial year</th><th className="num">Deposited</th><th className="num">Interest</th><th>Status</th><th className="num">Balance at year end</th><th></th></tr></thead>
        <tbody>{[...detail.data.years].reverse().map((y: any) => { const e = detail.data.entries.find((x: any) => x.kind === "interest" && x.entry_date === y.credit_date); return <tr key={y.label}>
          <td>{y.label}</td><td className="num">{inr(y.deposited)}</td><td className="num">{inr(y.interest)}</td>
          <td>{!y.ended ? <Pill tone="amber">in progress · added {fmtDate(y.credit_date)}</Pill> : y.confirmed ? <Pill tone="teal">confirmed from passbook</Pill> : <Pill>estimate · check your passbook</Pill>}</td>
          <td className="num">{y.ended ? inr(y.balance_end) : "—"}</td>
          <td>{canWrite() && y.ended && e && <button className="btn btn-s" onClick={() => { setErr(""); setConf({ e, value: String(e.amount), label: y.label }); }}>{y.confirmed ? "Change" : "Confirm"}</button>}</td></tr>; })}</tbody></table>
      <h4 style={{ marginBottom: 4 }}>{detail.data.scheme === "epf" ? "Contributions" : "Deposits and withdrawals"}</h4>
      {detail.data.entries.filter((e: any) => e.kind !== "interest").length === 0 ? <div className="small mute">{detail.data.opening_balance > 0 ? `Nothing added since tracking began; it started with ${inr(detail.data.opening_balance)} on ${fmtDate(detail.data.tracked_from)}.` : "No deposits yet."}</div> :
        <table className="tbl"><thead><tr><th>Date</th><th className="num">Amount</th><th>Source</th><th></th></tr></thead><tbody>{[...detail.data.entries].filter((e: any) => e.kind !== "interest").reverse().map((e: any) => <tr key={e.id}>
          <td>{fmtDate(e.entry_date)}</td><td className="num">{e.kind === "withdrawal" ? <span style={{ color: "var(--red, #b3261e)" }}>− {inr(e.amount)}</span> : inr(e.amount)}</td><td>{e.kind === "withdrawal" ? <Pill tone="amber">{e.closes ? "account closed" : "withdrawal"}</Pill> : null}{e.override_reason ? <span className="small mute"> · recorded as an exception: {e.override_reason}</span> : null}{e.kind === "withdrawal" ? null : e.auto ? <Pill tone="blue">added by the app</Pill> : e.bank_txn_ref ? <Pill tone="teal">verified by bank statement</Pill> : <Pill>entered by hand</Pill>}{e.note ? <span className="small mute"> · {e.note}</span> : null}</td>
          <td>{canWrite() && !e.bank_txn_ref && !e.auto && <button className="btn btn-s" onClick={() => { if (confirm(e.kind === "withdrawal" ? `Take back the ${e.closes ? "closing" : "withdrawal"} of ${inr(e.amount)} on ${fmtDate(e.entry_date)}?${e.closes ? " The account becomes active again." : ""}` : `Remove the deposit of ${inr(e.amount)} on ${fmtDate(e.entry_date)}?`)) run(() => api(`/savings-entries/${e.id}`, { method: "DELETE" }), () => e.kind === "withdrawal" ? "Withdrawal taken back." : "Deposit removed.", () => {}); }}>{e.kind === "withdrawal" ? "Take back" : "Remove"}</button>}</td></tr>)}</tbody></table>}
      <div className="small mute" style={{ marginTop: 6 }}>{detail.data.scheme === "epf" ? "Each month earns interest on the balance it opened with, so a contribution made at the end of a month earns from the next month. The year's interest is added on 31 March. The monthly contributions are added by the app at each month end; to correct them, use Update balance with your passbook figure." : "Each month earns interest on the lowest balance between the 5th and the end of the month, so a deposit made by the 5th counts for that month. The year's interest is added on 31 March. A bank statement that shows a PPF or Sukanya debit verifies the deposit, or adds it when it is not here yet."}{detail.data.balance_adjust ? ` Your last passbook check set the balance ${detail.data.balance_adjust > 0 ? "up" : "down"} by ${inr(Math.abs(detail.data.balance_adjust))}.` : ""}</div>
    </Card>}

    {f && <div className="modal-bg" onClick={() => setF(null)}><div className="modal" style={{ maxWidth: 680, maxHeight: "90vh", overflow: "auto" }} onClick={(e) => e.stopPropagation()}>
      <h3 style={{ margin: 0 }}>{editId ? "Edit account" : "Add account"} — {fs?.full}</h3>
      <div className="small mute">{fs?.limit ? `Limit ₹${Number(fs.limit).toLocaleString("en-IN")} a year, smallest deposit ₹${fs.min_deposit}. ` : "No yearly limit. "}Term: {fs?.term}.</div>
      <div className="grid-2">
        <label className="field">Owner<select style={inp} disabled={!!editId} value={f.entity_id} onChange={(e) => setF({ ...f, entity_id: e.target.value })}>{(ents.data ?? []).map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}</select></label>
        <label className="field">Scheme<select style={inp} disabled={!!editId} value={f.scheme} onChange={(e) => setF({ ...f, scheme: e.target.value, rate_pct: String(scheme(e.target.value)?.default_rate ?? f.rate_pct) })}><option value="ppf">PPF</option><option value="epf">EPF</option><option value="ssy">Sukanya Samriddhi</option></select></label>
        <label className="field">{f.scheme === "epf" ? "Employer" : "Post office / bank"}<input style={inp} value={f.institution} placeholder={f.scheme === "epf" ? "e.g. Infosys" : "e.g. India Post, SBI"} onChange={(e) => setF({ ...f, institution: e.target.value })} /></label>
        <label className="field">{f.scheme === "epf" ? "UAN or member ID" : "Account number"}<input style={inp} value={f.account_no} onChange={(e) => setF({ ...f, account_no: e.target.value })} /></label>
        {f.scheme === "ssy" && <><label className="field">Girl child's name<input style={inp} value={f.holder_name} onChange={(e) => setF({ ...f, holder_name: e.target.value })} /></label>
          <label className="field">Date of birth<input style={inp} type="date" value={f.holder_dob} onChange={(e) => setF({ ...f, holder_dob: e.target.value })} /></label></>}
        {f.scheme === "epf" && <><label className="field">Your monthly contribution (₹)<input style={inp} type="number" step="any" value={f.employee_monthly} placeholder="what is cut from your salary" onChange={(e) => setF({ ...f, employee_monthly: e.target.value })} /></label>
          <label className="field">Employer's monthly share (₹)<input style={inp} type="number" step="any" value={f.employer_monthly} placeholder="what your employer adds" onChange={(e) => setF({ ...f, employer_monthly: e.target.value })} /></label></>}
        <label className="field">{f.scheme === "epf" ? "Joined this employer on" : "Opened on"}<input style={inp} type="date" max={today()} value={f.opened_on} onChange={(e) => setF({ ...f, opened_on: e.target.value })} /></label>
        <label className="field">Interest rate % a year<input style={inp} type="number" step="0.01" value={f.rate_pct} onChange={(e) => setF({ ...f, rate_pct: e.target.value })} /></label>
        <label className="field">Money already in the account (₹)<input style={inp} type="number" step="any" value={f.opening_balance} placeholder="leave empty if the account is new" onChange={(e) => setF({ ...f, opening_balance: e.target.value })} /></label>
        <label className="field">The date that balance was true<input style={inp} type="date" max={today()} value={f.tracked_from} onChange={(e) => setF({ ...f, tracked_from: e.target.value })} /></label>
        <label className="field">Bucket<select style={inp} value={f.bucket} onChange={(e) => setF({ ...f, bucket: e.target.value })}>{["liquidity", "income", "growth"].map((b) => <option key={b}>{b}</option>)}</select></label>
      </div>
      {f.scheme === "epf" && <div className="small" style={{ marginTop: 6, padding: "6px 8px", borderRadius: 6, background: "var(--tealSoft)" }}><b>No end date.</b> The money stays until you retire or withdraw. At each month end the app adds one contribution (yours plus the employer's) from the date your balance is true, and works the interest out on the running balance. Change the amounts later with Edit; months already added keep their amount.</div>}
      {f.opened_on && f.scheme !== "epf" && <div className="small" style={{ marginTop: 6, padding: "6px 8px", borderRadius: 6, background: "var(--tealSoft)" }}><b>Matures on {fmtDate(maturityFor(f.scheme, f.opened_on)!)}</b>{f.scheme === "ssy" ? ` · deposits stop on ${fmtDate(`${Number(f.opened_on.slice(0, 4)) + 15}${f.opened_on.slice(4)}`)}` : ""}. The app works this out from the opening date; there is nothing to type.</div>}
      {fs && <div className="small" style={{ marginTop: 6, padding: "6px 8px", borderRadius: 6, background: "var(--amberSoft)" }}><b>Rate:</b> {fs.rate_note}</div>}
      <div className="small mute" style={{ marginTop: 6 }}><b>If the account is new</b>, leave the two boxes about money empty. <b>If you already have money in it</b>, type the amount your passbook shows and the date of that passbook entry. For example: ₹2,00,000 on 01-04-2025. The app works out the interest from that date onwards, so use a date when you know the balance, such as the start of a financial year (1 April). {editId ? "Changing the rate or the balance works the yearly interest out again; a figure you confirmed from the passbook is kept." : ""}</div>
      {err && <div className="err">{err}</div>}
      <div className="row gap" style={{ justifyContent: "flex-end", marginTop: 8 }}><button className="btn" onClick={() => { setF(null); setEditId(null); }}>Cancel</button><button className="btn btn-p" disabled={busy || !f.entity_id || !f.institution || !f.opened_on || !(Number(f.rate_pct) > 0) || (f.scheme === "ssy" && !f.holder_dob)} onClick={saveAccount}>{busy ? "Saving…" : editId ? "Save changes" : "Save"}</button></div>
    </div></div>}

    {dep && <div className="modal-bg" onClick={() => setDep(null)}><div className="modal" onClick={(e) => e.stopPropagation()}>
      <h3 style={{ margin: 0 }}>{dep.a.scheme === "epf" ? "Add contribution" : "Add deposit"} — {dep.a.scheme_label} {dep.a.account_no ?? ""}</h3>
      <div className="small mute">{dep.a.fy_limit ? `${dep.a.fy}: ${inr(dep.a.fy_deposited)} in so far, ${inr(dep.a.fy_limit_left)} left of the ${inr(dep.a.fy_limit)} limit. A deposit by the 5th of a month earns interest for that month.` : `${dep.a.fy}: ${inr(dep.a.fy_deposited)} in so far. Use this for a voluntary top-up (VPF) or any extra amount; the monthly salary contribution is added by the app. It earns interest from the next month.`}</div>
      <div className="grid-2">
        <label className="field">Amount (₹)<input style={inp} type="number" step="any" value={dep.amount} onChange={(e) => setDep({ ...dep, amount: e.target.value })} /></label>
        <label className="field">Date<input style={inp} type="date" max={today()} value={dep.date} onChange={(e) => setDep({ ...dep, date: e.target.value })} /></label>
        <label className="field">Paid from (optional)<select style={inp} value={dep.bank} onChange={(e) => setDep({ ...dep, bank: e.target.value })}><option value="">— don't change any balance —</option>{mine(dep.a.entity_id).map((b) => <option key={b.id} value={b.id}>{b.bank} {b.account_masked}</option>)}</select></label>
      </div>
      {err && <div className="err">{err}</div>}
      <div className="row gap" style={{ justifyContent: "flex-end", marginTop: 8 }}><button className="btn" onClick={() => setDep(null)}>Cancel</button><button className="btn btn-p" disabled={busy || !(Number(dep.amount) > 0)} onClick={() => run(() => api(`/savings-accounts/${dep.a.id}/deposits`, { method: "POST", body: JSON.stringify({ amount: Number(dep.amount), entry_date: dep.date, bank_account_id: dep.bank || null }) }), () => `Deposit of ${inr(dep.amount)} recorded.`, () => setDep(null))}>Save</button></div>
    </div></div>}

    {wd && (() => {
      const r = rules.data; const k = wd.kind; const rule = r ? (k === "part" ? r.part : r.close) : null; const amt = Number(wd.amount);
      const over = !!rule && !rule.allowed ? rule.reason : (k === "part" && rule?.max != null && amt > rule.max + 0.5 ? `The most that can be taken is ${inr(rule.max)}` : null);
      const needReason = k === "close" && !!r?.close.needs_reason && r.close.allowed && !wd.reason;
      const ready = !busy && amt > 0 && !needReason && (!over || (isOwner() && wd.override && wd.ovReason.trim().length >= 15));
      return <div className="modal-bg" onClick={() => setWd(null)}><div className="modal" style={{ maxWidth: 620, maxHeight: "90vh", overflow: "auto" }} onClick={(e) => e.stopPropagation()}>
        <h3 style={{ margin: 0 }}>Withdraw or close — {wd.a.scheme_label} {wd.a.account_no ?? ""}</h3>
        <div className="row gap" style={{ margin: "8px 0" }}>
          <label><input type="radio" checked={k === "part"} onChange={() => setWd({ ...wd, kind: "part", override: false })} /> Take some money out</label>
          <label><input type="radio" checked={k === "close"} onChange={() => setWd({ ...wd, kind: "close", override: false })} /> Close the account</label></div>
        <div className="grid-2">
          <label className="field">Date<input style={inp} type="date" max={today()} value={wd.date} onChange={(e) => setWd({ ...wd, date: e.target.value })} /></label>
          <label className="field">{k === "close" ? "Amount credited to you (₹)" : "Amount taken out (₹)"}<input style={inp} type="number" step="any" value={wd.amount} placeholder={k === "close" && r ? `about ${Math.round(r.close.estimate)} before any cut` : ""} onChange={(e) => setWd({ ...wd, amount: e.target.value })} /></label>
          <label className="field">Credited to (optional)<select style={inp} value={wd.bank} onChange={(e) => setWd({ ...wd, bank: e.target.value })}><option value="">— don't change any balance —</option>{mine(wd.a.entity_id).map((b) => <option key={b.id} value={b.id}>{b.bank} {b.account_masked}</option>)}</select></label>
          {k === "close" && r?.close.reasons?.length ? <label className="field">Why is it closing early?<select style={inp} value={wd.reason} onChange={(e) => setWd({ ...wd, reason: e.target.value })}><option value="">— choose —</option>{r.close.reasons.map((x: string) => <option key={x}>{x}</option>)}</select></label> : null}
        </div>
        {rule && <div className="small" style={{ marginTop: 6, padding: "6px 8px", borderRadius: 6, background: over ? "var(--amberSoft)" : "var(--tealSoft)" }}>
          {k === "part" ? (rule.allowed ? <><b>Allowed.</b> You can take up to <b>{inr(rule.max)}</b> ({rule.basis}). Only one part withdrawal a financial year.</> : <><b>Not allowed:</b> {rule.reason}.</>)
            : (rule.allowed ? <><b>Allowed.</b> The balance is about <b>{inr(r.close.estimate)}</b>, with the interest of the months finished so far. {wd.a.scheme === "ppf" && wd.date < wd.a.matures_on ? "The post office cuts 1% from the rate on an early closure, so the amount credited is lower: type what you were actually paid." : "Type what you were actually paid."}</> : <><b>Not allowed:</b> {rule.reason}.</>)}</div>}
        {over && rule?.allowed && <div className="small" style={{ marginTop: 6, color: "var(--amber, #8a5a00)" }}>{over}.</div>}
        {over && (isOwner() ? <div style={{ marginTop: 6 }}><label className="small"><input type="checkbox" checked={wd.override} onChange={(e) => setWd({ ...wd, override: e.target.checked })} /> Record it anyway as an exception (an owner can do this)</label>
          {wd.override && <label className="field">Why? (at least 15 characters)<input style={inp} value={wd.ovReason} placeholder="e.g. the post office approved it in writing" onChange={(e) => setWd({ ...wd, ovReason: e.target.value })} /></label>}</div> : <div className="small mute" style={{ marginTop: 6 }}>Only an owner can record it anyway.</div>)}
        {err && <div className="err">{err}</div>}
        <div className="row gap" style={{ justifyContent: "flex-end", marginTop: 8 }}><button className="btn" onClick={() => setWd(null)}>Cancel</button>
          <button className="btn btn-p" disabled={!ready} onClick={() => { if (k === "close" && !confirm(`Close ${wd.a.scheme_label} ${wd.a.account_no ?? ""}? It leaves your net worth. You can take the closing back afterwards.`)) return;
            run(() => api(`/savings-accounts/${wd.a.id}/withdraw`, { method: "POST", body: JSON.stringify({ kind: k, amount: amt, date: wd.date, bank_account_id: wd.bank || null, reason: wd.reason || undefined, override: over ? wd.override : undefined, override_reason: over && wd.override ? wd.ovReason : undefined }) }), (x) => k === "close" ? `Account closed. ${inr(amt)} recorded as paid out.` : `${inr(amt)} taken out. The balance is now ${inr(x.balance)}.`, () => setWd(null)); }}>{busy ? "Saving…" : k === "close" ? "Close account" : "Record withdrawal"}</button></div>
      </div></div>; })()}

    {bal && <div className="modal-bg" onClick={() => setBal(null)}><div className="modal" onClick={(e) => e.stopPropagation()}>
      <h3 style={{ margin: 0 }}>Update balance — {bal.a.scheme_label} {bal.a.account_no ?? ""}</h3>
      <div className="small mute">The app shows {inr(bal.a.balance)}. Enter what your passbook or the post office / EPFO app shows today. The difference is kept, and later deposits and interest add on top of it.</div>
      <label className="field">Balance in the passbook (₹)<input style={inp} type="number" step="any" value={bal.value} onChange={(e) => setBal({ ...bal, value: e.target.value })} /></label>
      {err && <div className="err">{err}</div>}
      <div className="row gap" style={{ justifyContent: "flex-end", marginTop: 8 }}><button className="btn" onClick={() => setBal(null)}>Cancel</button><button className="btn btn-p" disabled={busy || bal.value === ""} onClick={() => run(() => api(`/savings-accounts/${bal.a.id}/balance`, { method: "POST", body: JSON.stringify({ balance: Number(bal.value) }) }), (r) => `Balance set to ${inr(r.balance)}.`, () => setBal(null))}>Save</button></div>
    </div></div>}

    {conf && <div className="modal-bg" onClick={() => setConf(null)}><div className="modal" onClick={(e) => e.stopPropagation()}>
      <h3 style={{ margin: 0 }}>Interest for {conf.label}</h3>
      <div className="small mute">The app worked out {inr(conf.e.amount)} by the scheme's rule. Enter the interest your passbook shows for this year; it replaces the estimate.</div>
      <label className="field">Interest in the passbook (₹)<input style={inp} type="number" step="any" value={conf.value} onChange={(e) => setConf({ ...conf, value: e.target.value })} /></label>
      {err && <div className="err">{err}</div>}
      <div className="row gap" style={{ justifyContent: "flex-end", marginTop: 8 }}><button className="btn" onClick={() => setConf(null)}>Cancel</button><button className="btn btn-p" disabled={busy || conf.value === ""} onClick={() => run(() => api(`/savings-entries/${conf.e.id}/confirm`, { method: "POST", body: JSON.stringify({ amount: Number(conf.value) }) }), () => "Interest confirmed from the passbook.", () => setConf(null))}>Save</button></div>
    </div></div>}
  </>);
}
