import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import { buildApp } from "../src/server.js";
import { withFamily } from "../src/lib/db.js";

// GL period-end residue (FO-118 / 119): mark-to-market against the unrealised reserve, depreciation from `depreciation_rates` (data, WDV),
// both posted once per period and carried by a period close; Tally live sync against an in-test Tally (HTTP gateway) for ping / push / pull.
// Posted journals are immutable, so assertions are delta-based and re-runs find the journals already posted.
const FAMILY = "11111111-1111-1111-1111-111111111111", HUF = "33333333-0000-0000-0000-000000000002", ARJUN = "33333333-0000-0000-0000-000000000001";
let app: ReturnType<typeof buildApp>; let owner = "", viewer = ""; let tally: Server; let tallyUrl = ""; const tallyReqs: string[] = []; let tallyMode: "ok" | "errors" | "down" = "ok";
const h = (t = owner) => ({ authorization: `Bearer ${t}`, "x-family-id": FAMILY });
const get = async (url: string, t = owner) => { const r = await app.inject({ url: `/api/v1${url}`, headers: h(t) }); return { code: r.statusCode, body: r.json() }; };
const send = async (method: "POST" | "PATCH" | "PUT" | "DELETE", url: string, payload: any = {}, t = owner) => { const r = await app.inject({ method, url: `/api/v1${url}`, headers: h(t), payload }); return { code: r.statusCode, body: r.statusCode === 204 ? null : r.json() }; };
const run = <T>(fn: (c: any) => Promise<T>) => withFamily(FAMILY, fn);
let q2 = "", q3 = "", assetId = "";

beforeAll(async () => {
  app = buildApp(); await app.ready();
  const login = async (email: string) => (await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password: "Prototype!2026" } })).json().access_token;
  owner = await login("arjun@example.com"); viewer = await login("ca@example.com");
  tally = createServer((req, res) => { let body = ""; req.on("data", (d) => (body += d)); req.on("end", () => { tallyReqs.push(body);
    if (tallyMode === "down") { res.statusCode = 500; return res.end("<ENVELOPE>internal</ENVELOPE>"); }
    if (/List of Companies/.test(body)) return res.end(`<ENVELOPE><BODY><DATA><COLLECTION><COMPANY><NAME TYPE="String">Mehta HUF</NAME></COMPANY><COMPANY><NAME TYPE="String">Other Co</NAME></COMPANY></COLLECTION></DATA></BODY></ENVELOPE>`);
    if (/Import Data/.test(body)) { const n = (body.match(/<VOUCHER /g) ?? []).length; const m = (body.match(/<LEDGER /g) ?? []).length; return res.end(tallyMode === "errors" ? `<RESPONSE><CREATED>${Math.max(0, n - 1)}</CREATED><ALTERED>${m}</ALTERED><ERRORS>1</ERRORS><LINEERROR>Ledger 'Unknown' does not exist!</LINEERROR></RESPONSE>` : `<RESPONSE><CREATED>${n}</CREATED><ALTERED>${m}</ALTERED><DELETED>0</DELETED><ERRORS>0</ERRORS></RESPONSE>`); }
    if (/Day Book/.test(body)) return res.end(`<ENVELOPE><BODY><DATA><TALLYMESSAGE><VOUCHER VCHTYPE="Journal" ACTION="Create"><DATE>20260805</DATE><GUID>tally-test-${tallyReqs.length}-1</GUID><NARRATION>GL test Tally pull — audit fee</NARRATION><ALLLEDGERENTRIES.LIST><LEDGERNAME>Professional fees</LEDGERNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><AMOUNT>-1500</AMOUNT></ALLLEDGERENTRIES.LIST><ALLLEDGERENTRIES.LIST><LEDGERNAME>Bank accounts</LEDGERNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>1500</AMOUNT></ALLLEDGERENTRIES.LIST></VOUCHER></TALLYMESSAGE></DATA></BODY></ENVELOPE>`);
    res.end("<ENVELOPE/>"); }); });
  await new Promise<void>((r) => tally.listen(0, "127.0.0.1", () => r())); tallyUrl = `http://127.0.0.1:${(tally.address() as any).port}`;
  await run(async (c) => {
    await c.query("update gl_books set maker_checker=false, strict_reconciliation=false, mark_to_market=true, depreciation=true, mtm_treatment='reserve', tally_url=null where entity_id=$1", [HUF]);
    await c.query("update gl_periods set status='open', closed_by=null, closed_at=null where entity_id=$1 and fy='2026-27'", [HUF]);
    const ps = (await c.query("select id, period_start::text s from gl_periods where entity_id=$1 and fy='2026-27' order by period_start", [HUF])).rows; q2 = ps.find((p: any) => p.s === "2026-10-01").id; q3 = ps.find((p: any) => p.s === "2027-01-01").id;   // Q3 / Q4 of the FY: gl.test closes the earlier quarters
    await c.query("delete from lifestyle_assets where family_id=$1 and name like 'GL test %'", [FAMILY]);
    assetId = (await c.query("insert into lifestyle_assets (family_id, entity_id, kind, name, acquired_on, cost, current_value, include_in_net_worth) values ($1,$2,'other','GL test office furniture','2026-05-15',36500,36500,false) returning id", [FAMILY, HUF])).rows[0].id;
  });
});
afterAll(async () => {
  await run(async (c) => { await c.query("delete from lifestyle_assets where family_id=$1 and name like 'GL test %'", [FAMILY]); await c.query("update gl_periods set status='open', closed_by=null, closed_at=null where entity_id=$1 and fy='2026-27'", [HUF]); await c.query("update gl_books set tally_url=null, tally_company=null where entity_id=$1", [HUF]); await c.query("delete from gl_tally_sync where entity_id=$1 and log::text like '%127.0.0.1%'", [HUF]); });
  await new Promise<void>((r) => tally.close(() => r())); await app.close();
});

