import { PROVIDERS, type Provider } from "@fo/connectors";
const ALLOW = new Set((process.env.EGRESS_ALLOWLIST ?? "").split(",").map((s) => s.trim()).filter(Boolean));
/** Every live call goes through here: the host must be on the deployment's egress allow-list and on the provider's own host list. */
export async function guardedFetch(provider: string, url: string, init: RequestInit = {}, timeoutMs = 20000): Promise<Response> {
  const host = new URL(url).hostname; const spec = PROVIDERS[provider as Provider];
  if (!spec?.hosts.includes(host)) throw new Error(`egress refused: ${host} is not a ${provider} host`);
  if (ALLOW.size && !ALLOW.has(host)) throw new Error(`egress refused: ${host} is not on EGRESS_ALLOWLIST`);
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), timeoutMs);
  try { return await fetch(url, { ...init, signal: ctl.signal }); } finally { clearTimeout(t); }
}
