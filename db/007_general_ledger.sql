-- Family Office — General Ledger: entity books, chart of accounts, double-entry journals, posting rules,
-- sub-ledger links, periods and locks, inter-entity, partner capital, Tally sync.
-- Apply after 006.

create type gl_account_type as enum ('asset','liability','equity','income','expense');
create type gl_basis as enum ('accrual','cash');
create type journal_status as enum ('draft','posted','reversed');
create type journal_source as enum ('auto','manual','recurring','opening','closing','tally_import','reversal');
create type period_status as enum ('open','soft_closed','locked');

-- ---------- chart of accounts ----------
-- System template (family_id null, entity_id null) is copied into each entity's book on creation; families can add accounts.
create table gl_accounts (
  id uuid primary key default gen_random_uuid(),
  family_id uuid references families(id) on delete cascade,     -- null = system template
  entity_id uuid references entities(id) on delete cascade,     -- null = family/system template row
  code text not null,                                           -- hierarchical: 1000, 1100, 1110 ...
  name text not null,
  type gl_account_type not null,
  parent_code text,
  is_group boolean not null default false,
  is_system boolean not null default false,                     -- protected; posting rules depend on it
  tax_head text,                                                -- salary | house_property | business | capital_gains | other_sources | null (maps GL to ITR heads)
  tally_ledger_name text,                                       -- name used in Tally
  tally_parent_group text,
  currency char(3) not null default 'INR',
  active boolean not null default true,
  family_key uuid generated always as (coalesce(family_id,'00000000-0000-0000-0000-000000000000'::uuid)) stored,
  entity_key uuid generated always as (coalesce(entity_id,'00000000-0000-0000-0000-000000000000'::uuid)) stored,
  unique (family_key, entity_key, code)
);

-- ---------- books & periods ----------
create table gl_books (
  entity_id uuid primary key references entities(id) on delete cascade,
  family_id uuid not null references families(id) on delete cascade,
  basis gl_basis not null default 'accrual',
  fy_start_month smallint not null default 4,
  books_start_date date not null,
  mark_to_market boolean not null default false,               -- post unrealised gains/losses at period end
  depreciation boolean not null default false,                  -- for business entities
  maker_checker boolean not null default false,
  default_bank_account_id uuid references bank_accounts(id)
);
create table gl_periods (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references families(id) on delete cascade,
  entity_id uuid not null references entities(id) on delete cascade,
  fy text not null,
  period_start date not null,
  period_end date not null,
  status period_status not null default 'open',
  closed_by uuid references users(id),
  closed_at timestamptz,
  unique (entity_id, period_start)
);

-- ---------- journals ----------
create table gl_journals (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references families(id) on delete cascade,
  entity_id uuid not null references entities(id),
  journal_no bigint not null,                                    -- sequential per entity per FY
  fy text not null,
  entry_date date not null,
  source journal_source not null,
  source_type text,                                              -- investment_txn | bank_txn | rent_schedule | property_expense | property_tax | fee | private_flow | liability_schedule | insurance_premium | corporate_action | valuation | manual ...
  source_id uuid,
  narration text not null,
  status journal_status not null default 'posted',
  posted_by uuid references users(id),
  approved_by uuid references users(id),                         -- when maker_checker
  reversed_by_journal_id uuid references gl_journals(id),
  reverses_journal_id uuid references gl_journals(id),
  intercompany_group uuid,                                       -- links mirrored entries across entities
  tally_voucher_guid text,
  created_at timestamptz not null default now(),
  unique (entity_id, fy, journal_no),
  unique (entity_id, source_type, source_id)                     -- one auto journal per source event (reversals excluded by source_type suffix)
);
create index on gl_journals (family_id, entity_id, entry_date);

