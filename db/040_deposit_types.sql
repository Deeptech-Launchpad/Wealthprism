-- Deposit types (phase 1 of early-closure support). Reference data, like tax_rules: the same list for every family, read-only to the app.
-- break_rule says whether a deposit of this type may be closed before maturity: 'allowed', 'after_lock_in' (not until lock_in_months have run),
-- or 'never'. default_penalty_pct is only a starting point the user can edit when they close — banks differ (typically 0.5-1% off the rate).
create table deposit_types (
  code text primary key,
  kind text not null check (kind in ('fd','rd')),
  label text not null,
  description text not null,
  break_rule text not null check (break_rule in ('allowed','after_lock_in','never')),
  lock_in_months integer not null default 0,
  default_penalty_pct numeric(4,2) not null default 1.00,
  default_payout text check (default_payout in ('monthly','quarterly','at_maturity')),   -- null = the user chooses
  default_tds boolean not null default true,
  min_tenure_months integer,
  max_tenure_months integer,
  partial_withdrawal boolean not null default false,
  sort integer not null default 0
);
grant select on deposit_types to app_user;

insert into deposit_types (code, kind, label, description, break_rule, lock_in_months, default_penalty_pct, default_payout, default_tds, min_tenure_months, max_tenure_months, partial_withdrawal, sort) values
 ('fd_regular',   'fd', 'Regular FD (interest paid out)', 'Standard bank FD. Interest is paid monthly or quarterly. Can be closed early; the bank cuts the rate by about 0.5-1%.', 'allowed', 0, 1.00, 'monthly', true, null, null, false, 10),
 ('fd_cumulative','fd', 'Cumulative FD (interest compounds)', 'Interest is added to the deposit and paid at maturity. Can be closed early with a rate cut.', 'allowed', 0, 1.00, 'at_maturity', true, null, null, false, 20),
 ('fd_senior',    'fd', 'Senior citizen FD', 'Higher rate for depositors aged 60+. Can be closed early with a rate cut.', 'allowed', 0, 1.00, null, true, null, null, false, 30),
 ('fd_tax_saver', 'fd', 'Tax-saver FD (80C, 5 years)', 'Locked for 5 years: it cannot be closed early and no loan can be taken against it. The 80C deduction applies to the old tax regime only.', 'never', 60, 0.00, null, true, 60, 60, false, 40),
 ('fd_flexi',     'fd', 'Flexi / sweep-in FD', 'Linked to a savings account; money moves in and out in blocks. Can be broken early, in part or in full.', 'allowed', 0, 1.00, 'at_maturity', true, null, null, true, 50),
 ('rd_regular',   'rd', 'Regular RD', 'Fixed monthly instalment for a fixed tenure. Can be closed early; the bank cuts the rate by about 0.5-1%.', 'allowed', 0, 1.00, null, true, null, null, false, 10),
 ('rd_flexi',     'rd', 'Flexi RD (variable instalments)', 'The monthly amount can vary and an instalment can be skipped. Can be closed early with a rate cut.', 'allowed', 0, 1.00, null, true, null, null, false, 20),
 ('rd_senior',    'rd', 'Senior citizen RD', 'Higher rate for depositors aged 60+. Can be closed early with a rate cut.', 'allowed', 0, 1.00, null, true, null, null, false, 30);

-- every deposit has a type; the ones entered before this migration become the regular type of their kind
alter table deposits add column type_code text references deposit_types(code);
update deposits set type_code = case when kind = 'fd' then 'fd_regular' else 'rd_regular' end where type_code is null;
alter table deposits alter column type_code set not null;
create index on deposits (type_code);
