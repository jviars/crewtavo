-- Contract sections, packages for every trade with a picture each, and quotes that offer 2-3 options.
--
-- Contract sections (contract_sections): the business's own contract wording, kept as a library in
-- Settings → Contract terms: payment, changes to the work, the warranty, the right to cancel and the
-- like. Each one prints above the signatures or on the terms pages after the estimate, and can ask
-- the customer to initial it. A template names the sections every estimate (or invoice) carries
-- (document_templates.settings sections and invoice_sections), a package adds its own, and a quote
-- can add more for one job. The office writes them, with the Settings area; estimators read them, as
-- they sign with the homeowner on the iPad.
--
-- Packages (roof_packages, roof_package_items) are every trade's packages now, not only roofs: a set
-- of services sold together, with a tier ("Good", "Better", "Best" or the business's own words), a
-- picture so the salesperson can tell them apart at a glance, a few highlights, the warranty and the
-- contract sections that come with it. The tables keep their names, because the app's queries name
-- their links.
--
-- Options (quote_options): a quote can offer 2-3 options, each a copy of the package it came from
-- (name, tier, picture, highlights, warranty, sections, as they were when it was offered) with lines
-- of its own. A line without an option is on every option. quotes.option_id is the option shown,
-- and once it's signed, the one chosen: its lines count and every other option's lines are left
-- unselected. So the totals, promo codes, turning a quote into a job and change orders, which all
-- count the selected lines, work as before, and the database keeps it that way whatever writes the
-- lines. Options are added, filled in, removed and copied by locked functions here
-- (apply_quote_options, remove_quote_option, duplicate_quote); the iPad signs through sign_quote and
-- the Client Hub through approve_hub_quote and accept_hub_range, which now take the option the
-- homeowner picked. Once signed, the approval (signature, initials, the contract as read) stays as
-- it was signed; the business only signs under it.

-- ---------------------------------------------------------------------------------------------
-- Contract sections
-- ---------------------------------------------------------------------------------------------

create table public.contract_sections (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  title text not null check (length(trim(title)) between 1 and 120),
  -- HTML from the contract editor (headings, bold, lists, tables); the browser cleans it whenever it
  -- shows it. Fill-ins like {Customer name} are filled in as it prints and frozen when it's signed.
  body text not null default '' check (length(body) <= 20000),
  -- 'signatures': above the signatures. 'terms': on the terms pages after the estimate.
  place text not null default 'terms' check (place in ('signatures', 'terms')),
  initials boolean not null default false,
  sort integer not null default 0,
  created_by uuid references auth.users (id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, id)
);
select private.add_touch_triggers(array['contract_sections']);

-- The office writes them, with the Settings area; estimators read them to sign on the iPad.
select private.apply_policies('contract_sections', '{owner,admin,office}', '{owner,admin,office,estimator}');
select private.restrict_area('contract_sections', 'settings', false);

comment on table public.contract_sections is 'The business''s contract wording, a section at a time, printed on its estimates and invoices.';
comment on column public.contract_sections.body is 'The section''s words as HTML, with fill-ins like {Customer name}; cleaned by the browser whenever it''s shown.';
comment on column public.contract_sections.place is '''signatures'': printed above the signatures. ''terms'': on the terms pages after the estimate.';
comment on column public.contract_sections.initials is 'The customer initials this section when they sign.';

-- ---------------------------------------------------------------------------------------------
-- Packages, for every trade
-- ---------------------------------------------------------------------------------------------

alter table public.roof_packages
  add column tier text check (tier is null or length(trim(tier)) between 1 and 40),
  add column picture text,
  add column picture_width integer,
  add column picture_height integer,
  add column highlights text[] not null default '{}',
  add column warranty text not null default '' check (length(warranty) <= 400),
  add column section_ids uuid[] not null default '{}',
  -- Stored by the server (PUT /api/packages/:id/picture) in the business's own folder, never reused.
  add constraint roof_packages_picture_check
    check (picture is null or picture ~ ('^' || company_id::text || '/packages/[0-9a-f-]{36}\.jpg$')),
  add constraint roof_packages_picture_size_check
    check ((picture is null) = (picture_width is null) and (picture is null) = (picture_height is null)
       and (picture is null or (picture_width between 1 and 4000 and picture_height between 1 and 4000))),
  add constraint roof_packages_highlights_check
    check (cardinality(highlights) <= 8 and array_position(highlights, null) is null and length(array_to_string(highlights, '')) <= 1200),
  add constraint roof_packages_section_ids_check check (cardinality(section_ids) <= 50);

comment on table public.roof_packages is 'Every trade''s packages (the name is from when they were only roofs): services sold together, with a tier, a picture, highlights, a warranty and contract sections.';
comment on column public.roof_packages.roof_service_id is 'The package''s main service (the roof itself, priced by the square, for roofing); optional in other trades.';
comment on column public.roof_packages.style is 'The drawing on its card when it has no picture: shingles, designer shingles, metal panels or plain.';
comment on column public.roof_packages.tier is 'Its tier: "Good", "Better", "Best" or the business''s own words.';
comment on column public.roof_packages.picture is 'Its picture, <company>/packages/<uuid>.jpg in the files bucket; never deleted, so quotes keep the picture they offered.';
comment on column public.roof_packages.highlights is 'A few short lines about it for the homeowner (up to 8).';
comment on column public.roof_packages.warranty is 'The warranty that comes with it, in a line.';
comment on column public.roof_packages.section_ids is 'The contract sections that come with it (contract_sections ids, in order).';

-- ---------------------------------------------------------------------------------------------
-- Options on a quote
-- ---------------------------------------------------------------------------------------------

create table public.quote_options (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  quote_id uuid not null,
  package_id uuid,
  -- A copy of the package as it was offered: changing or deleting the package doesn't change it.
  name text not null check (length(trim(name)) between 1 and 80),
  tier text check (tier is null or length(trim(tier)) between 1 and 40),
  picture text,
  picture_width integer,
  picture_height integer,
  style text not null default 'other' check (style in ('shingle', 'designer', 'metal', 'other')),
  highlights text[] not null default '{}',
  warranty text not null default '' check (length(warranty) <= 400),
  section_ids uuid[] not null default '{}',
  sort integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint quote_options_company_id_id_key unique (company_id, id),
  constraint quote_options_quote_id_id_key unique (quote_id, id),
  constraint quote_options_quote_fkey foreign key (company_id, quote_id)
    references public.quotes (company_id, id) on delete cascade,
  constraint quote_options_package_fkey foreign key (company_id, package_id)
    references public.roof_packages (company_id, id) on delete set null (package_id),
  constraint quote_options_picture_check
    check (picture is null or picture ~ ('^' || company_id::text || '/packages/[0-9a-f-]{36}\.jpg$')),
  constraint quote_options_picture_size_check
    check ((picture is null) = (picture_width is null) and (picture is null) = (picture_height is null)
       and (picture is null or (picture_width between 1 and 4000 and picture_height between 1 and 4000))),
  constraint quote_options_highlights_check
    check (cardinality(highlights) <= 8 and array_position(highlights, null) is null and length(array_to_string(highlights, '')) <= 1200),
  constraint quote_options_section_ids_check check (cardinality(section_ids) <= 50)
);
create index quote_options_package_idx on public.quote_options (package_id) where package_id is not null;
select private.add_touch_triggers(array['quote_options']);

-- Like the quote's lines: the people who sell read and write them, with the Sales area.
select private.apply_policies('quote_options', '{owner,admin,office,estimator}', '{owner,admin,office,estimator}');
select private.restrict_area('quote_options', 'sales', false);

-- A line on one option (null: on every option). The option is always one of this quote's.
alter table public.quote_line_items
  add column option_id uuid,
  add constraint quote_line_items_option_fkey foreign key (quote_id, option_id)
    references public.quote_options (quote_id, id) on delete cascade;
create index quote_line_items_option_idx on public.quote_line_items (quote_id, option_id);

-- The option shown, and the sections added for this job.
alter table public.quotes
  add column option_id uuid,
  add column section_ids uuid[] not null default '{}',
  add constraint quotes_option_fkey foreign key (id, option_id)
    references public.quote_options (quote_id, id) on delete set null (option_id),
  add constraint quotes_section_ids_check check (cardinality(section_ids) <= 50);

comment on table public.quote_options is 'The 2-3 options a quote offers, each a copy of the package it came from as it was offered. quotes.option_id is the one shown.';
comment on column public.quote_options.package_id is 'The package it was made from, while that package is there.';
comment on column public.quote_options.picture is 'The package''s picture when it was offered (<company>/packages/<uuid>.jpg).';
comment on column public.quote_options.section_ids is 'The contract sections that come with this option (contract_sections ids, in order).';
comment on column public.quote_line_items.option_id is 'The option this line is on; null when it''s on every option. Lines of an option that isn''t shown are never selected.';
comment on column public.quotes.option_id is 'The option shown (once signed, the one chosen); null when the quote offers no options. Only its lines and the shared ones count.';
comment on column public.quotes.section_ids is 'Contract sections added for this job only, on top of the template''s and the option''s.';
comment on column public.quotes.roof_package_id is 'The package its lines came from: the shown option''s package when it offers options.';

-- ---------------------------------------------------------------------------------------------
-- Only the shown option's lines count
-- ---------------------------------------------------------------------------------------------

-- Lines saved before this follow the same rule. The assistant wrote a group the client picks one of
-- ("Good", "Better" and "Best") as required lines with only the first selected, and every screen
-- counts a required line now, so the Client Hub would show (and send) all three. Each line of a
-- group becomes an add-on the client picks one of, keeping its pick, as the assistant writes them
-- now; any other required line that isn't selected becomes an add-on left unpicked. Nothing selected
-- changes, so no total does, and the quotes' totals aren't worked out again (a signed quote's would
-- be, with today's promo codes).
alter table public.quote_line_items disable trigger touch_quote;
update public.quote_line_items set optional = true where not optional and (option_group is not null or not selected);
alter table public.quote_line_items enable trigger touch_quote;

-- A line of an option that isn't shown is never selected; a required line on the shown option or on
-- every option always is: a required line always counts, as every screen shows it (core countsOn).
-- Add-ons keep their pick. (A group of lines the client picks one of, "Good", "Better" and "Best",
-- is a group of add-ons.) The shown option is read under the quote's lock, which quote_lines_guard
-- took first, so an option switch or an approval under way is waited for, not missed.
create function private.quote_option_line() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_shown uuid;
begin
  select option_id into v_shown from public.quotes where id = new.quote_id for no key update;
  if new.option_id is not null and new.option_id is distinct from v_shown then
    new.selected := false;
  elsif not new.optional then
    new.selected := true;
  end if;
  return new;
end $$;
create trigger option_line before insert or update of option_id, selected, optional on public.quote_line_items
  for each row execute function private.quote_option_line();

-- As in 20261018000800_review_fixes, and a line's quote is locked before the line is written: a line
-- written while the quote's shown option changes or it's approved (option_switch, approve_hub_quote,
-- sign_quote) waits for that to finish, then goes on the option as it's shown now (quote_option_line,
-- which runs after this), and can't land on a quote that was approved meanwhile. Every line write
-- locked its quote anyway, a moment later, to work out its totals (touch_quote), so this only takes
-- that lock sooner. Two quotes (a line moved between them) are locked in order.
create or replace function private.quote_lines_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'UPDATE' and old.service_id is not null and new.service_id is null
     and to_jsonb(new) - 'service_id' = to_jsonb(old) - 'service_id' then
    return new;
  end if;
  perform 1 from public.quotes q
   where q.id in (case when tg_op <> 'DELETE' then new.quote_id end, case when tg_op <> 'INSERT' then old.quote_id end)
   order by q.id
     for no key update;
  if (select auth.uid()) is not null and exists (
    select 1 from public.quotes q
    where q.id in (case when tg_op <> 'DELETE' then new.quote_id end, case when tg_op <> 'INSERT' then old.quote_id end)
      and q.status in ('approved', 'converted')
  ) then
    raise exception 'This quote was approved, so its line items can''t change. Make a change order or a new quote instead' using errcode = '22023';
  end if;
  return coalesce(new, old);
end $$;

-- The shown option changes in a statement of its own, so what runs as a quote's status changes (the
-- activity feed, a change order joining its job) always sees the chosen option's lines. Once the
-- quote is signed (or lost, or archived) only the server changes it. A quote with options always
-- shows one of them, and shows none again only once they're gone. The package follows the shown
-- option, and a price set on site was for the option it was set on, so it goes.
create function private.quote_option_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_gone boolean := old.option_id is not null and not exists (select 1 from public.quote_options where id = old.option_id);
begin
  if new.status is distinct from old.status then
    raise exception 'Pick the option first, then change the quote''s status.' using errcode = '22023';
  end if;
  if (select auth.uid()) is not null and old.option_id is not null and not v_gone then
    if new.status in ('approved', 'converted') then
      raise exception 'The option can''t change once the estimate is signed.' using errcode = '22023';
    elsif new.status in ('lost', 'archived') then
      raise exception 'Reopen this quote as a draft to change the option.' using errcode = '22023';
    end if;
  end if;
  if new.option_id is null and old.option_id is not null and not v_gone then
    raise exception 'A quote with options always shows one of them.' using errcode = '22023';
  end if;
  if new.option_id is not null then
    new.roof_package_id := (select o.package_id from public.quote_options o where o.id = new.option_id and o.quote_id = new.id);
  end if;
  -- From one option to another (or the shown one deleted while others stay). Turning a single
  -- estimate into its first option, or back, keeps the price: it's on the same lines.
  if old.option_id is not null and new.priced_on_site_at is not null
     and (new.option_id is not null or exists (select 1 from public.quote_options o where o.quote_id = new.id)) then
    new.priced_on_site_at := null;
  end if;
  return new;
end $$;
create trigger option_guard before update on public.quotes
  for each row when (old.option_id is distinct from new.option_id)
  execute function private.quote_option_guard();

-- The newly shown option's required lines count and its add-ons start unpicked; every other
-- option's lines stop counting. A price set on site goes with its "Price adjustment" lines
-- (estimates.ts SITE_ADJUSTMENT_NAME, written by setSitePrice).
create function private.quote_option_switch() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.option_id is not null then
    update public.quote_line_items
       set selected = (option_id = new.option_id and not optional)
     where quote_id = new.id and option_id is not null
       and selected is distinct from (option_id = new.option_id and not optional);
  end if;
  if old.priced_on_site_at is not null and new.priced_on_site_at is null then
    delete from public.quote_line_items
     where quote_id = new.id and name = 'Price adjustment' and service_id is null and formula is null;
  end if;
  return null;
end $$;
create trigger option_switch after update on public.quotes
  for each row when (old.option_id is distinct from new.option_id)
  execute function private.quote_option_switch();

-- A quote's first option is shown. When the shown one goes, the first of the others is (whichever
-- runs first, this or the foreign key clearing quotes.option_id).
--
-- A price set on site before there were options was for the estimate as it was, which becomes this
-- first option, so it stays with it. With options it's a "Price adjustment" line on the option it
-- was set on (setSitePrice), never a discount on the whole quote, which would come off every
-- option's price: its adjustment line moves onto this option, and a discount it set (a price below
-- the estimate) becomes "Price adjustment" lines there. A discount comes off the taxed and untaxed
-- work in proportion (private.quote_totals), so it's split the same way, a taxed line and an untaxed
-- one (as carry_quote_discount does for a job): the price agreed on site, tax and all, doesn't move.
-- A promo code's discount is the code's own and stays.
create function private.quote_option_added() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  q public.quotes;
  v_base numeric;
  v_base_taxable numeric;
  v_discount numeric;
  v_taxed numeric;
  v_sort integer;
begin
  update public.quotes set option_id = new.id where id = new.quote_id and option_id is null returning * into q;
  if found and q.priced_on_site_at is not null and q.status in ('draft', 'sent', 'changes_requested') then
    update public.quote_line_items set option_id = new.id
     where quote_id = q.id and option_id is null and name = 'Price adjustment' and service_id is null and formula is null;
    if q.promo_code_id is null and q.discount_amount > 0 then
      v_discount := least(q.discount_amount, greatest(q.subtotal, 0));
      select coalesce(sum(round(quantity * unit_price, 2)) filter (where unit_price > 0), 0),
             coalesce(sum(round(quantity * unit_price, 2)) filter (where taxable and unit_price > 0), 0),
             coalesce(max(sort) + 1, 0)
        into v_base, v_base_taxable, v_sort
        from public.quote_line_items where quote_id = q.id and selected;
      v_taxed := case when v_base > 0 then round(v_discount * v_base_taxable / v_base, 2) else v_discount end;
      insert into public.quote_line_items (company_id, quote_id, option_id, name, quantity, unit, unit_price, taxable, sort)
      select q.company_id, q.id, new.id, 'Price adjustment', 1, 'ea', -a.amount, a.taxable, v_sort + a.n
        from (values (v_taxed, true, 0), (v_discount - v_taxed, false, 1)) a(amount, taxable, n)
       where a.amount > 0;
      update public.quotes set discount_amount = 0 where id = q.id;
    end if;
  end if;
  return null;
end $$;
create trigger option_added after insert on public.quote_options
  for each row execute function private.quote_option_added();

create function private.quote_option_removed() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  update public.quotes q set option_id = n.id
    from (select (select o.id from public.quote_options o where o.quote_id = old.quote_id order by o.sort, o.id limit 1) as id) n
   where q.id = old.quote_id and (q.option_id is null or q.option_id = old.id) and q.option_id is distinct from n.id;
  return null;
end $$;
create trigger option_removed after delete on public.quote_options
  for each row execute function private.quote_option_removed();

-- The shown option's package is the quote's, even when the package goes (its foreign key clears
-- both) or an option is pointed at another one.
create function private.quote_option_package() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  update public.quotes set roof_package_id = new.package_id
   where id = new.quote_id and option_id = new.id and roof_package_id is distinct from new.package_id;
  return null;
end $$;
create trigger option_package after update on public.quote_options
  for each row when (old.package_id is distinct from new.package_id)
  execute function private.quote_option_package();

-- An option is on the quote it was made for, for good. The options of an approved quote are what
-- the client approved, as its lines are (private.quote_lines_guard), and a lost or archived quote's
-- stay as they were until it's reopened, as its shown option does (and as apply_quote_options and
-- remove_quote_option have it); only the server changes them. Deleting a package still clears it
-- from them (the foreign key's own action). A quote offers 3 options at most.
create function private.quote_options_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_status text;
begin
  if tg_op = 'UPDATE' and (new.quote_id is distinct from old.quote_id or new.company_id is distinct from old.company_id) then
    raise exception 'An option stays on the quote it was made for.' using errcode = '22023';
  end if;
  if tg_op = 'UPDATE' and old.package_id is not null and new.package_id is null
     and to_jsonb(new) - 'package_id' - 'updated_at' = to_jsonb(old) - 'package_id' - 'updated_at' then
    return new;
  end if;
  if (select auth.uid()) is not null then
    select q.status into v_status from public.quotes q where q.id = coalesce(new.quote_id, old.quote_id);
    if v_status in ('approved', 'converted') then
      raise exception 'This quote was approved, so its options can''t change. Make a change order or a new quote instead' using errcode = '22023';
    elsif v_status in ('lost', 'archived') then
      raise exception 'Reopen this quote as a draft to change its options.' using errcode = '22023';
    end if;
  end if;
  if tg_op = 'INSERT' then
    -- Two people adding options at once take turns here, so neither gets past 3.
    perform 1 from public.quotes where id = new.quote_id for no key update;
    if (select count(*) from public.quote_options where quote_id = new.quote_id) >= 3 then
      raise exception 'A quote offers up to 3 options.' using errcode = '22023';
    end if;
  end if;
  return coalesce(new, old);
end $$;
create trigger guard before insert or update or delete on public.quote_options
  for each row execute function private.quote_options_guard();

-- ---------------------------------------------------------------------------------------------
-- A signed quote keeps its approval
-- ---------------------------------------------------------------------------------------------

-- The approval is what the client signed: their name, signature and initials, the option they
-- chose and the contract as they read it. Once a quote is approved (or a job), nobody signed in
-- changes it or when it was approved; the business only signs under the client, once
-- (countersignQuote; an approval signed on the iPad without the business says "company": null).
-- A job isn't approved again either. The server's own functions approve only open quotes.
create function private.quote_approval_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_countersigned boolean := coalesce(
    old.approval ->> 'company' is null and jsonb_typeof(new.approval -> 'company') = 'object'
      and new.approval - 'company' = coalesce(old.approval, '{}') - 'company', false);
begin
  if (select auth.uid()) is null then
    return new;
  end if;
  if (old.status = 'converted' and new.status = 'approved') or new.approved_at is distinct from old.approved_at
     or (new.approval is distinct from old.approval and not v_countersigned) then
    raise exception 'This quote was already approved.' using errcode = '22023';
  end if;
  return new;
end $$;
create trigger approval_guard before update on public.quotes
  for each row when (old.status in ('approved', 'converted')
    and (old.approval is distinct from new.approval or old.approved_at is distinct from new.approved_at
         or (old.status = 'converted' and new.status = 'approved')))
  execute function private.quote_approval_guard();

-- ---------------------------------------------------------------------------------------------
-- Contract sections named on a package, an option or a quote are this business's
-- ---------------------------------------------------------------------------------------------

-- Ids of another business's sections (or of none) are left out, as are repeats; the order stays.
create function private.keep_company_sections() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.section_ids is null or cardinality(new.section_ids) = 0 then
    return new;
  end if;
  new.section_ids := coalesce((
    select array_agg(k.id order by k.n)
    from (select distinct on (x.id) x.id, x.n from unnest(new.section_ids) with ordinality as x(id, n) order by x.id, x.n) k
    where exists (select 1 from public.contract_sections s where s.company_id = new.company_id and s.id = k.id)
  ), '{}');
  return new;
end $$;
create trigger keep_sections before insert or update of section_ids, company_id on public.quotes
  for each row execute function private.keep_company_sections();
create trigger keep_sections before insert or update of section_ids, company_id on public.roof_packages
  for each row execute function private.keep_company_sections();
create trigger keep_sections before insert or update of section_ids, company_id on public.quote_options
  for each row execute function private.keep_company_sections();

-- A list of sections put together from two, as it's kept: each once, in order, 50 at most.
create function private.section_list(p_ids uuid[]) returns uuid[]
language sql immutable set search_path = '' as $$
  select (array(select k.id from (select distinct on (x.id) x.id, x.n from unnest(p_ids) with ordinality as x(id, n)
                                   where x.id is not null order by x.id, x.n) k
                order by k.n))[1:50]
$$;
revoke execute on function private.section_list(uuid[]) from public;
grant execute on function private.section_list(uuid[]) to authenticated;

-- ---------------------------------------------------------------------------------------------
-- Adding, filling in, removing and copying options (POST/DELETE /api/quotes/:id/options, "Copy as
-- new draft"). Each runs as the signed-in person, so their access applies, and locks the quote.
-- ---------------------------------------------------------------------------------------------

-- What the functions below share: a quote's options, in order, and putting lines on one of them.
create function private.quote_options_of(p_quote uuid)
returns jsonb language sql stable security invoker set search_path = '' as $$
  select coalesce(jsonb_agg(to_jsonb(o) order by o.sort, o.id), '[]') from public.quote_options o where o.quote_id = p_quote
$$;

create function private.insert_option_lines(p_company uuid, p_quote uuid, p_option uuid, p_lines jsonb)
returns void language sql security invoker set search_path = '' as $$
  insert into public.quote_line_items (company_id, quote_id, option_id, service_id, name, description, quantity, unit, unit_price,
                                       unit_cost, taxable, formula, sort, optional, selected)
  select p_company, p_quote, p_option, (l.value ->> 'service_id')::uuid, l.value ->> 'name', l.value ->> 'description',
         coalesce((l.value ->> 'quantity')::numeric, 1), coalesce(l.value ->> 'unit', 'ea'), coalesce((l.value ->> 'unit_price')::numeric, 0),
         (l.value ->> 'unit_cost')::numeric, coalesce((l.value ->> 'taxable')::boolean, true), l.value ->> 'formula',
         coalesce((l.value ->> 'sort')::integer, l.ordinality::integer - 1),
         coalesce((l.value ->> 'optional')::boolean, false), not coalesce((l.value ->> 'optional')::boolean, false)
    from jsonb_array_elements(coalesce(p_lines, '[]')) with ordinality l
$$;
revoke execute on function private.quote_options_of(uuid), private.insert_option_lines(uuid, uuid, uuid, jsonb) from public;
grant execute on function private.quote_options_of(uuid), private.insert_option_lines(uuid, uuid, uuid, jsonb) to authenticated;

/**
 * Puts options on an open quote and returns its options. Each of p_options is {package_id, name,
 * tier, picture, picture_width, picture_height, style, highlights, warranty, section_ids, sort,
 * lines: [{service_id, name, description, quantity, unit, unit_price, unit_cost, taxable, formula,
 * sort, optional}]} (the server works the lines out first, with core packageLines). p_mode:
 *   'add': adds them after the options it has. A quote with lines and no options first turns its
 *          estimate into option 1 (a copy of its package, or "Option 1"), keeping the lines in
 *          p_shared on every option, with a price set on site staying on option 1
 *          (private.quote_option_added). p_current {name, tier, sort}, each one optional, names
 *          that option, gives its tier (null for none) and places it among the new ones, for
 *          options ordered by their totals.
 *   'replace': starts over: every option and line goes, with the price set on site, the exact
 *          price sent and the discount (a promo code keeps its own).
 *   'fill': lines only, for options of this quote ({id, lines}) that have none yet (options made
 *          before the roof was measured), once each.
 * A single estimate carries its package's contract sections on the quote (put_quote_package); once
 * it offers options they're each option's own, so the package's come off the quote (option 1, when
 * the estimate becomes it, has them), and the sections added for the job by hand stay.
 */
create function public.apply_quote_options(p_quote uuid, p_options jsonb, p_mode text, p_shared uuid[] default '{}',
  p_current jsonb default null)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  q public.quotes;
  r record;
  v_option uuid;
  v_count integer;
  v_convert boolean := false;
  v_next integer;
  v_had boolean;
  v_package_sections uuid[];
begin
  if p_mode is null or p_mode not in ('add', 'replace', 'fill') then
    raise exception 'Options are added, replaced or filled in, not %.', coalesce(p_mode, 'nothing') using errcode = '22023';
  end if;
  if p_options is null or jsonb_typeof(p_options) <> 'array' then
    raise exception 'The options must be a list.' using errcode = '22023';
  end if;
  if p_current is not null and jsonb_typeof(p_current) <> 'object' then
    raise exception 'The estimate''s own option is {name, tier, sort}.' using errcode = '22023';
  end if;
  select * into q from public.quotes where id = p_quote for update;
  if not found then
    raise exception 'Quote not found' using errcode = 'P0002';
  end if;
  if q.status in ('approved', 'converted') then
    raise exception 'This quote was approved, so its options can''t change. Make a change order or a new quote instead' using errcode = '22023';
  elsif q.status not in ('draft', 'sent', 'changes_requested') then
    raise exception 'Reopen this quote as a draft to change its options.' using errcode = '22023';
  end if;

  if p_mode = 'fill' then
    for r in select o.value as o, x.id as option_id
               from jsonb_array_elements(p_options) with ordinality o
               join public.quote_options x on x.id = (o.value ->> 'id')::uuid and x.quote_id = p_quote
              order by o.ordinality
    loop
      -- Asked here, not in the loop's query, so an option named twice is filled in once.
      if not exists (select 1 from public.quote_line_items l where l.quote_id = p_quote and l.option_id = r.option_id) then
        perform private.insert_option_lines(q.company_id, q.id, r.option_id, r.o -> 'lines');
      end if;
    end loop;
    return private.quote_options_of(p_quote);
  end if;

  if jsonb_array_length(p_options) = 0 then
    raise exception 'Pick at least one package to offer.' using errcode = '22023';
  end if;

  -- A single estimate's package brought its sections onto the quote (with options, the quote's own
  -- sections are only the ones added for the job).
  v_had := exists (select 1 from public.quote_options where quote_id = p_quote);
  v_package_sections := case when v_had then '{}' else coalesce(
    (select p.section_ids from public.roof_packages p where p.id = q.roof_package_id and p.company_id = q.company_id), '{}') end;

  if p_mode = 'replace' then
    delete from public.quote_line_items where quote_id = p_quote;
    delete from public.quote_options where quote_id = p_quote;
    -- Starting over starts the price over too (as applyPackage does with replace).
    update public.quotes
       set priced_on_site_at = null, exact_sent_at = null,
           discount_amount = case when promo_code_id is null then 0 else discount_amount end
     where id = p_quote;
  end if;

  select count(*) into v_count from public.quote_options where quote_id = p_quote;
  v_convert := p_mode = 'add' and v_count = 0 and exists (select 1 from public.quote_line_items where quote_id = p_quote);
  if v_count + v_convert::integer + jsonb_array_length(p_options) > 3 then
    raise exception 'A quote offers up to 3 options.' using errcode = '22023';
  end if;

  if v_convert then
    -- The estimate as it is becomes option 1, ahead of the new ones.
    insert into public.quote_options (company_id, quote_id, package_id, name, tier, picture, picture_width, picture_height,
                                      style, highlights, warranty, section_ids, sort)
    select q.company_id, q.id, p.id, coalesce(nullif(trim(p_current ->> 'name'), ''), p.name, 'Option 1'),
           case when p_current ? 'tier' then nullif(trim(p_current ->> 'tier'), '') else p.tier end,
           p.picture, p.picture_width, p.picture_height,
           coalesce(p.style, 'other'), coalesce(p.highlights, '{}'), coalesce(p.warranty, ''), coalesce(p.section_ids, '{}'),
           coalesce((p_current ->> 'sort')::integer,
                    least(0, coalesce((select min((o ->> 'sort')::integer) from jsonb_array_elements(p_options) o), 1) - 1))
      from (select 1) one
      left join public.roof_packages p on p.id = q.roof_package_id and p.company_id = q.company_id
    returning id into v_option;
    update public.quote_line_items set option_id = v_option
     where quote_id = p_quote and option_id is null and not (id = any(coalesce(p_shared, '{}')));
  end if;
  -- The package's sections are the options' now (option 1's, when the estimate became it), so they
  -- don't print on every option; the ones added for the job stay, in order.
  update public.quotes
     set section_ids = array(select s from unnest(section_ids) with ordinality as u(s, n) where s <> all(v_package_sections) order by n)
   where id = p_quote and section_ids && v_package_sections;

  select coalesce(max(sort) + 1, 0) into v_next from public.quote_options where quote_id = p_quote;
  for r in select o.value as o, o.ordinality as n from jsonb_array_elements(p_options) with ordinality o loop
    insert into public.quote_options (company_id, quote_id, package_id, name, tier, picture, picture_width, picture_height,
                                      style, highlights, warranty, section_ids, sort)
    values (q.company_id, q.id, (r.o ->> 'package_id')::uuid, r.o ->> 'name', r.o ->> 'tier', r.o ->> 'picture',
            (r.o ->> 'picture_width')::integer, (r.o ->> 'picture_height')::integer, coalesce(r.o ->> 'style', 'other'),
            coalesce(array(select jsonb_array_elements_text(r.o -> 'highlights')), '{}'),
            coalesce(r.o ->> 'warranty', ''),
            coalesce(array(select jsonb_array_elements_text(r.o -> 'section_ids')::uuid), '{}'),
            coalesce((r.o ->> 'sort')::integer, v_next + r.n::integer - 1))
    returning id into v_option;
    perform private.insert_option_lines(q.company_id, q.id, v_option, r.o -> 'lines');
  end loop;
  return private.quote_options_of(p_quote);
end $$;

/**
 * Takes an option off an open quote, with its lines, and returns the options left. When one would
 * be left, the quote goes back to a single estimate: that option's lines and contract sections go
 * on it as they are (as a single estimate from its package has them) and the option itself goes.
 * Removing an option that's already gone changes nothing.
 */
create function public.remove_quote_option(p_quote uuid, p_option uuid)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  q public.quotes;
  v_count integer;
  v_left uuid;
  v_left_sections uuid[];
begin
  select * into q from public.quotes where id = p_quote for update;
  if not found then
    raise exception 'Quote not found' using errcode = 'P0002';
  end if;
  if q.status in ('approved', 'converted') then
    raise exception 'This quote was approved, so its options can''t change. Make a change order or a new quote instead' using errcode = '22023';
  elsif q.status not in ('draft', 'sent', 'changes_requested') then
    raise exception 'Reopen this quote as a draft to change its options.' using errcode = '22023';
  end if;
  if not exists (select 1 from public.quote_options where quote_id = p_quote and id = p_option) then
    return private.quote_options_of(p_quote);
  end if;
  select count(*) into v_count from public.quote_options where quote_id = p_quote;

  -- Its lines go with it, and when it was shown the first of the others is shown instead.
  delete from public.quote_options where quote_id = p_quote and id = p_option;

  if v_count = 1 then
    -- It was the only one: no package and no price set on site are left either. The price's
    -- adjustment went with the option's lines; one left on every option goes too. A discount
    -- here is the office's own (or a promo code's), off whichever option, and stays.
    if q.priced_on_site_at is not null then
      delete from public.quote_line_items
       where quote_id = p_quote and option_id is null and name = 'Price adjustment' and service_id is null and formula is null;
    end if;
    update public.quotes set roof_package_id = null, priced_on_site_at = null where id = p_quote;
  elsif v_count = 2 then
    -- Back to a single estimate: the one left (shown by now) hands its lines and its sections (after
    -- the ones added for the job) to the quote, then goes.
    select id, section_ids into v_left, v_left_sections from public.quote_options where quote_id = p_quote;
    update public.quote_line_items set option_id = null where quote_id = p_quote and option_id = v_left;
    update public.quotes set section_ids = private.section_list(section_ids || v_left_sections)
     where id = p_quote and not (section_ids @> v_left_sections);
    delete from public.quote_options where id = v_left;
  end if;
  return private.quote_options_of(p_quote);
end $$;

/**
 * "Copy as new draft": a new draft quote for the same client and property with the same title
 * (marked a copy), message, discount, tax rate, deposit, valid-until date (when it's still ahead),
 * package and contract sections, its options with new ids, and every line on the copy of its option.
 * The copy shows the option the original shows; add-ons start unpicked. Returns the new quote's id.
 */
create function public.duplicate_quote(p_quote uuid)
returns uuid language plpgsql security invoker set search_path = '' as $$
declare
  q public.quotes;
  o public.quote_options;
  v_new uuid;
  v_id uuid;
  v_map jsonb := '{}';
begin
  select * into q from public.quotes where id = p_quote;
  if not found then
    raise exception 'Quote not found' using errcode = 'P0002';
  end if;
  insert into public.quotes (company_id, client_id, property_id, title, message, discount_amount, tax_rate, deposit_amount,
                             valid_until, roof_package_id, section_ids)
  select q.company_id, q.client_id, q.property_id, q.title || ' (copy)', q.message, q.discount_amount, q.tax_rate, q.deposit_amount,
         case when q.valid_until > (now() at time zone c.timezone)::date then q.valid_until end, q.roof_package_id, q.section_ids
    from public.companies c where c.id = q.company_id
  returning id into v_new;

  for o in select * from public.quote_options where quote_id = p_quote order by sort, id loop
    insert into public.quote_options (company_id, quote_id, package_id, name, tier, picture, picture_width, picture_height,
                                      style, highlights, warranty, section_ids, sort)
    values (o.company_id, v_new, o.package_id, o.name, o.tier, o.picture, o.picture_width, o.picture_height,
            o.style, o.highlights, o.warranty, o.section_ids, o.sort)
    returning id into v_id;
    v_map := v_map || jsonb_build_object(o.id::text, v_id);
  end loop;
  if q.option_id is not null then
    update public.quotes set option_id = (v_map ->> q.option_id::text)::uuid
     where id = v_new and option_id is distinct from (v_map ->> q.option_id::text)::uuid;
  end if;

  insert into public.quote_line_items (company_id, quote_id, option_id, service_id, name, description, quantity, unit, unit_price,
                                       unit_cost, taxable, optional, selected, option_group, formula, sort, materials, material_cost)
  select l.company_id, v_new, (v_map ->> l.option_id::text)::uuid, l.service_id, l.name, l.description, l.quantity, l.unit, l.unit_price,
         l.unit_cost, l.taxable, l.optional, not l.optional, l.option_group, l.formula, l.sort, l.materials, l.material_cost
    from public.quote_line_items l where l.quote_id = p_quote
   order by l.sort;
  return v_new;
end $$;

/**
 * One package prices an open quote that offers no options, the classic single-package estimate
 * (POST /api/roofing/:id/package, and POST /api/quotes/:id/options with one package). The quote
 * remembers the package, and its contract sections come with it: the sections the package it had
 * before brought come off (unless this one brings them too), and the ones added for the job stay.
 * That's worked out here, from the locked quote, so a section the office ticks meanwhile isn't
 * lost. p_lines go on it, shared (lines as apply_quote_options takes them; none for a roof that
 * isn't measured yet). A quote that has lines keeps them and gets none, unless p_replace starts over
 * first, as apply_quote_options does: every option and line goes, with the price set on site, the
 * exact price sent and the discount (a promo code keeps its own). Returns whether p_lines went on.
 */
create function public.put_quote_package(p_quote uuid, p_package uuid, p_lines jsonb, p_replace boolean default false)
returns boolean language plpgsql security invoker set search_path = '' as $$
declare
  q public.quotes;
  v_had boolean;
  v_before uuid[];
  v_after uuid[];
begin
  if p_lines is not null and jsonb_typeof(p_lines) <> 'array' then
    raise exception 'The lines must be a list.' using errcode = '22023';
  end if;
  select * into q from public.quotes where id = p_quote for update;
  if not found then
    raise exception 'Quote not found' using errcode = 'P0002';
  end if;
  if q.status in ('approved', 'converted') then
    raise exception 'This quote was approved, so its lines can''t change. Make a change order or a new quote instead' using errcode = '22023';
  elsif q.status not in ('draft', 'sent', 'changes_requested') then
    raise exception 'Reopen this quote as a draft to change its lines.' using errcode = '22023';
  end if;

  v_had := exists (select 1 from public.quote_options where quote_id = p_quote);
  if p_replace then
    delete from public.quote_line_items where quote_id = p_quote;
    delete from public.quote_options where quote_id = p_quote;
    update public.quotes
       set priced_on_site_at = null, exact_sent_at = null,
           discount_amount = case when promo_code_id is null then 0 else discount_amount end
     where id = p_quote;
  elsif v_had then
    raise exception 'This estimate offers options; change them from the options bar.' using errcode = '22023';
  end if;

  -- With options, the package was the shown option's, and its sections were that option's.
  v_before := case when v_had then '{}' else coalesce(
    (select p.section_ids from public.roof_packages p where p.id = q.roof_package_id and p.company_id = q.company_id), '{}') end;
  v_after := coalesce((select p.section_ids from public.roof_packages p where p.id = p_package and p.company_id = q.company_id), '{}');
  update public.quotes
     set roof_package_id = p_package,
         section_ids = private.section_list(
           array(select s from unnest(section_ids) with ordinality as u(s, n) where s = any(v_after) or s <> all(v_before) order by n) || v_after)
   where id = p_quote;
  if exists (select 1 from public.quote_line_items where quote_id = p_quote) then
    return false;
  end if;
  perform private.insert_option_lines(q.company_id, q.id, null, p_lines);
  return true;
end $$;

/**
 * The homeowner signs on the salesperson's iPad (POST /api/quotes/:id/sign). The quote is locked
 * and signed only while it's open, still shows the option they chose (p_option; null, or left out,
 * for a quote without options) and still comes to the total they saw (p_expected_total, when
 * given). Then it's approved with p_approval plus the amounts, and the signer becomes its
 * salesperson if it had none. Returns the amounts, or null when any of that changed (the server
 * answers 409).
 */
create function public.sign_quote(p_quote uuid, p_approval jsonb, p_option uuid default null, p_expected_total numeric default null)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  q public.quotes;
  v_amounts jsonb;
begin
  select * into q from public.quotes
   where id = p_quote and status in ('draft', 'sent', 'changes_requested')
   for update;
  if not found or q.option_id is distinct from p_option or (p_expected_total is not null and q.total <> p_expected_total) then
    return null;
  end if;
  v_amounts := jsonb_build_object('subtotal', q.subtotal, 'discount_amount', q.discount_amount, 'tax_amount', q.tax_amount, 'total', q.total);
  update public.quotes
     set status = 'approved', approved_at = now(), salesperson_id = coalesce(salesperson_id, (select auth.uid())),
         approval = coalesce(p_approval, '{}') || v_amounts
   where id = p_quote;
  return v_amounts;
end $$;

revoke execute on function public.apply_quote_options(uuid, jsonb, text, uuid[], jsonb), public.remove_quote_option(uuid, uuid),
  public.duplicate_quote(uuid), public.put_quote_package(uuid, uuid, jsonb, boolean),
  public.sign_quote(uuid, jsonb, uuid, numeric) from public, anon;
grant execute on function public.apply_quote_options(uuid, jsonb, text, uuid[], jsonb), public.remove_quote_option(uuid, uuid),
  public.duplicate_quote(uuid), public.put_quote_package(uuid, uuid, jsonb, boolean),
  public.sign_quote(uuid, jsonb, uuid, numeric) to authenticated;

-- ---------------------------------------------------------------------------------------------
-- The Client Hub: approving with the option picked, and saying yes to a range with a favourite
-- ---------------------------------------------------------------------------------------------

-- As in 20261018000100_audit_fixes, and the code's minimum order can be checked against what the
-- client is choosing in the Client Hub (POST /hub/:token/promo), not only the option shown and the
-- add-ons saved: p_option is the option they picked (one of this quote's), and p_selected, when
-- given, the add-ons they picked among the shared lines and that option's. Its required lines count
-- either way. Without them it's measured as before. The office applies codes as before. A code
-- doesn't go on a price agreed on site, which has its discount in it already.
drop function public.apply_promo_code(text, uuid, text);
create function public.apply_promo_code(p_kind text, p_id uuid, p_code text, p_option uuid default null, p_selected uuid[] default null)
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
revoke execute on function public.apply_promo_code(text, uuid, text, uuid, uuid[]) from public, anon;
grant execute on function public.apply_promo_code(text, uuid, text, uuid, uuid[]) to authenticated, service_role;

-- As in 20261018000830_hub_approval, now with the option the client picked (required when the quote
-- offers options) and the total they saw. Inside the claim: the option is set first, on its own (its
-- lines count and the rest stop), then the add-ons they picked among the shared lines and that
-- option's, and only if the total still comes to what they saw is the quote approved. Otherwise
-- nothing changes and it answers false, like a quote that's no longer waiting. A promo code's
-- minimum order holds for what they chose (the code was checked against the option shown, or the
-- add-ons saved, when it went on): when their choices come to less, nothing changes and it raises
-- CX412 with a message for them (the server answers 409).
drop function public.approve_hub_quote(uuid, uuid, uuid[], jsonb);
create function public.approve_hub_quote(p_company uuid, p_quote uuid, p_selected uuid[], p_approval jsonb,
  p_option uuid default null, p_expected_total numeric default null)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  v_selected uuid[] := coalesce(p_selected, '{}');
  v_minimum numeric;
begin
  -- A second approval waits here for the first, then finds the quote approved and leaves it alone.
  perform 1 from public.quotes
   where company_id = p_company and id = p_quote and status in ('sent', 'changes_requested')
   for update;
  if not found then
    return false;
  end if;
  if p_option is not null and not exists (select 1 from public.quote_options where quote_id = p_quote and id = p_option) then
    return false;
  end if;
  if p_option is null and exists (select 1 from public.quote_options where quote_id = p_quote) then
    raise exception 'Pick one of the options first.' using errcode = '22023';
  end if;

  begin
    if p_option is not null then
      update public.quotes set option_id = p_option where id = p_quote and option_id is distinct from p_option;
    end if;
    -- Add-ons follow the client's choices; required lines stay selected.
    update public.quote_line_items set selected = (id = any(v_selected))
     where quote_id = p_quote and optional and (option_id is null or option_id = p_option)
       and selected is distinct from (id = any(v_selected));
    if p_expected_total is not null and (select total from public.quotes where id = p_quote) <> p_expected_total then
      raise exception 'The price changed.' using errcode = 'CX409';
    end if;
  exception when sqlstate 'CX409' then
    return false;
  end;

  select p.min_subtotal into v_minimum
    from public.quotes q join public.promo_codes p on p.id = q.promo_code_id
   where q.id = p_quote;
  if v_minimum > 0 and (select coalesce(sum(round(quantity * unit_price, 2)) filter (where selected and unit_price > 0), 0)
                          from public.quote_line_items where quote_id = p_quote) < v_minimum then
    raise exception 'That code needs an order of at least %. Remove the code, or change your choices.',
      to_char(v_minimum, 'FM$999,999,990.00') using errcode = 'CX412';
  end if;

  -- The lines re-ran the quote's totals, so these are the amounts with those choices: the approval
  -- shows the price that was agreed to.
  update public.quotes q
     set status = 'approved', approved_at = now(),
         approval = coalesce(p_approval, '{}') || jsonb_build_object(
           'subtotal', q.subtotal, 'discount_amount', q.discount_amount, 'tax_amount', q.tax_amount, 'total', q.total)
   where q.id = p_quote;
  return true;
end $$;
revoke execute on function public.approve_hub_quote(uuid, uuid, uuid[], jsonb, uuid, numeric) from public, anon, authenticated;
grant execute on function public.approve_hub_quote(uuid, uuid, uuid[], jsonb, uuid, numeric) to service_role;

-- As in 20261023001000_roofing_estimates, and the client can say which option they're leaning
-- toward: it becomes the one shown, and the office hears which.
drop function public.accept_hub_range(uuid, uuid);
create function public.accept_hub_range(p_company uuid, p_quote uuid, p_option uuid default null)
returns timestamptz language plpgsql security definer set search_path = '' as $$
declare
  q public.quotes;
  v_option text;
begin
  select * into q from public.quotes
   where company_id = p_company and id = p_quote and status in ('sent', 'changes_requested')
     and range_low is not null and range_accepted_at is null and priced_on_site_at is null and exact_sent_at is null
   for update;
  if not found then
    return null;
  end if;
  if p_option is not null then
    select name into v_option from public.quote_options where quote_id = p_quote and id = p_option;
    if not found then
      return null;
    end if;
  end if;
  update public.quotes set range_accepted_at = now(), option_id = coalesce(p_option, option_id) where id = p_quote;
  -- Following up on the quote ("any questions about it?") would ask what they've just answered.
  update public.automation_runs r
     set status = 'cancelled', finished_at = now(), error = 'The client said yes to the price range.'
    from public.automation_rules rule
   where rule.id = r.rule_id and rule.trigger = 'quote.sent'
     and r.company_id = p_company and r.subject_type = 'quote' and r.subject_id = p_quote and r.status = 'pending';
  perform private.emit(p_company, 'quote.range_accepted', 'quote', p_quote,
    format('%s said yes to %s to %s for quote #%s', private.client_name(q.client_id),
      private.money(q.range_low), private.money(q.range_high), q.number)
      || case when v_option is not null then format(', leaning toward %s', v_option) else '' end,
    jsonb_build_object('number', q.number, 'range_low', q.range_low, 'range_high', q.range_high)
      || case when v_option is not null then jsonb_build_object('option_id', p_option, 'option', v_option) else '{}' end);
  return now();
end $$;
revoke execute on function public.accept_hub_range(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.accept_hub_range(uuid, uuid, uuid) to service_role;

-- ---------------------------------------------------------------------------------------------
-- AI assistants with the Quotes area can change a quote's options too
-- ---------------------------------------------------------------------------------------------

/** The area a table's rows are in, for an assistant writing to it; null for every other table. */
create or replace function private.assistant_table_area(p_table text) returns text
language sql immutable set search_path = '' as $$
  select case p_table
    when 'clients' then 'clients'
    when 'client_contacts' then 'clients'
    when 'properties' then 'clients'
    when 'property_access' then 'clients'
    when 'requests' then 'records'
    when 'messages' then 'records'
    when 'jobs' then 'jobs'
    when 'job_line_items' then 'jobs'
    when 'visits' then 'schedule'
    when 'visit_assignees' then 'schedule'
    when 'visit_equipment' then 'schedule'
    when 'routes' then 'schedule'
    when 'time_entries' then 'time'
    when 'quotes' then 'quotes'
    when 'quote_line_items' then 'quotes'
    when 'quote_options' then 'quotes'
    when 'invoices' then 'invoices'
    when 'invoice_line_items' then 'invoices'
    when 'payments' then 'invoices'
    when 'pay_periods' then 'pay'
    when 'pay_period_lines' then 'pay'
    when 'companies' then 'company'
    when 'services' then 'prices'
    when 'crews' then 'crews'
    when 'crew_members' then 'crews'
    when 'checklist_templates' then 'checklists'
    when 'intake_forms' then 'booking'
    when 'sop_pages' then 'guides'
    when 'sop_categories' then 'guides'
    when 'automation_rules' then 'automations'
    when 'memberships' then 'team'
    when 'company_roles' then 'team'
  end
$$;

-- ---------------------------------------------------------------------------------------------
-- Turning a quote into a job
-- ---------------------------------------------------------------------------------------------

-- As in 20261017002500_change_orders_and_materials, but a quote that offers options becomes a job
-- only once it's approved, with the option the homeowner chose: before that, the option shown is
-- just the one the office looked at last, and its lines would be the job's by accident.
create or replace function public.convert_quote_to_job(p_quote uuid) returns uuid
language plpgsql security invoker set search_path = '' as $$
declare q public.quotes; v_job uuid; v_label text;
begin
  select * into q from public.quotes where id = p_quote for update;
  if not found then
    raise exception 'Quote not found' using errcode = 'P0002';
  end if;
  if q.status in ('converted', 'lost', 'archived') then
    raise exception 'This quote is already %', q.status using errcode = '22023';
  end if;
  if q.status <> 'approved' and exists (select 1 from public.quote_options where quote_id = q.id) then
    raise exception 'This estimate offers options. Mark it approved with the option they chose first.' using errcode = '22023';
  end if;
  if q.change_order_for is not null then
    return private.apply_change_order(q.id);
  end if;

  insert into public.jobs (company_id, client_id, property_id, quote_id, title, instructions)
  values (q.company_id, q.client_id, q.property_id, q.id, q.title, q.message)
  returning id into v_job;

  insert into public.job_line_items (company_id, job_id, service_id, name, description, quantity, unit, unit_price, unit_cost, taxable, sort)
  select company_id, v_job, service_id, name, description, quantity, unit, unit_price, unit_cost, taxable, sort
  from public.quote_line_items where quote_id = q.id and selected;
  select coalesce('Promo code ' || p.code, 'Discount') into v_label from public.promo_codes p where p.id = q.promo_code_id;
  perform private.carry_quote_discount(q.id, v_job, coalesce(v_label, 'Discount'));

  update public.quotes set status = 'converted', converted_at = now() where id = q.id;
  if q.request_id is not null then
    update public.requests set status = 'converted' where id = q.request_id;
  end if;
  update public.clients set status = 'active' where id = q.client_id and status = 'lead';
  return v_job;
end $$;

-- ---------------------------------------------------------------------------------------------
-- Pictures only the server writes
-- ---------------------------------------------------------------------------------------------

-- The business's logo, its own letterhead and its package pictures (<company>/logo, /letterhead
-- and /packages in the files bucket) are written only by the server, as the service role, once it
-- has checked they're the pictures they say they are (services/logo.ts, letterhead.ts and
-- packagePictures.ts), and the Client Hub shows them to anyone with a link (/api/public/...).
-- Quotes and signed copies keep pointing at them, so nobody signed in adds, replaces or deletes one
-- in those folders directly. Every other folder is as it was.
create policy files_server_pictures_insert on storage.objects as restrictive for insert to authenticated
  with check (bucket_id <> 'files' or split_part(name, '/', 2) not in ('logo', 'letterhead', 'packages'));
create policy files_server_pictures_update on storage.objects as restrictive for update to authenticated
  using (bucket_id <> 'files' or split_part(name, '/', 2) not in ('logo', 'letterhead', 'packages'))
  with check (bucket_id <> 'files' or split_part(name, '/', 2) not in ('logo', 'letterhead', 'packages'));
create policy files_server_pictures_delete on storage.objects as restrictive for delete to authenticated
  using (bucket_id <> 'files' or split_part(name, '/', 2) not in ('logo', 'letterhead', 'packages'));

-- Policies above that ask about membership check it once per query (20261018000990_policy_lookups).
select private.fold_member_checks();

notify pgrst, 'reload schema';
