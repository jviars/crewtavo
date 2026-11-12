-- Database tests for progress billing on a job that's only partly taxed
-- (20261112000430_progress_tax_share): a progress invoice taxes the job's taxable share of what it
-- bills, the final invoice credits it the way it was taxed, and together the job's invoices charge
-- the tax the job owes. A fully taxable job comes out as it always did, a progress invoice made
-- before stays as it was made, and the job's later invoices don't tax what it already taxed.
-- Run with scripts/test-db.sh (plain Postgres + prelude.sql). Any failed check stops with an error.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

create schema pts;
grant usage on schema pts to authenticated, service_role;
create function pts.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL: %', p_what; end if;
  raise notice 'ok - %', p_what;
end $$;
-- An invoice's subtotal/tax/total.
create function pts.figures(p_invoice uuid) returns text language sql stable as $$
  select subtotal || '/' || tax_amount || '/' || total from public.invoices where id = p_invoice
$$;
-- An invoice's lines in order: "name price taxed|untaxed".
create function pts.lines(p_invoice uuid) returns text language sql stable as $$
  select string_agg(name || ' ' || unit_price || case when taxable then ' taxed' else ' untaxed' end, ', ' order by sort, id)
    from public.invoice_line_items where invoice_id = p_invoice
$$;
-- An approved quote at 10% tax with untaxed labour and taxed materials, as a job.
create function pts.job(p_company uuid, p_client uuid, p_title text, p_labour numeric, p_materials numeric) returns uuid
language plpgsql as $$
declare v_quote uuid;
begin
  insert into public.quotes (company_id, client_id, title, tax_rate) values (p_company, p_client, p_title, 0.10) returning id into v_quote;
  if p_labour > 0 then
    insert into public.quote_line_items (company_id, quote_id, name, quantity, unit_price, taxable) values (p_company, v_quote, 'Labour', 1, p_labour, false);
  end if;
  if p_materials > 0 then
    insert into public.quote_line_items (company_id, quote_id, name, quantity, unit_price, taxable, sort) values (p_company, v_quote, 'Materials', 1, p_materials, true, 1);
  end if;
  update public.quotes set status = 'approved', approved_at = now() where id = v_quote;
  return public.convert_quote_to_job(v_quote);
end $$;
grant execute on all functions in schema pts to authenticated, service_role;

-- Flo owns Fern Fencing; Gus is her client.
insert into auth.users (id, email, raw_user_meta_data) values
  ('d3430000-0000-0000-0000-000000000001', 'flo@fern-fencing.test', '{"full_name": "Flo Fern"}');

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "d3430000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select public.create_company('Fern Fencing', 'general') as co \gset
insert into public.clients (company_id, display_name) values (:'co', 'Gus Gable') returning id as gus \gset

-- ===== A partly taxed job: $1,000 of untaxed labour and $100 of taxed materials at 10% ===========
-- The whole job owes $10.00 of tax. Half the contract in progress billing used to charge $50.00.
select pts.job(:'co', :'gus', 'Cedar fence', 1000, 100) as fence \gset
select public.create_invoice_for_job(:'fence', 'progress', 500) as fence_progress \gset
-- 100 of the 1,100 is taxable, so 45.45 of the 500 is.
select pts.check(pts.figures(:'fence_progress') = '500.00/4.55/504.55', 'progress billing on a partly taxed job taxes the job''s taxable share of it');
select pts.check(pts.lines(:'fence_progress') = 'Progress billing: Cedar fence 45.45 taxed, Progress billing: Cedar fence 454.55 untaxed',
  'as a taxed line and an untaxed line that come to what was billed');
select pts.check((select string_agg(description, ' | ' order by sort) from public.invoice_line_items where invoice_id = :'fence_progress')
  = 'Taxed part of 45.5% of the $1,100.00 contract | Untaxed part of 45.5% of the $1,100.00 contract', 'each saying which part it is');
select pts.check((select pay_app_number = 1 and retainage_amount = 0 from public.invoices where id = :'fence_progress'), 'it''s still one pay application');

select public.create_invoice_for_job(:'fence') as fence_final \gset
select pts.check((select string_agg(left(name, 13) || ' ' || unit_price || case when taxable then ' taxed' else ' untaxed' end, ', ' order by sort) from public.invoice_line_items where invoice_id = :'fence_final')
  = 'Labour 1000.00 untaxed, Materials 100.00 taxed, Less progress -45.45 taxed, Less progress -454.55 untaxed', 'the final invoice credits it the way it was taxed');
