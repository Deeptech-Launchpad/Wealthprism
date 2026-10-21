-- Family Office — Planning & Taxation module (scenarios, what-if simulation, optimiser, execution tracking)
-- Apply after 001_init.sql.

create type scenario_status as enum ('draft','in_review','approved','executing','completed','archived');
create type plan_action_kind as enum (
  'sell_holding','buy_instrument','switch','redeem_before_date','defer_sale_to_fy',
  'harvest_loss','book_gain_within_exemption','transfer_to_entity','change_tax_regime',
  'sell_property','reinvest_54ec','reinvest_54f','prepay_loan','exit_private','donate_80g',
  'contribute_nps','contribute_ppf','change_rent','deploy_cash','custom'
);
create type plan_action_status as enum ('planned','in_progress','done','skipped');
create type suggestion_status as enum ('new','added_to_plan','dismissed');

create table plan_scenarios (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references families(id) on delete cascade,
  name text not null,
  description text,
  is_baseline boolean not null default false,        -- one auto-maintained baseline per family
  parent_scenario_id uuid references plan_scenarios(id),
  version int not null default 1,
  base_date date not null default current_date,
  horizon_fys int not null default 3,                -- how many FYs the simulation projects
  entity_scope uuid[],                               -- null = all entities
  assumptions jsonb not null default '{}',           -- {"returns":{"liquidity":6.5,"income":8,"growth":12},"inflation":6,"regime":{"<entity_id>":"new"},"price_growth":{}}
  status scenario_status not null default 'draft',
  created_by uuid references users(id),
  approved_by uuid references users(id),
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create unique index plan_scenarios_one_baseline on plan_scenarios (family_id) where is_baseline;
create trigger plan_scenarios_upd before update on plan_scenarios for each row execute function set_updated_at();

create table plan_actions (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references families(id) on delete cascade,
  scenario_id uuid not null references plan_scenarios(id) on delete cascade,
  seq int not null,
  kind plan_action_kind not null,
  entity_id uuid references entities(id),
  target_type text,                                  -- holding | property | private_investment | bank_account | goal | entity
  target_id uuid,
  params jsonb not null default '{}',                -- kind-specific: {"quantity":..,"price":..,"to_entity_id":..,"to_instrument_id":..,"fy":"2027-28",...}
  planned_date date not null,
  planned_amount numeric(18,2),
  status plan_action_status not null default 'planned',
  task_id uuid references tasks(id),
  actual_date date,
  actual_amount numeric(18,2),
  actual_ref_type text, actual_ref_id uuid,          -- investment_txn / bank_txn / private_exit that fulfilled it
  variance jsonb,                                    -- {"amount":..,"days":..,"tax_delta":..}
  note text,
  unique (scenario_id, seq)
);

create table plan_results (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references families(id) on delete cascade,
  scenario_id uuid not null references plan_scenarios(id) on delete cascade,
  computed_at timestamptz not null default now(),
  engine_version text not null,
  summary jsonb not null,        -- {"tax_total":..,"tax_vs_baseline":..,"post_tax_cash":..,"net_worth_end":..,"drift_max_pp":..}
  by_fy jsonb not null,          -- [{"fy":"2026-27","entity_id":..,"heads":{"salary":..,"house_property":..,"capital_gains":{"stcg_equity":..,"ltcg_equity":..,...},"other":..},"deductions":{...},"tax":{"basic":..,"surcharge":..,"cess":..,"total":..},"advance_tax":[{"due":"2026-09-15","amount":..}]}]
  allocation_after jsonb not null,  -- [{"bucket":"growth","pct":..,"value":..,"drift_pp":..}]
  goals_after jsonb not null,       -- [{"goal_id":..,"funded_pct":..,"delta_pp":..}]
  cash_ladder jsonb,                -- month-by-month projected cash and committed outflows
  warnings jsonb not null default '[]'  -- e.g. clubbing risk, 54EC cap exceeded, lot becomes short-term
);
create index on plan_results (scenario_id, computed_at desc);

create table plan_comments (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references families(id) on delete cascade,
  scenario_id uuid not null references plan_scenarios(id) on delete cascade,
  user_id uuid not null references users(id),
  body text not null,
  created_at timestamptz not null default now()
);

create table tax_suggestions (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references families(id) on delete cascade,
  scenario_id uuid references plan_scenarios(id) on delete cascade,   -- null = against baseline
  entity_id uuid references entities(id),
  code text not null,                -- use_ltcg_exemption | harvest_loss | split_across_fy | wait_for_long_term | regime_switch | route_to_entity | sec_54ec | advance_tax_gap | nps_80ccd | donate_80g
  title text not null,
  rationale text not null,
  est_saving numeric(18,2),
  fy text,
  proposed_actions jsonb not null,   -- array of plan_actions-shaped objects
  status suggestion_status not null default 'new',
  created_at timestamptz not null default now()
);
create unique index tax_suggestions_dedup on tax_suggestions (family_id, coalesce(scenario_id,'00000000-0000-0000-0000-000000000000'::uuid), coalesce(entity_id,'00000000-0000-0000-0000-000000000000'::uuid), code, coalesce(fy,''));

-- slab and surcharge tables are data, like tax_rules
create table tax_slabs (
  id uuid primary key default gen_random_uuid(),
  fy text not null,
  regime tax_regime not null,
  entity_type entity_type not null,
  slab_from numeric(18,2) not null,
  slab_to numeric(18,2),
  rate numeric(5,2) not null,
  unique (fy, regime, entity_type, slab_from)
);
create table tax_surcharge (
  fy text not null, regime tax_regime not null, income_from numeric(18,2) not null, rate numeric(5,2) not null,
  capped_on_gains_pct numeric(5,2) default 15,  -- surcharge on 111A/112/112A gains capped at 15%
  primary key (fy, regime, income_from)
);
create table tax_deduction_limits (
  fy text not null, regime tax_regime not null, code text not null, limit_amount numeric(18,2), notes text,
  primary key (fy, regime, code)
);

-- RLS for new tenant tables
do $$ declare t text; begin
  foreach t in array array['plan_scenarios','plan_actions','plan_results','plan_comments','tax_suggestions'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format($p$create policy %I_tenant on %I using (family_id = current_setting('app.family_id', true)::uuid) with check (family_id = current_setting('app.family_id', true)::uuid)$p$, t, t);
  end loop; end $$;
grant select, insert, update, delete on plan_scenarios, plan_actions, plan_results, plan_comments, tax_suggestions, tax_slabs, tax_surcharge, tax_deduction_limits to app_user;

-- reference data FY 2026-27 (illustrative; confirm against the Finance Act each year)
insert into tax_slabs (fy, regime, entity_type, slab_from, slab_to, rate) values
('2026-27','new','individual',0,400000,0),('2026-27','new','individual',400000,800000,5),('2026-27','new','individual',800000,1200000,10),
('2026-27','new','individual',1200000,1600000,15),('2026-27','new','individual',1600000,2000000,20),('2026-27','new','individual',2000000,2400000,25),('2026-27','new','individual',2400000,null,30),
('2026-27','old','individual',0,250000,0),('2026-27','old','individual',250000,500000,5),('2026-27','old','individual',500000,1000000,20),('2026-27','old','individual',1000000,null,30),
('2026-27','new','huf',0,400000,0),('2026-27','new','huf',400000,800000,5),('2026-27','new','huf',800000,1200000,10),('2026-27','new','huf',1200000,1600000,15),('2026-27','new','huf',1600000,2000000,20),('2026-27','new','huf',2000000,2400000,25),('2026-27','new','huf',2400000,null,30),
('2026-27','old','huf',0,250000,0),('2026-27','old','huf',250000,500000,5),('2026-27','old','huf',500000,1000000,20),('2026-27','old','huf',1000000,null,30);
insert into tax_surcharge (fy, regime, income_from, rate) values
('2026-27','new',5000000,10),('2026-27','new',10000000,15),('2026-27','new',20000000,25),
('2026-27','old',5000000,10),('2026-27','old',10000000,15),('2026-27','old',20000000,25),('2026-27','old',50000000,37);
insert into tax_deduction_limits (fy, regime, code, limit_amount, notes) values
('2026-27','old','80C',150000,'PPF, ELSS, LIC, principal'),('2026-27','old','80CCD1B',50000,'NPS additional'),('2026-27','old','80D',25000,'Health insurance (50000 senior)'),
('2026-27','old','24B',200000,'Home loan interest, self-occupied'),('2026-27','old','80G',null,'50%/100% with 10% GTI qualifying limit'),
('2026-27','new','80CCD2',null,'Employer NPS 14% of salary'),('2026-27','new','STD_DED',75000,'Standard deduction salary'),
('2026-27','old','54EC',5000000,'Capital-gain bonds within 6 months of transfer'),('2026-27','old','112A_EXEMPT',125000,'LTCG exemption on listed equity');
