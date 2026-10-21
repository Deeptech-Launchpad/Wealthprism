/** Market-data jobs: price feeds, benchmark closes, corporate actions, valuation snapshots, TWR cache, stale-price tasks.
 *  Fetching is injected (`fetchText`) so the ingest functions run on fixtures in tests and on the live feeds in the worker. */
import type pg from "pg";
import { pool } from "../lib/db.js";
import { parseAmfiNavAll, parseNseBhavcopy, parseNseCorporateActions, parseNseIndices, parseBhavcopy } from "@fo/parsers";
import { twr, xirr, xirrFlowsFor, type Valuation, type Flow } from "@fo/finance";
import { applyCorporateAction } from "../lib/corporateActions.js";
import { feedFetch, ingestNiftyTri, ingestBenchmarkSeries, benchmarkSeriesUrls, triRequest, runFxFeed } from "../lib/feeds.js";

export const FEEDS = {
  amfiNav: "https://www.amfiindia.com/spages/NAVAll.txt",
  nseBhavcopy: (d: string) => (process.env.NSE_BHAVCOPY_URL ?? "https://nsearchives.nseindia.com/content/cm/BhavCopy_NSE_CM_0_0_0_{yyyymmdd}_F_0000.csv.zip").replace("{yyyymmdd}", d.replace(/-/g, "")),
  nseIndices: "https://www.nseindia.com/api/allIndices",
  nseCorporateActions: "https://www.nseindia.com/api/corporates-corporateActions?index=equities",
  bseBhavcopy: (d: string) => (process.env.BSE_BHAVCOPY_URL ?? "https://www.bseindia.com/download/BhavCopy/Equity/BhavCopy_BSE_CM_0_0_0_{yyyymmdd}_F_0000.CSV").replace("{yyyymmdd}", d.replace(/-/g, "")),
};
/** Bucket scopes need a uuid; these three are fixed. */
export const BUCKET_SCOPE: Record<string, string> = {
  liquidity: "b0000000-0000-0000-0000-000000000001", income: "b0000000-0000-0000-0000-000000000002", growth: "b0000000-0000-0000-0000-000000000003",
};
export const BUCKET_BY_SCOPE = Object.fromEntries(Object.entries(BUCKET_SCOPE).map(([k, v]) => [v, k]));
const today = () => new Date().toISOString().slice(0, 10);

export async function recordRun<T extends { rows?: number; note?: string }>(job: string, fn: () => Promise<T>): Promise<T> {
  const id = (await pool.query("insert into feed_runs (job) values ($1) returning id", [job])).rows[0].id;
  try { const r = await fn(); await pool.query("update feed_runs set finished_at=now(), status='ok', rows=$2, note=$3 where id=$1", [id, r.rows ?? 0, r.note ?? null]); return r; }
  catch (e: any) { await pool.query("update feed_runs set finished_at=now(), status='failed', note=$2 where id=$1", [id, String(e.message ?? e).slice(0, 500)]); throw e; }
}

/** AMFI NAVAll: prices for every scheme we know; with `loadMaster` every scheme becomes an instrument (FO-20). */
export async function ingestAmfiNav(text: string, opts: { loadMaster?: boolean } = {}) {
  const parsed = parseAmfiNavAll(text);
  let priced = 0, created = 0;
  const c = await pool.connect();
  try {
    await c.query("begin");
    for (const r of parsed.rows) {
      let ins = (await c.query("select id from instruments where amfi_code=$1 or (isin is not null and isin=$2) limit 1", [r.amfiCode, r.isin ?? ""])).rows[0];
      if (!ins && opts.loadMaster) {
        ins = (await c.query("insert into instruments (type, isin, name, amfi_code, default_bucket, asset_class, meta) values ('mf',$1,$2,$3,$4,$5,$6) on conflict (amfi_code) do update set name = excluded.name returning id",
          [r.isin ?? null, r.name, r.amfiCode, r.assetClass === "equity" || r.assetClass === "intl_fund" ? "growth" : r.assetClass === "debt_mf_post_apr23" && /liquid|overnight|money market/i.test(r.category) ? "liquidity" : "income", r.assetClass, JSON.stringify({ amc: r.amc, category: r.category })])).rows[0];
        created++;
      }
      if (!ins) continue;
      await c.query("insert into prices (instrument_id, price_date, close, source) values ($1,$2,$3,'amfi') on conflict (instrument_id, price_date) do update set close = excluded.close", [ins.id, r.date, r.nav]);
      priced++;
    }
    await c.query("commit");
  } catch (e) { await c.query("rollback"); throw e; } finally { c.release(); }
  return { rows: priced, created, parsed: parsed.rows.length, errors: parsed.errors.length, note: `${priced} NAVs, ${created} schemes added` };
}

