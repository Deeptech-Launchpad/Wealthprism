/** PMS / AIF statements and depository e-CAS (FO-31, e-CAS reconcile): a PMS closing value prices the PMS holding and books its fees; an AIF
 *  statement keeps the commitment, drawn capital, NAV mark, call notices (→ committed outflow + task + schedule) and distributions; an e-CAS
 *  lands its positions in reconciliation. All idempotent on re-import. */
import type pg from "pg";
import type { PmsStatement, AifStatement, EcasStatement } from "@fo/parsers";
import { runReconciliation } from "./analytics.js";
import { notifyTask } from "./notify.js";

const r2 = (n: number) => Math.round(n * 100) / 100;
const words = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter((w) => w.length > 2 && !["fund", "the", "and", "ltd", "llp", "pms", "aif", "portfolio", "direct", "growth", "plan"].includes(w));
/** Best-effort match of a statement's manager / strategy words against instrument or company names. */
function score(candidate: string, ...needles: (string | undefined)[]) { const c = candidate.toLowerCase(); let n = 0; for (const s of needles) for (const w of words(s ?? "")) if (c.includes(w)) n++; return n; }

export async function applyPmsStatement(c: pg.PoolClient, familyId: string, s: PmsStatement, opts: { entityId?: string | null; jobId?: string | null } = {}) {
  const hs = (await c.query("select h.id, h.entity_id, h.quantity, h.avg_cost, i.id instrument_id, i.name, e.name entity_name from holdings h join instruments i on i.id=h.instrument_id join entities e on e.id=h.entity_id where h.family_id=$1 and i.type='pms' and h.quantity > 0 and ($2::uuid is null or h.entity_id=$2)", [familyId, opts.entityId ?? null])).rows;
  const ranked = hs.map((h) => ({ h, n: score(h.name, s.manager, s.strategy) + (s.clientName && h.entity_name.toUpperCase().split(" ")[0] === s.clientName.toUpperCase().split(" ")[0] ? 1 : 0) })).sort((a, b) => b.n - a.n);
  if (!ranked.length || ranked[0].n === 0) throw new Error(`no PMS holding matches "${s.manager}${s.strategy ? ` — ${s.strategy}` : ""}"; add the PMS as a holding first`);
  const h = ranked[0].h; const log: string[] = [];
  // the PMS holding is one unit priced at the portfolio value
  const unitPrice = r2(s.closingValue / Number(h.quantity)); const px = await c.query("insert into prices (instrument_id, price_date, close, source) values ($1,$2,$3,'pms_stmt') on conflict (instrument_id, price_date) do update set close=excluded.close, source=excluded.source returning (xmax = 0) inserted", [h.instrument_id, s.periodEnd, unitPrice]);
  log.push(`${h.name} valued at ${s.closingValue.toFixed(2)} on ${s.periodEnd}${px.rows[0]?.inserted ? "" : " (updated)"}`);
  let fees = 0; for (const [kind, amt] of [["pms_mgmt", s.fees.management], ["pms_perf", s.fees.performance], ["other", s.fees.other]] as const) {
    if (!amt || amt <= 0) continue; const dup = await c.query("select 1 from fees_ledger where family_id=$1 and instrument_id=$2 and fee_date=$3 and kind=$4", [familyId, h.instrument_id, s.periodEnd, kind]); if (dup.rowCount) continue;
    await c.query("insert into fees_ledger (family_id, entity_id, fee_date, kind, instrument_id, amount, source, note) values ($1,$2,$3,$4,$5,$6,'pms_stmt',$7)", [familyId, h.entity_id, s.periodEnd, kind, h.instrument_id, amt, `${s.manager} statement ${s.period}`]); fees += amt;
  }
  if (fees) log.push(`fees booked ${fees.toFixed(2)}`);
  // capital contributed against the platform's cost basis
  let recon = 0; if (s.contributed != null) { const cost = r2(Number(h.quantity) * Number(h.avg_cost)); const r = await runReconciliation(c, familyId, { source: "pms_stmt", entityId: h.entity_id, positions: [{ name: h.name, entity_id: h.entity_id, quantity: Number(h.quantity), amount: s.contributed, folio: s.clientCode }] }); recon = r.rows; if (Math.abs(cost - s.contributed) > Math.max(1, s.contributed * 0.01)) log.push(`capital contributed ${s.contributed.toFixed(2)} vs cost on platform ${cost.toFixed(2)}`); }
  if (s.holdings.length) await c.query("update instruments set meta = coalesce(meta,'{}'::jsonb) || jsonb_build_object('pms_holdings', $2::jsonb, 'pms_holdings_as_of', $3::text) where id=$1", [h.instrument_id, JSON.stringify(s.holdings.map((x) => ({ name: x.name, qty: x.qty, value: x.value, weight_pct: x.weightPct }))), s.periodEnd]);
  return { holding_id: h.id, instrument_id: h.instrument_id, entity_id: h.entity_id, value: s.closingValue, fees, reconciliation_items: recon, notes: log };
}

