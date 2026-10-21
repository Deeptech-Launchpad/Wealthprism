-- 025: balance-sheet completeness and analytics (PRD 3.14, 3.15; FO-90..94, 96..99, 101, 102) — columns, valuation history, demo data
-- Extends the Mehta family consistently: two loans and a credit line, five policies, three lifestyle assets, an operating-business stake,
-- nominations with deliberate gaps, a will overdue for review, the Varaha fund's call / distribution history and a fee ledger.

alter table liabilities add column if not exists ltv_alert_pct numeric(5,2),            -- LTV above this raises a task (loans against securities / property)
                        add column if not exists interest_only boolean not null default false,
                        add column if not exists security_value numeric(18,2),           -- latest value of the security, refreshed by the LTV monitor
                        add column if not exists note text,
                        add column if not exists updated_at timestamptz not null default now();
alter table liability_schedule add column if not exists matched_at timestamptz;
alter table insurance_policies add column if not exists covers_members text[] not null default '{}',   -- health / life: who is covered
                               add column if not exists created_at timestamptz not null default now(),
                               add column if not exists updated_at timestamptz not null default now();
alter table lifestyle_assets add column if not exists created_at timestamptz not null default now(),
                             add column if not exists updated_at timestamptz not null default now();
create table if not exists lifestyle_valuations (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references families(id) on delete cascade,
  asset_id uuid not null references lifestyle_assets(id) on delete cascade,
  valued_on date not null,
  value numeric(18,2) not null,
  source text,
  note text,
  document_id uuid references documents(id),
  unique (asset_id, valued_on)
);
alter table private_investments add column if not exists business_profit numeric(18,2),    -- operating business: latest audited profit
                                add column if not exists business_multiple numeric(6,2),   -- valuation multiple applied to it
                                add column if not exists business_fy text;
alter table nominations add column if not exists note text, add column if not exists created_at timestamptz not null default now();
alter table succession_documents add column if not exists created_at timestamptz not null default now();
alter table reconciliation_items add column if not exists holding_id uuid references holdings(id), add column if not exists bank_account_id uuid references bank_accounts(id), add column if not exists resolution text, add column if not exists source_ref text;
alter table fees_ledger add column if not exists note text;
alter table cashflow_forecast add column if not exists label text;

do $$ begin
  alter table lifestyle_valuations enable row level security; alter table lifestyle_valuations force row level security;
  if not exists (select 1 from pg_policies where tablename='lifestyle_valuations') then
    create policy lifestyle_valuations_tenant on lifestyle_valuations using (family_id = current_setting('app.family_id', true)::uuid) with check (family_id = current_setting('app.family_id', true)::uuid);
  end if;
end $$;
grant select, insert, update, delete on lifestyle_valuations to app_user;
grant select on liabilities, liability_schedule, insurance_policies to executor_user;   -- the executor's readiness checks may cite EMIs and premiums as committed outflows

-- amortisation for the seed: reducing balance, EMI by the standard formula (the API regenerates schedules with the same arithmetic from @fo/finance)
create or replace function seed_amortise(p_liability uuid, p_principal numeric, p_rate numeric, p_months int, p_start date, p_emi_day int, p_paid_until date) returns void language plpgsql as $$
declare r numeric := p_rate / 1200; emi numeric; bal numeric := p_principal; i int; intr numeric; prin numeric; due date;
begin
  if r = 0 then emi := round(p_principal / p_months, 2); else emi := round(p_principal * r * power(1 + r, p_months) / (power(1 + r, p_months) - 1), 2); end if;
  for i in 0..p_months - 1 loop
    due := (date_trunc('month', p_start) + make_interval(months => i + 1))::date + (least(p_emi_day, extract(day from (date_trunc('month', p_start) + make_interval(months => i + 2) - interval '1 day'))::int) - 1);
    intr := round(bal * r, 2); prin := least(bal, round(emi - intr, 2)); if i = p_months - 1 then prin := bal; end if;
    insert into liability_schedule (liability_id, due_date, principal, interest, paid_on) values (p_liability, due, prin, intr, case when due <= p_paid_until then due else null end) on conflict (liability_id, due_date) do nothing;
    bal := round(bal - prin, 2); exit when bal <= 0;
  end loop;
