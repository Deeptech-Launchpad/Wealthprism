-- Family Office — Investment Policy Framework: versioned policies per family / entity / goal,
-- risk profiling, allocation + bands, risk-metric limits, guardrails, compliance snapshots, periodic reviews.
-- Apply after 008.

create type policy_scope as enum ('family','entity','goal');
create type policy_status as enum ('draft','in_review','active','superseded','archived');
create type risk_profile as enum ('conservative','moderately_conservative','moderate','moderately_aggressive','aggressive');
create type review_kind as enum ('scheduled','trigger','ad_hoc');
create type review_status as enum ('due','in_progress','completed','skipped');

-- ---------- policies & versions ----------
create table investment_policies (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references families(id) on delete cascade,
  scope policy_scope not null,
  entity_id uuid references entities(id),
  goal_id uuid references goals(id),
  name text not null,
  parent_policy_id uuid references investment_policies(id),   -- entity/goal policies inherit from family policy
  current_version_id uuid,
  review_every_months smallint not null default 12,
  next_review_on date,
  created_at timestamptz not null default now(),
  deleted_at timestamptz,
  scope_key uuid generated always as (coalesce(goal_id, entity_id, '00000000-0000-0000-0000-000000000000'::uuid)) stored,
  unique (family_id, scope, scope_key)
);

create table policy_versions (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references families(id) on delete cascade,
  policy_id uuid not null references investment_policies(id) on delete cascade,
  version int not null,
  status policy_status not null default 'draft',
  effective_from date,
  effective_to date,
  -- narrative sections (rendered into the IPS document)
  objectives jsonb not null default '{}',        -- {"purpose":..,"return_objective_pct":..,"return_basis":"real|nominal","horizon_years":..,"spending_need_pa":..}
  risk jsonb not null default '{}',              -- {"profile":"moderate","score":62,"capacity":"high","tolerance":"moderate","max_drawdown_pct":-20,"questionnaire_response_id":..}
  constraints jsonb not null default '{}',       -- {"liquidity_months":24,"tax":{"prefer_direct_plans":true,"ltcg_first":true},"legal":[..],"unique":[..],"esg":[..]}
  permitted jsonb not null default '{}',         -- {"instrument_types":[..],"min_rating":"AA","max_single_issuer_pct":10,"prohibited":["crypto","f&o","unrated_debt"],"managers":[..]}
  rebalancing jsonb not null default '{}',       -- {"method":"bands|calendar|both","calendar":"quarterly","tolerance_pp":5,"use_new_cash_first":true,"tax_aware":true}
  monitoring jsonb not null default '{}',        -- {"benchmark_id":..,"tracking_error_max_pct":..,"report_to":["principal","ca"],"review_every_months":12,"triggers":[..]}
  guardrails jsonb not null default '{}',        -- {"execution_policies":[{"code":"max_single_amount","params":{...}}...], "approval_tiers":[...]}
  change_summary text,
  created_by uuid references users(id),
  approved_by uuid references users(id),
  approved_at timestamptz,
  signed_by jsonb not null default '[]',         -- [{"user_id":..,"name":..,"role":"principal","signed_at":..,"auth_method":..}]
  document_id uuid references documents(id),     -- rendered IPS PDF
  created_at timestamptz not null default now(),
  unique (policy_id, version)
);
alter table investment_policies add constraint ip_current_version_fk foreign key (current_version_id) references policy_versions(id);
create unique index policy_versions_one_active on policy_versions (policy_id) where status = 'active';

-- allocation targets owned by a policy version (bucket lens + asset-class lens with bands)
create table policy_allocations (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references families(id) on delete cascade,
  policy_version_id uuid not null references policy_versions(id) on delete cascade,
  lens text not null,                            -- bucket | asset_class | sub_class | geography | currency
  key text not null,                             -- liquidity | equity | large_cap | IN | USD ...
  target_pct numeric(5,2) not null,
  min_pct numeric(5,2),
  max_pct numeric(5,2),
  unique (policy_version_id, lens, key)
);