-- Each invoice rounds its own tax to the cent, as invoices always have.
select pts.check(pts.figures(:'fence_final') = '600.00/5.46/605.46', 'and taxes the taxable work that''s left');
select pts.check((select abs(sum(tax_amount) - 10.00) <= 0.01 and sum(subtotal) = 1100 from public.invoices where job_id = :'fence'),
  'together the job''s invoices charge the tax the job owes, to the cent each one rounds');

-- ===== A deposit and two progress invoices =======================================================
select pts.job(:'co', :'gus', 'Gate', 600, 400) as gate \gset
select public.create_invoice_for_job(:'gate', 'deposit', 100) as gate_deposit \gset
select public.create_invoice_for_job(:'gate', 'progress', 250) as gate_p1 \gset
select public.create_invoice_for_job(:'gate', 'progress', 300) as gate_p2 \gset
select pts.check(pts.figures(:'gate_deposit') = '100.00/0.00/100.00' and pts.figures(:'gate_p1') = '250.00/10.00/260.00' and pts.figures(:'gate_p2') = '300.00/12.00/312.00',
  'each progress invoice taxes its share (40% of the job is taxable); a deposit is untaxed as before');
select pts.check((select pay_app_number from public.invoices where id = :'gate_p2') = 2, 'pay applications still count up');
select public.create_invoice_for_job(:'gate') as gate_final \gset
-- 400 taxable less the 100 and 120 already taxed is 180.
select pts.check(pts.figures(:'gate_final') = '350.00/18.00/368.00', 'the final invoice taxes what''s left of the taxable work');
select pts.check((select sum(tax_amount) = 40 and sum(subtotal) = 1000 from public.invoices where job_id = :'gate'), 'and the job''s invoices charge exactly the job''s tax');

-- ===== A job with a discount ====================================================================
-- 1,000 taxed and 500 untaxed with 300 off: 800 of the 1,200 contract is taxable (tax 80).
insert into public.quotes (company_id, client_id, title, tax_rate, discount_amount) values (:'co', :'gus', 'Arbor', 0.10, 300) returning id as arbor_quote \gset
insert into public.quote_line_items (company_id, quote_id, name, quantity, unit_price, taxable) values
  (:'co', :'arbor_quote', 'Cedar', 1, 1000, true), (:'co', :'arbor_quote', 'Labour', 1, 500, false);
select public.convert_quote_to_job(:'arbor_quote') as arbor \gset
select public.create_invoice_for_job(:'arbor', 'progress', 600) as arbor_progress \gset
select pts.check(pts.figures(:'arbor_progress') = '600.00/40.00/640.00', 'the taxable share counts the job''s discount');
select public.create_invoice_for_job(:'arbor') as arbor_final \gset
select pts.check(pts.figures(:'arbor_final') = '600.00/40.00/640.00'
  and (select total from public.quotes where id = :'arbor_quote') = 1280, 'and the invoices come to the approved quote');

-- ===== A fully taxable job comes out as it always did ==========================================
select pts.job(:'co', :'gus', 'Deck', 0, 1000) as deck \gset
select public.create_invoice_for_job(:'deck', 'progress', 250) as deck_progress \gset
select pts.check(pts.figures(:'deck_progress') = '250.00/25.00/275.00' and pts.lines(:'deck_progress') = 'Progress billing: Deck 250.00 taxed'
  and (select description from public.invoice_line_items where invoice_id = :'deck_progress') = '25.0% of the $1,000.00 contract',
  'a fully taxable job''s progress invoice is one taxed line, as before');
select public.create_invoice_for_job(:'deck') as deck_final \gset
select pts.check(pts.figures(:'deck_final') = '750.00/75.00/825.00'
  and (select string_agg(name || ' ' || unit_price || case when taxable then ' taxed' else ' untaxed' end || coalesce(' ' || description, '') || ' ' || sort, ', ' order by sort)
         from public.invoice_line_items where invoice_id = :'deck_final' and unit_price < 0)
      = 'Less progress billing (invoice #' || (select number from public.invoices where id = :'deck_progress') || ') -250.00 taxed 200001',
  'and its final invoice credits it as one taxed line, as before');

