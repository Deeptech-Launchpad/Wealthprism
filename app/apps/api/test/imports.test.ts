import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { buildApp } from "../src/server.js";
import { pool, withFamily } from "../src/lib/db.js";

const FAMILY = "11111111-1111-1111-1111-111111111111";
const S = (f: string) => readFileSync(new URL(`../../../../samples/${f}`, import.meta.url), "utf8");
let app: ReturnType<typeof buildApp>;
let token = "";
let hdfcAccountId = "";

/** Tables the importer writes to. Rows this suite creates are removed afterwards, and rows it
 *  updates are put back, so the suite is re-runnable against a database seeded once. */
const CREATED = [
  "realized_gains", "investment_txns", "lots", "holdings", "bank_txns",
  "tds_26as", "import_jobs", "import_mappings", "accounts", "instruments",
];
const before: Record<string, string[]> = {};
let holdingsBefore: any[] = [];
let lotsBefore: any[] = [];
let rentBefore: any[] = [];
let tasksBefore: any[] = [];
let bankBefore: any[] = [];

const h = (extra: Record<string, string> = {}) => ({ authorization: `Bearer ${token}`, "x-family-id": FAMILY, ...extra });
const upload = (payload: Record<string, unknown>) => app.inject({ method: "POST", url: "/api/v1/imports", headers: h(), payload });
const holdings = async () => (await app.inject({ url: "/api/v1/holdings", headers: h() })).json().items;
const capitalGains = async (fy = "2026-27") => (await app.inject({ url: `/api/v1/capital-gains?fy=${fy}`, headers: h() })).json();

beforeAll(async () => {
  app = buildApp();
  await app.ready();
  const r = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: "arjun@example.com", password: "Prototype!2026" } });
  expect(r.statusCode).toBe(200);
  token = r.json().access_token;
  const accounts = (await app.inject({ url: "/api/v1/bank-accounts", headers: h() })).json();
  hdfcAccountId = accounts.find((a: any) => a.account_masked.endsWith("4471")).id;
  await withFamily(FAMILY, async (c) => {
    for (const t of CREATED) before[t] = (await c.query(`select id from ${t}`)).rows.map((x) => x.id);
    holdingsBefore = (await c.query("select id, quantity, avg_cost from holdings")).rows;
    lotsBefore = (await c.query("select id, remaining_qty, source_txn_id from lots")).rows;
    rentBefore = (await c.query("select id, status, received_amount, received_on, bank_txn_id from rent_schedule")).rows;
    tasksBefore = (await c.query("select id, status, done_at, verification from tasks")).rows;
    bankBefore = (await c.query("select id, balance, balance_as_of, sync_mode from bank_accounts")).rows;
  });
});

afterAll(async () => {
  await withFamily(FAMILY, async (c) => {
    for (const r of rentBefore) await c.query("update rent_schedule set status=$2, received_amount=$3, received_on=$4, bank_txn_id=$5 where id=$1", [r.id, r.status, r.received_amount, r.received_on, r.bank_txn_id]);
    for (const t of tasksBefore) await c.query("update tasks set status=$2, done_at=$3, verification=$4 where id=$1", [t.id, t.status, t.done_at, t.verification]);
    for (const b of bankBefore) await c.query("update bank_accounts set balance=$2, balance_as_of=$3, sync_mode=$4 where id=$1", [b.id, b.balance, b.balance_as_of, b.sync_mode]);
    await c.query("delete from tasks where id <> all($1::uuid[])", [tasksBefore.map((t) => t.id)]);
    for (const t of CREATED) await c.query(`delete from ${t} where id <> all($1::uuid[])`, [before[t]]);
    for (const x of holdingsBefore) await c.query("update holdings set quantity=$2, avg_cost=$3 where id=$1", [x.id, x.quantity, x.avg_cost]);
    for (const l of lotsBefore) await c.query("update lots set remaining_qty=$2, source_txn_id=$3 where id=$1", [l.id, l.remaining_qty, l.source_txn_id]);
  });
  await app.close();
  await pool.end();
});

