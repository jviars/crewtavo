-- A new access level, Subcontractor, for a sub's own sign-in (docs/subcontractors-plan.md, phase B).
--
-- On its own because Postgres won't use a new enum value inside the transaction that added it, and
-- every migration runs in one (scripts/migrate.mjs). The next migrations give the level its rules:
-- a sub starts with nothing and is let back in to their own visits and paperwork.

alter type public.member_role add value if not exists 'subcontractor';
