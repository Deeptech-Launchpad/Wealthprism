// Research pipeline (FO-150..157): ingest → extract → cluster → assess against the effective policy → propose → digest →
// track record. The agent (agent.ts) is optional; every step has a deterministic path so the seeded week reproduces offline.
import { createHash } from "node:crypto";
import type pg from "pg";
import { allocClassOf, concentration, ratingRank, type PolicyClauses } from "@fo/finance";
import { governingPolicy, effectiveFor, snapshotFor } from "./policy.js";
import { floatFor } from "./rebalance.js";
import { claudeJson, agentEnabled, agentSession, agentModel } from "./agent.js";
import { notifyTask } from "./notify.js";
import { createIntent } from "./actions.js";
import { ocrText, needsOcr } from "./documents.js";
import { decryptSecret } from "@fo/connectors";

export class ResearchError extends Error { constructor(public status: number, message: string, public extra?: unknown) { super(message); } }
export const iso = (d: any) => (d ? new Date(d).toISOString().slice(0, 10) : null);
const today = () => new Date().toISOString().slice(0, 10);
const r2 = (n: number) => Math.round(n * 100) / 100;
const addMonths = (d: string, m: number) => { const x = new Date(d + "T00:00:00Z"); x.setUTCMonth(x.getUTCMonth() + m); return x.toISOString().slice(0, 10); };
const addDays = (d: string, n: number) => new Date(Date.parse(d) + n * 86400000).toISOString().slice(0, 10);
export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
export type Action = "buy" | "sell" | "hold" | "accumulate" | "reduce" | "avoid" | "switch" | "subscribe" | "redeem" | "watch";
const ACTIONS: Action[] = ["buy", "sell", "hold", "accumulate", "reduce", "avoid", "switch", "subscribe", "redeem", "watch"];
export const directionOf = (a: string) => (["buy", "accumulate", "subscribe"].includes(a) ? "bullish" : ["sell", "reduce", "avoid", "redeem"].includes(a) ? "bearish" : "neutral");
const CONV: Record<string, number> = { high: 85, medium: 60, low: 35 };
const NO_CONFLICT = (s: string | null | undefined) => !s || ["none", "—", "-", "nil"].includes(s.trim().toLowerCase());

export async function settingsFor(c: pg.PoolClient, familyId: string) {
  return (await c.query("select * from research_settings where family_id=$1", [familyId])).rows[0] ?? (await c.query("insert into research_settings (family_id) values ($1) on conflict (family_id) do update set family_id=excluded.family_id returning *", [familyId])).rows[0];
}
const ownerUser = async (c: pg.PoolClient, familyId: string) => (await c.query("select user_id from family_members where family_id=$1 and role='owner' order by created_at limit 1", [familyId])).rows[0]?.user_id as string;

// ---------- instrument resolution ----------
export interface CatEntry { id: string; name: string; symbol: string | null; type: string; asset_class: string | null; aliases: string[] }
const ALIASES: Record<string, string[]> = { LT: ["l&t", "larsen", "larsen and toubro"], HDFCBANK: ["hdfc bank"], TCS: ["tcs", "tata consultancy"], TATAMOTORS: ["tata motors", "tamo"] };
const norm = (s: string) => s.toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
export async function catalogue(c: pg.PoolClient): Promise<CatEntry[]> {
  return (await c.query("select id, name, symbol, type, asset_class, amfi_code, isin from instruments order by length(name) desc")).rows.map((i) => ({ id: i.id, name: i.name, symbol: i.symbol, type: i.type, asset_class: i.asset_class,
    aliases: [norm(i.name), norm(i.name.replace(/ - direct growth| - regular growth| fund$/gi, "")), ...(i.symbol ? [i.symbol.toLowerCase()] : []), ...(i.isin ? [i.isin.toLowerCase()] : []), ...(i.amfi_code ? [i.amfi_code] : []), ...((ALIASES[i.symbol ?? ""] ?? []).map(norm))].filter((a) => a.length >= 3) }));
}
export function resolveInstrument(text: string, cat: CatEntry[]): CatEntry | null {
  const t = norm(text); if (!t) return null;
  const sym = text.match(/\(([A-Z][A-Z0-9&.\-]{1,15})\)/)?.[1]; if (sym) { const bySym = cat.find((i) => i.symbol && i.symbol.toUpperCase() === sym.toUpperCase()); if (bySym) return bySym; }
  return cat.find((i) => i.aliases.some((a) => a === t || t.includes(a) || (a.includes(t) && t.length >= 6))) ?? null;
}

// ---------- extraction ----------
export interface Extracted { instrument_id: string | null; instrument_text: string; action: Action; thesis: string | null; target_price: number | null; stop_loss: number | null; horizon_months: number | null; conviction: "high" | "medium" | "low"; published_on: string; price_at_publish: number | null; confidence: number; flags: string[] }
const num = (s?: string | null) => { if (!s) return null; const n = Number(String(s).replace(/[₹,\s]/g, "")); return Number.isFinite(n) ? n : null; };
const VERB: [RegExp, Action][] = [[/\b(?:we (?:are|remain) buyers of|initiate(?:d)? (?:coverage )?(?:with|at) buy|going to double|will double|multi-?bagger|(?:top pick|buy|add)\b)/i, "buy"], [/\baccumulat/i, "accumulate"], [/\b(?:subscribe|would subscribe)/i, "subscribe"], [/\b(?:sell|exit|book profits)\b/i, "sell"], [/\b(?:reduce|trim|underweight)\b/i, "reduce"], [/\bavoid\b/i, "avoid"], [/\bredeem\b/i, "redeem"], [/\bswitch\b/i, "switch"], [/\b(?:hold|not adding|full weight)\b/i, "hold"], [/\bwatch(?:list)?\b/i, "watch"]];
/** Deterministic extractor: structured call lines (ACTION | Instrument (SYMBOL) | CMP | TP | SL | 12M | High) with the thesis on the next line,
 *  then prose sentences that pair an action verb with a known instrument (or a capitalised company phrase when unknown). */
export function extractHeuristic(text: string, cat: CatEntry[], receivedOn: string): Extracted[] {
  const out: Extracted[] = []; const lines = text.split(/\r?\n/).map((l) => l.trim());
  const dateM = text.match(/\bDate:\s*(\d{4}-\d{2}-\d{2})/i) ?? text.match(/\b(\d{4}-\d{2}-\d{2})\b/); const published = dateM?.[1] ?? receivedOn;
  const seen = new Set<string>();
  const push = (e: Omit<Extracted, "published_on" | "price_at_publish">) => { const k = `${e.instrument_id ?? norm(e.instrument_text)}|${e.action}`; if (seen.has(k)) return; seen.add(k); out.push({ ...e, published_on: published, price_at_publish: null }); };
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(BUY|SELL|HOLD|ACCUMULATE|REDUCE|AVOID|SWITCH|SUBSCRIBE|REDEEM|WATCH|ADD)\s*[|:–-]\s*(.+)$/i); if (!m) continue;
    const parts = m[2].split("|").map((p) => p.trim()); const name = parts[0]; const rest = parts.slice(1).join(" | ");
    const inst = resolveInstrument(name, cat); const action = (m[1].toLowerCase() === "add" ? "accumulate" : m[1].toLowerCase()) as Action;
    const tp = rest.match(/(?:TP|Target)\s*₹?\s*([\d,\.]+)/i)?.[1], sl = rest.match(/(?:SL|Stop(?:\s*loss)?)\s*₹?\s*([\d,\.]+)/i)?.[1], hz = rest.match(/(\d{1,2})\s*M\b/i)?.[1], cv = rest.match(/\b(High|Medium|Low)\b/i)?.[1];
    const thesis = lines[i + 1] && !/^(BUY|SELL|HOLD|ACCUMULATE|REDUCE|AVOID|SWITCH|SUBSCRIBE|REDEEM|WATCH|ADD)\s*[|:–-]/i.test(lines[i + 1]) ? lines[i + 1] : null;
    push({ instrument_id: inst?.id ?? null, instrument_text: inst?.name ?? name.replace(/\s*\([A-Z0-9&.\-]+\)\s*$/, ""), action, thesis, target_price: num(tp), stop_loss: num(sl), horizon_months: hz ? Number(hz) : null, conviction: (cv?.toLowerCase() as any) ?? "medium", confidence: r2(0.86 + (inst ? 0.06 : 0) + (tp ? 0.03 : 0) + (thesis ? 0.03 : 0)), flags: inst ? [] : ["instrument_unresolved"] });
  }
  if (out.length) return out;
  for (const sRaw of text.replace(/\n+/g, " ").split(/(?<=[.!?])\s+/)) {
    const s = sRaw.trim(); if (s.length < 12) continue;
    const verb = VERB.find(([re]) => re.test(s)); if (!verb) continue;
    let inst = resolveInstrument(s, cat); let name = inst?.name ?? null;
    if (!inst) { const cap = s.match(/\b([A-Z][\w&.]*(?:\s+[A-Z][\w&.]*){1,4}\s+(?:Ltd|Limited|Fund|Infra|Industries|Bank|Finance))\b/)?.[1]; if (!cap) continue; name = cap; }
    const tp = s.match(/target(?:\s*price)?\s*(?:of\s*)?₹?\s*([\d,]{3,})/i)?.[1], sl = s.match(/stop(?:\s*loss)?\s*(?:at\s*)?₹?\s*([\d,]{3,})/i)?.[1], hz = s.match(/(\d{1,2})\s*(?:-\s*\d{1,2}\s*)?months?/i)?.[1];
    const conviction = /high conviction|strong|going to double/i.test(s) ? "high" : /modest|low conviction|tentative/i.test(s) ? "low" : "medium";
    const flags = [...(inst ? [] : ["instrument_unresolved"]), ...(/going to double|guaranteed|sure shot/i.test(s) ? ["hype"] : []), ...(/insider|on the board|inside information|not public|before (?:the )?announcement/i.test(text) ? ["possible_insider_information"] : [])];
    push({ instrument_id: inst?.id ?? null, instrument_text: name!, action: verb[1], thesis: s.slice(0, 400), target_price: num(tp), stop_loss: num(sl), horizon_months: hz ? Number(hz) : null, conviction, confidence: r2((inst ? 0.74 : 0.52) + (tp ? 0.08 : 0) - (flags.includes("hype") ? 0.1 : 0)), flags });
  }
  return out;
}
export async function extractRecommendations(c: pg.PoolClient, text: string, receivedOn: string): Promise<{ recs: Extracted[]; model: string | null }> {
  const cat = await catalogue(c); let recs = extractHeuristic(text, cat, receivedOn); let model: string | null = null;
  if (agentEnabled()) {
    const llm = await claudeJson<any[]>("You extract investment recommendations from research text for a family office. Reply with a JSON array only. Each element: {instrument_text, symbol|null, action (buy|sell|hold|accumulate|reduce|avoid|switch|subscribe|redeem|watch), thesis, target_price|null, stop_loss|null, horizon_months|null, conviction (high|medium|low), published_on (YYYY-MM-DD)|null, confidence 0-1}. Never invent instruments; keep unresolved names as written.", `Known instruments: ${cat.slice(0, 200).map((i) => `${i.name}${i.symbol ? ` (${i.symbol})` : ""}`).join("; ")}\n\nText:\n${text.slice(0, 12000)}`);
    if (Array.isArray(llm) && llm.length) { model = agentModel(); recs = llm.filter((r) => ACTIONS.includes(r.action)).map((r) => { const inst = resolveInstrument(r.symbol ? `${r.instrument_text} (${r.symbol})` : r.instrument_text ?? "", cat); return { instrument_id: inst?.id ?? null, instrument_text: inst?.name ?? String(r.instrument_text ?? "").slice(0, 200), action: r.action, thesis: r.thesis ?? null, target_price: num(r.target_price), stop_loss: num(r.stop_loss), horizon_months: r.horizon_months == null ? null : Number(r.horizon_months), conviction: ["high", "medium", "low"].includes(r.conviction) ? r.conviction : "medium", published_on: /^\d{4}-\d{2}-\d{2}$/.test(r.published_on ?? "") ? r.published_on : receivedOn, price_at_publish: null, confidence: Math.max(0, Math.min(1, Number(r.confidence ?? 0.7))), flags: inst ? [] : ["instrument_unresolved"] }; }); }
  }
  for (const r of recs) if (r.instrument_id) r.price_at_publish = await priceAt(c, r.instrument_id, r.published_on);
  return { recs, model };
}
export async function priceAt(c: pg.PoolClient, instrumentId: string, date: string) { const r = (await c.query("select close from prices where instrument_id=$1 and price_date <= $2 order by price_date desc limit 1", [instrumentId, date])).rows[0]; return r ? Number(r.close) : null; }

