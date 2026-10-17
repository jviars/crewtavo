-- Fixes from a database audit (supabase/tests/audit_fixes_test.sql covers each):
--   * who someone is: profile emails follow their sign-in, and the server finds accounts by email;
--   * a one-business instance can't get a second business, even by calling create_company directly;
--   * crews don't see amounts or the client's Hub links in messages, or other people's receipts;
--   * time is approved only by people who may approve it, at the person's real pay rate;
--   * activity comes from the database, so nobody can set off emails and texts to clients;
--   * money records stay put: invoices with payments survive, void stays void, a sent invoice and an
--     approved quote keep their lines, document numbers come from the sequence;
--   * invoicing a job and using a promo code are safe when two people do it at the same moment;
--   * a crew lead edits only their own crews' visits, and only the office changes what billed one;
--   * custom roles can't loosen themselves, checklists follow the visit, gate codes follow the
--     company's local day, and meter readings can't be dated in the future.

-- ---------------------------------------------------------------------------------------------
-- Profiles: the email is the person's sign-in email, not something they type
-- ---------------------------------------------------------------------------------------------

-- The invite and sign-in-link routes look people up by email, so a profile email someone could
-- change would let them pose as whoever is about to be invited. Names, phone and color stay theirs.
revoke update on public.profiles from authenticated;
grant update (full_name, phone, avatar_url, color) on public.profiles to authenticated;

create function private.sync_profile_email() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  update public.profiles set email = new.email where user_id = new.id and email is distinct from new.email;
  return null;
end $$;
create trigger on_auth_user_email_changed after update of email on auth.users
  for each row execute function private.sync_profile_email();

update public.profiles p set email = u.email from auth.users u where u.id = p.user_id and p.email is distinct from u.email;

-- The account for an email address, for the server (invites and sign-in links). Exact match,
-- ignoring case; null when there's none (or, which shouldn't happen, more than one).
create function public.user_id_for_email(p_email text) returns uuid
language sql stable security definer set search_path = '' as $$
  select case when count(*) = 1 then min(u.id::text)::uuid end
  from auth.users u
  where lower(u.email) = lower(trim(p_email))
$$;
revoke execute on function public.user_id_for_email(text) from public, anon, authenticated;
grant execute on function public.user_id_for_email(text) to service_role;

-- ---------------------------------------------------------------------------------------------
-- One-business instances
-- ---------------------------------------------------------------------------------------------

-- Settings for this whole installation (one row at most). scripts/migrate.mjs writes it; no row
-- means the defaults.
create table private.instance (
  id boolean primary key default true check (id),
  single_company boolean not null default false
);
alter table private.instance enable row level security;
revoke all on private.instance from public, anon, authenticated, service_role;

-- A one-business instance refuses a second business, even when create_company is called directly.
create or replace function public.create_company(p_name text, p_trade_preset text default 'general', p_timezone text default 'America/New_York')
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid := (select auth.uid());
  v_base text := trim(both '-' from regexp_replace(lower(p_name), '[^a-z0-9]+', '-', 'g'));
  v_slug text;
  v_id uuid;
begin
  if v_user is null then
    raise exception 'Sign in first' using errcode = '42501';
  end if;
  -- One business per instance when it's set up that way (one at a time, so two sign-ups at once
  -- can't both be first).
  if exists (select 1 from private.instance where single_company) then
    perform pg_advisory_xact_lock(hashtextextended('create_company', 0));
    if exists (select 1 from public.companies) then
      raise exception 'This Crewtavo already has a business. Ask its owner to invite you.' using errcode = '42501';
    end if;
  end if;
  if length(v_base) < 2 then
    v_base := 'company';
  end if;
  v_slug := left(v_base, 50);
  while exists (select 1 from public.companies where slug = v_slug) loop
    v_slug := left(v_base, 50) || '-' || substr(md5(random()::text), 1, 5);
  end loop;

  insert into public.companies (name, slug, trade_preset, timezone)
  values (p_name, v_slug, coalesce(p_trade_preset, 'general'), coalesce(p_timezone, 'America/New_York'))
  returning id into v_id;

  insert into public.memberships (company_id, user_id, role) values (v_id, v_user, 'owner');
  return v_id;
