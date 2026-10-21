-- Family Office — development seed. Matches the clickable prototype (Arjun Mehta family).
-- Run AFTER 001_init.sql as the DB owner:  psql "$DATABASE_URL" -f db/002_seed.sql
-- Amounts in rupees. Password for all users: "Prototype!2026" (bcrypt hash below, cost 10).

begin;
set local app.family_id = '11111111-1111-1111-1111-111111111111';

insert into families (id, name, ingest_address) values
('11111111-1111-1111-1111-111111111111','Mehta Family','mehta-7f3a@ingest.familyoffice.local');

insert into users (id, email, name, password_hash, mfa_enabled) values
('22222222-0000-0000-0000-000000000001','arjun@example.com','Arjun Mehta','$2b$10$9qzR2wY6b1o0Z5nq3e8wIuq1R3f0oV9a7D8kK5m3sJ2hT4gL6pN7e',false),
('22222222-0000-0000-0000-000000000002','priya@example.com','Priya Mehta','$2b$10$9qzR2wY6b1o0Z5nq3e8wIuq1R3f0oV9a7D8kK5m3sJ2hT4gL6pN7e',false),
('22222222-0000-0000-0000-000000000003','ops@example.com','Rohan Iyer (Operator)','$2b$10$9qzR2wY6b1o0Z5nq3e8wIuq1R3f0oV9a7D8kK5m3sJ2hT4gL6pN7e',false),
('22222222-0000-0000-0000-000000000004','ca@example.com','S. Krishnan (CA)','$2b$10$9qzR2wY6b1o0Z5nq3e8wIuq1R3f0oV9a7D8kK5m3sJ2hT4gL6pN7e',false);

insert into family_members (family_id, user_id, role, accepted_at) values
('11111111-1111-1111-1111-111111111111','22222222-0000-0000-0000-000000000001','owner',now()),
('11111111-1111-1111-1111-111111111111','22222222-0000-0000-0000-000000000002','member',now()),
('11111111-1111-1111-1111-111111111111','22222222-0000-0000-0000-000000000003','operator',now()),
('11111111-1111-1111-1111-111111111111','22222222-0000-0000-0000-000000000004','viewer',now());

-- entities: E1 Arjun (Individual), E2 Mehta HUF, E3 Spouse (Individual)
insert into entities (id, family_id, type, name, pan_last4, tax_regime, slab_rate) values
('33333333-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','individual','Arjun Mehta','123A','new',30),
('33333333-0000-0000-0000-000000000002','11111111-1111-1111-1111-111111111111','huf','Mehta HUF','456H','old',30),
('33333333-0000-0000-0000-000000000003','11111111-1111-1111-1111-111111111111','individual','Spouse (Individual)','789K','new',30);

insert into entity_gstins (id, family_id, entity_id, gstin, state_code, registered_on) values
('34343434-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','33333333-0000-0000-0000-000000000002','33AAAAA1234H1Z5','33','2022-04-01'),
('34343434-0000-0000-0000-000000000002','11111111-1111-1111-1111-111111111111','33333333-0000-0000-0000-000000000003','33ABBBB5678K1Z2','33','2023-01-15');

