/** Fixed & recurring deposits — "Add Asset" step 1 (roadmap item, agreed scope): manual entry only, generates its
 *  expected-receipts schedule on save (deposit_receipts), same pattern as leases -> rent_schedule. Bank-statement
 *  matching, GL posting rules and TDS reconciliation are later steps, deliberately not part of this file. */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireFamily, requireRole } from "../lib/auth.js";
import { syncOutflows } from "../lib/balance.js";
import { generateTasksFor } from "../jobs/tasks.js";
import { withFamily, money } from "../lib/db.js";
import { generateDepositSchedule, depositCurrentValue, interestSettled, estimateForeclosure, foreclosureEligibility } from "@fo/finance";

const iso = (d: any) => (d ? new Date(d).toISOString().slice(0, 10) : null);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const moneyIn = z.union([z.number(), z.string()]).transform((v) => Number(v));
const WRITERS = requireRole("owner", "member", "operator");

const DEPOSIT_INPUT = z.object({
  entity_id: z.string().uuid(), kind: z.enum(["fd", "rd"]), type_code: z.string().min(1).optional(), bank: z.string().min(1), account_no: z.string().optional(),
  bucket: z.enum(["liquidity", "income", "growth"]).default("liquidity"), rate_pct: moneyIn,
  start_date: date, maturity_date: date.optional(), tenure_months: z.number().int().positive().optional(),
  principal: moneyIn.optional(), installment_amount: moneyIn.optional(),
  payout_frequency: z.enum(["monthly", "quarterly", "at_maturity"]).default("at_maturity"),
  payout_bank_account_id: z.string().uuid().optional(), tds_applicable: z.boolean().default(true),
});

// dates are selected as text: the pg driver turns a date column into a local-midnight Date that toISOString() then shifts back a day
const DEPOSIT_SQL = `select d.*, d.start_date::text as start_date, d.maturity_date::text as maturity_date, d.closed_on::text as closed_on, e.name as entity_name, b.bank||' '||b.account_masked as payout_account_name,
  t.label as type_label, t.description as type_description, t.break_rule, t.lock_in_months, t.default_penalty_pct, t.partial_withdrawal from deposits d
  join deposit_types t on t.code=d.type_code join entities e on e.id=d.entity_id left join bank_accounts b on b.id=d.payout_bank_account_id`;

// an rd's maturity date is derived from its own tenure, not independently settable, so the two can never disagree
function rdMaturity(start: string, tenureMonths: number) { const [y, m, d] = start.split("-").map(Number); const total = m - 1 + tenureMonths; const ny = y + Math.floor(total / 12); const nm = (total % 12) + 1; return `${ny}-${String(nm).padStart(2, "0")}-${String(d).padStart(2, "0")}`; }

/** Money is "locked in" once any amount is recorded against a receipt or any of its rows is posted to Books. Posted journals are
 *  immutable, so past that point the amounts, rate and dates can no longer be edited and the deposit can no longer be deleted. */
async function lockInfo(c: any, depositId: string): Promise<{ locked: boolean; reason: string | null }> {
  if ((await c.query("select 1 from deposit_receipts where deposit_id=$1 and received_amount > 0 limit 1", [depositId])).rowCount) return { locked: true, reason: "money has already been recorded against it (a receipt or instalment was marked received/paid)" };
  if ((await c.query("select 1 from gl_journals where source_id in (select id from deposit_receipts where deposit_id=$1) limit 1", [depositId])).rowCount) return { locked: true, reason: "its entries are already posted to Books" };
  return { locked: false, reason: null };
}

/** The chosen type must exist, match the kind (fd/rd) and respect its tenure limits. Returns an error message, or null when fine. */
async function checkType(c: any, code: string, kind: string, startDate: string, maturityDate: string): Promise<string | null> {
  const t = (await c.query("select * from deposit_types where code=$1", [code])).rows[0];
  if (!t) return "Unknown deposit type";
  if (t.kind !== kind) return `${t.label} is a ${t.kind === "fd" ? "fixed" : "recurring"} deposit type, so it cannot be used for a ${kind === "fd" ? "fixed" : "recurring"} deposit`;
  const months = (Number(maturityDate.slice(0, 4)) - Number(startDate.slice(0, 4))) * 12 + Number(maturityDate.slice(5, 7)) - Number(startDate.slice(5, 7)) - (Number(maturityDate.slice(8, 10)) < Number(startDate.slice(8, 10)) ? 1 : 0);
  if (t.min_tenure_months != null && months < t.min_tenure_months) return `${t.label} needs a tenure of at least ${t.min_tenure_months} months (this one is ${months})`;
  if (t.max_tenure_months != null && months > t.max_tenure_months) return `${t.label} allows a tenure of at most ${t.max_tenure_months} months (this one is ${months})`;
  return null;
}

