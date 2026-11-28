-- Team chat voice notes, written out. A voice note is an audio file on a message
-- (20261129100000_chat_files_and_audio.sql), and can carry the words the phone heard while it was
-- recorded (its attachment's "words", from the browser's own speech recognition). When an owner or
-- admin has turned on writing voice notes out with the business's OpenAI key (Chat settings:
-- companies.settings.chat_voice_words), the server writes each one out after it's sent and keeps
-- those words here, beside the message, since a message's files can't change after sending
-- (chat_message_guard). Whoever can see the channel reads them; only the server writes them.

create table public.chat_transcripts (
  company_id uuid not null,
  channel_id uuid not null,
  message_id uuid not null,
  -- The voice note's path, as it is in the message's attachments.
  path text not null,
  words text not null check (length(words) <= 20000),
  created_at timestamptz not null default now(),
  primary key (message_id, path),
  foreign key (company_id, message_id) references public.chat_messages (company_id, id) on delete cascade,
  foreign key (company_id, channel_id) references public.chat_channels (company_id, id) on delete cascade
);
create index chat_transcripts_channel_idx on public.chat_transcripts (channel_id);

alter table public.chat_transcripts enable row level security;
create policy chat_transcripts_read on public.chat_transcripts for select to authenticated
  using (private.chat_can(channel_id, 'see'));

-- The words are the server's: a transcript is only ever of a voice note on its own message.
create function private.chat_transcript_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  select m.company_id, m.channel_id into new.company_id, new.channel_id
  from public.chat_messages m
  where m.id = new.message_id and m.deleted_at is null
    and exists (select 1 from jsonb_array_elements(m.attachments) a where a ->> 'path' = new.path);
  if new.channel_id is null then raise exception 'That voice note isn''t on the message' using errcode = '22023'; end if;
  return new;
end $$;
create trigger chat_transcript_guard before insert or update on public.chat_transcripts
  for each row execute function private.chat_transcript_guard();

-- A deleted message takes its words with it, as it does its files.
create function private.chat_transcripts_follow_delete() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  delete from public.chat_transcripts t where t.message_id = new.id;
  return null;
end $$;
create trigger chat_transcripts_follow_delete after update of deleted_at on public.chat_messages
  for each row when (new.deleted_at is not null and old.deleted_at is null)
  execute function private.chat_transcripts_follow_delete();

revoke all on function private.chat_transcript_guard(), private.chat_transcripts_follow_delete() from public;
