-- Activity events, in-app notifications and global search.
--
-- Every meaningful change (a quote approved, a visit completed, an invoice paid...) is written to
-- public.activity by triggers, whoever made it: the office, a crew, a client in the Client Hub or a
-- webhook. The activity feed, notifications and automations (next migration) all build on it.

-- ---------------------------------------------------------------------------------------------
-- Clients: marketing consent and referrals
-- ---------------------------------------------------------------------------------------------

alter table public.clients
  add column marketing_opt_out boolean not null default false,
  add column referred_by uuid,
  add constraint clients_referred_by_fkey foreign key (company_id, referred_by)
    references public.clients (company_id, id) on delete set null (referred_by);

-- ---------------------------------------------------------------------------------------------
-- Activity events
-- ---------------------------------------------------------------------------------------------

create index activity_subject_idx on public.activity (subject_type, subject_id);

create function private.emit(p_company uuid, p_verb text, p_type text, p_id uuid, p_summary text, p_data jsonb default '{}')
returns void language sql security definer set search_path = '' as $$
  insert into public.activity (company_id, actor_id, verb, subject_type, subject_id, summary, data)
  values (p_company, (select auth.uid()), p_verb, p_type, p_id, left(p_summary, 500), coalesce(p_data, '{}'));
$$;

create function private.client_name(p_id uuid) returns text
language sql stable security definer set search_path = '' as $$
  select coalesce((select display_name from public.clients where id = p_id), 'a client')
$$;

create function private.money(p_amount numeric) returns text
language sql immutable as $$
  select '$' || to_char(coalesce(p_amount, 0), 'FM999,999,990.00')
$$;

create function private.activity_clients() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform private.emit(new.company_id, 'client.created', 'client', new.id, 'New client: ' || new.display_name,
    jsonb_build_object('status', new.status, 'lead_source', new.lead_source));
  return null;
end $$;
create trigger activity after insert on public.clients for each row execute function private.activity_clients();

create function private.activity_requests() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform private.emit(new.company_id, 'request.created', 'request', new.id,
    format('New request #%s from %s: %s', new.number, private.client_name(new.client_id), new.title),
    jsonb_build_object('source', new.source, 'number', new.number));
  return null;
end $$;
create trigger activity after insert on public.requests for each row execute function private.activity_requests();

create function private.activity_quotes() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_client text := private.client_name(new.client_id);
  v_data jsonb := jsonb_build_object('number', new.number, 'total', new.total);
begin
  if tg_op = 'UPDATE' and new.status is distinct from old.status then
    case new.status
      when 'sent' then
        perform private.emit(new.company_id, 'quote.sent', 'quote', new.id, format('Quote #%s sent to %s (%s)', new.number, v_client, private.money(new.total)), v_data);
      when 'approved' then
        perform private.emit(new.company_id, 'quote.approved', 'quote', new.id,
          format('Quote #%s approved%s (%s)', new.number, coalesce(' by ' || (new.approval ->> 'name'), ''), private.money(new.total)), v_data);
      when 'changes_requested' then
        perform private.emit(new.company_id, 'quote.changes_requested', 'quote', new.id, format('%s asked for changes to quote #%s', v_client, new.number), v_data);
      when 'lost' then
        perform private.emit(new.company_id, 'quote.lost', 'quote', new.id, format('Quote #%s for %s marked lost', new.number, v_client), v_data);
      when 'converted' then
        perform private.emit(new.company_id, 'quote.converted', 'quote', new.id, format('Quote #%s converted to a job', new.number), v_data);
      else null;
    end case;
  end if;
  return null;
end $$;
create trigger activity after update of status on public.quotes for each row execute function private.activity_quotes();

create function private.activity_jobs() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_client text := private.client_name(new.client_id);
begin
  if tg_op = 'INSERT' then
    perform private.emit(new.company_id, 'job.created', 'job', new.id, format('Job #%s created for %s: %s', new.number, v_client, new.title),
      jsonb_build_object('number', new.number, 'kind', new.kind));
  elsif new.status is distinct from old.status and old.status = 'active' and new.status in ('requires_invoicing', 'completed') then
    perform private.emit(new.company_id, 'job.completed', 'job', new.id, format('Job #%s for %s is complete', new.number, v_client),
      jsonb_build_object('number', new.number, 'total', new.contract_total));
  end if;
  return null;
