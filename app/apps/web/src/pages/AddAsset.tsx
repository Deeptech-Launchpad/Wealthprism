import { useEffect, useMemo, useState } from "react";
import { useApi } from "../lib/useApi";
import { api, session } from "../lib/api";
import { fmtDate } from "../components";

// "Add asset": pick a category, then a type, then a form that asks only what that type needs. The catalogue (asset_types) decides the rest:
// market holdings go through /assets/market (the same lot engine as imports), physical assets through /lifestyle-assets, insurance through /insurance-policies.
// The same form edits an insurance policy or a physical asset when it is opened with `editing`.
const role = () => session.get()?.families.find((f) => f.id === session.family())?.role ?? "viewer";
export const canAddAsset = () => ["owner", "member", "operator"].includes(role());
const CATS: { code: string; title: string; text: string }[] = [
  { code: "market", title: "Market investments", text: "Stocks, mutual funds, ETFs, gold ETFs, bonds, G-Secs, SGB, PMS, AIF, REIT" },
  { code: "physical", title: "Physical assets", text: "Gold, silver, jewellery, art, watches, vehicles" },
  { code: "insurance", title: "Insurance", text: "Term, health, endowment, ULIP, vehicle and property cover" },
  { code: "savings", title: "Government savings", text: "PPF, EPF, NPS, Sukanya, SCSS, NSC, KVP" },
];
const FREQ = ["monthly", "quarterly", "half_yearly", "yearly", "single"];
const today = () => new Date().toISOString().slice(0, 10);
const num = (v: any) => (v === "" || v == null ? undefined : Number(v));
const text = (v: any) => (v === "" || v == null ? undefined : String(v));
const label = (s?: string | null) => (s ?? "").replace(/_/g, " ");

type Props = { onClose: () => void; onSaved: (message: string, category: string) => void; editing?: { category: "insurance" | "physical"; row: any }; only?: "market" | "physical" | "insurance"; onOpenDeposit?: (typeCode: string) => void; onOpenSavings?: (scheme: string) => void };