end $$;

-- ---------------------------------------------------------------------------------------------
-- Time: approving is approving, however the entry arrives
-- ---------------------------------------------------------------------------------------------

-- An entry added already approved needs the same right as approving one, a crew lead still can't
-- approve their own time, and the pay rate always comes from the person's membership unless the
-- office types one.
create or replace function private.time_approval_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_changes_approval boolean := case when tg_op = 'INSERT' then new.approved_at is not null
                                     else new.approved_at is distinct from old.approved_at end;
begin
  if (select auth.uid()) is not null then
    if v_changes_approval then
      if not private.has_perm(new.company_id, 'timesheets') then
        raise exception 'Your role can''t approve time' using errcode = '42501';
      end if;
      if new.approved_at is not null and new.user_id = (select auth.uid()) and private.has_role(new.company_id, '{crew_lead}') then
        raise exception 'The office approves your own time.' using errcode = '22023';
      end if;
    end if;
    if not private.has_role(new.company_id, '{owner,admin,office}') then
      new.labor_rate := case when tg_op = 'UPDATE' then old.labor_rate end;
    end if;
  end if;
  if new.approved_at is not null and (tg_op = 'INSERT' or old.approved_at is null) and new.labor_rate is null then
    select m.labor_rate into new.labor_rate from public.memberships m where m.company_id = new.company_id and m.user_id = new.user_id;
  end if;
  return new;
end $$;
drop trigger approval_guard on public.time_entries;
create trigger approval_guard before insert or update on public.time_entries
  for each row execute function private.time_approval_guard();

-- ---------------------------------------------------------------------------------------------
-- Messages and activity
-- ---------------------------------------------------------------------------------------------

-- Quotes and invoices we send (and notes about them) carry amounts and the client's signed Hub
-- link: sales and the office read quote messages, people with the invoices area read invoice ones.
-- What clients write in is visible as before.
drop policy messages_read on public.messages;
create policy messages_read on public.messages for select to authenticated using (
  private.is_member(company_id) and case
    when related_type = 'invoice' and direction <> 'in' then
      private.has_role(company_id, '{owner,admin,office}') and private.has_perm(company_id, 'invoices')
    when related_type = 'quote' and direction <> 'in' then
      private.has_role(company_id, '{owner,admin,office,estimator}')
    else
      private.has_role(company_id, '{owner,admin,office,estimator,crew_lead}')
      or (client_id is not null and private.crew_sees_client(client_id))
  end
);

-- Activity is written by the database's own triggers. A row added by hand would set off
-- automations (emails and texts to clients), so people can't add them.
drop policy activity_insert on public.activity;
revoke insert on public.activity from authenticated;

-- Invoice and payment events carry amounts: they need the invoices area.
drop policy activity_read on public.activity;
create policy activity_read on public.activity for select to authenticated using (
  (private.has_role(company_id, '{owner,admin,office,estimator}')
   and (subject_type is distinct from 'invoice' or private.has_perm(company_id, 'invoices')))
  or (private.is_member(company_id) and (verb like 'visit.%' or verb = 'job.created'))
);

-- ---------------------------------------------------------------------------------------------
-- Invoices: lines, deleting, voiding and clients with money on record
-- ---------------------------------------------------------------------------------------------

-- A sent invoice's lines are locked, including moving one off it onto another invoice.
create or replace function private.invoice_lines_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if exists (
    select 1 from public.invoices i
    where i.id in (case when tg_op <> 'DELETE' then new.invoice_id end, case when tg_op <> 'INSERT' then old.invoice_id end)
      and i.status <> 'draft'
  ) then
    raise exception 'Move the invoice back to draft to change its line items' using errcode = '22023';
  end if;
  return coalesce(new, old);
