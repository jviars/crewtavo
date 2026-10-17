import type { Database } from "@crewtavo/core";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Env } from "../env";
import { HttpError } from "./http";

const AUTH_OPTIONS = { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } as const;

export function publishableKey(env: Env): string {
  const key = env.SUPABASE_PUBLISHABLE_KEY ?? env.SUPABASE_ANON_KEY;
  if (!env.SUPABASE_URL || !key) throw new HttpError(500, "Crewtavo isn't fully set up yet (missing the database settings). Ask whoever installed it to finish setup.");
  return key;
}

/** Acts as the signed-in user; Postgres RLS decides what it can see and change. */
export type Db = SupabaseClient<Database>;

export function userClient(env: Env, accessToken: string): Db {
  return createClient<Database>(env.SUPABASE_URL, publishableKey(env), {
    auth: AUTH_OPTIONS,
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
}

/**
 * Bypasses RLS. Only for work with no signed-in user (webhooks, cron, signed client links, public
 * booking forms) and for the encrypted secrets table. Always filter by company_id explicitly.
 */
export function adminClient(env: Env): Db {
  const key = env.SUPABASE_SECRET_KEY ?? env.SUPABASE_SERVICE_ROLE_KEY;
  if (!env.SUPABASE_URL || !key) throw new HttpError(500, "Crewtavo isn't fully set up yet (missing the database secret key). Ask whoever installed it to finish setup.");
  return createClient<Database>(env.SUPABASE_URL, key, { auth: AUTH_OPTIONS });
}
