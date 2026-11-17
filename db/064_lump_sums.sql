-- One-time sums of money (bonus, gift, sale proceeds, inheritance, refund) that arrive in a bank account.
-- They are NOT income: they do not appear in the monthly income picture or the tax position. They change the bank balance
-- once, when entered (status 'pending'). When a bank statement line with the same amount and date arrives, the entry is
-- matched to that line and becomes 'verified': the balance is not changed again, so nothing is counted twice.
create table lump_sums (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references families(id) on delete cascade,
  bank_account_id uuid not null references bank_accounts(id) on delete cascade,
  entry_date date not null,
  amount numeric(18,2) not null check (amount > 0),
  reason text not null check (reason in ('bonus','gift','sale','inheritance','refund','other')),
  note text,
  status text not null default 'pending' check (status in ('pending','verified')),
  bank_txn_id uuid references bank_txns(id) on delete set null,
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);
do $$ declare t text; begin
  foreach t in array array['lump_sums'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format($p$create policy %I_tenant on %I using (family_id = current_setting('app.family_id', true)::uuid) with check (family_id = current_setting('app.family_id', true)::uuid)$p$, t, t);
  end loop; end $$;
grant select, insert, update, delete on lump_sums to app_user;
