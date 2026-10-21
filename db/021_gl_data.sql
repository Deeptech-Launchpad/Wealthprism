-- Family Office — General ledger data (FO-47, 62, 63, 110..119). Apply after 020.
-- Unposted queue, extra system posting rules (bank categories, realised gains, deposits, PMS/AIF/gold/REIT buys, cash-basis rent),
-- books for the three demo entities with quarterly periods, HUF member capital, a recurring CA-fee journal.

create table if not exists gl_unposted (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references families(id) on delete cascade,
  entity_id uuid not null references entities(id) on delete cascade,
  event_type text not null,
  source_type text not null,
  source_id uuid not null,
  event_date date not null,
  amount numeric(18,2),
  reason text not null,                          -- no_rule | account_missing | period_locked | unbalanced | error:<message>
  detail jsonb not null default '{}',
  created_at timestamptz not null default now(),
  unique (entity_id, source_type, source_id)
);
alter table gl_unposted enable row level security; alter table gl_unposted force row level security;
create policy gl_unposted_tenant on gl_unposted using (family_id = current_setting('app.family_id', true)::uuid) with check (family_id = current_setting('app.family_id', true)::uuid);
grant select, insert, update, delete on gl_unposted to app_user;
alter table gl_journals add column if not exists reason text;
alter table gl_recurring add column if not exists last_run date;
alter table gl_recurring add column if not exists narration text;
alter table gl_tally_sync add column if not exists xml text;
create index if not exists gl_lines_journal on gl_lines (journal_id);
create index if not exists gl_journals_source on gl_journals (entity_id, source_type, source_id);