-- ===== A job with nothing taxable isn't taxed on progress billing ===============================
-- It used to be: $50.00 of tax on a job that owes none, which the final invoice never gave back.
select pts.job(:'co', :'gus', 'Labour only', 1000, 0) as labour \gset
select public.create_invoice_for_job(:'labour', 'progress', 500) as labour_progress \gset
select pts.check(pts.figures(:'labour_progress') = '500.00/0.00/500.00' and pts.lines(:'labour_progress') = 'Progress billing: Labour only 500.00 untaxed',
  'progress billing on a job with nothing taxable has no tax');
select public.create_invoice_for_job(:'labour') as labour_final \gset
select pts.check(pts.figures(:'labour_final') = '500.00/0.00/500.00' and (select sum(tax_amount) = 0 from public.invoices where job_id = :'labour'), 'nor does its final invoice');

-- ===== A progress invoice made before the change ===============================================
-- Made the old way, as one fully taxed line: the client was charged $50.00 of tax on the fence job
-- that owes $10.00. It stays as it was made (an owner reviews those with
-- docs/queries/progress-invoice-tax-review.sql).
select pts.job(:'co', :'gus', 'Old fence', 1000, 100) as old \gset
select public.create_invoice_for_job(:'old', 'progress', 500) as old_progress \gset
delete from public.invoice_line_items where invoice_id = :'old_progress' and not taxable;
update public.invoice_line_items set unit_price = 500 where invoice_id = :'old_progress';
update public.invoices set status = 'sent' where id = :'old_progress';
select pts.check(pts.figures(:'old_progress') = '500.00/50.00/550.00', 'a progress invoice made before is fully taxed');
-- The job's taxable 100 is already taxed five times over, so nothing more of it is.
select public.create_invoice_for_job(:'old', 'progress', 300) as old_p2 \gset
select pts.check(pts.figures(:'old_p2') = '300.00/0.00/300.00', 'the job''s next progress invoice doesn''t tax what was already taxed');
select public.create_invoice_for_job(:'old') as old_final \gset
select pts.check((select string_agg(left(name, 13) || ' ' || unit_price || case when taxable then ' taxed' else ' untaxed' end, ', ' order by sort) from public.invoice_line_items where invoice_id = :'old_final' and unit_price < 0)
  = 'Less progress -500.00 taxed, Less progress -300.00 untaxed', 'the final invoice credits each as it was taxed');
select pts.check(pts.figures(:'old_final') = '300.00/0.00/300.00' and pts.figures(:'old_progress') = '500.00/50.00/550.00',
  'and the invoice made before is left as it was');

-- A partly taxed job with room left: the old invoice taxed 600 of the 800 taxable, so 200 is left.
insert into public.quotes (company_id, client_id, title, tax_rate, discount_amount) values (:'co', :'gus', 'Old arbor', 0.10, 300) returning id as oa_quote \gset
insert into public.quote_line_items (company_id, quote_id, name, quantity, unit_price, taxable) values
  (:'co', :'oa_quote', 'Cedar', 1, 1000, true), (:'co', :'oa_quote', 'Labour', 1, 500, false);
select public.convert_quote_to_job(:'oa_quote') as oa \gset
select public.create_invoice_for_job(:'oa', 'progress', 600) as oa_p1 \gset
delete from public.invoice_line_items where invoice_id = :'oa_p1' and not taxable;
update public.invoice_line_items set unit_price = 600 where invoice_id = :'oa_p1';
-- 450 more: its share would be 300 taxable, but only 200 of the job's taxable work is left.
select public.create_invoice_for_job(:'oa', 'progress', 450) as oa_p2 \gset
select pts.check(pts.figures(:'oa_p1') = '600.00/60.00/660.00' and pts.figures(:'oa_p2') = '450.00/20.00/470.00', 'a later progress invoice taxes no more than the taxable work that''s left');
select public.create_invoice_for_job(:'oa') as oa_final \gset
select pts.check((select sum(tax_amount) = 80 and sum(subtotal) = 1200 from public.invoices where job_id = :'oa'), 'so the job''s invoices still charge the job''s tax');
commit;

\echo 'All progress tax share tests passed.'
