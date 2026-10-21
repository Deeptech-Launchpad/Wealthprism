import { useState } from "react";
import { Plus, RefreshCw, ShieldCheck, KeyRound } from "lucide-react";
import { startRegistration } from "@simplewebauthn/browser";
import { useApi } from "../lib/useApi";
import { api, inr, session } from "../lib/api";
import { Card, Pill, Status, fmtDate } from "../components";

// Settings: the family's entities (encrypted PAN, GSTINs), members and invitations, two-factor login, and the health of every
// integration the platform depends on (feeds, connectors, AA consents, ingest, delivery, prices).
const inp = { background: "#fff", color: "var(--ink)", borderColor: "var(--line)" } as const;
const role = () => session.get()?.families.find((f) => f.id === session.family())?.role ?? "viewer";
const isOwner = () => role() === "owner"; const isMember = () => ["owner", "member"].includes(role());
const label = (s?: string | null) => (s ?? "").replace(/_/g, " ");
function Field({ label, children }: { label: string; children: React.ReactNode }) { return <label className="field">{label}{children}</label>; }
function useAction(after?: () => void) {
  const [busy, setBusy] = useState(""); const [err, setErr] = useState(""); const [note, setNote] = useState("");
  const run = async (l: string, fn: () => Promise<string | void>) => { setBusy(l); setErr(""); setNote(""); try { const n = await fn(); if (n) setNote(n); after?.(); } catch (e: any) { setErr(e.message); } finally { setBusy(""); } };
  return { busy, err, note, run, msg: <>{err && <div className="err">{err}</div>}{note && <div className="small" style={{ color: "var(--teal)" }}>{note}</div>}</> };
}
const TABS = ["Family", "Security", "Integrations"] as const;

export function Settings() {
  const [tab, setTab] = useState<(typeof TABS)[number]>("Family");
  return (<>
    <div className="tabs">{TABS.map((t) => <button key={t} className={tab === t ? "on" : ""} onClick={() => setTab(t)}>{t}</button>)}</div>
    {tab === "Family" && <div className="grid-2"><Entities /><Members /></div>}
    {tab === "Security" && <Security />}
    {tab === "Integrations" && <Integrations />}
  </>);
}

function Entities() {
  const e = useApi<any[]>("/entities"); const act = useAction(() => e.refetch());
  const [form, setForm] = useState<any | null>(null); const [gst, setGst] = useState<{ id: string; gstin: string; registered_on: string } | null>(null);
  if (e.loading || e.error) return <Status loading={e.loading} error={e.error} />;
  return (<Card title="Entities" action={isMember() ? <button className="btn btn-s" onClick={() => setForm(form ? null : { type: "individual", name: "", pan: "", tax_regime: "new", slab_rate: 30, dob_or_incorp: "" })}><Plus size={14} /> Entity</button> : undefined}>
    {form && <div className="row" style={{ gap: 8, flexWrap: "wrap", alignItems: "flex-end", marginBottom: 8 }}>
      <Field label="Type"><select style={inp} value={form.type} onChange={(ev) => setForm({ ...form, type: ev.target.value })}>{["individual", "huf", "trust", "llp", "company"].map((t) => <option key={t}>{t}</option>)}</select></Field>
      <Field label="Name"><input style={inp} value={form.name} onChange={(ev) => setForm({ ...form, name: ev.target.value })} /></Field>
      {!form.id && <Field label="PAN"><input style={{ ...inp, width: 120 }} value={form.pan} onChange={(ev) => setForm({ ...form, pan: ev.target.value.toUpperCase() })} /></Field>}
      <Field label="Regime"><select style={inp} value={form.tax_regime} onChange={(ev) => setForm({ ...form, tax_regime: ev.target.value })}><option>new</option><option>old</option></select></Field>
      <Field label="Slab %"><input style={{ ...inp, width: 60 }} type="number" value={form.slab_rate} onChange={(ev) => setForm({ ...form, slab_rate: ev.target.value })} /></Field>
      <Field label="DoB / incorporation"><input style={inp} type="date" value={form.dob_or_incorp ?? ""} onChange={(ev) => setForm({ ...form, dob_or_incorp: ev.target.value })} /></Field>
      <button className="btn" disabled={!form.name || !!act.busy} onClick={() => act.run("ent", async () => { const body: any = { type: form.type, name: form.name, tax_regime: form.tax_regime, slab_rate: +form.slab_rate, dob_or_incorp: form.dob_or_incorp || null }; if (!form.id && form.pan) body.pan = form.pan; if (form.id) await api(`/entities/${form.id}`, { method: "PATCH", body: JSON.stringify(body) }); else await api("/entities", { method: "POST", body: JSON.stringify(body) }); setForm(null); return form.id ? "Entity updated" : "Entity added — the PAN is stored encrypted"; })}>{form.id ? "Save" : "Add"}</button></div>}
    {e.data!.map((x) => <div key={x.id} className="attn"><div style={{ flex: 1 }}><b>{x.name}</b> <span className="small mute">{x.type} · PAN ••••{x.pan_last4 ?? "—"} · {x.tax_regime} regime · slab {x.slab_rate}%{x.dob_or_incorp ? ` · ${fmtDate(x.dob_or_incorp)}` : ""}</span>
      <div className="small mute">GSTINs: {(x.gstins ?? []).length ? x.gstins.map((g: any) => `${g.gstin} (${g.state_code}${g.active ? "" : ", inactive"})`).join(", ") : "none"}</div>
      {gst && gst.id === x.id && <GstinForm gst={gst} setGst={setGst} busy={!!act.busy} onAdd={() => act.run("gst", async () => { await api(`/entities/${x.id}/gstins`, { method: "POST", body: JSON.stringify({ gstin: gst.gstin, registered_on: gst.registered_on || null }) }); setGst(null); return "GSTIN added"; })} />}
    </div>{isMember() && <div className="row gap"><button className="btn btn-s" onClick={() => setForm({ id: x.id, type: x.type, name: x.name, tax_regime: x.tax_regime, slab_rate: x.slab_rate ?? 30, dob_or_incorp: x.dob_or_incorp ?? "" })}>Edit</button><button className="btn btn-s" onClick={() => setGst(gst?.id === x.id ? null : { id: x.id, gstin: "", registered_on: "" })}>GSTIN</button></div>}</div>)}
    {act.msg}
  </Card>);
}

