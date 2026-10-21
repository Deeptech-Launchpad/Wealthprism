-- Family Office — Research & Proposals: ingest recommendation feeds, extract, score sources, check against
-- Investment Policy, generate investment proposals, periodic digest with approve/reject/defer → action plane.
-- Apply after 009.

create type source_kind as enum ('research_house','broker','advisor','pms_manager','newsletter','friend','media','internal','other');
create type channel_kind as enum ('email','upload','paste','rss','whatsapp','api','web');
create type rec_action as enum ('buy','sell','hold','accumulate','reduce','avoid','switch','subscribe','redeem','watch');
create type rec_status as enum ('new','extracted','clustered','assessed','proposal_drafted','dismissed','superseded');
create type proposal_status as enum ('draft','in_review','approved','rejected','deferred','converted','expired');
create type fit_verdict as enum ('fits','fits_with_conditions','conflicts','prohibited','insufficient_info');

-- ---------- sources & channels ----------
create table research_sources (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references families(id) on delete cascade,
  kind source_kind not null,
  name text not null,
  organisation text,
  contact text,                                  -- email / phone (masked)
  conflict_of_interest text,                     -- e.g. earns brokerage, distributes regular plans, manages PMS, none
  sebi_registration text,                        -- RA / RIA / PMS number if any
  trust_score numeric(5,2) not null default 50,  -- 0–100, updated from track record
  notes text,
  active boolean not null default true,
  created_at timestamptz not null default now()
);
create table research_channels (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references families(id) on delete cascade,
  kind channel_kind not null,
  label text not null,
  config jsonb not null default '{}',            -- {"address":"research-7f3a@ingest…"} | {"url":".../rss"} | {"sender_allowlist":[...]}
  default_source_id uuid references research_sources(id),
  active boolean not null default true
);

-- ---------- raw items ----------
create table research_items (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references families(id) on delete cascade,
  channel_id uuid references research_channels(id),
  source_id uuid references research_sources(id),
  received_at timestamptz not null default now(),
  title text,
  sender text,
  body_text text,                                -- extracted text (PDF/email/paste)
  document_id uuid references documents(id),
  sha256 text not null,
  language text default 'en',
  status rec_status not null default 'new',
  extraction_id uuid references document_extractions(id),
  unique (family_id, sha256)
);
create index on research_items (family_id, received_at desc);

-- ---------- structured recommendations ----------
create table research_recommendations (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references families(id) on delete cascade,
  item_id uuid not null references research_items(id) on delete cascade,
  source_id uuid references research_sources(id),
  instrument_id uuid references instruments(id),
  instrument_text text not null,                 -- as written when unresolved
  action rec_action not null,
  thesis text,
  target_price numeric(18,4), stop_loss numeric(18,4),
  horizon_months int,
  conviction text,                               -- high | medium | low
  published_on date,
  price_at_publish numeric(18,4),
  cluster_id uuid,
  status rec_status not null default 'extracted',
  confidence numeric(4,3),
  created_at timestamptz not null default now()
);
create index on research_recommendations (family_id, instrument_id, action);

create table recommendation_clusters (                -- same instrument + direction within a window, across sources
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references families(id) on delete cascade,
  instrument_id uuid references instruments(id),
  instrument_text text not null,
  direction text not null,                       -- bullish | bearish | neutral
  first_seen date not null, last_seen date not null,
  source_count int not null default 1,
  weighted_conviction numeric(5,2),              -- trust-weighted
  consensus text,                                -- e.g. "4 of 5 sources bullish; 1 broker sell"
  status rec_status not null default 'clustered'
);
alter table research_recommendations add constraint rr_cluster_fk foreign key (cluster_id) references recommendation_clusters(id);

-- ---------- policy fit & assessment ----------
create table recommendation_assessments (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references families(id) on delete cascade,
  cluster_id uuid not null references recommendation_clusters(id) on delete cascade,
  policy_version_id uuid references policy_versions(id),     -- effective policy used
  entity_id uuid references entities(id),                    -- proposed home for the position
  goal_id uuid references goals(id),
  verdict fit_verdict not null,
  fit_score numeric(5,2),                        -- 0–100
  checks jsonb not null,                         -- [{"clause":"permitted","status":"pass"},{"clause":"equity_band","status":"warning","detail":"would move equity 58.9→60.4% (band 35–55)"},{"clause":"issuer_max",...},{"clause":"tax","detail":"..."}]
  already_held jsonb,                            -- {"holding_id":..,"qty":..,"weight_pct":..}
  sizing jsonb,                                  -- {"max_by_policy":..,"suggested":..,"basis":"issuer cap / bucket headroom"}
  agent_session_id uuid references agent_sessions(id),
  assessed_at timestamptz not null default now()
);