async function writeSchedule(c: any, fam: string, depositId: string, terms: Parameters<typeof generateDepositSchedule>[0]) {
  const schedule = generateDepositSchedule(terms);
  for (const s of schedule) await c.query("insert into deposit_receipts (family_id, deposit_id, kind, due_date, expected_amount, status) values ($1,$2,$3,$4,$5, case when $4::date < current_date then 'overdue'::text else 'expected'::text end)", [fam, depositId, s.kind, s.dueDate, s.expectedAmount]);
  return schedule.length;
}

async function depositView(c: any, row: any) {
  const lock = await lockInfo(c, row.id);
  const receipts = (await c.query("select r.*, r.due_date::text as due_date, r.received_on::text as received_on from deposit_receipts r where r.deposit_id=$1 order by r.due_date", [row.id])).rows
    .map((r: any) => ({ ...r, due_date: iso(r.due_date), received_on: iso(r.received_on), expected_amount: money(r.expected_amount), received_amount: money(r.received_amount) }));
  const maturityRow = receipts.find((r: any) => r.kind === "maturity");
  const maturityAmount = maturityRow ? Number(maturityRow.expected_amount) : Number(row.principal ?? 0);
  const today = new Date().toISOString().slice(0, 10);
  const startDate = iso(row.start_date)!, maturityDate = iso(row.maturity_date)!;
  const fc = receipts.find((r: any) => r.kind === "foreclosure");
  const foreclose = row.status === "active" ? foreclosureEligibility({ break_rule: row.break_rule, lock_in_months: row.lock_in_months, label: row.type_label }, startDate, today) : null;
  // What the closure cost and where the money went. The penalty is not paid to anyone: it is interest the bank does not pay (the gap between the
  // contracted rate and the reduced rate); the only amount that goes to the government is tax the bank deducted (TDS). Worked out from the stored
  // closure inputs, so it needs no extra columns and stays right if the estimate method is refined.
  let summary: any = null;
  if (row.status === "premature_closed" && fc && row.closed_on) {
    const closeDate: string = row.closed_on; const penalty = row.closure_penalty_pct == null ? 0 : Number(row.closure_penalty_pct);
    const contributions = receipts.filter((r: any) => r.kind === "contribution" && Number(r.received_amount) > 0 && r.due_date <= closeDate).map((r: any) => ({ a: Number(r.received_amount), on: r.received_on ?? r.due_date }));
    const interestPaid = receipts.filter((r: any) => r.kind === "interest" && r.due_date <= closeDate && Number(r.received_amount) > 0).reduce((t: number, r: any) => t + (r.status === "received" ? Number(r.expected_amount) : Number(r.received_amount)), 0);
    const inputs = { kind: row.kind, startDate, closeDate, ratePct: Number(row.rate_pct), principal: row.principal == null ? undefined : Number(row.principal), payoutFrequency: row.payout_frequency, contributions, interestAlreadyPaid: row.kind === "fd" && row.payout_frequency !== "at_maturity" ? interestPaid : 0 };
    const est = estimateForeclosure({ ...inputs, penaltyPct: penalty }), full = estimateForeclosure({ ...inputs, penaltyPct: 0 });
    const credited = Number(fc.received_amount) > 0 ? Number(fc.received_amount) : Number(fc.expected_amount); const tds = Number(fc.tds_component ?? 0); const principalReturned = Number(fc.principal_component ?? est.principalReturned);
    summary = { principal_returned: money(principalReturned), credited: money(credited), credited_is_confirmed: Number(fc.received_amount) > 0, tds_deducted: money(tds), interest_in_credit: money(credited + tds - principalReturned),
      penalty_pct: penalty, interest_at_full_rate: money(full.interest), interest_at_reduced_rate: money(est.interest), penalty_cost_estimate: money(est.penaltyCost), estimated_credit: money(est.estimatedCredit), credit_at_full_rate: money(full.estimatedCredit), shortfall_vs_full_rate: money(full.estimatedCredit - (credited + tds)), days_run: est.daysRun };
  }
  let proofDocs: any[] = [], categoryLabel: string | null = null;
  if (row.status === "premature_closed" && row.closure_exception_category) {
    categoryLabel = (await c.query("select label from deposit_exception_categories where code=$1", [row.closure_exception_category])).rows[0]?.label ?? null;
    proofDocs = (await c.query(`select d.id, d.name, substr(d.doc_type, 11) as doc_code, x.label from documents d left join deposit_exception_docs x on x.category_code=$2 and x.doc_code=substr(d.doc_type, 11)
        where d.linked_type='deposit' and d.linked_id=$1 and d.deleted_at is null and d.doc_type like 'exception:%' order by d.created_at`, [row.id, row.closure_exception_category])).rows;
  }
  const closure = row.status === "premature_closed" ? { closed_on: row.closed_on, penalty_pct: row.closure_penalty_pct == null ? null : Number(row.closure_penalty_pct), reason: row.closure_reason ?? row.closure_exception_reason, exception_reason: row.closure_exception_reason, exception_category: row.closure_exception_category ?? null, exception_category_label: categoryLabel, documents: proofDocs,
    credit_receipt_id: fc?.id ?? null, expected_amount: fc?.expected_amount ?? null, received_amount: fc?.received_amount ?? null, credit_status: fc?.status ?? null, verified_by_statement: !!fc?.bank_txn_ref, summary } : null;
  return { ...row, foreclose, closure, start_date: startDate, maturity_date: maturityDate, principal: row.principal == null ? null : money(row.principal),
    installment_amount: row.installment_amount == null ? null : money(row.installment_amount), rate_pct: Number(row.rate_pct),
    current_value: money(depositCurrentValue({ kind: row.kind, principal: row.principal, startDate, maturityDate, ratePct: Number(row.rate_pct), paid: receipts.filter((r: any) => r.kind === "contribution" && Number(r.received_amount) > 0).map((r: any) => ({ a: r.received_amount, on: r.received_on ?? r.due_date })) }, maturityAmount, today)), maturity_value: money(maturityAmount), matured_on: row.status === "closed" ? (maturityRow?.received_on ?? null) : null, maturity_receipt_id: row.status === "active" && maturityRow && maturityRow.status !== "received" ? maturityRow.id : null, days_to_maturity: Math.round((Date.parse(maturityDate) - Date.parse(today)) / 86400000), receipts, locked: lock.locked, locked_reason: lock.reason };
}

