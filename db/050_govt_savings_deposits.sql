-- Government savings, round 1: SCSS, NSC and KVP are fixed deposits with the government's own rules, so they use the deposit engine (schedule of expected
-- payments, maturity task, bank-statement matching, closed list). deposit_types gains what a scheme fixes: how interest compounds, the rate in force (a starting
-- value the user may change, since the government resets it every quarter) and a note saying where to check it. The tenure is fixed by min = max tenure.
alter table deposit_types add column if not exists compounding text not null default 'quarterly' check (compounding in ('quarterly','yearly'));
alter table deposit_types add column if not exists default_rate_pct numeric(5,2);
alter table deposit_types add column if not exists rate_note text;
alter table deposit_types add column if not exists govt_scheme boolean not null default false;

insert into deposit_types (code, kind, label, description, break_rule, lock_in_months, default_penalty_pct, default_payout, default_tds, min_tenure_months, max_tenure_months, partial_withdrawal, sort, compounding, default_rate_pct, rate_note, govt_scheme) values
 ('scss', 'fd', 'Senior Citizen Savings Scheme (SCSS)', 'For people aged 60 and over (55 if retired early). One deposit up to ₹30 lakh for 5 years. Interest is paid every quarter. It can be closed after 1 year with a small deduction: 1.5% of the deposit in year 2, 1% after that.', 'after_lock_in', 12, 1.50, 'quarterly', true, 60, 60, false, 80, 'quarterly', 8.20, 'The government sets this rate every quarter. 8.2% is a recent rate; check the current one on indiapost.gov.in before you save.', true),
 ('nsc',  'fd', 'National Savings Certificate (NSC)', 'A 5-year certificate from the post office. Interest builds up every year and is paid once, at maturity. It cannot be closed early (only on death or by a court order).', 'never', 60, 0.00, 'at_maturity', false, 60, 60, false, 85, 'yearly', 7.70, 'The government sets this rate every quarter. 7.7% is a recent rate; check the current one on indiapost.gov.in before you save. The rate of the quarter you buy in stays for the full 5 years.', true),
 ('kvp',  'fd', 'Kisan Vikas Patra (KVP)', 'A post office certificate that doubles your money in about 115 months (9 years 7 months). Interest builds up every year and is paid once, at maturity. It can be encashed early only after 2½ years.', 'after_lock_in', 30, 0.00, 'at_maturity', false, 115, 115, false, 86, 'yearly', 7.50, 'The government sets this rate every quarter, and the time to double changes with it. 7.5% (115 months) is a recent setting; check the current one on indiapost.gov.in before you save.', true)
on conflict (code) do nothing;

-- the Add asset catalogue: the three are now live and open the deposit form with the type chosen
alter table asset_types add column if not exists deposit_type_code text references deposit_types(code);
insert into asset_types (code, category, label, description, alloc_class, default_bucket, counts_in_net_worth, enabled, fields, sort) values
 ('kvp', 'savings', 'Kisan Vikas Patra', 'A post office certificate that doubles in about 115 months.', 'debt', 'income', true, false, '[]', 65)
on conflict (code) do nothing;
update asset_types set enabled = true, deposit_type_code = code where code in ('scss','nsc','kvp');
update asset_types set label = 'NSC (National Savings Certificate)', description = 'A 5-year post office certificate. Interest builds up every year and is paid at maturity.' where code = 'nsc';
update asset_types set label = 'SCSS (Senior Citizen Savings Scheme)' where code = 'scss';
