-- 023 — Connectors (FO-124..127, FO-134): credentials at rest (the API writes, only the executor reads), executor jobs
-- (session refresh, health, MF reads, mandate status, bill fetch, cancel, status poll), NACH e-mandates, persisted sandbox
-- provider state (so a crash mid-submit provably never double-submits), payee provenance, and the demo family's connectors.

alter table connectors add column if not exists config jsonb not null default '{}';           -- portal_authorisation, ria_code, redirect_uri, static_ip …
alter table connectors add column if not exists capabilities jsonb;                            -- cached capability matrix row for the UI
alter table payees add column if not exists created_at timestamptz not null default now();
alter table payees add column if not exists created_by uuid references users(id);
alter table payees add column if not exists beneficiary_ref text;                              -- bank-side beneficiary id after registration
alter table payees add column if not exists beneficiary_status text;                           -- registered | pending | rejected
alter table action_intents add column if not exists route text;                                -- executable | assisted
alter table action_intents add column if not exists confirmed_ref text;                        -- reference the person typed for an assisted intent
alter table action_executions add column if not exists client_ref text;                        -- idempotency key sent to the provider

create table if not exists connector_credentials (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references families(id) on delete cascade,
  connector_id uuid not null references connectors(id) on delete cascade,
  name text not null,                              -- api_key | api_secret | totp_seed | access_token | client_certificate | private_key | …
  ciphertext text not null,                        -- AES-256-GCM under FIELD_ENCRYPTION_KEY; never returned by the API
  created_at timestamptz not null default now(),
  rotated_at timestamptz,
  unique (connector_id, name)
);
create table if not exists connector_jobs (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references families(id) on delete cascade,
  connector_id uuid references connectors(id) on delete cascade,
  kind text not null,                              -- health | session_refresh | mf_read | positions_read | mandate_register | mandate_status | bill_fetch | status_poll | cancel | beneficiary_register
  payload jsonb not null default '{}',
  status text not null default 'queued',           -- queued | running | done | failed
  result jsonb,
  error text,
  requested_by uuid references users(id),
  created_at timestamptz not null default now(),
  started_at timestamptz, finished_at timestamptz
);
create index if not exists connector_jobs_queue on connector_jobs (family_id, status, created_at);
create table if not exists nach_mandates (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references families(id) on delete cascade,
  entity_id uuid not null references entities(id),
  connector_id uuid references connectors(id),      -- the MF platform it favours
  bank_account_id uuid references bank_accounts(id),
  umrn text,                                       -- unique mandate reference once registered
  provider_ref text,
  amount_limit numeric(18,2) not null,
  frequency text not null default 'as_and_when',   -- as_and_when | monthly
  start_date date not null default current_date,
  end_date date,
  status text not null default 'pending',          -- pending | active | rejected | expired | cancelled
  auth_mode text,                                  -- netbanking | debit_card | aadhaar
  auth_url text,
  registered_at timestamptz, last_status_at timestamptz,
  created_by uuid references users(id),
  created_at timestamptz not null default now()
);
create table if not exists connector_sandbox_orders (   -- the simulated provider's own book, keyed by the idempotency key we send
  connector_id uuid not null references connectors(id) on delete cascade,
  client_ref text not null,
  provider_ref text not null,
  status text not null,
  body jsonb not null,
  created_at timestamptz not null default now(),
  primary key (connector_id, client_ref)
);
do $$ declare t text; begin
  foreach t in array array['connector_credentials','connector_jobs','nach_mandates'] loop
    execute format('alter table %I enable row level security', t); execute format('alter table %I force row level security', t);
    if not exists (select 1 from pg_policies where tablename = t) then
      execute format($p$create policy %I_tenant on %I using (family_id = current_setting('app.family_id', true)::uuid) with check (family_id = current_setting('app.family_id', true)::uuid)$p$, t, t);
    end if;
  end loop; end $$;
