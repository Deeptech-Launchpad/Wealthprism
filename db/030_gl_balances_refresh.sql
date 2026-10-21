-- gl_balances has been unusable since db/007: app_user is not its owner, so the worker's
-- `refresh materialized view` always failed (caught and swallowed), and the blanket select
-- grant exposed every family's rows, because a materialised view does not enforce RLS.

-- refresh through a definer function; non-concurrent, so it is allowed inside the function's transaction
create or replace function refresh_gl_balances() returns void language plpgsql security definer set search_path = public as $$
begin refresh materialized view gl_balances; end $$;
revoke all on function refresh_gl_balances() from public;
grant execute on function refresh_gl_balances() to app_user;

-- read it only through a tenant filter (the view runs as its owner, so app_user needs no grant on the matview itself)
revoke select on gl_balances from app_user;
create or replace view gl_balances_family as
  select * from gl_balances where family_id = current_setting('app.family_id', true)::uuid;
grant select on gl_balances_family to app_user;
