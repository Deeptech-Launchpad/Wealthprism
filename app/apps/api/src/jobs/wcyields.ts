/** Nightly: re-fetch the NAVs behind every working-capital fund link, so the live yields shown next day come from fresh data.
 *  Runs after the AMFI price feed (which only brings in the latest NAV) and fills in the earlier point a 30-day or 1-year yield needs. */
import { pool } from "../lib/db.js";
import { withFamilyClient } from "./market.js";
import { refreshFundHistory, FUND_BASIS_DAYS } from "../lib/wcfunds.js";

export async function fundYieldsAll(): Promise<{ rows: number; note: string }> {
  const codes = new Set<string>(); const bases = new Set<number>();
  for (const f of (await pool.query("select id from families")).rows) {
    await withFamilyClient(f.id, async (c) => {
      const prefs = (await c.query("select instrument_prefs from wc_settings where family_id=$1", [f.id])).rows[0]?.instrument_prefs;
      for (const [bucket, fund] of Object.entries<any>(prefs?.funds ?? {})) { if (fund?.code && FUND_BASIS_DAYS[bucket]) { codes.add(String(fund.code)); bases.add(FUND_BASIS_DAYS[bucket]); } }
    });
  }
  if (!codes.size) return { rows: 0, note: "no fund is linked to a working-capital bucket" };
  const r = await refreshFundHistory(pool, [...codes], [...bases]);
  return { rows: r.stored, note: `${codes.size} linked fund(s) refreshed${r.missing.length ? `; not in the AMFI list: ${r.missing.join(", ")}` : ""}` };
}