end $$;

-- A void invoice stays void (its visits may already be on a new one).
create or replace function private.invoice_void_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if old.status = 'void' and new.status <> 'void' then
    raise exception 'A void invoice stays void. Make a new invoice instead' using errcode = '22023';
  end if;
  if new.status = 'void' and old.status <> 'void'
     and coalesce((select sum(amount) from public.payments where invoice_id = new.id), 0) <> 0 then
    raise exception 'This invoice has payments. Refund or remove them before voiding it' using errcode = '22023';
  end if;
  if new.status = 'draft' and old.status <> 'draft'
     and exists (select 1 from public.payments where invoice_id = new.id) then
    raise exception 'This invoice has payments, so it can''t go back to draft' using errcode = '22023';
  end if;
  return new;
end $$;

-- Only a draft with no payments is deleted; anything else is voided, so it stays on record.
create function private.invoice_delete_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if (select auth.uid()) is not null
     and (old.status <> 'draft' or exists (select 1 from public.payments where invoice_id = old.id)) then
    raise exception 'Only a draft invoice without payments can be deleted. Void it instead' using errcode = '22023';
  end if;
  return old;
end $$;
create trigger delete_guard before delete on public.invoices
  for each row execute function private.invoice_delete_guard();

-- Deleting a client takes its invoices and payments with it, so a client with money on record is
-- archived instead. (Drafts without payments still go with the client.)
create function private.client_delete_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if (select auth.uid()) is not null and (
    exists (select 1 from public.invoices where client_id = old.id and status <> 'draft')
    or exists (select 1 from public.payments where client_id = old.id)
  ) then
    raise exception '% has invoices or payments on record. Archive the client instead', old.display_name using errcode = '22023';
  end if;
  return old;
end $$;
create trigger delete_guard before delete on public.clients
  for each row execute function private.client_delete_guard();

-- ---------------------------------------------------------------------------------------------
-- Invoicing a job, one at a time
-- ---------------------------------------------------------------------------------------------

-- Two people invoicing the same job at once could each get past "one final invoice" and "not more
-- than the contract". The job's invoices are now made one after another.
create or replace function public.create_invoice_for_job(p_job uuid, p_kind text default 'standard', p_amount numeric default null)
returns uuid language plpgsql security invoker set search_path = '' as $$
declare
  j public.jobs;
  v_invoice uuid;
  v_terms integer;
  v_tax numeric;
  v_today date;
  v_deposit numeric;
  v_amount numeric;
  v_contract numeric;
  v_prebilled numeric;
  v_existing bigint;
  v_sort integer := 0;
  r record;
