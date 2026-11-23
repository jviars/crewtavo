-- The business's own prices and targets in its settings, kept from crews (a role audit, 2026-11-22).
-- Every member reads companies.settings, so a crew lead or field crew could read the paving
-- calculator's prices and profit (paving_calculator), the roofing price ranges (roofing) and the
-- finance targets (revenue_goal, margin_target). Those four keys now live in their own row that only
-- owners, admins, the office and estimators read. The sign-in (GET /api/me) adds them back to the
-- company's settings for those levels, so the app reads them where it always has.
--
-- Saving them doesn't change either: a key saved into companies.settings moves here, an object one
-- level down merged into the one kept (as merge_company_settings does), so a page that saves only
-- the roofing range keeps the typical roof size beside it.

create table public.company_private_settings (
  company_id uuid primary key references public.companies (id) on delete cascade deferrable initially deferred,
  settings jsonb not null default '{}'
);
alter table public.company_private_settings enable row level security;
create policy company_private_settings_read on public.company_private_settings for select to authenticated
  using (company_id = any ((select private.role_companies('{owner,admin,office,estimator}'))::uuid[]));
-- Only the trigger below writes them, as whoever saved the company's settings (owners and admins).
revoke all on public.company_private_settings from anon, authenticated;
grant select on public.company_private_settings to authenticated;

insert into public.company_private_settings (company_id, settings)
select c.id, (select jsonb_object_agg(e.key, e.value) from jsonb_each(c.settings) e
               where e.key = any ('{paving_calculator,roofing,revenue_goal,margin_target}'::text[]))
  from public.companies c
 where c.settings ?| '{paving_calculator,roofing,revenue_goal,margin_target}'::text[];
update public.companies set settings = settings - '{paving_calculator,roofing,revenue_goal,margin_target}'::text[]
 where settings ?| '{paving_calculator,roofing,revenue_goal,margin_target}'::text[];

create function private.keep_private_settings() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_moved jsonb;
begin
  select jsonb_object_agg(e.key, e.value) into v_moved from jsonb_each(coalesce(new.settings, '{}')) e
   where e.key = any ('{paving_calculator,roofing,revenue_goal,margin_target}'::text[]);
  if v_moved is not null then
    insert into public.company_private_settings as p (company_id, settings) values (new.id, v_moved)
    on conflict (company_id) do update set settings = p.settings || (
      select jsonb_object_agg(e.key, case when jsonb_typeof(p.settings -> e.key) = 'object' and jsonb_typeof(e.value) = 'object'
                                          then (p.settings -> e.key) || e.value else e.value end)
        from jsonb_each(excluded.settings) e);
    new.settings := new.settings - '{paving_calculator,roofing,revenue_goal,margin_target}'::text[];
  end if;
  return new;
end $$;
revoke all on function private.keep_private_settings() from public;
create trigger keep_private_settings before insert or update of settings on public.companies
  for each row execute function private.keep_private_settings();
