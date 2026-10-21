-- Family Office — Rebalancing & liquidity-timing engine: programs with calendar/band/milestone/need triggers,
-- dated funding needs, lot constraints, plan versions with timed moves, need coverage, calendar of actions.
-- Apply after 010.

create type rebalance_trigger as enum ('calendar','band_breach','drift_threshold','milestone','funding_need','glide_step','large_flow','tax_year_end','policy_change','manual');
create type rebalance_run_status as enum ('evaluated','no_action','plan_drafted','plan_approved','executing','completed','cancelled');
create type rebalance_plan_status as enum ('draft','in_review','approved','converted','superseded','cancelled');
create type move_kind as enum ('sell','buy','switch','redeem','transfer_cash','hold_cash','sip_change','stp','swp');
create type need_kind as enum ('goal_drawdown','capital_call','tax_instalment','liability_payment','insurance_premium','planned_expense','distribution_to_family','buffer_rebuild','other');
create type need_status as enum ('planned','funded','partially_funded','due','met','cancelled');

-- ---------- programs (what triggers a run, for which scope) ----------
create table rebalance_programs (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references families(id) on delete cascade,
  scope policy_scope not null,
  entity_id uuid references entities(id),
  goal_id uuid references goals(id),
  policy_id uuid references investment_policies(id),
  name text not null,
  calendar_rrule text,                            -- e.g. FREQ=MONTHLY;BYMONTHDAY=1 or FREQ=YEARLY;BYMONTH=4;BYMONTHDAY=1
  band_trigger boolean not null default true,     -- from policy allocations min/max
  drift_threshold_pp numeric(4,2),                -- optional total-drift trigger
  milestone_triggers jsonb not null default '[]', -- [{"kind":"goal_years_to_go","value":5},{"kind":"goal_funded_pct","value":90},{"kind":"life_event","value":"retirement"},{"kind":"glide_step"}]
  need_lookahead_days int not null default 120,   -- schedule funding for needs inside this horizon
  large_flow_pct numeric(5,2) default 5,          -- inflow/outflow > x% of scope value triggers a run
  tax_year_end boolean not null default true,     -- run in Feb/Mar with exemption/harvest awareness
  constraints jsonb not null default '{}',        -- {"min_trade":5000,"max_turnover_pct":15,"avoid_exit_load":true,"respect_lock_in":true,"prefer_new_cash":true,"tax_aware":true,"ltcg_wait_days":45,"max_tax_cost":..,"settlement_buffer_days":2}
  auto_draft boolean not null default true,       -- draft a plan without asking
  auto_convert_low_risk boolean not null default false,  -- convert to intents automatically for moves below policy tier 1 (still human-approved in action plane)
  active boolean not null default true,
  scope_key uuid generated always as (coalesce(goal_id, entity_id, '00000000-0000-0000-0000-000000000000'::uuid)) stored,
  unique (family_id, scope, scope_key)
);

-- ---------- dated funding needs (liability-driven timing) ----------
create table funding_needs (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references families(id) on delete cascade,
  entity_id uuid not null references entities(id),
  goal_id uuid references goals(id),
  kind need_kind not null,
  label text not null,
  need_date date not null,
  amount numeric(18,2) not null,
  flexibility_days int not null default 0,        -- can be met up to N days late
  source_type text, source_id uuid,               -- committed_outflow | fund_commitment | goal | liability_schedule | insurance_policy | manual
  priority smallint not null default 2,           -- 1 hard (tax, call), 2 firm, 3 soft
  status need_status not null default 'planned',
  funded_amount numeric(18,2) not null default 0,
  bank_account_id uuid references bank_accounts(id),
  created_at timestamptz not null default now()
);
create index on funding_needs (family_id, need_date);

-- ---------- lot-level constraints that affect timing ----------
create table lot_constraints (
  lot_id uuid primary key references lots(id) on delete cascade,
  family_id uuid not null references families(id) on delete cascade,
  lock_in_until date,                             -- ELSS 3y, SGB 5y early-exit window, PPF, FD, AIF
  exit_load_until date, exit_load_pct numeric(5,3),
  ltcg_eligible_on date,                          -- buy_date + holding period per tax_rules
  settlement_days smallint not null default 1,    -- T+1 equity, T+1..T+3 MF, quarterly AIF
  liquidity_class text,                           -- t0 | t1 | t3 | quarterly | locked
  computed_at timestamptz not null default now()
);

-- ---------- runs ----------
create table rebalance_runs (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references families(id) on delete cascade,
  program_id uuid not null references rebalance_programs(id) on delete cascade,
  triggered_by rebalance_trigger not null,
  trigger_detail jsonb,                           -- {"band":"equity","actual":58.9,"max":55} | {"need_id":..} | {"milestone":"goal_years_to_go=5"}
  run_at timestamptz not null default now(),
  snapshot jsonb not null,                        -- allocation before (both lenses, look-through), cash, needs in horizon, policy version
  drift jsonb not null,                           -- per lens/key drift and breach flags
  status rebalance_run_status not null default 'evaluated',
  plan_id uuid,
  note text
);
create index on rebalance_runs (family_id, run_at desc);

