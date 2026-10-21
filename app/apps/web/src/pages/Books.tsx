import { useMemo, useState } from "react";
import { BookOpen, Plus, RotateCcw, Play, Lock, Unlock, Download, Upload, Printer, CheckCircle2, Trash2 } from "lucide-react";
import { useApi } from "../lib/useApi";
import { api, apiJson, apiUpload, inr, session, API_URL } from "../lib/api";
import { Card, Pill, Status, fmtDate } from "../components";

const TABS = ["Trial balance", "Journals", "Ledger", "Statements", "Periods & close", "Reconciliation", "Posting rules"] as const;
const inp = { background: "#fff", color: "var(--ink)", borderColor: "var(--line)" } as const;
const FYS = ["2026-27", "2025-26", "2027-28"];
const money = (v: number | string | null | undefined) => (v == null || Number(v) === 0 ? "—" : inr(Number(v)));
const signed = (v: number) => (v < 0 ? `−${inr(-v)}` : inr(v));
const tone = (s: string) => (s === "posted" || s === "locked" || s === "done" || s === "reconciled" ? "teal" : s === "draft" || s === "soft_closed" || s === "no_rule" || s === "account_missing" ? "amber" : s === "reversed" || s === "period_locked" || s === "unbalanced" ? "red" : undefined);
function Field({ label, children }: { label: string; children: React.ReactNode }) { return <label className="field">{label}{children}</label>; }
type Ctx = { entity: string; entityName: string; fy: string; accounts: any[]; refetchBooks: () => void };

export function Books() {
  const ents = useApi<any[]>("/entities"); const books = useApi<any[]>("/gl/books");
  const [ent, setEnt] = useState(""); const [fy, setFy] = useState(FYS[0]); const [tab, setTab] = useState<(typeof TABS)[number]>("Trial balance"); const [err, setErr] = useState("");
  const entity = ent || books.data?.[0]?.entity_id || ""; const book = books.data?.find((b) => b.entity_id === entity);
  const accounts = useApi<any[]>(entity ? `/gl/accounts?entity_id=${entity}&fy=${fy}` : null);
  const open = async (entity_id: string) => { setErr(""); try { await api("/gl/books", { method: "PUT", body: JSON.stringify({ entity_id, books_start_date: "2026-04-01" }) }); books.refetch(); setEnt(entity_id); } catch (e: any) { setErr(e.message); } };
  const ctx: Ctx = { entity, entityName: ents.data?.find((e) => e.id === entity)?.name ?? "", fy, accounts: accounts.data ?? [], refetchBooks: () => { books.refetch(); accounts.refetch(); } };
  return (<>
    <Card title="Books" action={<div className="row gap"><select className="entity" style={inp} value={fy} onChange={(e) => setFy(e.target.value)}>{FYS.map((f) => <option key={f}>FY {f}</option>)}</select><span className="small mute">one book per entity · {book ? `${book.basis} basis · books from ${fmtDate(book.books_start_date)}` : "FY starts April"}</span></div>}>
      <div className="row gap" style={{ flexWrap: "wrap" }}>{(ents.data ?? []).map((e) => { const b = books.data?.find((x) => x.entity_id === e.id); return b ? <button key={e.id} className={`btn btn-s ${entity === e.id ? "btn-p" : ""}`} onClick={() => setEnt(e.id)}>{e.name} <span className="small" style={{ opacity: 0.7 }}>· {b.journals} jnl{Number(b.unposted) ? ` · ${b.unposted} unposted` : ""}{Number(b.drafts) ? ` · ${b.drafts} draft` : ""}</span></button> : <button key={e.id} className="btn btn-s" onClick={() => open(e.id)}><BookOpen size={14} /> Open books — {e.name}</button>; })}</div>
      {book && <div className="small mute" style={{ marginTop: 8 }}>{book.maker_checker ? "Maker-checker on: journals wait for a second person. " : ""}{book.strict_reconciliation ? "Locking a period requires a reconciled bank. " : ""}Posted journals are immutable — corrections are reversals.</div>}
      {err && <div className="err" style={{ marginTop: 8 }}>{err}</div>}
    </Card>
    {entity && <>
      <div className="tabs">{TABS.map((t) => <button key={t} className={tab === t ? "on" : ""} onClick={() => setTab(t)}>{t}</button>)}</div>
      {tab === "Trial balance" && <TrialBalance key={`${entity}${fy}`} ctx={ctx} book={book} />}
      {tab === "Journals" && <Journals key={`${entity}${fy}`} ctx={ctx} book={book} />}
      {tab === "Ledger" && <Ledger key={`${entity}${fy}`} ctx={ctx} />}
      {tab === "Statements" && <Statements key={`${entity}${fy}`} ctx={ctx} />}
      {tab === "Periods & close" && <Periods key={`${entity}${fy}`} ctx={ctx} />}
      {tab === "Reconciliation" && <Reconciliation key={entity} ctx={ctx} />}
      {tab === "Posting rules" && <Rules key={entity} ctx={ctx} book={book} />}
    </>}
  </>);
}

function useAction(after?: () => void) {
  const [busy, setBusy] = useState(""); const [err, setErr] = useState(""); const [note, setNote] = useState("");
  const run = async (label: string, fn: () => Promise<string | void>) => { setBusy(label); setErr(""); setNote(""); try { const n = await fn(); if (n) setNote(n); after?.(); } catch (e: any) { setErr(e.message); } finally { setBusy(""); } };
  return { busy, err, note, run, msg: <>{err && <div className="err">{err}</div>}{note && <div className="small" style={{ color: "var(--teal)" }}>{note}</div>}</> };
}