-- ---------- source track record ----------
create table source_track_record (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references families(id) on delete cascade,
  source_id uuid not null references research_sources(id) on delete cascade,
  recommendation_id uuid not null references research_recommendations(id) on delete cascade,
  horizon_months int not null,
  evaluated_on date not null,
  price_then numeric(18,4), price_now numeric(18,4),
  return_pct numeric(8,3), benchmark_return_pct numeric(8,3), excess_pct numeric(8,3),
  hit boolean,                                   -- direction right vs benchmark
  unique (recommendation_id, horizon_months)
);

-- ---------- investment proposals ----------
create table investment_proposals (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references families(id) on delete cascade,
  cluster_id uuid references recommendation_clusters(id),
  assessment_id uuid references recommendation_assessments(id),
  version int not null default 1,
  title text not null,
  instrument_id uuid references instruments(id),
  action rec_action not null,
  entity_id uuid references entities(id),
  goal_id uuid references goals(id),
  amount numeric(18,2),
  sections jsonb not null,                       -- {"summary":..,"thesis":..,"sources":[..],"counter_view":..,"policy_fit":{...},"portfolio_impact":{...},"tax_impact":{...},"risks":[..],"sizing":{...},"execution_plan":[..],"exit_plan":{...},"monitoring":[..]}
  simulation jsonb,                              -- from planner: tax delta, drift after, cash after, ips pass
  agent_session_id uuid references agent_sessions(id),
  status proposal_status not null default 'draft',
  digest_id uuid,
  decided_by uuid references users(id),
  decided_at timestamptz,
  decision_note text,
  defer_until date,
  intent_batch_id uuid,                          -- action_intents.batch_id when converted
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger investment_proposals_upd before update on investment_proposals for each row execute function set_updated_at();

-- ---------- periodic digest (the call-to-action report) ----------
create table research_digests (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references families(id) on delete cascade,
  period_start date not null, period_end date not null,
  cadence text not null,                         -- weekly | fortnightly | monthly | ad_hoc
  generated_at timestamptz not null default now(),
  summary jsonb not null,                        -- {"items":..,"recommendations":..,"clusters":..,"dismissed":..,"proposals":..,"source_leaderboard":[..],"themes":[..]}
  proposal_ids uuid[] not null default '{}',
  document_id uuid references documents(id),
  sent_to text[],
  status text not null default 'open'            -- open | actioned | closed
);
alter table investment_proposals add constraint ip_digest_fk foreign key (digest_id) references research_digests(id);

-- proposal state machine
create or replace function proposal_transition() returns trigger language plpgsql as $$
begin
  if old.status = new.status then return new; end if;
  if (old.status, new.status) not in (
    ('draft','in_review'),('draft','rejected'),('in_review','approved'),('in_review','rejected'),('in_review','deferred'),('in_review','expired'),
    ('deferred','in_review'),('deferred','rejected'),('deferred','expired'),('approved','converted'),('approved','rejected')) then
    raise exception 'illegal proposal transition % -> %', old.status, new.status;
  end if;
  if new.status in ('approved','rejected','deferred') and new.decided_by is null then raise exception 'decision requires decided_by'; end if;
  return new;
end $$;
create trigger investment_proposals_fsm before update on investment_proposals for each row execute function proposal_transition();

do $$ declare t text; begin
  foreach t in array array['research_sources','research_channels','research_items','research_recommendations','recommendation_clusters','recommendation_assessments','source_track_record','investment_proposals','research_digests'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format($p$create policy %I_tenant on %I using (family_id = current_setting('app.family_id', true)::uuid) with check (family_id = current_setting('app.family_id', true)::uuid)$p$, t, t);
  end loop; end $$;
grant select, insert, update, delete on research_sources, research_channels, research_items, research_recommendations, recommendation_clusters, recommendation_assessments, source_track_record, investment_proposals, research_digests to app_user;
