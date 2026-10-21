/** The report document model every renderer (PDF, XLSX, CSV, HTML) consumes. Builders in the API produce it; nothing here touches the database. */
export type Align = "left" | "right" | "center";
export type CellKind = "text" | "number" | "money" | "pct" | "int" | "date";
export interface Column { key: string; label: string; align?: Align; width?: number; kind?: CellKind }
export type Section =
  | { type: "heading"; text: string; level?: 1 | 2 | 3 }
  | { type: "paragraph"; text: string; style?: "normal" | "small" | "note" }
  | { type: "kv"; title?: string; items: { label: string; value: string | number | null | undefined; kind?: CellKind }[]; columns?: 1 | 2 | 3 }
  | { type: "table"; title?: string; sheet?: string; columns: Column[]; rows: Record<string, any>[]; totals?: Record<string, any>; note?: string; empty?: string }
  | { type: "pagebreak" };
export interface ReportDoc {
  code: string; title: string; subtitle?: string;
  family: string; generated_at: string;           // ISO timestamp; rendered in IST on every page
  period?: string; entity?: string; audience?: string;
  sections: Section[]; footer_note?: string;      // e.g. "Projection, not advice"
}
export interface PackCover { title: string; audience: string; period: string; version: number; family: string; generated_at: string; correction_note?: string | null; supersedes?: string | null; recipients?: string[] }

const IST = 5.5 * 3600 * 1000;
export function fmtIst(iso: string | Date, withTime = true): string {
  const d = new Date(new Date(iso).getTime() + IST);
  const mon = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getUTCMonth()];
  const date = `${String(d.getUTCDate()).padStart(2, "0")} ${mon} ${d.getUTCFullYear()}`;
  return withTime ? `${date} ${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")} IST` : date;
}
/** Indian digit grouping: 12,34,567.89 */
export function fmtInr(v: any, decimals = 2): string {
  if (v == null || v === "" || Number.isNaN(Number(v))) return "";
  const n = Number(v); const neg = n < 0; const [i, f] = Math.abs(n).toFixed(decimals).split(".");
  const last3 = i.slice(-3); const rest = i.slice(0, -3); const grouped = rest ? rest.replace(/\B(?=(\d{2})+(?!\d))/g, ",") + "," + last3 : last3;
  return (neg ? "-" : "") + grouped + (decimals ? "." + f : "");
}
export function fmtCell(v: any, kind: CellKind = "text"): string {
  if (v == null || v === "") return "";
  switch (kind) {
    case "money": return fmtInr(v, 2);
    case "number": return fmtInr(v, 2);
    case "int": return fmtInr(v, 0);
    case "pct": return Number.isNaN(Number(v)) ? String(v) : `${Number(v).toFixed(2)}%`;
    case "date": return /^\d{4}-\d{2}-\d{2}/.test(String(v)) ? fmtIst(String(v).slice(0, 10) + "T00:00:00Z", false) : String(v);
    default: return typeof v === "object" ? JSON.stringify(v) : String(v);
  }
}
export const isNumeric = (k?: CellKind) => k === "money" || k === "number" || k === "int" || k === "pct";
/** Sum a numeric column for a totals row. */
export function sumCol(rows: Record<string, any>[], key: string): number { return rows.reduce((s, r) => s + (Number(r[key]) || 0), 0); }