-- instruments
insert into instruments (id, type, isin, symbol, name, amfi_code, exchange, default_bucket, asset_class) values
('44444444-0000-0000-0000-000000000001','stock','INE040A01034','HDFCBANK','HDFC Bank',null,'NSE','growth','equity'),
('44444444-0000-0000-0000-000000000002','stock','INE467B01029','TCS','Tata Consultancy Services',null,'NSE','growth','equity'),
('44444444-0000-0000-0000-000000000003','mf',null,null,'Parag Parikh Flexi Cap Fund - Direct Growth','122639',null,'growth','equity'),
('44444444-0000-0000-0000-000000000004','pms',null,null,'Marcellus Consistent Compounders PMS',null,null,'growth','equity'),
('44444444-0000-0000-0000-000000000005','aif',null,null,'Neo Special Credit AIF (Cat II)',null,null,'income','debt_mf_post_apr23'),
('44444444-0000-0000-0000-000000000006','bond','INE062A08157','SBI7.72%2033','SBI 7.72% 2033 Bond',null,'NSE','income','listed_bond'),
('44444444-0000-0000-0000-000000000007','mf',null,null,'ICICI Prudential Liquid Fund - Direct Growth','120598',null,'liquidity','debt_mf_post_apr23'),
('44444444-0000-0000-0000-000000000008','mf',null,null,'Axis Small Cap Fund - Direct Growth','125354',null,'growth','equity'),
('44444444-0000-0000-0000-000000000009','mf',null,null,'Kotak Equity Arbitrage Fund - Direct Growth','119809',null,'liquidity','arbitrage_fund');

-- accounts
insert into accounts (id, family_id, entity_id, kind, provider, identifier_masked) values
('45454545-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','33333333-0000-0000-0000-000000000001','demat','Zerodha','1208****4471'),
('45454545-0000-0000-0000-000000000002','11111111-1111-1111-1111-111111111111','33333333-0000-0000-0000-000000000002','mf_folio','CAMS','9182****/12'),
('45454545-0000-0000-0000-000000000003','11111111-1111-1111-1111-111111111111','33333333-0000-0000-0000-000000000003','demat','ICICI Direct','1301****7715'),
('45454545-0000-0000-0000-000000000004','11111111-1111-1111-1111-111111111111','33333333-0000-0000-0000-000000000001','mf_folio','KFintech','5566****/33');

-- holdings (values scaled to prototype: cost/value in rupees)
insert into holdings (id, family_id, entity_id, account_id, instrument_id, quantity, avg_cost, bucket) values
('46464646-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','33333333-0000-0000-0000-000000000001','45454545-0000-0000-0000-000000000001','44444444-0000-0000-0000-000000000001',42,1471.43,'growth'),
('46464646-0000-0000-0000-000000000002','11111111-1111-1111-1111-111111111111','33333333-0000-0000-0000-000000000002','45454545-0000-0000-0000-000000000002','44444444-0000-0000-0000-000000000003',382.10,37.16,'growth'),
('46464646-0000-0000-0000-000000000003','11111111-1111-1111-1111-111111111111','33333333-0000-0000-0000-000000000001',null,'44444444-0000-0000-0000-000000000004',1,25000,'growth'),
('46464646-0000-0000-0000-000000000004','11111111-1111-1111-1111-111111111111','33333333-0000-0000-0000-000000000002',null,'44444444-0000-0000-0000-000000000005',1,10000,'income'),
('46464646-0000-0000-0000-000000000005','11111111-1111-1111-1111-111111111111','33333333-0000-0000-0000-000000000003','45454545-0000-0000-0000-000000000003','44444444-0000-0000-0000-000000000006',15,1000,'income'),
('46464646-0000-0000-0000-000000000006','11111111-1111-1111-1111-111111111111','33333333-0000-0000-0000-000000000001','45454545-0000-0000-0000-000000000004','44444444-0000-0000-0000-000000000007',81.12,345.17,'liquidity'),
('46464646-0000-0000-0000-000000000007','11111111-1111-1111-1111-111111111111','33333333-0000-0000-0000-000000000003','45454545-0000-0000-0000-000000000003','44444444-0000-0000-0000-000000000002',9,3044.44,'growth');

