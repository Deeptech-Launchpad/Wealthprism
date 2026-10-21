/** Planning jobs: nightly baseline (FO-71), optimiser rules (FO-78), actuals matching after imports (FO-77). */
import type pg from "pg";
import { pool } from "../lib/db.js";
import { runScenario, ensureBaseline, loadState, tablesProvider } from "../lib/planning.js";
import { withFamilyClient } from "./market.js";
import { fyOf, simulate, consumeFifo, compareRegimes } from "@fo/finance";

const iso = (d: any) => (d ? new Date(d).toISOString().slice(0, 10) : null);
const r2 = (n: number) => Math.round(n * 100) / 100;
const addMonths = (d: string, m: number) => { const x = new Date(d + "T00:00:00Z"); x.setUTCMonth(x.getUTCMonth() + m); return x.toISOString().slice(0, 10); };
const monthsBetween = (a: string, b: string) => { const [ay, am, ad] = a.split("-").map(Number), [by, bm, bd] = b.split("-").map(Number); let m = (by - ay) * 12 + (bm - am); if (bd < ad) m--; return m; };

/** Execution progress for a scenario from its actions and tasks. */
export async function executionProgress(c: pg.PoolClient, scenarioId: string) {
  const a = (await c.query("select status, planned_date, planned_amount, actual_amount, actual_date, variance, simulated_effect from plan_actions where scenario_id=$1 order by planned_date", [scenarioId])).rows;
  const done = a.filter((x) => x.status === "done"), inProg = a.filter((x) => x.status === "in_progress"), skipped = a.filter((x) => x.status === "skipped");
  const next = a.find((x) => ["planned", "in_progress"].includes(x.status));
  const planned = -a.reduce((t, x) => t + Number(x.simulated_effect?.tax ?? 0), 0);
  const realised = -done.reduce((t, x) => t + Number(x.simulated_effect?.tax ?? 0), 0);
  const withVar = done.filter((x) => x.variance);
  return { total: a.length, done: done.length, in_progress: inProg.length, skipped: skipped.length, pct: a.length ? Math.round((done.length / a.length) * 100) : 0, next_due: next ? iso(next.planned_date) : null,
    variance: { amount: r2(withVar.reduce((t, x) => t + Number(x.variance?.amount ?? 0), 0)).toFixed(2), tax_delta: r2(withVar.reduce((t, x) => t + Number(x.variance?.tax_delta ?? 0), 0)).toFixed(2), days_avg: withVar.length ? r2(withVar.reduce((t, x) => t + Number(x.variance?.days ?? 0), 0) / withVar.length) : 0 },
    planned_saving: r2(planned).toFixed(2), realised_saving: r2(realised).toFixed(2) };
}

/** plan.baseline: re-simulate every family's baseline and any approved/executing scenario nightly. */
export async function refreshBaselines() {
  let n = 0;
  for (const f of (await pool.query("select id from families")).rows) {
    await withFamilyClient(f.id, async (c) => {
      const base = await ensureBaseline(c, f.id);
      const ids = [base.id, ...(await c.query("select id from plan_scenarios where status in ('approved','executing','in_review') and not is_baseline and deleted_at is null")).rows.map((r) => r.id)];
      for (const id of ids) { try { await runScenario(c, f.id, id); n++; } catch (e: any) { await c.query("update plan_scenarios set last_error=$2 where id=$1", [id, String(e.message).slice(0, 500)]); } }
    });
  }
  return { rows: n, note: `${n} scenarios re-simulated` };
}