end $$;

-- ---------- demo liabilities ----------
insert into liabilities (id, family_id, entity_id, kind, lender, account_masked, principal_original, outstanding, outstanding_as_of, rate_pct, rate_type, emi, emi_day, start_date, end_date, secured_by_type, secured_by_id, ltv_pct, tax_section, bank_account_id, status, ltv_alert_pct, note)
select 'e1000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', '33333333-0000-0000-0000-000000000002', 'home_loan', 'HDFC Ltd', '••8817', 120000, 113710.25, '2026-09-05', 8.5, 'floating', 1041.39, 5, '2024-03-05', '2044-03-05', 'property', '55555555-0000-0000-0000-000000000001', 23.69, '24b', '89898989-0000-0000-0000-000000000002', 'active', 80, 'Office purchase loan; EMI debited from ICICI ••0928 on the 5th'
where not exists (select 1 from liabilities where id = 'e1000000-0000-0000-0000-000000000001');
insert into liabilities (id, family_id, entity_id, kind, lender, account_masked, principal_original, outstanding, outstanding_as_of, rate_pct, rate_type, emi, emi_day, start_date, end_date, secured_by_type, secured_by_id, ltv_pct, tax_section, bank_account_id, status, ltv_alert_pct, interest_only, note)
select 'e1000000-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111', '33333333-0000-0000-0000-000000000001', 'loan_against_securities', 'Kotak Securities', '••2291', 41000, 41000, '2026-09-01', 10.5, 'floating', null, null, '2026-01-15', null, 'holding', '46464646-0000-0000-0000-000000000001', 56.62, 'none', '89898989-0000-0000-0000-000000000001', 'active', 50, true, 'Overdraft against the pledged HDFC Bank shares; interest debited monthly'
where not exists (select 1 from liabilities where id = 'e1000000-0000-0000-0000-000000000002');
insert into liabilities (id, family_id, entity_id, kind, lender, account_masked, principal_original, outstanding, outstanding_as_of, rate_pct, rate_type, emi, emi_day, start_date, end_date, secured_by_type, secured_by_id, tax_section, bank_account_id, status, note)
select 'e1000000-0000-0000-0000-000000000003', '11111111-1111-1111-1111-111111111111', '33333333-0000-0000-0000-000000000001', 'vehicle_loan', 'HDFC Bank', '••5530', 60000, 24810.14, '2026-09-10', 9, 'fixed', 1245.50, 10, '2023-06-10', '2028-06-10', 'lifestyle_asset', 'e3000000-0000-0000-0000-000000000001', 'none', '89898989-0000-0000-0000-000000000001', 'active', 'Car loan; EMI on the 10th'
where not exists (select 1 from liabilities where id = 'e1000000-0000-0000-0000-000000000003');
select seed_amortise('e1000000-0000-0000-0000-000000000001', 120000, 8.5, 240, '2024-03-05', 5, '2026-08-31');
select seed_amortise('e1000000-0000-0000-0000-000000000003', 60000, 9, 60, '2023-06-10', 10, '2026-08-31');
update liabilities l set outstanding = (select 120000 - coalesce(sum(principal), 0) from liability_schedule s where s.liability_id = l.id and s.paid_on is not null) where l.id = 'e1000000-0000-0000-0000-000000000001';
update liabilities l set outstanding = (select 60000 - coalesce(sum(principal), 0) from liability_schedule s where s.liability_id = l.id and s.paid_on is not null) where l.id = 'e1000000-0000-0000-0000-000000000003';

