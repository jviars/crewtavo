-- Job offers to subs (docs/subcontractors-plan.md, phase D: "Offers"): the office sends a sub their
-- price on a job, and the sub takes it or turns it down in one tap in the field app.
--
--   job_pay            gains the offer: when it went out and who sent it (offered_at, offered_by), when
--                      it runs out if it isn't answered (respond_by, optional), and how it ended
--                      (offer_outcome: accepted, declined, expired or withdrawn), when (answered_at) and
--                      by which sign-in (answered_by; nobody for one that ran out or was taken back),
--                      with the reason given for turning it down. offer_round counts each offer that
--                      goes out, so an answer is to the offer the sub was looking at.
--   insurance_warning  what was wrong with the sub's insurance as the offer went out: liability or
--                      workers' comp missing, run out, not checked by the office yet, or ending before
--                      the last day of work it covers. It only warns (decided 24 October 2026): nothing
--                      stops an offer going out, and the record shows work given while uninsured.
--   accepted_snapshot  the lines and total last agreed. Changing an agreed price sends it back to the
--                      sub as a new offer (a change), and they stay on its visits meanwhile. Turned
--                      down, run out or taken back, the pay is agreed again at the lines kept here.
--
-- The office (owners, admins and office staff with the subs area) sends, takes back and changes
-- offers (send_sub_offer, withdraw_sub_offer, change_sub_offer), each in one step. A sub reads their
-- own offers (my_sub_offers: the job's title and town, the dates, the work without prices, their own
-- lines; my_sub_pay_totals: what they've been paid this year and are owed) and answers one
-- (answer_sub_offer), through an active sign-in of theirs: as approve_hub_quote
-- does, the offer is locked while it's answered, and an answer that comes second, too late or to an
-- offer that has changed gets false. Taking it puts their sign-ins on the visits it covers (phase C's
-- job_pay_assign, so cancelling takes them off again). The hourly upkeep runs expire_sub_offers().
--
-- Who hears: the sub's sign-ins, about an offer, a new price or one taken back, by push, text and
-- email unless they turn it off (a new notification topic, "jobs": a sub's job offers and pay); the
-- office with the subs area, about each answer and each offer that runs out. Activity verbs
-- sub_offer.sent, .accepted, .declined and .expired let automations react (on the job); like the
-- price, only the office with the subs area reads them. A follow-up waiting on an offer that's sent
-- is called off once the offer is over. While an offer waits, it stays as it went out: its lines,
-- the visits it covers and its notes are changed by taking it back first.

-- ---------------------------------------------------------------------------------------------
-- The offer, on the pay
-- ---------------------------------------------------------------------------------------------

alter table public.job_pay
  add column respond_by timestamptz,
  add column offered_at timestamptz,
  add column offered_by uuid references auth.users (id) on delete set null,
  add column offer_round integer not null default 0 check (offer_round >= 0),
  add column offer_outcome text check (offer_outcome in ('accepted', 'declined', 'expired', 'withdrawn')),
  add column answered_at timestamptz,
  add column answered_by uuid references auth.users (id) on delete set null,
  add column decline_reason text check (length(decline_reason) <= 500),
  add column insurance_warning jsonb
    check (insurance_warning is null or (jsonb_typeof(insurance_warning) = 'array' and jsonb_array_length(insurance_warning) > 0)),
  add column accepted_snapshot jsonb check (accepted_snapshot is null or jsonb_typeof(accepted_snapshot -> 'lines') = 'array');
comment on column public.job_pay.respond_by is 'When an offer runs out if the sub hasn''t answered (expire_sub_offers). None: it waits.';
comment on column public.job_pay.offer_round is 'How many offers have gone out for this pay. An answer names the one it''s to.';
comment on column public.job_pay.offer_outcome is 'How the last offer ended: accepted, declined, expired or withdrawn. A change that ends untaken leaves the pay agreed.';
comment on column public.job_pay.answered_at is 'When the last offer ended: answered, run out or taken back.';
comment on column public.job_pay.answered_by is 'The sign-in that answered (the office''s, when it agreed for the sub by phone).';
comment on column public.job_pay.insurance_warning is 'What was wrong with the sub''s insurance when the offer went out: [{requirement, problem, kind, document_id, expires_on, work_until, waiting}]. Warns only.';
comment on column public.job_pay.accepted_snapshot is 'The lines and total last agreed: {total, lines: [...], at}. A change that ends untaken puts these back.';
create index job_pay_offers_due_idx on public.job_pay (respond_by) where status = 'offered' and respond_by is not null;

-- A sub's job offers and pay: a notification topic of its own ("jobs"), by push, text and email
-- unless they turn it off. Only subs get these, so it's on for everyone; the team never sees it.
do $$
declare c text;
begin
  for c in select conname from pg_constraint where conrelid = 'public.notification_prefs'::regclass and contype = 'c' loop
    execute format('alter table public.notification_prefs drop constraint %I', c);
  end loop;
end $$;
alter table public.notification_prefs add constraint notification_prefs_topics_check check (
  email <@ array['schedule','client','equipment','subs','jobs','time','alerts','chat','hosting']
  and sms <@ array['schedule','client','equipment','subs','jobs','time','alerts','chat','hosting']
  and push <@ array['schedule','client','equipment','subs','jobs','time','alerts','chat','hosting']
);
alter table public.notification_prefs alter column email set default '{schedule,jobs,hosting}';
alter table public.notification_prefs alter column sms set default '{jobs}';
alter table public.notification_prefs alter column push set default '{schedule,client,equipment,subs,jobs,time,alerts,chat,hosting}';
update public.notification_prefs set email = array_append(email, 'jobs') where not ('jobs' = any (email));
update public.notification_prefs set sms = array_append(sms, 'jobs') where not ('jobs' = any (sms));
update public.notification_prefs set push = array_append(push, 'jobs') where not ('jobs' = any (push));

-- ---------------------------------------------------------------------------------------------
-- Small rules
-- ---------------------------------------------------------------------------------------------

-- How pay moves along (as 20261025003001_job_pay.sql), with offers: an agreed price goes back to the
-- sub as a change (accepted → offered), and a change waiting for an answer can be cancelled with the
-- rest of the pay. job_pay_guard keeps both to those paths.
create or replace function private.job_pay_moves(p_from text, p_to text) returns boolean
language sql immutable parallel safe set search_path = '' as $$
  select (p_from, p_to) in (values
    ('draft', 'offered'), ('draft', 'accepted'),
    ('offered', 'accepted'), ('offered', 'declined'), ('offered', 'withdrawn'), ('offered', 'expired'), ('offered', 'draft'), ('offered', 'cancelled'),
    ('accepted', 'offered'), ('accepted', 'done'), ('accepted', 'cancelled'),
    ('done', 'accepted'), ('done', 'paid'), ('done', 'cancelled'),
    ('paid', 'done'))
$$;

-- "$2,040", "$2,040.50": money as a sub's offer reads it. Mirrors moneyShort in packages/core/src/subOffers.ts.
create function private.money_short(p_amount numeric) returns text
language sql immutable parallel safe set search_path = '' as $$
  select '$' || case when round(coalesce(p_amount, 0), 2) = trunc(coalesce(p_amount, 0))
    then to_char(trunc(coalesce(p_amount, 0)), 'FM999,999,990') else to_char(round(p_amount, 2), 'FM999,999,990.00') end
$$;

-- "Mon Nov 2, 5:00 PM": a moment in the company's time zone.
create function private.local_time_words(p_company uuid, p_at timestamptz) returns text
language sql stable security definer set search_path = '' as $$
  select to_char(p_at at time zone coalesce((select c.timezone from public.companies c where c.id = p_company), 'UTC'), 'Dy Mon FMDD, FMHH12:MI AM')
$$;

-- The lines and total a pay comes to now, to keep as what was agreed.
create function private.job_pay_snapshot(p_pay uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'total', coalesce(sum(l.amount), 0),
    'lines', coalesce(jsonb_agg(jsonb_build_object('description', l.description, 'basis', l.basis, 'unit', l.unit, 'quantity', l.quantity,
      'rate', l.rate, 'amount', l.amount, 'service_id', l.service_id, 'pay_rate_id', l.pay_rate_id, 'sort', l.sort)
      order by l.sort, l.created_at, l.id), '[]'),
    'at', now())
  from public.job_pay_lines l where l.job_pay_id = p_pay
$$;

-- What a price is, to tell two apart: each line's description, basis, unit, quantity and rate.
create function private.snapshot_terms(p_snapshot jsonb) returns jsonb
language sql immutable parallel safe set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_array(l ->> 'description', l ->> 'basis', l ->> 'unit', (l ->> 'quantity')::numeric, (l ->> 'rate')::numeric) order by n), '[]')
  from jsonb_array_elements(coalesce(p_snapshot -> 'lines', '[]')) with ordinality as x(l, n)
