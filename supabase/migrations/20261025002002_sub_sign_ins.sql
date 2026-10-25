-- Sign-ins for subcontractors, and "a member of the company" meaning the team (docs/subcontractors-
-- plan.md, phase B: "Subs are shut out by default").
--
--   memberships.subcontractor_id   which sub a sign-in is for. A membership is at the Subcontractor
--                                  level exactly when it has one. Still one membership per person per
--                                  company, so someone on the team can't also be a sub of the same
--                                  company. The server makes and removes these (Subs → the sub → Text
--                                  sign-in link) once it has checked who's asking; from a browser
--                                  nobody makes one, changes one, or turns one into the team's.
--   is_member, member_companies    and shares_company now mean the team: every active membership but
--                                  a sub's. Every rule built on them closes to subs without being
--                                  edited one by one, and so does every rule written later. Staff
--                                  still see a sub's profile; a sub doesn't see the team's.
--   my_subs()                      the person's sub sign-ins: each company, which sub, and what the
--                                  office lets them do (clock in, see clients' phone and email). The
--                                  lists made from it (sub_companies, my_sub_ids, my_sub_visits,
--                                  sub_clock_companies and worker_companies, the team and subs) are
--                                  used only where a sub is let back in (the next migration). A sub's
--                                  access holds while both their sign-in and the sub are turned on,
--                                  and never for an AI assistant.
--
--   end_sessions()                 signs a person out everywhere, for the server when the office
--                                  removes a sub's sign-in (so giving it back doesn't revive an old
--                                  phone).
--
-- Subs aren't on crews, can't be given a custom role and aren't in team chat. A sign-in the office
-- made for a sub (marked crewtavo_sub in its app_metadata) can't set up a business of its own.

-- ---------------------------------------------------------------------------------------------
-- Which sub a sign-in is for
-- ---------------------------------------------------------------------------------------------

alter table public.memberships add column subcontractor_id uuid;
alter table public.memberships
  add constraint memberships_subcontractor_fkey foreign key (company_id, subcontractor_id)
    references public.subcontractors (company_id, id) on delete cascade,
  add constraint memberships_subcontractor_check check ((role = 'subcontractor') = (subcontractor_id is not null));
create index memberships_subcontractor_idx on public.memberships (subcontractor_id) where subcontractor_id is not null;
-- The office sees which sign-in is whose, like the rest of the row (pay rates stay out).
grant select (subcontractor_id) on public.memberships to authenticated;

-- A custom role narrows a level of the team; there's nothing to narrow for a sub.
alter table public.company_roles add constraint company_roles_base_role_staff check (base_role <> 'subcontractor');

-- Team chat is for the team: no channel rules or chat settings for subs (private.chat_rights below
-- keeps them out whatever the rules say).
alter table public.chat_role_rules add constraint chat_role_rules_staff check (role is distinct from 'subcontractor');
alter table public.chat_role_settings add constraint chat_role_settings_staff check (role is distinct from 'subcontractor');

-- ---------------------------------------------------------------------------------------------
-- "Member" means the team
-- ---------------------------------------------------------------------------------------------

create or replace function private.is_member(p_company uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.memberships m
    where m.company_id = p_company and m.user_id = (select auth.uid()) and m.active and m.role <> 'subcontractor'
  )
$$;

create or replace function private.member_companies() returns uuid[]
language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg(m.company_id), '{}')
  from public.memberships m
  where m.user_id = (select auth.uid()) and m.active and m.role <> 'subcontractor'
$$;

-- Someone the person works with: the team sees everyone in their company, subs included; a sub sees
-- only themselves (profiles_read).
create or replace function private.shares_company(p_user uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.memberships mine
    join public.memberships theirs on theirs.company_id = mine.company_id
    where mine.user_id = (select auth.uid()) and mine.active and mine.role <> 'subcontractor' and theirs.user_id = p_user
  )
$$;

-- ---------------------------------------------------------------------------------------------
-- A sub's own sign-ins, for letting them back in
-- ---------------------------------------------------------------------------------------------

create function private.my_subs() returns table (company_id uuid, subcontractor_id uuid, uses_clock boolean, can_contact_clients boolean)
language sql stable security definer set search_path = '' as $$
  select m.company_id, s.id, s.uses_clock, s.can_contact_clients
  from public.memberships m
  join public.subcontractors s on s.company_id = m.company_id and s.id = m.subcontractor_id
  where m.user_id = (select auth.uid()) and m.active and m.role = 'subcontractor' and s.active
    and private.assistant_client() is null
$$;

-- The companies the person is a sub of.
create function private.sub_companies() returns uuid[]
language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg(s.company_id), '{}') from private.my_subs() s
$$;

-- The subs the person signs in as.
create function private.my_sub_ids() returns setof uuid
language sql stable security definer set search_path = '' as $$
  select s.subcontractor_id from private.my_subs() s
