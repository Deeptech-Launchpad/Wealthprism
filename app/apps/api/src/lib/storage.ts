/**
 * Object storage behind the documents module: an S3-compatible driver (MinIO in compose, any S3 in production) with hand-rolled SigV4 signing and
 * presigned URLs, and a filesystem driver for development and tests. Keys are `<family>/<yyyy>/<mm>/<uuid>-<name>`; nothing outside a family
 * prefix is ever addressed by a client — URLs are signed and short-lived.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, unlinkSync, existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../config.js";

export interface Storage {
  driver: "fs" | "s3";
  put(key: string, body: Buffer, mime: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
  /** Direct download for the client: S3 presigned GET, or an HMAC-signed API URL served by GET /files/:token. */
  signedGetUrl(key: string, opts?: { ttlSeconds?: number; filename?: string; mime?: string }): Promise<string>;
  /** Direct upload for the client (S3 only); null means "POST the bytes to /documents". */
  signedPutUrl(key: string, opts: { ttlSeconds?: number; mime: string }): Promise<string | null>;
}
export const safeKey = (key: string) => { if (!/^[A-Za-z0-9][A-Za-z0-9._\-\/]*$/.test(key) || key.includes("..") || key.includes("//")) throw new Error(`invalid storage key ${key}`); return key; };
export const safeName = (name: string) => (name ?? "file").replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 80) || "file";
const b64u = (b: Buffer | string) => Buffer.from(b).toString("base64url");

// ---------- signed API links (both drivers can hand these out; the fs driver has nothing else) ----------
export function signFileToken(payload: { key: string; fn?: string; mime?: string; exp: number }): string {
  const body = b64u(JSON.stringify(payload)); const sig = b64u(createHmac("sha256", config.jwtSecret).update(body).digest()); return `${body}.${sig}`;
}
export function verifyFileToken(token: string): { key: string; fn?: string; mime?: string; exp: number } | null {
  const [body, sig] = token.split("."); if (!body || !sig) return null;
  const want = b64u(createHmac("sha256", config.jwtSecret).update(body).digest()); if (want.length !== sig.length || !timingSafeEqual(Buffer.from(want), Buffer.from(sig))) return null;
  try { const p = JSON.parse(Buffer.from(body, "base64url").toString("utf8")); if (!p.key || !p.exp || p.exp * 1000 < Date.now()) return null; return p; } catch { return null; }
}
export const publicApiUrl = () => (process.env.PUBLIC_API_URL ?? "/api/v1").replace(/\/$/, "");

// ---------- filesystem driver ----------
// new URL(...).pathname would do on Windows: a file:// URL's pathname keeps the leading "/" before the drive
// letter (e.g. "/C:/Users/..."), and path.resolve() then reads that as "root of the current drive", prepending
// the real drive letter again (-> "C:\C:\Users\..."). fileURLToPath() strips it correctly on every platform.
export function fsStorage(dir = process.env.STORAGE_DIR ?? resolve(fileURLToPath(new URL("../../../../.data/documents", import.meta.url)))): Storage {
  const path = (key: string) => join(dir, safeKey(key));
  return {
    driver: "fs",
    async put(key, body) { const p = path(key); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, body); },
    async get(key) { return readFileSync(path(key)); },
    async delete(key) { try { unlinkSync(path(key)); } catch { /* already gone */ } },
    async exists(key) { const p = path(key); return existsSync(p) && statSync(p).isFile(); },
    async signedGetUrl(key, opts = {}) { return `${publicApiUrl()}/files/${signFileToken({ key: safeKey(key), fn: opts.filename, mime: opts.mime, exp: Math.floor(Date.now() / 1000) + (opts.ttlSeconds ?? 900) })}`; },
    async signedPutUrl() { return null; },
  };
}

