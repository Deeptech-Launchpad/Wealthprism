import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderPdf, renderPackPdf, renderXlsx, rowsToXlsx, toCsv, toJsonl, renderHtml, docFromHtml, unzip, extractPdfText, PdfError, toParquet, fmtInr, fmtCell, type ReportDoc } from "../src/index.js";

const py = (code: string, input?: Buffer) => spawnSync("python3", ["-c", code], { input, maxBuffer: 64 * 1024 * 1024 });
const has = (mod: string) => py(`import ${mod}`).status === 0;
const HAS_PYPDF = has("pypdf"), HAS_CRYPTO = HAS_PYPDF && has("cryptography"), HAS_ARROW = has("pyarrow"), HAS_OPENPYXL = has("openpyxl");
const dir = mkdtempSync(join(tmpdir(), "fo-reports-"));
const rows = Array.from({ length: 70 }, (_, i) => ({ instrument: i % 3 ? `Instrument ${i} with a fairly long descriptive name` : "TCS", entity: ["Arjun Mehta", "Mehta HUF", "Spouse"][i % 3], qty: (i + 1) * 10, cost: 1234.5 * (i + 1), value: 1500.25 * (i + 1), gain_pct: (i % 7) - 3, sold_on: `2026-0${(i % 9) + 1}-1${i % 9}` }));
const doc: ReportDoc = {
  code: "net_worth", title: "Consolidated net worth statement", subtitle: "By asset class × entity", family: "Mehta Family", generated_at: "2026-09-12T10:35:00Z", period: "FY 2026-27 to date", audience: "principal", footer_note: "Figures in ₹; projection, not advice",
  sections: [
    { type: "kv", title: "Key figures", items: [{ label: "Net worth", value: 123456789.5, kind: "money" }, { label: "MoM change", value: 1.234, kind: "pct" }, { label: "Entities", value: 3, kind: "int" }, { label: "As of", value: "2026-09-12", kind: "date" }] },
    { type: "heading", text: "Holdings", level: 1 },
    { type: "paragraph", text: "A long paragraph that must wrap across several lines in the PDF because it keeps going on and on about the portfolio, the buckets, the goals and the ₹ figures that need Indian grouping such as ₹12,34,567.89 — with an em dash and “curly quotes”." },
    { type: "paragraph", style: "note", text: "Nothing here is advice." },
    { type: "table", title: "Holdings by entity", sheet: "Holdings", columns: [{ key: "instrument", label: "Instrument" }, { key: "entity", label: "Entity" }, { key: "qty", label: "Qty", kind: "int" }, { key: "cost", label: "Cost (₹)", kind: "money" }, { key: "value", label: "Value (₹)", kind: "money" }, { key: "gain_pct", label: "Gain %", kind: "pct" }, { key: "sold_on", label: "Sold on", kind: "date" }], rows, totals: { instrument: "Total", cost: rows.reduce((s, r) => s + r.cost, 0), value: rows.reduce((s, r) => s + r.value, 0) }, note: "Cost is FIFO." },
    { type: "table", title: "Empty section", columns: [{ key: "a", label: "A" }], rows: [], empty: "No liabilities." },
  ],
};

describe("formatting", () => {
  it("groups digits the Indian way and formats kinds", () => {
    expect(fmtInr(12345678.9)).toBe("1,23,45,678.90"); expect(fmtInr(-1234.5)).toBe("-1,234.50"); expect(fmtInr(999, 0)).toBe("999"); expect(fmtInr(100000, 0)).toBe("1,00,000");
    expect(fmtCell(12.345, "pct")).toBe("12.35%"); expect(fmtCell("2026-04-01", "date")).toBe("01 Apr 2026"); expect(fmtCell(null, "money")).toBe("");
  });
});

