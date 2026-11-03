import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildApp } from "../src/server.js";
import { pool, withFamily } from "../src/lib/db.js";
import { generateTasksFor } from "../src/jobs/tasks.js";

// Insurance premiums: "Premium paid" is refused for a premium months away, and a premium more than 30 days late raises a "may have lapsed" task.
const FAMILY = "11111111-1111-1111-1111-111111111111";
let app: ReturnType<typeof buildApp>; let owner = ""; let entity = "";
const h = (t = owner) => ({ authorization: `Bearer ${t}`, "x-family-id": FAMILY });
const call = async (method: string, url: string, payload?: any) => { const r = await app.inject({ method: method as any, url: `/api/v1${url}`, headers: h(), payload }); return { code: r.statusCode, body: r.body ? r.json() : null }; };
const day = (offset: number) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);

beforeAll(async () => {
  app = buildApp(); await app.ready();
  owner = (await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: "arjun@example.com", password: "Prototype!2026" } })).json().access_token;
  entity = (await call("GET", "/entities")).body[0].id;
});
afterAll(async () => {
  await withFamily(FAMILY, async (c) => { await c.query("delete from tasks where title like '%ZZ Premium%'"); await c.query("delete from committed_outflows where source_type='insurance_policy' and source_id in (select id from insurance_policies where insurer like 'ZZ Premium%')"); await c.query("delete from insurance_policies where insurer like 'ZZ Premium%'"); });
  await app.close(); await pool.end();
});

const make = (name: string, due: string, extra: any = {}) => call("POST", "/insurance-policies", { entity_id: entity, kind: "term_life", insurer: name, sum_assured: 5000000, premium: 12000, premium_frequency: "yearly", next_premium_due: due, ...extra });

describe("insurance premiums", () => {
  it("refuses 'premium paid' when the next premium is more than 60 days away, and rolls the date on when it is near", async () => {
    const far = await make("ZZ Premium Far", day(200)); expect(far.code).toBe(201);
    const refused = await call("POST", `/insurance-policies/${far.body.id}/premium-paid`, {}); expect(refused.code).toBe(422); expect(refused.body.title).toMatch(/days away/);
    expect((await call("GET", `/insurance-policies/${far.body.id}`)).body.next_premium_due).toBe(day(200));   // nothing moved
    const near = await make("ZZ Premium Near", day(20)); const ok = await call("POST", `/insurance-policies/${near.body.id}/premium-paid`, {});
    expect(ok.code).toBe(200); expect(Number(ok.body.next_premium_due.slice(0, 4))).toBe(Number(day(20).slice(0, 4)) + 1);
    const late = await make("ZZ Premium Late", day(-10)); expect((await call("POST", `/insurance-policies/${late.body.id}/premium-paid`, {})).code).toBe(200);   // overdue can be marked paid
  });
  it("raises a 'may have lapsed' task once a premium is more than 30 days late, and clears it when paid", async () => {
    const p = await make("ZZ Premium Lapsed", day(-45), { kind: "endowment", surrender_value: 150000 }); expect(p.code).toBe(201);
    await withFamily(FAMILY, (c) => generateTasksFor(c, FAMILY, day(0), { notify: false }));
    const find = async () => (await call("GET", "/tasks?status=open&module=insurance")).body.find((t: any) => /May have lapsed.*ZZ Premium Lapsed/.test(t.title));
    const t = await find(); expect(t).toBeTruthy(); expect(t.reason).toMatch(/surrender or fund value/);
    expect((await call("POST", `/insurance-policies/${p.body.id}/premium-paid`, {})).code).toBe(200);
    await withFamily(FAMILY, (c) => generateTasksFor(c, FAMILY, day(0), { notify: false }));
    expect(await find()).toBeFalsy();
    const recent = await make("ZZ Premium Recent", day(-10)); void recent;   // only 10 days late: the ordinary reminder, not the lapse one
    await withFamily(FAMILY, (c) => generateTasksFor(c, FAMILY, day(0), { notify: false }));
    expect((await call("GET", "/tasks?status=open&module=insurance")).body.find((t: any) => /May have lapsed.*ZZ Premium Recent/.test(t.title))).toBeFalsy();
  });
});
