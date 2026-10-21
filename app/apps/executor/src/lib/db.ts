import pg from "pg";
export const pool = new pg.Pool({ connectionString: process.env.EXECUTOR_DATABASE_URL ?? process.env.DATABASE_URL, max: 2 });
export const SANDBOX_ONLY = process.env.SANDBOX_ONLY !== "false";
/** Run `fn` for one family with RLS context; commits on success. */
export async function withFamily<T>(familyId: string, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try { await c.query("begin"); await c.query("select set_config('app.family_id',$1,true)", [familyId]); const r = await fn(c); await c.query("commit"); return r; }
  catch (e) { await c.query("rollback"); throw e; } finally { c.release(); }
}
