import { useRef, useState } from "react";
import { RefreshCw, Upload } from "lucide-react";
import { useApi } from "../lib/useApi";
import { api, apiUpload, apiJson } from "../lib/api";
import { Card, Pill, fmtDate } from "../components";

type Kind = "statement" | "bank";
interface JobResult { id: string; status: string; rows_total?: number; rows_ok?: number; rows_error?: number; errors?: { row?: number; message: string }[]; duplicates?: number; rent_matched?: number | null; detected_headers?: string[]; duplicate_of_previous_upload?: boolean; status_code: number }

const REQUIRED = [["date", "Trade date"], ["instrument", "Instrument / scrip"], ["side", "Buy / sell"], ["quantity", "Quantity"], ["price", "Price / rate"]] as const;
const OPTIONAL = [["isin", "ISIN"], ["ref", "Reference (contract note no.)"]] as const;

/** Upload a statement, then map an unknown contract-note layout once; the mapping is remembered per header signature. */
export function ImportPanel({ kind = "statement", bankAccountId, onDone }: { kind?: Kind; bankAccountId?: string; onDone?: () => void }) {
  const ents = useApi<any[]>("/entities");
  const banks = useApi<any[]>(kind === "bank" ? "/bank-accounts" : null);
  const [file, setFile] = useState<File | null>(null);
  const [entity, setEntity] = useState("");
  const [account, setAccount] = useState(bankAccountId ?? "");
  const [busy, setBusy] = useState(false);
  const [drag, setDrag] = useState(false);
  const [result, setResult] = useState<JobResult | null>(null);
  const [error, setError] = useState("");
  const [mapping, setMapping] = useState<Record<string, string> | null>(null);
  const [charges, setCharges] = useState<string[]>([]);
  const [provider, setProvider] = useState("");
  const input = useRef<HTMLInputElement>(null);

  const send = async (extra: Record<string, string> = {}) => {
    if (!file) return;
    setBusy(true); setError("");
    try {
      const form = new FormData();
      form.append("file", file);
      if (entity) form.append("entity_id", entity);
      if (kind === "bank" && account) form.append("bank_account_id", account);
      for (const [k, v] of Object.entries(extra)) form.append(k, v);
      const r = await apiUpload<JobResult>("/imports", form);
      setResult(r);
      if (r.status_code === 202 && r.detected_headers) {
        const guess: Record<string, string> = {};
        for (const h of r.detected_headers) {
          if (/date/.test(h) && !guess.date) guess.date = h;
          if (/scrip|instrument|security|symbol|name/.test(h) && !guess.instrument) guess.instrument = h;
          if (/isin/.test(h)) guess.isin = h;
          if (/buy\/sell|side|type/.test(h) && !guess.side) guess.side = h;
          if (/qty|quantity/.test(h) && !guess.quantity) guess.quantity = h;
          if (/rate|price/.test(h) && !guess.price) guess.price = h;
          if (/contract|ref|order/.test(h) && !guess.ref) guess.ref = h;
        }
        setMapping(guess);
        setCharges(r.detected_headers.filter((h) => /brokerage|stt|charge|gst|fee|duty|tax/.test(h)));
      } else { setMapping(null); onDone?.(); }
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };
  const submitMapping = async () => {
    if (!mapping || !result) return;
    const m: any = { ...mapping, charges };
    for (const k of Object.keys(m)) if (m[k] === "" || m[k] == null) delete m[k];
    setBusy(true); setError("");
    try {
      const r = await apiJson<JobResult>(`/imports/${result.id}/mapping`, { mapping: m, provider: provider || "generic", ...(entity ? { entity_id: entity } : {}) });
      setResult(r); setMapping(null); onDone?.();
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };
  const pick = (f: File | undefined) => { if (f) { setFile(f); setResult(null); setMapping(null); } };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div className={`drop ${drag ? "on" : ""}`} onClick={() => input.current?.click()}
        onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)}
        onDrop={(e) => { e.preventDefault(); setDrag(false); pick(e.dataTransfer.files[0]); }}>
        <input ref={input} type="file" hidden accept=".csv,.txt,.json,text/*,application/json" onChange={(e) => pick(e.target.files?.[0])} />
        <Upload size={18} style={{ color: "var(--mute)" }} />
        <div><b>{file ? file.name : kind === "bank" ? "Drop a bank statement CSV or AA JSON" : "Drop a CAS text, tradebook or contract note CSV, or Form 26AS"}</b></div>
        <div className="small mute">{kind === "bank" ? "HDFC, ICICI, SBI, Kotak and Axis layouts are recognised automatically" : "CAMS / KFintech CAS · Zerodha tradebook · any broker via the mapping assistant · TRACES 26AS · up to 25 MB"}</div>
      </div>
      <div className="row gap" style={{ flexWrap: "wrap", alignItems: "flex-end" }}>
        {kind === "bank" ? (
          <label className="field">Bank account
            <select value={account} onChange={(e) => setAccount(e.target.value)}>
              <option value="">Select…</option>
              {(banks.data ?? []).map((b) => <option key={b.id} value={b.id}>{b.bank} {b.account_masked} · {b.entity_name}</option>)}
            </select>
          </label>
        ) : (
          <label className="field">Entity (only if the file carries no PAN)
            <select value={entity} onChange={(e) => setEntity(e.target.value)}>
              <option value="">Attribute by PAN / provider account</option>
              {(ents.data ?? []).map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
            </select>
          </label>
        )}
        <button className="btn btn-p" disabled={!file || busy || (kind === "bank" && !account)} onClick={() => send()}>{busy ? "Importing…" : "Import"}</button>
      </div>
      {error && <div className="err">{error}</div>}
      {result && result.status_code !== 202 && (
        <div className="attn" style={{ borderBottom: 0 }}>
          <Pill tone={result.status === "done" ? "teal" : result.status === "failed" ? "red" : "amber"}>{result.duplicate_of_previous_upload ? "already imported" : result.status}</Pill>
          <span className="small">{result.duplicate_of_previous_upload ? "This exact file was imported before — nothing changed." : `${result.rows_ok ?? 0} of ${result.rows_total ?? 0} rows applied${result.rows_error ? `, ${result.rows_error} errors` : ""}`}</span>
          {!!result.errors?.length && <span className="small mute">{result.errors.slice(0, 3).map((l) => (l.row ? `row ${l.row}: ` : "") + l.message).join(" · ")}</span>}
          {!!result.duplicates && <span className="small mute">{result.duplicates} already recorded</span>}
          {result.rent_matched != null && <span className="small mute">rent settled: {result.rent_matched}</span>}
        </div>
      )}
      {mapping && result?.detected_headers && (
        <div className="modal-bg" onClick={() => setMapping(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div><h3 style={{ margin: 0 }}>Map this contract-note layout</h3><div className="small mute">We could not recognise this layout. Tell us which column holds each field; the mapping is saved for every future file with the same headers.</div></div>
            <div className="small mute">Detected columns: {result.detected_headers.join(" · ")}</div>
            <div className="grid-2">
              {[...REQUIRED, ...OPTIONAL].map(([k, label]) => (
                <label key={k} className="field">{label}{REQUIRED.some(([r]) => r === k) ? " *" : ""}
                  <select value={mapping[k] ?? ""} onChange={(e) => setMapping({ ...mapping, [k]: e.target.value })}>
                    <option value="">—</option>
                    {result.detected_headers!.map((h) => <option key={h} value={h}>{h}</option>)}
                  </select>
                </label>
              ))}
              <label className="field">Provider name<input value={provider} placeholder="e.g. icicidirect" onChange={(e) => setProvider(e.target.value)} /></label>
            </div>
            <div className="field">Charge columns (summed into cost / netted from proceeds)
              <div className="row gap" style={{ flexWrap: "wrap" }}>
                {result.detected_headers.map((h) => <label key={h} className="small row gap"><input type="checkbox" checked={charges.includes(h)} onChange={(e) => setCharges(e.target.checked ? [...charges, h] : charges.filter((x) => x !== h))} />{h}</label>)}
              </div>
            </div>
            <div className="row gap" style={{ justifyContent: "flex-end" }}>
              <button className="btn" onClick={() => setMapping(null)}>Cancel</button>
              <button className="btn btn-p" disabled={busy || REQUIRED.some(([k]) => !mapping[k])} onClick={submitMapping}>{busy ? "Importing…" : "Save mapping and import"}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** Request a fresh CAS from MF Central for an entity (FO-30): the backend queues an import job and raises a task,
 *  the statement itself arrives by e-mail to the family's ingest address and imports automatically from there. */
export function CasRefresh() {
  const ents = useApi<any[]>("/entities");
  const [entity, setEntity] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState("");
  const request = async () => {
    if (!entity) return;
    setBusy(true); setError(""); setMsg(null);
    try { await api("/imports/cas/refresh", { method: "POST", body: JSON.stringify({ entity_id: entity }) }); setMsg("Requested — a task will track it until the statement arrives and imports."); }
    catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };
  return (
    <Card title="Refresh CAS from MF Central">
      <div className="small mute" style={{ marginBottom: 8 }}>For an entity whose latest CAS isn't on hand yet — requests a fresh statement instead of waiting for the next one to turn up by e-mail.</div>
      <div className="row gap" style={{ flexWrap: "wrap", alignItems: "flex-end" }}>
        <label className="field">Entity
          <select value={entity} onChange={(e) => setEntity(e.target.value)}>
            <option value="">Select…</option>
            {(ents.data ?? []).map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
          </select>
        </label>
        <button className="btn btn-p" disabled={!entity || busy} onClick={request}><RefreshCw size={14} /> {busy ? "Requesting…" : "Refresh"}</button>
      </div>
      {error && <div className="err">{error}</div>}
      {msg && <div className="small" style={{ marginTop: 6 }}>{msg}</div>}
    </Card>
  );
}

const SOURCE: Record<string, string> = { cas: "MF CAS", contract_note: "Contract note / tradebook", bank_csv: "Bank statement", form26as: "Form 26AS", aa: "Account Aggregator", pms: "PMS statement" };

export function ImportJobs({ tick }: { tick: number }) {
  const jobs = useApi<any[]>("/imports", [tick]);
  return (
    <Card title="Recent imports">
      {jobs.data && !jobs.data.length && <div className="small mute">Nothing imported yet.</div>}
      {!!jobs.data?.length && (
        <table className="tbl"><thead><tr><th>When</th><th>Source</th><th>File</th><th>Status</th><th className="num">Rows</th><th className="num">Applied</th><th className="num">Errors</th></tr></thead>
          <tbody>{jobs.data.map((j) => {
            const msg = j.errors?.[0]?.message;
            return (<tr key={j.id}><td>{fmtDate(j.created_at)}</td><td>{SOURCE[j.source] ?? j.source}</td><td className="small">{j.filename ?? "—"}</td>
              <td><Pill tone={j.status === "done" ? "teal" : j.status === "failed" ? "red" : "amber"}>{j.status === "needs_mapping" ? "needs mapping" : j.status}</Pill>{msg && <div className="small mute">{msg}</div>}</td>
              <td className="num">{j.rows_total}</td><td className="num">{j.rows_ok}</td><td className={`num ${j.rows_error ? "down" : ""}`}>{j.rows_error}</td></tr>);
          })}</tbody></table>
      )}
    </Card>
  );
}

export function ImportSources() {
  const rows: [string, string, "teal" | "amber" | undefined][] = [
    ["MF CAS (CAMS + KFintech)", "Paste the text of the detailed CAS PDF (pdftotext -layout)", "teal"],
    ["Broker contract notes", "Zerodha tradebook recognised; other brokers via the mapping assistant", "teal"],
    ["Bank CSV / AA feed", "HDFC, ICICI, SBI, Kotak, Axis CSV; Account Aggregator deposit JSON", "teal"],
    ["Form 26AS", "TRACES text export → TDS reconciliation against rent", "teal"],
    ["PMS / AIF statements", "Monthly PDF, valuation marks", "amber"],
    ["NSDL / CDSL demat e-CAS", "Reconcile demat quantities against lots", "amber"],
  ];
  return (
    <Card title="Import sources">
      <div className="grid-3">{rows.map(([a, b, t]) => <div key={a} className="src"><b>{a}</b><div className="small mute">{b}</div><Pill tone={t}>{t === "teal" ? "Available" : "Coming"}</Pill></div>)}</div>
    </Card>
  );
}
