/** Applies db/*.sql in order (idempotent via schema_migrations); --seed also runs the seed files and sets dev passwords. */
import pg from "pg";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import bcrypt from "bcryptjs";
import { config } from "./config.js";
const seed = process.argv.includes("--seed");
const c = new pg.Client({ connectionString: config.migrationDatabaseUrl });
await c.connect();
await c.query("create table if not exists schema_migrations (name text primary key, applied_at timestamptz default now())");
const files = readdirSync(config.dbDir).filter((f) => f.endsWith(".sql")).sort();
for (const f of files) {
  if (f.includes("seed") && !seed) continue;
  if ((await c.query("select 1 from schema_migrations where name = $1", [f])).rowCount) { console.log("skip", f); continue; }
  console.log("apply", f);
  await c.query(readFileSync(join(config.dbDir, f), "utf8"));
  await c.query("insert into schema_migrations (name) values ($1)", [f]);
}
if (seed) { await c.query("update users set password_hash = $1 where email like '%@example.com'", [await bcrypt.hash("Prototype!2026", 10)]); console.log("seed users password set to Prototype!2026"); }
if (process.env.APP_DB_PASSWORD) await c.query(`alter role app_user with password '${process.env.APP_DB_PASSWORD.replace(/'/g, "''")}'`);
if (process.env.EXECUTOR_DB_PASSWORD) await c.query(`alter role executor_user with password '${process.env.EXECUTOR_DB_PASSWORD.replace(/'/g, "''")}'`).catch(() => null);   // role exists from db/008
await c.end();
