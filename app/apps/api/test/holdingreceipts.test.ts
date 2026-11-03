import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildApp } from "../src/server.js";
import { pool, withFamily } from "../src/lib/db.js";
import { receiptSchedule, addMonths, reconcileHoldingReceipts, syncHoldingReceipts } from "../src/lib/holdingreceipts.js";
import { generateTasksFor } from "../src/jobs/tasks.js";

// Bond interest and maturity payments: the schedule maths, the rows created when a bond is added, receiving them (balance, income, redemption), the quantity
// changing the amounts, the tasks, and matching a bank-statement credit. Dates are relative to today; every row it creates is removed afterwards.
const FAMILY = "11111111-1111-1111-1111-111111111111";
const day = (offset: number) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);

describe("receipt schedule (pure)", () => {
  it("coupon dates run back from maturity in whole periods and keep the day, clamped to short months", () => {
    expect(addMonths("2030-03-31", -3)).toBe("2029-12-31"); expect(addMonths("2030-03-31", -6)).toBe("2029-09-30"); expect(addMonths("2030-03-31", -12)).toBe("2029-03-31");
    const s = receiptSchedule({ type: "bond", quantity: 100, totalCost: 100000, faceValue: 1000, couponPct: 9, frequency: "quarterly", maturityDate: "2030-03-31", from: "2029-10-15" });
    expect(s.map((r) => `${r.kind}:${r.due}:${r.amount}`)).toEqual(["interest:2029-12-31:2250", "interest:2030-03-31:2250", "maturity:2030-03-31:100000"]);
  });
  it("yearly, half-yearly, cumulative, T-bill and SGB", () => {
    expect(receiptSchedule({ type: "bond", quantity: 10, totalCost: 10000, faceValue: 1000, couponPct: 8, frequency: "yearly", maturityDate: "2028-06-30", from: "2026-06-30" }).filter((r) => r.kind === "interest").map((r) => r.amount)).toEqual([800, 800]);
    expect(receiptSchedule({ type: "gsec", quantity: 100, totalCost: 10000, faceValue: 100, couponPct: 7, frequency: "half_yearly", maturityDate: "2027-12-31", from: "2027-01-01" }).filter((r) => r.kind === "interest").map((r) => r.amount)).toEqual([350, 350]);
    const cum = receiptSchedule({ type: "bond", quantity: 10, totalCost: 10000, faceValue: 1000, couponPct: 10, frequency: "at_maturity", maturityDate: "2028-01-01", from: "2026-01-01" });
    expect(cum.filter((r) => r.kind === "interest").length).toBe(1); expect(cum[0].amount).toBeGreaterThan(1990); expect(cum[0].amount).toBeLessThan(2010);
    expect(receiptSchedule({ type: "tbill", quantity: 100, totalCost: 9700, faceValue: 100, couponPct: 0, maturityDate: "2027-01-01", from: "2026-07-01" })).toEqual([{ kind: "maturity", due: "2027-01-01", amount: 10000 }]);
    const sgb = receiptSchedule({ type: "sgb", quantity: 10, totalCost: 60000, couponPct: 2.5, maturityDate: "2030-06-30", from: "2029-12-31" });
    expect(sgb[0]).toEqual({ kind: "interest", due: "2030-06-30", amount: 750 });   // half a year of 2.5% on the 60,000 paid
  });
});

let app: ReturnType<typeof buildApp>; let owner = "", viewer = ""; let entity = ""; let acct = ""; let startBal = 0; const started = new Date();
const h = (t = owner) => ({ authorization: `Bearer ${t}`, "x-family-id": FAMILY });
const get = async (url: string, t = owner) => { const r = await app.inject({ url: `/api/v1${url}`, headers: h(t) }); return { code: r.statusCode, body: r.json() }; };
const post = async (url: string, payload: any, t = owner) => { const r = await app.inject({ method: "POST", url: `/api/v1${url}`, headers: h(t), payload }); return { code: r.statusCode, body: r.body ? r.json() : null }; };
const addBond = (name: string, o: any = {}) => post("/assets/market", { type_code: "bond", entity_id: entity, txn_date: day(-30), quantity: 100, price: 1000, instrument: { name }, extras: { coupon_pct: 9, face_value: 1000, coupon_frequency: "quarterly", maturity_date: day(400), ...(o.extras ?? {}) }, ...o.body });

