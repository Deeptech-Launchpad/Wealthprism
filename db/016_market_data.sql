-- Milestone 2: price feeds, valuations and corporate actions (FO-20, 21, 32, 38, 95)

-- Every feed / job run, for the ops view and for "when did prices last arrive".
create table feed_runs (
  id uuid primary key default gen_random_uuid(),
  job text not null,                       -- amfi.nav | prices.eod | benchmarks.eod | corporate_actions.fetch | valuations.daily | twr.refresh | prices.stale
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  status text not null default 'running',  -- running | ok | failed
  rows int not null default 0,
  note text
);
create index feed_runs_job_idx on feed_runs (job, started_at desc);

-- A corporate action is global (per instrument); its application is per family and per holding.
create table corporate_action_applications (
  id uuid primary key default gen_random_uuid(),
  corporate_action_id uuid not null references corporate_actions(id) on delete cascade,
  family_id uuid not null references families(id) on delete cascade,
  holding_id uuid not null references holdings(id) on delete cascade,
  applied_at timestamptz not null default now(),
  applied_by uuid references users(id),    -- null = auto-applied by the worker
  detail jsonb not null default '{}',      -- quantities and cost moved, for the audit trail
  unique (corporate_action_id, holding_id)
);
alter table corporate_action_applications enable row level security;
alter table corporate_action_applications force row level security;
create policy corporate_action_applications_tenant on corporate_action_applications
  using (family_id = current_setting('app.family_id', true)::uuid) with check (family_id = current_setting('app.family_id', true)::uuid);

-- Decoded feed text kept on the action so the review screen can show it; face values for splits.
alter table corporate_actions add column if not exists subject text;
alter table corporate_actions add column if not exists face_value_from numeric(12,4);
alter table corporate_actions add column if not exists face_value_to numeric(12,4);
alter table corporate_actions add column if not exists auto_apply boolean not null default false;
create unique index if not exists corporate_actions_natural_key on corporate_actions (instrument_id, type, ex_date);

create index if not exists prices_date_idx on prices (price_date desc);
create index if not exists valuations_daily_scope_idx on valuations_daily (family_id, scope_type, scope_id, as_of desc);

grant select, insert, update, delete on feed_runs, corporate_action_applications, corporate_actions, benchmark_prices, benchmarks, prices, instruments to app_user;
