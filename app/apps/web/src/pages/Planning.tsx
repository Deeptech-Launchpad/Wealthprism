import { useState } from "react";
import { Plus, Play, GitBranch, AlertTriangle, MessageSquare, RefreshCw } from "lucide-react";
import { useApi } from "../lib/useApi";
import { api, inr, session } from "../lib/api";
import { Card, Pill, Status, fmtDate } from "../components";

const TABS = ["Scenarios", "Compare", "Tax position", "Optimiser", "Execution"] as const;
const FY = (() => { const d = new Date(); const y = d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1; return `${y}-${String(y + 1).slice(-2)}`; })();
const KINDS: [string, string][] = [["sell_holding", "Sell holding"], ["buy_instrument", "Buy instrument"], ["switch", "Switch"], ["redeem_before_date", "Redeem before a date"], ["defer_sale_to_fy", "Defer sale to a FY"], ["harvest_loss", "Harvest loss"], ["book_gain_within_exemption", "Book gain within exemption"], ["transfer_to_entity", "Transfer between entities"], ["change_tax_regime", "Change tax regime"], ["sell_property", "Sell property"], ["reinvest_54ec", "Reinvest under 54EC"], ["reinvest_54f", "Reinvest under 54F"], ["prepay_loan", "Prepay loan"], ["exit_private", "Exit private investment"], ["donate_80g", "Donate (80G)"], ["contribute_nps", "Contribute to NPS"], ["contribute_ppf", "Contribute to PPF"], ["change_rent", "Change rent / vacate"], ["deploy_cash", "Deploy cash"], ["custom", "Custom"]];
const TARGET_OF: Record<string, "holding" | "property" | "private_investment" | "entity" | null> = { sell_holding: "holding", switch: "holding", redeem_before_date: "holding", defer_sale_to_fy: "holding", harvest_loss: "holding", book_gain_within_exemption: "holding", sell_property: "property", change_rent: "property", exit_private: "private_investment", transfer_to_entity: "entity", change_tax_regime: "entity" };
const STATUS_TONE: Record<string, "teal" | "amber" | "blue" | "red" | undefined> = { in_review: "amber", approved: "teal", executing: "blue", completed: "teal" };
const pct = (v: number | null | undefined) => (v == null ? "—" : `${v}%`);

export function Planning() {
  const [tab, setTab] = useState<(typeof TABS)[number]>("Scenarios");
  const [tick, setTick] = useState(0);
  const bump = () => setTick((t) => t + 1);
  return (<>
    <div className="tabs">{TABS.map((t) => <button key={t} className={tab === t ? "on" : ""} onClick={() => setTab(t)}>{t}</button>)}</div>
    {tab === "Scenarios" && <Scenarios key={tick} onChange={bump} />}
    {tab === "Compare" && <Compare key={tick} />}
    {tab === "Tax position" && <TaxPosition key={tick} onChange={bump} />}
    {tab === "Optimiser" && <Optimiser key={tick} onChange={bump} />}
    {tab === "Execution" && <Execution key={tick} />}
  </>);
}

function Field({ label, children }: { label: string; children: React.ReactNode }) { return <label className="field">{label}{children}</label>; }
function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) { return <div className="modal-bg" onClick={onClose}><div className="modal" onClick={(e) => e.stopPropagation()}><h3 style={{ margin: 0 }}>{title}</h3>{children}</div></div>; }

