// The research agent's model call (FO-151/154/156). Read-only tools live in research.ts; this module only turns a prompt
// into JSON. It is optional: without ANTHROPIC_API_KEY (or in tests) every caller falls back to its deterministic path,
// so the pipeline is reproducible offline. The executor process never loads this module.
import type pg from "pg";

export const agentModel = () => process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-6";
export const agentEnabled = () => !!process.env.ANTHROPIC_API_KEY && process.env.NODE_ENV !== "test" && process.env.RESEARCH_AGENT !== "off";

/** One structured call: system + user prompt → the first JSON object/array in the reply, or null on any failure. */
export async function claudeJson<T = any>(system: string, user: string, opts: { maxTokens?: number; timeoutMs?: number } = {}): Promise<T | null> {
  if (!agentEnabled()) return null;
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), opts.timeoutMs ?? 45000);
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", signal: ctl.signal, headers: { "content-type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY!, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: agentModel(), max_tokens: opts.maxTokens ?? 4000, system, messages: [{ role: "user", content: user }] }) });
    if (!r.ok) return null;
    const j: any = await r.json(); const text = (j.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");
    const m = text.match(/```json\s*([\s\S]*?)```/) ?? text.match(/([\[{][\s\S]*[\]}])/); if (!m) return null;
    return JSON.parse(m[1]) as T;
  } catch { return null; } finally { clearTimeout(t); }
}
/** Records that the agent ran (which model, for what) — the audit trail every proposal and digest points at. */
export async function agentSession(c: pg.PoolClient, familyId: string, userId: string | null, purpose: string) {
  return (await c.query("insert into agent_sessions (family_id, user_id, model, purpose, started_at, ended_at) values ($1,$2,$3,$4,now(),now()) returning id", [familyId, userId, agentModel(), purpose])).rows[0].id as string;
}