/** NSE bhavcopy: closes for known ISINs/symbols; with `loadMaster`, EQ/BE stocks and listed bonds become instruments. */
export async function ingestNseBhavcopy(text: string, opts: { loadMaster?: boolean; source?: string } = {}) {
  const parsed = parseBhavcopy(text); const source = opts.source ?? (parsed.provider === "bse_bhavcopy" ? "bse_bhavcopy" : "nse_bhavcopy");
  let priced = 0, created = 0;
  const c = await pool.connect();
  try {
    await c.query("begin");
    for (const r of parsed.rows) {
      if (r.kind === "other") continue;
      let ins = (await c.query("select id from instruments where (isin is not null and isin=$1) or (symbol=$2 and exchange='NSE') limit 1", [r.isin ?? "", r.symbol])).rows[0];
      if (!ins && opts.loadMaster && r.isin && r.kind !== "etf") {
        ins = (await c.query("insert into instruments (type, isin, symbol, name, exchange, default_bucket, asset_class) values ($1,$2,$3,$4,'NSE',$5,$6) on conflict (isin) do update set symbol = excluded.symbol returning id",
          [r.kind, r.isin, r.symbol, r.name ?? r.symbol, r.kind === "bond" ? "income" : "growth", r.kind === "bond" ? "listed_bond" : "equity"])).rows[0];
        created++;
      }
      if (!ins) continue;
      await c.query("insert into prices (instrument_id, price_date, close, source) values ($1,$2,$3,$4) on conflict (instrument_id, price_date) do update set close = excluded.close, source = excluded.source", [ins.id, r.date, r.close, source]);
      priced++;
    }
    await c.query("commit");
  } catch (e) { await c.query("rollback"); throw e; } finally { c.release(); }
  return { rows: priced, created, parsed: parsed.rows.length, source, note: `${priced} closes from ${source === "bse_bhavcopy" ? "BSE" : "NSE"}, ${created} instruments added` };
}

/** NSE index closes → benchmark_prices; the 60/40 blend is rebuilt from its components when both exist. */
export async function ingestNseIndices(json: any) {
  const parsed = parseNseIndices(json);
  let n = 0;
  for (const r of parsed.rows) {
    const b = (await pool.query("insert into benchmarks (code, name) values ($1,$2) on conflict (code) do update set name = benchmarks.name returning id", [r.code, r.name])).rows[0];
    await pool.query("insert into benchmark_prices (benchmark_id, price_date, value) values ($1,$2,$3) on conflict (benchmark_id, price_date) do update set value = excluded.value", [b.id, r.date, r.value]);
    n++;
  }
  await rebuildBlend();
  return { rows: n, note: parsed.rows.map((r) => `${r.code}=${r.value}`).join(" ") };
}
/** BLEND_6040 as an index: 60% Nifty 50 + 40% CRISIL CBI, both rebased to 100 at the first common date. */
async function rebuildBlend() {
  const rows = (await pool.query(`select n.price_date, n.value nifty, c.value cbi from benchmark_prices n join benchmarks bn on bn.id=n.benchmark_id and bn.code='NIFTY50'
     join benchmark_prices c on c.price_date=n.price_date join benchmarks bc on bc.id=c.benchmark_id and bc.code='CRISIL_CBI' order by n.price_date`)).rows;
  if (!rows.length) return;
  const blend = (await pool.query("select id from benchmarks where code='BLEND_6040'")).rows[0];
  const n0 = Number(rows[0].nifty), c0 = Number(rows[0].cbi);
  for (const r of rows) await pool.query("insert into benchmark_prices (benchmark_id, price_date, value) values ($1,$2,$3) on conflict (benchmark_id, price_date) do update set value = excluded.value", [blend.id, r.price_date, +(100 * (0.6 * Number(r.nifty) / n0 + 0.4 * Number(r.cbi) / c0)).toFixed(4)]);
}