function Scenarios({ onChange }: { onChange: () => void }) {
  const list = useApi<any[]>("/plans"); const ents = useApi<any[]>("/entities"); const holdings = useApi<any>("/holdings"); const props = useApi<any[]>("/properties"); const privates = useApi<any[]>("/private-investments");
  const [sel, setSel] = useState<string | null>(null);
  const selectedId = sel ?? list.data?.find((s) => !s.is_baseline)?.id ?? list.data?.[0]?.id ?? null;
  const detail = useApi<any>(selectedId ? `/plans/${selectedId}` : null);
  const [busy, setBusy] = useState(""); const [err, setErr] = useState(""); const [newSc, setNewSc] = useState<any | null>(null); const [action, setAction] = useState<any | null>(null); const [comment, setComment] = useState("");
  const role = session.get()?.families.find((f) => f.id === session.family())?.role;
  const call = async (label: string, fn: () => Promise<unknown>, refresh = true) => { setBusy(label); setErr(""); try { await fn(); if (refresh) { list.refetch(); detail.refetch(); } } catch (e: any) { setErr(e.message); } finally { setBusy(""); } };
  if (!list.data) return <Status loading={list.loading} error={list.error} />;
  const sc = detail.data; const res = sc?.latest_result; const editable = sc && !sc.is_baseline && ["draft", "in_review"].includes(sc.status);
  const targetsFor = (kind: string) => { const t = TARGET_OF[kind]; if (t === "holding") return (holdings.data?.items ?? []).map((h: any) => ({ id: h.id, label: `${h.instrument} · ${h.entity_name} · ${Number(h.quantity).toLocaleString("en-IN")}`, entity_id: h.entity_id })); if (t === "property") return (props.data ?? []).map((p: any) => ({ id: p.id, label: p.name, entity_id: p.owners?.[0]?.entity_id })); if (t === "private_investment") return (privates.data ?? []).map((p: any) => ({ id: p.id, label: p.company, entity_id: p.entity_id })); if (t === "entity") return (ents.data ?? []).map((e: any) => ({ id: e.id, label: e.name, entity_id: e.id })); return []; };
  const saveAction = async () => { const p: Record<string, any> = {}; for (const [k, v] of Object.entries(action.params)) if (v !== "" && v != null) p[k] = isNaN(Number(v)) || k === "fy" || k === "regime" || k === "note" || k === "issuer" || k === "instrument_id" || k === "to_instrument_id" || k === "to_entity_id" ? v : Number(v);
    await call("action", () => api(`/plans/${sc.id}/actions`, { method: "POST", body: JSON.stringify({ kind: action.kind, entity_id: action.entity_id || undefined, target_type: TARGET_OF[action.kind] ?? undefined, target_id: action.target_id || undefined, params: p, planned_date: action.planned_date, planned_amount: action.planned_amount ? Number(action.planned_amount) : undefined }) })); setAction(null); };
  const paramFields = (kind: string): [string, string][] => ({ sell_holding: [["quantity", "Quantity"], ["price", "Price (blank = projected)"]], harvest_loss: [["quantity", "Quantity"], ["price", "Price"]], redeem_before_date: [["quantity", "Quantity (blank = all)"]], book_gain_within_exemption: [["quantity", "Quantity (blank = size to headroom)"], ["target_gain", "Target gain"]], defer_sale_to_fy: [["quantity", "Quantity"], ["fy", "FY (e.g. 2027-28)"]], buy_instrument: [["amount", "Amount"], ["instrument_id", "Instrument id (optional)"], ["note", "Note"]], deploy_cash: [["amount", "Amount"], ["bucket", "Bucket"], ["name", "Name"]], switch: [["quantity", "Quantity"], ["to_instrument_id", "To instrument id"]], transfer_to_entity: [["monthly", "Monthly amount"], ["amount", "One-off amount"], ["note", "Note"]], change_tax_regime: [["regime", "Regime (old / new)"], ["fy", "FY"]], sell_property: [["price", "Sale price"], ["brokerage_pct", "Brokerage %"]], reinvest_54ec: [["amount", "Amount"], ["issuer", "Issuer (REC / NHAI …)"]], reinvest_54f: [["amount", "Amount"]], prepay_loan: [["amount", "Amount"]], exit_private: [["proceeds", "Proceeds"]], donate_80g: [["amount", "Amount"], ["pct", "Deductible % (50 / 100)"]], contribute_nps: [["amount", "Amount"]], contribute_ppf: [["amount", "Amount"]], change_rent: [["new_rent", "New monthly rent"], ["note", "Note (write 'vacate' to end the lease)"]], custom: [["amount", "Amount"], ["tax_head", "Tax head (other / capital_gains_long / deduction:80C)"], ["note", "Note"]] } as Record<string, [string, string][]>)[kind] ?? [];
  return (<>
    <div className="grid-2" style={{ gridTemplateColumns: "340px 1fr" }}>
      <Card title="Scenarios" action={<button className="btn btn-s btn-p" onClick={() => setNewSc({ name: "", description: "", horizon_fys: 3 })}><Plus size={13} /> New</button>}>
        {list.data.map((x) => <div key={x.id} className="attn" style={{ cursor: "pointer", background: x.id === selectedId ? "var(--paper)" : undefined, borderRadius: 6, padding: "9px 8px", flexDirection: "column", alignItems: "stretch", gap: 2 }} onClick={() => setSel(x.id)}>
          <div className="row" style={{ justifyContent: "space-between" }}><b>{x.name}</b><Pill tone={STATUS_TONE[x.status]}>{x.is_baseline ? "baseline" : x.status.replace("_", " ")}</Pill></div>
          <div className="small mute">{x.is_baseline ? "Auto-maintained from current data" : `${x.action_count} actions · ${x.created_by_name ?? ""}${x.latest_result?.summary?.tax_vs_baseline != null ? ` · ${Number(x.latest_result.summary.tax_vs_baseline) <= 0 ? "saves" : "costs"} ${inr(Math.abs(Number(x.latest_result.summary.tax_vs_baseline)))} vs baseline` : " · not simulated"}`}</div>
        </div>)}
        <div className="small mute" style={{ marginTop: 10 }}>Scenarios are versioned. Clone one to try a variation; approve one to turn its actions into tasks.</div>
      </Card>
      {sc ? <Card title={sc.name} action={<div className="row gap" style={{ flexWrap: "wrap" }}>
        {!sc.is_baseline && <button className="btn btn-s" onClick={() => call("clone", () => api(`/plans/${sc.id}/clone`, { method: "POST", body: "{}" }))}><GitBranch size={13} /> Clone</button>}
        <button className="btn btn-s" disabled={!!busy} onClick={() => call("sim", () => api(`/plans/${sc.id}/simulate`, { method: "POST", body: "{}" }))}><Play size={13} /> {busy === "sim" ? "Simulating…" : "Re-simulate"}</button>
        {sc.status === "draft" && !sc.is_baseline && <button className="btn btn-s btn-p" onClick={() => call("status", () => api(`/plans/${sc.id}/status`, { method: "POST", body: JSON.stringify({ status: "in_review" }) }))}>Send for review</button>}
        {sc.status === "in_review" && role === "owner" && <button className="btn btn-s btn-p" onClick={() => call("status", () => api(`/plans/${sc.id}/status`, { method: "POST", body: JSON.stringify({ status: "approved" }) }))}>Approve → tasks</button>}
        {sc.status === "in_review" && <button className="btn btn-s" onClick={() => call("status", () => api(`/plans/${sc.id}/status`, { method: "POST", body: JSON.stringify({ status: "draft" }) }))}>Send back</button>}
        {!sc.is_baseline && !["archived", "completed"].includes(sc.status) && <button className="btn btn-s" onClick={() => call("status", () => api(`/plans/${sc.id}/status`, { method: "POST", body: JSON.stringify({ status: "archived" }) }))}>Archive</button>}
      </div>}>
        {err && <div className="err">{err}</div>}
        <div className="kpis" style={{ gridTemplateColumns: "repeat(4,1fr)", marginBottom: 14 }}>
          <div className="src"><div className="mute small">Tax over {sc.horizon_fys} FYs</div><div className="big-num">{res ? inr(res.summary.tax_total) : "—"}</div><div className="small">{res?.summary.tax_vs_baseline != null ? <span className={Number(res.summary.tax_vs_baseline) <= 0 ? "up" : "down"}>{Number(res.summary.tax_vs_baseline) <= 0 ? "−" : "+"}{inr(Math.abs(Number(res.summary.tax_vs_baseline)))} vs baseline</span> : <span className="mute">baseline</span>}</div></div>
          <div className="src"><div className="mute small">Post-tax cash generated</div><div className="big-num">{res ? inr(res.summary.post_tax_cash) : "—"}</div></div>
          <div className="src"><div className="mute small">Max bucket drift after</div><div className="big-num" style={{ color: res && res.summary.drift_max_pp > 1.5 ? "var(--amber)" : "var(--teal)" }}>{res ? `${res.summary.drift_max_pp} pp` : "—"}</div></div>
          <div className="src"><div className="mute small">Projected net worth</div><div className="big-num">{res ? inr(res.summary.net_worth_end) : "—"}</div><div className="small mute">{res ? `234B/C exposure ${inr(res.summary.interest_234_total)}` : ""}</div></div>
        </div>
        {sc.is_baseline ? <div className="small mute" style={{ padding: 20, textAlign: "center" }}>The baseline has no actions. It projects tax, cash and allocation from current holdings, leases, income sources and commitments. Every scenario is measured against it.</div> : (<>
          <table className="tbl"><thead><tr><th>If…</th><th>Who · when</th><th className="num">Amount</th><th>Then…</th><th>Status</th><th></th></tr></thead>
            <tbody>{sc.actions.map((a: any) => { const eff = a.simulated_effect; const ent = ents.data?.find((e) => e.id === a.entity_id); return (<tr key={a.id}>
              <td><b>{KINDS.find(([k]) => k === a.kind)?.[1] ?? a.kind}</b><div className="small mute">{Object.entries(a.params ?? {}).filter(([k]) => k !== "note").map(([k, v]) => `${k}: ${v}`).join(" · ")}{a.params?.note ? ` · ${a.params.note}` : ""}</div></td>
              <td className="small mute">{ent?.name ?? "—"} · {fmtDate(a.planned_date)}</td><td className="num">{a.planned_amount ? inr(a.planned_amount) : "—"}</td>
              <td className="small">{eff ? <>{eff.detail && <div>{eff.detail}</div>}{eff.gain ? <div>{eff.term ?? ""} gain {inr(eff.gain)} · tax {inr(eff.tax)}</div> : eff.tax ? <div>tax effect {inr(eff.tax)}</div> : null}{eff.cash ? <div className="mute">cash {Number(eff.cash) >= 0 ? "+" : ""}{inr(eff.cash)}</div> : null}</> : <span className="mute">simulate to see</span>}</td>
              <td><Pill tone={a.status === "done" ? "teal" : a.status === "skipped" ? undefined : a.status === "in_progress" ? "blue" : undefined}>{a.status}</Pill></td>
              <td>{editable && <button className="btn btn-s" onClick={() => call("del", () => api(`/plans/${sc.id}/actions/${a.id}`, { method: "DELETE" }))}>×</button>}</td></tr>); })}</tbody></table>
          <div className="row gap" style={{ marginTop: 10, flexWrap: "wrap" }}>{editable && <button className="btn btn-s" onClick={() => setAction({ kind: "sell_holding", entity_id: "", target_id: "", params: {}, planned_date: new Date().toISOString().slice(0, 10), planned_amount: "" })}><Plus size={13} /> Add action</button>}<span className="small mute">Sell, buy, switch, defer to next FY, harvest loss, book gain within exemption, transfer between entities, change regime, sell property, 54EC / 54F, NPS / PPF, donate, custom.</span></div>
          {(res?.warnings ?? []).map((w: string, i: number) => <div key={i} className="attn" style={{ borderBottom: 0, paddingBottom: 0 }}><AlertTriangle size={14} color="var(--amber)" /><span className="small">{w}</span></div>)}
          {res && <div style={{ marginTop: 14 }}><div className="small mute" style={{ marginBottom: 6 }}>Allocation after this scenario</div>
            <div className="bucket-bar">{res.allocation_after.map((b: any) => <div key={b.bucket} className="bucket-seg" style={{ flex: b.pct, background: b.bucket === "liquidity" ? "var(--blue)" : b.bucket === "income" ? "var(--teal)" : "var(--violet)" }}>{b.bucket} {b.pct}%</div>)}</div>
            <div className="bucket-target">{res.allocation_after.map((b: any) => <div key={b.bucket} style={{ flex: b.target_pct, borderColor: b.bucket === "liquidity" ? "var(--blue)" : b.bucket === "income" ? "var(--teal)" : "var(--violet)" }} />)}</div>
            {!!res.goals_after?.length && <div className="small mute" style={{ marginTop: 8 }}>Goals: {res.goals_after.map((g: any) => `${g.name ?? "goal"} ${g.funded_pct}%${g.delta_pp != null && g.delta_pp !== 0 ? ` (${g.delta_pp > 0 ? "+" : ""}${g.delta_pp} pp)` : ""}`).join(" · ")}</div>}
          </div>}
          <div style={{ marginTop: 14, borderTop: "1px solid var(--line)", paddingTop: 10 }}>
            <div className="row gap small" style={{ marginBottom: 6 }}><MessageSquare size={13} className="mute" /><b>Review thread</b></div>
            {sc.comments.map((c: any) => <div key={c.id} className="small" style={{ marginTop: 4 }}><b>{c.user_name}</b> · {c.body} <span className="mute">{fmtDate(c.created_at)}</span></div>)}
            {!sc.comments.length && <div className="small mute">No comments yet.</div>}
            <div className="row gap" style={{ marginTop: 8 }}><input className="field" style={{ flex: 1, padding: 7 }} placeholder="Add a comment" value={comment} onChange={(e) => setComment(e.target.value)} /><button className="btn btn-s" disabled={!comment} onClick={() => call("comment", () => api(`/plans/${sc.id}/comments`, { method: "POST", body: JSON.stringify({ body: comment }) }).then(() => setComment("")))}>Post</button></div>
          </div>
        </>)}
      </Card> : <Status loading={detail.loading} error={detail.error} />}
    </div>
    {newSc && <Modal title="New scenario" onClose={() => setNewSc(null)}>
      <div className="grid-2"><Field label="Name"><input value={newSc.name} onChange={(e) => setNewSc({ ...newSc, name: e.target.value })} /></Field><Field label="Horizon (FYs)"><input type="number" min={1} max={10} value={newSc.horizon_fys} onChange={(e) => setNewSc({ ...newSc, horizon_fys: Number(e.target.value) })} /></Field></div>
      <Field label="Description"><input value={newSc.description} onChange={(e) => setNewSc({ ...newSc, description: e.target.value })} /></Field>
      <div className="row gap" style={{ justifyContent: "flex-end" }}><button className="btn" onClick={() => setNewSc(null)}>Cancel</button><button className="btn btn-p" disabled={!newSc.name} onClick={() => call("new", async () => { const s = await api<any>("/plans", { method: "POST", body: JSON.stringify(newSc) }); setSel(s.id); setNewSc(null); onChange(); })}>Create</button></div>
    </Modal>}
    {action && <Modal title="Add action" onClose={() => setAction(null)}>
      <div className="grid-2">
        <Field label="Kind"><select value={action.kind} onChange={(e) => setAction({ ...action, kind: e.target.value, target_id: "", params: {} })}>{KINDS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
        <Field label="Planned date"><input type="date" value={action.planned_date} onChange={(e) => setAction({ ...action, planned_date: e.target.value })} /></Field>
        {TARGET_OF[action.kind] && <Field label={TARGET_OF[action.kind] === "entity" ? "Target entity" : "Target"}><select value={action.target_id} onChange={(e) => { const t = targetsFor(action.kind).find((x: any) => x.id === e.target.value); setAction({ ...action, target_id: e.target.value, entity_id: action.entity_id || t?.entity_id || "" }); }}><option value="">—</option>{targetsFor(action.kind).map((t: any) => <option key={t.id} value={t.id}>{t.label}</option>)}</select></Field>}
        <Field label="Entity"><select value={action.entity_id} onChange={(e) => setAction({ ...action, entity_id: e.target.value })}><option value="">—</option>{(ents.data ?? []).map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}</select></Field>
        {paramFields(action.kind).map(([k, l]) => <Field key={k} label={l}><input value={action.params[k] ?? ""} onChange={(e) => setAction({ ...action, params: { ...action.params, [k]: e.target.value } })} /></Field>)}
        <Field label="Planned amount (₹, optional)"><input type="number" value={action.planned_amount} onChange={(e) => setAction({ ...action, planned_amount: e.target.value })} /></Field>
      </div>
      {err && <div className="err">{err}</div>}
      <div className="row gap" style={{ justifyContent: "flex-end" }}><button className="btn" onClick={() => setAction(null)}>Cancel</button><button className="btn btn-p" onClick={saveAction}>Add</button></div>
    </Modal>}
  </>);
}

function Compare() {
  const list = useApi<any[]>("/plans");
  const [ids, setIds] = useState<string[]>([]);
  const chosen = ids.length ? ids : (list.data ?? []).filter((s) => !s.is_baseline).slice(0, 3).map((s) => s.id);
  const cmp = useApi<any>(chosen.length ? `/plans/compare?ids=${chosen.join(",")}` : null);
  if (!list.data) return <Status loading={list.loading} error={list.error} />;
  return (<>
    <Card title="Side by side — baseline and up to three scenarios" action={<div className="row gap" style={{ flexWrap: "wrap" }}>{list.data.filter((s) => !s.is_baseline).map((s) => <label key={s.id} className="small row gap"><input type="checkbox" checked={chosen.includes(s.id)} onChange={(e) => setIds(e.target.checked ? [...chosen, s.id].slice(-3) : chosen.filter((x) => x !== s.id))} />{s.name.split(",")[0].slice(0, 28)}</label>)}</div>}>
      {!cmp.data ? <div className="mute">{cmp.loading ? "Comparing…" : cmp.error ?? "Pick scenarios to compare."}</div> : <table className="tbl"><thead><tr><th>Metric</th>{cmp.data.scenarios.map((s: any) => <th key={s.id} className="num">{s.name.split(",")[0].split(" +")[0]}</th>)}</tr></thead>
        <tbody>{cmp.data.metrics.map((m: any) => <tr key={m.metric}><td>{m.metric}</td>{cmp.data.scenarios.map((s: any) => <td key={s.id} className={`num ${m.metric === "Saving vs baseline" && Number(m.values[s.name]) > 0 ? "up" : ""}`}>{/^-?\d+(\.\d+)?$/.test(m.values[s.name]) ? inr(m.values[s.name]) : m.values[s.name]}</td>)}</tr>)}
          {cmp.data.by_fy.map((r: any) => <tr key={r.fy}><td className="mute">Tax FY {r.fy}</td>{cmp.data.scenarios.map((s: any) => <td key={s.id} className="num">{inr(r.tax[s.name])}</td>)}</tr>)}
          {cmp.data.allocation.map((r: any) => <tr key={r.bucket}><td className="mute" style={{ textTransform: "capitalize" }}>{r.bucket} bucket after</td>{cmp.data.scenarios.map((s: any) => <td key={s.id} className="num">{r.pct[s.name]}%</td>)}</tr>)}</tbody></table>}
    </Card>
  </>);
}

function TaxPosition({ onChange }: { onChange: () => void }) {
  const [fy, setFy] = useState(FY);
  const proj = useApi<any[]>(`/tax/projection?fy=${fy}`); const adv = useApi<any>(`/tax/advance-tax?fy=${fy}`); const ents = useApi<any[]>("/entities"); const inputs = useApi<any>("/tax/inputs");
  const [ent, setEnt] = useState(""); const entity = ent || ents.data?.[0]?.id || "";
  const rc = useApi<any>(entity ? `/tax/regime-compare?fy=${fy}&entity_id=${entity}` : null);
  const [err, setErr] = useState(""); const [inc, setInc] = useState<any | null>(null);
  if (!proj.data) return <Status loading={proj.loading} error={proj.error} />;
  const sum = (k: (r: any) => number) => proj.data!.reduce((s, r) => s + k(r), 0);
  const addToScenario = async () => { setErr(""); try { const s = await api<any>("/plans", { method: "POST", body: JSON.stringify({ name: `Regime: ${rc.data.entity_name} → ${rc.data.recommended} (FY ${fy})` }) }); await api(`/plans/${s.id}/actions`, { method: "POST", body: JSON.stringify(rc.data.add_to_scenario) }); onChange(); alert(`Draft scenario "${s.name}" created with the regime change`); } catch (e: any) { setErr(e.message); } };
  return (<>
    <Card title={`Projected tax computation — FY ${fy}, baseline`} action={<label className="field" style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>FY <select value={fy} onChange={(e) => setFy(e.target.value)}>{[FY, `${Number(FY.slice(0, 4)) + 1}-${String(Number(FY.slice(0, 4)) + 2).slice(-2)}`].map((f) => <option key={f}>{f}</option>)}</select></label>}>
      <table className="tbl"><thead><tr><th>Entity</th><th>Regime</th><th className="num">Gross total income</th><th className="num">Capital gains</th><th className="num">Deductions</th><th className="num">Tax + cess</th><th className="num">Advance paid</th><th className="num">Balance</th></tr></thead>
        <tbody>{proj.data.map((r) => { const cg = r.heads.capital_gains; const gains = cg.stcg_equity + cg.ltcg_equity + cg.stcg_other + cg.ltcg_other; const paid = r.advance_tax.reduce((s: number, i: any) => Math.max(s, i.paid), 0); return <tr key={r.entity_id}><td><b>{r.entity_name}</b></td><td><Pill tone={r.regime === "old" ? "amber" : undefined}>{r.regime}</Pill></td><td className="num">{inr(r.heads.gross_total)}</td><td className={`num ${gains < 0 ? "down" : ""}`}>{inr(gains)}</td><td className="num">{inr(r.deductions_total)}</td><td className="num">{inr(r.tax.total)}</td><td className="num">{inr(paid)}</td><td className="num">{inr(r.net_payable - paid)}</td></tr>; })}
          <tr className="total"><td>Family</td><td></td><td className="num">{inr(sum((r) => r.heads.gross_total))}</td><td className="num">{inr(sum((r) => { const c = r.heads.capital_gains; return c.stcg_equity + c.ltcg_equity + c.stcg_other + c.ltcg_other; }))}</td><td className="num">{inr(sum((r) => r.deductions_total))}</td><td className="num">{inr(sum((r) => r.tax.total))}</td><td className="num">{inr(sum((r) => r.advance_tax.reduce((s: number, i: any) => Math.max(s, i.paid), 0)))}</td><td className="num">{inr(sum((r) => r.net_payable - r.advance_tax.reduce((s: number, i: any) => Math.max(s, i.paid), 0)))}</td></tr></tbody></table>
      <div className="small mute" style={{ marginTop: 10 }}>Heads: salary/fees, house property (rent less 30% and interest), capital gains by asset class and term, other sources. Slabs, surcharge, cess, rebate and deduction limits are data tables per FY. Add income sources, deductions and advance-tax challans below to sharpen the projection.</div>
    </Card>
    <div className="grid-2">
      <Card title="Advance tax schedule — family">
        {adv.data && <table className="tbl"><thead><tr><th>Instalment</th><th className="num">Cum. %</th><th className="num">Due</th><th className="num">Paid</th><th className="num">Shortfall</th><th className="num">234C</th></tr></thead><tbody>{adv.data.family.map((i: any) => <tr key={i.due}><td>{fmtDate(i.due)}</td><td className="num">{i.cumulative_pct}%</td><td className="num">{inr(i.amount)}</td><td className="num">{inr(i.paid)}</td><td className={`num ${Number(i.shortfall) > 0 ? "down" : "mute"}`}>{Number(i.shortfall) ? inr(i.shortfall) : "—"}</td><td className="num">{Number(i.interest) ? inr(i.interest) : "—"}</td></tr>)}</tbody></table>}
        <div className="small mute" style={{ marginTop: 8 }}>Interest exposure (234B + 234C) if nothing more is paid: {adv.data ? inr(adv.data.interest_234_total) : "—"}. Shortfalls feed the working-capital committed outflows.</div>
      </Card>
      <Card title={`Old vs new regime — ${rc.data?.entity_name ?? "…"}`} action={<select className="field" style={{ padding: 6 }} value={entity} onChange={(e) => setEnt(e.target.value)}>{(ents.data ?? []).map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}</select>}>
        {rc.data ? <><table className="tbl"><thead><tr><th></th><th className="num">New</th><th className="num">Old</th></tr></thead><tbody>
          <tr><td>Gross total income</td><td className="num">{inr(rc.data.new.heads.gross_total)}</td><td className="num">{inr(rc.data.old.heads.gross_total)}</td></tr>
          <tr><td>Deductions</td><td className="num">{inr(rc.data.new.deductions_total)}</td><td className="num">{inr(rc.data.old.deductions_total)}</td></tr>
          <tr><td>Taxable income</td><td className="num">{inr(rc.data.new.taxable_income)}</td><td className="num">{inr(rc.data.old.taxable_income)}</td></tr>
          <tr><td>Tax incl. cess</td><td className={`num ${rc.data.recommended === "new" ? "up" : ""}`}>{inr(rc.data.new.tax.total)}</td><td className={`num ${rc.data.recommended === "old" ? "up" : ""}`}>{inr(rc.data.old.tax.total)}</td></tr></tbody></table>
          <div className="row gap" style={{ marginTop: 10, flexWrap: "wrap" }}><Pill tone="teal">{rc.data.recommended} regime recommended{Number(rc.data.saving) ? ` · saves ${inr(rc.data.saving)}` : " · no difference"}</Pill>{rc.data.recommended !== rc.data.current_regime && <button className="btn btn-s" onClick={addToScenario}>Add to scenario</button>}</div>
          {rc.data.notes.slice(0, 2).map((n: string, i: number) => <div key={i} className="small mute" style={{ marginTop: 4 }}>{n}</div>)}</> : <div className="mute">{rc.loading ? "Comparing…" : rc.error}</div>}
        {err && <div className="err">{err}</div>}
      </Card>
    </div>
    <Card title="Inputs to the projection" action={<button className="btn btn-s" onClick={() => setInc({ entity_id: ents.data?.[0]?.id ?? "", kind: "salary", label: "", annual_amount: "" })}><Plus size={13} /> Income source</button>}>
      <div className="grid-2">
        <div><div className="small mute">Income sources (beyond holdings and leases)</div>{(inputs.data?.income_sources ?? []).map((s: any) => <div key={s.id} className="attn"><span style={{ flex: 1 }}>{s.entity_name} · {s.label} <span className="mute small">({s.kind}{Number(s.growth_pct) ? `, +${s.growth_pct}%/yr` : ""})</span></span><span className="num">{inr(s.annual_amount)}/yr</span></div>)}</div>
        <div><div className="small mute">Advance tax paid this FY</div>{(inputs.data?.advance_tax ?? []).filter((a: any) => a.fy === fy).map((a: any) => <div key={a.id} className="attn"><span style={{ flex: 1 }}>{a.entity_name} · {fmtDate(a.paid_on)} {a.challan && <span className="mute small">· {a.challan}</span>}</span><span className="num">{inr(a.amount)}</span></div>)}
          <div className="small mute" style={{ marginTop: 8 }}>Deductions on file</div>{(inputs.data?.deductions ?? []).filter((d: any) => d.fy === fy).map((d: any) => <div key={d.id} className="attn"><span style={{ flex: 1 }}>{d.entity_name} · {d.code}{d.note ? <span className="mute small"> · {d.note}</span> : null}</span><span className="num">{inr(d.amount)}</span></div>)}</div>
      </div>
    </Card>
    {inc && <Modal title="Add income source" onClose={() => setInc(null)}>
      <div className="grid-2"><Field label="Entity"><select value={inc.entity_id} onChange={(e) => setInc({ ...inc, entity_id: e.target.value })}>{(ents.data ?? []).map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}</select></Field><Field label="Kind"><select value={inc.kind} onChange={(e) => setInc({ ...inc, kind: e.target.value })}>{["salary", "fees", "business", "interest", "dividend", "other"].map((k) => <option key={k}>{k}</option>)}</select></Field><Field label="Label"><input value={inc.label} onChange={(e) => setInc({ ...inc, label: e.target.value })} /></Field><Field label="Annual amount (₹)"><input type="number" value={inc.annual_amount} onChange={(e) => setInc({ ...inc, annual_amount: e.target.value })} /></Field></div>
      <div className="row gap" style={{ justifyContent: "flex-end" }}><button className="btn" onClick={() => setInc(null)}>Cancel</button><button className="btn btn-p" disabled={!inc.label || !inc.annual_amount} onClick={async () => { await api("/tax/inputs/income", { method: "POST", body: JSON.stringify({ ...inc, annual_amount: Number(inc.annual_amount) }) }); setInc(null); inputs.refetch(); proj.refetch(); adv.refetch(); }}>Save</button></div>
    </Modal>}
  </>);
}

function Optimiser({ onChange }: { onChange: () => void }) {
  const list = useApi<any[]>("/tax/suggestions"); const plans = useApi<any[]>("/plans?status=draft");
  const [busy, setBusy] = useState(false); const [err, setErr] = useState("");
  const rerun = async () => { setBusy(true); setErr(""); try { await api("/tax/suggestions", { method: "POST", body: "{}" }); list.refetch(); } catch (e: any) { setErr(e.message); } finally { setBusy(false); } };
  const act = async (id: string, what: "apply" | "dismiss") => { setErr(""); try { const target = what === "apply" && plans.data?.length ? prompt(`Add to which draft? Leave blank for a new one.\n${plans.data.map((p) => `${p.name} → ${p.id}`).join("\n")}`) : ""; await api(`/tax/suggestions/${id}/${what}`, { method: "POST", body: JSON.stringify(target ? { scenario_id: target } : {}) }); list.refetch(); onChange(); } catch (e: any) { setErr(e.message); } };
  if (!list.data) return <Status loading={list.loading} error={list.error} />;
  const total = list.data.reduce((s, x) => s + Number(x.est_saving ?? 0), 0);
  return (
    <Card title="Suggestions against baseline" action={<div className="row gap"><button className="btn btn-s" disabled={busy} onClick={rerun}><RefreshCw size={13} /> {busy ? "Running…" : "Re-run"}</button><span className="small mute">Total identified: {inr(total)} this FY</span></div>}>
      {err && <div className="err">{err}</div>}
      {!list.data.length && <div className="small mute">No open suggestions. Re-run after imports or price updates.</div>}
      {list.data.map((s) => <div key={s.id} className="attn"><div style={{ flex: 1 }}><b>{s.title}</b><div className="small mute">{s.rationale}</div></div><Pill>{s.code.replace(/_/g, " ")}</Pill><span className="num up" style={{ width: 80, textAlign: "right" }}>{inr(s.est_saving)}</span><div className="row gap"><button className="btn btn-s" onClick={() => act(s.id, "apply")}>Add to scenario</button><button className="btn btn-s" onClick={() => act(s.id, "dismiss")}>Dismiss</button></div></div>)}
      <div className="small mute" style={{ marginTop: 10 }}>Rules checked: unused LTCG exemption per entity, loss lots that offset booked gains, lots about to cross the long-term threshold, gains that can be split across FYs, old vs new regime per entity, which entity should hold a new investment (lowest marginal rate, clubbing-safe), 54EC / 54F on property sales, advance-tax shortfalls, NPS 80CCD(1B) and 80G headroom, deferral to next FY.</div>
    </Card>
  );
}

function Execution() {
  const list = useApi<any[]>("/plans");
  const executing = (list.data ?? []).filter((s) => ["executing", "completed"].includes(s.status));
  const [sel, setSel] = useState<string | null>(null);
  const id = sel ?? executing.find((s) => s.status === "executing")?.id ?? executing[0]?.id ?? null;
  const ex = useApi<any>(id ? `/plans/${id}/execution` : null);
  if (!list.data) return <Status loading={list.loading} error={list.error} />;
  const sc = executing.find((s) => s.id === id);
  return (<>
    <div className="kpis" style={{ gridTemplateColumns: "repeat(4,1fr)" }}>
      <Card><div className="mute">Plans executing</div><div className="big-num">{executing.filter((s) => s.status === "executing").length}</div><div className="small mute">{executing.filter((s) => s.status === "executing").map((s) => s.name).join(", ") || "—"}</div></Card>
      <Card><div className="mute">Actions done</div><div className="big-num">{ex.data ? `${ex.data.done} / ${ex.data.total}` : "—"}</div>{ex.data && <div className="prog" style={{ marginTop: 6 }}><div style={{ width: `${ex.data.pct}%`, background: "var(--teal)" }} /></div>}</Card>
      <Card><div className="mute">Planned saving</div><div className="big-num">{ex.data ? inr(ex.data.planned_saving) : "—"}</div></Card>
      <Card><div className="mute">Realised so far</div><div className="big-num up">{ex.data ? inr(ex.data.realised_saving) : "—"}</div><div className="small mute">{ex.data?.next_due ? `next due ${fmtDate(ex.data.next_due)}` : "nothing pending"}</div></Card>
    </div>
    <Card title={sc ? `${sc.name} — execution tracker` : "Execution tracker"} action={executing.length > 1 && <select className="field" style={{ padding: 6 }} value={id ?? ""} onChange={(e) => setSel(e.target.value)}>{executing.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>}>
      {!ex.data ? <div className="mute">{executing.length ? "Loading…" : "Approve a scenario to start tracking its actions."}</div> : <table className="tbl"><thead><tr><th>Action</th><th>Planned</th><th>Actual</th><th className="num">Variance</th><th>Linked task</th><th>Status</th></tr></thead>
        <tbody>{ex.data.actions.map((a: any) => <tr key={a.id}><td><b>{a.task_title ?? KINDS.find(([k]) => k === a.kind)?.[1] ?? a.kind}</b>{a.simulated_effect?.detail && <div className="small mute">{a.simulated_effect.detail}</div>}</td><td className="small">{fmtDate(a.planned_date)}{a.planned_amount ? ` · ${inr(a.planned_amount)}` : ""}</td><td className="small">{a.actual_date ? `${fmtDate(a.actual_date)}${a.actual_amount ? ` · ${inr(a.actual_amount)}` : ""}${a.actual_ref_type ? ` (${a.actual_ref_type.replace("_", " ")})` : ""}` : <span className="mute">—</span>}</td>
          <td className={`num ${a.variance?.breach ? "down" : ""}`}>{a.variance ? `${inr(a.variance.amount ?? 0)} · ${a.variance.days ?? 0} d${a.variance.price_pct ? ` · ${a.variance.price_pct}%` : ""}` : <span className="mute">—</span>}</td>
          <td className="small">{a.task_id ? <span>{a.task_status}{a.task_verification && a.task_verification !== "na" ? ` · ${a.task_verification}` : ""}</span> : <span className="mute">—</span>}</td>
          <td><Pill tone={a.status === "done" ? "teal" : a.status === "in_progress" ? "blue" : undefined}>{a.status}{a.status === "done" && a.task_verification === "verified" ? " · verified" : ""}</Pill></td></tr>)}</tbody></table>}
      <div className="small mute" style={{ marginTop: 10 }}>Actual values come from the next contract-note or CAS import that matches the action (instrument, entity, quantity ± 2%, date ± 10 days). Price ± 5% or date ± 15 days beyond tolerance re-runs the simulation and raises a variance task.</div>
    </Card>
  </>);
}