// ---------- ingestion (FO-150) ----------
export interface IngestInput { channel_id?: string | null; channel_kind?: string | null; title?: string | null; sender?: string | null; body_text: string; received_at?: string | null; source_id?: string | null; document_id?: string | null }
/** Attribute a sender to a source: the channel's allow-list, then the channel default, then any source whose contact matches; else triage. */
export async function attributeSender(c: pg.PoolClient, familyId: string, channel: any | null, sender: string | null) {
  const s = (sender ?? "").trim().toLowerCase(); const allow = channel?.config?.sender_allowlist ?? {};
  for (const [k, v] of Object.entries<string>(allow)) if (k.toLowerCase() === s || (s && k.toLowerCase().includes(s)) || (s && s.includes(k.toLowerCase()))) return v;
  if (channel?.default_source_id) return channel.default_source_id as string;
  if (s) { const m = (await c.query("select id from research_sources where family_id=$1 and lower(contact)=$2 and active limit 1", [familyId, s])).rows[0]; if (m) return m.id as string; }
  return null;
}
export async function ingestItem(c: pg.PoolClient, familyId: string, input: IngestInput, userId?: string | null) {
  const text = (input.body_text ?? "").trim(); if (text.length < 10) throw new ResearchError(422, "Nothing to ingest — the text is empty");
  const hash = sha256(text);
  const dup = (await c.query("select id from research_items where family_id=$1 and sha256=$2", [familyId, hash])).rows[0];
  if (dup) return { item: await itemView(c, dup.id), duplicate: true, recommendations: [] as any[] };
  const channel = input.channel_id ? (await c.query("select * from research_channels where id=$1 and family_id=$2", [input.channel_id, familyId])).rows[0] : (await c.query("select * from research_channels where family_id=$1 and kind=$2::channel_kind order by active desc limit 1", [familyId, input.channel_kind ?? "paste"])).rows[0] ?? null;
  const sourceId = input.source_id ?? (await attributeSender(c, familyId, channel, input.sender ?? null));
  const receivedAt = input.received_at ?? new Date().toISOString();
  const row = (await c.query("insert into research_items (family_id, channel_id, channel_kind, source_id, received_at, title, sender, body_text, document_id, sha256, status, triage_note) values ($1,$2,$3::channel_kind,$4,$5,$6,$7,$8,$9,$10,'new',$11) returning id", [familyId, channel?.id ?? null, (channel?.kind ?? input.channel_kind ?? "paste"), sourceId, receivedAt, input.title ?? text.split("\n")[0].slice(0, 140), input.sender ?? null, text, input.document_id ?? null, hash, sourceId ? null : "unattributed sender — pick a source or add the sender to a channel allow-list"])).rows[0];
  const recs = await extractItem(c, familyId, row.id, userId ?? null);
  return { item: await itemView(c, row.id), duplicate: false, recommendations: recs };
}
/** Extract (or re-extract) one item. Low confidence (< 0.7) waits in the review queue as status 'new'. */
export async function extractItem(c: pg.PoolClient, familyId: string, itemId: string, userId: string | null) {
  const it = (await c.query("select * from research_items where id=$1 and family_id=$2", [itemId, familyId])).rows[0]; if (!it) throw new ResearchError(404, "Item not found");
  const { recs, model } = await extractRecommendations(c, it.body_text ?? "", iso(it.received_at)!);
  const sessionId = model ? await agentSession(c, familyId, userId ?? await ownerUser(c, familyId), `research.extract ${itemId}`) : null;
  await c.query("delete from research_recommendations where item_id=$1 and status in ('new','extracted') and cluster_id is null", [itemId]);
  const out: any[] = [];
  for (const r of recs) {
    const row = (await c.query("insert into research_recommendations (family_id, item_id, source_id, instrument_id, instrument_text, action, thesis, target_price, stop_loss, horizon_months, conviction, published_on, price_at_publish, status, confidence, review_note) values ($1,$2,$3,$4,$5,$6::rec_action,$7,$8,$9,$10,$11,$12,$13,$14::rec_status,$15,$16) returning *",
      [familyId, itemId, it.source_id, r.instrument_id, r.instrument_text, r.action, r.thesis, r.target_price, r.stop_loss, r.horizon_months, r.conviction, r.published_on, r.price_at_publish, r.confidence >= 0.7 || r.flags.length ? "extracted" : "new", r.confidence, r.flags.length ? r.flags.join(", ") : null])).rows[0];
    out.push(row);
  }
  await c.query("update research_items set status=$2::rec_status, extraction_id=null where id=$1", [itemId, out.length ? (out.every((r) => r.status === "new") ? "new" : "extracted") : "extracted"]);
  if (sessionId) await c.query("update research_recommendations set review_note = coalesce(review_note || '; ', '') || $2 where item_id=$1", [itemId, `extracted by ${model}`]);
  return out;
}
export async function itemView(c: pg.PoolClient, id: string) {
  const it = (await c.query("select i.*, s.name source_name, s.kind source_kind, s.trust_score, ch.label channel_label, (select count(*) from research_recommendations r where r.item_id=i.id) recommendation_count, (select count(*) from research_recommendations r where r.item_id=i.id and r.status='new') review_count, (select count(*) from research_recommendations r where r.item_id=i.id and r.status='dismissed') dismissed_count from research_items i left join research_sources s on s.id=i.source_id left join research_channels ch on ch.id=i.channel_id where i.id=$1", [id])).rows[0];
  if (!it) throw new ResearchError(404, "Item not found");
  const recs = (await c.query("select r.*, i.name instrument_name, i.symbol from research_recommendations r left join instruments i on i.id=r.instrument_id where r.item_id=$1 order by r.created_at", [id])).rows;
  return { ...it, recommendation_count: Number(it.recommendation_count), review_count: Number(it.review_count), dismissed_count: Number(it.dismissed_count), recommendations: recs.map(recView) };
}
export const recView = (r: any) => ({ ...r, target_price: r.target_price == null ? null : Number(r.target_price), stop_loss: r.stop_loss == null ? null : Number(r.stop_loss), price_at_publish: r.price_at_publish == null ? null : Number(r.price_at_publish), confidence: r.confidence == null ? null : Number(r.confidence), published_on: iso(r.published_on), direction: directionOf(r.action) });
/** Minimal RSS/Atom reader for the web-watch channel; each new entry becomes an item (content hash keeps re-polls idempotent). */
export async function pollRss(c: pg.PoolClient, familyId: string, channel: any, fetchImpl: typeof fetch = fetch) {
  const url = channel.config?.url; if (!url) return { fetched: 0, ingested: 0 };
  let xml = ""; try { const r = await fetchImpl(url, { signal: AbortSignal.timeout(15000) }); if (!r.ok) return { fetched: 0, ingested: 0, error: `HTTP ${r.status}` }; xml = await r.text(); } catch (e: any) { return { fetched: 0, ingested: 0, error: String(e.message ?? e).slice(0, 120) }; }
  const strip = (s: string) => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ").trim();
  const entries = xml.match(/<(?:item|entry)\b[\s\S]*?<\/(?:item|entry)>/gi) ?? []; let ingested = 0;
  for (const e of entries.slice(0, 50)) {
    const title = strip(e.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? ""); const body = strip(e.match(/<(?:description|summary|content)[^>]*>([\s\S]*?)<\/(?:description|summary|content)>/i)?.[1] ?? ""); const date = e.match(/<(?:pubDate|published|updated)>([\s\S]*?)<\/(?:pubDate|published|updated)>/i)?.[1];
    if (!title && !body) continue;
    const r = await ingestItem(c, familyId, { channel_id: channel.id, title, sender: "rss", body_text: `${title}\n${body}`, received_at: date && !Number.isNaN(Date.parse(date)) ? new Date(date).toISOString() : null }).catch(() => null);
    if (r && !r.duplicate) ingested++;
  }
  await c.query("update research_channels set config = config || jsonb_build_object('last_polled_at', now()::text) where id=$1", [channel.id]);
  return { fetched: entries.length, ingested };
}
const FIELD_KEY = () => process.env.FIELD_ENCRYPTION_KEY ?? "dev-only-field-key";
/** Deterministic in-process inbox for local/demo testing (channel.config.mock = true): no real mailbox needed,
 *  mirrors the sandbox pattern already used for the Account Aggregator (lib/aa.ts's mockProvider). Returns a
 *  small set of realistic research e-mails, including one with a scanned-looking attachment to exercise OCR. */
function mockMailbox(channel: any) {
  const day = today();
  return [
    { subject: "Weekly strategy note — IT services overweight", from: "research@capitalmind.in", date: day, text: "We remain overweight IT services into Q3 earnings. TCS and Infosys both look attractively valued after the recent pullback; initiate/add with a 12-month view.", attachment: null as null | { name: string; mime: string; text: string } },
    { subject: "Fwd: hot tip from the WhatsApp group", from: "a.friend@example.com", date: day, text: "bro XYZ Small Cap Infra is going to double, my cousin works there, buy now before it runs", attachment: null },
    { subject: "Q2 portfolio letter — scanned signature page attached", from: "updates@marcellus.in", date: day, text: "Please find attached our signed Q2 letter to investors.", attachment: { name: "signature-page.png", mime: "image/png", text: "Marcellus Investment Managers — Consistent Compounders PMS — Q2 FY27 Letter — Authorised Signatory" } },
  ].filter((m) => !channel.config?.last_polled_subjects?.includes(m.subject));
}
/** IMAP poll for an 'email' channel (FO-150 roadmap gap): fetches unseen messages, runs any image/PDF
 *  attachment through the same OCR path as Documents (lib/documents.ts's ocrText — no separate OCR wiring),
 *  appends the extracted text to the body, and ingests each message once (content-hash de-duplication in
 *  ingestItem already makes a re-poll of the same message a no-op). Real messages are marked \Seen after
 *  ingesting; the mock path (channel.config.mock) needs no server and marks itself idempotent via config. */
export async function pollImap(c: pg.PoolClient, familyId: string, channel: any) {
  if (channel.config?.mock) {
    const msgs = mockMailbox(channel); let ingested = 0;
    for (const m of msgs) { const text = m.attachment ? `${m.text}\n\n[attachment ${m.attachment.name}, OCR]: ${m.attachment.text}` : m.text; const r = await ingestItem(c, familyId, { channel_id: channel.id, title: m.subject, sender: m.from, body_text: text, received_at: new Date(m.date).toISOString() }).catch(() => null); if (r && !r.duplicate) ingested++; }
    const seen = [...new Set([...(channel.config?.last_polled_subjects ?? []), ...msgs.map((m) => m.subject)])];
    await c.query("update research_channels set config = config || jsonb_build_object('last_polled_at', now()::text, 'last_polled_subjects', $2::jsonb) where id=$1", [channel.id, JSON.stringify(seen)]);
    return { fetched: msgs.length, ingested };
  }
  const cfg = channel.config ?? {}; if (!cfg.host || !cfg.user || !cfg.password_enc) return { fetched: 0, ingested: 0, error: "not configured — host, user and password are required (or set config.mock=true to demo without a mailbox)" };
  const { ImapFlow } = await import("imapflow"); const { simpleParser } = await import("mailparser");
  const client = new ImapFlow({ host: cfg.host, port: cfg.port ?? 993, secure: cfg.secure ?? true, auth: { user: cfg.user, pass: decryptSecret(cfg.password_enc, FIELD_KEY()) }, logger: false });
  let fetched = 0, ingested = 0;
  try {
    await client.connect(); const lock = await client.getMailboxLock(cfg.mailbox ?? "INBOX");
    try {
      for await (const msg of client.fetch({ seen: false }, { source: true, uid: true })) {
        if (!msg.source) continue;
        fetched++; const parsed = await simpleParser(msg.source);
        let text = (parsed.text ?? parsed.html ?? "").toString();
        for (const att of parsed.attachments ?? []) { if (!needsOcr(null, att.contentType)) continue; const o = ocrText(att.content, att.filename ?? "attachment"); if (o.text) text += `\n\n[attachment ${att.filename ?? "image"}, OCR]: ${o.text}`; }
        const r = await ingestItem(c, familyId, { channel_id: channel.id, title: parsed.subject ?? undefined, sender: parsed.from?.text, body_text: text || "(no readable text)", received_at: parsed.date?.toISOString() ?? null }).catch(() => null);
        if (r && !r.duplicate) ingested++;
        await client.messageFlagsAdd(msg.uid, ["\\Seen"], { uid: true }).catch(() => null);
      }
    } finally { lock.release(); }
    await client.logout();
  } catch (e: any) { try { await client.logout(); } catch { /* already closed */ } return { fetched, ingested, error: String(e.message ?? e).slice(0, 160) }; }
  await c.query("update research_channels set config = config || jsonb_build_object('last_polled_at', now()::text) where id=$1", [channel.id]);
  return { fetched, ingested };
}
export async function pollChannels(c: pg.PoolClient, familyId: string, fetchImpl: typeof fetch = fetch) {
  let fetched = 0, ingested = 0;
  for (const ch of (await c.query("select * from research_channels where family_id=$1 and kind='rss' and active", [familyId])).rows) { const r = await pollRss(c, familyId, ch, fetchImpl); fetched += r.fetched; ingested += r.ingested; }
  for (const ch of (await c.query("select * from research_channels where family_id=$1 and kind='email' and active", [familyId])).rows) { const r = await pollImap(c, familyId, ch); fetched += r.fetched; ingested += r.ingested; }
  return { rows: ingested, note: `${fetched} entries seen, ${ingested} new` };
}

