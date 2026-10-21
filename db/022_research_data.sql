-- 022 — Research pipeline (FO-150..158): settings, dismissal columns, demo sources / channels / inbox / recommendations,
-- a two-year monthly price history for the instruments the demo recommendations name (track record needs it), and a
-- 40-call archive per source so the leaderboard has a sample. Extends the demo family consistently; nothing here changes
-- rows that db/002–021 created except adding a clause to the family policy's prohibited list.

-- ---------- settings & small schema additions ----------
create table if not exists research_settings (
  family_id uuid primary key references families(id) on delete cascade,
  digest_cadence text not null default 'weekly',            -- weekly | fortnightly | monthly
  digest_weekday smallint not null default 0,               -- 0 = Sunday
  digest_hour smallint not null default 7,                  -- IST
  send_to text[] not null default '{}',                      -- member emails; empty = every owner/member
  ca_monthly_copy boolean not null default true,
  cluster_window_days int not null default 45,
  proposal_expiry_days int not null default 30,
  decide_roles text[] not null default '{owner,member}',
  updated_at timestamptz not null default now()
);
alter table research_settings enable row level security; alter table research_settings force row level security;
do $$ begin
  if not exists (select 1 from pg_policies where tablename='research_settings') then
    create policy research_settings_tenant on research_settings using (family_id = current_setting('app.family_id', true)::uuid) with check (family_id = current_setting('app.family_id', true)::uuid);
  end if;
end $$;
grant select, insert, update, delete on research_settings to app_user;

alter table recommendation_clusters add column if not exists dismissed_reason text;
alter table recommendation_clusters add column if not exists dismissed_by uuid references users(id);
alter table recommendation_clusters add column if not exists dismissed_at timestamptz;
alter table recommendation_clusters add column if not exists dismissed_auto boolean not null default false;
alter table research_recommendations add column if not exists review_note text;
alter table research_recommendations add column if not exists corrected_by uuid references users(id);
alter table research_items add column if not exists channel_kind channel_kind;
alter table research_items add column if not exists triage_note text;
alter table investment_proposals add column if not exists document_html text;
alter table research_digests add column if not exists document_html text;
alter table research_sources add column if not exists trust_history jsonb not null default '[]';

-- the family policy names small-cap single stocks as prohibited (prototype clause 6); the clause is data, read by the assessor
update policy_versions set permitted = jsonb_set(permitted, '{prohibited}', (permitted->'prohibited') || '["small_cap_stocks"]'::jsonb)
  where id = '9b000000-0000-0000-0000-000000000013' and not (permitted->'prohibited') ? 'small_cap_stocks';

-- ---------- instruments the demo research names ----------
insert into instruments (id, type, isin, symbol, name, amfi_code, exchange, default_bucket, asset_class) values
('44444444-0000-0000-0000-000000000010','stock','INE018A01030','LT','Larsen & Toubro',null,'NSE','growth','equity'),
('44444444-0000-0000-0000-000000000011','stock','INE155A01022','TATAMOTORS','Tata Motors',null,'NSE','growth','equity')
on conflict (id) do nothing;
insert into instrument_attributes (instrument_id, as_of, sector, industry, market_cap_band, issuer, liquidity_class, source) values
('44444444-0000-0000-0000-000000000010','2026-09-01','Industrials','Engineering & construction','large','Larsen & Toubro','t1','seed'),
('44444444-0000-0000-0000-000000000011','2026-09-01','Auto','Passenger & commercial vehicles','large','Tata Motors','t1','seed')
on conflict do nothing;

-- ---------- monthly price history Jan 2024 – Sep 2026 (deterministic, format-faithful; the seeded 10 Sep 2026 closes stay) ----------
with months as (select generate_series(date '2024-01-31', date '2026-08-31', interval '1 month')::date d, generate_series(0, 31) n),
series(instrument_id, base, g, amp) as (values
  ('44444444-0000-0000-0000-000000000010'::uuid, 3390.0, 0.0025, 0.05),   -- L&T
  ('44444444-0000-0000-0000-000000000011'::uuid, 780.0, 0.0060, 0.09),    -- Tata Motors
  ('44444444-0000-0000-0000-000000000001'::uuid, 1470.0, 0.0050, 0.04),   -- HDFC Bank
  ('44444444-0000-0000-0000-000000000002'::uuid, 3760.0, 0.0002, 0.05))   -- TCS
