-- One promo code to a job. A job takes its quote's code once (20261031000600_promo_once_per_job.sql),
-- and an invoice that has the code's discount line takes no other (20261031000630). But a deposit,
-- progress or retainage invoice never has that line: it bills part of a contract total the discount
-- is already in. So a client could type a second code on one in the Client Hub: with SPRING15 on the
-- quote and another code on the $500 deposit invoice, they paid $450 and the final invoice credited
-- the whole $500 deposit. Now those invoices refuse a code when their job already has one.
--
-- Refusing rather than crediting only what was paid: the final invoice credits a deposit's subtotal
-- so that a code on the deposit of a job with no code of its own stays money off, which is what the
-- client was promised. Crediting what was paid would quietly charge that discount back on the final
-- invoice. The only case that's wrong is the second code, so that's what is refused. Codes already
-- on such invoices stay, and can still be taken off.

-- Whether an invoice's job already has a promo code's discount: on the job's lines (its quote's, or
-- a change order's), or, for the deposit invoice a client was asked as they approved, on the quote
-- that isn't a job yet. Read as the owner, so the answer is the same whoever asks.
create function private.invoice_job_has_promo(p_invoice uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.invoices i join public.job_line_items l on l.job_id = i.job_id
                  where i.id = p_invoice and l.discount_key is not null)
      or exists (select 1 from public.quotes q
                  where q.deposit_invoice_id = p_invoice and q.discount_amount > 0
                    and (q.promo_code_id is not null or q.promo_every_visit is not null))
$$;
revoke all on function private.invoice_job_has_promo(uuid) from public;
grant execute on function private.invoice_job_has_promo(uuid) to authenticated, service_role;

-- As in 20261031000630_promo_undo_and_signed_rule.sql, and a deposit, progress or retainage invoice
-- of a job that already has a promo code's discount doesn't take another code.
create or replace function public.apply_promo_code(p_kind text, p_id uuid, p_code text, p_option uuid default null, p_selected uuid[] default null)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  q public.quotes; i public.invoices; p public.promo_codes; v_base numeric; v_option uuid;
begin
  if p_kind = 'quote' then
    select * into q from public.quotes where id = p_id for update;
    if not found then raise exception 'Quote not found' using errcode = 'P0002'; end if;
    if q.status not in ('draft', 'sent', 'changes_requested') then
      raise exception 'Promo codes can''t be added once a quote is approved.' using errcode = '22023';
    end if;
    if p_option is not null and not exists (select 1 from public.quote_options where quote_id = q.id and id = p_option) then
      raise exception 'The options on this estimate changed. Please look it over again.' using errcode = '22023';
    end if;
    -- A price agreed on site already has its discount in it (core sitePriceSet, which the API and the
    -- screens check first): its "Price adjustment" line on what counts, or, without options, the
    -- discount it set. A visit that kept the estimate's price set neither.
    if q.priced_on_site_at is not null and (
         exists (select 1 from public.quote_line_items l
                  where l.quote_id = q.id and l.name = 'Price adjustment' and l.service_id is null and coalesce(l.formula, '') = ''
                    and (l.option_id is null or l.option_id = q.option_id) and (not l.optional or l.selected))
         or (q.option_id is null and q.promo_code_id is null and q.discount_amount > 0)) then
      raise exception 'A price was set on site for this estimate, so a promo code can''t go on it too. Set the price back to the estimate''s first.'
        using errcode = '22023';
    end if;
    v_option := coalesce(p_option, q.option_id);
    -- The lines of an option that isn't shown are all unselected: its required ones count, and its
    -- add-ons only when they're picked.
    select coalesce(sum(round(quantity * unit_price, 2)) filter (where unit_price > 0 and case
             when p_selected is not null then not optional or id = any(p_selected)
             when option_id is not null and option_id is distinct from q.option_id then not optional
             else selected end), 0) into v_base
    from public.quote_line_items where quote_id = q.id and (option_id is null or option_id = v_option);
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
    if private.bank_payment_clearing(i.id) then
      raise exception 'A bank payment for this invoice is on its way, so its promo code can''t change until it clears.' using errcode = '22023';
    end if;
    if exists (select 1 from public.invoice_line_items l where l.invoice_id = i.id and l.discount_quote_id is not null) then
      raise exception 'This invoice already has a promo code''s discount, so another code can''t go on it.' using errcode = '22023';
    end if;
    -- These bill part of the job's contract, which has the job's promo discount in it already.
    if i.kind in ('deposit', 'progress', 'retainage') and private.invoice_job_has_promo(i.id) then
      raise exception 'This job already has a promo code''s discount, so another code can''t go on this invoice.' using errcode = '22023';
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

notify pgrst, 'reload schema';
