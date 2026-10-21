import { zip } from "./zip.js";
import { fmtCell, fmtIst, isNumeric, type Column, type ReportDoc, type Section } from "./doc.js";
/** Minimal OOXML workbook writer: inline strings, real numbers, bold headers, money/percent number formats, column widths. Opens in Excel, LibreOffice and Power BI. */
const esc = (s: any) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "");
const colRef = (i: number) => { let s = ""; i++; while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; };
// cellXfs: 0 normal · 1 bold · 2 money (#,##0.00) · 3 bold money · 4 percent · 5 integer · 6 title · 7 header (bold, fill) · 8 muted
const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="3"><numFmt numFmtId="164" formatCode="#,##0.00"/><numFmt numFmtId="165" formatCode="0.00&quot;%&quot;"/><numFmt numFmtId="166" formatCode="#,##0"/></numFmts><fonts count="4"><font><sz val="10"/><name val="Calibri"/></font><font><b/><sz val="10"/><name val="Calibri"/></font><font><b/><sz val="14"/><color rgb="FF12213A"/><name val="Calibri"/></font><font><sz val="9"/><color rgb="FF5B6B82"/><name val="Calibri"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFF2F5F9"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left/><right/><top style="thin"><color rgb="FFB7C0CE"/></top><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="10"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="164" fontId="1" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyBorder="1"/><xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="166" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/><xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="0" fontId="1" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;
type Cell = { v: any; s?: number; kind?: "n" | "s" };
class Sheet {
  rows: Cell[][] = []; widths: number[] = [];
  constructor(public name: string) {}
  add(cells: Cell[]) { this.rows.push(cells); cells.forEach((c, i) => { const w = Math.min(60, Math.max(this.widths[i] ?? 8, String(c.kind === "n" ? fmtCell(c.v, "money") : c.v ?? "").length + 2)); this.widths[i] = w; }); }
  xml(): string {
    const rows = this.rows.map((r, ri) => `<row r="${ri + 1}">${r.map((c, ci) => { if (c.v == null || c.v === "") return ""; const ref = `${colRef(ci)}${ri + 1}`; const st = c.s ? ` s="${c.s}"` : ""; return c.kind === "n" ? `<c r="${ref}"${st}><v>${Number(c.v)}</v></c>` : `<c r="${ref}"${st} t="inlineStr"><is><t xml:space="preserve">${esc(c.v)}</t></is></c>`; }).join("")}</row>`).join("");
    const cols = this.widths.length ? `<cols>${this.widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join("")}</cols>` : "";
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"${this.rows.length > 2 ? ' showGridLines="1"' : ""}/></sheetViews>${cols}<sheetData>${rows}</sheetData></worksheet>`;
  }
}
const numStyle = (c: Column, bold = false) => (c.kind === "pct" ? 4 : c.kind === "int" ? 5 : bold ? 3 : 2);
function tableRows(sh: Sheet, columns: Column[], rows: Record<string, any>[], totals?: Record<string, any>) {
  sh.add(columns.map((c) => ({ v: c.label, s: 7 })));
  for (const r of rows) sh.add(columns.map((c) => (isNumeric(c.kind) && r[c.key] != null && r[c.key] !== "" && !Number.isNaN(Number(r[c.key])) ? { v: Number(r[c.key]), kind: "n" as const, s: numStyle(c) } : { v: fmtCell(r[c.key], c.kind === "date" ? "date" : "text") })));
  if (totals) sh.add(columns.map((c) => (isNumeric(c.kind) && totals[c.key] != null && totals[c.key] !== "" ? { v: Number(totals[c.key]), kind: "n" as const, s: numStyle(c, true) } : { v: totals[c.key] ?? "", s: 9 })));
}
const sheetName = (s: string, used: Set<string>) => { let base = s.replace(/[\\/*?:[\]]/g, " ").trim().slice(0, 28) || "Sheet"; let name = base, i = 2; while (used.has(name.toLowerCase())) name = `${base} ${i++}`; used.add(name.toLowerCase()); return name; };
/** One "Summary" sheet with the headings, key figures and paragraphs in order, then one sheet per table (named after the table). */
export function renderXlsx(doc: ReportDoc): Buffer {
  const used = new Set<string>(); const summary = new Sheet(sheetName("Summary", used)); const sheets: Sheet[] = [summary];
  summary.add([{ v: doc.title, s: 6 }]); if (doc.subtitle) summary.add([{ v: doc.subtitle, s: 8 }]);
  summary.add([{ v: `${doc.family}${doc.entity ? " · " + doc.entity : ""}${doc.period ? " · " + doc.period : ""} · generated ${fmtIst(doc.generated_at)}`, s: 8 }]); summary.add([]);
  for (const s of doc.sections as Section[]) {
    if (s.type === "heading") { summary.add([]); summary.add([{ v: s.text, s: s.level === 1 ? 6 : 1 }]); }
    else if (s.type === "paragraph") summary.add([{ v: s.text, s: s.style === "normal" ? 0 : 8 }]);
    else if (s.type === "kv") { if (s.title) summary.add([{ v: s.title, s: 1 }]); for (const i of s.items) summary.add([{ v: i.label }, isNumeric(i.kind) && i.value != null && i.value !== "" ? { v: Number(i.value), kind: "n", s: i.kind === "pct" ? 4 : i.kind === "int" ? 5 : 2 } : { v: fmtCell(i.value, i.kind ?? "text") }]); }
    else if (s.type === "table") {
      const sh = new Sheet(sheetName(s.sheet ?? s.title ?? `Table ${sheets.length}`, used)); sheets.push(sh);
      sh.add([{ v: s.title ?? doc.title, s: 6 }]); sh.add([{ v: `${doc.family}${doc.period ? " · " + doc.period : ""} · generated ${fmtIst(doc.generated_at)}`, s: 8 }]); sh.add([]);
      if (!s.rows.length && !s.totals) sh.add([{ v: s.empty ?? "Nothing to report for this period.", s: 8 }]); else tableRows(sh, s.columns, s.rows, s.totals);
      if (s.note) { sh.add([]); sh.add([{ v: s.note, s: 8 }]); }
      summary.add([{ v: s.title ?? sh.name, s: 1 }, { v: `${s.rows.length} rows — see sheet "${sh.name}"`, s: 8 }]);
    }
  }
  if (doc.footer_note) { summary.add([]); summary.add([{ v: doc.footer_note, s: 8 }]); }
  return workbook(sheets);
}
/** A workbook straight from columns + rows (bulk exports). */
export function rowsToXlsx(name: string, columns: Column[], rows: Record<string, any>[]): Buffer { const sh = new Sheet(sheetName(name, new Set())); tableRows(sh, columns, rows); return workbook([sh]); }
function workbook(sheets: Sheet[]): Buffer {
  const entries: { name: string; data: string }[] = [
    { name: "[Content_Types].xml", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>` },
    { name: "_rels/.rels", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>` },
    { name: "docProps/app.xml", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>Family Office</Application></Properties>` },
    { name: "xl/workbook.xml", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((s, i) => `<sheet name="${esc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets></workbook>` },
    { name: "xl/_rels/workbook.xml.rels", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("")}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>` },
    { name: "xl/styles.xml", data: STYLES },
    ...sheets.map((s, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: s.xml() })),
  ];
  return zip(entries);
}