// ---------- AWS Signature Version 4 ----------
export interface SigV4Input { method: string; url: string; headers?: Record<string, string>; payloadHash?: string; accessKey: string; secretKey: string; region: string; service?: string; date?: Date; sessionToken?: string }
const sha256hex = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const hmac = (k: Buffer | string, d: string) => createHmac("sha256", k).update(d, "utf8").digest();
const enc = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
const amz = (d: Date) => d.toISOString().replace(/[:-]|\.\d{3}/g, "");
function canonicalQuery(params: URLSearchParams): string { return [...params.entries()].map(([k, v]) => [enc(k), enc(v)] as const).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join("&"); }
const canonicalUri = (pathname: string) => pathname.split("/").map((seg) => enc(decodeURIComponent(seg))).join("/") || "/";
function signingKey(secret: string, dateStamp: string, region: string, service: string) { return hmac(hmac(hmac(hmac("AWS4" + secret, dateStamp), region), service), "aws4_request"); }
/** Header-signed request: returns the headers to send (Authorization, x-amz-date, x-amz-content-sha256, host). */
export function sigv4Headers(i: SigV4Input): Record<string, string> {
  const u = new URL(i.url); const date = i.date ?? new Date(); const amzDate = amz(date), stamp = amzDate.slice(0, 8); const service = i.service ?? "s3"; const payloadHash = i.payloadHash ?? sha256hex("");
  const headers: Record<string, string> = { ...Object.fromEntries(Object.entries(i.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v.trim()])), host: u.host, "x-amz-date": amzDate, "x-amz-content-sha256": payloadHash, ...(i.sessionToken ? { "x-amz-security-token": i.sessionToken } : {}) };
  const signedHeaders = Object.keys(headers).sort().join(";"); const canonicalHeaders = Object.keys(headers).sort().map((k) => `${k}:${headers[k].replace(/\s+/g, " ")}\n`).join("");
  const canonical = [i.method.toUpperCase(), canonicalUri(u.pathname), canonicalQuery(u.searchParams), canonicalHeaders, signedHeaders, payloadHash].join("\n");
  const scope = `${stamp}/${i.region}/${service}/aws4_request`; const sts = ["AWS4-HMAC-SHA256", amzDate, scope, sha256hex(canonical)].join("\n");
  const signature = createHmac("sha256", signingKey(i.secretKey, stamp, i.region, service)).update(sts).digest("hex");
  return { ...headers, authorization: `AWS4-HMAC-SHA256 Credential=${i.accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}` };
}
/** Query-signed (presigned) URL valid for `expires` seconds; payload is UNSIGNED-PAYLOAD as browsers cannot hash a streamed body. */
export function sigv4Presign(i: Omit<SigV4Input, "payloadHash"> & { expires: number }): string {
  const u = new URL(i.url); const date = i.date ?? new Date(); const amzDate = amz(date), stamp = amzDate.slice(0, 8); const service = i.service ?? "s3"; const scope = `${stamp}/${i.region}/${service}/aws4_request`;
  const extra = Object.fromEntries(Object.entries(i.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v.trim()])); const signedHeaders = ["host", ...Object.keys(extra)].sort().join(";");
  u.searchParams.set("X-Amz-Algorithm", "AWS4-HMAC-SHA256"); u.searchParams.set("X-Amz-Credential", `${i.accessKey}/${scope}`); u.searchParams.set("X-Amz-Date", amzDate); u.searchParams.set("X-Amz-Expires", String(i.expires)); u.searchParams.set("X-Amz-SignedHeaders", signedHeaders); if (i.sessionToken) u.searchParams.set("X-Amz-Security-Token", i.sessionToken);
  const canonicalHeaders = ["host", ...Object.keys(extra)].sort().map((k) => `${k}:${k === "host" ? u.host : extra[k]}\n`).join("");
  const canonical = [i.method.toUpperCase(), canonicalUri(u.pathname), canonicalQuery(u.searchParams), canonicalHeaders, signedHeaders, "UNSIGNED-PAYLOAD"].join("\n");
  const sts = ["AWS4-HMAC-SHA256", amzDate, scope, sha256hex(canonical)].join("\n");
  u.searchParams.set("X-Amz-Signature", createHmac("sha256", signingKey(i.secretKey, stamp, i.region, service)).update(sts).digest("hex"));
  return u.toString();
}

