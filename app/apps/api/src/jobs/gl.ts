// Nightly GL sweep (FO-47/111): recurring journals due today, then auto-posting of every source event without a journal.
import { pool } from "../lib/db.js";
import { withFamilyClient } from "./market.js";
import { autopost, runRecurring } from "../lib/gl.js";
export async function glAutopostAll() { let posted = 0, queued = 0; for (const f of (await pool.query("select id from families")).rows) await withFamilyClient(f.id, async (c) => { const r = await autopost(c, f.id); posted += r.posted; queued += r.queued; }); return { rows: posted, note: `${posted} journals posted, ${queued} queued` }; }
export async function glRecurringAll(day?: string) { let n = 0; for (const f of (await pool.query("select id from families")).rows) await withFamilyClient(f.id, async (c) => { n += (await runRecurring(c, f.id, day)).posted; }); return { rows: n, note: `${n} recurring journals` }; }