$$;

-- The companies where the office has the person, as a sub, on the clock.
create function private.sub_clock_companies() returns uuid[]
language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg(s.company_id), '{}') from private.my_subs() s where s.uses_clock
$$;

-- The team and subs: everyone with an active sign-in for the company.
create function private.worker_companies() returns uuid[]
language sql stable security definer set search_path = '' as $$
  select private.member_companies() || private.sub_companies()
$$;

-- The visits the person is on as a sub, with their company.
create function private.my_sub_visits() returns table (company_id uuid, visit_id uuid)
language sql stable security definer set search_path = '' as $$
  select a.company_id, a.visit_id from public.visit_assignees a
  where a.user_id = (select auth.uid()) and a.company_id = any (private.sub_companies())
$$;

revoke all on function private.my_subs(), private.sub_companies(), private.my_sub_ids(), private.sub_clock_companies(),
  private.worker_companies(), private.my_sub_visits() from public;
grant execute on function private.my_subs(), private.sub_companies(), private.my_sub_ids(), private.sub_clock_companies(),
  private.worker_companies(), private.my_sub_visits() to authenticated, service_role;

-- is_member's list (member_companies) changed with it.
create or replace function private.folded_helpers() returns table (helper text, body text)
language sql immutable set search_path = '' as $$
  values
    ('private.has_role(uuid,public.member_role[])', 'select exists ( select 1 from public.memberships m where m.company_id = p_company and m.user_id = (select auth.uid()) and m.active and m.role = any (p_roles) )'),
    ('private.has_perm(uuid,text)', 'select coalesce(( select case when r.id is null then p_perm = any (private.level_permissions(m.role)) else p_perm = any (r.permissions) end from public.memberships m left join public.company_roles r on r.id = m.role_id where m.company_id = p_company and m.user_id = (select auth.uid()) and m.active ), false)'),
    ('private.is_member(uuid)', 'select exists ( select 1 from public.memberships m where m.company_id = p_company and m.user_id = (select auth.uid()) and m.active and m.role <> ''subcontractor'' )'),
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

-- ---------------------------------------------------------------------------------------------
-- Guards
-- ---------------------------------------------------------------------------------------------

-- A sub's sign-in is the server's to give and take away. From a browser (an AI assistant included),
-- nobody adds one, turns a membership into one or one into the team's, or changes one. Deleting a
-- membership stays with owners and admins, as for anyone.
create function private.membership_sub_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if (select auth.uid()) is null then return new; end if;
  if new.role = 'subcontractor' or new.subcontractor_id is not null
     or (tg_op = 'UPDATE' and (old.role = 'subcontractor' or old.subcontractor_id is not null)) then
    raise exception 'A sub''s sign-in is given and taken away on their page, under Subs' using errcode = '42501';
  end if;
  return new;
end $$;
-- After role_level, which sets the level from a custom role.
create trigger sub_guard before insert or update on public.memberships for each row execute function private.membership_sub_guard();