/** NSE corporate-actions feed → corporate_actions (pending when it can be applied mechanically, review otherwise). */
export async function ingestCorporateActions(json: any) {
  const parsed = parseNseCorporateActions(json);
  let n = 0;
  for (const r of parsed.rows) {
    const ins = (await pool.query("select id from instruments where (isin is not null and isin=$1) or (symbol=$2 and exchange='NSE') limit 1", [r.isin ?? "", r.symbol])).rows[0];
    if (!ins) continue;
    await pool.query(`insert into corporate_actions (instrument_id, type, ex_date, record_date, ratio_num, ratio_den, cash_per_unit, status, source, subject, face_value_from, face_value_to, auto_apply)
        values ($1,$2,$3,$4,$5,$6,$7,$8,'nse',$9,$10,$11,$12)
        on conflict (instrument_id, type, ex_date) do update set record_date = excluded.record_date, ratio_num = coalesce(corporate_actions.ratio_num, excluded.ratio_num), ratio_den = coalesce(corporate_actions.ratio_den, excluded.ratio_den), cash_per_unit = coalesce(corporate_actions.cash_per_unit, excluded.cash_per_unit), subject = excluded.subject`,
      [ins.id, r.type, r.exDate, r.recordDate ?? null, r.ratioNum ?? null, r.ratioDen ?? null, r.cashPerUnit ?? null, r.autoApply ? "pending" : "review", r.subject, r.faceValueFrom ?? null, r.faceValueTo ?? null, r.autoApply]);
    n++;
  }
  return { rows: n, note: `${n} of ${parsed.rows.length} actions concern known instruments` };
}

async function families(): Promise<string[]> { return (await pool.query("select id from families order by created_at")).rows.map((r) => r.id); }
export async function withFamilyClient<T>(familyId: string, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try { await c.query("begin"); await c.query("select set_config('app.family_id',$1,true)", [familyId]); const r = await fn(c); await c.query("commit"); return r; }
  catch (e) { await c.query("rollback"); throw e; } finally { c.release(); }
}

/** Auto-apply bonus / split / dividend actions whose ex-date has passed, for every family holding the instrument.
 *  Matches 'pending' (not yet auto-applied anywhere) AND 'applied' (confirmed real, already applied to at least
 *  one family) — not just 'pending' — because corporate_actions has no family scoping: once any family's holding
 *  triggers the apply, the row's status moves on, but a family added later (self-signup, a late CAS import) can
 *  still be newly eligible. Safe to re-sweep 'applied' rows: applyCorporateAction() only touches a holding that
 *  has no corporate_action_applications row yet, so an already-applied holding is never touched twice. Only
 *  'review' is excluded — those are missing data (e.g. no ratio) and genuinely cannot be applied mechanically. */
export async function autoApplyCorporateActions(asOf = today()) {
  const cas = (await pool.query("select * from corporate_actions where status in ('pending','applied') and auto_apply and ex_date <= $1 and type in ('bonus','split','dividend')", [asOf])).rows;
  let applied = 0;
  for (const fam of await families()) {
    await withFamilyClient(fam, async (c) => {
      for (const ca of cas) {
        try { applied += (await applyCorporateAction(c, fam, ca, null)).length; }
        catch (e: any) { await c.query("insert into tasks (family_id, module, title, reason, severity, source_type, source_id) select $1,'investments',$2,$3,2,'corporate_action',$4 where not exists (select 1 from tasks where source_type='corporate_action' and source_id=$4 and status='open')", [fam, `Corporate action needs review`, e.message, ca.id]); }
      }
    });
  }
  return { rows: applied, note: `${applied} holdings adjusted from ${cas.length} actions` };
}

