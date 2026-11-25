-- Messages: the office marks a client's conversation done when the client's last message needs no
-- reply ("Thanks!"), so it stops waiting on someone. One mark for the whole office, as a shared inbox
-- has it. A conversation waits while its latest message is the client's and came after the mark (or
-- there's none): a reply ends the wait by itself, and the client writing again starts it again.
--
--   * Its own table, not a column on clients: a client's update runs its own triggers and syncs, and
--     reading a text changes nothing about the client.
--   * The mark is always now, whatever's sent: one dated ahead would hide the client's next messages.

create table public.conversations_done (
  client_id uuid primary key,
  company_id uuid not null references public.companies (id) on delete cascade,
  done_at timestamptz not null default now(),
  done_by uuid references auth.users (id) on delete set null default auth.uid(),
  foreign key (company_id, client_id) references public.clients (company_id, id) on delete cascade
);
-- Those who answer clients' messages (Messages is theirs) read and write it.
select private.apply_policies('conversations_done', '{owner,admin,office,estimator}', '{owner,admin,office,estimator}');

create function private.conversation_done_now() returns trigger language plpgsql as $$
begin
  new.done_at := now();
  new.done_by := auth.uid();
  return new;
end $$;
create trigger done_now before insert or update on public.conversations_done for each row execute function private.conversation_done_now();

-- How many clients' conversations wait on the office: their latest message, of those this person can
-- see, is the client's, and came after any done mark. For the dot on the Messages button; the
-- Messages list works it out the same way for each row.
create function public.waiting_conversations(p_company uuid) returns integer
language sql stable security invoker set search_path = '' as $$
  select count(*)::integer
  from (
    select distinct on (m.client_id) m.client_id, m.direction, m.created_at
    from public.messages m
    where m.company_id = p_company and m.client_id is not null and m.channel in ('sms', 'email', 'note', 'call')
    order by m.client_id, m.created_at desc
  ) latest
  left join public.conversations_done d on d.client_id = latest.client_id
  where latest.direction = 'in' and (d.done_at is null or d.done_at < latest.created_at)
$$;
revoke execute on function public.waiting_conversations(uuid) from public, anon;
grant execute on function public.waiting_conversations(uuid) to authenticated;

-- The new policies look the person's companies up once per query, as every other policy does.
select private.fold_member_checks();