-- ---------- plans and timed moves ----------
create table rebalance_plans (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references families(id) on delete cascade,
  run_id uuid not null references rebalance_runs(id) on delete cascade,
  version int not null default 1,
  status rebalance_plan_status not null default 'draft',
  objective text not null,                        -- back_to_target | to_band_edge | fund_needs_only | needs_plus_bands | glide_step
  allocation_after jsonb not null,
  summary jsonb not null,                         -- {"turnover":..,"turnover_pct":..,"est_tax":..,"est_costs":..,"exit_loads_avoided":..,"needs_covered":n,"needs_uncovered":n,"drift_after_max_pp":..}
  warnings jsonb not null default '[]',
  agent_session_id uuid references agent_sessions(id),
  approved_by uuid references users(id), approved_at timestamptz,
  intent_batch_id uuid,
  created_at timestamptz not null default now(),
  unique (run_id, version)
);
alter table rebalance_runs add constraint rr_plan_fk foreign key (plan_id) references rebalance_plans(id);

create table rebalance_moves (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references families(id) on delete cascade,
  plan_id uuid not null references rebalance_plans(id) on delete cascade,
  seq int not null,
  kind move_kind not null,
  entity_id uuid not null references entities(id),
  from_holding_id uuid references holdings(id),
  from_lot_ids uuid[],                            -- explicit lot selection (tax-aware)
  to_instrument_id uuid references instruments(id),
  to_bank_account_id uuid references bank_accounts(id),
  quantity numeric(18,6),
  amount numeric(18,2) not null,
  planned_date date not null,                     -- solver output
  earliest_date date, latest_date date,           -- window given constraints
  settles_on date,                                -- planned_date + settlement
  reason text not null,                           -- band:equity | need:<label> | glide | harvest | ltcg_wait | cash_first
  need_id uuid references funding_needs(id),
  est_gain numeric(18,2), est_tax numeric(18,2), est_cost numeric(18,2), exit_load numeric(18,2),
  constraints_checked jsonb not null default '[]',-- [{"lock_in":"ok"},{"exit_load":"waits until 2026-11-02"},{"ltcg":"eligible 2027-01-09, waiting"},{"settlement":"T+3 → settles 2026-10-10 for need 2026-10-14"}]
  depends_on_move_id uuid references rebalance_moves(id),
  intent_id uuid references action_intents(id),
  status text not null default 'planned',         -- planned | intent_created | executed | skipped
  unique (plan_id, seq)
);
create index on rebalance_moves (family_id, planned_date);

create table need_coverage (                      -- which moves / cash fund which need
  need_id uuid not null references funding_needs(id) on delete cascade,
  move_id uuid references rebalance_moves(id) on delete cascade,
  bank_account_id uuid references bank_accounts(id),
  amount numeric(18,2) not null,
  available_on date not null,
  coverage_key uuid generated always as (coalesce(move_id, bank_account_id)) stored,
  primary key (need_id, coverage_key)
);

-- plan state machine
create or replace function rebalance_plan_transition() returns trigger language plpgsql as $$
begin
  if old.status = new.status then return new; end if;
  if (old.status, new.status) not in (('draft','in_review'),('draft','cancelled'),('in_review','approved'),('in_review','draft'),('in_review','cancelled'),('approved','converted'),('approved','cancelled'),('draft','superseded'),('in_review','superseded')) then
    raise exception 'illegal plan transition % -> %', old.status, new.status;
  end if;
  if new.status = 'approved' and new.approved_by is null then raise exception 'approval requires approved_by'; end if;
  return new;
end $$;
create trigger rebalance_plans_fsm before update on rebalance_plans for each row execute function rebalance_plan_transition();

do $$ declare t text; begin
  foreach t in array array['rebalance_programs','funding_needs','lot_constraints','rebalance_runs','rebalance_plans','rebalance_moves'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format($p$create policy %I_tenant on %I using (family_id = current_setting('app.family_id', true)::uuid) with check (family_id = current_setting('app.family_id', true)::uuid)$p$, t, t);
  end loop; end $$;
alter table need_coverage enable row level security; alter table need_coverage force row level security;
create policy need_coverage_tenant on need_coverage using (exists (select 1 from funding_needs n where n.id = need_id and n.family_id = current_setting('app.family_id', true)::uuid));
grant select, insert, update, delete on rebalance_programs, funding_needs, lot_constraints, rebalance_runs, rebalance_plans, rebalance_moves, need_coverage to app_user;
