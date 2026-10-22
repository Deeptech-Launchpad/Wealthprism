import { bucketTargets, goalView } from "../lib/allocation.js";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireFamily, requireRole } from "../lib/auth.js";
import { netWorth } from "../lib/balance.js";
import { withFamily, money } from "../lib/db.js";
import { notifyTask } from "../lib/notify.js";
import { bucketDrift, requiredFloat, deployableExcess, xirr } from "@fo/finance";
import { activeDepositValues } from "../lib/depositvalue.js";

/** Holdings valued at latest price; PMS/AIF/private without a price row are valued at cost. */
const HOLDINGS_SQL = `
  select h.id, h.entity_id, e.name as entity_name, h.bucket, h.quantity, h.avg_cost, h.core_satellite,
         i.id as instrument_id, i.name as instrument, i.type, i.symbol, i.isin, i.asset_class,
         p.close as price, p.price_date,
         round(h.quantity * h.avg_cost, 2) as cost,
         round(h.quantity * coalesce(p.close, h.avg_cost), 2) as value
  from holdings h
  join entities e on e.id = h.entity_id
  join instruments i on i.id = h.instrument_id
  left join lateral (select close, price_date from prices where instrument_id = i.id order by price_date desc limit 1) p on true
  where 1=1`;

const monthsSince = (d: Date | string) => { const b = new Date(d), n = new Date(); return (n.getFullYear() - b.getFullYear()) * 12 + (n.getMonth() - b.getMonth()) - (n.getDate() < b.getDate() ? 1 : 0); };