// ---------- clustering & consensus (FO-152) ----------
const instrumentKey = (r: any) => r.instrument_id ?? `text:${norm(r.instrument_text)}`;
export async function clusterAll(c: pg.PoolClient, familyId: string, asOf = today()) {
  const st = await settingsFor(c, familyId); const window = Number(st.cluster_window_days);
  const recs = (await c.query("select r.*, s.trust_score, s.name source_name, s.kind source_kind from research_recommendations r left join research_sources s on s.id=r.source_id where r.family_id=$1 and r.status in ('extracted','clustered','assessed','proposal_drafted','superseded') and r.published_on >= $2::date - 120 order by r.published_on, r.created_at", [familyId, asOf])).rows;   // older calls are history for the track record, not live consensus
  // supersession: a later call from the same source on the same instrument in the other direction retires the earlier one
  const bySrcInst = new Map<string, any[]>(); for (const r of recs) { const k = `${r.source_id}|${instrumentKey(r)}`; bySrcInst.set(k, [...(bySrcInst.get(k) ?? []), r]); }
  let superseded = 0;
  for (const list of bySrcInst.values()) for (let i = 0; i < list.length; i++) { const later = list.slice(i + 1).find((x) => directionOf(x.action) !== "neutral" && directionOf(x.action) !== directionOf(list[i].action)); if (later && list[i].status !== "superseded") { await c.query("update research_recommendations set status='superseded' where id=$1", [list[i].id]); list[i].status = "superseded"; superseded++; } }
  const active = recs.filter((r) => r.status !== "superseded" && directionOf(r.action) !== "neutral");
  const groups = new Map<string, any[]>(); for (const r of active) { const k = `${instrumentKey(r)}|${directionOf(r.action)}`; groups.set(k, [...(groups.get(k) ?? []), r]); }
  let created = 0, updated = 0; const touched = new Set<string>();
  for (const [k, list] of groups) {
    // rolling window: a call more than `window` days after the previous one starts a new cluster
    const runs: any[][] = []; for (const r of list) { const cur = runs[runs.length - 1]; if (cur && (Date.parse(iso(r.published_on)!) - Date.parse(iso(cur[cur.length - 1].published_on)!)) / 86400000 <= window) cur.push(r); else runs.push([r]); }
    for (const run of runs) {
      const first = iso(run[0].published_on)!, last = iso(run[run.length - 1].published_on)!; const direction = k.split("|").pop()!;
      const instrumentId = run[0].instrument_id ?? null; const text = run.find((r) => r.instrument_text)?.instrument_text ?? "?";
      const sources = [...new Map(run.map((r) => [r.source_id ?? r.id, r])).values()];
      const wsum = sources.reduce((s, r) => s + Number(r.trust_score ?? 50), 0); const wconv = wsum ? r2(sources.reduce((s, r) => s + Number(r.trust_score ?? 50) * (CONV[r.conviction] ?? 60), 0) / wsum) : null;
      const others = recs.filter((r) => r.status !== "superseded" && instrumentKey(r) === instrumentKey(run[0]) && !run.includes(r) && Math.abs(Date.parse(iso(r.published_on)!) - Date.parse(last)) / 86400000 <= window);
      const otherSrc = [...new Map(others.map((r) => [r.source_id ?? r.id, r])).values()]; const total = sources.length + otherSrc.filter((o) => !sources.some((s) => s.source_id === o.source_id)).length;
      const consensus = `${sources.length} of ${total} source${total === 1 ? "" : "s"} ${direction} (${sources.map((s) => s.source_name ?? "unattributed").join(", ")})${otherSrc.length ? "; " + otherSrc.map((o) => `${o.source_name ?? "unattributed"} ${o.action}`).join(", ") : ""}`;
      const existing = (await c.query("select id, status from recommendation_clusters where family_id=$1 and direction=$2 and coalesce(instrument_id::text, 'text:' || lower(instrument_text))=$3 and last_seen >= $4::date - $5::int order by last_seen desc limit 1", [familyId, direction, instrumentId ?? `text:${text.toLowerCase()}`, first, window])).rows[0] ?? (await c.query("select id, status from recommendation_clusters where id = any($1::uuid[]) limit 1", [run.map((r) => r.cluster_id).filter(Boolean)])).rows[0];
      let clusterId: string;
      if (existing) { clusterId = existing.id; await c.query("update recommendation_clusters set first_seen=least(first_seen,$2::date), last_seen=greatest(last_seen,$3::date), source_count=$4, weighted_conviction=$5, consensus=$6, instrument_text=$7, instrument_id=coalesce(instrument_id,$8), status=case when status in ('dismissed','assessed','proposal_drafted') then status else 'clustered' end where id=$1", [clusterId, first, last, sources.length, wconv, consensus, text, instrumentId]); updated++; }
      else { clusterId = (await c.query("insert into recommendation_clusters (family_id, instrument_id, instrument_text, direction, first_seen, last_seen, source_count, weighted_conviction, consensus) values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id", [familyId, instrumentId, text, direction, first, last, sources.length, wconv, consensus])).rows[0].id; created++; }
      touched.add(clusterId);
      await c.query("update research_recommendations set cluster_id=$2, status=case when status='extracted' then 'clustered'::rec_status else status end where id = any($1::uuid[])", [run.map((r) => r.id), clusterId]);
      // a source that flipped invalidates the last assessment: back to clustered so the hourly job re-assesses
      if (existing && existing.status === "assessed" && superseded) await c.query("update recommendation_clusters set status='clustered' where id=$1", [clusterId]);
    }
  }
  await c.query("update recommendation_clusters set status='superseded' where family_id=$1 and status <> 'superseded' and not exists (select 1 from research_recommendations r where r.cluster_id=recommendation_clusters.id and r.status <> 'superseded')", [familyId]);
  return { rows: created + updated, note: `${created} new cluster${created === 1 ? "" : "s"}, ${updated} updated, ${superseded} superseded`, created, updated, superseded };
}

