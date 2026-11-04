-- Finding and merging duplicate clients.
--
--   * client_duplicates: pairs of clients who share an email (as private.email_key spells it), a
--     phone (private.phone_e164) or a property street with the same postal code, which is how
--     website and booking forms find a client (website_form_request, booking_form_client). Each says
--     why. A pair the office marks "not duplicates" (dismiss_client_duplicate) stops showing.
--   * client_merge_preview: what merging one client into another moves and fills in.
--   * merge_clients: moves everything on one client to the other in one transaction, fills in what
--     the kept client lacks, combines their tags, and deletes the empty client. Deleted, not
--     archived: nothing is left on it, and an archived copy would still be found by forms, searches
--     and client counts. The kept client's activity says who was merged in, with their email and phone.
--
-- Owners, admins and office staff with the invoices area only (private.has_role, private.has_perm):
-- a merge moves invoices and payments. Money stays as it was: an invoice's totals and a payment's
-- amount never change (merge_clients checks, and gives up if one would).

-- ---------------------------------------------------------------------------------------------
-- Pairs that aren't duplicates
-- ---------------------------------------------------------------------------------------------

-- The lower id first, so a pair is kept once. Read and written by the functions below only.
create table public.client_duplicate_dismissals (
  company_id uuid not null references public.companies (id) on delete cascade,
  client_a uuid not null,
  client_b uuid not null,
  dismissed_by uuid references auth.users (id) on delete set null,
  dismissed_at timestamptz not null default now(),
  primary key (company_id, client_a, client_b),
  check (client_a < client_b),
  foreign key (company_id, client_a) references public.clients (company_id, id) on delete cascade,
  foreign key (company_id, client_b) references public.clients (company_id, id) on delete cascade
);
create index client_duplicate_dismissals_b_idx on public.client_duplicate_dismissals (company_id, client_b);
alter table public.client_duplicate_dismissals enable row level security;

-- ---------------------------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------------------------

create function private.require_client_merging(p_company uuid) returns void
language plpgsql stable set search_path = '' as $$
begin
  if not (private.has_role(p_company, '{owner,admin,office}') and private.has_perm(p_company, 'invoices')) then
    raise exception 'Only the owner, admins and the office with invoices can find and merge duplicate clients' using errcode = '42501';
  end if;
end $$;

-- Whether merge_clients is moving p_from's records to p_into right now (any client's, for a null
-- p_from). The guards below let only that move through.
create function private.merging_clients(p_from uuid, p_into uuid) returns boolean
language sql stable set search_path = '' as $$
  select coalesce(coalesce(current_setting('crewtavo.merge', true), '') like coalesce(p_from::text, '%') || '>' || p_into::text, false)
$$;

-- The kept client k with what it lacks from m: email, phone, company, billing address, lead source,
-- payment terms, who referred them and custom field values; both clients' notes and tags; any
-- opt-out either gave; active if either is.
create function private.merged_client(k public.clients, m public.clients) returns public.clients
language plpgsql stable set search_path = '' as $$
begin
  if nullif(trim(k.email), '') is null then k.email := coalesce(nullif(trim(m.email), ''), k.email); end if;
  if nullif(trim(k.phone), '') is null then k.phone := coalesce(nullif(trim(m.phone), ''), k.phone); end if;
  if nullif(trim(k.company_name), '') is null then k.company_name := coalesce(nullif(trim(m.company_name), ''), k.company_name); end if;
  if nullif(trim(k.lead_source), '') is null then k.lead_source := coalesce(nullif(trim(m.lead_source), ''), k.lead_source); end if;
  if nullif(trim(k.billing_address ->> 'line1'), '') is null and nullif(trim(m.billing_address ->> 'line1'), '') is not null then
    k.billing_address := m.billing_address;
  end if;
  if nullif(trim(m.notes), '') is not null and trim(m.notes) is distinct from trim(k.notes) then
    k.notes := concat_ws(E'\n\n', nullif(trim(k.notes), ''), trim(m.notes));
  end if;
  k.payment_terms_days := coalesce(k.payment_terms_days, m.payment_terms_days);
  -- Never referred by themselves.
  k.referred_by := nullif(coalesce(nullif(k.referred_by, m.id), m.referred_by), k.id);
  k.tags := k.tags || array(select distinct t from unnest(m.tags) t where lower(t) <> all (select lower(x) from unnest(k.tags) x));
  k.custom_fields := m.custom_fields || coalesce((
    select jsonb_object_agg(e.key, e.value) from jsonb_each(k.custom_fields) e where e.value not in ('null', '""', '[]')), '{}');
  k.marketing_opt_out := k.marketing_opt_out or m.marketing_opt_out;
  k.review_opt_out := k.review_opt_out or m.review_opt_out;
  k.social_photos_opt_out := k.social_photos_opt_out or m.social_photos_opt_out;
  k.sms_opt_out_at := coalesce(k.sms_opt_out_at, m.sms_opt_out_at);
  if m.status = 'active' then k.status := 'active'; end if;
  return k;