$$;

/**
 * "Smith roof, Tue Nov 3, 24 squares, $2,040": the job, the days of the visits it covers (the first
 * to the last), the quantity of the per-unit line that comes to the most (none when there's nothing
 * per unit) and its total. Mirrors offerLine in packages/core/src/subOffers.ts.
 */
create function private.sub_offer_line(p_pay uuid) returns text
language sql stable security definer set search_path = '' as $$
  select concat_ws(', ', j.title, d.days, q.words, private.money_short(p.total))
  from public.job_pay p
  join public.jobs j on j.id = p.job_id
  left join lateral (
    select case
      when count(v.scheduled_on) = 0 then null
      when min(v.scheduled_on) = max(v.scheduled_on) then to_char(min(v.scheduled_on), 'Dy Mon FMDD')
      else to_char(min(v.scheduled_on), 'Dy Mon FMDD') || ' to ' || to_char(max(v.scheduled_on), 'Dy Mon FMDD')
    end as days
    from public.job_pay_visits jv join public.visits v on v.id = jv.visit_id
    where jv.job_pay_id = p.id and v.status <> 'cancelled'
  ) d on true
  left join lateral (
    select private.amount_words(l.quantity, l.unit) as words from public.job_pay_lines l
    where l.job_pay_id = p.id and l.basis = 'per_unit' and l.quantity > 0
    order by l.amount desc, l.sort, l.created_at, l.id limit 1
  ) q on true
  where p.id = p_pay
$$;

/**
 * What's wrong with a sub's insurance for this pay, as public.sub_paperwork has it now: for liability
 * and workers' comp (a certificate or an exemption), missing, expired, ending before the last day of
 * work the pay covers (work_until, its last visit's date), or sent by the sub and not checked by the
 * office yet, the first that applies. waiting: they've sent a newer one that's waiting to be checked.
 * Null when nothing is. Mirrors insuranceWarning in packages/core/src/subOffers.ts.
 */
