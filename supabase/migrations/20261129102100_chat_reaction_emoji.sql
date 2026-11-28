-- Reactions can be any emoji from a curated list, as well as the three quick ones (thumbs up, "On it",
-- "Seen"). The list is core's CHAT_EMOJI (packages/core/src/chatEmoji.ts), copied here, and
-- packages/core/test/chatEmoji.test.ts checks the two are the same. One message takes up to 20
-- kinds of reaction, and up to 12 from one person, so a message can't be buried under them.

-- The emoji people can react with. 👍 is listed, though the app sends it as thumbs_up.
create function private.chat_reaction_emoji() returns text[]
language sql immutable parallel safe set search_path = '' as $$
  select array[
    '😀', '😃', '😄', '😁', '😆', '😅', '😂', '🤣', '🙂', '🙃', '😉', '😊', '😇', '🥰', '😍', '🤩',
    '😘', '😋', '😛', '😜', '🤪', '🤑', '🤗', '🤭', '🤫', '🤔', '🤐', '🤨', '😐', '😑', '😶', '😏',
    '😒', '🙄', '😬', '😮‍💨', '😌', '😔', '😪', '🤤', '😴', '😷', '🤒', '🤕', '🤢', '🤮', '🥵', '🥶',
    '🥴', '😵', '🤯', '🤠', '🥳', '😎', '🤓', '🧐', '😕', '😟', '🙁', '😮', '😯', '😲', '😳', '🥺',
    '😦', '😧', '😨', '😰', '😥', '😢', '😭', '😱', '😖', '😣', '😞', '😓', '😩', '😫', '🥱', '😤',
    '😠', '😡', '🤬', '😈', '💀', '💩', '🤡', '👻', '👽', '🤖', '👋', '🤚', '✋', '🖐️', '👌', '🤌',
    '🤏', '✌️', '🤞', '🤟', '🤘', '🤙', '👈', '👉', '👆', '👇', '☝️', '👍', '👎', '✊', '👊', '🤛',
    '🤜', '👏', '🙌', '👐', '🤲', '🤝', '🙏', '✍️', '💪', '🦾', '🧠', '👀', '👁️', '👂', '👃', '🫡',
    '🙋', '🙅', '🙆', '🤷', '🤦', '💁', '🙇', '🧑‍🔧', '👷', '🧑‍🌾', '🧑‍💼', '🧑‍🏭', '🧑‍🚒', '👮', '🧑‍⚕️', '🏃',
    '🚶', '🧍', '👶', '🧒', '🧑', '🧓', '🔨', '🪓', '⛏️', '⚒️', '🛠️', '🔧', '🪛', '🔩', '⚙️', '🧰',
    '🪚', '📏', '📐', '🧱', '🪜', '🦺', '⛑️', '🧯', '🔌', '💡', '🔦', '🪣', '🧹', '🧽', '🧪', '🔋',
    '🪫', '⛽', '🚧', '⚠️', '🚨', '📋', '📝', '✏️', '🖊️', '📎', '📌', '📍', '🗂️', '📁', '📄', '📊',
    '📈', '📉', '📅', '🗓️', '⏰', '⏱️', '⌛', '💼', '🧾', '💵', '💰', '💳', '🏦', '📦', '🏷️', '🔑',
    '🔒', '🔓', '📞', '📱', '💻', '🖨️', '📷', '📸', '🔍', '☀️', '🌤️', '⛅', '🌥️', '☁️', '🌦️', '🌧️',
    '⛈️', '🌩️', '🌨️', '❄️', '☃️', '⛄', '🌬️', '💨', '🌪️', '🌫️', '🌈', '☔', '💧', '💦', '🌊', '🔥',
    '⚡', '🌡️', '🌙', '⭐', '🌟', '🌱', '🌿', '☘️', '🍀', '🍃', '🍂', '🍁', '🌾', '🌵', '🌴', '🌳',
    '🌲', '🪵', '🪨', '🌻', '🌼', '🌸', '🌷', '🌹', '💐', '🍄', '🐶', '🐱', '🐭', '🐰', '🦊', '🐻',
    '🐿️', '🦌', '🐦', '🐝', '🐛', '🐜', '🕷️', '🐍', '🐢', '🐟', '🦆', '🐓', '🐄', '🐴', '☕', '🍵',
    '🥤', '🧃', '🧊', '🍺', '🍻', '🥂', '🍷', '🍕', '🍔', '🌭', '🌮', '🌯', '🥪', '🥗', '🍝', '🍜',
    '🍣', '🍗', '🍖', '🥓', '🍳', '🥞', '🧇', '🥐', '🥯', '🍞', '🧀', '🍟', '🍿', '🍩', '🍪', '🎂',
    '🍰', '🧁', '🍫', '🍬', '🍦', '🍎', '🍏', '🍊', '🍋', '🍌', '🍉', '🍇', '🍓', '🍑', '🥑', '🌶️',
    '🥕', '🌽', '🥔', '🍅', '🚗', '🚙', '🛻', '🚚', '🚛', '🚜', '🏎️', '🚐', '🚌', '🚑', '🚒', '🚓',
    '🛵', '🏍️', '🚲', '🛴', '🛞', '🚦', '🛑', '🛣️', '🗺️', '🧭', '⛰️', '🏔️', '🏕️', '🏖️', '🏠', '🏡',
    '🏘️', '🏚️', '🏗️', '🏢', '🏭', '🏪', '🏫', '🏥', '🏨', '⛪', '🌉', '✈️', '🚁', '🚀', '⛵', '🚤',
    '⚓', '🅿️', '🎉', '🎊', '🎈', '🎁', '🏆', '🥇', '🏅', '🎯', '🎵', '🎶', '🎤', '🎧', '📢', '📣',
    '🔔', '🔕', '📬', '✉️', '📰', '📚', '📖', '🔖', '🗑️', '🛒', '🪑', '🛏️', '🚪', '🪟', '🚿', '🛁',
    '🚽', '🧻', '🧺', '🧸', '🖼️', '🕯️', '💎', '💍', '⌚', '🕶️', '🧢', '👟', '🥾', '🧤', '🧥', '👕',
    '👖', '🎒', '☂️', '🧳', '❤️', '🧡', '💛', '💚', '💙', '💜', '🖤', '🤍', '💔', '❣️', '💯', '✅',
    '☑️', '✔️', '❌', '❎', '➕', '➖', '❓', '❗', '‼️', '⁉️', '💤', '💥', '💫', '✨', '💬', '💭',
    '🗯️', '♻️', '🚫', '⛔', '⭕', '🔴', '🟠', '🟡', '🟢', '🔵', '🟣', '⚫', '⚪', '🟥', '🟩', '⬆️',
    '⬇️', '⬅️', '➡️', '🔄', '🔁', '⏩', '▶️', '⏸️', '⏹️', '🆗', '🆕', '🆘', '💲', '1️⃣', '2️⃣', '3️⃣',
    '🏁', '🚩', '🏳️'
  ]::text[]
