-- Automation rules about subs' job offers stay with the office that handles subs.
--
-- The sub_offer.* triggers (20261025004001_sub_offers.sql) carry a sub's name and price, and a reason
-- for turning a job down. Like the offer activity itself, they're for the office with the
-- Subcontractors area (docs/subcontractors-plan.md: "Crew leads and field crew never see them").
--
--   automation_rules   a rule on a sub_offer.* trigger is read, made, changed and deleted only by
--                      someone with the subs area, on top of the automations area it already needs.
--   automation_runs    its runs are read only by them too.
--   rule actions       a rule on a sub_offer.* trigger only tells the office or makes a task, as the
--                      rule screen and the AI assistant's tool already allow; told, it's only owners,
--                      admins and the office, never the crew or "the people on the visit". The engine
--                      (apps/api/src/services/automations.ts) holds to the same, and tells only those of
--                      them with the subs area, so a rule written straight to the database can't do more.

create policy automation_rules_sub_offers on public.automation_rules as restrictive for all to authenticated
  using (not starts_with(trigger, 'sub_offer.') or private.has_perm(company_id, 'subs'))
  with check (not starts_with(trigger, 'sub_offer.') or private.has_perm(company_id, 'subs'));

-- With the area, every run; without it, only runs of rules they can read, which leaves sub_offer.* out.
create policy automation_runs_sub_offers on public.automation_runs as restrictive for select to authenticated
  using (private.has_perm(company_id, 'subs') or exists (
    select 1 from public.automation_rules r where r.id = rule_id and not starts_with(r.trigger, 'sub_offer.')));

-- What a rule on a sub's offer may do, whoever saves it.
create function private.sub_offer_rule_actions() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if not starts_with(new.trigger, 'sub_offer.') then return new; end if;
  if exists (
    select 1 from jsonb_array_elements(case when jsonb_typeof(new.actions) = 'array' then new.actions else '[]' end) a
    where a ->> 'type' is distinct from 'notify' and a ->> 'type' is distinct from 'create_task'
  ) then
    raise exception 'A rule about a sub''s offer can only notify the office or make a task.' using errcode = '22023';
  end if;
  if exists (
    select 1 from jsonb_array_elements(case when jsonb_typeof(new.actions) = 'array' then new.actions else '[]' end) a
    cross join lateral jsonb_array_elements_text(case when jsonb_typeof(a -> 'roles') = 'array' then a -> 'roles' else '[]' end) r(role)
    where a ->> 'type' = 'notify' and r.role not in ('owner', 'admin', 'office')
  ) then
    raise exception 'Only the office hears about subs'' offers, never the crew.' using errcode = '22023';
  end if;
  return new;
end $$;
revoke all on function private.sub_offer_rule_actions() from public;

create trigger sub_offer_actions before insert or update of trigger, actions on public.automation_rules
  for each row execute function private.sub_offer_rule_actions();

-- One quick try at checking membership once per query (20261018000990_policy_lookups); if a table is
-- busy, scripts/migrate.mjs folds the rest a table at a time right after.
select private.fold_member_checks(null, interval '0');