create function private.sub_offer_insurance(p_pay uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  with pay as (select p.company_id, p.subcontractor_id from public.job_pay p where p.id = p_pay),
  work as (
    select max(v.scheduled_on) as until from public.job_pay_visits jv join public.visits v on v.id = jv.visit_id
    where jv.job_pay_id = p_pay and v.status <> 'cancelled'
  ),
  papers as (
    -- One row each (the view also lists a sub's own for them).
    select distinct on (sp.requirement) sp.requirement, sp.state, sp.kind, sp.document_id, sp.expires_on, sp.verified, sp.waiting
    from public.sub_paperwork sp join pay on sp.company_id = pay.company_id and sp.subcontractor_id = pay.subcontractor_id
    where sp.requirement in ('liability', 'workers_comp')
    order by sp.requirement
  ),
  found as (
    select pp.*, w.until,
      case
        when pp.state = 'missing' then 'missing'
        when pp.state = 'expired' then 'expired'
        when pp.expires_on < w.until then 'ends_before_work'
        when not pp.verified then 'unverified'
      end as problem
    from papers pp cross join work w
  )
  select jsonb_agg(jsonb_build_object('requirement', f.requirement, 'problem', f.problem, 'kind', f.kind, 'document_id', f.document_id,
    'expires_on', f.expires_on, 'work_until', f.until, 'waiting', f.waiting) order by f.requirement)
  from found f
  where f.problem is not null
$$;

/**
 * The warning as the sub reads it: "Your workers' comp certificate on file ends before this job."
 * Mirrors insuranceWarningText(item, "sub") in packages/core/src/subOffers.ts.
 */
create function private.sub_offer_warning_words(p_items jsonb) returns text[]
language sql immutable parallel safe set search_path = '' as $$
  select coalesce(array_agg(
    case i ->> 'problem'
      when 'missing' then format('We don''t have your %s on file.',
        case i ->> 'requirement' when 'liability' then 'liability insurance' else 'workers'' comp certificate or exemption' end)
      when 'expired' then format('Your %s on file has run out.', private.sub_document_words(i ->> 'kind'))
      when 'ends_before_work' then format('Your %s on file ends before this job.', private.sub_document_words(i ->> 'kind'))
      else format('We haven''t checked the %s you sent yet.', private.sub_document_words(i ->> 'kind'))
    end
    || case when (i ->> 'waiting')::boolean and i ->> 'problem' <> 'unverified' then ' We''ll check the new one you sent.' else '' end
    order by n), '{}')
  from jsonb_array_elements(coalesce(p_items, '[]')) with ordinality as x(i, n)
$$;

-- Tells a sub's active sign-ins (sign-in and sub both turned on), under their "jobs" topic. With
-- p_once, not again if the same words already went to them about the same pay.
create function private.tell_sub(p_company uuid, p_sub uuid, p_title text, p_body text, p_link text, p_once boolean default false) returns void
language sql security definer set search_path = '' as $$
  insert into public.notifications (company_id, user_id, kind, title, body, link)
  select m.company_id, m.user_id, 'jobs', left(p_title, 300), p_body, p_link
  from public.memberships m
  join public.subcontractors s on s.company_id = m.company_id and s.id = m.subcontractor_id
  where m.company_id = p_company and m.subcontractor_id = p_sub and m.active and s.active
    and not (p_once and exists (
      select 1 from public.notifications n where n.company_id = m.company_id and n.user_id = m.user_id and n.link = p_link and n.title = left(p_title, 300)))
$$;

-- Tells the office with the subs area, under their "subs" topic.
create function private.tell_subs_office(p_company uuid, p_title text, p_body text, p_link text) returns void
language sql security definer set search_path = '' as $$
  insert into public.notifications (company_id, user_id, kind, title, body, link)
  select p_company, o.user_id, 'subs', left(p_title, 300), p_body, p_link
  from private.subs_office(p_company) as o(user_id)
$$;

revoke all on function private.money_short(numeric), private.local_time_words(uuid, timestamptz), private.job_pay_snapshot(uuid),
  private.snapshot_terms(jsonb), private.sub_offer_line(uuid), private.sub_offer_insurance(uuid), private.sub_offer_warning_words(jsonb),
  private.tell_sub(uuid, uuid, text, text, text, boolean), private.tell_subs_office(uuid, text, text, text) from public;

/**
 * Who hears about an offer, and the activity that records it (sub_offer.*, on the job, for
 * automations). p is the pay as it now is; p_change says it was a new price for agreed pay. Once a
 * new price has ended the pay may be back at the agreed lines, so p_offered is the price that was
 * offered and p_was the one agreed before it (read before the pay changed); the activity's total is
 * always the price offered, with was for a new price.
 *   sent       the sub's sign-ins: the job, its days, the work and the price, and when to answer by
 *   accepted   the office with the subs area
 *   declined   the office, with the reason given
 *   expired    the office
 *   withdrawn  the sub's sign-ins (no activity)
 *   agreed     the sub's sign-ins, when the office agrees an offer for them (no activity)
 */
create function private.sub_offer_told(p public.job_pay, p_event text, p_change boolean, p_offered numeric default null, p_was numeric default null) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_job text := (select j.title from public.jobs j where j.id = p.job_id);
  v_sub text := (select s.name from public.subcontractors s where s.id = p.subcontractor_id);
  v_offered numeric := coalesce(p_offered, p.total);
  v_was numeric := case when p_change then coalesce(p_was, (p.accepted_snapshot ->> 'total')::numeric) end;
  v_price text := private.money_short(v_offered);
  v_agreed text := private.money_short((p.accepted_snapshot ->> 'total')::numeric);
  v_mine text := '/field/jobs/' || p.id;
  v_job_page text := '/jobs/' || p.job_id;
  -- In the title too, as a text carries only the title.
  v_by text := case when p.respond_by is not null then 'Answer by ' || private.local_time_words(p.company_id, p.respond_by) || '.' end;
  v_data jsonb := jsonb_build_object('job_pay_id', p.id, 'subcontractor_id', p.subcontractor_id, 'sub_name', v_sub, 'total', v_offered,
    'change', p_change, 'round', p.offer_round) || case when p_change then jsonb_build_object('was', v_was) else '{}'::jsonb end;
begin
  if p_event = 'sent' then
    if p_change then
      perform private.tell_sub(p.company_id, p.subcontractor_id,
        concat_ws(' ', format('New price for %s: %s (was %s).', v_job, v_price, private.money_short(v_was)), v_by, 'Open Crewtavo to accept or decline.'),
        'If you don''t accept it, the price you agreed stands.', v_mine);
      perform private.emit(p.company_id, 'sub_offer.sent', 'job', p.job_id, format('New price for %s sent to %s (%s, was %s)', v_job, v_sub, v_price, private.money_short(v_was)),
        v_data || jsonb_build_object('insurance_warning', p.insurance_warning is not null));
    else
      perform private.tell_sub(p.company_id, p.subcontractor_id, concat_ws(' ', private.sub_offer_line(p.id) || '.', v_by, 'Open Crewtavo to accept or decline.'),
        'New job offer.', v_mine);
      perform private.emit(p.company_id, 'sub_offer.sent', 'job', p.job_id, format('%s offered to %s (%s)', v_job, v_sub, v_price),
        v_data || jsonb_build_object('insurance_warning', p.insurance_warning is not null));
    end if;
  elsif p_event = 'accepted' then
    perform private.emit(p.company_id, 'sub_offer.accepted', 'job', p.job_id,
      case when p_change then format('%s accepted the new price for %s (%s, was %s)', v_sub, v_job, v_price, private.money_short(v_was)) else format('%s accepted %s (%s)', v_sub, v_job, v_price) end, v_data);
    perform private.tell_subs_office(p.company_id,
      case when p_change then format('%s accepted the new price for %s', v_sub, v_job) else format('%s accepted %s', v_sub, v_job) end,
      case when p_change then format('Now %s.', v_price) else format('%s. They''re on its visits now.', v_price) end, v_job_page);
  elsif p_event = 'declined' then
    perform private.emit(p.company_id, 'sub_offer.declined', 'job', p.job_id,
      case when p_change then format('%s declined the new price for %s (%s)', v_sub, v_job, v_price) else format('%s declined %s (%s)', v_sub, v_job, v_price) end
        || coalesce(': ' || p.decline_reason, ''),
      v_data || jsonb_build_object('reason', p.decline_reason));
    perform private.tell_subs_office(p.company_id,
      case when p_change then format('%s declined the new price for %s', v_sub, v_job) else format('%s declined %s', v_sub, v_job) end,
      concat_ws(' ', '“' || p.decline_reason || '”',
        case when p_change then format('The price they agreed (%s) stands.', v_agreed) else 'You can offer it to another sub from the job.' end), v_job_page);
  elsif p_event = 'expired' then
    perform private.emit(p.company_id, 'sub_offer.expired', 'job', p.job_id,
      case when p_change then format('The new price for %s (%s) ran out before %s answered', v_job, v_price, v_sub) else format('%s didn''t answer the offer for %s in time', v_sub, v_job) end,
      v_data);
    perform private.tell_subs_office(p.company_id,
      case when p_change then format('The new price for %s ran out', v_job) else format('%s didn''t answer in time: %s', v_sub, v_job) end,
      case when p_change then format('%s didn''t answer. The price they agreed (%s) stands.', v_sub, v_agreed)
        else 'The offer ran out. You can offer it again, or to another sub, from the job.' end, v_job_page);
  elsif p_event = 'withdrawn' then
    perform private.tell_sub(p.company_id, p.subcontractor_id,
      case when p_change then format('The new price for %s was withdrawn', v_job) else format('The offer for %s was withdrawn', v_job) end,
      case when p_change then format('The price you agreed (%s) stands.', v_agreed) else 'You don''t need to do anything.' end, v_mine);
  elsif p_event = 'agreed' then
    -- The office agreed an offer for them (they said yes on the phone): it's theirs at that price.
    perform private.tell_sub(p.company_id, p.subcontractor_id,
      case when p_change then format('Your price for %s is now %s (was %s)', v_job, v_price, private.money_short(v_was))
        else format('%s is yours at %s', v_job, v_price) end,
      case when p_change then 'The office agreed the new price with you.' else 'The office agreed it with you. It''s on My day.' end, v_mine);
  end if;
end $$;
revoke all on function private.sub_offer_told(public.job_pay, text, boolean, numeric, numeric) from public;

-- ---------------------------------------------------------------------------------------------
-- Keeping offers straight
-- ---------------------------------------------------------------------------------------------

-- As in 20261025003001_job_pay.sql, with the rules for offers: only a sub's pay goes out as one, and
-- each time as a new round (send_sub_offer, change_sub_offer, which fill in who and when); an agreed
-- price only as a change that keeps what was agreed. A change waiting for an answer ends agreed
-- (taken, turned down, run out or taken back) or cancelled with the rest of the pay; a first offer
-- isn't cancelled but taken back. While an offer waits, its notes stay as sent (they're part of what
-- the sub is answering), as do its lines and visits (job_pay_part_guard).
create or replace function private.job_pay_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.company_id <> old.company_id or new.job_id <> old.job_id
     or new.subcontractor_id is distinct from old.subcontractor_id or new.user_id is distinct from old.user_id then
    raise exception 'Pay stays with its job and whoever it''s for. Cancel it and start another.' using errcode = '22023';
  end if;
  new.created_by := old.created_by;
  new.created_at := old.created_at;
  if new.user_id is not null and new.status = 'paid' and new.pay_period_id is null then
    if old.status = 'paid' and old.pay_period_id is not null then
      new.status := 'done';
    else
      raise exception 'Pay for people on your team is paid with their pay period, under Timesheets → Pay.' using errcode = '22023';
    end if;
  end if;
  if pg_trigger_depth() = 1 and old.pay_period_id is not null and exists (
    select 1 from public.pay_period_lines l where l.period_id = old.pay_period_id and l.user_id = old.user_id and l.paid_at is not null
  ) then
    raise exception 'This pay is in a pay period that''s been marked paid. Take back the paid mark first (Timesheets → Pay).' using errcode = '22023';
  end if;
  if new.status is distinct from old.status then
    if not private.job_pay_moves(old.status, new.status) then
      raise exception 'Pay that''s % can''t be %.', replace(old.status, 'accepted', 'agreed'), replace(new.status, 'accepted', 'agreed') using errcode = '22023';
    end if;
    if new.status = 'offered' and (new.subcontractor_id is null or new.offer_round <> old.offer_round + 1) then
      raise exception 'Offers go out from the job, with Offer to a sub.' using errcode = '22023';
    end if;
    if old.status = 'accepted' and new.status = 'offered' and new.accepted_snapshot is null then
      raise exception 'A new price for agreed pay keeps the price they agreed.' using errcode = '22023';
    end if;
    if old.status = 'offered' and old.accepted_snapshot is not null and new.status not in ('accepted', 'cancelled') then
      raise exception 'A new price they haven''t taken goes back to the price they agreed.' using errcode = '22023';
    end if;
    if old.status = 'offered' and old.accepted_snapshot is null and new.status = 'cancelled' then
      raise exception 'This offer is still waiting for their answer. Withdraw it instead.' using errcode = '22023';
    end if;
    if new.status in ('draft', 'offered', 'accepted') then
      new.earned_on := null;
    end if;
  end if;
  if old.status = 'offered' and new.status = 'offered' and new.notes is distinct from old.notes then
    raise exception 'Withdraw the offer to change it.' using errcode = '22023';
  end if;
  if new.status <> 'paid' then
    new.paid_at := null;
    new.paid_amount := null;
    new.method := null;
    new.reference := null;
    new.paid_by := null;
    new.pay_period_id := null;
  end if;
  if pg_trigger_depth() = 1 and new.user_id is not null and new.status = 'done'
     and (old.status <> 'done' or new.earned_on is distinct from old.earned_on)
     and private.paid_for(new.company_id, new.user_id, new.earned_on) then
    raise exception 'That day is in a pay period that''s been marked paid. Pick a later day, or take back the paid mark first (Timesheets → Pay).' using errcode = '22023';
  end if;
  return new;
end $$;

-- A new price that ends without being taken (turned down, run out or taken back) puts the agreed
-- lines back. Named to run before status_change, which acts on the pay being agreed again (and may
-- find its work done).
create function private.job_pay_agreed_back() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  delete from public.job_pay_lines where job_pay_id = new.id;
  insert into public.job_pay_lines (company_id, job_pay_id, description, basis, unit, quantity, rate, service_id, pay_rate_id, sort)
  select new.company_id, new.id, x.description, x.basis, x.unit, x.quantity, x.rate,
    -- A service or rate deleted since is left off the line, as deleting it does.
    (select s.id from public.services s where s.company_id = new.company_id and s.id = x.service_id),
    (select r.id from public.pay_rates r where r.company_id = new.company_id and r.id = x.pay_rate_id),
    x.sort
  from jsonb_to_recordset(new.accepted_snapshot -> 'lines')
    as x(description text, basis text, unit text, quantity numeric, rate numeric, service_id uuid, pay_rate_id uuid, sort integer);
  return null;
end $$;
create trigger agreed_back after update of status on public.job_pay
  for each row when (old.status = 'offered' and new.status = 'accepted' and old.accepted_snapshot is not null
    and new.offer_outcome in ('declined', 'expired', 'withdrawn'))
  execute function private.job_pay_agreed_back();

-- As in 20261025003001_job_pay.sql, and a visit that comes out of a new price waiting for an answer
-- (deleted from the schedule: the offer itself is locked) takes the sub off it too: they're on its
-- visits as agreed meanwhile.
create or replace function private.job_pay_visit_change() returns trigger
language plpgsql security definer set search_path = '' as $$
declare p public.job_pay;
begin
  select * into p from public.job_pay where id = coalesce(new.job_pay_id, old.job_pay_id);
  if not found or not (p.status = 'accepted' or (p.status = 'offered' and p.accepted_snapshot is not null)) then return null; end if;
  if p.subcontractor_id is not null then
    if tg_op = 'INSERT' then
      perform private.job_pay_assign(p.id, new.visit_id);
    elsif cardinality(old.assigned) > 0 then
      perform private.job_pay_unassign(old.visit_id, old.assigned);
    end if;
  end if;
  perform private.job_pay_sync_done(p.id);
  return null;
end $$;

-- As in 20261025003001_job_pay.sql, and an offer waiting for an answer is locked: the visits it
-- covers stay as they went out, as its lines do (take it back to change them). A visit deleted from
-- the schedule still comes out of it, with the database (the visit's own delete, a level down).
create or replace function private.job_pay_part_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_status text;
begin
  if tg_op = 'UPDATE' and pg_trigger_depth() > 1 then return new; end if;
  select p.status into v_status from public.job_pay p where p.id = coalesce(new.job_pay_id, old.job_pay_id);
  if not found then return coalesce(new, old); end if;
  if tg_op = 'UPDATE' and (new.company_id <> old.company_id or new.job_pay_id <> old.job_pay_id) then
    raise exception 'A line stays on its pay.' using errcode = '22023';
  end if;
  if v_status in ('draft', 'accepted')
     or (tg_table_name = 'job_pay_visits' and tg_op = 'DELETE' and v_status not in ('done', 'paid', 'offered'))
     or (tg_table_name = 'job_pay_visits' and tg_op = 'DELETE' and v_status = 'offered' and pg_trigger_depth() > 1) then
    return coalesce(new, old);
  end if;
  if v_status in ('done', 'paid') then
    if tg_table_name = 'job_pay_lines' then
      raise exception 'This pay''s work is done, so its lines stay as they are.' using errcode = '22023';
    end if;
    raise exception 'This pay''s work is done, so the visits it covers stay as they are. To take a visit off the schedule, cancel it instead of deleting it.' using errcode = '22023';
  end if;
  if v_status = 'offered' and tg_table_name = 'job_pay_visits' then
    raise exception 'This offer went out for the visits it covers. Withdraw it to change them.' using errcode = '22023';
  end if;
  raise exception 'Change pay while it''s a draft or agreed.' using errcode = '22023';
end $$;

-- ---------------------------------------------------------------------------------------------
-- What the office does
-- ---------------------------------------------------------------------------------------------

-- Before an offer goes out: the sub has a sign-in to answer with, the price comes to something, and
-- the reply-by time, if any, is still to come and not too far off.
create function private.sub_offer_checks(p public.job_pay, p_respond_by timestamptz, p_change boolean) returns void
language plpgsql stable security definer set search_path = '' as $$
begin
  if not exists (
    select 1 from public.memberships m join public.subcontractors s on s.company_id = m.company_id and s.id = m.subcontractor_id
    where m.company_id = p.company_id and m.subcontractor_id = p.subcontractor_id and m.active and s.active
  ) then
    raise exception '%', case when p_change then 'Give them a sign-in first, or agree the new price with them and change the lines yourself.'
      else 'Give them a sign-in first, or agree it with them and press Agree.' end using errcode = '22023';
  end if;
  if coalesce((select sum(l.amount) from public.job_pay_lines l where l.job_pay_id = p.id), 0) <= 0 then
    raise exception 'Add what you''ll pay them first.' using errcode = '22023';
  end if;
  if p_respond_by <= now() then
    raise exception 'Pick a time to answer by that''s still to come.' using errcode = '22023';
  end if;
  if p_respond_by > now() + interval '90 days' then
    raise exception 'Give them at most 90 days to answer.' using errcode = '22023';
  end if;
end $$;
revoke all on function private.sub_offer_checks(public.job_pay, timestamptz, boolean) from public;

/**
 * The office sends a sub their price on a job (a draft, with its lines and the visits it covers). Their
 * sign-ins hear by push, text and email, and take it or turn it down in the field app; p_respond_by,
 * if given, is when it runs out unanswered. A sub who doesn't sign in is agreed with by phone instead
 * (job_pay_accept). What's wrong with their insurance is recorded on it; nothing about it stops it.
 */
create function public.send_sub_offer(p_pay uuid, p_respond_by timestamptz default null) returns public.job_pay
language plpgsql security definer set search_path = '' as $$
declare p public.job_pay;
begin
  p := private.job_pay_for_office(p_pay);
  if p.subcontractor_id is null then
    raise exception 'Offers are for subs. Agree pay for your team yourself.' using errcode = '22023';
  end if;
  if p.status <> 'draft' then
    raise exception '%', case p.status
      when 'offered' then 'This offer is already out, waiting for their answer.'
      when 'accepted' then 'This pay is already agreed. To change the price, send them the new one.'
      when 'done' then 'This pay is already agreed, and the work is done.'
      when 'paid' then 'This pay is already paid.'
      else 'This pay is over. Start new pay for them instead.' end using errcode = '22023';
  end if;
  perform private.sub_offer_checks(p, p_respond_by, false);
  update public.job_pay
  set status = 'offered', respond_by = p_respond_by, offered_at = now(), offered_by = (select auth.uid()), offer_round = offer_round + 1,
    offer_outcome = null, answered_at = null, answered_by = null, decline_reason = null, insurance_warning = private.sub_offer_insurance(id)
  where id = p.id;
  select * into p from public.job_pay where id = p_pay;
  perform private.sub_offer_told(p, 'sent', false);
  return p;
end $$;

/**
 * The office changes an agreed price (p_lines, the new lines: description, basis, unit, quantity,
 * rate, and the service_id and pay_rate_id they came from), which goes back to the sub as a new
 * offer. The agreed lines and total are kept (accepted_snapshot), and the sub stays on the pay's
 * visits meanwhile. Taken, it's agreed at the new price; turned down, run out or taken back, at the
 * old one again.
 */
create function public.change_sub_offer(p_pay uuid, p_lines jsonb, p_respond_by timestamptz default null) returns public.job_pay
language plpgsql security definer set search_path = '' as $$
declare p public.job_pay; v_agreed jsonb; v_new jsonb;
begin
  p := private.job_pay_for_office(p_pay);
  if p.subcontractor_id is null then
    raise exception 'Offers are for subs. Change pay for your team yourself.' using errcode = '22023';
  end if;
  if p.status <> 'accepted' then
    raise exception '%', case p.status
      when 'draft' then 'This is still a draft. Change its lines and send it.'
      when 'offered' then 'This offer is still waiting for their answer. Withdraw it first to change it.'
      when 'done' then 'The work is done, so the price stays as agreed.'
      when 'paid' then 'This pay is already paid.'
      else 'This pay is over.' end using errcode = '22023';
  end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'Add what you''ll pay them.' using errcode = '22023';
  end if;
  if jsonb_array_length(p_lines) > 50 then
    raise exception 'Keep it to 50 lines.' using errcode = '22023';
  end if;
  if exists (select 1 from jsonb_array_elements(p_lines) e where jsonb_typeof(e) <> 'object' or length(btrim(coalesce(e ->> 'description', ''))) not between 1 and 200) then
    raise exception 'Give each line a description (200 characters at most).' using errcode = '22023';
  end if;
  if exists (select 1 from jsonb_array_elements(p_lines) e where coalesce(e ->> 'basis', 'per_job') not in ('per_unit', 'per_job', 'per_day')) then
    raise exception 'Each line is per unit, per job or per day.' using errcode = '22023';
  end if;
  if exists (select 1 from jsonb_array_elements(p_lines) e where length(e ->> 'unit') > 20) then
    raise exception 'Keep each unit short (20 characters at most).' using errcode = '22023';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_lines) e cross join (values ('quantity'), ('rate')) as f(k)
    where case
      when e -> f.k is null or jsonb_typeof(e -> f.k) = 'null' then false
      when jsonb_typeof(e -> f.k) = 'number' then (e ->> f.k)::numeric not between 0 and 1000000
      else true
    end
  ) then
    raise exception 'Check the quantities and rates: numbers from 0 to 1,000,000.' using errcode = '22023';
  end if;
  v_agreed := private.job_pay_snapshot(p.id);
  delete from public.job_pay_lines where job_pay_id = p.id;
  insert into public.job_pay_lines (company_id, job_pay_id, description, basis, unit, quantity, rate, service_id, pay_rate_id, sort)
  select p.company_id, p.id, btrim(e ->> 'description'), coalesce(e ->> 'basis', 'per_job'), nullif(btrim(e ->> 'unit'), ''),
    coalesce((e ->> 'quantity')::numeric, 1), coalesce((e ->> 'rate')::numeric, 0),
    (select s.id from public.services s where s.company_id = p.company_id and s.id::text = e ->> 'service_id'),
    (select r.id from public.pay_rates r where r.company_id = p.company_id and r.id::text = e ->> 'pay_rate_id'),
    n::integer
  from jsonb_array_elements(p_lines) with ordinality as x(e, n);
  v_new := private.job_pay_snapshot(p.id);
  if private.snapshot_terms(v_new) = private.snapshot_terms(v_agreed) then
    raise exception 'That''s the price they agreed. Change something first.' using errcode = '22023';
  end if;
  perform private.sub_offer_checks(p, p_respond_by, true);
  update public.job_pay
  set status = 'offered', accepted_snapshot = v_agreed, respond_by = p_respond_by, offered_at = now(), offered_by = (select auth.uid()),
    offer_round = offer_round + 1, offer_outcome = null, answered_at = null, answered_by = null, decline_reason = null,
    insurance_warning = private.sub_offer_insurance(id)
  where id = p.id;
  select * into p from public.job_pay where id = p_pay;
  perform private.sub_offer_told(p, 'sent', true);
  return p;