insert into lots (family_id, holding_id, buy_date, quantity, remaining_qty, unit_cost, charges) values
('11111111-1111-1111-1111-111111111111','46464646-0000-0000-0000-000000000001','2022-03-14',21,21,1471.43,12),
('11111111-1111-1111-1111-111111111111','46464646-0000-0000-0000-000000000001','2026-08-28',21,21,0,0),          -- bonus 1:1
('11111111-1111-1111-1111-111111111111','46464646-0000-0000-0000-000000000002','2024-01-10',200,200,35.10,0),
('11111111-1111-1111-1111-111111111111','46464646-0000-0000-0000-000000000002','2025-06-10',182.10,182.10,39.42,0),
('11111111-1111-1111-1111-111111111111','46464646-0000-0000-0000-000000000005','2024-01-09',15,15,1000,0),
('11111111-1111-1111-1111-111111111111','46464646-0000-0000-0000-000000000006','2026-07-01',81.12,81.12,345.17,0),
('11111111-1111-1111-1111-111111111111','46464646-0000-0000-0000-000000000007','2023-05-22',9,9,3044.44,8);

insert into prices (instrument_id, price_date, close, source) values
('44444444-0000-0000-0000-000000000001','2026-09-10',1723.81,'nse_bhavcopy'),
('44444444-0000-0000-0000-000000000002','2026-09-10',3788.89,'nse_bhavcopy'),
('44444444-0000-0000-0000-000000000003','2026-09-10',55.22,'amfi'),
('44444444-0000-0000-0000-000000000006','2026-09-10',1020.00,'nse_bhavcopy'),
('44444444-0000-0000-0000-000000000007','2026-09-10',358.72,'amfi');

-- auto_apply (added later by 016_market_data.sql) is set true for the bonus row in that migration — its
-- auto_apply column does not exist yet at this point in a fresh install's migration order.
insert into corporate_actions (instrument_id, type, ex_date, ratio_num, ratio_den, status, source) values
('44444444-0000-0000-0000-000000000001','bonus','2026-08-28',1,1,'applied','nse'),
('44444444-0000-0000-0000-000000000002','dividend','2026-08-14',null,null,'applied','nse');

-- realized gains (FY 2026-27 YTD, scaled)
insert into realized_gains (family_id, entity_id, instrument_id, fy, buy_date, sell_date, quantity, cost, proceeds, gain, term, asset_class, tax_rate_applied) values
('11111111-1111-1111-1111-111111111111','33333333-0000-0000-0000-000000000001','44444444-0000-0000-0000-000000000002','2026-27','2022-02-12','2026-07-04',3,5100,6200,1100,'long','equity',12.5),
('11111111-1111-1111-1111-111111111111','33333333-0000-0000-0000-000000000002','44444444-0000-0000-0000-000000000008','2026-27','2025-11-02','2026-08-18',41.2,4800,4600,-200,'short','equity',20),
('11111111-1111-1111-1111-111111111111','33333333-0000-0000-0000-000000000003','44444444-0000-0000-0000-000000000006','2026-27','2024-01-09','2026-08-22',5,50000,51400,1400,'long','listed_bond',12.5);

-- ---------- real estate ----------
insert into properties (id, family_id, type, name, address, acquisition_date, acquisition_cost, stamp_duty, registration) values
('55555555-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','commercial','Race Course Road office, Coimbatore','{"city":"Coimbatore","state":"TN"}','2016-06-20',310000,21700,3100),
('55555555-0000-0000-0000-000000000002','11111111-1111-1111-1111-111111111111','residential','Saibaba Colony apartment','{"city":"Coimbatore","state":"TN"}','2019-02-11',140000,9800,1400),
('55555555-0000-0000-0000-000000000003','11111111-1111-1111-1111-111111111111','commercial','Anna Nagar retail unit, Chennai','{"city":"Chennai","state":"TN"}','2020-11-05',260000,18200,2600),
('55555555-0000-0000-0000-000000000004','11111111-1111-1111-1111-111111111111','land','Ooty farmland (12 acres)','{"city":"Ooty","state":"TN"}','2012-08-30',60000,4200,600);

insert into property_owners values
('55555555-0000-0000-0000-000000000001','33333333-0000-0000-0000-000000000002',100),
('55555555-0000-0000-0000-000000000002','33333333-0000-0000-0000-000000000001',100),
('55555555-0000-0000-0000-000000000003','33333333-0000-0000-0000-000000000003',100),
('55555555-0000-0000-0000-000000000004','33333333-0000-0000-0000-000000000002',100);