function GstinForm({ gst, setGst, busy, onAdd }: { gst: { id: string; gstin: string; registered_on: string }; setGst: (g: { id: string; gstin: string; registered_on: string }) => void; busy: boolean; onAdd: () => void }) {
  return <div className="row" style={{ gap: 8, alignItems: "flex-end", marginTop: 6 }}><Field label="GSTIN"><input style={{ ...inp, width: 170 }} value={gst.gstin} onChange={(ev) => setGst({ ...gst, gstin: ev.target.value.toUpperCase() })} /></Field><Field label="Registered on"><input style={inp} type="date" value={gst.registered_on} onChange={(ev) => setGst({ ...gst, registered_on: ev.target.value })} /></Field><button className="btn btn-s" disabled={gst.gstin.length !== 15 || busy} onClick={onAdd}>Add</button></div>;
}

function Members() {
  const m = useApi<any[]>("/members"); const ents = useApi<any[]>("/entities"); const act = useAction(() => m.refetch()); const me = session.get()?.user.id;
  const [inv, setInv] = useState<any | null>(null); const [link, setLink] = useState("");
  if (m.loading || m.error) return <Status loading={m.loading} error={m.error} />;
  return (<Card title="Members" action={isOwner() ? <button className="btn btn-s" onClick={() => setInv(inv ? null : { email: "", name: "", role: "viewer", entity_scope: "" })}><Plus size={14} /> Invite</button> : undefined}>
    {inv && <div className="row" style={{ gap: 8, flexWrap: "wrap", alignItems: "flex-end", marginBottom: 8 }}>
      <Field label="E-mail"><input style={inp} value={inv.email} onChange={(ev) => setInv({ ...inv, email: ev.target.value })} /></Field><Field label="Name"><input style={inp} value={inv.name} onChange={(ev) => setInv({ ...inv, name: ev.target.value })} /></Field>
      <Field label="Role"><select style={inp} value={inv.role} onChange={(ev) => setInv({ ...inv, role: ev.target.value })}>{["owner", "member", "operator", "viewer"].map((r) => <option key={r}>{r}</option>)}</select></Field>
      <Field label="Entity scope"><select style={inp} value={inv.entity_scope} onChange={(ev) => setInv({ ...inv, entity_scope: ev.target.value })}><option value="">all entities</option>{(ents.data ?? []).map((e) => <option key={e.id} value={e.id}>{e.name} only</option>)}</select></Field>
      <button className="btn" disabled={!inv.email.includes("@") || !!act.busy} onClick={() => act.run("inv", async () => { const r = await api<any>("/auth/invite", { method: "POST", body: JSON.stringify({ email: inv.email, name: inv.name || undefined, role: inv.role, entity_scope: inv.entity_scope ? [inv.entity_scope] : null }) }); setInv(null); if (r.invite_token) setLink(`${location.origin}/invite?email=${encodeURIComponent(r.email)}&token=${r.invite_token}`); return r.email_sent ? `Invitation e-mailed to ${r.email}; it expires ${fmtDate(r.expires_on)}` : `Invitation recorded for ${r.email} (e-mail transport is 'log' — share the link below)`; })}>Send invitation</button></div>}
    {link && <div className="small" style={{ marginBottom: 8, wordBreak: "break-all" }}>Invitation link (shown once outside production): <code>{link}</code></div>}
    {m.data!.map((x) => <div key={x.user_id} className="attn"><div style={{ flex: 1 }}><b>{x.name}</b> <span className="small mute">{x.email}{x.entity_scope?.length ? ` · scoped to ${x.entity_scope.length} entit${x.entity_scope.length === 1 ? "y" : "ies"}` : ""}</span><div className="small mute">{x.accepted_at ? `member since ${fmtDate(x.accepted_at)}` : `invited ${fmtDate(x.invited_at)} — not accepted yet`}</div></div>
      {isOwner() && x.user_id !== me ? <select style={inp} value={x.role} onChange={(ev) => act.run("role", async () => { await api(`/members/${x.user_id}`, { method: "PATCH", body: JSON.stringify({ role: ev.target.value }) }); return `${x.name} is now ${ev.target.value}`; })}>{["owner", "member", "operator", "viewer"].map((r) => <option key={r}>{r}</option>)}</select> : <Pill tone={x.role === "owner" ? "teal" : x.role === "viewer" ? undefined : "blue"}>{x.role}</Pill>}
      {isOwner() && x.user_id !== me && <button className="btn btn-s" disabled={!!act.busy} onClick={() => { if (confirm(`Remove ${x.name} from the family?`)) act.run("rm", async () => { await api(`/members/${x.user_id}`, { method: "DELETE" }); return `${x.name} removed`; }); }}>Remove</button>}
    </div>)}
    <div className="small mute" style={{ marginTop: 6 }}>Roles: owner approves and administers; member plans and records; operator executes and imports; viewer (e.g. the CA) reads what an external-access grant allows. Roles are read on every request.</div>
    {act.msg}
  </Card>);
}

