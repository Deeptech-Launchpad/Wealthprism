/** Fixed & recurring deposit expected-receipt schedules — pure functions, same shape as rent.ts's generateRentSchedule.
 *  Amounts here are the *expected* figures a bank-statement match will later confirm or correct (TDS, rounding and
 *  day-count conventions mean the real credited amount rarely matches this exactly) — never treat them as final. */
export interface DepositTerms {
  kind: "fd" | "rd";
  startDate: string; maturityDate: string; ratePct: number;
  principal?: number;           // fd only
  installmentAmount?: number;   // rd only
  tenureMonths?: number;        // rd only
  payoutFrequency: "monthly" | "quarterly" | "at_maturity";
}
export interface DepositReceiptRow { kind: "interest" | "contribution" | "maturity"; dueDate: string; expectedAmount: number }

const pad = (n: number) => String(n).padStart(2, "0");
const daysInMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const addMonths = (dateStr: string, n: number) => {
  const [y, m, d] = dateStr.split("-").map(Number);
  const total = m - 1 + n; const ny = y + Math.floor(total / 12); const nm = (total % 12) + 1;
  return `${ny}-${pad(nm)}-${pad(Math.min(d, daysInMonth(ny, nm)))}`;
};
const monthsBetween = (a: string, b: string) => { const [ay, am] = a.split("-").map(Number), [by, bm] = b.split("-").map(Number); return (by - ay) * 12 + (bm - am); };
const r2 = (n: number) => Math.round(n * 100) / 100;

/** Linear accrual between start and maturity toward the schedule's own maturity amount — an estimate for display
 *  only; real value is whatever a future bank-statement match confirms. Works for both kinds: an fd paying interest
 *  out periodically has maturityAmount === principal, so this correctly stays flat at `principal` the whole time;
 *  a cumulative fd or an rd grows linearly toward its computed maturity value. */
export function depositCurrentValue(d: { kind: "fd" | "rd"; principal?: number | null; startDate: string; maturityDate: string; ratePct?: number | null; paid?: { a: number | string; on: string }[] | null }, maturityAmount: number, today: string): number {
  // an rd is worth what has actually been paid in plus simple interest on each instalment since it was paid — an
  // instalment nobody has confirmed is still sitting in the bank account, so counting it here would double it
  if (d.kind === "rd" && d.paid) {
    const rate = Number(d.ratePct ?? 0) / 100;
    return r2(d.paid.reduce((s, p) => { const days = Math.max(0, (Date.parse(today) - Date.parse(String(p.on).slice(0, 10))) / 86400000); return s + Number(p.a) * (1 + rate * days / 365); }, 0));
  }
  const startValue = d.kind === "fd" ? Number(d.principal ?? 0) : 0;
  const totalDays = (Date.parse(d.maturityDate) - Date.parse(d.startDate)) / 86400000; if (totalDays <= 0) return maturityAmount;
  const elapsed = Math.min(totalDays, Math.max(0, (Date.parse(today) - Date.parse(d.startDate)) / 86400000));
  return r2(startValue + (maturityAmount - startValue) * (elapsed / totalDays));
}

/** Banks credit interest net of TDS (10%), so ₹540 against an expected ₹600 is a complete payment, not a short one. */
export function interestSettled(expected: number, received: number, tdsApplicable: boolean): boolean {
  return received + 0.5 >= expected || (tdsApplicable && received >= expected * 0.895);
}

export function generateDepositSchedule(t: DepositTerms): DepositReceiptRow[] {
  const rows: DepositReceiptRow[] = [];
  if (t.kind === "fd") {
    const principal = t.principal ?? 0;
    if (t.payoutFrequency === "at_maturity") {
      const quarters = Math.round(monthsBetween(t.startDate, t.maturityDate) / 3);
      rows.push({ kind: "maturity", dueDate: t.maturityDate, expectedAmount: r2(principal * Math.pow(1 + t.ratePct / 400, quarters)) });
    } else {
      const step = t.payoutFrequency === "monthly" ? 1 : 3;
      const interestPerPeriod = r2(principal * (t.ratePct / 100) * (step / 12));
      let due = addMonths(t.startDate, step);
      while (due <= t.maturityDate) { rows.push({ kind: "interest", dueDate: due, expectedAmount: interestPerPeriod }); due = addMonths(due, step); }
      rows.push({ kind: "maturity", dueDate: t.maturityDate, expectedAmount: principal });
    }
  } else {
    const n = t.tenureMonths ?? 0; const installment = t.installmentAmount ?? 0;
    for (let i = 0; i < n; i++) rows.push({ kind: "contribution", dueDate: addMonths(t.startDate, i), expectedAmount: installment });
    // Simple-interest approximation on the installment series (each instalment earns interest for its remaining months) — a
    // reasonable estimate, not the bank's own compounding method; the matching step will correct it against the real payout.
    const maturity = r2(installment * n + (installment * (t.ratePct / 100) * (n * (n + 1))) / (2 * 12));
    rows.push({ kind: "maturity", dueDate: t.maturityDate, expectedAmount: maturity });
  }
  return rows;
}

