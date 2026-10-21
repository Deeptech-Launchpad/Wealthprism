/** Planning glue: build a SimState from the family's tables, provide tax tables from the tax_* data, run the engine
 *  and persist results. Routes and jobs call these; the engine itself lives in @fo/finance. */
import type pg from "pg";
import { simulate, fyOf, type SimState, type SimAction, type Assumptions, type TablesProvider, type TaxTables, type SimResult, ENGINE_VERSION } from "@fo/finance";

export const DEFAULT_ASSUMPTIONS: Assumptions = { returns: { liquidity: 6.5, income: 8, growth: 12 }, inflation: 6 };
const iso = (d: any) => (d ? new Date(d).toISOString().slice(0, 10) : null);

/** Tax tables for (fy, regime, entity type) from the data tables; cached per call so a simulation loads each once. */
export async function tablesProvider(c: pg.PoolClient): Promise<{ tables: TablesProvider; cii: Record<string, number> }> {
  // one client → queries must run sequentially (pg serialises them anyway and warns)
  const slabs = await c.query("select fy, regime, entity_type, slab_from, slab_to, rate from tax_slabs");
  const sur = await c.query("select fy, regime, income_from, rate, capped_on_gains_pct from tax_surcharge");
  const ded = await c.query("select fy, regime, code, limit_amount from tax_deduction_limits");
  const params = await c.query("select fy, regime, code, value from tax_params");
  const rules = await c.query("select fy, asset_class, term, rate, taxed_at_slab, exemption_amount, holding_months_for_long from tax_rules");
  const cii = await c.query("select fy, index_value from cost_inflation_index");
  const cache = new Map<string, TaxTables>();
  const latestFy = [...new Set(slabs.rows.map((r) => r.fy))].sort().pop() as string;
  const tables: TablesProvider = (fy, regime, entityType) => {
    const key = `${fy}|${regime}|${entityType}`; const hit = cache.get(key); if (hit) return hit;
    const useFy = slabs.rows.some((r) => r.fy === fy) ? fy : latestFy; // horizon beyond the loaded Finance Act reuses the latest tables
    const t: TaxTables = {
      fy, regime, entityType,
      slabs: slabs.rows.filter((r) => r.fy === useFy && r.regime === regime && r.entity_type === entityType).map((r) => ({ from: Number(r.slab_from), to: r.slab_to == null ? null : Number(r.slab_to), rate: Number(r.rate) })),
      surcharge: sur.rows.filter((r) => r.fy === useFy && r.regime === regime).map((r) => ({ incomeFrom: Number(r.income_from), rate: Number(r.rate), cappedOnGainsPct: Number(r.capped_on_gains_pct ?? r.rate) })),
      deductionLimits: Object.fromEntries(ded.rows.filter((r) => r.fy === useFy && r.regime === regime).map((r) => [r.code, r.limit_amount == null ? null : Number(r.limit_amount)])),
      params: Object.fromEntries(params.rows.filter((r) => r.fy === useFy && r.regime === regime).map((r) => [r.code, Number(r.value)])),
      rules: rules.rows.filter((r) => r.fy === useFy).map((r) => ({ assetClass: r.asset_class, term: r.term, rate: Number(r.rate), taxedAtSlab: r.taxed_at_slab, exemptionAmount: Number(r.exemption_amount), holdingMonthsForLong: Number(r.holding_months_for_long) })),
    };
    cache.set(key, t); return t;
  };
  return { tables, cii: Object.fromEntries(cii.rows.map((r) => [r.fy, Number(r.index_value)])) };
}

