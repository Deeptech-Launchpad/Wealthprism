import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildApp } from "../src/server.js";
import { withFamily, pool } from "../src/lib/db.js";

// Every asset that counts toward net worth must sit in a bucket, or be listed as "not in a bucket".
const FAMILY = "11111111-1111-1111-1111-111111111111";
let app: ReturnType<typeof buildApp>; let token = "";
const h = () => ({ authorization: `Bearer ${token}`, "x-family-id": FAMILY });
const get = async (url: string) => { const r = await app.inject({ url: `/api/v1${url}`, headers: h() }); return { code: r.statusCode, body: r.json() }; };

beforeAll(async () => {
  app = buildApp(); await app.ready();
  token = (await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: "arjun@example.com", password: "Prototype!2026" } })).json().access_token;
});
afterAll(async () => { await app.close(); await pool.end(); });

describe("buckets reconcile with net worth", () => {
  it("the three buckets plus the items in no bucket add up to the dashboard's assets", async () => {
    const d = (await get("/dashboard")).body;
    const buckets = (d.buckets as any[]).reduce((s, b) => s + Number(b.value), 0);
    const notIn = Number(d.not_in_buckets?.total ?? 0);
    expect(Math.abs(buckets + notIn - Number(d.assets))).toBeLessThan(1);
  });
});
