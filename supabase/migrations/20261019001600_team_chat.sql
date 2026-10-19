-- Team chat: channels for the whole team, a crew or the office, with messages, photos, reactions,
-- pins and who has read what. Off until an owner or admin turns it on from Apps, which keeps the
-- switch in companies.settings.team_chat.enabled. Turning it off hides chat and keeps every
-- message; turning it back on brings them back.
--
-- Who sees what goes by role, the same roles as Settings -> Roles. For each channel, each access
-- level (admin, office, estimator, crew_lead, field_crew) and each custom role has a rule: can see
-- the channel, can post in it, can manage it (pin, change the topic, remove other people's
-- messages). A custom role with no rule of its own for a channel follows its access level's.
-- Owners can always do everything. A crew's channel can also be limited, per role, to the people
-- on that crew (chat_role_settings.own_crew_only).
--
-- Mentions are tokens in the message text: <@user id>, <@&role> (an access level such as
-- field_crew, or a custom role's id) and @everyone. The database reads them out of the text, so
-- nobody can ping people the text doesn't name, and turns them into notifications for the people
-- who can see the channel.

-- ---------------------------------------------------------------------------------------------
-- On or off, and who runs it
-- ---------------------------------------------------------------------------------------------

create function private.chat_enabled(p_company uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select (c.settings -> 'team_chat' -> 'enabled') = 'true'::jsonb from public.companies c where c.id = p_company), false)
$$;