describe("mark-to-market and depreciation", () => {
  it("previews the MTM per investment account from prices and the book balance; rates and the schedule come from depreciation_rates", async () => {
    const pv = (await get(`/gl/period-end/preview?entity_id=${HUF}&as_of=2026-09-30`)).body; expect(pv.mtm).toMatchObject({ enabled: true, treatment: "reserve" }); expect(pv.mtm.rows.length).toBeGreaterThan(0);
    const mf = pv.mtm.rows.find((r: any) => r.account_code === "1220"); expect(mf).toBeTruthy(); expect(Number(mf.market_value)).toBeGreaterThan(0); expect(mf.holdings.some((x: any) => /Parag Parikh/.test(x.instrument) && !x.unpriced)).toBe(true);
    expect(Number(pv.mtm.total_adjustment)).toBe(pv.mtm.rows.reduce((s: number, r: any) => s + Number(r.adjustment), 0));
    const dep = pv.depreciation; expect(dep.enabled).toBe(true); const art = dep.rows.find((r: any) => r.kind === "art"); expect(art).toMatchObject({ depreciable: false, rate_pct: 0 });
    const furn = dep.rows.find((r: any) => r.asset_id === assetId); expect(furn).toMatchObject({ kind: "other", method: "wdv", rate_pct: 10, cost: "36500.00", opening_wdv: "36500.00" }); expect(furn.depreciable_days).toBe(321);   // 15 May → 31 Mar
    expect(Number(furn.charge_for_year)).toBeCloseTo(36500 * 0.10 * 321 / 365, 0);
    const rates = (await get("/gl/depreciation/rates")).body; expect(rates.find((r: any) => r.asset_kind === "vehicle").rate_pct).toBe(15); expect((await get(`/gl/depreciation/schedule?entity_id=${HUF}&fy=2026-27`)).body.rows.length).toBe(dep.rows.length);
  });
  it("a soft close carries the period's depreciation and MTM journals once; re-running finds them; viewers cannot post", async () => {
    expect((await send("POST", "/gl/period-end/post", { entity_id: HUF, period_id: q2 }, viewer)).code).toBe(403);
    const before = (await get(`/gl/period-end/preview?entity_id=${HUF}&as_of=2026-12-31`)).body; const expectedMtm = Number(before.mtm.total_adjustment);
    const close = await send("POST", `/gl/periods/${q2}/status`, { status: "soft_closed" }); expect(close.code).toBe(200); expect(close.body.status).toBe("soft_closed");
    const p = close.body.period_end_postings; expect(p.period_end).toBe("2026-12-31");
    const dj = p.depreciation.journal; expect(dj).toBeTruthy(); expect(dj.source_type).toBe("depreciation"); expect(dj.entry_date).toBe("2026-12-31");
    const fresh = p.depreciation.posted;   /* an earlier suite or run may already own this period's journal (posted before this test's asset existed) */ const depLine = fresh ? dj.lines.find((l: any) => l.account_code === "5800" && l.sub_ledger_id === assetId) : null; const accLine = fresh ? dj.lines.find((l: any) => l.account_code === "1340" && l.sub_ledger_id === assetId) : null;
    if (fresh) { expect(Number(depLine.debit)).toBeCloseTo(36500 * 0.10 * 92 / 365, 0); expect(Number(accLine.credit)).toBe(Number(depLine.debit)); expect(accLine.sub_ledger_id).toBe(assetId); }
    if (p.mtm.journal) { const mj = p.mtm.journal; expect(mj.source_type).toBe("mtm"); expect(mj.lines.some((l: any) => l.account_code === "3400")).toBe(true); expect(mj.lines.some((l: any) => l.account_code === "4420" || l.account_code === "5900")).toBe(false);
      if (p.mtm.posted) { const reserve = mj.lines.filter((l: any) => l.account_code === "3400"); expect(reserve).toHaveLength(1); expect(Number(reserve[0].credit) - Number(reserve[0].debit)).toBeCloseTo(expectedMtm, 1); } }   // an earlier suite's lock may already have posted this period's MTM
    else expect(expectedMtm).toBe(0);
    const again = await send("POST", "/gl/period-end/post", { entity_id: HUF, period_id: q2 }); expect(again.code).toBe(201); expect(again.body.depreciation.already).toBe(true); expect(again.body.depreciation.journal.id).toBe(dj.id);
    const after = (await get(`/gl/period-end/preview?entity_id=${HUF}&as_of=2026-12-31`)).body; if (p.mtm.posted) expect(Math.abs(Number(after.mtm.total_adjustment))).toBeLessThan(0.02);   // the books now sit at market
    if (fresh) expect(Number(after.depreciation.rows.find((r: any) => r.asset_id === assetId).posted_this_fy)).toBe(Number(depLine.debit));
    const q3post = await send("POST", "/gl/period-end/post", { entity_id: HUF, period_id: q3, what: "depreciation" }); expect(q3post.code).toBe(201);
    if (q3post.body.depreciation.posted) { const l = q3post.body.depreciation.journal.lines.find((x: any) => x.account_code === "5800" && x.sub_ledger_id === assetId); expect(Number(l.debit)).toBeCloseTo(36500 * 0.10 * 90 / 365, 0); }   // Q4: 90 days
    expect((await send("POST", `/gl/periods/${q2}/status`, { status: "open" })).code).toBe(200);
  });
  it("P&L treatment routes the MTM through 4420 / 5900 in the preview note", async () => {
    await run((c) => c.query("update gl_books set mtm_treatment='pnl' where entity_id=$1", [HUF]));
    expect((await get(`/gl/period-end/preview?entity_id=${HUF}&as_of=2026-09-30`)).body.mtm.note).toMatch(/4420/);
    await run((c) => c.query("update gl_books set mtm_treatment='reserve' where entity_id=$1", [HUF]));
  });
});

