// Nightly rebalancing jobs (FO-160..162): needs, lot constraints, trigger evaluation → runs and drafted plans.
import { pool } from "../lib/db.js";
import { withFamilyClient } from "./market.js";
import { gatherNeeds, computeLotConstraints, evaluatePrograms } from "../lib/rebalance.js";
export async function rebalanceNeedsAll(day?: string) { let n = 0; for (const f of (await pool.query("select id from families")).rows) await withFamilyClient(f.id, async (c) => { n += (await gatherNeeds(c, f.id, day)).rows; await computeLotConstraints(c, f.id, day); }); return { rows: n, note: `${n} needs gathered; lot constraints refreshed` }; }
export async function rebalanceEvaluateAll(day?: string) { let n = 0; const notes: string[] = []; for (const f of (await pool.query("select id from families")).rows) await withFamilyClient(f.id, async (c) => { const r = await evaluatePrograms(c, f.id, day); n += r.rows; notes.push(r.note); }); return { rows: n, note: notes.join(" | ") }; }
