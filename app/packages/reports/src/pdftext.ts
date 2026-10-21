import { inflateSync } from "node:zlib";
import { createDecipheriv, createHash } from "node:crypto";
/**
 * Text extraction for uploaded PDFs (CAS, contract notes, capital-call notices): FlateDecode content streams, Tj / TJ / ' / " operators, line
 * breaks from Td / T* / Tm, and the standard security handler (RC4 40/128-bit and AES-128 with the user password — CAS PDFs are opened with the
 * PAN). AES-256 (R5/R6) documents are reported as unsupported rather than mis-read. Fonts are assumed simple (WinAnsi / Standard); CID text is
 * kept where the high byte is zero.
 */
const PAD = Buffer.from("28BF4E5E4E758A4164004E56FFFA01082E2E00B6D0683E802F0CA9FE6453697A", "hex");
export class PdfError extends Error { constructor(public code: "password_required" | "wrong_password" | "unsupported" | "invalid", m: string) { super(m); } }
function rc4(key: Buffer, data: Buffer): Buffer {
  const S = new Uint8Array(256); for (let i = 0; i < 256; i++) S[i] = i; let j = 0;
  for (let i = 0; i < 256; i++) { j = (j + S[i] + key[i % key.length]) & 0xff; [S[i], S[j]] = [S[j], S[i]]; }
  const out = Buffer.alloc(data.length); let i = 0; j = 0;
  for (let k = 0; k < data.length; k++) { i = (i + 1) & 0xff; j = (j + S[i]) & 0xff; [S[i], S[j]] = [S[j], S[i]]; out[k] = data[k] ^ S[(S[i] + S[j]) & 0xff]; }
  return out;
}
const md5 = (...b: Buffer[]) => { const h = createHash("md5"); for (const x of b) h.update(x); return h.digest(); };
interface Enc { key: Buffer; aes: boolean }
function num(dict: string, key: string): number | null { const m = dict.match(new RegExp(`/${key}\\s+(-?\\d+)`)); return m ? Number(m[1]) : null; }
function strEntry(dict: string, key: string): Buffer | null {
  const m = dict.match(new RegExp(`/${key}\\s*(\\((?:[^()\\\\]|\\\\.)*\\)|<[0-9A-Fa-f\\s]*>)`)); if (!m) return null; return litOrHex(m[1]);
}
function litOrHex(tok: string): Buffer {
  if (tok[0] === "<") return Buffer.from(tok.slice(1, -1).replace(/\s/g, ""), "hex");
  const out: number[] = []; const s = tok.slice(1, -1);
  for (let i = 0; i < s.length; i++) { const ch = s[i]; if (ch !== "\\") { out.push(ch.charCodeAt(0) & 0xff); continue; } const n = s[++i]; if (n === undefined) break;
    if (/[0-7]/.test(n)) { let oct = n; while (oct.length < 3 && /[0-7]/.test(s[i + 1] ?? "")) oct += s[++i]; out.push(parseInt(oct, 8) & 0xff); } else out.push(({ n: 10, r: 13, t: 9, b: 8, f: 12 } as Record<string, number>)[n] ?? n.charCodeAt(0)); }
  return Buffer.from(out);
}
function setupEncryption(pdf: Buffer, password: string): Enc | null {
  const bin = pdf.toString("latin1"); const trailerIdx = bin.lastIndexOf("/Encrypt"); if (trailerIdx < 0) return null;
  const ref = bin.slice(trailerIdx).match(/\/Encrypt\s+(\d+)\s+(\d+)\s+R/); let dict: string | null = null;
  if (ref) { const m = bin.match(new RegExp(`(?:^|[^0-9])${ref[1]}\\s+${ref[2]}\\s+obj\\s*(<<[\\s\\S]*?>>)\\s*endobj`)); dict = m?.[1] ?? null; } else { const m = bin.slice(trailerIdx).match(/\/Encrypt\s*(<<[\s\S]*?>>)/); dict = m?.[1] ?? null; }
  if (!dict) throw new PdfError("invalid", "encryption dictionary not found");
  const V = num(dict, "V") ?? 0, R = num(dict, "R") ?? 2, P = num(dict, "P") ?? -1, lengthBits = num(dict, "Length") ?? 40;
  if (R >= 5) throw new PdfError("unsupported", "AES-256 encrypted PDFs are not supported yet");
  const O = strEntry(dict, "O"), U = strEntry(dict, "U"); if (!O || !U) throw new PdfError("invalid", "encryption dictionary incomplete");
  const idm = bin.match(/\/ID\s*\[\s*(<[0-9A-Fa-f]*>|\((?:[^()\\]|\\.)*\))/); const id0 = idm ? litOrHex(idm[1]) : Buffer.alloc(0);
  const aes = V >= 4 && /\/AESV2/.test(dict); const n = R === 2 ? 5 : Math.max(5, Math.min(16, lengthBits / 8));
  const encryptMetadata = !/\/EncryptMetadata\s+false/.test(dict);
  const pw = Buffer.concat([Buffer.from(password, "latin1"), PAD]).subarray(0, 32);
  const pbuf = Buffer.alloc(4); pbuf.writeInt32LE(P | 0);
  let key = md5(pw, O.subarray(0, 32), pbuf, id0, ...(R >= 4 && !encryptMetadata ? [Buffer.from("ffffffff", "hex")] : []));
  if (R >= 3) for (let i = 0; i < 50; i++) key = md5(key.subarray(0, n)); key = key.subarray(0, n);
  // verify the user password (algorithm 4 / 5)
  let ok: boolean;
  if (R === 2) ok = rc4(key, PAD).equals(U.subarray(0, 32));
  else { let x = rc4(key, md5(PAD, id0)); for (let i = 1; i <= 19; i++) x = rc4(Buffer.from(key.map((b) => b ^ i)), x); ok = x.subarray(0, 16).equals(U.subarray(0, 16)); }
  if (!ok) throw new PdfError(password ? "wrong_password" : "password_required", password ? "the password does not open this PDF" : "this PDF needs a password");
  return { key, aes };
}
function decryptStream(enc: Enc, objNum: number, gen: number, data: Buffer): Buffer {
  const salt = Buffer.alloc(5); salt.writeUIntLE(objNum, 0, 3); salt.writeUIntLE(gen, 3, 2);
  const okey = md5(enc.key, salt, ...(enc.aes ? [Buffer.from("73416C54", "hex")] : [])).subarray(0, Math.min(enc.key.length + 5, 16));
  if (!enc.aes) return rc4(okey, data);
  const iv = data.subarray(0, 16); const body = data.subarray(16, 16 + Math.floor((data.length - 16) / 16) * 16); const d = createDecipheriv("aes-128-cbc", okey, iv); d.setAutoPadding(false);
  const out = Buffer.concat([d.update(body), d.final()]); const padN = out[out.length - 1]; return padN >= 1 && padN <= 16 ? out.subarray(0, out.length - padN) : out;
}
function decodeStream(dict: string, raw: Buffer): Buffer | null {
  const filters = [...dict.matchAll(/\/Filter\s*(?:\[([^\]]*)\]|\/(\w+))/g)].flatMap((m) => (m[1] ? [...m[1].matchAll(/\/(\w+)/g)].map((x) => x[1]) : [m[2]]));
  let data = raw;
  for (const f of filters) {
    if (f === "FlateDecode" || f === "Fl") { try { data = inflateSync(data); } catch { try { data = inflateSync(data.subarray(0, data.length - 1)); } catch { return null; } } }
    else if (f === "ASCIIHexDecode") data = Buffer.from(data.toString("latin1").replace(/>.*$/s, "").replace(/\s/g, ""), "hex");
    else return null;   // LZW / DCT / CCITT: not text
  }
  return data;
}
/** Tokenise a content stream, place every shown string at its text-matrix position and join strings that share a baseline into lines (top to bottom, left to right). */
export function textFromContent(content: Buffer): string {
  const s = content.toString("latin1"); const items: { x: number; y: number; t: string }[] = []; let i = 0; let tx = 0, ty = 0, leading = 12, size = 10;
  const operand: string[] = []; const decodeBytes = (b: Buffer) => { if (b.length >= 2 && b.length % 2 === 0 && b[0] === 0 && (b.length < 4 || b[2] === 0)) { let t = ""; for (let k = 0; k < b.length; k += 2) t += b[k] === 0 ? String.fromCharCode(b[k + 1]) : "?"; return t; } return b.toString("latin1"); };
  const emit = (t: string) => { if (t.length) items.push({ x: tx, y: ty, t }); };
  while (i < s.length) {
    const ch = s[i];
    if (ch === "(") { let depth = 0, j = i; for (; j < s.length; j++) { if (s[j] === "\\") { j++; continue; } if (s[j] === "(") depth++; else if (s[j] === ")") { depth--; if (!depth) break; } } operand.push(s.slice(i, j + 1)); i = j + 1; continue; }
    if (ch === "<" && s[i + 1] !== "<") { const j = s.indexOf(">", i); operand.push(s.slice(i, j + 1)); i = j + 1; continue; }
    if (ch === "[") { const j = s.indexOf("]", i); operand.push(s.slice(i, j + 1)); i = j + 1; continue; }
    if (ch === "%") { const j = s.indexOf("\n", i); i = j < 0 ? s.length : j + 1; continue; }
    if (/\s/.test(ch)) { i++; continue; }
    let j = i; while (j < s.length && !/[\s()<>\[\]\/%]/.test(s[j])) j++; if (j === i) { i++; continue; }
    const tok = s.slice(i, j); i = j; const n = (k: number) => Number(operand[operand.length - k]);
    if (tok === "BT") { tx = 0; ty = 0; operand.length = 0; }
    else if (tok === "Tm") { tx = n(2); ty = n(1); operand.length = 0; }
    else if (tok === "Td") { tx += n(2); ty += n(1); operand.length = 0; }
    else if (tok === "TD") { leading = -n(1); tx += n(2); ty += n(1); operand.length = 0; }
    else if (tok === "TL") { leading = n(1); operand.length = 0; }
    else if (tok === "Tf") { size = n(1) || size; operand.length = 0; }
    else if (tok === "T*") { ty -= leading || size * 1.2; operand.length = 0; }
    else if (tok === "Tj") { const str = operand[operand.length - 1]; if (str && /^[(<]/.test(str)) emit(decodeBytes(litOrHex(str))); operand.length = 0; }
    else if (tok === "'" || tok === '"') { ty -= leading || size * 1.2; const str = operand[operand.length - 1]; if (str && /^[(<]/.test(str)) emit(decodeBytes(litOrHex(str))); operand.length = 0; }
    else if (tok === "TJ") { const arr = operand[operand.length - 1] ?? ""; const parts = arr.slice(1, -1).match(/\((?:[^()\\]|\\.)*\)|<[0-9A-Fa-f\s]*>|-?\d+(?:\.\d+)?/g) ?? []; let t = ""; for (const p of parts) { if (/^[(<]/.test(p)) t += decodeBytes(litOrHex(p)); else if (Number(p) < -180) t += " "; } emit(t); operand.length = 0; }
    else if (/^[-+.\d]/.test(tok) || tok.startsWith("/")) operand.push(tok); else operand.length = 0;
  }
  // group by baseline (2 pt tolerance), order lines top-down and items left-right
  items.sort((a, b) => b.y - a.y || a.x - b.x); const lines: string[] = []; let cur: typeof items = [];
  const flush = () => { if (!cur.length) return; cur.sort((a, b) => a.x - b.x); const line = cur.map((c) => c.t).join(" ").replace(/\s+/g, " ").trim(); if (line) lines.push(line); cur = []; };
  for (const it of items) { if (cur.length && Math.abs(cur[0].y - it.y) > 2) flush(); cur.push(it); } flush();
  return lines.join("\n");
}
/** All text from a PDF, page streams in file order. Throws PdfError for password / unsupported cases. */
export function extractPdfText(pdf: Buffer, password = ""): string {
  if (!pdf.subarray(0, 1024).toString("latin1").includes("%PDF")) throw new PdfError("invalid", "not a PDF");
  const enc = setupEncryption(pdf, password); const bin = pdf.toString("latin1"); const texts: string[] = [];
  const re = /(\d+)\s+(\d+)\s+obj\s*(<<(?:(?!endobj)[\s\S])*?>>)\s*stream\r?\n/g; let m: RegExpExecArray | null;   // tempered: a dictionary never crosses the previous object's endobj let m: RegExpExecArray | null;
  while ((m = re.exec(bin))) {
    const dict = m[3]; const start = m.index + m[0].length; let len = num(dict, "Length"); const lenRef = dict.match(/\/Length\s+(\d+)\s+(\d+)\s+R/);
    if (lenRef) { const lm = bin.match(new RegExp(`(?:^|[^0-9])${lenRef[1]}\\s+${lenRef[2]}\\s+obj\\s*(\\d+)`)); len = lm ? Number(lm[1]) : null; }
    let end = len != null ? start + len : bin.indexOf("endstream", start); if (len == null || bin.slice(end, end + 12).indexOf("endstream") < 0) end = bin.indexOf("endstream", start); if (end < 0) continue;
    if (/\/Type\s*\/(XRef|ObjStm|XObject|Font|FontDescriptor|Metadata|EmbeddedFile)/.test(dict) && !/\/Subtype\s*\/Form/.test(dict)) { re.lastIndex = end; continue; }
    let raw = pdf.subarray(start, end); while (raw.length && (raw[raw.length - 1] === 0x0a || raw[raw.length - 1] === 0x0d)) raw = raw.subarray(0, raw.length - 1);
    if (enc) { try { raw = decryptStream(enc, Number(m[1]), Number(m[2]), raw); } catch { re.lastIndex = end; continue; } }
    const data = decodeStream(dict, raw); re.lastIndex = end; if (!data) continue;
    const head = data.subarray(0, 4096).toString("latin1"); if (!/\bBT\b/.test(head) && !/\bTj\b|\bTJ\b/.test(data.toString("latin1"))) continue;
    const t = textFromContent(data); if (t.trim()) texts.push(t);
  }
  return texts.join("\n");
}