create table gl_lines (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references families(id) on delete cascade,
  journal_id uuid not null references gl_journals(id) on delete cascade,
  line_no smallint not null,
  account_id uuid not null references gl_accounts(id),
  debit numeric(18,2) not null default 0,
  credit numeric(18,2) not null default 0,
  ccy char(3) not null default 'INR',
  amount_ccy numeric(18,2),                                       -- original currency amount for foreign assets
  fx_rate numeric(12,6),
  sub_ledger_type text,                                           -- holding | property | bank_account | tenant | liability | private_investment | goal | vendor
  sub_ledger_id uuid,
  cost_centre text,
  narration text,
  check (debit >= 0 and credit >= 0 and not (debit > 0 and credit > 0)),
  unique (journal_id, line_no)
);
create index on gl_lines (account_id);
create index on gl_lines (sub_ledger_type, sub_ledger_id);

-- balanced-journal enforcement (deferred check via trigger at statement end)
create or replace function gl_check_balanced() returns trigger language plpgsql as $$
declare d numeric; c numeric; jid uuid;
begin
  jid := coalesce(new.journal_id, old.journal_id);
  select coalesce(sum(debit),0), coalesce(sum(credit),0) into d, c from gl_lines where journal_id = jid;
  if d <> c then raise exception 'journal % not balanced: debit % credit %', jid, d, c; end if;
  return null;
end $$;
create constraint trigger gl_lines_balanced after insert or update or delete on gl_lines
  deferrable initially deferred for each row execute function gl_check_balanced();

-- posted journals are immutable: block updates/deletes except status → reversed
create or replace function gl_journal_immutable() returns trigger language plpgsql as $$
begin
  if old.status = 'posted' and (tg_op = 'DELETE' or new.status not in ('posted','reversed') or new.entry_date <> old.entry_date or new.entity_id <> old.entity_id) then
    raise exception 'posted journal % is immutable; post a reversal', old.id;
  end if;
  if tg_op = 'DELETE' then return old; end if; return new;
end $$;
create trigger gl_journals_immutable before update or delete on gl_journals for each row execute function gl_journal_immutable();

-- period lock enforcement
create or replace function gl_check_period_open() returns trigger language plpgsql as $$
declare st period_status;
begin
  select status into st from gl_periods where entity_id = new.entity_id and new.entry_date between period_start and period_end;
  if st = 'locked' then raise exception 'period locked for entity % on %', new.entity_id, new.entry_date; end if;
  return new;
end $$;
create trigger gl_journals_period before insert on gl_journals for each row execute function gl_check_period_open();

-- ---------- posting rules ----------
create table gl_posting_rules (
  id uuid primary key default gen_random_uuid(),
  family_id uuid references families(id) on delete cascade,     -- null = system default
  event_type text not null,                                     -- e.g. investment_txn.buy, investment_txn.sell, investment_txn.dividend, bank_txn.category:<name>, rent.received, rent.accrued, property_expense, property_tax, fee.brokerage, liability.emi, insurance.premium, private.capital_call, private.distribution, valuation.mtm, corporate_action.bonus ...
  instrument_class text,                                        -- optional filter: equity | debt | mf | pms | aif | real_estate | foreign ...
  basis gl_basis,                                               -- optional: rule applies only to books of this basis
  lines jsonb not null,                                         -- [{"side":"debit","account_code":"1210","amount":"gross"},{"side":"credit","account_code":"1110","amount":"net"},{"side":"credit","account_code":"2410","amount":"tds"}]
  priority int not null default 100,
  active boolean not null default true,
  family_key uuid generated always as (coalesce(family_id,'00000000-0000-0000-0000-000000000000'::uuid)) stored,
  class_key text generated always as (coalesce(instrument_class,'')) stored,
  basis_key text generated always as (case basis when 'accrual' then 'accrual' when 'cash' then 'cash' else '' end) stored,
  unique (family_key, event_type, class_key, basis_key)
);

-- ---------- opening balances, recurring, partner capital, tally ----------
create table gl_opening_balances (
  family_id uuid not null references families(id) on delete cascade,
  entity_id uuid not null references entities(id) on delete cascade,
  account_id uuid not null references gl_accounts(id),
  as_of date not null,
  debit numeric(18,2) not null default 0,
  credit numeric(18,2) not null default 0,
  sub_ledger_type text, sub_ledger_id uuid,
  sub_key uuid generated always as (coalesce(sub_ledger_id,'00000000-0000-0000-0000-000000000000'::uuid)) stored,
  primary key (entity_id, account_id, as_of, sub_key)
);