const callId = (piId: string, due: string) => `${piId.slice(0, 8)}-${due.replace(/-/g, "").slice(0, 4)}-4${due.replace(/-/g, "").slice(4, 7)}-8000-${piId.slice(-12)}`;
export async function applyAifStatement(c: pg.PoolClient, familyId: string, s: AifStatement, opts: { entityId?: string | null; jobId?: string | null } = {}) {
  const pis = (await c.query("select pi.id, pi.entity_id, pi.amount, co.name, e.name entity_name, fc.id fc_id, fc.total_commitment, fc.drawn, fc.schedule from private_investments pi join private_companies co on co.id=pi.company_id join entities e on e.id=pi.entity_id left join fund_commitments fc on fc.private_investment_id=pi.id where pi.family_id=$1 and pi.status <> 'written_off' and ($2::uuid is null or pi.entity_id=$2)", [familyId, opts.entityId ?? null])).rows;
  const ranked = pis.map((p) => ({ p, n: score(p.name, s.fund, s.manager) })).sort((a, b) => b.n - a.n); if (!ranked.length || ranked[0].n === 0) throw new Error(`no private investment matches "${s.fund}"; add the fund first`);
  const pi = ranked[0].p; const log: string[] = []; let tasks = 0, outflows = 0, flows = 0;
  if (s.commitment != null || s.drawn != null) {
    if (pi.fc_id) await c.query("update fund_commitments set total_commitment=coalesce($2,total_commitment), drawn=coalesce($3,drawn) where id=$1", [pi.fc_id, s.commitment ?? null, s.drawn ?? null]);
    else await c.query("insert into fund_commitments (private_investment_id, total_commitment, drawn, schedule) values ($1,$2,$3,'[]')", [pi.id, s.commitment ?? s.drawn ?? 0, s.drawn ?? 0]);
    log.push(`commitment ${s.commitment?.toFixed(2) ?? "—"}, drawn ${s.drawn?.toFixed(2) ?? "—"}`);
  }
  if (s.nav != null) { const dup = await c.query("select 1 from private_marks where private_investment_id=$1 and marked_on=$2", [pi.id, s.periodEnd]); if (!dup.rowCount) { await c.query("insert into private_marks (private_investment_id, marked_on, value, basis, note) values ($1,$2,$3,'nav',$4)", [pi.id, s.periodEnd, s.nav, `${s.fund} statement ${s.period ?? s.periodEnd}`]); log.push(`NAV ${s.nav.toFixed(2)} marked on ${s.periodEnd}`); } }
  for (const d of s.distributions) { const dup = await c.query("select 1 from fund_cashflows where private_investment_id=$1 and flow_date=$2 and kind='distribution' and amount=$3", [pi.id, d.date, d.amount]); if (dup.rowCount) continue; await c.query("insert into fund_cashflows (family_id, private_investment_id, flow_date, kind, amount, forecast, source) values ($1,$2,$3,'distribution',$4,false,$5)", [familyId, pi.id, d.date, d.amount, d.note ?? "aif statement"]); flows++; }
  for (const call of s.calls) {
    const sched: { due: string; amount: number }[] = Array.isArray(pi.schedule) ? pi.schedule : []; const fc = pi.fc_id ?? (await c.query("select id from fund_commitments where private_investment_id=$1", [pi.id])).rows[0]?.id;
    if (fc && !sched.some((x) => x.due === call.due && Math.abs(Number(x.amount) - call.amount) < 1)) { sched.push({ due: call.due, amount: call.amount }); sched.sort((a, b) => a.due.localeCompare(b.due)); await c.query("update fund_commitments set schedule=$2 where id=$1", [fc, JSON.stringify(sched)]); pi.schedule = sched; }
    const o = await c.query("select id from committed_outflows where family_id=$1 and kind='drawdown' and due_date=$2 and abs(amount - $3) < 1 and (label ilike $4 or source_id=$5)", [familyId, call.due, call.amount, `%${words(pi.name)[0] ?? pi.name}%`, pi.id]);
    if (!o.rowCount) { await c.query("insert into committed_outflows (family_id, entity_id, kind, label, due_date, amount, source_type, source_id, status) values ($1,$2,'drawdown',$3,$4,$5,'aif_statement',$6,'pending')", [familyId, pi.entity_id, `${pi.name} drawdown${call.number ? ` ${call.number}` : ""}`, call.due, call.amount, pi.id]); outflows++; }
    if (!(await c.query("select 1 from tasks where family_id=$1 and source_type='aif_call' and source_id=$2", [familyId, callId(pi.id, call.due)])).rowCount) {
      const t = (await c.query("insert into tasks (family_id, entity_id, module, title, reason, severity, due_date, amount, source_type, source_id, verification) values ($1,$2,'startups',$3,$4,1,$5,$6,'aif_call',$7,'pending') returning *", [familyId, pi.entity_id, `${pi.name} capital call${call.number ? ` ${call.number}` : ""} — ₹${call.amount.toLocaleString("en-IN")} due ${call.due}`, `Call notice in the ${s.period ?? s.periodEnd} statement; wire from ${pi.entity_name}'s account and import the debit to verify`, call.due, call.amount, callId(pi.id, call.due)])).rows[0];
      tasks++; await notifyTask(c, t).catch(() => null);
    }
  }
  let fees = 0; for (const [kind, amt] of [["aif_mgmt", s.fees.management], ["other", s.fees.other]] as const) { if (!amt || amt <= 0) continue; const dup = await c.query("select 1 from fees_ledger where family_id=$1 and entity_id=$2 and fee_date=$3 and kind=$4 and note like $5", [familyId, pi.entity_id, s.periodEnd, kind, `${s.fund}%`]); if (dup.rowCount) continue; await c.query("insert into fees_ledger (family_id, entity_id, fee_date, kind, amount, source, note) values ($1,$2,$3,$4,$5,'aif_stmt',$6)", [familyId, pi.entity_id, s.periodEnd, kind, amt, `${s.fund} statement ${s.period ?? s.periodEnd}`]); fees += amt; }
  return { private_investment_id: pi.id, entity_id: pi.entity_id, calls: s.calls.length, tasks, outflows, distributions: flows, fees, notes: log };
}

