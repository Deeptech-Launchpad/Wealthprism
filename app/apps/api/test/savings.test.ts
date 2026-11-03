import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildApp } from "../src/server.js";
import { pool, withFamily } from "../src/lib/db.js";
import { yearInterest, maturityOf, fyStart } from "../src/lib/savings.js";
import { generateTasksFor } from "../src/jobs/tasks.js";

// Government savings round 2: PPF and SSY. The interest rule, the limit, the balance, net worth, the passbook, the bank-statement matching.
const FAMILY = "11111111-1111-1111-1111-111111111111";
let app: ReturnType<typeof buildApp>; let owner = "", viewer = ""; let entity = "";
const h = (t = owner) => ({ authorization: `Bearer ${t}`, "x-family-id": FAMILY });
const call = async (method: string, url: string, payload?: any, t = owner) => { const r = await app.inject({ method: method as any, url: `/api/v1${url}`, headers: h(t), payload }); return { code: r.statusCode, body: r.body ? r.json() : null }; };
const get = (u: string, t = owner) => call("GET", u, undefined, t); const post = (u: string, p: any, t = owner) => call("POST", u, p, t);
const TODAY = new Date().toISOString().slice(0, 10); const FY = fyStart(TODAY);
const INST = "ZZ Savings Post Office"; const EMP = "ZZ Savings Employer"; const WD = "ZZ Savings Withdraw";

beforeAll(async () => {
  app = buildApp(); await app.ready();
  const login = async (email: string) => (await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password: "Prototype!2026" } })).json().access_token;
  owner = await login("arjun@example.com"); viewer = await login("ca@example.com"); entity = (await get("/entities")).body[0].id;
});
afterAll(async () => {
  await withFamily(FAMILY, async (c) => {
    await c.query("delete from tasks where title like '%ZZ-PPF%' or title like '%ZZ Savings%'");
    await c.query("delete from bank_txns where narration like 'ZZSAV%'");
    await c.query("delete from savings_accounts where institution in ($1,$2,$3)", [INST, EMP, WD]);
  });
  await app.close(); await pool.end();
});

describe("the interest rule", () => {
  it("a month earns on the lowest balance between the 5th and the month end; money after the 5th counts from the next month", () => {
    expect(yearInterest(2026, 0, [{ date: "2026-04-01", amount: 100000 }], 7.1)).toBeCloseTo(7100, 0);   // in on 1 April: all 12 months
    expect(yearInterest(2026, 0, [{ date: "2026-04-06", amount: 100000 }], 7.1)).toBeCloseTo(7100 * 11 / 12, 0);   // on 6 April it misses April
    expect(yearInterest(2027, 200000, [], 8)).toBeCloseTo(16000, 0);   // a balance carried in earns all year
    expect(yearInterest(2026, 0, [{ date: "2026-10-01", amount: 120000 }], 6, "2026-10-01")).toBeCloseTo(120000 * 0.06 * 6 / 12, 0);   // tracking from October
  });
  it("PPF matures 15 years after the end of the year it was opened in; SSY 21 years after opening", () => {
    expect(maturityOf("ppf", "2026-04-27")).toBe("2042-03-31"); expect(maturityOf("ppf", "2027-02-10")).toBe("2042-03-31");
    expect(maturityOf("ssy", "2026-04-27")).toBe("2047-04-27");
  });
});