function Security() {
  const act = useAction(); const [setup, setSetup] = useState<any | null>(null); const [code, setCode] = useState(""); const [on, setOn] = useState<boolean | null>(null); const [off, setOff] = useState("");
  return (<div className="grid-2">
    <Card title="Two-factor login (TOTP)">
      <div className="small mute" style={{ marginBottom: 8 }}>With two-factor on, login returns a short-lived token and asks for the six-digit code from your authenticator app before issuing a session. Step-up approvals keep using the same code.</div>
      {!setup && <button className="btn" disabled={!!act.busy} onClick={() => act.run("setup", async () => { setSetup(await api<any>("/auth/mfa/setup", { method: "POST", body: "{}" })); setOn(false); })}><ShieldCheck size={14} /> {on ? "Re-enrol" : "Set up two-factor"}</button>}
      {setup && <div>
        <div className="small">Add this secret to Google Authenticator, Authy or 1Password, then enter the current code:</div>
        <div style={{ margin: "8px 0", fontFamily: "ui-monospace, monospace", fontSize: 18, letterSpacing: 2 }}>{setup.secret.match(/.{1,4}/g)?.join(" ")}</div>
        <div className="small mute" style={{ wordBreak: "break-all" }}>{setup.otpauth_uri}</div>
        <div className="row gap" style={{ marginTop: 8 }}><input style={{ ...inp, width: 100 }} placeholder="000000" value={code} onChange={(ev) => setCode(ev.target.value)} /><button className="btn" disabled={code.length !== 6 || !!act.busy} onClick={() => act.run("confirm", async () => { await api("/auth/mfa/confirm", { method: "POST", body: JSON.stringify({ code }) }); setSetup(null); setCode(""); setOn(true); return "Two-factor is on — your next login will ask for a code"; })}>Confirm</button><button className="btn btn-s" onClick={() => setSetup(null)}>Cancel</button></div>
      </div>}
      {on && <div className="row gap" style={{ marginTop: 10 }}><input style={{ ...inp, width: 100 }} placeholder="code" value={off} onChange={(ev) => setOff(ev.target.value)} /><button className="btn btn-s" disabled={off.length !== 6 || !!act.busy} onClick={() => act.run("off", async () => { await api("/auth/mfa", { method: "DELETE", body: JSON.stringify({ code: off }) }); setOn(false); setOff(""); return "Two-factor switched off"; })}>Switch off</button></div>}
      {act.msg}
    </Card>
    <Card title="Session">
      <div className="small">Signed in as <b>{session.get()?.user.name}</b> ({session.get()?.user.email}) · role <b>{role()}</b> in this family.</div>
      <div className="small mute" style={{ marginTop: 6 }}>Access tokens are short-lived and refreshed silently; approvals and signatures need step-up authentication; every write is audited. Sign out from the rail at the bottom left.</div>
      <div className="small mute" style={{ marginTop: 6 }}>Families you belong to: {session.get()?.families.map((f) => `${f.name} (${f.role})`).join(", ")}.</div>
    </Card>
    <Passkeys />
  </div>);
}