-- ---------- demo lifestyle assets (before the policies that cover them) ----------
insert into lifestyle_assets (id, family_id, entity_id, kind, name, acquired_on, cost, current_value, valued_on, valuation_source, location, include_in_net_worth, bucket)
select * from (values
  ('e3000000-0000-0000-0000-000000000001'::uuid, '11111111-1111-1111-1111-111111111111'::uuid, '33333333-0000-0000-0000-000000000001'::uuid, 'vehicle'::lifestyle_kind, 'Hyundai Creta (TN 38 CX 4471)', '2023-06-10'::date, 85000::numeric, 52000::numeric, '2026-04-01'::date, 'Insurer IDV', 'Coimbatore', true, 'growth'::bucket),
  ('e3000000-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111', '33333333-0000-0000-0000-000000000003', 'jewellery', 'Gold & diamond jewellery (family set)', '2015-11-12', 60000, 92000, '2026-08-15', 'Jeweller appraisal', 'Bank locker, HDFC Race Course Road', true, 'growth'),
  ('e3000000-0000-0000-0000-000000000003', '11111111-1111-1111-1111-111111111111', '33333333-0000-0000-0000-000000000002', 'art', 'Thota Vaikuntam canvas (1998)', '2019-02-20', 30000, 45000, '2025-12-01', 'Gallery estimate', 'Race Course Road office', false, 'growth')
) v(id, family_id, entity_id, kind, name, acquired_on, cost, current_value, valued_on, valuation_source, location, include_in_net_worth, bucket)
where not exists (select 1 from lifestyle_assets where id = v.id);
insert into lifestyle_valuations (family_id, asset_id, valued_on, value, source)
select '11111111-1111-1111-1111-111111111111', a.id, v.d, v.v, v.s from (values
  ('e3000000-0000-0000-0000-000000000001'::uuid, '2023-06-10'::date, 85000::numeric, 'Invoice'), ('e3000000-0000-0000-0000-000000000001', '2025-04-01', 62000, 'Insurer IDV'), ('e3000000-0000-0000-0000-000000000001', '2026-04-01', 52000, 'Insurer IDV'),
  ('e3000000-0000-0000-0000-000000000002', '2015-11-12', 60000, 'Invoice'), ('e3000000-0000-0000-0000-000000000002', '2026-08-15', 92000, 'Jeweller appraisal'),
  ('e3000000-0000-0000-0000-000000000003', '2019-02-20', 30000, 'Invoice'), ('e3000000-0000-0000-0000-000000000003', '2025-12-01', 45000, 'Gallery estimate')
) v(id, d, v, s) join lifestyle_assets a on a.id = v.id
on conflict (asset_id, valued_on) do nothing;

-- ---------- demo insurance ----------
insert into insurance_policies (id, family_id, entity_id, kind, insurer, policy_no_masked, life_assured, sum_assured, premium, premium_frequency, next_premium_due, start_date, maturity_date, surrender_value, fund_value, covers_type, covers_id, covers_members, nominee, tax_section, status)
select * from (values
  ('e2000000-0000-0000-0000-000000000001'::uuid, '11111111-1111-1111-1111-111111111111'::uuid, '33333333-0000-0000-0000-000000000001'::uuid, 'term_life'::insurance_kind, 'HDFC Life', '••1842', 'Arjun Mehta', 2000000::numeric, 1800::numeric, 'yearly', '2026-10-05'::date, '2019-10-05'::date, '2049-10-05'::date, null::numeric, null::numeric, 'person', null::uuid, array['Arjun Mehta'], 'Priya Mehta', '80C', 'active'),
  ('e2000000-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111', '33333333-0000-0000-0000-000000000001', 'health', 'Star Health', '••7730', 'Family floater', 500000, 2400, 'yearly', '2026-09-28', '2021-09-28', null, null, null, 'person', null, array['Arjun Mehta','Priya Mehta','Aanya Mehta'], 'Priya Mehta', '80D', 'active'),
  ('e2000000-0000-0000-0000-000000000003', '11111111-1111-1111-1111-111111111111', '33333333-0000-0000-0000-000000000002', 'property', 'ICICI Lombard', '••0091', null, 400000, 620, 'yearly', '2027-02-10', '2020-02-10', null, null, null, 'property', '55555555-0000-0000-0000-000000000001', '{}', null, null, 'active'),
  ('e2000000-0000-0000-0000-000000000004', '11111111-1111-1111-1111-111111111111', '33333333-0000-0000-0000-000000000001', 'vehicle', 'Bajaj Allianz', '••6618', null, 52000, 1150, 'yearly', '2026-11-15', '2023-06-12', null, null, null, 'vehicle', 'e3000000-0000-0000-0000-000000000001', '{}', null, null, 'active'),
  ('e2000000-0000-0000-0000-000000000005', '11111111-1111-1111-1111-111111111111', '33333333-0000-0000-0000-000000000003', 'ulip', 'HDFC Life', '••2207', 'Priya Mehta', 250000, 1000, 'yearly', '2027-03-01', '2017-03-01', '2032-03-01', 36200, 38500, 'person', null, array['Priya Mehta'], 'Arjun Mehta', '80C', 'active')
) v(id, family_id, entity_id, kind, insurer, policy_no_masked, life_assured, sum_assured, premium, premium_frequency, next_premium_due, start_date, maturity_date, surrender_value, fund_value, covers_type, covers_id, covers_members, nominee, tax_section, status)
where not exists (select 1 from insurance_policies where id = v.id);
update lifestyle_assets set insured_policy_id = 'e2000000-0000-0000-0000-000000000004' where id = 'e3000000-0000-0000-0000-000000000001' and insured_policy_id is null;