/** Holding quantity and value as of a date: today from the holding row, history rebuilt from lots and realised sales. */
const HOLDINGS_ASOF = `
  select h.id, h.entity_id, h.bucket, h.goal_id, h.instrument_id, h.quantity as quantity_now, h.avg_cost,
         (select count(*) from lots l where l.holding_id=h.id) as lot_count,
         coalesce((select sum(l.quantity) from lots l where l.holding_id=h.id and l.buy_date <= $1),0)
           - coalesce((select sum(g.quantity) from realized_gains g join lots l2 on l2.id=g.lot_id where l2.holding_id=h.id and g.sell_date <= $1),0) as quantity_asof,
         (select close from prices p where p.instrument_id=h.instrument_id and p.price_date <= $1 order by p.price_date desc limit 1) as price
  from holdings h`;

/** Writes valuations_daily for every scope (asset, entity, bucket, family, goal) of every family for one date. */
export async function snapshotValuations(asOf = today(), familyIds?: string[]) {
  const fams = familyIds ?? (await families());
  const isToday = asOf >= today();
  let rows = 0;
  for (const fam of fams) {
    await withFamilyClient(fam, async (c) => {
      const hs = (await c.query(HOLDINGS_ASOF, [asOf])).rows;
      const flows = (await c.query(`select t.entity_id, t.instrument_id, t.account_id, t.type, t.amount from investment_txns t where t.txn_date = $1`, [asOf])).rows;
      const sign = (t: string) => (["buy", "sip", "switch_in", "rights", "capital_call"].includes(t) ? 1 : ["sell", "redemption", "switch_out", "buyback", "maturity", "dividend", "interest", "distribution"].includes(t) ? -1 : 0);
      const acc: Record<string, { scope_type: string; scope_id: string; value: number; net_flow: number }> = {};
      const add = (scope_type: string, scope_id: string | null, value: number, flow: number) => { if (!scope_id) return; const k = scope_type + scope_id; acc[k] ??= { scope_type, scope_id, value: 0, net_flow: 0 }; acc[k].value += value; acc[k].net_flow += flow; };
      for (const h of hs) {
        const qty = isToday || Number(h.lot_count) === 0 ? Number(h.quantity_now) : Math.max(0, Number(h.quantity_asof));
        const value = +(qty * Number(h.price ?? h.avg_cost)).toFixed(2);
        const flow = flows.filter((f) => f.entity_id === h.entity_id && f.instrument_id === h.instrument_id).reduce((s, f) => s + sign(f.type) * Number(f.amount), 0);
        add("asset", h.id, value, flow); add("entity", h.entity_id, value, flow); add("bucket", BUCKET_SCOPE[h.bucket], value, flow); add("family", fam, value, flow); add("goal", h.goal_id, value, flow);
      }
      if (!Object.keys(acc).length) add("family", fam, 0, 0);
      for (const v of Object.values(acc)) {
        await c.query("insert into valuations_daily (family_id, scope_type, scope_id, as_of, value, net_flow) values ($1,$2,$3,$4,$5,$6) on conflict (family_id, scope_type, scope_id, as_of) do update set value = excluded.value, net_flow = excluded.net_flow", [fam, v.scope_type, v.scope_id, asOf, +v.value.toFixed(2), +v.net_flow.toFixed(2)]);
        rows++;
      }
      if (isToday) await c.query("update holdings set last_valued_at = now()");
    });
  }
  return { rows, note: `${rows} scope values for ${asOf}` };
}

/** Month-end (or daily) snapshots between two dates, plus the end date itself. */
export async function backfillValuations(from: string, to = today(), step: "month" | "day" = "month", familyIds?: string[]) {
  const dates: string[] = [];
  const d = new Date(from + "T00:00:00Z");
  if (step === "month") { d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + 1); d.setUTCDate(0); }
  while (d.toISOString().slice(0, 10) <= to) {
    dates.push(d.toISOString().slice(0, 10));
    if (step === "month") { d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + 2); d.setUTCDate(0); } else d.setUTCDate(d.getUTCDate() + 1);
  }
  if (dates[dates.length - 1] !== to) dates.push(to);
  let rows = 0;
  for (const x of dates) rows += (await snapshotValuations(x, familyIds)).rows;
  return { rows, dates: dates.length, note: `${dates.length} snapshot dates from ${dates[0]} to ${to}` };
}

