-- Two rules that asked less of a direct change than the app's own screens do.
--
-- 1. Settings an area decides. Installing an app (Team chat, Drive, Careers, website forms and
--    analytics, Paving, Roofing) asks for the "Connect apps" area, weather rules for the settings
--    area and how subs are reminded for the subs area: the functions that save them check
--    (drive_set_enabled, set_weather_rules, set_sub_reminders and the rest). But companies.settings
--    is one column that any owner or admin may save, so an admin whose role leaves an area out
--    could change those settings by saving the company itself. They now stay as they were unless
--    the person saving has their area, the way settings.marketing, social, storage and autopay
--    already stay with their own functions (marketing_settings_guard and the others).
--
--    Kept quietly, not refused, and by a trigger, not a policy: Settings → Company, Schedule and
--    Maps, the revenue goal, and the paving and roofing set-up are open to every admin whatever
--    their areas, and several of them save the whole of settings as the page read it. A policy sees
--    only the row as it would become, not which setting changed, so it could only turn all of those
--    saves away or none. This way the rest of what they saved is saved, and a page open since
--    before an app was installed no longer uninstalls it for want of the area.
--
-- 2. Taking back what you added. Whoever added a photo, a time entry or an equipment photo may
--    remove it, and those rules went by the name on the row alone. They now also ask that the
--    person still has a sign-in the company hasn't turned off, as every other rule on those tables
--    does: for photos and time, the team or a sub (private.worker_companies); for equipment photos,
--    the team.
--
-- supabase/tests/settings_and_removed_members_test.sql covers both.

-- ---------------------------------------------------------------------------------------------
-- Settings an area decides
-- ---------------------------------------------------------------------------------------------

-- Someone signed in saving the company keeps each of these settings as it was unless they have its
-- area. The functions that save them run as the person asking, who has it. The server and
-- migrations have nobody signed in, so they go through.
create function private.company_settings_area_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_gate record;
  v_key text;
begin
  if (select auth.uid()) is null or new.settings is not distinct from old.settings then
    return new;
  end if;
  for v_gate in
    select * from (values
      ('apps', array['careers', 'drive', 'paving_app', 'roofing_app', 'team_chat', 'website_analytics', 'website_forms']),
      ('settings', array['weather_rules']),
      ('subs', array['subs'])) g(area, keys)
  loop
    continue when private.has_perm(new.id, v_gate.area);
    foreach v_key in array v_gate.keys loop
      if new.settings -> v_key is distinct from old.settings -> v_key then
        new.settings := case when old.settings -> v_key is null then coalesce(new.settings, '{}') - v_key
          else jsonb_set(coalesce(new.settings, '{}'), array[v_key], old.settings -> v_key) end;
      end if;
    end loop;
  end loop;
  return new;
end $$;
revoke all on function private.company_settings_area_guard() from public;
create trigger settings_area_guard before update of settings on public.companies
  for each row execute function private.company_settings_area_guard();

-- ---------------------------------------------------------------------------------------------
-- Taking back what you added
-- ---------------------------------------------------------------------------------------------

-- As 20261017000600_hardening.sql, for someone who still signs in: the team, or a sub taking back a
-- photo from their visit.
drop policy attachments_delete on public.attachments;
create policy attachments_delete on public.attachments for delete to authenticated using (
  private.has_role(company_id, '{owner,admin,office}')
  or (created_by = (select auth.uid()) and company_id = any ((select private.worker_companies())::uuid[]))
);

-- As 20261017002100_crew_leads.sql, for someone who still signs in: the team, or a sub on the
-- clock (time_entries_sub_clock keeps a sub off it to their own time).
drop policy time_entries_delete on public.time_entries;
create policy time_entries_delete on public.time_entries for delete to authenticated using (
  (user_id = (select auth.uid()) and approved_at is null and company_id = any ((select private.worker_companies())::uuid[]))
  or private.has_role(company_id, '{owner,admin,office}')
  or (private.has_role(company_id, '{crew_lead}') and private.on_my_crew(company_id, user_id) and approved_at is null)
);

-- As 20261109000200_equipment_photos.sql, for someone still on the team (only the team adds them).
drop policy equipment_photos_delete on public.equipment_photos;
create policy equipment_photos_delete on public.equipment_photos for delete to authenticated using (
  (created_by = (select auth.uid()) and private.is_member(company_id))
  or private.manages_equipment(company_id)
);

-- The policies above check membership once per query (20261018000990_policy_lookups).
select private.fold_member_checks('public.attachments');
select private.fold_member_checks('public.time_entries');
select private.fold_member_checks('public.equipment_photos');

notify pgrst, 'reload schema';