-- ---------- operating business (A5) and the ownership graph (B1) ----------
insert into private_companies (id, family_id, name, sector, website) select '66666666-0000-0000-0000-000000000006', '11111111-1111-1111-1111-111111111111', 'Mehta Textiles LLP', 'Textiles', null
where not exists (select 1 from private_companies where id = '66666666-0000-0000-0000-000000000006');
insert into private_investments (id, family_id, entity_id, company_id, instrument, stage, invested_on, amount, shares_or_units, holding_pct, status, bucket, next_event, business_profit, business_multiple, business_fy)
select '67676767-0000-0000-0000-000000000006', '11111111-1111-1111-1111-111111111111', '33333333-0000-0000-0000-000000000002', '66666666-0000-0000-0000-000000000006', 'operating_business', 'operating', '2012-04-01', 50000, null, 60, 'active', 'income', 'FY 2026-27 audit due Sep 2027', 18000, 4, '2025-26'
where not exists (select 1 from private_investments where id = '67676767-0000-0000-0000-000000000006');
insert into ownership_links (family_id, owner_entity_id, owned_type, owned_id, pct, role, effective_from)
select * from (values
  ('11111111-1111-1111-1111-111111111111'::uuid, '33333333-0000-0000-0000-000000000002'::uuid, 'private_investment', '67676767-0000-0000-0000-000000000006'::uuid, 60::numeric, 'partner', '2012-04-01'::date),
  ('11111111-1111-1111-1111-111111111111', '33333333-0000-0000-0000-000000000001', 'private_investment', '67676767-0000-0000-0000-000000000006', 40, 'partner', '2012-04-01')
) v(family_id, owner_entity_id, owned_type, owned_id, pct, role, effective_from)
on conflict do nothing;

