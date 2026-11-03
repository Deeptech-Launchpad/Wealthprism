/** PPF, SSY and EPF: the scheme rules, the yearly interest arithmetic, the balance, and the matching of bank debits to deposits.
 *  Dates are text (YYYY-MM-DD) throughout, so there is no timezone day-shift. */
import type pg from "pg";

export const SCHEMES = {
  ppf: { code: "ppf", label: "PPF", full: "Public Provident Fund", limit: 150000, min_deposit: 500, default_rate: 7.1, term: "15 years (ends on 31 March of the 15th year after the one you opened in)",
    rate_note: "The government sets this rate every quarter. 7.1% is a recent rate; check the current one on indiapost.gov.in before you save." },
  ssy: { code: "ssy", label: "SSY", full: "Sukanya Samriddhi Yojana", limit: 150000, min_deposit: 250, default_rate: 8.2, term: "21 years from opening; deposits stop after 15 years",
    rate_note: "The government sets this rate every quarter. 8.2% is a recent rate; check the current one on indiapost.gov.in before you save." },
  // no yearly limit (limit 0) and no fixed end: the money stays until you retire or withdraw
  epf: { code: "epf", label: "EPF", full: "Employees' Provident Fund", limit: 0, min_deposit: 1, default_rate: 8.25, term: "no fixed end; it stays until you retire or withdraw",
    rate_note: "EPFO declares this rate once a year (8.25% is a recent rate). Check the current one on epfindia.gov.in or in your passbook before you save." },
} as const;
export type Scheme = keyof typeof SCHEMES;

const r2 = (n: number) => Math.round(n * 100) / 100;
const pad = (n: number) => String(n).padStart(2, "0");
export const addYears = (d: string, n: number) => { const [y, m, dd] = d.split("-").map(Number); const ny = y + n; const last = new Date(Date.UTC(ny, m, 0)).getUTCDate(); return `${ny}-${pad(m)}-${pad(Math.min(dd, last))}`; };
/** The financial year a date falls in, as its starting calendar year: 27-Oct-2026 and 5-Feb-2027 are both in 2026 (FY 2026-27). */
export const fyStart = (d: string) => { const [y, m] = d.split("-").map(Number); return m >= 4 ? y : y - 1; };
export const fyLabel = (y: number) => `${y}-${String(y + 1).slice(-2)}`;
export const fyEnd = (y: number) => `${y + 1}-03-31`;
export const todayStr = () => new Date().toISOString().slice(0, 10);

/** When the account matures. PPF: 31 March, 15 years after the end of the financial year it was opened in. SSY: 21 years from opening. */
export const maturityOf = (scheme: Scheme, opened: string) => scheme === "ppf" ? addYears(fyEnd(fyStart(opened)), 15) : scheme === "epf" ? addYears(opened, 60) : addYears(opened, 21);   // EPF has no end: 60 years is only a stop for the arithmetic
export const depositsUntilOf = (scheme: Scheme, opened: string) => scheme === "ssy" ? addYears(opened, 15) : null;

export interface Flow { date: string; amount: number }
/** The interest for one financial year. Each month earns on the lowest balance between the 5th and the month end, so money in by the 5th counts for that
 *  month and money after it from the next. The year's own interest is added at the end, not month by month. `balance0` is what stood on 1 April (the
 *  balance carried in, including earlier years' interest); `flows` are the deposits made inside the year; `from` skips months before the account was tracked. */
export function yearInterest(fy: number, balance0: number, flows: Flow[], ratePct: number, from: string | null = null, cutDay = 5, until: string | null = null): number {
  let total = 0;
  for (let i = 0; i < 12; i++) {
    const month = ((3 + i) % 12) + 1; const year = month >= 4 ? fy : fy + 1;
    if (from && `${year}-${pad(month)}-31` < from) continue;
    if (until && `${year}-${pad(month)}-31` >= until) continue;   // a closing date: the months that finished before it
    const cut = `${year}-${pad(month)}-${pad(cutDay)}`;   // PPF and SSY: the 5th. EPF: the 1st, i.e. the balance the month opened with (a contribution made in a month earns from the next)
    // money in counts from the cut day; money taken out counts at once, because the lowest balance of the month is the one after it
    const bal = balance0 + flows.filter((f) => f.amount >= 0 ? f.date <= cut : f.date <= `${year}-${pad(month)}-31`).reduce((s, f) => s + f.amount, 0);
    if (bal > 0) total += bal * (ratePct / 100) / 12;
  }
  return r2(total);
}