end $$;

/**
 * The office takes back an offer the sub hasn't answered: a first offer is over (withdrawn; start new
 * pay to offer it again, to them or someone else), and a new price leaves the pay agreed at the old
 * one. The sub's sign-ins hear.
 */
create function public.withdraw_sub_offer(p_pay uuid) returns public.job_pay
language plpgsql security definer set search_path = '' as $$
declare p public.job_pay; v_change boolean; v_offered numeric; v_was numeric;
begin
  p := private.job_pay_for_office(p_pay);
  if p.status <> 'offered' then
    raise exception '%', case
      when p.status = 'draft' then 'This offer hasn''t gone out yet.'
      when p.status in ('accepted', 'done', 'paid') then 'They''ve already agreed this pay.'
      else 'This offer is already over.' end using errcode = '22023';
  end if;
  v_change := p.accepted_snapshot is not null;
  v_offered := p.total;
  v_was := (p.accepted_snapshot ->> 'total')::numeric;
  update public.job_pay
  set status = case when v_change then 'accepted' else 'withdrawn' end, offer_outcome = 'withdrawn', answered_at = now(), answered_by = null
  where id = p.id;
  select * into p from public.job_pay where id = p_pay;
  perform private.sub_offer_told(p, 'withdrawn', v_change, v_offered, v_was);
  return p;