-- ---------- nominations (B3) with deliberate gaps: the Spouse's TCS holding, demat and bank account, the liquid fund, the private stakes carry none ----------
insert into nominations (id, family_id, asset_type, asset_id, nominee_name, nominee_relation, nominee_member_id, share_pct, registered_with, registered_on, verified_on)
select * from (values
  ('e4000000-0000-0000-0000-000000000001'::uuid, '11111111-1111-1111-1111-111111111111'::uuid, 'holding', '46464646-0000-0000-0000-000000000001'::uuid, 'Priya Mehta', 'spouse', '22222222-0000-0000-0000-000000000002'::uuid, 100::numeric, 'depository', '2022-03-10'::date, '2025-01-15'::date),
  ('e4000000-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111', 'bank_account', '89898989-0000-0000-0000-000000000001', 'Priya Mehta', 'spouse', '22222222-0000-0000-0000-000000000002', 100, 'bank', '2019-05-02', '2025-01-15'),
  ('e4000000-0000-0000-0000-000000000003', '11111111-1111-1111-1111-111111111111', 'account', '45454545-0000-0000-0000-000000000004', 'Priya Mehta', 'spouse', '22222222-0000-0000-0000-000000000002', 100, 'AMC', '2021-08-20', null),
  ('e4000000-0000-0000-0000-000000000004', '11111111-1111-1111-1111-111111111111', 'insurance_policy', 'e2000000-0000-0000-0000-000000000001', 'Priya Mehta', 'spouse', '22222222-0000-0000-0000-000000000002', 100, 'insurer', '2019-10-05', '2019-10-05'),
  ('e4000000-0000-0000-0000-000000000005', '11111111-1111-1111-1111-111111111111', 'insurance_policy', 'e2000000-0000-0000-0000-000000000005', 'Arjun Mehta', 'spouse', '22222222-0000-0000-0000-000000000001', 100, 'insurer', '2017-03-01', '2017-03-01'),
  ('e4000000-0000-0000-0000-000000000006', '11111111-1111-1111-1111-111111111111', 'property', '55555555-0000-0000-0000-000000000002', 'Priya Mehta', 'spouse', '22222222-0000-0000-0000-000000000002', 100, 'registrar', '2020-01-20', null),
  ('e4000000-0000-0000-0000-000000000007', '11111111-1111-1111-1111-111111111111', 'bank_account', '89898989-0000-0000-0000-000000000004', 'Priya Mehta', 'spouse', '22222222-0000-0000-0000-000000000002', 100, 'bank', '2019-05-02', '2025-01-15')
) v(id, family_id, asset_type, asset_id, nominee_name, nominee_relation, nominee_member_id, share_pct, registered_with, registered_on, verified_on)
where not exists (select 1 from nominations where id = v.id);
insert into succession_documents (id, family_id, entity_id, kind, executed_on, executor, witnesses, storage_location, review_due, note)
select * from (values
  ('e5000000-0000-0000-0000-000000000001'::uuid, '11111111-1111-1111-1111-111111111111'::uuid, '33333333-0000-0000-0000-000000000001'::uuid, 'will', '2021-06-01'::date, 'Priya Mehta', 'R. Subramanian, K. Natarajan', 'HDFC Bank locker, Race Course Road', '2026-06-01'::date, 'Registered will; leaves the Saibaba Colony apartment to Aanya — review after the Ooty land purchase'),
  ('e5000000-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111', '33333333-0000-0000-0000-000000000002', 'huf_deed', '2008-01-15', 'Arjun Mehta (karta)', null, 'CA office', '2028-01-15', 'HUF declaration deed; members Arjun, Priya, Aanya')
) v(id, family_id, entity_id, kind, executed_on, executor, witnesses, storage_location, review_due, note)
where not exists (select 1 from succession_documents where id = v.id);