/** Raise (and auto-close) "price stale" tasks for held listed instruments without a close in the last few days. */
export async function stalePriceTasks(maxAgeDays = 4) {
  let raised = 0, closed = 0;
  for (const fam of await families()) {
    await withFamilyClient(fam, async (c) => {
      const stale = (await c.query(`select distinct i.id, i.name, max(p.price_date) last from holdings h join instruments i on i.id=h.instrument_id left join prices p on p.instrument_id=i.id
          where h.quantity > 0 and i.type in ('stock','etf','mf','bond','sgb') group by i.id, i.name having max(p.price_date) is null or max(p.price_date) < current_date - $1::int`, [maxAgeDays])).rows;
      for (const s of stale) {
        const r = await c.query(`insert into tasks (family_id, module, title, reason, due_date, severity, source_type, source_id)
            select $1,'investments',$2,$3,current_date,3,'instrument',$4 where not exists (select 1 from tasks where source_type='instrument' and source_id=$4 and status='open')`,
          [fam, `Price stale: ${s.name}`, s.last ? `Last close ${new Date(s.last).toISOString().slice(0, 10)}; the feed has not delivered a newer one` : "No price on file; valued at cost", s.id]);
        raised += r.rowCount ?? 0;
      }
      const fresh = await c.query(`update tasks t set status='done', done_at=now() where t.status='open' and t.source_type='instrument' and not exists (
          select 1 from holdings h join instruments i on i.id=h.instrument_id left join prices p on p.instrument_id=i.id where i.id=t.source_id and h.quantity > 0 group by i.id having max(p.price_date) is null or max(p.price_date) < current_date - $1::int)`, [maxAgeDays]);
      closed += fresh.rowCount ?? 0;
    });
  }
  return { rows: raised, closed, note: `${raised} raised, ${closed} closed` };
}

// ---------- performance ----------
export type Scope = { type: "asset" | "entity" | "bucket" | "family" | "goal"; id: string };
export async function scopeValuations(c: pg.PoolClient, s: Scope, from: string, to: string): Promise<Valuation[]> {
  const rows = (await c.query(`(select as_of, value from valuations_daily where scope_type=$1 and scope_id=$2 and as_of <= $3 order by as_of desc limit 1)
     union all (select as_of, value from valuations_daily where scope_type=$1 and scope_id=$2 and as_of > $3 and as_of <= $4) order by as_of`, [s.type, s.id, from, to])).rows;
  return rows.map((r) => ({ date: new Date(r.as_of).toISOString().slice(0, 10), value: Number(r.value) }));
}
/** External flows of a scope from investment_txns (signed: money in +, money out −). */
export async function scopeFlows(c: pg.PoolClient, s: Scope, from: string, to: string): Promise<Flow[]> {
  const where = s.type === "entity" ? "t.entity_id=$3" : s.type === "asset" ? "t.instrument_id=(select instrument_id from holdings where id=$3) and t.entity_id=(select entity_id from holdings where id=$3)"
    : s.type === "bucket" ? "exists (select 1 from holdings h where h.entity_id=t.entity_id and h.instrument_id=t.instrument_id and h.bucket=$3::bucket)"
    : s.type === "goal" ? "exists (select 1 from holdings h where h.entity_id=t.entity_id and h.instrument_id=t.instrument_id and h.goal_id=$3)" : "true";
  const param = s.type === "bucket" ? BUCKET_BY_SCOPE[s.id] : s.id;
  const rows = (await c.query(`select t.txn_date, sum(case when t.type in ('buy','sip','switch_in','rights','capital_call') then t.amount when t.type in ('sell','redemption','switch_out','buyback','maturity','dividend','interest','distribution') then -t.amount else 0 end) amt
      from investment_txns t where t.txn_date > $1 and t.txn_date <= $2 and ${where} group by t.txn_date order by t.txn_date`, s.type === "family" ? [from, to] : [from, to, param])).rows;
  return rows.map((r) => ({ date: new Date(r.txn_date).toISOString().slice(0, 10), amount: Number(r.amt) })).filter((f) => f.amount !== 0);
}
export async function benchmarkSeries(code: string, from: string, to: string) {
  const rows = (await pool.query("select p.price_date, p.value from benchmark_prices p join benchmarks b on b.id=p.benchmark_id where b.code=$1 and p.price_date >= $2 and p.price_date <= $3 order by p.price_date", [code, from, to])).rows;
  return rows.map((r) => ({ date: new Date(r.price_date).toISOString().slice(0, 10), value: Number(r.value) }));
}
export const periodStart = (period: string, to: string) => { const d = new Date(to + "T00:00:00Z"); const y = period === "1y" ? 1 : period === "3y" ? 3 : period === "5y" ? 5 : 0; if (!y) return "1900-01-01"; d.setUTCFullYear(d.getUTCFullYear() - y); return d.toISOString().slice(0, 10); };
export const defaultBenchmark = (s: Scope) => (s.type === "bucket" ? (BUCKET_BY_SCOPE[s.id] === "income" ? "CRISIL_CBI" : BUCKET_BY_SCOPE[s.id] === "liquidity" ? null : "NIFTY50") : "NIFTY50");