export default async function routes(app: FastifyInstance) {
  app.addHook("preHandler", requireFamily);

  app.get("/holdings", async (req) => {
    const q = z.object({ entity_id: z.string().uuid().optional(), bucket: z.enum(["liquidity", "income", "growth"]).optional() }).parse(req.query);
    return withFamily(req.family!.familyId, async (c) => {
      const params: any[] = []; let sql = HOLDINGS_SQL;
      if (q.entity_id) { params.push(q.entity_id); sql += ` and h.entity_id = $${params.length}`; }
      if (q.bucket) { params.push(q.bucket); sql += ` and h.bucket = $${params.length}`; }
      const { rows } = await c.query(sql + " order by value desc", params);
      // XIRR since inception on the open lots: each remaining lot is an outflow on its buy date, today's value the inflow
      const lots = (await c.query("select holding_id, buy_date, remaining_qty, unit_cost, charges, quantity from lots where remaining_qty > 0")).rows;
      const xirrOf = (r: any) => { const ls = lots.filter((l) => l.holding_id === r.id); if (!ls.length || Number(r.value) <= 0) return null; try { const v = xirr([...ls.map((l) => ({ date: new Date(l.buy_date), amount: -(Number(l.remaining_qty) * Number(l.unit_cost) + Number(l.charges) * Number(l.remaining_qty) / Number(l.quantity)) })), { date: new Date(), amount: Number(r.value) }]); return Number.isFinite(v) ? +(v * 100).toFixed(2) : null; } catch { return null; } };
      const items = rows.map((r) => ({ ...r, cost: money(r.cost), value: money(r.value), unrealised_gain: money(Number(r.value) - Number(r.cost)), unrealised_gain_pct: Number(r.cost) ? +(((Number(r.value) - Number(r.cost)) / Number(r.cost)) * 100).toFixed(2) : 0, xirr_pct: xirrOf(r) }));
      const totals = { cost: money(items.reduce((s, i) => s + Number(i.cost), 0)), value: money(items.reduce((s, i) => s + Number(i.value), 0)) };
      return { items, totals, next_cursor: null };
    });
  });

  app.get("/holdings/:id/lots", async (req) => withFamily(req.family!.familyId, async (c) => {
    const { id } = req.params as { id: string };
    const { rows } = await c.query("select id, buy_date, quantity, remaining_qty, unit_cost, charges, grandfathered_fmv from lots where holding_id = $1 order by buy_date", [id]);
    return rows.map((l) => ({ ...l, term_now: monthsSince(l.buy_date) >= 12 ? "long" : "short" }));
  }));

  app.get("/bank-accounts", async (req) => withFamily(req.family!.familyId, async (c) => {
    const { rows } = await c.query(`select b.id, b.entity_id, e.name as entity_name, b.bank, b.account_masked, b.type, b.balance, b.balance_as_of, b.sync_mode, a.expires_on as consent_expires_on
      from bank_accounts b join entities e on e.id = b.entity_id left join aa_consents a on a.id = b.aa_consent_id where b.deleted_at is null order by b.bank`);
    return rows.map((r) => ({ ...r, balance: money(r.balance) }));
  }));

  app.get("/bank-txns", async (req) => {
    const q = z.object({ account_id: z.string().uuid().optional(), entity_id: z.string().uuid().optional(), category_id: z.string().uuid().optional(), q: z.string().max(80).optional(), from: z.string().optional(), to: z.string().optional(), kind: z.enum(["credit", "debit"]).optional(), uncategorised: z.string().optional(), include_transfers: z.string().optional(), limit: z.coerce.number().max(500).default(50), offset: z.coerce.number().min(0).default(0) }).parse(req.query);
    return withFamily(req.family!.familyId, async (c) => {
      const params: any[] = [q.limit, q.offset]; const conds: string[] = []; const add = (sql: string, v: any) => { params.push(v); conds.push(sql.replace("?", `$${params.length}`)); };
      if (q.account_id) add("t.bank_account_id = ?", q.account_id); if (q.entity_id) add("b.entity_id = ?", q.entity_id); if (q.category_id) add("t.category_id = ?", q.category_id);
      if (q.q) add("(t.narration ilike ? or t.counterparty ilike ?)".replace("?", `$${params.length + 1}`), `%${q.q}%`); if (q.from) add("t.txn_date >= ?", q.from); if (q.to) add("t.txn_date <= ?", q.to);
      if (q.kind === "credit") conds.push("t.amount > 0"); if (q.kind === "debit") conds.push("t.amount < 0");
      if (q.uncategorised === "1") conds.push("(t.category_id is null or cat.name in ('Household','Other income'))"); if (q.include_transfers !== "1") conds.push("not t.is_transfer");
      const where = conds.length ? ` where ${conds.join(" and ")}` : "";
      const { rows } = await c.query(`select t.id, t.bank_account_id, b.bank || ' ' || b.account_masked as account_label, b.entity_id, t.txn_date, t.narration, t.counterparty, t.amount, t.balance_after, cat.name as category, t.category_id, t.link_type, t.link_id, t.is_transfer, t.note, t.source, count(*) over() as total
        from bank_txns t join bank_accounts b on b.id = t.bank_account_id left join categories cat on cat.id = t.category_id ${where} order by t.txn_date desc, t.created_at desc limit $1 offset $2`, params);
      const total = rows[0] ? Number(rows[0].total) : 0;
      return { items: rows.map(({ total: _t, ...r }) => ({ ...r, amount: money(r.amount), balance_after: r.balance_after == null ? null : money(r.balance_after) })), total, next_cursor: q.offset + rows.length < total ? String(q.offset + rows.length) : null };
    });
  });

  app.get("/tasks", async (req) => {
    const q = z.object({ status: z.enum(["open", "done", "dismissed"]).default("open"), module: z.string().optional(), entity_id: z.string().uuid().optional() }).parse(req.query);
    return withFamily(req.family!.familyId, async (c) => {
      const params: any[] = [q.status]; let extra = "";
      if (q.module) { params.push(q.module); extra += ` and t.module = $${params.length}`; }
      if (q.entity_id) { params.push(q.entity_id); extra += ` and t.entity_id = $${params.length}`; }
      const { rows } = await c.query(`select t.*, e.name as entity_name, u.name as assignee_name from tasks t left join entities e on e.id = t.entity_id left join users u on u.id = t.assignee_user_id where t.status = $1 ${extra} order by t.severity, t.due_date nulls last, t.created_at desc`, params);
      return rows.map((r) => ({ ...r, amount: r.amount === null ? null : money(r.amount) }));
    });
  });

  /** Manual task (contract TaskInput); generated tasks come from jobs/tasks.ts. */
  app.post("/tasks", { preHandler: requireRole("owner", "member", "operator") }, async (req, reply) => {
    const b = z.object({ module: z.string().min(1), title: z.string().min(1), reason: z.string().optional(), entity_id: z.string().uuid().optional(), amount: z.union([z.number(), z.string()]).optional(), due_date: z.string().optional(), assignee_user_id: z.string().uuid().optional(), severity: z.number().int().min(1).max(3).default(2) }).parse(req.body);
    return withFamily(req.family!.familyId, async (c) => {
      const t = (await c.query("insert into tasks (family_id, entity_id, module, title, reason, amount, due_date, assignee_user_id, severity, created_by) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,'user') returning *", [req.family!.familyId, b.entity_id ?? null, b.module, b.title, b.reason ?? null, b.amount == null ? null : Number(b.amount), b.due_date ?? null, b.assignee_user_id ?? null, b.severity])).rows[0];
      await notifyTask(c, t);
      await c.query("insert into audit_log (family_id, user_id, action, table_name, row_id, after) values ($1,$2,'create','tasks',$3,$4)", [req.family!.familyId, req.user!.id, t.id, JSON.stringify(b)]);
      return void reply.code(201).send({ ...t, amount: t.amount === null ? null : money(t.amount) });
    });
  });

  app.patch("/tasks/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z.object({ status: z.enum(["open", "done", "dismissed"]).optional(), assignee_user_id: z.string().uuid().optional(), due_date: z.string().optional() }).parse(req.body);
    if (req.family!.role === "viewer") return void reply.code(403).send({ title: "Viewers cannot change tasks", status: 403 });
    return withFamily(req.family!.familyId, async (c) => {
      // a task closed by hand on a verifiable source (rent, tax, drawdown) stays "pending" until the matching import proves it
      const { rows } = await c.query(`update tasks set status = coalesce($2::task_status, status), assignee_user_id = coalesce($3::uuid, assignee_user_id), due_date = coalesce($4::date, due_date),
        done_at = case when $2 = 'done' then now() when $2 = 'open' then null else done_at end,
        verification = case when $2 = 'done' and source_type in ('rent_schedule','property_tax','committed_outflow') and verification in ('na','pending') then 'pending'::verification else verification end
        where id = $1 returning *`, [id, body.status ?? null, body.assignee_user_id ?? null, body.due_date ?? null]);
      if (!rows[0]) return void reply.code(404).send({ title: "Not found", status: 404 });
      await c.query("insert into audit_log (family_id, user_id, action, table_name, row_id, after) values ($1,$2,'update','tasks',$3,$4)", [req.family!.familyId, req.user!.id, id, JSON.stringify(body)]);
      return { ...rows[0], amount: rows[0].amount === null ? null : money(rows[0].amount) };
    });
  });

  /** Same linked-value / gap / monthly-required math as GET /goals/:id (goalView) — this used to be its own partial
   *  copy that never computed gap_at_target at all, which made every freshly created, wholly-unfunded goal show
   *  "fully funded" in the list (undefined > 0 is false in JS) even though the detail view got it right. */
  app.get("/goals", async (req) => withFamily(req.family!.familyId, async (c) => {
    const { rows } = await c.query("select g.*, e.name as entity_name from goals g left join entities e on e.id = g.entity_id order by g.target_year");
    const out = []; for (const g of rows) { const v = await goalView(c, req.family!.familyId, g); const yrs = Math.max(0, g.target_year - new Date().getFullYear()); out.push({ ...v, on_track: Number(v.funded_pct ?? 0) >= Math.min(100, 100 - yrs * 6) }); }
    return out;
  }));

  async function bucketValues(c: any, familyId: string) {
    const rows = (await c.query(HOLDINGS_SQL)).rows;
    const v: Record<string, number> = { liquidity: 0, income: 0, growth: 0 };
    for (const r of rows) v[r.bucket] += Number(r.value);
    v.income += Number((await c.query("select coalesce(sum((select value from property_valuations v where v.property_id = p.id order by valued_on desc limit 1)),0) as v from properties p where p.deleted_at is null and not p.self_occupied")).rows[0].v);
    v.growth += Number((await c.query("select coalesce(sum(coalesce((select value from private_marks m where m.private_investment_id = pi.id order by marked_on desc limit 1), pi.amount)),0) as v from private_investments pi where pi.status <> 'written_off'")).rows[0].v);
    v.liquidity += Number((await c.query("select coalesce(sum(balance),0) as v from bank_accounts where deleted_at is null and type <> 'card'")).rows[0].v);
    for (const d of await activeDepositValues(c, familyId)) v[d.bucket] += d.value;
    return v as { liquidity: number; income: number; growth: number };
  }

  app.get("/buckets/drift", async (req) => withFamily(req.family!.familyId, async (c) => {
    const v = await bucketValues(c, req.family!.familyId);
    const t = await bucketTargets(c, req.family!.familyId, null);
    return bucketDrift(v, { liquidity: +t.liquidity_pct, income: +t.income_pct, growth: +t.growth_pct, driftThresholdPp: +t.drift_threshold_pp }).map((s) => ({ ...s, value: money(s.value) }));
  }));

  app.get("/working-capital/summary", async (req) => withFamily(req.family!.familyId, async (c) => {
    const cash = Number((await c.query("select coalesce(sum(balance),0) v from bank_accounts where deleted_at is null and type in ('savings','current')")).rows[0].v);
    const outflows = (await c.query("select due_date, amount from committed_outflows where status = 'pending' and due_date >= current_date")).rows.map((r: any) => ({ dueDate: new Date(r.due_date).toISOString().slice(0, 10), amount: Number(r.amount) }));
    const s = (await c.query("select float_days, buffer_months, idle_days, instrument_prefs from wc_settings")).rows[0] ?? { float_days: 60, buffer_months: 1, idle_days: 30 };
    const avg = Number((await c.query("select coalesce(-sum(amount),0)/3 v from bank_txns where amount < 0 and txn_date > current_date - 90 and link_type <> 'transfer'")).rows[0].v);
    const input = { cash, outflows, floatDays: +s.float_days, avgMonthlyOutflow: avg, bufferMonths: +s.buffer_months, asOf: new Date().toISOString().slice(0, 10) };
    const rf = requiredFloat(input), ex = deployableExcess(input);
    return { cash_total: money(cash), required_float: money(rf), float_days: +s.float_days, deployable_excess: money(ex), idle_days: +s.idle_days, drag_per_year: money(ex * 0.045), inflation_pct: Number(s.instrument_prefs?.inflation_pct ?? 6), inflation_loss_per_year: money(ex * Number(s.instrument_prefs?.inflation_pct ?? 6) / 100), committed_outflows: outflows.length };
  }));

  app.get("/private-investments", async (req) => withFamily(req.family!.familyId, async (c) => {
    const { rows } = await c.query(`select pi.*, co.name as company, e.name as entity_name,
      (select value from private_marks m where m.private_investment_id = pi.id order by marked_on desc limit 1) as mark,
      (select total_commitment - drawn from fund_commitments f where f.private_investment_id = pi.id) as unfunded
      from private_investments pi join private_companies co on co.id = pi.company_id join entities e on e.id = pi.entity_id order by pi.invested_on`);
    return rows.map((r) => ({ ...r, amount: money(r.amount), mark: money(r.mark ?? r.amount), unfunded: money(r.unfunded), moic: Number(r.amount) ? +(Number(r.mark ?? r.amount) / Number(r.amount)).toFixed(2) : null }));
  }));

  app.get("/dashboard", async (req) => withFamily(req.family!.familyId, async (c) => {
    const holdings = (await c.query(HOLDINGS_SQL)).rows;
    const byEntity: Record<string, { name: string; value: number }> = {};
    for (const r of holdings) { byEntity[r.entity_id] ??= { name: r.entity_name, value: 0 }; byEntity[r.entity_id].value += Number(r.value); }
    const props = (await c.query("select (select value from property_valuations v where v.property_id = p.id order by valued_on desc limit 1) as value, (select entity_id from property_owners o where o.property_id = p.id limit 1) as entity_id from properties p where p.deleted_at is null")).rows;
    for (const p of props) if (byEntity[p.entity_id]) byEntity[p.entity_id].value += Number(p.value ?? 0);
    const priv = (await c.query("select entity_id, coalesce((select value from private_marks m where m.private_investment_id = pi.id order by marked_on desc limit 1), pi.amount) as value from private_investments pi where pi.status <> 'written_off'")).rows;
    for (const p of priv) if (byEntity[p.entity_id]) byEntity[p.entity_id].value += Number(p.value);
    const banks = (await c.query("select entity_id, sum(balance) v, count(*) n, count(*) filter (where sync_mode = 'aa') live from bank_accounts where deleted_at is null group by entity_id")).rows;
    for (const b of banks) if (byEntity[b.entity_id]) byEntity[b.entity_id].value += Number(b.v);
    // balance-sheet completeness (FO-90..92): lifestyle assets and policy values count, liabilities are deducted per entity
    const nw = await netWorth(c, req.family!.familyId); for (const e of nw.by_entity) { byEntity[e.entity_id] ??= { name: e.name, value: 0 }; byEntity[e.entity_id].value = Number(e.net_worth); }
    const netWorth_ = Number(nw.net_worth);
    const rent = (await c.query("select coalesce(sum(expected_rent),0) due, count(*) filter (where status='received') received, count(*) filter (where status='overdue') overdue from rent_schedule where period_month = date_trunc('month', current_date)::date")).rows[0];
    const gains = (await c.query("select coalesce(sum(gain),0) g from realized_gains where fy = '2026-27'")).rows[0];
    const attention = (await c.query("select t.*, e.name as entity_name from tasks t left join entities e on e.id = t.entity_id where t.status = 'open' order by t.severity, t.due_date nulls last limit 5")).rows;
    const v = await bucketValues(c, req.family!.familyId);
    const t = await bucketTargets(c, req.family!.familyId, null);
    // 12 month-end snapshots of the family's investment value (valuations.daily job) and the cached since-inception XIRR
    const snaps = (await c.query(`select distinct on (to_char(as_of,'YYYY-MM')) to_char(as_of,'YYYY-MM') as month, value from valuations_daily where scope_type='family' and scope_id=$1 and as_of >= (current_date - interval '13 months') order by to_char(as_of,'YYYY-MM'), as_of desc`, [req.family!.familyId])).rows;
    const trend = snaps.slice(-12).map((r) => ({ month: r.month, value: money(r.value) }));
    const prev = snaps.length >= 2 ? Number(snaps[snaps.length - 2].value) : null;
    const last = snaps.length ? Number(snaps[snaps.length - 1].value) : null;
    const xirrSi = (await c.query("select value from xirr_cache where scope_type='family' and scope_id=$1 and period='si'", [req.family!.familyId])).rows[0];
    return {
      net_worth: money(netWorth_), assets: nw.assets, liabilities: nw.liabilities,
      net_worth_mom_pct: prev && last ? +(((last - prev) / prev) * 100).toFixed(2) : null,
      xirr_si_pct: xirrSi ? Number(xirrSi.value) : null,
      trend,
      bank_balance_total: money(banks.reduce((s, b) => s + Number(b.v), 0)), bank_accounts_live: banks.reduce((s, b) => s + Number(b.live), 0), bank_accounts_total: banks.reduce((s, b) => s + Number(b.n), 0),
      rent: { due: money(rent.due), received_count: Number(rent.received), overdue_count: Number(rent.overdue) },
      capital_gains_ytd: money(gains.g),
      buckets: bucketDrift(v, { liquidity: +t.liquidity_pct, income: +t.income_pct, growth: +t.growth_pct, driftThresholdPp: +t.drift_threshold_pp }).map((s) => ({ ...s, value: money(s.value) })),
      by_entity: Object.entries(byEntity).map(([entity_id, e]) => ({ entity_id, name: e.name, net_worth: money(e.value) })),
      attention: attention.map((x) => ({ ...x, amount: x.amount === null ? null : money(x.amount) })),
    };
  }));
}