// ---------- Trial balance ----------
function TrialBalance({ ctx, book }: { ctx: Ctx; book: any }) {
  const tb = useApi<any[]>(`/gl/reports/trial-balance?entity_id=${ctx.entity}&fy=${ctx.fy}`); const act = useAction(() => { tb.refetch(); ctx.refetchBooks(); });
  const [preview, setPreview] = useState<any>(null);
  const dr = (tb.data ?? []).reduce((s, r) => s + r.debit, 0), cr = (tb.data ?? []).reduce((s, r) => s + r.credit, 0);
  if (!tb.data) return <Status loading={tb.loading} error={tb.error} />;
  return (<>
    <Card title={`Trial balance — ${ctx.entityName} · FY ${ctx.fy}`} action={<div className="row gap"><Pill tone={Math.abs(dr - cr) < 0.01 ? "teal" : "red"}>{Math.abs(dr - cr) < 0.01 ? "Balanced" : "Unbalanced"}</Pill>{Number(book?.unposted) > 0 && <Pill tone="amber">{book.unposted} unposted</Pill>}
      <button className="btn btn-s" disabled={!!act.busy} onClick={() => act.run("post", async () => { const r: any = await api("/gl/unposted", { method: "POST", body: JSON.stringify({ entity_id: ctx.entity }) }); return `${r.posted} posted · ${r.queued} queued · ${r.skipped} already in the books`; })}><Play size={14} /> Post pending events</button>
      <button className="btn btn-s" disabled={!!act.busy} onClick={() => act.run("preview", async () => { setPreview(await api(`/gl/opening-balances/preview?entity_id=${ctx.entity}&as_of=${book?.books_start_date ?? "2026-04-01"}`)); })}>Opening balances</button></div>}>
      {act.msg}
      {preview && <div style={{ border: "1px solid var(--line)", borderRadius: 8, padding: 12, marginBottom: 12 }}>
        <div className="row" style={{ justifyContent: "space-between" }}><b>Opening balances from platform data as at {fmtDate(preview.as_of)}</b><span className="row gap"><Pill tone={Math.abs(preview.debit - preview.credit) < 0.01 ? "teal" : "red"}>Dr {inr(preview.debit)} · Cr {inr(preview.credit)}</Pill>
          <button className="btn btn-p" disabled={!!act.busy} onClick={() => act.run("opening", async () => { const j: any = await api("/gl/opening-balances", { method: "PUT", body: JSON.stringify({ entity_id: ctx.entity, as_of: preview.as_of, generate_from_platform: true }) }); setPreview(null); return `Opening journal #${j.journal_no} ${j.status}`; })}>Post opening journal</button><button className="btn btn-s" onClick={() => setPreview(null)}>Close</button></span></div>
        <table className="tbl"><thead><tr><th>Account</th><th>Item</th><th className="num">Debit</th><th className="num">Credit</th></tr></thead><tbody>{preview.lines.map((l: any, i: number) => <tr key={i}><td>{l.account_code}</td><td>{l.label}</td><td className="num">{money(l.debit)}</td><td className="num">{money(l.credit)}</td></tr>)}</tbody></table>
        <div className="small mute" style={{ marginTop: 6 }}>Holdings at lot cost, private investments and property at cost (plus capital improvements), bank balances rolled back to the date, tenant deposits and loans outstanding; the balancing figure is opening capital. If an opening journal is already posted, reverse it first.</div>
      </div>}
      <table className="tbl"><thead><tr><th>Code</th><th>Account</th><th>Type</th><th className="num">Opening</th><th className="num">Debit</th><th className="num">Credit</th><th className="num">Closing</th></tr></thead>
        <tbody>{tb.data.map((r) => <tr key={r.code}><td>{r.code}</td><td>{r.name}</td><td className="small mute">{r.type}</td><td className="num">{r.opening ? signed(r.opening) : "—"}</td><td className="num">{money(r.debit)}</td><td className="num">{money(r.credit)}</td><td className="num"><b>{r.closing ? signed(r.closing) : "—"}</b></td></tr>)}
          <tr><td colSpan={4}><b>Total</b></td><td className="num"><b>{inr(dr)}</b></td><td className="num"><b>{inr(cr)}</b></td><td /></tr></tbody></table>
      <div className="small mute" style={{ marginTop: 8 }}>Investments at cost (12xx) tie to holdings cost, 1110 ties to the bank sub-ledgers, 1410 clears when rent is received. Debit balances positive, credit balances negative in the closing column.</div>
    </Card>
  </>);
}

// ---------- Journals ----------
function Journals({ ctx, book }: { ctx: Ctx; book: any }) {
  const [src, setSrc] = useState(""); const [status, setStatus] = useState("");
  const jn = useApi<any>(`/gl/journals?entity_id=${ctx.entity}&fy=${ctx.fy}${src ? `&source=${src}` : ""}${status ? `&status=${status}` : ""}&limit=300`);
  const [open, setOpen] = useState<any>(null); const [creating, setCreating] = useState(false); const [reason, setReason] = useState("");
  const [f, setF] = useState<any>({ entry_date: new Date().toISOString().slice(0, 10), narration: "", lines: [{ account_code: "", debit: "", credit: "" }, { account_code: "", debit: "", credit: "" }] });
  const act = useAction(() => { jn.refetch(); ctx.refetchBooks(); });
  const me = session.get()?.user.id; const leaf = ctx.accounts.filter((a) => !a.is_group && a.active);
  const setLine = (i: number, k: string, v: string) => setF({ ...f, lines: f.lines.map((l: any, j: number) => (j === i ? { ...l, [k]: v } : l)) });
  const d = f.lines.reduce((s: number, l: any) => s + Number(l.debit || 0), 0), c = f.lines.reduce((s: number, l: any) => s + Number(l.credit || 0), 0);
  if (!jn.data) return <Status loading={jn.loading} error={jn.error} />;
  return (<div className="grid-2" style={{ alignItems: "start" }}>
    <Card title="Day book" action={<div className="row gap"><select style={inp} value={src} onChange={(e) => setSrc(e.target.value)}><option value="">all sources</option>{["auto", "manual", "recurring", "opening", "closing", "reversal", "tally_import"].map((s) => <option key={s}>{s}</option>)}</select><select style={inp} value={status} onChange={(e) => setStatus(e.target.value)}><option value="">any status</option>{["posted", "draft", "reversed"].map((s) => <option key={s}>{s}</option>)}</select><button className="btn btn-p" onClick={() => { setCreating(true); setOpen(null); }}><Plus size={14} /> Manual journal</button></div>}>
      {act.msg}
      {jn.data.items.length === 0 && <div className="small mute">No journals yet — post the opening balances and pending events from the Trial balance tab.</div>}
      {jn.data.items.map((j: any) => <div key={j.id} className="attn" style={{ cursor: "pointer", background: open?.id === j.id ? "#F6F8FB" : undefined }} onClick={() => { setOpen(j); setCreating(false); }}>
        <span style={{ flex: 1 }}><b>#{j.journal_no}</b> · {j.narration}<div className="small mute">{fmtDate(j.entry_date)} · source: {j.source_type ?? j.source}{j.posted_by_name ? ` · ${j.posted_by_name}` : ""}</div></span>
        <span className="num">{inr(j.lines.reduce((s: number, l: any) => s + Number(l.debit), 0))}</span><Pill tone={tone(j.status)}>{j.status}</Pill></div>)}
    </Card>
    {creating && <Card title="Manual journal" action={<span className="small mute">{book?.maker_checker ? "lands as a draft for a second person" : "posts immediately"}</span>}>
      <div className="row gap" style={{ flexWrap: "wrap", alignItems: "flex-end" }}><Field label="Date"><input type="date" style={inp} value={f.entry_date} onChange={(e) => setF({ ...f, entry_date: e.target.value })} /></Field><Field label="Narration"><input style={{ ...inp, minWidth: 260 }} value={f.narration} onChange={(e) => setF({ ...f, narration: e.target.value })} /></Field></div>
      <table className="tbl"><thead><tr><th>Account</th><th className="num">Debit</th><th className="num">Credit</th><th /></tr></thead><tbody>{f.lines.map((l: any, i: number) => <tr key={i}>
        <td><select style={inp} value={l.account_code} onChange={(e) => setLine(i, "account_code", e.target.value)}><option value="">—</option>{leaf.map((a) => <option key={a.code} value={a.code}>{a.code} {a.name}</option>)}</select></td>
        <td className="num"><input type="number" style={{ ...inp, width: 110 }} value={l.debit} onChange={(e) => setLine(i, "debit", e.target.value)} /></td><td className="num"><input type="number" style={{ ...inp, width: 110 }} value={l.credit} onChange={(e) => setLine(i, "credit", e.target.value)} /></td>
        <td><button className="btn btn-s" onClick={() => setF({ ...f, lines: f.lines.filter((_: any, j: number) => j !== i) })}><Trash2 size={12} /></button></td></tr>)}
        <tr><td><button className="btn btn-s" onClick={() => setF({ ...f, lines: [...f.lines, { account_code: "", debit: "", credit: "" }] })}><Plus size={12} /> line</button></td><td className="num"><b>{inr(d)}</b></td><td className="num"><b>{inr(c)}</b></td><td>{Math.abs(d - c) > 0.005 && <Pill tone="red">off by {inr(Math.abs(d - c))}</Pill>}</td></tr></tbody></table>
      <div className="row gap" style={{ marginTop: 8 }}><button className="btn btn-p" disabled={!!act.busy || !f.narration || Math.abs(d - c) > 0.005 || d === 0} onClick={() => act.run("post", async () => { const j: any = await api("/gl/journals", { method: "POST", body: JSON.stringify({ entity_id: ctx.entity, entry_date: f.entry_date, narration: f.narration, lines: f.lines.filter((l: any) => l.account_code).map((l: any) => ({ account_code: l.account_code, debit: Number(l.debit || 0), credit: Number(l.credit || 0) })) }) }); setCreating(false); setOpen(j); return `Journal #${j.journal_no} ${j.status}`; })}>Post</button><button className="btn btn-s" onClick={() => setCreating(false)}>Cancel</button></div>
    </Card>}
    {open && !creating && <Card title={`#${open.journal_no} · ${open.narration}`} action={<div className="row gap"><Pill tone={tone(open.status)}>{open.status}</Pill>
      {open.status === "draft" && <button className="btn btn-p" disabled={!!act.busy || open.posted_by === me} title={open.posted_by === me ? "Maker cannot approve their own draft" : ""} onClick={() => act.run("approve", async () => { const j: any = await api(`/gl/journals/${open.id}/approve`, { method: "POST" }); setOpen(j); return "Approved and posted"; })}><CheckCircle2 size={14} /> Approve</button>}
      {open.status === "posted" && <button className="btn btn-s" disabled={!!act.busy} onClick={() => act.run("reverse", async () => { const r: any = await api(`/gl/journals/${open.id}/reverse`, { method: "POST", body: JSON.stringify({ reason: reason || undefined }) }); setOpen(r); setReason(""); return `Reversal #${r.journal_no} posted`; })}><RotateCcw size={14} /> Reverse</button>}</div>}>
      <div className="small mute" style={{ marginBottom: 6 }}>{fmtDate(open.entry_date)} · {open.source} · {open.source_type}{open.posted_by_name ? ` · by ${open.posted_by_name}` : ""}{open.approved_by_name ? ` · approved by ${open.approved_by_name}` : ""}{open.reverses_journal_id ? " · reverses an earlier journal" : ""}{open.reversed_by_journal_id ? " · reversed" : ""}</div>
      <table className="tbl"><thead><tr><th>Account</th><th>Sub-ledger</th><th className="num">Debit</th><th className="num">Credit</th></tr></thead><tbody>{open.lines.map((l: any) => <tr key={l.line_no}><td>{l.account_code} {l.account_name}{l.narration ? <div className="small mute">{l.narration}</div> : null}</td><td className="small mute">{l.sub_ledger_type ? `${l.sub_ledger_type} ${String(l.sub_ledger_id).slice(0, 8)}` : ""}</td><td className="num">{money(l.debit)}</td><td className="num">{money(l.credit)}</td></tr>)}</tbody></table>
      {open.status === "posted" && <div className="row gap" style={{ marginTop: 8 }}><Field label="Reversal reason"><input style={{ ...inp, minWidth: 240 }} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="posted twice / wrong account…" /></Field></div>}
      <div className="small mute" style={{ marginTop: 8 }}>{open.source === "auto" ? `Posted by rule ${open.source_type} from the source record. Posted journals are immutable — corrections are reversals; a reversed auto journal returns to the unposted queue.` : open.source === "opening" ? "Opening balances from platform data." : "Manual journal" + (book?.maker_checker ? " under maker-checker." : ".")}</div>
    </Card>}
  </div>);
}

