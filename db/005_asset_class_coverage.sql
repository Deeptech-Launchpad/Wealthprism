-- Family Office — asset-class coverage extension: precious metals, REIT/InvIT, global investments,
-- asset-class allocation lens (equity/debt/gold/real estate/cash/global), model portfolios, bands, core/satellite, look-through.
-- Apply after 003.

alter type instrument_type add value if not exists 'silver';
alter type instrument_type add value if not exists 'reit';
alter type instrument_type add value if not exists 'invit';
alter type instrument_type add value if not exists 'foreign_stock';
alter type instrument_type add value if not exists 'foreign_etf';
alter type instrument_type add value if not exists 'foreign_fund';
alter type instrument_type add value if not exists 'gift_city';

create type core_satellite as enum ('core','satellite');
create type alloc_class as enum ('equity','debt','gold','real_estate','cash','global','alternatives');

alter table instruments
  add column if not exists currency char(3) not null default 'INR',
  add column if not exists alloc_class alloc_class,                 -- top-level lens class (derived from type when null)
  add column if not exists country char(2) default 'IN';
alter table holdings add column if not exists core_satellite core_satellite not null default 'core';
alter table holdings add column if not exists cost_ccy numeric(18,4);   -- cost in instrument currency, for foreign holdings
alter table investment_txns add column if not exists fx_rate numeric(12,6);   -- INR per unit of instrument currency on txn date (for TTBR/SBI rate on acquisition)

-- FX rates (RBI reference / SBI TT buying rate for tax) per day
create table fx_rates (
  ccy char(3) not null,
  rate_date date not null,
  rate_inr numeric(12,6) not null,       -- INR per 1 unit
  source text not null,                  -- rbi_reference | sbi_ttbr | manual
  primary key (ccy, rate_date, source)
);

-- Look-through: what an instrument is actually made of (hybrid/multi-asset/FoF/REIT/international funds)
create table instrument_exposure (
  instrument_id uuid not null references instruments(id) on delete cascade,
  as_of date not null,
  alloc_class alloc_class not null,
  pct numeric(6,3) not null,
  country char(2),
  source text not null,                  -- amfi_portfolio | factsheet | manual
  country_key char(2) generated always as (coalesce(country,'XX')) stored,
  primary key (instrument_id, as_of, alloc_class, country_key)
);

-- Asset-class targets (second lens beside bucket_targets), with tactical bands
create table asset_class_targets (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references families(id) on delete cascade,
  entity_id uuid references entities(id),
  alloc_class alloc_class not null,
  target_pct numeric(5,2) not null,
  min_pct numeric(5,2),
  max_pct numeric(5,2),
  effective_from date not null default current_date,
  entity_key uuid generated always as (coalesce(entity_id,'00000000-0000-0000-0000-000000000000'::uuid)) stored,
  unique (family_id, entity_key, alloc_class, effective_from)
);

-- Model portfolios (system-provided and family-defined)
create table model_portfolios (
  id uuid primary key default gen_random_uuid(),
  family_id uuid references families(id) on delete cascade,   -- null = system model
  code text not null,
  name text not null,
  risk_profile text,                                          -- conservative | moderate | aggressive | custom
  mix jsonb not null,                                         -- {"equity":60,"debt":30,"gold":10,...}
  bands jsonb,                                                -- {"equity":[55,65],...}
  notes text,
  family_key uuid generated always as (coalesce(family_id,'00000000-0000-0000-0000-000000000000'::uuid)) stored,
  unique (family_key, code)
);

-- Family allocation policy: strategy type and review cadence
create table allocation_policies (
  family_id uuid primary key references families(id) on delete cascade,
  strategy text not null default 'strategic',      -- strategic | tactical | dynamic | core_satellite | goal_based
  model_portfolio_id uuid references model_portfolios(id),
  review_every_months smallint not null default 12,
  next_review_on date,
  rebalance_trigger_pp numeric(4,2) not null default 5,   -- band breach that raises a rebalancing task
  include_self_occupied boolean not null default false,
  include_epf_ppf boolean not null default true
);

