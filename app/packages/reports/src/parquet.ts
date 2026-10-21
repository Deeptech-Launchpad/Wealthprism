/**
 * Minimal Apache Parquet writer for bulk exports: one row group, PLAIN encoding, uncompressed, optional columns with RLE/bit-packed definition
 * levels, types BYTE_ARRAY (UTF8), DOUBLE, INT64, BOOLEAN, INT32 (DATE) — the subset Excel / Power BI / pandas / DuckDB read. Thrift compact
 * protocol is hand-encoded for the fixed metadata structs. Verified against pyarrow in the package tests.
 */
export type PqType = "string" | "double" | "int64" | "bool" | "date";
export interface PqColumn { name: string; type: PqType }
// ---- thrift compact protocol ----
class TWriter {
  buf: number[] = []; stack: number[] = []; last = 0;
  varint(n: number | bigint) { let v = BigInt(n); while (true) { const b = Number(v & 0x7fn); v >>= 7n; if (v === 0n) { this.buf.push(b); break; } this.buf.push(b | 0x80); } }
  zig(n: number | bigint) { const v = BigInt(n); this.varint(v >= 0n ? v << 1n : ((-v) << 1n) - 1n); }
  field(id: number, type: number) { const d = id - this.last; if (d > 0 && d <= 15) this.buf.push((d << 4) | type); else { this.buf.push(type); this.zig(id); } this.last = id; }
  i32(id: number, v: number) { this.field(id, 5); this.zig(v); }
  i64(id: number, v: number | bigint) { this.field(id, 6); this.zig(v); }
  bool(id: number, v: boolean) { this.field(id, v ? 1 : 2); }
  str(id: number, s: string) { this.field(id, 8); const b = Buffer.from(s, "utf8"); this.varint(b.length); for (const x of b) this.buf.push(x); }
  bin(id: number, b: Buffer) { this.field(id, 8); this.varint(b.length); for (const x of b) this.buf.push(x); }
  struct(id: number, fn: (w: TWriter) => void) { this.field(id, 12); this.stack.push(this.last); this.last = 0; fn(this); this.buf.push(0); this.last = this.stack.pop()!; }
  list(id: number, n: number, elemType: number, fn: (w: TWriter) => void) { this.field(id, 9); if (n < 15) this.buf.push((n << 4) | elemType); else { this.buf.push(0xf0 | elemType); this.varint(n); } fn(this); }
  structElem(fn: (w: TWriter) => void) { this.stack.push(this.last); this.last = 0; fn(this); this.buf.push(0); this.last = this.stack.pop()!; }
  bytes() { return Buffer.from(this.buf); }
}
const PT: Record<PqType, number> = { bool: 0, int64: 2, date: 1, double: 5, string: 6 };   // parquet Type enum: BOOLEAN 0, INT32 1, INT64 2, DOUBLE 5, BYTE_ARRAY 6
function defLevels(present: boolean[]): Buffer {   // RLE/bit-packed hybrid, bit width 1: run-length encode runs of identical levels
  const out: number[] = []; let i = 0;
  while (i < present.length) { let j = i; while (j < present.length && present[j] === present[i]) j++; const run = j - i; let h = run << 1; while (h > 0x7f) { out.push((h & 0x7f) | 0x80); h >>>= 7; } out.push(h); out.push(present[i] ? 1 : 0); i = j; }
  const body = Buffer.from(out); const len = Buffer.alloc(4); len.writeUInt32LE(body.length); return Buffer.concat([len, body]);
}
function plain(type: PqType, vals: any[]): Buffer {
  const parts: Buffer[] = [];
  if (type === "bool") { const bits = Buffer.alloc(Math.ceil(vals.length / 8)); vals.forEach((v, i) => { if (v) bits[i >> 3] |= 1 << (i & 7); }); return bits; }
  for (const v of vals) {
    if (type === "double") { const b = Buffer.alloc(8); b.writeDoubleLE(Number(v)); parts.push(b); }
    else if (type === "int64") { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(Math.trunc(Number(v)))); parts.push(b); }
    else if (type === "date") { const b = Buffer.alloc(4); b.writeInt32LE(Math.floor(Date.parse(String(v).slice(0, 10) + "T00:00:00Z") / 86400000)); parts.push(b); }
    else { const s = Buffer.from(typeof v === "object" ? JSON.stringify(v) : String(v), "utf8"); const l = Buffer.alloc(4); l.writeUInt32LE(s.length); parts.push(l, s); }
  }
  return Buffer.concat(parts);
}
export function toParquet(columns: PqColumn[], rows: Record<string, any>[]): Buffer {
  const chunks: Buffer[] = [Buffer.from("PAR1")]; let offset = 4; const colMeta: { col: PqColumn; offset: number; size: number; values: number }[] = [];
  for (const col of columns) {
    const raw = rows.map((r) => r[col.name]); const present = raw.map((v) => v != null && v !== "" && !(col.type !== "string" && col.type !== "bool" && Number.isNaN(col.type === "date" ? Date.parse(String(v)) : Number(v))));
    const vals = raw.filter((_, i) => present[i]); const levels = defLevels(present); const data = plain(col.type, vals); const page = Buffer.concat([levels, data]);
    const ph = new TWriter(); ph.i32(1, 0); ph.i32(2, page.length); ph.i32(3, page.length); ph.struct(5, (w) => { w.i32(1, rows.length); w.i32(2, 0); w.i32(3, 3); w.i32(4, 3); }); ph.buf.push(0);   // PageHeader{type DATA_PAGE, sizes, DataPageHeader{num_values, PLAIN, RLE, RLE}}
    const header = ph.bytes(); const chunk = Buffer.concat([header, page]); colMeta.push({ col, offset, size: chunk.length, values: rows.length }); chunks.push(chunk); offset += chunk.length;
  }
  const fm = new TWriter(); fm.i32(1, 1);
  fm.list(2, columns.length + 1, 12, (w) => { w.structElem((s) => { s.str(4, "schema"); s.i32(5, columns.length); }); for (const c of columns) w.structElem((s) => { s.i32(1, PT[c.type]); s.i32(3, 1); s.str(4, c.name); if (c.type === "string") s.i32(6, 0); if (c.type === "date") s.i32(6, 6); }); });   // repetition OPTIONAL=1; ConvertedType UTF8=0, DATE=6
  fm.i64(3, rows.length);
  fm.list(4, 1, 12, (w) => w.structElem((rg) => { rg.list(1, colMeta.length, 12, (l) => { for (const m of colMeta) l.structElem((cc) => { cc.i64(2, m.offset); cc.struct(3, (md) => { md.i32(1, PT[m.col.type]); md.list(2, 3, 5, (e) => { e.zig(0); e.zig(3); e.zig(3); }); md.list(3, 1, 8, (p) => { const b = Buffer.from(m.col.name, "utf8"); p.varint(b.length); for (const x of b) p.buf.push(x); }); md.i32(4, 0); md.i64(5, m.values); md.i64(6, m.size); md.i64(7, m.size); md.i64(9, m.offset); }); }); }); rg.i64(2, colMeta.reduce((s, m) => s + m.size, 0)); rg.i64(3, rows.length); }));
  fm.str(6, "Family Office export engine"); fm.buf.push(0);
  const footer = fm.bytes(); const len = Buffer.alloc(4); len.writeUInt32LE(footer.length);
  return Buffer.concat([...chunks, footer, len, Buffer.from("PAR1")]);
}
