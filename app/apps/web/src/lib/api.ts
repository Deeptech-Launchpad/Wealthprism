/** Minimal typed API client shared in spirit with the mobile app: bearer token + X-Family-Id on every call. */
export const API_URL = import.meta.env.VITE_API_URL ?? "/api/v1";
export interface Session { access_token: string; refresh_token: string; user: { id: string; email: string; name: string }; families: { id: string; name: string; role: string }[] }
const KEY = "fo.session", FKEY = "fo.family";
export const session = {
  get: (): Session | null => { try { return JSON.parse(localStorage.getItem(KEY) ?? "null"); } catch { return null; } },
  set: (s: Session | null) => (s ? localStorage.setItem(KEY, JSON.stringify(s)) : localStorage.removeItem(KEY)),
  family: (): string | null => localStorage.getItem(FKEY) ?? session.get()?.families[0]?.id ?? null,
  setFamily: (id: string) => localStorage.setItem(FKEY, id),
};
export async function login(email: string, password: string): Promise<Session> {
  const r = await fetch(`${API_URL}/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password }) });
  if (!r.ok) throw new Error((await r.json()).title ?? "Login failed");
  const s = await r.json(); session.set(s); if (s.families[0]) session.setFamily(s.families[0].id); return s;
}
/** Accept an invite: sets the password, then logs in (the accept endpoint itself returns no session). */
export async function acceptInvite(email: string, token: string, password: string): Promise<Session> {
  const r = await fetch(`${API_URL}/auth/invite/accept`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, token, password }) });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).title ?? "Invitation not found, used or expired");
  return login(email, password);
}
/** Always resolves (even for an unknown e-mail, by design — the server never reveals whether the account exists). */
export async function forgotPassword(email: string): Promise<void> {
  const r = await fetch(`${API_URL}/auth/forgot-password`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email }) });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).title ?? "Could not process the request");
}
/** Sets a new password from the e-mailed token, then logs in (the reset endpoint itself returns a session already, but login keeps the two accept flows symmetric). */
export async function resetPassword(email: string, token: string, password: string): Promise<Session> {
  const r = await fetch(`${API_URL}/auth/reset-password`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, token, password }) });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).title ?? "Reset link not found, used or expired");
  const s = await r.json(); session.set(s); if (s.families[0]) session.setFamily(s.families[0].id); return s;
}
/** Self-service sign-up (open signup — see routes/auth.ts for how to revert to invite-only). */
export async function register(email: string, password: string, name: string, familyName: string): Promise<Session> {
  const r = await fetch(`${API_URL}/auth/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password, name, family_name: familyName }) });
  if (!r.ok) throw new Error((await r.json()).title ?? "Could not create account");
  const s = await r.json(); session.set(s); if (s.families[0]) session.setFamily(s.families[0].id); return s;
}
/** Silent token refresh: the access token lives 15 minutes, the refresh token 30 days — this is what actually
 *  uses the refresh token (it sat unused before this fix, so every user was logged out after 15 minutes
 *  regardless of the refresh token's real 30-day life). Concurrent 401s share one in-flight refresh instead of
 *  each firing their own. `/auth/refresh` does not return `user`, so the existing one is kept as-is. */
let refreshing: Promise<Session | null> | null = null;
async function refreshSession(): Promise<Session | null> {
  const cur = session.get();
  if (!cur?.refresh_token) return null;
  if (!refreshing) refreshing = (async () => {
    try {
      const r = await fetch(`${API_URL}/auth/refresh`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ refresh_token: cur.refresh_token }) });
      if (!r.ok) return null;
      const j = await r.json();
      const next: Session = { ...cur, access_token: j.access_token, refresh_token: j.refresh_token, families: j.families ?? cur.families };
      session.set(next);
      return next;
    } catch { return null; }
    finally { refreshing = null; }
  })();
  return refreshing;
}
/** One request, with a silent-refresh-and-retry on a 401 before giving up and signing out. */
async function request(path: string, init: RequestInit): Promise<Response> {
  const fam = session.family();
  const withAuth = (s: Session | null) => ({ ...(init.headers ?? {}), ...(s ? { Authorization: `Bearer ${s.access_token}` } : {}), ...(fam ? { "X-Family-Id": fam } : {}) });
  let r = await fetch(`${API_URL}${path}`, { ...init, headers: withAuth(session.get()) });
  if (r.status === 401) {
    const refreshed = await refreshSession();
    if (refreshed) r = await fetch(`${API_URL}${path}`, { ...init, headers: withAuth(refreshed) });
    else { session.set(null); location.href = "/login"; throw new Error("Session expired"); }
  }
  return r;
}
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const r = await request(path, { ...init, headers: { ...(init.body != null ? { "Content-Type": "application/json" } : {}), ...(init.headers ?? {}) } });
  if (r.status === 401) { session.set(null); location.href = "/login"; throw new Error("Session expired"); }
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).title ?? `HTTP ${r.status}`);
  if (r.status === 204) return null as T;   // "deleted" replies carry no body; parsing one would throw after the action had worked
  return r.json();
}
/** POST JSON where 202/422 carry a useful body (import jobs) rather than an error. */
export async function apiJson<T>(path: string, body: unknown): Promise<T & { status_code: number }> {
  const r = await request(path, { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } });
  if (r.status === 401) { session.set(null); location.href = "/login"; throw new Error("Session expired"); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok && r.status !== 202 && r.status !== 422) throw new Error(j.title ?? `HTTP ${r.status}`);
  return { ...j, status_code: r.status };
}
/** Multipart upload (imports): the browser sets the boundary, so no Content-Type header here. */
export async function apiUpload<T>(path: string, form: FormData): Promise<T & { status_code: number }> {
  const r = await request(path, { method: "POST", body: form });
  if (r.status === 401) { session.set(null); location.href = "/login"; throw new Error("Session expired"); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok && r.status !== 202 && r.status !== 422) throw new Error(j.title ?? `HTTP ${r.status}`);
  return { ...j, status_code: r.status };
}
export const inr = (v: string | number | null | undefined) => { const n = Number(v ?? 0); if (Math.abs(n) >= 1e5) return `₹${(n / 1e5).toFixed(2)} L`; return `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 0 })}`; };
