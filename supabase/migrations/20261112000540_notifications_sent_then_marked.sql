-- A notification counts as delivered once it has gone out, and one that didn't go is tried again.
--
-- claim_notifications marked a batch delivered as it handed it to the API, before anything was sent.
-- An email the mail server turned away, a text or push whose provider was down, or a batch whose
-- server was restarted partway (every update restarts it) was never sent and never tried again.
--
-- Now the API claims a batch the way the other queues do: a token for the batch and five minutes on
-- the database's clock, renewed as it reaches each person. What went out is written down channel by
-- channel (email, text, push) as it goes, so a later try sends only what's still missing. A
-- notification is delivered once nothing is missing. One that failed waits (2, 4, 8... minutes) and
-- is tried again, up to 8 times; after that, or once it's too old to be worth sending, it's recorded
-- as failed with the reason. A batch whose server died is claimed again when its five minutes run out.
--
-- The release before this one keeps calling claim_notifications while an update is under way. It
-- still works as it did, on notifications the new delivery hasn't touched.
--
-- And when a company's email or texts stop going out altogether (a revoked password, a mail server
-- that's down), its owners and admins are told once, on the bell and by push (the last section).

-- ---------------------------------------------------------------------------------------------
-- Delivery bookkeeping on notifications
-- ---------------------------------------------------------------------------------------------

-- delivery: what happened by channel so far, like {"email": "sent", "push": "failed"}. A channel
-- that isn't there is still to do, or was never wanted. Everything that exists now keeps the
-- delivered_at it has: nothing already marked delivered is sent again.
alter table public.notifications
  add column delivery jsonb not null default '{}',
  add column delivery_token uuid,
  add column delivery_locked_until timestamptz,
  add column delivery_attempts integer not null default 0,
  add column deliver_after timestamptz,
  add column delivery_failed_at timestamptz,
  add column delivery_error text;

-- The queue: not delivered, and not given up on.
create index notifications_to_deliver_idx on public.notifications (created_at)
  where delivered_at is null and delivery_failed_at is null;

-- How long a notification is worth sending. A reminder about a clock left running is stale within
-- hours, and a schedule change, a visit reminder or a chat mention the same day; the rest the next
-- day. The bell in the app has every one of them either way.
create function private.notification_max_age(p_kind text) returns interval
language sql immutable set search_path = '' as $$
  select case
    when p_kind = 'time' then interval '2 hours'
    when p_kind in ('schedule', 'visit', 'chat') then interval '6 hours'
    else interval '24 hours'
  end
$$;

-- ---------------------------------------------------------------------------------------------
-- Claiming, sending, and saying how it went
-- ---------------------------------------------------------------------------------------------

-- Claim notifications to deliver (oldest first), about a minute after they're made so quick changes
-- have folded together. Each claim lasts five minutes: a batch whose server died is claimed again
-- after that, and two servers never hold the same one.
create function public.claim_notification_deliveries(p_min_age_seconds integer default 45, p_limit integer default 200)
returns setof public.notifications
language plpgsql security definer set search_path = '' as $$
declare v_token uuid := gen_random_uuid();
begin
  -- Too old to be worth sending (the server was off, or sending kept failing), or started 8 times
  -- without finishing: recorded as failed, not sent.
  update public.notifications n
     set delivery_failed_at = now(), delivery_token = null, delivery_locked_until = null,
         delivery_error = case when n.delivery_attempts >= 8 then coalesce(n.delivery_error, 'Stopped after 8 attempts')
                               else coalesce('Too old to send. ' || n.delivery_error, 'Too old to send') end
   where n.id in (
     select x.id from public.notifications x
      where x.delivered_at is null and x.delivery_failed_at is null
        and (x.delivery_locked_until is null or x.delivery_locked_until < now())
        and (x.delivery_attempts >= 8 or x.created_at < now() - private.notification_max_age(x.kind))
      order by x.created_at
      limit 1000
      for update skip locked);

  return query
  update public.notifications n
     set delivery_token = v_token, delivery_locked_until = now() + interval '5 minutes'
   where n.id in (
     select x.id from public.notifications x
      where x.delivered_at is null and x.delivery_failed_at is null
        and x.created_at < now() - make_interval(secs => p_min_age_seconds)
        and x.created_at >= now() - private.notification_max_age(x.kind)
        and (x.deliver_after is null or x.deliver_after <= now())
        and (x.delivery_locked_until is null or x.delivery_locked_until < now())
        and x.delivery_attempts < 8
      order by x.created_at
      limit least(greatest(p_limit, 1), 300)
      for update skip locked)
  returning n.*;
