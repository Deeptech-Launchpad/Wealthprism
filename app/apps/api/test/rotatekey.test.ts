import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import pg from "pg";
import { encryptSecret, decryptSecret } from "@fo/connectors";

// FIELD_ENCRYPTION_KEY rotation. The key protects PANs, connector credentials, webhook secrets and AA key
// material; swapping it without re-encrypting is unrecoverable, so this proves the round trip and that the
// tool refuses to write when the old key is wrong. Rows created here are removed in teardown.
const run = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FAMILY = "11111111-1111-1111-1111-111111111111";
const OLD = "rotate-test-old-key-000000000000", NEW = "rotate-test-new-key-111111111111";
const url = process.env.MIGRATION_DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/familyoffice";

let db: pg.Client;
const ids: { entity?: string; connector?: string; cred?: string; hook?: string } = {};
const rotate = (args: string[] = []) =>
  run("npx", ["tsx", "src/rotatekey.ts", ...args], {
    cwd: ROOT,
    env: { ...process.env, OLD_FIELD_ENCRYPTION_KEY: OLD, NEW_FIELD_ENCRYPTION_KEY: NEW, MIGRATION_DATABASE_URL: url },
  }).catch((e) => e);

beforeAll(async () => {
  db = new pg.Client({ connectionString: url }); await db.connect();
  const e = (await db.query("insert into entities (family_id, type, name, pan_enc, pan_last4) values ($1,'individual','Rotation Test',$2,'9999') returning id",
    [FAMILY, Buffer.from(encryptSecret("AAAPZ1234C", OLD))])).rows[0]; ids.entity = e.id;
  const k = (await db.query("insert into connectors (family_id, entity_id, kind, provider, label, status, sandbox) values ($1,$2,'broker','kite','Rotation Test','pending_auth',true) returning id",
    [FAMILY, e.id])).rows[0]; ids.connector = k.id;
  ids.cred = (await db.query("insert into connector_credentials (family_id, connector_id, name, ciphertext) values ($1,$2,'api_key',$3) returning id",
    [FAMILY, k.id, encryptSecret("super-secret-token", OLD)])).rows[0].id;
  ids.hook = (await db.query("insert into webhooks (family_id, url, secret_hash, secret_enc, events, active, label) values ($1,'https://example.test/hook','hash',$2,'{export.ready}',false,'rotation test') returning id",
    [FAMILY, encryptSecret("whsec_abc", OLD)])).rows[0].id;
});

afterAll(async () => {
  if (ids.hook) await db.query("delete from webhooks where id=$1", [ids.hook]);
  if (ids.cred) await db.query("delete from connector_credentials where id=$1", [ids.cred]);
  if (ids.connector) await db.query("delete from connectors where id=$1", [ids.connector]);
  if (ids.entity) await db.query("delete from entities where id=$1", [ids.entity]);
  await db.end();
});

const panOf = async () => Buffer.from((await db.query("select pan_enc from entities where id=$1", [ids.entity])).rows[0].pan_enc).toString("utf8");
const credOf = async () => (await db.query("select ciphertext from connector_credentials where id=$1", [ids.cred])).rows[0].ciphertext;
const hookOf = async () => (await db.query("select secret_enc from webhooks where id=$1", [ids.hook])).rows[0].secret_enc;

describe("FIELD_ENCRYPTION_KEY rotation", () => {
  it("a dry run reports the work and changes nothing", async () => {
    const before = [await panOf(), await credOf(), await hookOf()];
    const r = await rotate();
    expect(r.stdout).toMatch(/dry run:/);
    expect(r.stdout).toMatch(/entities\.pan_enc/);
    expect([await panOf(), await credOf(), await hookOf()]).toEqual(before);
  });

  it("--apply re-encrypts every store so the new key reads exactly what the old key held", async () => {
    const r = await rotate(["--apply"]);
    expect(r.stdout, r.stderr).toMatch(/rotated \d+ row\(s\)/);
    expect(decryptSecret(await panOf(), NEW)).toBe("AAAPZ1234C");
    expect(decryptSecret(await credOf(), NEW)).toBe("super-secret-token");
    expect(decryptSecret(await hookOf(), NEW)).toBe("whsec_abc");
    const pan = await panOf();
    expect(() => decryptSecret(pan, OLD)).toThrow();                         // the old key no longer opens it
  });

  it("is safe to re-run: rows already on the new key are left alone, not double-encrypted", async () => {
    const r = await rotate(["--apply"]);
    expect(r.stdout).toMatch(/0 row\(s\); \d+ were already on the new key|rotated 0 row/);
    expect(decryptSecret(await credOf(), NEW)).toBe("super-secret-token");
  });

  it("refuses to write when the old key is wrong, rather than mangling the rows", async () => {
    const before = await credOf();
    const r = await run("npx", ["tsx", "src/rotatekey.ts", "--apply"], {
      cwd: ROOT,
      env: { ...process.env, OLD_FIELD_ENCRYPTION_KEY: "a-key-that-was-never-used-here", NEW_FIELD_ENCRYPTION_KEY: "another-new-key", MIGRATION_DATABASE_URL: url },
    }).catch((e) => e);
    expect(r.code ?? r.exitCode).toBe(1);
    expect(String(r.stderr)).toMatch(/decrypt with neither key/);
    expect(await credOf()).toBe(before);
  });
});
