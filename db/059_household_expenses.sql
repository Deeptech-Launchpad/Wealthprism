-- Monthly household expenses (groceries, school, travel, society, etc.). Each row is a recurring monthly amount that grows each year.
-- It reduces cash in the planning projection. If it carries a tax deduction code (for example 80C), its yearly total also counts as a deduction.
create table household_expenses (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references families(id) on delete cascade,
  entity_id uuid not null references entities(id) on delete cascade,
  category text not null check (category in ('housing','food','transport','school','health','insurance','entertainment','other')),
  label text not null,
  monthly_amount numeric(18,2) not null check (monthly_amount >= 0),
  growth_pct numeric(5,2) not null default 0,
  from_month date,
  to_month date,
  deduction_code text,
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);
do $$ declare t text; begin
  foreach t in array array['household_expenses'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format($p$create policy %I_tenant on %I using (family_id = current_setting('app.family_id', true)::uuid) with check (family_id = current_setting('app.family_id', true)::uuid)$p$, t, t);
  end loop; end $$;
grant select, insert, update, delete on household_expenses to app_user;