-- Owners and admins set up channels and roles.
create function private.chat_admin(p_company uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select private.has_role(p_company, '{owner,admin}')
$$;

-- ---------------------------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------------------------

create table public.chat_channels (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  kind text not null default 'text' check (kind in ('text', 'announcement')),
  -- Text channels have a short lower-case name (#north-crew); an announcement channel's is a title.
  name text not null check (length(name) between 1 and 50),
  category text not null default 'Company' check (length(trim(category)) between 1 and 40),
  topic text check (length(topic) <= 300),
  -- A crew's own channel. Its people can be the only ones who see it (chat_role_settings.own_crew_only).
  crew_id uuid,
  position integer not null default 0,
  archived_at timestamptz,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, id),
  foreign key (company_id, crew_id) references public.crews (company_id, id) on delete set null (crew_id),
  check (kind = 'announcement' or name ~ '^[a-z0-9]+(-[a-z0-9]+)*$')
);
create unique index chat_channels_name_idx on public.chat_channels (company_id, lower(name));
create index chat_channels_crew_idx on public.chat_channels (company_id, crew_id) where crew_id is not null;

-- What each role can do in each channel.
create table public.chat_role_rules (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  channel_id uuid not null,
  role public.member_role check (role is distinct from 'owner'),
  role_id uuid,
  can_see boolean not null default false,
  can_post boolean not null default false,
  can_manage boolean not null default false,
  check ((role is null) <> (role_id is null)),
  check (can_see or not (can_post or can_manage)),
  foreign key (company_id, channel_id) references public.chat_channels (company_id, id) on delete cascade,
  foreign key (company_id, role_id) references public.company_roles (company_id, id) on delete cascade
);
create unique index chat_role_rules_level_idx on public.chat_role_rules (channel_id, role) where role is not null;
create unique index chat_role_rules_custom_idx on public.chat_role_rules (channel_id, role_id) where role_id is not null;
create index chat_role_rules_company_idx on public.chat_role_rules (company_id);

-- How each role looks and behaves in chat.
create table public.chat_role_settings (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  role public.member_role,
  role_id uuid,
  color text not null default 'default' check (color in ('amber', 'orange', 'ruby', 'purple', 'blue', 'teal', 'green', 'default')),
  -- Its own group in the member list ("Crew lead — 2") rather than with everyone else.
  show_separately boolean not null default true,
  -- Anyone can @mention it. Otherwise only owners, admins, office and the channel's managers can.
  mentionable boolean not null default true,
  -- Crew channels: only the crews this person is on (or leads).
  own_crew_only boolean not null default false,
  updated_at timestamptz not null default now(),
  check ((role is null) <> (role_id is null)),
  foreign key (company_id, role_id) references public.company_roles (company_id, id) on delete cascade
);
create unique index chat_role_settings_level_idx on public.chat_role_settings (company_id, role) where role is not null;
create unique index chat_role_settings_custom_idx on public.chat_role_settings (company_id, role_id) where role_id is not null;

create table public.chat_messages (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  channel_id uuid not null,
  -- Empty for messages Crewtavo posts itself.
  author_id uuid references auth.users (id) on delete set null,
  body text not null default '' check (length(body) <= 4000),
  -- Photos: [{ "path": "<company>/chat/<channel>/<uuid>.jpg", "name", "type", "size", "width", "height" }]
  attachments jsonb not null default '[]' check (jsonb_typeof(attachments) = 'array' and jsonb_array_length(attachments) <= 6),
  job_id uuid,
  reply_to uuid,
  -- Read out of the body by chat_message_guard(); never set directly.
  mention_users uuid[] not null default '{}',
  mention_roles text[] not null default '{}',
  mention_all boolean not null default false,
  pinned_at timestamptz,
  pinned_by uuid references auth.users (id) on delete set null,
  edited_at timestamptz,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  unique (company_id, id),
  foreign key (company_id, channel_id) references public.chat_channels (company_id, id) on delete cascade,
  foreign key (company_id, job_id) references public.jobs (company_id, id) on delete set null (job_id),
  foreign key (company_id, reply_to) references public.chat_messages (company_id, id) on delete set null (reply_to)
);
create index chat_messages_channel_idx on public.chat_messages (channel_id, created_at desc);
create index chat_messages_pinned_idx on public.chat_messages (channel_id) where pinned_at is not null;

create table public.chat_reactions (
  company_id uuid not null,
  channel_id uuid not null,
  message_id uuid not null,
  user_id uuid not null references auth.users (id) on delete cascade,
  kind text not null check (kind in ('thumbs_up', 'on_it', 'seen')),
  created_at timestamptz not null default now(),
  primary key (message_id, user_id, kind),
  foreign key (company_id, message_id) references public.chat_messages (company_id, id) on delete cascade,
  foreign key (company_id, channel_id) references public.chat_channels (company_id, id) on delete cascade
);
create index chat_reactions_channel_idx on public.chat_reactions (channel_id);

-- How far each person has read each channel. Written only by chat_mark_read().
create table public.chat_reads (
  company_id uuid not null,
  channel_id uuid not null,
  user_id uuid not null references auth.users (id) on delete cascade,
  last_read_at timestamptz not null default now(),
  primary key (channel_id, user_id),
  foreign key (company_id, channel_id) references public.chat_channels (company_id, id) on delete cascade
);

select private.add_touch_triggers(array['chat_channels', 'chat_role_settings']);

-- ---------------------------------------------------------------------------------------------
-- Who can see, post and manage
-- ---------------------------------------------------------------------------------------------

create function private.chat_rights(p_channel uuid, p_user uuid, out can_see boolean, out can_post boolean, out can_manage boolean)
language plpgsql stable security definer set search_path = '' as $$
declare
  ch record;
  m record;
  rule record;
  own_only boolean;
begin
  can_see := false;
  can_post := false;
  can_manage := false;
  select c.company_id, c.crew_id, c.archived_at into ch from public.chat_channels c where c.id = p_channel;
  if not found or not private.chat_enabled(ch.company_id) then return; end if;
  select mb.role, mb.role_id into m from public.memberships mb where mb.company_id = ch.company_id and mb.user_id = p_user and mb.active;
  if not found then return; end if;
  if m.role = 'owner' then
    can_see := true;
    can_manage := true;
    can_post := ch.archived_at is null;
    return;
  end if;
  -- The custom role's own rule, else its access level's.
  select r.can_see, r.can_post, r.can_manage into rule from public.chat_role_rules r
  where r.channel_id = p_channel and ((m.role_id is not null and r.role_id = m.role_id) or r.role = m.role)
  order by (r.role_id is not null) desc
  limit 1;
  if not found or not rule.can_see then return; end if;
  if ch.crew_id is not null then
    select s.own_crew_only into own_only from public.chat_role_settings s
    where s.company_id = ch.company_id and ((m.role_id is not null and s.role_id = m.role_id) or s.role = m.role)
    order by (s.role_id is not null) desc
    limit 1;
    if coalesce(own_only, false)
       and not exists (select 1 from public.crews c where c.id = ch.crew_id and c.lead_user_id = p_user)
       and not exists (select 1 from public.crew_members cm where cm.crew_id = ch.crew_id and cm.user_id = p_user) then
      return;
    end if;
  end if;
  can_manage := rule.can_manage;
  if ch.archived_at is null then
    can_see := true;
    can_post := rule.can_post;
  else
    -- An archived channel is read-only, and only its managers still see it (to bring it back).
    can_see := rule.can_manage;
  end if;
end $$;

-- For the signed-in person: 'see', 'post' or 'manage'.
create function private.chat_can(p_channel uuid, p_what text) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((
    select case p_what when 'see' then r.can_see when 'post' then r.can_post when 'manage' then r.can_manage else false end
    from private.chat_rights(p_channel, (select auth.uid())) r
  ), false)
$$;

-- The key a person's role goes by in chat: their custom role's id, else their access level.
create function private.chat_role_key(p_company uuid, p_user uuid) returns text
language sql stable security definer set search_path = '' as $$
  select coalesce(m.role_id::text, m.role::text) from public.memberships m where m.company_id = p_company and m.user_id = p_user
$$;

-- "Crew lead", or a custom role's name.
create function private.chat_role_label(p_company uuid, p_key text) returns text
language sql stable security definer set search_path = '' as $$
  select case p_key
    when 'owner' then 'Owner' when 'admin' then 'Admin' when 'office' then 'Office'
    when 'estimator' then 'Estimator' when 'crew_lead' then 'Crew lead' when 'field_crew' then 'Field crew'
    else (select r.name from public.company_roles r
          where r.company_id = p_company
            and r.id = case when p_key ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then p_key::uuid end)
  end
$$;

-- Can anyone @mention this role? A custom role without settings of its own follows its access level.
create function private.chat_mentionable(p_company uuid, p_key text) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((
    select s.mentionable from public.chat_role_settings s
    left join public.company_roles r on r.company_id = s.company_id
      and r.id = case when p_key ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then p_key::uuid end
    where s.company_id = p_company and (s.role::text = p_key or s.role_id::text = p_key or s.role = r.base_role)
    order by (s.role_id is not null) desc, (s.role::text = p_key) desc
    limit 1
  ), true)
$$;

-- Chat photos live at <company>/chat/<channel>/<file>: only people who can see the channel read them,
-- and only people who can post in it add them.
create function private.chat_file_channel(p_name text) returns uuid
language sql stable security definer set search_path = '' as $$
  select c.id from public.chat_channels c
  where c.id = case when split_part(p_name, '/', 3) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then split_part(p_name, '/', 3)::uuid end
    and c.company_id = private.path_company(p_name)
$$;

grant execute on function private.chat_enabled(uuid), private.chat_admin(uuid), private.chat_rights(uuid, uuid),
  private.chat_can(uuid, text), private.chat_role_key(uuid, uuid), private.chat_role_label(uuid, text),
  private.chat_mentionable(uuid, text), private.chat_file_channel(text) to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------------------------

alter table public.chat_channels enable row level security;
create policy chat_channels_read on public.chat_channels for select to authenticated
  using (private.chat_can(id, 'see') or (private.chat_admin(company_id) and private.chat_enabled(company_id)));
create policy chat_channels_insert on public.chat_channels for insert to authenticated
  with check (private.chat_admin(company_id));
create policy chat_channels_update on public.chat_channels for update to authenticated
  using (private.chat_admin(company_id) or private.chat_can(id, 'manage'))
  with check (private.chat_admin(company_id) or private.chat_can(id, 'manage'));
create policy chat_channels_delete on public.chat_channels for delete to authenticated
  using (private.chat_admin(company_id));

-- Rules and settings change through chat_save_roles() only.
alter table public.chat_role_rules enable row level security;
create policy chat_role_rules_read on public.chat_role_rules for select to authenticated
  using (private.chat_admin(company_id) or private.chat_can(channel_id, 'see'));
alter table public.chat_role_settings enable row level security;
create policy chat_role_settings_read on public.chat_role_settings for select to authenticated
  using (private.is_member(company_id));

alter table public.chat_messages enable row level security;
create policy chat_messages_read on public.chat_messages for select to authenticated
  using (private.chat_can(channel_id, 'see'));
create policy chat_messages_insert on public.chat_messages for insert to authenticated
  with check (author_id = (select auth.uid()) and private.chat_can(channel_id, 'post'));
-- What an update may change is checked by chat_message_guard(): authors edit and delete their own,
-- managers pin and remove anyone's.
create policy chat_messages_update on public.chat_messages for update to authenticated
  using (private.chat_can(channel_id, 'see') and (author_id = (select auth.uid()) or private.chat_can(channel_id, 'manage')))
  with check (private.chat_can(channel_id, 'see'));

alter table public.chat_reactions enable row level security;
create policy chat_reactions_read on public.chat_reactions for select to authenticated
  using (private.chat_can(channel_id, 'see'));
create policy chat_reactions_insert on public.chat_reactions for insert to authenticated
  with check (user_id = (select auth.uid()) and private.chat_can(channel_id, 'see'));
create policy chat_reactions_delete on public.chat_reactions for delete to authenticated
  using (user_id = (select auth.uid()));

alter table public.chat_reads enable row level security;
create policy chat_reads_read on public.chat_reads for select to authenticated
  using (user_id = (select auth.uid()) and private.is_member(company_id));

-- Photos in chat follow the channel. Receipts keep following expense privacy (20261018000100).
drop policy files_read on storage.objects;
create policy files_read on storage.objects for select to authenticated using (
  bucket_id = 'files' and private.is_member(private.path_company(name)) and (
    split_part(name, '/', 2) not in ('receipts', 'chat')
    or (split_part(name, '/', 2) = 'receipts' and (owner = (select auth.uid()) or private.has_perm(private.path_company(name), 'job_costs')))
    or (split_part(name, '/', 2) = 'chat' and private.chat_can(private.chat_file_channel(name), 'see'))
  )
);
create policy files_chat_insert on storage.objects as restrictive for insert to authenticated with check (
  bucket_id <> 'files' or split_part(name, '/', 2) <> 'chat' or private.chat_can(private.chat_file_channel(name), 'post')
);

-- ---------------------------------------------------------------------------------------------
-- Guards
-- ---------------------------------------------------------------------------------------------

-- Managers who aren't owners or admins only change a channel's topic.
create function private.chat_channel_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if (select auth.uid()) is not null and not private.chat_admin(old.company_id)
     and (new.name, new.kind, new.category, new.crew_id, new.position, new.archived_at, new.company_id)
         is distinct from (old.name, old.kind, old.category, old.crew_id, old.position, old.archived_at, old.company_id) then
    raise exception 'Only owners and admins can change that about a channel' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger chat_channel_guard before update on public.chat_channels
  for each row execute function private.chat_channel_guard();

-- Mentions, read from the text. @everyone needs the channel's manage right; a role that isn't open
-- to mentions needs owner, admin, office or a manager; anything else stays as plain text.
create function private.chat_read_mentions(p_message public.chat_messages) returns public.chat_messages
language plpgsql stable security definer set search_path = '' as $$
declare
  v_user uuid := (select auth.uid());
  v_trusted boolean;
begin
  p_message.mention_users := coalesce((
    select array_agg(distinct x[1]::uuid)
    from regexp_matches(p_message.body, '<@([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})>', 'g') as t(x)
  ), '{}');
  p_message.mention_roles := coalesce((
    select array_agg(distinct x[1])
    from regexp_matches(p_message.body, '<@&([a-z_]+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})>', 'g') as t(x)
  ), '{}');
  p_message.mention_all := p_message.body ~ '(^|[^A-Za-z0-9_<])@everyone([^A-Za-z0-9_]|$)';
  if v_user is not null then
    v_trusted := private.chat_can(p_message.channel_id, 'manage');
    if p_message.mention_all and not v_trusted then p_message.mention_all := false; end if;
    if not (v_trusted or private.has_role(p_message.company_id, '{owner,admin,office}')) then
      p_message.mention_roles := coalesce((
        select array_agg(k) from unnest(p_message.mention_roles) as k where private.chat_mentionable(p_message.company_id, k)
      ), '{}');
    end if;
  end if;
  return p_message;
end $$;

create function private.chat_message_guard() returns trigger
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
      raise exception 'Photos and links can''t be changed after sending' using errcode = '42501';
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
       or coalesce(a ->> 'path', '') !~ ('^' || new.company_id || '/chat/' || new.channel_id || '/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|jpeg|png|webp|gif|heic|heif)$')
  ) into v_bad;
  if v_bad then
    raise exception 'Photos must be uploaded to this channel first' using errcode = '22023';
  end if;
  if new.reply_to is not null and not exists (select 1 from public.chat_messages r where r.id = new.reply_to and r.channel_id = new.channel_id) then
    raise exception 'You can only reply to a message in the same channel' using errcode = '22023';
  end if;
  new := private.chat_read_mentions(new);
  return new;