create table gl_recurring (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references families(id) on delete cascade,
  entity_id uuid not null references entities(id),
  name text not null,
  rrule text not null,
  template jsonb not null,                                      -- journal lines template
  next_run date,
  active boolean not null default true
);

create table gl_partner_capital (                                -- LLP / partnership / HUF member capital accounts
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references families(id) on delete cascade,
  entity_id uuid not null references entities(id),              -- the LLP / firm / HUF
  partner_entity_id uuid references entities(id),
  partner_name text not null,
  capital_account_id uuid not null references gl_accounts(id),
  profit_share_pct numeric(6,3) not null,
  unique (entity_id, partner_name)
);

create table gl_tally_sync (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references families(id) on delete cascade,
  entity_id uuid not null references entities(id),
  direction text not null,                                      -- export | import
  fy text not null,
  from_date date, to_date date,
  file_document_id uuid references documents(id),
  vouchers int default 0,
  status text not null default 'queued',
  log jsonb not null default '[]',
  created_at timestamptz not null default now()
);

-- balances view (materialised nightly + on demand)
create materialized view gl_balances as
select l.family_id, j.entity_id, j.fy, l.account_id,
       sum(l.debit) as debit, sum(l.credit) as credit, sum(l.debit) - sum(l.credit) as balance
from gl_lines l join gl_journals j on j.id = l.journal_id
where j.status = 'posted'
group by l.family_id, j.entity_id, j.fy, l.account_id;
create unique index on gl_balances (entity_id, fy, account_id);