/** tax.optimise: the ten PRD rule codes against the baseline (or a scenario's projected state). Writes tax_suggestions. */
export async function runOptimiser(c: pg.PoolClient, familyId: string, opts: { scenarioId?: string; fy?: string; today?: string } = {}) {
  const today = opts.today ?? new Date().toISOString().slice(0, 10); const fy = opts.fy ?? fyOf(today);
  const fyEnd = `${Number(fy.slice(0, 4)) + 1}-03-31`;
  const { tables, cii } = await tablesProvider(c);
  const state = await loadState(c, today);
  const base = await ensureBaseline(c, familyId);
  const baseline = await runScenario(c, familyId, opts.scenarioId ?? base.id, { persist: false });
  const byEntity = (id: string) => baseline.by_fy.find((x) => x.fy === fy && x.entity_id === id);
  const drafts: { entity_id: string | null; code: string; title: string; rationale: string; est_saving: number; proposed_actions: any[] }[] = [];
  const nameOf = (id: string) => state.entities.find((e) => e.id === id)?.name ?? "";
  const regimeOf = (id: string) => state.entities.find((e) => e.id === id)!.regime;
  const slabTop = (id: string) => { const e = state.entities.find((x) => x.id === id)!; return tables(fy, regimeOf(id), e.type).slabs.slice(-1)[0]?.rate ?? 30; };

  for (const e of state.entities) {
    const comp = byEntity(e.id); if (!comp) continue;
    const t = tables(fy, regimeOf(e.id), e.type);
    const eqLong = t.rules.find((r) => r.assetClass === "equity" && r.term === "long");
    const headroom = Math.max(0, (eqLong?.exemptionAmount ?? 0) - comp.heads.capital_gains.exemption_used);
    const holdings = state.holdings.filter((h) => h.entityId === e.id);
    // use_ltcg_exemption: long-term equity lots in gain while exemption headroom remains
    if (headroom > 0 && eqLong) {
      const cands = holdings.filter((h) => h.assetClass === "equity").map((h) => { const lots = h.lots.filter((l) => monthsBetween(l.buyDate, today) >= eqLong.holdingMonthsForLong && h.price > l.unitCost); const gain = lots.reduce((s, l) => s + l.remainingQty * (h.price - l.unitCost), 0); return { h, lots, gain }; }).filter((x) => x.gain > 0).sort((a, b) => b.gain - a.gain);
      if (cands.length) { const c0 = cands[0]; const book = Math.min(headroom, c0.gain); const unitGain = c0.h.price - c0.lots[0].unitCost; const qty = Math.floor((book / unitGain) * 1000) / 1000;
        drafts.push({ entity_id: e.id, code: "use_ltcg_exemption", title: `Book ₹${Math.round(book).toLocaleString("en-IN")} LTCG in ${c0.h.name} before 31 Mar`, rationale: `${e.name} has used ₹${comp.heads.capital_gains.exemption_used.toLocaleString("en-IN")} of the ₹${eqLong.exemptionAmount.toLocaleString("en-IN")} equity LTCG exemption this FY; ${c0.h.name} lots are long-term with unrealised gain ₹${Math.round(c0.gain).toLocaleString("en-IN")}. Selling and re-buying resets the cost base tax-free.`, est_saving: r2(book * eqLong.rate / 100), proposed_actions: [{ kind: "book_gain_within_exemption", target_type: "holding", target_id: c0.h.id, params: { quantity: qty }, planned_date: addMonths(fyEnd, 0).replace("-31", "-20") }, { kind: "buy_instrument", params: { instrument_id: c0.h.instrumentId, amount: r2(qty * c0.h.price), note: `re-buy ${c0.h.name} next day` }, planned_date: addMonths(fyEnd, 0).replace("-31", "-21") }] }); }
    }
    // harvest_loss: loss lots that offset gains booked this FY
    const booked = comp.heads.capital_gains; const gainsBooked = Math.max(0, booked.stcg_equity + booked.stcg_other) + Math.max(0, booked.ltcg_equity - booked.exemption_used + booked.ltcg_other);
    if (gainsBooked > 0) {
      const losses = holdings.map((h) => { const lots = h.lots.filter((l) => h.price < l.unitCost); return { h, loss: lots.reduce((s, l) => s + l.remainingQty * (l.unitCost - h.price), 0), qty: lots.reduce((s, l) => s + l.remainingQty, 0), short: lots.some((l) => monthsBetween(l.buyDate, today) < (t.rules.find((r) => r.assetClass === h.assetClass && r.term === "long")?.holdingMonthsForLong ?? 12)) }; }).filter((x) => x.loss > 0).sort((a, b) => b.loss - a.loss);
      if (losses.length) { const l0 = losses[0]; const offset = Math.min(l0.loss, gainsBooked); const rate = l0.short ? (t.rules.find((r) => r.assetClass === l0.h.assetClass && r.term === "short")?.rate || slabTop(e.id)) : (t.rules.find((r) => r.assetClass === l0.h.assetClass && r.term === "long")?.rate ?? 12.5);
        drafts.push({ entity_id: e.id, code: "harvest_loss", title: `Harvest ₹${Math.round(l0.loss).toLocaleString("en-IN")} loss in ${l0.h.name}`, rationale: `${e.name} has ₹${Math.round(gainsBooked).toLocaleString("en-IN")} of taxable gains booked this FY; ${l0.h.name} carries an unrealised ${l0.short ? "short" : "long"}-term loss of ₹${Math.round(l0.loss).toLocaleString("en-IN")} that sets off against ${l0.short ? "any" : "long-term"} gains.`, est_saving: r2(offset * rate / 100), proposed_actions: [{ kind: "harvest_loss", target_type: "holding", target_id: l0.h.id, params: { quantity: l0.qty }, planned_date: today }] }); }
    }
    // wait_for_long_term: lots within 90 days of turning long where the short-term rate is worse
    for (const h of holdings) {
      const lr = t.rules.find((r) => r.assetClass === h.assetClass && r.term === "long"), sr = t.rules.find((r) => r.assetClass === h.assetClass && r.term === "short"); if (!lr || !sr) continue;
      const stRate = sr.taxedAtSlab || sr.rate === 0 ? slabTop(e.id) : sr.rate; if (stRate <= lr.rate) continue;
      const soon = h.lots.filter((l) => { const m = monthsBetween(l.buyDate, today); return m < lr.holdingMonthsForLong && m >= lr.holdingMonthsForLong - 3 && h.price > l.unitCost; });
      if (!soon.length) continue;
      const gain = soon.reduce((s, l) => s + l.remainingQty * (h.price - l.unitCost), 0); const turns = addMonths(soon[0].buyDate, lr.holdingMonthsForLong);
      drafts.push({ entity_id: e.id, code: "wait_for_long_term", title: `Hold ${h.name} until ${turns} before selling`, rationale: `${soon.reduce((s, l) => s + l.remainingQty, 0)} units bought ${soon[0].buyDate} turn long-term on ${turns}; selling earlier taxes the ₹${Math.round(gain).toLocaleString("en-IN")} gain at ${stRate}% instead of ${lr.rate}%.`, est_saving: r2(gain * (stRate - lr.rate) / 100), proposed_actions: [{ kind: "defer_sale_to_fy", target_type: "holding", target_id: h.id, params: { fy: fyOf(turns), quantity: soon.reduce((s, l) => s + l.remainingQty, 0) }, planned_date: turns }] });
    }
    // regime_switch
    if (["individual", "huf"].includes(e.type)) {
      const other = regimeOf(e.id) === "old" ? "new" : "old";
      const alt = simulate(state, [], { returns: { liquidity: 6.5, income: 8, growth: 12 }, inflation: 6, regime: { [e.id]: other } }, tables, { horizonFys: 1, cii }).by_fy.find((x) => x.entity_id === e.id && x.fy === fy);
      if (alt && alt.tax.total + 1 < comp.tax.total) drafts.push({ entity_id: e.id, code: "regime_switch", title: `${e.name}: ${other} regime saves ₹${Math.round(comp.tax.total - alt.tax.total).toLocaleString("en-IN")} this FY`, rationale: other === "old" ? `Deductions of ₹${alt.deductions_total.toLocaleString("en-IN")} (${Object.keys(alt.deductions).filter((k) => k !== "STD_DED").join(", ") || "none"}) outweigh the new slabs for ${e.name}.` : `With deductions of only ₹${comp.deductions_total.toLocaleString("en-IN")}, the wider new-regime slabs beat the old regime for ${e.name}.`, est_saving: r2(comp.tax.total - alt.tax.total), proposed_actions: [{ kind: "change_tax_regime", target_type: "entity", target_id: e.id, params: { regime: other, fy }, planned_date: fyEnd }] });
    }
    // advance_tax_gap
    const short = comp.advance_tax.filter((i) => i.due <= today && i.shortfall > 0);
    if (short.length && comp.interest_234c > 0) { const s = short[short.length - 1];
      drafts.push({ entity_id: e.id, code: "advance_tax_gap", title: `Advance tax short by ₹${Math.round(s.shortfall).toLocaleString("en-IN")} for ${e.name}`, rationale: `Projected tax ₹${comp.net_payable.toLocaleString("en-IN")} vs ₹${s.paid.toLocaleString("en-IN")} paid by ${s.due}; 234C interest accrues at ${t.params.INT_234C_PCT_PM ?? 1}%/month, 234B if under ${t.params.INT_234B_MIN_PAID_PCT ?? 90}% by 31 Mar.`, est_saving: r2(comp.interest_234), proposed_actions: [{ kind: "custom", params: { amount: -s.shortfall, tax_head: "other", cash: true, note: `Pay ₹${Math.round(s.shortfall).toLocaleString("en-IN")} advance tax` }, planned_date: today }] }); }
    // nps_80ccd / donate_80g headroom (old regime only)
    if (regimeOf(e.id) === "old" && comp.normal_income > 0) {
      const npsLim = t.deductionLimits["80CCD1B"] ?? 0; const used = comp.deductions["80CCD1B"] ?? 0; const room = Math.max(0, npsLim - used);
      if (room > 0 && comp.marginal_rate_pct >= 20) drafts.push({ entity_id: e.id, code: "nps_80ccd", title: `Put ₹${room.toLocaleString("en-IN")} into NPS for ${e.name}`, rationale: `80CCD(1B) headroom of ₹${room.toLocaleString("en-IN")} at a ${comp.marginal_rate_pct}% marginal rate.`, est_saving: r2(room * comp.marginal_rate_pct / 100 * (1 + (t.params.CESS_PCT ?? 4) / 100)), proposed_actions: [{ kind: "contribute_nps", params: { amount: room }, planned_date: addMonths(fyEnd, 0).replace("-31", "-25") }] });
      const gCap = comp.normal_income * (t.params.DED_80G_GTI_CAP_PCT ?? 10) / 100; if (!comp.deductions["80G"] && gCap > 0 && comp.marginal_rate_pct >= 30) drafts.push({ entity_id: e.id, code: "donate_80g", title: `80G room of ₹${Math.round(gCap).toLocaleString("en-IN")} for ${e.name}`, rationale: `Donations up to 10% of adjusted gross total income get a 50% deduction (100% for notified funds).`, est_saving: r2(gCap * (t.params.DED_80G_PCT ?? 50) / 100 * comp.marginal_rate_pct / 100), proposed_actions: [{ kind: "donate_80g", params: { amount: Math.round(gCap) }, planned_date: addMonths(fyEnd, 0).replace("-31", "-25") }] });
    }
    // route_to_entity: SIP/commitments in a high-rate entity when a lower-rate one exists
    const lowest = [...state.entities].filter((x) => ["individual", "huf"].includes(x.type)).map((x) => ({ x, rate: byEntity(x.id)?.marginal_rate_pct ?? 0 })).sort((a, b) => a.rate - b.rate)[0];
    if (lowest && lowest.x.id !== e.id && comp.marginal_rate_pct - lowest.rate >= 10) {
      const sip = state.commitments.filter((k) => k.entityId === e.id && /sip/i.test(k.label)).reduce((s, k) => s + k.amount, 0);
      if (sip > 0) drafts.push({ entity_id: e.id, code: "route_to_entity", title: `Route new SIPs via ${lowest.x.name}`, rationale: `${e.name} is at ${comp.marginal_rate_pct}% marginal; ${lowest.x.name} at ${lowest.rate}%. Fund the SIP from ${lowest.x.name}'s own income (a gift from ${e.name} is clubbed under s.64).`, est_saving: r2(sip * 0.08 * (comp.marginal_rate_pct - lowest.rate) / 100), proposed_actions: [{ kind: "transfer_to_entity", target_type: "entity", target_id: lowest.x.id, params: { monthly: r2(sip / 12), note: "route SIP mandate; fund from own income" }, planned_date: addMonths(today, 1) }] });
    }
  }
  // sec_54ec / sec_54f and split_across_fy / defer_to_next_fy: look at planned sales in draft/in-review scenarios
  const planned = (await c.query("select a.*, p.name scenario from plan_actions a join plan_scenarios p on p.id=a.scenario_id where p.deleted_at is null and p.status in ('draft','in_review') and a.kind in ('sell_property','sell_holding') and a.planned_date >= $1", [today])).rows;
  for (const a of planned) {
    const eff = a.simulated_effect ?? {};
    if (a.kind === "sell_property" && eff.term === "long" && Number(eff.gain) > 0) {
      const already = (await c.query("select 1 from plan_actions where scenario_id=$1 and kind in ('reinvest_54ec','reinvest_54f')", [a.scenario_id])).rows[0];
      if (!already) { const cap = tables(fy, "new", "individual").deductionLimits["54EC"] ?? 5000000; const amt = Math.min(Number(eff.gain), cap);
        drafts.push({ entity_id: a.entity_id, code: "sec_54ec", title: `Shelter ₹${Math.round(amt).toLocaleString("en-IN")} of the property gain in 54EC bonds`, rationale: `Scenario "${a.scenario}" sells a property with a long-term gain of ₹${Math.round(Number(eff.gain)).toLocaleString("en-IN")}; 54EC bonds bought within 6 months exempt up to ₹${cap.toLocaleString("en-IN")} per FY (5-year lock-in). 54F applies instead if the proceeds buy a house.`, est_saving: r2(amt * 12.5 / 100), proposed_actions: [{ kind: "reinvest_54ec", entity_id: a.entity_id, params: { amount: Math.round(amt), issuer: "REC" }, planned_date: addMonths(iso(a.planned_date)!, 5) }] }); }
    }
    if (a.kind === "sell_holding" && eff.term === "long" && Number(eff.gain) > 0) {
      const e = state.entities.find((x) => x.id === a.entity_id); const comp = e && byEntity(e.id); const ex = tables(fy, "new", "individual").rules.find((r) => r.assetClass === "equity" && r.term === "long")?.exemptionAmount ?? 0;
      if (comp && Number(eff.gain) > ex && iso(a.planned_date)! <= fyEnd) drafts.push({ entity_id: a.entity_id, code: "split_across_fy", title: `Split the ${eff.detail?.split("→")[0]?.trim() ?? "planned"} sale across 31 March`, rationale: `The planned gain of ₹${Math.round(Number(eff.gain)).toLocaleString("en-IN")} exceeds one year's exemption of ₹${ex.toLocaleString("en-IN")}; selling half in each FY uses two exemptions.`, est_saving: r2(Math.min(ex, Number(eff.gain) - ex) * 12.5 / 100), proposed_actions: [{ kind: "defer_sale_to_fy", target_type: "holding", target_id: a.target_id, params: { quantity: Math.floor(Number(a.params?.quantity ?? 0) / 2), fy: `${Number(fy.slice(0, 4)) + 1}-${String(Number(fy.slice(0, 4)) + 2).slice(-2)}` }, planned_date: `${Number(fy.slice(0, 4)) + 1}-04-05` }] });
      const daysToFyEnd = (Date.parse(fyEnd) - Date.parse(iso(a.planned_date)!)) / 86400000;
      if (daysToFyEnd >= 0 && daysToFyEnd <= 45 && comp && comp.heads.capital_gains.exemption_used >= ex) drafts.push({ entity_id: a.entity_id, code: "defer_to_next_fy", title: `Defer the ${eff.detail?.split("→")[0]?.trim() ?? "planned"} sale to April`, rationale: `The sale is planned in the last 45 days of FY ${fy} when the exemption is already used; next FY's exemption is untouched.`, est_saving: r2(Math.min(ex, Number(eff.gain)) * 12.5 / 100), proposed_actions: [{ kind: "defer_sale_to_fy", target_type: "holding", target_id: a.target_id, params: { quantity: a.params?.quantity, fy: `${Number(fy.slice(0, 4)) + 1}-${String(Number(fy.slice(0, 4)) + 2).slice(-2)}` }, planned_date: `${Number(fy.slice(0, 4)) + 1}-04-05` }] });
    }
  }
  // upsert: dismissed ones stay dismissed for the FY; new ones replace old 'new' rows of the same code/entity
  let written = 0;
  for (const d of drafts) {
    const r = await c.query(`insert into tax_suggestions (family_id, scenario_id, entity_id, code, title, rationale, est_saving, fy, proposed_actions) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
        on conflict (family_id, coalesce(scenario_id,'00000000-0000-0000-0000-000000000000'::uuid), coalesce(entity_id,'00000000-0000-0000-0000-000000000000'::uuid), code, coalesce(fy,''))
        do update set title = excluded.title, rationale = excluded.rationale, est_saving = excluded.est_saving, proposed_actions = excluded.proposed_actions where tax_suggestions.status = 'new' returning id`,
      [familyId, opts.scenarioId ?? null, d.entity_id, d.code, d.title, d.rationale, d.est_saving, fy, JSON.stringify(d.proposed_actions)]);
    written += r.rowCount ?? 0;
  }
  // suggestions whose condition no longer holds are withdrawn
  const live = drafts.map((d) => `${d.entity_id ?? ""}|${d.code}`);
  const stale = (await c.query("select id, entity_id, code from tax_suggestions where status='new' and fy=$1 and coalesce(scenario_id::text,'') = coalesce($2::text,'')", [fy, opts.scenarioId ?? null])).rows.filter((s) => !live.includes(`${s.entity_id ?? ""}|${s.code}`));
  for (const s of stale) await c.query("delete from tax_suggestions where id=$1", [s.id]);
  return { rows: written, drafts: drafts.length, withdrawn: stale.length, total_saving: r2(drafts.reduce((s, d) => s + d.est_saving, 0)), note: `${drafts.length} suggestions, ₹${Math.round(drafts.reduce((s, d) => s + d.est_saving, 0)).toLocaleString("en-IN")} identified` };
}
export async function runOptimiserAll(today?: string) {
  let n = 0;
  for (const f of (await pool.query("select id from families")).rows) await withFamilyClient(f.id, async (c) => { n += (await runOptimiser(c, f.id, { today })).drafts; });
  return { rows: n, note: `${n} suggestions across families` };
}

