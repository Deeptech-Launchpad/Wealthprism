/** Nightly balance-sheet and analytics jobs (FO-90, 97, 101, 102): EMI matching, LTV, committed outflows, IPS rules, reconciliation and the cash-flow forecast, per family. */
import { pool } from "../lib/db.js";
import { withFamilyClient } from "./market.js";
import { matchEmis, refreshLtv, syncOutflows } from "../lib/balance.js";
import { evaluateIpsRules, runReconciliation, buildForecast } from "../lib/analytics.js";
import type pg from "pg";

export async function balanceNightly(c: pg.PoolClient, familyId: string) {
  const emi = await matchEmis(c, familyId); const ltv = await refreshLtv(c, familyId); const out = await syncOutflows(c, familyId);
  const ips = await evaluateIpsRules(c, familyId); const recon = await runReconciliation(c, familyId, { source: undefined }); const fc = await buildForecast(c, familyId, { months: 24, persist: true });
  return { emi: emi.rows, ltv: ltv.rows, outflows: out.rows, ips_breaches: ips.results.filter((r) => !r.ok).length, recon_exceptions: recon.rows, first_below_float: fc.first_below_float };
}
export async function balanceNightlyAll() {
  let n = 0; const notes: string[] = [];
  for (const f of (await pool.query("select id from families")).rows) await withFamilyClient(f.id, async (c) => { const r = await balanceNightly(c, f.id); n++; notes.push(`${r.emi} EMIs · ${r.ips_breaches} IPS breaches · ${r.recon_exceptions} recon exceptions${r.first_below_float ? ` · float dip ${r.first_below_float}` : ""}`); });
  return { rows: n, note: notes.join(" | ") };
}
