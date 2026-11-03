/** Government savings, rounds 2 and 3: PPF, SSY and EPF accounts. The account, what goes into it, the yearly interest (worked out by the scheme's rule and confirmed
 *  from the passbook), the passbook balance, and how the balance feeds net worth (through lib/depositvalue). */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireFamily, requireRole } from "../lib/auth.js";
import { withFamily } from "../lib/db.js";
import { SCHEMES, type Scheme, maturityOf, depositsUntilOf, fyStart, fyLabel, todayStr, addYears, fyDeposited, viewAccount, syncSavingsInterest, reconcileSavingsDeposits, withdrawRules } from "../lib/savings.js";

const WRITERS = requireRole("owner", "member", "operator");
const num = z.union([z.number(), z.string().regex(/^-?\d+(\.\d+)?$/)]).transform(Number); const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const r2 = (n: number) => Math.round(n * 100) / 100; const money = (n: number) => "₹" + Math.round(n).toLocaleString("en-IN");
class SavingsError extends Error { constructor(public status: number, message: string) { super(message); } }
const problem = (reply: any, e: any) => { if (e instanceof SavingsError) return void reply.code(e.status).send({ title: e.message, status: e.status }); if (e?.name === "ZodError") return void reply.code(422).send({ title: e.issues?.[0] ? `${e.issues[0].path.join(".") || "request"}: ${e.issues[0].message}` : "Invalid request", status: 422 }); throw e; };

const ACCOUNT_SQL = `select a.*, a.opened_on::text opened_on, a.matures_on::text matures_on, a.deposits_until::text deposits_until, a.tracked_from::text tracked_from, a.closed_on::text closed_on, a.holder_dob::text holder_dob, e.name entity_name from savings_accounts a join entities e on e.id=a.entity_id`;
const ENTRY_SQL = `select e.id, e.auto, e.closes, e.override_reason, e.kind, e.entry_date::text entry_date, e.amount, e.status, e.confirmed, e.bank_account_id, e.bank_txn_ref, e.note from savings_entries e`;

async function loadEntries(c: any, accountId: string) { return (await c.query(`${ENTRY_SQL} where e.account_id=$1 order by e.entry_date, e.created_at`, [accountId])).rows.map((e: any) => ({ ...e, amount: Number(e.amount) })); }

async function accountOut(c: any, row: any, withEntries = false) {
  const entries = await loadEntries(c, row.id); const scheme = row.scheme as Scheme; const v = viewAccount(row, entries, scheme); const today = todayStr();
  const days = Math.round((Date.parse(row.matures_on) - Date.parse(today)) / 86400000);
  return { id: row.id, entity_id: row.entity_id, entity_name: row.entity_name, scheme, scheme_label: SCHEMES[scheme].label, institution: row.institution, account_no: row.account_no, holder_name: row.holder_name, holder_dob: row.holder_dob,
    opened_on: row.opened_on, matures_on: scheme === "epf" ? null : row.matures_on, deposits_until: row.deposits_until, days_to_maturity: scheme === "epf" ? null : days, employee_monthly: Number(row.employee_monthly), employer_monthly: Number(row.employer_monthly), rate_pct: Number(row.rate_pct), opening_balance: Number(row.opening_balance), tracked_from: row.tracked_from, balance_adjust: Number(row.balance_adjust), bucket: row.bucket, status: row.status,
    balance: row.status === "closed" ? 0 : v.balance, closed_on: row.closed_on, withdrawn_total: r2(entries.filter((e: any) => e.kind === "withdrawal").reduce((s: number, e: any) => s + e.amount, 0)), fy: fyLabel(v.fy), fy_deposited: v.fy_deposited, fy_limit: SCHEMES[scheme].limit || null, fy_limit_left: v.fy_limit_left, projected_interest: v.projected_interest, years: v.years.map((y) => ({ label: y.label, credit_date: y.credit_date, interest: y.interest, confirmed: y.confirmed, ended: y.ended, deposited: y.deposited, withdrawn: y.withdrawn, balance_end: y.balance_end })),
    ...(withEntries ? { entries } : {}) };
}