// ---------- foreclosure (closing a deposit before its maturity date) ----------
export interface ForeclosureInput {
  kind: "fd" | "rd"; startDate: string; closeDate: string; ratePct: number; penaltyPct: number;
  principal?: number;                       // fd
  payoutFrequency?: "monthly" | "quarterly" | "at_maturity";   // fd: at_maturity = cumulative, interest compounds quarterly
  contributions?: { a: number; on: string }[];                // rd: instalments actually paid
  interestAlreadyPaid?: number;             // fd paying out: interest already credited before the closure
}
export interface ForeclosureEstimate { daysRun: number; reducedRatePct: number; principalReturned: number; interest: number; interestAlreadyPaid: number; estimatedCredit: number; penaltyCost: number }
const dayDiff = (a: string, b: string) => Math.max(0, Math.round((Date.parse(b) - Date.parse(a)) / 86400000));

/** What the bank is likely to credit on closing early: the principal (or what an rd has had paid in) plus interest at the contracted rate
 *  less the penalty for the period it actually ran, less interest already paid out. The bank's own figure uses the rate card for the
 *  period run, which this does not know — so this is an estimate to compare against, never the amount of record. A deposit closed
 *  inside 7 days earns no interest (the usual bank rule). A negative interest-less-paid means the bank recovers the excess from the principal. */
export function estimateForeclosure(i: ForeclosureInput): ForeclosureEstimate {
  const daysRun = dayDiff(i.startDate, i.closeDate);
  const reduced = Math.max(0, i.ratePct - i.penaltyPct); const noInterest = daysRun < 7;
  let principalReturned = 0;
  if (i.kind === "fd") principalReturned = i.principal ?? 0; else for (const p of i.contributions ?? []) principalReturned += p.a;
  // interest for the period run at a given rate — called twice, at the reduced rate (what the bank pays) and at the full contracted rate (what it would have paid)
  const interestAt = (rate: number) => {
    if (noInterest) return 0;
    if (i.kind === "fd") {
      if (i.payoutFrequency === "at_maturity") {
        const [sy, sm, sd] = i.startDate.split("-").map(Number), [cy, cm, cd] = i.closeDate.split("-").map(Number);
        const fullMonths = (cy - sy) * 12 + (cm - sm) - (cd < sd ? 1 : 0); const q = Math.max(0, Math.floor(fullMonths / 3));
        const grown = principalReturned * Math.pow(1 + rate / 400, q); const remDays = dayDiff(addMonths(i.startDate, 3 * q), i.closeDate);
        return grown * (1 + (rate / 100) * remDays / 365) - principalReturned;
      }
      return principalReturned * (rate / 100) * daysRun / 365;
    }
    return (i.contributions ?? []).reduce((t, p) => t + p.a * (rate / 100) * dayDiff(String(p.on).slice(0, 10), i.closeDate) / 365, 0);
  };
  const interest = interestAt(reduced); const paid = i.interestAlreadyPaid ?? 0;
  // the penalty is not a payment to anyone: it is interest the bank does not pay, i.e. the gap between the contracted rate and the reduced rate
  const penaltyCost = interestAt(i.ratePct) - interest;
  return { daysRun, reducedRatePct: r2(reduced), principalReturned: r2(principalReturned), interest: r2(interest), interestAlreadyPaid: r2(paid), estimatedCredit: r2(principalReturned + interest - paid), penaltyCost: r2(penaltyCost) };
}

/** Whether a type's rule lets this deposit be closed on this date. A locked type can still be closed as a bank exception (owner, with a reason). */
export function foreclosureEligibility(type: { break_rule: "allowed" | "after_lock_in" | "never"; lock_in_months: number; label?: string }, startDate: string, closeDate: string): { allowed: boolean; needsException: boolean; reason: string | null } {
  if (type.break_rule === "never") return { allowed: false, needsException: true, reason: `${type.label ?? "This deposit type"} cannot be closed before maturity` };
  if (type.break_rule === "after_lock_in") {
    const [sy, sm, sd] = startDate.split("-").map(Number), [cy, cm, cd] = closeDate.split("-").map(Number);
    const months = (cy - sy) * 12 + (cm - sm) - (cd < sd ? 1 : 0);
    if (months < type.lock_in_months) return { allowed: false, needsException: true, reason: `${type.label ?? "This deposit type"} can be closed only after ${type.lock_in_months} months (this one has run ${Math.max(0, months)})` };
  }
  return { allowed: true, needsException: false, reason: null };
}

/** A bank credit within ₹10 or 0.5% of the amount recorded counts as the same amount; anything further apart is a variance to review. */
export const foreclosureTolerance = (expected: number) => Math.max(10, Math.abs(expected) * 0.005);
export const foreclosureCreditMatches = (expected: number, credited: number) => Math.abs(credited - expected) <= foreclosureTolerance(expected);
