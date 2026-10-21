-- Family Office — Action plane: AI-assisted execution with policy guardrails, human approval, connectors, audit.
-- Apply after 007.

create type connector_kind as enum ('broker','mf_platform','bank_api','bbps','payout','custom');
create type connector_status as enum ('pending_auth','active','expired','revoked','error','sandbox');
create type intent_kind as enum (
  'equity_order','mf_purchase','mf_redemption','mf_switch','mf_sip_mandate',
  'bank_transfer','bill_payment','tax_payment','gst_payment','capital_call_payment','rent_reminder',
  'assisted'            -- prepared instructions the human completes manually (UPI intent, Retail Direct, PMS form)
);
create type intent_status as enum ('draft','policy_failed','pending_approval','approved','rejected','expired','queued','submitted','partially_filled','filled','failed','cancelled','reconciled','posted');
create type approval_decision as enum ('approved','rejected','deferred');
create type agent_role as enum ('user','assistant','tool','system');

-- ---------- connectors ----------
create table connectors (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references families(id) on delete cascade,
  entity_id uuid not null references entities(id),
  kind connector_kind not null,
  provider text not null,                     -- zerodha_kite | upstox | angel_smartapi | icici_breeze | dhan | bse_star_mf | mfu | icici_cib | hdfc_corp | axis_corp | setu_bbps | razorpayx | manual
  label text not null,
  account_ref text,                           -- broker client id / bank account id (masked)
  linked_account_id uuid references accounts(id),
  linked_bank_account_id uuid references bank_accounts(id),
  status connector_status not null default 'pending_auth',
  scopes text[] not null default '{}',        -- read:holdings place:orders read:balance initiate:payment ...
  credential_ref text,                        -- vault path / KMS-encrypted blob id; never the secret
  session_expires_at timestamptz,             -- Kite-style daily tokens
  static_ip text,
  sandbox boolean not null default false,
  last_health_at timestamptz, last_error text,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);

-- ---------- policies & limits ----------
create table execution_policies (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references families(id) on delete cascade,
  entity_id uuid references entities(id),
  intent_kind intent_kind,                    -- null = all kinds
  code text not null,                         -- max_single_amount | max_daily_amount | max_monthly_amount | approvers_required | cooling_off_minutes | allowed_instruments | blocked_instruments | allowed_payees | trading_hours_only | require_simulation | max_orders_per_day | require_ips_pass | require_tax_check | block_new_payee_days
  params jsonb not null,                      -- {"amount":500000} {"count":2,"above":200000} {"minutes":30,"above":1000000} {"isins":[...]} {"payee_ids":[...]}
  active boolean not null default true,
  created_by uuid references users(id),
  updated_at timestamptz not null default now()
);
create table execution_limits_usage (
  family_id uuid not null references families(id) on delete cascade,
  entity_id uuid references entities(id),
  intent_kind intent_kind,
  window_start date not null,                 -- day or month start
  window_kind text not null,                  -- day | month
  amount_used numeric(18,2) not null default 0,
  count_used int not null default 0,
  entity_key uuid generated always as (coalesce(entity_id,'00000000-0000-0000-0000-000000000000'::uuid)) stored,
  kind_key text not null default '',       -- set by app = intent_kind or '' for all-kinds
  primary key (family_id, entity_key, kind_key, window_kind, window_start)
);
create table payees (                         -- allow-listed counterparties for payments
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references families(id) on delete cascade,
  name text not null,
  kind text not null,                         -- vendor | tax_authority | tenant_refund | fund_house | own_account | other
  account_masked text, ifsc text, vpa text, bbps_biller_id text,
  linked_type text, linked_id uuid,           -- vendor/tenant/property/private_investment
  verified_by uuid references users(id), verified_at timestamptz,
  first_used_at timestamptz,
  active boolean not null default true
);
create table kill_switches (
  family_id uuid primary key references families(id) on delete cascade,
  paused boolean not null default false,
  paused_by uuid references users(id),
  paused_at timestamptz,
  reason text
);

-- ---------- agent (AI) sessions ----------
create table agent_sessions (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references families(id) on delete cascade,
  user_id uuid not null references users(id),
  model text not null,
  purpose text,                               -- rebalance | deploy_cash | pay_bills | tax_plan | question
  started_at timestamptz not null default now(),
  ended_at timestamptz
);
create table agent_messages (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references families(id) on delete cascade,
  session_id uuid not null references agent_sessions(id) on delete cascade,
  seq int not null,
  role agent_role not null,
  content text,
  tool_name text, tool_args jsonb, tool_result jsonb,
  tokens_in int, tokens_out int,
  created_at timestamptz not null default now(),
  unique (session_id, seq)
);

