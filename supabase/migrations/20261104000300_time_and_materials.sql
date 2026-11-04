-- Time and materials: the hours logged on a job (time_entries) and the materials its crews logged
-- (job_materials) go on its invoice as lines, priced from the price list (packages/core billing.ts
-- works the lines out; the invoice's "Add logged work" step and the assistant's bill_logged_work use
-- it). A line remembers what it bills (time_entry_ids, material_ids), so nothing is billed twice:
-- each is on at most one line of the job's invoices that aren't void. Taking the line off, or
-- voiding the invoice, frees them to bill again.
--
-- And a material logged without a unit is "ea": tons were the paving app's (its log form says so).

alter table public.invoice_line_items
  add column time_entry_ids uuid[] check (cardinality(time_entry_ids) between 1 and 1000),
  add column material_ids uuid[] check (cardinality(material_ids) between 1 and 1000);
comment on column public.invoice_line_items.time_entry_ids is 'The logged hours this line bills (time and materials).';
comment on column public.invoice_line_items.material_ids is 'The logged materials this line bills (time and materials).';
create index invoice_line_items_time_idx on public.invoice_line_items using gin (time_entry_ids) where time_entry_ids is not null;
create index invoice_line_items_materials_idx on public.invoice_line_items using gin (material_ids) where material_ids is not null;

alter table public.job_materials alter column unit set default 'ea';

-- Only the job's own finished hours (not breaks) and its logged materials, on one of its standard or
-- visits invoices, and none already on another line of its invoices that aren't void. The job's
-- lock (create_invoice_for_job's) is taken first, so two people billing the same hours wait.
create function private.billed_work_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  i public.invoices;
  v_number bigint;
begin
  if new.time_entry_ids is null and new.material_ids is null then return new; end if;
  if tg_op = 'UPDATE' and new.time_entry_ids is not distinct from old.time_entry_ids and new.material_ids is not distinct from old.material_ids
     and new.invoice_id = old.invoice_id then
    return new;
  end if;
  select * into i from public.invoices where id = new.invoice_id;
  if i.job_id is null or i.kind not in ('standard', 'visits') then
    raise exception 'Logged hours and materials go on an invoice for their job' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('invoice-for-job:' || i.job_id::text, 0));
  if exists (
       select 1 from unnest(coalesce(new.time_entry_ids, '{}')) x
       left join public.time_entries t on t.id = x and t.company_id = i.company_id
       left join public.visits v on v.id = t.visit_id
       where t.id is null or t.ended_at is null or t.category = 'break' or coalesce(t.job_id, v.job_id) is distinct from i.job_id)
     or exists (
       select 1 from unnest(coalesce(new.material_ids, '{}')) x
       left join public.job_materials m on m.id = x and m.company_id = i.company_id
       where m.id is null or m.job_id is distinct from i.job_id) then
    raise exception 'Only this job''s finished hours and logged materials go on its invoice' using errcode = '22023';
  end if;
  select inv.number into v_number
    from public.invoice_line_items l
    join public.invoices inv on inv.id = l.invoice_id
   where inv.job_id = i.job_id and inv.status <> 'void' and l.id <> new.id
     and (l.time_entry_ids && new.time_entry_ids or l.material_ids && new.material_ids)
   order by inv.number
   limit 1;
  if found then
    raise exception 'Some of that work is already on invoice #%', v_number using errcode = '22023';
  end if;
  return new;
end $$;
create trigger billed_work_guard before insert or update of time_entry_ids, material_ids, invoice_id on public.invoice_line_items
  for each row execute function private.billed_work_guard();

notify pgrst, 'reload schema';