end $$;

/**
 * As in 20261025003001_job_pay.sql: the office agrees the pay (for a sub, standing for "agreed by
 * phone"), with the visits it covers if given (not for an offer: it went out for its visits). What's
 * agreed is kept (accepted_snapshot). A sub's draft agreed this way records what was wrong with their
 * insurance, as an offer would (it only warns). An offer waiting for an answer is recorded as taken,
 * by the office person who agreed it, and the sub's sign-ins are told: it's their price now.
 */
create or replace function public.job_pay_accept(p_pay uuid, p_visits uuid[] default null) returns public.job_pay
language plpgsql security definer set search_path = '' as $$
declare p public.job_pay; v_offered boolean; v_change boolean; v_was numeric;
begin
  p := private.job_pay_for_office(p_pay);
  if p.status not in ('draft', 'offered') then
    raise exception '%', case p.status
      when 'accepted' then 'This pay is already agreed.'
      when 'done' then 'This pay is already agreed, and the work is done.'
      when 'paid' then 'This pay is already paid.'
      else 'This pay is over. Start new pay for them instead.' end using errcode = '22023';
  end if;
  v_offered := p.status = 'offered';
  v_change := v_offered and p.accepted_snapshot is not null;
  v_was := (p.accepted_snapshot ->> 'total')::numeric;
  if p_visits is not null then
    p_visits := private.job_pay_cover(p.job_id, p.subcontractor_id, p.user_id, p_visits);
    if v_offered then
      if exists (select 1 from public.job_pay_visits jv where jv.job_pay_id = p.id and jv.visit_id <> all (p_visits))
         or exists (select 1 from unnest(p_visits) x where not exists (select 1 from public.job_pay_visits jv where jv.job_pay_id = p.id and jv.visit_id = x)) then
        raise exception 'This offer went out for the visits it covers. Withdraw it to change them.' using errcode = '22023';
      end if;
    else
      delete from public.job_pay_visits where job_pay_id = p.id and visit_id <> all (p_visits);
      insert into public.job_pay_visits (company_id, job_pay_id, visit_id) select p.company_id, p.id, x from unnest(p_visits) x on conflict do nothing;
    end if;
  end if;
  update public.job_pay
  set status = 'accepted', accepted_snapshot = private.job_pay_snapshot(id),
    offer_outcome = case when v_offered then 'accepted' else offer_outcome end,
    answered_at = case when v_offered then now() else answered_at end,
    answered_by = case when v_offered then (select auth.uid()) else answered_by end,
    decline_reason = case when v_offered then null else decline_reason end,
    insurance_warning = case when v_offered or subcontractor_id is null then insurance_warning else private.sub_offer_insurance(id) end
  where id = p.id;
  select * into p from public.job_pay where id = p_pay;
  if v_offered then
    perform private.sub_offer_told(p, 'agreed', v_change, p.total, v_was);
  end if;
  return p;
