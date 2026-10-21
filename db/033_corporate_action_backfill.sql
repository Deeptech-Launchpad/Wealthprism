-- Fix for a real bug found while testing a brand-new family: the HDFC Bank 1:1 bonus (seeded in 002_seed.sql,
-- ex-date 2026-08-28) was inserted before auto_apply existed (that column was added later, in 016), so it
-- defaulted to false even though its ratio is complete and it is mechanically safe to auto-apply. Because
-- corporate_actions has no family scoping, autoApplyCorporateActions() (jobs/market.ts) never ran it for any
-- family — Mehta Family's holding only reflects the bonus because its lot was hand-seeded directly in
-- 002_seed.sql, bypassing the apply mechanism and its tracking entirely. Any family created after the seed
-- (self-signup, a late CAS import) that held HDFC Bank before the ex-date silently never got its bonus shares.
--
-- This sets auto_apply=true so the action is genuinely ready, and backfills the missing tracking row for
-- Mehta's already-seeded holding so the next sweep (now broadened in jobs/market.ts to also match 'applied',
-- not just 'pending') does not double-apply it. Families missing the bonus are fixed by that next sweep, not
-- by this migration — a migration should not call application code.

update corporate_actions set auto_apply = true
where instrument_id = '44444444-0000-0000-0000-000000000001' and type = 'bonus' and ex_date = '2026-08-28' and ratio_num is not null;

insert into corporate_action_applications (corporate_action_id, family_id, holding_id, applied_at, applied_by, detail)
select ca.id, f.id, h.id, now(), null, jsonb_build_object('note', 'backfilled: this lot was hand-seeded in 002_seed.sql, never tracked as an applied corporate action')
from corporate_actions ca
join holdings h on h.instrument_id = ca.instrument_id
join entities e on e.id = h.entity_id
join families f on f.id = e.family_id
where ca.instrument_id = '44444444-0000-0000-0000-000000000001' and ca.type = 'bonus' and ca.ex_date = '2026-08-28'
  and exists (select 1 from lots l where l.holding_id = h.id and l.buy_date = ca.ex_date and l.unit_cost = 0)
on conflict (corporate_action_id, holding_id) do nothing;