interface Entry { kind: string; entry_date: string; amount: number; status: string; confirmed: boolean; closes?: boolean }

/** Walk the account year by year: the deposits in, the interest of each year (estimated or confirmed), and the balance after each. */
export function walkAccount(a: { opening_balance: number; tracked_from: string; rate_pct: number; matures_on: string; scheme?: Scheme }, entries: Entry[], today: string) {
  const cutDay = a.scheme === "epf" ? 1 : 5;
  const deposits = entries.filter((e) => e.kind === "deposit"); const takenOut = entries.filter((e) => e.kind === "withdrawal");
  const confirmed = new Map(entries.filter((e) => e.kind === "interest" && e.confirmed).map((e) => [fyStart(e.entry_date), e.amount]));
  const first = fyStart(a.tracked_from); const lastFy = Math.min(fyStart(today), fyStart(a.matures_on));
  const years: { fy: number; label: string; credit_date: string; interest: number; confirmed: boolean; ended: boolean; deposited: number; withdrawn: number; balance_start: number; balance_end: number }[] = [];
  let carried = a.opening_balance;   // the opening balance counts from the tracking date; deposits made on or after it are in `deposits`
  for (let fy = first; fy <= lastFy; fy++) {
    const inYear = deposits.filter((d) => fyStart(d.entry_date) === fy && d.entry_date >= a.tracked_from).map((d) => ({ date: d.entry_date, amount: d.amount }));
    const outYear = takenOut.filter((d) => fyStart(d.entry_date) === fy && d.entry_date >= a.tracked_from).map((d) => ({ date: d.entry_date, amount: -d.amount }));
    const flows = fy === first ? [{ date: a.tracked_from, amount: a.opening_balance }, ...inYear, ...outYear] : [...inYear, ...outYear];
    const base = fy === first ? 0 : carried;
    const est = yearInterest(fy, base, flows, a.rate_pct, fy === first ? a.tracked_from : null, cutDay);
    const ended = fyEnd(fy) <= today; const isConf = confirmed.has(fy); const interest = isConf ? confirmed.get(fy)! : est;
    const depositedYear = inYear.reduce((s, d) => s + d.amount, 0);
    const withdrawnYear = outYear.reduce((s, d) => s - d.amount, 0);
    const balanceStart = base; const balanceEnd = base + (fy === first ? a.opening_balance : 0) + depositedYear - withdrawnYear + (ended ? interest : 0);
    years.push({ fy, label: fyLabel(fy), credit_date: fyEnd(fy), interest, confirmed: isConf, ended, deposited: r2(depositedYear), withdrawn: r2(withdrawnYear), balance_start: r2(balanceStart), balance_end: r2(balanceEnd) });
    carried = balanceEnd;
  }
  return years;
}

const lastDay = (y: number, m: number) => `${y}-${pad(m)}-${pad(new Date(Date.UTC(y, m, 0)).getUTCDate())}`;
/** EPF: the salary pays in every month, so add one contribution per month end from tracking until today, at the account's monthly amounts. Months already added
 *  are left as they were (a later change to the amounts applies from the next month on). */
export async function syncMonthlyContributions(c: pg.PoolClient, familyId: string, accountId?: string) {
  const accts = (await c.query("select id, tracked_from::text tracked_from, employee_monthly, employer_monthly from savings_accounts where family_id=$1 and scheme='epf' and status='active' and employee_monthly + employer_monthly > 0 and ($2::uuid is null or id=$2)", [familyId, accountId ?? null])).rows;
  const today = todayStr();
  for (const a of accts) {
    const amount = r2(Number(a.employee_monthly) + Number(a.employer_monthly)); const note = `monthly contribution (you ${Number(a.employee_monthly)} + employer ${Number(a.employer_monthly)})`;
    let [y, m] = a.tracked_from.split("-").map(Number);
    for (; lastDay(y, m) <= today; m === 12 ? (y++, m = 1) : m++) {
      const d = lastDay(y, m); if (d < a.tracked_from) continue;
      await c.query("insert into savings_entries (family_id, account_id, kind, entry_date, amount, status, auto, note) values ($1,$2,'deposit',$3,$4,'received',true,$5) on conflict (account_id, entry_date) where auto do nothing", [familyId, a.id, d, amount, note]);
    }
  }
}

