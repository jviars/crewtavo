-- What an AI assistant (Claude, ChatGPT over MCP) sends its own words to.
--
-- An assistant sends quotes, invoices and campaigns only to addresses on file (apps/api/src/services/
-- sales.ts, services/campaigns.ts). But it can put an address on file itself: add a client or a
-- contact, or change their email or phone. Text it reads (a client's note, a website form) could then
-- have it add an address and send there whatever it read. So:
--
-- 1. clients and client_contacts keep whether their email and phone are as an assistant left them
--    (contact_from_assistant). The database sets it, whatever a request says: on when an assistant
--    adds the record with an email or phone, or changes either; off again once anyone else (a person
--    in Crewtavo, the server) changes them. An assistant's sends leave those addresses out, and say so.
--    Everything else (a person's sends, the rules, reminders) goes to them as before.
-- 2. A rule that emails or texts clients in its own words is turned on by a person, in Crewtavo, where
--    they read those words: an assistant writes it and leaves it off, can turn it off, and doesn't
--    change one that's on. Rules that send nothing of their own are as before.
--
-- supabase/tests/addresses_an_assistant_added_test.sql covers both.

-- ---------------------------------------------------------------------------------------------
-- Addresses an assistant put on file
-- ---------------------------------------------------------------------------------------------

alter table public.clients add column contact_from_assistant boolean not null default false;
alter table public.client_contacts add column contact_from_assistant boolean not null default false;
comment on column public.clients.contact_from_assistant is 'The email and phone are as an AI assistant added or last changed them: an assistant''s own sends leave them out. Set by the database (private.assistant_contact_mark).';
comment on column public.client_contacts.contact_from_assistant is 'As clients.contact_from_assistant, for a contact.';

-- Whether this row's email and phone are as an assistant left them: whatever the request wrote in
-- the column, this decides it.
create function private.assistant_contact_mark() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    new.contact_from_assistant := private.assistant_client() is not null and (new.email is not null or new.phone is not null);
  elsif (new.email, new.phone) is distinct from (old.email, old.phone) then
    new.contact_from_assistant := private.assistant_client() is not null;
  else
    new.contact_from_assistant := old.contact_from_assistant;
  end if;
  return new;
end $$;
revoke all on function private.assistant_contact_mark() from public;
create trigger assistant_contact_mark before insert or update on public.clients
  for each row execute function private.assistant_contact_mark();
create trigger assistant_contact_mark before insert or update on public.client_contacts
  for each row execute function private.assistant_contact_mark();

-- ---------------------------------------------------------------------------------------------
-- Rules that email or text clients
-- ---------------------------------------------------------------------------------------------

/** Whether a rule's actions email or text the client in the rule's own words. */
create function private.rule_messages_clients(p_actions jsonb) returns boolean
language sql immutable set search_path = '' as $$
  select coalesce((select bool_or(a ->> 'type' in ('send_email', 'send_sms')) from jsonb_array_elements(case when jsonb_typeof(p_actions) = 'array' then p_actions else '[]' end) a), false)
$$;

create function private.assistant_rule_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if private.assistant_client() is null or not new.enabled or not private.rule_messages_clients(new.actions) then return new; end if;
  if tg_op = 'INSERT' or not old.enabled or new.actions is distinct from old.actions or new.trigger is distinct from old.trigger or new.conditions is distinct from old.conditions then
    raise exception 'A rule that emails or texts clients is turned on, or changed while it''s on, in Crewtavo, where you can read what it sends. Save it turned off, then turn it on under Automations.'
      using errcode = '42501';
  end if;
  return new;
end $$;
revoke all on function private.assistant_rule_guard() from public;
create trigger assistant_rule_guard before insert or update on public.automation_rules
  for each row execute function private.assistant_rule_guard();

notify pgrst, 'reload schema';
