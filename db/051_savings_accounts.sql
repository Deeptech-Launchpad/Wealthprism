-- Government savings, round 2: PPF and SSY. They take deposits of any size through the year and add the interest once a year, on 31 March, so they do not fit
-- the fixed-deposit engine. savings_accounts is the account; savings_entries holds what goes in (deposit) and the yearly interest (interest). The interest is worked
-- out by the scheme's rule (the lowest balance between the 5th and the end of each month, at the rate, credited at the year end) and stays an estimate until the user
-- confirms the passbook figure. balance_adjust is the gap between that arithmetic and the passbook the last time the user said "update balance".
create table savings_accounts (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references families(id) on delete cascade,
  entity_id uuid not null references entities(id),
  scheme text not null check (scheme in ('ppf','ssy')),
  institution text not null,
  account_no text,
  holder_name text,            -- SSY: the girl child
  holder_dob date,
  opened_on date not null,
  matures_on date not null,
  deposits_until date,         -- SSY: deposits stop 15 years after opening
  rate_pct numeric(5,2) not null,
  opening_balance numeric(14,2) not null default 0,   -- what it already held on tracked_from, when the account is older than its entry here
  tracked_from date not null,
  balance_adjust numeric(14,2) not null default 0,
  bucket text not null default 'income' check (bucket in ('liquidity','income','growth')),
  status text not null default 'active' check (status in ('active','closed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on savings_accounts (family_id);
create table savings_entries (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references families(id) on delete cascade,
  account_id uuid not null references savings_accounts(id) on delete cascade,
  kind text not null check (kind in ('deposit','interest')),
  entry_date date not null,
  amount numeric(14,2) not null,
  status text not null default 'received' check (status in ('received','expected','credited')),   -- deposit: received; interest: expected (year not over) or credited
  confirmed boolean not null default false,            -- interest: the user has entered the passbook figure
  bank_account_id uuid references bank_accounts(id),   -- the account the money was taken from (its balance went down)
  bank_txn_ref text,                                   -- set when a bank statement line matched
  note text,
  created_at timestamptz not null default now()
);
create unique index savings_interest_once on savings_entries (account_id, entry_date) where kind = 'interest';
create index on savings_entries (account_id, entry_date);
do $$ declare t text; begin
  foreach t in array array['savings_accounts','savings_entries'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format($p$create policy %I_tenant on %I using (family_id = current_setting('app.family_id', true)::uuid) with check (family_id = current_setting('app.family_id', true)::uuid)$p$, t, t);
  end loop; end $$;
grant select, insert, update, delete on savings_accounts, savings_entries to app_user;

update asset_types set enabled = true, label = 'PPF (Public Provident Fund)', description = 'A 15-year government savings account. Put in ₹500 to ₹1.5 lakh a year; the interest (set every quarter) is added once a year and is tax-free.' where code = 'ppf';
update asset_types set enabled = true, label = 'SSY (Sukanya Samriddhi)', description = 'A government savings account for a girl child under 10. Deposits for 15 years, matures after 21. The interest is added once a year and is tax-free.' where code = 'ssy';