/** Make the yearly interest rows match the arithmetic: one per financial year from tracking to now, 'credited' once the year has ended (until the user
 *  confirms the passbook figure it stays an estimate), 'expected' for the year in progress. A confirmed figure is never overwritten. */
export async function syncSavingsInterest(c: pg.PoolClient, familyId: string, accountId?: string) {
  await syncMonthlyContributions(c, familyId, accountId);
  const accts = (await c.query("select id, family_id, scheme, opening_balance, tracked_from::text tracked_from, rate_pct, matures_on::text matures_on from savings_accounts where family_id=$1 and status='active' and ($2::uuid is null or id=$2)", [familyId, accountId ?? null])).rows;
  const today = todayStr();
  for (const a of accts) {
    const entries = (await c.query("select kind, entry_date::text entry_date, amount, status, confirmed from savings_entries where account_id=$1", [a.id])).rows.map((e: any) => ({ ...e, amount: Number(e.amount) }));
    const years = walkAccount({ opening_balance: Number(a.opening_balance), tracked_from: a.tracked_from, rate_pct: Number(a.rate_pct), matures_on: a.matures_on, scheme: a.scheme }, entries, today);
    for (const y of years) {
      if (y.confirmed) continue;
      await c.query(`insert into savings_entries (family_id, account_id, kind, entry_date, amount, status) values ($1,$2,'interest',$3,$4,$5)
        on conflict (account_id, entry_date) where kind = 'interest' do update set amount = excluded.amount, status = excluded.status where savings_entries.confirmed = false`, [familyId, a.id, y.credit_date, y.interest, y.ended ? "credited" : "expected"]);
    }
  }
}

/** What counts against the year's limit: the deposits of the year, and the opening balance too when the account was opened and first tracked in that same year. */
export function fyDeposited(a: { opening_balance: number | string; tracked_from: string; opened_on: string }, entries: { kind: string; entry_date: string; amount: number }[], fy: number): number {
  const dep = entries.filter((e) => e.kind === "deposit" && fyStart(e.entry_date) === fy).reduce((s, e) => s + e.amount, 0);
  return r2(dep + (fyStart(a.tracked_from) === fy && fyStart(a.opened_on) === fy ? Number(a.opening_balance) : 0));
}

export interface AccountView { id: string; balance: number; years: ReturnType<typeof walkAccount>; fy: number; fy_deposited: number; fy_limit_left: number | null; projected_interest: number }
/** The balance today (everything in, plus interest of the years that have ended, plus the passbook adjustment) and where the current year stands. */
export function viewAccount(a: any, entries: Entry[], scheme: Scheme, today = todayStr()): AccountView {
  const years = walkAccount({ opening_balance: Number(a.opening_balance), tracked_from: a.tracked_from, rate_pct: Number(a.rate_pct), matures_on: a.matures_on, scheme }, entries, today);
  const cur = years[years.length - 1]; const fy = fyStart(today);
  const dep = fyDeposited(a, entries.filter((e) => e.entry_date <= today) as any, fy);
  const balance = r2((cur?.balance_end ?? Number(a.opening_balance)) + Number(a.balance_adjust ?? 0));
  const inProgress = years.find((y) => !y.ended);
  return { id: a.id, balance, years, fy, fy_deposited: r2(dep), fy_limit_left: SCHEMES[scheme].limit ? r2(Math.max(0, SCHEMES[scheme].limit - dep)) : null, projected_interest: inProgress ? inProgress.interest : 0 };
}

/** Bank-statement matching. A debit that names the scheme and equals a deposit entered by hand (within five days) marks that deposit verified; a debit with
 *  no entry behind it is added as a deposit when exactly one account of that scheme belongs to the entity and the year's limit allows it. */