-- system rules: refine the expense split and add the rest of the event types (data, not code)
update gl_posting_rules set lines = '[{"side":"debit","account_code":"5120|5130|1320","amount":"amount"},{"side":"credit","account_code":"1110|2220","amount":"amount"}]' where family_id is null and event_type = 'property_expense';
update gl_posting_rules set lines = '[{"side":"debit","account_code":"1110","amount":"net_proceeds"},{"side":"debit","account_code":"5210","amount":"charges"},{"side":"credit","account_code":"1210","amount":"cost_of_lots_sold"},{"side":"credit","account_code":"4400|4410","amount":"gain_by_term"}]' where family_id is null and event_type = 'investment_txn.sell' and instrument_class = 'equity';
insert into gl_posting_rules (event_type, instrument_class, basis, lines) values
('investment_txn.buy','pms',null,'[{"side":"debit","account_code":"1230","amount":"cost_incl_charges"},{"side":"credit","account_code":"1110","amount":"net_paid"}]'),
('investment_txn.buy','aif',null,'[{"side":"debit","account_code":"1240","amount":"cost_incl_charges"},{"side":"credit","account_code":"1110","amount":"net_paid"}]'),
('investment_txn.buy','gold',null,'[{"side":"debit","account_code":"1270","amount":"cost_incl_charges"},{"side":"credit","account_code":"1110","amount":"net_paid"}]'),
('investment_txn.buy','reit',null,'[{"side":"debit","account_code":"1280","amount":"cost_incl_charges"},{"side":"credit","account_code":"1110","amount":"net_paid"}]'),
('investment_txn.buy','liquid',null,'[{"side":"debit","account_code":"1130","amount":"cost_incl_charges"},{"side":"credit","account_code":"1110","amount":"net_paid"}]'),
('investment_txn.sell','mf',null,'[{"side":"debit","account_code":"1110","amount":"net_proceeds"},{"side":"debit","account_code":"5210","amount":"charges"},{"side":"credit","account_code":"1220","amount":"cost_of_lots_sold"},{"side":"credit","account_code":"4400|4410","amount":"gain_by_term"}]'),
('investment_txn.sell','debt',null,'[{"side":"debit","account_code":"1110","amount":"net_proceeds"},{"side":"debit","account_code":"5210","amount":"charges"},{"side":"credit","account_code":"1250","amount":"cost_of_lots_sold"},{"side":"credit","account_code":"4400|4410","amount":"gain_by_term"}]'),
('investment_txn.sell','liquid',null,'[{"side":"debit","account_code":"1110","amount":"net_proceeds"},{"side":"credit","account_code":"1130","amount":"cost_of_lots_sold"},{"side":"credit","account_code":"4400|4410","amount":"gain_by_term"}]'),
('investment_txn.redemption','liquid',null,'[{"side":"debit","account_code":"1110","amount":"net_proceeds"},{"side":"credit","account_code":"1130","amount":"cost_of_lots_sold"},{"side":"credit","account_code":"4400|4410","amount":"gain_by_term"}]'),
('investment_txn.switch_out','mf',null,'[{"side":"debit","account_code":"1110","amount":"net_proceeds"},{"side":"credit","account_code":"1220","amount":"cost_of_lots_sold"},{"side":"credit","account_code":"4400|4410","amount":"gain_by_term"}]'),
('investment_txn.switch_in','mf',null,'[{"side":"debit","account_code":"1220","amount":"amount"},{"side":"credit","account_code":"1110","amount":"amount"}]'),
('investment_txn.maturity','debt',null,'[{"side":"debit","account_code":"1110","amount":"net_proceeds"},{"side":"credit","account_code":"1250","amount":"cost_of_lots_sold"},{"side":"credit","account_code":"4300","amount":"gain_by_term"}]'),
('realized_gain','equity',null,'[{"side":"debit","account_code":"1110","amount":"net_proceeds"},{"side":"credit","account_code":"1210|1220","amount":"cost_of_lots_sold"},{"side":"credit","account_code":"4400|4410","amount":"gain_by_term"}]'),
('realized_gain','debt',null,'[{"side":"debit","account_code":"1110","amount":"net_proceeds"},{"side":"credit","account_code":"1250","amount":"cost_of_lots_sold"},{"side":"credit","account_code":"4400|4410","amount":"gain_by_term"}]'),
('rent.received',null,'cash','[{"side":"debit","account_code":"1110","amount":"received"},{"side":"debit","account_code":"1420","amount":"tds"},{"side":"credit","account_code":"4100","amount":"rent"},{"side":"credit","account_code":"2240","amount":"gst"}]'),
('rent.deposit_received',null,null,'[{"side":"debit","account_code":"1110","amount":"amount"},{"side":"credit","account_code":"2230","amount":"amount"}]'),
('rent.deposit_refunded',null,null,'[{"side":"debit","account_code":"2230","amount":"amount"},{"side":"credit","account_code":"1110","amount":"amount"}]'),
('private.invested',null,null,'[{"side":"debit","account_code":"1295","amount":"amount"},{"side":"credit","account_code":"1110","amount":"amount"}]'),
('bank_txn.dining',null,null,'[{"side":"debit","account_code":"5500","amount":"amount"},{"side":"credit","account_code":"1110","amount":"amount"}]'),
('bank_txn.medical',null,null,'[{"side":"debit","account_code":"5500","amount":"amount"},{"side":"credit","account_code":"1110","amount":"amount"}]'),
('bank_txn.travel',null,null,'[{"side":"debit","account_code":"5500","amount":"amount"},{"side":"credit","account_code":"1110","amount":"amount"}]'),
('bank_txn.education',null,null,'[{"side":"debit","account_code":"5500","amount":"amount"},{"side":"credit","account_code":"1110","amount":"amount"}]'),
('bank_txn.maintenance',null,null,'[{"side":"debit","account_code":"5120","amount":"amount"},{"side":"credit","account_code":"1110","amount":"amount"}]'),
('bank_txn.insurance_premium',null,null,'[{"side":"debit","account_code":"5400","amount":"amount"},{"side":"credit","account_code":"1110","amount":"amount"}]'),
('bank_txn.tax_payment',null,null,'[{"side":"debit","account_code":"1430","amount":"amount"},{"side":"credit","account_code":"1110","amount":"amount"}]'),
('bank_txn.gst_payment',null,null,'[{"side":"debit","account_code":"2240","amount":"amount"},{"side":"credit","account_code":"1110","amount":"amount"}]'),
('bank_txn.property_tax',null,null,'[{"side":"debit","account_code":"5110","amount":"amount"},{"side":"credit","account_code":"1110","amount":"amount"}]'),
('bank_txn.emi',null,null,'[{"side":"debit","account_code":"2110|2120|2130","amount":"principal"},{"side":"debit","account_code":"5300","amount":"interest"},{"side":"credit","account_code":"1110","amount":"emi"}]'),
('bank_txn.card_payment',null,null,'[{"side":"debit","account_code":"2210","amount":"amount"},{"side":"credit","account_code":"1110","amount":"amount"}]'),
('bank_txn.investment_sip',null,null,'[{"side":"debit","account_code":"1220","amount":"amount"},{"side":"credit","account_code":"1110","amount":"amount"}]'),
('bank_txn.dividend',null,null,'[{"side":"debit","account_code":"1110","amount":"amount"},{"side":"credit","account_code":"4200","amount":"amount"}]'),
('bank_txn.interest',null,null,'[{"side":"debit","account_code":"1110","amount":"amount"},{"side":"credit","account_code":"4300","amount":"amount"}]'),
('bank_txn.rental_income',null,null,'[{"side":"debit","account_code":"1110","amount":"amount"},{"side":"credit","account_code":"4100","amount":"amount"}]'),
('bank_txn.salary_fees',null,null,'[{"side":"debit","account_code":"1110","amount":"amount"},{"side":"credit","account_code":"4500","amount":"amount"}]'),
('bank_txn.other_income',null,null,'[{"side":"debit","account_code":"1110","amount":"amount"},{"side":"credit","account_code":"4900","amount":"amount"}]'),
('bank_txn.redemption',null,null,'[{"side":"debit","account_code":"1110","amount":"amount"},{"side":"credit","account_code":"1220","amount":"amount"}]'),
('inter_entity.reimbursement',null,null,'[{"side":"debit","account_code":"1460","amount":"amount","entity":"giver"},{"side":"credit","account_code":"1110","amount":"amount","entity":"giver"},{"side":"debit","account_code":"1110","amount":"amount","entity":"receiver"},{"side":"credit","account_code":"2280","amount":"amount","entity":"receiver"}]'),
('inter_entity.shared_expense',null,null,'[{"side":"debit","account_code":"5990","amount":"share","entity":"giver"},{"side":"debit","account_code":"1460","amount":"other_share","entity":"giver"},{"side":"credit","account_code":"1110","amount":"amount","entity":"giver"},{"side":"debit","account_code":"5990","amount":"other_share","entity":"receiver"},{"side":"credit","account_code":"2280","amount":"other_share","entity":"receiver"}]')
on conflict do nothing;

