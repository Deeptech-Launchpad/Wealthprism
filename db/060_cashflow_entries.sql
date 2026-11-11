-- Income and household expenses become monthly-first entries that can be linked to an asset.
-- Income: monthly or yearly. Household expenses: monthly, yearly or once (on a date).
-- linked_type / linked_id say which asset the money belongs to (a flat, a holding, a policy and so on). Optional.
alter table entity_income_sources
  add column if not exists frequency text not null default 'yearly' check (frequency in ('monthly','yearly')),
  add column if not exists linked_type text check (linked_type is null or linked_type in ('property','holding','lifestyle_asset','insurance_policy','savings_account')),
  add column if not exists linked_id uuid;

alter table household_expenses
  add column if not exists frequency text not null default 'monthly' check (frequency in ('monthly','yearly','once')),
  add column if not exists once_on date,
  add column if not exists linked_type text check (linked_type is null or linked_type in ('property','holding','lifestyle_asset','insurance_policy','savings_account')),
  add column if not exists linked_id uuid;
