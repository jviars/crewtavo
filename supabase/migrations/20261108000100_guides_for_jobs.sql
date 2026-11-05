-- Guides for a job (apps/web/src/features/kb): required reading for the people with a team role
-- (Settings → Roles), not just an access level, and the guide that's each role's job description.

-- Who must read a required guide: anyone whose access level is in audience or whose team role is in
-- audience_roles. Neither set: everyone. A deleted role's id stays and matches no one.
alter table public.sop_pages add column audience_roles uuid[];

-- A role's job description. Deleting the guide leaves the role without one.
alter table public.company_roles add column guide_id uuid;
alter table public.company_roles add constraint company_roles_guide_fkey foreign key (company_id, guide_id)
  references public.sop_pages (company_id, id) on delete set null (guide_id);
