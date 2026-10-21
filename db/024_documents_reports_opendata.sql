-- 024: document store, report engine (jobs, schedules, packs, external viewers) and open data (API keys, webhooks, bulk exports)
-- FO-33 (exports), FO-100 (extraction review), FO-103 (packs, versions, external viewers), FO-104 (open data), FO-115 / FO-146 (stored statements and IPS)

-- ---------- folders and documents ----------
alter table folders add column if not exists entity_id uuid references entities(id),
                    add column if not exists created_at timestamptz not null default now();
create unique index if not exists folders_family_parent_name on folders (family_id, coalesce(parent_id, '00000000-0000-0000-0000-000000000000'::uuid), name);
alter table documents add column if not exists doc_type text,                                  -- cas | contract_note | bank_statement | form26as | capital_call | insurance | loan_statement | report | export | other
                      add column if not exists source text not null default 'upload',         -- upload | report | export | import | research | system
                      add column if not exists text text,                                      -- extracted text (PDF / CSV / TXT) for extraction and search
                      add column if not exists tags text[] not null default '{}',
                      add column if not exists scan_status text not null default 'skipped',    -- skipped | clean | infected | error (SCAN_COMMAND)
                      add column if not exists page_count int,
                      add column if not exists report_code text,
                      add column if not exists params jsonb,
                      add column if not exists expires_at timestamptz,                         -- temporary objects (exports) are purged after this
                      add column if not exists updated_at timestamptz not null default now();
create index if not exists documents_family_sha on documents (family_id, sha256) where deleted_at is null;
create index if not exists documents_family_link on documents (family_id, linked_type, linked_id) where deleted_at is null;
create index if not exists documents_family_folder on documents (family_id, folder_id) where deleted_at is null;
alter table document_extractions add column if not exists summary text,
                                 add column if not exists review_note text,
                                 add column if not exists redactions int not null default 0,   -- PII spans masked before the model saw the text
                                 add column if not exists source_kind text;                    -- import source the approval will run (cas, contract_note, bank_csv, form26as, aa) when applicable

-- ---------- report engine ----------
create table if not exists report_jobs (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references families(id) on delete cascade,
  report_code text not null,
  params jsonb not null default '{}',
  format text not null default 'pdf',
  status text not null default 'queued' check (status in ('queued','running','done','failed')),
  document_id uuid references documents(id),
  pack_run_id uuid,
  schedule_id uuid references report_schedules(id) on delete set null,
  requested_by uuid references users(id),
  error text,
  created_at timestamptz not null default now(),
  finished_at timestamptz
);
create index if not exists report_jobs_family_created on report_jobs (family_id, created_at desc);
alter table report_schedules add column if not exists name text,
                             add column if not exists created_by uuid references users(id),
                             add column if not exists active boolean not null default true,
                             add column if not exists next_run_at timestamptz,
                             add column if not exists last_document_id uuid references documents(id),
                             add column if not exists last_error text,
                             add column if not exists created_at timestamptz not null default now();
alter table report_packs add column if not exists description text,
                         add column if not exists created_at timestamptz not null default now(),
                         add column if not exists updated_at timestamptz not null default now(),
                         add column if not exists last_run_at timestamptz,
                         add column if not exists deleted_at timestamptz;
alter table report_pack_runs add column if not exists family_id uuid references families(id) on delete cascade,
                             add column if not exists status text not null default 'done',
                             add column if not exists document_id uuid references documents(id),
                             add column if not exists requested_by uuid references users(id),
                             add column if not exists sections jsonb,                       -- the pack definition as run (name, audience, sections with params)
                             add column if not exists report_codes text[],
                             add column if not exists page_count int,
                             add column if not exists delivered_to text[],
                             add column if not exists error text;
update report_pack_runs r set family_id = p.family_id from report_packs p where p.id = r.pack_id and r.family_id is null;
alter table report_pack_runs alter column family_id set not null;
create unique index if not exists report_pack_runs_version on report_pack_runs (pack_id, version);
alter table report_jobs add constraint report_jobs_pack_run_fk foreign key (pack_run_id) references report_pack_runs(id) on delete set null;

