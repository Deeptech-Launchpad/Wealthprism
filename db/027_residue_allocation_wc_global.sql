-- Milestone 13: residue rows — allocation policy demo, deployment plans, FX rates, LRS / foreign tax credit demo, LRS parameters as data.

alter table deployment_plans add column if not exists entity_id uuid references entities(id);
alter table deployment_plans add column if not exists created_by uuid references users(id);
alter table deployment_plans add column if not exists tasked_at timestamptz;
alter table deployment_plans add column if not exists note text;

alter table lrs_remittances add column if not exists note text;
alter table lrs_remittances add column if not exists created_at timestamptz not null default now();
alter table foreign_tax_credits add column if not exists note text;
alter table foreign_tax_credits add column if not exists created_at timestamptz not null default now();
alter table allocation_policies add column if not exists updated_at timestamptz not null default now();
alter table model_portfolios add column if not exists created_at timestamptz not null default now();

-- LRS is regulation data, not a constant in code: annual limit (USD), TCS threshold and rate on remittances for investment
insert into tax_params (fy, regime, code, value, notes)
select v.fy, v.regime::tax_regime, v.code, v.value, v.notes from (values
  ('2026-27','new','LRS_LIMIT_USD',250000,'Liberalised Remittance Scheme annual limit per resident individual'), ('2026-27','old','LRS_LIMIT_USD',250000,'Liberalised Remittance Scheme annual limit per resident individual'),
  ('2026-27','new','LRS_TCS_THRESHOLD_INR',1000000,'TCS applies above this aggregate in the FY'), ('2026-27','old','LRS_TCS_THRESHOLD_INR',1000000,'TCS applies above this aggregate in the FY'),
  ('2026-27','new','LRS_TCS_RATE_PCT',20,'TCS on remittances for overseas investment above the threshold'), ('2026-27','old','LRS_TCS_RATE_PCT',20,'TCS on remittances for overseas investment above the threshold')
) v(fy, regime, code, value, notes)
where not exists (select 1 from tax_params t where t.fy = v.fy and t.regime = v.regime::tax_regime and t.code = v.code);

-- demo: the family follows the Moderate model with a half-yearly review that falls due inside the next 30 days
insert into allocation_policies (family_id, strategy, model_portfolio_id, review_every_months, next_review_on, rebalance_trigger_pp, include_self_occupied, include_epf_ppf)
select '11111111-1111-1111-1111-111111111111', 'strategic', (select id from model_portfolios where family_id is null and code = 'moderate'), 6, '2026-10-01', 5, false, true
where not exists (select 1 from allocation_policies where family_id = '11111111-1111-1111-1111-111111111111');
update holdings set core_satellite = 'satellite' where family_id = '11111111-1111-1111-1111-111111111111' and instrument_id in (select id from instruments where type in ('pms','aif')) and core_satellite = 'core';
update wc_settings set instrument_prefs = '{"instruments":{"overnight_fund":"ICICI Prudential Overnight Fund - Direct Growth","liquid_fund":"ICICI Prudential Liquid Fund - Direct Growth","arbitrage_fund":"Kotak Equity Arbitrage Fund - Direct Growth","bank_fd":"HDFC Bank fixed deposit","target_maturity_debt":"SBI 7.72% 2033 Bond"},"yields":{"overnight_fund":6.2,"liquid_fund":6.8,"arbitrage_fund":7.1,"bank_fd":7.0,"target_maturity_debt":7.4}}'::jsonb
where family_id = '11111111-1111-1111-1111-111111111111' and (instrument_prefs is null or instrument_prefs = '{}'::jsonb);

-- FX reference rates (global table, no family): INR per unit of currency
insert into fx_rates (ccy, rate_date, rate_inr, source) values
('USD','2026-09-10',83.2100,'rbi'),('USD','2026-09-11',83.2600,'rbi'),('EUR','2026-09-11',91.4200,'rbi'),('GBP','2026-09-11',106.1800,'rbi'),('AED','2026-09-11',22.6600,'rbi'),('SGD','2026-09-11',62.0500,'rbi')
on conflict do nothing;

-- demo: Arjun's LRS remittance for a US brokerage funding and the withholding tax on US dividends
insert into lrs_remittances (id, family_id, entity_id, fy, remitted_on, ccy, amount_ccy, amount_inr, purpose, tcs_collected, note)
select 'f1000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', '33333333-0000-0000-0000-000000000001', '2026-27', '2026-06-15', 'USD', 25000, 2080000, 'overseas_investment', 216000, 'US brokerage funding; TCS on the amount above the threshold'
where not exists (select 1 from lrs_remittances where id = 'f1000000-0000-0000-0000-000000000001');
insert into foreign_tax_credits (id, family_id, entity_id, fy, country, income_type, income_inr, foreign_tax_inr, dtaa_article, form67_filed_on, note)
select 'f2000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', '33333333-0000-0000-0000-000000000001', '2026-27', 'US', 'dividend', 42000, 10500, 'Article 10', null, 'US-listed ETF dividends, 25% withheld'
where not exists (select 1 from foreign_tax_credits where id = 'f2000000-0000-0000-0000-000000000001');

-- member invitations (FO-11 residue): a one-time token, accepted with a password like the external-viewer flow
alter table family_members add column if not exists invite_token_hash text;
alter table family_members add column if not exists invite_expires_on date;
create or replace function member_invite_lookup(p_email citext, p_token_hash text)
returns table (id uuid, user_id uuid, family_id uuid)
language sql security definer set search_path = public stable as $$
  select m.id, m.user_id, m.family_id from family_members m join users u on u.id = m.user_id
  where u.email = p_email and m.invite_token_hash = p_token_hash and m.invite_expires_on >= current_date and m.accepted_at is null limit 1
$$;
revoke all on function member_invite_lookup(citext, text) from public;
grant execute on function member_invite_lookup(citext, text) to app_user;
-- hand-entered transactions carry their own source label
alter type txn_source add value if not exists 'manual';
