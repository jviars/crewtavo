-- Quo (once called OpenPhone): a business can text from its Quo number instead of Twilio
-- (Apps → Quo, apps/api/src/lib/quo.ts). Texts go both ways: what Crewtavo sends shows in Quo's
-- inbox, and replies, texts someone sends from the Quo app and the number's calls (with Quo's
-- summary of each) come back onto the client's timeline. Past texts and calls can be brought in.
--
--   * messages.origin says where a message came from when it didn't go through Crewtavo itself:
--     'quo' for a text someone sent from the Quo app and for a call on the Quo number, and
--     'quo_import' for one brought in from Quo's history. Null for everything else, as before.
--   * messages.call holds a call's details (channel 'call'): how it went, how long, Quo's summary
--     and next steps, a voicemail's words. Its body says the same in words, for lists and search.
--   * A call from a number nobody knows waits in unknown_texts with the texts, as a lead's voicemail
--     should, and moves onto the client's timeline with them when the number is attached.
--   * quo_events and quo_sent are the server's: which of Quo's deliveries were already handled
--     (Quo tries again for a day), and which texts Crewtavo itself sent (so a delivery report for one
--     isn't taken for a text someone typed in Quo).

-- ---------------------------------------------------------------------------------------------
-- Messages
-- ---------------------------------------------------------------------------------------------

alter table public.messages
  add column origin text check (origin in ('quo', 'quo_import')),
  add column call jsonb check (call is null or jsonb_typeof(call) = 'object');
comment on column public.messages.origin is
  'Where a message came from when not through Crewtavo: quo (sent from the Quo app, or a call on the Quo number), quo_import (brought in from Quo''s history). Null otherwise';
comment on column public.messages.call is
  'A call (channel call): {"outcome": "answered"|"missed"|"voicemail", "seconds": n, "summary": [..], "next_steps": [..], "voicemail": "..", "quo_id": ".."}';

-- Quo's message and call ids, looked up as its reports come in and as history is brought in.
create index messages_external_idx on public.messages (company_id, external_id) where external_id is not null;
-- A call is on a client's timeline once, however its reports arrive (the call, its voicemail and
-- its summary can come at the same moment, in any order).
create unique index messages_call_once on public.messages (company_id, client_id, external_id) where channel = 'call' and external_id is not null;

-- Only the server says a message came from Quo, or what a call was: from the browser a message is
-- the office's own, as it always was. The database's own functions (attaching an unknown number,
-- merging clients) run as their owner and write through.
create function private.messages_origin_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if current_user = 'authenticated' then
    if tg_op = 'INSERT' then
      new.origin := null;
      new.call := null;
    else
      new.origin := old.origin;
      new.call := old.call;
    end if;
  end if;
  return new;
end $$;
create trigger origin_guard before insert or update on public.messages for each row execute function private.messages_origin_guard();

-- ---------------------------------------------------------------------------------------------
-- Calls from numbers nobody knows
-- ---------------------------------------------------------------------------------------------

alter table public.unknown_texts
  add column channel text not null default 'sms' check (channel in ('sms', 'call')),
  add column call jsonb check (call is null or jsonb_typeof(call) = 'object');
comment on column public.unknown_texts.channel is 'sms: a text; call: a call on the Quo number (its details in call, as messages.call)';
create index unknown_texts_external_idx on public.unknown_texts (company_id, external_id) where external_id is not null;
create unique index unknown_texts_call_once on public.unknown_texts (company_id, external_id) where channel = 'call' and external_id is not null;

/**
 * Attaches an unknown number to a client and moves its texts (and calls) onto their timeline: as
 * the client's own phone (p_as 'phone', replacing the one on file), or as a new contact named
 * p_name (p_as 'contact'; not ticked for reminders, which is for the office to choose). For whoever
 * may edit clients. A number that texted STOP stays stopped: as the client's phone, they have texts
 * off. Returns how many texts and calls moved.
 */
create or replace function public.attach_unknown_texts(p_company uuid, p_phone text, p_client uuid, p_as text default 'contact', p_name text default null)
returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_key text := right(regexp_replace(coalesce(p_phone, ''), '\D', '', 'g'), 10);
  v_from text;
  v_client text;
  v_name text := nullif(btrim(coalesce(p_name, '')), '');
  v_stopped timestamptz;
  v_moved integer;