insert into prices (instrument_id, price_date, close, source)
select s.instrument_id, (date_trunc('month', m.d) + interval '1 month - 1 day')::date, round((s.base * power(1 + s.g, m.n) * (1 + s.amp * sin(m.n * 0.9)))::numeric, 2), 'seed'
from months m cross join series s
on conflict do nothing;
insert into benchmark_prices (benchmark_id, price_date, value)
select b.id, (date_trunc('month', m.d) + interval '1 month - 1 day')::date,
  round((case b.code when 'NIFTY50' then 20000 * power(1.0075, m.n) * (1 + 0.035 * sin(m.n * 0.8)) when 'NIFTY500' then 17900 * power(1.0082, m.n) * (1 + 0.04 * sin(m.n * 0.8)) when 'CRISIL_CBI' then 4800 * power(1.0058, m.n) else 12900 * power(1.0068, m.n) * (1 + 0.02 * sin(m.n * 0.8)) end)::numeric, 2)
from (select generate_series(date '2024-01-31', date '2026-09-30', interval '1 month')::date d, generate_series(0, 32) n) m cross join benchmarks b
on conflict do nothing;

-- ---------- sources, channels, settings ----------
insert into research_sources (id, family_id, kind, name, organisation, contact, conflict_of_interest, sebi_registration, trust_score, notes) values
('a1000000-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','research_house','Capitalmind','Capitalmind Financial Services','premium@capitalmind.example','none','INH000012345',65,'Paid research subscription'),
('a1000000-0000-0000-0000-000000000002','11111111-1111-1111-1111-111111111111','pms_manager','Marcellus','Marcellus Investment Managers','letters@marcellus.example','manages PMS held (Consistent Compounders)','INP000005678',64,'Quarterly letters'),
('a1000000-0000-0000-0000-000000000003','11111111-1111-1111-1111-111111111111','broker','Motilal Oswal','Motilal Oswal Financial Services','research@motilaloswal.example','earns brokerage','INH000000412',55,null),
('a1000000-0000-0000-0000-000000000004','11111111-1111-1111-1111-111111111111','broker','Kotak Securities','Kotak Securities','morningnote@kotaksecurities.example','earns brokerage','INH000000586',47,null),
('a1000000-0000-0000-0000-000000000005','11111111-1111-1111-1111-111111111111','friend','Ravi','—','+91 98••• ••210','—',null,29,'College friend; tips arrive on WhatsApp'),
('a1000000-0000-0000-0000-000000000006','11111111-1111-1111-1111-111111111111','media','RBI','Reserve Bank of India','rss','none',null,50,'Policy statements via RSS')
on conflict (id) do nothing;
insert into research_channels (id, family_id, kind, label, config, default_source_id) values
('a2000000-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','email','Research inbox','{"address":"research-7f3a@ingest.familyoffice.example","sender_allowlist":{"premium@capitalmind.example":"a1000000-0000-0000-0000-000000000001","letters@marcellus.example":"a1000000-0000-0000-0000-000000000002","research@motilaloswal.example":"a1000000-0000-0000-0000-000000000003","morningnote@kotaksecurities.example":"a1000000-0000-0000-0000-000000000004"}}',null),
('a2000000-0000-0000-0000-000000000002','11111111-1111-1111-1111-111111111111','whatsapp','WhatsApp inbox','{"number":"+91 98xxx xx011","sender_allowlist":{"+91 98••• ••210":"a1000000-0000-0000-0000-000000000005"}}',null),
('a2000000-0000-0000-0000-000000000003','11111111-1111-1111-1111-111111111111','rss','RBI press releases','{"url":"https://www.rbi.org.in/pressreleases_rss.xml","poll_minutes":60}','a1000000-0000-0000-0000-000000000006'),
('a2000000-0000-0000-0000-000000000004','11111111-1111-1111-1111-111111111111','upload','Upload','{}',null),
('a2000000-0000-0000-0000-000000000005','11111111-1111-1111-1111-111111111111','paste','Paste','{}',null)
on conflict (id) do nothing;
insert into research_settings (family_id, digest_cadence, digest_weekday, digest_hour, send_to, ca_monthly_copy)
values ('11111111-1111-1111-1111-111111111111','weekly',0,7,'{arjun@example.com,priya@example.com}',true) on conflict do nothing;

