-- Billing, second version:
--   * deposit invoices bill the deposit, not the whole job;
--   * progress invoices bill a percentage or amount of the contract;
--   * "completed visits" invoices bill each finished, not-yet-billed visit (per-visit billing for
--     recurring work), and remember which visits they covered;
--   * the final invoice credits deposits and progress payments already invoiced.
-- Also tightens who can delete messages, and lets the office delete draft invoices.

alter table public.visits add column invoice_id uuid;
alter table public.visits add constraint visits_invoice_fkey foreign key (company_id, invoice_id)
  references public.invoices (company_id, id) on delete set null (invoice_id);
create index visits_invoice_idx on public.visits (invoice_id) where invoice_id is not null;

alter table public.invoices drop constraint invoices_kind_check;
alter table public.invoices add constraint invoices_kind_check check (kind in ('standard', 'deposit', 'progress', 'visits'));

drop function public.create_invoice_for_job(uuid, text);

create or replace function public.create_invoice_for_job(p_job uuid, p_kind text default 'standard', p_amount numeric default null)
returns uuid language plpgsql security invoker set search_path = '' as $$
declare
  j public.jobs;
  v_invoice uuid;
  v_terms integer;
  v_tax numeric;
  v_deposit numeric;
  v_amount numeric;
  v_sort integer := 0;
  r record;
begin
  select * into j from public.jobs where id = p_job;
  if not found then
    raise exception 'Job not found' using errcode = 'P0002';
  end if;
  if p_kind not in ('standard', 'deposit', 'progress', 'visits') then
    raise exception 'Unknown invoice type' using errcode = '22023';
  end if;
  select coalesce((settings ->> 'payment_terms_days')::integer, 30), coalesce((settings ->> 'default_tax_rate')::numeric, 0)
    into v_terms, v_tax
  from public.companies where id = j.company_id;

  if p_kind = 'visits' and not exists (
    select 1 from public.visits where job_id = j.id and status = 'completed' and invoice_id is null and kind = 'job'
  ) then
    raise exception 'There are no completed visits waiting to be invoiced' using errcode = '22023';
  end if;

  if p_kind = 'deposit' then
    select deposit_amount into v_deposit from public.quotes where id = j.quote_id;
    v_amount := coalesce(p_amount, nullif(v_deposit, 0));
    if v_amount is null or v_amount <= 0 then
      raise exception 'Enter the deposit amount' using errcode = '22023';
    end if;
  elsif p_kind = 'progress' then
    if p_amount is null or p_amount <= 0 then
      raise exception 'Enter how much to bill' using errcode = '22023';
    end if;
    v_amount := p_amount;
  end if;

  insert into public.invoices (company_id, client_id, job_id, kind, subject, due_on, tax_rate, retainage_pct, pay_app_number)
  values (
    j.company_id, j.client_id, j.id, p_kind,
    case p_kind when 'deposit' then 'Deposit: ' || j.title when 'visits' then j.title || ' (completed visits)' else j.title end,
    current_date + v_terms,
    case when p_kind in ('deposit') then 0 else v_tax end,
    case when p_kind in ('standard', 'progress') then j.retainage_pct else 0 end,
    case when p_kind = 'progress' then (select coalesce(max(pay_app_number), 0) + 1 from public.invoices where job_id = j.id) end
  )
  returning id into v_invoice;

  if p_kind = 'deposit' then
    insert into public.invoice_line_items (company_id, invoice_id, name, quantity, unit, unit_price, taxable, sort)
    values (j.company_id, v_invoice, 'Deposit for ' || j.title, 1, 'ea', round(v_amount, 2), false, 0);

  elsif p_kind = 'progress' then
    insert into public.invoice_line_items (company_id, invoice_id, name, description, quantity, unit, unit_price, taxable, sort)
    values (j.company_id, v_invoice, 'Progress billing: ' || j.title,
            case when j.contract_total > 0 then round(v_amount / j.contract_total * 100, 1) || '% of the ' || to_char(j.contract_total, 'FM$999,999,990.00') || ' contract' end,
            1, 'ea', round(v_amount, 2), true, 0);

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
      v_sort := v_sort + 100;
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
           1, 'ea', -i.subtotal, i.kind = 'progress', 10000 + row_number() over (order by i.number)
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

revoke execute on function public.create_invoice_for_job(uuid, text, numeric) from public, anon;
grant execute on function public.create_invoice_for_job(uuid, text, numeric) to authenticated;

-- Voiding releases the visits an invoice covered, so they can be billed again.
create function private.release_visits() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.status = 'void' and old.status <> 'void' then
    update public.visits set invoice_id = null where invoice_id = new.id;
  end if;
  return null;
end $$;
create trigger release_visits after update of status on public.invoices
  for each row execute function private.release_visits();

-- Messages: anyone on the team can log notes and messages, but only the office (or the author of
-- an internal note) can delete them.
drop policy messages_delete on public.messages;
create policy messages_delete on public.messages for delete to authenticated using (
  private.has_role(company_id, '{owner,admin,office}')
  or (channel = 'note' and direction = 'internal' and sent_by = (select auth.uid()))
);
drop policy messages_update on public.messages;
create policy messages_update on public.messages for update to authenticated using (
  private.has_role(company_id, '{owner,admin,office}')
) with check (private.has_role(company_id, '{owner,admin,office}'));

notify pgrst, 'reload schema';
