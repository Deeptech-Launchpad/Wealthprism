import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
process.env.STORAGE_DIR ??= mkdtempSync(join(tmpdir(), "fo-docs-"));
import { buildApp } from "../src/server.js";
import { withFamily } from "../src/lib/db.js";
import { renderPdf } from "@fo/reports";
import { redactPii, classifyDocument, sniffMime } from "../src/lib/documents.js";
import { sigv4Headers, sigv4Presign, s3Storage, signFileToken } from "../src/lib/storage.js";

// Documents (PRD 3.10, FO-100): the store, folders, signed links, extraction review → import. Everything created here is removed in teardown.
const FAMILY = "11111111-1111-1111-1111-111111111111", HUF = "33333333-0000-0000-0000-000000000002", PROPERTY = "55555555-0000-0000-0000-000000000001";
const S = (f: string) => readFileSync(new URL(`../../../../samples/${f}`, import.meta.url), "utf8");
let app: ReturnType<typeof buildApp>; let owner = "", operator = "", viewer = "";
const h = (t = owner) => ({ authorization: `Bearer ${t}`, "x-family-id": FAMILY });
const get = async (url: string, t = owner) => { const r = await app.inject({ url: `/api/v1${url}`, headers: h(t) }); return { code: r.statusCode, body: r.headers["content-type"]?.toString().includes("json") ? r.json() : r.body, raw: r.rawPayload, headers: r.headers }; };
const send = async (method: "POST" | "PATCH" | "DELETE", url: string, payload: any = {}, t = owner) => { const r = await app.inject({ method, url: `/api/v1${url}`, headers: h(t), payload }); return { code: r.statusCode, body: r.statusCode === 204 ? null : r.json() }; };
/** multipart/form-data by hand: light-my-request takes a raw body with the boundary header. */
const upload = async (file: { name: string; mime: string; data: Buffer }, fields: Record<string, string> = {}, t = owner) => {
  const b = "----fo" + Math.random().toString(16).slice(2); const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) parts.push(Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  parts.push(Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: ${file.mime}\r\n\r\n`), file.data, Buffer.from(`\r\n--${b}--\r\n`));
  const r = await app.inject({ method: "POST", url: "/api/v1/documents", headers: { ...h(t), "content-type": `multipart/form-data; boundary=${b}` }, payload: Buffer.concat(parts) }); return { code: r.statusCode, body: r.json() };
};
const fetchUrl = async (url: string) => { const r = await app.inject({ url: url.startsWith("http") ? new URL(url).pathname + new URL(url).search : url }); return { code: r.statusCode, raw: r.rawPayload, type: String(r.headers["content-type"]), disposition: String(r.headers["content-disposition"]) }; };
const py = (code: string, input?: Buffer) => spawnSync("python3", ["-c", code], { input, maxBuffer: 64 * 1024 * 1024 });
const HAS_PYPDF = py("import pypdf, cryptography").status === 0;
const created: string[] = [];

beforeAll(async () => {
  app = buildApp(); await app.ready();
  const login = async (email: string) => (await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password: "Prototype!2026" } })).json().access_token;
  owner = await login("arjun@example.com"); operator = await login("ops@example.com"); viewer = await login("ca@example.com");
  await cleanup();   // leftovers from an interrupted run
});
const NAMES = ["kovai-sale-deed.pdf", "Kovai plot — sale deed.pdf", "scratch.txt", "form26as-huf-2026-27.txt", "varaha-capital-call.txt", "unknown-letter.txt", "cas-locked.pdf"];
async function cleanup() {
  await withFamily(FAMILY, async (c) => {
    created.push(...(await c.query("select id from documents where family_id=$1 and name = any($2)", [FAMILY, NAMES])).rows.map((r) => r.id));
    await c.query("delete from tasks where source_type='document' and family_id=$1", [FAMILY]);
    const jobs = (await c.query("select id from import_jobs where family_id=$1 and file_document_id = any($2::uuid[])", [FAMILY, created])).rows.map((r) => r.id);
    await c.query("delete from document_extractions where document_id = any($1::uuid[])", [created]);
    if (jobs.length) { await c.query("delete from tds_26as where family_id=$1 and source_file = any($2::uuid[])", [FAMILY, jobs]); await c.query("delete from tasks where family_id=$1 and source_type='import_job' and source_id = any($2::uuid[])", [FAMILY, jobs]); await c.query("delete from import_jobs where id = any($1::uuid[])", [jobs]); } await c.query("delete from documents where id = any($1::uuid[])", [created]); await c.query("delete from folders where family_id=$1 and system=false and name like 'Test %'", [FAMILY]);
    await c.query("delete from audit_log where family_id=$1 and table_name='documents' and row_id = any($2::uuid[])", [FAMILY, created]);
  });
  created.length = 0;
}
afterAll(async () => { await cleanup(); await app.close(); rmSync(process.env.STORAGE_DIR!, { recursive: true, force: true }); });

describe("folders and the store (PRD 3.10)", () => {
  it("has the system folder tree per family; custom folders can be added, system folders cannot be deleted", async () => {
    const tree = (await get("/folders")).body; expect(tree.filter((f: any) => f.system).map((f: any) => f.name)).toEqual(expect.arrayContaining(["Property deeds & agreements", "Tax filings (ITR, GST)", "Bank statements", "Insurance policies", "Wills & nominations", "Reports", "Exports"]));
    const f = await send("POST", "/folders", { name: "Test deeds 2026" }); expect(f.code).toBe(201); expect(f.body.system).toBe(false);
    expect((await send("DELETE", `/folders/${tree.find((x: any) => x.system).id}`)).code).toBe(409);
    expect((await send("DELETE", `/folders/${f.body.id}`)).code).toBe(204);
  });
  it("stores a PDF with sha-256 de-duplication, extracted text and a signed link; refuses unsupported and empty files", async () => {
    const pdf = renderPdf({ code: "t", title: "Sale deed — Kovai plot", family: "Mehta Family", generated_at: new Date().toISOString(), sections: [{ type: "paragraph", text: "Registered at Coimbatore SRO on 12 Aug 2019. Survey No 114/2B." }] });
    const folder = (await get("/folders")).body.find((f: any) => f.name === "Property deeds & agreements");
    const r = await upload({ name: "kovai-sale-deed.pdf", mime: "application/pdf", data: pdf }, { folder_id: folder.id, linked_type: "property", linked_id: PROPERTY, entity_id: HUF }, operator); expect(r.code, JSON.stringify(r.body)).toBe(201); created.push(r.body.id);
    expect(r.body).toMatchObject({ mime: "application/pdf", size: pdf.length, folder_name: "Property deeds & agreements", linked_type: "property", linked_id: PROPERTY, has_text: true, scan_status: "skipped", source: "upload", duplicate: false }); expect(r.body.sha256).toMatch(/^[0-9a-f]{64}$/); expect(r.body.url).toContain("/files/");
    const dl = await fetchUrl(r.body.url); expect(dl.code).toBe(200); expect(dl.type).toContain("application/pdf"); expect(dl.raw.equals(pdf)).toBe(true); expect(dl.disposition).toContain("kovai-sale-deed.pdf");
    expect((await get(`/documents/${r.body.id}/text`)).body.text).toContain("Survey No 114/2B");
    const again = await upload({ name: "kovai-sale-deed (copy).pdf", mime: "application/pdf", data: pdf }); expect(again.code).toBe(200); expect(again.body.duplicate).toBe(true); expect(again.body.id).toBe(r.body.id);
    expect((await upload({ name: "virus.exe", mime: "application/octet-stream", data: Buffer.from([0x4d, 0x5a, 0, 0, 0x90, 0, 3, 0]) })).code).toBe(415);
    expect((await upload({ name: "empty.txt", mime: "text/plain", data: Buffer.alloc(0) })).code).toBe(422);
    expect((await upload({ name: "big.txt", mime: "text/plain", data: Buffer.alloc(25 * 1024 * 1024 + 1, 0x61) })).code).toBe(413);
    // viewer cannot upload; the CA (external viewer) can still browse documents (in scope)
    expect((await upload({ name: "x.txt", mime: "text/plain", data: Buffer.from("hello") }, {}, viewer)).code).toBe(403);
    const list = (await get(`/documents?linked_type=property&linked_id=${PROPERTY}`, viewer)).body; expect(list.some((d: any) => d.id === r.body.id)).toBe(true); expect(list[0].url).toBeUndefined();
    expect((await get(`/documents?q=Survey`)).body.some((d: any) => d.id === r.body.id)).toBe(true);
    const moved = await send("PATCH", `/documents/${r.body.id}`, { tags: ["deed", "kovai"], name: "Kovai plot — sale deed.pdf" }); expect(moved.body.tags).toEqual(["deed", "kovai"]);
    const dlr = await app.inject({ url: `/api/v1/documents/${r.body.id}/download`, headers: h() }); expect(dlr.statusCode).toBe(302); expect(dlr.headers.location).toContain("/files/");
  });
  it("signed links expire and cannot be forged", async () => {
    const good = (await get("/documents")).body[0]; const url = (await get(`/documents/${good.id}`)).body.url as string;
    expect((await fetchUrl(url.replace(/.$/, (c) => (c === "a" ? "b" : "a")))).code).toBe(403);
    const expired = signFileToken({ key: good.storage_key, exp: Math.floor(Date.now() / 1000) - 5 }); expect((await fetchUrl(`/api/v1/files/${expired}`)).code).toBe(403);
    const fs = (await send("POST", "/documents/upload-url", { name: "a.pdf", mime: "application/pdf", size: 1000 })).body; expect(fs.multipart).toBe(true); expect(fs.storage_key.startsWith(`${FAMILY}/`)).toBe(true);
    expect((await send("POST", "/documents/upload-url", { name: "a.exe", mime: "application/x-msdownload", size: 1000 })).code).toBe(415);
  });
  it("sniffs the real type and soft-deletes with an audit row", async () => {
    expect(sniffMime(Buffer.from("%PDF-1.4"), "text/plain", "x.txt")).toBe("application/pdf"); expect(sniffMime(Buffer.from("a,b\n1,2"), "text/csv", "x.csv")).toBe("text/csv"); expect(sniffMime(Buffer.from("hello"), undefined, "note.txt")).toBe("text/plain"); expect(() => sniffMime(Buffer.from([0, 1, 2, 3]), "text/plain", "x.bin")).toThrow();
    const r = await upload({ name: "scratch.txt", mime: "text/plain", data: Buffer.from("temporary note " + Date.now()) }); created.push(r.body.id);
    expect((await send("DELETE", `/documents/${r.body.id}`, {}, operator)).code).toBe(403); expect((await send("DELETE", `/documents/${r.body.id}`)).code).toBe(204); expect((await get(`/documents/${r.body.id}`)).code).toBe(404);
    expect((await withFamily(FAMILY, (c) => c.query("select 1 from audit_log where table_name='documents' and action='delete' and row_id=$1", [r.body.id]))).rowCount).toBe(1);
  });
});

describe("extraction review queue (FO-100)", () => {
  it("classifies a 26AS through the importers, writes nothing until approval, and approval runs the import", async () => {
    const before = Number((await withFamily(FAMILY, (c) => c.query("select count(*) n from tds_26as"))).rows[0].n);
    const up = await upload({ name: "form26as-huf-2026-27.txt", mime: "text/plain", data: Buffer.from(S("form26as_mehta_huf_FY2026-27.txt")) }, { doc_type: "" }); expect(up.code).toBe(201); created.push(up.body.id);
    const x = await send("POST", `/documents/${up.body.id}/extract`, {}, operator); expect(x.code, JSON.stringify(x.body)).toBe(202);
    expect(x.body.extraction).toMatchObject({ doc_type: "form26as", source_kind: "form26as", model: "heuristic-v1", redactions: 0 }); expect(Number(x.body.extraction.confidence)).toBeGreaterThanOrEqual(0.9); expect(x.body.status).toBe("extracted"); expect(x.body.extraction.extracted.rows).toBeGreaterThan(0); expect(x.body.extraction.summary).toMatch(/rows parsed/);
    expect(Number((await withFamily(FAMILY, (c) => c.query("select count(*) n from tds_26as"))).rows[0].n)).toBe(before);   // nothing written before approval
    expect((await get("/documents/extractions?status=extracted")).body.some((e: any) => e.id === x.body.id)).toBe(true);
    const ok = await send("POST", `/documents/extractions/${x.body.id}/decide`, { decision: "approve", note: "looks right" }, operator); expect(ok.code, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.extraction.status).toBe("approved"); expect(ok.body.import_job).toBeTruthy(); expect(ok.body.import_job.status).toBe("done"); expect(ok.body.import_job.rows_ok).toBeGreaterThan(0);
    expect(Number((await withFamily(FAMILY, (c) => c.query("select count(*) n from tds_26as"))).rows[0].n)).toBeGreaterThan(before);
    expect((await withFamily(FAMILY, (c) => c.query("select file_document_id from import_jobs where id=$1", [ok.body.import_job.id]))).rows[0].file_document_id).toBe(up.body.id);
    expect((await send("POST", `/documents/extractions/${x.body.id}/decide`, { decision: "approve" })).code).toBe(409);
  });
  it("reads a capital-call notice into the review queue and approval raises the dated task; rejection records the reviewer", async () => {
    const text = "VARAHA VENTURES FUND II\nCapital Call Notice No. CC/2026/07\nDear Limited Partner,\nThis is a drawdown notice for your commitment to the Fund.\nAmount due: INR 25,00,000\nDue date: 15 Oct 2026\nPlease remit to the escrow account 001234567890 (IFSC HDFC0000123).\nContact: ops@varaha.example (+91 98765 43210). PAN of investor: ABCDE1234F";
    const up = await upload({ name: "varaha-capital-call.txt", mime: "text/plain", data: Buffer.from(text) }, { entity_id: HUF }); created.push(up.body.id);
    const x = await send("POST", `/documents/${up.body.id}/extract`); expect(x.body.status).toBe("needs_review"); expect(x.body.extraction.doc_type).toBe("capital_call"); expect(x.body.extraction.extracted).toMatchObject({ amount: 2500000, due_date: "2026-10-15" }); expect(x.body.extraction.extracted.fund).toMatch(/Varaha/i);
    const ok = await send("POST", `/documents/extractions/${x.body.id}/decide`, { decision: "approve" }); expect(ok.body.task).toMatchObject({ module: "startups", amount: "2500000.00", entity_id: HUF }); expect(String(ok.body.task.due_date).slice(0, 10)).toBe("2026-10-15");
    const up2 = await upload({ name: "unknown-letter.txt", mime: "text/plain", data: Buffer.from("Dear Sir, with reference to our discussion, please find attached the minutes.") }); created.push(up2.body.id);
    const x2 = await send("POST", `/documents/${up2.body.id}/extract`); expect(x2.body.extraction.doc_type).toBe("other"); expect(x2.body.status).toBe("needs_review");
    const rj = await send("POST", `/documents/extractions/${x2.body.id}/decide`, { decision: "reject", note: "not a financial document" }); expect(rj.body.extraction).toMatchObject({ status: "rejected", review_note: "not a financial document" });
  });
  it("masks PAN, Aadhaar, account numbers, e-mail and phone numbers before a model would see them", () => {
    const { text, count } = redactPii("PAN ABCDE1234F, Aadhaar 1234 5678 9012, account 001234567890, mail ops@varaha.example, call +91 98765 43210 for Rs 25,00,000");
    expect(text).not.toContain("ABCDE1234F"); expect(text).toContain("ABXXXXXXXF"); expect(text).not.toContain("5678 9012"); expect(text).toContain("XXXXXXXX7890"); expect(text).toContain("[email]"); expect(text).toContain("[phone]"); expect(text).toContain("25,00,000"); expect(count).toBe(5);
    expect(classifyDocument(S("form26as_mehta_huf_FY2026-27.txt"), "26as.txt", "text/plain")).toMatchObject({ doc_type: "form26as", source_kind: "form26as" });
    expect(classifyDocument(S("zerodha_tradebook_FY2026-27.csv"), "tradebook.csv", "text/csv")).toMatchObject({ doc_type: "contract_note", source_kind: "zerodha" });
    expect(classifyDocument(null, "photo.jpg", "image/jpeg").doc_type).toBe("image");
  });
  it.skipIf(!HAS_PYPDF)("a password-protected CAS PDF is stored, flagged, and opens with the PAN", async () => {
    const pdf = renderPdf({ code: "t", title: "Consolidated Account Statement", family: "Mehta Family", generated_at: new Date().toISOString(), sections: [{ type: "paragraph", text: "Folio No: 1234567 / 0" }] });
    const r = py(`import sys,io;from pypdf import PdfReader,PdfWriter;r=PdfReader(io.BytesIO(sys.stdin.buffer.read()));w=PdfWriter();w.append(r);w.encrypt(user_password="ABCDE1234F",algorithm="AES-128");b=io.BytesIO();w.write(b);sys.stdout.buffer.write(b.getvalue())`, pdf); expect(r.status, r.stderr.toString()).toBe(0);
    const up = await upload({ name: "cas-locked.pdf", mime: "application/pdf", data: r.stdout }); expect(up.code).toBe(201); created.push(up.body.id); expect(up.body.has_text).toBe(false); expect(up.body.tags).toContain("password-protected");
    const x = await send("POST", `/documents/${up.body.id}/extract`); expect(x.code).toBe(422); expect(x.body.code).toBe("password_required");
    expect((await send("POST", `/documents/${up.body.id}/unlock`, { password: "WRONG" })).code).toBe(422);
    const ok = await send("POST", `/documents/${up.body.id}/unlock`, { password: "ABCDE1234F" }); expect(ok.code).toBe(200); expect(ok.body.chars).toBeGreaterThan(10);
    expect((await get(`/documents/${up.body.id}`)).body).toMatchObject({ has_text: true, tags: [] });
    expect((await send("POST", `/documents/${up.body.id}/extract`)).code).toBe(202);
  });
});

describe("storage drivers", () => {
  it("signs S3 requests exactly as AWS's published SigV4 examples", () => {
    const creds = { accessKey: "AKIAIOSFODNN7EXAMPLE", secretKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", region: "us-east-1", date: new Date("2013-05-24T00:00:00Z") };
    const hdrs = sigv4Headers({ method: "GET", url: "https://examplebucket.s3.amazonaws.com/test.txt", headers: { Range: "bytes=0-9" }, ...creds });
    expect(hdrs.authorization).toBe("AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41");
    const url = new URL(sigv4Presign({ method: "GET", url: "https://examplebucket.s3.amazonaws.com/test.txt", expires: 86400, ...creds }));
    expect(url.searchParams.get("X-Amz-Signature")).toBe("aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404");
    const s3 = s3Storage({ endpoint: "http://minio:9000", bucket: "documents", accessKey: "minio", secretKey: "minio123", publicEndpoint: "https://files.example.com" });
    return s3.signedGetUrl(`${FAMILY}/2026/09/x.pdf`, { filename: "Kovai deed.pdf", ttlSeconds: 300 }).then((u) => { const p = new URL(u); expect(p.origin).toBe("https://files.example.com"); expect(p.pathname).toBe(`/documents/${FAMILY}/2026/09/x.pdf`); expect(p.searchParams.get("X-Amz-Expires")).toBe("300"); expect(p.searchParams.get("response-content-disposition")).toContain("Kovai_deed.pdf"); expect(p.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/); });
  });
});
