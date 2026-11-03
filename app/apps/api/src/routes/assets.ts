/** "Add asset": the catalogue of asset types (asset_types) and the one write path that has no screen of its own, a hand-entered market holding.
 *  Physical assets and insurance are saved through /lifestyle-assets and /insurance-policies; the form picks the right one from the type's category. */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireFamily, requireRole } from "../lib/auth.js";
import { withFamily, money } from "../lib/db.js";
import { applyInvestmentTxn } from "./imports.js";
import { syncHoldingReceipts, settleHoldingReceipt, receiptView, RECEIPT_TYPES } from "../lib/holdingreceipts.js";
import { searchFunds, ensureInstrument, refreshFundHistory, loadNavAll, FundFeedError } from "../lib/wcfunds.js";

const WRITERS = requireRole("owner", "member", "operator");
const num = z.union([z.number(), z.string().regex(/^-?\d+(\.\d+)?$/)]).transform(Number); const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const r2 = (n: number) => Math.round(n * 100) / 100;
class AssetError extends Error { constructor(public status: number, message: string) { super(message); } }
const problem = (reply: any, e: any) => { if (e instanceof AssetError) return void reply.code(e.status).send({ title: e.message, status: e.status }); if (e instanceof FundFeedError) return void reply.code(502).send({ title: "The AMFI fund list could not be loaded just now. Try again in a minute.", status: 502 }); if (e?.name === "ZodError") return void reply.code(422).send({ title: e.issues?.[0] ? `${e.issues[0].path.join(".") || "request"}: ${e.issues[0].message}` : "Invalid request", status: 422 }); throw e; };
const NPS_ALLOC: Record<string, string> = { "Equity (E)": "equity", "Corporate bond (C)": "debt", "Government bond (G)": "debt", "Alternative (A)": "alternatives" };   // an NPS scheme's class in the allocation lens
const UNITLESS = new Set(["pms", "aif"]);   // no units: the money put in is one "unit" and its value is updated from the statement

