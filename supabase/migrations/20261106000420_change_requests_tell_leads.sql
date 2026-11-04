-- A client's request to move or cancel a visit tells the lead of the visit's crew too, who can
-- already answer it (private.schedules_crew: a crew lead for their own crew's visits), as well as
-- the owners, admins and office staff who schedule the whole team. Someone who is both is told once.

-- The visit's crew's lead, while they're on the team as a crew lead.
create function private.visit_crew_lead(p_company uuid, p_visit uuid) returns setof uuid
language sql stable security definer set search_path = '' as $$
  select c.lead_user_id
  from public.visits v
  join public.crews c on c.id = v.crew_id
  join public.memberships m on m.company_id = c.company_id and m.user_id = c.lead_user_id
  where v.company_id = p_company and v.id = p_visit and m.active and m.role = 'crew_lead'
$$;

-- As in 20261105000600_visit_change_requests.sql, with the crew's lead told too.
create or replace function private.visit_change_requested() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v public.visits;
  v_tz text;
  v_title text;
  v_body text;
begin
  select * into v from public.visits where id = new.visit_id;
  select timezone into v_tz from public.companies where id = new.company_id;
  v_title := format('%s asked to %s %s', private.client_name(new.client_id), case new.kind when 'cancel' then 'cancel' else 'move' end, v.title);
  v_body := 'Booked ' || private.visit_when(v.starts_at, v.scheduled_on, v_tz) || '. ' || case
    when new.kind = 'cancel' then coalesce('Reason: ' || new.reason, 'No reason given.')
    when new.scheduled_on is not null then 'Asked for ' || private.visit_when(new.starts_at, new.scheduled_on, v_tz) || '.'
    else '"' || left(new.message, 200) || '"'
  end;
  perform private.emit(new.company_id, 'visit.' || new.kind || '_requested', 'visit', new.visit_id, v_title, jsonb_build_object('request_id', new.id));
  insert into public.notifications (company_id, user_id, kind, title, body, link)
  select new.company_id, u, 'client', left(v_title, 300), v_body, '/schedule?date=' || coalesce(v.scheduled_on::text, '') || '&visit=' || v.id
  from (select o from private.schedule_office(new.company_id) o union select l from private.visit_crew_lead(new.company_id, new.visit_id) l) told(u);
  return null;
end $$;

revoke all on function private.visit_crew_lead(uuid, uuid), private.visit_change_requested() from public;