begin
  -- One invoice at a time for a job, so the checks below see each other's invoices.
  perform pg_advisory_xact_lock(hashtextextended('invoice-for-job:' || p_job::text, 0));
  select * into j from public.jobs where id = p_job;
  if not found then
    raise exception 'Job not found' using errcode = 'P0002';
  end if;
  if p_kind not in ('standard', 'deposit', 'progress', 'visits', 'retainage') then
    raise exception 'Unknown invoice type' using errcode = '22023';
  end if;
  select contract_total into v_contract from public.job_financials where job_id = j.id;
  select coalesce((settings ->> 'payment_terms_days')::integer, 30), coalesce((settings ->> 'default_tax_rate')::numeric, 0),
         (now() at time zone coalesce(timezone, 'UTC'))::date
    into v_terms, v_tax, v_today
  from public.companies where id = j.company_id;
  -- The rate the client approved on the quote wins over the company default.
  select coalesce(q.tax_rate, v_tax) into v_tax from public.quotes q where q.id = j.quote_id;
  v_tax := coalesce(v_tax, 0);

  select coalesce(sum(subtotal), 0) into v_prebilled
  from public.invoices where job_id = j.id and kind in ('deposit', 'progress') and status <> 'void';

  if p_kind = 'standard' and j.kind <> 'recurring' then
    select number into v_existing from public.invoices
    where job_id = j.id and kind = 'standard' and status <> 'void' order by number limit 1;
    if found then
      raise exception 'This job already has its final invoice (#%). Void it first to bill the job again', v_existing using errcode = '22023';
    end if;
  end if;

  if p_kind = 'visits' and not exists (
    select 1 from public.visits where job_id = j.id and status = 'completed' and invoice_id is null and kind = 'job'
  ) then
    raise exception 'There are no completed visits waiting to be invoiced' using errcode = '22023';
  end if;

  if p_kind = 'deposit' then
    select deposit_amount into v_deposit from public.quotes where id = j.quote_id;
    v_amount := round(coalesce(p_amount, nullif(v_deposit, 0)), 2);
    if v_amount is null or v_amount <= 0 then
      raise exception 'Enter the deposit amount' using errcode = '22023';
    end if;
  elsif p_kind = 'progress' then
    if p_amount is null or p_amount <= 0 then
      raise exception 'Enter how much to bill' using errcode = '22023';
    end if;
    v_amount := round(p_amount, 2);
  elsif p_kind = 'retainage' then
    select coalesce(sum(retainage_amount), 0) into v_amount
    from public.invoices where job_id = j.id and kind <> 'retainage' and status <> 'void';
    v_amount := v_amount - coalesce((select sum(subtotal) from public.invoices where job_id = j.id and kind = 'retainage' and status <> 'void'), 0);
    if v_amount <= 0 then
      raise exception 'There''s no retainage left to bill on this job' using errcode = '22023';
    end if;
  end if;

  if p_kind in ('deposit', 'progress') and j.kind <> 'recurring' and v_prebilled + v_amount > coalesce(v_contract, 0) + 0.005 then
    raise exception 'That''s more than what''s left to bill on this job (%)',
      to_char(greatest(coalesce(v_contract, 0) - v_prebilled, 0), 'FM$999,999,990.00') using errcode = '22023';
  end if;

  insert into public.invoices (company_id, client_id, job_id, kind, subject, issued_on, due_on, tax_rate, retainage_pct, pay_app_number)
  values (
    j.company_id, j.client_id, j.id, p_kind,
    case p_kind when 'deposit' then 'Deposit: ' || j.title when 'visits' then j.title || ' (completed visits)'
                when 'retainage' then 'Retainage: ' || j.title else j.title end,
    v_today, v_today + v_terms,
    case when p_kind in ('deposit', 'retainage') then 0 else v_tax end,
    case when p_kind in ('standard', 'progress') then j.retainage_pct else 0 end,
    case when p_kind = 'progress' then (select coalesce(max(pay_app_number), 0) + 1 from public.invoices where job_id = j.id) end
  )
  returning id into v_invoice;

  if p_kind = 'deposit' then
    insert into public.invoice_line_items (company_id, invoice_id, name, quantity, unit, unit_price, taxable, sort)
    values (j.company_id, v_invoice, 'Deposit for ' || j.title, 1, 'ea', v_amount, false, 0);

  elsif p_kind = 'retainage' then
    insert into public.invoice_line_items (company_id, invoice_id, name, description, quantity, unit, unit_price, taxable, sort)
    values (j.company_id, v_invoice, 'Retainage release: ' || j.title, 'Amount held back on earlier invoices for this job', 1, 'ea', v_amount, false, 0);

  elsif p_kind = 'progress' then
    insert into public.invoice_line_items (company_id, invoice_id, name, description, quantity, unit, unit_price, taxable, sort)
    values (j.company_id, v_invoice, 'Progress billing: ' || j.title,
            case when v_contract > 0 then round(v_amount / v_contract * 100, 1) || '% of the ' || to_char(v_contract, 'FM$999,999,990.00') || ' contract' end,
            1, 'ea', v_amount, true, 0);

  elsif p_kind = 'visits' then
    for r in
      select v.id, coalesce(v.completed_at::date, v.scheduled_on) as day
      from public.visits v
      where v.job_id = j.id and v.status = 'completed' and v.invoice_id is null and v.kind = 'job'
      order by coalesce(v.completed_at::date, v.scheduled_on)
    loop
      insert into public.invoice_line_items (company_id, invoice_id, name, description, quantity, unit, unit_price, taxable, sort)
      select j.company_id, v_invoice, li.name, 'Visit on ' || to_char(r.day, 'Mon DD, YYYY'), li.quantity, li.unit, li.unit_price, li.taxable, v_sort + li.sort
      from public.job_line_items li where li.job_id = j.id;
      update public.visits set invoice_id = v_invoice where id = r.id;
      v_sort := v_sort + 1000000;
    end loop;

  else
    insert into public.invoice_line_items (company_id, invoice_id, service_id, name, description, quantity, unit, unit_price, taxable, sort)
    select company_id, v_invoice, service_id, name, description, quantity, unit, unit_price, taxable, sort
    from public.job_line_items where job_id = j.id;
    -- Credit what was already billed as deposits and progress payments.
    insert into public.invoice_line_items (company_id, invoice_id, name, quantity, unit, unit_price, taxable, sort)
    select j.company_id, v_invoice,
           case i.kind when 'deposit' then 'Less deposit (invoice #' || i.number || ')' else 'Less progress billing (invoice #' || i.number || ')' end,
           -- Progress invoices were taxed, so their credit reduces the taxable amount too.
           1, 'ea', -i.subtotal, i.kind = 'progress', 200000 + row_number() over (order by i.number)
    from public.invoices i
    where i.job_id = j.id and i.kind in ('deposit', 'progress') and i.status <> 'void' and i.id <> v_invoice;
  end if;

  -- Touch the invoice so totals include the lines just added.
  update public.invoices set updated_at = now() where id = v_invoice;

  if j.status = 'requires_invoicing' and p_kind in ('standard', 'visits') then
    update public.jobs set status = 'completed' where id = j.id;
  end if;
  return v_invoice;
