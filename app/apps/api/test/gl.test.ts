import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildApp } from "../src/server.js";
import { withFamily } from "../src/lib/db.js";
import { yearEndClose } from "../src/lib/gl.js";

// Posted journals are immutable (db/007), so this suite is delta-based: every assertion compares against state it created
// or against seeded events that post idempotently, and teardown removes only rows that can legally be removed.
const FAMILY = "11111111-1111-1111-1111-111111111111", FY = "2026-27";
const ARJUN = "33333333-0000-0000-0000-000000000001", HUF = "33333333-0000-0000-0000-000000000002";
const ARJUN_USER = "22222222-0000-0000-0000-000000000001";
const HUF_ICICI = "89898989-0000-0000-0000-000000000002";
const RACE_COURSE = "55555555-0000-0000-0000-000000000001"; let RACE_COURSE_SEP = "", RACE_COURSE_TAX = "";   // seeded rows carry generated ids
let app: ReturnType<typeof buildApp>; let owner = "", operator = "", viewer = ""; let startedAt = "";
const h = (t = owner) => ({ authorization: `Bearer ${t}`, "x-family-id": FAMILY });
const get = async (url: string, t = owner) => { const r = await app.inject({ url: `/api/v1${url}`, headers: h(t) }); return { code: r.statusCode, body: r.json() }; };
const send = async (method: "POST" | "PATCH" | "PUT" | "DELETE", url: string, payload: any = {}, t = owner) => { const r = await app.inject({ method, url: `/api/v1${url}`, headers: h(t), payload }); return { code: r.statusCode, body: r.statusCode === 204 ? null : r.json() }; };
const line = (j: any, code: string) => j.lines.find((l: any) => l.account_code === code);
const journalsFor = async (entity: string, sourceType: string) => (await get(`/gl/journals?entity_id=${entity}&fy=${FY}&limit=500`)).body.items.filter((j: any) => j.source_type === sourceType);
let categoryId = "", bankTxnId = "", ruleId = "", recurringId = ""; const RECURRING = `GL test retainer ${Date.now()}`;

beforeAll(async () => {
  app = buildApp(); await app.ready();
  const login = async (email: string) => (await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password: "Prototype!2026" } })).json().access_token;
  owner = await login("arjun@example.com"); operator = await login("ops@example.com"); viewer = await login("ca@example.com");
  startedAt = (await withFamily(FAMILY, (c) => c.query("select now() t"))).rows[0].t.toISOString();
  await withFamily(FAMILY, async (c) => {
    await c.query("update gl_books set maker_checker=false, strict_reconciliation=false where entity_id=$1", [HUF]);
    RACE_COURSE_SEP = (await c.query("select r.id from rent_schedule r join leases l on l.id=r.lease_id where l.property_id=$1 and r.period_month='2026-09-01'", [RACE_COURSE])).rows[0].id;
    RACE_COURSE_TAX = (await c.query("select id from property_taxes where property_id=$1 and amount=482", [RACE_COURSE])).rows[0].id;
  });
});
afterAll(async () => {
  await withFamily(FAMILY, async (c) => {
    if (ruleId) await c.query("delete from gl_posting_rules where id=$1", [ruleId]);
    if (bankTxnId) await c.query("delete from bank_txns where id=$1", [bankTxnId]);
    if (categoryId) await c.query("delete from categories where id=$1", [categoryId]);
    if (recurringId) await c.query("delete from gl_recurring where id=$1", [recurringId]);
    await c.query("delete from gl_unposted where event_type like 'gltest%'");
    await c.query("delete from gl_tally_sync where created_at > $1", [startedAt]);
    await c.query("update gl_periods set status='open', closed_by=null, closed_at=null where entity_id=$1 and fy=$2", [HUF, FY]);
    await c.query("update gl_books set maker_checker=false, strict_reconciliation=false where entity_id=$1", [HUF]);
  });
  await app.close();
});