/** Snapshot of everything the engine needs, inside the caller's family transaction. */
export async function loadState(c: pg.PoolClient, asOf = new Date().toISOString().slice(0, 10), entityScope?: string[] | null): Promise<SimState> {
  const fy = fyOf(asOf);
  const ents = (await c.query("select id, name, type, tax_regime from entities where deleted_at is null and ($1::uuid[] is null or id = any($1)) order by created_at, id", [entityScope ?? null])).rows;
  const ids = ents.map((e) => e.id);
  const holdings = (await c.query(`select h.id, h.entity_id, h.instrument_id, h.bucket, h.quantity, i.name, i.asset_class, i.type, coalesce((select close from prices p where p.instrument_id=i.id order by price_date desc limit 1), h.avg_cost) price,
      coalesce((select json_agg(json_build_object('id', l.id, 'buyDate', l.buy_date, 'quantity', l.quantity, 'remainingQty', l.remaining_qty, 'unitCost', l.unit_cost, 'charges', l.charges, 'fmv', l.grandfathered_fmv) order by l.buy_date) from lots l where l.holding_id=h.id and l.remaining_qty > 0), '[]') lots
      from holdings h join instruments i on i.id=h.instrument_id where h.entity_id = any($1) and h.quantity > 0`, [ids])).rows;
  const props = (await c.query(`select p.id, p.name, p.self_occupied, p.acquisition_date, p.acquisition_cost + p.stamp_duty + p.registration + coalesce((select sum(amount) from property_expenses x where x.property_id=p.id and x.capital_improvement),0) cost,
      coalesce((select value from property_valuations v where v.property_id=p.id order by valued_on desc limit 1), p.acquisition_cost) value,
      o.entity_id, o.ownership_pct,
      coalesce((select l.rent * 12 from leases l where l.property_id=p.id and l.status='active' order by l.end_date desc limit 1), 0) annual_rent,
      (select l.end_date from leases l where l.property_id=p.id and l.status='active' order by l.end_date desc limit 1) lease_end,
      coalesce((select sum(amount) from property_taxes x where x.property_id=p.id and x.period like $2 || '%'), 0) municipal_tax,
      coalesce((select sum(amount) from property_expenses x where x.property_id=p.id and x.category='loan_interest' and x.expense_date >= $3), 0)
        + coalesce((select sum(s.interest) from liability_schedule s join liabilities l on l.id=s.liability_id where l.secured_by_type='property' and l.secured_by_id=p.id and l.tax_section='24b' and l.status='active' and s.due_date between $3::date and ($3::date + interval '1 year' - interval '1 day')::date), 0) interest
      from properties p join property_owners o on o.property_id=p.id where p.deleted_at is null and o.entity_id = any($1)`, [ids, fy, `${fy.slice(0, 4)}-04-01`])).rows;
  // an operating business (the family firm) sits on the balance sheet with look-through, not in the investable portfolio the IPS and rebalancing govern
  const privates = (await c.query(`select pi.id, pi.entity_id, co.name, pi.amount cost, coalesce((select value from private_marks m where m.private_investment_id=pi.id order by marked_on desc limit 1), pi.amount) mark, pi.invested_on, pi.bucket
      from private_investments pi join private_companies co on co.id=pi.company_id where pi.status in ('active','unconverted') and pi.instrument <> 'operating_business' and pi.entity_id = any($1)`, [ids])).rows;
  const cash = (await c.query("select entity_id, coalesce(sum(balance),0) v from bank_accounts where deleted_at is null and type in ('savings','current') and entity_id = any($1) group by entity_id", [ids])).rows;
  const incomes = (await c.query("select entity_id, kind, annual_amount, growth_pct from entity_income_sources where entity_id = any($1) and (from_fy is null or from_fy <= $2) and (to_fy is null or to_fy >= $2)", [ids, fy])).rows;
  const deductions = (await c.query("select entity_id, fy, code, amount from entity_deductions where entity_id = any($1) and fy >= $2", [ids, fy])).rows;
  const advance = (await c.query("select entity_id, fy, paid_on, amount from advance_tax_payments where entity_id = any($1) and fy >= $2", [ids, fy])).rows;
  const tds = (await c.query("select entity_id, fy, coalesce(sum(tds_deducted),0) v from tds_26as where entity_id = any($1) and fy >= $2 group by entity_id, fy", [ids, fy])).rows;
  // fd/rd interest falling in this financial year is "income from other sources"; the TDS banks already cut from received interest is a credit against it
  const fyFrom = `${fy.slice(0, 4)}-04-01`, fyTo = `${Number(fy.slice(0, 4)) + 1}-03-31`;
  for (const d of (await c.query(`select d.entity_id,
        sum(case when r.kind='interest' and r.status <> 'cancelled' then r.expected_amount
                 when r.kind='foreclosure' then coalesce(nullif(r.received_amount, 0), r.expected_amount) + r.tds_component - coalesce(r.principal_component, 0)
                 when r.kind='maturity' and d.kind='fd' and d.payout_frequency='at_maturity' then r.expected_amount - d.principal
                 when r.kind='maturity' and d.kind='rd' then r.expected_amount - d.installment_amount * d.tenure_months else 0 end) interest,
        sum(case when r.kind='interest' and r.status='received' and d.tds_applicable then greatest(0, r.expected_amount - r.received_amount)
                 when r.kind='foreclosure' and r.status='received' then r.tds_component else 0 end) tds
      from deposit_receipts r join deposits d on d.id=r.deposit_id
      where d.entity_id = any($1) and d.status in ('active','closed','premature_closed') and r.due_date between $2::date and $3::date group by d.entity_id`, [ids, fyFrom, fyTo])).rows) {
    if (Number(d.interest) > 0) incomes.push({ entity_id: d.entity_id, kind: "interest", annual_amount: Number(d.interest), growth_pct: 0 });
    if (Number(d.tds) > 0) tds.push({ entity_id: d.entity_id, fy, v: Number(d.tds) });
  }
  const realised = (await c.query("select entity_id, fy, asset_class, term, gain, sell_date from realized_gains where entity_id = any($1) and fy = $2", [ids, fy])).rows;
  const goals = (await c.query(`select g.id, g.name, g.target_year, g.amount_today, g.inflation_pct, g.bucket,
      coalesce((select json_agg(l.holding_id) from goal_links l where l.goal_id=g.id and l.holding_id is not null), '[]') hids, coalesce((select json_agg(l.property_id) from goal_links l where l.goal_id=g.id and l.property_id is not null), '[]') pids, coalesce((select json_agg(l.private_investment_id) from goal_links l where l.goal_id=g.id and l.private_investment_id is not null), '[]') vids
      from goals g where g.status='active'`)).rows;
  const t = (await c.query("select liquidity_pct, income_pct, growth_pct, drift_threshold_pp from bucket_targets where entity_id is null order by effective_from desc limit 1")).rows[0] ?? { liquidity_pct: 8, income_pct: 32, growth_pct: 60, drift_threshold_pp: 1.5 };
  const commitments = (await c.query("select entity_id, due_date, amount, label from committed_outflows where status='pending' and due_date >= $1 and (entity_id is null or entity_id = any($2))", [asOf, ids])).rows;
  const liabilities = (await c.query("select entity_id, outstanding, rate_pct, tax_section from liabilities where status='active' and deleted_at is null and entity_id = any($1)", [ids])).rows;
  // holdings whose goal links use the holding's own goal_id column count too
  const goalHoldings = (await c.query("select id, goal_id from holdings where goal_id is not null and entity_id = any($1)", [ids])).rows;
  return {
    asOf,
    entities: ents.map((e) => ({ id: e.id, name: e.name, type: e.type, regime: e.tax_regime })),
    holdings: holdings.map((h) => ({ id: h.id, entityId: h.entity_id, instrumentId: h.instrument_id, name: h.name, assetClass: h.asset_class, bucket: h.bucket, price: Number(h.price), quantity: Number(h.quantity), fmv31Jan2018: h.lots.find((l: any) => l.fmv)?.fmv ? Number(h.lots.find((l: any) => l.fmv).fmv) : undefined,
      lots: (h.lots as any[]).map((l) => ({ id: l.id, buyDate: String(l.buyDate).slice(0, 10), quantity: Number(l.quantity), remainingQty: Number(l.remainingQty), unitCost: Number(l.unitCost), charges: Number(l.charges) })) })),
    properties: props.map((p) => ({ id: p.id, name: p.name, entityId: p.entity_id, ownershipPct: Number(p.ownership_pct), value: Number(p.value), cost: Number(p.cost), acquisitionDate: iso(p.acquisition_date) ?? "2000-04-01", annualRentGross: Number(p.annual_rent), rentEndDate: iso(p.lease_end), municipalTax: Number(p.municipal_tax), interest: Number(p.interest), selfOccupied: p.self_occupied })),
    privates: privates.map((p) => ({ id: p.id, entityId: p.entity_id, name: p.name, cost: Number(p.cost), mark: Number(p.mark), investedOn: iso(p.invested_on)!, bucket: p.bucket })),
    cash: Object.fromEntries(ents.map((e) => [e.id, Number(cash.find((x) => x.entity_id === e.id)?.v ?? 0)])),
    incomes: incomes.map((i) => ({ entityId: i.entity_id, kind: i.kind, annual: Number(i.annual_amount), growthPct: Number(i.growth_pct) })),
    deductions: deductions.map((d) => ({ entityId: d.entity_id, fy: d.fy, code: d.code, amount: Number(d.amount) })),
    advancePaid: advance.map((a) => ({ entityId: a.entity_id, fy: a.fy, date: iso(a.paid_on)!, amount: Number(a.amount) })),
    tds: tds.map((x) => ({ entityId: x.entity_id, fy: x.fy, amount: Number(x.v) })),
    realised: realised.map((r) => ({ entityId: r.entity_id, fy: r.fy, assetClass: r.asset_class, term: r.term, amount: Number(r.gain), sellDate: iso(r.sell_date)! })),
    goals: goals.map((g) => ({ id: g.id, name: g.name, targetYear: Number(g.target_year), amountToday: Number(g.amount_today), inflationPct: Number(g.inflation_pct), bucket: g.bucket, linkedHoldingIds: [...(g.hids as string[]), ...goalHoldings.filter((h) => h.goal_id === g.id).map((h) => h.id)], linkedPropertyIds: g.pids, linkedPrivateIds: g.vids })),
    targets: { liquidity: Number(t.liquidity_pct), income: Number(t.income_pct), growth: Number(t.growth_pct), driftThresholdPp: Number(t.drift_threshold_pp) },
    commitments: commitments.map((x) => ({ entityId: x.entity_id, date: iso(x.due_date)!, amount: Number(x.amount), label: x.label })),
    liabilities: (liabilities as any[]).map((l) => ({ entityId: l.entity_id, outstanding: Number(l.outstanding), ratePct: Number(l.rate_pct ?? 0), section: l.tax_section })),
  };
}