describe("imports", () => {
  it("ingests a Zerodha tradebook into holdings, lots and realized gains", async () => {
    const hdfcBefore = (await holdings()).find((x: any) => x.symbol === "HDFCBANK");
    const r = await upload({ text: S("zerodha_tradebook_FY2026-27.csv") });
    expect(r.statusCode).toBe(201);
    const job = r.json();
    expect(job.status).toBe("done");
    expect(job.rows_total).toBe(4);
    expect(job.rows_ok).toBe(4);
    expect(job.rows_error).toBe(0);

    // the tradebook lands on the existing Zerodha demat account; the 21 HDFCBANK shares were already
    // entered by hand as a lot, so that lot is adopted rather than counted twice
    const after = await holdings();
    const hdfc = after.filter((x: any) => x.symbol === "HDFCBANK");
    expect(hdfc.length).toBe(1);
    expect(Number(hdfc[0].quantity)).toBe(Number(hdfcBefore.quantity));
    const lots = (await app.inject({ url: `/api/v1/holdings/${hdfc[0].id}/lots`, headers: h() })).json();
    const bought = lots.filter((l: any) => Number(l.unit_cost) === 1471.43 && l.buy_date.startsWith("2022-03-14"));
    expect(bought.length).toBe(1);
    expect(bought[0].term_now).toBe("long");

    // INFY: 3 bought in Feb 2022, all 3 sold in Jul 2026 — a long-term gain and an emptied lot
    const infyHolding = after.find((x: any) => x.symbol === "INFY");
    expect(Number(infyHolding.quantity)).toBe(0);
    const cg = await capitalGains();
    const infy = cg.lots.find((l: any) => l.instrument === "INFY");
    expect(infy).toBeTruthy();
    expect(infy.term).toBe("long");
    expect(infy.entity_name).toBe("Arjun Mehta");
    expect(Number(infy.quantity)).toBe(3);
    expect(Number(infy.cost)).toBeCloseTo(5100, 0);
    expect(Number(infy.gain)).toBeCloseTo(1100, 0);
    const equity = cg.summary.find((s: any) => s.asset_class === "equity" && s.entity_name === "Arjun Mehta");
    expect(Number(equity.ltcg)).toBeGreaterThanOrEqual(1100);
    expect(Number(equity.exemption_used)).toBeGreaterThan(0);
  });

  it("treats a re-upload of the same file as a no-op", async () => {
    const r = await upload({ text: S("zerodha_tradebook_FY2026-27.csv") });
    expect(r.statusCode).toBe(200);
    expect(r.json().duplicate_of_previous_upload).toBe(true);
    const jobs = (await app.inject({ url: "/api/v1/imports", headers: h() })).json();
    expect(jobs.filter((j: any) => j.source === "contract_note" && j.status === "done").length).toBe(1);
  });

  it("ingests a CAMS CAS, attributing folios to entities by PAN", async () => {
    const r = await upload({ text: S("cams_cas_extracted_text_sample.txt") });
    expect(r.statusCode).toBe(201);
    const job = r.json();
    expect(job.rows_total).toBe(6);
    expect(job.rows_ok).toBe(6);

    const detail = (await app.inject({ url: `/api/v1/imports/${job.id}`, headers: h() })).json();
    expect(detail.source).toBe("cas");

    // the PPFAS folio carries the HUF's PAN: it joins the HUF's existing folio, adding only the new SIP
    const items = await holdings();
    const ppfas = items.filter((x: any) => /Parag Parikh/i.test(x.instrument));
    expect(ppfas.length).toBe(1);
    expect(ppfas[0].entity_name).toBe("Mehta HUF");
    expect(Number(ppfas[0].quantity)).toBeCloseTo(418.319, 3);
    // the liquid fund purchase was already on Arjun's KFintech folio: adopted, not duplicated
    const liquid = items.filter((x: any) => /ICICI Prudential Liquid/i.test(x.instrument));
    expect(liquid.length).toBe(1);
    expect(liquid[0].entity_name).toBe("Arjun Mehta");
    expect(Number(liquid[0].quantity)).toBeCloseTo(81.12, 3);

    // the Axis redemption realises a short-term loss in FY 2026-27 for the HUF
    const cg = await capitalGains();
    const axis = cg.lots.find((l: any) => /Axis Small Cap/i.test(l.instrument));
    expect(axis).toBeTruthy();
    expect(axis.entity_name).toBe("Mehta HUF");
    expect(axis.term).toBe("short");
    expect(Number(axis.quantity)).toBeCloseTo(41.2, 2);
    expect(Number(axis.gain)).toBeCloseTo(-200, 0);
  });

  it("ingests a bank statement: categorises, updates the balance and reconciles rent", async () => {
    const r = await upload({ text: S("hdfc_bank_statement_sep2026.csv"), bank_account_id: hdfcAccountId });
    expect(r.statusCode).toBe(201);
    expect(r.json().rows_ok).toBe(6);

    const txns = (await app.inject({ url: `/api/v1/bank-txns?account_id=${hdfcAccountId}`, headers: h() })).json().items;
    const tax = txns.find((t: any) => /PROPERTY TAX/.test(t.narration));
    expect(tax.category).toBe("Property tax");
    expect(Number(tax.amount)).toBe(-482);
    expect(txns.find((t: any) => /HDFC BANK LTD DIV/.test(t.narration)).category).toBe("Dividend");
    expect(txns.find((t: any) => /PPFAS MF SIP/.test(t.narration)).category).toBe("Investment / SIP");

    const acct = (await app.inject({ url: "/api/v1/bank-accounts", headers: h() })).json().find((a: any) => a.id === hdfcAccountId);
    expect(Number(acct.balance)).toBeCloseTo(21567.6, 2);

    // a second statement carries the overdue September rent; the importer must settle it
    const overdue = rentBefore.find((x) => x.status === "overdue")!;
    await withFamily(FAMILY, async (c) => {
      await c.query(`insert into tasks (family_id, module, title, reason, severity, source_type, source_id)
        values ($1,'real_estate','Rent overdue','seeded by the imports test',1,'rent_schedule',$2)`, [FAMILY, overdue.id]);
    });
    const settle = [
      "Date,Narration,Chq./Ref.No.,Value Dt,Withdrawal Amt.,Deposit Amt.,Closing Balance",
      "12/09/26,NEFT CR-R. SUNDARAM RENT SEP,N254260912999999,12/09/26,,420.00,21987.60",
    ].join("\n");
    const r2 = await upload({ text: settle, bank_account_id: hdfcAccountId });
    expect(r2.statusCode).toBe(201);
    expect(r2.json().rent_matched).toBe(1);

    const rent = (await app.inject({ url: "/api/v1/rent-schedule?month=2026-09", headers: h() })).json();
    const settled = rent.find((x: any) => x.id === overdue.id);
    expect(settled.status).toBe("received");
    expect(Number(settled.received_amount)).toBeCloseTo(420, 2);
    expect(settled.bank_txn_id).toBeTruthy();
    const after = (await app.inject({ url: `/api/v1/bank-txns?account_id=${hdfcAccountId}`, headers: h() })).json().items;
    expect(after.find((t: any) => t.id === settled.bank_txn_id).link_type).toBe("rent");
    // …and the overdue-rent task it raised is closed
    const open = (await app.inject({ url: "/api/v1/tasks?status=open", headers: h() })).json();
    expect(open.some((t: any) => t.source_type === "rent_schedule" && t.source_id === overdue.id)).toBe(false);
  });

  it("ingests Form 26AS and reconciles it against expected rent TDS", async () => {
    const r = await upload({ text: S("form26as_mehta_huf_FY2026-27.txt") });
    expect(r.statusCode).toBe(201);
    expect(r.json().rows_ok).toBe(7);

    // attributed to Mehta HUF by PAN, so filtering by that entity still shows the rows
    const huf = (await app.inject({ url: "/api/v1/entities", headers: h() })).json().find((e: any) => e.name === "Mehta HUF");
    const rec = (await app.inject({ url: `/api/v1/tds/reconciliation?fy=2026-27&entity_id=${huf.id}`, headers: h() })).json();
    const kovai = rec.find((x: any) => /KOVAI/i.test(x.deductor));
    expect(kovai).toBeTruthy();
    expect(Number(kovai.in_26as)).toBe(1710);
    expect(["matched", "short", "extra"]).toContain(kovai.status);
  });

  it("asks for a mapping on an unknown layout, then imports it and remembers the mapping", async () => {
    const text = S("icicidirect_contract_note_sample.csv");
    const first = await upload({ text });
    expect(first.statusCode).toBe(202);
    expect(first.json().status).toBe("needs_mapping");
    expect(first.json().detected_headers).toContain("contract note no");

    const mapping = {
      date: "Trade Date", instrument: "Scrip", isin: "ISIN", side: "Buy/Sell",
      quantity: "Quantity", price: "Rate", ref: "Contract Note No",
      charges: ["Brokerage", "STT", "Exchange Txn Charges", "GST", "SEBI Fee", "Stamp Duty"],
    };
    // the contract's re-run endpoint: the job kept the payload, so only the mapping is sent
    const second = await app.inject({ method: "POST", url: `/api/v1/imports/${first.json().id}/mapping`, headers: h(), payload: { mapping, provider: "icicidirect" } });
    expect(second.statusCode).toBe(201);
    expect(second.json().id).toBe(first.json().id);
    expect(second.json().rows_ok).toBe(2);
    expect(second.json().filename).toBe("paste.txt");
    expect((await app.inject({ method: "POST", url: `/api/v1/imports/${first.json().id}/mapping`, headers: h(), payload: { mapping } })).statusCode).toBe(409);
    // and uploading the same file again with the mapping inline is the usual no-op
    expect((await upload({ text, mapping, provider: "icicidirect" })).json().duplicate_of_previous_upload).toBe(true);

    // the note carries no PAN: it lands on the spouse, who holds the ICICI Direct account, and the 15-unit
    // purchase already entered by hand is adopted, so 5 sold leaves 10
    const cg = await capitalGains();
    const bond = cg.lots.find((l: any) => /SBI 7\.72/.test(l.instrument) && Math.abs(Number(l.proceeds) - 5133.9) < 1);
    expect(bond).toBeTruthy();
    expect(bond.entity_name).toBe("Spouse (Individual)");
    expect(Number(bond.quantity)).toBe(5);
    expect(bond.term).toBe("long");
    const bondHoldings = (await holdings()).filter((x: any) => /SBI 7\.72/.test(x.instrument));
    expect(bondHoldings.length).toBe(1);
    expect(Number(bondHoldings[0].quantity)).toBe(10);

    // the same layout with different rows now parses without a mapping being supplied again
    const more = text.trimEnd() + "\nCN/26/01288,2026-09-01,2026180,8807715,NSE,SBI 7.72% 2033,INE062A08157,B,4,1030.00,4.12,0.00,0.02,0.74,0.01,0.00,4124.89\n";
    const third = await upload({ text: more });
    expect(third.statusCode).toBe(201);
    expect(third.json().rows_ok).toBe(1); // two rows were already imported, one is new
  });

  it("refuses uploads from a viewer and rejects an empty file", async () => {
    const viewer = (await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: "ca@example.com", password: "Prototype!2026" } })).json().access_token;
    const r = await app.inject({ method: "POST", url: "/api/v1/imports", headers: { authorization: `Bearer ${viewer}`, "x-family-id": FAMILY }, payload: { text: "anything" } });
    expect(r.statusCode).toBe(403);
    expect((await upload({ text: "   " })).statusCode).toBe(422);
  });
});
