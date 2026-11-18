import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Eye, EyeOff } from "lucide-react";
import { login, register, apiJson, session, API_URL, verifyMfa, type Session } from "../lib/api";
export function Login() {
  // the demo user is pre-filled only when running locally (vite dev); a built, deployed copy starts with empty fields
  const [email, setEmail] = useState(import.meta.env.DEV ? "arjun@example.com" : ""); const [pw, setPw] = useState(import.meta.env.DEV ? "Prototype!2026" : ""); const [err, setErr] = useState(""); const [showPw, setShowPw] = useState(false); const nav = useNavigate();
  // existing email, signed in, but no owner role anywhere — offer to add a new owned account
  const [needsOwner, setNeedsOwner] = useState(false);
  // user explicitly asked to self-register — never inferred from a failed login, since "invalid credentials" also
  // covers an existing account with the wrong password, and this app can't tell the two apart (nor should it hint at
  // which, same reason /auth/forgot-password never says whether an e-mail is registered)
  const [wantsNew, setWantsNew] = useState(false);
  // whether the server accepts new sign-ups (ALLOW_SIGNUP); when it does not, the form is hidden and the page says to ask for an invite
  const [signupOpen, setSignupOpen] = useState(false);
  useEffect(() => { fetch(`${API_URL}/auth/config`).then((r) => r.json()).then((j) => setSignupOpen(!!j.signup_open)).catch(() => setSignupOpen(false)); }, []);
  const [newFamilyName, setNewFamilyName] = useState(""); const [fullName, setFullName] = useState(""); const [regEmail, setRegEmail] = useState(""); const [regPw, setRegPw] = useState(""); const [showRegPw, setShowRegPw] = useState(false); const [mfaToken, setMfaToken] = useState(""); const [mfaCode, setMfaCode] = useState(""); const [creating, setCreating] = useState(false); const [createErr, setCreateErr] = useState("");
  const resetExtras = () => { setNeedsOwner(false); setCreateErr(""); };
  const createOwnerAccount = async () => {
    if (!newFamilyName.trim()) return; setCreating(true); setCreateErr("");
    try { const r = await apiJson<{ id: string; families: Session["families"] }>("/families", { name: newFamilyName.trim() }); session.set({ ...session.get()!, families: r.families }); session.setFamily(r.id); nav("/"); }
    catch (x: any) { setCreateErr(x.message); } finally { setCreating(false); }
  };
  const registerAndCreate = async () => {
    if (!newFamilyName.trim() || !fullName.trim() || !regEmail.trim() || regPw.length < 8) return; setCreating(true); setCreateErr("");
    try { await register(regEmail.trim(), regPw, fullName.trim(), newFamilyName.trim()); nav("/"); }
    catch (x: any) { setCreateErr(x.message); } finally { setCreating(false); }
  };
  return (
    <div className="login"><form className="card" onSubmit={async (e) => {
      e.preventDefault(); setErr(""); resetExtras();
      try { const s: any = await login(email, pw); if (s.mfa_required) { setMfaToken(s.mfa_token); return; } if (s.families.some((f: any) => f.role === "owner")) { nav("/"); return; } setNeedsOwner(true); }
      catch (x: any) { setErr(x.message); }
    }}>
      <div className="brand" style={{ color: "var(--navy)" }}><div className="brand-mark" />Family Office</div>
      <input value={email} onChange={(e) => { setEmail(e.target.value); resetExtras(); }} placeholder="Email" /><div style={{ position: "relative" }}><input type={showPw ? "text" : "password"} value={pw} onChange={(e) => setPw(e.target.value)} placeholder="Password" style={{ width: "100%", boxSizing: "border-box", paddingRight: 40 }} /><button type="button" onClick={() => setShowPw((v) => !v)} aria-label={showPw ? "Hide password" : "Show password"} title={showPw ? "Hide password" : "Show password"} style={{ position: "absolute", right: 8, top: "50%", transform: "translateY(-50%)", background: "none", border: 0, padding: 4, cursor: "pointer", color: "var(--mute, #6b7280)", display: "flex" }}>{showPw ? <EyeOff size={18} /> : <Eye size={18} />}</button></div>
      {err && <div className="err">{err}</div>}
      {mfaToken && <div className="card" style={{ marginTop: 12 }}>
        <div className="small mute">Two-step sign-in is on for this account. Enter the 6-digit code from your authenticator app.</div>
        <input inputMode="numeric" maxLength={6} value={mfaCode} onChange={(e) => setMfaCode(e.target.value.replace(/\D/g, ""))} placeholder="6-digit code" />
        <button className="btn btn-p" type="button" disabled={mfaCode.length !== 6} onClick={async () => { try { await verifyMfa(mfaToken, mfaCode); nav("/"); } catch (x: any) { setErr(x.message); } }}>Verify and sign in</button>
      </div>}
      <button className="btn btn-p" type="submit">Sign in</button>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <Link className="small mute" to="/forgot-password">Forgot password?</Link>
        {signupOpen ? <a className="small mute" style={{ cursor: "pointer" }} onClick={() => setWantsNew(!wantsNew)}>{wantsNew ? "I already have an account" : "New here? Create an account"}</a> : <span className="small mute">Ask an owner to invite you</span>}
      </div>
      {import.meta.env.DEV && <div className="small mute">Seeded users: arjun / priya / ops / ca @example.com · Prototype!2026</div>}
    </form>
      {needsOwner && <div className="card" style={{ marginTop: 12 }}>
        <div className="small mute">You are not an owner on any account yet.</div>
        <input value={newFamilyName} onChange={(e) => setNewFamilyName(e.target.value)} placeholder="New family / account name" />
        {createErr && <div className="err">{createErr}</div>}
        <button className="btn btn-p" type="button" disabled={creating || !newFamilyName.trim()} onClick={createOwnerAccount}>Create owner account</button>
        <button className="btn btn-s" type="button" style={{ marginTop: 8 }} onClick={() => nav("/")}>Continue to my account</button>
      </div>}
      {wantsNew && signupOpen && <div className="card" style={{ marginTop: 12 }}>
        <div className="small mute">Create a brand-new account and become its owner. If {regEmail || "this email"} already has an account, this will fail — sign in above instead, or use Forgot password.</div>
        <input type="email" value={regEmail} onChange={(e) => setRegEmail(e.target.value)} placeholder="Email" />
        <div style={{ position: "relative" }}><input type={showRegPw ? "text" : "password"} value={regPw} onChange={(e) => setRegPw(e.target.value)} placeholder="Password (at least 8 characters)" style={{ width: "100%", paddingRight: 36 }} /><button type="button" onClick={() => setShowRegPw(!showRegPw)} aria-label={showRegPw ? "Hide password" : "Show password"} style={{ position: "absolute", right: 8, top: "50%", transform: "translateY(-50%)", background: "none", border: 0, cursor: "pointer", color: "var(--mute)" }}>{showRegPw ? <EyeOff size={16} /> : <Eye size={16} />}</button></div>
        <input value={fullName} onChange={(e) => setFullName(e.target.value)} placeholder="Your name" />
        <input value={newFamilyName} onChange={(e) => setNewFamilyName(e.target.value)} placeholder="New family / account name" />
        {createErr && <div className="err">{createErr}</div>}
        <button className="btn btn-p" type="button" disabled={creating || !newFamilyName.trim() || !fullName.trim() || !regEmail.trim() || regPw.length < 8} onClick={registerAndCreate}>Create owner account</button>
        {regPw.length > 0 && regPw.length < 8 && <div className="small mute">Password must be at least 8 characters.</div>}
      </div>}
    </div>
  );
}