end $$;

-- Right before sending one person's notifications: the ones the worker still holds, with five more
-- minutes and what has gone out by each channel so far (another server may have sent some of it).
-- That's when the attempt counts, so notifications waiting their turn in a slow batch don't use
-- attempts. One missing from the answer belongs to another worker now, or is gone: leave it.
create function public.start_notification_deliveries(p_token uuid, p_ids uuid[])
returns table (id uuid, delivery jsonb)
language sql security definer set search_path = '' as $$
  update public.notifications n
     set delivery_locked_until = now() + interval '5 minutes', delivery_attempts = n.delivery_attempts + 1
   where n.id = any (p_ids) and n.delivery_token = p_token and n.delivered_at is null and n.delivery_failed_at is null
  returning n.id, n.delivery
$$;

-- Right after an email, text or push went out (or was turned down for good, like an address that
-- doesn't exist): written down at once, so nobody sends it by that channel again, whatever happens
-- to the rest of the batch. It's a fact about the notification, so it's kept even if the worker's
-- claim has run out; the claim only gets its five more minutes while the worker still holds it.
create function public.note_notification_channel(p_token uuid, p_ids uuid[], p_channel text, p_outcome text)
returns integer language plpgsql security definer set search_path = '' as $$
declare v_count integer;
begin
  if p_channel is null or p_channel not in ('email', 'sms', 'push') or p_outcome is null or p_outcome not in ('sent', 'failed') then
    raise exception 'A channel is email, sms or push, and it is sent or failed' using errcode = '22023';
  end if;
  update public.notifications n
     set delivery = n.delivery || jsonb_build_object(p_channel, p_outcome),
         delivery_locked_until = case when n.delivery_token = p_token then now() + interval '5 minutes' else n.delivery_locked_until end
   where n.id = any (p_ids) and n.delivered_at is null and n.delivery_failed_at is null;
  get diagnostics v_count = row_count;
  return v_count;
end $$;

-- How it went for notifications the worker holds. p_delivered: nothing is left to send. p_retry:
-- something didn't go and may go later, so wait 2, 4, 8... minutes and try again; on the 8th failed
-- try, or when the next try would come after it's too old to be worth sending, it's failed instead.
-- p_failed: it can't go (p_error says why). Returns how many it recorded; notifications another
-- worker has claimed since are theirs to record.
create function public.settle_notification_deliveries(p_token uuid, p_delivered uuid[], p_retry uuid[] default '{}', p_failed uuid[] default '{}', p_error text default null)
returns integer language plpgsql security definer set search_path = '' as $$
declare v_count integer; v_total integer := 0;
begin
  update public.notifications n
     set delivered_at = now(), delivery_token = null, delivery_locked_until = null, delivery_error = null
   where n.id = any (p_delivered) and n.delivery_token = p_token and n.delivered_at is null and n.delivery_failed_at is null;
  get diagnostics v_count = row_count;
  v_total := v_total + v_count;

  update public.notifications n
     set delivery_failed_at = now(), delivery_token = null, delivery_locked_until = null,
         delivery_error = left(coalesce(p_error, n.delivery_error, 'Not sent'), 1000)
   where n.delivery_token = p_token and n.delivered_at is null and n.delivery_failed_at is null
     and (n.id = any (p_failed)
          or (n.id = any (p_retry)
              and (n.delivery_attempts >= 8
                   or now() + make_interval(mins => power(2, n.delivery_attempts)::integer) > n.created_at + private.notification_max_age(n.kind))));
  get diagnostics v_count = row_count;
  v_total := v_total + v_count;

  -- Whatever of p_retry is still held has tries and time left.
  update public.notifications n
     set deliver_after = now() + make_interval(mins => power(2, n.delivery_attempts)::integer),
         delivery_token = null, delivery_locked_until = null, delivery_error = left(coalesce(p_error, n.delivery_error), 1000)
   where n.id = any (p_retry) and n.delivery_token = p_token and n.delivered_at is null and n.delivery_failed_at is null;
  get diagnostics v_count = row_count;
  return v_total + v_count;
end $$;

revoke execute on function public.claim_notification_deliveries(integer, integer) from public, anon, authenticated;
revoke execute on function public.start_notification_deliveries(uuid, uuid[]) from public, anon, authenticated;
revoke execute on function public.note_notification_channel(uuid, uuid[], text, text) from public, anon, authenticated;
revoke execute on function public.settle_notification_deliveries(uuid, uuid[], uuid[], uuid[], text) from public, anon, authenticated;
grant execute on function public.claim_notification_deliveries(integer, integer) to service_role;
grant execute on function public.start_notification_deliveries(uuid, uuid[]) to service_role;
grant execute on function public.note_notification_channel(uuid, uuid[], text, text) to service_role;
grant execute on function public.settle_notification_deliveries(uuid, uuid[], uuid[], uuid[], text) to service_role;

-- ---------------------------------------------------------------------------------------------
-- The release before this one, while an update is under way
-- ---------------------------------------------------------------------------------------------

-- As in 20261017002200_notification_delivery.sql (it marks a batch delivered as it claims it, which
-- is how that release works), except it leaves alone what the new delivery holds, has started, or
-- has given up on: those would otherwise go out a second time. What it claims is delivered_at
-- already, so the new delivery never picks it up.
create or replace function public.claim_notifications(p_min_age_seconds integer default 45, p_limit integer default 200)
returns setof public.notifications
language sql security definer set search_path = '' as $$
  update public.notifications n set delivered_at = now()
  where n.id in (
    select id from public.notifications
    where delivered_at is null and created_at < now() - make_interval(secs => p_min_age_seconds)
      and delivery_failed_at is null and delivery_attempts = 0
      and (delivery_locked_until is null or delivery_locked_until < now())
    order by created_at
    limit p_limit
    for update skip locked
  )
  returning n.*
$$;

-- ---------------------------------------------------------------------------------------------
-- Schedule changes fold into a notification only until it starts going out
-- ---------------------------------------------------------------------------------------------

-- As in 20261025002003_sub_field_app.sql, except a change joins the unread notification only while
-- none of it has started going out (delivery_attempts = 0). "Not delivered yet" used to mean that;
-- now a notification can be partway (pushed, with its email waiting for another try), and replacing
-- it then would send the part that already went a second time. The change starts a new one instead.
create or replace function private.notify_schedule(p_company uuid, p_user uuid, p_visit uuid, p_line text) returns void
language plpgsql security definer set search_path = '' as $$
declare v_prev public.notifications; v_lines text[];
begin
  if p_user is null or p_user = (select auth.uid()) then
    return; -- you made the change yourself
  end if;
  -- Gone from the team, a sub the office turned off, or the whole company is being deleted.
  if not exists (
    select 1 from public.memberships m join public.companies c on c.id = m.company_id
    where m.company_id = p_company and m.user_id = p_user and m.active
      and (m.role <> 'subcontractor'
           or exists (select 1 from public.subcontractors s where s.company_id = m.company_id and s.id = m.subcontractor_id and s.active))
  ) then
    return;
  end if;
  select * into v_prev from public.notifications
  where company_id = p_company and user_id = p_user and kind = 'schedule'
    and read_at is null and delivered_at is null and delivery_attempts = 0 and delivery_failed_at is null
    and created_at > now() - interval '10 minutes'
  order by created_at desc limit 1
  for update;
  if found then
    v_lines := string_to_array(v_prev.body, E'\n');
    if p_line = any (v_lines) then
      return;
    end if;
    v_lines := (v_lines || p_line)[greatest(1, array_length(v_lines, 1) - 18):];
    delete from public.notifications where id = v_prev.id;
    insert into public.notifications (company_id, user_id, kind, title, body, link)
    values (p_company, p_user, 'schedule', format('%s changes to your schedule', array_length(v_lines, 1)), array_to_string(v_lines, E'\n'), '/field');
  else
    insert into public.notifications (company_id, user_id, kind, title, body, link)
    values (p_company, p_user, 'schedule', left(p_line, 300), p_line, coalesce('/field/visits/' || p_visit, '/field'));
  end if;
end $$;

-- ---------------------------------------------------------------------------------------------
-- Telling the owners when email or texts stop going out
-- ---------------------------------------------------------------------------------------------

-- A mailbox whose password was revoked showed only on Settings → Email, and a mail server that was
-- down or over its limit showed nowhere, so quotes, invoices and reminders could fail for weeks
-- before anyone looked. Now the API says how each send went (lib/notify.ts), and the owners and
-- admins are told once, on the bell and by push, when a company's email or texts stop going out.
--
-- A row is here only while a company's email or texts are failing: how many sends in a row, since
-- when, what the provider last said, and when the owners were told. Only the API reads it.
create table public.sending_health (
  company_id uuid not null references public.companies (id) on delete cascade,
  channel text not null check (channel in ('email', 'sms')),
  failures integer not null default 0,
  failing_since timestamptz not null default now(),
  last_error text,
  warned_at timestamptz,
  primary key (company_id, channel)
);
alter table public.sending_health enable row level security;
revoke all on public.sending_health from authenticated, anon;

-- How a send went for a company. A failure counts (one that's about the person it was for, like an
-- address that doesn't exist, isn't reported here). The owners and admins get one notification, in
-- the words the API gives, when the sign-in is refused (p_refused), or on the third failure in a row
-- once it has been failing for 15 minutes: a mail server having a bad minute isn't worth a warning.
-- It's a notification like any other, so it reaches them on the bell and by push; the API keeps a
-- warning about email out of email, and one about texts out of texts. A send that works forgets the
-- failures and marks the warning read, so the next time it stops they're told again.
-- Returns 'warned', 'cleared' or null.
create function public.note_sending(p_company uuid, p_channel text, p_ok boolean, p_error text default null, p_refused boolean default false, p_title text default null, p_body text default null)
returns text language plpgsql security definer set search_path = '' as $$
declare v public.sending_health; v_kind text; v_warned timestamptz;
begin
  if p_channel is null or p_channel not in ('email', 'sms') or p_ok is null then
    raise exception 'A send is by email or sms, and it went or it didn''t' using errcode = '22023';
  end if;
  v_kind := case p_channel when 'email' then 'email_failing' else 'texts_failing' end;

  if p_ok then
    delete from public.sending_health where company_id = p_company and channel = p_channel returning warned_at into v_warned;
    if v_warned is null then
      return null;
    end if;
    update public.notifications set read_at = now() where company_id = p_company and kind = v_kind and read_at is null;
    return 'cleared';
  end if;

  insert into public.sending_health as h (company_id, channel, failures, last_error)
  values (p_company, p_channel, 1, left(p_error, 500))
  on conflict (company_id, channel) do update set failures = h.failures + 1, last_error = excluded.last_error
  returning * into v;
  if v.warned_at is not null
     or not (coalesce(p_refused, false) or (v.failures >= 3 and v.failing_since <= now() - interval '15 minutes')) then
    return null;
  end if;

  update public.sending_health set warned_at = now() where company_id = p_company and channel = p_channel;
  insert into public.notifications (company_id, user_id, kind, title, body, link)
  select p_company, m.user_id, v_kind,
         left(coalesce(nullif(trim(p_title), ''), case p_channel when 'email' then 'Emails aren''t going out' else 'Texts aren''t going out' end), 300),
         nullif(trim(p_body), ''),
         case p_channel when 'email' then '/settings?tab=email' else '/apps/twilio' end
    from public.memberships m
   where m.company_id = p_company and m.active and m.role in ('owner', 'admin');
  return 'warned';
end $$;
revoke execute on function public.note_sending(uuid, text, boolean, text, boolean, text, text) from public, anon, authenticated;
grant execute on function public.note_sending(uuid, text, boolean, text, boolean, text, text) to service_role;

notify pgrst, 'reload schema';
