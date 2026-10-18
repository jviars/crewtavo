-- Row checks that ask "is this person in the row's company (with this role, or with this area)?"
-- looked the person's membership up again for every row: private.has_role, has_perm and is_member
-- are security definer functions, which Postgres can't fold into the query, so listing 20,000
-- invoices made 40,000 lookups and took 1.5 s, and the dashboard took 2 s on a few years of data.
--
-- The same questions are now asked once per query, as "which companies is this person in (with
-- this role, or this area)?", and each row is checked against that list. The answers are the same:
-- a row whose company is missing still fails the check (coalesce keeps a NOT around it the same).

create or replace function private.member_companies() returns uuid[]
language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg(m.company_id), '{}')
  from public.memberships m
  where m.user_id = (select auth.uid()) and m.active
$$;

create or replace function private.role_companies(p_roles public.member_role[]) returns uuid[]
language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg(m.company_id), '{}')
  from public.memberships m
  where m.user_id = (select auth.uid()) and m.active and m.role = any (p_roles)
$$;

create or replace function private.perm_companies(p_perm text) returns uuid[]
language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg(m.company_id), '{}')
  from public.memberships m left join public.company_roles r on r.id = m.role_id
  where m.user_id = (select auth.uid()) and m.active
    and case when r.id is null then p_perm = any (private.level_permissions(m.role)) else p_perm = any (r.permissions) end
$$;

-- The same grants as the per-row checks they stand in for.
revoke all on function private.member_companies() from public;
revoke all on function private.role_companies(public.member_role[]) from public;
grant execute on function private.member_companies() to authenticated, service_role;
grant execute on function private.role_companies(public.member_role[]) to authenticated, service_role;
grant execute on function private.perm_companies(text) to public;

/**
 * Rewrites every policy's per-row membership checks into a check against the list above, keeping
 * the policy's name, command, roles and the rest of its expression. Safe to run again: a migration
 * that adds policies written the old way can end with `select private.fold_member_checks();`.
 */
create or replace function private.fold_member_checks() returns integer
language plpgsql set search_path = '' as $$
declare
  p record;
  -- The row value being checked: a column (company_id, id) or private.path_company(name).
  arg constant text := '(private\.path_company\([a-z_]+\)|[a-z_]+)';
  q text;
  c text;
  changed integer := 0;
begin
  -- With an empty search path every name in the printed expressions is schema-qualified, so they
  -- read back the same.
  perform set_config('search_path', '', true);
  for p in
    select pol.polname, pol.polrelid::regclass::text as tbl,
           pg_get_expr(pol.polqual, pol.polrelid) as qual, pg_get_expr(pol.polwithcheck, pol.polrelid) as chk
    from pg_policy pol join pg_class t on t.oid = pol.polrelid join pg_namespace n on n.oid = t.relnamespace
    where n.nspname in ('public', 'storage')
  loop
    q := p.qual;
    c := p.chk;
    for i in 1..2 loop
      if i = 1 and q is null or i = 2 and c is null then continue; end if;
      declare e text := case i when 1 then q else c end;
      begin
        e := regexp_replace(e, 'private\.has_role\(' || arg || ', (''[^'']*''::public\.member_role\[\])\)',
                            '(COALESCE(\1 = ANY ((SELECT private.role_companies(\2))::uuid[]), false))', 'g');
        e := regexp_replace(e, 'private\.has_perm\(' || arg || ', (''[^'']*''::text)\)',
                            '(COALESCE(\1 = ANY ((SELECT private.perm_companies(\2))::uuid[]), false))', 'g');
        e := regexp_replace(e, 'private\.is_member\(' || arg || '\)',
                            '(COALESCE(\1 = ANY ((SELECT private.member_companies())::uuid[]), false))', 'g');
        if i = 1 then q := e; else c := e; end if;
      end;
    end loop;
    if q is distinct from p.qual or c is distinct from p.chk then
      execute format('alter policy %I on %s', p.polname, p.tbl)
        || coalesce(' using (' || q || ')', '') || coalesce(' with check (' || c || ')', '');
      changed := changed + 1;
    end if;
  end loop;
  return changed;
end $$;

revoke all on function private.fold_member_checks() from public;

select private.fold_member_checks();
