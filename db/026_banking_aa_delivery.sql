-- Milestone 12: banking Account Aggregator flows, categorisation rules, internal transfers, e-mail ingest, delivery log.
-- Extends 002/006 tables; RLS on every family table; grants for app_user.

-- ---------- Account Aggregator consents and fetches ----------
alter table aa_consents add column if not exists consent_id text;                       -- the AA's consent artefact id (after approval)
alter table aa_consents add column if not exists redirect_url text;
alter table aa_consents add column if not exists mobile text;
alter table aa_consents add column if not exists fi_types text[] not null default '{DEPOSIT}';
alter table aa_consents add column if not exists purpose text;
alter table aa_consents add column if not exists data_from date;
alter table aa_consents add column if not exists data_to date;
alter table aa_consents add column if not exists key_material text;                     -- our ECDH key pair for FI decryption, encrypted at rest
alter table aa_consents add column if not exists last_fetch_at timestamptz;
alter table aa_consents add column if not exists next_fetch_at timestamptz;
alter table aa_consents add column if not exists fetch_error text;
alter table aa_consents add column if not exists revoked_on date;
alter table aa_consents add column if not exists accounts jsonb not null default '[]';   -- accounts the AA reported as linked under this consent
alter table aa_consents add column if not exists created_at timestamptz not null default now();
alter table aa_consents add column if not exists updated_at timestamptz not null default now();
create index if not exists aa_consents_handle_idx on aa_consents (consent_handle);

create table if not exists aa_fetches (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references families(id) on delete cascade,
  consent_id uuid not null references aa_consents(id) on delete cascade,
  bank_account_id uuid references bank_accounts(id) on delete set null,
  fetched_at timestamptz not null default now(),
  from_date date, to_date date,
  txns_new int not null default 0, txns_dup int not null default 0,
  balance numeric(18,2),
  status text not null default 'ok',                                                     -- ok | failed
  error text
);
create index if not exists aa_fetches_consent_idx on aa_fetches (consent_id, fetched_at desc);
alter table aa_fetches enable row level security;
drop policy if exists aa_fetches_family on aa_fetches;
create policy aa_fetches_family on aa_fetches using (family_id = current_setting('app.family_id', true)::uuid) with check (family_id = current_setting('app.family_id', true)::uuid);
grant select, insert, update, delete on aa_fetches to app_user;

-- the AA webhook arrives without a family context: resolve the consent by its handle
create or replace function aa_consent_lookup(p_handle text)
returns table (id uuid, family_id uuid, entity_id uuid, provider text, status text)
language sql security definer set search_path = public stable as $$
  select a.id, a.family_id, a.entity_id, a.provider, a.status from aa_consents a where a.consent_handle = p_handle or a.consent_id = p_handle limit 1
$$;
revoke all on function aa_consent_lookup(text) from public;
grant execute on function aa_consent_lookup(text) to app_user;

-- ---------- categorisation rules and transfers ----------
alter table categorisation_rules add column if not exists name text;
alter table categorisation_rules add column if not exists active boolean not null default true;
alter table categorisation_rules add column if not exists hits int not null default 0;
alter table categorisation_rules add column if not exists last_hit_at timestamptz;
alter table categorisation_rules add column if not exists created_by uuid references users(id);
alter table categorisation_rules add column if not exists created_at timestamptz not null default now();
alter table categorisation_rules alter column field set default 'narration';
update categorisation_rules set name = initcap(lower(pattern)) where name is null;

alter table bank_txns add column if not exists is_transfer boolean not null default false;
alter table bank_txns add column if not exists transfer_txn_id uuid;                     -- the other leg of an internal transfer
alter table bank_txns add column if not exists note text;
alter table bank_txns add column if not exists updated_at timestamptz not null default now();
create index if not exists bank_txns_family_date_idx on bank_txns (family_id, txn_date desc);

-- ---------- e-mail ingest ----------
alter table families add column if not exists ingest_allow_senders text[] not null default '{}';
alter table families add column if not exists ingest_quarantine_unknown boolean not null default true;

