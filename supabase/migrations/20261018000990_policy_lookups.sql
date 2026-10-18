-- Row checks that ask "is this person in the row's company (with this role, or with this area)?",
-- or "is this one of my visits (or its client, job, property, request)?", looked the answer up again
-- for every row: they're security definer functions, which Postgres can't fold into the query, so
-- listing 20,000 invoices made 40,000 lookups and took 1.5 s, and the dashboard took 2 s on a few
-- years of data.
--
-- The same questions are now asked once per query, as "which companies is this person in (with
-- this role, or this area)?" and "which visits, clients, jobs... can they reach?", and each row is
-- checked against that list. Two checks still look one thing up per row, cheaply: the visit's crew
-- (crew members' checklists, crew leads' visit equipment and assignees) and, for crew leads,
-- whether a time entry's person is on their crew (on_my_crew).
--
-- The answers are the same: has_role and the rest stay as they are, for the database's own
-- functions, and supabase/tests/policy_lookups_test.sql checks that both forms agree for every role
-- and fails if a helper changes without its list (private.folded_helpers).

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

-- The crews this person leads or is on, with their company (what private.my_crews returns for one
-- company, for all of them).
create or replace function private.my_crew_pairs() returns table (company_id uuid, crew_id uuid)
language sql stable security definer set search_path = '' as $$
  select c.company_id, c.id from public.crews c where c.lead_user_id = (select auth.uid())
  union
  select m.company_id, m.crew_id from public.crew_members m where m.user_id = (select auth.uid())
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

-- The same grants as the per-row checks they stand in for.
revoke all on function private.member_companies(), private.role_companies(public.member_role[]),
  private.my_crew_pairs() from public;
grant execute on function private.member_companies(), private.role_companies(public.member_role[]),
  private.my_crew_pairs() to authenticated, service_role;
grant execute on function private.perm_companies(text), private.my_assigned_visits(), private.crew_clients(),
  private.crew_jobs(), private.crew_properties(), private.crew_requests()
  to public, authenticated, service_role;

/**
 * The helpers whose checks the lists stand in for, with the body each list mirrors. A helper is
 * folded into policies only while its body is still this one; supabase/tests/policy_lookups_test.sql
 * fails if one changes, so a change to a helper comes with the same change to its list (and the
 * policies folded again).
 */
create or replace function private.folded_helpers() returns table (helper text, body text)
language sql immutable set search_path = '' as $$
  values
    ('private.has_role(uuid,public.member_role[])', 'select exists ( select 1 from public.memberships m where m.company_id = p_company and m.user_id = (select auth.uid()) and m.active and m.role = any (p_roles) )'),
    ('private.has_perm(uuid,text)', 'select coalesce(( select case when r.id is null then p_perm = any (private.level_permissions(m.role)) else p_perm = any (r.permissions) end from public.memberships m left join public.company_roles r on r.id = m.role_id where m.company_id = p_company and m.user_id = (select auth.uid()) and m.active ), false)'),
    ('private.is_member(uuid)', 'select exists ( select 1 from public.memberships m where m.company_id = p_company and m.user_id = (select auth.uid()) and m.active )'),
    ('private.manages_equipment(uuid)', 'select private.has_role(p_company, ''{owner,admin,office,estimator,crew_lead}'') and private.has_perm(p_company, ''equipment'')'),
    ('private.schedules_crew(uuid,uuid)', 'select (private.has_role(p_company, ''{owner,admin,office,estimator,crew_lead}'') and private.has_perm(p_company, ''schedule'')) or (private.has_role(p_company, ''{crew_lead}'') and p_crew is not null and exists (select 1 from private.my_crews(p_company) as mine(crew_id) where mine.crew_id = p_crew))'),
    ('private.my_crews(uuid)', 'select c.id from public.crews c where c.company_id = p_company and c.lead_user_id = (select auth.uid()) union select m.crew_id from public.crew_members m where m.company_id = p_company and m.user_id = (select auth.uid())'),
    ('private.assigned_to_visit(uuid)', 'select exists (select 1 from public.visit_assignees a where a.visit_id = p_visit and a.user_id = (select auth.uid()))'),
    ('private.works_visit(uuid)', 'select exists (select 1 from public.visit_assignees a where a.visit_id = p_visit and a.user_id = (select auth.uid())) or exists ( select 1 from public.visits v join public.crews c on c.id = v.crew_id where v.id = p_visit and (c.lead_user_id = (select auth.uid()) or exists (select 1 from public.crew_members m where m.crew_id = c.id and m.user_id = (select auth.uid()))) )'),
    ('private.visit_crew(uuid)', 'select crew_id from public.visits where id = p_visit'),
    ('private.crew_sees_client(uuid)', 'select exists ( select 1 from private.my_visits() v left join public.jobs j on j.id = v.job_id left join public.requests r on r.id = v.request_id left join public.properties p on p.id = v.property_id where p_client in (j.client_id, r.client_id, p.client_id) )'),
    ('private.crew_sees_job(uuid)', 'select exists (select 1 from private.my_visits() v where v.job_id = p_job)'),
    ('private.crew_sees_property(uuid)', 'select exists ( select 1 from private.my_visits() v left join public.jobs j on j.id = v.job_id left join public.requests r on r.id = v.request_id where p_property in (v.property_id, j.property_id, r.property_id) )'),
    ('private.crew_sees_request(uuid)', 'select exists (select 1 from private.my_visits() v where v.request_id = p_request)')
$$;

