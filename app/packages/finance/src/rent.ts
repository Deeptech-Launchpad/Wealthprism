/** Rent schedules, GST on commercial rent and property P&L — pure functions; rates come in as data. */
export interface LeaseTerms {
  startDate: string; endDate: string; rent: number; dueDay: number;
  escalationPct?: number; escalationEveryMonths?: number | null;
  gstApplicable?: boolean; gstRate?: number; tdsApplicable?: boolean; tdsRate?: number;
}
export interface RentRow { periodMonth: string; dueDate: string; expectedRent: number; expectedGst: number; expectedTds: number }

const pad = (n: number) => String(n).padStart(2, "0");
const ym = (y: number, m: number) => `${y}-${pad(m)}`; // m 1-12
const daysInMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

/** One row per calendar month of the term. Rent steps up by escalationPct every escalationEveryMonths from the start,
 *  compounding; GST and TDS are computed on the escalated rent. The due date is the due day of that month (clamped). */
export function generateRentSchedule(t: LeaseTerms): RentRow[] {
  const [sy, sm] = t.startDate.split("-").map(Number), [ey, em] = t.endDate.split("-").map(Number);
  const rows: RentRow[] = [];
  let y = sy, m = sm, i = 0;
  while (y < ey || (y === ey && m <= em)) {
    const steps = t.escalationEveryMonths && t.escalationPct ? Math.floor(i / t.escalationEveryMonths) : 0;
    const rent = +(t.rent * Math.pow(1 + (t.escalationPct ?? 0) / 100, steps)).toFixed(2);
    const gst = t.gstApplicable ? +((rent * (t.gstRate ?? 18)) / 100).toFixed(2) : 0;
    const tds = t.tdsApplicable ? +((rent * (t.tdsRate ?? 10)) / 100).toFixed(2) : 0;
    rows.push({ periodMonth: `${ym(y, m)}-01`, dueDate: `${ym(y, m)}-${pad(Math.min(t.dueDay, daysInMonth(y, m)))}`, expectedRent: rent, expectedGst: gst, expectedTds: tds });
    i++; m++; if (m > 12) { m = 1; y++; }
  }
  return rows;
}

/** Intra-state supply splits the tax into CGST + SGST; inter-state is IGST. Unknown recipient state → treated as intra-state. */
export function gstSplit(taxableValue: number, ratePct: number, supplierState: string, recipientState?: string | null) {
  const tax = +((taxableValue * ratePct) / 100).toFixed(2);
  if (recipientState && recipientState !== supplierState) return { cgst: 0, sgst: 0, igst: tax, total: tax };
  const half = +(tax / 2).toFixed(2);
  return { cgst: half, sgst: +(tax - half).toFixed(2), igst: 0, total: tax };
}

/** Indian financial year label for a date: 2026-09-01 → 2026-27. */
export function fyOf(date: string): string { const [y, m] = date.split("-").map(Number); const s = m >= 4 ? y : y - 1; return `${s}-${String(s + 1).slice(-2)}`; }
export function fyStart(fy: string): string { return `${fy.slice(0, 4)}-04-01`; }

export interface PnlInput { rentReceived: number; propertyTax: number; expenses: number; currentValue: number; annualRent: number }
/** Gross yield on the current valuation from contracted rent; net yield after tax and revenue expenses. */
export function propertyPnl(p: PnlInput) {
  const net = +(p.rentReceived - p.propertyTax - p.expenses).toFixed(2);
  const gross = p.currentValue > 0 ? +((p.annualRent / p.currentValue) * 100).toFixed(2) : null;
  const netYield = p.currentValue > 0 && p.annualRent > 0 ? +(((p.annualRent - (p.propertyTax + p.expenses) * (p.rentReceived > 0 ? p.annualRent / p.rentReceived : 1)) / p.currentValue) * 100).toFixed(2) : null;
  return { net, grossYieldPct: gross, netYieldPct: netYield };
}