describe("PDF", () => {
  const pdf = renderPdf(doc);
  it("is a valid PDF with a watermark, footer and repeated table headers that our own extractor reads back", () => {
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-"); expect(pdf.toString("latin1")).toMatch(/startxref\n\d+\n%%EOF/);
    const text = extractPdfText(pdf); expect(text).toContain("Consolidated net worth statement"); expect(text).toContain("Mehta Family"); expect(text).toContain("12,34,56,789.50"); expect(text).toMatch(/Page 1 of \d+/); expect(text).toContain("Rs.12,34,567.89"); expect(text).toContain("No liabilities.");
    const pages = (pdf.toString("latin1").match(/\/Type \/Page\b/g) ?? []).length; expect(pages).toBeGreaterThanOrEqual(3);   // 70 rows wrap over pages
    expect((text.match(/Instrument Entity Qty/g) ?? []).length).toBeGreaterThanOrEqual(pages - 1);   // header repeated on each table page
    writeFileSync(join(dir, "doc.pdf"), pdf);
  });
  it.skipIf(!HAS_PYPDF)("parses in pypdf: page count, xref offsets and text", () => {
    const r = py(`import sys,json;from pypdf import PdfReader;import io;r=PdfReader(io.BytesIO(sys.stdin.buffer.read()),strict=True);print(json.dumps({"n":len(r.pages),"t":r.pages[0].extract_text(),"last":r.pages[-1].extract_text(),"title":r.metadata.title}))`, pdf);
    expect(r.status, r.stderr.toString()).toBe(0); const o = JSON.parse(r.stdout.toString());
    expect(o.title).toBe("Consolidated net worth statement"); expect(o.t).toContain("Mehta Family"); expect(o.t).toContain("Page 1 of " + o.n); expect(o.last).toContain(`Page ${o.n} of ${o.n}`); expect(o.t).toContain("Key figures");
  });
  it.skipIf(!HAS_CRYPTO)("opens RC4-128 and AES-128 password-protected PDFs with the user password and refuses the wrong one", () => {
    for (const algo of ["RC4-128", "AES-128", "RC4-40"]) {
      const r = py(`import sys,io;from pypdf import PdfReader,PdfWriter;r=PdfReader(io.BytesIO(sys.stdin.buffer.read()));w=PdfWriter();w.append(r);w.encrypt(user_password="ABCDE1234F",owner_password="owner",algorithm="${algo}");b=io.BytesIO();w.write(b);sys.stdout.buffer.write(b.getvalue())`, pdf);
      expect(r.status, r.stderr.toString()).toBe(0); const enc = r.stdout as Buffer;
      const text = extractPdfText(enc, "ABCDE1234F"); expect(text, algo).toContain("Consolidated net worth statement"); expect(text, algo).toContain("12,34,56,789.50");
      expect(() => extractPdfText(enc, "wrong")).toThrow(PdfError); try { extractPdfText(enc, ""); } catch (e: any) { expect(e.code).toBe("password_required"); }
    }
  });
  it.skipIf(!HAS_PYPDF)("a pack has a cover, a contents page with the right page numbers and one running page count", () => {
    const d2: ReportDoc = { ...doc, code: "capital_gains", title: "Capital gains — Schedule CG", entity: "Arjun Mehta", sections: doc.sections.slice(0, 2) };
    const d3: ReportDoc = { ...doc, code: "rent_gst", title: "Rental income & GST register", sections: [{ type: "paragraph", text: "short" }] };
    const pack = renderPackPdf({ title: "CA pack Q2 FY 2026-27", audience: "ca", period: "Jul–Sep 2026", version: 2, family: "Mehta Family", generated_at: "2026-10-05T04:30:00Z", correction_note: "TDS column corrected", supersedes: "v1 of 03 Oct 2026", recipients: ["ca@example.com"] }, [doc, d2, d3]);
    const r = py(`import sys,json,io;from pypdf import PdfReader;r=PdfReader(io.BytesIO(sys.stdin.buffer.read()),strict=True);print(json.dumps({"n":len(r.pages),"p":[p.extract_text() for p in r.pages]}))`, pack);
    expect(r.status, r.stderr.toString()).toBe(0); const o = JSON.parse(r.stdout.toString());
    expect(o.p[0]).toContain("CA pack Q2 FY 2026-27"); expect(o.p[0]).toContain("Correction: TDS column corrected"); expect(o.p[1]).toContain("Contents");
    const tocLine = (o.p[1] as string).split("\n").find((l) => l.includes("Capital gains")); expect(tocLine).toBeTruthy(); const pageNo = Number(tocLine!.match(/(\d+)\s*$/)?.[1]);
    expect(o.p[pageNo - 1]).toContain("Capital gains"); expect(o.p[pageNo - 1]).toContain("Arjun Mehta");
    const last = o.p[o.n - 1]; expect(last).toContain(`Page ${o.n} of ${o.n}`); expect(last).toContain("Rental income & GST register");
    writeFileSync(join(dir, "pack.pdf"), pack);
  });
});