end $$;
create trigger activity after insert or update of status on public.jobs for each row execute function private.activity_jobs();

create function private.visit_client(p_visit public.visits) returns uuid
language sql stable security definer set search_path = '' as $$
  select coalesce(
    (select client_id from public.jobs where id = p_visit.job_id),
    (select client_id from public.requests where id = p_visit.request_id),
    (select client_id from public.properties where id = p_visit.property_id)
  )
$$;

create function private.activity_visits() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_client uuid;
begin
  if new.status is distinct from old.status and new.status in ('en_route', 'in_progress', 'completed') then
    v_client := private.visit_client(new);
    perform private.emit(new.company_id,
      case new.status when 'completed' then 'visit.completed' when 'in_progress' then 'visit.started' else 'visit.en_route' end,
      'visit', new.id,
      format('%s: %s%s',
        case new.status when 'completed' then 'Visit completed' when 'in_progress' then 'Visit started' else 'On the way' end,
        new.title, case when v_client is null then '' else ' (' || private.client_name(v_client) || ')' end),
      jsonb_build_object('kind', new.kind, 'client_id', v_client));
  end if;
  return null;
end $$;
create trigger activity after update of status on public.visits for each row execute function private.activity_visits();

create function private.activity_invoices() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_client text := private.client_name(new.client_id);
  v_data jsonb := jsonb_build_object('number', new.number, 'total', new.total, 'balance_due', new.balance_due);
begin
  if (tg_op = 'INSERT' and new.status <> 'draft') or (tg_op = 'UPDATE' and new.status is distinct from old.status) then
    case new.status
      when 'sent' then
        if tg_op = 'INSERT' or old.status = 'draft' then
          perform private.emit(new.company_id, 'invoice.sent', 'invoice', new.id, format('Invoice #%s sent to %s (%s)', new.number, v_client, private.money(new.total)), v_data);
        end if;
      when 'paid' then
        perform private.emit(new.company_id, 'invoice.paid', 'invoice', new.id, format('Invoice #%s paid by %s (%s)', new.number, v_client, private.money(new.total)), v_data);
      when 'overdue' then
        perform private.emit(new.company_id, 'invoice.overdue', 'invoice', new.id, format('Invoice #%s for %s is past due (%s owing)', new.number, v_client, private.money(new.balance_due)), v_data);
      else null;
    end case;
  end if;
  return null;
end $$;
create trigger activity after insert or update of status on public.invoices for each row execute function private.activity_invoices();

create function private.activity_payments() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.amount > 0 then
    perform private.emit(new.company_id, 'payment.received', 'invoice', new.invoice_id,
      format('%s payment received from %s', private.money(new.amount), private.client_name(new.client_id)),
      jsonb_build_object('amount', new.amount, 'method', new.method, 'client_id', new.client_id));
  end if;
  return null;
end $$;
create trigger activity after insert on public.payments for each row execute function private.activity_payments();

-- Crews see field activity; dollar amounts and sales stay with the office.
drop policy activity_read on public.activity;
create policy activity_read on public.activity for select to authenticated using (
  private.has_role(company_id, '{owner,admin,office,estimator}')
  or (private.is_member(company_id) and (verb like 'visit.%' or verb = 'job.created'))
);

-- ---------------------------------------------------------------------------------------------
-- Notifications: per person, created by automations ("Notify the office when...")
-- ---------------------------------------------------------------------------------------------

create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  kind text not null default 'info',
  title text not null check (length(title) between 1 and 300),
  body text,
  link text,
  read_at timestamptz,
  created_at timestamptz not null default now()
);
create index notifications_user_idx on public.notifications (user_id, company_id, created_at desc);
create index notifications_unread_idx on public.notifications (user_id, company_id) where read_at is null;