-- ---------- Varaha fund cash flows (C7) and the fee ledger (C8) ----------
insert into fund_cashflows (id, family_id, private_investment_id, flow_date, kind, amount, forecast, source)
select * from (values
  ('e6000000-0000-0000-0000-000000000001'::uuid, '11111111-1111-1111-1111-111111111111'::uuid, '67676767-0000-0000-0000-000000000005'::uuid, '2024-04-14'::date, 'call', 40000::numeric, false, 'capital call notice 1'),
  ('e6000000-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111', '67676767-0000-0000-0000-000000000005', '2024-10-14', 'call', 40000, false, 'capital call notice 2'),
  ('e6000000-0000-0000-0000-000000000003', '11111111-1111-1111-1111-111111111111', '67676767-0000-0000-0000-000000000005', '2025-04-14', 'call', 40000, false, 'capital call notice 3'),
  ('e6000000-0000-0000-0000-000000000004', '11111111-1111-1111-1111-111111111111', '67676767-0000-0000-0000-000000000005', '2026-02-10', 'distribution', 9000, false, 'partial exit — portfolio company B')
) v(id, family_id, private_investment_id, flow_date, kind, amount, forecast, source)
where not exists (select 1 from fund_cashflows where id = v.id);
insert into fees_ledger (id, family_id, entity_id, fee_date, kind, instrument_id, account_id, amount, source, note)
select * from (values
  ('e7000000-0000-0000-0000-000000000001'::uuid, '11111111-1111-1111-1111-111111111111'::uuid, '33333333-0000-0000-0000-000000000001'::uuid, '2026-05-12'::date, 'brokerage', '44444444-0000-0000-0000-000000000001'::uuid, '45454545-0000-0000-0000-000000000001'::uuid, 42::numeric, 'contract_note', 'Zerodha — HDFC Bank buy'),
  ('e7000000-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111', '33333333-0000-0000-0000-000000000001', '2026-05-12', 'stt', '44444444-0000-0000-0000-000000000001', '45454545-0000-0000-0000-000000000001', 28, 'contract_note', 'STT on the same trade'),
  ('e7000000-0000-0000-0000-000000000003', '11111111-1111-1111-1111-111111111111', '33333333-0000-0000-0000-000000000001', '2026-06-30', 'pms_mgmt', (select id from instruments where name like 'Marcellus%' limit 1), null, 93.75, 'pms_statement', 'Q1 FY27 management fee (1.5% p.a.)'),
  ('e7000000-0000-0000-0000-000000000004', '11111111-1111-1111-1111-111111111111', '33333333-0000-0000-0000-000000000002', '2026-06-30', 'aif_mgmt', (select id from instruments where name like 'Neo Special%' limit 1), null, 43.75, 'aif_statement', 'Q1 FY27 management fee (1.75% p.a.)'),
  ('e7000000-0000-0000-0000-000000000005', '11111111-1111-1111-1111-111111111111', '33333333-0000-0000-0000-000000000001', '2026-04-15', 'advisor', null, null, 1500, 'invoice', 'Annual planning retainer — S. Krishnan'),
  ('e7000000-0000-0000-0000-000000000006', '11111111-1111-1111-1111-111111111111', '33333333-0000-0000-0000-000000000003', '2026-07-03', 'dp_charges', null, '45454545-0000-0000-0000-000000000003', 18, 'ledger', 'ICICI Direct DP charges')
) v(id, family_id, entity_id, fee_date, kind, instrument_id, account_id, amount, source, note)
where not exists (select 1 from fees_ledger where id = v.id);

-- instrument attributes for exposure (C3): geography / currency / country sit on instruments; look-through tables in meta for the funds
update instruments set meta = coalesce(meta, '{}'::jsonb) || '{"lookthrough":[{"alloc_class":"equity","country":"IN","sector":"Diversified","pct":66},{"alloc_class":"equity","country":"US","sector":"Technology","pct":28},{"alloc_class":"cash","country":"IN","pct":6}]}'::jsonb where name like 'Parag Parikh%' and (meta->'lookthrough') is null;
update instruments set meta = coalesce(meta, '{}'::jsonb) || '{"lookthrough":[{"alloc_class":"equity","country":"IN","sector":"Diversified","pct":92},{"alloc_class":"cash","country":"IN","pct":8}]}'::jsonb where name like 'Axis Small Cap%' and (meta->'lookthrough') is null;
update instruments set meta = coalesce(meta, '{}'::jsonb) || '{"lookthrough":[{"alloc_class":"arbitrage","country":"IN","pct":70},{"alloc_class":"debt","country":"IN","pct":30}]}'::jsonb where name like 'Kotak Equity Arbitrage%' and (meta->'lookthrough') is null;
insert into instrument_attributes (instrument_id, as_of, sector, market_cap_band, credit_rating, issuer, manager, liquidity_class, expense_ratio_pct, modified_duration, source)
select i.id, '2026-09-01', v.sector, v.cap, v.rating, v.issuer, v.manager, v.liq, v.ter, v.dur, 'seed' from (values
  ('Kotak Equity Arbitrage Fund - Direct Growth', null, null, null, null, 'Kotak AMC', 't1', 0.40, 0.20),
  ('Marcellus Consistent Compounders PMS', 'Diversified', 'large', null, null, 'Marcellus', 'quarterly', 1.50, null)
) v(name, sector, cap, rating, issuer, manager, liq, ter, dur) join instruments i on i.name = v.name
on conflict (instrument_id, as_of) do nothing;
