-- "Add asset": one catalogue of asset types, like deposit_types is for deposits. Reference data, the same list for every family, read-only to the app.
-- category says where the asset is stored: 'market' = units x price through holdings / lots / investment_txns, 'physical' = lifestyle_assets (value by hand),
-- 'insurance' = insurance_policies, 'savings' = government and retirement accounts (PPF, EPF, NPS ... added in a later phase, enabled = false until then).
-- fields lists the extra inputs a type asks for, beyond the common ones of its category. For 'market' they are kept in instruments.meta, for 'physical'
-- in lifestyle_assets.details, for 'insurance' the keys are insurance_policies columns.
alter type lifestyle_kind add value if not exists 'gold';
alter type lifestyle_kind add value if not exists 'silver';
alter table lifestyle_assets add column if not exists details jsonb not null default '{}';

create table asset_types (
  code text primary key,
  category text not null check (category in ('market','physical','insurance','savings')),
  label text not null,
  description text not null,
  instrument_type text,          -- market: instruments.type
  asset_class text,              -- market: instruments.asset_class (also the tax_rules key)
  alloc_class text,              -- market: lens class; null = derived
  default_bucket text not null default 'growth' check (default_bucket in ('liquidity','income','growth')),
  lifestyle_kind text,           -- physical: lifestyle_assets.kind
  insurance_kind text,           -- insurance: insurance_policies.kind
  counts_in_net_worth boolean not null default true,
  enabled boolean not null default true,
  fields jsonb not null default '[]',
  sort integer not null default 0
);
grant select on asset_types to app_user;

