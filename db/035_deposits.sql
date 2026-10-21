-- Fixed & recurring deposits (new "Add Asset" category, step 1 of the agreed build order): manual entry only,
-- generates its own expected-receipts schedule on save, same pattern as leases -> rent_schedule. Bank-statement
-- matching against these receipts, GL posting rules and TDS reconciliation are later steps, deliberately not
-- part of this migration.

create table deposits (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references families(id),
  entity_id uuid not null references entities(id),
  kind text not null check (kind in ('fd','rd')),
  bank text not null,
  account_no text,
  bucket text not null default 'liquidity' check (bucket in ('liquidity','income','growth')),
  principal numeric(14,2),            -- fd only
  installment_amount numeric(14,2),   -- rd only
  rate_pct numeric(5,2) not null,
  start_date date not null,
  maturity_date date not null,
  tenure_months integer,              -- rd only
  payout_frequency text not null default 'at_maturity' check (payout_frequency in ('monthly','quarterly','at_maturity')),
  payout_bank_account_id uuid references bank_accounts(id),
  tds_applicable boolean not null default true,
  status text not null default 'active' check (status in ('active','closed','premature_closed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on deposits (family_id);
create index on deposits (entity_id);

-- One row per expected cash movement: an fd's periodic interest + its maturity payout, or an rd's monthly
-- contributions (outflow from the payout account) + its maturity payout. Mirrors rent_schedule's
-- expected/received/status shape so the later matching step can reuse the same reconciliation pattern.
create table deposit_receipts (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references families(id),
  deposit_id uuid not null references deposits(id) on delete cascade,
  kind text not null check (kind in ('interest','contribution','maturity')),
  due_date date not null,
  expected_amount numeric(14,2) not null,
  received_amount numeric(14,2) not null default 0,
  received_on date,
  status text not null default 'expected' check (status in ('expected','received','partial','overdue')),
  bank_txn_ref text
);
create index on deposit_receipts (deposit_id);
create index on deposit_receipts (family_id, status);

do $$ declare t text; begin
  foreach t in array array['deposits','deposit_receipts'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format($p$create policy %I_tenant on %I using (family_id = current_setting('app.family_id', true)::uuid) with check (family_id = current_setting('app.family_id', true)::uuid)$p$, t, t);
  end loop; end $$;
grant select, insert, update, delete on deposits, deposit_receipts to app_user;
