-- Family Office — initial schema (PostgreSQL 16)
-- Apply with: psql "$DATABASE_URL" -f db/001_init.sql
-- Conventions: uuid PKs, family_id on tenant tables, soft delete via deleted_at, RLS by family.

create extension if not exists "pgcrypto";
create extension if not exists "citext";

-- ---------- enums ----------
create type member_role as enum ('owner','member','operator','viewer');
create type entity_type as enum ('individual','huf','trust','llp','company');
create type tax_regime as enum ('old','new');
create type bucket as enum ('liquidity','income','growth');
create type instrument_type as enum ('stock','etf','mf','pms','aif','bond','sgb','gsec','tbill','fd','rd','nps','ppf','epf','insurance','gold');
create type account_kind as enum ('demat','mf_folio','pms','aif','bank','card','fd','other');
create type inv_txn_type as enum ('buy','sell','dividend','interest','bonus','split','rights','buyback','merger','demerger','sip','switch_in','switch_out','redemption','capital_call','distribution','fee','maturity');
create type txn_source as enum ('cas','contract_note','manual','api','corporate_action');
create type ca_status as enum ('pending','applied','review');
create type gain_term as enum ('short','long');
create type property_type as enum ('residential','commercial','land','under_construction');
create type party_type as enum ('individual','company');
create type rent_status as enum ('due','received','partial','overdue','waived');
create type expense_category as enum ('maintenance','repair','society','insurance','loan_interest','brokerage','other');
create type gst_form as enum ('gstr1','gstr3b');
create type private_instrument as enum ('equity','ccps','ccd','safe_post','safe_pre','conv_note','fund_units');
create type private_status as enum ('active','unconverted','exited','written_off');
create type mark_basis as enum ('last_round','manual','nav');
create type bank_account_type as enum ('savings','current','card','od');
create type sync_mode as enum ('aa','csv','manual');
create type category_kind as enum ('inflow','outflow','transfer');
create type link_type as enum ('none','rent','dividend','interest','redemption','sip','drawdown','property_tax','expense','transfer');
create type outflow_kind as enum ('advance_tax','gst','property_tax','drawdown','card_due','sip','emi','manual');
create type plan_status as enum ('proposed','tasked','executed');
create type task_status as enum ('open','done','dismissed');
create type verification as enum ('na','pending','verified','mismatch');
create type created_by as enum ('system','user');
create type notif_channel as enum ('inapp','push','email','whatsapp');
create type import_source as enum ('cas','contract_note','pms_stmt','bank_csv','form26as','ecas');
create type job_status as enum ('queued','running','done','failed','needs_mapping');
create type scope_type as enum ('asset','entity','bucket','family','goal');
create type period as enum ('1y','3y','5y','si');

create or replace function set_updated_at() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;

