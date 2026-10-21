-- Family Office — balance-sheet completeness, ownership graph, succession, performance/risk analytics, open data.
-- Apply after 005.

create type liability_kind as enum ('home_loan','loan_against_securities','loan_against_property','personal_loan','vehicle_loan','education_loan','credit_line','guarantee','other');
create type insurance_kind as enum ('term_life','endowment','ulip','health','critical_illness','property','vehicle','liability','other');
create type lifestyle_kind as enum ('art','jewellery','vehicle','watch','wine','collectible','other');
create type extraction_status as enum ('extracted','needs_review','approved','rejected');
create type recon_status as enum ('matched','mismatch','missing_in_source','missing_in_platform','resolved');

-- ---------- A1 liabilities ----------
create table liabilities (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references families(id) on delete cascade,
  entity_id uuid not null references entities(id),
  kind liability_kind not null,
  lender text not null,
  account_masked text,
  principal_original numeric(18,2) not null,
  outstanding numeric(18,2) not null,
  outstanding_as_of date,
  rate_pct numeric(6,3),
  rate_type text default 'floating',       -- fixed | floating
  emi numeric(18,2),
  emi_day smallint,
  start_date date, end_date date,
  secured_by_type text, secured_by_id uuid, -- property | holding | private_investment
  ltv_pct numeric(5,2),
  tax_section text,                         -- 24b | 80C | 80E | none
  bank_account_id uuid references bank_accounts(id),
  status text not null default 'active',
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);
create table liability_schedule (
  id uuid primary key default gen_random_uuid(),
  liability_id uuid not null references liabilities(id) on delete cascade,
  due_date date not null,
  principal numeric(18,2) not null,
  interest numeric(18,2) not null,
  paid_on date,
  bank_txn_id uuid references bank_txns(id),
  unique (liability_id, due_date)
);

-- ---------- A2 insurance ----------
create table insurance_policies (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references families(id) on delete cascade,
  entity_id uuid not null references entities(id),
  kind insurance_kind not null,
  insurer text not null,
  policy_no_masked text,
  life_assured text,
  sum_assured numeric(18,2) not null,
  premium numeric(18,2) not null,
  premium_frequency text not null default 'yearly',   -- monthly | quarterly | half_yearly | yearly | single
  next_premium_due date,
  start_date date, maturity_date date,
  surrender_value numeric(18,2),
  fund_value numeric(18,2),                            -- ULIP
  covers_type text, covers_id uuid,                    -- property | vehicle (lifestyle asset) | person
  nominee text,
  tax_section text,                                    -- 80C | 80D | 10(10D)
  document_id uuid references documents(id),
  status text not null default 'active',
  deleted_at timestamptz
);

-- ---------- A3 lifestyle assets, A5 operating business ----------
create table lifestyle_assets (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references families(id) on delete cascade,
  entity_id uuid not null references entities(id),
  kind lifestyle_kind not null,
  name text not null,
  acquired_on date, cost numeric(18,2),
  current_value numeric(18,2), valued_on date, valuation_source text,
  location text,
  insured_policy_id uuid references insurance_policies(id),
  include_in_net_worth boolean not null default true,
  bucket bucket not null default 'growth',
  document_id uuid references documents(id),
  deleted_at timestamptz
);
alter type private_instrument add value if not exists 'operating_business';

-- ---------- B1 ownership graph ----------
create table ownership_links (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references families(id) on delete cascade,
  owner_entity_id uuid not null references entities(id),
  owned_type text not null,        -- entity | property | private_investment | lifestyle_asset | bank_account | holding
  owned_id uuid not null,
  pct numeric(6,3) not null,
  role text,                       -- shareholder | partner | trustee | beneficiary | karta | member
  effective_from date not null default current_date,
  effective_to date,
  unique (owner_entity_id, owned_type, owned_id, effective_from)
);
-- migrate existing property owners into the graph
insert into ownership_links (family_id, owner_entity_id, owned_type, owned_id, pct)
select p.family_id, po.entity_id, 'property', po.property_id, po.ownership_pct from property_owners po join properties p on p.id = po.property_id
on conflict do nothing;

