/** Tally live sync (FO-119 residue): the same XML the export produces, POSTed to a running Tally's HTTP gateway (default port 9000);
 *  the day book pulled back with an Export Data request and fed through tallyImport. `fetchImpl` is injectable for tests. */
import type pg from "pg";
import { GlError, tallyExport, tallyImport } from "./gl.js";

type Fetch = (url: string, init?: any) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;
const tag = (s: string, t: string) => s.match(new RegExp(`<${t}>([\\s\\S]*?)</${t}>`, "i"))?.[1]?.trim() ?? null;
const xml = (s: any) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const tallyDate = (d: string) => d.replace(/-/g, "");

async function endpoint(c: pg.PoolClient, entityId: string) {
  const b = (await c.query("select b.tally_url, b.tally_company, e.name from gl_books b join entities e on e.id=b.entity_id where b.entity_id=$1", [entityId])).rows[0]; if (!b) throw new GlError(404, "No book for this entity");
  const url = b.tally_url ?? process.env.TALLY_URL; if (!url) throw new GlError(422, "No Tally endpoint: set tally_url on the book (PUT /gl/books) or TALLY_URL", { code: "tally_url_missing" });
  return { url, company: b.tally_company ?? b.name };
}
async function post(fetchImpl: Fetch, url: string, body: string, timeoutMs = 20_000) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), timeoutMs);
  try { const r = await fetchImpl(url, { method: "POST", headers: { "content-type": "text/xml; charset=utf-8" }, body, signal: ctl.signal }); const text = await r.text(); if (!r.ok) throw new GlError(502, `Tally answered HTTP ${r.status}`, { body: text.slice(0, 300) }); return text; }
  catch (e: any) { if (e instanceof GlError) throw e; throw new GlError(502, `Tally unreachable at ${url}: ${e.name === "AbortError" ? "timeout" : e.message}`); }
  finally { clearTimeout(t); }
}
/** Connectivity: asks Tally for its company list and reports whether the book's company is open. */
export async function tallyPing(c: pg.PoolClient, entityId: string, fetchImpl: Fetch = fetch as any) {
  const { url, company } = await endpoint(c, entityId);
  const req = `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>List of Companies</ID></HEADER><BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT></STATICVARIABLES><TDL><TDLMESSAGE><COLLECTION NAME="List of Companies" ISMODIFY="No"><TYPE>Company</TYPE><FETCH>NAME</FETCH></COLLECTION></TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>`;
  const text = await post(fetchImpl, url, req, 8_000); const companies = [...text.matchAll(/<NAME[^>]*>([^<]+)<\/NAME>/gi)].map((m) => m[1].trim()).filter((v, i, a) => a.indexOf(v) === i);
  return { url, company, reachable: true, companies, company_open: companies.some((x) => x.toLowerCase() === company.toLowerCase()) };
}
/** Push: export the period's masters + vouchers and import them into Tally; the sync row records Tally's CREATED / ALTERED / ERRORS counts and line errors. */
export async function tallyPush(c: pg.PoolClient, familyId: string, entityId: string, from: string, to: string, opts: { includeMasters?: boolean; fetchImpl?: Fetch } = {}) {
  const { url, company } = await endpoint(c, entityId); const fetchImpl = opts.fetchImpl ?? (fetch as any);
  const exp = await tallyExport(c, familyId, entityId, from, to, opts.includeMasters ?? true);
  const body = exp.xml.replace(/<SVCURRENTCOMPANY>[^<]*<\/SVCURRENTCOMPANY>/, `<SVCURRENTCOMPANY>${xml(company)}</SVCURRENTCOMPANY>`);
  let text = ""; try { text = await post(fetchImpl, url, body); } catch (e: any) { await c.query("update gl_tally_sync set status='failed', log=$2::jsonb, response=$3 where id=$1", [exp.sync_id, JSON.stringify({ error: e.message, url }), JSON.stringify(e.extra ?? null)]); throw e; }
  const created = Number(tag(text, "CREATED") ?? 0), altered = Number(tag(text, "ALTERED") ?? 0), errors = Number(tag(text, "ERRORS") ?? 0), exceptions = Number(tag(text, "EXCEPTIONS") ?? 0);
  const lineErrors = [...text.matchAll(/<LINEERROR>([\s\S]*?)<\/LINEERROR>/gi)].map((m) => m[1].trim()).slice(0, 20);
  const status = errors || exceptions ? (created || altered ? "partial" : "failed") : "done";
  await c.query("update gl_tally_sync set status=$2, log=$3::jsonb, response=$4, created_count=$5, altered_count=$6, error_count=$7 where id=$1", [exp.sync_id, status, JSON.stringify({ pushed_to: url, company, created, altered, errors: errors + exceptions, line_errors: lineErrors }), text.slice(0, 4000), created, altered, errors + exceptions]);
  if (status !== "failed") await c.query("update gl_books set last_tally_sync_at=now() where entity_id=$1", [entityId]);
  return { sync_id: exp.sync_id, url, company, vouchers: exp.vouchers, masters: exp.masters, created, altered, errors: errors + exceptions, line_errors: lineErrors, status };
}
/** Pull: Tally's day book for the range → vouchers not yet in the books are imported (guid de-duplicated by tallyImport). */
export async function tallyPull(c: pg.PoolClient, familyId: string, entityId: string, from: string, to: string, userId: string, opts: { mapping?: Record<string, string>; fetchImpl?: Fetch } = {}) {
  const { url, company } = await endpoint(c, entityId); const fetchImpl = opts.fetchImpl ?? (fetch as any);
  const req = `<ENVELOPE><HEADER><TALLYREQUEST>Export Data</TALLYREQUEST></HEADER><BODY><EXPORTDATA><REQUESTDESC><REPORTNAME>Day Book</REPORTNAME><STATICVARIABLES><SVCURRENTCOMPANY>${xml(company)}</SVCURRENTCOMPANY><SVFROMDATE>${tallyDate(from)}</SVFROMDATE><SVTODATE>${tallyDate(to)}</SVTODATE><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT></STATICVARIABLES></REQUESTDESC></EXPORTDATA></BODY></ENVELOPE>`;
  const text = await post(fetchImpl, url, req, 60_000);
  const r = await tallyImport(c, familyId, entityId, text, userId, opts.mapping ?? {});
  await c.query("update gl_tally_sync set log = coalesce(log,'[]'::jsonb) || $2::jsonb, response=$3, from_date=$4, to_date=$5 where id=(select id from gl_tally_sync where entity_id=$1 and direction='import' order by created_at desc limit 1)", [entityId, JSON.stringify([{ pulled_from: url, company, from, to }]), text.slice(0, 4000), from, to]).catch(() => {});
  await c.query("update gl_books set last_tally_sync_at=now() where entity_id=$1", [entityId]);
  return { ...r, url, company };
}