insert into property_valuations (property_id, valued_on, value, source) values
('55555555-0000-0000-0000-000000000001','2026-04-01',480000,'Registered valuer'),
('55555555-0000-0000-0000-000000000002','2026-04-01',190000,'Market estimate'),
('55555555-0000-0000-0000-000000000003','2026-04-01',360000,'Registered valuer'),
('55555555-0000-0000-0000-000000000004','2026-04-01',130000,'Guideline value');

insert into tenants (id, family_id, name, phone, type) values
('56565656-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','Kovai Analytics Pvt Ltd','+91 98400 00001','company'),
('56565656-0000-0000-0000-000000000002','11111111-1111-1111-1111-111111111111','R. Sundaram','+91 98400 00002','individual'),
('56565656-0000-0000-0000-000000000003','11111111-1111-1111-1111-111111111111','Bloom Pharmacy','+91 98400 00003','company');

insert into leases (id, family_id, property_id, tenant_id, entity_gstin_id, start_date, end_date, rent, due_day, escalation_pct, escalation_every_months, deposit, gst_applicable, tds_applicable) values
('57575757-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','55555555-0000-0000-0000-000000000001','56565656-0000-0000-0000-000000000001','34343434-0000-0000-0000-000000000001','2025-03-01','2028-02-29',2850,1,5,12,17100,true,true),
('57575757-0000-0000-0000-000000000002','11111111-1111-1111-1111-111111111111','55555555-0000-0000-0000-000000000002','56565656-0000-0000-0000-000000000002',null,'2024-09-01','2027-08-31',420,5,5,12,2520,false,false),
('57575757-0000-0000-0000-000000000003','11111111-1111-1111-1111-111111111111','55555555-0000-0000-0000-000000000003','56565656-0000-0000-0000-000000000003','34343434-0000-0000-0000-000000000002','2023-12-01','2026-11-30',1650,3,8,12,9900,true,true);

insert into rent_schedule (family_id, lease_id, period_month, expected_rent, expected_gst, expected_tds, due_date, received_amount, received_on, status) values
('11111111-1111-1111-1111-111111111111','57575757-0000-0000-0000-000000000001','2026-09-01',2850,513,285,'2026-09-01',3078,'2026-09-01','received'),
('11111111-1111-1111-1111-111111111111','57575757-0000-0000-0000-000000000003','2026-09-01',1650,297,165,'2026-09-03',1782,'2026-09-03','received'),
('11111111-1111-1111-1111-111111111111','57575757-0000-0000-0000-000000000002','2026-09-01',420,0,0,'2026-09-05',0,null,'overdue'),
('11111111-1111-1111-1111-111111111111','57575757-0000-0000-0000-000000000001','2026-08-01',2850,513,285,'2026-08-01',3078,'2026-08-01','received'),
('11111111-1111-1111-1111-111111111111','57575757-0000-0000-0000-000000000003','2026-08-01',1650,297,165,'2026-08-03',1782,'2026-08-04','received'),
('11111111-1111-1111-1111-111111111111','57575757-0000-0000-0000-000000000002','2026-08-01',420,0,0,'2026-08-05',420,'2026-08-06','received');

insert into property_taxes (family_id, property_id, authority, assessment_no, period, amount, due_date, paid_on, status) values
('11111111-1111-1111-1111-111111111111','55555555-0000-0000-0000-000000000001','Coimbatore City Municipal Corporation','CCMC/RC/1182','2026-27 H1',482,'2026-09-30','2026-09-09','paid'),
('11111111-1111-1111-1111-111111111111','55555555-0000-0000-0000-000000000002','Coimbatore City Municipal Corporation','CCMC/SB/4471','2026-27 H1',114,'2026-09-30',null,'due'),
('11111111-1111-1111-1111-111111111111','55555555-0000-0000-0000-000000000003','Greater Chennai Corporation','GCC/AN/77210','2026-27 H1',360,'2026-10-15',null,'due'),
('11111111-1111-1111-1111-111111111111','55555555-0000-0000-0000-000000000004','Ooty Municipality','OM/L/0093','2026-27',32,'2026-04-30','2026-04-12','paid');