export async function performance(c: pg.PoolClient, s: Scope, from: string, to: string, benchmark?: string | null) {
  const vals = await scopeValuations(c, s, from, to);
  const flows = await scopeFlows(c, s, vals[0]?.date ?? from, to);
  const r = twr(vals, flows);
  // XIRR is an annualised figure: over a few weeks it explodes, so it is only reported for windows of a month or more
  let xirrPct: number | null = null;
  try { const f = xirrFlowsFor(vals, flows); if (f.length >= 2 && r.days >= 30) { const v = xirr(f) * 100; xirrPct = Number.isFinite(v) ? +Math.max(-99.99, Math.min(9999, v)).toFixed(2) : null; } } catch { xirrPct = null; }
  const code = benchmark === undefined ? defaultBenchmark(s) : benchmark;
  let benchmarkPct: number | null = null; let bench: { date: string; value: number }[] = [];
  if (code && vals.length >= 2) {
    bench = await benchmarkSeries(code, vals[0].date, vals[vals.length - 1].date);
    if (bench.length >= 2) { const total = bench[bench.length - 1].value / bench[0].value - 1; const ann = r.days >= 365 ? Math.pow(1 + total, 365 / r.days) - 1 : total; benchmarkPct = +(ann * 100).toFixed(2); }
  }
  const twrPct = +((r.annualised ?? r.total) * 100).toFixed(2);
  return { from: vals[0]?.date ?? from, to: vals[vals.length - 1]?.date ?? to, days: r.days, annualised: r.annualised != null, twr_pct: twrPct, twr_cumulative_pct: +(r.total * 100).toFixed(2), xirr_pct: xirrPct,
    benchmark: code, benchmark_pct: benchmarkPct, excess_pct: benchmarkPct == null ? null : +(twrPct - benchmarkPct).toFixed(2), valuations: vals, flows, benchmark_series: bench, sub_periods: r.subPeriods.length };
}

