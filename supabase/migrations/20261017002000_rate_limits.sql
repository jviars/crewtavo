-- Durable rate limits for endpoints where guessing or flooding is possible (promo codes, Client Hub
-- messages, assistant calls). Counts live here instead of in each API process, so every Worker
-- isolate, Vercel instance and replica shares them, and a restart or deploy doesn't reset them.
--
--   private.rate_limits      one row per key: hits in the current window and when it ends
--   public.rate_limit_hit()  count one attempt and say whether it's allowed (service key only)
--
-- Keys are stored as SHA-256 hashes, so client IP addresses never sit in the table.

create table private.rate_limits (
  key_hash bytea primary key,
  hits integer not null check (hits > 0),
  reset_at timestamptz not null
);
create index rate_limits_reset_at on private.rate_limits (reset_at);
alter table private.rate_limits enable row level security;
revoke all on private.rate_limits from public, anon, authenticated, service_role;

-- Count one attempt for p_key. Returns false once p_max attempts were made in the window that
-- started with the first attempt (p_window_seconds long). The upsert takes a row lock, so
-- simultaneous requests for the same key are counted one after another, never lost.
create function public.rate_limit_hit(p_key text, p_max integer, p_window_seconds integer) returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  v_hits integer;
begin
  if p_key is null or length(p_key) not between 1 and 200 then
    raise exception 'A rate limit key is 1 to 200 characters.' using errcode = '22023';
  end if;
  if p_max is null or p_max < 1 then
    raise exception 'A rate limit allows at least one attempt.' using errcode = '22023';
  end if;
  if p_window_seconds is null or p_window_seconds not between 1 and 86400 then
    raise exception 'A rate limit window is 1 second to 1 day.' using errcode = '22023';
  end if;

  insert into private.rate_limits as r (key_hash, hits, reset_at)
  values (sha256(convert_to(p_key, 'UTF8')), 1, now() + make_interval(secs => p_window_seconds))
  on conflict (key_hash) do update set
    -- A finished window starts over; otherwise count, stopping just past the limit.
    hits = case when r.reset_at <= now() then 1 else least(r.hits, p_max) + 1 end,
    reset_at = case when r.reset_at <= now() then excluded.reset_at else r.reset_at end
  returning r.hits into v_hits;

  -- Clear a few finished windows on every call so the table stays small without a cleanup job.
  delete from private.rate_limits
  where key_hash in (
    select key_hash from private.rate_limits where reset_at < now()
    order by reset_at limit 20 for update skip locked
  );

  return v_hits <= p_max;
end $$;
revoke execute on function public.rate_limit_hit(text, integer, integer) from public, anon, authenticated;
grant execute on function public.rate_limit_hit(text, integer, integer) to service_role;