-- risk-metric limits owned by a policy version
create table policy_risk_limits (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references families(id) on delete cascade,
  policy_version_id uuid not null references policy_versions(id) on delete cascade,
  metric text not null,                          -- volatility_1y | max_drawdown | var_95_1m | beta | tracking_error | sharpe_min | concentration_top5 | issuer_max | manager_max | sector_max | illiquid_max | liquidity_coverage_months_min | unrated_debt_max | leverage_max | fx_exposure_max | duration_max
  operator text not null,                        -- <= | >= 
  limit_value numeric(12,4) not null,
  warn_value numeric(12,4),                      -- soft threshold
  severity smallint not null default 2,
  unique (policy_version_id, metric)
);

-- link existing rule/target tables to the policy version that owns them
alter table ips_rules add column if not exists policy_version_id uuid references policy_versions(id) on delete set null;
alter table asset_class_targets add column if not exists policy_version_id uuid references policy_versions(id) on delete set null;
alter table bucket_targets add column if not exists policy_version_id uuid references policy_versions(id) on delete set null;
alter table execution_policies add column if not exists policy_version_id uuid references policy_versions(id) on delete set null;
alter table glide_paths add column if not exists policy_version_id uuid references policy_versions(id) on delete set null;

-- ---------- risk profiling ----------
create table risk_questionnaires (
  id uuid primary key default gen_random_uuid(),
  family_id uuid references families(id) on delete cascade,   -- null = system default
  name text not null,
  version int not null default 1,
  questions jsonb not null,                       -- [{"id":"q1","dimension":"capacity|tolerance|horizon|knowledge","text":..,"options":[{"label":..,"score":..}]}]
  scoring jsonb not null,                         -- {"bands":[{"max":30,"profile":"conservative"},...],"weights":{"capacity":0.5,"tolerance":0.3,"horizon":0.2}}
  family_key uuid generated always as (coalesce(family_id,'00000000-0000-0000-0000-000000000000'::uuid)) stored,
  unique (family_key, name, version)
);
create table risk_questionnaire_responses (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references families(id) on delete cascade,
  questionnaire_id uuid not null references risk_questionnaires(id),
  entity_id uuid references entities(id),
  goal_id uuid references goals(id),
  respondent_user_id uuid references users(id),
  answers jsonb not null,
  score numeric(5,2) not null,
  capacity_score numeric(5,2), tolerance_score numeric(5,2), horizon_score numeric(5,2),
  profile risk_profile not null,
  completed_at timestamptz not null default now()
);

-- ---------- computed risk metrics & compliance ----------
create table risk_metrics (
  family_id uuid not null references families(id) on delete cascade,
  scope_type scope_type not null,
  scope_id uuid not null,
  as_of date not null,
  metric text not null,
  value numeric(14,6) not null,
  lookback text,                                  -- 1y | 3y | 1m ...
  benchmark_id uuid references benchmarks(id),
  primary key (family_id, scope_type, scope_id, as_of, metric)
);
create table policy_compliance (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references families(id) on delete cascade,
  policy_version_id uuid not null references policy_versions(id) on delete cascade,
  as_of date not null,
  overall text not null,                          -- compliant | warning | breach
  checks jsonb not null,                          -- [{"kind":"allocation|risk_limit|permitted|ips_rule|liquidity","key":..,"target":..,"actual":..,"status":..,"detail":..}]
  breaches int not null default 0,
  warnings int not null default 0,
  task_ids uuid[] not null default '{}',
  unique (policy_version_id, as_of)
);

-- ---------- periodic reviews ----------
create table policy_reviews (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references families(id) on delete cascade,
  policy_id uuid not null references investment_policies(id) on delete cascade,
  kind review_kind not null,
  trigger_reason text,                            -- scheduled | life_event | market_move | breach_persisting | goal_change | regulation
  due_on date not null,
  status review_status not null default 'due',
  started_at timestamptz, completed_at timestamptz,
  reviewer_user_id uuid references users(id),
  findings jsonb,                                 -- compliance summary, drift, metric trends since last review
  outcome text,                                   -- no_change | amended | superseded
  resulting_version_id uuid references policy_versions(id),
  task_id uuid references tasks(id),
  note text
);

