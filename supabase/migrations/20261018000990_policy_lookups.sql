-- Row checks that ask "is this person in the row's company (with this role, or with this area)?",
-- or "is this one of my visits (or its client, job, property, request)?", looked the answer up again
-- for every row: they're security definer functions, which Postgres can't fold into the query, so
-- listing 20,000 invoices made 40,000 lookups and took 1.5 s, and the dashboard took 2 s on a few
-- years of data.
--
-- The same questions are now asked once per query, as "which companies is this person in (with
-- this role, or this area)?" and "which visits, clients, jobs... can they reach?", and each row is
-- checked against that list. The answers are the same: has_role and the rest stay as they are, for
-- the database's own functions, and supabase/tests/policy_lookups_test.sql checks that both forms
-- agree for every role, so change them together.

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

-- What private.assigned_to_visit, works_visit and crew_sees_* check one row at a time.
create or replace function private.my_assigned_visits() returns setof uuid
language sql stable security definer set search_path = '' as $$
  select a.visit_id from public.visit_assignees a where a.user_id = (select auth.uid())
$$;

create or replace function private.my_worked_visits() returns setof uuid
language sql stable security definer set search_path = '' as $$
  select a.visit_id from public.visit_assignees a where a.user_id = (select auth.uid())
  union
  select v.id from public.visits v join public.crews c on c.id = v.crew_id
  where c.lead_user_id = (select auth.uid())
     or exists (select 1 from public.crew_members m where m.crew_id = c.id and m.user_id = (select auth.uid()))
$$;

create or replace function private.crew_clients() returns setof uuid
language sql stable security definer set search_path = '' as $$
  select x.id from private.my_visits() v
  left join public.jobs j on j.id = v.job_id
  left join public.requests r on r.id = v.request_id
  left join public.properties p on p.id = v.property_id
  cross join lateral (values (j.client_id), (r.client_id), (p.client_id)) as x(id)
  where x.id is not null
$$;

create or replace function private.crew_jobs() returns setof uuid
language sql stable security definer set search_path = '' as $$
  select v.job_id from private.my_visits() v where v.job_id is not null
$$;

create or replace function private.crew_properties() returns setof uuid
language sql stable security definer set search_path = '' as $$
  select x.id from private.my_visits() v
  left join public.jobs j on j.id = v.job_id
  left join public.requests r on r.id = v.request_id
  cross join lateral (values (v.property_id), (j.property_id), (r.property_id)) as x(id)
  where x.id is not null
$$;

create or replace function private.crew_requests() returns setof uuid
language sql stable security definer set search_path = '' as $$
  select v.request_id from private.my_visits() v where v.request_id is not null
$$;