// ---------- policy-fit assessment & sizing (FO-153) ----------
interface Check { clause: string; status: "pass" | "warning" | "fail" | "n/a"; detail: string }
const clusterRecs = async (c: pg.PoolClient, clusterId: string) => (await c.query("select r.*, s.name source_name, s.kind source_kind, s.trust_score, s.conflict_of_interest, i.title item_title, i.body_text from research_recommendations r left join research_sources s on s.id=r.source_id join research_items i on i.id=r.item_id where r.cluster_id=$1 and r.status <> 'superseded' order by r.published_on", [clusterId])).rows;
async function defaultEntity(c: pg.PoolClient, instrumentId: string | null, direction: string) {
  if (direction === "bearish" && instrumentId) { const h = (await c.query("select entity_id from holdings where instrument_id=$1 and quantity > 0 order by quantity desc limit 1", [instrumentId])).rows[0]; if (h) return h.entity_id as string; }
  return (await c.query("select e.id from entities e left join bank_accounts b on b.entity_id=e.id and b.deleted_at is null and b.type <> 'card' where e.deleted_at is null group by e.id order by coalesce(sum(b.balance),0) desc, e.created_at limit 1")).rows[0]?.id as string;
}
export async function assessCluster(c: pg.PoolClient, familyId: string, clusterId: string, opts: { entityId?: string | null; goalId?: string | null; userId?: string | null } = {}) {
  const cl = (await c.query("select * from recommendation_clusters where id=$1 and family_id=$2", [clusterId, familyId])).rows[0]; if (!cl) throw new ResearchError(404, "Cluster not found");
  const recs = await clusterRecs(c, clusterId); const direction: "buy" | "sell" = cl.direction === "bearish" ? "sell" : "buy";
  const entityId = opts.entityId ?? await defaultEntity(c, cl.instrument_id, cl.direction); const goalId = opts.goalId ?? null;
  const policy = await governingPolicy(c, entityId, goalId); if (!policy) throw new ResearchError(422, "No active investment policy governs this entity — activate one before assessing");
  const { clauses: eff } = await effectiveFor(c, policy); const snap = await snapshotFor(c, familyId, policy, eff);
  const inst = cl.instrument_id ? (await c.query("select i.*, a.issuer, a.sector, a.market_cap_band, a.credit_rating, a.manager, a.liquidity_class from instruments i left join lateral (select * from instrument_attributes x where x.instrument_id=i.id order by as_of desc limit 1) a on true where i.id=$1", [cl.instrument_id])).rows[0] : null;
  const checks: Check[] = []; const text = recs.map((r) => `${r.thesis ?? ""} ${r.body_text ?? ""}`).join(" ");
  const total = snap.total; const perm = eff.permitted ?? {}; const cons = eff.constraints ?? {};
  const cls = inst ? allocClassOf(inst.asset_class, inst.type) : null; const ty = inst?.type ?? null;
  const band = cls ? (eff.allocations ?? []).find((a) => a.lens === "asset_class" && a.key === cls) : null;
  const held = inst ? (snap.positions as any[]).filter((p) => p.id === inst.id && (!entityId || p.entityId === entityId)) : []; const heldValue = held.reduce((s, p) => s + p.value, 0);
  const heldAny = inst ? snap.positions.filter((p) => p.id === inst.id) : [];
  const issuerName = inst?.issuer ?? inst?.name ?? null; const issuerHeld = issuerName ? snap.positions.filter((p) => (p.issuer ?? p.name) === issuerName || p.id === inst?.id).reduce((s, p) => s + p.value, 0) : 0;
  const capPct = (code: string, metric: string, fallback: number | null) => { const r = (eff.ips_rules ?? []).find((x) => x.code === code)?.params?.pct; if (r != null) return Number(r); const l = (eff.risk_limits ?? []).find((x) => x.metric === metric); return l ? Number(l.limit_value) : fallback; };
  const singleStockRule = (perm.prohibited ?? []).map((s: string) => s.match(/single_stocks?\s*>\s*(\d+)/i)?.[1]).find(Boolean);
  const issuerCap = capPct("max_single_issuer", "issuer_max", singleStockRule ? Number(singleStockRule) : null), sectorCap = capPct("max_single_sector", "sector_max", null), managerCap = capPct("max_single_manager", "manager_max", null);
  // headroom under a cap: (held + x) / (total + x) ≤ cap  ⇒  x ≤ (cap·total − held) / (1 − cap)
  const headroom = (cap: number | null, heldNow: number) => (cap == null ? null : Math.max(0, r2((cap / 100 * total - heldNow) / (1 - cap / 100))));
  const smallCap = inst ? inst.market_cap_band === "small" : /small[\s-]?cap/i.test(cl.instrument_text + " " + text);
  if (!inst) checks.push({ clause: "instrument", status: "fail", detail: `"${cl.instrument_text}" is not in the instruments master — resolve it (or add the instrument) before assessing` });
  else {
    if (Array.isArray(perm.instrument_types) && perm.instrument_types.length) checks.push(perm.instrument_types.includes(ty) ? { clause: "permitted.instrument_types", status: "pass", detail: `${ty} is a permitted instrument type` } : { clause: "permitted.instrument_types", status: "fail", detail: `${ty} is not a permitted instrument type` });
    for (const rule of (perm.prohibited ?? []) as string[]) {
      const r = rule.toLowerCase();
      if (r === "small_cap_stocks" && ty === "stock" && smallCap) checks.push({ clause: "permitted.prohibited", status: "fail", detail: `small-cap single stocks are prohibited (${rule})` });
      if (r === "unrated_debt" && ty === "bond" && ratingRank(inst.credit_rating) < 0) checks.push({ clause: "permitted.prohibited", status: "fail", detail: "unrated debt is prohibited" });
      if (ty && ty === r) checks.push({ clause: "permitted.prohibited", status: "fail", detail: `${rule} is prohibited` });
    }
    if (perm.min_rating && ty === "bond" && direction === "buy" && ratingRank(inst.credit_rating) >= 0 && ratingRank(inst.credit_rating) < ratingRank(perm.min_rating)) checks.push({ clause: "permitted.min_rating", status: "fail", detail: `${inst.credit_rating} is below the minimum rating ${perm.min_rating}` });
    if (["mf", "pms", "aif"].includes(ty) && Array.isArray(perm.managers) && perm.managers.length && inst.manager) checks.push(perm.managers.some((m: string) => m.toLowerCase() === String(inst.manager).toLowerCase()) ? { clause: "permitted.managers", status: "pass", detail: `${inst.manager} is on the permitted manager list` } : { clause: "permitted.managers", status: "fail", detail: `${inst.manager} is not a permitted manager` });
  }
  if (!inst && smallCap && ((perm.prohibited ?? []) as string[]).some((r) => r.toLowerCase() === "small_cap_stocks")) checks.push({ clause: "permitted.prohibited", status: "fail", detail: "small-cap single stocks are prohibited (small_cap_stocks) — the tip names a small cap" });
  if (/insider|on the board|inside information|not (?:yet )?public/i.test(text)) checks.push({ clause: "conduct", status: "fail", detail: "the tip cites non-public information (board / insider) — do not act" });
  // sizing candidates (buys)
  const cash = Number((await c.query("select coalesce(sum(balance),0) v from bank_accounts where entity_id=$1 and deleted_at is null and type <> 'card'", [entityId])).rows[0].v);
  const fl = await floatFor(c, familyId).catch(() => null as any); const floor = fl && Number(fl.cash) > 0 ? r2(Number(fl.floatRequired ?? 0) * cash / Number(fl.cash)) : 0;   // family float apportioned by the entity's share of cash
  const cashAvail = Math.max(0, r2(cash - floor));
  const sizing: Record<string, any> = { cash_available: cashAvail, cash_floor: floor };
  if (direction === "buy" && inst) {
    const now = cls ? (snap.allocation.asset_class?.[cls] ?? 0) : 0;
    if (band?.max_pct != null && cls) { const bandRoom = headroom(Number(band.max_pct), now / 100 * total); sizing.band_headroom = bandRoom; sizing.band = { key: cls, now_pct: r2(now), max_pct: Number(band.max_pct) }; checks.push(now > Number(band.max_pct) ? { clause: `allocation.asset_class:${cls}`, status: "warning", detail: `${cls} band already breached (${r2(now)}% vs max ${band.max_pct}%) — fund the position from a sale within the class, not from cash` } : { clause: `allocation.asset_class:${cls}`, status: "pass", detail: `${cls} ${r2(now)}% now; headroom to the ${band.max_pct}% band ≈ ₹${bandRoom?.toLocaleString("en-IN")}` }); }
    if (issuerCap != null && ty === "stock") { const room = headroom(issuerCap, issuerHeld); sizing.issuer_headroom = room; sizing.issuer = { name: issuerName, held_pct: total ? r2(issuerHeld / total * 100) : 0, cap_pct: issuerCap }; checks.push({ clause: "ips_rule.max_single_issuer", status: room! > 0 ? "pass" : "fail", detail: `${issuerName} ${total ? r2(issuerHeld / total * 100) : 0}% held; cap ${issuerCap}% leaves ₹${room?.toLocaleString("en-IN")}` }); }
    if (managerCap != null && ["mf", "pms", "aif"].includes(ty ?? "") && inst.manager) { const mHeld = snap.positions.filter((p) => p.manager === inst.manager).reduce((s, p) => s + p.value, 0); const room = headroom(managerCap, mHeld); sizing.manager_headroom = room; checks.push({ clause: "ips_rule.max_single_manager", status: room! > 0 ? "pass" : "fail", detail: `${inst.manager} ${total ? r2(mHeld / total * 100) : 0}% held; cap ${managerCap}% leaves ₹${room?.toLocaleString("en-IN")}` }); }
    if (inst.sector) { const sHeld = snap.positions.filter((p) => p.sector === inst.sector).reduce((s, p) => s + p.value, 0); if (sectorCap != null) { const room = headroom(sectorCap, sHeld); sizing.sector_headroom = room; checks.push({ clause: "ips_rule.max_single_sector", status: room! > 0 ? "pass" : "warning", detail: `${inst.sector} ${total ? r2(sHeld / total * 100) : 0}% held; cap ${sectorCap}%` }); } else checks.push({ clause: "sector", status: "n/a", detail: `${inst.sector} ${total ? r2(sHeld / total * 100) : 0}% of the portfolio; the policy sets no sector cap` }); }
    const liqMonths = Number(cons.liquidity_months ?? 0); const liqRoom = liqMonths && snap.monthlySpend && ["stock", "etf", "pms", "aif", "bond"].includes(ty ?? "") ? Math.max(0, r2(snap.liquid - liqMonths * snap.monthlySpend)) : null; if (liqRoom != null) sizing.liquidity_headroom = liqRoom;
    const cands = [sizing.issuer_headroom, sizing.manager_headroom, sizing.sector_headroom, liqRoom, cashAvail].filter((v) => v != null) as number[]; const bandRoom = sizing.band_headroom as number | undefined;
    let suggested = Math.min(...cands); let basis = suggested === sizing.issuer_headroom ? "issuer cap" : suggested === sizing.manager_headroom ? "manager cap" : suggested === sizing.sector_headroom ? "sector cap" : suggested === liqRoom ? `liquidity floor (${liqMonths} months of spending stay liquid)` : "cash above the working-capital float";
    if (liqMonths && snap.monthlySpend) { const afterMonths = r2((snap.liquid - (liqRoom == null ? 0 : Math.min(suggested, cashAvail))) / snap.monthlySpend); checks.push(afterMonths < liqMonths ? { clause: "constraints.liquidity_months", status: "warning", detail: `liquidity would fall to ${afterMonths} months vs ${liqMonths} required` } : { clause: "constraints.liquidity_months", status: "pass", detail: `${afterMonths} months of spending stay liquid (≥ ${liqMonths})${liqRoom != null && suggested === liqRoom ? " — the liquidity floor sets the size" : ""}` }); }
    if (bandRoom != null && bandRoom > 0 && bandRoom < suggested) { suggested = bandRoom; basis = `${cls} band headroom`; }
    if (bandRoom != null && bandRoom <= 0) basis += "; band already at its maximum — fund from a sale within the class";
    suggested = Math.max(0, Math.floor(suggested / 100) * 100); sizing.max_by_policy = Math.floor(Math.min(...[sizing.issuer_headroom, sizing.manager_headroom, sizing.sector_headroom].filter((v) => v != null) as number[], Infinity) / 100) * 100; if (!Number.isFinite(sizing.max_by_policy)) sizing.max_by_policy = null;
    sizing.suggested = suggested; sizing.basis = basis;
  }
  // sells and avoids on held positions: tax preference and the exemption headroom decide whether the call conflicts
  let taxNote: any = null;
  if (direction === "sell" && inst) {
    if (!heldAny.length) checks.push({ clause: "portfolio", status: "n/a", detail: "not held — nothing to sell; recorded for the track record" });
    else {
      const lots = (await c.query("select l.buy_date, l.remaining_qty, l.unit_cost from lots l join holdings h on h.id=l.holding_id where h.instrument_id=$1 and h.entity_id=$2 and l.remaining_qty > 0 order by l.buy_date", [inst.id, entityId])).rows;
      const px = await priceAt(c, inst.id, today()) ?? 0; const cut = addMonths(today(), -12);
      const ltcg = r2(lots.filter((l) => iso(l.buy_date)! <= cut).reduce((s, l) => s + Number(l.remaining_qty) * (px - Number(l.unit_cost)), 0)), stcg = r2(lots.filter((l) => iso(l.buy_date)! > cut).reduce((s, l) => s + Number(l.remaining_qty) * (px - Number(l.unit_cost)), 0));
      const rule = (await c.query("select exemption_amount from tax_rules where asset_class=$1 and term='long' and fy <= $2 order by fy desc limit 1", [cls === "equity" ? "equity" : "debt", `${new Date().getUTCMonth() >= 3 ? new Date().getUTCFullYear() : new Date().getUTCFullYear() - 1}-${String((new Date().getUTCMonth() >= 3 ? new Date().getUTCFullYear() : new Date().getUTCFullYear() - 1) + 1).slice(-2)}`])).rows[0];
      const used = Number((await c.query("select coalesce(sum(gain),0) v from realized_gains where entity_id=$1 and term='long' and sell_date >= date_trunc('year', current_date - interval '3 months') + interval '3 months'", [entityId])).rows[0].v);
      const exemptionRoom = Math.max(0, Number(rule?.exemption_amount ?? 0) - used); taxNote = { ltcg, stcg, exemption_headroom: exemptionRoom, held_value: r2(heldValue) };
      if (cons.tax?.ltcg_first && stcg > 0) checks.push({ clause: "constraints.tax.ltcg_first", status: "fail", detail: `a sale now would realise short-term gains of ₹${stcg.toLocaleString("en-IN")} (lots under 12 months) — the policy prefers long-term-first` });
      if (cons.tax?.use_exemptions && ltcg > exemptionRoom) checks.push({ clause: "constraints.tax.use_exemptions", status: "fail", detail: `long-term gains ₹${ltcg.toLocaleString("en-IN")} exceed the exemption headroom ₹${exemptionRoom.toLocaleString("en-IN")}` });
      if (!checks.some((k) => k.clause.startsWith("constraints.tax") && k.status === "fail")) checks.push({ clause: "constraints.tax", status: "pass", detail: `realises LTCG ₹${ltcg.toLocaleString("en-IN")} inside the exemption headroom` });
      sizing.suggested = r2(heldValue); sizing.basis = "full position held by the entity"; sizing.within_exemption = ltcg > 0 && px ? Math.floor(Math.min(heldValue, exemptionRoom / Math.max(ltcg, 1) * heldValue) / 100) * 100 : null;
    }
  }
  // sources: a friend alone is never enough; all-conflicted sources are a condition
  const srcs = [...new Map(recs.map((r) => [r.source_id ?? r.id, r])).values()];
  if (srcs.length && srcs.every((s) => s.source_kind === "friend")) checks.push({ clause: "sources.independent_thesis", status: "fail", detail: "only a friend (low-trust) source and no independent thesis" });
  else if (srcs.length && srcs.every((s) => !NO_CONFLICT(s.conflict_of_interest))) checks.push({ clause: "sources.conflicts", status: "warning", detail: `every source has a conflict of interest (${srcs.map((s) => `${s.source_name}: ${s.conflict_of_interest}`).join("; ")})` });
  else checks.push({ clause: "sources", status: "pass", detail: `${srcs.length} source${srcs.length === 1 ? "" : "s"}; ${srcs.filter((s) => NO_CONFLICT(s.conflict_of_interest)).length} without conflicts` });
  const bearishOthers = inst ? (await c.query("select count(*) n from research_recommendations r join recommendation_clusters k on k.id=r.cluster_id where r.family_id=$1 and r.instrument_id=$2 and k.direction <> $3 and r.status <> 'superseded' and r.published_on >= current_date - 180", [familyId, inst.id, cl.direction])).rows[0].n : 0;
  if (direction === "buy") checks.push(Number(bearishOthers) === 0 ? { clause: "counter_view", status: "pass", detail: "no bearish view on file — the proposal carries a counter-view constructed from the data" } : { clause: "counter_view", status: "pass", detail: `${bearishOthers} bearish view${Number(bearishOthers) === 1 ? "" : "s"} on file — cited as the counter-view` });
  // verdict
  const prohibited = checks.some((k) => k.status === "fail" && ["permitted.instrument_types", "permitted.prohibited", "permitted.min_rating", "permitted.managers", "conduct"].includes(k.clause));   // same list as PROHIBIT below
  const conflicts = checks.some((k) => k.status === "fail" && (k.clause.startsWith("constraints.tax") || k.clause.startsWith("ips_rule")));
  const insufficient = checks.some((k) => k.status === "fail" && ["instrument", "sources.independent_thesis"].includes(k.clause)) || (direction === "sell" && inst && !heldAny.length);
  const verdict = prohibited ? "prohibited" : conflicts ? "conflicts" : insufficient ? "insufficient_info" : checks.some((k) => k.status === "warning") ? "fits_with_conditions" : "fits";
  const wconv = Number(cl.weighted_conviction ?? 50);
  let score = verdict === "prohibited" ? 0 : 100 - 40 * checks.filter((k) => k.status === "fail").length - 12 * checks.filter((k) => k.status === "warning").length - (wconv < 50 ? (50 - wconv) / 2 : 0) - (srcs.some((s) => s.source_kind === "friend") ? 15 : 0);
  score = Math.max(0, Math.min(100, r2(score)));
  const alreadyHeld = heldAny.length ? { holding_id: (heldAny[0] as any).holdingId ?? null, entity_id: (heldAny[0] as any).entityId, value: r2(heldAny.reduce((s, p) => s + p.value, 0)), weight_pct: total ? r2(heldAny.reduce((s, p) => s + p.value, 0) / total * 100) : 0, surface: direction === "sell" } : null;
  const PROHIBIT = ["permitted.instrument_types", "permitted.prohibited", "permitted.min_rating", "permitted.managers", "conduct"];
  const reason = (verdict === "prohibited" ? checks.find((k) => k.status === "fail" && PROHIBIT.includes(k.clause)) : checks.find((k) => k.status === "fail"))?.detail ?? null;
  const a = (await c.query("insert into recommendation_assessments (family_id, cluster_id, policy_version_id, entity_id, goal_id, verdict, fit_score, checks, already_held, sizing) values ($1,$2,$3,$4,$5,$6::fit_verdict,$7,$8,$9,$10) returning *", [familyId, clusterId, policy.current_version_id, entityId, goalId, verdict, score, JSON.stringify(checks), alreadyHeld ? JSON.stringify(alreadyHeld) : null, JSON.stringify({ ...sizing, tax: taxNote, entity_id: entityId, direction })])).rows[0];
  // prohibited, conflicting and unresolved clusters are declined automatically with the clause; a sell on a held position always surfaces
  const surface = direction === "sell" && !!alreadyHeld;
  if (["prohibited", "conflicts", "insufficient_info"].includes(verdict) && !surface) { await c.query("update recommendation_clusters set status='dismissed', dismissed_reason=$2, dismissed_auto=true, dismissed_at=now() where id=$1", [clusterId, `${verdict}: ${reason ?? checks.find((k) => k.status !== "pass")?.detail ?? "declined"}`]); await c.query("update research_recommendations set status='dismissed' where cluster_id=$1 and status <> 'superseded'", [clusterId]); }
  else { await c.query("update recommendation_clusters set status=case when status='proposal_drafted' then status else 'assessed' end, dismissed_reason=null, dismissed_auto=false, dismissed_at=null where id=$1", [clusterId]); await c.query("update research_recommendations set status='assessed' where cluster_id=$1 and status in ('clustered','extracted','dismissed')", [clusterId]); }
  return assessmentView(a, { policy_name: policy.name, entity_id: entityId, verdict, surface });
}
const assessmentView = (a: any, extra: Record<string, any> = {}) => ({ ...a, fit_score: a.fit_score == null ? null : Number(a.fit_score), assessed_at: a.assessed_at, ...extra });
export async function assessAll(c: pg.PoolClient, familyId: string) {
  let n = 0; const verdicts: Record<string, number> = {};
  for (const cl of (await c.query("select id from recommendation_clusters where family_id=$1 and status='clustered' order by last_seen", [familyId])).rows) { const a = await assessCluster(c, familyId, cl.id).catch((e) => ({ verdict: `error: ${e.message}` })); n++; verdicts[a.verdict] = (verdicts[a.verdict] ?? 0) + 1; }
  return { rows: n, note: Object.entries(verdicts).map(([k, v]) => `${v} ${k}`).join(" · ") || "nothing to assess", verdicts };
}
export async function clusterView(c: pg.PoolClient, id: string) {
  const cl = (await c.query("select k.*, i.name instrument_name, i.symbol, i.type instrument_type from recommendation_clusters k left join instruments i on i.id=k.instrument_id where k.id=$1", [id])).rows[0]; if (!cl) throw new ResearchError(404, "Cluster not found");
  const recs = (await c.query("select r.*, s.name source_name, s.kind source_kind, s.trust_score, s.conflict_of_interest, i.title item_title from research_recommendations r left join research_sources s on s.id=r.source_id join research_items i on i.id=r.item_id where r.cluster_id=$1 order by r.published_on desc", [id])).rows.map(recView);
  const a = (await c.query("select a.*, e.name entity_name from recommendation_assessments a left join entities e on e.id=a.entity_id where a.cluster_id=$1 order by a.assessed_at desc limit 1", [id])).rows[0];
  const proposal = (await c.query("select id, status, title, amount, version from investment_proposals where cluster_id=$1 order by created_at desc limit 1", [id])).rows[0] ?? null;
  return { ...cl, first_seen: iso(cl.first_seen), last_seen: iso(cl.last_seen), weighted_conviction: cl.weighted_conviction == null ? null : Number(cl.weighted_conviction), recommendations: recs, assessment: a ? assessmentView(a) : null, proposal };
}

