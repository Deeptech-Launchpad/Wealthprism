import pg from "pg";
import { AsyncLocalStorage } from "node:async_hooks";
import { config } from "../config.js";
export const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 10 });
/** Per-request store of family transactions in flight: a handler that calls reply.send() inside withFamily must not let the
 *  response leave before the commit lands, or the client's next request can read the uncommitted state. server.ts opens the
 *  store per request and awaits every pending transaction in onSend. */
export const txContext = new AsyncLocalStorage<{ pending: Promise<unknown>[]; open: number }>();
/** Run `fn` inside a transaction with app.family_id set so Postgres RLS scopes every query. */
export function withFamily<T>(familyId: string, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const store = txContext.getStore(); if (store) store.open++;   // counted synchronously so the onSend hook can tell "nothing in flight" without a tick
  const p = (async () => {
    const c = await pool.connect();
    try {
      await c.query("begin");
      await c.query("select set_config('app.family_id', $1, true)", [familyId]);
      const r = await fn(c);
      await c.query("commit");
      return r;
    } catch (e) { await c.query("rollback"); throw e; } finally { c.release(); if (store) store.open--; }
  })();
  store?.pending.push(p.catch(() => undefined));
  return p;
}
export const money = (v: unknown) => (v === null || v === undefined ? "0.00" : Number(v).toFixed(2));