-- books for the demo entities (accrual, FY from April 2026, quarterly periods); the HUF has two member capital accounts
insert into gl_books (entity_id, family_id, basis, books_start_date, maker_checker) values
('33333333-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','accrual','2026-04-01',false),
('33333333-0000-0000-0000-000000000002','11111111-1111-1111-1111-111111111111','accrual','2026-04-01',false),
('33333333-0000-0000-0000-000000000003','11111111-1111-1111-1111-111111111111','accrual','2026-04-01',false)
on conflict (entity_id) do nothing;
insert into gl_accounts (family_id, entity_id, code, name, type, parent_code, is_group, is_system, tax_head, tally_ledger_name, tally_parent_group)
select '11111111-1111-1111-1111-111111111111', e.id, t.code, t.name, t.type, t.parent_code, t.is_group, t.is_system, t.tax_head, t.name, t.tally_parent_group
from gl_accounts t cross join (values ('33333333-0000-0000-0000-000000000001'::uuid),('33333333-0000-0000-0000-000000000002'::uuid),('33333333-0000-0000-0000-000000000003'::uuid)) e(id)
where t.family_id is null and not exists (select 1 from gl_accounts x where x.entity_id=e.id and x.code=t.code);
insert into gl_periods (family_id, entity_id, fy, period_start, period_end)
select '11111111-1111-1111-1111-111111111111', e.id, '2026-27', q.s, q.e from (values ('33333333-0000-0000-0000-000000000001'::uuid),('33333333-0000-0000-0000-000000000002'::uuid),('33333333-0000-0000-0000-000000000003'::uuid)) e(id)
cross join (values ('2026-04-01'::date,'2026-06-30'::date),('2026-07-01','2026-09-30'),('2026-10-01','2026-12-31'),('2027-01-01','2027-03-31')) q(s,e)
on conflict do nothing;
insert into gl_partner_capital (family_id, entity_id, partner_entity_id, partner_name, capital_account_id, profit_share_pct)
select '11111111-1111-1111-1111-111111111111', '33333333-0000-0000-0000-000000000002', p.pe, p.name, a.id, p.pct
from (values ('33333333-0000-0000-0000-000000000001'::uuid,'Arjun Mehta (karta)',60.0),(null::uuid,'Priya Mehta',40.0)) p(pe,name,pct)
join gl_accounts a on a.entity_id='33333333-0000-0000-0000-000000000002' and a.code='3110'
on conflict do nothing;
insert into gl_recurring (family_id, entity_id, name, rrule, template, next_run, narration)
select '11111111-1111-1111-1111-111111111111','33333333-0000-0000-0000-000000000002','CA retainer — accrual','FREQ=MONTHLY;BYMONTHDAY=1',
 '[{"account_code":"5700","debit":150},{"account_code":"2220","credit":150}]','2026-05-01','CA retainer accrued'
where not exists (select 1 from gl_recurring where entity_id='33333333-0000-0000-0000-000000000002' and name='CA retainer — accrual');
alter table gl_books add column if not exists strict_reconciliation boolean not null default false;   -- when true, locking a period also needs every bank account reconciled