-- ---------- action intents ----------
create table action_intents (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references families(id) on delete cascade,
  entity_id uuid not null references entities(id),
  kind intent_kind not null,
  status intent_status not null default 'draft',
  connector_id uuid references connectors(id),
  payload jsonb not null,                     -- kind-specific, validated against schema: {"instrument_id","side","quantity","order_type","limit_price","product"} / {"amfi_code","amount","folio"} / {"payee_id","amount","remarks","mode":"NEFT|IMPS|UPI"} ...
  amount numeric(18,2) not null,
  rationale text,                             -- AI or human explanation
  proposed_by_kind text not null,             -- agent | user | rule
  proposed_by_user_id uuid references users(id),
  agent_session_id uuid references agent_sessions(id),
  source_type text, source_id uuid,           -- task | plan_action | deployment_plan | rent_schedule | committed_outflow | ips_breach
  simulation jsonb,                           -- {"tax_delta":..,"drift_after":[...],"cash_after":..,"warnings":[...]}
  policy_result jsonb,                        -- [{"code":"max_single_amount","pass":true,...}]
  approvers_required smallint not null default 1,
  cooling_off_until timestamptz,
  expires_at timestamptz not null,
  batch_id uuid,                              -- group intents for batch approval
  idempotency_key text not null unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on action_intents (family_id, status, created_at desc);
create trigger action_intents_upd before update on action_intents for each row execute function set_updated_at();

create table action_approvals (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references families(id) on delete cascade,
  intent_id uuid not null references action_intents(id) on delete cascade,
  approver_user_id uuid not null references users(id),
  decision approval_decision not null,
  note text,
  auth_method text not null,                  -- totp | biometric | passkey
  device_id text, ip text, user_agent text,
  decided_at timestamptz not null default now(),
  unique (intent_id, approver_user_id)
);

create table action_executions (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references families(id) on delete cascade,
  intent_id uuid not null references action_intents(id) on delete cascade,
  attempt smallint not null default 1,
  connector_id uuid not null references connectors(id),
  request jsonb not null,                     -- exact provider request (secrets redacted)
  response jsonb,
  provider_ref text,                          -- order id / UTR / transaction id
  status intent_status not null,
  filled_qty numeric(18,6), avg_price numeric(18,4), fees numeric(18,2),
  submitted_at timestamptz not null default now(),
  completed_at timestamptz,
  error text,
  unique (intent_id, attempt)
);

create table action_reconciliations (
  intent_id uuid primary key references action_intents(id) on delete cascade,
  family_id uuid not null references families(id) on delete cascade,
  matched_type text,                          -- investment_txn | bank_txn
  matched_id uuid,
  variance jsonb,
  gl_journal_id uuid references gl_journals(id),
  reconciled_at timestamptz
);

-- state machine guard: only allowed transitions
create or replace function action_intent_transition() returns trigger language plpgsql as $$
declare ok boolean := false;
begin
  if old.status = new.status then return new; end if;
  ok := (old.status, new.status) in (
    ('draft','policy_failed'),('draft','pending_approval'),('draft','cancelled'),
    ('policy_failed','draft'),('policy_failed','cancelled'),
    ('pending_approval','approved'),('pending_approval','rejected'),('pending_approval','expired'),('pending_approval','cancelled'),
    ('approved','queued'),('approved','cancelled'),('approved','expired'),
    ('queued','submitted'),('queued','failed'),('queued','cancelled'),
    ('submitted','partially_filled'),('submitted','filled'),('submitted','failed'),('submitted','cancelled'),
    ('partially_filled','filled'),('partially_filled','cancelled'),('partially_filled','failed'),
    ('filled','reconciled'),('reconciled','posted'),('failed','draft')
  );
  if not ok then raise exception 'illegal intent transition % -> %', old.status, new.status; end if;
  -- an intent cannot become approved without the required number of approvals
  if new.status = 'approved' and (select count(*) from action_approvals a where a.intent_id = new.id and a.decision = 'approved') < new.approvers_required then
    raise exception 'intent % needs % approvals', new.id, new.approvers_required;
  end if;
  if new.status = 'queued' and new.cooling_off_until is not null and now() < new.cooling_off_until then
    raise exception 'intent % is in cooling-off until %', new.id, new.cooling_off_until;
  end if;
  if new.status = 'queued' and exists (select 1 from kill_switches k where k.family_id = new.family_id and k.paused) then
    raise exception 'execution paused for family %', new.family_id;
  end if;
  return new;
end $$;
create trigger action_intents_fsm before update on action_intents for each row execute function action_intent_transition();

-- approver must not be the human proposer (four-eyes)
create or replace function action_approval_four_eyes() returns trigger language plpgsql as $$
declare pid uuid;
begin
  select proposed_by_user_id into pid from action_intents where id = new.intent_id;
  if pid is not null and pid = new.approver_user_id then raise exception 'proposer cannot approve own intent'; end if;
  return new;
end $$;
create trigger action_approvals_four_eyes before insert on action_approvals for each row execute function action_approval_four_eyes();

do $$ declare t text; begin
  foreach t in array array['connectors','execution_policies','execution_limits_usage','payees','kill_switches','agent_sessions','agent_messages','action_intents','action_approvals','action_executions','action_reconciliations'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format($p$create policy %I_tenant on %I using (family_id = current_setting('app.family_id', true)::uuid) with check (family_id = current_setting('app.family_id', true)::uuid)$p$, t, t);
  end loop; end $$;
grant select, insert, update, delete on connectors, execution_policies, execution_limits_usage, payees, kill_switches, agent_sessions, agent_messages, action_intents, action_approvals, action_executions, action_reconciliations to app_user;

-- executor role: a separate DB role for the executor service with narrower rights (no delete, no policy edits)
do $$ begin if not exists (select 1 from pg_roles where rolname='executor_user') then create role executor_user login; end if; end $$;
grant usage on schema public to executor_user;
grant select on connectors, action_intents, action_approvals, execution_policies, kill_switches, payees to executor_user;
grant insert, update on action_executions to executor_user;
grant update (status, updated_at) on action_intents to executor_user;

-- default policies inserted per family by the API on family creation (documented here as reference):
-- max_single_amount 5,00,000 · approvers_required {count:1} / {count:2, above:10,00,000} · cooling_off_minutes {minutes:30, above:25,00,000}
-- block_new_payee_days {days:1} · trading_hours_only · require_simulation for equity/mf · require_tax_check for sells · max_orders_per_day 20