alter table public.notifications enable row level security;
create policy notifications_read on public.notifications for select to authenticated
  using (user_id = (select auth.uid()) and private.is_member(company_id));
create policy notifications_update on public.notifications for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy notifications_delete on public.notifications for delete to authenticated
  using (user_id = (select auth.uid()));
-- Inserts come from the automation engine (service role) only.

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.notifications;
  end if;
end $$;

-- ---------------------------------------------------------------------------------------------
-- Global search (the ⌘K palette): clients, properties, requests, quotes, jobs and invoices.
-- security invoker, so row-level security decides what each person finds.
-- ---------------------------------------------------------------------------------------------

create function public.global_search(p_company_id uuid, p_query text, p_limit integer default 5)
returns table (kind text, id uuid, title text, subtitle text, number bigint, status text, client_id uuid)
language plpgsql stable security invoker set search_path = '' as $$
declare
  v_q text := trim(coalesce(p_query, ''));
  v_like text;
  v_num bigint;
  v_limit integer := least(greatest(coalesce(p_limit, 5), 1), 20);
begin
  if length(v_q) = 0 then
    return;
  end if;
  v_like := '%' || replace(replace(replace(v_q, '\', '\\'), '%', '\%'), '_', '\_') || '%';
  if v_q ~ '^#?[0-9]{1,12}$' then
    v_num := ltrim(v_q, '#')::bigint;
  end if;

  return query
  (select 'client'::text, c.id, c.display_name, concat_ws(' · ', nullif(c.company_name, ''), c.email, c.phone), null::bigint, c.status, c.id
     from public.clients c
    where c.company_id = p_company_id
      and (c.display_name ilike v_like or c.company_name ilike v_like or c.email ilike v_like or c.phone ilike v_like)
    order by (c.status = 'archived'), (c.display_name ilike v_q || '%') desc, c.display_name
    limit v_limit)
  union all
  (select 'property'::text, p.id, p.line1, concat_ws(' · ', concat_ws(', ', p.city, p.region), cl.display_name), null::bigint, null::text, p.client_id
     from public.properties p join public.clients cl on cl.id = p.client_id
    where p.company_id = p_company_id and (p.line1 ilike v_like or p.label ilike v_like)
    order by p.line1
    limit v_limit)
  union all
  (select 'request'::text, r.id, r.title, cl.display_name, r.number, r.status, r.client_id
     from public.requests r join public.clients cl on cl.id = r.client_id
    where r.company_id = p_company_id and (r.number = v_num or r.title ilike v_like or cl.display_name ilike v_like)
    order by (r.number = v_num) desc nulls last, r.created_at desc
    limit v_limit)
  union all
  (select 'quote'::text, q.id, q.title, cl.display_name, q.number, q.status, q.client_id
     from public.quotes q join public.clients cl on cl.id = q.client_id
    where q.company_id = p_company_id and (q.number = v_num or q.title ilike v_like or cl.display_name ilike v_like)
    order by (q.number = v_num) desc nulls last, q.created_at desc
    limit v_limit)
  union all
  (select 'job'::text, j.id, j.title, cl.display_name, j.number, j.status, j.client_id
     from public.jobs j join public.clients cl on cl.id = j.client_id
    where j.company_id = p_company_id and (j.number = v_num or j.title ilike v_like or cl.display_name ilike v_like)
    order by (j.number = v_num) desc nulls last, j.created_at desc
    limit v_limit)
  union all
  (select 'invoice'::text, i.id, coalesce(nullif(i.subject, ''), 'Invoice #' || i.number), cl.display_name, i.number, i.status, i.client_id
     from public.invoices i join public.clients cl on cl.id = i.client_id
    where i.company_id = p_company_id and (i.number = v_num or i.subject ilike v_like or cl.display_name ilike v_like)
    order by (i.number = v_num) desc nulls last, i.created_at desc
    limit v_limit);
end $$;

revoke execute on function public.global_search(uuid, text, integer) from public, anon;
grant execute on function public.global_search(uuid, text, integer) to authenticated;

-- Refresh PostgREST's schema cache so new tables and relationships are available at once.
notify pgrst, 'reload schema';