-- Global / foreign-asset compliance records
create table lrs_remittances (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references families(id) on delete cascade,
  entity_id uuid not null references entities(id),
  fy text not null,
  remitted_on date not null,
  ccy char(3) not null,
  amount_ccy numeric(18,2) not null,
  amount_inr numeric(18,2) not null,
  purpose text not null default 'S0001',           -- LRS purpose code
  tcs_collected numeric(18,2) not null default 0,
  bank_txn_id uuid references bank_txns(id)
);
create table foreign_tax_credits (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references families(id) on delete cascade,
  entity_id uuid not null references entities(id),
  fy text not null,
  country char(2) not null,
  income_type text not null,                       -- dividend | interest | gains
  income_inr numeric(18,2) not null,
  foreign_tax_inr numeric(18,2) not null,
  dtaa_article text,
  form67_filed_on date
);

do $$ declare t text; begin
  foreach t in array array['asset_class_targets','lrs_remittances','foreign_tax_credits'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format($p$create policy %I_tenant on %I using (family_id = current_setting('app.family_id', true)::uuid) with check (family_id = current_setting('app.family_id', true)::uuid)$p$, t, t);
  end loop; end $$;
alter table model_portfolios enable row level security;
create policy model_portfolios_tenant on model_portfolios using (family_id is null or family_id = current_setting('app.family_id', true)::uuid);
alter table allocation_policies enable row level security; alter table allocation_policies force row level security;
create policy allocation_policies_tenant on allocation_policies using (family_id = current_setting('app.family_id', true)::uuid) with check (family_id = current_setting('app.family_id', true)::uuid);
grant select, insert, update, delete on fx_rates, instrument_exposure, asset_class_targets, model_portfolios, allocation_policies, lrs_remittances, foreign_tax_credits to app_user;

-- reference: tax rules for the new classes (FY 2026-27; confirm each year)
insert into tax_rules (fy, asset_class, term, rate, taxed_at_slab, exemption_amount, holding_months_for_long, indexation, notes) values
('2026-27','gold_etf','short',0,true,0,12,false,'Listed gold/silver ETF'),
('2026-27','gold_etf','long',12.5,false,0,12,false,''),
('2026-27','gold_fof','short',0,true,0,24,false,'Gold/silver fund of funds'),
('2026-27','gold_fof','long',12.5,false,0,24,false,''),
('2026-27','reit_invit','short',20,false,0,12,false,'Listed units, STT paid'),
('2026-27','reit_invit','long',12.5,false,125000,12,false,'Shares the 112A exemption; distributions taxed by component (interest slab, dividend slab/exempt, return of capital reduces cost)'),
('2026-27','foreign_equity','short',0,true,0,24,false,'Direct foreign stocks/ETFs via LRS; gains in INR using TTBR on buy and sell dates'),
('2026-27','foreign_equity','long',12.5,false,0,24,false,'Report in Schedule FA; dividends at slab with DTAA credit via Form 67'),
('2026-27','intl_fund','short',0,true,0,24,false,'International FoF / global funds (not "specified mutual fund" from 1 Apr 2025)'),
('2026-27','intl_fund','long',12.5,false,0,24,false,''),
('2026-27','sgb','long',0,false,0,96,false,'Exempt on redemption at maturity; secondary sale >12m listed at 12.5%')
on conflict (fy, asset_class, term) do nothing;

insert into model_portfolios (family_id, code, name, risk_profile, mix, bands, notes) values
(null,'conservative','Conservative','conservative','{"equity":30,"debt":60,"gold":10}','{"equity":[20,40],"debt":[50,70],"gold":[10,20]}','Indicative HNI framework: equity 20–40, debt 50–70, gold and others 10–20'),
(null,'moderate','Moderate','moderate','{"equity":60,"debt":30,"gold":10}','{"equity":[50,70],"debt":[20,40],"gold":[10,15]}','Traditional 60-30-10'),
(null,'aggressive','Aggressive','aggressive','{"equity":80,"debt":12,"gold":8}','{"equity":[70,90],"debt":[5,20],"gold":[5,10]}','Growth-oriented'),
(null,'growth_70_15_15','70-15-15','aggressive','{"equity":70,"debt":15,"gold":15}','{"equity":[65,75],"debt":[10,20],"gold":[10,20]}','Higher gold weight'),
(null,'multi_asset','Multi-asset with global','moderate','{"equity":50,"debt":25,"gold":10,"global":10,"cash":5}','{"equity":[40,60],"debt":[20,30],"gold":[5,15],"global":[5,15],"cash":[2,10]}','Includes international exposure');