end $$;

-- ---------------------------------------------------------------------------------------------
-- Promo codes, one use at a time
-- ---------------------------------------------------------------------------------------------

-- Two documents taking the last use of a code at once could both get it. Uses of a code are now
-- counted one after another.
create or replace function public.apply_promo_code(p_kind text, p_id uuid, p_code text) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare
  q public.quotes; i public.invoices; p public.promo_codes; v_base numeric;
begin
  if p_kind = 'quote' then
    select * into q from public.quotes where id = p_id for update;
    if not found then raise exception 'Quote not found' using errcode = 'P0002'; end if;
    if q.status not in ('draft', 'sent', 'changes_requested') then
      raise exception 'Promo codes can''t be added once a quote is approved.' using errcode = '22023';
    end if;
    select coalesce(sum(round(quantity * unit_price, 2)) filter (where selected and unit_price > 0), 0) into v_base
    from public.quote_line_items where quote_id = q.id;
    -- One use of a code at a time, so its limits hold when two documents take it at once.
    perform pg_advisory_xact_lock(hashtextextended('promo:' || q.company_id::text || ':' || upper(regexp_replace(coalesce(p_code, ''), '\s', '', 'g')), 0));
    p := private.find_promo(q.company_id, q.client_id, p_code, v_base, q.id);
    update public.quotes set promo_code_id = p.id where id = q.id returning * into q;
    return jsonb_build_object('code', p.code, 'description', p.description, 'discount_amount', q.discount_amount, 'total', q.total);
  elsif p_kind = 'invoice' then
    select * into i from public.invoices where id = p_id for update;
    if not found then raise exception 'Invoice not found' using errcode = 'P0002'; end if;
    if i.status not in ('draft', 'sent', 'overdue') or exists (select 1 from public.payments where invoice_id = i.id) then
      raise exception 'Promo codes can only be added before an invoice is paid.' using errcode = '22023';
    end if;
    select coalesce(sum(round(quantity * unit_price, 2)) filter (where unit_price > 0), 0) into v_base
    from public.invoice_line_items where invoice_id = i.id;
    -- One use of a code at a time, so its limits hold when two documents take it at once.
    perform pg_advisory_xact_lock(hashtextextended('promo:' || i.company_id::text || ':' || upper(regexp_replace(coalesce(p_code, ''), '\s', '', 'g')), 0));
    p := private.find_promo(i.company_id, i.client_id, p_code, v_base, i.id);
    update public.invoices set promo_code_id = p.id where id = i.id returning * into i;
    return jsonb_build_object('code', p.code, 'description', p.description, 'discount_amount', i.discount_amount, 'total', i.total);
  end if;
  raise exception 'Unknown document type' using errcode = '22023';