begin
  if not private.has_role(p_company, '{owner,admin,office,estimator}') then
    raise exception 'Only the office can attach a number to a client.' using errcode = '42501';
  end if;
  if p_as is null or p_as not in ('phone', 'contact') then
    raise exception 'Attach the number as the client''s phone or as a contact.' using errcode = '22023';
  end if;
  select display_name into v_client from public.clients where company_id = p_company and id = p_client for update;
  if v_client is null then
    raise exception 'That client isn''t here anymore.' using errcode = 'P0002';
  end if;
  -- The number as it texted (or called), from its newest.
  select from_phone into v_from from public.unknown_texts
   where company_id = p_company and phone_key = v_key order by created_at desc limit 1;
  if v_from is null then
    raise exception 'There are no texts from that number to attach.' using errcode = 'P0002';
  end if;
  if p_as = 'contact' and v_name is null then
    raise exception 'Add the contact''s name.' using errcode = '22023';
  end if;
  select stopped_at into v_stopped from public.sms_stops where company_id = p_company and phone_key = v_key;

  if p_as = 'phone' then
    -- The STOP is the number's, and the number is now theirs (the guard lets this one write through).
    perform set_config('crewtavo.attach_text', p_client::text, true);
    update public.clients set phone = v_from, sms_opt_out_at = coalesce(v_stopped, sms_opt_out_at) where company_id = p_company and id = p_client;
    perform set_config('crewtavo.attach_text', '', true);
  else
    insert into public.client_contacts (company_id, client_id, name, phone, notify_email, notify_sms)
    values (p_company, p_client, left(v_name, 120), v_from, false, false);
  end if;

  -- Written as the function's owner, so the origin guard keeps a call's details.
  insert into public.messages (company_id, client_id, channel, direction, status, body, external_id, sent_by, created_at, from_phone, from_name, origin, call)
  select u.company_id, p_client, u.channel, 'in', 'received', u.body, u.external_id, null, u.created_at, u.from_phone,
         case when p_as = 'contact' then left(v_name, 200) end,
         case when u.channel = 'call' then 'quo' end, u.call
    from public.unknown_texts u
   where u.company_id = p_company and u.phone_key = v_key
   order by u.created_at;
  get diagnostics v_moved = row_count;
  delete from public.unknown_texts where company_id = p_company and phone_key = v_key;
  return v_moved;
end $$;
revoke execute on function public.attach_unknown_texts(uuid, text, uuid, text, text) from public, anon;
grant execute on function public.attach_unknown_texts(uuid, text, uuid, text, text) to authenticated;

-- ---------------------------------------------------------------------------------------------
-- The server's own records
-- ---------------------------------------------------------------------------------------------

-- Quo's deliveries already handled, by their webhook-id: Quo tries a delivery again for about a
-- day until it's answered, and one handled once isn't filed twice. Kept a few days.
create table public.quo_events (
  company_id uuid not null references public.companies (id) on delete cascade,
  event_id text not null check (char_length(event_id) between 1 and 200),
  received_at timestamptz not null default now(),
  primary key (company_id, event_id)
);
create index quo_events_age_idx on public.quo_events (received_at);
comment on table public.quo_events is 'Quo webhook deliveries already handled (the server''s only), kept a few days';

-- Texts Crewtavo sent through Quo, by Quo's message id, as soon as Quo took them: Quo reports each
-- text the number sends, and one in here isn't filed as typed in the Quo app. Kept a few days.
create table public.quo_sent (
  company_id uuid not null references public.companies (id) on delete cascade,
  message_id text not null check (char_length(message_id) between 1 and 200),
  sent_at timestamptz not null default now(),
  primary key (company_id, message_id)
);
create index quo_sent_age_idx on public.quo_sent (sent_at);
comment on table public.quo_sent is 'Texts Crewtavo sent through Quo (the server''s only), kept a few days';

alter table public.quo_events enable row level security;
alter table public.quo_sent enable row level security;
revoke all on public.quo_events, public.quo_sent from public, anon, authenticated;

notify pgrst, 'reload schema';
