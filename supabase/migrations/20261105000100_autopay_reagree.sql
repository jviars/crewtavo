-- Agreeing again to autopay's terms in the Client Hub, for monthly plans.
--
-- A client whose agreement was made before the starter terms mentioned a monthly plan has each of
-- their plan's monthly charges wait for the office's OK (autopay_bill, "Their autopay terms don't
-- mention a monthly plan"). Their Client Hub asks them to agree to the terms as they are now, with
-- the card they have (services/autopay.ts hubAutopay, reagree). The starter terms changed words but
-- kept their version (starter-<trade>-1), so agreeing to the same card at the same version used to
-- keep the old agreement: now it's kept only when its words are today's too, and otherwise replaced
-- by one with today's words (a card change does the same). A monthly charge waiting for its OK for
-- that reason alone goes ahead then, checked again as any charge is.

-- As in 20261101000100_autopay.sql, plus: the same card and version with other words is agreed
-- again, and a monthly charge that waited only for the words goes ahead.
create or replace function public.autopay_record_authorization(p_company uuid, p_client uuid, p_payment_method uuid,
  p_source text, p_terms_version text, p_ip text default null, p_user_agent text default null,
  p_link_kind text default null, p_link_via text default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  m public.client_payment_methods;
  v_live public.autopay_authorizations;
  v_last public.autopay_authorizations;
  v_id uuid;
begin
  if p_source is null or p_source not in ('hub', 'confirmed') then
    raise exception 'Say how the client agreed' using errcode = '22023';
  end if;
  if not exists (select 1 from public.companies c where c.id = p_company and private.autopay_of(c.settings) -> 'enabled' = 'true'::jsonb) then
    raise exception 'Autopay is turned off' using errcode = '22023';
  end if;
  if p_terms_version is distinct from private.autopay_terms_version(p_company) then
    raise exception 'The terms changed. Read them again and agree' using errcode = '22023';
  end if;
  select * into m from public.client_payment_methods
  where id = p_payment_method and company_id = p_company and client_id = p_client and status in ('active', 'pending');
  if not found then
    raise exception 'That card isn''t saved anymore' using errcode = 'P0002';
  end if;

  -- One at a time for a client, so two taps don't both replace the agreement.
  perform pg_advisory_xact_lock(hashtextextended('autopay-agreement:' || p_client::text, 0));
  select * into v_last from public.autopay_authorizations
  where company_id = p_company and client_id = p_client order by accepted_at desc, created_at desc limit 1;
  if v_last.revoked_via in ('client', 'office') and v_last.revoked_at > m.created_at then
    raise exception 'Add your card again to turn autopay back on' using errcode = '22023';
  end if;

  select * into v_live from public.autopay_authorizations
  where company_id = p_company and client_id = p_client and revoked_at is null for update;
  if found then
    -- The words too: the starter terms changed without a new version.
    if v_live.payment_method_id = m.id and v_live.terms_version = p_terms_version and v_live.terms = private.autopay_terms_shown(p_company) then
      return v_live.id;
    end if;
    update public.autopay_authorizations set revoked_at = now(), revoked_via = 'replaced' where id = v_live.id;
  end if;

  -- The card agreed to is the client's default (here, and only here, for a client with an agreement).
  update public.client_payment_methods set is_default = false
  where client_id = p_client and company_id = p_company and is_default and id <> m.id;
  update public.client_payment_methods set is_default = true where id = m.id and not is_default;

  insert into public.autopay_authorizations (company_id, client_id, payment_method_id, terms, terms_version, ip, user_agent,
    source, link_kind, link_via, paused_at, paused_by, resumed_at)
  values (p_company, p_client, m.id, private.autopay_terms_shown(p_company), p_terms_version, left(p_ip, 100), left(p_user_agent, 500),
    p_source, p_link_kind, p_link_via, v_live.paused_at, v_live.paused_by, v_live.resumed_at)
  returning id into v_id;

  -- Words that mention a monthly plan now: a month that waited only for them is billed (and checked) again.
  if private.autopay_covers_monthly(private.autopay_terms_shown(p_company)) and private.autopay_ready(p_company, p_client) is not null then
    update public.autopay_charges
    set status = 'waiting', due_at = now(), last_error = null
    where company_id = p_company and client_id = p_client and bill = 'month' and status = 'needs_approval' and approved_at is null
      and last_error = 'Their autopay terms don''t mention a monthly plan';
  end if;
  return v_id;
end $$;

notify pgrst, 'reload schema';