-- ---------- core ----------
create table families (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  base_currency char(3) not null default 'INR',
  ingest_address citext unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table users (
  id uuid primary key default gen_random_uuid(),
  email citext unique not null,
  phone text,
  name text not null,
  password_hash text not null,
  mfa_secret text,
  mfa_enabled boolean not null default false,
  last_login_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table family_members (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references families(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  role member_role not null,
  entity_scope uuid[],
  invited_at timestamptz,
  accepted_at timestamptz,
  unique (family_id, user_id)
);

create table entities (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references families(id) on delete cascade,
  type entity_type not null,
  name text not null,
  pan_enc bytea,
  pan_last4 text,
  dob_or_incorp date,
  residential_status text default 'resident',
  tax_regime tax_regime not null default 'new',
  slab_rate numeric(5,2) not null default 30.00,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table entity_gstins (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references families(id) on delete cascade,
  entity_id uuid not null references entities(id) on delete cascade,
  gstin text not null unique,
  state_code char(2) not null,
  registered_on date,
  active boolean not null default true
);

-- ---------- investments ----------
create table instruments (
  id uuid primary key default gen_random_uuid(),
  type instrument_type not null,
  isin text unique,
  symbol text,
  name text not null,
  amfi_code text unique,
  exchange text,
  default_bucket bucket not null default 'growth',
  asset_class text not null,
  meta jsonb not null default '{}'
);
create index on instruments (symbol);

create table accounts (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references families(id) on delete cascade,
  entity_id uuid not null references entities(id),
  kind account_kind not null,
  provider text,
  identifier_masked text,
  meta jsonb not null default '{}',
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table holdings (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references families(id) on delete cascade,
  entity_id uuid not null references entities(id),
  account_id uuid references accounts(id),
  instrument_id uuid not null references instruments(id),
  quantity numeric(18,6) not null default 0,
  avg_cost numeric(18,4) not null default 0,
  bucket bucket not null,
  goal_id uuid,
  last_valued_at timestamptz,
  updated_at timestamptz not null default now(),
  unique (entity_id, account_id, instrument_id)
);

create table lots (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references families(id) on delete cascade,
  holding_id uuid not null references holdings(id) on delete cascade,
  buy_date date not null,
  quantity numeric(18,6) not null,
  remaining_qty numeric(18,6) not null,
  unit_cost numeric(18,4) not null,
  charges numeric(18,2) not null default 0,
  grandfathered_fmv numeric(18,4),
  source_txn_id uuid
);
create index on lots (holding_id, buy_date);

create table investment_txns (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references families(id) on delete cascade,
  entity_id uuid not null references entities(id),
  account_id uuid references accounts(id),
  instrument_id uuid not null references instruments(id),
  type inv_txn_type not null,
  txn_date date not null,
  quantity numeric(18,6),
  price numeric(18,4),
  amount numeric(18,2) not null,
  charges numeric(18,2) not null default 0,
  source txn_source not null,
  source_ref text,
  hash text not null,
  created_at timestamptz not null default now(),
  unique (family_id, hash)
);
create index on investment_txns (entity_id, txn_date);

create table prices (
  instrument_id uuid not null references instruments(id) on delete cascade,
  price_date date not null,
  close numeric(18,4) not null,
  source text not null,
  primary key (instrument_id, price_date)
);

create table corporate_actions (
  id uuid primary key default gen_random_uuid(),
  instrument_id uuid not null references instruments(id),
  type inv_txn_type not null,
  ex_date date not null,
  record_date date,
  ratio_num numeric(12,4),
  ratio_den numeric(12,4),
  cash_per_unit numeric(18,4),
  new_instrument_id uuid references instruments(id),
  cost_split_pct numeric(6,3),
  status ca_status not null default 'pending',
  source text,
  created_at timestamptz not null default now()
);

create table tax_rules (
  id uuid primary key default gen_random_uuid(),
  fy text not null,
  asset_class text not null,
  term gain_term not null,
  rate numeric(5,2) not null,
  taxed_at_slab boolean not null default false,
  exemption_amount numeric(18,2) not null default 0,
  holding_months_for_long int not null,
  indexation boolean not null default false,
  notes text,
  unique (fy, asset_class, term)
);

create table realized_gains (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references families(id) on delete cascade,
  entity_id uuid not null references entities(id),
  instrument_id uuid not null references instruments(id),
  lot_id uuid references lots(id),
  sell_txn_id uuid references investment_txns(id),
  fy text not null,
  buy_date date not null,
  sell_date date not null,
  quantity numeric(18,6) not null,
  cost numeric(18,2) not null,
  proceeds numeric(18,2) not null,
  gain numeric(18,2) not null,
  term gain_term not null,
  asset_class text not null,
  tax_rate_applied numeric(5,2),
  exemption_used numeric(18,2) not null default 0
);
create index on realized_gains (entity_id, fy);

create table benchmarks (id uuid primary key default gen_random_uuid(), code text unique not null, name text not null);
create table benchmark_prices (benchmark_id uuid references benchmarks(id) on delete cascade, price_date date, value numeric(18,4), primary key (benchmark_id, price_date));

create table xirr_cache (
  family_id uuid not null references families(id) on delete cascade,
  scope_type scope_type not null,
  scope_id uuid not null,
  period period not null,
  value numeric(8,4),
  computed_at timestamptz not null default now(),
  primary key (family_id, scope_type, scope_id, period)
);

-- ---------- real estate ----------
create table properties (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references families(id) on delete cascade,
  type property_type not null,
  name text not null,
  address jsonb not null default '{}',
  acquisition_date date,
  acquisition_cost numeric(18,2) not null default 0,
  stamp_duty numeric(18,2) not null default 0,
  registration numeric(18,2) not null default 0,
  self_occupied boolean not null default false,
  bucket bucket not null default 'income',
  status text not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table property_owners (
  property_id uuid references properties(id) on delete cascade,
  entity_id uuid references entities(id),
  ownership_pct numeric(6,3) not null default 100,
  primary key (property_id, entity_id)
);

create table property_valuations (
  id uuid primary key default gen_random_uuid(),
  property_id uuid not null references properties(id) on delete cascade,
  valued_on date not null,
  value numeric(18,2) not null,
  source text,
  note text
);

create table tenants (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references families(id) on delete cascade,
  name text not null,
  pan_last4 text,
  phone text,
  email citext,
  type party_type not null default 'individual'
);

create table leases (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references families(id) on delete cascade,
  property_id uuid not null references properties(id),
  tenant_id uuid not null references tenants(id),
  entity_gstin_id uuid references entity_gstins(id),
  start_date date not null,
  end_date date not null,
  rent numeric(18,2) not null,
  due_day smallint not null default 5,
  grace_days smallint not null default 3,
  escalation_pct numeric(5,2) not null default 0,
  escalation_every_months smallint,
  deposit numeric(18,2) not null default 0,
  gst_applicable boolean not null default false,
  gst_rate numeric(5,2) not null default 18,
  tds_applicable boolean not null default false,
  tds_rate numeric(5,2) not null default 10,
  notice_days smallint not null default 90,
  status text not null default 'active',
  document_id uuid
);

create table rent_schedule (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references families(id) on delete cascade,
  lease_id uuid not null references leases(id) on delete cascade,
  period_month date not null,
  expected_rent numeric(18,2) not null,
  expected_gst numeric(18,2) not null default 0,
  expected_tds numeric(18,2) not null default 0,
  due_date date not null,
  received_amount numeric(18,2) not null default 0,
  received_on date,
  bank_txn_id uuid,
  status rent_status not null default 'due',
  unique (lease_id, period_month)
);

create table property_taxes (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references families(id) on delete cascade,
  property_id uuid not null references properties(id) on delete cascade,
  authority text not null,
  assessment_no text,
  period text not null,
  amount numeric(18,2) not null,
  due_date date not null,
  paid_on date,
  bank_txn_id uuid,
  status text not null default 'due'
);

create table property_expenses (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references families(id) on delete cascade,
  property_id uuid not null references properties(id) on delete cascade,
  expense_date date not null,
  category expense_category not null,
  capital_improvement boolean not null default false,
  vendor text,
  amount numeric(18,2) not null,
  bank_txn_id uuid,
  document_id uuid,
  note text
);

create table gst_returns (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references families(id) on delete cascade,
  entity_gstin_id uuid not null references entity_gstins(id),
  period_month date not null,
  form gst_form not null,
  taxable_value numeric(18,2) not null default 0,
  tax_amount numeric(18,2) not null default 0,
  due_date date,
  filed_on date,
  arn text,
  status text not null default 'due',
  unique (entity_gstin_id, period_month, form)
);

create table tds_26as (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references families(id) on delete cascade,
  entity_id uuid not null references entities(id),
  fy text not null,
  quarter smallint not null,
  deductor_tan text,
  deductor_name text,
  section text,
  amount_paid numeric(18,2),
  tds_deducted numeric(18,2),
  source_file uuid
);

-- ---------- private investments ----------
create table private_companies (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references families(id) on delete cascade,
  name text not null, cin text, sector text, website text
);

create table private_investments (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references families(id) on delete cascade,
  entity_id uuid not null references entities(id),
  company_id uuid not null references private_companies(id),
  instrument private_instrument not null,
  stage text,
  invested_on date not null,
  amount numeric(18,2) not null,
  shares_or_units numeric(18,6),
  holding_pct numeric(6,3),
  valuation_cap numeric(18,2),
  discount_pct numeric(5,2),
  status private_status not null default 'active',
  bucket bucket not null default 'growth',
  goal_id uuid,
  next_event text,
  created_at timestamptz not null default now()
);

create table private_rounds (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references private_companies(id) on delete cascade,
  round_name text not null,
  closed_on date,
  pre_money numeric(18,2),
  raised numeric(18,2),
  post_money numeric(18,2),
  total_shares_post numeric(18,0),
  price_per_share numeric(18,4)
);

create table private_marks (
  id uuid primary key default gen_random_uuid(),
  private_investment_id uuid not null references private_investments(id) on delete cascade,
  marked_on date not null,
  value numeric(18,2) not null,
  basis mark_basis not null,
  note text
);

create table fund_commitments (
  id uuid primary key default gen_random_uuid(),
  private_investment_id uuid not null references private_investments(id) on delete cascade,
  total_commitment numeric(18,2) not null,
  drawn numeric(18,2) not null default 0,
  schedule jsonb not null default '[]'
);

create table private_exits (
  id uuid primary key default gen_random_uuid(),
  private_investment_id uuid not null references private_investments(id),
  exit_on date not null,
  shares_or_units numeric(18,6),
  proceeds numeric(18,2) not null,
  gain numeric(18,2),
  tax_estimate numeric(18,2)
);

-- ---------- goals & buckets ----------
create table bucket_targets (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references families(id) on delete cascade,
  entity_id uuid references entities(id),
  liquidity_pct numeric(5,2) not null,
  income_pct numeric(5,2) not null,
  growth_pct numeric(5,2) not null,
  drift_threshold_pp numeric(4,2) not null default 1.5,
  effective_from date not null default current_date,
  check (liquidity_pct + income_pct + growth_pct = 100)
);

create table goals (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references families(id) on delete cascade,
  entity_id uuid references entities(id),
  name text not null,
  target_year int not null,
  amount_today numeric(18,2) not null,
  inflation_pct numeric(5,2) not null default 6,
  bucket bucket not null,
  assumed_return_pct numeric(5,2) not null default 11,
  funded_pct numeric(5,2),
  status text not null default 'active'
);
alter table holdings add constraint holdings_goal_fk foreign key (goal_id) references goals(id);
alter table private_investments add constraint pi_goal_fk foreign key (goal_id) references goals(id);

create table goal_links (
  goal_id uuid references goals(id) on delete cascade,
  holding_id uuid references holdings(id) on delete cascade,
  private_investment_id uuid references private_investments(id) on delete cascade,
  property_id uuid references properties(id) on delete cascade,
  allocation_pct numeric(6,3) not null default 100,
  check (num_nonnulls(holding_id, private_investment_id, property_id) = 1)
);

create table glide_paths (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references families(id) on delete cascade,
  goal_id uuid references goals(id) on delete cascade,
  steps jsonb not null
);

-- ---------- banking ----------
create table aa_consents (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references families(id) on delete cascade,
  entity_id uuid not null references entities(id),
  provider text not null,
  consent_handle text,
  status text not null default 'pending',
  granted_on timestamptz,
  expires_on timestamptz
);

create table bank_accounts (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references families(id) on delete cascade,
  entity_id uuid not null references entities(id),
  bank text not null,
  account_masked text not null,
  type bank_account_type not null,
  aa_consent_id uuid references aa_consents(id),
  balance numeric(18,2) not null default 0,
  balance_as_of timestamptz,
  sync_mode sync_mode not null default 'csv',
  card_due_day smallint,
  deleted_at timestamptz
);

create table categories (
  id uuid primary key default gen_random_uuid(),
  family_id uuid references families(id) on delete cascade,
  name text not null,
  kind category_kind not null,
  parent_id uuid references categories(id)
);

create table bank_txns (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references families(id) on delete cascade,
  bank_account_id uuid not null references bank_accounts(id) on delete cascade,
  txn_date date not null,
  value_date date,
  narration text not null,
  amount numeric(18,2) not null,
  balance_after numeric(18,2),
  category_id uuid references categories(id),
  counterparty text,
  link_type link_type not null default 'none',
  link_id uuid,
  hash text not null,
  source sync_mode not null,
  created_at timestamptz not null default now(),
  unique (bank_account_id, hash)
);
create index on bank_txns (family_id, txn_date desc);
alter table rent_schedule add constraint rs_bank_txn_fk foreign key (bank_txn_id) references bank_txns(id);
alter table property_taxes add constraint pt_bank_txn_fk foreign key (bank_txn_id) references bank_txns(id);
alter table property_expenses add constraint pe_bank_txn_fk foreign key (bank_txn_id) references bank_txns(id);

create table categorisation_rules (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references families(id) on delete cascade,
  pattern text not null,
  field text not null default 'narration',
  category_id uuid not null references categories(id),
  link_type link_type not null default 'none',
  link_id uuid,
  priority int not null default 100,
  learned boolean not null default false
);

-- ---------- working capital, tasks, docs, reports, ops ----------
create table wc_settings (
  family_id uuid primary key references families(id) on delete cascade,
  float_days int not null default 60,
  buffer_months numeric(4,2) not null default 1,
  idle_days int not null default 30,
  instrument_prefs jsonb not null default '{}'
);

create table committed_outflows (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references families(id) on delete cascade,
  entity_id uuid references entities(id),
  kind outflow_kind not null,
  label text not null,
  due_date date not null,
  amount numeric(18,2) not null,
  recurring_months smallint,
  source_type text, source_id uuid,
  status text not null default 'pending'
);

create table deployment_plans (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references families(id) on delete cascade,
  created_at timestamptz not null default now(),
  excess_amount numeric(18,2) not null,
  lines jsonb not null,
  status plan_status not null default 'proposed'
);

create table tasks (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references families(id) on delete cascade,
  entity_id uuid references entities(id),
  module text not null,
  title text not null,
  reason text,
  amount numeric(18,2),
  due_date date,
  assignee_user_id uuid references users(id),
  status task_status not null default 'open',
  verification verification not null default 'na',
  source_type text, source_id uuid,
  created_by created_by not null default 'system',
  severity smallint not null default 2,
  created_at timestamptz not null default now(),
  done_at timestamptz
);
create index on tasks (family_id, status, due_date);

create table notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  task_id uuid references tasks(id) on delete cascade,
  channel notif_channel not null,
  payload jsonb not null default '{}',
  sent_at timestamptz, read_at timestamptz
);

create table folders (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references families(id) on delete cascade,
  parent_id uuid references folders(id),
  name text not null,
  system boolean not null default false
);

create table documents (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references families(id) on delete cascade,
  entity_id uuid references entities(id),
  folder_id uuid references folders(id),
  name text not null,
  mime text not null,
  size bigint not null,
  storage_key text not null,
  sha256 text not null,
  uploaded_by uuid references users(id),
  linked_type text, linked_id uuid,
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);
alter table leases add constraint leases_doc_fk foreign key (document_id) references documents(id);
alter table property_expenses add constraint pe_doc_fk foreign key (document_id) references documents(id);

create table report_schedules (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references families(id) on delete cascade,
  report_code text not null,
  params jsonb not null default '{}',
  cron text not null,
  recipients text[] not null,
  format text not null default 'pdf',
  last_run_at timestamptz
);

create table import_mappings (
  id uuid primary key default gen_random_uuid(),
  family_id uuid references families(id) on delete cascade,
  source import_source not null,
  provider text not null,
  header_signature text not null,
  mapping jsonb not null,
  unique (family_id, source, header_signature)
);

create table import_jobs (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references families(id) on delete cascade,
  source import_source not null,
  file_document_id uuid references documents(id),
  status job_status not null default 'queued',
  rows_total int default 0, rows_ok int default 0, rows_error int default 0,
  error_log jsonb not null default '[]',
  mapping_id uuid references import_mappings(id),
  created_at timestamptz not null default now(),
  finished_at timestamptz
);

create table audit_log (
  id bigserial primary key,
  family_id uuid,
  user_id uuid,
  action text not null,
  table_name text not null,
  row_id uuid,
  before jsonb, after jsonb,
  at timestamptz not null default now()
);
create index on audit_log (family_id, at desc);

-- ---------- updated_at triggers ----------
do $$ declare t text; begin
  for t in select unnest(array['families','users','entities','properties','holdings']) loop
    execute format('create trigger %I_upd before update on %I for each row execute function set_updated_at()', t, t);
  end loop; end $$;

-- ---------- row level security ----------
-- The API runs:  select set_config('app.family_id', '<uuid>', true);  inside every request transaction.
do $$ declare t text; begin
  for t in select distinct table_name from information_schema.columns
           where table_schema='public' and column_name='family_id'
             and table_name not in ('audit_log','categories','import_mappings') loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format($p$create policy %I_tenant on %I using (family_id = current_setting('app.family_id', true)::uuid) with check (family_id = current_setting('app.family_id', true)::uuid)$p$, t, t);
  end loop; end $$;
alter table categories enable row level security;
create policy categories_tenant on categories using (family_id is null or family_id = current_setting('app.family_id', true)::uuid);
alter table import_mappings enable row level security;
create policy import_mappings_tenant on import_mappings using (family_id is null or family_id = current_setting('app.family_id', true)::uuid);

-- Application role: API connects as app_user (RLS enforced). Migrations/seeds run as the DB owner.
do $$ begin
  if not exists (select 1 from pg_roles where rolname='app_user') then create role app_user login; end if;
end $$;
grant usage on schema public to app_user;
grant select, insert, update, delete on all tables in schema public to app_user;
grant usage, select on all sequences in schema public to app_user;
alter default privileges in schema public grant select, insert, update, delete on tables to app_user;

-- ---------- reference data ----------
insert into tax_rules (fy, asset_class, term, rate, taxed_at_slab, exemption_amount, holding_months_for_long, indexation, notes) values
('2026-27','equity','short',20,false,0,12,false,'Listed equity / equity MF; STT paid'),
('2026-27','equity','long',12.5,false,125000,12,false,'Exemption Rs 1.25 L per entity; grandfathered to 31 Jan 2018 FMV'),
('2026-27','debt_mf_post_apr23','short',0,true,0,9999,false,'Always slab regardless of holding'),
('2026-27','debt_mf_pre_apr23','long',12.5,false,0,24,false,'Units bought before 1 Apr 2023'),
('2026-27','listed_bond','short',0,true,0,12,false,''),
('2026-27','listed_bond','long',12.5,false,0,12,false,''),
('2026-27','unlisted_equity','short',0,true,0,24,false,'Startups, CCPS, unlisted shares'),
('2026-27','unlisted_equity','long',12.5,false,0,24,false,''),
('2026-27','real_estate','short',0,true,0,24,false,''),
('2026-27','real_estate','long',12.5,false,0,24,false,'Or 20% with indexation if acquired before 23 Jul 2024, whichever is lower'),
('2026-27','gold','short',0,true,0,24,false,''),
('2026-27','gold','long',12.5,false,0,24,false,''),
('2026-27','arbitrage_fund','short',20,false,0,12,false,'Equity-oriented'),
('2026-27','arbitrage_fund','long',12.5,false,125000,12,false,'Shares the equity exemption');

insert into benchmarks (code, name) values ('NIFTY50','Nifty 50 TRI'),('NIFTY500','Nifty 500 TRI'),('CRISIL_CBI','CRISIL Composite Bond Index'),('BLEND_6040','60% Nifty 50 / 40% CRISIL CBI');

insert into categories (family_id, name, kind) values
(null,'Rental income','inflow'),(null,'Dividend','inflow'),(null,'Interest','inflow'),(null,'Redemption','inflow'),(null,'Salary / fees','inflow'),(null,'Other income','inflow'),
(null,'Investment / SIP','outflow'),(null,'Property tax','outflow'),(null,'Maintenance','outflow'),(null,'Tax payment','outflow'),(null,'GST payment','outflow'),(null,'Household','outflow'),
(null,'Medical','outflow'),(null,'Education','outflow'),(null,'Travel','outflow'),(null,'Dining','outflow'),(null,'Insurance premium','outflow'),(null,'EMI','outflow'),(null,'Card payment','transfer'),(null,'Internal transfer','transfer');