describe("opening balances and auto-posting (FO-110, FO-113)", () => {
  it("previews a balanced opening from platform data: holdings at lot cost, banks rolled back, deposits held; posts it once", async () => {
    const pv = (await get(`/gl/opening-balances/preview?entity_id=${HUF}&as_of=2026-04-01`)).body;
    expect(pv.debit).toBeCloseTo(pv.credit, 2);
    const expected = await withFamily(FAMILY, async (c) => ({
      holdings: Number((await c.query("select sum(coalesce((select sum(remaining_qty*unit_cost+charges) from lots l where l.holding_id=h.id and remaining_qty > 0 and l.buy_date < '2026-04-01'), case when not exists (select 1 from lots l where l.holding_id=h.id) then h.quantity*h.avg_cost else 0 end)) v from holdings h where h.entity_id=$1 and h.quantity > 0", [HUF])).rows[0].v),
      bank: Number((await c.query("select sum(b.balance - coalesce((select sum(amount) from bank_txns t where t.bank_account_id=b.id and t.txn_date >= '2026-04-01'),0)) v from bank_accounts b where b.entity_id=$1 and b.deleted_at is null and b.type <> 'card'", [HUF])).rows[0].v),
      deposits: Number((await c.query("select coalesce(sum(l.deposit),0) v from leases l join properties p on p.id=l.property_id join property_owners o on o.property_id=p.id where o.entity_id=$1 and l.status='active' and l.start_date < '2026-04-01'", [HUF])).rows[0].v),
    }));
    const sumWhere = (f: (l: any) => boolean, side: "debit" | "credit") => pv.lines.filter(f).reduce((s: number, l: any) => s + Number(l[side] ?? 0), 0);
    expect(sumWhere((l) => l.sub_ledger_type === "holding", "debit")).toBeCloseTo(expected.holdings, 1);
    expect(sumWhere((l) => l.account_code === "1110", "debit") - sumWhere((l) => l.account_code === "1110", "credit")).toBeCloseTo(expected.bank, 1);
    expect(sumWhere((l) => l.account_code === "2230", "credit")).toBeCloseTo(expected.deposits, 1);
    expect(pv.lines.find((l: any) => l.account_code === "3100")).toBeTruthy();
    const put = await send("PUT", "/gl/opening-balances", { entity_id: HUF, as_of: "2026-04-01", generate_from_platform: true });
    expect([200, 409]).toContain(put.code); if (put.code === 200) expect(put.body.status).toBe("posted"); else expect(put.body.title).toMatch(/already posted/);
    const tb = (await get(`/gl/reports/trial-balance?entity_id=${HUF}&fy=${FY}&as_of=2026-04-01`)).body;
    expect(tb.reduce((s: number, r: any) => s + r.debit, 0)).toBeCloseTo(tb.reduce((s: number, r: any) => s + r.credit, 0), 2);
    expect(tb.find((r: any) => r.code === "1110").closing).toBeCloseTo(expected.bank, 1);
  });
  it("auto-posts seeded events by rule: rent accrual with GST, receipt net of TDS clears the receivable, the Axis loss, property tax; a re-run posts nothing", async () => {
    const run = await send("POST", "/gl/unposted", { entity_id: HUF }); expect(run.code).toBe(202); expect(run.body.queued).toBe(0);
    const accrual = (await journalsFor(HUF, "rent_schedule")).find((j: any) => j.source_id === RACE_COURSE_SEP); expect(accrual).toBeTruthy();
    expect(Number(line(accrual, "1410").debit)).toBe(3363); expect(Number(line(accrual, "4100").credit)).toBe(2850); expect(Number(line(accrual, "2240").credit)).toBe(513);
    const receipt = (await journalsFor(HUF, "rent_receipt")).find((j: any) => j.source_id === RACE_COURSE_SEP); expect(receipt).toBeTruthy();
    expect(Number(line(receipt, "1110").debit)).toBe(3078); expect(Number(line(receipt, "1420").debit)).toBe(285); expect(Number(line(receipt, "1410").credit)).toBe(3363);
    expect(line(receipt, "1110").sub_ledger_type).toBe("bank_account");
    const loss = (await journalsFor(HUF, "realized_gain")).find((j: any) => /Axis Small Cap/.test(j.narration)); expect(Number(line(loss, "4400").debit)).toBe(200);
    const tax = (await journalsFor(HUF, "property_tax")).find((j: any) => j.source_id === RACE_COURSE_TAX); expect(Number(line(tax, "5110").debit)).toBe(482);
    // the Kovai NEFT credit is the receipt of that rent, not a second income event
    expect((await journalsFor(HUF, "bank_txn")).some((j: any) => /KOVAI/.test(j.narration))).toBe(false);
    const again = await send("POST", "/gl/unposted", { entity_id: HUF }); expect(again.body.posted).toBe(0); expect(again.body.queued).toBe(0);
  });
  it("an event without a rule waits in the unposted queue until a family override is added, then posts on the next run", async () => {
    await withFamily(FAMILY, async (c) => {
      categoryId = (await c.query("insert into categories (family_id, name, kind) values ($1, 'GLTest Charity', 'outflow') returning id", [FAMILY])).rows[0].id;
      bankTxnId = (await c.query("insert into bank_txns (family_id, bank_account_id, txn_date, narration, amount, category_id, hash, source) values ($1,$2,'2026-09-05','UPI/GLTEST TRUST/DONATION',-1500,$3,$4,'manual') returning id", [FAMILY, HUF_ICICI, categoryId, `gltest-${Date.now()}`])).rows[0].id;
    });
    const run = await send("POST", "/gl/unposted", { entity_id: HUF }); expect(run.body.queued).toBe(1);
    const q = (await get(`/gl/unposted?entity_id=${HUF}`)).body.find((u: any) => u.source_id === bankTxnId);
    expect(q).toMatchObject({ event_type: "bank_txn.gltest_charity", reason: "no_rule", amount: 1500 });
    const periods = (await get(`/gl/periods?entity_id=${HUF}`)).body; const q2 = periods.find((p: any) => p.period_start === "2026-07-01");
    expect(q2.unposted).toBeGreaterThanOrEqual(1);
    expect((await send("POST", `/gl/periods/${q2.id}/status`, { status: "locked" })).code).toBe(409);
    const rule = await send("POST", "/gl/posting-rules", { event_type: "bank_txn.gltest_charity", lines: [{ side: "debit", account_code: "5500", amount: "amount" }, { side: "credit", account_code: "1110", amount: "amount", sub_ledger: "bank" }] });
    expect(rule.code).toBe(201); ruleId = rule.body.id; expect(rule.body.system).toBe(false);
    expect((await get("/gl/posting-rules")).body.filter((r: any) => r.event_type === "bank_txn.gltest_charity").length).toBe(1);
    const rerun = await send("POST", "/gl/unposted", { entity_id: HUF }); expect(rerun.body.posted).toBe(1);
    expect((await get(`/gl/unposted?entity_id=${HUF}`)).body.some((u: any) => u.source_id === bankTxnId)).toBe(false);
    const j = (await journalsFor(HUF, "bank_txn")).find((x: any) => x.source_id === bankTxnId); expect(Number(line(j, "5500").debit)).toBe(1500); expect(line(j, "1110").sub_ledger_id).toBe(HUF_ICICI);
  });
});