/** plan.match_actuals: after an import, match new transactions to planned actions of executing scenarios
 *  (instrument, entity, quantity ±2%, date ±10 days); price ±5% or date ±15 days beyond tolerance re-simulates and raises a task. */
export async function matchActuals(c: pg.PoolClient, familyId: string, opts: { since?: string } = {}) {
  const pending = (await c.query(`select a.*, p.name scenario_name, h.instrument_id, h.entity_id holding_entity from plan_actions a join plan_scenarios p on p.id=a.scenario_id
      left join holdings h on h.id=a.target_id where p.status='executing' and p.deleted_at is null and a.status in ('planned','in_progress') and a.kind in ('sell_holding','harvest_loss','book_gain_within_exemption','defer_sale_to_fy','redeem_before_date','buy_instrument','switch','deploy_cash')`)).rows;
  let matched = 0, flagged = 0;
  for (const a of pending) {
    const instrument = a.instrument_id ?? a.params?.instrument_id; if (!instrument) continue;
    const sellKinds = ["sell_holding", "harvest_loss", "book_gain_within_exemption", "defer_sale_to_fy", "redeem_before_date"];
    const types = sellKinds.includes(a.kind) ? ["sell", "redemption", "switch_out"] : ["buy", "sip", "switch_in"];
    const qty = Number(a.params?.quantity ?? 0);
    const txn = (await c.query(`select t.* from investment_txns t where t.instrument_id=$1 and t.entity_id = coalesce($2, t.entity_id) and t.type = any($3) and t.txn_date between $4::date - 10 and $4::date + 10
        and ($5::numeric = 0 or abs(t.quantity - $5::numeric) <= greatest(0.0001, $5::numeric * 0.02)) and ($6::timestamptz is null or t.created_at >= $6::timestamptz) and not exists (select 1 from plan_actions x where x.actual_ref_id = t.id) order by abs(t.txn_date - $4::date) limit 1`,
      [instrument, a.entity_id ?? a.holding_entity ?? null, types, iso(a.planned_date), qty, opts.since ?? null])).rows[0];
    if (!txn) continue;
    const plannedAmt = Number(a.planned_amount ?? 0); const actualAmt = Number(txn.amount);
    const days = Math.round((Date.parse(iso(txn.txn_date)!) - Date.parse(iso(a.planned_date)!)) / 86400000);
    const pricePct = a.params?.price ? Math.abs(Number(txn.price) - Number(a.params.price)) / Number(a.params.price) * 100 : plannedAmt ? Math.abs(actualAmt - plannedAmt) / plannedAmt * 100 : 0;
    const breach = pricePct > 5 || Math.abs(days) > 15;
    let taxDelta: number | null = null;
    if (breach) {
      const before = Number(a.simulated_effect?.tax ?? 0);
      await c.query("update plan_actions set params = params || $2 where id=$1", [a.id, JSON.stringify({ price: Number(txn.price) })]);
      try { const re = await runScenario(c, familyId, a.scenario_id); taxDelta = r2(Number(re.action_effects[a.id]?.tax ?? 0) - before); } catch { taxDelta = null; }
      const t = await c.query("insert into tasks (family_id, entity_id, module, title, reason, amount, due_date, severity, source_type, source_id) select $1,$2,'planning',$3,$4,$5,current_date,2,'plan_variance',$6 where not exists (select 1 from tasks where source_type='plan_variance' and source_id=$6 and status='open') returning id",
        [familyId, a.entity_id ?? txn.entity_id, `Plan variance: ${a.scenario_name}`, `${a.kind} executed ${Math.abs(days)} d ${days > 0 ? "late" : "early"}${pricePct ? `, price ${pricePct.toFixed(1)}% off plan` : ""}${taxDelta != null ? `; tax effect changes by ₹${taxDelta.toLocaleString("en-IN")}` : ""}`, taxDelta, a.scenario_id]);
      flagged += t.rowCount ?? 0;
    }
    await c.query("update plan_actions set status='done', actual_date=$2, actual_amount=$3, actual_ref_type='investment_txn', actual_ref_id=$4, variance=$5 where id=$1", [a.id, iso(txn.txn_date), actualAmt, txn.id, JSON.stringify({ amount: r2(actualAmt - plannedAmt), days, price_pct: r2(pricePct), tax_delta: taxDelta, breach })]);
    if (a.task_id) await c.query("update tasks set status='done', done_at=now(), verification='verified' where id=$1 and status='open'", [a.task_id]);
    matched++;
    const left = Number((await c.query("select count(*) n from plan_actions where scenario_id=$1 and status in ('planned','in_progress')", [a.scenario_id])).rows[0].n);
    if (!left) await c.query("update plan_scenarios set status='completed' where id=$1 and status='executing'", [a.scenario_id]);
  }
  return { matched, flagged };
}
export { compareRegimes, consumeFifo };