type DebitScheme = "ppf" | "ssy";   // EPF is paid from the salary, there is no debit to match
const KW: Record<DebitScheme, string> = { ppf: String.raw`(\mppf\M|public provident|provident fund)`, ssy: String.raw`(\mssy\M|\msny\M|sukanya|samriddhi)` };
export async function reconcileSavingsDeposits(c: pg.PoolClient, familyId: string): Promise<{ matched: number; added: number }> {
  let matched = 0, added = 0;
  for (const scheme of ["ppf", "ssy"] as DebitScheme[]) {
    const open = (await c.query(`select e.id, e.amount, e.entry_date::text d, a.entity_id from savings_entries e join savings_accounts a on a.id=e.account_id
      where e.family_id=$1 and e.kind='deposit' and e.bank_txn_ref is null and a.scheme=$2 and a.status='active'`, [familyId, scheme])).rows;
    for (const e of open) {
      const hit = (await c.query(`select t.id from bank_txns t where t.family_id=$1 and t.amount < 0 and abs(t.amount + $2::numeric) <= 0.5 and t.txn_date between $3::date - 5 and $3::date + 5
        and t.bank_account_id in (select id from bank_accounts where entity_id=$4::uuid) and t.narration ~* $5::text and not exists (select 1 from savings_entries x where x.bank_txn_ref = t.id::text) order by abs(t.txn_date - $3::date) limit 1`, [familyId, e.amount, e.d, e.entity_id, KW[scheme]])).rows[0];
      if (hit) { await c.query("update savings_entries set bank_txn_ref=$2 where id=$1", [e.id, hit.id]); matched++; }
    }
    // a debit with no deposit behind it
    const lone = (await c.query(`select t.id, -t.amount amt, t.txn_date::text d, b.entity_id from bank_txns t join bank_accounts b on b.id=t.bank_account_id
      where t.family_id=$1 and t.amount < 0 and t.narration ~* $2::text and not exists (select 1 from savings_entries x where x.bank_txn_ref = t.id::text) order by t.txn_date`, [familyId, KW[scheme]])).rows;
    for (const t of lone) {
      const accts = (await c.query("select id, opened_on::text opened_on, deposits_until::text deposits_until, tracked_from::text tracked_from from savings_accounts where family_id=$1 and entity_id=$2 and scheme=$3 and status='active'", [familyId, t.entity_id, scheme])).rows;
      if (accts.length !== 1) continue; const a = accts[0]; const amt = Number(t.amt);
      if (t.d < a.tracked_from || (a.deposits_until && t.d > a.deposits_until) || amt < SCHEMES[scheme].min_deposit) continue;
      const fy = fyStart(t.d); const inYear = Number((await c.query("select coalesce(sum(amount),0) s from savings_entries where account_id=$1 and kind='deposit' and entry_date between $2::date and $3::date", [a.id, `${fy}-04-01`, fyEnd(fy)])).rows[0].s);
      if (inYear + amt > SCHEMES[scheme].limit + 0.5) continue;
      await c.query("insert into savings_entries (family_id, account_id, kind, entry_date, amount, status, bank_txn_ref, note) values ($1,$2,'deposit',$3,$4,'received',$5,'added from a bank statement')", [familyId, a.id, t.d, amt, t.id]); added++;
    }
  }
  if (matched || added) await syncSavingsInterest(c, familyId);
  return { matched, added };
}

/** What the closing amount would be about: the balance, plus the interest of the months that finished in the year in progress. It is an estimate; the
 *  post office cuts 1% from the rate on an early PPF closure, so the figure actually credited is lower and the user types that. */
export function estimateClosing(a: any, entries: Entry[], scheme: Scheme, date: string): number {
  const years = walkAccount({ opening_balance: Number(a.opening_balance), tracked_from: a.tracked_from, rate_pct: Number(a.rate_pct), matures_on: a.matures_on, scheme }, entries, date);
  const cur = years[years.length - 1]; if (!cur) return r2(Number(a.opening_balance) + Number(a.balance_adjust ?? 0));
  let accrued = 0;
  if (!cur.ended) {
    const first = fyStart(a.tracked_from) === cur.fy;
    const flows = [...(first ? [{ date: a.tracked_from, amount: Number(a.opening_balance) }] : []),
      ...entries.filter((e) => (e.kind === "deposit" || e.kind === "withdrawal") && fyStart(e.entry_date) === cur.fy && e.entry_date >= a.tracked_from).map((e) => ({ date: e.entry_date, amount: e.kind === "deposit" ? e.amount : -e.amount }))];
    accrued = yearInterest(cur.fy, first ? 0 : cur.balance_start, flows, Number(a.rate_pct), first ? a.tracked_from : null, 5, date);
  }
  return r2(cur.balance_end + accrued + Number(a.balance_adjust ?? 0));
}