end $$;

-- ---------------------------------------------------------------------------------------------
-- Change orders join their job once
-- ---------------------------------------------------------------------------------------------

-- A change order that's re-opened and approved again doesn't add its lines a second time.
create or replace function private.apply_change_order(p_quote uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare q public.quotes; v_sort integer;
begin
  select * into q from public.quotes where id = p_quote for update;
  if not found or q.change_order_for is null or q.status = 'converted' then
    return q.change_order_for;
  end if;
  -- Already on the job (it was re-opened and approved again): just mark it converted.
  if exists (select 1 from public.job_line_items where source_quote_id = q.id) then
    update public.quotes set status = 'converted', converted_at = coalesce(converted_at, now()) where id = q.id;
    return q.change_order_for;
  end if;
  select coalesce(max(sort), 0) into v_sort from public.job_line_items where job_id = q.change_order_for;
  insert into public.job_line_items (company_id, job_id, service_id, name, description, quantity, unit, unit_price, unit_cost, taxable, sort, source_quote_id)
  select company_id, q.change_order_for, service_id, name, description, quantity, unit, unit_price, unit_cost, taxable, v_sort + sort + 1, q.id
  from public.quote_line_items where quote_id = q.id and selected;
  perform private.carry_quote_discount(q.id, q.change_order_for, 'Change order discount');
  update public.job_line_items set source_quote_id = q.id
  where job_id = q.change_order_for and source_quote_id is null and name = 'Change order discount';
  -- The job's total (job_financials) follows its line items.
  update public.jobs set updated_at = now() where id = q.change_order_for;
  update public.quotes set status = 'converted', converted_at = now() where id = q.id;
  return q.change_order_for;
end $$;

-- ---------------------------------------------------------------------------------------------
-- Visits
-- ---------------------------------------------------------------------------------------------

-- As before, moving and reassigning follow schedules_crew(), now including which request a visit is
-- for. A crew lead without the "schedule" area changes only their own crews' visits (or ones
-- they're on), and only the office with the invoices area changes which invoice billed a visit.
create or replace function private.visit_crew_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if (select auth.uid()) is not null
     and (new.starts_at is distinct from old.starts_at or new.ends_at is distinct from old.ends_at
          or new.scheduled_on is distinct from old.scheduled_on or new.crew_id is distinct from old.crew_id
          or new.job_id is distinct from old.job_id or new.property_id is distinct from old.property_id
          or new.request_id is distinct from old.request_id)
     and not (private.schedules_crew(new.company_id, old.crew_id) and private.schedules_crew(new.company_id, new.crew_id)) then
    if private.has_role(new.company_id, '{crew_lead}') then
      raise exception 'You can change your own crew''s visits. Ask the office to move this one.' using errcode = '22023';
    end if;
    raise exception 'Your role can''t reschedule visits' using errcode = '42501';
  end if;
  if (select auth.uid()) is not null and private.has_role(new.company_id, '{crew_lead}')
     and not private.schedules_crew(new.company_id, old.crew_id) and not private.assigned_to_visit(old.id) then
    raise exception 'You can change your own crew''s visits. Ask the office to change this one.' using errcode = '22023';
  end if;
  if (select auth.uid()) is not null and new.invoice_id is distinct from old.invoice_id
     and not (private.has_role(new.company_id, '{owner,admin,office}') and private.has_perm(new.company_id, 'invoices')) then
    raise exception 'Only the office changes which invoice billed a visit' using errcode = '42501';
  end if;
  return new;
end $$;

-- ---------------------------------------------------------------------------------------------
-- Document numbers
-- ---------------------------------------------------------------------------------------------

-- Numbers always come from the company's sequence (a number picked by hand could block every later
-- document) and don't change afterwards. The server and imports, with no signed-in user, may set one.
create or replace function private.assign_number() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.number is null or (select auth.uid()) is not null then
    new.number := private.next_number(new.company_id, tg_table_name);
  end if;
  return new;