describe("journals: reversal, maker-checker, recurring, inter-entity (FO-47, FO-111, FO-112)", () => {
  it("corrects by reversal: mirrored lines, original marked reversed, a second reversal is refused; viewers cannot post", async () => {
    const j = await send("POST", "/gl/journals", { entity_id: HUF, entry_date: "2026-09-05", narration: "GL test — courier", lines: [{ account_code: "5500", debit: 120 }, { account_code: "1110", credit: 120, sub_ledger_type: "bank_account", sub_ledger_id: HUF_ICICI }] }, operator);
    expect(j.code).toBe(201); expect(j.body.status).toBe("posted"); expect(j.body.lines.length).toBe(2);
    const rev = await send("POST", `/gl/journals/${j.body.id}/reverse`, { reason: "posted twice" }, operator);
    expect(rev.code).toBe(201); expect(rev.body.source).toBe("reversal"); expect(rev.body.reverses_journal_id).toBe(j.body.id);
    expect(Number(line(rev.body, "5500").credit)).toBe(120); expect(Number(line(rev.body, "1110").debit)).toBe(120); expect(rev.body.narration).toMatch(/posted twice/);
    expect((await get(`/gl/journals/${j.body.id}`)).body).toMatchObject({ status: "reversed", reversed_by_journal_id: rev.body.id });
    expect((await send("POST", `/gl/journals/${j.body.id}/reverse`, {}, operator)).code).toBe(409);
    expect((await send("POST", "/gl/journals", { entity_id: HUF, entry_date: "2026-09-05", narration: "x", lines: [{ account_code: "5500", debit: 1 }, { account_code: "1110", credit: 1 }] }, viewer)).code).toBe(403);
    expect((await send("POST", "/gl/journals", { entity_id: HUF, entry_date: "2026-09-05", narration: "x", lines: [{ account_code: "5500", debit: 10 }, { account_code: "1110", credit: 9 }] }, operator)).code).toBe(422);
  });
  it("maker-checker: with the flag on, journals land as drafts; the maker cannot approve, a viewer cannot approve, another writer posts it", async () => {
    expect((await send("PUT", "/gl/books", { entity_id: HUF, books_start_date: "2026-04-01", maker_checker: true }, operator)).body.maker_checker).toBe(true);
    const j = await send("POST", "/gl/journals", { entity_id: HUF, entry_date: "2026-09-06", narration: "GL test — stationery", lines: [{ account_code: "5500", debit: 40 }, { account_code: "1110", credit: 40, sub_ledger_type: "bank_account", sub_ledger_id: HUF_ICICI }] }, operator);
    expect(j.body.status).toBe("draft");
    expect((await send("POST", `/gl/journals/${j.body.id}/approve`, {}, operator)).code).toBe(403);
    expect((await send("POST", `/gl/journals/${j.body.id}/approve`, {}, viewer)).code).toBe(403);
    const ok = await send("POST", `/gl/journals/${j.body.id}/approve`, {}); expect(ok.code).toBe(200); expect(ok.body.status).toBe("posted"); expect(ok.body.approved_by).toBe(ARJUN_USER);
    expect((await send("POST", `/gl/journals/${j.body.id}/approve`, {})).code).toBe(409);
    expect((await send("PUT", "/gl/books", { entity_id: HUF, books_start_date: "2026-04-01", maker_checker: false }, operator)).body.maker_checker).toBe(false);
  });
  it("recurring templates post every due occurrence and advance next_run", async () => {
    const r = await send("POST", "/gl/recurring", { entity_id: HUF, name: RECURRING, rrule: "FREQ=MONTHLY;INTERVAL=1", template: [{ account_code: "5700", debit: 100 }, { account_code: "2220", credit: 100 }], next_run: "2026-07-01", narration: "Retainer accrued" });
    expect(r.code).toBe(201); recurringId = r.body.id;
    const run = await send("POST", "/gl/recurring/run", { today: "2026-09-12" }); expect(run.body.posted).toBeGreaterThanOrEqual(3);
    const mine = (await journalsFor(HUF, `recurring:${RECURRING}`)); expect(mine.map((j: any) => j.entry_date).sort()).toEqual(["2026-07-01", "2026-08-01", "2026-09-01"]);
    const row = (await get("/gl/recurring")).body.find((x: any) => x.id === recurringId); expect(row).toMatchObject({ next_run: "2026-10-01", last_run: "2026-09-01" });
    expect((await send("POST", "/gl/recurring/run", { today: "2026-09-12" })).body.posted).toBe(0);
    expect((await send("PATCH", `/gl/recurring/${recurringId}`, { active: false })).body.active).toBe(false);
  });
  it("inter-entity gift and loan post one journal per entity in a group; the consolidated balance sheet eliminates the inter-entity balances", async () => {
    const gift = await send("POST", "/gl/inter-entity", { kind: "gift", from_entity_id: ARJUN, to_entity_id: HUF, amount: 5000, entry_date: "2026-09-06", narration: "GL test gift to HUF" });
    expect(gift.code).toBe(201); expect(gift.body.journals.length).toBe(2); expect(new Set(gift.body.journals.map((j: any) => j.intercompany_group)).size).toBe(1);
    const [giver, receiver] = gift.body.journals; expect(giver.entity_id).toBe(ARJUN); expect(Number(line(giver, "3200").debit)).toBe(5000); expect(receiver.entity_id).toBe(HUF); expect(Number(line(receiver, "3100").credit)).toBe(5000);
    const loan = await send("POST", "/gl/inter-entity", { kind: "loan", from_entity_id: ARJUN, to_entity_id: HUF, amount: 2000, entry_date: "2026-09-07" });
    expect(line(loan.body.journals[0], "1460")).toMatchObject({ sub_ledger_type: "entity", sub_ledger_id: HUF }); expect(line(loan.body.journals[1], "2280")).toMatchObject({ sub_ledger_type: "entity", sub_ledger_id: ARJUN });
    const cons = (await get("/gl/reports/balance-sheet?consolidated=true")).body; expect(cons.consolidated).toBe(true); expect(cons.balances).toBe(true); expect(cons.eliminations).toBeGreaterThanOrEqual(2000);
    expect(cons.sections.find((s: any) => s.title === "Assets").rows.some((r: any) => r.code === "1460")).toBe(false);
    expect((await get("/gl/reports/balance-sheet")).code).toBe(422);
  });
});