grant select, insert, update, delete on connector_credentials, connector_jobs, nach_mandates, connector_sandbox_orders to app_user;
-- the API may write credentials and see that they exist; only the executor reads the ciphertext
revoke select on connector_credentials from app_user;
grant select (id, family_id, connector_id, name, created_at, rotated_at) on connector_credentials to app_user;
grant select on connector_credentials, connector_jobs, nach_mandates, instruments, prices, bank_accounts, property_taxes, nach_mandates to executor_user;
grant update (status, result, error, started_at, finished_at) on connector_jobs to executor_user;
grant update (status, umrn, provider_ref, registered_at, last_status_at, auth_url) on nach_mandates to executor_user;
grant update (status, session_expires_at, last_health_at, last_error, account_ref) on connectors to executor_user;
grant insert (family_id, connector_id, name, ciphertext, rotated_at), update (ciphertext, rotated_at) on connector_credentials to executor_user;
grant select, insert, update, delete on connector_sandbox_orders to executor_user;
grant update (status, updated_at, confirmed_ref, route) on action_intents to executor_user;

-- ---------- demo connectors (all sandbox), payees, mandates, policies ----------
insert into connectors (id, family_id, entity_id, kind, provider, label, account_ref, linked_account_id, linked_bank_account_id, status, scopes, session_expires_at, static_ip, sandbox, config, created_by) values
('c1000000-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','33333333-0000-0000-0000-000000000001','broker','zerodha_kite','Zerodha Kite Connect','ZX1234','45454545-0000-0000-0000-000000000001',null,'pending_auth','{place:orders,read:positions,read:mf}',null,'203.0.113.24',true,'{"redirect_uri":"https://app.familyoffice.local/connectors/callback","note":"daily login pending"}','22222222-0000-0000-0000-000000000001'),
('c1000000-0000-0000-0000-000000000002','11111111-1111-1111-1111-111111111111','33333333-0000-0000-0000-000000000003','broker','icici_breeze','ICICI Direct Breeze','1301****7715','45454545-0000-0000-0000-000000000003',null,'sandbox','{place:orders,read:positions}',(date_trunc('day', now() at time zone 'Asia/Kolkata') + interval '23 hours 59 minutes') at time zone 'Asia/Kolkata',null,true,'{}','22222222-0000-0000-0000-000000000001'),
('c1000000-0000-0000-0000-000000000003','11111111-1111-1111-1111-111111111111','33333333-0000-0000-0000-000000000002','bank_api','icici_cib','ICICI Corporate API Suite','••0928',null,'89898989-0000-0000-0000-000000000002','sandbox','{initiate:payment,txn:status,read:balance}',null,'203.0.113.24',true,'{"portal_authorisation":true,"corp_id":"MEHTAHUF","user_id":"KARTA01"}','22222222-0000-0000-0000-000000000001'),
('c1000000-0000-0000-0000-000000000004','11111111-1111-1111-1111-111111111111','33333333-0000-0000-0000-000000000002','bbps','setu_bbps','Setu BBPS',null,null,'89898989-0000-0000-0000-000000000002','sandbox','{fetch:bill,pay:bill}',null,null,true,'{"all_entities":true}','22222222-0000-0000-0000-000000000001'),
('c1000000-0000-0000-0000-000000000005','11111111-1111-1111-1111-111111111111','33333333-0000-0000-0000-000000000001','mf_platform','bse_star_mf','BSE StAR MF via Cybrilla FP','RIA INA000012345',null,null,'sandbox','{place:mf_orders,read:folios,manage:mandates}',null,null,true,'{"ria_code":"INA000012345","plan":"direct","all_entities":true}','22222222-0000-0000-0000-000000000001')
on conflict (id) do nothing;
insert into payees (id, family_id, name, kind, account_masked, ifsc, vpa, bbps_biller_id, linked_type, linked_id, verified_by, verified_at, first_used_at, active, created_at, created_by, beneficiary_status) values
('c2000000-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','Coimbatore City Municipal Corporation','tax_authority',null,null,null,'CCMC00000COIMB','property_tax_authority',null,'22222222-0000-0000-0000-000000000002',now() - interval '120 days',now() - interval '90 days',true,now() - interval '121 days','22222222-0000-0000-0000-000000000001','registered'),
('c2000000-0000-0000-0000-000000000002','11111111-1111-1111-1111-111111111111','Greater Chennai Corporation','tax_authority',null,null,null,'GCC00000NATUR','property_tax_authority',null,'22222222-0000-0000-0000-000000000002',now() - interval '120 days',null,true,now() - interval '121 days','22222222-0000-0000-0000-000000000001','registered'),
('c2000000-0000-0000-0000-000000000003','11111111-1111-1111-1111-111111111111','Ooty Municipality','tax_authority',null,null,null,'OOTYM0000MUNIC','property_tax_authority',null,'22222222-0000-0000-0000-000000000002',now() - interval '120 days',now() - interval '150 days',true,now() - interval '121 days','22222222-0000-0000-0000-000000000001','registered'),
('c2000000-0000-0000-0000-000000000004','11111111-1111-1111-1111-111111111111','Safeguard Systems (AMC vendor)','vendor','••4410','HDFC0001234','safeguard@upi',null,'vendor',null,'22222222-0000-0000-0000-000000000002',now() - interval '60 days',now() - interval '40 days',true,now() - interval '61 days','22222222-0000-0000-0000-000000000003','registered'),
('c2000000-0000-0000-0000-000000000005','11111111-1111-1111-1111-111111111111','Varaha Angel Fund II — escrow','fund_house','••2201','ICIC0000104',null,null,'fund_commitment',null,null,null,null,true,now() - interval '3 hours','22222222-0000-0000-0000-000000000003','pending'),
('c2000000-0000-0000-0000-000000000006','11111111-1111-1111-1111-111111111111','Mehta HUF — ICICI current ••0928','own_account','••0928','ICIC0000928',null,null,'bank_account','89898989-0000-0000-0000-000000000002','22222222-0000-0000-0000-000000000002',now() - interval '200 days',now() - interval '180 days',true,now() - interval '201 days','22222222-0000-0000-0000-000000000001','registered')
on conflict (id) do nothing;
insert into nach_mandates (id, family_id, entity_id, connector_id, bank_account_id, umrn, provider_ref, amount_limit, frequency, start_date, end_date, status, auth_mode, registered_at, last_status_at, created_by) values
('c3000000-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','33333333-0000-0000-0000-000000000001','c1000000-0000-0000-0000-000000000005','89898989-0000-0000-0000-000000000001','HDFC7000000012345678','mand_4f3a9c',50000,'as_and_when','2026-05-02','2036-05-01','active','netbanking','2026-05-02 09:14+05:30',now() - interval '1 day','22222222-0000-0000-0000-000000000001'),
('c3000000-0000-0000-0000-000000000002','11111111-1111-1111-1111-111111111111','33333333-0000-0000-0000-000000000003','c1000000-0000-0000-0000-000000000005','89898989-0000-0000-0000-000000000003','KKBK7000000098765432','mand_88b1e2',25000,'as_and_when','2026-06-15','2026-10-05','active','debit_card','2026-06-15 11:02+05:30',now() - interval '1 day','22222222-0000-0000-0000-000000000002'),
('c3000000-0000-0000-0000-000000000003','11111111-1111-1111-1111-111111111111','33333333-0000-0000-0000-000000000002','c1000000-0000-0000-0000-000000000005','89898989-0000-0000-0000-000000000002',null,'mand_pend01',100000,'as_and_when','2026-09-01',null,'pending','netbanking',null,now() - interval '2 days','22222222-0000-0000-0000-000000000001')
on conflict (id) do nothing;
insert into execution_policies (family_id, entity_id, intent_kind, code, params, active, created_by)
select '11111111-1111-1111-1111-111111111111', null, v.kind::intent_kind, v.code, v.params::jsonb, true, '22222222-0000-0000-0000-000000000001'
from (values ('equity_order','trading_hours_only','{"queue_at_next_open":true}'), (null,'max_daily_amount','{"amount":1000000}'), (null,'max_orders_per_day','{"count":20}'), (null,'block_new_payee_days','{"days":1}'), ('bank_transfer','allowed_payees','{"verified_only":true}'), ('capital_call_payment','allowed_payees','{"verified_only":true}')) v(kind, code, params)
where not exists (select 1 from execution_policies e where e.family_id='11111111-1111-1111-1111-111111111111' and e.code=v.code and e.intent_kind is not distinct from v.kind::intent_kind);
