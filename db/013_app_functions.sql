-- Helper functions the API calls before a family context exists (run as owner; SECURITY DEFINER so RLS on
-- family_members does not hide the caller's own memberships).
create or replace function user_families(uid uuid)
returns table (id uuid, name text, role member_role, entity_scope uuid[])
language sql security definer set search_path = public stable as $$
  select f.id, f.name, m.role, m.entity_scope from family_members m join families f on f.id = m.family_id where m.user_id = uid order by f.name
$$;
revoke all on function user_families(uuid) from public;
grant execute on function user_families(uuid) to app_user;