export async function applyEcas(c: pg.PoolClient, familyId: string, s: EcasStatement, opts: { entityId?: string | null; resolveEntity: (hint: { pan?: string; name?: string }) => Promise<string | null> } ) {
  const entityId = opts.entityId ?? (await opts.resolveEntity({ pan: s.pan, name: s.holder })); if (!entityId) throw new Error(`could not attribute the ${s.depository} statement to an entity (PAN ${s.pan ?? "missing"}, holder ${s.holder ?? "missing"}) — pass entity_id`);
  const demat = s.positions.filter((p) => p.account.kind === "demat"), mf = s.positions.filter((p) => p.account.kind === "mf_folio"); const out = { entity_id: entityId, positions: s.positions.length, exceptions: 0, matched: 0, items: [] as any[] };
  if (demat.length) { const r = await runReconciliation(c, familyId, { source: s.depository === "CDSL" ? "ecas_cdsl" : "ecas_nsdl", entityId, positions: demat.map((p) => ({ isin: p.isin, name: p.name, quantity: p.quantity, entity_id: entityId, folio: p.account.clientId })) }); out.exceptions += r.rows; out.matched += r.matched; out.items.push(...r.items); }
  if (mf.length) { const r = await runReconciliation(c, familyId, { source: "cas_mf", entityId, positions: mf.map((p) => ({ isin: p.isin, name: p.name, quantity: p.quantity, entity_id: entityId, folio: p.account.folio })) }); out.exceptions += r.rows; out.matched += r.matched; out.items.push(...r.items); }
  return out;
}
