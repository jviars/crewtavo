-- "Allow changes" for each connected AI assistant (20261019001040_assistant_access.sql) is in
-- Settings → Profile → AI assistants now, which every role has. It was only on the Claude and
-- ChatGPT pages under Apps, which only owners and admins open, so most people couldn't let their
-- assistant change things, and the Data API's refusal sent them somewhere they couldn't go. The
-- check is the same; the refusal says where the switch is.

create or replace function hooks.before_request() returns void
language plpgsql security definer set search_path = '' as $$
begin
  if private.assistant_may_change() then return; end if;
  perform set_config('transaction_read_only', 'on', true);
  if current_setting('request.method', true) in ('GET', 'HEAD') or current_setting('request.path', true) like '/rpc/%' then
    return;
  end if;
  raise exception using errcode = 'PT403',
    message = 'This assistant can only read. To let it make changes, turn on "Allow changes" for it in Crewtavo, under Settings → Profile → AI assistants.';
end $$;