describe("PPF and SSY accounts", () => {
  it("opens, takes deposits up to the year's limit, estimates the year's interest and values the balance in net worth", async () => {
    const open = `${FY - 2}-06-10`; const assets0 = Number((await get("/net-worth")).body.assets);
    const a = await post("/savings-accounts", { entity_id: entity, scheme: "ppf", institution: INST, account_no: "ZZ-PPF-1", opened_on: open, rate_pct: 7.1, opening_balance: 200000, tracked_from: `${FY - 1}-04-01` });
    expect(a.code).toBe(201); const id = a.body.id; expect(a.body.matures_on).toBe(`${FY - 2 + 16}-03-31`);
    const last = a.body.years.find((y: any) => y.label.startsWith(String(FY - 1)));   // last year ended: 200000 held all year at 7.1% = 14200, credited as an estimate
    expect(last.interest).toBeCloseTo(14200, 0); expect(last.ended).toBe(true); expect(last.confirmed).toBe(false);
    expect(a.body.balance).toBeCloseTo(214200, 0);
    const d = await post(`/savings-accounts/${id}/deposits`, { amount: 50000, entry_date: `${FY}-04-02` }); expect(d.code).toBe(201); expect(d.body.fy_deposited).toBe(50000); expect(d.body.balance).toBeCloseTo(214200 + 50000, 0);
    expect((await post(`/savings-accounts/${id}/deposits`, { amount: 100001, entry_date: `${FY}-04-03` })).code).toBe(422);   // over the 1.5 lakh limit
    expect((await post(`/savings-accounts/${id}/deposits`, { amount: 100, entry_date: `${FY}-04-03` })).code).toBe(422);   // under ₹500
    expect((await post(`/savings-accounts/${id}/deposits`, { amount: 1000, entry_date: "2099-01-01" })).code).toBe(422);
    expect((await post(`/savings-accounts/${id}/deposits`, { amount: 1000, entry_date: `${FY - 3}-01-01` })).code).toBe(422);   // before tracking
    expect((await post(`/savings-accounts/${id}/deposits`, { amount: 1000, entry_date: `${FY}-04-03` }, viewer)).code).toBe(403);
    expect(Number((await get("/net-worth")).body.assets)).toBeCloseTo(assets0 + 264200, -1);   // net worth counts the balance: 200000 + last year's 14200 + the 50000 just put in
  });
  it("the passbook confirms the interest and the balance; a changed rate rebuilds the estimate; the entry list is kept clean", async () => {
    const id = (await get("/savings-accounts")).body.find((a: any) => a.institution === INST).id;
    const acct = (await get(`/savings-accounts/${id}`)).body; const intr = acct.entries.find((e: any) => e.kind === "interest" && e.status === "credited");
    const c = await post(`/savings-entries/${intr.id}/confirm`, { amount: 14000 }); expect(c.code).toBe(200); expect(c.body.years.find((y: any) => y.confirmed).interest).toBe(14000);
    const p = await call("PATCH", `/savings-accounts/${id}`, { rate_pct: 8 }); expect(p.code).toBe(200); expect(p.body.years.find((y: any) => y.confirmed).interest).toBe(14000);   // the passbook figure stays
    const b = await post(`/savings-accounts/${id}/balance`, { balance: 300000 }); expect(b.code).toBe(200); expect(b.body.balance).toBe(300000);
    const dep = b.body.entries.find((e: any) => e.kind === "deposit"); expect((await call("DELETE", `/savings-entries/${dep.id}`)).code).toBe(200);
    expect((await call("DELETE", `/savings-entries/${intr.id}`)).code).toBe(409);   // interest follows the rule, it is not deleted
  });
  it("a Sukanya account needs the girl's age and stops taking deposits after 15 years", async () => {
    expect((await post("/savings-accounts", { entity_id: entity, scheme: "ssy", institution: INST, opened_on: `${FY - 12}-05-01`, rate_pct: 8.2 })).code).toBe(422);   // no date of birth
    expect((await post("/savings-accounts", { entity_id: entity, scheme: "ssy", institution: INST, opened_on: `${FY - 1}-05-01`, rate_pct: 8.2, holder_dob: `${FY - 14}-01-01` })).code).toBe(422);   // already past 10
    const s = await post("/savings-accounts", { entity_id: entity, scheme: "ssy", institution: INST, holder_name: "ZZ Savings Child", holder_dob: `${FY - 6}-01-01`, opened_on: `${FY - 5}-05-01`, rate_pct: 8.2 });
    expect(s.code).toBe(201); expect(s.body.matures_on).toBe(`${FY - 5 + 21}-05-01`); expect(s.body.deposits_until).toBe(`${FY - 5 + 15}-05-01`);
    expect((await post(`/savings-accounts/${s.body.id}/deposits`, { amount: 250, entry_date: TODAY })).code).toBe(201);   // SSY allows ₹250
  });
  it("bank statements: a PPF debit verifies a deposit entered by hand, and a lone one is added", async () => {
    const id = (await get("/savings-accounts")).body.find((a: any) => a.scheme === "ppf" && a.institution === INST).id;
    const bank = (await get("/bank-accounts")).body.find((a: any) => a.entity_id === entity && a.type !== "card");
    await post(`/savings-accounts/${id}/deposits`, { amount: 12345, entry_date: TODAY });
    await withFamily(FAMILY, async (c) => {
      await c.query("insert into bank_txns (family_id, bank_account_id, txn_date, narration, amount, hash, source) values ($1,$2,$3,'ZZSAV PPF DEPOSIT SBI 123',-12345,'zzsav1','csv')", [FAMILY, bank.id, TODAY]);
      await c.query("insert into bank_txns (family_id, bank_account_id, txn_date, narration, amount, hash, source) values ($1,$2,$3,'ZZSAV PUBLIC PROVIDENT FUND',-4000,'zzsav2','csv')", [FAMILY, bank.id, TODAY]);
    });
    const r = await post("/savings-accounts/reconcile", {}); expect(r.code).toBe(200); expect(r.body.matched).toBe(1); expect(r.body.added).toBe(1);
    const e = (await get(`/savings-accounts/${id}`)).body.entries.filter((x: any) => x.kind === "deposit");
    expect(e.find((x: any) => x.amount === 12345).bank_txn_ref).toBeTruthy(); expect(e.find((x: any) => x.amount === 4000).bank_txn_ref).toBeTruthy();
    expect((await call("DELETE", `/savings-entries/${e.find((x: any) => x.amount === 12345).id}`)).code).toBe(409);   // a statement line matches it
  });
  it("a task reminds of the unused limit in February and March", async () => {
    const d = new Date(Date.UTC(FY + 1, 1, 10)).toISOString().slice(0, 10);   // 10 February
    await withFamily(FAMILY, (c) => generateTasksFor(c, FAMILY, d, { notify: false }));
    expect((await get("/tasks?status=open&module=investments")).body.find((x: any) => /of this year's limit is unused: PPF ZZ-PPF-1/.test(x.title))).toBeTruthy();
  });
});

describe("EPF", () => {
  it("interest runs on the balance each month opened with; a contribution made in a month earns from the next", () => {
    // 1,00,000 on 1 April, 6,000 added at each month end: the months open at 1,00,000 + 6,000 x 0..11
    const flows = [{ date: "2026-04-01", amount: 100000 }, ...Array.from({ length: 12 }, (_, i) => ({ date: new Date(Date.UTC(2026, 4 + i, 0)).toISOString().slice(0, 10), amount: 6000 }))];
    expect(yearInterest(2026, 0, flows, 8.25, "2026-04-01", 1)).toBeCloseTo((12 * 100000 + 6000 * 66) * 0.0825 / 12, 0);
  });
  it("adds the monthly contributions by itself, earns interest, shows the balance in net worth, and refuses a hand-removal of an automatic entry", async () => {
    const assets0 = Number((await get("/net-worth")).body.assets);
    const a = await post("/savings-accounts", { entity_id: entity, scheme: "epf", institution: EMP, account_no: "ZZEPF1", opened_on: `${FY - 3}-06-01`, rate_pct: 8.25, opening_balance: 100000, tracked_from: `${FY - 1}-04-01`, employee_monthly: 3000, employer_monthly: 3000 });
    expect(a.code).toBe(201); const id = a.body.id; expect(a.body.matures_on).toBeNull(); expect(a.body.fy_limit).toBeNull(); expect(a.body.fy_limit_left).toBeNull();
    const auto = a.body.entries.filter((e: any) => e.auto); const last = a.body.years.find((y: any) => y.label.startsWith(String(FY - 1)));
    expect(auto.filter((e: any) => e.entry_date <= `${FY}-03-31`).length).toBe(12); expect(auto.every((e: any) => e.amount === 6000)).toBe(true);
    expect(last.interest).toBeCloseTo((12 * 100000 + 6000 * 66) * 0.0825 / 12, 0); expect(last.deposited).toBe(72000);
    const thisYear = auto.filter((e: any) => e.entry_date >= `${FY}-04-01`).length;
    expect(a.body.balance).toBeCloseTo(100000 + 72000 + last.interest + 6000 * thisYear, 0);
    expect(Number((await get("/net-worth")).body.assets)).toBeCloseTo(assets0 + a.body.balance, -1);
    expect((await call("DELETE", `/savings-entries/${auto[0].id}`)).code).toBe(409);
    // a second read does not add the months again
    expect((await get(`/savings-accounts/${id}`)).body.entries.filter((e: any) => e.auto).length).toBe(auto.length);
  });
  it("has no yearly limit, takes an extra contribution, and a new monthly amount applies from the next month; the passbook sets the balance", async () => {
    const id = (await get("/savings-accounts")).body.find((a: any) => a.institution === EMP).id;
    const d = await post(`/savings-accounts/${id}/deposits`, { amount: 250000, entry_date: TODAY }); expect(d.code).toBe(201);   // a voluntary top-up far above 1.5 lakh
    const before = (await get(`/savings-accounts/${id}`)).body.entries.filter((e: any) => e.auto).length;
    const p = await call("PATCH", `/savings-accounts/${id}`, { employee_monthly: 4000, employer_monthly: 4000 }); expect(p.code).toBe(200); expect(p.body.employee_monthly).toBe(4000);
    expect(p.body.entries.filter((e: any) => e.auto).length).toBe(before);   // months already added keep their amount
    expect((await post("/savings-accounts", { entity_id: entity, scheme: "ppf", institution: INST, opened_on: `${FY}-04-01`, rate_pct: 7.1, employee_monthly: 100 })).code).toBe(422);   // monthly amounts are for EPF only
    expect((await post(`/savings-accounts/${id}/balance`, { balance: 500000 })).body.balance).toBe(500000);
    expect((await post(`/savings-accounts/${id}/deposits`, { amount: 100, entry_date: TODAY }, viewer)).code).toBe(403);
  });
  it("a task does not remind an EPF account of the PPF limit", async () => {
    const d = new Date(Date.UTC(FY + 1, 1, 10)).toISOString().slice(0, 10);
    await withFamily(FAMILY, (c) => generateTasksFor(c, FAMILY, d, { notify: false }));
    expect((await get("/tasks?status=open&module=investments")).body.find((x: any) => /unused: EPF/.test(x.title))).toBeFalsy();
  });
});

describe("PPF and SSY withdrawals", () => {
  let id = "";
  it("a PPF past its 7th financial year may take half of last year's closing balance, once a year", async () => {
    const a = await post("/savings-accounts", { entity_id: entity, scheme: "ppf", institution: WD, account_no: "ZZ-WD-1", opened_on: `${FY - 8}-04-10`, rate_pct: 7.1, opening_balance: 500000, tracked_from: `${FY - 1}-04-01` });
    expect(a.code).toBe(201); id = a.body.id; const bal0 = a.body.balance;
    const r = (await get(`/savings-accounts/${id}/withdraw-rules`)).body;
    expect(r.part.allowed).toBe(true); expect(r.part.max).toBeCloseTo((500000 + 35500) * 0.5, -1);   // last year's balance 5,00,000 + 35,500 interest, half of it
    expect(r.close.allowed).toBe(true); expect(r.close.needs_reason).toBe(true);
    expect((await post(`/savings-accounts/${id}/withdraw`, { kind: "part", amount: 300000, date: TODAY })).code).toBe(422);   // over the limit: refused, an owner could override
    expect((await post(`/savings-accounts/${id}/withdraw`, { kind: "part", amount: 1000, date: TODAY }, viewer)).code).toBe(403);
    const w = await post(`/savings-accounts/${id}/withdraw`, { kind: "part", amount: 100000, date: TODAY }); expect(w.code).toBe(201);
    expect(w.body.withdrawn_total).toBe(100000); expect(w.body.balance).toBeCloseTo(bal0 - 100000, 0);
    const again = await post(`/savings-accounts/${id}/withdraw`, { kind: "part", amount: 1000, date: TODAY }); expect(again.code).toBe(422); expect(again.body.title).toMatch(/one part withdrawal/i);
    expect((await post(`/savings-accounts/${id}/withdraw`, { kind: "part", amount: 1000, date: TODAY, override: true, override_reason: "short" })).code).toBe(422);
    expect((await post(`/savings-accounts/${id}/withdraw`, { kind: "part", amount: 1000, date: TODAY, override: true, override_reason: "The post office approved it in writing" })).code).toBe(201);
  });
  it("a withdrawal lowers the interest from its month; taking it back restores the balance", async () => {
    const acct = (await get(`/savings-accounts/${id}`)).body; const cur = acct.years.find((y: any) => !y.ended); expect(cur.withdrawn).toBe(101000);
    const w = acct.entries.filter((e: any) => e.kind === "withdrawal");
    for (const e of w) expect((await call("DELETE", `/savings-entries/${e.id}`)).code).toBe(200);
    const back = (await get(`/savings-accounts/${id}`)).body; expect(back.withdrawn_total).toBe(0); expect(back.years.find((y: any) => !y.ended).interest).toBeGreaterThan(cur.interest);
  });
  it("closing is refused before the rule allows it, an owner can record it with a reason, and the account leaves net worth and can be reopened", async () => {
    const young = await post("/savings-accounts", { entity_id: entity, scheme: "ppf", institution: WD, account_no: "ZZ-WD-2", opened_on: `${FY - 1}-05-01`, rate_pct: 7.1, opening_balance: 100000 });
    const yid = young.body.id; const r = (await get(`/savings-accounts/${yid}/withdraw-rules`)).body;
    expect(r.close.allowed).toBe(false); expect(r.close.opens_on).toBe(`${FY + 5}-04-01`); expect(r.part.allowed).toBe(false);
    expect((await post(`/savings-accounts/${yid}/withdraw`, { kind: "close", amount: 100000, date: TODAY })).code).toBe(422);
    const nw0 = Number((await get("/net-worth")).body.assets);
    const c = await post(`/savings-accounts/${yid}/withdraw`, { kind: "close", amount: 98000, date: TODAY, reason: "Serious illness of the holder, spouse or children", override: true, override_reason: "Medical closure approved by the post office" });
    expect(c.code).toBe(201); expect(c.body.status).toBe("closed"); expect(c.body.balance).toBe(0); expect(c.body.closed_on).toBe(TODAY);
    expect(Number((await get("/net-worth")).body.assets)).toBeLessThan(nw0 - 90000);
    expect((await post(`/savings-accounts/${yid}/deposits`, { amount: 1000, entry_date: TODAY })).code).toBe(409);
    const close = c.body.entries.find((e: any) => e.closes); expect((await call("DELETE", `/savings-entries/${close.id}`)).code).toBe(200);
    expect((await get(`/savings-accounts/${yid}`)).body.status).toBe("active");
  });
  it("a Sukanya account opens its part withdrawal when the girl turns 18", async () => {
    const s = await post("/savings-accounts", { entity_id: entity, scheme: "ssy", institution: WD, holder_name: "ZZ Girl", holder_dob: `${FY - 6}-01-01`, opened_on: `${FY - 5}-05-01`, rate_pct: 8.2, opening_balance: 200000 });
    const r = (await get(`/savings-accounts/${s.body.id}/withdraw-rules`)).body;
    expect(r.part.allowed).toBe(false); expect(r.part.opens_on).toBe(`${FY - 6 + 18}-01-01`); expect(r.close.allowed).toBe(false);
    expect((await get(`/savings-accounts/${s.body.id}/withdraw-rules?date=${FY - 6 + 18}-02-01`)).body.part.allowed).toBe(true);
  });
});