// ---------- proposals (FO-154, FO-155) ----------
const REQUIRED_SECTIONS = ["summary", "thesis", "sources", "counter_view", "policy_fit", "portfolio_impact", "tax_impact", "risks", "sizing", "execution_plan", "exit_plan", "monitoring"];
export function validateProposal(sections: Record<string, any>) {
  const errors: string[] = [];
  for (const k of REQUIRED_SECTIONS) { const v = sections?.[k]; if (v == null || v === "" || (Array.isArray(v) && !v.length) || (typeof v === "object" && !Array.isArray(v) && !Object.keys(v).length)) errors.push(`${k} is required`); }
  if (typeof sections?.counter_view === "string" && sections.counter_view.trim().length < 40) errors.push("counter_view must argue the bear case (≥ 40 characters)");
  if (!Array.isArray(sections?.citations) || !sections.citations.length) errors.push("every number must cite a tool result (citations)");
  return errors;
}
export async function draftProposal(c: pg.PoolClient, familyId: string, userId: string, input: { cluster_id?: string | null; instrument_id?: string | null; action?: Action | null; entity_id?: string | null; goal_id?: string | null; amount?: number | null; notes?: string | null }) {
  let cl: any = null, assessment: any = null;
  if (input.cluster_id) {
    cl = (await c.query("select * from recommendation_clusters where id=$1 and family_id=$2", [input.cluster_id, familyId])).rows[0]; if (!cl) throw new ResearchError(404, "Cluster not found");
    assessment = (await c.query("select * from recommendation_assessments where cluster_id=$1 and ($2::uuid is null or entity_id=$2) order by assessed_at desc limit 1", [cl.id, input.entity_id ?? null])).rows[0] ?? await assessCluster(c, familyId, cl.id, { entityId: input.entity_id, goalId: input.goal_id, userId });
  } else {
    if (!input.instrument_id || !input.action) throw new ResearchError(422, "cluster_id, or instrument_id + action, is required");
    // a manual idea gets its own single-source cluster (source: internal) so the same assessment path applies
    const src = (await c.query("select id from research_sources where family_id=$1 and kind='internal' limit 1", [familyId])).rows[0] ?? (await c.query("insert into research_sources (family_id, kind, name, conflict_of_interest, trust_score) values ($1,'internal','Family (own idea)','none',60) returning id", [familyId])).rows[0];
    const inst = (await c.query("select id, name from instruments where id=$1", [input.instrument_id])).rows[0]; if (!inst) throw new ResearchError(404, "Instrument not found");
    const item = (await c.query("insert into research_items (family_id, channel_kind, source_id, title, sender, body_text, sha256, status) values ($1,'paste',$2,$3,'internal',$4,$5,'extracted') returning id", [familyId, src.id, `Own idea: ${input.action} ${inst.name}`, input.notes ?? `${input.action} ${inst.name}`, sha256(`${userId}|${inst.id}|${input.action}|${Date.now()}`)])).rows[0];
    cl = (await c.query("insert into recommendation_clusters (family_id, instrument_id, instrument_text, direction, first_seen, last_seen, source_count, weighted_conviction, consensus) values ($1,$2,$3,$4,current_date,current_date,1,60,'own idea') returning *", [familyId, inst.id, inst.name, directionOf(input.action)])).rows[0];
    await c.query("insert into research_recommendations (family_id, item_id, source_id, instrument_id, instrument_text, action, thesis, conviction, published_on, price_at_publish, cluster_id, status, confidence) values ($1,$2,$3,$4,$5,$6::rec_action,$7,'medium',current_date,$8,$9,'clustered',1)", [familyId, item.id, src.id, inst.id, inst.name, input.action, input.notes ?? null, await priceAt(c, inst.id, today()), cl.id]);
    assessment = await assessCluster(c, familyId, cl.id, { entityId: input.entity_id, goalId: input.goal_id, userId });
  }
  if (assessment.verdict === "prohibited") throw new ResearchError(422, `The agent cannot draft a proposal for a prohibited instrument — ${(assessment.checks as Check[]).find((k) => k.status === "fail")?.detail}`, { verdict: "prohibited" });
  if (assessment.verdict === "insufficient_info") throw new ResearchError(422, `Not enough to propose — ${(assessment.checks as Check[]).find((k) => k.status === "fail" || k.status === "n/a")?.detail}`, { verdict: "insufficient_info" });
  const entityId = assessment.entity_id; const sizing = assessment.sizing ?? {}; const direction: "buy" | "sell" = cl.direction === "bearish" ? "sell" : "buy";
  const amount = input.amount != null ? Number(input.amount) : (direction === "sell" ? Number(sizing.within_exemption ?? sizing.suggested ?? 0) : Number(sizing.suggested ?? 0));
  if (!(amount > 0)) throw new ResearchError(422, "No sizing headroom under the policy — nothing to propose", { sizing });
  const inst = (await c.query("select i.*, a.sector, a.issuer, a.manager from instruments i left join lateral (select * from instrument_attributes x where x.instrument_id=i.id order by as_of desc limit 1) a on true where i.id=$1", [cl.instrument_id])).rows[0];
  const ent = (await c.query("select id, name from entities where id=$1", [entityId])).rows[0]; const recs = await clusterRecs(c, cl.id);
  const policy = await governingPolicy(c, entityId, input.goal_id ?? null); const { clauses: eff } = await effectiveFor(c, policy); const snap = await snapshotFor(c, familyId, policy, eff);
  const px = await priceAt(c, inst.id, today()); const cls = allocClassOf(inst.asset_class, inst.type);
  // portfolio after: the position added (or removed) at the proposed amount
  const sign = direction === "buy" ? 1 : -1; const total = snap.total, after = total + sign * amount;
  const pctAfter = (now: number) => r2((now / 100 * total + sign * amount) / after * 100);
  const classNow = snap.allocation.asset_class?.[cls] ?? 0; const sectorNow = inst.sector ? r2(snap.positions.filter((p) => p.sector === inst.sector).reduce((s, p) => s + p.value, 0) / total * 100) : null;
  const positionsAfter = [...snap.positions.map((p) => ({ ...p })), ...(direction === "buy" ? [{ id: inst.id, name: inst.name, value: amount, allocClass: cls, instrumentType: inst.type, issuer: inst.issuer ?? inst.name, manager: inst.manager, sector: inst.sector, liquidityClass: "t1" } as any] : [])];
  if (direction === "sell") for (const p of positionsAfter) if (p.id === inst.id && p.entityId === entityId) p.value = Math.max(0, p.value - amount);
  const concBefore = concentration(snap.positions), concAfter = concentration(positionsAfter);
  const track = (await c.query("select source_id, count(*) n, round(avg(case when hit then 100 else 0 end),1) hit_rate, round(avg(excess_pct),2) excess from source_track_record where family_id=$1 and horizon_months=12 group by source_id", [familyId])).rows;
  const sources = [...new Map(recs.map((r) => [r.source_id ?? r.id, r])).values()].map((r) => { const t = track.find((x) => x.source_id === r.source_id); return { source_id: r.source_id, name: r.source_name ?? "unattributed", kind: r.source_kind, trust_score: Number(r.trust_score ?? 50), conflict_of_interest: r.conflict_of_interest, action: r.action, target_price: r.target_price == null ? null : Number(r.target_price), horizon_months: r.horizon_months, thesis: r.thesis, track_record_12m: t ? { n: Number(t.n), hit_rate_pct: Number(t.hit_rate), avg_excess_pct: Number(t.excess) } : null }; });
  const bear = (await c.query("select r.*, s.name source_name from research_recommendations r left join research_sources s on s.id=r.source_id where r.family_id=$1 and r.instrument_id=$2 and r.published_on >= current_date - 180 and r.action in ('sell','reduce','avoid','redeem') order by r.published_on desc limit 1", [familyId, inst.id])).rows[0];
  const px12 = (await c.query("select max(close) hi, min(close) lo, avg(close) av from prices where instrument_id=$1 and price_date >= current_date - 365", [inst.id])).rows[0];
  const drawdown = px12?.hi && px ? r2((px / Number(px12.hi) - 1) * 100) : null; const vsAvg = px12?.av && px ? r2((px / Number(px12.av) - 1) * 100) : null;
  const counter = direction === "buy" ? (bear ? `${bear.source_name}: ${bear.action} — ${bear.thesis ?? "no thesis recorded"} (source view, ${iso(bear.published_on)}).` : `Bear case (constructed by the agent from the data, not a source view): the price is ${vsAvg != null ? `${vsAvg > 0 ? "+" : ""}${vsAvg}% against its 12-month average` : "without a 12-month history"}${drawdown != null ? ` and ${Math.abs(drawdown)}% off its 12-month high` : ""}; ${inst.sector ? `${inst.sector} would be ${pctAfter(sectorNow ?? 0)}% of the portfolio after; ` : ""}${sources.every((s) => !NO_CONFLICT(s.conflict_of_interest)) ? "every recommending source has a conflict of interest; " : ""}if the thesis stalls a ${Math.max(15, Math.round(Math.abs(drawdown ?? 15) + 5))}% drawdown to the stop is the exposure.`) : `Counter-view to selling (constructed by the agent from the data): ${sources.length} source${sources.length === 1 ? "" : "s"} call${sources.length === 1 ? "s" : ""} for a reduction, but the position ${snap.positions.some((p) => p.id === inst.id) ? `is ${r2(snap.positions.filter((p) => p.id === inst.id).reduce((s, p) => s + p.value, 0) / total * 100)}% of the portfolio` : "is not held"}; selling crystallises tax now for a view with a ${Math.max(...recs.map((r) => Number(r.horizon_months ?? 6)))}-month horizon.`;
  const targets = recs.map((r) => Number(r.target_price)).filter((v) => v > 0).sort((a, b) => a - b), stops = recs.map((r) => Number(r.stop_loss)).filter((v) => v > 0).sort((a, b) => a - b);
  const median = (a: number[]) => (a.length ? a[Math.floor((a.length - 1) / 2)] : null);
  const connectors = (await c.query("select id, label, provider, status from connectors where entity_id=$1 and revoked_at is null order by (status='active') desc", [entityId])).rows; const conn = connectors[0] ?? { label: "Assisted / sandbox", provider: "manual", status: "sandbox" };
  const kind = inst.type === "mf" ? (direction === "buy" ? "mf_purchase" : "mf_redemption") : ["stock", "etf"].includes(inst.type) ? "equity_order" : "assisted";
  const tranches = amount >= 4000 ? [{ n: 1, amount: r2(Math.round(amount / 2 / 100) * 100), when: direction === "buy" ? `limit ≤ ₹${px ? r2(px * 1.01).toLocaleString("en-IN") : "market"} (CMP ${px?.toLocaleString("en-IN") ?? "n/a"})` : "market at open" }, { n: 2, amount: r2(amount - Math.round(amount / 2 / 100) * 100), when: direction === "buy" ? "on a 5% pullback or in 30 days, whichever first" : "after the first tranche settles" }] : [{ n: 1, amount, when: direction === "buy" ? `limit ≤ ₹${px ? r2(px * 1.01).toLocaleString("en-IN") : "market"}` : "market at open" }];
  const horizon = Math.max(...recs.map((r) => Number(r.horizon_months ?? 12)), 6);
  const sections: Record<string, any> = {
    summary: `${sources.length} source${sources.length === 1 ? "" : "s"} ${cl.direction} on ${inst.name} (${cl.consensus}); the ${direction} of ₹${amount.toLocaleString("en-IN")} in ${ent.name} ${assessment.verdict === "fits" ? "fits the policy" : assessment.verdict === "conflicts" ? "conflicts with the tax clause — sized inside the exemption" : "fits with conditions"}: ${(assessment.checks as Check[]).filter((k) => k.status !== "pass").map((k) => k.detail).join("; ") || "no conditions"}.`,
    thesis: recs.filter((r) => r.thesis).map((r) => `${r.source_name ?? "unattributed"}: ${r.thesis}${r.target_price ? ` (target ₹${Number(r.target_price).toLocaleString("en-IN")})` : ""}`).join(" ") || (input.notes ?? "No thesis recorded by the sources."),
    sources, counter_view: counter,
    policy_fit: { verdict: assessment.verdict, fit_score: Number(assessment.fit_score), policy: policy.name, policy_version_id: policy.current_version_id, checks: assessment.checks },
    portfolio_impact: { asset_class: { key: cls, before_pct: r2(classNow), after_pct: pctAfter(classNow) }, sector: inst.sector ? { key: inst.sector, before_pct: sectorNow, after_pct: pctAfter(sectorNow ?? 0) } : null, issuer_after_pct: concAfter.issuer_max, top5_before_pct: concBefore.concentration_top5, top5_after_pct: concAfter.concentration_top5, already_held: assessment.already_held, cash_after: r2(Number(sizing.cash_available ?? 0) - sign * amount), liquidity_months_after: snap.monthlySpend ? r2((snap.liquid - sign * amount) / snap.monthlySpend) : null },
    tax_impact: direction === "buy" ? { est_tax: 0, note: "a purchase realises nothing; holding period starts today" } : { ...(sizing.tax ?? {}), note: "gains by term from the entity's lots at today's price; rates from tax_rules" },
    risks: [...(inst.sector ? [`${inst.sector} exposure rises to ${pctAfter(sectorNow ?? 0)}%`] : []), ...(sources.some((s) => !NO_CONFLICT(s.conflict_of_interest)) ? [`conflicted sources: ${sources.filter((s) => !NO_CONFLICT(s.conflict_of_interest)).map((s) => `${s.name} (${s.conflict_of_interest})`).join(", ")}`] : []), ...(drawdown != null && drawdown > -3 ? ["buying near the 12-month high"] : []), `liquidity: ${inst.type === "stock" ? "T+1 listed" : inst.type === "mf" ? "T+1/T+3 redemption; exit load may apply" : "illiquid"}`, "single-name risk against the issuer cap"],
    sizing: { amount, basis: sizing.basis, max_by_policy: sizing.max_by_policy ?? null, suggested: sizing.suggested ?? null, cash_available: sizing.cash_available ?? null, rationale: `${sizing.basis ?? "policy headroom"} → ₹${amount.toLocaleString("en-IN")}${tranches.length > 1 ? " in two tranches" : ""}` },
    execution_plan: tranches.map((t) => ({ tranche: t.n, entity_id: entityId, entity: ent.name, connector: conn.label, provider: conn.provider, kind, side: direction, amount: t.amount, instruction: t.when })),
    exit_plan: { target_price: median(targets), stop_loss: median(stops), horizon_months: horizon, review_trigger: direction === "buy" ? "thesis metric misses for two quarters, or cluster consensus turns bearish" : "the reduction thesis reverses (source flips back)" },
    monitoring: [direction === "buy" ? "quarterly results against the thesis" : "next quarterly print", inst.sector ? `sector weight vs cap (${inst.sector})` : "issuer weight vs cap", "cluster consensus and source flips", "policy compliance snapshot after execution"],
    citations: [{ tool: "policy.effective", policy_version_id: policy.current_version_id }, { tool: "portfolio.snapshot", as_of: today(), total }, { tool: "prices.latest", instrument_id: inst.id, price: px }, { tool: "research.cluster", cluster_id: cl.id, consensus: cl.consensus }, { tool: "research.track_record", horizon_months: 12 }, { tool: "assessment", assessment_id: assessment.id }],
    disclaimer: "Internal decision memo for the family's own money — not investment advice to third parties. Drafted by the research agent; every figure cites its tool result. Approval creates action-plane intents that still pass their own policy check and human approval.",
    drafted_by: agentEnabled() ? agentModel() : "deterministic drafter",
  };
  if (agentEnabled()) { const prose = await claudeJson<any>("You write concise investment memos for a family office. Return JSON {summary, thesis, counter_view} — plain prose, cite only numbers present in the input, label inferences as such, keep the counter-view genuinely adversarial.", JSON.stringify({ instrument: inst.name, direction, amount, entity: ent.name, sources, checks: assessment.checks, portfolio_impact: sections.portfolio_impact, prices: { cmp: px, drawdown_from_12m_high: drawdown } })); if (prose?.summary && prose?.counter_view) { sections.summary = prose.summary; sections.thesis = prose.thesis ?? sections.thesis; sections.counter_view = prose.counter_view; sections.agent_session_id = await agentSession(c, familyId, userId, `research.draft_proposal ${cl.id}`); } }
  const errors = validateProposal(sections); if (errors.length) throw new ResearchError(422, `Proposal failed validation: ${errors.join("; ")}`, { errors });
  const st = await settingsFor(c, familyId);
  const title = `${direction === "buy" ? "Add" : "Reduce"} ${inst.name} — ₹${amount.toLocaleString("en-IN")} (${ent.name})`;
  const p = (await c.query("insert into investment_proposals (family_id, cluster_id, assessment_id, title, instrument_id, action, entity_id, goal_id, amount, sections, simulation, agent_session_id, status, expires_at) values ($1,$2,$3,$4,$5,$6::rec_action,$7,$8,$9,$10,$11,$12,'draft', now() + ($13 || ' days')::interval) returning id", [familyId, cl.id, assessment.id, title, inst.id, direction === "buy" ? (recs[0]?.action ?? "buy") : (recs[0]?.action ?? "reduce"), entityId, input.goal_id ?? null, amount, JSON.stringify(sections), JSON.stringify(sections.portfolio_impact), sections.agent_session_id ?? null, String(st.proposal_expiry_days)])).rows[0];
  await c.query("update investment_proposals set status='in_review' where id=$1", [p.id]);
  await c.query("update recommendation_clusters set status='proposal_drafted' where id=$1", [cl.id]); await c.query("update research_recommendations set status='proposal_drafted' where cluster_id=$1 and status <> 'superseded'", [cl.id]);
  return proposalView(c, p.id);
}
export async function proposalView(c: pg.PoolClient, id: string) {
  const p = (await c.query("select p.*, e.name entity_name, i.name instrument_name, i.symbol, u.name decided_by_name, k.consensus, k.direction from investment_proposals p left join entities e on e.id=p.entity_id left join instruments i on i.id=p.instrument_id left join users u on u.id=p.decided_by left join recommendation_clusters k on k.id=p.cluster_id where p.id=$1", [id])).rows[0];
  if (!p) throw new ResearchError(404, "Proposal not found");
  const intents = p.intent_batch_id ? (await c.query("select id, kind, status, amount, entity_id from action_intents where batch_id=$1 order by created_at", [p.intent_batch_id])).rows : [];
  return { ...p, amount: p.amount == null ? null : Number(p.amount), defer_until: iso(p.defer_until), document_url: p.document_html ? `/api/v1/research/proposals/${p.id}/document` : null, intents };
}
export async function updateProposal(c: pg.PoolClient, familyId: string, id: string, userId: string, patch: { sections?: Record<string, any>; amount?: number; entity_id?: string; title?: string }) {
  const p = (await c.query("select * from investment_proposals where id=$1 and family_id=$2", [id, familyId])).rows[0]; if (!p) throw new ResearchError(404, "Proposal not found");
  if (!["draft", "in_review", "deferred"].includes(p.status)) throw new ResearchError(409, `A ${p.status} proposal cannot be edited`);
  const sections = { ...p.sections, ...(patch.sections ?? {}) }; if (patch.amount != null) sections.sizing = { ...(sections.sizing ?? {}), amount: patch.amount, rationale: `${sections.sizing?.basis ?? "policy headroom"} → ₹${Number(patch.amount).toLocaleString("en-IN")} (edited)` };
  const errors = validateProposal(sections); if (errors.length) throw new ResearchError(422, `Proposal failed validation: ${errors.join("; ")}`, { errors });
  sections._history = [...(p.sections._history ?? []), { version: p.version, edited_by: userId, at: new Date().toISOString(), amount: p.amount, title: p.title }].slice(-20);
  const title = patch.title ?? (patch.amount != null ? String(p.title).replace(/₹[\d,\.]+/, `₹${Number(patch.amount).toLocaleString("en-IN")}`) : null);
  await c.query("update investment_proposals set sections=$2, amount=coalesce($3,amount), entity_id=coalesce($4,entity_id), title=coalesce($5,title), version=version+1, document_html=null where id=$1", [id, JSON.stringify(sections), patch.amount ?? null, patch.entity_id ?? null, title]);
  return proposalView(c, id);
}
const esc = (s: any) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
export function renderProposalHtml(p: any) {
  const s = p.sections ?? {}; const li = (a: any[]) => `<ul>${(a ?? []).map((x) => `<li>${esc(typeof x === "string" ? x : JSON.stringify(x))}</li>`).join("")}</ul>`;
  const checks = (s.policy_fit?.checks ?? []).map((k: any) => `<tr><td>${esc(k.clause)}</td><td class="${k.status}">${esc(k.status)}</td><td>${esc(k.detail)}</td></tr>`).join("");
  const srcs = (s.sources ?? []).map((x: any) => `<tr><td>${esc(x.name)}</td><td>${esc(x.kind)}</td><td>${esc(x.action)}</td><td>${x.trust_score}</td><td>${esc(x.conflict_of_interest ?? "—")}</td><td>${x.track_record_12m ? `${x.track_record_12m.hit_rate_pct}% · ${x.track_record_12m.avg_excess_pct > 0 ? "+" : ""}${x.track_record_12m.avg_excess_pct}% (n=${x.track_record_12m.n})` : "—"}</td></tr>`).join("");
  const exec = (s.execution_plan ?? []).map((x: any) => `<li>Tranche ${x.tranche}: ₹${Number(x.amount).toLocaleString("en-IN")} · ${esc(x.entity)} · ${esc(x.connector)} (${esc(x.kind)}) — ${esc(x.instruction)}</li>`).join("");
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(p.title)}</title><style>body{font:14px/1.5 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#12213A;max-width:860px;margin:32px auto;padding:0 20px}h1{font-size:22px;margin:0 0 4px}h2{font-size:15px;margin:22px 0 6px;color:#0E7C6B;border-bottom:1px solid #E5E9F0;padding-bottom:3px}table{border-collapse:collapse;width:100%;font-size:13px}td,th{border-bottom:1px solid #EFF1F4;padding:5px 6px;text-align:left;vertical-align:top}.pass{color:#0E7C6B}.warning{color:#B7791F}.fail{color:#B93B31}.meta{color:#6B7280;font-size:12px}.box{background:#F6F8FB;border-radius:8px;padding:12px}@media print{body{margin:0}}</style></head><body>
<h1>${esc(p.title)}</h1><div class="meta">Investment proposal v${p.version} · ${esc(p.status)} · ${esc(p.entity_name ?? "")} · drafted ${esc(String(p.created_at).slice(0, 10))} · expires ${esc(String(p.expires_at ?? "").slice(0, 10))} · fit ${s.policy_fit?.fit_score ?? "—"} (${esc(s.policy_fit?.verdict ?? "")})</div>
<h2>Summary</h2><p>${esc(s.summary)}</p><h2>Thesis</h2><p>${esc(s.thesis)}</p>
<h2>Sources, track record and conflicts</h2><table><tr><th>Source</th><th>Kind</th><th>Call</th><th>Trust</th><th>Conflict of interest</th><th>12-month record</th></tr>${srcs}</table>
<h2>Counter-view</h2><div class="box">${esc(s.counter_view)}</div>
<h2>Policy fit — ${esc(s.policy_fit?.policy ?? "")}</h2><table><tr><th>Clause</th><th>Status</th><th>Detail</th></tr>${checks}</table>
<h2>Portfolio impact</h2><p>${esc(s.portfolio_impact?.asset_class?.key)} ${s.portfolio_impact?.asset_class?.before_pct}% → ${s.portfolio_impact?.asset_class?.after_pct}%${s.portfolio_impact?.sector ? ` · ${esc(s.portfolio_impact.sector.key)} ${s.portfolio_impact.sector.before_pct}% → ${s.portfolio_impact.sector.after_pct}%` : ""} · top-5 concentration ${s.portfolio_impact?.top5_before_pct ?? "—"}% → ${s.portfolio_impact?.top5_after_pct ?? "—"}% · cash after ₹${Number(s.portfolio_impact?.cash_after ?? 0).toLocaleString("en-IN")}${s.portfolio_impact?.liquidity_months_after != null ? ` · liquidity ${s.portfolio_impact.liquidity_months_after} months` : ""}</p>
<h2>Tax and cash</h2><p>${esc(JSON.stringify(s.tax_impact))}</p><h2>Risks</h2>${li(s.risks)}
<h2>Sizing</h2><p>${esc(s.sizing?.rationale)}${s.sizing?.max_by_policy != null ? ` · policy maximum ₹${Number(s.sizing.max_by_policy).toLocaleString("en-IN")}` : ""}</p>
<h2>Execution plan</h2><ul>${exec}</ul><h2>Exit plan</h2><p>Target ${s.exit_plan?.target_price ?? "—"} · stop ${s.exit_plan?.stop_loss ?? "—"} · horizon ${s.exit_plan?.horizon_months} months · review: ${esc(s.exit_plan?.review_trigger)}</p>
<h2>Monitoring triggers</h2>${li(s.monitoring)}<h2>Citations</h2>${li((s.citations ?? []).map((x: any) => JSON.stringify(x)))}
<p class="meta">${esc(s.disclaimer)} Drafted by ${esc(s.drafted_by)}.</p></body></html>`;
}
export async function renderProposal(c: pg.PoolClient, familyId: string, id: string) {
  const p = await proposalView(c, id); if (p.family_id !== familyId) throw new ResearchError(404, "Proposal not found");
  const html = renderProposalHtml(p); await c.query("update investment_proposals set document_html=$2 where id=$1", [id, html]); return { id, html, document_url: `/api/v1/research/proposals/${id}/document` };
}
/** Approve / reject / defer. Approve with convert=true creates the intent batch through the action plane's own policy check. */
export async function decideProposal(c: pg.PoolClient, familyId: string, user: { id: string; role: string }, id: string, d: { decision: "approve" | "reject" | "defer"; note?: string | null; defer_until?: string | null; convert?: boolean; amount_override?: number | null }) {
  const st = await settingsFor(c, familyId); if (!(st.decide_roles as string[]).includes(user.role)) throw new ResearchError(403, `Only ${(st.decide_roles as string[]).join(" / ")} can decide proposals`);
  const p = (await c.query("select * from investment_proposals where id=$1 and family_id=$2", [id, familyId])).rows[0]; if (!p) throw new ResearchError(404, "Proposal not found");
  const move = async (status: string, extra: string = "", args: any[] = []) => { try { await c.query(`update investment_proposals set status=$2::proposal_status, decided_by=$3, decided_at=now(), decision_note=coalesce($4, decision_note) ${extra} where id=$1`, [id, status, user.id, d.note ?? null, ...args]); } catch (e: any) { throw new ResearchError(409, String(e.message).replace(/^error: /, "")); } };
  if (p.status === "deferred" || p.status === "draft") await move("in_review");
  if (d.decision === "reject") { await move("rejected"); await c.query("update recommendation_clusters set status='dismissed', dismissed_reason=$2, dismissed_by=$3, dismissed_at=now() where id=$1 and status <> 'dismissed'", [p.cluster_id, `rejected: ${d.note ?? "no note"}`, user.id]); return proposalView(c, id); }
  if (d.decision === "defer") { await move("deferred", ", defer_until=$5", [d.defer_until ?? addDays(today(), 90)]); return proposalView(c, id); }
  if (d.amount_override != null && Number(d.amount_override) !== Number(p.amount)) await updateProposal(c, familyId, id, user.id, { amount: Number(d.amount_override) });
  await move("approved");
  if (!d.convert) return proposalView(c, id);
  const fresh = (await c.query("select * from investment_proposals where id=$1", [id])).rows[0]; const amount = Number(fresh.amount);
  const plan: any[] = fresh.sections.execution_plan ?? []; const planTotal = plan.reduce((s, t) => s + Number(t.amount), 0) || amount;
  const batch = (await c.query("select gen_random_uuid() id")).rows[0].id; const intents: any[] = [];
  for (const t of plan) {
    const amt = r2(amount * Number(t.amount) / planTotal); if (!(amt > 0)) continue;
    const payload = { instrument_id: fresh.instrument_id, side: t.side, amount: amt, instruction: t.instruction, proposal_id: id, tranche: t.tranche, name: fresh.title };
    intents.push(await createIntent(c, familyId, user.id, { entity_id: t.entity_id ?? fresh.entity_id, kind: t.kind ?? "assisted", payload, amount: amt, rationale: `Research proposal: ${fresh.title} (tranche ${t.tranche})`, source_type: "investment_proposal", source_id: id, batch_id: batch, idempotency_key: `proposal-${id}-v${fresh.version}-${t.tranche}` }));
  }
  await move("converted", ", intent_batch_id=$5", [batch]);
  return proposalView(c, id);
}
export async function expireProposals(c: pg.PoolClient, familyId: string) {
  const r = await c.query("update investment_proposals set status='expired' where family_id=$1 and status in ('in_review','deferred') and expires_at < now() and (defer_until is null or defer_until < current_date) returning id", [familyId]);
  return r.rowCount ?? 0;
}

// ---------- digest (FO-156) ----------
export async function generateDigest(c: pg.PoolClient, familyId: string, userId: string | null, opts: { period_start?: string; period_end?: string; cadence?: string; send_to?: string[] } = {}) {
  const st = await settingsFor(c, familyId); const end = opts.period_end ?? today(); const cadence = opts.cadence ?? st.digest_cadence;
  const start = opts.period_start ?? addDays(end, cadence === "monthly" ? -30 : cadence === "fortnightly" ? -14 : -7);
  await expireProposals(c, familyId);
  const items = (await c.query("select i.id, i.title, i.channel_kind, i.status, s.name source_name, (select count(*) from research_recommendations r where r.item_id=i.id) recs from research_items i left join research_sources s on s.id=i.source_id where i.family_id=$1 and i.received_at::date between $2 and $3 and i.title not like 'Archive —%' order by i.received_at desc", [familyId, start, end])).rows;
  const recs = (await c.query("select r.id, r.action, r.instrument_text, r.status, i.name instrument_name, a.sector from research_recommendations r left join instruments i on i.id=r.instrument_id left join lateral (select sector from instrument_attributes x where x.instrument_id=r.instrument_id order by as_of desc limit 1) a on true where r.family_id=$1 and r.published_on between $2 and $3", [familyId, start, end])).rows;
  const clusters = (await c.query("select k.*, i.name instrument_name, a.verdict, a.fit_score from recommendation_clusters k left join instruments i on i.id=k.instrument_id left join lateral (select verdict, fit_score from recommendation_assessments x where x.cluster_id=k.id order by assessed_at desc limit 1) a on true where k.family_id=$1 and k.last_seen between $2 and $3 and k.status <> 'superseded'", [familyId, start, end])).rows;
  const dismissed = clusters.filter((k) => k.status === "dismissed").map((k) => ({ cluster_id: k.id, instrument: k.instrument_name ?? k.instrument_text, direction: k.direction, verdict: k.verdict, reason: k.dismissed_reason ?? "dismissed" }));
  const proposals = (await c.query("select id, title, status, amount, sections->'policy_fit'->>'fit_score' fit_score, sections->'policy_fit'->>'verdict' verdict, defer_until, expires_at from investment_proposals where family_id=$1 and (status='in_review' or (status='deferred' and coalesce(defer_until, current_date) <= $2)) order by created_at", [familyId, end])).rows;
  const themes = (() => { const m: Record<string, number> = {}; for (const r of recs) { for (const k of [r.sector, r.instrument_name ?? r.instrument_text]) if (k) m[k] = (m[k] ?? 0) + 1; } return Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, n]) => `${k} (${n})`); })();
  const leaderboard = (await c.query("select s.id, s.name, s.kind, s.trust_score, s.trust_history from research_sources s where s.family_id=$1 and s.active order by s.trust_score desc", [familyId])).rows.map((s) => { const h = (s.trust_history as any[]).filter((x) => x.date >= start && x.date <= end); return { source_id: s.id, source: s.name, kind: s.kind, trust_score: Number(s.trust_score), moved_from: h.length ? Number(h[0].from) : null, moved_to: h.length ? Number(h[h.length - 1].to) : null }; });
  let agentThemes: string[] | null = null; if (agentEnabled() && recs.length) agentThemes = await claudeJson<string[]>("Summarise the week's research into at most four short themes (JSON array of strings). Use only the input.", JSON.stringify({ items: items.map((i) => i.title), recommendations: recs.map((r) => `${r.action} ${r.instrument_name ?? r.instrument_text}`) }));
  const summary = { items: items.length, recommendations: recs.length, clusters: clusters.length, dismissed, declined_count: dismissed.length, proposals: proposals.map((p) => ({ id: p.id, title: p.title, status: p.status, amount: Number(p.amount), fit_score: p.fit_score == null ? null : Number(p.fit_score), verdict: p.verdict, defer_until: iso(p.defer_until) })), awaiting: proposals.filter((p) => p.status === "in_review").length, deferred: proposals.filter((p) => p.status === "deferred").length, themes: agentThemes?.length ? agentThemes : themes, source_leaderboard: leaderboard, items_list: items.map((i) => ({ id: i.id, title: i.title, channel: i.channel_kind, source: i.source_name, recommendations: Number(i.recs), status: i.status })) };
  const monthEnd = new Date(Date.UTC(Number(end.slice(0, 4)), Number(end.slice(5, 7)), 0)).toISOString().slice(0, 10) === end;
  const caEmails = st.ca_monthly_copy && (cadence === "monthly" || monthEnd) ? (await c.query("select u.email from family_members m join users u on u.id=m.user_id where m.family_id=$1 and m.role='viewer'", [familyId])).rows.map((r) => r.email) : [];
  const sendTo = [...new Set([...(opts.send_to ?? (st.send_to?.length ? st.send_to : (await c.query("select u.email from family_members m join users u on u.id=m.user_id where m.family_id=$1 and m.role in ('owner','member')", [familyId])).rows.map((r) => r.email))), ...caEmails])];
  const d = (await c.query("insert into research_digests (family_id, period_start, period_end, cadence, summary, proposal_ids, sent_to, status) values ($1,$2,$3,$4,$5,$6,$7,$8) returning *", [familyId, start, end, cadence, JSON.stringify(summary), proposals.map((p) => p.id), sendTo, proposals.length ? "open" : "closed"])).rows[0];
  if (proposals.length) await c.query("update investment_proposals set digest_id=$2 where id = any($1::uuid[])", [proposals.map((p) => p.id), d.id]);
  await c.query("update research_digests set document_html=$2 where id=$1", [d.id, renderDigestHtml({ ...d, summary })]);
  // in-app + push: one task per digest that has something to decide
  if (proposals.length) {
    const t = (await c.query("insert into tasks (family_id, module, title, reason, severity, source_type, source_id, verification) values ($1,'research',$2,$3,2,'research_digest',$4,'na') on conflict do nothing returning *", [familyId, `Research digest: ${summary.awaiting} proposal${summary.awaiting === 1 ? "" : "s"} to decide`, `${items.length} items · ${recs.length} recommendations · ${dismissed.length} declined with reasons · week ${start} – ${end}`, d.id])).rows[0];
    if (t) await notifyTask(c, t, { push: true }).catch(() => null);
  }
  return digestView(c, d.id);
}
export async function digestView(c: pg.PoolClient, id: string) {
  const d = (await c.query("select * from research_digests where id=$1", [id])).rows[0]; if (!d) throw new ResearchError(404, "Digest not found");
  const proposals = d.proposal_ids?.length ? (await c.query("select p.id, p.title, p.status, p.amount, p.entity_id, e.name entity_name, p.sections->'policy_fit' policy_fit, p.sections->>'summary' summary, p.defer_until, p.decision_note from investment_proposals p left join entities e on e.id=p.entity_id where p.id = any($1::uuid[]) order by array_position($1::uuid[], p.id)", [d.proposal_ids])).rows : [];
  return { ...d, period_start: iso(d.period_start), period_end: iso(d.period_end), proposals: proposals.map((p) => ({ ...p, amount: Number(p.amount), defer_until: iso(p.defer_until) })), document_url: d.document_html ? `/api/v1/research/digests/${d.id}/document` : null };
}
export function renderDigestHtml(d: any) {
  const s = d.summary ?? {}; const row = (cells: any[]) => `<tr>${cells.map((x) => `<td>${esc(x)}</td>`).join("")}</tr>`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>Research digest ${esc(iso(d.period_start))} – ${esc(iso(d.period_end))}</title><style>body{font:14px/1.5 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#12213A;max-width:860px;margin:32px auto;padding:0 20px}h1{font-size:22px}h2{font-size:15px;color:#0E7C6B;border-bottom:1px solid #E5E9F0;margin:22px 0 6px}table{border-collapse:collapse;width:100%;font-size:13px}td,th{border-bottom:1px solid #EFF1F4;padding:5px 6px;text-align:left}.k{display:inline-block;margin:0 18px 8px 0}.k b{display:block;font-size:20px}.meta{color:#6B7280;font-size:12px}</style></head><body>
<h1>Research digest — ${esc(iso(d.period_start))} to ${esc(iso(d.period_end))}</h1><div class="meta">${esc(d.cadence)} · sent to ${esc((d.sent_to ?? []).join(", "))}</div>
<div><span class="k"><b>${s.items ?? 0}</b>items</span><span class="k"><b>${s.recommendations ?? 0}</b>recommendations</span><span class="k"><b>${s.clusters ?? 0}</b>clusters</span><span class="k"><b>${s.declined_count ?? 0}</b>declined</span><span class="k"><b>${s.awaiting ?? 0}</b>to decide</span><span class="k"><b>${s.deferred ?? 0}</b>deferred</span></div>
<h2>Themes</h2><p>${esc((s.themes ?? []).join(" · ") || "—")}</p>
<h2>Proposals awaiting decision</h2><table><tr><th>Proposal</th><th>Verdict</th><th>Fit</th><th>Amount</th><th>Status</th></tr>${(s.proposals ?? []).map((p: any) => row([p.title, p.verdict ?? "", p.fit_score ?? "", `₹${Number(p.amount).toLocaleString("en-IN")}`, p.status])).join("")}</table>
<h2>Declined, with reasons</h2><table><tr><th>Instrument</th><th>Direction</th><th>Verdict</th><th>Reason</th></tr>${(s.dismissed ?? []).map((x: any) => row([x.instrument, x.direction, x.verdict ?? "", x.reason])).join("") || row(["—", "", "", "nothing declined"])}</table>
<h2>What arrived</h2><table><tr><th>Item</th><th>Channel</th><th>Source</th><th>Recs</th></tr>${(s.items_list ?? []).map((i: any) => row([i.title, i.channel, i.source ?? "unattributed", i.recommendations])).join("")}</table>
<h2>Source leaderboard</h2><table><tr><th>Source</th><th>Kind</th><th>Trust</th><th>Movement</th></tr>${(s.source_leaderboard ?? []).map((x: any) => row([x.source, x.kind, x.trust_score, x.moved_from != null ? `${x.moved_from} → ${x.moved_to}` : "—"])).join("")}</table>
<p class="meta">Approve / reject / defer in the app; one step-up decides the batch. Approved proposals become intent batches in the Action plane; deferred ones return in a later digest. Internal decision memo for the family's own money — not investment advice to third parties.</p></body></html>`;
}
export async function decideDigest(c: pg.PoolClient, familyId: string, user: { id: string; role: string }, id: string, decisions: { proposal_id: string; decision: "approve" | "reject" | "defer"; note?: string | null; defer_until?: string | null; convert?: boolean; amount_override?: number | null }[]) {
  const d = (await c.query("select * from research_digests where id=$1 and family_id=$2", [id, familyId])).rows[0]; if (!d) throw new ResearchError(404, "Digest not found");
  const out: any[] = [];
  for (const x of decisions) { if (!(d.proposal_ids as string[]).includes(x.proposal_id)) throw new ResearchError(422, `Proposal ${x.proposal_id} is not in this digest`); out.push(await decideProposal(c, familyId, user, x.proposal_id, x)); }
  const open = Number((await c.query("select count(*) n from investment_proposals where id = any($1::uuid[]) and status in ('in_review')", [d.proposal_ids])).rows[0].n);
  await c.query("update research_digests set status=$2 where id=$1", [id, open ? "open" : "actioned"]);
  return out;
}

