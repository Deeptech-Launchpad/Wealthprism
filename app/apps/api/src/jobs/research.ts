// Research jobs (FO-150..157): channel polling + pipeline hourly, track record nightly, digest on the family's cadence.
import { pool } from "../lib/db.js";
import { withFamilyClient } from "./market.js";
import { runPipeline, evaluateTrackRecord, generateDigest, settingsFor } from "../lib/research.js";

export async function researchPipelineAll(opts: { poll?: boolean } = {}) {
  let rows = 0; const notes: string[] = [];
  for (const f of (await pool.query("select id from families")).rows) await withFamilyClient(f.id, async (c) => { const r = await runPipeline(c, f.id, { poll: opts.poll ?? process.env.RESEARCH_POLL !== "false" }); rows += r.rows; notes.push(r.note); });
  return { rows, note: notes.join(" | ") };
}
export async function researchTrackRecordAll(asOf?: string) {
  let rows = 0, moved = 0;
  for (const f of (await pool.query("select id from families")).rows) await withFamilyClient(f.id, async (c) => { const r = await evaluateTrackRecord(c, f.id, asOf); rows += r.rows; moved += r.moved; });
  return { rows, note: `${rows} evaluations, ${moved} trust scores moved` };
}
/** Generates the digest for every family whose cadence day/hour has come and which has none for the period yet. */
export async function researchDigestAll(now = new Date(), force = false) {
  let n = 0; const ist = new Date(now.getTime() + 5.5 * 3600 * 1000); const day = ist.getUTCDay(), hour = ist.getUTCHours(); const today = ist.toISOString().slice(0, 10);
  for (const f of (await pool.query("select id from families")).rows) await withFamilyClient(f.id, async (c) => {
    const st = await settingsFor(c, f.id);
    if (!force && (day !== Number(st.digest_weekday) || hour < Number(st.digest_hour))) return;
    const days = st.digest_cadence === "monthly" ? 30 : st.digest_cadence === "fortnightly" ? 14 : 7;
    if (!force && (await c.query("select 1 from research_digests where family_id=$1 and period_end >= $2::date - ($3 - 1)", [f.id, today, days])).rowCount) return;
    await generateDigest(c, f.id, null, { period_end: today, cadence: st.digest_cadence }); n++;
  });
  return { rows: n, note: `${n} digest${n === 1 ? "" : "s"} generated` };
}
