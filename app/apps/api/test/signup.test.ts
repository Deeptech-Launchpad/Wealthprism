import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildApp } from "../src/server.js";
import { pool } from "../src/lib/db.js";

// Sign-up is open unless the server sets ALLOW_SIGNUP=false; the login page reads this to show or hide sign-up.
let app: ReturnType<typeof buildApp>; let saved: string | undefined;
beforeAll(async () => { saved = process.env.ALLOW_SIGNUP; app = buildApp(); await app.ready(); });
afterAll(async () => { if (saved === undefined) delete process.env.ALLOW_SIGNUP; else process.env.ALLOW_SIGNUP = saved; await app.close(); await pool.end(); });

describe("sign-up setting", () => {
  it("is open when ALLOW_SIGNUP is not set, and the login page can read it without signing in", async () => {
    delete process.env.ALLOW_SIGNUP;
    const r = await app.inject({ method: "GET", url: "/api/v1/auth/config" });
    expect(r.statusCode).toBe(200); expect(r.json()).toEqual({ signup_open: true });
  });
  it("is closed when the server sets ALLOW_SIGNUP=false, and sign-up is then refused", async () => {
    process.env.ALLOW_SIGNUP = "false";
    expect((await app.inject({ method: "GET", url: "/api/v1/auth/config" })).json()).toEqual({ signup_open: false });
    const reg = await app.inject({ method: "POST", url: "/api/v1/auth/register", payload: { email: "nobody@example.com", password: "longenough1", name: "No One", family_name: "No Family" } });
    expect(reg.statusCode).toBe(403);
  });
});