beforeAll(async () => {
  app = buildApp(); await app.ready();
  const login = async (email: string) => (await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password: "Prototype!2026" } })).json().access_token;
  owner = await login("arjun@example.com"); viewer = await login("ca@example.com");
  entity = (await get("/entities")).body[0].id;
  const ba = (await get("/bank-accounts")).body.find((b: any) => b.entity_id === entity && b.type !== "card"); acct = ba.id; startBal = Number(ba.balance);
});
afterAll(async () => {
  let ids: string[] = [];
  await withFamily(FAMILY, async (c) => {
    ids = (await c.query("select id from instruments where name like 'ZZ Rcpt %'")).rows.map((r: any) => r.id);
    if (ids.length) {
      await c.query("delete from tasks where source_type='holding_receipt' and source_id in (select id from holding_receipts where instrument_id = any($1))", [ids]);
      await c.query("update bank_txns set link_type='none', link_id=null where link_id in (select id from holding_receipts where instrument_id = any($1))", [ids]);
      await c.query("delete from realized_gains where instrument_id = any($1)", [ids]).catch(() => null);
      await c.query("delete from lots where holding_id in (select id from holdings where instrument_id = any($1))", [ids]);
      await c.query("delete from investment_txns where instrument_id = any($1)", [ids]);
      await c.query("delete from holdings where instrument_id = any($1)", [ids]);   // holding_receipts go with them
    }
    await c.query("delete from tasks where title like '%ZZ Rcpt%'");   // includes the generic No-nominee tasks the succession check raises for any new holding
    await c.query("delete from bank_txns where hash like 'zzrcpt-%'");
    await c.query("update bank_accounts set balance=$2 where id=$1", [acct, startBal]);
    await c.query("delete from accounts where provider='manual' and identifier_masked='MANUAL' and created_at >= $1", [started]).catch(() => null);
  });
  if (ids.length) { await pool.query("delete from prices where instrument_id = any($1)", [ids]).catch(() => null); await pool.query("delete from instruments where id = any($1)", [ids]).catch(() => null); }
  await app.close();
});