/** Nightly: cache TWR and XIRR for family / entity / bucket scopes over the standard periods. */
export async function refreshPerformanceCache(asOf = today()) {
  let n = 0;
  for (const fam of await families()) {
    await withFamilyClient(fam, async (c) => {
      const scopes: Scope[] = [{ type: "family", id: fam }, ...(await c.query("select id from entities where deleted_at is null")).rows.map((e) => ({ type: "entity" as const, id: e.id })), ...Object.values(BUCKET_SCOPE).map((id) => ({ type: "bucket" as const, id }))];
      for (const s of scopes) for (const period of ["1y", "3y", "5y", "si"] as const) {
        const p = await performance(c, s, periodStart(period, asOf), asOf);
        if (p.valuations.length < 2) continue;
        const bid = p.benchmark ? (await c.query("select id from benchmarks where code=$1", [p.benchmark])).rows[0]?.id : null;
        const clamp = (v: number | null) => (v == null ? null : Math.max(-9999, Math.min(9999, v))); // numeric(8,4) columns
        await c.query("insert into twr_cache (family_id, scope_type, scope_id, period, twr, benchmark_id, benchmark_return, computed_at) values ($1,$2,$3,$4,$5,$6,$7,now()) on conflict (family_id, scope_type, scope_id, period) do update set twr = excluded.twr, benchmark_id = excluded.benchmark_id, benchmark_return = excluded.benchmark_return, computed_at = now()", [fam, s.type, s.id, period, clamp(p.twr_pct), bid, clamp(p.benchmark_pct)]);
        if (p.xirr_pct != null) await c.query("insert into xirr_cache (family_id, scope_type, scope_id, period, value, computed_at) values ($1,$2,$3,$4,$5,now()) on conflict (family_id, scope_type, scope_id, period) do update set value = excluded.value, computed_at = now()", [fam, s.type, s.id, period, p.xirr_pct]);
        n++;
      }
    });
  }
  return { rows: n, note: `${n} scope×period rows` };
}

/** Live-feed runner used by the worker and CLI. `fetchText` is injectable for tests. */
export async function runFeeds(which: ("amfi" | "eod" | "indices" | "ca" | "tri" | "series" | "fx")[], fetchText: (url: string, init?: any) => Promise<string> = feedFetch, date = today()) {
  const out: Record<string, any> = {};
  if (which.includes("amfi")) out.amfi = await recordRun("amfi.nav", async () => ingestAmfiNav(await fetchText(FEEDS.amfiNav)));
  if (which.includes("eod")) out.eod = await recordRun("prices.eod", async () => {
    // NSE first; when the archive is late or refuses, the BSE file for the same day prices the ISINs both exchanges list
    let text: string; let source = "nse_bhavcopy"; try { text = await fetchText(FEEDS.nseBhavcopy(date)); } catch (e: any) { if (process.env.BSE_FALLBACK === "false") throw e; text = await fetchText(FEEDS.bseBhavcopy(date)); source = "bse_bhavcopy"; const r = await ingestNseBhavcopy(text, { source }); return { ...r, note: `${r.note} — NSE failed (${String(e.message).slice(0, 80)}), BSE fallback used` }; }
    return ingestNseBhavcopy(text, { source }); });
  if (which.includes("tri") && process.env.NIFTY_TRI_ENABLED !== "false") out.tri = await recordRun("benchmarks.tri", async () => { const all = { rows: 0, notes: [] as string[] }; for (const idx of (process.env.NIFTY_TRI_INDICES ?? "NIFTY 50,NIFTY 500").split(",").map((x) => x.trim()).filter(Boolean)) { const q = triRequest(idx, 10, new Date(date + "T00:00:00Z")); const r = await ingestNiftyTri(JSON.parse(await fetchText(q.url, { method: "POST", body: q.body, headers: { "content-type": "application/json; charset=UTF-8" } }))); all.rows += r.rows; all.notes.push(r.note); } return { rows: all.rows, note: all.notes.join("; ") }; });
  if (which.includes("fx") && process.env.FX_FEED_ENABLED !== "false") out.fx = await recordRun("fx.daily", () => runFxFeed(fetchText));
  if (which.includes("series") && benchmarkSeriesUrls().length) out.series = await recordRun("benchmarks.series", async () => { let rows = 0; const notes: string[] = []; for (const s of benchmarkSeriesUrls()) { const r = await ingestBenchmarkSeries(s.code, await fetchText(s.url)); rows += r.rows; notes.push(r.note); } return { rows, note: notes.join("; ") }; });
  if (which.includes("indices")) out.indices = await recordRun("benchmarks.eod", async () => ingestNseIndices(JSON.parse(await fetchText(FEEDS.nseIndices))));
  if (which.includes("ca")) out.ca = await recordRun("corporate_actions.fetch", async () => { const r = await ingestCorporateActions(JSON.parse(await fetchText(FEEDS.nseCorporateActions))); const a = await autoApplyCorporateActions(); return { ...r, note: `${r.note}; ${a.note}` }; });
  return out;
}
export { unzipSingle, feedFetch } from "../lib/feeds.js";