export function AddAsset({ onClose, onSaved, editing, only, onOpenDeposit, onOpenSavings }: Props) {   // only = open straight into one category (the Balance sheet lists), with no way to pick another
  const types = useApi<any[]>("/asset-types"); const ents = useApi<any[]>("/entities");
  const [cat, setCat] = useState<string | null>(editing?.category ?? only ?? null);
  const [code, setCode] = useState<string | null>(null);
  const [f, setF] = useState<any>({}); const [x, setX] = useState<any>({});   // f = the common fields, x = the type's extra fields
  const [err, setErr] = useState(""); const [busy, setBusy] = useState(false);
  const list = types.data ?? []; const at = list.find((t) => t.code === code);
  // opening an existing record: find its type from the kind and fill the form
  useEffect(() => {
    if (!editing || !list.length || code) return; const r = editing.row;
    const t = list.find((a) => (editing.category === "insurance" ? a.insurance_kind === r.kind : a.lifestyle_kind === r.kind));
    if (!t) return; setCode(t.code);
    if (editing.category === "insurance") { setF({ entity_id: r.entity_id, insurer: r.insurer ?? "", policy_no_masked: r.policy_no_masked ?? "", life_assured: r.life_assured ?? "", sum_assured: r.sum_assured ?? "", premium: r.premium ?? "", premium_frequency: r.premium_frequency ?? "yearly", next_premium_due: r.next_premium_due?.slice(0, 10) ?? "", start_date: r.start_date?.slice(0, 10) ?? "", maturity_date: r.maturity_date?.slice(0, 10) ?? "", nominee: r.nominee ?? "", tax_section: r.tax_section ?? "", covers_members: (r.covers_members ?? []).join(", ") }); setX({ surrender_value: r.surrender_value ?? "", fund_value: r.fund_value ?? "" }); }
    else { setF({ entity_id: r.entity_id, name: r.name ?? "", acquired_on: r.acquired_on?.slice(0, 10) ?? "", cost: r.cost ?? "", current_value: r.current_value ?? "", valued_on: r.valued_on?.slice(0, 10) ?? today(), location: r.location ?? "", include_in_net_worth: r.include_in_net_worth !== false, bucket: r.bucket ?? "growth" }); setX({ ...(r.details ?? {}) }); }
  }, [editing, list, code]);
  const defaultEntity = ents.data?.[0]?.id ?? "";
  const pick = (t: any) => { setCode(t.code); setErr(""); setX(Object.fromEntries((t.fields ?? []).filter((e: any) => e.default != null).map((e: any) => [e.key, e.default]))); setF({ entity_id: defaultEntity, txn_date: today(), acquired_on: today(), valued_on: today(), bucket: t.default_bucket, include_in_net_worth: true, premium_frequency: "yearly" }); };
  const set = (k: string, v: any) => setF((s: any) => ({ ...s, [k]: v }));
  const setE = (k: string, v: any) => setX((s: any) => ({ ...s, [k]: v }));
  const back = () => { if (editing) return onClose(); if (code) { setCode(null); setErr(""); } else if (only) onClose(); else setCat(null); };

  const save = async () => {
    if (!at) return; setErr(""); setBusy(true);
    try {
      if (at.category === "market") {
        const body: any = { type_code: at.code, entity_id: f.entity_id, txn_date: f.txn_date, quantity: num(f.quantity), price: num(f.price), amount: num(f.amount), charges: num(f.charges), current_price: num(f.current_price), bucket: f.bucket, note: text(f.note) };
        if (at.code === "mf") body.amfi_code = f.amfi_code; else if (f.instrument_id) body.instrument_id = f.instrument_id; else body.instrument = { name: f.name, isin: text(f.isin), symbol: text(f.symbol) };
        const extras = Object.fromEntries(Object.entries(x).filter(([, v]) => v !== "" && v != null).map(([k, v]) => [k, (at.fields ?? []).find((e: any) => e.key === k)?.type === "number" ? Number(v) : v])); if (Object.keys(extras).length) body.extras = extras;
        const r: any = await api("/assets/market", { method: "POST", body: JSON.stringify(body) });
        onSaved(`Added ${r.instrument.name} — ${r.holding ? `${r.holding.quantity} held now` : "saved"}.${r.note ? " " + r.note : ""} See it under Investments → Holdings.${r.scheduled ? ` ${r.scheduled} expected interest and maturity payments are listed under "Bond interest and maturities".` : ""}`, "market");
      } else if (at.category === "physical") {
        const details = Object.fromEntries(Object.entries(x).filter(([, v]) => v !== "" && v != null).map(([k, v]) => [k, (at.fields ?? []).find((e: any) => e.key === k)?.type === "number" ? Number(v) : v]));
        const body = { entity_id: f.entity_id, kind: at.lifestyle_kind, name: f.name, acquired_on: text(f.acquired_on) ?? null, cost: num(f.cost) ?? null, current_value: num(f.current_value) ?? num(f.cost) ?? null, valued_on: text(f.valued_on) ?? null, location: text(f.location) ?? null, include_in_net_worth: f.include_in_net_worth !== false, bucket: f.bucket, details };
        if (editing) await api(`/lifestyle-assets/${editing.row.id}`, { method: "PATCH", body: JSON.stringify(body) }); else await api("/lifestyle-assets", { method: "POST", body: JSON.stringify(body) });
        onSaved(`${editing ? "Updated" : "Added"} ${f.name}. See it under Balance sheet → Physical assets.`, "physical");
      } else if (at.category === "insurance") {
        const members = String(f.covers_members ?? "").split(",").map((s) => s.trim()).filter(Boolean);
        const body: any = { entity_id: f.entity_id, kind: at.insurance_kind, insurer: f.insurer, policy_no_masked: text(f.policy_no_masked) ?? null, life_assured: text(f.life_assured) ?? null, sum_assured: num(f.sum_assured), premium: num(f.premium), premium_frequency: f.premium_frequency, next_premium_due: text(f.next_premium_due) ?? null, start_date: text(f.start_date) ?? null, maturity_date: text(f.maturity_date) ?? null, surrender_value: num(x.surrender_value) ?? null, fund_value: num(x.fund_value) ?? null, nominee: text(f.nominee) ?? null, tax_section: text(f.tax_section) ?? null, covers_members: members };
        if (editing) await api(`/insurance-policies/${editing.row.id}`, { method: "PATCH", body: JSON.stringify(body) }); else await api("/insurance-policies", { method: "POST", body: JSON.stringify(body) });
        onSaved(`${editing ? "Updated" : "Added"} ${f.insurer} ${label(at.insurance_kind)} policy. See it under Balance sheet → Insurance.`, "insurance");
      }
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };

  const valid = (() => {
    if (!at || !f.entity_id) return false;
    if (at.category === "market") { const unitless = at.code === "pms" || at.code === "aif"; const named = at.code === "mf" ? !!f.amfi_code : !!(f.instrument_id || (f.name && f.name.trim().length >= 2)); const money = unitless ? Number(f.amount) > 0 : (Number(f.quantity) > 0 && (Number(f.price) > 0 || Number(f.amount) > 0)); const needs = (at.fields ?? []).filter((e: any) => e.required).every((e: any) => x[e.key] !== "" && x[e.key] != null); return !!(named && money && f.txn_date && needs); }
    if (at.category === "physical") return !!f.name && (Number(f.cost) > 0 || Number(f.current_value) > 0) && (at.fields ?? []).filter((e: any) => e.required).every((e: any) => x[e.key] !== "" && x[e.key] != null);
    if (at.category === "insurance") return !!(f.insurer && Number(f.sum_assured) > 0 && Number(f.premium) >= 0 && f.premium !== "" && f.premium != null);
    return false;
  })();
  const title = editing ? `Edit ${editing.category === "insurance" ? "policy" : "asset"}` : at ? `Add — ${at.label}` : cat ? CATS.find((c) => c.code === cat)!.title : "Add asset";

  return (<div className="modal-bg" onClick={onClose}><div className="modal" style={{ maxWidth: 760, width: "92vw", maxHeight: "88vh", overflowY: "auto" }} onClick={(e) => e.stopPropagation()}>
    <div className="row" style={{ justifyContent: "space-between", alignItems: "center" }}><h3 style={{ margin: 0 }}>{title}</h3><button className="btn btn-s" onClick={onClose}>Close</button></div>
    {types.loading && !types.data && <div className="small mute" style={{ marginTop: 8 }}>Loading…</div>}
    {types.error && <div className="err">{types.error}</div>}

    {!cat && !editing && <div className="grid-2" style={{ marginTop: 10 }}>{CATS.map((c) => <div key={c.code} className="card" style={{ cursor: c.code === "savings" && !onOpenDeposit ? "default" : "pointer", opacity: c.code === "savings" && !onOpenDeposit ? 0.6 : 1 }} onClick={() => (c.code !== "savings" || onOpenDeposit) && setCat(c.code)}><b>{c.title}</b><div className="small mute">{c.text}</div></div>)}</div>}

    {cat && !code && <>
      <div className="small mute" style={{ margin: "8px 0" }}>What kind of {CATS.find((c) => c.code === cat)!.title.toLowerCase()}?</div>
      <div className="grid-2">{list.filter((t) => (t.code === "nps" ? "savings" : t.category) === cat).map((t) => <div key={t.code} className="card" style={{ cursor: t.enabled ? "pointer" : "default", opacity: t.enabled ? 1 : 0.55 }} onClick={() => { if (!t.enabled) return; if (t.deposit_type_code && onOpenDeposit) { onClose(); onOpenDeposit(t.deposit_type_code); } else if ((t.code === "ppf" || t.code === "ssy" || t.code === "epf") && onOpenSavings) { onClose(); onOpenSavings(t.code); } else pick(t); }}><b>{t.label}</b>{!t.enabled && <span className="small mute"> · coming soon</span>}<div className="small mute">{t.description}</div>{t.enabled && t.category !== "insurance" && <div style={{ marginTop: 4 }}><PriceBadge mode={t.price_mode} /></div>}</div>)}</div>
      <div className="row gap" style={{ marginTop: 10 }}><button className="btn" onClick={back}>Back</button></div>
    </>}

    {at && <>
      <div className="small mute" style={{ margin: "8px 0" }}>{at.description}{at.category === "insurance" && at.counts_in_net_worth && <b> Its cash value counts in net worth.</b>}</div>
      {at.price_help && at.category !== "savings" && !(at.category === "insurance" && !at.counts_in_net_worth) && <div className="small" style={{ margin: "0 0 8px", padding: "6px 8px", borderRadius: 6, background: at.price_mode === "feed" || at.price_mode === "accrued" ? "var(--tealSoft)" : at.price_mode === "partial" ? "var(--blueSoft)" : "var(--amberSoft)" }}><PriceBadge mode={at.price_mode} /> {at.price_help}</div>}
      <div className="grid-2">
        <label className="field">Owner (entity)<select value={f.entity_id ?? ""} onChange={(e) => set("entity_id", e.target.value)}>{(ents.data ?? []).map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}</select></label>
        {at.category === "market" && <MarketFields at={at} f={f} set={set} x={x} setE={setE} />}
        {at.category === "physical" && <>
          <label className="field">Name<input value={f.name ?? ""} placeholder={at.code === "gold_physical" ? "e.g. Gold bars, locker 12" : "What is it?"} onChange={(e) => set("name", e.target.value)} /></label>
          <label className="field">Bought on<input type="date" value={f.acquired_on ?? ""} onChange={(e) => set("acquired_on", e.target.value)} /></label>
          <label className="field">Cost (₹)<input type="number" value={f.cost ?? ""} onChange={(e) => set("cost", e.target.value)} /></label>
          <label className="field">Value today (₹)<input type="number" value={f.current_value ?? ""} placeholder="same as cost if blank" onChange={(e) => set("current_value", e.target.value)} /></label>
          <label className="field">Valued on<input type="date" value={f.valued_on ?? ""} onChange={(e) => set("valued_on", e.target.value)} /></label>
          <label className="field">Where it is kept<input value={f.location ?? ""} placeholder="e.g. bank locker, home safe" onChange={(e) => set("location", e.target.value)} /></label>
          <Extras at={at} x={x} setE={setE} />
          <label className="field">Bucket<select value={f.bucket ?? "growth"} onChange={(e) => set("bucket", e.target.value)}><option value="liquidity">liquidity</option><option value="income">income</option><option value="growth">growth</option></select></label>
          <label className="field" style={{ flexDirection: "row", alignItems: "center", gap: 6 }}><input type="checkbox" checked={f.include_in_net_worth !== false} onChange={(e) => set("include_in_net_worth", e.target.checked)} />Count in net worth</label>
        </>}
        {at.category === "insurance" && <>
          <label className="field">Insurer<input value={f.insurer ?? ""} placeholder="e.g. HDFC Life" onChange={(e) => set("insurer", e.target.value)} /></label>
          <label className="field">Policy number (last digits)<input value={f.policy_no_masked ?? ""} onChange={(e) => set("policy_no_masked", e.target.value)} /></label>
          <label className="field">Person insured<input value={f.life_assured ?? ""} onChange={(e) => set("life_assured", e.target.value)} /></label>
          {at.insurance_kind === "health" && <label className="field">Members covered (comma separated)<input value={f.covers_members ?? ""} placeholder="e.g. Arjun, Priya, Aarav" onChange={(e) => set("covers_members", e.target.value)} /></label>}
          <label className="field">Sum assured / cover (₹)<input type="number" value={f.sum_assured ?? ""} onChange={(e) => set("sum_assured", e.target.value)} /></label>
          <label className="field">Premium (₹)<input type="number" value={f.premium ?? ""} onChange={(e) => set("premium", e.target.value)} /></label>
          <label className="field">Paid<select value={f.premium_frequency ?? "yearly"} onChange={(e) => set("premium_frequency", e.target.value)}>{FREQ.map((q) => <option key={q} value={q}>{label(q)}</option>)}</select></label>
          <label className="field">Next premium due<input type="date" value={f.next_premium_due ?? ""} onChange={(e) => set("next_premium_due", e.target.value)} /></label>
          <label className="field">Start date<input type="date" value={f.start_date ?? ""} onChange={(e) => set("start_date", e.target.value)} /></label>
          <label className="field">Maturity / end date<input type="date" value={f.maturity_date ?? ""} onChange={(e) => set("maturity_date", e.target.value)} /></label>
          <label className="field">Nominee<input value={f.nominee ?? ""} onChange={(e) => set("nominee", e.target.value)} /></label>
          <label className="field">Tax section<select value={f.tax_section ?? ""} onChange={(e) => set("tax_section", e.target.value)}><option value="">none</option><option value="80C">80C</option><option value="80D">80D</option><option value="10(10D)">10(10D)</option></select></label>
          <Extras at={at} x={x} setE={setE} />
        </>}
      </div>
      {err && <div className="err">{err}</div>}
      <div className="row gap" style={{ marginTop: 10, justifyContent: "flex-end" }}><button className="btn" onClick={back}>{editing ? "Cancel" : "Back"}</button><button className="btn btn-p" disabled={!valid || busy} onClick={save}>{busy ? "Saving…" : editing ? "Save changes" : "Save"}</button></div>
    </>}
  </div></div>);
}

/** How a price is kept: filled in by a daily feed, only when it matches, or by the user. */
function PriceBadge({ mode }: { mode?: string }) {
  const m = mode === "accrued" ? { t: "Value: worked out for you", c: "var(--teal)" } : mode === "feed" ? { t: "Price: automatic", c: "var(--teal)" } : mode === "partial" ? { t: "Price: automatic if listed", c: "var(--blue)" } : { t: "Price: you update it", c: "var(--amber)" };
  return <b className="small" style={{ color: m.c }}>{m.t}.</b>;
}

function Extras({ at, x, setE }: { at: any; x: any; setE: (k: string, v: any) => void }) {
  return <>{(at.fields ?? []).map((e: any) => <label key={e.key} className="field">{e.label}{e.required ? " *" : ""}{e.type === "select"
    ? <select value={x[e.key] ?? ""} onChange={(ev) => setE(e.key, ev.target.value)}><option value="">—</option>{e.options.map((o: string) => <option key={o} value={o}>{label(o)}</option>)}</select>
    : <input type={e.type === "number" ? "number" : e.type === "date" ? "date" : "text"} step="any" value={x[e.key] ?? ""} onChange={(ev) => setE(e.key, ev.target.value)} />}</label>)}</>;
}

/** The instrument picker and the money fields of a market holding. */
function MarketFields({ at, f, set, x, setE }: { at: any; f: any; set: (k: string, v: any) => void; x: any; setE: (k: string, v: any) => void }) {
  const unitless = at.code === "pms" || at.code === "aif";
  const [q, setQ] = useState(""); const [hits, setHits] = useState<any[] | null>(null); const [busy, setBusy] = useState(false); const [err, setErr] = useState(""); const [picked, setPicked] = useState<string>("");
  const url = useMemo(() => (at.code === "mf" ? `/assets/fund-search?q=${encodeURIComponent(q.trim())}` : `/instruments/search?q=${encodeURIComponent(q.trim())}&type=${at.instrument_type}&limit=8`), [q, at]);
  useEffect(() => {
    if (picked || q.trim().length < (at.code === "mf" ? 3 : 2)) { setHits(null); return; }
    let alive = true; setBusy(true); setErr("");
    const t = setTimeout(async () => { try { const r = await api<any[]>(url); if (alive) setHits(r); } catch (e: any) { if (alive) { setErr(e.message); setHits(null); } } finally { if (alive) setBusy(false); } }, 350);
    return () => { alive = false; clearTimeout(t); };
  }, [q, url, picked, at.code]);
  const chooseFund = (h: any) => { set("amfi_code", h.code); setPicked(h.name + " · " + h.plan + (h.option ? ", " + h.option : "")); setQ(""); setHits(null); if (!f.price) set("price", h.nav); };
  const chooseKnown = (h: any) => { set("instrument_id", h.id); set("name", h.name); setPicked(h.name + (h.symbol ? ` (${h.symbol})` : "")); setQ(""); setHits(null); if (!f.price && h.last_price) set("price", h.last_price); for (const e of at.fields ?? []) { const v = h.meta?.[e.key]; if (v != null && v !== "") setE(e.key, typeof v === "string" ? v.slice(0, e.type === "date" ? 10 : undefined) : v); } };
  const clear = () => { setPicked(""); set("amfi_code", undefined); set("instrument_id", undefined); set("name", ""); setQ(""); };
  return (<>
    <div className="field" style={{ gridColumn: "1 / -1" }}>
      {at.code === "mf" ? "Mutual fund (search the AMFI list)" : unitless ? `${at.label} name` : "Security name, symbol or ISIN"}
      {picked ? <div className="row gap" style={{ alignItems: "center" }}><b>{picked}</b><button type="button" className="btn btn-s" onClick={clear}>Change</button></div> : <>
        <input value={q || (at.code === "mf" ? "" : f.name ?? "")} placeholder={at.code === "mf" ? "e.g. parag parikh flexi cap direct growth" : "start typing; pick an existing one or keep your own name"} onChange={(e) => { setQ(e.target.value); if (at.code !== "mf") set("name", e.target.value); }} />
        {busy && <div className="small mute">Searching…</div>}{err && <div className="err">{err}</div>}
        {hits && hits.length > 0 && <div style={{ border: "1px solid var(--line)", borderRadius: 6, marginTop: 4, background: "#fff" }}>{hits.map((h) => at.code === "mf"
          ? <div key={h.code} className="small" style={{ padding: "6px 8px", cursor: "pointer", borderBottom: "1px solid var(--line)" }} onClick={() => chooseFund(h)}><b>{h.name}</b> <span className="mute">· {h.plan}{h.option ? `, ${h.option}` : ""}</span><div className="mute">NAV {h.nav} on {fmtDate(h.date)}</div></div>
          : <div key={h.id} className="small" style={{ padding: "6px 8px", cursor: "pointer", borderBottom: "1px solid var(--line)" }} onClick={() => chooseKnown(h)}><b>{h.name}</b> <span className="mute">· {h.symbol ?? h.isin ?? h.type}{h.held ? " · you hold this" : ""}</span>{h.last_price ? <div className="mute">last price {h.last_price}</div> : null}</div>)}
          {at.code !== "mf" && <div className="small mute" style={{ padding: "6px 8px" }}>None of these? Keep typing — a new security will be created with your name.</div>}</div>}
      </>}
    </div>
    {at.code !== "mf" && !picked && !unitless && <>
      <label className="field">Symbol (optional)<input value={f.symbol ?? ""} onChange={(e) => set("symbol", e.target.value)} /></label>
      <label className="field">ISIN (optional)<input value={f.isin ?? ""} placeholder="12 characters, e.g. INE002A01018" onChange={(e) => set("isin", e.target.value.toUpperCase())} /></label>
    </>}
    <Extras at={at} x={x} setE={setE} />
    <label className="field">{unitless ? "Invested on" : "Bought on"}<input type="date" value={f.txn_date ?? ""} onChange={(e) => set("txn_date", e.target.value)} /></label>
    {unitless ? <>
      <label className="field">Amount invested (₹)<input type="number" value={f.amount ?? ""} onChange={(e) => set("amount", e.target.value)} /></label>
      <label className="field">Value today (₹, from the latest statement)<input type="number" value={f.current_price ?? ""} onChange={(e) => set("current_price", e.target.value)} /></label>
    </> : <>
      <label className="field">Quantity (units / shares)<input type="number" step="any" value={f.quantity ?? ""} onChange={(e) => set("quantity", e.target.value)} /></label>
      <label className="field">Price per unit (₹)<input type="number" step="any" value={f.price ?? ""} onChange={(e) => set("price", e.target.value)} /></label>
      <label className="field">Or total amount (₹)<input type="number" step="any" value={f.amount ?? ""} placeholder="used if you leave the price blank" onChange={(e) => set("amount", e.target.value)} /></label>
      <label className="field">Charges (₹, optional)<input type="number" step="any" value={f.charges ?? ""} onChange={(e) => set("charges", e.target.value)} /></label>
      {at.code !== "mf" && at.price_mode !== "accrued" && <label className="field">{at.price_mode === "manual" ? "Current price (₹) — you keep this up to date" : at.code === "bond" ? "Current price (₹) — leave blank to let the value grow to face value" : "Current price (₹, optional until the feed takes over)"}<input type="number" step="any" value={f.current_price ?? ""} onChange={(e) => set("current_price", e.target.value)} /></label>}
    </>}
    {!picked && at.code !== "mf" && <label className="field">Bucket<select value={f.bucket ?? "growth"} onChange={(e) => set("bucket", e.target.value)}><option value="liquidity">liquidity</option><option value="income">income</option><option value="growth">growth</option></select></label>}
    <label className="field">Note (optional)<input value={f.note ?? ""} onChange={(e) => set("note", e.target.value)} /></label>
  </>);
}
