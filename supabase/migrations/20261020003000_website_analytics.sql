-- Website analytics (Apps → Crewtavo - Website Analytics): the business's own website counts its
-- visits with a small script its Crewtavo serves (/v.js, apps/api/src/routes/analytics.ts), with no
-- cookies and nothing kept that could tell who a visitor is, the way Plausible counts:
--
--   * A visitor is a hash of their address, their browser and a salt that changes every day (the
--     business's own day). Addresses and browsers are never stored, and salts are deleted soon after
--     their day ends, so nobody, Crewtavo included, can later work out who a visitor was or follow
--     anyone from one day to the next. The same person on two days counts as two visitors.
--   * public.web_hits keeps each page view for two days at most: long enough to tell which page and
--     source brought in a booking request (web_visit_for). web_rollup, run every hour, counts each
--     finished day into public.web_daily (per page, source, campaign and device) and deletes its
--     page views: that's the retention rule for raw hits.
--   * Page views count only while the app is installed (settings.website_analytics.enabled).
--     Uninstalling stops counting at once and keeps every number.
--   * Marketing shows them (web_stats): owners, admins and office staff with Marketing.
--   * A booking-form request remembers the visit that brought it in (requests.web_visit), for
--     Marketing's pages and sources and Metrics' lead sources.

create table public.web_hits (
  id bigint generated always as identity primary key,
  company_id uuid not null references public.companies (id) on delete cascade,
  at timestamptz not null default now(),
  -- The business's own day, in its time zone.
  day date not null,
  -- private.web_visitor: changes every day, and can't be turned back into an address.
  visitor text not null,
  path text not null check (length(path) between 1 and 300),
  -- The first page of a visit: nothing from this visitor in the last 30 minutes, or they came back
  -- from somewhere else. Only entries say where the visit came from.
  entry boolean not null,
  source text check (length(source) <= 100),
  channel text check (channel in ('search', 'ads', 'social', 'ai', 'directory', 'email', 'campaign', 'referral', 'direct')),
  campaign text check (length(campaign) <= 100),
  -- The other website's name (www.yelp.com), never the whole address.
  referrer text check (length(referrer) <= 255),
  device text not null check (device in ('phone', 'tablet', 'computer'))
);
create index web_hits_visitor_idx on public.web_hits (company_id, visitor, at desc);
create index web_hits_day_idx on public.web_hits (company_id, day);

comment on table public.web_hits is 'Website page views from the last two days, read only through web_stats and web_visit_for, then counted into web_daily.';

-- Only the server's functions read and write page views.
alter table public.web_hits enable row level security;
revoke all on public.web_hits from anon, authenticated;

create table public.web_daily (
  company_id uuid not null references public.companies (id) on delete cascade,
  day date not null,
  -- total: the whole site (key ''); page: a path; source: where visits came from (sub: its channel);
  -- campaign: utm_campaign; device: phone, tablet or computer.
  kind text not null check (kind in ('total', 'page', 'source', 'campaign', 'device')),
  key text not null,
  sub text not null default '',
  -- Different people that day (each day's visitors are new, see above).
  visitors integer not null default 0,
  pageviews integer not null default 0,
  -- Visits that started here (a page's landings, a source's visits).
  visits integer not null default 0,
  primary key (company_id, day, kind, key, sub)
);

comment on table public.web_daily is 'Website visits counted per day: the whole site, each page, source, campaign and device.';

alter table public.web_daily enable row level security;
revoke insert, update, delete on public.web_daily from authenticated;
create policy web_daily_read on public.web_daily for select to authenticated
  using (private.has_role(company_id, '{owner,admin,office}') and private.has_perm(company_id, 'marketing'));

alter table public.requests add column web_visit jsonb;
comment on column public.requests.web_visit is 'The website visit that brought in a booking-form request: landing_page, page, source, channel, campaign, referrer, device, visited_at.';

-- ---------------------------------------------------------------------------------------------
-- Visitors
-- ---------------------------------------------------------------------------------------------

create table private.web_salts (
  day date primary key,
  salt bytea not null
);
revoke all on private.web_salts from public;

-- A day's salt, made the first time it's needed (32 random bytes).
create function private.web_salt(p_day date) returns bytea
language plpgsql security definer set search_path = '' as $$
declare
  v_salt bytea;
begin
  select salt into v_salt from private.web_salts where day = p_day;
  if v_salt is null then
    insert into private.web_salts (day, salt)
    values (p_day, decode(replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''), 'hex'))
    on conflict (day) do nothing;
    select salt into v_salt from private.web_salts where day = p_day;
  end if;
  return v_salt;
end $$;

-- A visitor on one day: their address and browser, hashed with that day's salt. Null when the
-- day's salt is gone (or, without p_create, was never made).
create function private.web_visitor(p_company uuid, p_day date, p_ip text, p_agent text, p_create boolean default true) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_salt bytea := case when p_create then private.web_salt(p_day) else (select salt from private.web_salts where day = p_day) end;
begin
  if v_salt is null then return null; end if;
  return left(encode(sha256(v_salt || convert_to(p_company::text || '|' || coalesce(p_ip, '') || '|' || coalesce(p_agent, ''), 'UTF8')), 'hex'), 32);
end $$;

revoke all on function private.web_salt(date), private.web_visitor(uuid, date, text, text, boolean) from public;

-- ---------------------------------------------------------------------------------------------
-- Counting a page view (the API's POST /v, after it filtered out bots)
-- ---------------------------------------------------------------------------------------------

-- p_site: the business's slug from the script's line, or null on a server with one business.
-- p_host and p_path: the page's. p_source, p_channel, p_campaign and p_referrer: where the visitor
-- came from, when the page says (packages/core/src/analytics.ts); null for a page within the site.
-- False when it wasn't counted: no such business, the app isn't installed, or another site.
create function public.web_record_hit(
  p_ip text, p_agent text, p_host text, p_path text, p_device text,
  p_site text default null, p_source text default null, p_channel text default null, p_campaign text default null, p_referrer text default null
) returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  v_company uuid;
  v_tz text;
  v_settings jsonb;
  v_site text;
  v_host text := lower(regexp_replace(coalesce(p_host, ''), '^www\.', ''));
  v_day date;
  v_visitor text;
  v_entry boolean;
begin
  select c.id, c.timezone, c.settings -> 'website_analytics' into v_company, v_tz, v_settings
  from public.companies c
  where case when p_site is null then (select count(*) from public.companies) = 1 else c.slug = p_site end;
  if v_company is null or v_settings -> 'enabled' is distinct from 'true'::jsonb then return false; end if;

  -- Once the website's address is known, only its pages count (www. or not, and its subdomains):
  -- a copy of the site somewhere else doesn't add to the numbers.
  v_site := lower(regexp_replace(coalesce(v_settings ->> 'host', ''), '^www\.', ''));
  if v_site <> '' and v_host <> v_site and right(v_host, length(v_site) + 1) <> '.' || v_site then return false; end if;

  v_day := (now() at time zone v_tz)::date;
  v_visitor := private.web_visitor(v_company, v_day, p_ip, p_agent);
  v_entry := not exists (
      select 1 from public.web_hits h
      where h.company_id = v_company and h.visitor = v_visitor and h.at > now() - interval '30 minutes'
    )
    or (p_source is not null and p_source is distinct from (
      select h.source from public.web_hits h
      where h.company_id = v_company and h.visitor = v_visitor and h.entry
      order by h.at desc, h.id desc limit 1
    ));

  insert into public.web_hits (company_id, day, visitor, path, entry, source, channel, campaign, referrer, device)
  values (
    v_company, v_day, v_visitor, left(p_path, 300), v_entry,
    case when v_entry then left(coalesce(p_source, 'Direct'), 100) end,
    case when v_entry then coalesce(p_channel, 'direct') end,
    case when v_entry then left(p_campaign, 100) end,
    case when v_entry then left(p_referrer, 255) end,
    p_device
  );
  return true;
end $$;

-- The visit a booking request came from: the visitor's latest page in the last six hours, and the
-- page their visit started on and where from. Null when there's none, or the app isn't installed.
create function public.web_visit_for(p_company uuid, p_ip text, p_agent text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_tz text;
  v_today date;
  v_visitors text[];
  v_last public.web_hits;
  v_entry public.web_hits;
begin
  select c.timezone into v_tz from public.companies c
  where c.id = p_company and c.settings -> 'website_analytics' -> 'enabled' = 'true'::jsonb;
  if v_tz is null then return null; end if;
  v_today := (now() at time zone v_tz)::date;
  -- Yesterday's too, for someone who booked just after midnight.
  v_visitors := array_remove(array[
    private.web_visitor(p_company, v_today, p_ip, p_agent, false),
    private.web_visitor(p_company, v_today - 1, p_ip, p_agent, false)
  ], null);
  if cardinality(v_visitors) = 0 then return null; end if;

  select * into v_last from public.web_hits h
  where h.company_id = p_company and h.visitor = any (v_visitors) and h.at > now() - interval '6 hours'
  order by h.at desc, h.id desc limit 1;
  if v_last.id is null then return null; end if;
  select * into v_entry from public.web_hits h
  where h.company_id = p_company and h.visitor = v_last.visitor and h.entry and h.at <= v_last.at
  order by h.at desc, h.id desc limit 1;

  return jsonb_strip_nulls(jsonb_build_object(
    'landing_page', coalesce(v_entry.path, v_last.path),
    'page', v_last.path,
    'source', coalesce(v_entry.source, 'Direct'),
    'channel', coalesce(v_entry.channel, 'direct'),
    'campaign', v_entry.campaign,
    'referrer', v_entry.referrer,
    'device', v_last.device,
    'visited_at', coalesce(v_entry.at, v_last.at)
  ));
end $$;

-- ---------------------------------------------------------------------------------------------
-- Counts: per day, page, source, campaign and device
-- ---------------------------------------------------------------------------------------------

-- The page views still waiting to be rolled up, counted the way web_daily holds them.
create function private.web_counts(p_company uuid, p_from date, p_to date)
returns table (day date, kind text, key text, sub text, visitors integer, pageviews integer, visits integer)
language sql stable security definer set search_path = '' as $$
  with hits as (select * from public.web_hits h where h.company_id = p_company and h.day between p_from and p_to)
  select h.day, 'total', '', '', count(distinct h.visitor)::integer, count(*)::integer, (count(*) filter (where h.entry))::integer
  from hits h group by h.day
  union all
  select h.day, 'page', h.path, '', count(distinct h.visitor)::integer, count(*)::integer, (count(*) filter (where h.entry))::integer
  from hits h group by h.day, h.path
  union all
  select h.day, 'source', h.source, h.channel, count(distinct h.visitor)::integer, 0, count(*)::integer
  from hits h where h.entry group by h.day, h.source, h.channel
  union all
  select h.day, 'campaign', h.campaign, '', count(distinct h.visitor)::integer, 0, count(*)::integer
  from hits h where h.entry and h.campaign is not null group by h.day, h.campaign
  union all
  select h.day, 'device', h.device, '', count(distinct h.visitor)::integer, count(*)::integer, (count(*) filter (where h.entry))::integer
  from hits h group by h.day, h.device
$$;
revoke all on function private.web_counts(uuid, date, date) from public;

-- Every hour: count each business's finished days (before yesterday, its time) into web_daily and
-- delete their page views, then the salts of days that are over.
create function public.web_rollup() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  r record;
  v_days integer := 0;
  v_hits integer := 0;
  v_gone integer;
begin
  -- One at a time, should two servers run it together.
  perform pg_advisory_xact_lock(hashtext('crewtavo.web_rollup'));
  for r in
    select h.company_id, h.day
    from public.web_hits h join public.companies c on c.id = h.company_id
    where h.day < (now() at time zone c.timezone)::date - 1
    group by h.company_id, h.day
  loop
    insert into public.web_daily as d (company_id, day, kind, key, sub, visitors, pageviews, visits)
    select r.company_id, n.day, n.kind, n.key, n.sub, n.visitors, n.pageviews, n.visits
    from private.web_counts(r.company_id, r.day, r.day) n
    on conflict (company_id, day, kind, key, sub) do update
      set visitors = d.visitors + excluded.visitors, pageviews = d.pageviews + excluded.pageviews, visits = d.visits + excluded.visits;
    delete from public.web_hits where company_id = r.company_id and day = r.day;
    get diagnostics v_gone = row_count;
    v_days := v_days + 1;
    v_hits := v_hits + v_gone;
  end loop;
  -- Yesterday's salt (UTC) stays for bookings just after midnight; older ones go.
  delete from private.web_salts where day < (now() at time zone 'UTC')::date - 1;
  return jsonb_build_object('days', v_days, 'hits', v_hits);
end $$;

-- Marketing's Website section: each day's totals for the range and the one before it (for "vs the
-- previous period"), and the range's pages, sources, campaigns and devices, with the booking
-- requests each brought in.
create function public.web_stats(p_company uuid, p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_tz text;
  v_prev date := p_from - (p_to - p_from + 1);
begin
  if not (private.has_role(p_company, '{owner,admin,office}') and private.has_perm(p_company, 'marketing')) then
    raise exception 'Only people with Marketing see website visits' using errcode = '42501';
  end if;
  if p_to < p_from or p_to - p_from > 1100 then
    raise exception 'Pick a range of up to three years' using errcode = '22023';
  end if;
  select c.timezone into v_tz from public.companies c where c.id = p_company;

  return (
    with counts as (
      select d.day, d.kind, d.key, d.sub, d.visitors, d.pageviews, d.visits
      from public.web_daily d where d.company_id = p_company and d.day between v_prev and p_to
      union all
      select * from private.web_counts(p_company, v_prev, p_to)
    ),
    shown as (select * from counts where day >= p_from),
    asked as (
      select (r.created_at at time zone v_tz)::date as day, r.web_visit as v
      from public.requests r
      where r.company_id = p_company and r.web_visit is not null
        and r.created_at >= (v_prev::timestamp at time zone v_tz) and r.created_at < ((p_to + 1)::timestamp at time zone v_tz)
    ),
    asked_now as (select * from asked where day >= p_from)
    select jsonb_build_object(
      'days', coalesce((
        select jsonb_agg(jsonb_build_object('day', t.day, 'visitors', t.visitors, 'pageviews', t.pageviews, 'visits', t.visits, 'requests', t.requests) order by t.day)
        from (
          select x.day, sum(x.visitors)::integer as visitors, sum(x.pageviews)::integer as pageviews, sum(x.visits)::integer as visits, sum(x.requests)::integer as requests
          from (
            select c.day, c.visitors, c.pageviews, c.visits, 0 as requests from counts c where c.kind = 'total'
            union all
            select a.day, 0, 0, 0, 1 from asked a
          ) x group by x.day
        ) t
      ), '[]'),
      'pages', coalesce((
        select jsonb_agg(jsonb_build_object('path', p.key, 'visitors', p.visitors, 'pageviews', p.pageviews, 'entries', p.visits,
          'requests', (select count(*) from asked_now a where a.v ->> 'landing_page' = p.key)) order by p.pageviews desc, p.key)
        from (
          select c.key, sum(c.visitors)::integer as visitors, sum(c.pageviews)::integer as pageviews, sum(c.visits)::integer as visits
          from shown c where c.kind = 'page' group by c.key order by 3 desc, 1 limit 100
        ) p
      ), '[]'),
      'sources', coalesce((
        select jsonb_agg(jsonb_build_object('source', s.key, 'channel', s.sub, 'visitors', s.visitors, 'visits', s.visits, 'requests', s.requests) order by s.visits desc, s.requests desc, s.key)
        from (
          select coalesce(c.key, a.source) as key, coalesce(c.sub, a.channel) as sub, coalesce(c.visitors, 0) as visitors, coalesce(c.visits, 0) as visits, coalesce(a.requests, 0) as requests
          from (
            select c.key, c.sub, sum(c.visitors)::integer as visitors, sum(c.visits)::integer as visits
            from shown c where c.kind = 'source' group by c.key, c.sub
          ) c
          full join (
            select a.v ->> 'source' as source, coalesce(a.v ->> 'channel', 'direct') as channel, count(*)::integer as requests
            from asked_now a group by 1, 2
          ) a on a.source = c.key and a.channel = c.sub
          order by 4 desc, 5 desc, 1 limit 100
        ) s
      ), '[]'),
      'campaigns', coalesce((
        select jsonb_agg(jsonb_build_object('campaign', s.key, 'visitors', s.visitors, 'visits', s.visits, 'requests', s.requests) order by s.visits desc, s.requests desc, s.key)
        from (
          select coalesce(c.key, a.campaign) as key, coalesce(c.visitors, 0) as visitors, coalesce(c.visits, 0) as visits, coalesce(a.requests, 0) as requests
          from (select c.key, sum(c.visitors)::integer as visitors, sum(c.visits)::integer as visits from shown c where c.kind = 'campaign' group by c.key) c
          full join (select a.v ->> 'campaign' as campaign, count(*)::integer as requests from asked_now a where a.v ? 'campaign' group by 1) a on a.campaign = c.key
          order by 3 desc, 4 desc, 1 limit 50
        ) s
      ), '[]'),
      'devices', coalesce((
        select jsonb_agg(jsonb_build_object('device', d.key, 'visitors', d.visitors, 'pageviews', d.pageviews) order by d.visitors desc)
        from (select c.key, sum(c.visitors)::integer as visitors, sum(c.pageviews)::integer as pageviews from shown c where c.kind = 'device' group by c.key) d
      ), '[]')
    )
  );
end $$;

-- ---------------------------------------------------------------------------------------------
-- Installing it (Apps), and the website it counts
-- ---------------------------------------------------------------------------------------------

-- enabled: installed or not; site: the website's address, as typed; host: its name, the pages that
-- count; check: what Check found on its home page. Other keys are ignored.
create function public.web_analytics_save(p_company uuid, p_changes jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_changes jsonb := coalesce(p_changes, '{}');
  v_saved jsonb;
begin
  if not (private.has_role(p_company, '{owner,admin}') and private.has_perm(p_company, 'apps')) then
    raise exception 'Only owners and admins who connect apps can change website analytics' using errcode = '42501';
  end if;
  if v_changes ? 'enabled' and jsonb_typeof(v_changes -> 'enabled') <> 'boolean' then
    raise exception 'enabled is true or false' using errcode = '22023';
  end if;
  if exists (select 1 from jsonb_each(v_changes) e where e.key in ('site', 'host') and jsonb_typeof(e.value) not in ('string', 'null')) then
    raise exception 'site and host are text' using errcode = '22023';
  end if;
  update public.companies c
  set settings = jsonb_set(coalesce(c.settings, '{}'), '{website_analytics}',
    coalesce(c.settings -> 'website_analytics', '{}')
    || (select coalesce(jsonb_object_agg(e.key, e.value), '{}') from jsonb_each(v_changes) e where e.key in ('enabled', 'site', 'host', 'check'))
    || case when v_changes ? 'enabled' then jsonb_build_object('changed_at', now()) else '{}' end)
  where c.id = p_company
  returning c.settings -> 'website_analytics' into v_saved;
  return v_saved;
end $$;

revoke execute on function public.web_record_hit(text, text, text, text, text, text, text, text, text, text), public.web_visit_for(uuid, text, text),
  public.web_rollup(), public.web_stats(uuid, date, date), public.web_analytics_save(uuid, jsonb) from public, anon;
revoke execute on function public.web_record_hit(text, text, text, text, text, text, text, text, text, text), public.web_visit_for(uuid, text, text),
  public.web_rollup() from authenticated;
grant execute on function public.web_record_hit(text, text, text, text, text, text, text, text, text, text), public.web_visit_for(uuid, text, text),
  public.web_rollup() to service_role;
grant execute on function public.web_stats(uuid, date, date), public.web_analytics_save(uuid, jsonb) to authenticated;

-- Policies above that ask about membership check it once per query (20261018000990_policy_lookups).
select private.fold_member_checks();

notify pgrst, 'reload schema';
