-- Crew leads' time entries were still checked one row at a time: "is this person me, or on one of my
-- crews?" (private.on_my_crew) is a security definer function, which Postgres can't fold into the
-- query, so a crew lead's timesheets on 20,000 time entries took 4.6 s. People a crew lead puts on a
-- visit were checked the same way.
--
-- The same question is now asked once per query, as "who's on my crews, in which company?"
-- (private.my_crew_people), and each row's company and person is checked against that list, as
-- 20261018000990_policy_lookups.sql does for the other checks. The answers are the same, down to the
-- NULL for a row with nobody's name: on_my_crew stays as it is, and
-- supabase/tests/policy_lookups_test.sql checks that both forms agree for everyone, about every
-- company and person.

-- The people on the crews this person leads or is on (each crew's members and lead), with the
-- crew's company: whom private.on_my_crew says yes to in that company, besides the person themselves.
create or replace function private.my_crew_people() returns table (company_id uuid, user_id uuid)
language sql stable security definer set search_path = '' as $$
  select mine.company_id, x.user_id
  from private.my_crew_pairs() mine
  cross join lateral (
    select m.user_id from public.crew_members m where m.crew_id = mine.crew_id
    union
    select c.lead_user_id from public.crews c where c.id = mine.crew_id and c.lead_user_id is not null
  ) as x(user_id)
$$;

-- The same grants as on_my_crew.
grant execute on function private.my_crew_people() to public, authenticated, service_role;

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
    ('private.on_my_crew(uuid,uuid)', 'select p_user = (select auth.uid()) or exists ( select 1 from private.my_crews(p_company) as mine(crew_id) where exists (select 1 from public.crew_members m where m.crew_id = mine.crew_id and m.user_id = p_user) or exists (select 1 from public.crews c where c.id = mine.crew_id and c.lead_user_id = p_user) )'),
    ('private.assigned_to_visit(uuid)', 'select exists (select 1 from public.visit_assignees a where a.visit_id = p_visit and a.user_id = (select auth.uid()))'),
    ('private.works_visit(uuid)', 'select exists (select 1 from public.visit_assignees a where a.visit_id = p_visit and a.user_id = (select auth.uid())) or exists ( select 1 from public.visits v join public.crews c on c.id = v.crew_id where v.id = p_visit and (c.lead_user_id = (select auth.uid()) or exists (select 1 from public.crew_members m where m.crew_id = c.id and m.user_id = (select auth.uid()))) )'),
    ('private.visit_crew(uuid)', 'select crew_id from public.visits where id = p_visit'),
    ('private.crew_sees_client(uuid)', 'select exists ( select 1 from private.my_visits() v left join public.jobs j on j.id = v.job_id left join public.requests r on r.id = v.request_id left join public.properties p on p.id = v.property_id where p_client in (j.client_id, r.client_id, p.client_id) )'),
    ('private.crew_sees_job(uuid)', 'select exists (select 1 from private.my_visits() v where v.job_id = p_job)'),
    ('private.crew_sees_property(uuid)', 'select exists ( select 1 from private.my_visits() v left join public.jobs j on j.id = v.job_id left join public.requests r on r.id = v.request_id where p_property in (v.property_id, j.property_id, r.property_id) )'),
    ('private.crew_sees_request(uuid)', 'select exists (select 1 from private.my_visits() v where v.request_id = p_request)')
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
      (11, 'private\.crew_sees_request\(' || arg || '\)', 'private.crew_sees_request(uuid)'),
      -- The person is checked twice in what this is rewritten to, so it has to be a column.
      (12, 'private\.on_my_crew\(' || arg || ', ([a-z_]+(?:\.[a-z_]+)?)\)', 'private.on_my_crew(uuid,uuid)')
    ) as r(n, pattern, fn)
    order by n
  loop
    -- manages_equipment and schedules_crew are folded into has_role's and has_perm's lists,
    -- schedules_crew and on_my_crew check the crew through my_crews, and works_visit through
    -- visit_crew, as well.
    continue when rule.fn = any (changed)
      or rule.n in (4, 5) and changed && array['private.has_role(uuid,public.member_role[])', 'private.has_perm(uuid,text)']
      or rule.n in (5, 12) and 'private.my_crews(uuid)' = any (changed)
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
          -- Me, or someone on one of my crews in the row's company. The first half is on_my_crew's
          -- own, NULL for a row with nobody's name as before; the pair is written plainly only if
          -- neither column can be NULL.
          when 12 then '((' || m[3] || ' = (SELECT auth.uid())) OR '
                 || private.fold_test('(' || m[2] || ', ' || m[3] || ')', ' IN (SELECT p.company_id, p.user_id FROM private.my_crew_people() p)',
                      case when array[m[2], m[3]] <@ p_notnull then array['(' || m[2] || ', ' || m[3] || ')'] else '{}' end) || ')'
        end from strpos(e, m[1]) for length(m[1]));
    end loop;
  end loop;
  for i in 1..coalesce(cardinality(lits), 0) loop
    e := replace(e, chr(31) || i || chr(31), lits[i]);
  end loop;
  return e;
end $$;

/**
 * The ALTER POLICY statements that rewrite the per-row checks (private.fold_member_expr) of every
 * policy, or of one table's, keeping each policy's name, command, roles and the rest of its
 * expression. Warns about any check it can't rewrite.
 */
create or replace function private.member_fold_changes(p_only regclass default null)
returns table (tbl text, statement text)
language plpgsql stable set search_path = '' as $$
declare
  per_row constant text := 'private\.(has_role|has_perm|is_member|manages_equipment|schedules_crew|assigned_to_visit|works_visit|crew_sees_[a-z]+|on_my_crew)\(';
  p record;
  q text;
  c text;
  required text[];
begin
  -- With the empty search path every name in the printed expressions is schema-qualified, so they
  -- read back the same.
  for p in
    select pol.polname, pol.polrelid, pol.polrelid::regclass::text as tbl,
           pg_get_expr(pol.polqual, pol.polrelid) as qual, pg_get_expr(pol.polwithcheck, pol.polrelid) as chk
    from pg_policy pol join pg_class t on t.oid = pol.polrelid join pg_namespace n on n.oid = t.relnamespace
    where n.nspname in ('public', 'storage') and (p_only is null or pol.polrelid = p_only)
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
      tbl := p.tbl;
      statement := format('alter policy %I on %s', p.polname, p.tbl)
        || coalesce(' using (' || q || ')', '') || coalesce(' with check (' || c || ')', '');
      return next;
    end if;
  end loop;
end $$;

select private.fold_member_checks();
