-- When a client opens a sent quote or invoice in the Client Hub: the first time and the last, for the
-- office's lists and pages ("Opened 2h ago"), and on the first open a line in the record's history
-- and the activity feed ('quote.viewed', 'invoice.viewed'), which automations can follow.
--
--   * Its own table, not columns on quotes and invoices: an invoice's update runs its accounting and
--     Stripe syncs, autopay and totals, and a quote's moves it on the sales board. A client looking
--     at a link changes none of that.
--   * Only the server writes it (public.hub_opened, from GET /api/hub/:token), never for the office's
--     own preview, so "Opened" always means someone with the client's link opened it. Opening the
--     client's account page isn't opening each quote and invoice on it; opening one of them is.
--   * Whoever can see the quote or invoice can see when it was opened.

create table public.hub_opens (
  company_id uuid not null references public.companies (id) on delete cascade,
  quote_id uuid,
  invoice_id uuid,
  first_at timestamptz not null default now(),
  last_at timestamptz not null default now(),
  constraint hub_opens_one check (num_nonnulls(quote_id, invoice_id) = 1),
  constraint hub_opens_quote_key unique (company_id, quote_id),
  constraint hub_opens_invoice_key unique (company_id, invoice_id),
  constraint hub_opens_quote_fkey foreign key (company_id, quote_id) references public.quotes (company_id, id) on delete cascade,
  constraint hub_opens_invoice_fkey foreign key (company_id, invoice_id) references public.invoices (company_id, id) on delete cascade
);

alter table public.hub_opens enable row level security;
-- Seen with the record it's about: the quotes and invoices policies decide (a foreman sees no invoices).
create policy hub_opens_read on public.hub_opens for select to authenticated using (
  (quote_id is not null and exists (select 1 from public.quotes q where q.id = quote_id))
  or (invoice_id is not null and exists (select 1 from public.invoices i where i.id = invoice_id))
);
revoke insert, update, delete, truncate on public.hub_opens from anon, authenticated;
grant select on public.hub_opens to authenticated;

-- A client opened one: the first open adds the history line (and says so: true), every open moves "last".
create function public.hub_opened(p_company uuid, p_kind text, p_id uuid) returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  v_first boolean;
  v_number integer;
  v_client uuid;
  v_total numeric;
begin
  if p_kind = 'quote' then
    select number, client_id, total into v_number, v_client, v_total from public.quotes
    where company_id = p_company and id = p_id and status <> 'draft';
    if not found then return false; end if;
    insert into public.hub_opens (company_id, quote_id) values (p_company, p_id)
    on conflict (company_id, quote_id) do update set last_at = now()
    returning first_at = last_at into v_first;
    if v_first then
      perform private.emit(p_company, 'quote.viewed', 'quote', p_id, format('%s opened quote #%s', private.client_name(v_client), v_number),
        jsonb_build_object('number', v_number, 'total', v_total));
    end if;
  elsif p_kind = 'invoice' then
    select number, client_id, total into v_number, v_client, v_total from public.invoices
    where company_id = p_company and id = p_id and status not in ('draft', 'void');
    if not found then return false; end if;
    insert into public.hub_opens (company_id, invoice_id) values (p_company, p_id)
    on conflict (company_id, invoice_id) do update set last_at = now()
    returning first_at = last_at into v_first;
    if v_first then
      perform private.emit(p_company, 'invoice.viewed', 'invoice', p_id, format('%s opened invoice #%s', private.client_name(v_client), v_number),
        jsonb_build_object('number', v_number, 'total', v_total));
    end if;
  end if;
  return coalesce(v_first, false);
end $$;
revoke execute on function public.hub_opened(uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.hub_opened(uuid, text, uuid) to service_role;

notify pgrst, 'reload schema';
