-- Saved for later in team chat: a person marks a message to come back to, and finds it in Saved.
-- One row a person a message. Each person sees only their own, and only while they can still read
-- the message's channel (the rule chat_messages' own policy uses, private.chat_can). A deleted
-- message leaves everyone's saved.

create table public.chat_saved (
  company_id uuid not null,
  channel_id uuid not null,
  message_id uuid not null,
  user_id uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, message_id),
  foreign key (company_id, message_id) references public.chat_messages (company_id, id) on delete cascade,
  foreign key (company_id, channel_id) references public.chat_channels (company_id, id) on delete cascade
);
create index chat_saved_mine_idx on public.chat_saved (user_id, company_id, created_at desc);
create index chat_saved_message_idx on public.chat_saved (message_id);

-- A saved message goes with its message's channel and business, and can't be a deleted one.
create function private.chat_saved_fill() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  select m.channel_id, m.company_id into new.channel_id, new.company_id
  from public.chat_messages m where m.id = new.message_id and m.deleted_at is null;
  if new.channel_id is null then raise exception 'That message is gone' using errcode = '22023'; end if;
  new.created_at := now();
  return new;
end $$;
revoke all on function private.chat_saved_fill() from public;
create trigger chat_saved_fill before insert on public.chat_saved
  for each row execute function private.chat_saved_fill();

-- Deleting a message takes it out of everyone's saved.
create function private.chat_saved_forget() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  delete from public.chat_saved where message_id = new.id;
  return null;
end $$;
revoke all on function private.chat_saved_forget() from public;
create trigger chat_saved_forget after update of deleted_at on public.chat_messages
  for each row when (new.deleted_at is not null and old.deleted_at is null) execute function private.chat_saved_forget();

alter table public.chat_saved enable row level security;
create policy chat_saved_read on public.chat_saved for select to authenticated
  using (user_id = (select auth.uid()) and private.chat_can(channel_id, 'see'));
create policy chat_saved_insert on public.chat_saved for insert to authenticated
  with check (user_id = (select auth.uid()) and private.chat_can(channel_id, 'see'));
create policy chat_saved_delete on public.chat_saved for delete to authenticated
  using (user_id = (select auth.uid()));
-- Nothing about a saved message changes: it's saved, or it's taken out.
revoke update on public.chat_saved from authenticated, anon;
revoke all on public.chat_saved from anon;
