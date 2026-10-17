-- Pay rates are visible to the office only. Every member can still read who's on the team and their
-- role; the API reads labor_rate with the service role for owners, admins and office staff.
revoke select on public.memberships from anon, authenticated;
grant select (company_id, user_id, role, active, created_at, updated_at) on public.memberships to authenticated;
