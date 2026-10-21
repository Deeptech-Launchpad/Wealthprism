import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { acceptInvite } from "../lib/api";
/** The page a real invite e-mail link lands on: /invite?email=...&token=... — sets a password and signs in. */
export function InviteAccept() {
  const [params] = useSearchParams();
  const email = params.get("email") ?? ""; const token = params.get("token") ?? "";
  const [pw, setPw] = useState(""); const [confirm, setConfirm] = useState(""); const [err, setErr] = useState(""); const [busy, setBusy] = useState(false);
  const nav = useNavigate();
  if (!email || !token) return (
    <div className="login"><div className="card">
      <div className="brand" style={{ color: "var(--navy)" }}><div className="brand-mark" />Family Office</div>
      <div className="err">This invitation link is missing its email or token — copy the full link from the invitation e-mail.</div>
    </div></div>
  );
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setErr("");
    if (pw.length < 10) return setErr("Password must be at least 10 characters.");
    if (pw !== confirm) return setErr("Passwords do not match.");
    setBusy(true);
    try { await acceptInvite(email, token, pw); nav("/"); }
    catch (x: any) { setErr(x.message); } finally { setBusy(false); }
  };
  return (
    <div className="login"><form className="card" onSubmit={submit}>
      <div className="brand" style={{ color: "var(--navy)" }}><div className="brand-mark" />Family Office</div>
      <div className="small mute">You've been invited as <b>{email}</b>. Set a password to accept and sign in.</div>
      <input value={pw} onChange={(e) => setPw(e.target.value)} type="password" placeholder="New password (min. 10 characters)" />
      <input value={confirm} onChange={(e) => setConfirm(e.target.value)} type="password" placeholder="Confirm password" />
      {err && <div className="err">{err}</div>}
      <button className="btn btn-p" type="submit" disabled={busy}>{busy ? "Setting up…" : "Accept invitation"}</button>
    </form></div>
  );
}