insert into property_expenses (family_id, property_id, expense_date, category, vendor, amount, note) values
('11111111-1111-1111-1111-111111111111','55555555-0000-0000-0000-000000000003','2026-08-22','repair','Cool Care Services',385,'AC compressor replacement'),
('11111111-1111-1111-1111-111111111111','55555555-0000-0000-0000-000000000002','2026-08-12','society','SBC Owners Assn',144,'Society maintenance Q2'),
('11111111-1111-1111-1111-111111111111','55555555-0000-0000-0000-000000000001','2026-08-02','maintenance','Safeguard Systems',220,'Fire safety AMC');

insert into gst_returns (family_id, entity_gstin_id, period_month, form, taxable_value, tax_amount, due_date, filed_on, status) values
('11111111-1111-1111-1111-111111111111','34343434-0000-0000-0000-000000000001','2026-08-01','gstr1',2850,513,'2026-09-11','2026-09-10','filed'),
('11111111-1111-1111-1111-111111111111','34343434-0000-0000-0000-000000000001','2026-08-01','gstr3b',2850,513,'2026-09-20',null,'due'),
('11111111-1111-1111-1111-111111111111','34343434-0000-0000-0000-000000000002','2026-08-01','gstr1',1650,297,'2026-09-11','2026-09-10','filed'),
('11111111-1111-1111-1111-111111111111','34343434-0000-0000-0000-000000000002','2026-08-01','gstr3b',1650,297,'2026-09-20',null,'due');

-- ---------- private investments ----------
insert into private_companies (id, family_id, name, sector) values
('66666666-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','Cropsense AgriTech','AgriTech'),
('66666666-0000-0000-0000-000000000002','11111111-1111-1111-1111-111111111111','Lumen Diagnostics','HealthTech'),
('66666666-0000-0000-0000-000000000003','11111111-1111-1111-1111-111111111111','Threadline Commerce','D2C'),
('66666666-0000-0000-0000-000000000004','11111111-1111-1111-1111-111111111111','Orbital Logistics','Logistics'),
('66666666-0000-0000-0000-000000000005','11111111-1111-1111-1111-111111111111','Varaha Angel Fund II','AIF Cat I');

insert into private_investments (id, family_id, entity_id, company_id, instrument, stage, invested_on, amount, shares_or_units, holding_pct, valuation_cap, discount_pct, status, next_event) values
('67676767-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','33333333-0000-0000-0000-000000000001','66666666-0000-0000-0000-000000000001','ccps','Series A','2023-06-15',50000,120,1.8,null,null,'active','Series B talks, Q4 2026'),
('67676767-0000-0000-0000-000000000002','11111111-1111-1111-1111-111111111111','33333333-0000-0000-0000-000000000002','66666666-0000-0000-0000-000000000002','safe_post','Seed','2025-01-20',25000,null,null,4000000,20,'unconverted','Priced round expected Mar 2027'),
('67676767-0000-0000-0000-000000000003','11111111-1111-1111-1111-111111111111','33333333-0000-0000-0000-000000000001','66666666-0000-0000-0000-000000000003','equity','Pre-seed','2022-11-14',15000,320,3.2,null,null,'active','Secondary offer received'),
('67676767-0000-0000-0000-000000000004','11111111-1111-1111-1111-111111111111','33333333-0000-0000-0000-000000000001','66666666-0000-0000-0000-000000000004','ccd','Seed','2021-08-03',30000,null,null,null,null,'written_off','Wound up, loss claimed'),
('67676767-0000-0000-0000-000000000005','11111111-1111-1111-1111-111111111111','33333333-0000-0000-0000-000000000002','66666666-0000-0000-0000-000000000005','fund_units','AIF Cat I','2024-02-01',120000,1200,null,null,null,'active','Drawdown 4 of 6 due Oct');