export const toSimAction = (a: any): SimAction => ({ id: a.id, seq: a.seq, kind: a.kind, entityId: a.entity_id, targetType: a.target_type, targetId: a.target_id, params: a.params ?? {}, plannedDate: iso(a.planned_date)!, plannedAmount: a.planned_amount == null ? null : Number(a.planned_amount) });

/** Simulate one scenario against the live state and store the result (and per-action effects). Baseline runs first so the deltas are filled. */
export async function runScenario(c: pg.PoolClient, familyId: string, scenarioId: string, opts: { assumptionsOverride?: Partial<Assumptions>; persist?: boolean } = { persist: true }): Promise<SimResult & { scenario_id: string; computed_at: string }> {
  const sc = (await c.query("select * from plan_scenarios where id=$1 and deleted_at is null", [scenarioId])).rows[0];
  if (!sc) throw new Error("scenario not found");
  const { tables, cii } = await tablesProvider(c);
  const asOf = iso(sc.base_date) && iso(sc.base_date)! > new Date().toISOString().slice(0, 10) ? iso(sc.base_date)! : new Date().toISOString().slice(0, 10);
  const state = await loadState(c, asOf, sc.entity_scope);
  const assumptions: Assumptions = { ...DEFAULT_ASSUMPTIONS, ...(sc.assumptions ?? {}), ...(opts.assumptionsOverride ?? {}), returns: { ...DEFAULT_ASSUMPTIONS.returns, ...(sc.assumptions?.returns ?? {}), ...(opts.assumptionsOverride?.returns ?? {}) } };
  const horizon = Number(sc.horizon_fys ?? 3);
  let baselineTax: number | undefined, baselineGoals: Record<string, number> | undefined;
  if (!sc.is_baseline) {
    const base = simulate(state, [], { ...assumptions, regime: undefined }, tables, { horizonFys: horizon, cii });
    baselineTax = base.summary.tax_total; baselineGoals = Object.fromEntries(base.goals_after.map((g) => [g.goal_id, g.funded_pct]));
  }
  const actions = (await c.query("select * from plan_actions where scenario_id=$1 order by seq", [scenarioId])).rows.map(toSimAction);
  const result = simulate(state, actions, assumptions, tables, { horizonFys: horizon, cii, baselineTax, baselineGoals });
  const computedAt = new Date().toISOString();
  if (opts.persist !== false) {
    await c.query("insert into plan_results (family_id, scenario_id, engine_version, summary, by_fy, allocation_after, goals_after, cash_ladder, warnings) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
      [familyId, scenarioId, ENGINE_VERSION, JSON.stringify(result.summary), JSON.stringify(result.by_fy), JSON.stringify(result.allocation_after), JSON.stringify(result.goals_after), JSON.stringify(result.cash_ladder), JSON.stringify(result.warnings)]);
    for (const [id, eff] of Object.entries(result.action_effects)) await c.query("update plan_actions set simulated_effect=$2 where id=$1", [id, JSON.stringify(eff)]);
    await c.query("update plan_scenarios set last_error=null where id=$1", [scenarioId]);
  }
  return { ...result, scenario_id: scenarioId, computed_at: computedAt };
}

/** The family's baseline scenario, created on first use. */
export async function ensureBaseline(c: pg.PoolClient, familyId: string, userId?: string | null) {
  const b = (await c.query("select * from plan_scenarios where is_baseline and deleted_at is null")).rows[0];
  if (b) return b;
  return (await c.query("insert into plan_scenarios (family_id, name, description, is_baseline, status, created_by, assumptions) values ($1,'Baseline (do nothing)','Auto-maintained from current holdings, leases and commitments',true,'approved',$2,$3) returning *", [familyId, userId ?? null, JSON.stringify(DEFAULT_ASSUMPTIONS)])).rows[0];
}