end $$;

/**
 * As in 20261025003001_job_pay.sql: the office calls it off. A first offer still waiting is taken
 * back instead (withdraw_sub_offer); a new price waiting for an answer is cancelled with the pay.
 */
create or replace function public.job_pay_cancel(p_pay uuid) returns public.job_pay
language plpgsql security definer set search_path = '' as $$
declare p public.job_pay;
begin
  p := private.job_pay_for_office(p_pay);
  if p.status = 'draft' then
    raise exception 'This pay is still a draft. Delete it instead.' using errcode = '22023';
  end if;
  if p.status = 'paid' then
    raise exception 'This pay is marked paid. Take that back first.' using errcode = '22023';
  end if;
  if p.status = 'offered' and p.accepted_snapshot is null then
    raise exception 'This offer is still waiting for their answer. Withdraw it instead.' using errcode = '22023';
  end if;
  if not private.job_pay_live(p.status) then
    raise exception 'This pay is already over.' using errcode = '22023';
  end if;
  update public.job_pay set status = 'cancelled' where id = p.id;
  select * into p from public.job_pay where id = p_pay;
  return p;
end $$;

-- ---------------------------------------------------------------------------------------------
-- What the sub does
-- ---------------------------------------------------------------------------------------------

/**
 * A sub's own job offers, through their active sign-ins (at p_company, or every company they sign in
 * to): those waiting for an answer first, then those answered, run out or taken back in the last 30
 * days. With p_all (for My jobs), also their work: taken and coming up, done and owed, and paid this
 * year or in the last 30 days (older pay is in their totals, my_sub_pay_totals). Cancelled pay isn't
 * listed. Live work comes before what's over, so the 500 rows at most never leave out work to do.
 * Each with:
 *   - the job's title and only its town (city, region): the address shows in My day once they're on
 *     the visits;
 *   - the visits it covers (not cancelled ones): their dates and times;
 *   - the work, as job_scope() gives it: names, quantities and units, no prices (for work that's
 *     theirs or offered to them; an offer that's over keeps only its days);
 *   - their own lines and total, and for a new price, the price agreed until now (agreed_*);
 *   - when to answer by, whether they still can (can_answer), and the round to answer (offer_round);
 *   - for an offer waiting for an answer, what's wrong with their insurance now, in their words.
 */