end $$;

create function private.freeze_number() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if (select auth.uid()) is not null and new.number is distinct from old.number then
    raise exception 'Document numbers can''t be changed' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger freeze_number before update of number on public.requests for each row execute function private.freeze_number();
create trigger freeze_number before update of number on public.quotes for each row execute function private.freeze_number();
create trigger freeze_number before update of number on public.jobs for each row execute function private.freeze_number();
create trigger freeze_number before update of number on public.invoices for each row execute function private.freeze_number();

-- ---------------------------------------------------------------------------------------------
-- Approved quotes keep what the client approved
-- ---------------------------------------------------------------------------------------------

-- Line items change while a quote is a draft, sent or has changes requested. (The Client Hub picks
-- options before it marks the quote approved, as the server.)
create function private.quote_lines_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if (select auth.uid()) is not null and exists (
    select 1 from public.quotes q
    where q.id in (case when tg_op <> 'DELETE' then new.quote_id end, case when tg_op <> 'INSERT' then old.quote_id end)
      and q.status in ('approved', 'converted')
  ) then
    raise exception 'This quote was approved, so its line items can''t change. Make a change order or a new quote instead' using errcode = '22023';
  end if;
  return coalesce(new, old);
end $$;
create trigger lines_guard before insert or update or delete on public.quote_line_items
  for each row execute function private.quote_lines_guard();

-- ---------------------------------------------------------------------------------------------
-- Custom roles can't loosen themselves
-- ---------------------------------------------------------------------------------------------

-- Does the signed-in person have this custom role?
create function private.holds_role(p_role uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.memberships m where m.role_id = p_role and m.user_id = (select auth.uid()))
$$;
revoke execute on function private.holds_role(uuid) from public;
grant execute on function private.holds_role(uuid) to authenticated, service_role;

-- Only an owner changes their own access level, custom role or access. (Your own pay rate is fine.)
create function private.membership_self_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if (select auth.uid()) is not null and old.user_id = (select auth.uid())
     and not private.has_role(old.company_id, '{owner}')
     and (new.role is distinct from old.role or new.role_id is distinct from old.role_id or new.active is distinct from old.active
          or new.user_id is distinct from old.user_id or new.company_id is distinct from old.company_id) then
    raise exception 'Ask an owner to change your own role or access' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger self_guard before update on public.memberships
  for each row execute function private.membership_self_guard();

-- Only an owner changes the areas or level of the custom role they have, or deletes it (which would
-- give them everything their level allows). Renaming it is fine.
create function private.company_role_self_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if (select auth.uid()) is not null and private.holds_role(old.id) and not private.has_role(old.company_id, '{owner}')
     and (tg_op = 'DELETE' or new.permissions is distinct from old.permissions or new.base_role is distinct from old.base_role) then
    raise exception 'Ask an owner to change the role you have' using errcode = '42501';
  end if;
  return coalesce(new, old);
end $$;
create trigger self_guard before update or delete on public.company_roles
  for each row execute function private.company_role_self_guard();

-- ---------------------------------------------------------------------------------------------
-- Checklists follow the visit
-- ---------------------------------------------------------------------------------------------

