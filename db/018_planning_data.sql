-- Milestone 4: planning & taxation reference data and inputs (FO-70..81). Rates and thresholds are data.

-- Parameters the tax engine reads by (fy, regime, code). Illustrative FY 2026-27 values; confirm against the Finance Act.
create table tax_params (
  fy text not null, regime tax_regime not null, code text not null, value numeric(18,4) not null, notes text,
  primary key (fy, regime, code)
);
insert into tax_params (fy, regime, code, value, notes) values
('2026-27','new','CESS_PCT',4,'Health & education cess'),('2026-27','old','CESS_PCT',4,''),
('2026-27','new','REBATE_87A_LIMIT',1200000,'Total income up to which 87A applies'),('2026-27','old','REBATE_87A_LIMIT',500000,''),
('2026-27','new','REBATE_87A_MAX',60000,''),('2026-27','old','REBATE_87A_MAX',12500,''),
('2026-27','new','REBATE_87A_MARGINAL_RELIEF',1,'Tax just above the limit capped at the excess income'),('2026-27','old','REBATE_87A_MARGINAL_RELIEF',0,''),
('2026-27','new','HP_STD_DED_PCT',30,'s.24(a)'),('2026-27','old','HP_STD_DED_PCT',30,''),
('2026-27','new','ADV_Q1_PCT',15,'15 Jun'),('2026-27','new','ADV_Q2_PCT',45,'15 Sep'),('2026-27','new','ADV_Q3_PCT',75,'15 Dec'),('2026-27','new','ADV_Q4_PCT',100,'15 Mar'),
('2026-27','old','ADV_Q1_PCT',15,''),('2026-27','old','ADV_Q2_PCT',45,''),('2026-27','old','ADV_Q3_PCT',75,''),('2026-27','old','ADV_Q4_PCT',100,''),
('2026-27','new','ADV_TAX_THRESHOLD',10000,'Advance tax applies when net liability >= this'),('2026-27','old','ADV_TAX_THRESHOLD',10000,''),
('2026-27','new','INT_234B_PCT_PM',1,''),('2026-27','old','INT_234B_PCT_PM',1,''),('2026-27','new','INT_234C_PCT_PM',1,''),('2026-27','old','INT_234C_PCT_PM',1,''),
('2026-27','new','INT_234B_MIN_PAID_PCT',90,''),('2026-27','old','INT_234B_MIN_PAID_PCT',90,''),('2026-27','new','INT_234B_MONTHS',4,'Apr–Jul to a July return'),('2026-27','old','INT_234B_MONTHS',4,''),
('2026-27','new','DED_80G_PCT',50,''),('2026-27','old','DED_80G_PCT',50,''),('2026-27','new','DED_80G_GTI_CAP_PCT',10,'qualifying limit'),('2026-27','old','DED_80G_GTI_CAP_PCT',10,''),
('2026-27','new','SEC54EC_MONTHS',6,'Investment window after transfer'),('2026-27','old','SEC54EC_MONTHS',6,''),
('2026-27','new','SEC54EC_LOCK_YEARS',5,''),('2026-27','old','SEC54EC_LOCK_YEARS',5,''),
('2026-27','new','SEC54F_MAX_CONSIDERATION',100000000,''),('2026-27','old','SEC54F_MAX_CONSIDERATION',100000000,''),
('2026-27','new','PROPERTY_INDEXATION_CUTOFF',20240723,'Acquisitions before 23 Jul 2024 may choose 20% with indexation'),('2026-27','old','PROPERTY_INDEXATION_CUTOFF',20240723,''),
('2026-27','new','PROPERTY_INDEXED_RATE_PCT',20,''),('2026-27','old','PROPERTY_INDEXED_RATE_PCT',20,''),
('2026-27','new','CLUBBING_WARN',1,'s.64 clubbing warning on transfers to spouse / HUF'),('2026-27','old','CLUBBING_WARN',1,'');
-- deductions the new regime still allows, plus the standard deduction under both
insert into tax_deduction_limits (fy, regime, code, limit_amount, notes) values
('2026-27','old','STD_DED',50000,'Standard deduction salary (old)'),('2026-27','old','80TTA',10000,'Savings interest'),('2026-27','old','54F',null,'Proportionate exemption; consideration cap in tax_params'),
('2026-27','new','54EC',5000000,'Capital-gain bonds within 6 months of transfer'),('2026-27','new','112A_EXEMPT',125000,''),('2026-27','new','24B',0,'No HP loss set-off in the new regime')
on conflict (fy, regime, code) do nothing;

-- Cost inflation index for indexed property gains (s.48). 2026-27 is an assumption until notified.
create table cost_inflation_index (fy text primary key, index_value int not null);
insert into cost_inflation_index values ('2001-02',100),('2002-03',105),('2003-04',109),('2004-05',113),('2005-06',117),('2006-07',122),('2007-08',129),('2008-09',137),('2009-10',148),('2010-11',167),('2011-12',184),('2012-13',200),('2013-14',220),('2014-15',240),('2015-16',254),('2016-17',264),('2017-18',272),('2018-19',280),('2019-20',289),('2020-21',301),('2021-22',317),('2022-23',331),('2023-24',348),('2024-25',363),('2025-26',376),('2026-27',389),('2027-28',402),('2028-29',416);