insert into private_rounds (company_id, round_name, closed_on, pre_money, raised, post_money, total_shares_post, price_per_share) values
('66666666-0000-0000-0000-000000000001','Seed','2023-06-15',180000,25000,205000,6667,30.75),
('66666666-0000-0000-0000-000000000001','Series A','2025-02-10',620000,150000,770000,7640,100.79);

insert into private_marks (private_investment_id, marked_on, value, basis) values
('67676767-0000-0000-0000-000000000001','2025-02-10',121000,'last_round'),
('67676767-0000-0000-0000-000000000002','2025-01-20',25000,'manual'),
('67676767-0000-0000-0000-000000000003','2026-08-30',42000,'manual'),
('67676767-0000-0000-0000-000000000004','2025-12-31',0,'manual'),
('67676767-0000-0000-0000-000000000005','2026-06-30',139000,'nav');

insert into fund_commitments (private_investment_id, total_commitment, drawn, schedule) values
('67676767-0000-0000-0000-000000000005',160000,120000,'[{"due":"2026-10-14","amount":20000},{"due":"2027-04-14","amount":20000}]');

-- ---------- goals & buckets ----------
insert into bucket_targets (family_id, liquidity_pct, income_pct, growth_pct) values ('11111111-1111-1111-1111-111111111111',8,32,60);

insert into goals (id, family_id, entity_id, name, target_year, amount_today, bucket, funded_pct) values
('77777777-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','33333333-0000-0000-0000-000000000001','Daughter''s overseas MBA',2029,160000,'income',68),
('77777777-0000-0000-0000-000000000002','11111111-1111-1111-1111-111111111111','33333333-0000-0000-0000-000000000002','Retirement income floor',2036,950000,'income',54),
('77777777-0000-0000-0000-000000000003','11111111-1111-1111-1111-111111111111','33333333-0000-0000-0000-000000000003','Second home, Kodaikanal',2031,320000,'growth',31),
('77777777-0000-0000-0000-000000000004','11111111-1111-1111-1111-111111111111','33333333-0000-0000-0000-000000000001','Emergency & contingency',2026,60000,'liquidity',100),
('77777777-0000-0000-0000-000000000005','11111111-1111-1111-1111-111111111111','33333333-0000-0000-0000-000000000002','Philanthropy endowment',2040,500000,'growth',12);

insert into glide_paths (family_id, goal_id, steps) values
('11111111-1111-1111-1111-111111111111','77777777-0000-0000-0000-000000000002','[{"year":2026,"growth_pct":60},{"year":2028,"growth_pct":58},{"year":2030,"growth_pct":55},{"year":2032,"growth_pct":50},{"year":2034,"growth_pct":45},{"year":2036,"growth_pct":40}]');

-- ---------- banking ----------
insert into aa_consents (id, family_id, entity_id, provider, consent_handle, status, granted_on, expires_on) values
('88888888-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','33333333-0000-0000-0000-000000000001','finvu','ch_demo_arjun','active','2026-01-10','2027-01-10'),
('88888888-0000-0000-0000-000000000002','11111111-1111-1111-1111-111111111111','33333333-0000-0000-0000-000000000002','finvu','ch_demo_huf','active','2026-01-10','2027-01-10'),
('88888888-0000-0000-0000-000000000003','11111111-1111-1111-1111-111111111111','33333333-0000-0000-0000-000000000003','finvu','ch_demo_spouse','active','2026-02-02','2027-02-02');

