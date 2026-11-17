-- A record of each premium paid on a policy: when, how much, and from which bank account.
-- The bank balance is reduced once when the premium is recorded (POST /insurance-policies/:id/premium-paid).
create table insurance_premium_payments (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references families(id) on delete cascade,
  policy_id uuid not null references insurance_policies(id) on delete cascade,
  paid_on date not null,
  amount numeric(18,2) not null check (amount >= 0),
  bank_account_id uuid references bank_accounts(id) on delete set null,
  due_on date,
  created_at timestamptz not null default now()
);
do $$ declare t text; begin
  foreach t in array array['insurance_premium_payments'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format($p$create policy %I_tenant on %I using (family_id = current_setting('app.family_id', true)::uuid) with check (family_id = current_setting('app.family_id', true)::uuid)$p$, t, t);
  end loop; end $$;
grant select, insert, update, delete on insurance_premium_payments to app_user;
