import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireFamily, requireRole } from "../lib/auth.js";
import { withFamily, money } from "../lib/db.js";
import { divergenceNote } from "@fo/finance";
import { applyCorporateAction, describeEffect } from "../lib/corporateActions.js";
import { performance, periodStart, BUCKET_SCOPE, BUCKET_BY_SCOPE, runFeeds, type Scope } from "../jobs/market.js";
import { feedHealth } from "../lib/feeds.js";

const iso = (d: any) => (d ? new Date(d).toISOString().slice(0, 10) : null);
const INSTRUMENT_COLS = "i.id, i.type, i.isin, i.symbol, i.name, i.amfi_code, i.exchange, i.asset_class, i.default_bucket, i.meta";

export default async function routes(app: FastifyInstance) {
  app.addHook("preHandler", requireFamily);

  /** FO-21 ops: last run per feed job, stale holdings, latest price dates, benchmark coverage; owners can run a feed now. */
  app.get("/feeds/health", async (req) => withFamily(req.family!.familyId, (c) => feedHealth(c)));   // on the family client: pooled connections may carry an empty app.family_id, which RLS policies cannot cast
  app.post("/feeds/run", { preHandler: requireRole("owner", "member") }, async (req, reply) => { const b = z.object({ which: z.array(z.enum(["amfi", "eod", "indices", "ca", "tri", "series", "fx"])).min(1), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }).parse(req.body); try { return await runFeeds(b.which, undefined, b.date); } catch (e: any) { return void reply.code(502).send({ title: e.message, status: 502 }); } });
  /** FO-20: name / symbol / ISIN / AMFI code search; exact identifiers first, then prefix, then substring. Held instruments carry a flag. */
  app.get("/instruments/search", async (req) => {
    const q = z.object({ q: z.string().min(2).max(80), type: z.string().optional(), limit: z.coerce.number().min(1).max(50).default(20) }).parse(req.query);
    return withFamily(req.family!.familyId, async (c) => {
      const term = q.q.trim();
      const rows = (await c.query(`select ${INSTRUMENT_COLS}, exists (select 1 from holdings h where h.instrument_id=i.id and h.quantity > 0) as held,
          (select close from prices p where p.instrument_id=i.id order by price_date desc limit 1) as last_price, (select price_date from prices p where p.instrument_id=i.id order by price_date desc limit 1) as price_date
        from instruments i where (upper(i.isin) = upper($1) or i.amfi_code = $1 or i.symbol ilike $2 or i.name ilike $3) ${q.type ? "and i.type = $5" : ""}
        order by (upper(i.isin) = upper($1) or i.amfi_code = $1) desc, (i.symbol ilike $1) desc, (i.name ilike $2) desc, exists (select 1 from holdings h where h.instrument_id=i.id) desc, length(i.name) limit $4`,
        q.type ? [term, term + "%", "%" + term + "%", q.limit, q.type] : [term, term + "%", "%" + term + "%", q.limit])).rows;
      return rows.map((r) => ({ ...r, last_price: r.last_price == null ? null : Number(r.last_price), price_date: iso(r.price_date), currency: "INR", country: "IN" }));
    });
  });

  /** FO-32: actions on instruments the family holds, with the family's own applied state. */
  app.get("/corporate-actions", async (req) => {
    const q = z.object({ status: z.enum(["pending", "applied", "review"]).optional() }).parse(req.query);
    return withFamily(req.family!.familyId, async (c) => {
      const rows = (await c.query(`select ca.*, ${INSTRUMENT_COLS.replace(/i\./g, "i.").split(", ").map((x) => x + " as instrument_" + x.split(".")[1]).join(", ")},
          (select count(*) from corporate_action_applications a where a.corporate_action_id=ca.id) as applied_holdings,
          (select max(a.applied_at) from corporate_action_applications a where a.corporate_action_id=ca.id) as applied_at,
          (select sum(h.quantity) from holdings h where h.instrument_id=ca.instrument_id) as quantity_held,
          ni.name as new_instrument_name
        from corporate_actions ca join instruments i on i.id=ca.instrument_id left join instruments ni on ni.id=ca.new_instrument_id
        where exists (select 1 from holdings h where h.instrument_id=ca.instrument_id) order by ca.ex_date desc`)).rows;
      const out = rows.map((r) => {
        const status = Number(r.applied_holdings) > 0 || r.status === "applied" ? "applied" : r.status;
        return { id: r.id, type: r.type, ex_date: iso(r.ex_date), record_date: iso(r.record_date), ratio: r.ratio_num != null && r.ratio_den != null ? `${Number(r.ratio_num)}:${Number(r.ratio_den)}` : null,
          cash_per_unit: r.cash_per_unit == null ? null : Number(r.cash_per_unit), cost_split_pct: r.cost_split_pct == null ? null : Number(r.cost_split_pct), subject: r.subject, source: r.source,
          effect: describeEffect(r), status, applied_at: r.applied_at, applied_holdings: Number(r.applied_holdings), quantity_held: Number(r.quantity_held ?? 0), auto_apply: r.auto_apply,
          new_instrument: r.new_instrument_id ? { id: r.new_instrument_id, name: r.new_instrument_name } : null,
          instrument: { id: r.instrument_id, type: r.instrument_type, isin: r.instrument_isin, symbol: r.instrument_symbol, name: r.instrument_name, amfi_code: r.instrument_amfi_code, asset_class: r.instrument_asset_class, default_bucket: r.instrument_default_bucket } };
      });
      return q.status ? out.filter((x) => x.status === q.status) : out;
    });
  });

  /** Apply a pending / reviewed action to this family's holdings; demergers and mergers take their parameters here. */
  app.post("/corporate-actions/:id/apply", { preHandler: requireRole("owner", "member") }, async (req, reply) => {
    const b = z.object({ cost_split_pct: z.number().min(0).max(100).optional(), new_instrument_id: z.string().uuid().optional(), ratio_num: z.number().positive().optional(), ratio_den: z.number().positive().optional() }).parse(req.body ?? {});
    return withFamily(req.family!.familyId, async (c) => {
      const ca = (await c.query("select * from corporate_actions where id=$1", [(req.params as any).id])).rows[0];
      if (!ca) return void reply.code(404).send({ title: "Not found", status: 404 });
      if (ca.status === "applied") return void reply.code(409).send({ title: "Already applied", status: 409 });
      let touched;
      try { touched = await applyCorporateAction(c, req.family!.familyId, ca, req.user!.id, b); }
      catch (e: any) { return void reply.code(422).send({ title: e.message, status: 422 }); }
      if (b.cost_split_pct != null || b.new_instrument_id || b.ratio_num) await c.query("update corporate_actions set cost_split_pct = coalesce($2, cost_split_pct), new_instrument_id = coalesce($3, new_instrument_id), ratio_num = coalesce($4, ratio_num), ratio_den = coalesce($5, ratio_den) where id=$1", [ca.id, b.cost_split_pct ?? null, b.new_instrument_id ?? null, b.ratio_num ?? null, b.ratio_den ?? null]);
      await c.query("insert into audit_log (family_id, user_id, action, table_name, row_id, after) values ($1,$2,'apply','corporate_actions',$3,$4)", [req.family!.familyId, req.user!.id, ca.id, JSON.stringify({ holdings: touched })]);
      return { id: ca.id, status: "applied", holdings: touched };
    });
  });

  /** FO-95: TWR (Modified Dietz, linked) and XIRR for a scope and period, against a benchmark, with a divergence note. */
  app.get("/performance", async (req, reply) => {
    const q = z.object({ scope_type: z.enum(["asset", "entity", "bucket", "family", "goal"]), scope_id: z.string().optional(), period: z.enum(["1y", "3y", "5y", "si", "custom"]).default("si"),
      from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), benchmark: z.string().optional() }).parse(req.query);
    const fam = req.family!.familyId;
    const scopeId = q.scope_type === "family" ? fam : q.scope_type === "bucket" ? (BUCKET_SCOPE[q.scope_id ?? ""] ?? q.scope_id) : q.scope_id;
    if (!scopeId) return void reply.code(422).send({ title: "scope_id is required for this scope", status: 422 });
    const to = q.to ?? new Date().toISOString().slice(0, 10);
    const from = q.period === "custom" ? (q.from ?? periodStart("1y", to)) : periodStart(q.period, to);
    return withFamily(fam, async (c) => {
      const s: Scope = { type: q.scope_type, id: scopeId };
      const p = await performance(c, s, from, to, q.benchmark === "none" ? null : q.benchmark);
      const label = q.scope_type === "bucket" ? BUCKET_BY_SCOPE[scopeId] : q.scope_type === "entity" ? (await c.query("select name from entities where id=$1", [scopeId])).rows[0]?.name : q.scope_type === "asset" ? (await c.query("select i.name from holdings h join instruments i on i.id=h.instrument_id where h.id=$1", [scopeId])).rows[0]?.name : q.scope_type === "goal" ? (await c.query("select name from goals where id=$1", [scopeId])).rows[0]?.name : "Family";
      // month-end series for charts, benchmark rebased to the opening value
      const monthEnds = new Map<string, number>(); for (const v of p.valuations) monthEnds.set(v.date.slice(0, 7), v.value);
      const b0 = p.benchmark_series[0]?.value; const benchAt = (d: string) => { const x = [...p.benchmark_series].reverse().find((b) => b.date <= d); return x && b0 ? +((x.value / b0) * (p.valuations[0]?.value ?? 0)).toFixed(2) : null; };
      const series = [...monthEnds.entries()].map(([m, v]) => { const d = p.valuations.filter((x) => x.date.startsWith(m)).pop()!.date; return { date: d, value: money(v), benchmark: benchAt(d) == null ? null : money(benchAt(d)) }; });
      return { scope_type: q.scope_type, scope_id: scopeId, scope_label: label, period: q.period, from: p.from, to: p.to, days: p.days, annualised: p.annualised,
        twr_pct: p.twr_pct, twr_cumulative_pct: p.twr_cumulative_pct, xirr_pct: p.xirr_pct, benchmark: p.benchmark, benchmark_pct: p.benchmark_pct, excess_pct: p.excess_pct,
        divergence_note: p.xirr_pct == null ? null : divergenceNote(p.twr_pct, p.xirr_pct, p.valuations, p.flows),
        opening_value: money(p.valuations[0]?.value ?? 0), closing_value: money(p.valuations[p.valuations.length - 1]?.value ?? 0), net_flow: money(p.flows.reduce((s, f) => s + f.amount, 0)),
        valuations: p.valuations.length, flows: p.flows.length, series };
    });
  });
}