-- Am I working this visit: on it, or on (or leading) its crew?
create function private.works_visit(p_visit uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.visit_assignees a where a.visit_id = p_visit and a.user_id = (select auth.uid()))
      or exists (
        select 1 from public.visits v join public.crews c on c.id = v.crew_id
        where v.id = p_visit and (c.lead_user_id = (select auth.uid())
          or exists (select 1 from public.crew_members m where m.crew_id = c.id and m.user_id = (select auth.uid())))
      )
$$;
revoke execute on function private.works_visit(uuid) from public;
grant execute on function private.works_visit(uuid) to authenticated, service_role;

-- Answers are read by the office, estimators and crew leads, and by whoever works the visit; they're
-- filled in by whoever works it, whoever schedules its crew, and the office.
drop policy checklist_responses_read on public.checklist_responses;
drop policy checklist_responses_insert on public.checklist_responses;
drop policy checklist_responses_update on public.checklist_responses;
drop policy checklist_responses_delete on public.checklist_responses;
create policy checklist_responses_read on public.checklist_responses for select to authenticated using (
  private.has_role(company_id, '{owner,admin,office,estimator,crew_lead}')
  or (private.is_member(company_id) and private.works_visit(visit_id))
);
create policy checklist_responses_write on public.checklist_responses for all to authenticated
  using (
    private.has_role(company_id, '{owner,admin,office}')
    or private.schedules_crew(company_id, private.visit_crew(visit_id))
    or (private.is_member(company_id) and private.works_visit(visit_id))
  )
  with check (
    private.has_role(company_id, '{owner,admin,office}')
    or private.schedules_crew(company_id, private.visit_crew(visit_id))
    or (private.is_member(company_id) and private.works_visit(visit_id))
  );

-- ---------------------------------------------------------------------------------------------
-- Storage: receipts follow expense privacy
-- ---------------------------------------------------------------------------------------------

-- Receipts (<company>/receipts/...) are for whoever uploaded them and people with the job costs
-- area, like the expenses they belong to. Other files stay readable by the team.
drop policy files_read on storage.objects;
create policy files_read on storage.objects for select to authenticated using (
  bucket_id = 'files' and private.is_member(private.path_company(name)) and (
    split_part(name, '/', 2) <> 'receipts'
    or owner = (select auth.uid())
    or private.has_perm(private.path_company(name), 'job_costs')
  )
);

-- ---------------------------------------------------------------------------------------------
-- Gate codes on the day, in the company's time zone
-- ---------------------------------------------------------------------------------------------

-- An anytime visit (a day, no time) used to count from midnight UTC, so its crew lost the gate code
-- by mid-morning in the Americas. It now counts the company's local today and tomorrow.
grant execute on function private.company_today(uuid) to authenticated;
drop policy property_access_read on public.property_access;
create policy property_access_read on public.property_access for select to authenticated using (
  private.has_role(company_id, '{owner,admin,office}')
  or exists (
    select 1 from public.visits v
    join public.visit_assignees a on a.visit_id = v.id
    where v.property_id = property_access.property_id
      and a.user_id = (select auth.uid())
      and v.status not in ('completed', 'cancelled')
      and case when v.starts_at is not null
               then v.starts_at between now() - interval '12 hours' and now() + interval '24 hours'
               else v.scheduled_on between private.company_today(v.company_id) and private.company_today(v.company_id) + 1 end
  )
);

-- ---------------------------------------------------------------------------------------------
-- Equipment readings can't be dated in the future
-- ---------------------------------------------------------------------------------------------

-- The newest reading sets the meter, so one dated next year would hide every reading after it (and
-- the maintenance it should bring due).
create function private.equipment_log_date_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.done_on > private.company_today(new.company_id) + 1 then
    raise exception 'That date is in the future' using errcode = '22023';
  end if;
  return new;
end $$;
create trigger date_guard before insert or update of done_on on public.equipment_logs
  for each row execute function private.equipment_log_date_guard();

-- Refresh PostgREST's schema cache so the new function is available at once.
notify pgrst, 'reload schema';