create table if not exists email_ingest (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references families(id) on delete cascade,
  message_id text,
  sender text not null,
  recipient text,
  subject text,
  received_at timestamptz not null default now(),
  attachments jsonb not null default '[]',                                              -- [{name, mime, size, document_id, import_job_id, status, note}]
  status text not null default 'accepted',                                              -- accepted | quarantined | imported | partial | failed | rejected
  reason text,
  task_id uuid references tasks(id) on delete set null,
  released_by uuid references users(id), released_at timestamptz,
  created_at timestamptz not null default now()
);
create unique index if not exists email_ingest_message_idx on email_ingest (family_id, message_id) where message_id is not null;
alter table email_ingest enable row level security;
drop policy if exists email_ingest_family on email_ingest;
create policy email_ingest_family on email_ingest using (family_id = current_setting('app.family_id', true)::uuid) with check (family_id = current_setting('app.family_id', true)::uuid);
grant select, insert, update, delete on email_ingest to app_user;

-- inbound mail arrives without a family context: resolve the family by its ingest address
create or replace function family_by_ingest_address(p_addr text)
returns table (id uuid, name text, ingest_allow_senders text[], ingest_quarantine_unknown boolean)
language sql security definer set search_path = public stable as $$
  select f.id, f.name, f.ingest_allow_senders, f.ingest_quarantine_unknown from families f where lower(f.ingest_address) = lower(p_addr) limit 1
$$;
revoke all on function family_by_ingest_address(text) from public;
grant execute on function family_by_ingest_address(text) to app_user;

-- ---------- delivery ----------
alter table rent_reminders add column if not exists provider text;
alter table rent_reminders add column if not exists provider_ref text;
alter table rent_reminders add column if not exists attempts int not null default 0;
alter table rent_reminders add column if not exists next_attempt_at timestamptz;

create table if not exists message_log (
  id uuid primary key default gen_random_uuid(),
  family_id uuid references families(id) on delete cascade,                             -- null for account-level mail (digests)
  channel text not null,                                                                -- email | whatsapp | sms | push
  to_contact text not null,
  subject text,
  provider text not null,
  provider_ref text,
  status text not null,                                                                 -- sent | failed | logged
  error text,
  ref_type text, ref_id uuid,
  sent_at timestamptz not null default now()
);
create index if not exists message_log_family_idx on message_log (family_id, sent_at desc);
alter table message_log enable row level security;
drop policy if exists message_log_family on message_log;
create policy message_log_family on message_log using (family_id is null or family_id = nullif(current_setting('app.family_id', true), '')::uuid) with check (family_id is null or family_id = nullif(current_setting('app.family_id', true), '')::uuid);
grant select, insert, update, delete on message_log to app_user;

-- ---------- demo ----------
update families set ingest_address = coalesce(ingest_address, 'mehta-family@ingest.familyoffice.local'), ingest_allow_senders = case when ingest_allow_senders = '{}' then array['statements@zerodha.com', 'donotreply@camsonline.com', 'noreply@hdfcbank.net', 'arjun@example.com'] else ingest_allow_senders end
where id = '11111111-1111-1111-1111-111111111111';
update categorisation_rules set name = case pattern when 'KOVAI ANALYTICS' then 'Kovai Analytics rent' when 'BLOOM PHARMACY' then 'Bloom Pharmacy rent' when 'PPFAS MF' then 'PPFAS SIP' when 'PROPERTY TAX' then 'Municipal property tax' else name end
where family_id = '11111111-1111-1111-1111-111111111111';

-- ISINs for the seeded schemes so depository statements (e-CAS) reconcile by ISIN
update instruments set isin = v.isin from (values ('Parag Parikh Flexi Cap Fund - Direct Growth','INF879O01027'), ('ICICI Prudential Liquid Fund - Direct Growth','INF109K01VQ1'), ('Axis Small Cap Fund - Direct Growth','INF846K01K35'), ('Kotak Equity Arbitrage Fund - Direct Growth','INF174K01LQ9')) v(name, isin)
where instruments.name = v.name and instruments.isin is null;
