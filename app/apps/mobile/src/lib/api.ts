/** Mobile API client — same contract as the web client; tokens in SecureStore, family id in AsyncStorage. */
import * as SecureStore from "expo-secure-store";
import AsyncStorage from "@react-native-async-storage/async-storage";
import Constants from "expo-constants";
export const API_URL: string = (Constants.expoConfig?.extra as any)?.apiUrl ?? "http://localhost:4000/api/v1";
export interface Session { access_token: string; refresh_token: string; user: { id: string; email: string; name: string }; families: { id: string; name: string; role: string }[] }
let cached: Session | null = null; let family: string | null = null;
export const session = {
  async load(): Promise<Session | null> { const raw = await SecureStore.getItemAsync("fo.session"); cached = raw ? JSON.parse(raw) : null; family = (await AsyncStorage.getItem("fo.family")) ?? cached?.families[0]?.id ?? null; return cached; },
  get: () => cached, family: () => family,
  async set(s: Session | null) { cached = s; if (s) { await SecureStore.setItemAsync("fo.session", JSON.stringify(s)); if (!family && s.families[0]) await session.setFamily(s.families[0].id); } else await SecureStore.deleteItemAsync("fo.session"); },
  async setFamily(id: string) { family = id; await AsyncStorage.setItem("fo.family", id); },
};
export async function login(email: string, password: string): Promise<Session> {
  const r = await fetch(`${API_URL}/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password }) });
  if (!r.ok) throw new Error((await r.json()).title ?? "Login failed");
  const s = (await r.json()) as Session; await session.set(s); return s;
}
async function refresh(): Promise<boolean> {
  if (!cached) return false;
  const r = await fetch(`${API_URL}/auth/refresh`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ refresh_token: cached.refresh_token }) });
  if (!r.ok) { await session.set(null); return false; }
  const j = await r.json(); await session.set({ ...cached, ...j }); return true;
}
export async function api<T>(path: string, init: RequestInit = {}, retry = true): Promise<T> {
  const r = await fetch(`${API_URL}${path}`, { ...init, headers: { "Content-Type": "application/json", ...(cached ? { Authorization: `Bearer ${cached.access_token}` } : {}), ...(family ? { "X-Family-Id": family } : {}), ...((init.headers as any) ?? {}) } });
  if (r.status === 401 && retry && (await refresh())) return api<T>(path, init, false);
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).title ?? `HTTP ${r.status}`);
  return r.json();
}
export const inr = (v: string | number | null | undefined) => { const n = Number(v ?? 0); if (Math.abs(n) >= 1e5) return `₹${(n / 1e5).toFixed(2)} L`; return `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 0 })}`; };
export const fmtDate = (d: string | null) => (d ? new Date(d).toLocaleDateString("en-IN", { day: "2-digit", month: "short" }) : "—");