// ---------- track record & trust (FO-157) ----------
const HORIZONS = [3, 6, 12, 24];
export async function evaluateTrackRecord(c: pg.PoolClient, familyId: string, asOf = today()) {
  const bench = new Map<string, string>((await c.query("select id, code from benchmarks")).rows.map((b) => [b.code, b.id]));
  const recs = (await c.query("select r.id, r.source_id, r.instrument_id, r.action, r.published_on, r.price_at_publish, i.asset_class, i.type from research_recommendations r join instruments i on i.id=r.instrument_id where r.family_id=$1 and r.source_id is not null and r.published_on is not null and r.status <> 'new' order by r.published_on", [familyId])).rows;
  let rows = 0;
  for (const r of recs) {
    const pub = iso(r.published_on)!; const then = r.price_at_publish != null ? Number(r.price_at_publish) : await priceAt(c, r.instrument_id, pub); if (!then) continue;
    const cls = allocClassOf(r.asset_class, r.type); const bId = bench.get(cls === "debt" ? "CRISIL_CBI" : "NIFTY50") ?? null;
    for (const h of HORIZONS) {
      const at = addMonths(pub, h); if (at > asOf) continue;
      const now = (await c.query("select close, price_date from prices where instrument_id=$1 and price_date between $2::date - 45 and $2 order by price_date desc limit 1", [r.instrument_id, at])).rows[0]; if (!now) continue;
      const b0 = bId ? (await c.query("select value from benchmark_prices where benchmark_id=$1 and price_date <= $2 order by price_date desc limit 1", [bId, pub])).rows[0] : null, b1 = bId ? (await c.query("select value from benchmark_prices where benchmark_id=$1 and price_date <= $2 order by price_date desc limit 1", [bId, at])).rows[0] : null;
      const ret = r2((Number(now.close) / then - 1) * 100); const bret = b0 && b1 ? r2((Number(b1.value) / Number(b0.value) - 1) * 100) : 0; const excess = r2(ret - bret);
      const dir = directionOf(r.action); const hit = dir === "bullish" ? excess > 0 : dir === "bearish" ? excess < 0 : excess >= -3;
      await c.query("insert into source_track_record (family_id, source_id, recommendation_id, horizon_months, evaluated_on, price_then, price_now, return_pct, benchmark_return_pct, excess_pct, hit) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) on conflict (recommendation_id, horizon_months) do update set evaluated_on=excluded.evaluated_on, price_now=excluded.price_now, return_pct=excluded.return_pct, benchmark_return_pct=excluded.benchmark_return_pct, excess_pct=excluded.excess_pct, hit=excluded.hit", [familyId, r.source_id, r.id, h, iso(now.price_date), then, Number(now.close), ret, bret, excess, hit]);
      rows++;
    }
  }
  // trust update: 12-month record (6-month when thin), bounded ±5 per run, friends capped at 40
  let moved = 0;
  for (const s of (await c.query("select id, kind, trust_score from research_sources where family_id=$1 and active", [familyId])).rows) {
    let rec = (await c.query("select count(*) n, avg(case when hit then 100.0 else 0 end) hit_rate, avg(excess_pct) excess from source_track_record where source_id=$1 and horizon_months=12", [s.id])).rows[0];
    if (Number(rec.n) < 5) rec = (await c.query("select count(*) n, avg(case when hit then 100.0 else 0 end) hit_rate, avg(excess_pct) excess from source_track_record where source_id=$1 and horizon_months=6", [s.id])).rows[0];
    if (Number(rec.n) < 5) continue;
    const target = Math.max(5, Math.min(s.kind === "friend" ? 40 : 95, 50 + (Number(rec.hit_rate) - 50) * 0.6 + Number(rec.excess) * 2));
    const from = Number(s.trust_score); const to = r2(from + Math.max(-5, Math.min(5, target - from)));
    if (to !== from) { moved++; await c.query("update research_sources set trust_score=$2, trust_history = (trust_history || jsonb_build_object('date', $3::text, 'from', $4::numeric, 'to', $2::numeric, 'n', $5::int, 'hit_rate', round($6::numeric, 1)))::jsonb where id=$1", [s.id, to, asOf, from, Number(rec.n), Number(rec.hit_rate)]); }
  }
  return { rows, note: `${rows} evaluations, ${moved} trust scores moved`, moved };
}
export async function leaderboard(c: pg.PoolClient, familyId: string, horizon = 12) {
  const rows = (await c.query(`select s.id source_id, s.name source, s.kind, s.conflict_of_interest, s.trust_score, s.sebi_registration,
      count(t.id) n, round(avg(case when t.hit then 100.0 else 0 end), 1) hit_rate_pct, round(avg(t.excess_pct), 2) avg_excess_pct,
      (select json_build_object('instrument', i.name, 'excess_pct', x.excess_pct, 'published_on', r.published_on) from source_track_record x join research_recommendations r on r.id=x.recommendation_id join instruments i on i.id=r.instrument_id where x.source_id=s.id and x.horizon_months=$2 order by x.excess_pct desc limit 1) best,
      (select json_build_object('instrument', i.name, 'excess_pct', x.excess_pct, 'published_on', r.published_on) from source_track_record x join research_recommendations r on r.id=x.recommendation_id join instruments i on i.id=r.instrument_id where x.source_id=s.id and x.horizon_months=$2 order by x.excess_pct asc limit 1) worst,
      (select json_object_agg(h, j) from (select horizon_months h, json_build_object('n', count(*), 'hit_rate_pct', round(avg(case when hit then 100.0 else 0 end),1), 'avg_excess_pct', round(avg(excess_pct),2)) j from source_track_record y where y.source_id=s.id group by horizon_months) z) by_horizon
    from research_sources s left join source_track_record t on t.source_id=s.id and t.horizon_months=$2 where s.family_id=$1 and s.active group by s.id order by count(t.id) desc, s.trust_score desc`, [familyId, horizon])).rows;
  return rows.map((r) => ({ ...r, trust_score: Number(r.trust_score), n: Number(r.n), hit_rate_pct: r.hit_rate_pct == null ? null : Number(r.hit_rate_pct), avg_excess_pct: r.avg_excess_pct == null ? null : Number(r.avg_excess_pct), horizon_months: horizon }));
}
/** Everything the nightly / hourly jobs do, in order: poll → cluster → assess → expire. */
export async function runPipeline(c: pg.PoolClient, familyId: string, opts: { poll?: boolean; fetchImpl?: typeof fetch } = {}) {
  const polled = opts.poll ? await pollChannels(c, familyId, opts.fetchImpl) : null;
  for (const it of (await c.query("select id from research_items where family_id=$1 and status='new' and not exists (select 1 from research_recommendations r where r.item_id=research_items.id)", [familyId])).rows) await extractItem(c, familyId, it.id, null);
  const cl = await clusterAll(c, familyId); const as = await assessAll(c, familyId); const expired = await expireProposals(c, familyId);
  return { rows: cl.rows + as.rows, note: `${polled ? polled.note + "; " : ""}${cl.note}; ${as.note}; ${expired} expired`, polled, clusters: cl, assessments: as, expired };
}