// ---------- Ledger ----------
function Ledger({ ctx }: { ctx: Ctx }) {
  const [mode, setMode] = useState<"account" | "bank_account" | "holding" | "property" | "entity">("account"); const [id, setId] = useState("");
  const [from, setFrom] = useState(`${ctx.fy.slice(0, 4)}-04-01`), [to, setTo] = useState(`${Number(ctx.fy.slice(0, 4)) + 1}-03-31`);
  const banks = useApi<any[]>("/bank-accounts"); const holdings = useApi<any[]>("/holdings"); const props = useApi<any[]>("/properties"); const ents = useApi<any[]>("/entities");
  const options = useMemo(() => mode === "account" ? ctx.accounts.filter((a) => !a.is_group).map((a) => [a.id, `${a.code} ${a.name}`]) : mode === "bank_account" ? (banks.data ?? []).filter((b) => b.entity_id === ctx.entity).map((b) => [b.id, `${b.bank} ${b.account_masked ?? ""}`]) : mode === "holding" ? (holdings.data ?? []).filter((h) => h.entity_id === ctx.entity).map((h) => [h.id, h.instrument ?? h.symbol]) : mode === "property" ? (props.data ?? []).map((p) => [p.id, p.name]) : (ents.data ?? []).filter((e) => e.id !== ctx.entity).map((e) => [e.id, e.name]), [mode, ctx.accounts, banks.data, holdings.data, props.data, ents.data, ctx.entity]);
  const url = id ? `/gl/reports/ledger?entity_id=${ctx.entity}&${mode === "account" ? `account_id=${id}` : `sub_ledger_type=${mode}&sub_ledger_id=${id}`}&from=${from}&to=${to}` : null;
  const led = useApi<any>(url);
  return (<Card title="Ledger" action={<div className="row gap" style={{ flexWrap: "wrap" }}><select style={inp} value={mode} onChange={(e) => { setMode(e.target.value as any); setId(""); }}>{[["account", "Account"], ["bank_account", "Bank account"], ["holding", "Holding"], ["property", "Property"], ["entity", "Inter-entity"]].map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
    <select style={{ ...inp, maxWidth: 320 }} value={id} onChange={(e) => setId(e.target.value)}><option value="">choose…</option>{options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select><input type="date" style={inp} value={from} onChange={(e) => setFrom(e.target.value)} /><input type="date" style={inp} value={to} onChange={(e) => setTo(e.target.value)} /></div>}>
    {!id && <div className="small mute">Pick an account, or a sub-ledger (bank account, holding, property, other entity) to see its running balance.</div>}
    {id && led.data && <>
      <table className="tbl"><thead><tr><th>Date</th><th>Jnl</th><th>Narration</th><th>Account</th><th className="num">Debit</th><th className="num">Credit</th><th className="num">Balance</th></tr></thead>
        <tbody><tr><td colSpan={6}><i>Opening balance</i></td><td className="num">{signed(led.data.opening)}</td></tr>
          {led.data.rows.map((r: any, i: number) => <tr key={i}><td>{fmtDate(r.date)}</td><td>#{r.journal_no}</td><td>{r.narration}</td><td className="small mute">{r.account_code}</td><td className="num">{money(r.debit)}</td><td className="num">{money(r.credit)}</td><td className="num">{signed(r.balance)}</td></tr>)}
          <tr><td colSpan={6}><b>Closing balance</b></td><td className="num"><b>{signed(led.data.closing)}</b></td></tr></tbody></table></>}
    {id && !led.data && <Status loading={led.loading} error={led.error} />}
  </Card>);
}

// ---------- Statements ----------
function Statements({ ctx }: { ctx: Ctx }) {
  const [cons, setCons] = useState(false); const scope = cons ? "consolidated=true" : `entity_id=${ctx.entity}`; const q = `${scope}&fy=${ctx.fy}`;
  const pl = useApi<any>(`/gl/reports/profit-loss?${q}`); const bs = useApi<any>(`/gl/reports/balance-sheet?${q}`); const cap = useApi<any>(`/gl/reports/capital-account?${q}`); const cf = useApi<any>(`/gl/reports/cash-flow?${q}`); const itr = useApi<any[]>(`/gl/reports/itr-mapping?entity_id=${ctx.entity}&fy=${ctx.fy}`);
  const Sec = ({ s, prior }: { s: any; prior?: boolean }) => (<><tr><td colSpan={prior ? 3 : 2}><b>{s.title}</b></td></tr>{s.rows.map((r: any) => <tr key={r.code + r.name}><td style={{ paddingLeft: 18 }}>{r.code !== "—" ? `${r.code} ` : ""}{r.name}</td><td className="num">{signed(r.amount)}</td>{prior && <td className="num mute">{r.prior != null ? signed(r.prior) : ""}</td>}</tr>)}<tr><td style={{ paddingLeft: 18 }}><i>Total {s.title.toLowerCase()}</i></td><td className="num"><b>{signed(s.total)}</b></td>{prior && <td className="num mute">{s.prior != null ? signed(s.prior) : ""}</td>}</tr></>);
  const title = cons ? "Consolidated (all books, inter-entity balances eliminated)" : ctx.entityName;
  return (<>
    <div className="row gap" style={{ justifyContent: "flex-end", margin: "8px 0" }}><label className="row gap small"><input type="checkbox" checked={cons} onChange={(e) => setCons(e.target.checked)} /> consolidated</label><button className="btn btn-s" onClick={() => window.print()}><Printer size={14} /> Print / PDF</button></div>
    <div className="grid-2" style={{ alignItems: "start" }}>
      <Card title={`Income & expenditure — ${title} · FY ${ctx.fy}`} action={pl.data && <Pill tone={pl.data.total >= 0 ? "teal" : "red"}>surplus {signed(pl.data.total)}</Pill>}>
        {pl.data ? <table className="tbl"><thead><tr><th /><th className="num">FY {ctx.fy}</th><th className="num">prior</th></tr></thead><tbody>{pl.data.sections.map((s: any) => <Sec key={s.title} s={s} prior />)}<tr><td><b>Surplus / (deficit)</b></td><td className="num"><b>{signed(pl.data.total)}</b></td><td className="num mute">{signed(pl.data.prior_total)}</td></tr></tbody></table> : <Status loading={pl.loading} error={pl.error} />}
        <div className="small mute" style={{ marginTop: 6 }}>Rental income is gross; the 30% standard deduction and municipal taxes are applied in the tax module. Capital gains are shown as realised.</div>
      </Card>
      <Card title={`Balance sheet — ${title} · ${bs.data ? fmtDate(bs.data.as_of) : ""}`} action={bs.data && <div className="row gap">{bs.data.consolidated && <Pill>eliminated {inr(bs.data.eliminations)}</Pill>}<Pill tone={bs.data.balances ? "teal" : "red"}>{bs.data.balances ? "balances" : "does not balance"}</Pill></div>}>
        {bs.data ? <table className="tbl"><tbody>{bs.data.sections.map((s: any) => <Sec key={s.title} s={s} />)}</tbody></table> : <Status loading={bs.loading} error={bs.error} />}
        <div className="small mute" style={{ marginTop: 6 }}>Books carry investments at cost; the dashboard's net worth uses market value.</div>
      </Card>
      <Card title="Capital account" action={cap.data && <Pill>{signed(cap.data.total)}</Pill>}>
        {cap.data ? <><table className="tbl"><thead><tr><th>Account</th><th className="num">Opening</th><th className="num">Additions</th><th className="num">Drawings</th><th className="num">Closing</th></tr></thead><tbody>{cap.data.sections[0].rows.map((r: any) => <tr key={r.code}><td>{r.code} {r.name}</td><td className="num">{signed(r.opening)}</td><td className="num">{money(r.additions)}</td><td className="num">{money(r.drawings)}</td><td className="num">{signed(r.amount)}</td></tr>)}<tr><td>Surplus for the year</td><td /><td /><td /><td className="num">{signed(cap.data.sections[1].total)}</td></tr></tbody></table>
          {cap.data.partners.length > 0 && <div style={{ marginTop: 8 }}><b className="small">Profit-sharing</b>{cap.data.partners.map((p: any) => <div key={p.partner} className="attn"><span style={{ flex: 1 }}>{p.partner}</span><span className="small mute">{p.share_pct}%</span><span className="num">{signed(p.share_of_surplus)}</span></div>)}</div>}</> : <Status loading={cap.loading} error={cap.error} />}
      </Card>
      <Card title="Cash & fund flow" action={cf.data && <Pill>{inr(cf.data.opening_cash)} → {inr(cf.data.closing_cash)}</Pill>}>
        {cf.data ? <table className="tbl"><tbody>{cf.data.sections.map((s: any) => <Sec key={s.title} s={s} />)}<tr><td><b>Net movement in cash</b></td><td className="num"><b>{signed(cf.data.total)}</b></td></tr></tbody></table> : <Status loading={cf.loading} error={cf.error} />}
      </Card>
    </div>
    <Card title={`ITR mapping — ${ctx.entityName} · FY ${ctx.fy}`} action={<span className="small mute">books vs tax engine</span>}>
      {itr.data ? <table className="tbl"><thead><tr><th>Head</th><th className="num">Books</th><th className="num">Tax engine</th><th className="num">Difference</th><th>Why they differ</th></tr></thead><tbody>{itr.data.map((r) => <tr key={r.tax_head}><td>{r.tax_head.replace(/_/g, " ")}</td><td className="num">{signed(r.gl_amount)}</td><td className="num">{r.tax_engine_amount == null ? "—" : signed(r.tax_engine_amount)}</td><td className="num">{r.difference == null ? "—" : signed(r.difference)}</td><td className="small mute">{r.note}</td></tr>)}</tbody></table> : <Status loading={itr.loading} error={itr.error} />}
    </Card>
  </>);
}

// ---------- Periods & close ----------
function Periods({ ctx }: { ctx: Ctx }) {
  const pr = useApi<any[]>(`/gl/periods?entity_id=${ctx.entity}`); const act = useAction(() => { pr.refetch(); ctx.refetchBooks(); }); const [closing, setClosing] = useState(false); const [result, setResult] = useState<any>(null);
  const setStatus = (p: any, status: string) => act.run(p.id, async () => { const reason = status === "open" && p.status === "locked" ? window.prompt("Reason for reopening a locked period") ?? "" : undefined; if (status === "open" && p.status === "locked" && !reason) return; await api(`/gl/periods/${p.id}/status`, { method: "POST", body: JSON.stringify({ status, reason }) }); });
  if (!pr.data) return <Status loading={pr.loading} error={pr.error} />;
  const fys = [...new Set(pr.data.map((p) => p.fy))];
  return (<><Card title={`Periods — ${ctx.entityName}`} action={<button className="btn btn-p" disabled={!!act.busy} onClick={() => setClosing(true)}><Lock size={14} /> Year-end close FY {ctx.fy}</button>}>
    {act.msg}
    {closing && <div style={{ border: "1px solid var(--line)", borderRadius: 8, padding: 12, marginBottom: 12 }}><b>Close FY {ctx.fy}?</b><div className="small mute">Income and expense accounts close to capital (partner capital by profit share where partners are defined), every period in the year locks and next year's quarters open. Requires zero unposted events.</div>
      <div className="row gap" style={{ marginTop: 8 }}><button className="btn btn-p" disabled={!!act.busy} onClick={() => act.run("close", async () => { const r: any = await api("/gl/year-end-close", { method: "POST", body: JSON.stringify({ entity_id: ctx.entity, fy: ctx.fy }) }); setResult(r); setClosing(false); return `FY ${r.fy} closed — surplus ${signed(r.surplus)} to ${r.partners.length ? "partner capital" : "capital"}`; })}>Close the year</button><button className="btn btn-s" onClick={() => setClosing(false)}>Cancel</button></div></div>}
    {result && <div className="small" style={{ marginBottom: 8 }}>Closing journal #{result.journal?.journal_no}: {result.partners.map((p: any) => `${p.partner} ${p.share_pct}% ${signed(p.amount)}`).join(" · ") || `surplus ${signed(result.surplus)} to capital`} · next FY {result.next_fy} opened.</div>}
    <table className="tbl"><thead><tr><th>FY</th><th>Period</th><th>Status</th><th>Closed by</th><th>Preconditions</th><th /></tr></thead><tbody>
      {fys.map((fy) => pr.data!.filter((p) => p.fy === fy).map((p) => <tr key={p.id}><td>{p.fy}</td><td>{fmtDate(p.period_start)} – {fmtDate(p.period_end)}</td><td><Pill tone={tone(p.status)}>{p.status.replace("_", " ")}</Pill></td><td className="small mute">{p.closed_by_name ? `${p.closed_by_name} · ${fmtDate(p.closed_at)}` : "—"}</td>
        <td className="small">{Number(p.unposted) ? <Pill tone="amber">{p.unposted} unposted</Pill> : <span className="mute">0 unposted</span>}{Number(p.drafts) ? <> <Pill tone="amber">{p.drafts} draft</Pill></> : null}</td>
        <td className="row gap" style={{ justifyContent: "flex-end" }}>{p.status === "open" && <button className="btn btn-s" disabled={!!act.busy} onClick={() => setStatus(p, "soft_closed")}>Soft close</button>}{p.status !== "locked" && <button className="btn btn-s" disabled={!!act.busy} onClick={() => setStatus(p, "locked")}><Lock size={12} /> Lock</button>}{p.status !== "open" && <button className="btn btn-s" disabled={!!act.busy} onClick={() => setStatus(p, "open")}><Unlock size={12} /> Reopen</button>}</td></tr>))}
    </tbody></table>
    <div className="small mute" style={{ marginTop: 8 }}>Locking requires zero unposted events and no drafts inside the period (and a reconciled bank when the book is set to strict reconciliation); the database rejects any posting dated inside a locked period. Reopening a locked period needs an owner and a reason.</div>
  </Card><PeriodEnd ctx={ctx} periods={pr.data} onPosted={() => { pr.refetch(); ctx.refetchBooks(); }} /></>);
}

/** Period-end residue (FO-118 / 119): MTM against the unrealised reserve (or P&L) and depreciation from depreciation_rates, per period. */
function PeriodEnd({ ctx, periods, onPosted }: { ctx: Ctx; periods: any[]; onPosted: () => void }) {
  const asOf = new Date().toISOString().slice(0, 10); const pv = useApi<any>(`/gl/period-end/preview?entity_id=${ctx.entity}&as_of=${asOf}&fy=${ctx.fy}`); const act = useAction(() => { pv.refetch(); onPosted(); });
  const [period, setPeriod] = useState(""); const [what, setWhat] = useState<"both" | "mtm" | "depreciation">("both");
  if (!pv.data) return <Status loading={pv.loading} error={pv.error} />;
  const m = pv.data.mtm, d = pv.data.depreciation; const open = periods.filter((p) => p.fy === ctx.fy); const pid = period || open.find((p) => p.status === "open")?.id || "";
  return (<Card title="Period-end: mark-to-market and depreciation" action={<div className="row gap"><select style={inp} value={pid} onChange={(e) => setPeriod(e.target.value)}>{open.map((p) => <option key={p.id} value={p.id}>{fmtDate(p.period_start)} – {fmtDate(p.period_end)} · {p.status.replace("_", " ")}</option>)}</select><select style={inp} value={what} onChange={(e) => setWhat(e.target.value as any)}><option value="both">both</option><option value="mtm">MTM only</option><option value="depreciation">depreciation only</option></select><button className="btn btn-p" disabled={!pid || !!act.busy} onClick={() => act.run("post", async () => { const r: any = await api("/gl/period-end/post", { method: "POST", body: JSON.stringify({ entity_id: ctx.entity, period_id: pid, what }) }); const bits = []; if (r.depreciation) bits.push(r.depreciation.already ? "depreciation already posted" : r.depreciation.journal ? `depreciation #${r.depreciation.journal.journal_no}` : r.depreciation.note); if (r.mtm) bits.push(r.mtm.already ? "MTM already posted" : r.mtm.journal ? `MTM #${r.mtm.journal.journal_no}` : r.mtm.note); return bits.join(" · "); })}>Post for period</button></div>}>
    {act.msg}
    <div className="grid-2">
      <div><b>Mark-to-market as of {m.as_of}</b> <Pill tone={m.enabled ? "teal" : undefined}>{m.enabled ? `on · ${m.treatment}` : "off for this book"}</Pill>
        <table className="tbl tight" style={{ marginTop: 6 }}><thead><tr><th>Account</th><th className="num">Book</th><th className="num">Market</th><th className="num">Adjustment</th></tr></thead><tbody>{m.rows.map((r: any) => <tr key={r.account_code}><td>{r.account_code} {ctx.accounts.find((a) => a.code === r.account_code)?.name ?? ""}{r.unpriced ? <span className="small mute"> · {r.unpriced} unpriced at cost</span> : null}</td><td className="num">{inr(r.book_balance)}</td><td className="num">{inr(r.market_value)}</td><td className="num" style={{ color: Number(r.adjustment) >= 0 ? "var(--teal)" : "var(--red)" }}>{signed(r.adjustment)}</td></tr>)}{!m.rows.length && <tr><td colSpan={4} className="mute small">No priced holdings on this entity.</td></tr>}</tbody></table>
        <div className="small mute" style={{ marginTop: 6 }}>Total {signed(m.total_adjustment)} · {m.note}</div></div>
      <div><b>Depreciation FY {d.fy}</b> <Pill tone={d.enabled ? "teal" : undefined}>{d.enabled ? "on" : "off for this book"}</Pill>
        <table className="tbl tight" style={{ marginTop: 6 }}><thead><tr><th>Asset</th><th className="num">Rate</th><th className="num">Opening WDV</th><th className="num">Charge / yr</th><th className="num">Posted</th></tr></thead><tbody>{d.rows.map((r: any) => <tr key={r.asset_id}><td>{r.name}<div className="small mute">{r.kind.replace(/_/g, " ")} · {r.method.toUpperCase()} · from {fmtDate(r.acquired_on)}</div></td><td className="num">{r.depreciable ? `${r.rate_pct}%` : "—"}</td><td className="num">{inr(r.opening_wdv)}</td><td className="num">{inr(r.charge_for_year)}</td><td className="num">{inr(r.posted_this_fy)}</td></tr>)}{!d.rows.length && <tr><td colSpan={5} className="mute small">No lifestyle assets or capital improvements on this entity.</td></tr>}</tbody></table>
        <div className="small mute" style={{ marginTop: 6 }}>Total for the year {inr(d.total_for_year)} · {d.source}. Art, jewellery and collectibles carry a 0% rate (capital assets).</div></div>
    </div>
    <div className="small mute" style={{ marginTop: 8 }}>A soft close or lock posts both automatically when the book asks for them (Books → settings: mark-to-market, depreciation); posting here is the same journal, once per period.</div>
  </Card>);
}

// ---------- Reconciliation ----------
function Reconciliation({ ctx }: { ctx: Ctx }) {
  const banks = useApi<any[]>("/bank-accounts"); const mine = (banks.data ?? []).filter((b) => b.entity_id === ctx.entity && b.type !== "card"); const [bank, setBank] = useState("");
  const bankId = bank || mine[0]?.id || ""; const asOf = new Date().toISOString().slice(0, 10);
  const rb = useApi<any>(bankId ? `/gl/reconcile/bank?bank_account_id=${bankId}&as_of=${asOf}` : null); const ri = useApi<any>(`/gl/reconcile/investments?entity_id=${ctx.entity}`); const un = useApi<any[]>(`/gl/unposted?entity_id=${ctx.entity}`);
  const act = useAction(() => { un.refetch(); rb.refetch(); ri.refetch(); ctx.refetchBooks(); });
  return (<>
    {act.msg}
    <div className="grid-2" style={{ alignItems: "start" }}>
      <Card title="Bank" action={<div className="row gap"><select style={inp} value={bankId} onChange={(e) => setBank(e.target.value)}>{mine.map((b) => <option key={b.id} value={b.id}>{b.bank} {b.account_masked ?? ""}</option>)}</select>{rb.data && <Pill tone={rb.data.reconciled ? "teal" : "amber"}>{rb.data.reconciled ? "reconciled" : `difference ${signed(rb.data.difference)}`}</Pill>}</div>}>
        {rb.data ? <>
          <div className="kpis" style={{ gridTemplateColumns: "repeat(4,1fr)" }}><div className="card"><div className="small mute">Ledger balance (1110)</div><div className="big-num">{inr(rb.data.ledger_balance)}</div></div><div className="card"><div className="small mute">Statement balance</div><div className="big-num">{inr(rb.data.statement_balance)}</div></div><div className="card"><div className="small mute">Unmatched in statement</div><div className="big-num">{rb.data.unmatched_in_statement.length}</div></div><div className="card"><div className="small mute">Manual entries on this bank</div><div className="big-num">{rb.data.unmatched_in_ledger.length}</div></div></div>
          {rb.data.unmatched_in_statement.length > 0 && <><div className="small" style={{ marginTop: 8 }}><b>Statement lines without a journal</b> — categorise them in Banking and post pending events</div>{rb.data.unmatched_in_statement.slice(0, 12).map((t: any) => <div key={t.id} className="attn"><span className="small mute">{fmtDate(t.txn_date)}</span><span style={{ flex: 1 }}>{t.narration}</span><span className="num">{signed(t.amount)}</span></div>)}</>}
          {rb.data.unmatched_in_ledger.length > 0 && <><div className="small" style={{ marginTop: 8 }}><b>Manual / recurring journals on this bank</b> — confirm each against the statement</div>{rb.data.unmatched_in_ledger.map((l: any) => <div key={l.journal_id} className="attn"><span className="small mute">{fmtDate(l.entry_date)} #{l.journal_no}</span><span style={{ flex: 1 }}>{l.narration}</span><span className="num">{l.debit ? inr(l.debit) : `−${inr(l.credit)}`}</span></div>)}</>}
        </> : <Status loading={rb.loading} error={rb.error ?? (mine.length ? null : "No bank account on this entity")} />}
      </Card>
      <Card title="Investments — book cost vs holdings" action={ri.data && <Pill tone={ri.data.differences ? "amber" : "teal"}>{ri.data.differences ? `${ri.data.differences} difference${ri.data.differences > 1 ? "s" : ""}` : "ties"}</Pill>}>
        {ri.data ? <table className="tbl"><thead><tr><th>Instrument</th><th className="num">Book cost</th><th className="num">Holdings cost</th><th className="num">Diff</th></tr></thead><tbody>{ri.data.rows.map((r: any) => <tr key={r.holding_id ?? r.private_investment_id}><td>{r.name}</td><td className="num">{inr(r.book_cost)}</td><td className="num">{inr(r.holdings_cost ?? r.cost)}</td><td className="num" style={{ color: Math.abs(r.difference) >= 0.01 ? "var(--amber)" : undefined }}>{Math.abs(r.difference) < 0.01 ? "₹0" : signed(r.difference)}</td></tr>)}</tbody></table> : <Status loading={ri.loading} error={ri.error} />}
        <div className="small mute" style={{ marginTop: 6 }}>Book cost is the holding sub-ledger on 12xx; holdings cost is the remaining lots. A difference usually means a corporate action or an import that has not posted yet.</div>
      </Card>
    </div>
    <Card title="Unposted queue" action={<div className="row gap">{un.data && <Pill tone={un.data.length ? "amber" : "teal"}>{un.data.length} waiting</Pill>}<button className="btn btn-s" disabled={!!act.busy} onClick={() => act.run("rerun", async () => { const r: any = await api("/gl/unposted", { method: "POST", body: JSON.stringify({ entity_id: ctx.entity }) }); return `${r.posted} posted · ${r.queued} still queued`; })}><Play size={14} /> Re-run posting</button></div>}>
      {un.data ? (un.data.length ? <table className="tbl"><thead><tr><th>Date</th><th>Event</th><th>Reason</th><th>Detail</th><th className="num">Amount</th><th /></tr></thead><tbody>{un.data.map((u) => <tr key={u.id}><td>{fmtDate(u.event_date)}</td><td>{u.event_type}</td><td><Pill tone={tone(u.reason.split(":")[0])}>{u.reason.replace(/_/g, " ").slice(0, 60)}</Pill></td><td className="small mute">{u.detail?.narration ?? u.detail?.note ?? ""}{u.reason === "no_rule" ? " — add a posting rule for this event, then re-run" : u.reason === "period_locked" ? " — reopen the period or date the correction in an open one" : ""}</td><td className="num">{u.amount == null ? "" : inr(u.amount)}</td><td><button className="btn btn-s" disabled={!!act.busy} onClick={() => act.run(u.id, async () => { await api(`/gl/unposted/${u.id}`, { method: "DELETE" }); })}>Dismiss</button></td></tr>)}</tbody></table> : <div className="small mute">Nothing waiting — every event since the books opened has a journal.</div>) : <Status loading={un.loading} error={un.error} />}
    </Card>
  </>);
}

// ---------- Posting rules + Tally ----------
function Rules({ ctx, book }: { ctx: Ctx; book: any }) {
  const rules = useApi<any[]>("/gl/posting-rules"); const act = useAction(() => rules.refetch()); const [q, setQ] = useState(""); const [editing, setEditing] = useState<any>(null);
  const recurring = useApi<any[]>("/gl/recurring"); const sync = useApi<any[]>("/gl/tally/sync");
  const [tally, setTally] = useState({ from: `${ctx.fy.slice(0, 4)}-04-01`, to: new Date().toISOString().slice(0, 10) }); const [xml, setXml] = useState(""); const [imp, setImp] = useState<any>(null);
  const names = new Map(ctx.accounts.map((a) => [a.code, a.name]));
  const side = (r: any, s: string) => (r.lines ?? []).filter((l: any) => l.side === s).map((l: any) => `${l.account_code} ${l.account_code.split("|").map((c: string) => names.get(c) ?? "").filter(Boolean).join(" / ")} (${l.amount})`).join(" · ");
  const list = (rules.data ?? []).filter((r) => !q || `${r.event_type} ${r.instrument_class ?? ""}`.includes(q));
  const download = async () => { const r: any = await api("/gl/tally/export", { method: "POST", body: JSON.stringify({ entity_id: ctx.entity, ...tally }) }); const s = session.get(); const res = await fetch(`${API_URL}${r.url.replace(/^\/api\/v1/, "")}`, { headers: { Authorization: `Bearer ${s?.access_token}`, "X-Family-Id": session.family() ?? "" } }); const blob = await res.blob(); const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `tally-${ctx.entityName.replace(/\s+/g, "-")}-${tally.from}-${tally.to}.xml`; a.click(); sync.refetch(); return `${r.vouchers} vouchers and ${r.masters} ledger masters exported`; };
  const doImport = async (form?: FormData) => { const r: any = form ? await apiUpload("/gl/tally/import", form) : await apiJson("/gl/tally/import", { entity_id: ctx.entity, xml }); setImp(r); sync.refetch(); return r.status_code === 422 ? undefined : `${r.imported} imported · ${r.duplicates} duplicates`; };
  return (<>
    {act.msg}
    <Card title="Posting rules" action={<div className="row gap"><input style={inp} placeholder="filter events…" value={q} onChange={(e) => setQ(e.target.value)} /><button className="btn btn-p" onClick={() => setEditing({ event_type: "", instrument_class: "", basis: "", lines: [{ side: "debit", account_code: "", amount: "amount" }, { side: "credit", account_code: "1110", amount: "amount", sub_ledger: "bank" }] })}><Plus size={14} /> Override</button></div>}>
      {editing && <div style={{ border: "1px solid var(--line)", borderRadius: 8, padding: 12, marginBottom: 12 }}>
        <div className="row gap" style={{ flexWrap: "wrap", alignItems: "flex-end" }}><Field label="Event type"><input style={{ ...inp, minWidth: 220 }} value={editing.event_type} onChange={(e) => setEditing({ ...editing, event_type: e.target.value })} placeholder="bank_txn.household / investment_txn.buy" /></Field><Field label="Instrument class"><input style={inp} value={editing.instrument_class} onChange={(e) => setEditing({ ...editing, instrument_class: e.target.value })} placeholder="any" /></Field><Field label="Basis"><select style={inp} value={editing.basis} onChange={(e) => setEditing({ ...editing, basis: e.target.value })}><option value="">any</option><option>accrual</option><option>cash</option></select></Field></div>
        <table className="tbl"><thead><tr><th>Side</th><th>Account</th><th>Amount key</th><th>Sub-ledger</th><th /></tr></thead><tbody>{editing.lines.map((l: any, i: number) => <tr key={i}>
          <td><select style={inp} value={l.side} onChange={(e) => setEditing({ ...editing, lines: editing.lines.map((x: any, j: number) => (j === i ? { ...x, side: e.target.value } : x)) })}><option>debit</option><option>credit</option></select></td>
          <td><select style={inp} value={l.account_code} onChange={(e) => setEditing({ ...editing, lines: editing.lines.map((x: any, j: number) => (j === i ? { ...x, account_code: e.target.value } : x)) })}><option value="">—</option>{ctx.accounts.filter((a) => !a.is_group).map((a) => <option key={a.code} value={a.code}>{a.code} {a.name}</option>)}</select></td>
          <td><input style={inp} value={l.amount} onChange={(e) => setEditing({ ...editing, lines: editing.lines.map((x: any, j: number) => (j === i ? { ...x, amount: e.target.value } : x)) })} /></td>
          <td><input style={inp} value={l.sub_ledger ?? ""} placeholder="bank / holding / property" onChange={(e) => setEditing({ ...editing, lines: editing.lines.map((x: any, j: number) => (j === i ? { ...x, sub_ledger: e.target.value || undefined } : x)) })} /></td>
          <td><button className="btn btn-s" onClick={() => setEditing({ ...editing, lines: editing.lines.filter((_: any, j: number) => j !== i) })}><Trash2 size={12} /></button></td></tr>)}
          <tr><td colSpan={5}><button className="btn btn-s" onClick={() => setEditing({ ...editing, lines: [...editing.lines, { side: "debit", account_code: "", amount: "amount" }] })}><Plus size={12} /> line</button></td></tr></tbody></table>
        <div className="small mute">Amount keys come from the event: <code>amount</code>, <code>net_proceeds</code>, <code>cost_of_lots_sold</code>, <code>gain_by_term</code>, <code>rent</code>, <code>gst</code>, <code>tds</code>, <code>principal</code>, <code>interest</code>, <code>share</code>… Alternatives like <code>4400|4410</code> pick by term. A family override wins over the system rule for the same event / class / basis.</div>
        <div className="row gap" style={{ marginTop: 8 }}><button className="btn btn-p" disabled={!!act.busy || !editing.event_type || editing.lines.some((l: any) => !l.account_code)} onClick={() => act.run("rule", async () => { await api("/gl/posting-rules", { method: "POST", body: JSON.stringify({ event_type: editing.event_type, instrument_class: editing.instrument_class || null, basis: editing.basis || null, lines: editing.lines }) }); setEditing(null); return "Override saved — re-run posting to apply it to queued events"; })}>Save override</button><button className="btn btn-s" onClick={() => setEditing(null)}>Cancel</button></div>
      </div>}
      {rules.data ? <table className="tbl"><thead><tr><th>Event</th><th>Class</th><th>Debit</th><th>Credit</th><th>Scope</th><th /></tr></thead><tbody>{list.map((r) => <tr key={r.id} style={{ opacity: r.active ? 1 : 0.5 }}><td><code>{r.event_type}</code>{r.basis ? <div className="small mute">{r.basis} basis</div> : null}</td><td className="small">{r.instrument_class ?? "—"}</td><td className="small">{side(r, "debit")}</td><td className="small">{side(r, "credit")}</td><td>{r.system ? <span className="small mute">system</span> : <Pill tone="amber">family override</Pill>}</td>
        <td className="row gap" style={{ justifyContent: "flex-end" }}><button className="btn btn-s" onClick={() => setEditing({ event_type: r.event_type, instrument_class: r.instrument_class ?? "", basis: r.basis ?? "", lines: r.lines })}>{r.system ? "Override" : "Edit"}</button>{!r.system && <button className="btn btn-s" disabled={!!act.busy} onClick={() => act.run(r.id, async () => { await api(`/gl/posting-rules/${r.id}`, { method: "DELETE" }); })}><Trash2 size={12} /></button>}</td></tr>)}</tbody></table> : <Status loading={rules.loading} error={rules.error} />}
      <div className="small mute" style={{ marginTop: 8 }}>Events with no matching rule go to the unposted queue; nothing is silently skipped.</div>
    </Card>
    <div className="grid-2" style={{ alignItems: "start" }}>
      <Card title="Recurring journals" action={<button className="btn btn-s" disabled={!!act.busy} onClick={() => act.run("recur", async () => { const r: any = await api("/gl/recurring/run", { method: "POST", body: JSON.stringify({}) }); recurring.refetch(); return `${r.posted} recurring journal${r.posted === 1 ? "" : "s"} posted`; })}><Play size={14} /> Run due</button>}>
        {recurring.data ? (recurring.data.length ? recurring.data.map((r) => <div key={r.id} className="attn"><span style={{ flex: 1 }}><b>{r.name}</b> · {r.entity_name}<div className="small mute">{r.rrule.replace("FREQ=", "").toLowerCase()} · next {fmtDate(r.next_run)}{r.last_run ? ` · last ${fmtDate(r.last_run)}` : ""}</div></span><Pill tone={r.active ? "teal" : undefined}>{r.active ? "active" : "paused"}</Pill><button className="btn btn-s" disabled={!!act.busy} onClick={() => act.run(r.id, async () => { await api(`/gl/recurring/${r.id}`, { method: "PATCH", body: JSON.stringify({ active: !r.active }) }); recurring.refetch(); })}>{r.active ? "Pause" : "Resume"}</button></div>) : <div className="small mute">None yet.</div>) : <Status loading={recurring.loading} error={recurring.error} />}
      </Card>
      <Card title="Tally" action={<span className="small mute">{book ? `${ctx.entityName} · ${book.basis}` : ""}</span>}>
        <div className="row gap" style={{ flexWrap: "wrap", alignItems: "flex-end" }}><Field label="From"><input type="date" style={inp} value={tally.from} onChange={(e) => setTally({ ...tally, from: e.target.value })} /></Field><Field label="To"><input type="date" style={inp} value={tally.to} onChange={(e) => setTally({ ...tally, to: e.target.value })} /></Field><button className="btn btn-p" disabled={!!act.busy} onClick={() => act.run("tally", download)}><Download size={14} /> Export XML</button></div>
        <div className="small mute" style={{ margin: "6px 0 12px" }}>Ledger masters and vouchers (Receipt / Payment / Contra / Journal) in Tally's import XML; the CA imports it with Gateway → Import.</div>
        <Field label="Import a Tally day book (XML)"><div className="row gap" style={{ flexWrap: "wrap" }}><input type="file" accept=".xml,text/xml" onChange={(e) => { const f = e.target.files?.[0]; if (!f) return; const fd = new FormData(); fd.append("entity_id", ctx.entity); fd.append("file", f); act.run("import", () => doImport(fd)); }} /><span className="small mute">or paste</span></div></Field>
        <textarea style={{ ...inp, width: "100%", minHeight: 70, fontFamily: "monospace", fontSize: 11 }} value={xml} onChange={(e) => setXml(e.target.value)} placeholder="<ENVELOPE>…<VOUCHER>…" />
        <div className="row gap" style={{ marginTop: 6 }}><button className="btn btn-s" disabled={!!act.busy || xml.length < 10} onClick={() => act.run("import", () => doImport())}><Upload size={14} /> Import pasted XML</button></div>
        {imp && imp.status_code === 422 && <div className="err" style={{ marginTop: 6 }}>Map these Tally ledgers to accounts first: {imp.unmapped.join(", ")} — create the account (or rename its Tally ledger name) and import again.</div>}
        {sync.data && sync.data.length > 0 && <div style={{ marginTop: 10 }}><b className="small">Sync log</b>{sync.data.slice(0, 6).map((s) => <div key={s.id} className="attn small"><span style={{ flex: 1 }}>{s.direction} · {s.from_date ? `${fmtDate(s.from_date)} – ${fmtDate(s.to_date)}` : s.fy} · {s.vouchers} vouchers</span><span className="mute">{fmtDate(s.created_at)}</span><Pill tone={tone(s.status)}>{s.status}</Pill></div>)}</div>}
      </Card>
    </div>
    <TallyLive ctx={ctx} book={book} />
  </>);
}

/** Tally live sync (FO-119): ping the HTTP gateway, push masters + vouchers, pull the day book. */
function TallyLive({ ctx, book }: { ctx: Ctx; book: any }) {
  const act = useAction(); const [url, setUrl] = useState(book?.tally_url ?? ""); const [company, setCompany] = useState(book?.tally_company ?? ""); const [range, setRange] = useState({ from: `${ctx.fy.slice(0, 4)}-04-01`, to: new Date().toISOString().slice(0, 10) }); const [ping, setPing] = useState<any>(null); const [last, setLast] = useState<any>(null);
  const saveUrl = () => act.run("url", async () => { await api("/gl/books", { method: "PUT", body: JSON.stringify({ entity_id: ctx.entity, basis: book.basis, books_start_date: String(book.books_start_date).slice(0, 10), mark_to_market: !!book.mark_to_market, maker_checker: !!book.maker_checker, depreciation: !!book.depreciation, strict_reconciliation: !!book.strict_reconciliation, tally_url: url || null, tally_company: company || null }) }); ctx.refetchBooks(); return "Tally endpoint saved"; });
  return (<Card title="Tally — live sync" action={book?.last_tally_sync_at ? <span className="small mute">last sync {fmtDate(book.last_tally_sync_at)}</span> : <span className="small mute">never synced live</span>}>
    {act.msg}
    <div className="row gap" style={{ flexWrap: "wrap", alignItems: "flex-end" }}><Field label="Tally HTTP gateway"><input style={{ ...inp, minWidth: 240 }} placeholder="http://192.168.1.20:9000" value={url} onChange={(e) => setUrl(e.target.value)} /></Field><Field label="Company in Tally"><input style={inp} placeholder={ctx.entityName} value={company} onChange={(e) => setCompany(e.target.value)} /></Field><button className="btn btn-s" disabled={!!act.busy || !book} onClick={saveUrl}>Save</button>
      <button className="btn btn-s" disabled={!!act.busy} onClick={() => act.run("ping", async () => { const r: any = await api(`/gl/tally/ping?entity_id=${ctx.entity}`); setPing(r); return r.company_open ? `Tally reachable · ${r.company} is open` : `Tally reachable · open ${r.company} in Tally first (companies: ${r.companies.join(", ") || "none"})`; })}>Ping</button></div>
    <div className="row gap" style={{ flexWrap: "wrap", alignItems: "flex-end", marginTop: 8 }}><Field label="From"><input type="date" style={inp} value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} /></Field><Field label="To"><input type="date" style={inp} value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} /></Field>
      <button className="btn btn-p" disabled={!!act.busy} onClick={() => act.run("push", async () => { const r: any = await api("/gl/tally/push", { method: "POST", body: JSON.stringify({ entity_id: ctx.entity, ...range }) }); setLast(r); return `${r.status}: ${r.created} vouchers created, ${r.altered} masters, ${r.errors} errors${r.line_errors?.[0] ? ` — ${r.line_errors[0]}` : ""}`; })}>Push to Tally</button>
      <button className="btn btn-s" disabled={!!act.busy} onClick={() => act.run("pull", async () => { const r: any = await apiJson("/gl/tally/pull", { entity_id: ctx.entity, ...range }); setLast(r); return r.status_code === 422 ? `Map these Tally ledgers first: ${r.unmapped.join(", ")}` : `${r.imported} vouchers imported · ${r.duplicates} already in the books`; })}>Pull day book</button></div>
    {ping && <div className="small mute" style={{ marginTop: 6 }}>{ping.url}: {ping.companies.length} compan{ping.companies.length === 1 ? "y" : "ies"} open — {ping.companies.join(", ") || "none"}</div>}
    <div className="small mute" style={{ marginTop: 8 }}>Turn on Tally's HTTP gateway (F12 › Advanced › Enable ODBC / HTTP on port 9000) with the company open; push sends the same XML as the export, pull reads the day book and de-duplicates by voucher GUID. When the gateway is not reachable the file export / import above still works.</div>
  </Card>);
}

