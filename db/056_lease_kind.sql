-- Lump-sum leases (bhogya / otti style): the tenant pays a refundable lump sum (kept in leases.deposit) instead of, or on top of, monthly rent.
-- Ending a lease records when the money was handed back and how much.
alter table leases add column if not exists lease_kind text not null default 'rent';
alter table leases add column if not exists refunded_on date;
alter table leases add column if not exists refunded_amount numeric(18,2);
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'leases_kind_chk') then
    alter table leases add constraint leases_kind_chk check (lease_kind in ('rent','lump_sum'));
  end if;
end $$;
