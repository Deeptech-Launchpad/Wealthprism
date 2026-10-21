import { csv, dedupKey, parseDate, parseIndianNumber, ParsedBankTxn, ParseResult } from "./types.js";
type Layout = { provider: string; date: string[]; narration: string[]; withdrawal?: string[]; deposit?: string[]; amount?: string[]; balance?: string[]; ref?: string[]; valueDate?: string[] };
const LAYOUTS: Layout[] = [
  { provider: "hdfc", date: ["date"], narration: ["narration"], withdrawal: ["withdrawal amt."], deposit: ["deposit amt."], balance: ["closing balance"], ref: ["chq./ref.no."], valueDate: ["value dt"] },
  { provider: "icici", date: ["transaction date", "value date"], narration: ["transaction remarks", "description"], withdrawal: ["withdrawal amount (inr )", "withdrawal amount"], deposit: ["deposit amount (inr )", "deposit amount"], balance: ["balance (inr )", "balance"], ref: ["cheque number", "transaction id"] },
  { provider: "sbi", date: ["txn date"], narration: ["description"], withdrawal: ["debit"], deposit: ["credit"], balance: ["balance"], ref: ["ref no./cheque no."], valueDate: ["value date"] },
  { provider: "kotak", date: ["date"], narration: ["description"], withdrawal: ["debit"], deposit: ["credit"], balance: ["balance"], ref: ["chq / ref number"] },
  { provider: "axis", date: ["tran date"], narration: ["particulars"], withdrawal: ["debit"], deposit: ["credit"], balance: ["balance"], ref: ["chq no"] },
];
/** Detects the bank layout from the header row; parses any bank whose header matches a layout. */
export function parseBankCsv(text: string, accountMasked?: string): ParseResult<ParsedBankTxn> {
  const rows = csv(text); const h = rows[0].map((x) => x.trim().toLowerCase());
  const find = (names: string[]) => h.findIndex((x) => names.includes(x));
  const layout = LAYOUTS.find((L) => find(L.date) >= 0 && find(L.narration) >= 0 && ((L.withdrawal && find(L.withdrawal) >= 0) || (L.amount && find(L.amount) >= 0)));
  if (!layout) return { rows: [], errors: [{ row: 0, message: "unrecognised bank statement layout" }], detectedHeaders: h, provider: "unknown" };
  const c = (r: string[], names?: string[]) => { const i = names ? find(names) : -1; return i >= 0 ? (r[i] ?? "").trim() : ""; };
  const out: ParsedBankTxn[] = []; const errors: { row: number; message: string }[] = [];
  rows.slice(1).forEach((r, i) => {
    try {
      const w = c(r, layout.withdrawal), d = c(r, layout.deposit);
      const amount = layout.amount ? parseIndianNumber(c(r, layout.amount)) : (d ? parseIndianNumber(d) : 0) - (w ? parseIndianNumber(w) : 0);
      const date = parseDate(c(r, layout.date)); const narration = c(r, layout.narration); const bal = c(r, layout.balance);
      out.push({ source: "bank_csv", provider: layout.provider, accountHint: { masked: accountMasked }, date, valueDate: layout.valueDate && c(r, layout.valueDate) ? parseDate(c(r, layout.valueDate)) : undefined, narration, amount: +amount.toFixed(2), balanceAfter: bal ? parseIndianNumber(bal) : undefined, ref: dedupKey([layout.provider, date, narration, amount, c(r, layout.ref)]) });
    } catch (e: any) { errors.push({ row: i + 2, message: e.message }); }
  });
  return { rows: out, errors, detectedHeaders: h, provider: layout.provider };
}
/** Account Aggregator FI data (ReBIT deposit schema) → bank transactions + balance. */
export function parseAaDeposit(json: any): ParseResult<ParsedBankTxn> & { balance?: number; balanceAsOf?: string; masked?: string } {
  const acc = json.account ?? json; const txns = acc?.Transactions?.Transaction ?? [];
  const rows: ParsedBankTxn[] = txns.map((t: any) => ({ source: "aa", provider: "aa", accountHint: { masked: acc.maskedAccNumber?.slice(-4) }, date: (t.valueDate ?? t.transactionTimestamp).slice(0, 10), valueDate: t.valueDate, narration: t.narration, amount: (t.type === "DEBIT" ? -1 : 1) * Number(t.amount), balanceAfter: t.currentBalance ? Number(t.currentBalance) : undefined, ref: dedupKey(["aa", acc.maskedAccNumber, t.txnId ?? t.reference, t.amount]) }));
  return { rows, errors: [], provider: "aa", balance: acc?.Summary?.currentBalance ? Number(acc.Summary.currentBalance) : undefined, balanceAsOf: acc?.Summary?.balanceDateTime, masked: acc?.maskedAccNumber };
}