export default async function assetRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireFamily);
  const fam = (req: any) => req.family!.familyId as string;

  app.get("/asset-types", async (req) => withFamily(fam(req), async (c) => (await c.query("select code, category, label, description, instrument_type, alloc_class, default_bucket, lifestyle_kind, insurance_kind, counts_in_net_worth, enabled, fields, price_mode, price_help, deposit_type_code from asset_types order by category, sort")).rows));

  /** Search the AMFI scheme list, for the mutual-fund type. */
  app.get("/assets/fund-search", async (req, reply) => { try { return void reply.send(await searchFunds(String((req.query as any)?.q ?? ""))); } catch (e) { return problem(reply, e); } });

  /** Expected interest and maturity payments of the bonds held. status=open (default) = not yet in; all = every one. */
  app.get("/holding-receipts", async (req) => withFamily(fam(req), async (c) => {
    const q = z.object({ status: z.enum(["open", "all"]).default("open") }).parse(req.query);
    await syncHoldingReceipts(c, fam(req));
    return (await c.query(`select r.id, r.holding_id, r.entity_id, e.name entity_name, r.instrument_id, i.name instrument, i.type instrument_type, r.kind, r.due_date::text due_date, r.expected_amount, r.received_amount, r.received_on::text received_on, r.status, r.bank_txn_ref, (r.due_date - current_date) days
      from holding_receipts r join instruments i on i.id=r.instrument_id join entities e on e.id=r.entity_id where r.family_id=$1 and r.status <> 'cancelled' and ($2::boolean or r.status in ('expected','overdue','partial'))
      order by r.due_date limit 300`, [fam(req), q.status === "all"])).rows.map(receiptView);
  }));

  /** Money that has arrived for one expected payment: the amount, the day, and the bank account it was credited to (its balance goes up by the amount). */
  app.post("/holding-receipts/:id/receive", { preHandler: WRITERS }, async (req, reply) => {
    try {
      const b = z.object({ amount: num, received_on: date.optional(), bank_account_id: z.string().uuid().nullable().optional() }).parse(req.body ?? {});
      if (!(b.amount > 0)) throw new AssetError(422, "Enter the amount that was credited");
      const out = await withFamily(fam(req), async (c) => {
        const r = (await c.query("select r.*, r.due_date::text due_date2, i.type instrument_type from holding_receipts r join instruments i on i.id=r.instrument_id where r.id=$1 and r.family_id=$2", [(req.params as any).id, fam(req)])).rows[0];
        if (!r) throw new AssetError(404, "Payment not found");
        if (r.status === "received") throw new AssetError(409, "Already recorded as received");
        if (r.status === "cancelled") throw new AssetError(409, "This payment is no longer expected");
        if (b.bank_account_id && !(await c.query("select 1 from bank_accounts where id=$1 and family_id=$2 and entity_id=$3 and deleted_at is null", [b.bank_account_id, fam(req), r.entity_id])).rowCount) throw new AssetError(404, "Bank account not found for this owner");
        const on = b.received_on ?? new Date().toISOString().slice(0, 10);
        const res = await settleHoldingReceipt(c, fam(req), r, b.amount, on, { bankAccountId: b.bank_account_id ?? null });
        let balanceNote: string | null = null;
        if (b.bank_account_id) { await c.query("update bank_accounts set balance = balance + $2 where id=$1", [b.bank_account_id, b.amount]); balanceNote = "Added to the bank balance"; }
        await c.query("insert into audit_log (family_id, user_id, action, table_name, row_id, after) values ($1,$2,'receive','holding_receipts',$3,$4)", [fam(req), req.user!.id, r.id, JSON.stringify({ amount: b.amount, status: res.status })]);
        await syncHoldingReceipts(c, fam(req));
        const row = (await c.query("select r.*, r.due_date::text due_date, r.received_on::text received_on from holding_receipts r where r.id=$1", [r.id])).rows[0];
        return { ...receiptView(row), balance_note: balanceNote, note: res.note };
      });
      return void reply.send(out);
    } catch (e) { return problem(reply, e); }
  });

  /** Update the price of a holding nobody prices: a security with no feed, a PMS or AIF (its value from the latest statement). A price a daily feed supplies is refused, and so is a G-Sec or
   *  T-bill, whose value the app works out. The new price is stored for its date, so the history of what was typed is kept. */
  app.post("/holdings/:id/price", { preHandler: WRITERS }, async (req, reply) => {
    try {
      const b = z.object({ price: num.optional(), value: num.optional(), price_date: date.optional(), note: z.string().max(200).optional() }).parse(req.body ?? {});
      const out = await withFamily(fam(req), async (c) => {
        const h = (await c.query("select h.id, h.quantity, h.instrument_id, i.name, i.type from holdings h join instruments i on i.id=h.instrument_id where h.id=$1 and h.family_id=$2", [(req.params as any).id, fam(req)])).rows[0];
        if (!h) throw new AssetError(404, "Holding not found");
        if (["mf", "gsec", "tbill"].includes(h.type)) throw new AssetError(409, h.type === "mf" ? "Mutual fund prices come from the AMFI NAV feed." : "The value of a G-Sec or T-bill is worked out by the app.");
        if ((await c.query("select 1 from prices where instrument_id=$1 and source <> 'manual' limit 1", [h.instrument_id])).rowCount) throw new AssetError(409, "This security is priced by the daily NSE feed, so its price cannot be typed.");
        const qty = Number(h.quantity); const price = b.price ?? (b.value != null && qty > 0 ? b.value / qty : undefined);
        if (price == null || !(price > 0)) throw new AssetError(422, "Enter the new price (or the value) as a number above zero");
        const on = b.price_date ?? new Date().toISOString().slice(0, 10);
        if (on > new Date().toISOString().slice(0, 10)) throw new AssetError(422, "The price date cannot be in the future");
        await c.query("insert into prices (instrument_id, price_date, close, source) values ($1,$2,$3,'manual') on conflict (instrument_id, price_date) do update set close=excluded.close, source='manual'", [h.instrument_id, on, Math.round(price * 10000) / 10000]);
        await c.query("insert into audit_log (family_id, user_id, action, table_name, row_id, after) values ($1,$2,'update_price','holdings',$3,$4)", [fam(req), req.user!.id, h.id, JSON.stringify({ instrument: h.name, price, on, note: b.note ?? null })]);
        return { instrument: h.name, price: Math.round(price * 10000) / 10000, price_date: on, value: money(qty * price) };
      });
      return void reply.send(out);
    } catch (e) { return problem(reply, e); }
  });

  /** Delete a holding with its lots and transactions, for a wrong or test entry. Refused when sales are already on record (the gains feed the tax reports) or when it is pledged
   *  against a loan; a holding still used by a proposal or a reconciliation answers 409 as well. The bank balances credited by "Record" are left as they are. */
  app.delete("/holdings/:id", { preHandler: requireRole("owner", "member") }, async (req, reply) => {
    try {
      const out = await withFamily(fam(req), async (c) => {
        const id = (req.params as any).id;
        const h = (await c.query("select h.id, h.entity_id, h.account_id, h.instrument_id, h.quantity, h.avg_cost, i.name from holdings h join instruments i on i.id=h.instrument_id where h.id=$1 and h.family_id=$2", [id, fam(req)])).rows[0];
        if (!h) throw new AssetError(404, "Holding not found");
        if ((await c.query("select 1 from realized_gains g join lots l on l.id=g.lot_id where l.holding_id=$1 limit 1", [id])).rowCount) throw new AssetError(409, "Units of this holding have been sold. The gains are already counted for tax, so it cannot be deleted.");
        if ((await c.query("select 1 from liabilities where secured_by_type='holding' and secured_by_id=$1 and deleted_at is null limit 1", [id])).rowCount) throw new AssetError(409, "This holding is pledged against a loan. Remove the pledge first.");
        const credited = (await c.query("select count(*) n from holding_receipts where holding_id=$1 and status='received' and bank_account_id is not null", [id])).rows[0].n;
        await c.query("savepoint del");
        try {
          await c.query("delete from tasks where family_id=$1 and source_type='holding_receipt' and source_id in (select id from holding_receipts where holding_id=$2)", [fam(req), id]);
          await c.query("delete from investment_txns where family_id=$1 and entity_id=$2 and instrument_id=$3 and account_id is not distinct from $4", [fam(req), h.entity_id, h.instrument_id, h.account_id]);
          await c.query("delete from lots where holding_id=$1", [id]);
          await c.query("delete from holdings where id=$1", [id]);
        } catch (e: any) { await c.query("rollback to savepoint del"); if (e?.code === "23503") throw new AssetError(409, "This holding is still used by a rebalance proposal or a reconciliation, so it cannot be deleted."); throw e; }
        await c.query("insert into audit_log (family_id, user_id, action, table_name, row_id, before) values ($1,$2,'delete','holdings',$3,$4)", [fam(req), req.user!.id, id, JSON.stringify({ instrument: h.name, quantity: Number(h.quantity), avg_cost: Number(h.avg_cost) })]);
        return { deleted: h.name, note: Number(credited) ? "Bank balances you credited when recording its payments were not changed; adjust them on the Banking page if needed." : null };
      });
      return void reply.send(out);
    } catch (e) { return problem(reply, e); }
  });

  /** One more entry on a holding that already exists: buy more, sell (oldest units first, the gain is worked out), income received (dividend, interest, distribution) or a fee.
   *  With preview: true nothing is kept; the answer shows what saving would do. A PMS or AIF has no units, so its entries are amounts, turned into units at the latest unit price. */
  app.post("/holdings/:id/txn", { preHandler: WRITERS }, async (req, reply) => {
    try {
      const b = z.object({ kind: z.enum(["buy", "sell", "income", "fee"]), date, quantity: num.optional(), price: num.optional(), amount: num.optional(), charges: num.optional(), bank_account_id: z.string().uuid().nullable().optional(), note: z.string().max(200).optional(), preview: z.boolean().optional(), capital_call_id: z.string().uuid().optional() }).parse(req.body ?? {});
      const out = await withFamily(fam(req), async (c) => {
        const h = (await c.query(`select h.id, h.entity_id, h.account_id, h.quantity, h.avg_cost, i.id iid, i.name, i.type, i.isin, i.symbol, i.amfi_code, a.kind akind, a.identifier_masked aident, a.provider aprov
          from holdings h join instruments i on i.id=h.instrument_id left join accounts a on a.id=h.account_id where h.id=$1 and h.family_id=$2`, [(req.params as any).id, fam(req)])).rows[0];
        if (!h) throw new AssetError(404, "Holding not found");
        if (b.date > new Date().toISOString().slice(0, 10)) throw new AssetError(422, "The date cannot be in the future");
        if (b.bank_account_id && !(await c.query("select 1 from bank_accounts where id=$1 and family_id=$2 and entity_id=$3 and deleted_at is null", [b.bank_account_id, fam(req), h.entity_id])).rowCount) throw new AssetError(404, "Bank account not found for this owner");
        const unitless = UNITLESS.has(h.type); const charges = b.charges ?? 0;
        if (charges < 0) throw new AssetError(422, "Charges cannot be negative");
        const held = Number(h.quantity);
        let qty = 0, price = 0, amount = 0;
        if (b.kind === "income" || b.kind === "fee") { amount = b.amount ?? 0; if (!(amount > 0)) throw new AssetError(422, "Enter the amount"); if (b.kind === "fee" && !unitless) throw new AssetError(422, "A fee is recorded for a PMS or AIF only"); }
        else if (unitless) {
          amount = b.amount ?? 0; if (!(amount > 0)) throw new AssetError(422, "Enter the amount");
          const last = (await c.query("select close from prices where instrument_id=$1 order by price_date desc limit 1", [h.iid])).rows[0]?.close;
          price = Number(last ?? h.avg_cost) || 0; if (!(price > 0)) throw new AssetError(422, "This holding has no value yet. Update its value first");
          qty = Math.round(amount / price * 1e6) / 1e6;
        } else {
          qty = b.quantity ?? 0; price = b.price ?? 0; amount = b.amount ?? 0;
          if (qty && price && !amount) amount = r2(qty * price); else if (amount && qty && !price) price = amount / qty; else if (amount && price && !qty) qty = amount / price;
          if (!(qty > 0) || !(price > 0) || !(amount > 0)) throw new AssetError(422, "Enter the quantity and the price (or the quantity and the total amount)");
        }
        if (b.kind === "sell") {
          const avail = Number((await c.query("select coalesce(sum(remaining_qty),0) q from lots where holding_id=$1 and buy_date <= $2", [h.id, b.date])).rows[0].q);
          if (avail + 1e-6 < qty) throw new AssetError(422, held + 1e-6 >= qty ? "Some of those units were bought after that date. Pick a later sale date" : `You hold only ${held}. A sale cannot be larger than that`);
        }
        const kindOf = b.kind === "income" ? (["mf", "stock", "etf", "reit"].includes(h.type) ? "dividend" : unitless ? "distribution" : "interest") : b.kind;
        const ref = `manual:txn:${h.id}:${kindOf}:${b.date}:${qty}:${amount}`;
        await c.query("savepoint tx");
        let gains: any[] = [];
        if (b.kind === "buy" || b.kind === "sell") {
          const t: any = { source: "manual", provider: h.aprov ?? "manual", account: { kind: h.akind ?? "demat", identifier: h.aident ?? "MANUAL" }, instrument: { id: h.iid, name: h.name, isin: h.isin, amfiCode: h.amfi_code, symbol: h.symbol, type: h.type }, type: b.kind, date: b.date, quantity: qty, price, amount, charges, ref };
          let r: string; try { r = await applyInvestmentTxn(c, fam(req), h.entity_id, t, null); } catch (e: any) { await c.query("rollback to savepoint tx"); throw new AssetError(422, e.message); }
          if (r === "dup") { await c.query("rollback to savepoint tx"); throw new AssetError(409, "An identical entry is already recorded for this date and amount"); }
          if (b.kind === "sell") gains = (await c.query("select g.buy_date::text buy_date, g.quantity, g.cost, g.proceeds, g.gain, g.term from realized_gains g join investment_txns x on x.id=g.sell_txn_id where x.family_id=$1 and x.hash=$2 order by g.buy_date", [fam(req), ref])).rows.map((g: any) => ({ ...g, quantity: Number(g.quantity), cost: Number(g.cost), proceeds: Number(g.proceeds), gain: Number(g.gain) }));
        } else {
          if ((await c.query("select 1 from investment_txns where family_id=$1 and hash=$2", [fam(req), ref])).rowCount) { await c.query("rollback to savepoint tx"); throw new AssetError(409, "An identical entry is already recorded for this date and amount"); }
          await c.query("insert into investment_txns (family_id, entity_id, account_id, instrument_id, type, txn_date, quantity, price, amount, charges, source, hash) values ($1,$2,$3,$4,$5,$6,0,0,$7,0,'manual',$8)", [fam(req), h.entity_id, h.account_id, h.iid, kindOf, b.date, amount, ref]);
        }
        const after = (await c.query("select quantity, avg_cost from holdings where id=$1", [h.id])).rows[0];
        const delta = b.kind === "buy" ? -(amount + charges) : b.kind === "sell" ? amount - charges : b.kind === "income" ? amount : -amount;
        const result: any = { kind: b.kind, recorded_as: kindOf, quantity: qty, price, amount: r2(amount), charges, units_before: held, units_after: Number(after.quantity), avg_cost_after: Number(after.avg_cost), gains, total_cost: r2(gains.reduce((s, g) => s + g.cost, 0)), total_proceeds: r2(gains.reduce((s, g) => s + g.proceeds, 0)), total_gain: r2(gains.reduce((s, g) => s + g.gain, 0)), bank_change: b.bank_account_id ? r2(delta) : 0, closes_holding: b.kind === "sell" && Number(after.quantity) <= 1e-6 };
        if (b.preview) { await c.query("rollback to savepoint tx"); return { preview: true, ...result }; }
        if (b.bank_account_id) await c.query("update bank_accounts set balance = balance + $2 where id=$1", [b.bank_account_id, delta]);
        if (b.capital_call_id && b.kind === "buy") await c.query("update capital_calls set status='paid', paid_on=$3 where id=$1 and holding_id=$2 and status='expected'", [b.capital_call_id, h.id, b.date]);
        await c.query("insert into audit_log (family_id, user_id, action, table_name, row_id, after) values ($1,$2,'add_txn','holdings',$3,$4)", [fam(req), req.user!.id, h.id, JSON.stringify({ instrument: h.name, kind: kindOf, qty, price, amount, charges, bank: b.bank_account_id ?? null, note: b.note ?? null })]);
        if (["bond", "gsec", "tbill", "sgb"].includes(h.type)) await syncHoldingReceipts(c, fam(req));
        return { preview: false, ...result };
      });
      return void reply.send(out);
    } catch (e) { return problem(reply, e); }
  });

  /** Every entry on a holding, newest first: purchases, sales, income, fees, whatever came from an import or a corporate action. */
  app.get("/holdings/:id/transactions", async (req, reply) => {
    try {
      const out = await withFamily(fam(req), async (c) => {
        const h = (await c.query("select h.entity_id, h.account_id, h.instrument_id from holdings h where h.id=$1 and h.family_id=$2", [(req.params as any).id, fam(req)])).rows[0];
        if (!h) throw new AssetError(404, "Holding not found");
        return (await c.query("select id, type, txn_date::text txn_date, quantity, price, amount, charges, source from investment_txns where family_id=$1 and entity_id=$2 and instrument_id=$3 and account_id is not distinct from $4 order by txn_date desc, id desc limit 200", [fam(req), h.entity_id, h.instrument_id, h.account_id])).rows
          .map((t: any) => ({ id: t.id, type: t.type, date: t.txn_date, quantity: Number(t.quantity), price: Number(t.price), amount: Number(t.amount), charges: Number(t.charges), source: t.source }));
      });
      return void reply.send(out);
    } catch (e) { return problem(reply, e); }
  });

  /** An AIF's commitment, how much of it has been called, and the calls announced and still to pay. */
  const callsView = async (c: any, familyId: string, holdingId: string) => {
    const h = (await c.query("select h.entity_id, h.account_id, h.instrument_id, i.type, i.meta->>'commitment' commitment from holdings h join instruments i on i.id=h.instrument_id where h.id=$1 and h.family_id=$2", [holdingId, familyId])).rows[0];
    if (!h) throw new AssetError(404, "Holding not found");
    if (h.type !== "aif") return { is_aif: false };
    const called = Number((await c.query("select coalesce(sum(amount),0) a from investment_txns where family_id=$1 and entity_id=$2 and instrument_id=$3 and account_id is not distinct from $4 and type='buy'", [familyId, h.entity_id, h.instrument_id, h.account_id])).rows[0].a);
    const commitment = h.commitment ? Number(h.commitment) : null;
    const calls = (await c.query("select id, due_date::text due_date, amount, status, paid_on::text paid_on, note, (due_date - current_date) days from capital_calls where holding_id=$1 and status <> 'cancelled' order by due_date", [holdingId])).rows.map((x: any) => ({ ...x, amount: Number(x.amount), days: Number(x.days) }));
    return { is_aif: true, commitment, called: r2(called), remaining: commitment == null ? null : r2(Math.max(0, commitment - called)), pct: commitment ? Math.round(called / commitment * 1000) / 10 : null, calls };
  };
  app.get("/holdings/:id/capital-calls", async (req, reply) => { try { return void reply.send(await withFamily(fam(req), (c) => callsView(c, fam(req), (req.params as any).id))); } catch (e) { return problem(reply, e); } });

  /** The manager has announced a call: note its amount and due date so a reminder is raised before it. */
  app.post("/holdings/:id/capital-calls", { preHandler: WRITERS }, async (req, reply) => {
    try {
      const b = z.object({ due_date: date, amount: num, note: z.string().max(200).optional() }).parse(req.body ?? {});
      const out = await withFamily(fam(req), async (c) => {
        const v: any = await callsView(c, fam(req), (req.params as any).id);
        if (!v.is_aif) throw new AssetError(422, "Capital calls are for an AIF only");
        if (!(b.amount > 0)) throw new AssetError(422, "Enter the amount of the call");
        const open = v.calls.filter((x: any) => x.status === "expected").reduce((s: number, x: any) => s + x.amount, 0);
        if (v.remaining != null && b.amount + open > v.remaining + 0.5) throw new AssetError(422, `That is more than the commitment still left to call (${r2(v.remaining - open)}).`);
        const id = (await c.query("insert into capital_calls (family_id, holding_id, due_date, amount, note) values ($1,$2,$3,$4,$5) returning id", [fam(req), (req.params as any).id, b.due_date, b.amount, b.note ?? null])).rows[0].id;
        await c.query("insert into audit_log (family_id, user_id, action, table_name, row_id, after) values ($1,$2,'create','capital_calls',$3,$4)", [fam(req), req.user!.id, id, JSON.stringify(b)]);
        return callsView(c, fam(req), (req.params as any).id);
      });
      return void reply.send(out);
    } catch (e) { return problem(reply, e); }
  });

  /** Cancel a call that is no longer due. */
  app.delete("/capital-calls/:id", { preHandler: WRITERS }, async (req, reply) => {
    try {
      const out = await withFamily(fam(req), async (c) => {
        const r = (await c.query("update capital_calls set status='cancelled' where id=$1 and family_id=$2 and status='expected' returning holding_id", [(req.params as any).id, fam(req)])).rows[0];
        if (!r) throw new AssetError(404, "No open call found");
        await c.query("insert into audit_log (family_id, user_id, action, table_name, row_id) values ($1,$2,'cancel','capital_calls',$3)", [fam(req), req.user!.id, (req.params as any).id]);
        return callsView(c, fam(req), r.holding_id);
      });
      return void reply.send(out);
    } catch (e) { return problem(reply, e); }
  });

  /** What the Edit window shows: the holding's details, the extra fields of its type with their values, and every purchase (lot) with whether it can still be changed. */
  app.get("/holdings/:id/edit", async (req, reply) => {
    try {
      const out = await withFamily(fam(req), async (c) => {
        const h = (await c.query("select h.id, h.entity_id, h.bucket, h.quantity, h.avg_cost, i.id instrument_id, i.name, i.type, i.asset_class, i.meta from holdings h join instruments i on i.id=h.instrument_id where h.id=$1 and h.family_id=$2", [(req.params as any).id, fam(req)])).rows[0];
        if (!h) throw new AssetError(404, "Holding not found");
        const at = (await c.query("select code, label, fields from asset_types where category='market' and instrument_type=$1 order by (alloc_class is not distinct from $2 or asset_class is not distinct from $2) desc, sort limit 1", [h.type, h.asset_class])).rows[0];
        const fed = h.type === "mf" || !!(await c.query("select 1 from prices where instrument_id=$1 and source <> 'manual' limit 1", [h.instrument_id])).rowCount;
        const lots = (await c.query("select l.id, l.buy_date::text buy_date, l.quantity, l.remaining_qty, l.unit_cost, l.charges, t.source txn_source from lots l left join investment_txns t on t.id=l.source_txn_id where l.holding_id=$1 order by l.buy_date, l.id", [h.id])).rows.map((l: any) => {
          const sold = Number(l.remaining_qty) + 1e-6 < Number(l.quantity); const imported = !!l.txn_source && l.txn_source !== "manual";
          return { id: l.id, buy_date: l.buy_date, quantity: Number(l.quantity), remaining_qty: Number(l.remaining_qty), unit_cost: Number(l.unit_cost), charges: Number(l.charges), amount: r2(Number(l.quantity) * Number(l.unit_cost)), locked: sold || imported, locked_why: sold ? "Units from this purchase have been sold. The gain is already in the tax records." : imported ? "This purchase came from an imported statement. Correct it by importing again." : null };
        });
        return { id: h.id, name: h.name, type: h.type, bucket: h.bucket, unitless: UNITLESS.has(h.type), name_locked: fed, name_locked_why: fed ? (h.type === "mf" ? "A mutual fund keeps its AMFI name." : "A daily price feed matches this security by its name.") : null, type_label: at?.label ?? h.type, fields: at?.fields ?? [], values: h.meta ?? {}, lots };
      });
      return void reply.send(out);
    } catch (e) { return problem(reply, e); }
  });

  /** Change a holding's details: its bucket, its name (unless a feed matches on it) and the type-specific fields such as a maturity date. The security is shared, so these apply to it everywhere. */
  app.patch("/holdings/:id", { preHandler: WRITERS }, async (req, reply) => {
    try {
      const b = z.object({ name: z.string().min(2).max(120).optional(), bucket: z.enum(["liquidity", "income", "growth"]).optional(), extras: z.record(z.any()).optional() }).parse(req.body ?? {});
      const out = await withFamily(fam(req), async (c) => {
        const h = (await c.query("select h.id, h.instrument_id, h.bucket, i.name, i.type from holdings h join instruments i on i.id=h.instrument_id where h.id=$1 and h.family_id=$2", [(req.params as any).id, fam(req)])).rows[0];
        if (!h) throw new AssetError(404, "Holding not found");
        const changed: any = {};
        if (b.name && b.name.trim() !== h.name) {
          if (h.type === "mf" || (await c.query("select 1 from prices where instrument_id=$1 and source <> 'manual' limit 1", [h.instrument_id])).rowCount) throw new AssetError(409, "This security is matched by name to a price feed, so its name cannot be changed.");
          if ((await c.query("select 1 from instruments where lower(name)=lower($1) and type=$2 and id <> $3", [b.name.trim(), h.type, h.instrument_id])).rowCount) throw new AssetError(409, "Another security already has that name");
          await c.query("update instruments set name=$2 where id=$1", [h.instrument_id, b.name.trim()]); changed.name = b.name.trim();
        }
        if (b.bucket && b.bucket !== h.bucket) { await c.query("update holdings set bucket=$2, updated_at=now() where id=$1", [h.id, b.bucket]); changed.bucket = b.bucket; }
        if (b.extras && Object.keys(b.extras).length) {
          const mat = typeof b.extras.maturity_date === "string" ? b.extras.maturity_date.slice(0, 10) : null;
          if (mat) { const first = (await c.query("select min(buy_date)::text d from lots where holding_id=$1", [h.id])).rows[0]?.d; if (first && mat <= first) throw new AssetError(422, "The maturity date must be after the date you bought it"); }
          const clean = Object.fromEntries(Object.entries(b.extras).filter(([, v]) => v !== "" && v != null));
          await c.query("update instruments set meta = coalesce(meta, '{}'::jsonb) || $2::jsonb where id=$1", [h.instrument_id, JSON.stringify(clean)]); changed.extras = clean;
        }
        if (!Object.keys(changed).length) return { changed: false };
        await c.query("insert into audit_log (family_id, user_id, action, table_name, row_id, before, after) values ($1,$2,'edit','holdings',$3,$4,$5)", [fam(req), req.user!.id, h.id, JSON.stringify({ name: h.name, bucket: h.bucket }), JSON.stringify(changed)]);
        if (["bond", "gsec", "tbill", "sgb"].includes(h.type)) await syncHoldingReceipts(c, fam(req));
        return { changed: true };
      });
      return void reply.send(out);
    } catch (e) { return problem(reply, e); }
  });

  const recompute = (c: any, holdingId: string) => c.query(`update holdings h set quantity = s.q, avg_cost = case when s.q > 0 then s.c / s.q else 0 end, updated_at = now()
     from (select coalesce(sum(remaining_qty),0) q, coalesce(sum(remaining_qty * unit_cost + case when quantity > 0 then charges * remaining_qty / quantity else 0 end),0) c from lots where holding_id=$1) s where h.id=$1`, [holdingId]);
  const lotFor = async (c: any, req: any) => {
    const l = (await c.query("select l.*, l.buy_date::text bd, t.source txn_source, i.type itype, i.name iname from lots l join holdings h on h.id=l.holding_id join instruments i on i.id=h.instrument_id left join investment_txns t on t.id=l.source_txn_id where l.id=$1 and l.family_id=$2", [req.params.id, fam(req)])).rows[0];
    if (!l) throw new AssetError(404, "Purchase not found");
    if (Number(l.remaining_qty) + 1e-6 < Number(l.quantity)) throw new AssetError(409, "Units from this purchase have been sold, and the gain is already in the tax records. It cannot be changed.");
    if (l.txn_source && l.txn_source !== "manual") throw new AssetError(409, "This purchase came from an imported statement. Correct it by importing again.");
    return l;
  };

  /** Correct one purchase: its date, quantity, price and charges (a PMS or AIF: the amount). Only a purchase nothing has been sold from, and not one that came from a statement import. */
  app.patch("/lots/:id", { preHandler: WRITERS }, async (req, reply) => {
    try {
      const b = z.object({ buy_date: date.optional(), quantity: num.optional(), price: num.optional(), amount: num.optional(), charges: num.optional() }).parse(req.body ?? {});
      const out = await withFamily(fam(req), async (c) => {
        const l = await lotFor(c, req);
        const unitless = UNITLESS.has(l.itype);
        const buyDate = b.buy_date ?? l.bd; if (buyDate > new Date().toISOString().slice(0, 10)) throw new AssetError(422, "The date cannot be in the future");
        const charges = b.charges ?? Number(l.charges); if (charges < 0) throw new AssetError(422, "Charges cannot be negative");
        let qty = Number(l.quantity), price = Number(l.unit_cost);
        if (unitless) { if (b.amount != null) { if (!(b.amount > 0)) throw new AssetError(422, "The amount must be above zero"); price = Math.round(b.amount / qty * 1e6) / 1e6; } }
        else {
          qty = b.quantity ?? qty; price = b.price ?? price;
          if (b.amount != null && b.quantity != null && b.price == null && b.quantity > 0) price = b.amount / b.quantity;
          if (!(qty > 0) || !(price > 0)) throw new AssetError(422, "The quantity and the price must be above zero");
        }
        const amount = r2(qty * price);
        const mat = (await c.query("select i.meta->>'maturity_date' m from holdings h join instruments i on i.id=h.instrument_id where h.id=$1", [l.holding_id])).rows[0]?.m;
        if (mat && String(mat).slice(0, 10) <= buyDate) throw new AssetError(422, "The buy date must be before the maturity date");
        await c.query("update lots set buy_date=$2, quantity=$3, remaining_qty=$3, unit_cost=$4, charges=$5 where id=$1", [l.id, buyDate, qty, price, charges]);
        if (l.source_txn_id) await c.query("update investment_txns set txn_date=$2, quantity=$3, price=$4, amount=$5, charges=$6, hash=$7 where id=$1", [l.source_txn_id, buyDate, qty, price, amount, charges, `manual:edit:${l.id}:${Date.now()}`]);
        await recompute(c, l.holding_id);
        await c.query("insert into audit_log (family_id, user_id, action, table_name, row_id, before, after) values ($1,$2,'edit','lots',$3,$4,$5)", [fam(req), req.user!.id, l.id, JSON.stringify({ buy_date: l.bd, quantity: Number(l.quantity), price: Number(l.unit_cost), charges: Number(l.charges) }), JSON.stringify({ buy_date: buyDate, quantity: qty, price, charges })]);
        if (["bond", "gsec", "tbill", "sgb"].includes(l.itype)) await syncHoldingReceipts(c, fam(req));
        const hd = (await c.query("select quantity, avg_cost from holdings where id=$1", [l.holding_id])).rows[0];
        return { units: Number(hd.quantity), avg_cost: Number(hd.avg_cost), amount, note: "Bank balances are not changed by an edit; adjust them on the Banking page if the money moved." };
      });
      return void reply.send(out);
    } catch (e) { return problem(reply, e); }
  });

  /** Remove a wrong purchase. The last purchase of a holding stays: delete the whole holding instead. */
  app.delete("/lots/:id", { preHandler: WRITERS }, async (req, reply) => {
    try {
      const out = await withFamily(fam(req), async (c) => {
        const l = await lotFor(c, req);
        if ((await c.query("select count(*) n from lots where holding_id=$1", [l.holding_id])).rows[0].n <= 1) throw new AssetError(409, "This is the only purchase of the holding. Delete the whole holding instead.");
        await c.query("delete from lots where id=$1", [l.id]);
        if (l.source_txn_id) await c.query("delete from investment_txns where id=$1", [l.source_txn_id]);
        await recompute(c, l.holding_id);
        await c.query("insert into audit_log (family_id, user_id, action, table_name, row_id, before) values ($1,$2,'delete','lots',$3,$4)", [fam(req), req.user!.id, l.id, JSON.stringify({ instrument: l.iname, buy_date: l.bd, quantity: Number(l.quantity), price: Number(l.unit_cost) })]);
        if (["bond", "gsec", "tbill", "sgb"].includes(l.itype)) await syncHoldingReceipts(c, fam(req));
        return { removed: true };
      });
      return void reply.send(out);
    } catch (e) { return problem(reply, e); }
  });

  /** A hand-entered market holding: finds or creates the instrument, then goes through the same lot engine as imports (FIFO lots, holdings, de-duplication). */
  app.post("/assets/market", { preHandler: WRITERS }, async (req, reply) => {
    try {
      const b = z.object({
        type_code: z.string(), entity_id: z.string().uuid(), txn_date: date,
        quantity: num.optional(), price: num.optional(), amount: num.optional(), charges: num.optional(), current_price: num.optional(),
        instrument_id: z.string().uuid().optional(), amfi_code: z.string().regex(/^\d{3,8}$/).optional(),
        instrument: z.object({ name: z.string().min(2).max(160), isin: z.string().regex(/^[A-Z]{2}[A-Z0-9]{9}\d$/i).optional(), symbol: z.string().max(40).optional() }).optional(),
        extras: z.record(z.any()).optional(), bucket: z.enum(["liquidity", "income", "growth"]).optional(), note: z.string().max(200).optional(),
      }).parse(req.body);
      const out = await withFamily(fam(req), async (c) => {
        const at = (await c.query("select * from asset_types where code=$1", [b.type_code])).rows[0];
        if (!at || at.category !== "market") throw new AssetError(422, "That asset type is not a market holding");
        if (!at.enabled) throw new AssetError(422, "That asset type is not available yet");
        if (!(await c.query("select 1 from entities where id=$1 and family_id=$2 and deleted_at is null", [b.entity_id, fam(req)])).rowCount) throw new AssetError(404, "Entity not found");
        const mat = typeof b.extras?.maturity_date === "string" ? b.extras.maturity_date.slice(0, 10) : null;
        if (mat && mat <= b.txn_date) throw new AssetError(422, "The maturity date must be after the date you bought it");
        let instrumentId: string | null = null; let created = false;
        if (b.instrument_id) { instrumentId = (await c.query("select id from instruments where id=$1", [b.instrument_id])).rows[0]?.id ?? null; if (!instrumentId) throw new AssetError(404, "Instrument not found"); }
        else if (at.code === "mf") {
          if (!b.amfi_code) throw new AssetError(422, "Pick the fund from the list");
          const row = (await loadNavAll()).find((r) => r.amfiCode === b.amfi_code); if (!row) throw new AssetError(404, "That scheme is not in the AMFI list");
          created = !(await c.query("select 1 from instruments where amfi_code=$1", [b.amfi_code])).rowCount; instrumentId = await ensureInstrument(c, row);
        } else {
          const i = b.instrument; if (!i) throw new AssetError(422, "Enter the name of the security");
          const ex = (i.isin ? (await c.query("select id from instruments where upper(isin)=upper($1)", [i.isin])).rows[0] : null)
            ?? (i.symbol ? (await c.query("select id from instruments where upper(symbol)=upper($1) and type=$2", [i.symbol, at.instrument_type])).rows[0] : null)
            ?? (await c.query("select id from instruments where lower(name)=lower($1) and type=$2", [i.name, at.instrument_type])).rows[0];
          if (ex) instrumentId = ex.id;
          else {
            instrumentId = (await c.query("insert into instruments (type, isin, symbol, name, exchange, default_bucket, asset_class, alloc_class, meta) values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id",
              [at.instrument_type, i.isin?.toUpperCase() ?? null, i.symbol?.toUpperCase() ?? null, i.name.trim(), i.symbol && ["stock", "etf", "reit"].includes(at.instrument_type) ? "NSE" : null, b.bucket ?? at.default_bucket, at.asset_class, at.code === "nps" ? NPS_ALLOC[String(b.extras?.scheme_choice)] ?? "equity" : at.alloc_class, JSON.stringify(b.extras ?? {})])).rows[0].id; created = true;
          }
        }
        // buying a bond again: the dates typed now (e.g. a new maturity) replace the old ones, so the payment schedule follows this purchase
        if (!created && b.extras && Object.keys(b.extras).length && ["sgb", "bond", "gsec", "tbill"].includes(at.code)) await c.query("update instruments set meta = coalesce(meta, '{}'::jsonb) || $2::jsonb where id=$1", [instrumentId, JSON.stringify(b.extras)]);
        const inst = (await c.query("select id, name, type, isin, amfi_code, symbol, asset_class from instruments where id=$1", [instrumentId])).rows[0];
        let qty = b.quantity, price = b.price, amount = b.amount;
        if (UNITLESS.has(at.code) && qty == null) { qty = 1; price = amount; }
        if (qty == null && amount != null && price) qty = amount / price;
        if (price == null && amount != null && qty) price = amount / qty;
        if (amount == null && qty != null && price != null) amount = r2(qty * price);
        if (!qty || qty <= 0 || !price || price <= 0 || !amount || amount <= 0) throw new AssetError(422, UNITLESS.has(at.code) ? "Enter the amount invested" : "Enter the quantity and the price (or the quantity and the total amount)");
        const ref = `manual:${b.entity_id}:${instrumentId}:buy:${b.txn_date}:${qty}:${amount}`;
        const t: any = { source: "manual", provider: "manual", account: { kind: inst.type === "mf" ? "mf_folio" : "demat", identifier: "MANUAL" }, instrument: { id: inst.id, name: inst.name, isin: inst.isin, amfiCode: inst.amfi_code, symbol: inst.symbol, type: inst.type }, type: "buy", date: b.txn_date, quantity: qty, price, amount, charges: b.charges ?? 0, ref };
        let r: string; try { r = await applyInvestmentTxn(c, fam(req), b.entity_id, t, null); } catch (e: any) { throw new AssetError(422, e.message); }
        if (r === "dup") throw new AssetError(409, "An identical entry is already recorded for this date and amount");
        // the value shown follows a price: a mutual fund takes its latest NAV from AMFI, and a security nobody prices yet takes the current price typed here
        let priceNote: string | null = null;
        if (at.code === "mf") { try { await refreshFundHistory(c, [b.amfi_code!], []); } catch { priceNote = "The latest NAV could not be fetched; the value follows your purchase price until the nightly feed runs."; } }
        else if (b.current_price && b.current_price > 0 && !["gsec", "tbill"].includes(at.code)) {   // a G-Sec or T-bill is valued by the app, so a typed price is not kept
          const has = (await c.query("select 1 from prices where instrument_id=$1 limit 1", [instrumentId])).rowCount;
          if (!has || created) await c.query("insert into prices (instrument_id, price_date, close, source) values ($1, current_date, $2, 'manual') on conflict (instrument_id, price_date) do update set close=excluded.close, source='manual'", [instrumentId, b.current_price]);
          else priceNote = "This security already has a market price, so the typed current price was ignored.";
        }
        const h = (await c.query("select id, quantity, avg_cost from holdings where family_id=$1 and entity_id=$2 and instrument_id=$3 order by updated_at desc limit 1", [fam(req), b.entity_id, instrumentId])).rows[0];
        await c.query("insert into audit_log (family_id, user_id, action, table_name, row_id, after) values ($1,$2,'create','holdings',$3,$4)", [fam(req), req.user!.id, h?.id ?? null, JSON.stringify({ via: "add_asset", type: at.code, instrument: inst.name, amount, note: b.note ?? null })]);
        // a bond, G-Sec, SGB or T-bill: lay out its expected interest and maturity payments now
        let scheduled = 0;
        if (RECEIPT_TYPES.includes(inst.type)) { await syncHoldingReceipts(c, fam(req)); scheduled = h ? Number((await c.query("select count(*) n from holding_receipts where holding_id=$1 and status in ('expected','overdue')", [h.id])).rows[0].n) : 0; }
        return { instrument: { id: inst.id, name: inst.name, type: inst.type, created }, holding: h ? { id: h.id, quantity: Number(h.quantity), avg_cost: Number(h.avg_cost) } : null, amount: money(amount), note: priceNote, scheduled };
      });
      return void reply.code(201).send(out);
    } catch (e) { return problem(reply, e); }
  });
}