create function public.my_sub_offers(p_all boolean default false, p_company uuid default null)
returns table (id uuid, company_id uuid, subcontractor_id uuid, job_id uuid, job_title text, city text, region text, status text,
               is_change boolean, can_answer boolean, total numeric, lines jsonb, agreed_total numeric, agreed_lines jsonb, visits jsonb,
               scope jsonb, notes text, respond_by timestamptz, offered_at timestamptz, offer_round integer, outcome text,
               answered_at timestamptz, decline_reason text, insurance_warning text[], earned_on date, paid_at timestamptz, paid_amount numeric)
language sql stable security definer set search_path = '' as $$
  select p.id, p.company_id, p.subcontractor_id, p.job_id, j.title, pr.city, pr.region, p.status,
    p.status = 'offered' and p.accepted_snapshot is not null,
    p.status = 'offered' and (p.respond_by is null or p.respond_by > now()),
    p.total,
    (select coalesce(jsonb_agg(jsonb_build_object('id', l.id, 'description', l.description, 'basis', l.basis, 'unit', l.unit,
        'quantity', l.quantity, 'rate', l.rate, 'amount', l.amount) order by l.sort, l.created_at, l.id), '[]')
     from public.job_pay_lines l where l.job_pay_id = p.id),
    case when p.status = 'offered' and p.accepted_snapshot is not null then (p.accepted_snapshot ->> 'total')::numeric end,
    case when p.status = 'offered' and p.accepted_snapshot is not null then
      (select coalesce(jsonb_agg(jsonb_build_object('description', l ->> 'description', 'basis', l ->> 'basis', 'unit', l ->> 'unit',
          'quantity', (l ->> 'quantity')::numeric, 'rate', (l ->> 'rate')::numeric, 'amount', (l ->> 'amount')::numeric) order by n), '[]')
       from jsonb_array_elements(p.accepted_snapshot -> 'lines') with ordinality as x(l, n))
    end,
    (select coalesce(jsonb_agg(jsonb_build_object('id', v.id, 'scheduled_on', v.scheduled_on, 'starts_at', v.starts_at, 'ends_at', v.ends_at,
        'status', v.status) order by v.scheduled_on nulls last, v.starts_at nulls last, v.id), '[]')
     from public.job_pay_visits jv join public.visits v on v.id = jv.visit_id
     where jv.job_pay_id = p.id and v.status <> 'cancelled'),
    case when p.status in ('offered', 'accepted', 'done', 'paid') then
      (select coalesce(jsonb_agg(jsonb_build_object('name', li.name, 'description', li.description, 'quantity', li.quantity, 'unit', li.unit)
          order by li.sort, li.name), '[]')
       from public.job_line_items li where li.job_id = p.job_id and li.unit_price >= 0)
      else '[]'::jsonb end,
    p.notes, p.respond_by, p.offered_at, p.offer_round, p.offer_outcome, p.answered_at, p.decline_reason,
    case when p.status = 'offered' then private.sub_offer_warning_words(private.sub_offer_insurance(p.id)) else '{}'::text[] end,
    p.earned_on, p.paid_at, p.paid_amount
  from public.job_pay p
  join private.my_subs() s on s.company_id = p.company_id and s.subcontractor_id = p.subcontractor_id
  join public.jobs j on j.id = p.job_id
  join public.companies c on c.id = p.company_id
  left join public.properties pr on pr.id = j.property_id
  where p.status not in ('draft', 'cancelled')
    and (p_company is null or p.company_id = p_company)
    and (p.status = 'offered'
      or (p.offer_outcome is not null and p.answered_at > now() - interval '30 days')
      or (coalesce(p_all, false) and (p.status in ('accepted', 'done')
        or (p.status = 'paid' and (p.paid_at > now() - interval '30 days'
          or p.paid_at >= date_trunc('year', now() at time zone coalesce(c.timezone, 'UTC')) at time zone coalesce(c.timezone, 'UTC'))))))
  order by case when p.status = 'offered' then 0 when p.status in ('accepted', 'done') then 1 else 2 end,
    case when p.status = 'offered' then p.respond_by end nulls last,
    coalesce(p.paid_at, p.answered_at, p.offered_at, p.created_at) desc, p.id
  limit 500
$$;

/**
 * What a sub has been paid this year at p_company (by the day it was paid, the company's, as the
 * 1099 totals count it) and what they're owed now (work done, not paid yet), through their active
 * sign-in there. Nothing for anyone who isn't one of its subs.
 */
create function public.my_sub_pay_totals(p_company uuid)
returns table (year integer, paid numeric, payments integer, owed numeric, owed_jobs integer)
language sql stable security definer set search_path = '' as $$
  with co as (
    select coalesce(c.timezone, 'UTC') as tz from public.companies c
    where c.id = p_company and exists (select 1 from private.my_subs() s where s.company_id = p_company)
  ),
  mine as (
    select p.status, p.total, p.paid_at, p.paid_amount from public.job_pay p
    join private.my_subs() s on s.company_id = p.company_id and s.subcontractor_id = p.subcontractor_id
    where p.company_id = p_company and p.status in ('done', 'paid')
  )
  select extract(year from now() at time zone co.tz)::integer,
    coalesce(sum(m.paid_amount) filter (where m.status = 'paid' and m.paid_at >= date_trunc('year', now() at time zone co.tz) at time zone co.tz), 0),
    (count(*) filter (where m.status = 'paid' and m.paid_at >= date_trunc('year', now() at time zone co.tz) at time zone co.tz))::integer,
    coalesce(sum(m.total) filter (where m.status = 'done'), 0),
    (count(*) filter (where m.status = 'done'))::integer
  from co left join mine m on true
  group by co.tz
$$;