end $$;

-- What's on a client, for the preview and the activity.
create function private.client_merge_counts(p_company uuid, p_client uuid) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'properties', (select count(*) from public.properties where company_id = p_company and client_id = p_client),
    'contacts', (select count(*) from public.client_contacts where company_id = p_company and client_id = p_client),
    'requests', (select count(*) from public.requests where company_id = p_company and client_id = p_client),
    'quotes', (select count(*) from public.quotes where company_id = p_company and client_id = p_client),
    'jobs', (select count(*) from public.jobs where company_id = p_company and client_id = p_client),
    'invoices', (select count(*) from public.invoices where company_id = p_company and client_id = p_client),
    'payments', (select count(*) from public.payments where company_id = p_company and client_id = p_client),
    'messages', (select count(*) from public.messages where company_id = p_company and client_id = p_client),
    'files', (select count(*) from public.attachments where company_id = p_company and owner_type = 'client' and owner_id = p_client),
    'cards', (select count(*) from public.client_payment_methods where company_id = p_company and client_id = p_client and status <> 'removed'),
    'reviews', (select count(*) from public.reviews where company_id = p_company and client_id = p_client and deleted_at is null),
    'referrals', (select count(*) from public.referrals where company_id = p_company and p_client in (referrer_client_id, referred_client_id))
  )
$$;

revoke all on function private.require_client_merging(uuid), private.merging_clients(uuid, uuid),
  private.merged_client(public.clients, public.clients), private.client_merge_counts(uuid, uuid) from public;

-- ---------------------------------------------------------------------------------------------
-- Finding duplicates
-- ---------------------------------------------------------------------------------------------

-- Pairs, newest first: reasons is [{kind: email | phone | address, value}], and clients the two of
-- them, to tell apart. A placeholder (.invalid) address or one that isn't a whole address matches
-- nothing, as on the forms.
create function public.client_duplicates(p_company uuid, p_limit integer default 200)
returns table (client_id uuid, other_id uuid, reasons jsonb, clients jsonb)
language plpgsql stable security definer set search_path = '' as $$
#variable_conflict use_column
begin
  perform private.require_client_merging(p_company);
  return query
  with keys as (
    select c.id, 'email' as kind, private.email_key(c.email) as key, trim(c.email) as shown
    from public.clients c
    where c.company_id = p_company and private.email_key(c.email) ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' and private.email_key(c.email) !~ '\.invalid$'
    union all
    select c.id, 'phone', private.phone_e164(c.phone), trim(c.phone)
    from public.clients c
    where c.company_id = p_company and private.phone_e164(c.phone) is not null
    union all
    select distinct on (a.client_id, a.key) a.client_id, 'address', a.key, a.shown
    from (
      select p.client_id, lower(trim(p.line1)) || ' ' || upper(regexp_replace(p.postal_code, '\s', '', 'g')) as key, trim(p.line1) || ', ' || trim(p.postal_code) as shown
      from public.properties p
      where p.company_id = p_company and trim(p.line1) <> '' and regexp_replace(coalesce(p.postal_code, ''), '\s', '', 'g') <> ''
    ) a
  ), pairs as (
    select a.id as a_id, b.id as b_id, jsonb_agg(jsonb_build_object('kind', a.kind, 'value', a.shown) order by a.kind, a.shown) as why
    from keys a join keys b on b.kind = a.kind and b.key = a.key and a.id < b.id
    group by a.id, b.id
  )
  select p.a_id, p.b_id, p.why, jsonb_build_array(
    jsonb_build_object('id', ca.id, 'display_name', ca.display_name, 'email', ca.email, 'phone', ca.phone, 'status', ca.status, 'created_at', ca.created_at),
    jsonb_build_object('id', cb.id, 'display_name', cb.display_name, 'email', cb.email, 'phone', cb.phone, 'status', cb.status, 'created_at', cb.created_at))
  from pairs p
  join public.clients ca on ca.id = p.a_id
  join public.clients cb on cb.id = p.b_id
  where not exists (select 1 from public.client_duplicate_dismissals d where d.company_id = p_company and d.client_a = p.a_id and d.client_b = p.b_id)
  order by greatest(ca.created_at, cb.created_at) desc, p.a_id, p.b_id
  limit least(greatest(coalesce(p_limit, 200), 1), 1000);