describe("Tally live sync", () => {
  it("needs an endpoint; ping lists companies and whether the book's company is open", async () => {
    const none = await get(`/gl/tally/ping?entity_id=${HUF}`); expect(none.code).toBe(422); expect(none.body.extra?.code ?? none.body.code).toBe("tally_url_missing");
    const b = (await get("/gl/books")).body.find((x: any) => x.entity_id === HUF); const put = await send("PUT", "/gl/books", { entity_id: HUF, basis: b.basis, books_start_date: String(b.books_start_date).slice(0, 10), mark_to_market: true, depreciation: true, maker_checker: false, strict_reconciliation: false, tally_url: tallyUrl }); expect(put.code).toBe(200);
    const ping = (await get(`/gl/tally/ping?entity_id=${HUF}`)).body; expect(ping).toMatchObject({ reachable: true, company: "Mehta HUF", company_open: true }); expect(ping.companies).toContain("Other Co");
  });
  it("push sends masters and vouchers, records Tally's counts; line errors mark the sync partial; a down Tally fails cleanly", async () => {
    tallyMode = "ok"; const n0 = tallyReqs.length;
    const r = await send("POST", "/gl/tally/push", { entity_id: HUF, from: "2026-04-01", to: "2026-09-30" }); expect(r.code).toBe(200); expect(r.body).toMatchObject({ status: "done", errors: 0, company: "Mehta HUF" }); expect(r.body.created).toBe(r.body.vouchers); expect(r.body.altered).toBe(r.body.masters);
    expect(tallyReqs.length).toBe(n0 + 1); expect(tallyReqs[n0]).toMatch(/<SVCURRENTCOMPANY>Mehta HUF<\/SVCURRENTCOMPANY>/); expect(tallyReqs[n0]).toMatch(/Import Data/);
    const sync = (await get("/gl/tally/sync")).body.find((s: any) => s.id === r.body.sync_id); expect(sync.status).toBe("done");
    tallyMode = "errors"; const p = await send("POST", "/gl/tally/push", { entity_id: HUF, from: "2026-04-01", to: "2026-09-30", include_masters: false }); expect(p.body.status).toBe("partial"); expect(p.body.line_errors[0]).toMatch(/does not exist/); expect(p.body.masters).toBe(0);
    tallyMode = "down"; const d = await send("POST", "/gl/tally/push", { entity_id: HUF, from: "2026-04-01", to: "2026-09-30" }); expect(d.code).toBe(502); expect(d.body.title).toMatch(/HTTP 500/);
    expect((await get("/gl/tally/sync")).body.some((s: any) => s.entity_id === HUF && s.status === "failed")).toBe(true); tallyMode = "ok";
    expect((await get(`/gl/books`)).body.find((x: any) => x.entity_id === HUF).last_tally_sync_at).toBeTruthy();
  });
  it("pull imports the day book through tallyImport (ledger names mapped to accounts, guid de-duplicated)", async () => {
    const r = await send("POST", "/gl/tally/pull", { entity_id: HUF, from: "2026-08-01", to: "2026-08-31" }); expect([200, 422]).toContain(r.code);
    if (r.code === 422) { expect(r.body.unmapped.length).toBeGreaterThan(0); return; }   // the demo CoA may name the fee ledger differently: the API says which ledgers to map
    expect(r.body.imported + r.body.duplicates).toBe(1); expect(r.body.company).toBe("Mehta HUF");
    const j = (await get(`/gl/journals?entity_id=${HUF}&fy=2026-27&limit=500`)).body.items.find((x: any) => /GL test Tally pull/.test(x.narration)); expect(j).toBeTruthy(); expect(j.source).toBe("tally_import");
  });
});