insert into asset_types (code, category, label, description, instrument_type, asset_class, alloc_class, default_bucket, lifestyle_kind, insurance_kind, counts_in_net_worth, enabled, fields, sort) values
 ('stock',     'market', 'Listed stock', 'A share listed on NSE or BSE. Value follows the daily price; gains are taxed under the equity rules.', 'stock', 'equity', 'equity', 'growth', null, null, true, true, '[]', 10),
 ('mf',        'market', 'Mutual fund', 'Any scheme in the AMFI list. Search by name; the NAV feed keeps the value current.', 'mf', null, null, 'growth', null, null, true, true, '[]', 20),
 ('etf',       'market', 'ETF (equity or index)', 'An exchange-traded fund that tracks an equity index. Bought and sold like a stock.', 'etf', 'equity', 'equity', 'growth', null, null, true, true, '[]', 30),
 ('gold_etf',  'market', 'Gold or silver ETF', 'A listed gold or silver ETF. Counts under gold in the allocation lens.', 'etf', 'gold_etf', 'gold', 'growth', null, null, true, true, '[]', 40),
 ('sgb',       'market', 'Sovereign Gold Bond', 'Government gold bond: it earns 2.5% a year, and the gain is exempt if held to the 8-year maturity.', 'sgb', 'sgb', 'gold', 'growth', null, null, true, true,
   '[{"key":"coupon_pct","label":"Interest (% a year)","type":"number","default":2.5},{"key":"maturity_date","label":"Maturity date","type":"date","required":true}]', 50),
 ('bond',      'market', 'Bond, NCD or debenture', 'A listed or unlisted company or PSU bond. Interest is paid at the coupon rate and taxed at your slab.', 'bond', 'listed_bond', 'debt', 'income', null, null, true, true,
   '[{"key":"coupon_pct","label":"Coupon (% a year)","type":"number","required":true},{"key":"coupon_frequency","label":"Coupon paid","type":"select","options":["monthly","quarterly","half_yearly","yearly","at_maturity"]},{"key":"maturity_date","label":"Maturity date","type":"date","required":true},{"key":"credit_rating","label":"Credit rating","type":"text"}]', 60),
 ('gsec',      'market', 'Government security (G-Sec)', 'A bond issued by the Government of India or a state.', 'gsec', 'listed_bond', 'debt', 'income', null, null, true, true,
   '[{"key":"coupon_pct","label":"Coupon (% a year)","type":"number","required":true},{"key":"maturity_date","label":"Maturity date","type":"date","required":true}]', 70),
 ('tbill',     'market', 'Treasury bill', 'A short-term government paper bought at a discount and redeemed at face value.', 'tbill', 'listed_bond', 'debt', 'liquidity', null, null, true, true,
   '[{"key":"maturity_date","label":"Maturity date","type":"date","required":true}]', 80),
 ('pms',       'market', 'PMS (portfolio management)', 'A discretionary portfolio held with a portfolio manager. Enter what you put in and update its value from the statement.', 'pms', 'equity', 'alternatives', 'growth', null, null, true, true,
   '[{"key":"manager","label":"Manager / strategy","type":"text"}]', 90),
 ('aif',       'market', 'AIF (alternative fund)', 'A Category I, II or III alternative fund. Money goes in as drawdowns against a commitment.', 'aif', 'unlisted_equity', 'alternatives', 'growth', null, null, true, true,
   '[{"key":"aif_category","label":"Category","type":"select","options":["Cat I","Cat II","Cat III"]},{"key":"manager","label":"Manager","type":"text"},{"key":"commitment","label":"Total commitment (₹)","type":"number"}]', 100),
 ('reit',      'market', 'REIT or InvIT', 'Listed units of a real-estate or infrastructure trust. Distributions are taxed by component.', 'reit', 'reit_invit', 'real_estate', 'income', null, null, true, true, '[]', 110),

 ('gold_physical',   'physical', 'Gold (bars or coins)', 'Physical gold you hold. Value = weight x the gold rate; update it from time to time.', null, null, 'gold', 'growth', 'gold', null, true, true,
   '[{"key":"weight_grams","label":"Weight (grams)","type":"number","required":true},{"key":"purity","label":"Purity","type":"select","options":["24K (999)","22K (916)","18K (750)"]}]', 10),
 ('silver_physical', 'physical', 'Silver (bars or coins)', 'Physical silver you hold.', null, null, 'gold', 'growth', 'silver', null, true, true,
   '[{"key":"weight_grams","label":"Weight (grams)","type":"number","required":true}]', 20),
 ('jewellery',       'physical', 'Jewellery', 'Gold, silver or stone jewellery. Value includes the making charges only if you can sell it for them.', null, null, 'gold', 'growth', 'jewellery', null, true, true,
   '[{"key":"weight_grams","label":"Weight (grams)","type":"number"},{"key":"purity","label":"Purity","type":"select","options":["24K (999)","22K (916)","18K (750)","Silver","Other"]}]', 30),
 ('art',             'physical', 'Art or antique', 'Paintings, sculpture and antiques. Value by a valuer or a recent comparable sale.', null, null, 'alternatives', 'growth', 'art', null, true, true, '[]', 40),
 ('watch',           'physical', 'Watch', 'A luxury watch.', null, null, 'alternatives', 'growth', 'watch', null, true, true, '[]', 50),
 ('vehicle',         'physical', 'Vehicle', 'Car, bike or other vehicle. It loses value with age and is left out of the allocation lens.', null, null, null, 'growth', 'vehicle', null, true, true,
   '[{"key":"registration_no","label":"Registration no.","type":"text"}]', 60),
 ('collectible',     'physical', 'Collectible or wine', 'Coins, stamps, wine and other collectibles.', null, null, 'alternatives', 'growth', 'collectible', null, true, true, '[]', 70),
 ('other_physical',  'physical', 'Other valuable', 'Anything else of value that is not in the list.', null, null, 'alternatives', 'growth', 'other', null, true, true, '[]', 80),

 ('ins_term',      'insurance', 'Term life', 'Pure cover: it pays only if the person insured dies. No cash value, so it is not counted as an asset.', null, null, null, 'liquidity', null, 'term_life', false, true, '[]', 10),
 ('ins_health',    'insurance', 'Health', 'Hospital and medical cover for one person or the whole family. No cash value.', null, null, null, 'liquidity', null, 'health', false, true, '[]', 20),
 ('ins_critical',  'insurance', 'Critical illness', 'A lump sum on diagnosis of a listed illness. No cash value.', null, null, null, 'liquidity', null, 'critical_illness', false, true, '[]', 30),
 ('ins_endowment', 'insurance', 'Endowment or money-back', 'Cover plus savings. It pays on maturity or death and builds a surrender value, which counts as an asset.', null, null, null, 'income', null, 'endowment', true, true,
   '[{"key":"surrender_value","label":"Surrender value now (₹)","type":"number"}]', 40),
 ('ins_ulip',      'insurance', 'ULIP', 'Insurance plus market-linked investment. The fund value counts as an asset.', null, null, null, 'growth', null, 'ulip', true, true,
   '[{"key":"fund_value","label":"Fund value now (₹)","type":"number"}]', 50),
 ('ins_property',  'insurance', 'Property insurance', 'Fire, home or contents cover. No cash value.', null, null, null, 'liquidity', null, 'property', false, true, '[]', 60),
 ('ins_vehicle',   'insurance', 'Vehicle insurance', 'Motor cover for a car or bike. No cash value.', null, null, null, 'liquidity', null, 'vehicle', false, true, '[]', 70),
 ('ins_other',     'insurance', 'Other insurance', 'Liability or any other policy.', null, null, null, 'liquidity', null, 'other', false, true, '[]', 80),

 ('ppf',  'savings', 'PPF', 'Public Provident Fund: a 15-year government savings account.', null, null, 'debt', 'income', null, null, true, false, '[]', 10),
 ('epf',  'savings', 'EPF', 'Employees'' Provident Fund through an employer.', null, null, 'debt', 'income', null, null, true, false, '[]', 20),
 ('nps',  'savings', 'NPS', 'National Pension System, Tier I or II.', null, null, 'debt', 'growth', null, null, true, false, '[]', 30),
 ('ssy',  'savings', 'Sukanya Samriddhi', 'A government savings account for a girl child.', null, null, 'debt', 'income', null, null, true, false, '[]', 40),
 ('scss', 'savings', 'Senior Citizen Savings Scheme', 'A 5-year government scheme for people aged 60 and over.', null, null, 'debt', 'income', null, null, true, false, '[]', 50),
 ('nsc',  'savings', 'NSC or KVP', 'National Savings Certificate or Kisan Vikas Patra.', null, null, 'debt', 'income', null, null, true, false, '[]', 60);
