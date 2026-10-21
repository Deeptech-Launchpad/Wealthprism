import type { Column } from "./doc.js";
const esc = (v: any) => { if (v == null) return ""; const s = typeof v === "object" ? JSON.stringify(v) : String(v); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
/** RFC 4180 CSV with a UTF-8 BOM so Excel opens Indian text correctly. */
export function toCsv(columns: Column[], rows: Record<string, any>[]): string {
  const lines = [columns.map((c) => esc(c.label)).join(",")]; for (const r of rows) lines.push(columns.map((c) => esc(r[c.key])).join(","));
  return "\uFEFF" + lines.join("\r\n") + "\r\n";
}
export function toJsonl(rows: Record<string, any>[]): string { return rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : ""); }
