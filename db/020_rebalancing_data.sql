-- Family Office — Rebalancing & liquidity-timing data (FO-160..166). Apply after 019.
alter table lot_constraints add column if not exists manual boolean not null default false;   -- operator override survives the nightly recompute
alter table lot_constraints add column if not exists matures_on date;
alter table funding_needs add column if not exists note text;
alter table funding_needs add column if not exists updated_at timestamptz not null default now();
alter table rebalance_runs add column if not exists objective text;
alter table rebalance_plans add column if not exists simulation jsonb;
alter table rebalance_plans add column if not exists coverage jsonb not null default '[]';
alter table rebalance_plans add column if not exists cash_timeline jsonb not null default '[]';
alter table rebalance_plans add column if not exists note text;
alter table rebalance_moves add column if not exists what text;
alter table rebalance_moves add column if not exists to_alloc_class text;
alter table rebalance_moves add column if not exists executed_ref_type text;
alter table rebalance_moves add column if not exists executed_ref_id uuid;
alter table rebalance_moves add column if not exists executed_on date;
create index if not exists funding_needs_source on funding_needs (family_id, source_type, source_id);
create index if not exists rebalance_moves_plan on rebalance_moves (plan_id, seq);

-- one program per policy scope, owned by the policy's rebalancing clause
insert into rebalance_programs (id, family_id, scope, entity_id, goal_id, policy_id, name, calendar_rrule, band_trigger, drift_threshold_pp, milestone_triggers, need_lookahead_days, large_flow_pct, tax_year_end, constraints, auto_draft) values
('9e000000-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','family',null,null,'9a000000-0000-0000-0000-000000000001','Family policy program','FREQ=MONTHLY;INTERVAL=3;BYMONTHDAY=1',true,null,'[]',120,5,true,'{"min_trade":2000,"max_turnover_pct":15,"avoid_exit_load":true,"respect_lock_in":true,"prefer_new_cash":true,"tax_aware":true,"ltcg_wait_days":45,"settlement_buffer_days":2}',true),
('9e000000-0000-0000-0000-000000000002','11111111-1111-1111-1111-111111111111','goal',null,'77777777-0000-0000-0000-000000000002','9a000000-0000-0000-0000-000000000003','Retirement income floor',null,true,null,'[{"kind":"goal_years_to_go","value":10},{"kind":"goal_years_to_go","value":5},{"kind":"goal_years_to_go","value":3},{"kind":"glide_step"}]',120,10,false,'{"min_trade":2000,"max_turnover_pct":20,"avoid_exit_load":true,"respect_lock_in":true,"prefer_new_cash":true,"tax_aware":true,"ltcg_wait_days":60,"settlement_buffer_days":2}',true),
('9e000000-0000-0000-0000-000000000003','11111111-1111-1111-1111-111111111111','goal',null,'77777777-0000-0000-0000-000000000001','9a000000-0000-0000-0000-000000000004','Daughter''s MBA (2029)',null,true,null,'[{"kind":"goal_years_to_go","value":3},{"kind":"goal_years_to_go","value":1}]',180,10,false,'{"min_trade":1000,"max_turnover_pct":30,"avoid_exit_load":true,"respect_lock_in":true,"prefer_new_cash":true,"tax_aware":true,"ltcg_wait_days":30,"settlement_buffer_days":2}',true);

-- run history for the demo: a calendar run that found nothing, last March's tax year-end run, the MBA milestone run
insert into rebalance_runs (id, family_id, program_id, triggered_by, trigger_detail, run_at, snapshot, drift, status, objective, note) values
('9f000000-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','9e000000-0000-0000-0000-000000000001','calendar','{"scheduled_for":"2026-04-01"}','2026-04-01T02:10:00+05:30','{"total":540000}','{"max_pp":0.6}','no_action','to_band_edge','Quarterly run: every class inside its band'),
('9f000000-0000-0000-0000-000000000002','11111111-1111-1111-1111-111111111111','9e000000-0000-0000-0000-000000000001','tax_year_end','{"fy":"2025-26"}','2026-03-18T02:10:00+05:30','{"total":531000}','{"max_pp":1.4}','completed','needs_plus_bands','Booked ₹9,800 of gains inside the exemption; both moves executed'),
('9f000000-0000-0000-0000-000000000003','11111111-1111-1111-1111-111111111111','9e000000-0000-0000-0000-000000000001','calendar','{"scheduled_for":"2026-07-01"}','2026-07-01T02:10:00+05:30','{"total":552000}','{"max_pp":0.9}','no_action','to_band_edge','Quarterly run: drift 0.9 pp'),
('9f000000-0000-0000-0000-000000000004','11111111-1111-1111-1111-111111111111','9e000000-0000-0000-0000-000000000003','milestone','{"milestone":"goal_years_to_go:3","years_to_go":3}','2026-08-12T02:10:00+05:30','{"total":29000}','{"max_pp":0}','completed','glide_step','Three years to go: the sleeve is already parked in the liquid fund');
insert into rebalance_plans (id, family_id, run_id, version, status, objective, allocation_after, summary, warnings, approved_by, approved_at, created_at) values
('9f100000-0000-0000-0000-000000000002','11111111-1111-1111-1111-111111111111','9f000000-0000-0000-0000-000000000002',1,'converted','needs_plus_bands','[]','{"turnover":9800,"turnover_pct":1.8,"est_tax":0,"est_costs":10,"needs_covered":0,"needs_uncovered":0,"drift_after_max_pp":1.1}','[]','22222222-0000-0000-0000-000000000001','2026-03-19T09:00:00+05:30','2026-03-18T02:10:00+05:30');
update rebalance_runs set plan_id='9f100000-0000-0000-0000-000000000002' where id='9f000000-0000-0000-0000-000000000002';
insert into rebalance_moves (family_id, plan_id, seq, kind, entity_id, from_holding_id, amount, quantity, planned_date, earliest_date, latest_date, settles_on, reason, est_gain, est_tax, est_cost, exit_load, constraints_checked, status, what, executed_on) values
('11111111-1111-1111-1111-111111111111','9f100000-0000-0000-0000-000000000002',1,'sell','33333333-0000-0000-0000-000000000003','46464646-0000-0000-0000-000000000007',7580,2,'2026-03-20','2026-03-18','2026-03-31','2026-03-21','tax year-end: use LTCG exemption',1490,0,8,0,'["lot 2023-05-22 LTCG-eligible ✓","gain within exemption → tax ₹0"]','executed','Sell 2 × Tata Consultancy Services within the LTCG exemption','2026-03-20'),
('11111111-1111-1111-1111-111111111111','9f100000-0000-0000-0000-000000000002',2,'redeem','33333333-0000-0000-0000-000000000002','46464646-0000-0000-0000-000000000002',2220,60,'2026-03-24','2026-03-18','2026-03-31','2026-03-27','tax year-end: use LTCG exemption',110,0,2,0,'["lot 2024-01-10 LTCG-eligible ✓"]','executed','Redeem 60 u Parag Parikh Flexi Cap within the LTCG exemption','2026-03-24');
