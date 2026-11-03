-- Interest and maturity payments expected from the bonds, G-Secs, SGBs and T-bills a family holds, like deposit_receipts is for deposits.
-- They are built from the instrument's coupon, frequency and maturity date and the quantity held, matched to bank-statement credits, or confirmed by hand.
alter type link_type add value if not exists 'holding_receipt';

create table holding_receipts (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references families(id) on delete cascade,
  entity_id uuid not null references entities(id),
  holding_id uuid not null references holdings(id) on delete cascade,
  instrument_id uuid not null references instruments(id),
  kind text not null check (kind in ('interest','maturity')),
  due_date date not null,
  expected_amount numeric(18,2) not null,
  received_amount numeric(18,2) not null default 0,
  received_on date,
  status text not null default 'expected' check (status in ('expected','overdue','partial','received','cancelled')),
  bank_txn_ref text,
  bank_account_id uuid references bank_accounts(id),
  created_at timestamptz not null default now(),
  unique (holding_id, kind, due_date)
);
create index on holding_receipts (family_id, status, due_date);

alter table holding_receipts enable row level security;
alter table holding_receipts force row level security;
create policy holding_receipts_tenant on holding_receipts using (family_id = current_setting('app.family_id', true)::uuid) with check (family_id = current_setting('app.family_id', true)::uuid);
grant select, insert, update, delete on holding_receipts to app_user;

-- the extra inputs the schedule needs: the face value each unit is redeemed at, and how often interest is paid
update asset_types set fields = '[{"key":"coupon_pct","label":"Coupon (% a year)","type":"number","required":true},{"key":"face_value","label":"Face value per unit (₹)","type":"number","default":1000},{"key":"coupon_frequency","label":"Coupon paid","type":"select","options":["monthly","quarterly","half_yearly","yearly","at_maturity"],"default":"yearly"},{"key":"maturity_date","label":"Maturity date","type":"date","required":true},{"key":"credit_rating","label":"Credit rating","type":"text"}]' where code = 'bond';
update asset_types set fields = '[{"key":"coupon_pct","label":"Coupon (% a year)","type":"number","required":true},{"key":"face_value","label":"Face value per unit (₹)","type":"number","default":100},{"key":"coupon_frequency","label":"Coupon paid","type":"select","options":["monthly","quarterly","half_yearly","yearly","at_maturity"],"default":"half_yearly"},{"key":"maturity_date","label":"Maturity date","type":"date","required":true}]' where code = 'gsec';
update asset_types set fields = '[{"key":"face_value","label":"Face value per unit (₹)","type":"number","default":100},{"key":"maturity_date","label":"Maturity date","type":"date","required":true}]' where code = 'tbill';
update asset_types set fields = '[{"key":"coupon_pct","label":"Interest (% a year, on the issue price)","type":"number","default":2.5},{"key":"maturity_date","label":"Maturity date","type":"date","required":true}]' where code = 'sgb';
