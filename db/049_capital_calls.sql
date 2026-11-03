-- An AIF asks for its commitment in parts. capital_calls holds the calls the manager has announced and that are still to be paid, so the app can remind before the
-- due date. Paying one is an ordinary "Capital call" entry on the holding; that entry marks the call paid. The commitment itself is kept with the AIF (instruments.meta).
create table capital_calls (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references families(id) on delete cascade,
  holding_id uuid not null references holdings(id) on delete cascade,
  due_date date not null,
  amount numeric(18,2) not null check (amount > 0),
  status text not null default 'expected' check (status in ('expected','paid','cancelled')),
  paid_on date,
  note text,
  created_at timestamptz not null default now()
);
create index on capital_calls (family_id, status, due_date);
alter table capital_calls enable row level security;
alter table capital_calls force row level security;
create policy capital_calls_tenant on capital_calls using (family_id = current_setting('app.family_id', true)::uuid) with check (family_id = current_setting('app.family_id', true)::uuid);
grant select, insert, update, delete on capital_calls to app_user;