export default async function routes(app: FastifyInstance) {
  app.addHook("preHandler", requireFamily);
  /** The bank-exception categories and the proof each one needs (same for every family). */
  app.get("/deposit-exception-categories", async (req) => withFamily(req.family!.familyId, async (c) => {
    const cats = (await c.query("select code, label, description, default_penalty_pct::float as default_penalty_pct from deposit_exception_categories order by sort")).rows;
    const docs = (await c.query("select category_code, doc_code, label, required from deposit_exception_docs order by category_code, sort")).rows;
    return cats.map((k: any) => ({ ...k, docs: docs.filter((d: any) => d.category_code === k.code).map((d: any) => ({ doc_code: d.doc_code, label: d.label, required: d.required })) }));
  }));
  /** The proofs already uploaded against a deposit for a bank-exception closure (uploaded through POST /documents with linked_type=deposit and doc_type=exception:<doc_code>). */
  app.get("/deposits/:id/exception-documents", async (req) => withFamily(req.family!.familyId, async (c) => (await c.query("select d.id, d.name, substr(d.doc_type, 11) as doc_code, d.created_at from documents d where d.family_id=$1 and d.linked_type='deposit' and d.linked_id=$2 and d.deleted_at is null and d.doc_type like 'exception:%' order by d.created_at", [req.family!.familyId, (req.params as any).id])).rows));
  /** The reference list behind the Type dropdown (same for every family). */
  app.get("/deposit-types", async (req) => withFamily(req.family!.familyId, async (c) => (await c.query("select code, kind, label, description, break_rule, lock_in_months, default_penalty_pct::float as default_penalty_pct, default_payout, default_tds, min_tenure_months, max_tenure_months, partial_withdrawal from deposit_types order by kind, sort")).rows));
  app.get("/deposits", async (req) => withFamily(req.family!.familyId, async (c) => {
    const rows = (await c.query(`${DEPOSIT_SQL} where d.family_id=$1 and (d.status='active' or ($2::boolean and d.status in ('premature_closed','closed'))) order by d.status, d.maturity_date`, [req.family!.familyId, (req.query as any)?.status === "all"])).rows;
    const out = []; for (const r of rows) out.push(await depositView(c, r)); return out;
  }));
  app.get("/deposits/:id", async (req, reply) => withFamily(req.family!.familyId, async (c) => {
    const row = (await c.query(`${DEPOSIT_SQL} where d.id=$1 and d.family_id=$2`, [(req.params as any).id, req.family!.familyId])).rows[0];
    if (!row) return void reply.code(404).send({ title: "Deposit not found", status: 404 });
    return depositView(c, row);
  }));
  /** Record a receipt by hand — same rules as /rent-schedule/:id/receive: short amounts stay partial, a full
   *  receipt closes the overdue reminder task. Bank-statement auto-matching is a later step. */
  app.post("/deposit-receipts/:id/receive", { preHandler: WRITERS }, async (req, reply) => {
    const b = z.object({ amount: moneyIn, received_on: date.optional(), adjust_balance: z.boolean().default(true) }).parse(req.body ?? {});
    return withFamily(req.family!.familyId, async (c) => {
      const id = (req.params as any).id; const fam = req.family!.familyId;
      const row = (await c.query("select r.*, d.tds_applicable, d.payout_bank_account_id from deposit_receipts r join deposits d on d.id=r.deposit_id where r.id=$1", [id])).rows[0];
      if (!row) return void reply.code(404).send({ title: "Receipt not found", status: 404 });
      if (row.status === "received") return void reply.code(409).send({ title: "Already recorded as received", status: 409 });
      const total = row.kind === "foreclosure" ? b.amount : Number(row.received_amount) + b.amount;
      const expected = Number(row.expected_amount);
      const done = row.kind === "interest" ? interestSettled(expected, total, row.tds_applicable) : row.kind === "foreclosure" ? total > 0 : total + 0.5 >= expected;
      const status = done ? "received" : total > 0 ? "partial" : row.status;
      const on = b.received_on ?? new Date().toISOString().slice(0, 10);
      await c.query("update deposit_receipts set received_amount=$2, received_on=$3, status=$4 where id=$1", [id, total, on, status]);
      // by hand the cash moves in our records only: interest and maturity credit the linked account, an instalment debits it.
      // (A later statement import sets the balance from the bank's own closing figure, so this can never compound.)
      let balanceNote: string | null = null;
      if (row.bank_txn_ref && b.adjust_balance) balanceNote = "The bank statement already set the balance, so it is unchanged";
      else if (b.adjust_balance && row.payout_bank_account_id) {
        const delta = row.kind === "contribution" ? -b.amount : b.amount;
        await c.query("update bank_accounts set balance = balance + $2 where id=$1", [row.payout_bank_account_id, delta]);
        balanceNote = `${delta < 0 ? "Deducted from" : "Added to"} the linked bank balance`;
      } else if (b.adjust_balance) balanceNote = "No payout bank account is linked to this deposit, so net worth is unchanged";
      if (status === "received") {
        await c.query("update tasks set status='done', done_at=now() where family_id=$1 and status='open' and source_type='deposit_receipt' and source_id=$2", [fam, id]);
        // the maturity payout ends the deposit: its value leaves net worth as the cash arrives
        if (row.kind === "maturity") await c.query("update deposits set status='closed', updated_at=now() where id=$1", [row.deposit_id]);
      }
      await syncOutflows(c, fam); await generateTasksFor(c, fam);
      await c.query("insert into audit_log (family_id, user_id, action, table_name, row_id, after) values ($1,$2,'receive','deposit_receipts',$3,$4)", [fam, req.user!.id, id, JSON.stringify({ ...b, status, total })]);
      return { ...(await depositView(c, (await c.query(`${DEPOSIT_SQL} where d.id=$1`, [row.deposit_id])).rows[0])), balance_note: balanceNote };
    });
  });
  /** Everything the Foreclose window and the estimate need, read once: the deposit, what has been paid so far, and whether its type allows closing on that date. */
  async function foreclosureFacts(c: any, fam: string, id: string, closeDate: string, penaltyPct: number | null) {
    const dep = (await c.query(`${DEPOSIT_SQL} where d.id=$1 and d.family_id=$2`, [id, fam])).rows[0];
    if (!dep) return { error: { code: 404, title: "Deposit not found" } } as const;
    if (dep.status !== "active") return { error: { code: 409, title: "This deposit is not active, so it cannot be closed early" } } as const;
    if (closeDate < dep.start_date) return { error: { code: 422, title: "The closure date cannot be before the start date" } } as const;
    if (closeDate >= dep.maturity_date) return { error: { code: 422, title: "The closure date is on or after the maturity date: that is a maturity, not an early closure" } } as const;
    const today = new Date().toISOString().slice(0, 10);
    if (closeDate > today) return { error: { code: 422, title: "The closure date cannot be in the future" } } as const;
    const rows = (await c.query("select r.*, r.due_date::text as due_date, r.received_on::text as received_on from deposit_receipts r where r.deposit_id=$1 order by r.due_date", [id])).rows;
    const interestPaid = rows.filter((r: any) => r.kind === "interest" && r.due_date <= closeDate && Number(r.received_amount) > 0).reduce((t: number, r: any) => t + (r.status === "received" ? Number(r.expected_amount) : Number(r.received_amount)), 0);
    const contributions = rows.filter((r: any) => r.kind === "contribution" && Number(r.received_amount) > 0 && r.due_date <= closeDate).map((r: any) => ({ a: Number(r.received_amount), on: r.received_on ?? r.due_date }));
    const penalty = penaltyPct ?? Number(dep.default_penalty_pct);
    const eligibility = foreclosureEligibility({ break_rule: dep.break_rule, lock_in_months: dep.lock_in_months, label: dep.type_label }, dep.start_date, closeDate);
    const estimate = estimateForeclosure({ kind: dep.kind, startDate: dep.start_date, closeDate, ratePct: Number(dep.rate_pct), penaltyPct: penalty, principal: dep.principal == null ? undefined : Number(dep.principal), payoutFrequency: dep.payout_frequency, contributions, interestAlreadyPaid: dep.kind === "fd" && dep.payout_frequency !== "at_maturity" ? interestPaid : 0 });
    return { error: null, dep, rows, penalty, eligibility, estimate, interestPaid, contributions, today };
  }
  app.get("/deposits/:id/foreclosure-estimate", async (req, reply) => {
    const q = z.object({ date: date.optional(), penalty: moneyIn.optional() }).parse(req.query ?? {});
    return withFamily(req.family!.familyId, async (c) => {
      const f = await foreclosureFacts(c, req.family!.familyId, (req.params as any).id, q.date ?? new Date().toISOString().slice(0, 10), q.penalty ?? null);
      if (f.error) return void reply.code(f.error.code).send({ title: f.error.title, status: f.error.code });
      return { close_date: q.date ?? f.today, penalty_pct: f.penalty, eligibility: f.eligibility, estimate: f.estimate, principal_returned: f.estimate.principalReturned, note: "An estimate only: the bank works from its own rate card for the period the deposit ran. Enter what the bank actually credits." };
    });
  });
  /** Foreclose (close before maturity). Records the closure date, penalty and the amount the bank is crediting; the credit itself is a receipt that stays
   *  expected until the bank statement shows it (or it is confirmed by hand). Future rows are removed, interest due up to the closure that was never
   *  received is settled by the payout (cancelled), and the type's rule is enforced — a locked type needs an owner and a written reason. */
  app.post("/deposits/:id/foreclose", { preHandler: WRITERS }, async (req, reply) => {
    const b = z.object({ closure_date: date, penalty_pct: moneyIn.optional(), amount: moneyIn, tds_deducted: moneyIn.default(0), bank_agreed: z.boolean().optional(), exception_category: z.string().optional(), reason: z.string().trim().min(5).max(300).optional(), exception_reason: z.string().trim().min(5).max(300).optional(), payout_bank_account_id: z.string().uuid().optional() }).parse(req.body ?? {});
    if (!(b.amount > 0)) return void reply.code(422).send({ title: "Enter the amount the bank is crediting for the closure", status: 422 });
    // closing a deposit early is a deliberate act: whoever does it says why (for a locked type this same text is the bank-exception reason)
    const reason = b.reason ?? b.exception_reason;
    if (!reason) return void reply.code(422).send({ title: "Say why this deposit is being closed early (at least 5 characters)", status: 422 });
    return withFamily(req.family!.familyId, async (c) => {
      const fam = req.family!.familyId; const id = (req.params as any).id;
      const f = await foreclosureFacts(c, fam, id, b.closure_date, b.penalty_pct ?? null);
      if (f.error) return void reply.code(f.error.code).send({ title: f.error.title, status: f.error.code });
      const { dep, rows, eligibility, estimate } = f;
      let exceptionCategory: string | null = null;
      if (!eligibility.allowed) {
        if (req.family!.role !== "owner") return void reply.code(403).send({ title: eligibility.reason + ". Only an owner can record it as a bank exception.", status: 403 });
        if (!b.bank_agreed) return void reply.code(422).send({ title: eligibility.reason + ". Confirm that the bank has actually agreed to close it before recording a bank exception.", status: 422 });
        if (reason.length < 15) return void reply.code(422).send({ title: eligibility.reason + ". To record it anyway as a bank exception, explain the reason in a sentence (for example the death of the holder, a court order, or the bank agreeing in writing).", status: 422 });
        // the proof the category needs must already be uploaded against this deposit
        const cat = b.exception_category ? (await c.query("select code, label from deposit_exception_categories where code=$1", [b.exception_category])).rows[0] : null;
        if (!cat) return void reply.code(422).send({ title: "Choose the exception category (for example death of the holder, a court order, or the bank's written approval)", status: 422 });
        const needed = (await c.query("select doc_code, label from deposit_exception_docs where category_code=$1 and required order by sort", [cat.code])).rows;
        const have = new Set((await c.query("select substr(doc_type, 11) as code from documents where family_id=$1 and linked_type='deposit' and linked_id=$2 and deleted_at is null and doc_type like 'exception:%'", [fam, id])).rows.map((r: any) => r.code as string));
        const missing = needed.filter((r: any) => !have.has(r.doc_code));
        if (missing.length) return void reply.code(422).send({ title: "Upload the required proof first: " + missing.map((m: any) => m.label).join("; "), status: 422 });
        exceptionCategory = cat.code;
      }
      if (b.payout_bank_account_id && !(await c.query("select 1 from bank_accounts where id=$1 and family_id=$2 and deleted_at is null", [b.payout_bank_account_id, fam])).rowCount) return void reply.code(404).send({ title: "Bank account not found", status: 404 });
      // rows after the closure date must be untouched: no money recorded, and no interest booked to the ledger for them
      if (rows.some((r: any) => r.due_date > b.closure_date && Number(r.received_amount) > 0)) return void reply.code(409).send({ title: "A payment after the closure date has already been recorded against this deposit, so it cannot be closed on that date", status: 409 });
      const booked = (await c.query("select max(r.due_date)::text d from deposit_receipts r where r.deposit_id=$1 and r.kind='interest' and exists (select 1 from gl_journals j where j.source_type='deposit_receipt' and j.source_id=r.id)", [id])).rows[0]?.d as string | null;
      if (booked && booked > b.closure_date) return void reply.code(409).send({ title: `Interest up to ${booked} is already posted to Books, so the closure date cannot be earlier than that`, status: 409 });
      const principal = dep.kind === "fd" ? Number(dep.principal ?? 0) : estimate.principalReturned;
      const afterIds = rows.filter((r: any) => r.due_date > b.closure_date).map((r: any) => r.id);
      const unpaidContribIds = rows.filter((r: any) => r.kind === "contribution" && r.due_date <= b.closure_date && Number(r.received_amount) === 0).map((r: any) => r.id);
      const settleIds = rows.filter((r: any) => r.kind === "interest" && r.due_date <= b.closure_date && ["expected", "overdue"].includes(r.status)).map((r: any) => r.id);
      const gone = [...afterIds, ...unpaidContribIds];
      if (gone.length) {
        await c.query("delete from tasks where source_type='deposit_receipt' and source_id = any($1::uuid[])", [gone]);
        await c.query("delete from gl_unposted where source_id = any($1::uuid[])", [gone]);
        await c.query("delete from deposit_receipts where id = any($1::uuid[])", [gone]);
      }
      if (settleIds.length) {
        await c.query("update deposit_receipts set status='cancelled' where id = any($1::uuid[])", [settleIds]);
        await c.query("update tasks set status='done', done_at=now() where family_id=$1 and status='open' and source_type='deposit_receipt' and source_id = any($2::uuid[])", [fam, settleIds]);
      }
      const credit = (await c.query("insert into deposit_receipts (family_id, deposit_id, kind, due_date, expected_amount, status, principal_component, tds_component) values ($1,$2,'foreclosure',$3,$4,'expected',$5,$6) returning id", [fam, id, b.closure_date, b.amount, principal, b.tds_deducted])).rows[0];
      await c.query("update deposits set status='premature_closed', closed_on=$2, closure_penalty_pct=$3, closure_exception_reason=$4, closed_by=$5, payout_bank_account_id=coalesce($6, payout_bank_account_id), closure_reason=$7, closure_exception_category=$8, updated_at=now() where id=$1", [id, b.closure_date, f.penalty, eligibility.allowed ? null : reason, req.user!.id, b.payout_bank_account_id ?? null, reason, exceptionCategory]);
      await syncOutflows(c, fam);
      await c.query("insert into audit_log (family_id, user_id, action, table_name, row_id, before, after) values ($1,$2,'foreclose','deposits',$3,$4,$5)", [fam, req.user!.id, id, JSON.stringify({ status: "active", maturity_date: dep.maturity_date }), JSON.stringify({ closure_date: b.closure_date, penalty_pct: f.penalty, amount: b.amount, tds_deducted: b.tds_deducted, reason, exception: eligibility.allowed ? null : reason, exception_category: exceptionCategory, estimate: estimate.estimatedCredit, rows_removed: gone.length, interest_rows_settled: settleIds.length, credit_receipt: credit.id })]);
      return { ...(await depositView(c, (await c.query(`${DEPOSIT_SQL} where d.id=$1`, [id])).rows[0])), estimate, rows_removed: gone.length, unpaid_instalments_dropped: unpaidContribIds.length, interest_rows_settled: settleIds.length };
    });
  });
  /** Edit. Labels (bank, account no., bucket, payout account, TDS) are always editable. Terms (amounts, rate, dates, frequency,
   *  tenure) only until money is recorded or posted — then the schedule is rebuilt from the new terms. */
  app.patch("/deposits/:id", { preHandler: WRITERS }, async (req, reply) => {
    const b = z.object({
      type_code: z.string().min(1).optional(), bank: z.string().min(1).optional(), account_no: z.string().nullable().optional(), bucket: z.enum(["liquidity", "income", "growth"]).optional(),
      payout_bank_account_id: z.string().uuid().nullable().optional(), tds_applicable: z.boolean().optional(),
      rate_pct: moneyIn.optional(), start_date: date.optional(), maturity_date: date.optional(), tenure_months: z.number().int().positive().optional(),
      principal: moneyIn.optional(), installment_amount: moneyIn.optional(), payout_frequency: z.enum(["monthly", "quarterly", "at_maturity"]).optional(),
    }).parse(req.body ?? {});
    return withFamily(req.family!.familyId, async (c) => {
      const fam = req.family!.familyId; const id = (req.params as any).id;
      const cur = (await c.query(`${DEPOSIT_SQL} where d.id=$1 and d.family_id=$2`, [id, fam])).rows[0];
      if (!cur) return void reply.code(404).send({ title: "Deposit not found", status: 404 });
      const m: any = { ...cur, ...Object.fromEntries(Object.entries(b).filter(([, v]) => v !== undefined)) };
      if (cur.kind === "rd") { m.maturity_date = rdMaturity(m.start_date, Number(m.tenure_months)); m.payout_frequency = "at_maturity"; }
      const termsChanged = Number(m.rate_pct) !== Number(cur.rate_pct) || m.start_date !== cur.start_date || m.maturity_date !== cur.maturity_date
        || Number(m.principal ?? 0) !== Number(cur.principal ?? 0) || Number(m.installment_amount ?? 0) !== Number(cur.installment_amount ?? 0)
        || Number(m.tenure_months ?? 0) !== Number(cur.tenure_months ?? 0) || m.payout_frequency !== cur.payout_frequency;
      if (cur.status !== "active" && (termsChanged || m.type_code !== cur.type_code)) return void reply.code(409).send({ title: "This deposit has been closed, so its terms and type can no longer be changed", status: 409 });
      if (termsChanged) {
        const lock = await lockInfo(c, id);
        if (lock.locked) return void reply.code(409).send({ title: `The amounts, rate and dates can no longer be changed because ${lock.reason}. You can still change the bank, account number, bucket, payout account and TDS.`, status: 409 });
        if (cur.kind === "fd" && (!Number(m.principal) || m.maturity_date <= m.start_date)) return void reply.code(422).send({ title: "A fixed deposit needs a principal and a maturity date after the start date", status: 422 });
        if (cur.kind === "rd" && (!Number(m.installment_amount) || !Number(m.tenure_months))) return void reply.code(422).send({ title: "A recurring deposit needs an instalment amount and a tenure", status: 422 });
      }
      // the type decides whether the deposit may be broken early, so it cannot be swapped once money is recorded against it
      if (m.type_code !== cur.type_code || termsChanged) {
        if (m.type_code !== cur.type_code) { const lock = await lockInfo(c, id); if (lock.locked) return void reply.code(409).send({ title: `The deposit type can no longer be changed because ${lock.reason}.`, status: 409 }); }
        const bad = await checkType(c, m.type_code, cur.kind, m.start_date, m.maturity_date); if (bad) return void reply.code(422).send({ title: bad, status: 422 });
      }
      if (b.payout_bank_account_id && !(await c.query("select 1 from bank_accounts where id=$1 and family_id=$2 and deleted_at is null", [b.payout_bank_account_id, fam])).rowCount) return void reply.code(404).send({ title: "Bank account not found", status: 404 });
      await c.query(`update deposits set bank=$2, account_no=$3, bucket=$4, payout_bank_account_id=$5, tds_applicable=$6, rate_pct=$7, start_date=$8, maturity_date=$9, tenure_months=$10, principal=$11, installment_amount=$12, payout_frequency=$13, type_code=$14, updated_at=now() where id=$1`,
        [id, m.bank, m.account_no ?? null, m.bucket, m.payout_bank_account_id ?? null, m.tds_applicable, m.rate_pct, m.start_date, m.maturity_date, m.tenure_months ?? null, m.principal ?? null, m.installment_amount ?? null, m.payout_frequency, m.type_code]);
      let rows: number | null = null;
      if (termsChanged) {
        const ids = `select id from deposit_receipts where deposit_id=$1`;
        await c.query(`delete from tasks where source_type='deposit_receipt' and source_id in (${ids})`, [id]);
        await c.query(`delete from gl_unposted where source_id in (${ids})`, [id]);
        await c.query("delete from deposit_receipts where deposit_id=$1", [id]);
        rows = await writeSchedule(c, fam, id, { kind: cur.kind, startDate: m.start_date, maturityDate: m.maturity_date, ratePct: Number(m.rate_pct), principal: m.principal == null ? undefined : Number(m.principal), installmentAmount: m.installment_amount == null ? undefined : Number(m.installment_amount), tenureMonths: m.tenure_months == null ? undefined : Number(m.tenure_months), payoutFrequency: m.payout_frequency });
      }
      if (termsChanged) await syncOutflows(c, fam); await generateTasksFor(c, fam);
      await c.query("insert into audit_log (family_id, user_id, action, table_name, row_id, before, after) values ($1,$2,'update','deposits',$3,$4,$5)", [fam, req.user!.id, id, JSON.stringify({ bank: cur.bank, account_no: cur.account_no, rate_pct: cur.rate_pct, principal: cur.principal, installment_amount: cur.installment_amount, start_date: cur.start_date, maturity_date: cur.maturity_date }), JSON.stringify({ ...b, schedule_rebuilt: termsChanged, schedule_rows: rows })]);
      return depositView(c, (await c.query(`${DEPOSIT_SQL} where d.id=$1`, [id])).rows[0]);
    });
  });
  /** Delete — only while nothing has been recorded or posted, so Books can never be left pointing at a deposit that is gone. */
  app.delete("/deposits/:id", { preHandler: WRITERS }, async (req, reply) => withFamily(req.family!.familyId, async (c) => {
    const fam = req.family!.familyId; const id = (req.params as any).id;
    const cur = (await c.query("select id, bank, account_no, kind, status from deposits where id=$1 and family_id=$2", [id, fam])).rows[0];
    if (!cur) return void reply.code(404).send({ title: "Deposit not found", status: 404 });
    if (cur.status !== "active") return void reply.code(409).send({ title: "A closed deposit cannot be deleted: its closure is part of the record", status: 409 });
    const lock = await lockInfo(c, id);
    if (lock.locked) return void reply.code(409).send({ title: `This deposit can't be deleted because ${lock.reason}.`, status: 409 });
    const ids = `select id from deposit_receipts where deposit_id=$1`;
    await c.query(`delete from tasks where source_type='deposit_receipt' and source_id in (${ids})`, [id]);
    await c.query(`delete from gl_unposted where source_id in (${ids})`, [id]);
    await c.query("delete from deposits where id=$1", [id]);
    await syncOutflows(c, fam);
    await c.query("insert into audit_log (family_id, user_id, action, table_name, row_id, before) values ($1,$2,'delete','deposits',$3,$4)", [fam, req.user!.id, id, JSON.stringify(cur)]);
    return { deleted: true, id };
  }));
  app.post("/deposits", { preHandler: WRITERS }, async (req, reply) => {
    const b = DEPOSIT_INPUT.parse(req.body);
    if (b.kind === "fd" && !b.principal) return void reply.code(422).send({ title: "A fixed deposit needs a principal amount", status: 422 });
    if (b.kind === "fd" && !b.maturity_date) return void reply.code(422).send({ title: "A fixed deposit needs a maturity date", status: 422 });
    if (b.kind === "rd" && !b.installment_amount) return void reply.code(422).send({ title: "A recurring deposit needs a monthly instalment amount", status: 422 });
    if (b.kind === "rd" && !b.tenure_months) return void reply.code(422).send({ title: "A recurring deposit needs its tenure in months", status: 422 });
    return withFamily(req.family!.familyId, async (c) => {
      const fam = req.family!.familyId;
      if (!(await c.query("select 1 from entities where id=$1 and family_id=$2 and deleted_at is null", [b.entity_id, fam])).rowCount) return void reply.code(404).send({ title: "Entity not found", status: 404 });
      const maturityDate = b.kind === "rd" ? rdMaturity(b.start_date, b.tenure_months!) : b.maturity_date!;
      const typeCode = b.type_code ?? (b.kind === "fd" ? "fd_regular" : "rd_regular");
      const badType = await checkType(c, typeCode, b.kind, b.start_date, maturityDate); if (badType) return void reply.code(422).send({ title: badType, status: 422 });
      const payoutFrequency = b.kind === "rd" ? "at_maturity" : b.payout_frequency;
      const row = (await c.query(`insert into deposits (family_id, entity_id, kind, bank, account_no, bucket, principal, installment_amount, rate_pct, start_date, maturity_date, tenure_months, payout_frequency, payout_bank_account_id, tds_applicable, type_code)
          values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) returning id`,
        [fam, b.entity_id, b.kind, b.bank, b.account_no ?? null, b.bucket, b.principal ?? null, b.installment_amount ?? null, b.rate_pct, b.start_date, maturityDate, b.tenure_months ?? null, payoutFrequency, b.payout_bank_account_id ?? null, b.tds_applicable, typeCode])).rows[0];
      const rows = await writeSchedule(c, fam, row.id, { kind: b.kind, startDate: b.start_date, maturityDate, ratePct: b.rate_pct, principal: b.principal, installmentAmount: b.installment_amount, tenureMonths: b.tenure_months, payoutFrequency });
      await syncOutflows(c, fam); await generateTasksFor(c, fam);
      await c.query("insert into audit_log (family_id, user_id, action, table_name, row_id, after) values ($1,$2,'create','deposits',$3,$4)", [fam, req.user!.id, row.id, JSON.stringify({ ...b, schedule_rows: rows })]);
      return void reply.code(201).send(await depositView(c, (await c.query(`${DEPOSIT_SQL} where d.id=$1`, [row.id])).rows[0]));
    });
  });
}