describe("bond payments", () => {
  let bondHolding = ""; let first: any;
  it("adding a bond lays out its coupons and its maturity, sized by what is held", async () => {
    const r = await addBond("ZZ Rcpt Demo NCD 9%"); expect(r.code).toBe(201); expect(r.body.scheduled).toBeGreaterThanOrEqual(5); bondHolding = r.body.holding.id;
    const list = (await get("/holding-receipts")).body.filter((x: any) => x.holding_id === bondHolding);
    expect(list.filter((x: any) => x.kind === "maturity").length).toBe(1); expect(Number(list.find((x: any) => x.kind === "maturity").expected_amount)).toBe(100000);
    first = list.filter((x: any) => x.kind === "interest").sort((a: any, b: any) => a.due_date.localeCompare(b.due_date))[0]; expect(Number(first.expected_amount)).toBe(2250);
    expect(first.status).toBe("expected");
  });

  it("buying more units re-sizes the open payments", async () => {
    await addBond("ZZ Rcpt Demo NCD 9%", { body: { quantity: 50, txn_date: day(-29) } });
    const list = (await get("/holding-receipts")).body.filter((x: any) => x.holding_id === bondHolding);
    expect(Number(list.find((x: any) => x.id === first.id).expected_amount)).toBe(3375); expect(Number(list.find((x: any) => x.kind === "maturity").expected_amount)).toBe(150000);
  });

  it("receiving an interest payment: marked received, bank balance up, an income entry on the security; a second time is refused", async () => {
    const r = await post(`/holding-receipts/${first.id}/receive`, { amount: 3375, bank_account_id: acct });
    expect(r.code).toBe(200); expect(r.body.status).toBe("received"); expect(r.body.balance_note).toMatch(/bank balance/i);
    const bal = Number((await get("/bank-accounts")).body.find((b: any) => b.id === acct).balance); expect(bal).toBeCloseTo(startBal + 3375, 0);
    const inc = (await withFamily(FAMILY, (c) => c.query("select amount from investment_txns where type='interest' and hash=$1", [`holdrcpt:${first.id}`]))).rows;
    expect(inc.length).toBe(1); expect(Number(inc[0].amount)).toBe(3375);
    expect((await post(`/holding-receipts/${first.id}/receive`, { amount: 3375 })).code).toBe(409);
  });

  it("interest net of 10% TDS counts as received; a short amount stays partial", async () => {
    const open = (await get("/holding-receipts")).body.filter((x: any) => x.holding_id === bondHolding && x.kind === "interest").sort((a: any, b: any) => a.due_date.localeCompare(b.due_date));
    expect((await post(`/holding-receipts/${open[0].id}/receive`, { amount: 3375 * 0.9 })).body.status).toBe("received");
    expect((await post(`/holding-receipts/${open[1].id}/receive`, { amount: 1000 })).body.status).toBe("partial");
  });

  it("a bond maturing soon: a task is raised; receiving the maturity redeems the units and closes the holding", async () => {
    const r = await addBond("ZZ Rcpt Soon NCD", { extras: { maturity_date: day(10) }, body: { txn_date: day(-340), quantity: 10, price: 990 } }); expect(r.code).toBe(201);
    const g = await withFamily(FAMILY, (c) => generateTasksFor(c, FAMILY, day(0), { notify: false })); expect(g.byGenerator.holding_receipt_due).toBeGreaterThanOrEqual(1);
    expect((await get("/tasks?status=open&module=investments")).body.some((t: any) => /^Matures in \d+ d: ZZ Rcpt Soon NCD/.test(t.title))).toBe(true);
    const mat = (await get("/holding-receipts")).body.find((x: any) => x.holding_id === r.body.holding.id && x.kind === "maturity");
    const rec = await post(`/holding-receipts/${mat.id}/receive`, { amount: 10000 }); expect(rec.code).toBe(200); expect(rec.body.status).toBe("received"); expect(rec.body.note).toMatch(/closed/);
    const hold = (await withFamily(FAMILY, (c) => c.query("select quantity from holdings where id=$1", [r.body.holding.id]))).rows[0]; expect(Number(hold.quantity)).toBe(0);
    const gain = (await withFamily(FAMILY, (c) => c.query("select gain, asset_class from realized_gains where instrument_id=$1", [r.body.instrument.id]))).rows[0]; expect(Number(gain.gain)).toBe(100); expect(gain.asset_class).toBe("listed_bond");
    const t = (await get("/tasks?status=open&module=investments")).body.filter((x: any) => /^(Matures|Maturity).*ZZ Rcpt Soon NCD/.test(x.title)); expect(t.length).toBe(0);   // the maturity task closed with the payment (its earlier unpaid coupons stay open)
  });

  it("a payment that is late becomes an urgent task", async () => {
    const r = await addBond("ZZ Rcpt Late NCD", { extras: { maturity_date: day(-3), coupon_frequency: "at_maturity" }, body: { txn_date: day(-200), quantity: 10, price: 1000 } }); expect(r.code).toBe(201);
    await withFamily(FAMILY, (c) => generateTasksFor(c, FAMILY, day(0), { notify: false }));
    const t = (await get("/tasks?status=open&module=investments")).body.find((x: any) => /^(Maturity|Interest) overdue 3 d: ZZ Rcpt Late NCD/.test(x.title)); expect(t).toBeTruthy(); expect(t.severity).toBe(1);
  });

  it("a bank-statement credit with the right amount and a matching narration marks the payment received by itself", async () => {
    const r = await addBond("ZZ Rcpt Bank NCD", { extras: { maturity_date: day(40), coupon_frequency: "yearly", coupon_pct: 10 }, body: { txn_date: day(-325), quantity: 20, price: 1000 } }); expect(r.code).toBe(201);
    const rc = (await get("/holding-receipts")).body.find((x: any) => x.holding_id === r.body.holding.id && x.kind === "interest"); expect(Number(rc.expected_amount)).toBe(2000);
    await withFamily(FAMILY, async (c) => { await c.query("insert into bank_txns (family_id, bank_account_id, txn_date, narration, amount, hash, source) values ($1,$2,$3,$4,$5,$6,'csv')", [FAMILY, acct, rc.due_date, "NEFT CR ZZ RCPT BANK NCD INTEREST", 2000, "zzrcpt-1"]); });
    const n = await withFamily(FAMILY, (c) => reconcileHoldingReceipts(c, FAMILY)); expect(n).toBeGreaterThanOrEqual(1);
    const after = (await get("/holding-receipts?status=all")).body.find((x: any) => x.id === rc.id); expect(after.status).toBe("received"); expect(after.bank_txn_ref).toBeTruthy();
    expect(await withFamily(FAMILY, (c) => reconcileHoldingReceipts(c, FAMILY))).toBe(0);   // already matched: nothing twice
  });

  it("guards: a viewer cannot record, a wrong bank account is refused, and an empty amount is refused", async () => {
    const open = (await get("/holding-receipts")).body.find((x: any) => x.holding_id === bondHolding && x.status === "expected");
    expect((await post(`/holding-receipts/${open.id}/receive`, { amount: 100 }, viewer)).code).toBe(403);
    expect((await post(`/holding-receipts/${open.id}/receive`, { amount: 100, bank_account_id: "00000000-0000-4000-8000-000000000000" })).code).toBe(404);
    expect((await post(`/holding-receipts/${open.id}/receive`, { amount: 0 })).code).toBe(422);
    expect((await get("/holding-receipts", viewer)).code).toBe(200);   // a viewer can still look
    await withFamily(FAMILY, (c) => syncHoldingReceipts(c, FAMILY));
  });
});