describe("XLSX / CSV / JSONL", () => {
  it("writes a workbook with a summary sheet and one sheet per table, numbers as numbers", () => {
    const x = renderXlsx(doc); const files = unzip(x);
    expect(Object.keys(files)).toEqual(expect.arrayContaining(["[Content_Types].xml", "xl/workbook.xml", "xl/styles.xml", "xl/worksheets/sheet1.xml", "xl/worksheets/sheet2.xml", "xl/worksheets/sheet3.xml"]));
    expect(files["xl/workbook.xml"].toString()).toContain('name="Holdings"'); const sh = files["xl/worksheets/sheet2.xml"].toString();
    expect(sh).toContain("<v>1234.5</v>"); expect(sh).toContain('<t xml:space="preserve">TCS</t>'); expect(sh).toMatch(/<c r="D5" s="2"><v>1234.5<\/v>/); expect(files["xl/worksheets/sheet1.xml"].toString()).toContain("12,34,56,789.50".replace(/,/g, "") === "12345678.50" ? "<v>123456789.5</v>" : "<v>123456789.5</v>");
    writeFileSync(join(dir, "doc.xlsx"), x);
  });
  it.skipIf(!HAS_OPENPYXL)("opens in openpyxl with typed cells", () => {
    const r = py(`import sys,io,json;from openpyxl import load_workbook;wb=load_workbook(io.BytesIO(sys.stdin.buffer.read()));ws=wb["Holdings"];print(json.dumps({"sheets":wb.sheetnames,"h":[c.value for c in ws[4]],"r":[c.value for c in ws[5]],"fmt":ws["D5"].number_format,"bold":ws["A4"].font.b}))`, renderXlsx(doc));
    expect(r.status, r.stderr.toString()).toBe(0); const o = JSON.parse(r.stdout.toString());
    expect(o.sheets).toEqual(["Summary", "Holdings", "Empty section"]); expect(o.h[0]).toBe("Instrument"); expect(o.r[3]).toBe(1234.5); expect(o.fmt).toBe("#,##0.00"); expect(o.bold).toBe(true);
    const e = py(`import sys,io;from openpyxl import load_workbook;wb=load_workbook(io.BytesIO(sys.stdin.buffer.read()));print(wb["Sheet"]["B2"].value, wb["Sheet"]["A2"].value)`, rowsToXlsx("Sheet", [{ key: "a", label: "A" }, { key: "n", label: "N", kind: "money" }], [{ a: "x", n: "12.50" }]));
    expect(e.stdout.toString().trim()).toBe("12.5 x");
  });
  it("quotes CSV fields and prefixes a BOM", () => {
    const csv = toCsv([{ key: "a", label: "Name" }, { key: "b", label: "Amount" }], [{ a: 'He said "hi", ok', b: 1.5 }, { a: "line\nbreak", b: null }]);
    expect(csv.charCodeAt(0)).toBe(0xfeff); expect(csv).toContain('"He said ""hi"", ok",1.5'); expect(csv).toContain('"line\nbreak",');
    expect(toJsonl([{ a: 1 }, { b: "x" }])).toBe('{"a":1}\n{"b":"x"}\n');
  });
});

