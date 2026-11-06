-- Paving worksheets: the working behind a price from the paving calculator (Paving → Calculator):
-- the area, each item's depth or rate and amount, the prices it was priced at and the profit, with
-- the estimator's own notes. One sits on its quote (and on the quote line it priced, so a quote that
-- offers options keeps one per option), and on the job through the job's quote (jobs.quote_id).
--
-- It holds the business's costs and profit, so it's the office's alone: sales and the office read
-- and write it, as they do quotes (quotes_read). Crews, subs and clients never see it; the quote
-- line it priced carries only the price and the scope the client reads. The shape of `data` is the
-- web app's WorksheetData (apps/web/src/features/paving/calculator.ts), read back defensively.
-- supabase/tests/paving_worksheets_test.sql covers it.

create table public.paving_worksheets (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  quote_id uuid not null,
  line_id uuid references public.quote_line_items (id) on delete set null,
  name text not null check (length(trim(name)) between 1 and 200),
  notes text check (length(notes) <= 2000),
  data jsonb not null check (jsonb_typeof(data) = 'object' and pg_column_size(data) <= 100000),
  created_by uuid references auth.users (id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, id),
  foreign key (company_id, quote_id) references public.quotes (company_id, id) on delete cascade
);
create index paving_worksheets_quote_idx on public.paving_worksheets (quote_id);
create index paving_worksheets_line_idx on public.paving_worksheets (line_id) where line_id is not null;
select private.add_touch_triggers(array['paving_worksheets']);

comment on table public.paving_worksheets is 'The paving calculator''s working behind a quote line: amounts, prices and profit. The office''s only.';
comment on column public.paving_worksheets.line_id is 'The quote line it priced, on the same quote. Null once that line is taken off.';
comment on column public.paving_worksheets.data is 'The calculator''s setup, inputs and typed-over amounts as priced (web WorksheetData, v 1).';

alter table public.paving_worksheets enable row level security;
create policy paving_worksheets_read on public.paving_worksheets for select to authenticated
  using (private.has_role(company_id, '{owner,admin,office,estimator}'));
-- The line it priced is one of its own quote's.
create policy paving_worksheets_insert on public.paving_worksheets for insert to authenticated with check (
  private.has_role(company_id, '{owner,admin,office,estimator}')
  and (line_id is null or exists (select 1 from public.quote_line_items l where l.id = line_id and l.quote_id = paving_worksheets.quote_id))
);
create policy paving_worksheets_update on public.paving_worksheets for update to authenticated
  using (private.has_role(company_id, '{owner,admin,office,estimator}'))
  with check (
    private.has_role(company_id, '{owner,admin,office,estimator}')
    and (line_id is null or exists (select 1 from public.quote_line_items l where l.id = line_id and l.quote_id = paving_worksheets.quote_id))
  );
create policy paving_worksheets_delete on public.paving_worksheets for delete to authenticated
  using (private.has_role(company_id, '{owner,admin,office,estimator}'));
-- It stays on the quote it was made for: only its line, name, notes and working change.
revoke update on public.paving_worksheets from authenticated;
grant update (line_id, name, notes, data) on public.paving_worksheets to authenticated;
select private.fold_member_checks('public.paving_worksheets');
