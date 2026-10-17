-- Agreeing to the Crewtavo License (LICENSE at the repository root). Whoever sets up a business
-- agrees during setup; owners and admins are asked again when the license changes (TERMS_VERSION
-- in packages/core/src/terms.ts). Each agreement is kept as it was made: who, which version and
-- when. Rows are added only through public.accept_terms() and never edited or removed by people.

create table public.terms_acceptances (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  user_id uuid references auth.users (id) on delete set null,
  -- Who agreed, as they were then, so the record stays readable after they leave.
  full_name text not null default '',
  email text,
  role public.member_role not null,
  version text not null check (length(version) between 1 and 40),
  accepted_at timestamptz not null default now()
);
create index terms_acceptances_company on public.terms_acceptances (company_id, version);

alter table public.terms_acceptances enable row level security;
create policy terms_acceptances_read on public.terms_acceptances for select to authenticated
  using (private.has_role(company_id, '{owner,admin}'));
revoke insert, update, delete on public.terms_acceptances from authenticated;
revoke all on public.terms_acceptances from anon;

-- An owner or admin agrees on behalf of the business. Returns the new record's id.
create function public.accept_terms(p_company uuid, p_version text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid := (select auth.uid());
  v_role public.member_role;
  v_id uuid;
begin
  select m.role into v_role from public.memberships m
  where m.company_id = p_company and m.user_id = v_user and m.active;
  if v_role is null or v_role not in ('owner', 'admin') then
    raise exception 'Only an owner or admin can agree to the license for the business' using errcode = '42501';
  end if;
  insert into public.terms_acceptances (company_id, user_id, full_name, email, role, version)
  select p_company, v_user, coalesce(p.full_name, ''), p.email, v_role, p_version
  from (select 1) one
  left join public.profiles p on p.user_id = v_user
  returning id into v_id;
  return v_id;
end $$;

revoke execute on function public.accept_terms(uuid, text) from public, anon;
grant execute on function public.accept_terms(uuid, text) to authenticated;