insert into bank_accounts (id, family_id, entity_id, bank, account_masked, type, aa_consent_id, balance, balance_as_of, sync_mode, card_due_day) values
('89898989-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','33333333-0000-0000-0000-000000000001','HDFC Bank','••4471','savings','88888888-0000-0000-0000-000000000001',21485,'2026-09-11 10:41+05:30','aa',null),
('89898989-0000-0000-0000-000000000002','11111111-1111-1111-1111-111111111111','33333333-0000-0000-0000-000000000002','ICICI Bank','••0928','current','88888888-0000-0000-0000-000000000002',18623,'2026-09-11 10:41+05:30','aa',null),
('89898989-0000-0000-0000-000000000003','11111111-1111-1111-1111-111111111111','33333333-0000-0000-0000-000000000003','Kotak Bank','••7715','savings','88888888-0000-0000-0000-000000000003',9342,'2026-09-11 10:32+05:30','aa',null),
('89898989-0000-0000-0000-000000000004','11111111-1111-1111-1111-111111111111','33333333-0000-0000-0000-000000000001','HDFC Infinia','••3320','card','88888888-0000-0000-0000-000000000001',-1846,'2026-09-11 10:41+05:30','aa',18),
('89898989-0000-0000-0000-000000000005','11111111-1111-1111-1111-111111111111','33333333-0000-0000-0000-000000000002','SBI','••1102','savings',null,4120,'2026-09-04','csv',null);

insert into bank_txns (family_id, bank_account_id, txn_date, narration, amount, category_id, link_type, hash, source) values
('11111111-1111-1111-1111-111111111111','89898989-0000-0000-0000-000000000002','2026-09-11','NEFT KOVAI ANALYTICS PVT LTD RENT SEP',2565,(select id from categories where name='Rental income' and family_id is null),'rent','h001','aa'),
('11111111-1111-1111-1111-111111111111','89898989-0000-0000-0000-000000000001','2026-09-11','UPI/APOLLO PHARMACY/PAY',-32.40,(select id from categories where name='Medical' and family_id is null),'none','h002','aa'),
('11111111-1111-1111-1111-111111111111','89898989-0000-0000-0000-000000000001','2026-09-10','ACH C- HDFC BANK LTD DIV',798,(select id from categories where name='Dividend' and family_id is null),'dividend','h003','aa'),
('11111111-1111-1111-1111-111111111111','89898989-0000-0000-0000-000000000002','2026-09-10','ACH D- PPFAS MF SIP',-2000,(select id from categories where name='Investment / SIP' and family_id is null),'sip','h004','aa'),
('11111111-1111-1111-1111-111111111111','89898989-0000-0000-0000-000000000004','2026-09-09','TAJ COROMANDEL CHENNAI',-186.50,(select id from categories where name='Dining' and family_id is null),'none','h005','aa'),
('11111111-1111-1111-1111-111111111111','89898989-0000-0000-0000-000000000002','2026-09-09','BILLDESK CCMC PROPERTY TAX',-482,(select id from categories where name='Property tax' and family_id is null),'property_tax','h006','aa'),
('11111111-1111-1111-1111-111111111111','89898989-0000-0000-0000-000000000003','2026-09-08','NACH SBI BOND INTEREST',579,(select id from categories where name='Interest' and family_id is null),'interest','h007','aa');

insert into categorisation_rules (family_id, pattern, category_id, link_type, link_id, priority) values
('11111111-1111-1111-1111-111111111111','KOVAI ANALYTICS',(select id from categories where name='Rental income' and family_id is null),'rent','57575757-0000-0000-0000-000000000001',10),
('11111111-1111-1111-1111-111111111111','BLOOM PHARMACY',(select id from categories where name='Rental income' and family_id is null),'rent','57575757-0000-0000-0000-000000000003',10),
('11111111-1111-1111-1111-111111111111','PPFAS MF',(select id from categories where name='Investment / SIP' and family_id is null),'sip','46464646-0000-0000-0000-000000000002',20),
('11111111-1111-1111-1111-111111111111','PROPERTY TAX',(select id from categories where name='Property tax' and family_id is null),'property_tax',null,30);

-- ---------- working capital & tasks ----------
insert into wc_settings (family_id) values ('11111111-1111-1111-1111-111111111111');