-- Horizon FYs reuse the latest published tables until the next Finance Act is loaded.
insert into tax_slabs (fy, regime, entity_type, slab_from, slab_to, rate) select f.fy, s.regime, s.entity_type, s.slab_from, s.slab_to, s.rate from tax_slabs s cross join (values ('2027-28'),('2028-29'),('2029-30')) f(fy) where s.fy='2026-27' on conflict do nothing;
insert into tax_surcharge (fy, regime, income_from, rate, capped_on_gains_pct) select f.fy, s.regime, s.income_from, s.rate, s.capped_on_gains_pct from tax_surcharge s cross join (values ('2027-28'),('2028-29'),('2029-30')) f(fy) where s.fy='2026-27' on conflict do nothing;
insert into tax_deduction_limits (fy, regime, code, limit_amount, notes) select f.fy, d.regime, d.code, d.limit_amount, d.notes from tax_deduction_limits d cross join (values ('2027-28'),('2028-29'),('2029-30')) f(fy) where d.fy='2026-27' on conflict do nothing;
insert into tax_params (fy, regime, code, value, notes) select f.fy, x.regime, x.code, x.value, x.notes from tax_params x cross join (values ('2027-28'),('2028-29'),('2029-30')) f(fy) where x.fy='2026-27' on conflict do nothing;
insert into tax_rules (fy, asset_class, term, rate, taxed_at_slab, exemption_amount, holding_months_for_long, indexation, notes) select f.fy, r.asset_class, r.term, r.rate, r.taxed_at_slab, r.exemption_amount, r.holding_months_for_long, r.indexation, r.notes from tax_rules r cross join (values ('2027-28'),('2028-29'),('2029-30')) f(fy) where r.fy='2026-27' on conflict do nothing;

-- Income that is not derived from holdings or leases (salary, professional fees, business, interest), per entity.
create table entity_income_sources (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references families(id) on delete cascade,
  entity_id uuid not null references entities(id) on delete cascade,
  kind text not null,                 -- salary | fees | business | interest | dividend | other
  label text not null,
  annual_amount numeric(18,2) not null,
  growth_pct numeric(5,2) not null default 0,
  from_fy text, to_fy text,           -- null = open-ended
  tds_pct numeric(5,2) not null default 0,
  created_at timestamptz not null default now()
);
-- Advance-tax challans paid, per entity and FY.
create table advance_tax_payments (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references families(id) on delete cascade,
  entity_id uuid not null references entities(id) on delete cascade,
  fy text not null,
  paid_on date not null,
  amount numeric(18,2) not null,
  challan text,
  bank_txn_id uuid,
  created_at timestamptz not null default now()
);
-- Deductions the entity intends to claim for a FY (80C, 80D, 80CCD1B, 24B interest on self-occupied …).
create table entity_deductions (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references families(id) on delete cascade,
  entity_id uuid not null references entities(id) on delete cascade,
  fy text not null,
  code text not null,
  amount numeric(18,2) not null,
  note text,
  unique (entity_id, fy, code)
);
alter table plan_actions add column if not exists simulated_effect jsonb;
alter table plan_scenarios add column if not exists last_error text;

do $$ declare t text; begin
  foreach t in array array['entity_income_sources','advance_tax_payments','entity_deductions'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format($p$create policy %I_tenant on %I using (family_id = current_setting('app.family_id', true)::uuid) with check (family_id = current_setting('app.family_id', true)::uuid)$p$, t, t);
  end loop; end $$;
grant select, insert, update, delete on tax_params, cost_inflation_index, entity_income_sources, advance_tax_payments, entity_deductions to app_user;

-- Demo family inputs (scaled like the rest of the seed): fees for Arjun, interest for the spouse, 80C room for the HUF,
-- and the advance-tax challans the prototype's Tax position shows as paid (520 / 400 / 280).
insert into entity_income_sources (family_id, entity_id, kind, label, annual_amount) values
('11111111-1111-1111-1111-111111111111','33333333-0000-0000-0000-000000000001','fees','Consulting fees',8000),
('11111111-1111-1111-1111-111111111111','33333333-0000-0000-0000-000000000003','interest','FD and savings interest',2600);
insert into advance_tax_payments (family_id, entity_id, fy, paid_on, amount, challan) values
('11111111-1111-1111-1111-111111111111','33333333-0000-0000-0000-000000000001','2026-27','2026-06-14',520,'CHLN-0614-01'),
('11111111-1111-1111-1111-111111111111','33333333-0000-0000-0000-000000000002','2026-27','2026-06-14',400,'CHLN-0614-02'),
('11111111-1111-1111-1111-111111111111','33333333-0000-0000-0000-000000000003','2026-27','2026-06-14',280,'CHLN-0614-03');
insert into entity_deductions (family_id, entity_id, fy, code, amount, note) values
('11111111-1111-1111-1111-111111111111','33333333-0000-0000-0000-000000000002','2026-27','80C',1500,'PPF room available (old regime only)');