-- ---------- external viewers ----------
alter table external_access add column if not exists email citext,
                            add column if not exists invite_token_hash text,
                            add column if not exists accepted_at timestamptz,
                            add column if not exists last_viewed_at timestamptz,
                            add column if not exists views int not null default 0,
                            add column if not exists created_at timestamptz not null default now();

-- ---------- open data ----------
alter table api_keys add column if not exists rate_limit_per_min int not null default 120,
                     add column if not exists created_at timestamptz not null default now(),
                     add column if not exists note text;
alter table webhooks add column if not exists label text,
                     add column if not exists secret_enc text,                                -- AES-256-GCM under FIELD_ENCRYPTION_KEY: deliveries are signed with it; secret_hash identifies it
                     add column if not exists created_by uuid references users(id),
                     add column if not exists created_at timestamptz not null default now(),
                     add column if not exists updated_at timestamptz not null default now();
create table if not exists webhook_deliveries (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references families(id) on delete cascade,
  webhook_id uuid not null references webhooks(id) on delete cascade,
  event text not null,
  payload jsonb not null,
  status text not null default 'pending' check (status in ('pending','delivered','failed','dead')),
  attempts int not null default 0,
  next_attempt_at timestamptz not null default now(),
  last_status_code int,
  last_error text,
  delivered_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists webhook_deliveries_due on webhook_deliveries (status, next_attempt_at) where status in ('pending','failed');
create index if not exists webhook_deliveries_hook on webhook_deliveries (webhook_id, created_at desc);
create table if not exists export_jobs (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references families(id) on delete cascade,
  dataset text not null,
  format text not null,
  filters jsonb not null default '{}',
  status text not null default 'queued' check (status in ('queued','running','done','failed')),
  document_id uuid references documents(id),
  row_count int,
  error text,
  requested_by uuid references users(id),
  created_at timestamptz not null default now(),
  finished_at timestamptz,
  expires_at timestamptz
);
create index if not exists export_jobs_family_created on export_jobs (family_id, created_at desc);

-- ---------- RLS on the new / repaired tables ----------
do $$ declare t text; begin
  foreach t in array array['report_jobs','report_pack_runs','webhook_deliveries','export_jobs'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    if not exists (select 1 from pg_policies where tablename = t and policyname = t || '_tenant') then
      execute format($p$create policy %I_tenant on %I using (family_id = current_setting('app.family_id', true)::uuid) with check (family_id = current_setting('app.family_id', true)::uuid)$p$, t, t);
    end if;
  end loop; end $$;
grant select, insert, update, delete on report_jobs, webhook_deliveries, export_jobs to app_user;
-- API keys and webhook secrets are read only by the API; the executor never sees them (no grant).

-- ---------- demo data (extends the Mehta family consistently) ----------
insert into folders (family_id, name, system)
select '11111111-1111-1111-1111-111111111111', n, true from unnest(array['Reports','Exports','Imports','Research notes']) n
where not exists (select 1 from folders f where f.family_id = '11111111-1111-1111-1111-111111111111' and f.parent_id is null and f.name = n);

insert into report_packs (id, family_id, name, audience, sections, cron, recipients, created_by, description)
select 'd1000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'CA quarterly pack', 'ca',
  '[{"report_code":"capital_gains","params":{}},{"report_code":"rent_gst","params":{}},{"report_code":"tds_recon","params":{}},{"report_code":"books_trial_balance","params":{"entity_id":"33333333-0000-0000-0000-000000000002"}},{"report_code":"tax_computation","params":{}}]'::jsonb,
  '0 9 5 1,4,7,10 *', array['ca@example.com'], '22222222-0000-0000-0000-000000000001', 'Capital gains, rent / GST register, TDS reconciliation, the HUF trial balance and the tax computation — the quarter''s hand-off to the CA'
where not exists (select 1 from report_packs where id = 'd1000000-0000-0000-0000-000000000001');
insert into report_packs (id, family_id, name, audience, sections, cron, recipients, created_by, description)
select 'd1000000-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111', 'Family monthly review', 'family',
  '[{"report_code":"net_worth","params":{}},{"report_code":"performance","params":{"scope_type":"family","period":"1y"}},{"report_code":"bucket_drift","params":{}},{"report_code":"working_capital","params":{}},{"report_code":"execution_audit","params":{}}]'::jsonb,
  '0 8 1 * *', array['arjun@example.com','priya@example.com'], '22222222-0000-0000-0000-000000000001', 'Net worth, performance, drift, cash and what the action plane did last month'
where not exists (select 1 from report_packs where id = 'd1000000-0000-0000-0000-000000000002');

insert into report_schedules (id, family_id, report_code, params, cron, recipients, format, name, created_by)
select 'd2000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'net_worth', '{}', '0 8 1 * *', array['arjun@example.com','priya@example.com'], 'pdf', 'Monthly net worth to the family', '22222222-0000-0000-0000-000000000001'
where not exists (select 1 from report_schedules where id = 'd2000000-0000-0000-0000-000000000001');

-- the CA is an external viewer: a member with role viewer whose access is bounded by scope and expiry
insert into external_access (id, family_id, user_id, label, scope, expires_on, invited_by, email, accepted_at)
select 'd3000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', '22222222-0000-0000-0000-000000000004', 'CA – S. Krishnan',
  '{"entities":[],"modules":["reports","books","documents","imports","investments","real_estate","planning"],"reports":["capital_gains","rent_gst","tds_recon","tax_computation","books_trial_balance","books_profit_loss","books_balance_sheet","books_capital_account","books_cash_flow","books_ledger","books_itr_mapping","books_bank_recon"]}'::jsonb,
  '2027-06-30', '22222222-0000-0000-0000-000000000001', 'ca@example.com', now()
where not exists (select 1 from external_access where id = 'd3000000-0000-0000-0000-000000000001');

-- membership lookup for external viewers runs before any family transaction (like user_families): security definer, one row per (family, user)
create or replace function external_access_for(fid uuid, uid uuid)
returns table (scope jsonb, expires_on date, revoked_at timestamptz, label text)
language sql security definer set search_path = public stable as $$
  select x.scope, x.expires_on, x.revoked_at, x.label from external_access x where x.family_id = fid and x.user_id = uid order by (x.revoked_at is null) desc, x.created_at desc limit 1
$$;
revoke all on function external_access_for(uuid, uuid) from public;
grant execute on function external_access_for(uuid, uuid) to app_user;

-- invitation acceptance runs before the viewer has any family context: look the token up as definer, the caller then acts inside that family
create or replace function external_invite_lookup(p_email citext, p_token_hash text)
returns table (id uuid, user_id uuid, family_id uuid)
language sql security definer set search_path = public stable as $$
  select x.id, x.user_id, x.family_id from external_access x join users u on u.id = x.user_id
  where u.email = p_email and x.invite_token_hash = p_token_hash and x.revoked_at is null and x.expires_on >= current_date and x.accepted_at is null limit 1
$$;
revoke all on function external_invite_lookup(citext, text) from public;
grant execute on function external_invite_lookup(citext, text) to app_user;

-- API-key authentication happens before any family context exists: resolve the key as definer (hash compared in the API), touch last_used_at the same way
create or replace function api_key_lookup(p_prefix text)
returns table (id uuid, family_id uuid, label text, key_hash text, key_prefix text, scopes text[], created_by uuid, last_used_at timestamptz, expires_on date, revoked_at timestamptz, rate_limit_per_min int, email citext, name text)
language sql security definer set search_path = public stable as $$
  select k.id, k.family_id, k.label, k.key_hash, k.key_prefix, k.scopes, k.created_by, k.last_used_at, k.expires_on, k.revoked_at, k.rate_limit_per_min, u.email, u.name
  from api_keys k join users u on u.id = k.created_by where k.key_prefix = p_prefix limit 1
$$;
create or replace function api_key_touch(p_id uuid) returns void language sql security definer set search_path = public as $$ update api_keys set last_used_at = now() where id = p_id $$;
revoke all on function api_key_lookup(text) from public; grant execute on function api_key_lookup(text) to app_user;
revoke all on function api_key_touch(uuid) from public; grant execute on function api_key_touch(uuid) to app_user;
