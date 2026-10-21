-- Milestone 14: GL period-end (mark-to-market reserve, depreciation as data), Tally live sync, scheduled exports.

-- ---------- depreciation rates are data (Income-tax Act blocks, WDV) ----------
create table if not exists depreciation_rates (
  id uuid primary key default gen_random_uuid(),
  asset_kind text not null,                     -- lifestyle_kind value or 'building' / 'computer' / 'plant' / 'intangible' / 'capital_improvement'
  method text not null default 'wdv' check (method in ('wdv','slm')),
  rate_pct numeric(6,2) not null,               -- 0 = not depreciable (capital asset held for appreciation)
  fy_from text not null,
  notes text,
  unique (asset_kind, fy_from)
);
grant select on depreciation_rates to app_user;
insert into depreciation_rates (asset_kind, method, rate_pct, fy_from, notes) values
('vehicle','wdv',15,'2017-18','Motor cars (block 15%)'),
('watch','wdv',10,'2017-18','Furniture & fittings block'),
('collectible','wdv',0,'2017-18','Capital asset, no depreciation'),
('art','wdv',0,'2017-18','Capital asset, no depreciation'),
('jewellery','wdv',0,'2017-18','Capital asset, no depreciation'),
('wine','wdv',0,'2017-18','Capital asset, no depreciation'),
('other','wdv',10,'2017-18','Furniture & fittings block'),
('building','wdv',5,'2017-18','Residential buildings'),
('building_commercial','wdv',10,'2017-18','Buildings other than residential'),
('capital_improvement','wdv',10,'2017-18','Improvements follow the furniture / fittings block'),
('computer','wdv',40,'2017-18','Computers and software'),
('plant','wdv',15,'2017-18','Plant & machinery, general'),
('intangible','wdv',25,'2017-18','Know-how, patents, licences')
on conflict (asset_kind, fy_from) do nothing;

-- ---------- books: Tally endpoint and the MTM treatment ----------
alter table gl_books add column if not exists tally_url text;                 -- e.g. http://192.168.1.20:9000 (a running Tally with the HTTP gateway on)
alter table gl_books add column if not exists tally_company text;             -- company name in Tally when it differs from the entity name
alter table gl_books add column if not exists mtm_treatment text not null default 'reserve' check (mtm_treatment in ('reserve','pnl'));
alter table gl_books add column if not exists last_tally_sync_at timestamptz;
alter table gl_tally_sync add column if not exists response text;
alter table gl_tally_sync add column if not exists created_count int;
alter table gl_tally_sync add column if not exists altered_count int;
alter table gl_tally_sync add column if not exists error_count int;

-- ---------- scheduled exports (FO-104 v1.1) ----------
create table if not exists export_schedules (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references families(id) on delete cascade,
  name text not null,
  dataset text not null,
  format text not null default 'csv',
  filters jsonb not null default '{}',
  cron text not null,
  active boolean not null default true,
  webhook boolean not null default true,        -- emit export.ready on every run
  created_by uuid references users(id),
  next_run_at timestamptz,
  last_run_at timestamptz,
  last_export_id uuid references export_jobs(id) on delete set null,
  last_error text,
  created_at timestamptz not null default now()
);
create index if not exists export_schedules_family on export_schedules (family_id, active);
alter table export_jobs add column if not exists schedule_id uuid references export_schedules(id) on delete set null;
do $$ declare t text; begin
  foreach t in array array['export_schedules'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    if not exists (select 1 from pg_policies where tablename = t and policyname = t || '_tenant') then
      execute format($p$create policy %I_tenant on %I using (family_id = current_setting('app.family_id', true)::uuid) with check (family_id = current_setting('app.family_id', true)::uuid)$p$, t, t);
    end if;
  end loop; end $$;
grant select, insert, update, delete on export_schedules to app_user;

-- demo: the HUF keeps its books at market with a reserve and depreciates its assets
update gl_books set mark_to_market = true, depreciation = true where entity_id = '33333333-0000-0000-0000-000000000002';