-- ---------- B3 nominees & succession ----------
create table nominations (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references families(id) on delete cascade,
  asset_type text not null,        -- holding | account | bank_account | property | insurance_policy | private_investment | lifestyle_asset | liability
  asset_id uuid not null,
  nominee_name text not null,
  nominee_relation text,
  nominee_member_id uuid references users(id),
  share_pct numeric(6,3) not null default 100,
  registered_with text,            -- AMC | depository | bank | insurer | registrar
  registered_on date,
  document_id uuid references documents(id),
  verified_on date
);
create table succession_documents (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references families(id) on delete cascade,
  entity_id uuid references entities(id),
  kind text not null,              -- will | trust_deed | poa | letter_of_wishes | huf_deed | partnership_deed
  executed_on date,
  executor text,
  witnesses text,
  storage_location text,
  document_id uuid references documents(id),
  review_due date,
  note text
);

-- ---------- C1/C3/C4/C7/C8 analytics ----------
create table valuations_daily (
  family_id uuid not null references families(id) on delete cascade,
  scope_type scope_type not null,
  scope_id uuid not null,
  as_of date not null,
  value numeric(18,2) not null,
  net_flow numeric(18,2) not null default 0,   -- contributions − withdrawals that day (for TWR)
  primary key (family_id, scope_type, scope_id, as_of)
);
create table twr_cache (
  family_id uuid not null references families(id) on delete cascade,
  scope_type scope_type not null,
  scope_id uuid not null,
  period period not null,
  twr numeric(8,4),
  benchmark_id uuid references benchmarks(id),
  benchmark_return numeric(8,4),
  computed_at timestamptz not null default now(),
  primary key (family_id, scope_type, scope_id, period)
);
create table instrument_attributes (
  instrument_id uuid not null references instruments(id) on delete cascade,
  as_of date not null,
  sector text, industry text,
  market_cap_band text,            -- large | mid | small | micro
  credit_rating text, rating_agency text,
  modified_duration numeric(6,2),
  issuer text,
  manager text,                    -- AMC / PMS / AIF manager
  liquidity_class text,            -- t0 | t1 | t3 | quarterly | locked
  expense_ratio_pct numeric(6,3),
  source text,
  primary key (instrument_id, as_of)
);
create table ips_rules (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references families(id) on delete cascade,
  entity_id uuid references entities(id),
  code text not null,              -- max_single_issuer | max_single_manager | min_credit_rating | max_illiquid_pct | max_sector_pct | max_unrated_pct | min_liquidity_months | max_leverage_pct
  params jsonb not null,           -- {"pct":10} / {"rating":"AA"} / ...
  severity smallint not null default 2,
  active boolean not null default true
);
create table ips_breaches (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references families(id) on delete cascade,
  rule_id uuid not null references ips_rules(id) on delete cascade,
  detected_on date not null,
  detail jsonb not null,
  resolved_on date,
  task_id uuid references tasks(id)
);
create table fund_cashflows (                -- private funds: calls and distributions for DPI/TVPI/PME
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references families(id) on delete cascade,
  private_investment_id uuid not null references private_investments(id) on delete cascade,
  flow_date date not null,
  kind text not null,              -- call | distribution | recallable | fee | nav
  amount numeric(18,2) not null,
  forecast boolean not null default false,
  source text
);
create table fees_ledger (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references families(id) on delete cascade,
  entity_id uuid not null references entities(id),
  fee_date date not null,
  kind text not null,              -- ter_implied | pms_mgmt | pms_perf | aif_mgmt | brokerage | stt | advisor | custody | dp_charges | other
  instrument_id uuid references instruments(id),
  account_id uuid references accounts(id),
  amount numeric(18,2) not null,
  source text
);

