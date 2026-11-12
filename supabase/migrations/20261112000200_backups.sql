-- Built-in database backups (apps/api/src/services/backups.ts): every night the server dumps the
-- whole database with pg_dump and keeps the dump in Storage, for the owner to download from
-- Settings → Your data.
--
--   storage bucket "backups"   Where the dumps are kept, in pieces (<backup id>/part-0001, ...). It
--                              is private and has no policies, so no signed-in person's key reads,
--                              lists or writes it: only the server's service key does. It isn't
--                              the "files" bucket, so nothing in it counts toward the storage
--                              limits (storage_snapshot counts that bucket alone).
--   public.backups             One row for each run: when, how big, and whether it finished. A
--                              dump is only ever offered once its row says "ok", which the server
--                              sets after every piece is stored, so a run that died halfway is
--                              never listed as good. Server only (no policies, as public.outbox).
--   claim_backup()             Starts a run, one at a time across every server: two replicas
--                              running the scheduler make one backup between them.

insert into storage.buckets (id, name, public) values ('backups', 'backups', false) on conflict (id) do nothing;

create table public.backups (
  id uuid primary key default gen_random_uuid(),
  kind text not null default 'nightly' check (kind in ('nightly', 'manual')),
  status text not null default 'running' check (status in ('running', 'ok', 'failed')),
  started_at timestamptz not null default now(),
  -- The server doing the run says it's still going; a run that stops saying so died with its server.
  heartbeat_at timestamptz not null default now(),
  finished_at timestamptz,
  bytes bigint,
  parts integer,
  -- Why it failed, in words for the owner (no secrets).
  error text,
  -- When the owners were told about this run failing, or about no backup being made for too long.
  warned_at timestamptz
);
comment on table public.backups is 'Database backups made by the server (services/backups.ts). The dumps are in the storage bucket "backups", under each row''s id.';
create unique index backups_one_running_idx on public.backups ((true)) where status = 'running';
create index backups_started_idx on public.backups (started_at desc);
alter table public.backups enable row level security;
revoke all on public.backups from authenticated, anon;

-- Starts a backup and returns its id, or null when there's nothing to start: one is running, or
-- (for the nightly one) tonight's is already made, or it has failed p_tries times since p_since and
-- waits for tomorrow night. A run whose server stopped saying it was going is closed as failed
-- first, so it never blocks the next one. Service key only.
create function public.claim_backup(p_kind text, p_since timestamptz default null, p_tries integer default 3) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid;
begin
  -- Two servers asking at the same moment take turns.
  perform pg_advisory_xact_lock(hashtext('crewtavo:backup'));
  update public.backups
     set status = 'failed', finished_at = now(), error = 'Crewtavo restarted before this backup finished.'
   where status = 'running' and heartbeat_at < now() - interval '10 minutes';
  if exists (select 1 from public.backups where status = 'running') then
    return null;
  end if;
  if p_kind = 'nightly' then
    if exists (select 1 from public.backups where status = 'ok' and started_at >= coalesce(p_since, '-infinity')) then
      return null;
    end if;
    if (select count(*) from public.backups where kind = 'nightly' and status = 'failed' and started_at >= coalesce(p_since, '-infinity')) >= p_tries then
      return null;
    end if;
  end if;
  insert into public.backups (kind) values (p_kind) returning id into v_id;
  return v_id;
end $$;
revoke execute on function public.claim_backup(text, timestamptz, integer) from public, anon, authenticated;
grant execute on function public.claim_backup(text, timestamptz, integer) to service_role;