do $$ declare t text; begin
  foreach t in array array['investment_policies','policy_versions','policy_allocations','policy_risk_limits','risk_questionnaire_responses','risk_metrics','policy_compliance','policy_reviews'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format($p$create policy %I_tenant on %I using (family_id = current_setting('app.family_id', true)::uuid) with check (family_id = current_setting('app.family_id', true)::uuid)$p$, t, t);
  end loop; end $$;
alter table risk_questionnaires enable row level security;
create policy risk_questionnaires_tenant on risk_questionnaires using (family_id is null or family_id = current_setting('app.family_id', true)::uuid) with check (family_id = current_setting('app.family_id', true)::uuid);
grant select, insert, update, delete on investment_policies, policy_versions, policy_allocations, policy_risk_limits, risk_questionnaires, risk_questionnaire_responses, risk_metrics, policy_compliance, policy_reviews to app_user;

-- ---------- system risk questionnaire (12 questions, three dimensions) ----------
insert into risk_questionnaires (family_id, name, version, questions, scoring) values (null, 'Standard family risk profile', 1, '[
 {"id":"q1","dimension":"capacity","text":"What share of annual family expenses is covered by reliable income (rent, coupons, dividends, salary) without selling assets?","options":[{"label":"Under 50%","score":1},{"label":"50–100%","score":3},{"label":"Over 100%","score":5}]},
 {"id":"q2","dimension":"capacity","text":"How many months of expenses are held in cash and liquid funds?","options":[{"label":"Under 6","score":1},{"label":"6–24","score":3},{"label":"Over 24","score":5}]},
 {"id":"q3","dimension":"capacity","text":"What share of investable wealth is committed to dated goals within 5 years?","options":[{"label":"Over 50%","score":1},{"label":"20–50%","score":3},{"label":"Under 20%","score":5}]},
 {"id":"q4","dimension":"capacity","text":"Total liabilities as a share of net worth","options":[{"label":"Over 30%","score":1},{"label":"10–30%","score":3},{"label":"Under 10%","score":5}]},
 {"id":"q5","dimension":"tolerance","text":"If the growth portfolio fell 25% in a year, you would","options":[{"label":"Sell to stop further loss","score":1},{"label":"Hold and wait","score":3},{"label":"Add to positions","score":5}]},
 {"id":"q6","dimension":"tolerance","text":"The largest single-year loss you would accept on the whole portfolio","options":[{"label":"5%","score":1},{"label":"10–15%","score":3},{"label":"25% or more","score":5}]},
 {"id":"q7","dimension":"tolerance","text":"Preferred trade-off","options":[{"label":"Lower return, rarely negative years","score":1},{"label":"Balanced","score":3},{"label":"Higher return, frequent negative years","score":5}]},
 {"id":"q8","dimension":"tolerance","text":"Experience with equity drawdowns (2008, 2020)","options":[{"label":"None / exited","score":1},{"label":"Held through","score":3},{"label":"Invested more","score":5}]},
 {"id":"q9","dimension":"horizon","text":"Years until the family needs to draw regular income from the portfolio","options":[{"label":"Under 5","score":1},{"label":"5–15","score":3},{"label":"Over 15","score":5}]},
 {"id":"q10","dimension":"horizon","text":"Intended holding period for the growth bucket","options":[{"label":"Under 3 years","score":1},{"label":"3–10 years","score":3},{"label":"Over 10 years / multi-generational","score":5}]},
 {"id":"q11","dimension":"knowledge","text":"Familiarity with PMS, AIF, unlisted and international investments","options":[{"label":"Low","score":1},{"label":"Moderate","score":3},{"label":"High","score":5}]},
 {"id":"q12","dimension":"knowledge","text":"Who makes investment decisions?","options":[{"label":"Advisor-led","score":1},{"label":"Joint","score":3},{"label":"Self-directed with advisers","score":5}]}
]', '{"weights":{"capacity":0.45,"tolerance":0.30,"horizon":0.15,"knowledge":0.10},"bands":[{"max":28,"profile":"conservative"},{"max":44,"profile":"moderately_conservative"},{"max":60,"profile":"moderate"},{"max":76,"profile":"moderately_aggressive"},{"max":100,"profile":"aggressive"}],"rule":"profile = min(capacity_band, tolerance_band) then adjusted by horizon; capacity caps tolerance"}');
