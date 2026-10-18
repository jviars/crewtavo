-- Database tests for drawings on quotes and invoices: a measurement attaches to an invoice of its own
-- company only, showing it on the quote and on the invoice are separate choices that don't follow it
-- somewhere new, and its map picture can only be one of that company's map pictures.
-- Run with scripts/test-db.sh (plain Postgres + prelude.sql). Any failed check stops with an error.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

create schema tmd;
grant usage on schema tmd to authenticated, service_role;
create function tmd.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL: %', p_what; end if;
  raise notice 'ok - %', p_what;
end $$;
create function tmd.expect_error(p_sql text, p_what text) returns void language plpgsql as $$
begin
  begin execute p_sql; exception when others then
    raise notice 'ok - % (%)', p_what, sqlerrm;
    return;
  end;
  raise exception 'FAIL (expected an error): %', p_what;
end $$;
grant execute on all functions in schema tmd to authenticated, service_role;

insert into auth.users (id, email, raw_user_meta_data) values
  ('e9300000-0000-0000-0000-000000000001', 'owner@sierra.test', '{"full_name": "Sam Sierra"}'),
  ('e9300000-0000-0000-0000-000000000002', 'owner@tango.test', '{"full_name": "Tess Tango"}');

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "e9300000-0000-0000-0000-000000000002", "role": "authenticated"}', true);
select public.create_company('Tango Lawn', 'lawn_care') as other \gset
insert into public.clients (company_id, display_name) values (:'other', 'Their Client') returning id as other_client \gset
insert into public.invoices (company_id, client_id) values (:'other', :'other_client') returning id as other_invoice \gset
commit;

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "e9300000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select public.create_company('Sierra Paving', 'paving') as co \gset
insert into public.clients (company_id, display_name) values (:'co', 'Pat Client') returning id as client \gset
insert into public.invoices (company_id, client_id) values (:'co', :'client') returning id as invoice \gset
insert into public.invoices (company_id, client_id) values (:'co', :'client') returning id as invoice2 \gset
insert into public.quotes (company_id, client_id, title) values (:'co', :'client', 'Driveway') returning id as quote \gset
insert into public.measurements (company_id, geojson) values (:'co', '{"type": "FeatureCollection", "features": []}') returning id as m \gset

update public.measurements set invoice_id = :'invoice', show_on_invoice = true, snapshot_path = :'co' || '/measurements/' || gen_random_uuid() || '.jpg', view = '{"center": [-79.87, 37.05], "zoom": 19}' where id = :'m';
select tmd.check((select invoice_id = :'invoice' and show_on_invoice and snapshot_path like :'co' || '/measurements/%' from public.measurements where id = :'m'), 'a drawing attaches to an invoice, shown to the client, and keeps its map picture');
update public.measurements set quote_id = :'quote' where id = :'m';
update public.measurements set show_on_quote = true where id = :'m';
update public.measurements set show_on_invoice = false where id = :'m';
select tmd.check((select show_on_quote and not show_on_invoice from public.measurements where id = :'m'), 'hiding it from the invoice leaves it on the quote');
update public.measurements set show_on_invoice = true where id = :'m';
update public.measurements set invoice_id = :'invoice2' where id = :'m';
select tmd.check((select invoice_id = :'invoice2' and not show_on_invoice and show_on_quote from public.measurements where id = :'m'), 'moved to another invoice, it is hidden there until someone shows it');
update public.measurements set invoice_id = :'invoice', show_on_invoice = true where id = :'m';
select tmd.check((select show_on_invoice from public.measurements where id = :'m'), 'unless the same change shows it');

select tmd.expect_error(format('update public.measurements set invoice_id = %L where id = %L', :'other_invoice', :'m'), 'not to another company''s invoice');
select tmd.expect_error(format('update public.measurements set snapshot_path = %L where id = %L', :'co' || '/receipts/' || gen_random_uuid() || '.jpg', :'m'), 'the picture is a map picture, never a receipt');
select tmd.expect_error(format('update public.measurements set snapshot_path = %L where id = %L', :'other' || '/measurements/' || gen_random_uuid() || '.jpg', :'m'), 'the picture is this company''s');
select tmd.expect_error(format('update public.measurements set snapshot_path = %L where id = %L', :'co' || '/measurements/../receipts/x.jpg', :'m'), 'no climbing out of the folder');
select tmd.expect_error(format('update public.measurements set view = %L where id = %L', '[1, 2]', :'m'), 'the view is an object');

delete from public.invoices where id = :'invoice';
select tmd.check((select invoice_id is null and not show_on_invoice and show_on_quote from public.measurements where id = :'m'), 'deleting the invoice keeps the drawing, no longer shown anywhere for it');
commit;

drop schema tmd cascade;
