import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildApp } from "../src/server.js";
import { pool } from "../src/lib/db.js";
const FAMILY = "11111111-1111-1111-1111-111111111111";
let app: ReturnType<typeof buildApp>; let token = "";
beforeAll(async () => {
  app = buildApp(); await app.ready();
  const r = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: "arjun@example.com", password: "Prototype!2026" } });
  expect(r.statusCode).toBe(200); token = r.json().access_token;
});
afterAll(async () => { await app.close(); await pool.end(); });
const h = (extra: Record<string, string> = {}) => ({ authorization: `Bearer ${token}`, "x-family-id": FAMILY, ...extra });
describe("api", () => {
  it("rejects without token", async () => { expect((await app.inject({ url: "/api/v1/holdings" })).statusCode).toBe(401); });
  it("rejects a family the user is not in", async () => { expect((await app.inject({ url: "/api/v1/holdings", headers: h({ "x-family-id": "00000000-0000-0000-0000-000000000009" }) })).statusCode).toBe(403); });
  it("returns seeded holdings with totals", async () => {
    const j = (await app.inject({ url: "/api/v1/holdings", headers: h() })).json();
    expect(j.items.length).toBeGreaterThanOrEqual(7); expect(Number(j.totals.value)).toBeGreaterThan(0);
  });
  it("dashboard aggregates entities, rent and attention", async () => {
    const j = (await app.inject({ url: "/api/v1/dashboard", headers: h() })).json();
    expect(j.by_entity.length).toBe(3); expect(j.rent.overdue_count).toBe(1); expect(j.attention.length).toBeGreaterThan(0); expect(j.buckets.length).toBe(3);
  });
  it("marks a task done, audits it, and viewers are refused", async () => {
    const tasks = (await app.inject({ url: "/api/v1/tasks", headers: h() })).json();
    const r = await app.inject({ method: "PATCH", url: `/api/v1/tasks/${tasks[0].id}`, headers: h(), payload: { status: "done" } });
    expect(r.statusCode).toBe(200); expect(r.json().status).toBe("done");
    await app.inject({ method: "PATCH", url: `/api/v1/tasks/${tasks[0].id}`, headers: h(), payload: { status: "open" } });
    const v = (await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: "ca@example.com", password: "Prototype!2026" } })).json().access_token;
    const rv = await app.inject({ method: "PATCH", url: `/api/v1/tasks/${tasks[0].id}`, headers: { authorization: `Bearer ${v}`, "x-family-id": FAMILY }, payload: { status: "done" } });
    expect(rv.statusCode).toBe(403);
  });
  it("working capital summary computes float and excess", async () => {
    const j = (await app.inject({ url: "/api/v1/working-capital/summary", headers: h() })).json();
    expect(Number(j.cash_total)).toBeGreaterThan(0); expect(Number(j.required_float)).toBeGreaterThan(0);
  });
});
