import { deflateSync } from "node:zlib";
import { fmtCell, fmtIst, isNumeric, type Column, type PackCover, type ReportDoc, type Section } from "./doc.js";
/**
 * Dependency-free PDF 1.4 writer: A4 portrait, Helvetica / Helvetica-Bold (standard fonts, WinAnsi), wrapped paragraphs, tables with repeated
 * headers across pages, key–value grids, a family-name watermark and a "generated at · page n of N" footer on every page, cover + table of
 * contents for packs. Text is encoded to cp1252 (₹ becomes "Rs."); the layout is deterministic so a regenerated report diffs cleanly.
 */
const W = 595.28, H = 841.89, M = 40, TOP = 62, BOTTOM = 48, CW = W - 2 * M;
const NAVY = "0.07 0.13 0.23", GREY = "0.36 0.42 0.51", LIGHT = "0.89 0.91 0.94", AMBER = "0.72 0.47 0.12";
// Helvetica / Helvetica-Bold advance widths for ASCII 32..126 (per 1000 em)
const HW = [278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584];
const HBW = [278,333,474,556,556,889,722,238,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,333,333,584,584,584,611,975,722,722,722,722,667,611,778,722,278,556,722,611,833,722,778,667,778,722,667,611,722,667,944,667,667,611,333,278,333,584,556,333,556,611,556,611,556,333,611,611,278,278,556,278,889,611,611,611,611,389,556,333,611,556,778,556,556,500,389,280,389,584];
const CP1252: Record<string, number> = { "€": 0x80, "…": 0x85, "‘": 0x91, "’": 0x92, "“": 0x93, "”": 0x94, "•": 0x95, "–": 0x96, "—": 0x97, "™": 0x99, "©": 0xa9, "®": 0xae, "°": 0xb0, "±": 0xb1, "²": 0xb2, "³": 0xb3, "·": 0xb7, "½": 0xbd, "¼": 0xbc, "¾": 0xbe, "×": 0xd7, "÷": 0xf7, "£": 0xa3, "¥": 0xa5, "§": 0xa7, "«": 0xab, "»": 0xbb };
const SUBS: [RegExp, string][] = [[/₹(?=\d)/g, "Rs."], [/₹\s*/g, "Rs. "], [/−/g, "-"], [/→/g, "->"], [/←/g, "<-"], [/≤/g, "<="], [/≥/g, ">="], [/≠/g, "!="], [/✓/g, "v"], [/✗|✕/g, "x"], [/ /g, " "], [/[   ]/g, " "], [/‑/g, "-"]];
export function toCp1252(s: string): string {   // returns a "binary" string (one char per byte)
  let t = String(s ?? ""); for (const [re, r] of SUBS) t = t.replace(re, r);
  let out = ""; for (const ch of t) { const c = ch.codePointAt(0)!; if (c < 0x80 || (c >= 0xa0 && c <= 0xff)) out += ch; else if (CP1252[ch] != null) out += String.fromCharCode(CP1252[ch]); else out += "?"; }
  return out;
}
const pdfStr = (bin: string) => "(" + bin.replace(/[\\()]/g, (m) => "\\" + m).replace(/\r/g, "\\r").replace(/\n/g, "\\n") + ")";
export function textWidth(bin: string, size: number, bold = false): number { const t = bold ? HBW : HW; let w = 0; for (let i = 0; i < bin.length; i++) { const c = bin.charCodeAt(i); w += c >= 32 && c <= 126 ? t[c - 32] : 556; } return (w * size) / 1000; }
function wrap(bin: string, width: number, size: number, bold = false): string[] {
  const lines: string[] = []; for (const para of bin.split("\n")) {
    const words = para.split(/(\s+)/).filter((w) => w.length); let line = "";
    for (const w of words) {
      if (/^\s+$/.test(w)) { if (line) line += " "; continue; }
      if (textWidth(line + w, size, bold) <= width) { line += w; continue; }
      if (line.trim()) lines.push(line.trimEnd()); line = "";
      let piece = w; while (textWidth(piece, size, bold) > width && piece.length > 1) { let k = piece.length; while (k > 1 && textWidth(piece.slice(0, k), size, bold) > width) k--; lines.push(piece.slice(0, k)); piece = piece.slice(k); } line = piece;
    }
    lines.push(line.trimEnd());
  }
  return lines.length ? lines : [""];
}
interface Page { ops: string[]; header: { left: string; right: string }; footnote?: string }
class Layout {
  pages: Page[] = []; y = H - TOP; header = { left: "", right: "" }; footnote?: string;
  constructor(public family: string) { this.newPage(); }
  get page() { return this.pages[this.pages.length - 1]; }
  newPage() { this.pages.push({ ops: [], header: { ...this.header }, footnote: this.footnote }); this.y = H - TOP; }
  ensure(h: number) { if (this.y - h < BOTTOM) this.newPage(); }
  text(x: number, y: number, bin: string, size: number, opts: { bold?: boolean; color?: string; align?: "left" | "right" | "center"; width?: number } = {}) {
    let tx = x; const tw = textWidth(bin, size, opts.bold); if (opts.align === "right") tx = x + (opts.width ?? 0) - tw; else if (opts.align === "center") tx = x + ((opts.width ?? 0) - tw) / 2;
    this.page.ops.push(`BT ${opts.color ?? "0 0 0"} rg /F${opts.bold ? 2 : 1} ${size} Tf ${tx.toFixed(2)} ${y.toFixed(2)} Td ${pdfStr(bin)} Tj ET`);
  }
  rect(x: number, y: number, w: number, h: number, fill: string) { this.page.ops.push(`${fill} rg ${x.toFixed(2)} ${y.toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)} re f`); }
  line(x1: number, y1: number, x2: number, y2: number, stroke = LIGHT, width = 0.5) { this.page.ops.push(`${stroke} RG ${width} w ${x1.toFixed(2)} ${y1.toFixed(2)} m ${x2.toFixed(2)} ${y2.toFixed(2)} l S`); }
  para(text: string, size: number, opts: { bold?: boolean; color?: string; x?: number; width?: number; lh?: number; before?: number; after?: number } = {}) {
    const x = opts.x ?? M, width = opts.width ?? CW, lh = opts.lh ?? size * 1.38; const lines = wrap(toCp1252(text), width, size, opts.bold);
    this.y -= opts.before ?? 0; for (const l of lines) { this.ensure(lh); this.y -= lh; this.text(x, this.y + lh * 0.28, l, size, { bold: opts.bold, color: opts.color }); } this.y -= opts.after ?? 0;
  }
  titleBlock(doc: ReportDoc) {
    this.para(doc.title, 18, { bold: true, color: NAVY, after: 2 }); if (doc.subtitle) this.para(doc.subtitle, 10, { color: GREY, after: 2 });
    const meta = [doc.family, doc.entity, doc.period, doc.audience ? `for the ${doc.audience}` : null].filter(Boolean).join(" · ") + ` · generated ${fmtIst(doc.generated_at)}`;
    this.para(meta, 8.5, { color: GREY, after: 6 }); this.line(M, this.y, W - M, this.y, LIGHT, 0.8); this.y -= 10;
  }
  heading(text: string, level: 1 | 2 | 3) {
    const size = level === 1 ? 14 : level === 2 ? 11.5 : 10; this.ensure(size * 3); this.para(text, size, { bold: true, color: NAVY, before: level === 3 ? 8 : 12, after: 3 });
    if (level === 1) { this.line(M, this.y, W - M, this.y, LIGHT, 0.6); this.y -= 6; }
  }
  kv(s: Extract<Section, { type: "kv" }>) {
    if (s.title) this.heading(s.title, 3); const cols = s.columns ?? 2; const colW = (CW - (cols - 1) * 16) / cols; const rowH = 15; let i = 0;
    while (i < s.items.length) { this.ensure(rowH); this.y -= rowH; for (let c = 0; c < cols && i < s.items.length; c++, i++) { const it = s.items[i]; const x = M + c * (colW + 16); const val = toCp1252(fmtCell(it.value, it.kind ?? "text")); const vw = textWidth(val, 9.5, true); const label = toCp1252(it.label); let lab = label; while (textWidth(lab, 8.5) > colW - vw - 8 && lab.length > 4) lab = lab.slice(0, -2) + "…"; this.text(x, this.y + 4, lab, 8.5, { color: GREY }); this.text(x, this.y + 4, val, 9.5, { bold: true, align: "right", width: colW }); this.line(x, this.y, x + colW, this.y, LIGHT, 0.3); } }
    this.y -= 6;
  }
  table(s: Extract<Section, { type: "table" }>) {
    if (s.title) this.heading(s.title, 3);
    if (!s.rows.length && !s.totals) { this.para(s.empty ?? "Nothing to report for this period.", 8.5, { color: GREY, after: 4 }); return; }
    const size = 8.2, lh = size * 1.3, pad = 3.5; const cols = s.columns; const numeric = (c: Column) => isNumeric(c.kind) || c.align === "right";
    // column widths: explicit relative widths, else header vs typical content estimate, scaled to the content width
    const est = cols.map((c) => { if (c.width) return c.width; const hw = textWidth(toCp1252(c.label), size, true) + 2 * pad; const sample = [...s.rows.slice(0, 60), ...(s.totals ? [s.totals] : [])].map((r) => textWidth(toCp1252(fmtCell(r[c.key], c.kind)), size) + 2 * pad); sample.sort((a, b) => a - b); const p90 = sample[Math.floor(sample.length * 0.9)] ?? hw; return Math.min(numeric(c) ? 110 : 220, Math.max(numeric(c) ? 48 : 40, hw * 0.7, p90)); });
    const total = est.reduce((a, b) => a + b, 0); const widths = est.map((w) => (w / total) * CW);
    const cells = (r: Record<string, any>, bold = false) => cols.map((c, i) => wrap(toCp1252(fmtCell(r[c.key], c.kind)), widths[i] - 2 * pad, size, bold));
    const drawRow = (lines: string[][], opts: { bold?: boolean; fill?: string; topRule?: boolean; color?: string }) => {
      const n = Math.max(...lines.map((l) => l.length)); const h = n * lh + 2 * pad; this.ensure(h); if (opts.fill) this.rect(M, this.y - h, CW, h, opts.fill); if (opts.topRule) this.line(M, this.y, W - M, this.y, "0.55 0.6 0.68", 0.8);
      let x = M; cols.forEach((c, i) => { lines[i].forEach((l, k) => this.text(x + pad, this.y - pad - (k + 1) * lh + lh * 0.3, l, size, { bold: opts.bold, color: opts.color, align: numeric(c) ? "right" : "left", width: widths[i] - 2 * pad })); x += widths[i]; });
      this.y -= h; this.line(M, this.y, W - M, this.y, LIGHT, 0.3);
    };
    const headerLines = cols.map((c) => wrap(toCp1252(c.label), widths[cols.indexOf(c)] - 2 * pad, size, true));
    const drawHeader = () => drawRow(headerLines, { bold: true, fill: "0.95 0.96 0.98", color: NAVY });
    drawHeader(); let pageIdx = this.pages.length;
    for (const r of s.rows) { const lines = cells(r); const h = Math.max(...lines.map((l) => l.length)) * lh + 2 * pad; if (this.y - h < BOTTOM) { this.newPage(); drawHeader(); pageIdx = this.pages.length; } drawRow(lines, {}); }
    if (s.totals) { const lines = cells(s.totals, true); const h = Math.max(...lines.map((l) => l.length)) * lh + 2 * pad; if (this.y - h < BOTTOM) { this.newPage(); drawHeader(); } drawRow(lines, { bold: true, topRule: true }); }
    void pageIdx; if (s.note) this.para(s.note, 7.8, { color: GREY, before: 3 }); this.y -= 8;
  }
  section(s: Section) {
    switch (s.type) {
      case "heading": return this.heading(s.text, s.level ?? 2);
      case "paragraph": if (s.style === "note") { const lines = wrap(toCp1252(s.text), CW - 14, 8.5); const h = lines.length * 11.7 + 8; this.ensure(h); this.rect(M, this.y - h, 3, h, AMBER); this.rect(M + 3, this.y - h, CW - 3, h, "0.98 0.96 0.91"); const top = this.y; this.y -= 4; for (const l of lines) { this.y -= 11.7; this.text(M + 10, this.y + 3.3, l, 8.5, { color: "0.54 0.43 0.11" }); } this.y = top - h - 6; return; }
        return this.para(s.text, s.style === "small" ? 8.5 : 9.5, { color: s.style === "small" ? GREY : "0 0 0", after: 5 });
      case "kv": return this.kv(s);
      case "table": return this.table(s);
      case "pagebreak": return this.newPage();
    }
  }
}
export function layoutDoc(doc: ReportDoc, into?: Layout): Layout {
  const L = into ?? new Layout(doc.family); L.header = { left: toCp1252(doc.title), right: toCp1252(doc.family) }; L.footnote = doc.footer_note ? toCp1252(doc.footer_note) : undefined;
  if (into) L.newPage(); else { L.page.header = { ...L.header }; L.page.footnote = L.footnote; }
  L.titleBlock(doc); for (const s of doc.sections) L.section(s); return L;
}
function chrome(pages: Page[], family: string, generatedAt: string, skipOn: Set<number> = new Set()): string[] {
  const fam = toCp1252(family); const gen = toCp1252(`${family} · generated ${fmtIst(generatedAt)}`);
  return pages.map((p, i) => {
    const ops = [...p.ops]; const n = i + 1;
    // watermark: family name across the page, very light, drawn first so content sits on top
    const wm = `q 0.94 g BT /F2 40 Tf 0.766 0.643 -0.643 0.766 150 260 Tm ${pdfStr(fam)} Tj ET Q`;
    if (!skipOn.has(i)) ops.unshift(wm);
    if (!skipOn.has(i)) { ops.push(`BT ${GREY} rg /F2 7.5 Tf ${M} ${H - 34} Td ${pdfStr(p.header.left)} Tj ET`, `BT ${GREY} rg /F1 7.5 Tf ${(W - M - textWidth(p.header.right, 7.5)).toFixed(2)} ${H - 34} Td ${pdfStr(p.header.right)} Tj ET`, `${LIGHT} RG 0.5 w ${M} ${H - 40} m ${W - M} ${H - 40} l S`); }
    const pn = toCp1252(`Page ${n} of ${pages.length}`);
    ops.push(`${LIGHT} RG 0.5 w ${M} ${BOTTOM - 14} m ${W - M} ${BOTTOM - 14} l S`, `BT ${GREY} rg /F1 7 Tf ${M} ${BOTTOM - 24} Td ${pdfStr(gen)} Tj ET`, `BT ${GREY} rg /F1 7 Tf ${(W - M - textWidth(pn, 7)).toFixed(2)} ${BOTTOM - 24} Td ${pdfStr(pn)} Tj ET`);
    if (p.footnote) ops.push(`BT ${GREY} rg /F1 7 Tf ${(W / 2 - textWidth(p.footnote, 7) / 2).toFixed(2)} ${BOTTOM - 34} Td ${pdfStr(p.footnote)} Tj ET`);
    return ops.join("\n");
  });
}
function serialize(contents: string[], info: { title: string; subject?: string; created: string }): Buffer {
  const objs: string[] = []; const add = (s: string) => (objs.push(s), objs.length);
  add("<< /Type /Catalog /Pages 2 0 R >>"); add(""); // pages placeholder
  add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>"); add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>");
  const d = new Date(info.created); const pdfDate = `D:${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}${String(d.getUTCHours()).padStart(2, "0")}${String(d.getUTCMinutes()).padStart(2, "0")}${String(d.getUTCSeconds()).padStart(2, "0")}Z`;
  add(`<< /Title ${pdfStr(toCp1252(info.title))} ${info.subject ? `/Subject ${pdfStr(toCp1252(info.subject))} ` : ""}/Producer (Family Office report engine) /Creator (Family Office) /CreationDate (${pdfDate}) /ModDate (${pdfDate}) >>`);
  const pageIds: number[] = []; const streams: Record<number, Buffer> = {};
  for (const c of contents) { const raw = Buffer.from(c, "latin1"); const z = deflateSync(raw); const cid = add(`<< /Length ${z.length} /Filter /FlateDecode >>`); streams[cid] = z; pageIds.push(add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${cid} 0 R >>`)); }
  objs[1] = `<< /Type /Pages /Kids [${pageIds.map((i) => `${i} 0 R`).join(" ")}] /Count ${pageIds.length} >>`;
  const parts: Buffer[] = [Buffer.from("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n", "latin1")]; const offsets: number[] = []; let pos = parts[0].length;
  objs.forEach((o, i) => { offsets.push(pos); const head = Buffer.from(`${i + 1} 0 obj\n${o}\n`, "latin1"); const st = streams[i + 1]; const body = st ? Buffer.concat([head, Buffer.from("stream\n", "latin1"), st, Buffer.from("\nendstream\n", "latin1")]) : head; const b = Buffer.concat([body, Buffer.from("endobj\n", "latin1")]); parts.push(b); pos += b.length; });
  const xref = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => String(o).padStart(10, "0") + " 00000 n \n").join("")}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R /Info 5 0 R >>\nstartxref\n${pos}\n%%EOF\n`;
  parts.push(Buffer.from(xref, "latin1")); return Buffer.concat(parts);
}
export function renderPdf(doc: ReportDoc): Buffer { const L = layoutDoc(doc); return serialize(chrome(L.pages, doc.family, doc.generated_at), { title: doc.title, subject: doc.family, created: doc.generated_at }); }
/** A pack: cover, table of contents with page numbers, then each report starting on a fresh page; one running page count. */
export function renderPackPdf(cover: PackCover, docs: ReportDoc[]): Buffer {
  const L = new Layout(cover.family); const bodyStart = L.pages.length; // lay the reports out first so the TOC knows their pages
  const starts: number[] = []; docs.forEach((d, i) => { if (i === 0) { L.header = { left: toCp1252(d.title), right: toCp1252(d.family) }; L.footnote = d.footer_note ? toCp1252(d.footer_note) : undefined; L.page.header = { ...L.header }; L.page.footnote = L.footnote; starts.push(L.pages.length); L.titleBlock(d); for (const s of d.sections) L.section(s); } else { starts.push(L.pages.length + 1); layoutDoc(d, L); } });
  const body = L.pages.splice(bodyStart - 1); const perToc = 34; const tocPages = Math.max(1, Math.ceil(docs.length / perToc)); const front = 1 + tocPages;
  const C = new Layout(cover.family); C.pages = []; C.newPage(); const P = C.page; void P;
  C.y = H - 200; C.para(cover.title, 26, { bold: true, color: NAVY, after: 6 }); C.para(`${cover.family} · ${cover.audience} pack`, 12, { color: GREY, after: 4 }); C.para(cover.period, 12, { color: GREY, after: 18 });
  C.line(M, C.y, W - M, C.y, LIGHT, 0.8); C.y -= 14;
  C.kv({ type: "kv", items: [{ label: "Version", value: `v${cover.version}` }, { label: "Generated", value: fmtIst(cover.generated_at) }, { label: "Reports", value: String(docs.length) }, { label: "Recipients", value: cover.recipients?.length ? cover.recipients.join(", ") : "—" }], columns: 2 });
  if (cover.supersedes) C.para(`Supersedes ${cover.supersedes}.`, 9.5, { after: 2 }); if (cover.correction_note) C.section({ type: "paragraph", style: "note", text: `Correction: ${cover.correction_note}` });
  C.y = 120; C.para("Prepared by the family office platform from the books, holdings and records as at generation time. Every page carries the family name and the generation timestamp; a corrected pack supersedes this version and both are retained.", 8, { color: GREY });
  C.newPage(); C.para("Contents", 18, { bold: true, color: NAVY, after: 10 });
  docs.forEach((d, i) => { if (i && i % perToc === 0) C.newPage(); C.ensure(16); C.y -= 16; const t = toCp1252(`${i + 1}. ${d.title}${d.entity ? " — " + d.entity : ""}${d.period ? " (" + d.period + ")" : ""}`); const pg = String(starts[i] + front); const pw = textWidth(pg, 9.5); let tt = t; while (textWidth(tt, 9.5) > CW - pw - 30 && tt.length > 5) tt = tt.slice(0, -2) + "…"; C.text(M, C.y + 4, tt, 9.5); const tw = textWidth(tt, 9.5); const dots = ".".repeat(Math.max(0, Math.floor((CW - tw - pw - 12) / textWidth(".", 9.5)))); C.text(M + tw + 4, C.y + 4, dots, 9.5, { color: LIGHT }); C.text(W - M - pw, C.y + 4, pg, 9.5, { bold: true }); });
  while (C.pages.length < front) C.newPage();
  const pages = [...C.pages.slice(0, front), ...body];
  return serialize(chrome(pages, cover.family, cover.generated_at, new Set([0])), { title: cover.title, subject: `${cover.family} · ${cover.audience} pack v${cover.version}`, created: cover.generated_at });
}
