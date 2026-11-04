-- Show to client on a checklist (Settings → Checklists), the way Jobber shows job form answers:
-- once it's on, the checklist's finished answers show on the client's past visit in the Client Hub
-- and print on the job's invoice. Off by default, so what crews fill in stays the office's until
-- the business says otherwise. The Hub's server reads only the checklists with it on.
--
-- It's a column of the checklist like `active`, so the rules that already decide who changes
-- checklists (the Settings area) decide who turns it on.

alter table public.checklist_templates add column show_to_client boolean not null default false;

notify pgrst, 'reload schema';
