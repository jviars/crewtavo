-- Trip fees and a minimum charge.
--
-- "Add to every job" (services.add_to_every_job): a price list item, a trip charge say, that goes on
-- as a line wherever it isn't yet:
--   * a job made without a quote, when it's made (Create job, a request turned into a job, the
--     assistant's create_job);
--   * a quote, with its first lines: a roof estimate's package or options still go on a fresh quote
--     (they only go on one without lines), and a copy (Duplicate, a template) that has the line
--     already isn't given it again.
-- Not a job made from a quote (it has the quote's lines), nor a change order (its job has it). It's
-- added once: a line the office takes off stays off. At commit, so a copy's lines are in first.
--
-- A minimum charge (settings.minimum_charge, off unless set): an invoice whose charges come to less
-- gets a "Minimum charge" line making up the difference, kept right while it's a draft. Its charges
-- are its lines above $0, so a deposit or progress payment taken off a final invoice, or a discount,
-- doesn't set it off. Standard and visits invoices made in Crewtavo (from a job, or New invoice), so
-- create_invoice_for_job, batch invoicing, autopay and the assistant's invoice_job all get it; not
-- deposits, progress billing, retainage, or invoices brought in from Stripe. invoices.minimum_charge
-- is the minimum each was made with: taking the line off (or changing its price) stops topping it up.

alter table public.services add column add_to_every_job boolean not null default false;
comment on column public.services.add_to_every_job is 'Goes on every new job and quote as a line (a trip charge). See 20261104000100_trip_fee_minimum.sql.';

-- Quotes from before this have had their first lines already.
alter table public.quotes add column every_job_items_added boolean not null default true;
alter table public.quotes alter column every_job_items_added set default false;
comment on column public.quotes.every_job_items_added is 'The price list''s "Add to every job" items were put on (or it didn''t need them): they''re never added again.';

alter table public.invoices add column minimum_charge numeric(12, 2) check (minimum_charge > 0);
comment on column public.invoices.minimum_charge is 'The minimum charge it''s topped up to while a draft (settings.minimum_charge when it was made); null for none.';

alter table public.invoice_line_items add column kind text check (kind in ('minimum', 'late_fee'));
comment on column public.invoice_line_items.kind is 'minimum: the Minimum charge line; late_fee: a late fee (add_late_fees). Null for every other line.';

-- ---------------------------------------------------------------------------------------------
-- Add to every job
-- ---------------------------------------------------------------------------------------------

-- The turned-on "Add to every job" items a quote or job doesn't have a line from yet, after its lines.
create function private.add_every_job_items(p_quote uuid, p_job uuid) returns void
language sql security definer set search_path = '' as $$
  insert into public.quote_line_items (company_id, quote_id, service_id, name, description, quantity, unit, unit_price, unit_cost, taxable, sort)
  select q.company_id, q.id, s.id, s.name, s.description, 1, s.unit, s.unit_price, s.unit_cost, s.taxable,
         coalesce((select max(l.sort) from public.quote_line_items l where l.quote_id = q.id), 0) + row_number() over (order by s.sort, s.name)
    from public.quotes q
    join public.services s on s.company_id = q.company_id and s.active and s.add_to_every_job
   where q.id = p_quote
     and not exists (select 1 from public.quote_line_items l where l.quote_id = q.id and l.service_id = s.id);
  insert into public.job_line_items (company_id, job_id, service_id, name, description, quantity, unit, unit_price, unit_cost, taxable, sort)
  select j.company_id, j.id, s.id, s.name, s.description, 1, s.unit, s.unit_price, s.unit_cost, s.taxable,
         coalesce((select max(l.sort) from public.job_line_items l where l.job_id = j.id), 0) + row_number() over (order by s.sort, s.name)
    from public.jobs j
    join public.services s on s.company_id = j.company_id and s.active and s.add_to_every_job
   where j.id = p_job
     and not exists (select 1 from public.job_line_items l where l.job_id = j.id and l.service_id = s.id);
$$;
revoke execute on function private.add_every_job_items(uuid, uuid) from public;

-- A quote's first lines: the items go on a draft that isn't a change order, once. Trouble here
-- never stops the lines being saved.
create function private.every_job_items_quote() returns trigger
language plpgsql security definer set search_path = '' as $$
declare q public.quotes;
begin
  -- A business that adds nothing to every job is left as it was.
  if not exists (select 1 from public.services s where s.company_id = new.company_id and s.active and s.add_to_every_job) then return null; end if;
  select * into q from public.quotes where id = new.quote_id for update;
  if not found or q.every_job_items_added then return null; end if;
  begin
    if q.status = 'draft' and q.change_order_for is null then
      perform private.add_every_job_items(q.id, null);
    end if;
    update public.quotes set every_job_items_added = true where id = q.id;
  exception when others then
    raise warning 'The every-job items weren''t put on quote %: %', q.id, sqlerrm;
  end;
  return null;
end $$;
create constraint trigger every_job_items after insert on public.quote_line_items deferrable initially deferred
  for each row execute function private.every_job_items_quote();

-- A job made without a quote gets them when it's made.
create function private.every_job_items_job() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  begin
    if exists (select 1 from public.jobs where id = new.id and quote_id is null and status not in ('completed', 'archived')) then
      perform private.add_every_job_items(null, new.id);
    end if;
  exception when others then
    raise warning 'The every-job items weren''t put on job %: %', new.id, sqlerrm;
  end;
  return null;
end $$;
create constraint trigger every_job_items after insert on public.jobs deferrable initially deferred
  for each row when (new.quote_id is null) execute function private.every_job_items_job();

-- ---------------------------------------------------------------------------------------------
-- The minimum charge
-- ---------------------------------------------------------------------------------------------

-- Made in Crewtavo (from a job, or by someone signed in), not brought in from Stripe.
create function private.invoice_minimum() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.kind in ('standard', 'visits') and new.minimum_charge is null and (new.job_id is not null or (select auth.uid()) is not null) then
    select case when jsonb_typeof(c.settings -> 'minimum_charge') = 'number' and (c.settings ->> 'minimum_charge')::numeric > 0
                then round((c.settings ->> 'minimum_charge')::numeric, 2) end
      into new.minimum_charge
      from public.companies c where c.id = new.company_id;
  end if;
  return new;
end $$;
create trigger minimum_charge before insert on public.invoices
  for each row execute function private.invoice_minimum();

-- A draft's Minimum charge line made right: what its charges (lines above $0, the minimum and late
-- fees aside) are short of the minimum, or no line when they reach it (or it has none yet). Taxed
-- when any of the charges is.
create function private.fit_minimum_charge(p_invoice uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  i public.invoices;
  v_charges numeric;
  v_short numeric;
  v_line uuid;
  v_was text := coalesce(current_setting('crewtavo.minimum_charge', true), '');
begin
  select * into i from public.invoices where id = p_invoice;
  -- No minimum (or the office took the line over): its lines are the office's.
  if not found or i.status <> 'draft' or i.minimum_charge is null then return; end if;
  select coalesce(sum(round(quantity * unit_price, 2)) filter (where quantity * unit_price > 0), 0) into v_charges
    from public.invoice_line_items where invoice_id = i.id and kind is null;
  v_short := case when v_charges > 0 then greatest(i.minimum_charge - v_charges, 0) else 0 end;
  select id into v_line from public.invoice_line_items where invoice_id = i.id and kind = 'minimum' order by sort limit 1;
  perform set_config('crewtavo.minimum_charge', 'on', true);
  if v_short > 0 and v_line is null then
    insert into public.invoice_line_items (company_id, invoice_id, name, description, quantity, unit, unit_price, taxable, sort, kind)
    select i.company_id, i.id, 'Minimum charge', 'Brings the invoice up to our minimum', 1, 'ea', v_short,
           exists (select 1 from public.invoice_line_items l where l.invoice_id = i.id and l.kind is null and l.taxable and l.quantity * l.unit_price > 0),
           coalesce((select max(l.sort) from public.invoice_line_items l where l.invoice_id = i.id), 0) + 1, 'minimum';
  elsif v_short > 0 then
    update public.invoice_line_items set quantity = 1, unit_price = v_short where id = v_line and (quantity, unit_price) is distinct from (1, v_short);
  elsif v_line is not null then
    delete from public.invoice_line_items where invoice_id = i.id and kind = 'minimum';
  end if;
  perform set_config('crewtavo.minimum_charge', v_was, true);
end $$;
revoke execute on function private.fit_minimum_charge(uuid) from public;

-- After a draft's lines change. The office taking the line off, or changing what it charges, is the
-- office's call: that invoice isn't topped up any more.
create function private.minimum_charge_follows() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if coalesce(current_setting('crewtavo.minimum_charge', true), '') = 'on' then return null; end if;
  if (tg_op = 'DELETE' and old.kind = 'minimum')
     or (tg_op = 'UPDATE' and old.kind = 'minimum' and (new.quantity, new.unit_price) is distinct from (old.quantity, old.unit_price)) then
    update public.invoices set minimum_charge = null where id = old.invoice_id and status = 'draft' and minimum_charge is not null;
    return null;
  end if;
  perform private.fit_minimum_charge(coalesce(new.invoice_id, old.invoice_id));
  return null;
end $$;
create trigger minimum_charge after insert or update or delete on public.invoice_line_items
  for each row execute function private.minimum_charge_follows();

-- An AI assistant changes the minimum charge with the rest of Settings → Company (as in
-- 20261019001900_assistant_areas.sql, with minimum_charge and late_fee added).
create or replace function private.assistant_company_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  details constant text[] := array['name', 'phone', 'email', 'website', 'address', 'timezone', 'settings', 'updated_at'];
  settings constant text[] := array['payment_terms_days', 'default_tax_rate', 'quote_valid_days', 'working_hours', 'branding', 'hub_tips', 'depot',
                                    'minimum_charge', 'late_fee'];
begin
  if private.assistant_client() is null then return new; end if;
  if to_jsonb(new) - details is distinct from to_jsonb(old) - details
    or coalesce(new.settings, '{}') - settings is distinct from coalesce(old.settings, '{}') - settings
    or coalesce(new.settings -> 'branding', '{}') - 'color' is distinct from coalesce(old.settings -> 'branding', '{}') - 'color' then
    raise exception 'An AI assistant can change the company''s details and the settings on Settings → Company, nothing else.' using errcode = '42501';
  end if;
  return new;
end $$;

notify pgrst, 'reload schema';