/**
 * A sub takes an offer (p_accept) or turns it down, with an optional reason, as one of their active
 * sign-ins. p_round, if given, is the offer they were looking at: one the office has changed since
 * isn't answered; p_company, if given, is the company they're answering at (the server's, from the
 * company they have open), and an offer from another isn't answered there. The offer is locked while it's answered, so of two answers at once the second gets
 * false, as does one to an offer that isn't theirs, isn't waiting for an answer or has run out (the
 * server then says so).
 *   - Taken: agreed at its price (kept as what was agreed), and their sign-ins go on the visits it covers.
 *   - Turned down: declined; a new price turned down leaves the pay agreed at the old one.
 * The office with the subs area hears either way.
 */
create function public.answer_sub_offer(p_pay uuid, p_accept boolean, p_reason text default null, p_round integer default null, p_company uuid default null)
returns boolean
language plpgsql security definer set search_path = '' as $$
declare p public.job_pay; v_change boolean; v_offered numeric; v_was numeric;
begin
  if p_accept is null then
    raise exception 'Accept it or decline it.' using errcode = '22023';
  end if;
  if length(p_reason) > 500 then
    raise exception 'Keep the reason short: 500 characters at most.' using errcode = '22023';
  end if;
  select * into p from public.job_pay jp
  where jp.id = p_pay and jp.status = 'offered' and (jp.respond_by is null or jp.respond_by > now())
    and (p_round is null or jp.offer_round = p_round)
    and (p_company is null or jp.company_id = p_company)
    and (jp.company_id, jp.subcontractor_id) in (select s.company_id, s.subcontractor_id from private.my_subs() s)
  for update;
  if not found then
    return false;
  end if;
  v_change := p.accepted_snapshot is not null;
  v_offered := p.total;
  v_was := (p.accepted_snapshot ->> 'total')::numeric;
  if p_accept then
    -- Agreed: job_pay_status_change puts their sign-ins on the visits it covers.
    update public.job_pay
    set status = 'accepted', offer_outcome = 'accepted', answered_at = now(), answered_by = (select auth.uid()), decline_reason = null,
      accepted_snapshot = private.job_pay_snapshot(id)
    where id = p.id;
  else
    update public.job_pay
    set status = case when v_change then 'accepted' else 'declined' end, offer_outcome = 'declined', answered_at = now(),
      answered_by = (select auth.uid()), decline_reason = nullif(btrim(p_reason), '')
    where id = p.id;
  end if;
  select * into p from public.job_pay where id = p_pay;
  perform private.sub_offer_told(p, case when p_accept then 'accepted' else 'declined' end, v_change, v_offered, v_was);
  return true;
end $$;

-- ---------------------------------------------------------------------------------------------
-- Offers that run out
-- ---------------------------------------------------------------------------------------------

/**
 * Offers past their reply-by time, unanswered: a first offer is expired, and a new price leaves the
 * pay agreed at the old one. The office with the subs area hears. Returns how many ran out. Run
 * hourly by the server; safe to run twice, at the same time too (one an answer has locked waits for
 * the next run, and is gone by then if it was answered).
 */
create function public.expire_sub_offers() returns integer
language plpgsql security definer set search_path = '' as $$
declare r record; p public.job_pay; v_change boolean; v_offered numeric; v_was numeric; n integer := 0;
begin
  for r in
    select jp.id from public.job_pay jp
    where jp.status = 'offered' and jp.respond_by <= now()
    order by jp.respond_by, jp.id
    for update skip locked
  loop
    select * into p from public.job_pay where id = r.id;
    v_change := p.accepted_snapshot is not null;
    v_offered := p.total;
    v_was := (p.accepted_snapshot ->> 'total')::numeric;
    update public.job_pay
    set status = case when v_change then 'accepted' else 'expired' end, offer_outcome = 'expired', answered_at = now(), answered_by = null
    where id = p.id;
    select * into p from public.job_pay where id = r.id;
    perform private.sub_offer_told(p, 'expired', v_change, v_offered, v_was);
    n := n + 1;
  end loop;
  return n;
end $$;

revoke execute on function public.send_sub_offer(uuid, timestamptz), public.change_sub_offer(uuid, jsonb, timestamptz), public.withdraw_sub_offer(uuid),
  public.my_sub_offers(boolean, uuid), public.my_sub_pay_totals(uuid), public.answer_sub_offer(uuid, boolean, text, integer, uuid), public.expire_sub_offers()
  from public, anon;
grant execute on function public.send_sub_offer(uuid, timestamptz), public.change_sub_offer(uuid, jsonb, timestamptz), public.withdraw_sub_offer(uuid),
  public.my_sub_offers(boolean, uuid), public.my_sub_pay_totals(uuid), public.answer_sub_offer(uuid, boolean, text, integer, uuid) to authenticated;
revoke execute on function public.expire_sub_offers() from authenticated;
grant execute on function public.expire_sub_offers() to service_role;

-- ---------------------------------------------------------------------------------------------
-- Follow-ups on an offer that's over
-- ---------------------------------------------------------------------------------------------

-- A rule that follows up an offer a while after it's sent ("4 hours after a job is offered to a
-- sub, tell me") is called off once the offer is over, however it ended: chasing it would ask about
-- something already answered, as accept_hub_range does for a quote's follow-ups.
create function private.job_pay_offer_over() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  update public.automation_runs r
  set status = 'cancelled', finished_at = now(), error = case new.offer_outcome
    when 'accepted' then 'The sub took the offer.'
    when 'declined' then 'The sub turned the offer down.'
    when 'expired' then 'The offer ran out.'
    when 'withdrawn' then 'The offer was withdrawn.'
    else 'The offer is over.' end
  from public.automation_rules ru, public.activity a
  where ru.id = r.rule_id and ru.trigger = 'sub_offer.sent' and a.id = r.activity_id and a.data ->> 'job_pay_id' = new.id::text
    and r.company_id = new.company_id and r.subject_type = 'job' and r.subject_id = new.job_id and r.status = 'pending';
  return null;
end $$;
create trigger offer_over after update of status on public.job_pay
  for each row when (old.status = 'offered' and new.status <> 'offered') execute function private.job_pay_offer_over();

-- ---------------------------------------------------------------------------------------------
-- Who reads offer activity
-- ---------------------------------------------------------------------------------------------

-- Offer events carry a sub's price: only the office with the subs area reads them (the activity feed
-- otherwise shows estimators the rest of a job's events).
create policy activity_sub_offers on public.activity as restrictive for select to authenticated
  using (not starts_with(verb, 'sub_offer.') or (private.has_role(company_id, '{owner,admin,office}') and private.has_perm(company_id, 'subs')));

-- Policies above that ask about membership check it once per query (20261018000990_policy_lookups).
-- One quick try (half a second at most) while this migration holds its own locks: if a table is
-- busy, nothing is changed, and scripts/migrate.mjs folds the rest a table at a time right after.
select private.fold_member_checks(null, interval '0');

notify pgrst, 'reload schema';