-- RLS
do $$ declare t text; begin
  foreach t in array array['gl_books','gl_periods','gl_journals','gl_lines','gl_opening_balances','gl_recurring','gl_partner_capital','gl_tally_sync'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format($p$create policy %I_tenant on %I using (family_id = current_setting('app.family_id', true)::uuid) with check (family_id = current_setting('app.family_id', true)::uuid)$p$, t, t);
  end loop; end $$;
alter table gl_accounts enable row level security;
create policy gl_accounts_tenant on gl_accounts using (family_id is null or family_id = current_setting('app.family_id', true)::uuid) with check (family_id = current_setting('app.family_id', true)::uuid);
alter table gl_posting_rules enable row level security;
create policy gl_posting_rules_tenant on gl_posting_rules using (family_id is null or family_id = current_setting('app.family_id', true)::uuid) with check (family_id = current_setting('app.family_id', true)::uuid);
grant select, insert, update, delete on gl_accounts, gl_books, gl_periods, gl_journals, gl_lines, gl_posting_rules, gl_opening_balances, gl_recurring, gl_partner_capital, gl_tally_sync to app_user;
grant select on gl_balances to app_user;

-- ---------- system chart of accounts template (Indian family office; Tally-compatible groups) ----------
insert into gl_accounts (code, name, type, parent_code, is_group, is_system, tax_head, tally_parent_group) values
('1000','Assets','asset',null,true,true,null,null),
('1100','Bank & cash','asset','1000',true,true,null,'Bank Accounts'),
('1110','Bank accounts','asset','1100',false,true,null,'Bank Accounts'),
('1120','Cash in hand','asset','1100',false,true,null,'Cash-in-Hand'),
('1130','Liquid & overnight funds','asset','1100',false,true,null,'Investments'),
('1200','Investments','asset','1000',true,true,null,'Investments'),
('1210','Listed equity','asset','1200',false,true,null,'Investments'),
('1220','Mutual funds','asset','1200',false,true,null,'Investments'),
('1230','PMS','asset','1200',false,true,null,'Investments'),
('1240','AIF','asset','1200',false,true,null,'Investments'),
('1250','Bonds, G-Secs, T-bills','asset','1200',false,true,null,'Investments'),
('1260','Fixed & recurring deposits','asset','1200',false,true,null,'Deposits (Asset)'),
('1270','Gold, silver & SGB','asset','1200',false,true,null,'Investments'),
('1280','REITs & InvITs','asset','1200',false,true,null,'Investments'),
('1290','Foreign investments','asset','1200',false,true,null,'Investments'),
('1295','Private investments & startups','asset','1200',false,true,null,'Investments'),
('1296','Operating business interests','asset','1200',false,true,null,'Investments'),
('1297','PPF, EPF, NPS','asset','1200',false,true,null,'Investments'),
('1298','Insurance (surrender/fund value)','asset','1200',false,true,null,'Investments'),
('1300','Fixed assets','asset','1000',true,true,null,'Fixed Assets'),
('1310','Immovable property','asset','1300',false,true,null,'Fixed Assets'),
('1320','Capital improvements','asset','1300',false,true,null,'Fixed Assets'),
('1330','Lifestyle assets','asset','1300',false,true,null,'Fixed Assets'),
('1340','Accumulated depreciation','asset','1300',false,true,null,'Fixed Assets'),
('1400','Receivables & advances','asset','1000',true,true,null,'Current Assets'),
('1410','Rent receivable','asset','1400',false,true,null,'Sundry Debtors'),
('1420','TDS receivable','asset','1400',false,true,null,'Current Assets'),
('1430','Advance tax paid','asset','1400',false,true,null,'Current Assets'),
('1440','GST input credit','asset','1400',false,true,null,'Duties & Taxes'),
('1450','Security deposits given','asset','1400',false,true,null,'Deposits (Asset)'),
('1460','Loans given / inter-entity receivable','asset','1400',false,true,null,'Loans & Advances (Asset)'),
('1470','Accrued interest & dividends','asset','1400',false,true,null,'Current Assets'),
('1480','Foreign tax credit receivable','asset','1400',false,true,null,'Current Assets'),
('2000','Liabilities','liability',null,true,true,null,null),
('2100','Loans','liability','2000',true,true,null,'Secured Loans'),
('2110','Home loans','liability','2100',false,true,null,'Secured Loans'),
('2120','Loans against securities / property','liability','2100',false,true,null,'Secured Loans'),
('2130','Other loans & credit lines','liability','2100',false,true,null,'Unsecured Loans'),
('2200','Payables & provisions','liability','2000',true,true,null,'Current Liabilities'),
('2210','Credit card payable','liability','2200',false,true,null,'Sundry Creditors'),
('2220','Vendor payables','liability','2200',false,true,null,'Sundry Creditors'),
('2230','Security deposits received (tenants)','liability','2200',false,true,null,'Current Liabilities'),
('2240','GST output payable','liability','2200',false,true,null,'Duties & Taxes'),
('2250','TDS payable','liability','2200',false,true,null,'Duties & Taxes'),
('2260','Provision for income tax','liability','2200',false,true,null,'Provisions'),
('2270','Unfunded capital commitments (memo)','liability','2200',false,true,null,'Current Liabilities'),
('2280','Inter-entity payable','liability','2200',false,true,null,'Loans (Liability)'),
('3000','Capital','equity',null,true,true,null,null),
('3100','Capital account','equity','3000',false,true,null,'Capital Account'),
('3110','Partner / member capital','equity','3000',false,true,null,'Capital Account'),
('3200','Drawings','equity','3000',false,true,null,'Capital Account'),
('3300','Retained surplus','equity','3000',false,true,null,'Reserves & Surplus'),
('3400','Unrealised gain/loss reserve','equity','3000',false,true,null,'Reserves & Surplus'),
('4000','Income','income',null,true,true,null,null),
('4100','Rental income','income','4000',false,true,'house_property','Indirect Incomes'),
('4200','Dividend income','income','4000',false,true,'other_sources','Indirect Incomes'),
('4300','Interest income','income','4000',false,true,'other_sources','Indirect Incomes'),
('4400','Capital gains — short term','income','4000',false,true,'capital_gains','Indirect Incomes'),
('4410','Capital gains — long term','income','4000',false,true,'capital_gains','Indirect Incomes'),
('4420','Unrealised gains (MTM)','income','4000',false,true,null,'Indirect Incomes'),
('4500','Salary / professional fees','income','4000',false,true,'salary','Direct Incomes'),
('4600','Business income / share of profit','income','4000',false,true,'business','Direct Incomes'),
('4700','Fund distributions','income','4000',false,true,'other_sources','Indirect Incomes'),
('4800','Foreign income','income','4000',false,true,'other_sources','Indirect Incomes'),
('4900','Other income','income','4000',false,true,'other_sources','Indirect Incomes'),
('5000','Expenses','expense',null,true,true,null,null),
('5100','Property expenses','expense','5000',true,true,'house_property','Indirect Expenses'),
('5110','Property tax','expense','5100',false,true,'house_property','Indirect Expenses'),
('5120','Maintenance & repairs','expense','5100',false,true,'house_property','Indirect Expenses'),
('5130','Society & insurance','expense','5100',false,true,'house_property','Indirect Expenses'),
('5200','Investment expenses','expense','5000',true,true,null,'Indirect Expenses'),
('5210','Brokerage, STT & charges','expense','5200',false,true,null,'Indirect Expenses'),
('5220','PMS / AIF fees','expense','5200',false,true,null,'Indirect Expenses'),
('5230','Advisor, custody & DP charges','expense','5200',false,true,null,'Indirect Expenses'),
('5300','Interest expense','expense','5000',false,true,'house_property','Indirect Expenses'),
('5400','Insurance premiums','expense','5000',false,true,null,'Indirect Expenses'),
('5500','Household & lifestyle','expense','5000',false,true,null,'Indirect Expenses'),
('5600','Taxes paid — income tax','expense','5000',false,true,null,'Indirect Expenses'),
('5610','Interest on tax (234A/B/C)','expense','5000',false,true,null,'Indirect Expenses'),
('5700','Professional fees (CA, legal)','expense','5000',false,true,null,'Indirect Expenses'),
('5800','Depreciation','expense','5000',false,true,null,'Indirect Expenses'),
('5900','Unrealised losses (MTM)','expense','5000',false,true,null,'Indirect Expenses'),
('5950','Realised FX gain/loss','expense','5000',false,true,null,'Indirect Expenses'),
('5990','Other expenses','expense','5000',false,true,null,'Indirect Expenses');

-- default posting rules (system)
insert into gl_posting_rules (event_type, instrument_class, lines) values
('investment_txn.buy','equity','[{"side":"debit","account_code":"1210","amount":"cost_incl_charges"},{"side":"credit","account_code":"1110","amount":"net_paid"}]'),
('investment_txn.buy','mf','[{"side":"debit","account_code":"1220","amount":"cost_incl_charges"},{"side":"credit","account_code":"1110","amount":"net_paid"}]'),
('investment_txn.buy','debt','[{"side":"debit","account_code":"1250","amount":"cost_incl_charges"},{"side":"credit","account_code":"1110","amount":"net_paid"}]'),
('investment_txn.buy','foreign','[{"side":"debit","account_code":"1290","amount":"cost_inr"},{"side":"credit","account_code":"1110","amount":"cost_inr"}]'),
('investment_txn.sell','equity','[{"side":"debit","account_code":"1110","amount":"net_proceeds"},{"side":"debit","account_code":"5210","amount":"charges"},{"side":"credit","account_code":"1210","amount":"cost_of_lots_sold"},{"side":"credit","account_code":"4400|4410","amount":"gain_by_term"}]'),
('investment_txn.dividend',null,'[{"side":"debit","account_code":"1110","amount":"net"},{"side":"debit","account_code":"1420","amount":"tds"},{"side":"credit","account_code":"4200","amount":"gross"}]'),
('investment_txn.interest',null,'[{"side":"debit","account_code":"1110","amount":"net"},{"side":"debit","account_code":"1420","amount":"tds"},{"side":"credit","account_code":"4300","amount":"gross"}]'),
('investment_txn.sip','mf','[{"side":"debit","account_code":"1220","amount":"amount"},{"side":"credit","account_code":"1110","amount":"amount"}]'),
('investment_txn.redemption','mf','[{"side":"debit","account_code":"1110","amount":"net_proceeds"},{"side":"credit","account_code":"1220","amount":"cost_of_lots_sold"},{"side":"credit","account_code":"4400|4410","amount":"gain_by_term"}]'),
('investment_txn.capital_call','private','[{"side":"debit","account_code":"1295","amount":"amount"},{"side":"credit","account_code":"1110","amount":"amount"}]'),
('investment_txn.distribution','private','[{"side":"debit","account_code":"1110","amount":"amount"},{"side":"credit","account_code":"4700","amount":"income_component"},{"side":"credit","account_code":"1295","amount":"return_of_capital"}]'),
('investment_txn.fee',null,'[{"side":"debit","account_code":"5220","amount":"amount"},{"side":"credit","account_code":"1110|1230","amount":"amount"}]'),
('rent.accrued',null,'[{"side":"debit","account_code":"1410","amount":"rent_plus_gst"},{"side":"credit","account_code":"4100","amount":"rent"},{"side":"credit","account_code":"2240","amount":"gst"}]'),
('rent.received',null,'[{"side":"debit","account_code":"1110","amount":"received"},{"side":"debit","account_code":"1420","amount":"tds"},{"side":"credit","account_code":"1410","amount":"received_plus_tds"}]'),
('property_expense',null,'[{"side":"debit","account_code":"5120|1320","amount":"amount"},{"side":"credit","account_code":"1110|2220","amount":"amount"}]'),
('property_tax.paid',null,'[{"side":"debit","account_code":"5110","amount":"amount"},{"side":"credit","account_code":"1110","amount":"amount"}]'),
('gst.paid',null,'[{"side":"debit","account_code":"2240","amount":"amount"},{"side":"credit","account_code":"1110","amount":"amount"}]'),
('liability.emi',null,'[{"side":"debit","account_code":"2110|2120|2130","amount":"principal"},{"side":"debit","account_code":"5300","amount":"interest"},{"side":"credit","account_code":"1110","amount":"emi"}]'),
('insurance.premium',null,'[{"side":"debit","account_code":"5400","amount":"amount"},{"side":"credit","account_code":"1110","amount":"amount"}]'),
('advance_tax.paid',null,'[{"side":"debit","account_code":"1430","amount":"amount"},{"side":"credit","account_code":"1110","amount":"amount"}]'),
('valuation.mtm',null,'[{"side":"debit","account_code":"12xx","amount":"unrealised_change"},{"side":"credit","account_code":"3400","amount":"unrealised_change"}]'),
('corporate_action.bonus',null,'[]'),
('bank_txn.household',null,'[{"side":"debit","account_code":"5500","amount":"amount"},{"side":"credit","account_code":"1110","amount":"amount"}]'),
('bank_txn.internal_transfer',null,'[{"side":"debit","account_code":"1110","amount":"amount","sub_ledger":"to_account"},{"side":"credit","account_code":"1110","amount":"amount","sub_ledger":"from_account"}]'),
('inter_entity.gift',null,'[{"side":"debit","account_code":"3200","amount":"amount","entity":"giver"},{"side":"credit","account_code":"1110","amount":"amount","entity":"giver"},{"side":"debit","account_code":"1110","amount":"amount","entity":"receiver"},{"side":"credit","account_code":"3100","amount":"amount","entity":"receiver"}]'),
('inter_entity.loan',null,'[{"side":"debit","account_code":"1460","amount":"amount","entity":"lender"},{"side":"credit","account_code":"1110","amount":"amount","entity":"lender"},{"side":"debit","account_code":"1110","amount":"amount","entity":"borrower"},{"side":"credit","account_code":"2280","amount":"amount","entity":"borrower"}]');