// ---------- S3 driver ----------
export function s3Storage(opts: { endpoint: string; bucket: string; accessKey: string; secretKey: string; region?: string; sse?: string | null; publicEndpoint?: string } = { endpoint: process.env.S3_ENDPOINT!, bucket: process.env.S3_BUCKET ?? "documents", accessKey: process.env.S3_ACCESS_KEY!, secretKey: process.env.S3_SECRET_KEY!, region: process.env.S3_REGION, sse: process.env.S3_SSE ?? "AES256", publicEndpoint: process.env.S3_PUBLIC_ENDPOINT }): Storage {
  const region = opts.region ?? "us-east-1"; const base = opts.endpoint.replace(/\/$/, ""); const pub = (opts.publicEndpoint ?? base).replace(/\/$/, "");
  const objUrl = (key: string, host = base) => `${host}/${opts.bucket}/${safeKey(key).split("/").map(encodeURIComponent).join("/")}`;   // path-style: works for MinIO and AWS alike
  const call = async (method: string, key: string, body?: Buffer, headers: Record<string, string> = {}) => {
    const url = objUrl(key); const h = sigv4Headers({ method, url, headers, payloadHash: sha256hex(body ?? ""), accessKey: opts.accessKey, secretKey: opts.secretKey, region });
    const r = await fetch(url, { method, headers: h, body: body as any }); return r;
  };
  return {
    driver: "s3",
    async put(key, body, mime) { const r = await call("PUT", key, body, { "content-type": mime, ...(opts.sse ? { "x-amz-server-side-encryption": opts.sse } : {}) }); if (!r.ok) throw new Error(`S3 PUT ${r.status}: ${(await r.text()).slice(0, 200)}`); },
    async get(key) { const r = await call("GET", key); if (!r.ok) throw new Error(`S3 GET ${r.status}`); return Buffer.from(await r.arrayBuffer()); },
    async delete(key) { const r = await call("DELETE", key); if (!r.ok && r.status !== 404) throw new Error(`S3 DELETE ${r.status}`); },
    async exists(key) { const r = await call("HEAD", key); return r.ok; },
    // Presigned links only when the bucket has a browser-reachable endpoint (S3_PUBLIC_ENDPOINT); otherwise the API streams the object itself.
    async signedGetUrl(key, o = {}) { if (!opts.publicEndpoint) return `${publicApiUrl()}/files/${signFileToken({ key: safeKey(key), fn: o.filename, mime: o.mime, exp: Math.floor(Date.now() / 1000) + (o.ttlSeconds ?? 900) })}`; const u = new URL(objUrl(key, pub)); if (o.filename) u.searchParams.set("response-content-disposition", `attachment; filename="${safeName(o.filename)}"`); if (o.mime) u.searchParams.set("response-content-type", o.mime); return sigv4Presign({ method: "GET", url: u.toString(), expires: o.ttlSeconds ?? 900, accessKey: opts.accessKey, secretKey: opts.secretKey, region }); },
    async signedPutUrl(key, o) { if (!opts.publicEndpoint) return null; return sigv4Presign({ method: "PUT", url: objUrl(key, pub), expires: o.ttlSeconds ?? 900, headers: { "content-type": o.mime }, accessKey: opts.accessKey, secretKey: opts.secretKey, region }); },
  };
}
let current: Storage | null = null;
/** S3 when S3_ENDPOINT is configured (compose sets it), the filesystem otherwise. */
export function storage(): Storage { if (!current) current = process.env.S3_ENDPOINT && process.env.S3_ACCESS_KEY ? s3Storage() : fsStorage(); return current; }
export function setStorage(s: Storage | null) { current = s; }