export interface WithdrawRules {
  part: { allowed: boolean; reason: string | null; opens_on: string | null; max: number | null; basis: string };
  close: { allowed: boolean; reason: string | null; opens_on: string | null; needs_reason: boolean; reasons: string[]; estimate: number };
}
const money = (n: number) => "₹" + Math.round(n).toLocaleString("en-IN");
const PPF_REASONS = ["Serious illness of the holder, spouse or children", "Higher education of the holder or children", "Change of residence status (became an NRI)"];
const SSY_REASONS = ["Marriage of the account holder (after 18)", "Death of the account holder", "Serious illness of the account holder"];

/** The rules for taking money out of a PPF or SSY before it matures, on a given date. A part withdrawal is limited to half the balance at a past year end, once a year. */
export function withdrawRules(a: any, entries: Entry[], scheme: "ppf" | "ssy", date: string): WithdrawRules {
  const years = walkAccount({ opening_balance: Number(a.opening_balance), tracked_from: a.tracked_from, rate_pct: Number(a.rate_pct), matures_on: a.matures_on, scheme }, entries, date);
  const fy = fyStart(date); const endOf = (y: number) => years.find((x) => x.fy === y && x.ended)?.balance_end;
  const now = estimateClosing(a, entries, scheme, date);
  const adjust = Number(a.balance_adjust ?? 0);
  const matured = date >= a.matures_on;
  let opens: string; let basisBal: number; let basis: string;
  if (scheme === "ppf") {
    opens = `${fyStart(a.opened_on) + 6}-04-01`;   // five years after the end of the year it was opened in: the 7th financial year
    const known = [endOf(fy - 4), endOf(fy - 1)].filter((v): v is number => v != null);
    basisBal = known.length ? Math.min(...known) + adjust : now; basis = known.length ? "half the balance at the end of the 4th year back or of last year, whichever is lower" : "half the balance today (the earlier year-end balances are before this account was tracked)";
  } else {
    opens = addYears(a.holder_dob, 18);
    const last = endOf(fy - 1); basisBal = last != null ? last + adjust : now; basis = last != null ? "half the balance at the end of last year" : "half the balance today (last year-end is before this account was tracked)";
  }
  const takenThisYear = entries.filter((e) => e.kind === "withdrawal" && !e.closes && fyStart(e.entry_date) === fy);
  let part: WithdrawRules["part"];
  if (matured) part = { allowed: false, reason: "The account has matured; close it to take the whole balance", opens_on: null, max: null, basis };
  else if (date < opens) part = { allowed: false, reason: scheme === "ppf" ? `A PPF part withdrawal is allowed from the 7th financial year, which for this account starts on ${opens}` : `A Sukanya part withdrawal is allowed once the girl turns 18 (${opens})`, opens_on: opens, max: null, basis };
  else if (takenThisYear.length) part = { allowed: false, reason: `Only one part withdrawal is allowed in a financial year, and ${money(takenThisYear.reduce((s, e) => s + e.amount, 0))} was taken on ${takenThisYear[0].entry_date}`, opens_on: `${fy + 1}-04-01`, max: null, basis };
  else part = { allowed: true, reason: null, opens_on: null, max: r2(Math.min(Math.max(0, basisBal) * 0.5, now)), basis };

  let close: WithdrawRules["close"];
  if (matured) close = { allowed: true, reason: null, opens_on: null, needs_reason: false, reasons: [], estimate: now };
  else if (scheme === "ppf") close = date >= opens
    ? { allowed: true, reason: null, opens_on: null, needs_reason: true, reasons: PPF_REASONS, estimate: now }
    : { allowed: false, reason: `A PPF can be closed early only after 5 years from the end of the year it was opened (from ${opens}), and only for illness, higher education or a change of residence status`, opens_on: opens, needs_reason: true, reasons: PPF_REASONS, estimate: now };
  else close = date >= opens
    ? { allowed: true, reason: null, opens_on: null, needs_reason: true, reasons: SSY_REASONS, estimate: now }
    : { allowed: false, reason: `A Sukanya account can be closed early only on marriage after 18 (from ${opens}), or on the girl's death or a serious illness`, opens_on: opens, needs_reason: true, reasons: SSY_REASONS, estimate: now };
  return { part, close };
}