-- ---------- the seeded week's inbox (raw items; the pipeline extracts, clusters and assesses) ----------
insert into research_items (id, family_id, channel_id, channel_kind, source_id, received_at, title, sender, body_text, sha256, status) values
('a3000000-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','a2000000-0000-0000-0000-000000000001','email','a1000000-0000-0000-0000-000000000003','2026-09-11 02:40+00','Motilal Oswal — India Strategy: Capex cycle, top picks Sept','research@motilaloswal.example',
$t$India Strategy — September 2026
Date: 2026-09-11
The capex cycle is broadening from public to private. Order books at the large EPC names are at 3x revenue and margins are recovering.

Top picks
BUY | Larsen & Toubro (LT) | CMP 3,640 | TP 4,300 | SL 3,300 | 24M | High
Order book at 3.1x revenue, margin recovery in core E&C, Middle East exposure diversifying domestic risk.
BUY | Tata Motors (TATAMOTORS) | CMP 985 | TP 1,180 | SL 880 | 12M | Medium
JLR mix improving; domestic CV cycle turning; EV losses narrowing.
BUY | Reliance Industries (RELIANCE) | CMP 2,960 | TP 3,400 | SL 2,700 | 12M | Medium
Retail and Jio value unlocking; O2C stable.
HOLD | Tata Consultancy Services (TCS) | CMP 3,790 | TP 3,950 | 12M | Low
Discretionary spend still soft; wait for deal TCV recovery.$t$,'seed-item-0001','new'),
('a3000000-0000-0000-0000-000000000002','11111111-1111-1111-1111-111111111111','a2000000-0000-0000-0000-000000000002','whatsapp','a1000000-0000-0000-0000-000000000005','2026-09-10 16:10+00','Ravi: "Bro, XYZ Small Cap Infra is going to double"','+91 98••• ••210',
$t$Bro, XYZ Small Cap Infra Ltd is going to double in 6 months. My CA's friend is on the board and says a big order is coming. Buy before Monday.$t$,'seed-item-0002','new'),
('a3000000-0000-0000-0000-000000000003','11111111-1111-1111-1111-111111111111','a2000000-0000-0000-0000-000000000004','upload','a1000000-0000-0000-0000-000000000002','2026-09-10 10:32+00','Marcellus — Consistent Compounders Q2 letter.pdf','letters@marcellus.example',
$t$Consistent Compounders — Q2 FY27 letter
Date: 2026-09-09
We continue to accumulate Larsen & Toubro as a compounder in the capex cycle; the order book gives 24 months of visibility and we see 15% earnings growth. We hold HDFC Bank at a full weight and are not adding; NIM pressure is transient and deposit growth is recovering.$t$,'seed-item-0003','new'),
('a3000000-0000-0000-0000-000000000004','11111111-1111-1111-1111-111111111111','a2000000-0000-0000-0000-000000000001','email','a1000000-0000-0000-0000-000000000001','2026-09-09 03:45+00','Capitalmind Premium — The case for arbitrage funds now','premium@capitalmind.example',
$t$The case for arbitrage funds now
Date: 2026-09-09
Arbitrage spreads are at a 12-month high (annualised 7.4%) while liquid-fund yields have slipped to 6.6%. For money parked 3–12 months in the liquidity bucket we would subscribe to Kotak Equity Arbitrage Fund - Direct Growth: equity taxation, T+1 liquidity, no exit load after 30 days. Target: hold 12 months; medium conviction.$t$,'seed-item-0004','new'),
('a3000000-0000-0000-0000-000000000005','11111111-1111-1111-1111-111111111111','a2000000-0000-0000-0000-000000000001','email','a1000000-0000-0000-0000-000000000004','2026-09-08 13:00+00','Kotak Securities — Dalal Street Morning Note','morningnote@kotaksecurities.example',
$t$Dalal Street Morning Note
Date: 2026-09-08
Markets: Nifty flat; capex names firm; private banks weak on NIM commentary.

Calls
BUY | Larsen & Toubro (LT) | CMP 3,625 | TP 4,150 | SL 3,350 | 12M | High
Order inflow guidance raised; hydrocarbon wins in the Middle East.
BUY | Tata Motors (TATAMOTORS) | CMP 980 | TP 1,150 | SL 900 | 12M | Medium
Volume recovery in PVs; JLR margins guided up.
REDUCE | HDFC Bank (HDFCBANK) | CMP 1,724 | TP 1,650 | SL 1,800 | 6M | Medium
NIM pressure to persist for two quarters; book profits after the bonus.
BUY | Bajaj Finance (BAJFINANCE) | CMP 7,450 | TP 8,400 | SL 6,900 | 12M | Medium
AUM growth 26%; credit costs stable.
SELL | Infosys (INFY) | CMP 1,530 | TP 1,380 | SL 1,620 | 6M | Low
Deal ramp-downs; margin guidance cut.
BUY | Reliance Industries (RELIANCE) | CMP 2,950 | TP 3,350 | SL 2,720 | 12M | Medium
Retail listing catalyst.$t$,'seed-item-0005','new'),
('a3000000-0000-0000-0000-000000000006','11111111-1111-1111-1111-111111111111','a2000000-0000-0000-0000-000000000003','rss','a1000000-0000-0000-0000-000000000006','2026-09-07 05:30+00','RBI monetary policy — rate held; stance neutral','rss',
$t$The Monetary Policy Committee kept the policy repo rate unchanged at 5.50 per cent and retained the neutral stance. Inflation projected at 3.9 per cent for FY27; growth at 6.5 per cent.$t$,'seed-item-0006','new')
on conflict (id) do nothing;

-- ---------- 40-call archive (FO-157): one archive item per source, recommendations dated 2024-25 with the publish price from the series ----------
insert into research_items (id, family_id, channel_id, channel_kind, source_id, received_at, title, sender, body_text, sha256, status) values
('a5000000-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','a2000000-0000-0000-0000-000000000004','upload','a1000000-0000-0000-0000-000000000001','2026-04-01 05:00+00','Archive — Capitalmind calls 2024-25','import','Back-filled call archive used to seed the track record.','seed-archive-0001','extracted'),
('a5000000-0000-0000-0000-000000000002','11111111-1111-1111-1111-111111111111','a2000000-0000-0000-0000-000000000004','upload','a1000000-0000-0000-0000-000000000002','2026-04-01 05:00+00','Archive — Marcellus letters 2024-25','import','Back-filled call archive used to seed the track record.','seed-archive-0002','extracted'),
('a5000000-0000-0000-0000-000000000003','11111111-1111-1111-1111-111111111111','a2000000-0000-0000-0000-000000000004','upload','a1000000-0000-0000-0000-000000000003','2026-04-01 05:00+00','Archive — Motilal Oswal calls 2024-25','import','Back-filled call archive used to seed the track record.','seed-archive-0003','extracted'),
('a5000000-0000-0000-0000-000000000004','11111111-1111-1111-1111-111111111111','a2000000-0000-0000-0000-000000000004','upload','a1000000-0000-0000-0000-000000000004','2026-04-01 05:00+00','Archive — Kotak Securities calls 2024-25','import','Back-filled call archive used to seed the track record.','seed-archive-0004','extracted'),
('a5000000-0000-0000-0000-000000000005','11111111-1111-1111-1111-111111111111','a2000000-0000-0000-0000-000000000004','upload','a1000000-0000-0000-0000-000000000005','2026-04-01 05:00+00','Archive — Ravi tips 2024-25','import','Back-filled call archive used to seed the track record.','seed-archive-0005','extracted')
on conflict (id) do nothing;
with calls(n, src, inst, action, conviction, published_on) as (values
  -- Capitalmind: 8 calls
  (1,'a1000000-0000-0000-0000-000000000001','44444444-0000-0000-0000-000000000010','buy','high',date '2024-02-29'),
  (2,'a1000000-0000-0000-0000-000000000001','44444444-0000-0000-0000-000000000001','buy','medium',date '2024-04-30'),
  (3,'a1000000-0000-0000-0000-000000000001','44444444-0000-0000-0000-000000000011','buy','medium',date '2024-06-28'),
  (4,'a1000000-0000-0000-0000-000000000001','44444444-0000-0000-0000-000000000002','reduce','medium',date '2024-08-30'),
  (5,'a1000000-0000-0000-0000-000000000001','44444444-0000-0000-0000-000000000010','accumulate','high',date '2024-11-29'),
  (6,'a1000000-0000-0000-0000-000000000001','44444444-0000-0000-0000-000000000011','reduce','low',date '2025-02-28'),
  (7,'a1000000-0000-0000-0000-000000000001','44444444-0000-0000-0000-000000000001','buy','medium',date '2025-05-30'),
  (8,'a1000000-0000-0000-0000-000000000001','44444444-0000-0000-0000-000000000010','buy','high',date '2025-08-29'),
  -- Marcellus: 6
  (9,'a1000000-0000-0000-0000-000000000002','44444444-0000-0000-0000-000000000010','accumulate','high',date '2024-03-29'),
  (10,'a1000000-0000-0000-0000-000000000002','44444444-0000-0000-0000-000000000001','hold','medium',date '2024-06-28'),
  (11,'a1000000-0000-0000-0000-000000000002','44444444-0000-0000-0000-000000000002','hold','medium',date '2024-09-30'),
  (12,'a1000000-0000-0000-0000-000000000002','44444444-0000-0000-0000-000000000010','accumulate','high',date '2025-01-31'),
  (13,'a1000000-0000-0000-0000-000000000002','44444444-0000-0000-0000-000000000001','accumulate','medium',date '2025-04-30'),
  (14,'a1000000-0000-0000-0000-000000000002','44444444-0000-0000-0000-000000000011','avoid','medium',date '2025-07-31'),
  -- Motilal: 10
  (15,'a1000000-0000-0000-0000-000000000003','44444444-0000-0000-0000-000000000010','buy','high',date '2024-01-31'),
  (16,'a1000000-0000-0000-0000-000000000003','44444444-0000-0000-0000-000000000011','buy','medium',date '2024-03-29'),
  (17,'a1000000-0000-0000-0000-000000000003','44444444-0000-0000-0000-000000000002','buy','low',date '2024-05-31'),
  (18,'a1000000-0000-0000-0000-000000000003','44444444-0000-0000-0000-000000000001','buy','medium',date '2024-07-31'),
  (19,'a1000000-0000-0000-0000-000000000003','44444444-0000-0000-0000-000000000011','sell','medium',date '2024-10-31'),
  (20,'a1000000-0000-0000-0000-000000000003','44444444-0000-0000-0000-000000000010','buy','high',date '2024-12-31'),
  (21,'a1000000-0000-0000-0000-000000000003','44444444-0000-0000-0000-000000000002','sell','medium',date '2025-03-31'),
  (22,'a1000000-0000-0000-0000-000000000003','44444444-0000-0000-0000-000000000001','buy','medium',date '2025-06-30'),
  (23,'a1000000-0000-0000-0000-000000000003','44444444-0000-0000-0000-000000000011','buy','medium',date '2025-08-29'),
  (24,'a1000000-0000-0000-0000-000000000003','44444444-0000-0000-0000-000000000010','buy','high',date '2025-09-30'),
  -- Kotak: 12
  (25,'a1000000-0000-0000-0000-000000000004','44444444-0000-0000-0000-000000000002','buy','medium',date '2024-01-31'),
  (26,'a1000000-0000-0000-0000-000000000004','44444444-0000-0000-0000-000000000011','sell','medium',date '2024-02-29'),
  (27,'a1000000-0000-0000-0000-000000000004','44444444-0000-0000-0000-000000000001','reduce','medium',date '2024-04-30'),
  (28,'a1000000-0000-0000-0000-000000000004','44444444-0000-0000-0000-000000000010','buy','medium',date '2024-05-31'),
  (29,'a1000000-0000-0000-0000-000000000004','44444444-0000-0000-0000-000000000002','buy','low',date '2024-07-31'),
  (30,'a1000000-0000-0000-0000-000000000004','44444444-0000-0000-0000-000000000011','buy','medium',date '2024-09-30'),
  (31,'a1000000-0000-0000-0000-000000000004','44444444-0000-0000-0000-000000000001','sell','medium',date '2024-11-29'),
  (32,'a1000000-0000-0000-0000-000000000004','44444444-0000-0000-0000-000000000010','reduce','low',date '2025-01-31'),
  (33,'a1000000-0000-0000-0000-000000000004','44444444-0000-0000-0000-000000000002','buy','medium',date '2025-02-28'),
  (34,'a1000000-0000-0000-0000-000000000004','44444444-0000-0000-0000-000000000011','buy','high',date '2025-04-30'),
  (35,'a1000000-0000-0000-0000-000000000004','44444444-0000-0000-0000-000000000001','reduce','medium',date '2025-06-30'),
  (36,'a1000000-0000-0000-0000-000000000004','44444444-0000-0000-0000-000000000010','buy','medium',date '2025-08-29'),
  -- Ravi: 4
  (37,'a1000000-0000-0000-0000-000000000005','44444444-0000-0000-0000-000000000011','buy','high',date '2024-02-29'),
  (38,'a1000000-0000-0000-0000-000000000005','44444444-0000-0000-0000-000000000002','buy','high',date '2024-08-30'),
  (39,'a1000000-0000-0000-0000-000000000005','44444444-0000-0000-0000-000000000011','buy','high',date '2025-03-31'),
  (40,'a1000000-0000-0000-0000-000000000005','44444444-0000-0000-0000-000000000001','sell','high',date '2025-05-30'))
insert into research_recommendations (id, family_id, item_id, source_id, instrument_id, instrument_text, action, thesis, horizon_months, conviction, published_on, price_at_publish, status, confidence)
select ('a6000000-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid, '11111111-1111-1111-1111-111111111111',
  ('a5000000-0000-0000-0000-' || lpad(right(src, 1), 12, '0'))::uuid, src::uuid, inst::uuid, i.name, action::rec_action, 'Archived call', 12, conviction, published_on,
  (select close from prices p where p.instrument_id = inst::uuid and p.price_date <= published_on order by price_date desc limit 1), 'extracted', 0.99
from calls c join instruments i on i.id = inst::uuid
on conflict (id) do nothing;