function Passkeys() {
  const list = useApi<{ credentials: any[] }>("/auth/webauthn/credentials"); const act = useAction(() => list.refetch()); const [name, setName] = useState("");
  const register = () => act.run("reg", async () => {
    const opts = await api<any>("/auth/webauthn/register/options", { method: "POST", body: "{}" });
    const response = await startRegistration({ optionsJSON: opts });
    await api("/auth/webauthn/register/verify", { method: "POST", body: JSON.stringify({ response, device_name: name || undefined }) });
    setName(""); return "Passkey registered";
  });
  return (<Card title="Passkeys">
    <div className="small mute" style={{ marginBottom: 8 }}>A passkey (fingerprint, face or security key) approves action-plane intents in place of a typed step-up code.</div>
    <div className="row gap"><input style={inp} placeholder="device name (optional)" value={name} onChange={(ev) => setName(ev.target.value)} /><button className="btn" disabled={!!act.busy} onClick={register}><KeyRound size={14} /> Register this device</button></div>
    {(list.data?.credentials ?? []).map((c: any) => <div key={c.id} className="attn"><span style={{ flex: 1 }}>{c.device_name || "Unnamed device"}<div className="small mute">added {fmtDate(c.created_at)}{c.last_used_at ? ` · last used ${fmtDate(c.last_used_at)}` : ""}</div></span><button className="btn btn-s" disabled={!!act.busy} onClick={() => act.run("rm", async () => { await api(`/auth/webauthn/credentials/${c.id}`, { method: "DELETE" }); return "Passkey removed"; })}>Remove</button></div>)}
    {!(list.data?.credentials ?? []).length && <div className="small mute">No passkeys registered yet.</div>}
    {act.msg}
  </Card>);
}

function Integrations() {
  const h = useApi<any[]>("/integrations/health"); const f = useApi<any>("/feeds/health"); const act = useAction(() => { h.refetch(); f.refetch(); });
  if (h.loading || h.error) return <Status loading={h.loading} error={h.error} />;
  const tone = (s: string) => (s === "healthy" ? "teal" : s === "failed" ? "red" : s === "needs_review" ? "amber" : undefined);
  return (<>
    <Card title="Integrations" action={isOwner() ? <div className="row gap">{["eod", "amfi", "indices", "fx"].map((w) => <button key={w} className="btn btn-s" disabled={!!act.busy} onClick={() => act.run(w, async () => { const r = await api<any>("/feeds/run", { method: "POST", body: JSON.stringify({ which: [w] }) }); return `${w}: ${JSON.stringify(r).slice(0, 160)}`; })}><RefreshCw size={13} /> {w}</button>)}</div> : undefined}>
      <table className="tbl"><thead><tr><th>Source</th><th>Kind</th><th>Status</th><th>Last run</th><th>Detail</th></tr></thead><tbody>{h.data!.map((x) => <tr key={x.source}><td><b>{x.source}</b></td><td>{label(x.kind)}</td><td><Pill tone={tone(x.status) as any}>{label(x.status)}</Pill></td><td>{x.last_run_at ? new Date(x.last_run_at).toLocaleString("en-IN") : "—"}</td><td className="small mute">{x.detail}</td></tr>)}</tbody></table>
      <div className="small mute" style={{ marginTop: 8 }}>"manual" means the source is configured to log or has never run — the worker runs feeds on schedule; owners can trigger one here. Provider credentials (AA, brokers, e-mail, WhatsApp) live in the server environment, never in the browser.</div>
      {act.msg}
    </Card>
    {f.data && <Card title="Feeds">
      <table className="tbl tight"><thead><tr><th>Job</th><th>Source · window</th><th>Last status</th><th>Last ok</th><th className="num">Rows</th></tr></thead><tbody>{(f.data.jobs ?? []).map((j: any) => <tr key={j.job}><td><b>{j.label}</b></td><td className="small mute">{j.source} · {j.window}</td><td><Pill tone={j.last_status === "ok" ? "teal" : j.last_status === "never" ? undefined : "red"}>{j.last_status}</Pill></td><td>{j.last_ok_at ? new Date(j.last_ok_at).toLocaleString("en-IN") : "—"}</td><td className="num">{j.rows ?? "—"}</td></tr>)}</tbody></table>
      <div className="small mute" style={{ marginTop: 8 }}>Stale priced holdings: {f.data.stale_priced_holdings} · latest prices: {(f.data.latest_prices ?? []).map((p: any) => `${p.type} ${p.d}`).join(", ") || "—"} · benchmarks: {(f.data.benchmarks ?? []).map((b: any) => `${b.code} ${b.n}`).join(", ") || "—"}</div>
    </Card>}
  </>);
}
