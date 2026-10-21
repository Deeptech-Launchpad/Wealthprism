/**
 * Re-encrypt every FIELD_ENCRYPTION_KEY ciphertext from an old key to a new one.
 *
 * The key protects four stores (AES-256-GCM, so a wrong key cannot be brute-forced back):
 *   entities.pan_enc                  PANs — only the last four digits survive elsewhere
 *   connector_credentials.ciphertext  broker / bank credentials
 *   webhooks.secret_enc               the secret each delivery is signed with
 *   aa_consents.key_material          the ECDH key pair that decrypts Account Aggregator data
 * Changing the key in deploy/.env without running this makes all four permanently unreadable.
 *
 *   OLD_FIELD_ENCRYPTION_KEY=… NEW_FIELD_ENCRYPTION_KEY=… node dist/rotatekey.js            # dry run
 *   OLD_FIELD_ENCRYPTION_KEY=… NEW_FIELD_ENCRYPTION_KEY=… node dist/rotatekey.js --apply    # rewrite
 *
 * Connects with MIGRATION_DATABASE_URL: the rotation must see every family's rows, and app_user
 * is deliberately denied select on connector_credentials.ciphertext (db/023).
 *
 * Safe to re-run: a row that no longer decrypts with the old key but does with the new one is
 * counted as already rotated and left alone. Everything happens in one transaction, and --apply
 * aborts before writing if any row decrypts with neither key.
 */
import pg from "pg";
import { encryptSecret, decryptSecret } from "@fo/connectors";
import { config } from "./config.js";

const OLD = process.env.OLD_FIELD_ENCRYPTION_KEY, NEW = process.env.NEW_FIELD_ENCRYPTION_KEY;
const apply = process.argv.includes("--apply");
if (!OLD || !NEW) { console.error("set OLD_FIELD_ENCRYPTION_KEY and NEW_FIELD_ENCRYPTION_KEY"); process.exit(2); }
if (OLD === NEW) { console.error("the two keys are identical — nothing to do"); process.exit(2); }

/** Each store: where the blob lives, and how to read/write it (pan_enc is bytea, the rest are text). */
const STORES = [
  { table: "entities", column: "pan_enc", bytea: true },
  { table: "connector_credentials", column: "ciphertext", bytea: false },
  { table: "webhooks", column: "secret_enc", bytea: false },
  { table: "aa_consents", column: "key_material", bytea: false },
] as const;

const c = new pg.Client({ connectionString: config.migrationDatabaseUrl });
await c.connect();
await c.query("begin");

let rotated = 0, already = 0, failed = 0;
for (const s of STORES) {
  const exists = (await c.query(
    "select 1 from information_schema.columns where table_name=$1 and column_name=$2", [s.table, s.column])).rowCount;
  if (!exists) { console.log(`${s.table}.${s.column}`.padEnd(38), "— no such column, skipped"); continue; }

  const rows = (await c.query(`select id, ${s.column} as blob from ${s.table} where ${s.column} is not null`)).rows;
  let n = 0, skip = 0;
  for (const r of rows) {
    const blob = s.bytea ? Buffer.from(r.blob).toString("utf8") : String(r.blob);
    let plain: string;
    try { plain = decryptSecret(blob, OLD); }
    catch {
      try { decryptSecret(blob, NEW); skip++; continue; }                       // already rotated
      catch { failed++; console.error(`  ${s.table} ${r.id}: decrypts with neither key`); continue; }
    }
    const next = encryptSecret(plain, NEW);
    if (apply) await c.query(`update ${s.table} set ${s.column}=$2 where id=$1`,
      [r.id, s.bytea ? Buffer.from(next) : next]);
    n++;
  }
  rotated += n; already += skip;
  console.log(`${s.table}.${s.column}`.padEnd(38), `${String(n).padStart(4)} to rotate, ${skip} already, ${rows.length} total`);
}

if (failed) { await c.query("rollback"); console.error(`\n${failed} row(s) decrypt with neither key — nothing written. Is OLD_FIELD_ENCRYPTION_KEY right?`); await c.end(); process.exit(1); }
if (!apply) { await c.query("rollback"); console.log(`\ndry run: ${rotated} row(s) would be rotated, ${already} already done. Re-run with --apply.`); }
else { await c.query("commit"); console.log(`\nrotated ${rotated} row(s); ${already} were already on the new key. Put the new key in deploy/.env and restart api, worker and executor.`); }
await c.end();