-- The crew lead half of private.schedules_crew: the crew is one of theirs.
create or replace function private.leads_crew(p_company uuid, p_crew uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select p_crew is not null and exists (select 1 from private.my_crews(p_company) as mine(crew_id) where mine.crew_id = p_crew)
$$;

-- The same grants as the per-row checks they stand in for.
revoke all on function private.member_companies(), private.role_companies(public.member_role[]),
  private.my_worked_visits() from public;
grant execute on function private.member_companies(), private.role_companies(public.member_role[]),
  private.my_worked_visits() to authenticated, service_role;
grant execute on function private.perm_companies(text), private.my_assigned_visits(), private.crew_clients(),
  private.crew_jobs(), private.crew_properties(), private.crew_requests(), private.leads_crew(uuid, uuid)
  to public, authenticated, service_role;

/**
 * One policy expression with its per-row checks written against the lists above. p_notnull names
 * the table's NOT NULL columns: a check on one of those is written plainly (so an index on it can
 * be used); on anything that can be NULL it's wrapped so it still reads false, not NULL, under a NOT.
 */
create or replace function private.fold_member_expr(p_expr text, p_notnull text[]) returns text
language plpgsql stable set search_path = '' as $$
declare
  -- The value a check is about: a column (company_id, id, visit_id; qualified inside a subquery)
  -- or private.path_company(name).
  arg constant text := '(private\.path_company\([a-z_]+\)|[a-z_]+(?:\.[a-z_]+)?)';
  -- String literals are set aside (as \x1f<n>\x1f) while the checks are rewritten, so a check named
  -- inside one is left alone; a role list or area is one of them.
  lit constant text := chr(31) || '[0-9]+' || chr(31);
  roles constant text := '(' || lit || '::public\.member_role\[\])';
  sched constant text := '''{owner,admin,office,estimator,crew_lead}''::public.member_role[]';
  lead constant text := '''{crew_lead}''::public.member_role[]';
  e text := p_expr;
  m text[];
  rule record;
  bodies jsonb;
  lits text[];
begin
  if e is null then return null; end if;
  lits := array(select l[1] from regexp_matches(e, '(''(?:[^'']|'''')*'')', 'g') with ordinality as x(l, n) order by n);
  for i in 1..coalesce(cardinality(lits), 0) loop
    e := overlay(e placing chr(31) || i || chr(31) from strpos(e, lits[i]) for length(lits[i]));
  end loop;
  -- Helpers that are folded in only while their body is still the one the lists mirror.
  select jsonb_object_agg(p.oid::regprocedure::text, btrim(regexp_replace(p.prosrc, '\s+', ' ', 'g'))) into bodies
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'private';
  for rule in
    select * from (values
      (1, 'private\.has_role\(' || arg || ', ' || roles || '\)', null::text, null::text),
      (2, 'private\.has_perm\(' || arg || ', (' || lit || '::text)\)', null, null),
      (3, 'private\.is_member\(' || arg || '\)', null, null),
      (4, 'private\.manages_equipment\(' || arg || '\)', 'private.manages_equipment(uuid)',
       'select private.has_role(p_company, ''{owner,admin,office,estimator,crew_lead}'') and private.has_perm(p_company, ''equipment'')'),
      (5, 'private\.schedules_crew\(' || arg || ', (private\.visit_crew\([a-z_]+\)|[a-z_]+)\)', 'private.schedules_crew(uuid,uuid)',
       'select (private.has_role(p_company, ''{owner,admin,office,estimator,crew_lead}'') and private.has_perm(p_company, ''schedule'')) or (private.has_role(p_company, ''{crew_lead}'') and p_crew is not null and exists (select 1 from private.my_crews(p_company) as mine(crew_id) where mine.crew_id = p_crew))'),
      (6, 'private\.assigned_to_visit\(' || arg || '\)', 'private.assigned_to_visit(uuid)',
       'select exists (select 1 from public.visit_assignees a where a.visit_id = p_visit and a.user_id = (select auth.uid()))'),
      (7, 'private\.works_visit\(' || arg || '\)', 'private.works_visit(uuid)',
       'select exists (select 1 from public.visit_assignees a where a.visit_id = p_visit and a.user_id = (select auth.uid())) or exists ( select 1 from public.visits v join public.crews c on c.id = v.crew_id where v.id = p_visit and (c.lead_user_id = (select auth.uid()) or exists (select 1 from public.crew_members m where m.crew_id = c.id and m.user_id = (select auth.uid()))) )'),
      (8, 'private\.crew_sees_client\(' || arg || '\)', 'private.crew_sees_client(uuid)',
       'select exists ( select 1 from private.my_visits() v left join public.jobs j on j.id = v.job_id left join public.requests r on r.id = v.request_id left join public.properties p on p.id = v.property_id where p_client in (j.client_id, r.client_id, p.client_id) )'),
      (9, 'private\.crew_sees_job\(' || arg || '\)', 'private.crew_sees_job(uuid)',
       'select exists (select 1 from private.my_visits() v where v.job_id = p_job)'),
      (10, 'private\.crew_sees_property\(' || arg || '\)', 'private.crew_sees_property(uuid)',
       'select exists ( select 1 from private.my_visits() v left join public.jobs j on j.id = v.job_id left join public.requests r on r.id = v.request_id where p_property in (v.property_id, j.property_id, r.property_id) )'),
      (11, 'private\.crew_sees_request\(' || arg || '\)', 'private.crew_sees_request(uuid)',
       'select exists (select 1 from private.my_visits() v where v.request_id = p_request)')
    ) as r(n, pattern, fn, body)
    order by n
  loop
    continue when rule.fn is not null and bodies ->> rule.fn is distinct from rule.body;
    loop
      m := regexp_match(e, '(' || rule.pattern || ')');
      exit when m is null;
      -- m[1] is the whole call, m[2] the value it's about, m[3] its second argument.
      e := overlay(e placing case rule.n
          when 1 then private.fold_test(m[2], ' = ANY ((SELECT private.role_companies(' || m[3] || '))::uuid[])', p_notnull)
          when 2 then private.fold_test(m[2], ' = ANY ((SELECT private.perm_companies(' || m[3] || '))::uuid[])', p_notnull)
          when 3 then private.fold_test(m[2], ' = ANY ((SELECT private.member_companies())::uuid[])', p_notnull)
          when 4 then '(' || private.fold_test(m[2], ' = ANY ((SELECT private.role_companies(' || sched || '))::uuid[])', p_notnull)
                 || ' AND ' || private.fold_test(m[2], ' = ANY ((SELECT private.perm_companies(''equipment''::text))::uuid[])', p_notnull) || ')'
          when 5 then '((' || private.fold_test(m[2], ' = ANY ((SELECT private.role_companies(' || sched || '))::uuid[])', p_notnull)
                 || ' AND ' || private.fold_test(m[2], ' = ANY ((SELECT private.perm_companies(''schedule''::text))::uuid[])', p_notnull)
                 || ') OR (' || private.fold_test(m[2], ' = ANY ((SELECT private.role_companies(' || lead || '))::uuid[])', p_notnull)
                 || ' AND private.leads_crew(' || m[2] || ', ' || m[3] || ')))'
          when 6 then private.fold_test(m[2], ' IN (SELECT private.my_assigned_visits())', p_notnull)
          when 7 then private.fold_test(m[2], ' IN (SELECT private.my_worked_visits())', p_notnull)
          when 8 then private.fold_test(m[2], ' IN (SELECT private.crew_clients())', p_notnull)
          when 9 then private.fold_test(m[2], ' IN (SELECT private.crew_jobs())', p_notnull)
          when 10 then private.fold_test(m[2], ' IN (SELECT private.crew_properties())', p_notnull)
          when 11 then private.fold_test(m[2], ' IN (SELECT private.crew_requests())', p_notnull)
        end from strpos(e, m[1]) for length(m[1]));
    end loop;
  end loop;
  for i in 1..coalesce(cardinality(lits), 0) loop
    e := replace(e, chr(31) || i || chr(31), lits[i]);
  end loop;
  return e;
end $$;

create or replace function private.fold_test(p_value text, p_test text, p_notnull text[]) returns text
language sql immutable set search_path = '' as $$
  select case when p_value = any (p_notnull) then '(' || p_value || p_test || ')'
              else '(COALESCE((' || p_value || p_test || '), false))' end
$$;

/**
 * Rewrites every policy's per-row checks (private.fold_member_expr), keeping each policy's name,
 * command, roles and the rest of its expression, and returns how many changed. Safe to run again:
 * a migration that adds policies written the old way can end with `select private.fold_member_checks();`.
 */
create or replace function private.fold_member_checks() returns integer
language plpgsql set search_path = '' as $$
declare
  per_row constant text := 'private\.(has_role|has_perm|is_member|manages_equipment|schedules_crew|assigned_to_visit|works_visit|crew_sees_[a-z]+)\(';
  lock_timeout_was constant text := current_setting('lock_timeout');
  p record;
  q text;
  c text;
  required text[];
  changes text[] := '{}';
  tables text[] := '{}';
  tries integer := 0;
begin
  -- With an empty search path every name in the printed expressions is schema-qualified, so they
  -- read back the same.
  perform set_config('search_path', '', true);
  for p in
    select pol.polname, pol.polrelid, pol.polrelid::regclass::text as tbl,
           pg_get_expr(pol.polqual, pol.polrelid) as qual, pg_get_expr(pol.polwithcheck, pol.polrelid) as chk
    from pg_policy pol join pg_class t on t.oid = pol.polrelid join pg_namespace n on n.oid = t.relnamespace
    where n.nspname in ('public', 'storage')
    order by pol.polrelid::regclass::text, pol.polname
  loop
    select coalesce(array_agg(a.attname::text), '{}') into required
    from pg_attribute a where a.attrelid = p.polrelid and a.attnum > 0 and a.attnotnull and not a.attisdropped;
    q := private.fold_member_expr(p.qual, required);
    c := private.fold_member_expr(p.chk, required);
    if regexp_replace(concat(q, ' ', c), '''(?:[^'']|'''')*''', '''''', 'g') ~ per_row then
      raise warning 'Policy % on % still checks each row with a security definer function: %', p.polname, p.tbl, concat(q, ' / ', c);
    end if;
    if q is distinct from p.qual or c is distinct from p.chk then
      changes := changes || (format('alter policy %I on %s', p.polname, p.tbl)
        || coalesce(' using (' || q || ')', '') || coalesce(' with check (' || c || ')', ''));
      if not p.tbl = any (tables) then tables := tables || p.tbl; end if;
    end if;
  end loop;
  if cardinality(changes) = 0 then return 0; end if;

  -- Changing a policy locks its table until the migration commits. Take all the locks first, in
  -- one order (memberships and company_roles, which every check reads, first), waiting at most a
  -- second each try: a long query then holds things up for a second at a time instead of every
  -- request queueing behind the migration, and the migration can't deadlock with the app.
  select array_agg(t order by t not in ('public.memberships', 'public.company_roles'), t) into tables from unnest(tables) t;
  perform set_config('lock_timeout', '1s', true);
  loop
    begin
      execute 'lock table ' || array_to_string(tables, ', ') || ' in access exclusive mode';
      exit;
    exception when lock_not_available or deadlock_detected then
      tries := tries + 1;
      if tries >= 60 then
        raise exception 'Couldn''t update the row checks: other queries kept % busy for a minute. Run the migration again.', array_to_string(tables, ', ');
      end if;
      perform pg_sleep(0.5 + random());
    end;
  end loop;
  perform set_config('lock_timeout', lock_timeout_was, true);

  for i in 1..cardinality(changes) loop
    execute changes[i];
  end loop;
  return cardinality(changes);
end $$;

revoke all on function private.fold_member_checks(), private.fold_member_expr(text, text[]),
  private.fold_test(text, text, text[]) from public;

select private.fold_member_checks();