-- ---------- D1 document extraction, D2 reconciliation ----------
create table document_extractions (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references families(id) on delete cascade,
  document_id uuid not null references documents(id) on delete cascade,
  doc_type text,                   -- capital_call | nav_statement | contract_note | pms_statement | bank_statement | insurance | loan_statement | other
  model text not null,
  extracted jsonb not null,
  confidence numeric(4,3),
  status extraction_status not null default 'needs_review',
  reviewed_by uuid references users(id),
  reviewed_at timestamptz,
  applied_import_job_id uuid references import_jobs(id),
  created_at timestamptz not null default now()
);
create table reconciliation_items (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references families(id) on delete cascade,
  run_at timestamptz not null default now(),
  source text not null,            -- ecas_nsdl | ecas_cdsl | cas_mf | bank_aa | pms_stmt
  entity_id uuid references entities(id),
  instrument_id uuid references instruments(id),
  account_id uuid references accounts(id),
  platform_qty numeric(18,6), source_qty numeric(18,6),
  platform_amt numeric(18,2), source_amt numeric(18,2),
  status recon_status not null,
  note text,
  resolved_by uuid references users(id), resolved_at timestamptz
);

-- ---------- D3 cash-flow forecast ----------
create table cashflow_forecast (
  family_id uuid not null references families(id) on delete cascade,
  entity_id uuid,
  month date not null,
  kind text not null,              -- rent | dividend | coupon | maturity | capital_call | distribution | tax | emi | premium | lifestyle | sip | other
  amount numeric(18,2) not null,
  source_type text, source_id uuid,
  computed_at timestamptz not null default now(),
  entity_key uuid generated always as (coalesce(entity_id,'00000000-0000-0000-0000-000000000000'::uuid)) stored,
  source_key uuid generated always as (coalesce(source_id,'00000000-0000-0000-0000-000000000000'::uuid)) stored,
  primary key (family_id, entity_key, month, kind, source_key)
);

-- ---------- E1 report packs, E2 external viewers, E4 open data ----------
create table report_packs (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references families(id) on delete cascade,
  name text not null,
  audience text not null,          -- principal | family | ca | advisor | trustee
  sections jsonb not null,         -- [{"report_code":"net_worth","params":{}}, ...]
  cron text,
  recipients text[],
  created_by uuid references users(id)
);
create table report_pack_runs (
  id uuid primary key default gen_random_uuid(),
  pack_id uuid not null references report_packs(id) on delete cascade,
  version int not null,
  period_label text not null,
  generated_at timestamptz not null default now(),
  storage_key text,
  supersedes_run_id uuid references report_pack_runs(id),
  correction_note text
);
create table external_access (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references families(id) on delete cascade,
  user_id uuid not null references users(id),
  label text not null,             -- "CA – S. Krishnan"
  scope jsonb not null,            -- {"entities":[...],"modules":["reports","investments"],"reports":["capital_gains","rent_gst"]}
  expires_on date not null,
  invited_by uuid references users(id),
  revoked_at timestamptz
);
create table api_keys (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references families(id) on delete cascade,
  label text not null,
  key_hash text not null,
  key_prefix text not null,
  scopes text[] not null,          -- read:holdings read:reports write:txns ...
  created_by uuid references users(id),
  last_used_at timestamptz,
  expires_on date,
  revoked_at timestamptz
);
create table webhooks (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references families(id) on delete cascade,
  url text not null,
  secret_hash text not null,
  events text[] not null,          -- task.created import.done rent.overdue ips.breach plan.approved ...
  active boolean not null default true,
  last_delivery_at timestamptz, failures int not null default 0
);

do $$ declare t text; begin
  foreach t in array array['liabilities','insurance_policies','lifestyle_assets','ownership_links','nominations','succession_documents','valuations_daily','twr_cache','ips_rules','ips_breaches','fund_cashflows','fees_ledger','document_extractions','reconciliation_items','cashflow_forecast','report_packs','external_access','api_keys','webhooks'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format($p$create policy %I_tenant on %I using (family_id = current_setting('app.family_id', true)::uuid) with check (family_id = current_setting('app.family_id', true)::uuid)$p$, t, t);
  end loop; end $$;
grant select, insert, update, delete on liabilities, liability_schedule, insurance_policies, lifestyle_assets, ownership_links, nominations, succession_documents, valuations_daily, twr_cache, instrument_attributes, ips_rules, ips_breaches, fund_cashflows, fees_ledger, document_extractions, reconciliation_items, cashflow_forecast, report_packs, report_pack_runs, external_access, api_keys, webhooks to app_user;