end $$;
create trigger chat_message_guard before insert or update on public.chat_messages
  for each row execute function private.chat_message_guard();

-- Reactions go with their message's channel, and not on deleted messages.
create function private.chat_reaction_fill() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  select m.channel_id, m.company_id into new.channel_id, new.company_id
  from public.chat_messages m where m.id = new.message_id and m.deleted_at is null;
  if new.channel_id is null then raise exception 'That message is gone' using errcode = '22023'; end if;
  new.created_at := now();
  return new;
end $$;
create trigger chat_reaction_fill before insert on public.chat_reactions
  for each row execute function private.chat_reaction_fill();

-- ---------------------------------------------------------------------------------------------
-- Mentions become notifications (the bell, and push, email or text by each person's choices)
-- ---------------------------------------------------------------------------------------------

-- A message as plain text: <@id> and <@&role> become @names.
create function private.chat_plain(p_company uuid, p_body text) returns text
language plpgsql stable security definer set search_path = '' as $$
declare
  v text := p_body;
  r record;
begin
  for r in select distinct x[1] as id from regexp_matches(p_body, '<@([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})>', 'g') as t(x) loop
    v := replace(v, '<@' || r.id || '>', '@' || coalesce((select nullif(p.full_name, '') from public.profiles p where p.user_id = r.id::uuid), 'someone'));
  end loop;
  for r in select distinct x[1] as k from regexp_matches(p_body, '<@&([a-z_]+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})>', 'g') as t(x) loop
    v := replace(v, '<@&' || r.k || '>', '@' || coalesce(private.chat_role_label(p_company, r.k), 'role'));
  end loop;
  return v;
end $$;

create function private.chat_notify_mentions() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_name text;
  v_where text;
  v_text text;
begin
  if not (new.mention_all or cardinality(new.mention_users) > 0 or cardinality(new.mention_roles) > 0) then return null; end if;
  select case when c.kind = 'announcement' then c.name else '#' || c.name end into v_where from public.chat_channels c where c.id = new.channel_id;
  v_name := coalesce((select coalesce(nullif(p.full_name, ''), p.email) from public.profiles p where p.user_id = new.author_id), 'Crewtavo');
  v_text := nullif(left(regexp_replace(private.chat_plain(new.company_id, new.body), '\s+', ' ', 'g'), 140), '');
  insert into public.notifications (company_id, user_id, kind, title, body, link)
  select new.company_id, m.user_id, 'chat',
    case when m.user_id = any (new.mention_users) or coalesce(m.role_id::text, m.role::text) = any (new.mention_roles)
      then v_name || ' mentioned you in ' || v_where
      else v_name || ' posted in ' || v_where end,
    coalesce(v_text, 'Sent a photo'),
    '/chat/' || new.channel_id || '?message=' || new.id
  from public.memberships m
  where m.company_id = new.company_id and m.active and m.user_id is distinct from new.author_id
    and (new.mention_all or m.user_id = any (new.mention_users) or coalesce(m.role_id::text, m.role::text) = any (new.mention_roles))
    and (private.chat_rights(new.channel_id, m.user_id)).can_see;
  return null;
end $$;
create trigger chat_notify_mentions after insert on public.chat_messages
  for each row execute function private.chat_notify_mentions();

-- "Team chat" is a notification topic of its own, by push unless someone turns it off.
do $$
declare c text;
begin
  for c in select conname from pg_constraint where conrelid = 'public.notification_prefs'::regclass and contype = 'c' loop
    execute format('alter table public.notification_prefs drop constraint %I', c);
  end loop;
end $$;
alter table public.notification_prefs add constraint notification_prefs_topics_check check (
  email <@ array['schedule','client','equipment','time','alerts','chat']
  and sms <@ array['schedule','client','equipment','time','alerts','chat']
  and push <@ array['schedule','client','equipment','time','alerts','chat']
);
alter table public.notification_prefs alter column push set default '{schedule,client,equipment,time,alerts,chat}';
update public.notification_prefs set push = array_append(push, 'chat') where not ('chat' = any (push));

-- ---------------------------------------------------------------------------------------------
-- Setting it up
-- ---------------------------------------------------------------------------------------------

-- A free text channel name for a title: "North Crew" -> north-crew, unique in the company.
create function private.chat_slug(p_company uuid, p_name text) returns text
language plpgsql stable security definer set search_path = '' as $$
declare
  base text := trim(both '-' from left(trim(both '-' from lower(regexp_replace(coalesce(p_name, ''), '[^a-zA-Z0-9]+', '-', 'g'))), 44));
  candidate text;
  n integer := 1;
begin
  if base = '' then base := 'channel'; end if;
  candidate := base;
  while exists (select 1 from public.chat_channels c where c.company_id = p_company and lower(c.name) = candidate) loop
    n := n + 1;
    candidate := base || '-' || n;
  end loop;
  return candidate;
end $$;

-- Starting rules for a channel. everyone: the whole team talks; announcement: the whole team
-- reads, admins and office post; office: admins, office and estimators; crew: the whole team, with
-- crew leads managing (field crew only see their own crew's, by chat_role_settings).
create function private.chat_default_rules(p_channel uuid, p_preset text) returns void
language plpgsql security definer set search_path = '' as $$
declare v_company uuid;
begin
  select company_id into v_company from public.chat_channels where id = p_channel;
  insert into public.chat_role_rules (company_id, channel_id, role, can_see, can_post, can_manage)
  select v_company, p_channel, lvl,
    case p_preset when 'office' then lvl in ('admin', 'office', 'estimator') else true end,
    case p_preset when 'office' then lvl in ('admin', 'office', 'estimator') when 'announcement' then lvl in ('admin', 'office') else true end,
    case p_preset when 'crew' then lvl in ('admin', 'office', 'crew_lead') else lvl in ('admin', 'office') end
  from unnest(array['admin', 'office', 'estimator', 'crew_lead', 'field_crew']::public.member_role[]) as lvl;
end $$;

create function private.chat_install(p_company uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_channel uuid;
  v_position integer := 10;
  crew record;
begin
  insert into public.chat_role_settings (company_id, role, color, own_crew_only) values
    (p_company, 'owner', 'amber', false),
    (p_company, 'admin', 'purple', false),
    (p_company, 'office', 'blue', false),
    (p_company, 'estimator', 'ruby', false),
    (p_company, 'crew_lead', 'green', false),
    (p_company, 'field_crew', 'default', true)
  on conflict do nothing;

  insert into public.chat_channels (company_id, kind, name, category, topic, position)
  values (p_company, 'announcement', 'Announcements', 'Company', 'News from the office for the whole team.', 0) returning id into v_channel;
  perform private.chat_default_rules(v_channel, 'announcement');
  insert into public.chat_channels (company_id, name, category, topic, position)
  values (p_company, 'general', 'Company', 'Anything for the whole team.', 1) returning id into v_channel;
  perform private.chat_default_rules(v_channel, 'everyone');

  for crew in select c.id, c.name from public.crews c where c.company_id = p_company and c.active order by c.name loop
    insert into public.chat_channels (company_id, name, category, topic, crew_id, position)
    values (p_company, private.chat_slug(p_company, crew.name), 'Crews', 'Everything for ' || crew.name || '.', crew.id, v_position) returning id into v_channel;
    perform private.chat_default_rules(v_channel, 'crew');
    v_position := v_position + 1;
  end loop;

  insert into public.chat_channels (company_id, name, category, topic, position)
  values (p_company, private.chat_slug(p_company, 'office'), 'Office', 'Scheduling, quotes and billing.', 100) returning id into v_channel;
  perform private.chat_default_rules(v_channel, 'office');
end $$;

-- A new crew gets its own channel once chat has been set up.
create function private.chat_crew_channel() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_channel uuid;
begin
  if not exists (select 1 from public.chat_channels c where c.company_id = new.company_id) then return null; end if;
  insert into public.chat_channels (company_id, name, category, topic, crew_id, position)
  values (new.company_id, private.chat_slug(new.company_id, new.name), 'Crews', 'Everything for ' || new.name || '.', new.id,
          coalesce((select max(c.position) + 1 from public.chat_channels c where c.company_id = new.company_id and c.category = 'Crews'), 10))
  returning id into v_channel;
  perform private.chat_default_rules(v_channel, 'crew');
  return null;
end $$;
create trigger chat_crew_channel after insert on public.crews
  for each row execute function private.chat_crew_channel();

revoke execute on function private.chat_read_mentions(public.chat_messages), private.chat_plain(uuid, text), private.chat_slug(uuid, text),
  private.chat_default_rules(uuid, text), private.chat_install(uuid) from public;

-- ---------------------------------------------------------------------------------------------
-- What the app calls
-- ---------------------------------------------------------------------------------------------

-- Turn chat on or off (Apps -> Team chat). The first time, it sets up starter channels and roles.
create function public.chat_set_enabled(p_company uuid, p_enabled boolean) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if not (private.has_role(p_company, '{owner,admin}') and private.has_perm(p_company, 'apps')) then
    raise exception 'Only owners and admins who connect apps can turn team chat on or off' using errcode = '42501';
  end if;
  update public.companies
  set settings = jsonb_set(coalesce(settings, '{}'), '{team_chat}', coalesce(settings -> 'team_chat', '{}') || jsonb_build_object('enabled', p_enabled, 'changed_at', now()))
  where id = p_company;
  if p_enabled and not exists (select 1 from public.chat_channels where company_id = p_company) then
    perform private.chat_install(p_company);
  end if;
  return p_enabled;
end $$;

-- The channels I can see, with what I can do in each and what's new since I last looked.
create function public.chat_overview(p_company uuid)
returns table (
  id uuid, kind text, name text, category text, topic text, crew_id uuid, "position" integer, archived boolean,
  can_post boolean, can_manage boolean, unread integer, mentions integer, last_message_at timestamptz
)
language sql stable security definer set search_path = '' as $$
  with me as (
    select m.user_id, m.created_at, coalesce(m.role_id::text, m.role::text) as role_key
    from public.memberships m where m.company_id = p_company and m.user_id = (select auth.uid()) and m.active
  ),
  visible as (
    select c.*, r.can_post as may_post, r.can_manage as may_manage
    from public.chat_channels c
    cross join lateral private.chat_rights(c.id, (select auth.uid())) r
    where c.company_id = p_company and r.can_see
  )
  select v.id, v.kind, v.name, v.category, v.topic, v.crew_id, v.position, v.archived_at is not null, v.may_post, v.may_manage,
    coalesce(n.unread, 0)::integer, coalesce(n.mentions, 0)::integer, n.last_at
  from visible v
  cross join me
  left join public.chat_reads rd on rd.channel_id = v.id and rd.user_id = me.user_id
  left join lateral (
    select
      count(*) filter (where msg.created_at > coalesce(rd.last_read_at, me.created_at) and msg.author_id is distinct from me.user_id) as unread,
      count(*) filter (where msg.created_at > coalesce(rd.last_read_at, me.created_at) and msg.author_id is distinct from me.user_id
                        and (msg.mention_all or me.user_id = any (msg.mention_users) or me.role_key = any (msg.mention_roles))) as mentions,
      max(msg.created_at) as last_at
    from public.chat_messages msg
    where msg.channel_id = v.id and msg.deleted_at is null
  ) n on true
  order by v.position, v.name
$$;

-- Everyone who can see a channel, with how their role looks in chat.
create function public.chat_members(p_channel uuid)
returns table (user_id uuid, full_name text, avatar_color text, role public.member_role, role_id uuid, role_key text, role_name text, color text, show_separately boolean)
language sql stable security definer set search_path = '' as $$
  select m.user_id, coalesce(nullif(p.full_name, ''), p.email, 'Someone'), p.color, m.role, m.role_id,
    coalesce(m.role_id::text, m.role::text),
    coalesce(cr.name, private.chat_role_label(m.company_id, m.role::text)),
    coalesce(s.color, 'default'), coalesce(s.show_separately, true)
  from public.chat_channels c
  join public.memberships m on m.company_id = c.company_id and m.active
  left join public.profiles p on p.user_id = m.user_id
  left join public.company_roles cr on cr.id = m.role_id
  left join lateral (
    select st.color, st.show_separately from public.chat_role_settings st
    where st.company_id = c.company_id and ((m.role_id is not null and st.role_id = m.role_id) or st.role = m.role)
    order by (st.role_id is not null) desc limit 1
  ) s on true
  where c.id = p_channel and private.chat_can(p_channel, 'see') and (private.chat_rights(p_channel, m.user_id)).can_see
  order by 2
$$;

-- I've read this channel up to now. Its mention notifications count as read too.
create function public.chat_mark_read(p_channel uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v_company uuid;
begin
  if not private.chat_can(p_channel, 'see') then
    raise exception 'You can''t see that channel' using errcode = '42501';
  end if;
  select company_id into v_company from public.chat_channels where id = p_channel;
  insert into public.chat_reads (company_id, channel_id, user_id, last_read_at)
  values (v_company, p_channel, (select auth.uid()), now())
  on conflict (channel_id, user_id) do update set last_read_at = greatest(public.chat_reads.last_read_at, excluded.last_read_at);
  update public.notifications set read_at = now()
  where user_id = (select auth.uid()) and company_id = v_company and kind = 'chat' and read_at is null
    and link like '/chat/' || p_channel || '%';
end $$;

-- Who should get a live update about a channel (the server's live connection, service key only).
create function public.chat_audience(p_channel uuid) returns setof uuid
language sql stable security definer set search_path = '' as $$
  select m.user_id from public.chat_channels c
  join public.memberships m on m.company_id = c.company_id and m.active
  where c.id = p_channel and (private.chat_rights(p_channel, m.user_id)).can_see
$$;

-- A new channel with starting rules: 'everyone', 'announcement', 'office' or 'crew' (with p_crew).
create function public.chat_create_channel(p_company uuid, p_name text, p_preset text, p_category text default null, p_topic text default null, p_crew uuid default null)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_channel uuid;
  v_announcement boolean := p_preset = 'announcement';
begin
  if not private.chat_admin(p_company) then raise exception 'Only owners and admins can add channels' using errcode = '42501'; end if;
  if p_preset not in ('everyone', 'announcement', 'office', 'crew') then raise exception 'Unknown kind of channel' using errcode = '22023'; end if;
  if p_preset = 'crew' and not exists (select 1 from public.crews c where c.id = p_crew and c.company_id = p_company) then
    raise exception 'Choose one of your crews' using errcode = '22023';
  end if;
  insert into public.chat_channels (company_id, kind, name, category, topic, crew_id, position, created_by)
  values (
    p_company,
    case when v_announcement then 'announcement' else 'text' end,
    case when v_announcement then left(trim(p_name), 50) else private.chat_slug(p_company, p_name) end,
    coalesce(nullif(trim(p_category), ''), case p_preset when 'crew' then 'Crews' when 'office' then 'Office' else 'Company' end),
    nullif(trim(p_topic), ''),
    case when p_preset = 'crew' then p_crew end,
    coalesce((select max(c.position) + 1 from public.chat_channels c where c.company_id = p_company), 0),
    (select auth.uid())
  ) returning id into v_channel;
  perform private.chat_default_rules(v_channel, p_preset);
  return v_channel;
end $$;

-- Save Chat settings -> Roles in one go: how each role looks, and its rule in each channel.
--   p_settings: [{ "role" | "role_id", "color", "show_separately", "mentionable", "own_crew_only" }]
--   p_rules:    [{ "channel_id", "role" | "role_id", "can_see", "can_post", "can_manage" }]
create function public.chat_save_roles(p_company uuid, p_settings jsonb, p_rules jsonb) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not private.chat_admin(p_company) then raise exception 'Only owners and admins can change chat roles' using errcode = '42501'; end if;
  if jsonb_typeof(p_settings) <> 'array' or jsonb_typeof(p_rules) <> 'array' then raise exception 'Settings and rules must be lists' using errcode = '22023'; end if;

  delete from public.chat_role_settings where company_id = p_company;
  insert into public.chat_role_settings (company_id, role, role_id, color, show_separately, mentionable, own_crew_only)
  select p_company, nullif(s ->> 'role', '')::public.member_role, nullif(s ->> 'role_id', '')::uuid,
    coalesce(s ->> 'color', 'default'), coalesce((s ->> 'show_separately')::boolean, true),
    coalesce((s ->> 'mentionable')::boolean, true), coalesce((s ->> 'own_crew_only')::boolean, false)
  from jsonb_array_elements(p_settings) s;

  -- Only rules for this company's channels; owners need none.
  delete from public.chat_role_rules where company_id = p_company;
  insert into public.chat_role_rules (company_id, channel_id, role, role_id, can_see, can_post, can_manage)
  select p_company, (r ->> 'channel_id')::uuid, nullif(r ->> 'role', '')::public.member_role, nullif(r ->> 'role_id', '')::uuid,
    coalesce((r ->> 'can_see')::boolean, false),
    coalesce((r ->> 'can_see')::boolean, false) and coalesce((r ->> 'can_post')::boolean, false),
    coalesce((r ->> 'can_see')::boolean, false) and coalesce((r ->> 'can_manage')::boolean, false)
  from jsonb_array_elements(p_rules) r
  where nullif(r ->> 'role', '') is distinct from 'owner'
    and exists (select 1 from public.chat_channels c where c.id = (r ->> 'channel_id')::uuid and c.company_id = p_company);
end $$;

revoke execute on function public.chat_set_enabled(uuid, boolean), public.chat_overview(uuid), public.chat_members(uuid),
  public.chat_mark_read(uuid), public.chat_audience(uuid), public.chat_create_channel(uuid, text, text, text, text, uuid),
  public.chat_save_roles(uuid, jsonb, jsonb) from public, anon;
grant execute on function public.chat_set_enabled(uuid, boolean), public.chat_overview(uuid), public.chat_members(uuid),
  public.chat_mark_read(uuid), public.chat_create_channel(uuid, text, text, text, text, uuid),
  public.chat_save_roles(uuid, jsonb, jsonb) to authenticated;
revoke execute on function public.chat_audience(uuid) from authenticated;
grant execute on function public.chat_audience(uuid) to service_role;

-- Policies above that ask about membership check it once per query (20261018000990_policy_lookups).
select private.fold_member_checks();