describe("statements, reconciliation, close (FO-62, FO-114..119)", () => {
  it("P&L, balance sheet, capital account with partner shares, cash flow and ledger running balances agree with each other", async () => {
    const pl = (await get(`/gl/reports/profit-loss?entity_id=${HUF}&fy=${FY}`)).body;
    const income = pl.sections.find((s: any) => s.title === "Income"), exp = pl.sections.find((s: any) => s.title === "Expenses");
    expect(income.rows.find((r: any) => r.code === "4100").amount).toBeGreaterThanOrEqual(5700); expect(pl.total).toBeCloseTo(income.total - exp.total, 2);
    const bs = (await get(`/gl/reports/balance-sheet?entity_id=${HUF}&fy=${FY}`)).body; expect(bs.balances).toBe(true);
    expect(bs.sections.find((s: any) => s.title === "Capital").rows.find((r: any) => r.name.startsWith("Surplus")).amount).toBeCloseTo(pl.total, 2);
    const cap = (await get(`/gl/reports/capital-account?entity_id=${HUF}&fy=${FY}`)).body;
    expect(cap.partners.map((p: any) => p.share_pct)).toEqual([60, 40]); expect(cap.partners[0].share_of_surplus).toBeCloseTo(pl.total * 0.6, 2);
    const cf = (await get(`/gl/reports/cash-flow?entity_id=${HUF}&fy=${FY}`)).body; expect(cf.sections.map((s: any) => s.title)).toEqual(["Operating", "Investing", "Financing"]); expect(cf.closing_cash).toBeCloseTo(cf.opening_cash + cf.total, 2);
    const accts = (await get(`/gl/accounts?entity_id=${HUF}&fy=${FY}`)).body; const rent = accts.find((a: any) => a.code === "1410");
    const led = (await get(`/gl/reports/ledger?entity_id=${HUF}&account_id=${rent.id}&from=2026-04-01&to=2027-03-31`)).body;
    expect(led.rows.length).toBeGreaterThanOrEqual(4); let bal = led.opening; for (const r of led.rows) { bal = Math.round((bal + r.debit - r.credit) * 100) / 100; expect(r.balance).toBeCloseTo(bal, 2); } expect(led.closing).toBeCloseTo(bal, 2);
    expect(led.closing).toBeCloseTo(rent.balance, 2);
    const sub = (await get(`/gl/reports/ledger?entity_id=${HUF}&sub_ledger_type=bank_account&sub_ledger_id=${HUF_ICICI}&from=2026-04-01&to=2027-03-31`)).body; expect(sub.rows.length).toBeGreaterThan(0);
    expect((await get(`/gl/reports/trial-balance?entity_id=${HUF}&fy=${FY}`, viewer)).code).toBe(200);
  });
  it("the balances materialised view refreshes through the definer function and is only readable behind the tenant filter", async () => {
    await withFamily(FAMILY, (c) => c.query("select refresh_gl_balances()"));   // app_user is not the matview's owner: a bare refresh raises "must be owner of materialized view"
    await expect(withFamily(FAMILY, (c) => c.query("refresh materialized view gl_balances"))).rejects.toThrow(/must be owner/);
    await expect(withFamily(FAMILY, (c) => c.query("select 1 from gl_balances limit 1"))).rejects.toThrow(/permission denied/);
    const rows = await withFamily(FAMILY, async (c) => (await c.query("select family_id::text f, sum(debit) d, sum(credit) cr from gl_balances_family group by 1")).rows);
    expect(rows.length).toBe(1); expect(rows[0].f).toBe(FAMILY); expect(Number(rows[0].d)).toBeCloseTo(Number(rows[0].cr), 2);
  });
  it("ITR mapping shows the five heads from the books beside the tax engine", async () => {
    const m = (await get(`/gl/reports/itr-mapping?entity_id=${HUF}&fy=${FY}`)).body;
    expect(m.map((r: any) => r.tax_head)).toEqual(["salary", "house_property", "business", "capital_gains", "other_sources"]);
    expect(m.find((r: any) => r.tax_head === "house_property").gl_amount).toBeGreaterThan(0);
    expect(m.find((r: any) => r.tax_head === "capital_gains").gl_amount).toBeLessThanOrEqual(0);
  });
  it("reconciles a bank sub-ledger against the statement and holdings against book cost", async () => {
    const b = (await get(`/gl/reconcile/bank?bank_account_id=${HUF_ICICI}&as_of=2026-09-12`)).body;
    expect(b).toMatchObject({ bank_account_id: HUF_ICICI, as_of: "2026-09-12" }); expect(typeof b.ledger_balance).toBe("number"); expect(b.difference).toBeCloseTo(b.statement_balance - b.ledger_balance, 2);
    expect(Array.isArray(b.unmatched_in_statement)).toBe(true); expect(b.unmatched_in_ledger.some((l: any) => /courier|stationery/.test(l.narration))).toBe(true);
    const inv = (await get(`/gl/reconcile/investments?entity_id=${HUF}`)).body;
    expect(inv.rows.length).toBeGreaterThan(0); for (const r of inv.rows) expect(r.difference).toBeCloseTo(r.book_cost - r.holdings_cost, 2);
    expect(inv.rows.find((r: any) => r.holding_id === "46464646-0000-0000-0000-000000000004")).toMatchObject({ holdings_cost: 10000, book_cost: 10000, difference: 0 });   // AIF without lots: quantity × average cost
  });
  it("locks a quarter only when nothing is unposted or draft; posting into it fails; reopening needs an owner and a reason", async () => {
    const periods = (await get(`/gl/periods?entity_id=${HUF}`)).body; expect(periods.filter((p: any) => p.fy === FY).length).toBe(4);
    const q2 = periods.find((p: any) => p.period_start === "2026-07-01"); expect(q2.period_end).toBe("2026-09-30");
    await withFamily(FAMILY, (c) => c.query("insert into gl_unposted (family_id, entity_id, event_type, source_type, source_id, event_date, reason, detail) values ($1,$2,'gltest.blocker','gltest',gen_random_uuid(),'2026-08-15','no_rule','{}')", [FAMILY, HUF]));
    const blocked = await send("POST", `/gl/periods/${q2.id}/status`, { status: "locked" }); expect(blocked.code).toBe(409); expect(blocked.body.title).toMatch(/unposted/);
    expect((await send("POST", "/gl/year-end-close", { entity_id: HUF, fy: FY })).code).toBe(409);
    await withFamily(FAMILY, (c) => c.query("delete from gl_unposted where event_type='gltest.blocker'"));
    const locked = await send("POST", `/gl/periods/${q2.id}/status`, { status: "locked" }, operator); expect(locked.code).toBe(200); expect(locked.body.status).toBe("locked");
    const inLocked = await send("POST", "/gl/journals", { entity_id: HUF, entry_date: "2026-08-20", narration: "x", lines: [{ account_code: "5500", debit: 5 }, { account_code: "1110", credit: 5 }] }, operator); expect(inLocked.code).toBe(409); expect(inLocked.body.title).toMatch(/locked/);
    expect((await send("POST", `/gl/periods/${q2.id}/status`, { status: "open", reason: "late invoice" }, operator)).code).toBe(403);
    expect((await send("POST", `/gl/periods/${q2.id}/status`, { status: "open" })).code).toBe(422);
    expect((await send("POST", `/gl/periods/${q2.id}/status`, { status: "open", reason: "late invoice" })).body.status).toBe("open");
    expect((await send("POST", `/gl/periods/${q2.id}/status`, { status: "soft_closed" }, operator)).body.status).toBe("soft_closed");
    expect((await send("POST", `/gl/periods/${q2.id}/status`, { status: "open", reason: "test" }, operator)).body.status).toBe("open");
  });
  it("year-end close moves the surplus to partner capital 60/40, locks the year and opens the next (checked inside a rolled-back transaction)", async () => {
    let out: any = null;
    await withFamily(FAMILY, async (c) => { out = await yearEndClose(c, FAMILY, HUF, FY, ARJUN_USER); throw new Error("rollback"); }).catch((e) => { if (e.message !== "rollback") throw e; });
    const pl = (await get(`/gl/reports/profit-loss?entity_id=${HUF}&fy=${FY}`)).body;
    expect(out.surplus).toBeCloseTo(pl.total, 2); expect(out.next_fy).toBe("2027-28");
    expect(out.partners.map((p: any) => [p.partner, p.share_pct])).toEqual([["Arjun Mehta (karta)", 60], ["Priya Mehta", 40]]);
    const partnerLines = out.journal.lines.filter((l: any) => l.sub_ledger_type === "partner"); expect(partnerLines.length).toBe(2);
    expect(partnerLines.reduce((s: number, l: any) => s + l.credit - l.debit, 0)).toBeCloseTo(out.surplus, 2);
    expect(Math.abs(partnerLines[0].credit - partnerLines[0].debit)).toBeCloseTo(Math.abs(out.surplus) * 0.6, 1);
    expect(out.journal.lines.filter((l: any) => l.account_code === "4100").every((l: any) => l.debit > 0)).toBe(true);
    // nothing persisted: periods still open, no closing journal
    expect((await get(`/gl/periods?entity_id=${HUF}`)).body.filter((p: any) => p.fy === FY).every((p: any) => p.status === "open")).toBe(true);
    expect((await journalsFor(HUF, "closing")).length).toBe(0);
  });
  it("exports Tally XML vouchers and imports a day book once, refusing unmapped ledgers", async () => {
    const ex = await send("POST", "/gl/tally/export", { entity_id: HUF, from: "2026-04-01", to: "2026-09-30" }); expect(ex.code).toBe(202); expect(ex.body.vouchers).toBeGreaterThan(5);
    const x = await app.inject({ url: ex.body.url, headers: h() }); expect(x.statusCode).toBe(200); expect(x.headers["content-type"]).toMatch(/xml/); expect(x.body).toContain("<ENVELOPE>"); expect(x.body).toContain("VCHTYPE=\"Receipt\"");
    const accts = (await get(`/gl/accounts?entity_id=${HUF}`)).body; const name = (code: string) => accts.find((a: any) => a.code === code).name;
    const guid = `gltest-${Date.now()}`;
    const xml = (ledger: string) => `<ENVELOPE><BODY><IMPORTDATA><REQUESTDATA><TALLYMESSAGE><VOUCHER VCHTYPE="Payment" ACTION="Create"><DATE>20260907</DATE><GUID>${guid}</GUID><NARRATION>Tally test voucher</NARRATION><ALLLEDGERENTRIES.LIST><LEDGERNAME>${ledger}</LEDGERNAME><AMOUNT>-250</AMOUNT></ALLLEDGERENTRIES.LIST><ALLLEDGERENTRIES.LIST><LEDGERNAME>${name("1110")}</LEDGERNAME><AMOUNT>250</AMOUNT></ALLLEDGERENTRIES.LIST></VOUCHER></TALLYMESSAGE></REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>`;
    const bad = await send("POST", "/gl/tally/import", { entity_id: HUF, xml: xml("Petty Cash Ledger That Does Not Exist") }); expect(bad.code).toBe(422); expect(bad.body.unmapped).toEqual(["Petty Cash Ledger That Does Not Exist"]);
    const mapped = await send("POST", "/gl/tally/import", { entity_id: HUF, xml: xml("Petty Cash Ledger That Does Not Exist"), mapping: { "Petty Cash Ledger That Does Not Exist": "5500" } }); expect(mapped.code).toBe(202); expect(mapped.body.imported).toBe(1);
    const j = (await journalsFor(HUF, "tally_voucher")).find((x: any) => x.tally_voucher_guid === guid); expect(Number(line(j, "5500").debit)).toBe(250); expect(Number(line(j, "1110").credit)).toBe(250);
    const dup = await send("POST", "/gl/tally/import", { entity_id: HUF, xml: xml(name("5500")) }); expect(dup.body.duplicates).toBe(1); expect(dup.body.imported).toBe(0);
    expect((await get("/gl/tally/sync")).body.filter((s: any) => s.direction === "import").length).toBeGreaterThanOrEqual(2);
    expect((await send("POST", "/gl/tally/import", { entity_id: HUF, xml: xml(name("5500")) }, viewer)).code).toBe(403);
  });
});
