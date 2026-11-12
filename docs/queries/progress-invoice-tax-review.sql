-- Progress invoices that charged more tax than their job's taxable share.
--
-- Before 20261112000430_progress_tax_share.sql a progress invoice taxed everything it billed, even
-- on a job where only some of the work is taxable. Where the progress billing came to more than the
-- job's taxable work, the final invoice couldn't give the difference back, and the client paid tax
-- the job didn't owe. Crewtavo doesn't change invoices that already exist, so this lists them for an
-- owner to look over and correct by hand (a credit or a refund to the client, as your accountant
-- advises).
--
-- It only reads. Run it against the instance's database:
--
--   docker compose --env-file .env.instance exec -T db psql -U postgres -d postgres < docs/queries/progress-invoice-tax-review.sql
--
-- or paste it into any SQL client connected with the instance's SUPABASE_DB_URL.
--
-- One row per progress invoice that isn't void, on a job whose lines aren't all taxable, where the
-- tax charged is more than the job's share would give:
--
--   tax_charged      what the invoice charged
--   tax_by_share     what it would charge now: the job's taxable share of its subtotal, at its rate
--   job_tax_owed     the tax on all the job's taxable lines, at the invoice's rate
--   job_tax_charged  the tax on all the job's invoices that aren't void
--   job_over         job_tax_charged - job_tax_owed. Above 0 once the job has its final invoice
--                    (final_invoice), the client was charged that much too much. Without a final
--                    invoice yet, the job's later invoices may still even it out.
--
-- The share is worked out from the job's lines as they are today, which may not be what they were
-- when the invoice was made, and an invoice's own discount or promo code isn't counted, so read
-- each row against the invoice before correcting anything.
begin transaction read only;

with job_lines as (
  select l.job_id,
         sum(round(l.quantity * l.unit_price, 2)) as total,
         coalesce(sum(round(l.quantity * l.unit_price, 2)) filter (where l.taxable), 0) as taxable
    from public.job_line_items l
   group by l.job_id
),
job_invoices as (
  select i.job_id,
         sum(i.tax_amount) as tax_charged,
         min(i.number) filter (where i.kind = 'standard') as final_invoice
    from public.invoices i
   where i.job_id is not null and i.status <> 'void'
   group by i.job_id
)
select co.name as company,
       i.number as invoice,
       i.status,
       i.issued_on,
       c.display_name as client,
       j.title as job,
       i.subtotal,
       i.tax_rate,
       i.tax_amount as tax_charged,
       round(round(i.subtotal * greatest(jl.taxable, 0) / jl.total, 2) * i.tax_rate, 2) as tax_by_share,
       round(greatest(jl.taxable, 0) * i.tax_rate, 2) as job_tax_owed,
       ji.tax_charged as job_tax_charged,
       ji.tax_charged - round(greatest(jl.taxable, 0) * i.tax_rate, 2) as job_over,
       ji.final_invoice
  from public.invoices i
  join public.jobs j on j.id = i.job_id
  join public.companies co on co.id = i.company_id
  join public.clients c on c.id = i.client_id
  join job_lines jl on jl.job_id = i.job_id
  join job_invoices ji on ji.job_id = i.job_id
 where i.kind = 'progress' and i.status <> 'void' and i.tax_rate > 0
   and jl.total > 0 and jl.taxable < jl.total
   and i.tax_amount > round(round(i.subtotal * greatest(jl.taxable, 0) / jl.total, 2) * i.tax_rate, 2)
 order by co.name, j.title, i.number;

rollback;