/** The folded helpers whose body has changed since (none, normally). */
create or replace function private.changed_folded_helpers() returns setof text
language sql stable set search_path = '' as $$
  select h.helper from private.folded_helpers() h
  left join pg_proc p on p.oid = to_regprocedure(h.helper)
  where p.oid is null or btrim(regexp_replace(p.prosrc, '\s+', ' ', 'g')) is distinct from h.body
$$;

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
  changed text[];
  lits text[];
begin
  if e is null then return null; end if;
  lits := array(select l[1] from regexp_matches(e, '(''(?:[^'']|'''')*'')', 'g') with ordinality as x(l, n) order by n);
  for i in 1..coalesce(cardinality(lits), 0) loop
    e := overlay(e placing chr(31) || i || chr(31) from strpos(e, lits[i]) for length(lits[i]));
  end loop;
  -- Only helpers whose body is still the one their list mirrors are folded in.
  changed := array(select private.changed_folded_helpers());
  for rule in
    select * from (values
      (1, 'private\.has_role\(' || arg || ', ' || roles || '\)', 'private.has_role(uuid,public.member_role[])'),
      (2, 'private\.has_perm\(' || arg || ', (' || lit || '::text)\)', 'private.has_perm(uuid,text)'),
      (3, 'private\.is_member\(' || arg || '\)', 'private.is_member(uuid)'),
      (4, 'private\.manages_equipment\(' || arg || '\)', 'private.manages_equipment(uuid)'),
      (5, 'private\.schedules_crew\(' || arg || ', (private\.visit_crew\([a-z_]+\)|[a-z_]+)\)', 'private.schedules_crew(uuid,uuid)'),
      (6, 'private\.assigned_to_visit\(' || arg || '\)', 'private.assigned_to_visit(uuid)'),
      (7, 'private\.works_visit\(' || arg || '\)', 'private.works_visit(uuid)'),
      (8, 'private\.crew_sees_client\(' || arg || '\)', 'private.crew_sees_client(uuid)'),
      (9, 'private\.crew_sees_job\(' || arg || '\)', 'private.crew_sees_job(uuid)'),
      (10, 'private\.crew_sees_property\(' || arg || '\)', 'private.crew_sees_property(uuid)'),
      (11, 'private\.crew_sees_request\(' || arg || '\)', 'private.crew_sees_request(uuid)')
    ) as r(n, pattern, fn)
    order by n
  loop
    -- schedules_crew and works_visit check the crew through my_crews and visit_crew as well.
    continue when rule.fn = any (changed)
      or rule.n = 5 and 'private.my_crews(uuid)' = any (changed)
      or rule.n = 7 and 'private.visit_crew(uuid)' = any (changed);
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
                 || ' AND (COALESCE(((' || m[2] || ', ' || m[3] || ') IN (SELECT p.company_id, p.crew_id FROM private.my_crew_pairs() p)), false))))'
          when 6 then private.fold_test(m[2], ' IN (SELECT private.my_assigned_visits())', p_notnull)
          -- Their own visits, or one of their crew's: the visit's crew is looked up for the row, as
          -- a list of every visit their crew ever had would be large.
          when 7 then '(' || private.fold_test(m[2], ' IN (SELECT private.my_assigned_visits())', p_notnull)
                 || ' OR (COALESCE((private.visit_crew(' || m[2] || ') IN (SELECT p.crew_id FROM private.my_crew_pairs() p)), false)))'
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
  started constant timestamptz := clock_timestamp();
  attempt timestamptz;
  tries integer := 0;
  busy text;
begin
  if exists (select private.changed_folded_helpers()) then
    raise warning 'These helpers changed, so policies using them are left checking each row: %. Change their lists in this migration''s functions to match, and fold again.',
      (select string_agg(h, ', ') from private.changed_folded_helpers() h);
  end if;
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
  -- the order a query takes them (its table, then memberships and company_roles if those change,
  -- as its policy reads them). Each try waits a little for each table (longer as tries go on, for a
  -- busy app) and lets go of everything after 0.8 s at most: requests on a table are held up for a
  -- moment at a time, never as long as Postgres waits before it looks for a deadlock (a second). If
  -- the app keeps a table busy for three minutes the update stops (Railway keeps the running
  -- version), and it tries again the next time Crewtavo starts.
  select array_agg(t order by t in ('public.memberships', 'public.company_roles'), t = 'public.company_roles', t)
  into tables from unnest(tables) as u(t);
  loop
    attempt := clock_timestamp();
    perform set_config('lock_timeout', least(100 + 25 * tries, 500) || 'ms', true);
    tries := tries + 1;
    begin
      foreach busy in array tables loop
        if clock_timestamp() - attempt > interval '800 ms' then
          raise exception using errcode = 'lock_not_available';
        end if;
        execute 'lock table ' || busy || ' in access exclusive mode';
      end loop;
      exit;
    exception when lock_not_available or deadlock_detected then
      if clock_timestamp() - started > interval '3 minutes' then
        raise exception 'Couldn''t update the row checks: other queries kept % busy for three minutes. It''ll try again when Crewtavo next starts.', busy;
      end if;
      perform pg_sleep(0.1 + random() * 0.3);
    end;
  end loop;
  perform set_config('lock_timeout', lock_timeout_was, true);

  for i in 1..cardinality(changes) loop
    execute changes[i];
  end loop;
  return cardinality(changes);
end $$;

revoke all on function private.fold_member_checks(), private.fold_member_expr(text, text[]),
  private.fold_test(text, text, text[]), private.folded_helpers(), private.changed_folded_helpers() from public;

select private.fold_member_checks();
