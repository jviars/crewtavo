-- What the crew changes, and what stays with the office.
--
-- 1. Their visits. Field crew update the visits they're on (visits_update_assigned) to move them
--    through their steps and leave notes, and that rule let them change anything else about the
--    visit too: cancel it, rename it, change its kind, address or series, or say someone else
--    finished it. They now change what the field app changes, as a sub already did
--    (visit_sub_guard): the status, forward through the visit's steps and never to cancelled or out
--    of done, the notes, and the arrival time On my way works out. A visit they finish is finished
--    by them, when they tapped it. Crew leads, who schedule their crew, are as they were.
--
-- 2. Client messages. Field crew add notes on the clients they work for, and crew leads on any
--    client, and the rule let them add any message: a text "from the client", or a note signed by
--    someone else. Anyone but the office and sales now adds only an internal note, as themselves.
--
-- 3. Taking back what you wrote. Deleting your own equipment log entry, materials logged on a job,
--    your own note on a client and your own chat reaction went by the name on the row alone. They
--    now also ask that the person is still on the team, as 20261112000500_settings_and_removed_members.sql
--    did for photos, time and equipment photos.
--
-- supabase/tests/what_field_crews_change_test.sql covers all three.

-- ---------------------------------------------------------------------------------------------
-- Their visits
-- ---------------------------------------------------------------------------------------------

-- Not security definer: it asks who's writing, so the database's own functions that change a visit
-- for whatever a crew member did (finishing a job's last visit, say) go through. It runs before
-- visit_defaults (triggers run in name order), so it sees only what the person changed.
create function private.visit_field_crew_guard() returns trigger
language plpgsql set search_path = '' as $$
declare
  free constant text[] := array['status', 'notes', 'completed_at', 'completed_by', 'updated_at', 'eta_at'];
begin
  if current_user <> 'authenticated' or not private.has_role(old.company_id, '{field_crew}') then
    return new;
  end if;
  if to_jsonb(new) - free is distinct from to_jsonb(old) - free then
    raise exception 'You can change a visit''s status and notes. Ask the office about anything else.' using errcode = '42501';
  end if;
  if new.status is distinct from old.status
     and (old.status in ('completed', 'cancelled') or new.status not in ('scheduled', 'en_route', 'in_progress', 'completed')) then
    raise exception 'Ask the office to cancel, move or reopen this visit.' using errcode = '42501';
  end if;
  -- Finished when it was tapped (a phone that was offline sends the tap's time), if that's believable,
  -- and by whoever finished it. A visit finished before keeps its time and who finished it.
  new.completed_at := case
    when new.status = 'completed' and old.completed_at is null
         and new.completed_at <= now() and new.completed_at >= now() - interval '3 days' then new.completed_at
    when new.status = 'completed' then coalesce(old.completed_at, now())
    else old.completed_at end;
  new.completed_by := case when new.status = 'completed' and old.completed_at is null then (select auth.uid()) else old.completed_by end;
  return new;
end $$;
revoke all on function private.visit_field_crew_guard() from public;
create trigger visit_crew_status_guard before update on public.visits
  for each row execute function private.visit_field_crew_guard();

-- ---------------------------------------------------------------------------------------------
-- Client messages
-- ---------------------------------------------------------------------------------------------

-- As 20261017001300_field_crew_scope.sql for who adds one on which client; from anyone but the
-- office and sales, only an internal note, signed by them, that isn't made out to be a text or email.
drop policy messages_insert on public.messages;
create policy messages_insert on public.messages for insert to authenticated with check (
  private.has_role(company_id, '{owner,admin,office,estimator}')
  or (channel = 'note' and direction = 'internal' and status = 'sent' and sent_by = (select auth.uid())
      and external_id is null and recipients is null and from_phone is null and from_name is null
      and (private.has_role(company_id, '{crew_lead}')
           or (private.is_member(company_id) and client_id is not null and private.crew_sees_client(client_id))))
);

-- ---------------------------------------------------------------------------------------------
-- Taking back what you wrote
-- ---------------------------------------------------------------------------------------------

-- As 20261017001900_equipment.sql, for someone still on the team.
drop policy equipment_logs_delete on public.equipment_logs;
create policy equipment_logs_delete on public.equipment_logs for delete to authenticated
  using ((user_id = (select auth.uid()) and private.is_member(company_id)) or private.manages_equipment(company_id));

-- As 20261017002500_change_orders_and_materials.sql, for someone still on the team.
drop policy job_materials_delete on public.job_materials;
create policy job_materials_delete on public.job_materials for delete to authenticated
  using (private.has_role(company_id, '{owner,admin,office,crew_lead}')
         or (logged_by = (select auth.uid()) and logged_at > now() - interval '1 day' and private.is_member(company_id)));

-- As 20261017000500_billing_v2.sql, for someone still on the team.
drop policy messages_delete on public.messages;
create policy messages_delete on public.messages for delete to authenticated using (
  private.has_role(company_id, '{owner,admin,office}')
  or (channel = 'note' and direction = 'internal' and sent_by = (select auth.uid()) and private.is_member(company_id))
);

-- As 20261019001600_team_chat.sql, for someone still on the team.
drop policy chat_reactions_delete on public.chat_reactions;
create policy chat_reactions_delete on public.chat_reactions for delete to authenticated
  using (user_id = (select auth.uid()) and private.is_member(company_id));

-- The policies above check membership once per query (20261018000990_policy_lookups).
select private.fold_member_checks('public.messages');
select private.fold_member_checks('public.equipment_logs');
select private.fold_member_checks('public.job_materials');
select private.fold_member_checks('public.chat_reactions');

notify pgrst, 'reload schema';