insert into committed_outflows (family_id, entity_id, kind, label, due_date, amount, recurring_months) values
('11111111-1111-1111-1111-111111111111','33333333-0000-0000-0000-000000000002','drawdown','Varaha Fund II drawdown 4/6','2026-10-14',20000,null),
('11111111-1111-1111-1111-111111111111',null,'advance_tax','Advance tax Q2 (all entities)','2026-09-15',9400,null),
('11111111-1111-1111-1111-111111111111',null,'gst','GSTR-3B liability Aug','2026-09-20',810,null),
('11111111-1111-1111-1111-111111111111','33333333-0000-0000-0000-000000000001','manual','School fees, term 2','2026-10-01',3200,null),
('11111111-1111-1111-1111-111111111111',null,'sip','Household + SIPs','2026-10-01',5900,1);

insert into deployment_plans (family_id, excess_amount, lines, status) values
('11111111-1111-1111-1111-111111111111',31000,'[
 {"instrument":"overnight_fund","entity_id":"33333333-0000-0000-0000-000000000001","amount":4000,"reason":"buffer to 7 days","gross":6.3,"post_tax":4.4},
 {"instrument":"liquid_fund","entity_id":"33333333-0000-0000-0000-000000000002","amount":7000,"reason":"advance tax on 15 Dec","gross":6.9,"post_tax":4.8},
 {"instrument":"arbitrage_fund","entity_id":"33333333-0000-0000-0000-000000000001","amount":14000,"reason":"6-12 months, equity taxation","gross":7.1,"post_tax":5.7},
 {"instrument":"tbill_91","entity_id":"33333333-0000-0000-0000-000000000002","amount":6000,"reason":"Varaha drawdown 14 Oct","gross":6.7,"post_tax":4.7}]','proposed');

insert into tasks (family_id, entity_id, module, title, reason, amount, due_date, status, verification, severity) values
('11111111-1111-1111-1111-111111111111','33333333-0000-0000-0000-000000000001','real_estate','Saibaba Colony rent overdue 6 days — send reminder to R. Sundaram','Rent due 5 Sep not received',420,'2026-09-11','open','na',1),
('11111111-1111-1111-1111-111111111111',null,'working_capital','Deploy Rs 31,000 idle cash per plan','Idle across HDFC and ICICI for 34 days',31000,'2026-09-12','open','pending',2),
('11111111-1111-1111-1111-111111111111','33333333-0000-0000-0000-000000000003','real_estate','Renew Anna Nagar lease with 8% escalation','Lease expires 30 Nov 2026',null,'2026-10-30','open','na',1),
('11111111-1111-1111-1111-111111111111','33333333-0000-0000-0000-000000000002','goals','Move Rs 18,000 from Parag Parikh Flexi Cap to ICICI Liquid Fund','Liquidity bucket 1.8 pp under target',18000,'2026-09-15','open','pending',2),
('11111111-1111-1111-1111-111111111111','33333333-0000-0000-0000-000000000003','investments','Book LTCG of Rs 1,250 in TCS before 31 Mar','Use LTCG exemption',1250,'2027-03-31','open','pending',3),
('11111111-1111-1111-1111-111111111111','33333333-0000-0000-0000-000000000002','startups','Varaha Angel Fund II drawdown 4/6','Rs 20,000 due',20000,'2026-10-14','open','pending',2),
('11111111-1111-1111-1111-111111111111',null,'real_estate','File GSTR-3B for Aug (2 GSTINs)','Due 20 Sep',810,'2026-09-20','open','na',2);

-- documents folders (system)
insert into folders (family_id, name, system) select '11111111-1111-1111-1111-111111111111', n, true from unnest(array['Property deeds & agreements','Tax filings (ITR, GST)','PMS / AIF statements','Startup SHAs & term sheets','Bank statements','Insurance policies','Wills & nominations','CA correspondence']) n;

commit;