-- Nobody changes their own level, access or which sub they sign in as (owners can change their own
-- level, as before; to or from a sub's, sub_guard stops them too).
create or replace function private.membership_self_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if (select auth.uid()) is not null and old.user_id = (select auth.uid())
     and not private.has_role(old.company_id, '{owner}')
     and (new.role is distinct from old.role or new.role_id is distinct from old.role_id or new.active is distinct from old.active
          or new.user_id is distinct from old.user_id or new.company_id is distinct from old.company_id
          or new.subcontractor_id is distinct from old.subcontractor_id) then
    raise exception 'Ask an owner to change your own role or access' using errcode = '42501';
  end if;
  return new;
end $$;

-- A crew's people see its visits, its chat and its time, so a sub is never on one (or leads one).
-- They're put on the visit itself.
create function private.crew_staff_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid := (to_jsonb(new) ->> case tg_table_name when 'crews' then 'lead_user_id' else 'user_id' end)::uuid;
begin
  if v_user is not null and exists (
    select 1 from public.memberships m where m.company_id = new.company_id and m.user_id = v_user and m.role = 'subcontractor'
  ) then
    raise exception 'A sub can''t be on a crew. Put them on the visit itself.' using errcode = '22023';
  end if;
  return new;
end $$;
create trigger staff_only before insert or update of lead_user_id on public.crews for each row execute function private.crew_staff_guard();
create trigger staff_only before insert or update of user_id on public.crew_members for each row execute function private.crew_staff_guard();

-- A sign-in the office made for a sub (Subs → the sub → Text sign-in link marks the account it makes,
-- app_metadata.crewtavo_sub) is for their work with that business, not for setting up one of their
-- own, unless they're also on a team somewhere. Someone with their own account the office gave sub
-- access to can still start a business: an office can't take that from them.
create or replace function public.create_company(p_name text, p_trade_preset text default 'general', p_timezone text default 'America/New_York')
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid := (select auth.uid());
  v_base text := trim(both '-' from regexp_replace(lower(p_name), '[^a-z0-9]+', '-', 'g'));
  v_slug text;
  v_id uuid;
begin
  if v_user is null then
    raise exception 'Sign in first' using errcode = '42501';
  end if;
  if exists (select 1 from auth.users u where u.id = v_user and u.raw_app_meta_data ? 'crewtavo_sub')
     and not exists (select 1 from public.memberships m where m.user_id = v_user and m.role <> 'subcontractor') then
    raise exception 'This sign-in is for your work with another business. To run your own business on Crewtavo, use a different email address.' using errcode = '42501';
  end if;
  -- One business per instance when it's set up that way (one at a time, so two sign-ups at once
  -- can't both be first).
  if exists (select 1 from private.instance where single_company) then
    perform pg_advisory_xact_lock(hashtextextended('create_company', 0));
    if exists (select 1 from public.companies) then
      raise exception 'This Crewtavo already has a business. Ask its owner to invite you.' using errcode = '42501';
    end if;
  end if;
  if length(v_base) < 2 then
    v_base := 'company';
  end if;
  v_slug := left(v_base, 50);
  while exists (select 1 from public.companies where slug = v_slug) loop
    v_slug := left(v_base, 50) || '-' || substr(md5(random()::text), 1, 5);
  end loop;

  insert into public.companies (name, slug, trade_preset, timezone)
  values (p_name, v_slug, coalesce(p_trade_preset, 'general'), coalesce(p_timezone, 'America/New_York'))
  returning id into v_id;

  insert into public.memberships (company_id, user_id, role) values (v_id, v_user, 'owner');
  return v_id;
end $$;

-- Signs a person out everywhere: every device's session and its refresh tokens (they go with it), so
-- a sign-in taken away doesn't come back on an old phone when it's given again. Their access token
-- runs out within the hour, and until then their removed membership already reaches nothing. For
-- the server only (services/subAccess.ts), never a browser.
create function public.end_sessions(p_user uuid) returns integer
language plpgsql security definer set search_path = '' as $$
declare n integer;
begin
  delete from auth.sessions where user_id = p_user;
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function public.end_sessions(uuid) from public, anon, authenticated;
grant execute on function public.end_sessions(uuid) to service_role;

-- What someone can do in a chat channel. A sub never sees one, whatever its rules say.
create or replace function private.chat_rights(p_channel uuid, p_user uuid, out can_see boolean, out can_post boolean, out can_manage boolean)
language plpgsql stable security definer set search_path = '' as $$
declare
  ch record;
  m record;
  rule record;
  own_only boolean;
begin
  can_see := false;
  can_post := false;
  can_manage := false;
  select c.company_id, c.crew_id, c.archived_at into ch from public.chat_channels c where c.id = p_channel;
  if not found or not private.chat_enabled(ch.company_id) then return; end if;
  select mb.role, mb.role_id into m from public.memberships mb where mb.company_id = ch.company_id and mb.user_id = p_user and mb.active;
  if not found or m.role = 'subcontractor' then return; end if;
  if m.role = 'owner' then
    can_see := true;
    can_manage := true;
    can_post := ch.archived_at is null;
    return;
  end if;
  -- The custom role's own rule, else its access level's.
  select r.can_see, r.can_post, r.can_manage into rule from public.chat_role_rules r
  where r.channel_id = p_channel and ((m.role_id is not null and r.role_id = m.role_id) or r.role = m.role)
  order by (r.role_id is not null) desc
  limit 1;
  if not found or not rule.can_see then return; end if;
  if ch.crew_id is not null then
    select s.own_crew_only into own_only from public.chat_role_settings s
    where s.company_id = ch.company_id and ((m.role_id is not null and s.role_id = m.role_id) or s.role = m.role)
    order by (s.role_id is not null) desc
    limit 1;
    if coalesce(own_only, false)
       and not exists (select 1 from public.crews c where c.id = ch.crew_id and c.lead_user_id = p_user)
       and not exists (select 1 from public.crew_members cm where cm.crew_id = ch.crew_id and cm.user_id = p_user) then
      return;
    end if;
  end if;
  can_manage := rule.can_manage;
  if ch.archived_at is null then
    can_see := true;
    can_post := rule.can_post;
  else
    -- An archived channel is read-only, and only its managers still see it (to bring it back).
    can_see := rule.can_manage;
  end if;
end $$;

-- No policy changes here, so nothing to fold: policies that ask about membership already read
-- member_companies() (20261018000990_policy_lookups), which now leaves subs out. (Folding here could
-- only wait on another migration's leftovers while memberships is locked; scripts/migrate.mjs folds
-- those a table at a time.)

notify pgrst, 'reload schema';
