import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { resetPassword } from "../lib/api";
/** The page a "forgot password" e-mail link lands on: /reset-password?email=...&token=... — sets a new password and signs in. */
export function ResetPassword() {
  const [params] = useSearchParams();
  const email = params.get("email") ?? ""; const token = params.get("token") ?? "";
  const [pw, setPw] = useState(""); const [confirm, setConfirm] = useState(""); const [err, setErr] = useState(""); const [busy, setBusy] = useState(false);
  const nav = useNavigate();
  if (!email || !token) return (
    <div className="login"><div className="card">
      <div className="brand" style={{ color: "var(--navy)" }}><div className="brand-mark" />Family Office</div>
      <div className="err">This reset link is missing its email or token — copy the full link from the reset e-mail.</div>
    </div></div>
  );
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setErr("");
    if (pw.length < 10) return setErr("Password must be at least 10 characters.");
    if (pw !== confirm) return setErr("Passwords do not match.");
    setBusy(true);
    try { await resetPassword(email, token, pw); nav("/"); }
    catch (x: any) { setErr(x.message); } finally { setBusy(false); }
  };
  return (
    <div className="login"><form className="card" onSubmit={submit}>
      <div className="brand" style={{ color: "var(--navy)" }}><div className="brand-mark" />Family Office</div>
      <div className="small mute">Resetting the password for <b>{email}</b>.</div>
      <input value={pw} onChange={(e) => setPw(e.target.value)} type="password" placeholder="New password (min. 10 characters)" />
      <input value={confirm} onChange={(e) => setConfirm(e.target.value)} type="password" placeholder="Confirm password" />
      {err && <div className="err">{err}</div>}
      <button className="btn btn-p" type="submit" disabled={busy}>{busy ? "Resetting…" : "Reset password"}</button>
    </form></div>
  );
}