end $$;

create function public.dismiss_client_duplicate(p_company uuid, p_client uuid, p_other uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_client_merging(p_company);
  if p_client is null or p_other is null or p_client = p_other
     or (select count(*) from public.clients c where c.company_id = p_company and c.id in (p_client, p_other)) <> 2 then
    raise exception 'Those clients weren''t found' using errcode = 'P0002';
  end if;
  insert into public.client_duplicate_dismissals (company_id, client_a, client_b, dismissed_by)
  values (p_company, least(p_client, p_other), greatest(p_client, p_other), (select auth.uid()))
  on conflict do nothing;
end $$;

-- ---------------------------------------------------------------------------------------------
-- Merging
-- ---------------------------------------------------------------------------------------------

-- moves: what's on p_merge. fills: the kept client's details that come from it. fields: custom
-- field keys that come from it. tags: tags it adds. autopay_off: both have autopay, so p_merge's
-- agreement ends (the kept client's stays).
create function public.client_merge_preview(p_company uuid, p_keep uuid, p_merge uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  k public.clients;
  m public.clients;
  n public.clients;
begin
  perform private.require_client_merging(p_company);
  select * into k from public.clients c where c.company_id = p_company and c.id = p_keep;
  select * into m from public.clients c where c.company_id = p_company and c.id = p_merge;
  if k.id is null or m.id is null or k.id = m.id then
    raise exception 'Pick two different clients to merge' using errcode = 'P0002';
  end if;
  n := private.merged_client(k, m);
  return jsonb_build_object(
    'moves', private.client_merge_counts(p_company, p_merge),
    'fills', to_jsonb(array_remove(array[
      case when n.email is distinct from k.email then 'email' end,
      case when n.phone is distinct from k.phone then 'phone' end,
      case when n.company_name is distinct from k.company_name then 'company_name' end,
      case when n.billing_address is distinct from k.billing_address then 'billing_address' end,
      case when n.lead_source is distinct from k.lead_source then 'lead_source' end,
      case when n.notes is distinct from k.notes then 'notes' end,
      case when n.payment_terms_days is distinct from k.payment_terms_days then 'payment_terms_days' end], null)),
    'fields', (select coalesce(jsonb_agg(e.key order by e.key), '[]') from jsonb_each(n.custom_fields) e where (k.custom_fields -> e.key) is distinct from e.value),
    'tags', to_jsonb(array(select t from unnest(n.tags) t where t <> all (k.tags))),
    'autopay_off', exists (select 1 from public.autopay_authorizations a where a.client_id = p_merge and a.revoked_at is null)
      and exists (select 1 from public.autopay_authorizations a where a.client_id = p_keep and a.revoked_at is null)
  );
end $$;

-- Every table that refers to a client is moved here: by foreign key (properties, contacts,
-- requests, quotes, jobs, invoices, payments, messages and notes, campaign recipients and bookings,
-- review requests, reviews and the choices matching them, referrals both ways, referral asks,
-- inactive-client marks, cards, autopay agreements and charges, visit change requests, who referred
-- whom), and by id (files, activity, automation runs, links to QuickBooks or Stripe,
-- notifications' links). Records under those (visits, line items, plan files) come with them.
create function public.merge_clients(p_company uuid, p_keep uuid, p_merge uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  k public.clients;
  m public.clients;
  n public.clients;
  v_moved jsonb;
  v_totals jsonb;
  v_email_left boolean;
  v_phone_left boolean;
begin
  perform private.require_client_merging(p_company);
  if p_keep is null or p_merge is null or p_keep = p_merge then
    raise exception 'Pick two different clients to merge' using errcode = '22023';
  end if;
  -- Both locked, in one order, so nothing new lands on the one going while it moves.
  perform 1 from public.clients c where c.company_id = p_company and c.id in (p_keep, p_merge) order by c.id for update;
  select * into k from public.clients c where c.company_id = p_company and c.id = p_keep;
  select * into m from public.clients c where c.company_id = p_company and c.id = p_merge;
  if k.id is null or m.id is null then
    raise exception 'Those clients weren''t found' using errcode = 'P0002';
  end if;
  v_moved := private.client_merge_counts(p_company, p_merge);
  select coalesce(jsonb_object_agg(i.id, jsonb_build_array(i.subtotal, i.discount_amount, i.credit_amount, i.tax_amount, i.total, i.retainage_amount, i.amount_paid, i.balance_due)), '{}')
    into v_totals from public.invoices i where i.company_id = p_company and i.client_id = p_merge;
  perform set_config('crewtavo.merge', p_merge || '>' || p_keep, true);
  -- A referral credit isn't put on a moved invoice by the move (referral_credits_follow). Left on:
  -- that check runs at commit.
  perform set_config('crewtavo.referral_credits', 'on', true);

  n := private.merged_client(k, m);
  update public.clients c set
    email = n.email, phone = n.phone, company_name = n.company_name, billing_address = n.billing_address, lead_source = n.lead_source,
    notes = n.notes, tags = n.tags, custom_fields = n.custom_fields, marketing_opt_out = n.marketing_opt_out, review_opt_out = n.review_opt_out,
    social_photos_opt_out = n.social_photos_opt_out, sms_opt_out_at = n.sms_opt_out_at, referred_by = n.referred_by,
    payment_terms_days = n.payment_terms_days, status = n.status
  where c.id = p_keep;
  -- An email or phone the kept client has another of stays, as a contact who isn't sent anything.
  v_email_left := nullif(trim(m.email), '') is not null and private.email_key(m.email) is distinct from private.email_key(n.email);
  v_phone_left := nullif(trim(m.phone), '') is not null
    and coalesce(private.phone_e164(m.phone), trim(m.phone)) is distinct from coalesce(private.phone_e164(n.phone), trim(n.phone));
  if v_email_left or v_phone_left then
    insert into public.client_contacts (company_id, client_id, name, email, phone, notify_email, notify_sms)
    select p_company, p_keep, m.display_name, case when v_email_left then trim(m.email) end, case when v_phone_left then trim(m.phone) end, false, false
    where not exists (
      select 1 from public.client_contacts cc where cc.company_id = p_company and cc.client_id in (p_keep, p_merge)
        and (not v_email_left or private.email_key(cc.email) = private.email_key(m.email))
        and (not v_phone_left or coalesce(private.phone_e164(cc.phone), trim(cc.phone)) = coalesce(private.phone_e164(m.phone), trim(m.phone))));
  end if;

  update public.clients c set referred_by = p_keep where c.company_id = p_company and c.referred_by = p_merge and c.id <> p_keep;
  update public.client_contacts set client_id = p_keep where company_id = p_company and client_id = p_merge;
  update public.properties set client_id = p_keep where company_id = p_company and client_id = p_merge;
  update public.requests set client_id = p_keep where company_id = p_company and client_id = p_merge;
  update public.quotes set client_id = p_keep where company_id = p_company and client_id = p_merge;
  update public.jobs set client_id = p_keep where company_id = p_company and client_id = p_merge;
  -- Invoices before their payments: a payment is always its invoice's client's (payment_client_guard).
  update public.invoices set client_id = p_keep where company_id = p_company and client_id = p_merge;
  update public.payments set client_id = p_keep where company_id = p_company and client_id = p_merge;
  update public.messages set client_id = p_keep where company_id = p_company and client_id = p_merge;
  update public.campaign_recipients set client_id = p_keep where company_id = p_company and client_id = p_merge;
  update public.campaign_bookings set client_id = p_keep where company_id = p_company and client_id = p_merge;
  update public.review_requests set client_id = p_keep where company_id = p_company and client_id = p_merge;
  update public.reviews set client_id = p_keep where company_id = p_company and client_id = p_merge;
  update public.review_match_choices set client_id = p_keep where company_id = p_company and client_id = p_merge;
  update public.referral_asks set client_id = p_keep where company_id = p_company and client_id = p_merge;
  update public.visit_change_requests set client_id = p_keep where company_id = p_company and client_id = p_merge;
  update public.autopay_charges set client_id = p_keep where company_id = p_company and client_id = p_merge;
  update public.referrals set referrer_client_id = p_keep where company_id = p_company and referrer_client_id = p_merge;
  update public.referrals set referred_client_id = p_keep where company_id = p_company and referred_client_id = p_merge;
  -- A referral between the two is now the client's own: it earns nothing.
  update public.referrals set reward_status = 'none', no_reward_reason = 'self'
  where company_id = p_company and referrer_client_id = p_keep and referred_client_id = p_keep and reward_status = 'pending';
  -- One mark per rule and last visit: the kept client's stays.
  delete from public.inactive_client_marks x where x.company_id = p_company and x.client_id = p_merge
    and exists (select 1 from public.inactive_client_marks y where y.client_id = p_keep and y.rule_id = x.rule_id and y.last_visit_at = x.last_visit_at);
  update public.inactive_client_marks set client_id = p_keep where company_id = p_company and client_id = p_merge;
  -- One default card: the kept client's stays the default. Each card keeps its own Stripe customer.
  update public.client_payment_methods set is_default = false
  where company_id = p_company and client_id = p_merge and is_default
    and exists (select 1 from public.client_payment_methods y where y.client_id = p_keep and y.is_default and y.status <> 'removed');
  update public.client_payment_methods set client_id = p_keep where company_id = p_company and client_id = p_merge;
  -- One agreement in force: the kept client's stays; the other's ends as replaced (its charges go on).
  update public.autopay_authorizations set revoked_at = now(), revoked_via = 'replaced', revoked_by = (select auth.uid())
  where company_id = p_company and client_id = p_merge and revoked_at is null
    and exists (select 1 from public.autopay_authorizations y where y.client_id = p_keep and y.revoked_at is null);
  update public.autopay_authorizations set client_id = p_keep where company_id = p_company and client_id = p_merge;

  -- By id: files (still stored under the old client's folder), history, automations, apps' links
  -- (one per app: the kept client's stays), and notifications that link to the client.
  update public.attachments set owner_id = p_keep where company_id = p_company and owner_type = 'client' and owner_id = p_merge;
  update public.activity set subject_id = p_keep where company_id = p_company and subject_type = 'client' and subject_id = p_merge;
  update public.automation_runs set subject_id = p_keep where company_id = p_company and subject_type = 'client' and subject_id = p_merge;
  delete from public.sync_links x where x.company_id = p_company and x.entity = 'client' and x.local_id = p_merge
    and exists (select 1 from public.sync_links y where y.company_id = p_company and y.provider = x.provider and y.entity = 'client' and y.local_id = p_keep);
  update public.sync_links set local_id = p_keep where company_id = p_company and entity = 'client' and local_id = p_merge;
  update public.notifications set link = replace(link, p_merge::text, p_keep::text) where company_id = p_company and link like '%' || p_merge || '%';
  -- Clients the merged one was marked "not duplicates" of aren't the kept one's either.
  insert into public.client_duplicate_dismissals (company_id, client_a, client_b, dismissed_by, dismissed_at)
  select p_company, least(p_keep, o.id), greatest(p_keep, o.id), d.dismissed_by, d.dismissed_at
  from public.client_duplicate_dismissals d
  cross join lateral (select case when d.client_a = p_merge then d.client_b else d.client_a end as id) o
  where d.company_id = p_company and p_merge in (d.client_a, d.client_b) and o.id <> p_keep
  on conflict do nothing;

  if exists (
    select 1 from public.invoices i
    where i.company_id = p_company and v_totals ? i.id::text
      and jsonb_build_array(i.subtotal, i.discount_amount, i.credit_amount, i.tax_amount, i.total, i.retainage_amount, i.amount_paid, i.balance_due) <> v_totals -> i.id::text
  ) then
    raise exception 'Merging would change an invoice''s totals, so nothing was merged. Open the invoices of %, save them, then try again', m.display_name
      using errcode = '22023';
  end if;

  delete from public.clients c where c.id = p_merge;
  perform set_config('crewtavo.merge', '', true);
  perform private.emit(p_company, 'client.merged', 'client', p_keep, format('%s merged into %s', m.display_name, k.display_name),
    jsonb_build_object('merged_id', p_merge, 'merged_name', m.display_name, 'merged_email', m.email, 'merged_phone', m.phone, 'moved', v_moved));
  return jsonb_build_object('client_id', p_keep, 'moved', v_moved);
end $$;

revoke execute on function public.client_duplicates(uuid, integer), public.dismiss_client_duplicate(uuid, uuid, uuid),
  public.client_merge_preview(uuid, uuid, uuid), public.merge_clients(uuid, uuid, uuid) from public, anon;
grant execute on function public.client_duplicates(uuid, integer), public.dismiss_client_duplicate(uuid, uuid, uuid),
  public.client_merge_preview(uuid, uuid, uuid), public.merge_clients(uuid, uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------------------------
-- The guards that let a merge's moves through, and only those
-- ---------------------------------------------------------------------------------------------

-- As in 20261018000600_payment_integrity.sql, except a merge moves an invoice with its payments.
create or replace function private.invoice_client_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.client_id is distinct from old.client_id and not private.merging_clients(old.client_id, new.client_id)
     and exists (select 1 from public.payments where invoice_id = new.id) then
    raise exception 'This invoice has payments, so its client can''t change' using errcode = '22023';
  end if;
  return new;
end $$;

-- As in 20261104000200_client_billing_late_fees.sql, except a merge leaves a moved quote's or
-- invoice's tax and due date as they were: its totals don't change.
create or replace function private.client_billing() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  c public.clients;
  v_terms integer;
begin
  if tg_op = 'UPDATE' then
    if new.client_id is not distinct from old.client_id and new.tax_rate is not distinct from old.tax_rate then return new; end if;
    if private.merging_clients(old.client_id, new.client_id) then return new; end if;
  end if;
  select * into c from public.clients where id = new.client_id;
  if not found then return new; end if;
  -- Due when the client's terms say, when it was given the business's due date (made in Crewtavo,
  -- not brought in from Stripe with Stripe's).
  if tg_op = 'INSERT' and tg_table_name = 'invoices' and c.payment_terms_days is not null then
    if new.job_id is not null or (select auth.uid()) is not null then
      select coalesce((settings ->> 'payment_terms_days')::integer, 30) into v_terms from public.companies where id = new.company_id;
      if new.due_on = new.issued_on + v_terms then
        new.due_on := new.issued_on + c.payment_terms_days;
      end if;
    end if;
  end if;
  if c.tax_exempt then
    new.tax_rate := 0;
  end if;
  return new;
end $$;

-- As in 20261101000100_autopay.sql, except a merge moves an agreement, as it was made, to the
-- client it's kept with.
create or replace function private.autopay_authorization_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_moving text[] := case when private.merging_clients(old.client_id, new.client_id) then array['client_id'] else '{}' end;
begin
  if to_jsonb(new) - (array['paused_at', 'paused_by', 'resumed_at', 'revoked_at', 'revoked_by', 'revoked_via', 'updated_at'] || v_moving)
     is distinct from to_jsonb(old) - (array['paused_at', 'paused_by', 'resumed_at', 'revoked_at', 'revoked_by', 'revoked_via', 'updated_at'] || v_moving) then
    raise exception 'An agreement is kept as it was made. It can only be paused or turned off' using errcode = '42501';
  end if;
  if old.revoked_at is not null and to_jsonb(new) - (array['updated_at'] || v_moving) is distinct from to_jsonb(old) - (array['updated_at'] || v_moving) then
    raise exception 'An agreement that was turned off stays off' using errcode = '22023';
  end if;
  return new;
end $$;

-- As in 20261019002000_assistant_more_areas.sql, except an assistant's merge moves a refund too.
create or replace function private.assistant_payment_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if private.assistant_client() is null then return coalesce(new, old); end if;
  if tg_op = 'UPDATE' and private.merging_clients(old.client_id, new.client_id) and to_jsonb(new) - 'client_id' = to_jsonb(old) - 'client_id' then
    return new;
  end if;
  if tg_op = 'DELETE' then
    raise exception 'An AI assistant can''t delete a payment. Do it in Crewtavo itself.' using errcode = '42501';
  end if;
  if new.amount < 0 then
    raise exception 'An AI assistant can''t record a refund. Do it in Crewtavo itself.' using errcode = '42501';
  end if;
  return new;
end $$;

-- As in 20261030000300_review_reminders.sql, except a merge keeps a text opt-out the merged client gave.
create or replace function private.client_sms_opt_out_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if (select auth.role()) = 'authenticated' and not (tg_op = 'UPDATE' and private.merging_clients(null, new.id)) then
    if tg_op = 'UPDATE' then
      new.sms_opt_out_at := old.sms_opt_out_at;
    else
      new.sms_opt_out_at := null;
    end if;
  end if;
  return new;
end $$;

-- An AI assistant merges clients as a change to invoices and payments, which a merge moves (as in
-- 20261105000200_weather_rules.sql, with that one added).
create or replace function private.assistant_rpc_area(p_function text) returns text
language sql immutable set search_path = '' as $$
  select case p_function
    when 'convert_quote_to_job' then 'quotes'
    when 'create_invoice_for_job' then 'invoices'
    when 'merge_clients' then 'invoices'
    when 'set_checklist_services' then 'checklists'
    when 'set_weather_rules' then 'prices'
  end
$$;

notify pgrst, 'reload schema';