export default async function savingsRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireFamily);
  const fam = (req: any) => req.family!.familyId as string;

  /** The two schemes' rules and their starting rates, for the form. */
  app.get("/savings-schemes", async () => Object.values(SCHEMES));

  app.get("/savings-accounts", async (req) => withFamily(fam(req), async (c) => {
    await syncSavingsInterest(c, fam(req));
    const rows = (await c.query(`${ACCOUNT_SQL} where a.family_id=$1 order by a.status, a.opened_on`, [fam(req)])).rows;
    return Promise.all(rows.map((r: any) => accountOut(c, r)));
  }));

  app.get("/savings-accounts/:id", async (req, reply) => {
    try {
      return void reply.send(await withFamily(fam(req), async (c) => {
        await syncSavingsInterest(c, fam(req), (req.params as any).id);
        const r = (await c.query(`${ACCOUNT_SQL} where a.id=$1 and a.family_id=$2`, [(req.params as any).id, fam(req)])).rows[0]; if (!r) throw new SavingsError(404, "Account not found");
        return accountOut(c, r, true);
      }));
    } catch (e) { return problem(reply, e); }
  });

  const BODY = z.object({
    entity_id: z.string().uuid(), scheme: z.enum(["ppf", "ssy", "epf"]), institution: z.string().min(1).max(80), account_no: z.string().max(40).optional().nullable(),
    holder_name: z.string().max(80).optional().nullable(), holder_dob: date.optional().nullable(), opened_on: date, rate_pct: num,
    opening_balance: num.optional(), employee_monthly: num.optional(), employer_monthly: num.optional(), tracked_from: date.optional(), bucket: z.enum(["liquidity", "income", "growth"]).optional(),
  });

  app.post("/savings-accounts", { preHandler: WRITERS }, async (req, reply) => {
    try {
      const b = BODY.parse(req.body ?? {}); const today = todayStr();
      if (b.opened_on > today) throw new SavingsError(422, "The opening date cannot be in the future");
      if (!(b.rate_pct > 0 && b.rate_pct < 20)) throw new SavingsError(422, "Enter the interest rate, for example 7.1");
      if ((b.employee_monthly ?? 0) < 0 || (b.employer_monthly ?? 0) < 0) throw new SavingsError(422, "The monthly amounts cannot be negative");
      if (b.scheme !== "epf" && ((b.employee_monthly ?? 0) > 0 || (b.employer_monthly ?? 0) > 0)) throw new SavingsError(422, "Monthly contributions are only for EPF");
      const opening = b.opening_balance ?? 0; if (opening < 0) throw new SavingsError(422, "The opening balance cannot be negative");
      const tracked = b.tracked_from ?? (opening > 0 ? today : b.opened_on);
      if (tracked < b.opened_on || tracked > today) throw new SavingsError(422, "Tracking must start between the opening date and today");
      if (b.scheme === "ssy") {
        if (!b.holder_dob) throw new SavingsError(422, "Enter the girl child's date of birth");
        if (addYears(b.holder_dob, 10) < b.opened_on) throw new SavingsError(422, "A Sukanya account must be opened before the girl turns 10");
      }
      const out = await withFamily(fam(req), async (c) => {
        if (!(await c.query("select 1 from entities where id=$1 and family_id=$2 and deleted_at is null", [b.entity_id, fam(req)])).rowCount) throw new SavingsError(404, "Entity not found");
        const id = (await c.query(`insert into savings_accounts (family_id, entity_id, scheme, institution, account_no, holder_name, holder_dob, opened_on, matures_on, deposits_until, rate_pct, opening_balance, tracked_from, bucket, employee_monthly, employer_monthly)
          values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) returning id`, [fam(req), b.entity_id, b.scheme, b.institution, b.account_no ?? null, b.holder_name ?? null, b.holder_dob ?? null, b.opened_on, maturityOf(b.scheme, b.opened_on), depositsUntilOf(b.scheme, b.opened_on), b.rate_pct, opening, tracked, b.bucket ?? "income", b.employee_monthly ?? 0, b.employer_monthly ?? 0])).rows[0].id;
        await syncSavingsInterest(c, fam(req), id);
        await c.query("insert into audit_log (family_id, user_id, action, table_name, row_id, after) values ($1,$2,'create','savings_accounts',$3,$4)", [fam(req), req.user!.id, id, JSON.stringify({ scheme: b.scheme, institution: b.institution, opened_on: b.opened_on, rate_pct: b.rate_pct, opening_balance: opening })]);
        return accountOut(c, (await c.query(`${ACCOUNT_SQL} where a.id=$1`, [id])).rows[0], true);
      });
      return void reply.code(201).send(out);
    } catch (e) { return problem(reply, e); }
  });

  /** Edit the account. A new rate rebuilds the interest estimates (a figure the user has already confirmed from the passbook is kept). */
  app.patch("/savings-accounts/:id", { preHandler: WRITERS }, async (req, reply) => {
    try {
      const b = BODY.partial().omit({ entity_id: true, scheme: true }).parse(req.body ?? {});
      const out = await withFamily(fam(req), async (c) => {
        const cur = (await c.query(`${ACCOUNT_SQL} where a.id=$1 and a.family_id=$2`, [(req.params as any).id, fam(req)])).rows[0]; if (!cur) throw new SavingsError(404, "Account not found");
        const m: any = { ...cur, ...Object.fromEntries(Object.entries(b).filter(([, v]) => v !== undefined)) };
        if (b.rate_pct != null && !(Number(b.rate_pct) > 0 && Number(b.rate_pct) < 20)) throw new SavingsError(422, "Enter the interest rate, for example 7.1");
        if (b.opened_on && b.opened_on !== cur.opened_on) {
          if (b.opened_on > todayStr()) throw new SavingsError(422, "The opening date cannot be in the future");
          m.matures_on = maturityOf(cur.scheme, b.opened_on); m.deposits_until = depositsUntilOf(cur.scheme, b.opened_on);
        }
        if (b.tracked_from || b.opened_on) { if (m.tracked_from < m.opened_on || m.tracked_from > todayStr()) throw new SavingsError(422, "Tracking must start between the opening date and today"); }
        if (b.opening_balance != null && Number(b.opening_balance) < 0) throw new SavingsError(422, "The opening balance cannot be negative");
        if (cur.scheme !== "epf" && (Number(b.employee_monthly ?? 0) > 0 || Number(b.employer_monthly ?? 0) > 0)) throw new SavingsError(422, "Monthly contributions are only for EPF");
        if (Number(m.employee_monthly) < 0 || Number(m.employer_monthly) < 0) throw new SavingsError(422, "The monthly amounts cannot be negative");
        if (cur.scheme === "ssy" && m.holder_dob && addYears(m.holder_dob, 10) < m.opened_on) throw new SavingsError(422, "A Sukanya account must be opened before the girl turns 10");
        await c.query(`update savings_accounts set institution=$2, account_no=$3, holder_name=$4, holder_dob=$5, opened_on=$6, matures_on=$7, deposits_until=$8, rate_pct=$9, opening_balance=$10, tracked_from=$11, bucket=$12, employee_monthly=$13, employer_monthly=$14, updated_at=now() where id=$1`,
          [cur.id, m.institution, m.account_no ?? null, m.holder_name ?? null, m.holder_dob ?? null, m.opened_on, m.matures_on, m.deposits_until ?? null, m.rate_pct, Number(m.opening_balance), m.tracked_from, m.bucket, Number(m.employee_monthly), Number(m.employer_monthly)]);
        // a new start date or opening balance moves where the automatic monthly entries begin, so they are made again; a new monthly amount applies from the next month on
        if (b.tracked_from || b.opening_balance != null) await c.query("delete from savings_entries where account_id=$1 and auto", [cur.id]);
        await syncSavingsInterest(c, fam(req), cur.id);
        await c.query("insert into audit_log (family_id, user_id, action, table_name, row_id, before, after) values ($1,$2,'edit','savings_accounts',$3,$4,$5)", [fam(req), req.user!.id, cur.id, JSON.stringify({ rate_pct: Number(cur.rate_pct), institution: cur.institution, opening_balance: Number(cur.opening_balance) }), JSON.stringify(b)]);
        return accountOut(c, (await c.query(`${ACCOUNT_SQL} where a.id=$1`, [cur.id])).rows[0], true);
      });
      return void reply.send(out);
    } catch (e) { return problem(reply, e); }
  });

  app.delete("/savings-accounts/:id", { preHandler: requireRole("owner", "member") }, async (req, reply) => {
    try {
      return void reply.send(await withFamily(fam(req), async (c) => {
        const cur = (await c.query("select id, institution, scheme, account_no from savings_accounts where id=$1 and family_id=$2", [(req.params as any).id, fam(req)])).rows[0]; if (!cur) throw new SavingsError(404, "Account not found");
        await c.query("delete from savings_accounts where id=$1", [cur.id]);
        await c.query("insert into audit_log (family_id, user_id, action, table_name, row_id, before) values ($1,$2,'delete','savings_accounts',$3,$4)", [fam(req), req.user!.id, cur.id, JSON.stringify(cur)]);
        return { deleted: true, note: "Bank balances you changed when adding its deposits were not changed back; adjust them on the Banking page if needed." };
      }));
    } catch (e) { return problem(reply, e); }
  });

  /** Money put into the account. Refused above the year's limit, before the account was opened, or after the deposit period ended. */
  app.post("/savings-accounts/:id/deposits", { preHandler: WRITERS }, async (req, reply) => {
    try {
      const b = z.object({ amount: num, entry_date: date, bank_account_id: z.string().uuid().nullable().optional(), note: z.string().max(200).optional() }).parse(req.body ?? {});
      const out = await withFamily(fam(req), async (c) => {
        const a = (await c.query(`${ACCOUNT_SQL} where a.id=$1 and a.family_id=$2`, [(req.params as any).id, fam(req)])).rows[0]; if (!a) throw new SavingsError(404, "Account not found");
        const s = SCHEMES[a.scheme as Scheme];
        if (a.status !== "active") throw new SavingsError(409, "This account is closed");
        if (!(b.amount >= s.min_deposit)) throw new SavingsError(422, `The smallest deposit is ₹${s.min_deposit}`);
        if (b.entry_date > todayStr()) throw new SavingsError(422, "The date cannot be in the future");
        if (b.entry_date < a.tracked_from) throw new SavingsError(422, `This account is tracked from ${a.tracked_from}, and its opening balance already includes earlier deposits`);
        if (a.deposits_until && b.entry_date > a.deposits_until) throw new SavingsError(422, `Deposits to this account stopped on ${a.deposits_until}`);
        if (b.entry_date > a.matures_on) throw new SavingsError(422, "This account has matured");
        if (b.bank_account_id && !(await c.query("select 1 from bank_accounts where id=$1 and family_id=$2 and entity_id=$3 and deleted_at is null", [b.bank_account_id, fam(req), a.entity_id])).rowCount) throw new SavingsError(404, "Bank account not found for this owner");
        const entries = await loadEntries(c, a.id); const fy = fyStart(b.entry_date);
        const used = fyDeposited(a, entries.filter((e: any) => fyStart(e.entry_date) === fy), fy);
        if (s.limit && used + b.amount > s.limit + 0.5) throw new SavingsError(422, `The limit is ₹${s.limit.toLocaleString("en-IN")} a year. ₹${used.toLocaleString("en-IN")} is already in for ${fyLabel(fy)}, so at most ₹${r2(s.limit - used).toLocaleString("en-IN")} more.`);
        const id = (await c.query("insert into savings_entries (family_id, account_id, kind, entry_date, amount, status, bank_account_id, note) values ($1,$2,'deposit',$3,$4,'received',$5,$6) returning id", [fam(req), a.id, b.entry_date, b.amount, b.bank_account_id ?? null, b.note ?? null])).rows[0].id;
        if (b.bank_account_id) await c.query("update bank_accounts set balance = balance - $2 where id=$1", [b.bank_account_id, b.amount]);
        await syncSavingsInterest(c, fam(req), a.id);
        await c.query("insert into audit_log (family_id, user_id, action, table_name, row_id, after) values ($1,$2,'create','savings_entries',$3,$4)", [fam(req), req.user!.id, id, JSON.stringify({ account: a.id, amount: b.amount, date: b.entry_date, bank: b.bank_account_id ?? null })]);
        return accountOut(c, (await c.query(`${ACCOUNT_SQL} where a.id=$1`, [a.id])).rows[0], true);
      });
      return void reply.code(201).send(out);
    } catch (e) { return problem(reply, e); }
  });

  /** Remove a deposit entered by mistake (one a bank statement has matched stays: the statement is the record). */
  app.delete("/savings-entries/:id", { preHandler: WRITERS }, async (req, reply) => {
    try {
      return void reply.send(await withFamily(fam(req), async (c) => {
        const e = (await c.query("select id, account_id, kind, auto, closes, amount, bank_account_id, bank_txn_ref from savings_entries where id=$1 and family_id=$2", [(req.params as any).id, fam(req)])).rows[0]; if (!e) throw new SavingsError(404, "Entry not found");
        if (e.kind === "interest") throw new SavingsError(409, "Yearly interest is worked out by the scheme's rule. To correct it, confirm the passbook figure instead");
        if (e.auto) throw new SavingsError(409, "This is a monthly contribution the app adds from the account's monthly amounts. To stop them, set the monthly amounts to 0 under Edit; to match the passbook, use Update balance");
        if (e.bank_txn_ref) throw new SavingsError(409, "A bank statement line matches this deposit, so it cannot be removed");
        await c.query("delete from savings_entries where id=$1", [e.id]);
        if (e.kind === "withdrawal") {   // taking a withdrawal back: the money leaves the bank account again, and a closing reopens the account
          if (e.bank_account_id) await c.query("update bank_accounts set balance = balance - $2 where id=$1", [e.bank_account_id, e.amount]);
          if (e.closes) await c.query("update savings_accounts set status='active', closed_on=null, updated_at=now() where id=$1", [e.account_id]);
        } else if (e.bank_account_id) await c.query("update bank_accounts set balance = balance + $2 where id=$1", [e.bank_account_id, e.amount]);
        await syncSavingsInterest(c, fam(req), e.account_id);
        await c.query("insert into audit_log (family_id, user_id, action, table_name, row_id, before) values ($1,$2,'delete','savings_entries',$3,$4)", [fam(req), req.user!.id, e.id, JSON.stringify({ amount: Number(e.amount) })]);
        return accountOut(c, (await c.query(`${ACCOUNT_SQL} where a.id=$1`, [e.account_id])).rows[0], true);
      }));
    } catch (e) { return problem(reply, e); }
  });

  /** The passbook says the year's interest was this much: replace the estimate with it. */
  app.post("/savings-entries/:id/confirm", { preHandler: WRITERS }, async (req, reply) => {
    try {
      const b = z.object({ amount: num }).parse(req.body ?? {});
      return void reply.send(await withFamily(fam(req), async (c) => {
        const e = (await c.query("select id, account_id, kind, status, amount from savings_entries where id=$1 and family_id=$2", [(req.params as any).id, fam(req)])).rows[0]; if (!e) throw new SavingsError(404, "Entry not found");
        if (e.kind !== "interest") throw new SavingsError(409, "Only the yearly interest is confirmed this way");
        if (e.status !== "credited") throw new SavingsError(409, "The year is not over yet, so the interest has not been added");
        if (!(b.amount >= 0)) throw new SavingsError(422, "Enter the interest the passbook shows");
        await c.query("update savings_entries set amount=$2, confirmed=true where id=$1", [e.id, b.amount]);
        await syncSavingsInterest(c, fam(req), e.account_id);
        await c.query("insert into audit_log (family_id, user_id, action, table_name, row_id, before, after) values ($1,$2,'confirm','savings_entries',$3,$4,$5)", [fam(req), req.user!.id, e.id, JSON.stringify({ amount: Number(e.amount) }), JSON.stringify({ amount: b.amount })]);
        return accountOut(c, (await c.query(`${ACCOUNT_SQL} where a.id=$1`, [e.account_id])).rows[0], true);
      }));
    } catch (e) { return problem(reply, e); }
  });

  /** "Update balance": make the balance equal what the passbook shows today. The gap is kept as an adjustment, so later deposits and interest still add on top. */
  app.post("/savings-accounts/:id/balance", { preHandler: WRITERS }, async (req, reply) => {
    try {
      const b = z.object({ balance: num }).parse(req.body ?? {});
      return void reply.send(await withFamily(fam(req), async (c) => {
        const a = (await c.query(`${ACCOUNT_SQL} where a.id=$1 and a.family_id=$2`, [(req.params as any).id, fam(req)])).rows[0]; if (!a) throw new SavingsError(404, "Account not found");
        if (!(b.balance >= 0)) throw new SavingsError(422, "Enter the balance the passbook shows");
        await syncSavingsInterest(c, fam(req), a.id);
        const entries = await loadEntries(c, a.id);
        const computed = viewAccount({ ...a, balance_adjust: 0 }, entries, a.scheme).balance;
        await c.query("update savings_accounts set balance_adjust=$2, updated_at=now() where id=$1", [a.id, r2(b.balance - computed)]);
        await c.query("insert into audit_log (family_id, user_id, action, table_name, row_id, after) values ($1,$2,'update_balance','savings_accounts',$3,$4)", [fam(req), req.user!.id, a.id, JSON.stringify({ passbook: b.balance, computed, adjust: r2(b.balance - computed) })]);
        return accountOut(c, (await c.query(`${ACCOUNT_SQL} where a.id=$1`, [a.id])).rows[0], true);
      }));
    } catch (e) { return problem(reply, e); }
  });

  /** What the scheme allows on a date: a part withdrawal (and the most that can be taken) and closing the account early. */
  app.get("/savings-accounts/:id/withdraw-rules", async (req, reply) => {
    try {
      const q = z.object({ date: date.optional() }).parse(req.query ?? {});
      return void reply.send(await withFamily(fam(req), async (c) => {
        const a = (await c.query(`${ACCOUNT_SQL} where a.id=$1 and a.family_id=$2`, [(req.params as any).id, fam(req)])).rows[0]; if (!a) throw new SavingsError(404, "Account not found");
        if (a.scheme === "epf") throw new SavingsError(422, "Withdrawals from an EPF are not recorded here yet");
        await syncSavingsInterest(c, fam(req), a.id);
        return { date: q.date ?? todayStr(), ...withdrawRules(a, await loadEntries(c, a.id), a.scheme, q.date ?? todayStr()) };
      }));
    } catch (e) { return problem(reply, e); }
  });

  /** Take money out of a PPF or SSY: a part withdrawal, or closing the account. A rule that is not met refuses it; an owner can record it anyway with a written reason. */
  app.post("/savings-accounts/:id/withdraw", { preHandler: WRITERS }, async (req, reply) => {
    try {
      const b = z.object({ kind: z.enum(["part", "close"]), amount: num, date, bank_account_id: z.string().uuid().nullable().optional(), reason: z.string().trim().max(200).optional(), override: z.boolean().optional(), override_reason: z.string().trim().max(300).optional() }).parse(req.body ?? {});
      const out = await withFamily(fam(req), async (c) => {
        const a = (await c.query(`${ACCOUNT_SQL} where a.id=$1 and a.family_id=$2`, [(req.params as any).id, fam(req)])).rows[0]; if (!a) throw new SavingsError(404, "Account not found");
        if (a.scheme === "epf") throw new SavingsError(422, "Withdrawals from an EPF are not recorded here yet");
        if (a.status !== "active") throw new SavingsError(409, "This account is already closed");
        if (!(b.amount > 0)) throw new SavingsError(422, "Enter the amount taken out");
        if (b.date > todayStr()) throw new SavingsError(422, "The date cannot be in the future");
        if (b.date < a.tracked_from) throw new SavingsError(422, `This account is tracked from ${a.tracked_from}, so a withdrawal cannot be earlier`);
        if (b.bank_account_id && !(await c.query("select 1 from bank_accounts where id=$1 and family_id=$2 and entity_id=$3 and deleted_at is null", [b.bank_account_id, fam(req), a.entity_id])).rowCount) throw new SavingsError(404, "Bank account not found for this owner");
        await syncSavingsInterest(c, fam(req), a.id);
        const entries = await loadEntries(c, a.id); const r = withdrawRules(a, entries, a.scheme, b.date); const rule: any = b.kind === "part" ? r.part : r.close;
        const breaks: string[] = [];
        if (!rule.allowed) breaks.push(rule.reason!);
        if (b.kind === "part" && rule.allowed && rule.max != null && b.amount > rule.max + 0.5) breaks.push(`The most that can be taken now is ${money(rule.max)} (${r.part.basis})`);
        if (b.kind === "close" && rule.allowed && rule.needs_reason && !b.reason) throw new SavingsError(422, "Choose the reason for closing early");
        const balanceNow = r.close.estimate;
        if (b.kind === "part" && b.amount > balanceNow + 0.5) throw new SavingsError(422, `The balance is only about ${money(balanceNow)}`);
        let overrideReason: string | null = null;
        if (breaks.length) {
          if (req.family!.role !== "owner") throw new SavingsError(403, breaks[0] + ". Only an owner can record it anyway.");
          if (!b.override || !b.override_reason || b.override_reason.length < 15) throw new SavingsError(422, breaks[0] + ". To record it anyway, tick the box and explain the reason in a sentence (for example that the post office approved it in writing).");
          overrideReason = b.override_reason;
        }
        const note = b.kind === "close" ? `account closed${b.reason ? ": " + b.reason : ""}` : "part withdrawal";
        const id = (await c.query("insert into savings_entries (family_id, account_id, kind, entry_date, amount, status, bank_account_id, closes, override_reason, note) values ($1,$2,'withdrawal',$3,$4,'received',$5,$6,$7,$8) returning id", [fam(req), a.id, b.date, b.amount, b.bank_account_id ?? null, b.kind === "close", overrideReason, note])).rows[0].id;
        if (b.bank_account_id) await c.query("update bank_accounts set balance = balance + $2 where id=$1", [b.bank_account_id, b.amount]);
        if (b.kind === "close") await c.query("update savings_accounts set status='closed', closed_on=$2, updated_at=now() where id=$1", [a.id, b.date]);
        else await syncSavingsInterest(c, fam(req), a.id);
        await c.query("insert into audit_log (family_id, user_id, action, table_name, row_id, after) values ($1,$2,$3,'savings_entries',$4,$5)", [fam(req), req.user!.id, b.kind === "close" ? "close_account" : "withdraw", id, JSON.stringify({ account: a.id, amount: b.amount, date: b.date, reason: b.reason ?? null, override: overrideReason })]);
        return accountOut(c, (await c.query(`${ACCOUNT_SQL} where a.id=$1`, [a.id])).rows[0], true);
      });
      return void reply.code(201).send(out);
    } catch (e) { return problem(reply, e); }
  });

  /** Run the bank-statement matching by hand (an import runs it by itself). */
  app.post("/savings-accounts/reconcile", { preHandler: WRITERS }, async (req) => withFamily(fam(req), (c) => reconcileSavingsDeposits(c, fam(req))));
}
