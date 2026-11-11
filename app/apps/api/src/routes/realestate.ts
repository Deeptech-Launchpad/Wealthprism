import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireFamily, requireRole } from "../lib/auth.js";
import { withFamily, money } from "../lib/db.js";
import { generateRentSchedule, gstSplit, fyOf, fyStart, propertyPnl } from "@fo/finance";
import { ensureGstReturns } from "../jobs/tasks.js";

// a pg DATE arrives as local midnight: read the local calendar day, so a machine east of UTC does not show it a day early
const iso = (d: any) => { if (!d) return null; if (typeof d === "string") return d.slice(0, 10); const x = new Date(d); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`; };
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const moneyIn = z.union([z.number(), z.string()]).transform((v) => Number(v));
const WRITERS = requireRole("owner", "member", "operator");

const PROPERTY_SQL = `
  select p.id, p.type, p.name, p.address, p.acquisition_date, p.acquisition_cost, p.stamp_duty, p.registration, p.self_occupied, p.bucket, p.status,
    p.area_value, p.area_unit, p.built_up_sqft, p.carpet_sqft, p.survey_no, p.patta_no, p.land_use, p.unit_no, p.registration_no, p.sub_registrar, p.boundaries,
    (select value from property_valuations v where v.property_id = p.id order by valued_on desc limit 1) as current_value,
    (select valued_on from property_valuations v where v.property_id = p.id order by valued_on desc limit 1) as valued_on,
    (select json_build_object('id', l.id, 'rent', l.rent, 'start_date', l.start_date, 'end_date', l.end_date, 'due_day', l.due_day, 'gst_applicable', l.gst_applicable, 'tds_applicable', l.tds_applicable, 'escalation_pct', l.escalation_pct, 'deposit', l.deposit, 'notice_days', l.notice_days, 'lease_kind', l.lease_kind, 'tenant', t.name, 'tenant_id', t.id, 'status', l.status)
       from leases l join tenants t on t.id = l.tenant_id where l.property_id = p.id and l.status = 'active' order by l.end_date desc limit 1) as active_lease,
    (select coalesce(sum(outstanding),0) from liabilities q where q.secured_by_type='property' and q.secured_by_id=p.id and q.deleted_at is null and q.status='active') as loan_outstanding,
    (select coalesce(sum(emi),0) from liabilities q where q.secured_by_type='property' and q.secured_by_id=p.id and q.deleted_at is null and q.status='active') as loan_emi,
    (select json_agg(json_build_object('entity_id', o.entity_id, 'name', e.name, 'ownership_pct', o.ownership_pct)) from property_owners o join entities e on e.id = o.entity_id where o.property_id = p.id) as owners
  from properties p where p.deleted_at is null`;

async function pnlFor(c: any, propertyId: string, today: string) {
  const from = fyStart(fyOf(today));
  const rent = Number((await c.query("select coalesce(sum(rs.received_amount),0) v from rent_schedule rs join leases l on l.id=rs.lease_id where l.property_id=$1 and rs.period_month >= $2", [propertyId, from])).rows[0].v);
  const tax = Number((await c.query("select coalesce(sum(amount),0) v from property_taxes where property_id=$1 and status='paid' and paid_on >= $2", [propertyId, from])).rows[0].v);
  const linked = "exists (select 1 from liabilities q where q.secured_by_type='property' and q.secured_by_id=$1 and q.deleted_at is null)";
  const exp = Number((await c.query(`select coalesce(sum(amount),0) v from property_expenses where property_id=$1 and not capital_improvement and expense_date >= $2 and not (category='loan_interest' and ${linked})`, [propertyId, from])).rows[0].v);
  // interest part of the EMIs actually paid this financial year, on loans linked to this property
  const interest = Number((await c.query("select coalesce(sum(s.interest),0) v from liability_schedule s join liabilities l on l.id=s.liability_id where l.secured_by_type='property' and l.secured_by_id=$1 and l.deleted_at is null and s.paid_on >= $2", [propertyId, from])).rows[0].v);
  const capex = Number((await c.query("select coalesce(sum(amount),0) v from property_expenses where property_id=$1 and capital_improvement", [propertyId])).rows[0].v);
  return { rent, tax, exp, capex, interest };
}
// square feet in one of each unit (1 cent = 435.6 sq ft, 1 ground = 2,400 sq ft, 1 acre = 43,560 sq ft)
const SQFT_PER: Record<string, number> = { sqft: 1, sqm: 10.7639, cent: 435.6, ground: 2400, acre: 43560, hectare: 107639.1 };
const DETAIL_TEXT = ["survey_no", "patta_no", "unit_no", "registration_no", "sub_registrar", "boundaries"] as const;
const DETAIL_NUM = ["area_value", "built_up_sqft", "carpet_sqft"] as const;
function shapeProperty(p: any, pnl?: { rent: number; tax: number; exp: number; capex: number; interest: number }) {
  const areaSqft = p.area_value && p.area_unit ? Number(p.area_value) * SQFT_PER[p.area_unit] : (p.built_up_sqft ? Number(p.built_up_sqft) : 0);
  const cost = Number(p.acquisition_cost);
  const loan = Number(p.loan_outstanding ?? 0), emi = Number(p.loan_emi ?? 0), monthlyRent = p.active_lease?.rent ? Number(p.active_lease.rent) : 0;
  const rent = p.active_lease?.rent ? Number(p.active_lease.rent) : 0;
  const value = Number(p.current_value ?? 0);
  const y = pnl ? propertyPnl({ rentReceived: pnl.rent, propertyTax: pnl.tax, expenses: pnl.exp + pnl.interest, currentValue: value, annualRent: rent * 12 }) : null;
  return { ...p, area_value: p.area_value == null ? null : Number(p.area_value), built_up_sqft: p.built_up_sqft == null ? null : Number(p.built_up_sqft), carpet_sqft: p.carpet_sqft == null ? null : Number(p.carpet_sqft),
    area_sqft: areaSqft ? Math.round(areaSqft * 100) / 100 : null, cost_per_sqft: areaSqft && cost ? Math.round(cost / areaSqft) : null,
    loan_outstanding: money(loan), loan_emi: money(emi), equity: money(Number(p.current_value ?? 0) - loan), monthly_cash_flow: money(monthlyRent - emi),
    current_value: money(p.current_value), acquisition_cost: money(p.acquisition_cost), stamp_duty: money(p.stamp_duty), registration: money(p.registration), valued_on: iso(p.valued_on), acquisition_date: iso(p.acquisition_date),
    gross_yield_pct: value ? +(((rent * 12) / value) * 100).toFixed(2) : null, net_yield_pct: y?.netYieldPct ?? null,
    ...(pnl ? { pnl_fytd: { rent: money(pnl.rent), property_tax: money(pnl.tax), expenses: money(pnl.exp), loan_interest: money(pnl.interest), net: money(y!.net) }, capital_improvements: money(pnl.capex), cost_of_acquisition: money(Number(p.acquisition_cost) + Number(p.stamp_duty) + Number(p.registration) + pnl.capex) } : {}) };
}
const propertyInput = z.object({ type: z.enum(["residential", "commercial", "land", "under_construction"]), name: z.string().min(1), address: z.record(z.any()).optional(), acquisition_date: date.optional().nullable(), acquisition_cost: moneyIn.optional(), stamp_duty: moneyIn.optional(), registration: moneyIn.optional(), self_occupied: z.boolean().optional(), bucket: z.enum(["liquidity", "income", "growth"]).optional(),
  area_value: z.number().positive().nullable().optional(), area_unit: z.enum(["sqft", "sqm", "cent", "ground", "acre", "hectare"]).nullable().optional(), built_up_sqft: z.number().positive().nullable().optional(), carpet_sqft: z.number().positive().nullable().optional(),
  land_use: z.enum(["agricultural", "residential_plot", "commercial_plot"]).nullable().optional(), survey_no: z.string().max(120).nullable().optional(), patta_no: z.string().max(120).nullable().optional(), unit_no: z.string().max(120).nullable().optional(), registration_no: z.string().max(120).nullable().optional(), sub_registrar: z.string().max(200).nullable().optional(), boundaries: z.string().max(1000).nullable().optional(),
  owners: z.array(z.object({ entity_id: z.string().uuid(), ownership_pct: z.number().positive().max(100) })).min(1).optional() });
const leaseInput = z.object({ lease_kind: z.enum(["rent", "lump_sum"]).default("rent"), property_id: z.string().uuid(), tenant_id: z.string().uuid(), entity_gstin_id: z.string().uuid().nullable().optional(), start_date: date, end_date: date, rent: moneyIn, due_day: z.number().int().min(1).max(28).default(5), grace_days: z.number().int().min(0).default(3), escalation_pct: z.number().min(0).default(0), escalation_every_months: z.number().int().positive().nullable().optional(), deposit: moneyIn.default(0), gst_applicable: z.boolean().default(false), gst_rate: z.number().optional(), tds_applicable: z.boolean().default(false), tds_rate: z.number().default(10), notice_days: z.number().int().default(90), document_id: z.string().uuid().optional() });

// writes only the detail fields that were sent (null clears one)
async function saveDetails(c: any, id: string, b: any) {
  const cols = [...DETAIL_NUM, ...DETAIL_TEXT, "area_unit", "land_use"].filter((k) => (b as any)[k] !== undefined);
  if (!cols.length) return;
  await c.query(`update properties set ${cols.map((k, i) => `${k}=$${i + 2}`).join(", ")} where id=$1`, [id, ...cols.map((k) => (b as any)[k] === "" ? null : (b as any)[k])]);
}

// A lump sum held for a tenant has to be handed back on the lease end date. It is listed as a committed outflow so Working capital keeps that money
// back instead of treating it as free cash to deploy, and it is marked done once the lease is ended.
export async function syncLeaseRefunds(c: any, familyId: string) {
  await c.query(`insert into committed_outflows (family_id, entity_id, kind, label, due_date, amount, source_type, source_id, status)
    select l.family_id, (select o.entity_id from property_owners o where o.property_id=l.property_id order by o.ownership_pct desc limit 1), 'manual', 'Return lump sum to ' || trim(t.name) || ' — ' || p.name, l.end_date, l.deposit, 'lease_refund', l.id, 'pending'
    from leases l join tenants t on t.id=l.tenant_id join properties p on p.id=l.property_id
    where l.family_id=$1 and l.lease_kind='lump_sum' and l.status='active' and l.deposit > 0 and p.deleted_at is null
      and not exists (select 1 from committed_outflows o where o.source_type='lease_refund' and o.source_id=l.id)`, [familyId]);
  await c.query(`update committed_outflows o set due_date=l.end_date, amount=l.deposit from leases l where o.source_type='lease_refund' and o.source_id=l.id and o.status='pending' and l.status='active' and (o.due_date <> l.end_date or o.amount <> l.deposit)`);
  await c.query(`update committed_outflows o set status='done' where o.family_id=$1 and o.source_type='lease_refund' and o.status='pending' and not exists (select 1 from leases l where l.id=o.source_id and l.status='active')`, [familyId]);
}

export default async function routes(app: FastifyInstance) {
  app.addHook("preHandler", requireFamily);
  const today = () => new Date().toISOString().slice(0, 10);

  // ---------- properties ----------
  app.get("/properties", async (req) => withFamily(req.family!.familyId, async (c) => {
    const q = z.object({ entity_id: z.string().uuid().optional() }).parse(req.query);
    const rows = (await c.query(PROPERTY_SQL + (q.entity_id ? " and exists (select 1 from property_owners o where o.property_id=p.id and o.entity_id=$1)" : "") + " order by current_value desc nulls last", q.entity_id ? [q.entity_id] : [])).rows;
    return rows.map((p) => shapeProperty(p));
  }));
  app.get("/properties/:id", async (req, reply) => withFamily(req.family!.familyId, async (c) => {
    const p = (await c.query(PROPERTY_SQL + " and p.id=$1", [(req.params as any).id])).rows[0];
    if (!p) return void reply.code(404).send({ title: "Not found", status: 404 });
    const valuations = (await c.query("select id, valued_on, value, source, note from property_valuations where property_id=$1 order by valued_on desc", [p.id])).rows.map((v) => ({ ...v, valued_on: iso(v.valued_on), value: money(v.value) }));
    const leases = (await c.query("select l.*, t.name tenant from leases l join tenants t on t.id=l.tenant_id where l.property_id=$1 order by l.start_date desc", [p.id])).rows.map((l) => ({ ...l, start_date: iso(l.start_date), end_date: iso(l.end_date), rent: money(l.rent), deposit: money(l.deposit), refunded_on: iso(l.refunded_on), refunded_amount: l.refunded_amount == null ? null : money(l.refunded_amount) }));
    const loans = (await c.query("select id, kind::text kind, lender, principal_original, outstanding, emi, emi_day, rate_pct, end_date, ltv_pct, (select json_build_object('id', s.id, 'due_date', s.due_date::text, 'amount', s.principal + s.interest) from liability_schedule s where s.liability_id=liabilities.id and s.paid_on is null order by s.due_date limit 1) next_instalment, (select max(s.due_date)::text from liability_schedule s where s.liability_id=liabilities.id) last_instalment, (select coalesce(json_agg(json_build_object('id', s.id, 'due_date', s.due_date::text, 'paid_on', s.paid_on::text, 'principal', s.principal, 'interest', s.interest) order by s.due_date), '[]'::json) from liability_schedule s where s.liability_id=liabilities.id and s.paid_on is not null) paid from liabilities where secured_by_type='property' and secured_by_id=$1 and deleted_at is null and status='active' order by created_at", [p.id])).rows.map((x) => ({ ...x, principal_original: money(x.principal_original), outstanding: money(x.outstanding), emi: x.emi == null ? null : money(x.emi), end_date: iso(x.end_date) }));
    const closed_loans = (await c.query("select l.id, l.kind::text kind, l.lender, l.principal_original, l.closed_on::text closed_on, l.closed_amount, (select count(*)::int from liability_schedule s where s.liability_id=l.id and s.paid_on is not null) emis_paid, (select coalesce(sum(s.interest),0) from liability_schedule s where s.liability_id=l.id and s.paid_on is not null) interest_paid from liabilities l where l.secured_by_type='property' and l.secured_by_id=$1 and l.deleted_at is null and l.status='closed' order by l.closed_on desc nulls last", [p.id])).rows.map((x) => ({ ...x, principal_original: money(x.principal_original), closed_amount: x.closed_amount == null ? null : money(x.closed_amount), interest_paid: money(x.interest_paid) }));
    return { ...shapeProperty(p, await pnlFor(c, p.id, today())), valuations, leases, loans, closed_loans };
  }));
  app.post("/properties", { preHandler: WRITERS }, async (req, reply) => {
    const b = propertyInput.parse(req.body);
    const owners = b.owners ?? [];
    if (owners.length && Math.abs(owners.reduce((s, o) => s + o.ownership_pct, 0) - 100) > 0.01) return void reply.code(422).send({ title: "Ownership must total 100%", status: 422 });
    if (b.area_value && !b.area_unit) return void reply.code(422).send({ title: "Choose the unit for the area (sq ft, cent, acre ...)", status: 422 });
    return withFamily(req.family!.familyId, async (c) => {
      const fam = req.family!.familyId;
      const p = (await c.query("insert into properties (family_id, type, name, address, acquisition_date, acquisition_cost, stamp_duty, registration, self_occupied, bucket) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning id", [fam, b.type, b.name, JSON.stringify(b.address ?? {}), b.acquisition_date ?? null, b.acquisition_cost ?? 0, b.stamp_duty ?? 0, b.registration ?? 0, b.self_occupied ?? false, b.bucket ?? "income"])).rows[0];
      const ownerRows = owners.length ? owners : [{ entity_id: (await c.query("select id from entities where deleted_at is null order by created_at, id limit 1")).rows[0].id, ownership_pct: 100 }];
      for (const o of ownerRows) await c.query("insert into property_owners (property_id, entity_id, ownership_pct) values ($1,$2,$3)", [p.id, o.entity_id, o.ownership_pct]);
      await saveDetails(c, p.id, b);
      // the purchase price is the first valuation, so a new property counts in the portfolio value straight away
      if (Number(b.acquisition_cost ?? 0) > 0) await c.query("insert into property_valuations (property_id, valued_on, value, source) values ($1,$2,$3,'acquisition')", [p.id, b.acquisition_date ?? today(), b.acquisition_cost]);
      await c.query("insert into audit_log (family_id, user_id, action, table_name, row_id, after) values ($1,$2,'create','properties',$3,$4)", [fam, req.user!.id, p.id, JSON.stringify(b)]);
      return void reply.code(201).send(shapeProperty((await c.query(PROPERTY_SQL + " and p.id=$1", [p.id])).rows[0]));
    });
  });
  app.patch("/properties/:id", { preHandler: WRITERS }, async (req, reply) => {
    const b = propertyInput.partial().parse(req.body);
    return withFamily(req.family!.familyId, async (c) => {
      const id = (req.params as any).id;
      const r = await c.query(`update properties set type=coalesce($2,type), name=coalesce($3,name), address=coalesce($4,address), acquisition_date=coalesce($5,acquisition_date), acquisition_cost=coalesce($6,acquisition_cost), stamp_duty=coalesce($7,stamp_duty), registration=coalesce($8,registration), self_occupied=coalesce($9,self_occupied), bucket=coalesce($10,bucket), updated_at=now() where id=$1 and deleted_at is null returning id`,
        [id, b.type ?? null, b.name ?? null, b.address ? JSON.stringify(b.address) : null, b.acquisition_date ?? null, b.acquisition_cost ?? null, b.stamp_duty ?? null, b.registration ?? null, b.self_occupied ?? null, b.bucket ?? null]);
      if (!r.rows[0]) return void reply.code(404).send({ title: "Not found", status: 404 });
      await saveDetails(c, id, b);
      if (b.owners) { if (Math.abs(b.owners.reduce((s, o) => s + o.ownership_pct, 0) - 100) > 0.01) return void reply.code(422).send({ title: "Ownership must total 100%", status: 422 }); await c.query("delete from property_owners where property_id=$1", [id]); for (const o of b.owners) await c.query("insert into property_owners (property_id, entity_id, ownership_pct) values ($1,$2,$3)", [id, o.entity_id, o.ownership_pct]); }
      await c.query("insert into audit_log (family_id, user_id, action, table_name, row_id, after) values ($1,$2,'update','properties',$3,$4)", [req.family!.familyId, req.user!.id, id, JSON.stringify(b)]);
      return shapeProperty((await c.query(PROPERTY_SQL + " and p.id=$1", [id])).rows[0]);
    });
  });
  app.delete("/properties/:id", { preHandler: WRITERS }, async (req, reply) => withFamily(req.family!.familyId, async (c) => {
    const id = (req.params as any).id;
    const p = (await c.query("select id, name from properties where id=$1 and deleted_at is null", [id])).rows[0];
    if (!p) return void reply.code(404).send({ title: "Not found", status: 404 });
    const lease = (await c.query("select 1 from leases where property_id=$1 and status='active' limit 1", [id])).rows[0];
    if (lease) return void reply.code(422).send({ title: "This property has an active lease. End or finish the lease before deleting it.", status: 422 });
    await c.query("update properties set deleted_at=now(), updated_at=now() where id=$1", [id]);
    await c.query("insert into audit_log (family_id, user_id, action, table_name, row_id, before) values ($1,$2,'delete','properties',$3,$4)", [req.family!.familyId, req.user!.id, id, JSON.stringify({ name: p.name })]);
    return void reply.code(204).send();
  }));
  app.post("/properties/:id/valuations", { preHandler: WRITERS }, async (req, reply) => {
    const b = z.object({ valued_on: date, value: moneyIn, source: z.string().optional(), note: z.string().optional() }).parse(req.body);
    return withFamily(req.family!.familyId, async (c) => {
      const p = (await c.query("select id from properties where id=$1 and deleted_at is null", [(req.params as any).id])).rows[0];
      if (!p) return void reply.code(404).send({ title: "Not found", status: 404 });
      const v = (await c.query("insert into property_valuations (property_id, valued_on, value, source, note) values ($1,$2,$3,$4,$5) returning *", [p.id, b.valued_on, b.value, b.source ?? "manual", b.note ?? null])).rows[0];
      return void reply.code(201).send({ ...v, valued_on: iso(v.valued_on), value: money(v.value) });
    });
  });

  app.get("/gstins", async (req) => withFamily(req.family!.familyId, async (c) => (await c.query("select g.id, g.gstin, g.state_code, g.registered_on, g.active, g.entity_id, e.name entity_name from entity_gstins g join entities e on e.id=g.entity_id where g.active order by e.name")).rows));

  // ---------- tenants & leases ----------
  app.get("/tenants", async (req) => withFamily(req.family!.familyId, async (c) => (await c.query("select id, name, pan_last4, gstin, state_code, phone, email, type from tenants order by name")).rows));
  app.post("/tenants", { preHandler: WRITERS }, async (req, reply) => {
    const b = z.object({ name: z.string().min(1), pan: z.string().optional(), gstin: z.string().regex(/^\d{2}[A-Z0-9]{13}$/).optional().nullable(), state_code: z.string().length(2).optional().nullable(), phone: z.string().optional(), email: z.string().email().optional(), type: z.enum(["individual", "company"]).default("individual") }).parse(req.body);
    return withFamily(req.family!.familyId, async (c) => {
      const t = (await c.query("insert into tenants (family_id, name, pan_last4, gstin, state_code, phone, email, type) values ($1,$2,$3,$4,$5,$6,$7,$8) returning id, name, pan_last4, gstin, state_code, phone, email, type", [req.family!.familyId, b.name, b.pan ? b.pan.slice(-4) : null, b.gstin ?? null, b.state_code ?? (b.gstin ? b.gstin.slice(0, 2) : null), b.phone ?? null, b.email ?? null, b.type])).rows[0];
      return void reply.code(201).send(t);
    });
  });
  const leaseView = (l: any) => ({ ...l, refunded_on: iso(l.refunded_on), refunded_amount: l.refunded_amount == null ? null : money(l.refunded_amount), start_date: iso(l.start_date), end_date: iso(l.end_date), rent: money(l.rent), deposit: money(l.deposit), tenant: { id: l.tenant_id, name: l.tenant_name, pan_last4: l.tenant_pan, gstin: l.tenant_gstin, state_code: l.tenant_state, type: l.tenant_type } });
  const LEASE_SQL = "select l.*, t.name tenant_name, t.pan_last4 tenant_pan, t.gstin tenant_gstin, t.state_code tenant_state, t.type tenant_type, p.name property from leases l join tenants t on t.id=l.tenant_id join properties p on p.id=l.property_id";
  app.get("/leases", async (req) => withFamily(req.family!.familyId, async (c) => {
    const q = z.object({ property_id: z.string().uuid().optional(), status: z.string().optional() }).parse(req.query);
    const rows = (await c.query(`${LEASE_SQL} where ($1::uuid is null or l.property_id=$1) and ($2::text is null or l.status=$2) order by l.end_date desc`, [q.property_id ?? null, q.status ?? null])).rows;
    return rows.map(leaseView);
  }));
  /** Creating a lease writes the whole rent schedule for the term; GST/TDS rates default from gst_settings and the lease. */
  app.post("/leases", { preHandler: WRITERS }, async (req, reply) => {
    const b = leaseInput.parse(req.body);
    if (b.end_date <= b.start_date) return void reply.code(422).send({ title: "end_date must be after start_date", status: 422 });
    if (b.lease_kind === "lump_sum" && !(b.deposit > 0)) return void reply.code(422).send({ title: "Enter the lump sum amount the tenant paid", status: 422 });
    if (b.lease_kind === "rent" && !(b.rent > 0)) return void reply.code(422).send({ title: "Enter the monthly rent", status: 422 });
    if (b.gst_applicable && !b.entity_gstin_id) return void reply.code(422).send({ title: "A GST-applicable lease needs the landlord's GSTIN (entity_gstin_id)", status: 422 });
    return withFamily(req.family!.familyId, async (c) => {
      const fam = req.family!.familyId;
      if (!(await c.query("select 1 from properties where id=$1 and deleted_at is null", [b.property_id])).rows[0]) return void reply.code(404).send({ title: "Property not found", status: 404 });
      const gstRate = b.gst_rate ?? Number((await c.query("select commercial_rent_rate from gst_settings where fy=$1", [fyOf(b.start_date)])).rows[0]?.commercial_rent_rate ?? 18);
      const l = (await c.query(`insert into leases (family_id, property_id, tenant_id, entity_gstin_id, start_date, end_date, rent, due_day, grace_days, escalation_pct, escalation_every_months, deposit, gst_applicable, gst_rate, tds_applicable, tds_rate, notice_days, document_id, lease_kind)
          values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) returning id`,
        [fam, b.property_id, b.tenant_id, b.entity_gstin_id ?? null, b.start_date, b.end_date, b.rent, b.due_day, b.grace_days, b.escalation_pct, b.escalation_every_months ?? null, b.deposit, b.gst_applicable, gstRate, b.tds_applicable, b.tds_rate, b.notice_days, b.document_id ?? null, b.lease_kind])).rows[0];
      // a pure lump-sum lease has no monthly rent, so there is no schedule to generate
      const rows = b.rent > 0 ? generateRentSchedule({ startDate: b.start_date, endDate: b.end_date, rent: b.rent, dueDay: b.due_day, escalationPct: b.escalation_pct, escalationEveryMonths: b.escalation_every_months ?? null, gstApplicable: b.gst_applicable, gstRate, tdsApplicable: b.tds_applicable, tdsRate: b.tds_rate }) : [];
      for (const r of rows) await c.query("insert into rent_schedule (family_id, lease_id, period_month, expected_rent, expected_gst, expected_tds, due_date, status) values ($1,$2,$3,$4,$5,$6,$7, case when $7::date < current_date then 'overdue'::rent_status else 'due'::rent_status end)", [fam, l.id, r.periodMonth, r.expectedRent, r.expectedGst, r.expectedTds, r.dueDate]);
      await syncLeaseRefunds(c, fam);
      await c.query("insert into audit_log (family_id, user_id, action, table_name, row_id, after) values ($1,$2,'create','leases',$3,$4)", [fam, req.user!.id, l.id, JSON.stringify({ ...b, schedule_rows: rows.length })]);
      return void reply.code(201).send({ ...leaseView((await c.query(`${LEASE_SQL} where l.id=$1`, [l.id])).rows[0]), schedule_rows: rows.length });
    });
  });
  /** Rent, dates and flags can change; future unpaid schedule rows are regenerated from the effective month. */
  app.patch("/leases/:id", { preHandler: WRITERS }, async (req, reply) => {
    const b = leaseInput.partial().extend({ status: z.enum(["active", "ended", "renewed"]).optional(), effective_from: date.optional() }).parse(req.body);
    return withFamily(req.family!.familyId, async (c) => {
      const id = (req.params as any).id; const fam = req.family!.familyId;
      const old = (await c.query("select * from leases where id=$1", [id])).rows[0];
      if (!old) return void reply.code(404).send({ title: "Not found", status: 404 });
      const n = { ...old, ...Object.fromEntries(Object.entries(b).filter(([, v]) => v !== undefined)) };
      await c.query(`update leases set tenant_id=$2, entity_gstin_id=$3, start_date=$4, end_date=$5, rent=$6, due_day=$7, grace_days=$8, escalation_pct=$9, escalation_every_months=$10, deposit=$11, gst_applicable=$12, gst_rate=$13, tds_applicable=$14, tds_rate=$15, notice_days=$16, status=$17 where id=$1`,
        [id, n.tenant_id, n.entity_gstin_id ?? null, n.start_date, n.end_date, n.rent, n.due_day, n.grace_days, n.escalation_pct, n.escalation_every_months ?? null, n.deposit, n.gst_applicable, n.gst_rate, n.tds_applicable, n.tds_rate, n.notice_days, n.status]);
      const termChanged = ["rent", "end_date", "start_date", "due_day", "escalation_pct", "escalation_every_months", "gst_applicable", "tds_applicable", "gst_rate", "tds_rate"].some((k) => (b as any)[k] !== undefined);
      let regenerated = 0;
      if (termChanged) {
        const from = b.effective_from ?? `${today().slice(0, 7)}-01`;
        await c.query("delete from rent_schedule where lease_id=$1 and period_month >= $2 and status in ('due','overdue')", [id, from]);
        const rows = generateRentSchedule({ startDate: iso(n.start_date)!, endDate: iso(n.end_date)!, rent: Number(n.rent), dueDay: n.due_day, escalationPct: Number(n.escalation_pct), escalationEveryMonths: n.escalation_every_months, gstApplicable: n.gst_applicable, gstRate: Number(n.gst_rate), tdsApplicable: n.tds_applicable, tdsRate: Number(n.tds_rate) }).filter((r) => r.periodMonth >= from);
        for (const r of rows) { const ins = await c.query("insert into rent_schedule (family_id, lease_id, period_month, expected_rent, expected_gst, expected_tds, due_date, status) values ($1,$2,$3,$4,$5,$6,$7, case when $7::date < current_date then 'overdue'::rent_status else 'due'::rent_status end) on conflict (lease_id, period_month) do nothing", [fam, id, r.periodMonth, r.expectedRent, r.expectedGst, r.expectedTds, r.dueDate]); regenerated += ins.rowCount ?? 0; }
      }
      if (b.status && b.status !== "active") await c.query("delete from rent_schedule where lease_id=$1 and status in ('due','overdue') and period_month > date_trunc('month', current_date)", [id]);
      await syncLeaseRefunds(c, fam);
      await c.query("insert into audit_log (family_id, user_id, action, table_name, row_id, after) values ($1,$2,'update','leases',$3,$4)", [fam, req.user!.id, id, JSON.stringify(b)]);
      return { ...leaseView((await c.query(`${LEASE_SQL} where l.id=$1`, [id])).rows[0]), regenerated };
    });
  });

  /** Ending a lease closes it, drops the unpaid future rent rows and records the refund of the deposit / lump sum. */
  app.post("/leases/:id/end", { preHandler: WRITERS }, async (req, reply) => {
    const b = z.object({ refunded_amount: moneyIn.optional(), refunded_on: date.optional() }).parse(req.body ?? {});
    return withFamily(req.family!.familyId, async (c) => {
      const id = (req.params as any).id;
      const l = (await c.query("select * from leases where id=$1", [id])).rows[0];
      if (!l) return void reply.code(404).send({ title: "Not found", status: 404 });
      if (l.status !== "active") return void reply.code(422).send({ title: "This lease has already ended", status: 422 });
      const owed = Number(l.deposit);
      const amount = b.refunded_amount ?? owed;
      if (amount < 0 || amount > owed + 0.005) return void reply.code(422).send({ title: `The refund cannot be more than the ${owed} held`, status: 422 });
      await c.query("update leases set status='ended', refunded_on=$2, refunded_amount=$3 where id=$1", [id, owed > 0 ? (b.refunded_on ?? today()) : null, owed > 0 ? amount : null]);
      await c.query("delete from rent_schedule where lease_id=$1 and status in ('due','overdue') and period_month > date_trunc('month', current_date)", [id]);
      await syncLeaseRefunds(c, req.family!.familyId);
      await c.query("insert into audit_log (family_id, user_id, action, table_name, row_id, after) values ($1,$2,'update','leases',$3,$4)", [req.family!.familyId, req.user!.id, id, JSON.stringify({ ended: true, ...b })]);
      return leaseView((await c.query(`${LEASE_SQL} where l.id=$1`, [id])).rows[0]);
    });
  });

  // ---------- rent ledger ----------
  const RENT_SQL = `select rs.id, rs.lease_id, p.id property_id, p.name as property, t.name as tenant, t.phone tenant_phone, t.email tenant_email, rs.period_month, rs.due_date, rs.expected_rent, rs.expected_gst, rs.expected_tds,
      rs.received_amount, rs.received_on, rs.bank_txn_id, rs.status, greatest(0, (current_date - rs.due_date)) as overdue_days, l.gst_applicable
      from rent_schedule rs join leases l on l.id = rs.lease_id join properties p on p.id = l.property_id join tenants t on t.id = l.tenant_id`;
  const rentView = (r: any) => ({ ...r, period_month: iso(r.period_month)?.slice(0, 7), due_date: iso(r.due_date), received_on: iso(r.received_on), expected_rent: money(r.expected_rent), expected_gst: money(r.expected_gst), expected_tds: money(r.expected_tds), received_amount: money(r.received_amount), net_due: money(Number(r.expected_rent) + Number(r.expected_gst) - Number(r.expected_tds)), overdue_days: Number(r.overdue_days) });
  app.get("/rent-schedule", async (req) => withFamily(req.family!.familyId, async (c) => {
    const q = z.object({ month: z.string().regex(/^\d{4}-\d{2}$/), entity_id: z.string().uuid().optional(), status: z.string().optional(), lease_id: z.string().uuid().optional() }).parse(req.query);
    const rows = (await c.query(`${RENT_SQL} where rs.period_month = ($1 || '-01')::date and ($2::text is null or rs.status::text = $2) and ($3::uuid is null or rs.lease_id=$3)
        and ($4::uuid is null or exists (select 1 from property_owners o where o.property_id=p.id and o.entity_id=$4)) order by rs.due_date`, [q.month, q.status ?? null, q.lease_id ?? null, q.entity_id ?? null])).rows;
    return rows.map(rentView);
  }));
  /** Record a receipt by hand or by pointing at a bank credit; partial amounts stay open. Closes the overdue task. */
  app.post("/rent-schedule/:id/receive", { preHandler: WRITERS }, async (req, reply) => {
    const b = z.object({ amount: moneyIn.optional(), received_on: date.optional(), bank_txn_id: z.string().uuid().optional(), waive: z.boolean().optional() }).parse(req.body ?? {});
    return withFamily(req.family!.familyId, async (c) => {
      const id = (req.params as any).id; const fam = req.family!.familyId;
      const row = (await c.query("select * from rent_schedule where id=$1", [id])).rows[0];
      if (!row) return void reply.code(404).send({ title: "Not found", status: 404 });
      let amount = b.amount, on = b.received_on ?? today();
      if (b.bank_txn_id) { const t = (await c.query("select amount, txn_date from bank_txns where id=$1", [b.bank_txn_id])).rows[0]; if (!t) return void reply.code(404).send({ title: "Bank transaction not found", status: 404 }); amount ??= Number(t.amount); on = b.received_on ?? iso(t.txn_date)!; await c.query("update bank_txns set link_type='rent', link_id=$2 where id=$1", [b.bank_txn_id, id]); }
      const total = Number(row.received_amount) + (amount ?? 0);
      const expectedNet = Number(row.expected_rent) + Number(row.expected_gst) - Number(row.expected_tds);
      const status = b.waive ? "waived" : total + 0.5 >= expectedNet || total + 0.5 >= Number(row.expected_rent) ? "received" : total > 0 ? "partial" : row.status;
      await c.query("update rent_schedule set received_amount=$2, received_on=$3, bank_txn_id=coalesce($4, bank_txn_id), status=$5 where id=$1", [id, total, on, b.bank_txn_id ?? null, status]);
      if (status === "received" || status === "waived") await c.query("update tasks set status='done', done_at=now(), verification = case when $3::boolean then 'verified' else verification end where family_id=$1 and status='open' and source_type='rent_schedule' and source_id=$2", [fam, id, !!b.bank_txn_id]);
      await c.query("insert into audit_log (family_id, user_id, action, table_name, row_id, after) values ($1,$2,'receive','rent_schedule',$3,$4)", [fam, req.user!.id, id, JSON.stringify({ ...b, status, total })]);
      return rentView((await c.query(`${RENT_SQL} where rs.id=$1`, [id])).rows[0]);
    });
  });
  /** Undo a receipt recorded by mistake: the rent goes back to due (or overdue if its due date has passed) and the amount received is cleared. */
  app.post("/rent-schedule/:id/revert", { preHandler: WRITERS }, async (req, reply) => {
    return withFamily(req.family!.familyId, async (c) => {
      const id = (req.params as any).id; const fam = req.family!.familyId;
      const row = (await c.query("select * from rent_schedule where id=$1", [id])).rows[0];
      if (!row) return void reply.code(404).send({ title: "Not found", status: 404 });
      if (!(["received", "partial", "waived"] as string[]).includes(row.status)) return void reply.code(409).send({ title: "Only a received, partly received or waived rent can be undone", status: 409 });
      const status = iso(row.due_date)! < today() ? "overdue" : "due";
      await c.query("update rent_schedule set received_amount=0, received_on=null, bank_txn_id=null, status=$2 where id=$1", [id, status]);
      await c.query("insert into audit_log (family_id, user_id, action, table_name, row_id, before, after) values ($1,$2,'revert','rent_schedule',$3,$4,$5)", [fam, req.user!.id, id, JSON.stringify({ status: row.status, received_amount: row.received_amount }), JSON.stringify({ status })]);
      return rentView((await c.query(`${RENT_SQL} where rs.id=$1`, [id])).rows[0]);
    });
  });
  /** One-tap reminder: queued for the channel adapter; the tenant's contact is taken from the tenant record. */
  app.post("/rent-schedule/:id/remind", { preHandler: WRITERS }, async (req, reply) => {
    const b = z.object({ channel: z.enum(["email", "whatsapp", "sms"]).default("whatsapp"), template: z.string().default("rent_overdue"), message: z.string().max(1000).optional() }).parse(req.body ?? {});
    return withFamily(req.family!.familyId, async (c) => {
      const r = (await c.query(`${RENT_SQL} where rs.id=$1`, [(req.params as any).id])).rows[0];
      if (!r) return void reply.code(404).send({ title: "Not found", status: 404 });
      const to = b.channel === "email" ? r.tenant_email : r.tenant_phone;
      if (!to) return void reply.code(422).send({ title: `Tenant has no ${b.channel === "email" ? "e-mail" : "phone"} on file`, status: 422 });
      const net = Number(r.expected_rent) + Number(r.expected_gst) - Number(r.expected_tds);
      const message = b.message ?? `Dear ${r.tenant}, rent of ₹${net.toLocaleString("en-IN")} for ${r.property} (${new Date(r.period_month).toLocaleDateString("en-IN", { month: "long", year: "numeric" })}) was due on ${new Date(r.due_date).toLocaleDateString("en-IN")}. Kindly remit at the earliest. — Family Office`;
      const q = (await c.query("insert into rent_reminders (family_id, rent_schedule_id, channel, template, to_contact, message, queued_by) values ($1,$2,$3,$4,$5,$6,$7) returning id, status, queued_at", [req.family!.familyId, r.id, b.channel, b.template, to, message, req.user!.id])).rows[0];
      await c.query("update tasks set reason = coalesce(reason,'') || ' · reminder sent ' || to_char(now(),'DD Mon') where family_id=$1 and status='open' and source_type='rent_schedule' and source_id=$2", [req.family!.familyId, r.id]);
      return void reply.code(202).send({ id: q.id, status: q.status, channel: b.channel, to, message, queued_at: q.queued_at });
    });
  });
  app.get("/rent-reminders", async (req) => withFamily(req.family!.familyId, async (c) => (await c.query("select r.*, rs.period_month, t.name tenant from rent_reminders r join rent_schedule rs on rs.id=r.rent_schedule_id join leases l on l.id=rs.lease_id join tenants t on t.id=l.tenant_id order by queued_at desc limit 100")).rows));

  // ---------- property tax ----------
  const taxView = (r: any) => ({ ...r, amount: money(r.amount), due_date: iso(r.due_date), paid_on: iso(r.paid_on) });
  app.get("/property-taxes", async (req) => withFamily(req.family!.familyId, async (c) => {
    const q = z.object({ property_id: z.string().uuid().optional(), status: z.string().optional() }).parse(req.query);
    return (await c.query("select x.*, p.name property from property_taxes x join properties p on p.id=x.property_id where ($1::uuid is null or x.property_id=$1) and ($2::text is null or x.status=$2) order by x.due_date", [q.property_id ?? null, q.status ?? null])).rows.map(taxView);
  }));
  app.post("/property-taxes", { preHandler: WRITERS }, async (req, reply) => {
    const b = z.object({ property_id: z.string().uuid(), authority: z.string().min(1), assessment_no: z.string().optional(), period: z.string().min(1), amount: moneyIn, due_date: date, recurring: z.enum(["half_yearly", "annual"]).optional() }).parse(req.body);
    return withFamily(req.family!.familyId, async (c) => {
      const r = (await c.query("insert into property_taxes (family_id, property_id, authority, assessment_no, period, amount, due_date) values ($1,$2,$3,$4,$5,$6,$7) returning *", [req.family!.familyId, b.property_id, b.authority, b.assessment_no ?? null, b.period, b.amount, b.due_date])).rows[0];
      return void reply.code(201).send(taxView(r));
    });
  });
  app.post("/property-taxes/:id/pay", { preHandler: WRITERS }, async (req, reply) => {
    const b = z.object({ paid_on: date, bank_txn_id: z.string().uuid().optional(), amount: moneyIn.optional() }).parse(req.body);
    return withFamily(req.family!.familyId, async (c) => {
      const id = (req.params as any).id; const fam = req.family!.familyId;
      const r = (await c.query("update property_taxes set status='paid', paid_on=$2, bank_txn_id=coalesce($3, bank_txn_id), amount=coalesce($4, amount) where id=$1 returning *", [id, b.paid_on, b.bank_txn_id ?? null, b.amount ?? null])).rows[0];
      if (!r) return void reply.code(404).send({ title: "Not found", status: 404 });
      if (b.bank_txn_id) await c.query("update bank_txns set link_type='property_tax', link_id=$2 where id=$1", [b.bank_txn_id, id]);
      await c.query("update tasks set status='done', done_at=now(), verification = case when $3::boolean then 'verified' else verification end where family_id=$1 and status='open' and source_type='property_tax' and source_id=$2", [fam, id, !!b.bank_txn_id]);
      await c.query("insert into audit_log (family_id, user_id, action, table_name, row_id, after) values ($1,$2,'pay','property_taxes',$3,$4)", [fam, req.user!.id, id, JSON.stringify(b)]);
      return taxView(r);
    });
  });

  // ---------- expenses / maintenance ----------
  const expView = (r: any) => ({ ...r, amount: money(r.amount), expense_date: iso(r.expense_date) });
  app.get("/property-expenses", async (req) => withFamily(req.family!.familyId, async (c) => {
    const q = z.object({ property_id: z.string().uuid().optional(), from: date.optional(), to: date.optional() }).parse(req.query);
    return (await c.query("select x.*, p.name property from property_expenses x join properties p on p.id=x.property_id where ($1::uuid is null or x.property_id=$1) and ($2::date is null or x.expense_date >= $2) and ($3::date is null or x.expense_date <= $3) order by x.expense_date desc", [q.property_id ?? null, q.from ?? null, q.to ?? null])).rows.map(expView);
  }));
  app.post("/property-expenses", { preHandler: WRITERS }, async (req, reply) => {
    const b = z.object({ property_id: z.string().uuid(), expense_date: date, category: z.enum(["maintenance", "repair", "society", "insurance", "loan_interest", "brokerage", "other"]), capital_improvement: z.boolean().default(false), vendor: z.string().optional(), amount: moneyIn, bank_txn_id: z.string().uuid().optional(), document_id: z.string().uuid().optional(), note: z.string().optional() }).parse(req.body);
    return withFamily(req.family!.familyId, async (c) => {
      const r = (await c.query("insert into property_expenses (family_id, property_id, expense_date, category, capital_improvement, vendor, amount, bank_txn_id, document_id, note) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning *", [req.family!.familyId, b.property_id, b.expense_date, b.category, b.capital_improvement, b.vendor ?? null, b.amount, b.bank_txn_id ?? null, b.document_id ?? null, b.note ?? null])).rows[0];
      if (b.bank_txn_id) await c.query("update bank_txns set link_type='property_expense', link_id=$2 where id=$1", [b.bank_txn_id, r.id]);
      return void reply.code(201).send(expView(r));
    });
  });

  // ---------- GST ----------
  /** GSTR-1 B2B rows for a month per GSTIN: SAC 997212 at the FY rate, CGST/SGST when the tenant is in the same state, IGST otherwise. */
  app.get("/gst/register", async (req) => withFamily(req.family!.familyId, async (c) => {
    const q = z.object({ month: z.string().regex(/^\d{4}-\d{2}$/), gstin_id: z.string().uuid().optional() }).parse(req.query);
    const fy = fyOf(`${q.month}-01`); const gst = (await c.query("select * from gst_settings where fy=$1", [fy])).rows[0] ?? { registration_threshold: 2000000, commercial_rent_rate: 18, sac_code: "997212" };
    const gstins = (await c.query("select g.id, g.gstin, g.state_code, e.name entity from entity_gstins g join entities e on e.id=g.entity_id where g.active and ($1::uuid is null or g.id=$1) order by e.name", [q.gstin_id ?? null])).rows;
    const out = [];
    for (const g of gstins) {
      const rows = (await c.query(`select rs.id, rs.expected_rent, rs.expected_gst, rs.status, p.name property, t.name tenant, t.gstin tenant_gstin, t.state_code tenant_state, l.gst_rate from rent_schedule rs join leases l on l.id=rs.lease_id join properties p on p.id=l.property_id join tenants t on t.id=l.tenant_id
          where l.entity_gstin_id=$1 and l.gst_applicable and rs.period_month=($2 || '-01')::date order by p.name`, [g.id, q.month])).rows;
      const lines = rows.map((r) => { const s = gstSplit(Number(r.expected_rent), Number(r.gst_rate ?? gst.commercial_rent_rate), g.state_code, r.tenant_state); return { rent_schedule_id: r.id, property: r.property, tenant: r.tenant, tenant_gstin: r.tenant_gstin, place_of_supply: r.tenant_state ?? g.state_code, sac: gst.sac_code, taxable_value: money(r.expected_rent), rate: Number(r.gst_rate ?? gst.commercial_rent_rate), cgst: money(s.cgst), sgst: money(s.sgst), igst: money(s.igst), invoice_type: r.tenant_gstin ? "B2B" : "B2C", status: r.status }; });
      const turnover = Number((await c.query("select coalesce(sum(rs.expected_rent),0) v from rent_schedule rs join leases l on l.id=rs.lease_id where l.entity_gstin_id=$1 and rs.period_month >= $2 and rs.period_month <= ($3 || '-01')::date", [g.id, fyStart(fy), q.month])).rows[0].v);
      const returns = (await c.query("select form, status, due_date, filed_on, arn from gst_returns where entity_gstin_id=$1 and period_month=($2 || '-01')::date", [g.id, q.month])).rows.map((r) => ({ ...r, due_date: iso(r.due_date), filed_on: iso(r.filed_on) }));
      out.push({ gstin_id: g.id, gstin: g.gstin, entity: g.entity, state_code: g.state_code, month: q.month, rows: lines, taxable_total: money(lines.reduce((s, l) => s + Number(l.taxable_value), 0)), gstr3b_liability: money(lines.reduce((s, l) => s + Number(l.cgst) + Number(l.sgst) + Number(l.igst), 0)), turnover_fytd: money(turnover), threshold: money(gst.registration_threshold), threshold_pct: +((turnover / Number(gst.registration_threshold)) * 100).toFixed(2), returns });
    }
    return q.gstin_id ? out[0] ?? null : out;
  }));
  app.get("/gst/returns", async (req) => withFamily(req.family!.familyId, async (c) => {
    const q = z.object({ fy: z.string().optional(), status: z.string().optional() }).parse(req.query);
    await ensureGstReturns(c, req.family!.familyId, today());
    const rows = (await c.query(`select r.*, g.gstin, e.name entity_name from gst_returns r join entity_gstins g on g.id=r.entity_gstin_id join entities e on e.id=g.entity_id
        where ($1::text is null or (r.period_month >= ($2 || '-04-01')::date and r.period_month < (($2::int + 1)::text || '-04-01')::date)) and ($3::text is null or r.status=$3) order by r.period_month desc, e.name, r.form`, [q.fy ?? null, q.fy ? q.fy.slice(0, 4) : "2000", q.status ?? null])).rows;
    return rows.map((r) => ({ ...r, period_month: iso(r.period_month)?.slice(0, 7), taxable_value: money(r.taxable_value), tax_amount: money(r.tax_amount), due_date: iso(r.due_date), filed_on: iso(r.filed_on) }));
  }));
  app.patch("/gst/returns/:id", { preHandler: WRITERS }, async (req, reply) => {
    const b = z.object({ filed_on: date.optional(), arn: z.string().optional(), status: z.enum(["due", "filed", "late"]).optional() }).parse(req.body);
    return withFamily(req.family!.familyId, async (c) => {
      const id = (req.params as any).id; const fam = req.family!.familyId;
      const cur = (await c.query("select * from gst_returns where id=$1", [id])).rows[0];
      if (!cur) return void reply.code(404).send({ title: "Not found", status: 404 });
      const filedOn = b.filed_on ?? (b.status && b.status !== "due" ? today() : null);
      const status = b.status ?? (filedOn ? (iso(cur.due_date)! < filedOn ? "late" : "filed") : cur.status);
      const r = (await c.query("update gst_returns set filed_on=coalesce($2, filed_on), arn=coalesce($3, arn), status=$4 where id=$1 returning *", [id, filedOn, b.arn ?? null, status])).rows[0];
      if (status !== "due") await c.query("update tasks set status='done', done_at=now() where family_id=$1 and status='open' and source_type='gst_return' and source_id=$2", [fam, id]);
      await c.query("insert into audit_log (family_id, user_id, action, table_name, row_id, after) values ($1,$2,'update','gst_returns',$3,$4)", [fam, req.user!.id, id, JSON.stringify(b)]);
      return { ...r, period_month: iso(r.period_month)?.slice(0, 7), taxable_value: money(r.taxable_value), tax_amount: money(r.tax_amount), due_date: iso(r.due_date), filed_on: iso(r.filed_on) };
    });
  });
}