$$;
revoke execute on function private.chat_reaction_emoji() from public;
grant execute on function private.chat_reaction_emoji() to authenticated, service_role;

do $$
declare c text;
begin
  for c in select conname from pg_constraint
           where conrelid = 'public.chat_reactions'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%kind%' loop
    execute format('alter table public.chat_reactions drop constraint %I', c);
  end loop;
end $$;
alter table public.chat_reactions add constraint chat_reactions_kind_check
  check (kind in ('thumbs_up', 'on_it', 'seen') or kind = any (private.chat_reaction_emoji()));

-- Up to 20 kinds on a message, and up to 12 from each person. Taken in turn per message (its row
-- locked), so two people reacting at once can't both slip past the limit.
create function private.chat_reaction_limit() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  -- One already there is left to the insert's own "on conflict".
  if exists (select 1 from public.chat_reactions r where r.message_id = new.message_id and r.user_id = new.user_id and r.kind = new.kind) then
    return new;
  end if;
  perform 1 from public.chat_messages m where m.id = new.message_id for no key update;
  if (select count(*) from public.chat_reactions r where r.message_id = new.message_id and r.user_id = new.user_id) >= 12 then
    raise exception 'That''s as many reactions as one person can add to a message' using errcode = '23514';
  end if;
  if not exists (select 1 from public.chat_reactions r where r.message_id = new.message_id and r.kind = new.kind)
     and (select count(distinct r.kind) from public.chat_reactions r where r.message_id = new.message_id) >= 20 then
    raise exception 'That message has as many kinds of reaction as it can take' using errcode = '23514';
  end if;
  return new;
end $$;
revoke all on function private.chat_reaction_limit() from public;
create trigger chat_reaction_limit before insert on public.chat_reactions
  for each row execute function private.chat_reaction_limit();
