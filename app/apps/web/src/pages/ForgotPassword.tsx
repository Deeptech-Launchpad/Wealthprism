import { useState } from "react";
import { Link } from "react-router-dom";
import { forgotPassword } from "../lib/api";

export function ForgotPassword() {
  const [email, setEmail] = useState(""); const [sent, setSent] = useState(false); const [err, setErr] = useState(""); const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setErr(""); setBusy(true);
    try { await forgotPassword(email); setSent(true); }
    catch (x: any) { setErr(x.message); } finally { setBusy(false); }
  };
  return (
    <div className="login"><form className="card" onSubmit={submit}>
      <div className="brand" style={{ color: "var(--navy)" }}><div className="brand-mark" />Family Office</div>
      {sent ? (
        <div className="small mute">If an account exists for <b>{email}</b>, a password reset link has been sent. It expires in 1 hour.</div>
      ) : (
        <>
          <div className="small mute">Enter your account e-mail and we will send you a reset link.</div>
          <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Email" />
          {err && <div className="err">{err}</div>}
          <button className="btn btn-p" type="submit" disabled={busy || !email.trim()}>{busy ? "Sending…" : "Send reset link"}</button>
        </>
      )}
      <Link className="small mute" to="/login" style={{ marginTop: 8 }}>Back to sign in</Link>
    </form></div>
  );
}
