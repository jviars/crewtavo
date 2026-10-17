-- Home dashboard, file storage rules and realtime.

-- One round trip for the Home screen. Runs as the caller: crews see only what RLS allows them.
create function public.dashboard(p_company uuid) returns jsonb
language sql stable security invoker set search_path = '' as $$
  with co as (
    select coalesce(timezone, 'UTC') as tz from public.companies where id = p_company
  ),
  bounds as (
    select (date_trunc('day', now() at time zone co.tz)) at time zone co.tz as day_start,
           (date_trunc('day', now() at time zone co.tz) + interval '1 day') at time zone co.tz as day_end,
           (now() at time zone co.tz)::date as today
    from co
  ),
  today_visits as (
    select v.id, v.title, v.kind, v.status, v.starts_at, v.scheduled_on, c.display_name as client, cr.name as crew
    from public.visits v
    cross join bounds b
    left join public.jobs j on j.id = v.job_id
    left join public.requests r on r.id = v.request_id
    left join public.clients c on c.id = coalesce(j.client_id, r.client_id)
    left join public.crews cr on cr.id = v.crew_id
    where v.company_id = p_company and v.status <> 'cancelled'
      and ((v.starts_at >= b.day_start and v.starts_at < b.day_end) or (v.starts_at is null and v.scheduled_on = b.today))
  ),
  owing as (
    select c.display_name as client, sum(i.balance_due) as owed
    from public.invoices i join public.clients c on c.id = i.client_id
    where i.company_id = p_company and i.status in ('sent', 'partially_paid', 'overdue') and i.balance_due > 0
    group by c.display_name
  )
  select jsonb_build_object(
    'workflow', jsonb_build_object(
      'requests', (
        select jsonb_build_object(
          'new', count(*) filter (where status = 'new'),
          'assessment_complete', count(*) filter (where status = 'assessment_complete'),
          'overdue', count(*) filter (where status = 'new' and created_at < now() - interval '2 days'))
        from public.requests where company_id = p_company),
      'quotes', (
        select jsonb_build_object(
          'awaiting', count(*) filter (where status in ('sent', 'changes_requested')),
          'awaiting_value', coalesce(sum(total) filter (where status in ('sent', 'changes_requested')), 0),
          'draft', count(*) filter (where status = 'draft'),
          'draft_value', coalesce(sum(total) filter (where status = 'draft'), 0))
        from public.quotes where company_id = p_company),
      'jobs', (
        select jsonb_build_object(
          'to_invoice', count(*) filter (where status = 'requires_invoicing'),
          'to_invoice_value', coalesce(sum(contract_total) filter (where status = 'requires_invoicing'), 0),
          'active', count(*) filter (where status = 'active'))
        from public.jobs where company_id = p_company),
      'invoices', (
        select jsonb_build_object(
          'awaiting', count(*) filter (where status in ('sent', 'partially_paid', 'overdue')),
          'awaiting_value', coalesce(sum(balance_due) filter (where status in ('sent', 'partially_paid', 'overdue')), 0),
          'past_due', count(*) filter (where status = 'overdue'),
          'past_due_value', coalesce(sum(balance_due) filter (where status = 'overdue'), 0),
          'draft', count(*) filter (where status = 'draft'))
        from public.invoices where company_id = p_company)
    ),
    'today', jsonb_build_object(
      'total', (select count(*) from today_visits),
      'by_status', coalesce((select jsonb_object_agg(status, n) from (select status, count(*) as n from today_visits group by status) s), '{}'),
      'visits', coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', id, 'title', title, 'kind', kind, 'status', status, 'starts_at', starts_at,
          'scheduled_on', scheduled_on, 'client', client, 'crew', crew)
          order by starts_at nulls last, title)
        from today_visits), '[]')
    ),
    'receivables', jsonb_build_object(
      'clients_owing', (select count(*) from owing),
      'total', coalesce((select sum(owed) from owing), 0),
      'top', coalesce((select jsonb_agg(jsonb_build_object('client', client, 'owed', owed) order by owed desc)
                       from (select * from owing order by owed desc limit 5) t), '[]')
    ),
    'attention', coalesce((
      select jsonb_agg(item) from (
        select jsonb_build_object('kind', 'quote', 'title', 'Quote #' || number || ' changes requested',
                                  'detail', title, 'link', '/quotes/' || id) as item
        from public.quotes where company_id = p_company and status = 'changes_requested'
        union all
        select jsonb_build_object('kind', 'visit', 'title', 'Weather hold: ' || title,
                                  'detail', hold_reason, 'link', '/schedule')
        from public.visits where company_id = p_company and hold_reason is not null and status = 'scheduled'
        limit 8
      ) a), '[]')
  )
$$;
revoke execute on function public.dashboard(uuid) from public, anon;
grant execute on function public.dashboard(uuid) to authenticated;

-- ---------------------------------------------------------------------------------------------
-- Storage: one private bucket; objects live under <company_id>/...
-- ---------------------------------------------------------------------------------------------

create function private.path_company(p_name text) returns uuid
language sql immutable as $$
  select case when split_part(p_name, '/', 1) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
              then split_part(p_name, '/', 1)::uuid end
$$;

insert into storage.buckets (id, name, public) values ('files', 'files', false) on conflict (id) do nothing;

create policy files_read on storage.objects for select to authenticated
  using (bucket_id = 'files' and private.is_member(private.path_company(name)));
create policy files_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'files' and private.is_member(private.path_company(name)));
create policy files_delete on storage.objects for delete to authenticated
  using (bucket_id = 'files' and private.has_role(private.path_company(name), '{owner,admin,office}'));

-- ---------------------------------------------------------------------------------------------
-- Realtime: the schedule board listens for visit changes (RLS still filters what each user gets).
-- ---------------------------------------------------------------------------------------------

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.visits;
  end if;
end $$;

-- Belt and braces: tables created before the default privileges above, and anon gets nothing.
grant select, insert, update, delete on all tables in schema public to authenticated;
grant all on all tables in schema public to service_role;
grant usage, select on all sequences in schema public to authenticated, service_role;
revoke all on all tables in schema public from anon;
revoke all on public.integration_secrets, public.outbox, public.number_sequences from authenticated;