describe("HTML", () => {
  it("renders and converts back into a document", () => {
    const html = renderHtml(doc); expect(html).toContain("<h3>Holdings by entity</h3>"); expect(html).toContain("12,34,56,789.50"); expect(html).toContain("generated 12 Sep 2026 16:05 IST");
    const back = docFromHtml(`<html><body><h1>Investment Policy Statement</h1><p>Scope: <b>family</b> &amp; goals</p><h2>Allocation</h2><table><tr><th>Class</th><th>Target</th></tr><tr><td>Equity</td><td>45%</td></tr><tr><td>Debt</td><td>40%</td></tr></table><ul><li>one</li><li>two</li></ul></body></html>`, { code: "ips", title: "IPS", family: "Mehta Family", generated_at: "2026-09-12T00:00:00Z" });
    expect(back.sections[0]).toEqual({ type: "heading", text: "Investment Policy Statement", level: 1 }); expect(back.sections[1]).toEqual({ type: "paragraph", text: "Scope: family & goals" });
    const t = back.sections.find((s) => s.type === "table") as any; expect(t.columns.map((c: any) => c.label)).toEqual(["Class", "Target"]); expect(t.rows).toEqual([{ c0: "Equity", c1: "45%" }, { c0: "Debt", c1: "40%" }]); expect(t.columns[1].align).toBe("right");
    expect(back.sections.filter((s) => s.type === "paragraph").map((s: any) => s.text)).toContain("• two");
    expect(extractPdfText(renderPdf(back))).toContain("Equity 45%");
  });
});

describe("Parquet", () => {
  const cols = [{ name: "id", type: "string" as const }, { name: "value", type: "double" as const }, { name: "qty", type: "int64" as const }, { name: "flag", type: "bool" as const }, { name: "on", type: "date" as const }];
  const data = [{ id: "a", value: 1.5, qty: 10, flag: true, on: "2026-04-01" }, { id: "b", value: null, qty: "20", flag: false, on: null }, { id: null, value: -3.25, qty: null, flag: null, on: "2026-09-12" }];
  it("has the magic bytes and a footer", () => { const p = toParquet(cols, data); expect(p.subarray(0, 4).toString()).toBe("PAR1"); expect(p.subarray(-4).toString()).toBe("PAR1"); writeFileSync(join(dir, "x.parquet"), p); });
  it.skipIf(!HAS_ARROW)("round-trips through pyarrow with nulls and types", () => {
    const f = join(dir, "rt.parquet"); writeFileSync(f, toParquet(cols, data));
    const r = py(`import pyarrow.parquet as pq,json;t=pq.read_table(${JSON.stringify(f)});print(json.dumps({"schema":[(f.name,str(f.type)) for f in t.schema],"rows":t.to_pylist()},default=str))`);
    expect(r.status, r.stderr.toString()).toBe(0); const o = JSON.parse(r.stdout.toString());
    expect(o.schema).toEqual([["id", "string"], ["value", "double"], ["qty", "int64"], ["flag", "bool"], ["on", "date32[day]"]]);
    expect(o.rows).toEqual([{ id: "a", value: 1.5, qty: 10, flag: true, on: "2026-04-01" }, { id: "b", value: null, qty: 20, flag: false, on: null }, { id: null, value: -3.25, qty: null, flag: null, on: "2026-09-12" }]);
  });
  it.skipIf(!HAS_ARROW)("handles a wide table with many rows", () => {
    const big = Array.from({ length: 5000 }, (_, i) => ({ id: `row-${i}`, value: i / 7, qty: i, flag: i % 2 === 0, on: "2026-01-01" })); const f = join(dir, "big.parquet"); writeFileSync(f, toParquet(cols, big));
    const r = py(`import pyarrow.parquet as pq;t=pq.read_table(${JSON.stringify(f)});print(t.num_rows, t.column("qty").to_pylist()[4999], round(t.column("value").to_pylist()[7],3))`); expect(r.status, r.stderr.toString()).toBe(0); expect(r.stdout.toString().trim()).toBe("5000 4999 1.0");
  });
});
