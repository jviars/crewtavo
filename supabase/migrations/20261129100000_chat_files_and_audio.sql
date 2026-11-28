-- Team chat takes more than photos: documents (PDF, Word, Excel, PowerPoint, text and CSV) and
-- recorded voice notes (audio), each still uploaded to its own channel's folder first, so it follows
-- the channel's rules (20261019001600_team_chat.sql). The endings a message's files may have are kept
-- in one place, private.chat_file_endings(). Otherwise chat_message_guard() is as before.

create function private.chat_file_endings() returns text
language sql immutable set search_path = '' as $$
  select 'jpg|jpeg|png|webp|gif|heic|heif'
    || '|pdf|doc|docx|xls|xlsx|csv|txt|rtf|ppt|pptx|odt|ods|odp'
    || '|webm|weba|m4a|mp4|aac|mp3|mpga|ogg|oga|opus|wav'
$$;
revoke execute on function private.chat_file_endings() from public;
grant execute on function private.chat_file_endings() to authenticated, service_role;

create or replace function private.chat_message_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid := (select auth.uid());
  v_author boolean;
  v_manager boolean;
  v_bad boolean;
begin
  if tg_op = 'INSERT' then
    new.created_at := now();
    new.edited_at := null;
    new.deleted_at := null;
    new.pinned_at := null;
    new.pinned_by := null;
  else
    if (new.company_id, new.channel_id, new.author_id, new.created_at) is distinct from (old.company_id, old.channel_id, old.author_id, old.created_at) then
      raise exception 'A message can''t be moved or reassigned' using errcode = '42501';
    end if;
    if old.deleted_at is not null then
      raise exception 'That message was deleted' using errcode = '42501';
    end if;
    -- A deleted job or replied-to message clears its link here.
    if (new.job_id is null and old.job_id is not null) or (new.reply_to is null and old.reply_to is not null) then
      if (new.body, new.attachments, new.pinned_at, new.deleted_at) is not distinct from (old.body, old.attachments, old.pinned_at, old.deleted_at) then
        return new;
      end if;
    end if;
    v_author := v_user is not null and v_user = old.author_id;
    v_manager := v_user is null or private.chat_can(old.channel_id, 'manage');
    if new.deleted_at is not null then
      if not (v_author or v_manager) then raise exception 'You can only delete your own messages' using errcode = '42501'; end if;
      new.deleted_at := now();
      new.body := '';
      new.attachments := '[]';
      new.job_id := null;
      new.mention_users := '{}';
      new.mention_roles := '{}';
      new.mention_all := false;
      new.pinned_at := null;
      new.pinned_by := null;
      return new;
    end if;
    if (new.attachments, new.job_id, new.reply_to) is distinct from (old.attachments, old.job_id, old.reply_to) then
      raise exception 'Files and links can''t be changed after sending' using errcode = '42501';
    end if;
    if new.pinned_at is distinct from old.pinned_at then
      if not v_manager then raise exception 'Only people who manage this channel can pin messages' using errcode = '42501'; end if;
      if new.pinned_at is null then new.pinned_by := null; else new.pinned_at := now(); new.pinned_by := v_user; end if;
    else
      new.pinned_by := old.pinned_by;
    end if;
    if new.body is distinct from old.body then
      if v_user is not null and not (v_author and private.chat_can(old.channel_id, 'post')) then
        raise exception 'You can only edit your own messages' using errcode = '42501';
      end if;
      new.edited_at := now();
    else
      new.edited_at := old.edited_at;
      new.mention_users := old.mention_users;
      new.mention_roles := old.mention_roles;
      new.mention_all := old.mention_all;
      return new;
    end if;
  end if;

  if length(trim(new.body)) = 0 and jsonb_array_length(new.attachments) = 0 and new.job_id is null then
    raise exception 'Write a message first' using errcode = '23514';
  end if;
  select exists (
    select 1 from jsonb_array_elements(new.attachments) a
    where jsonb_typeof(a) <> 'object'
       or coalesce(a ->> 'path', '') !~ ('^' || new.company_id || '/chat/' || new.channel_id || '/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(' || private.chat_file_endings() || ')$')
  ) into v_bad;
  if v_bad then
    raise exception 'Files must be uploaded to this channel first' using errcode = '22023';
  end if;
  if new.reply_to is not null and not exists (select 1 from public.chat_messages r where r.id = new.reply_to and r.channel_id = new.channel_id) then
    raise exception 'You can only reply to a message in the same channel' using errcode = '22023';
  end if;
  new := private.chat_read_mentions(new);
  return new;
end $$;
