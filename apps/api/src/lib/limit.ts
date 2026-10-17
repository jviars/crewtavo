/**
 * Rate limits for endpoints where guessing or flooding is possible (promo codes, Client Hub
 * messages, assistant calls). Counts live in Postgres (public.rate_limit_hit, see the
 * rate_limits migration), so every replica shares them, and restarts and deploys don't reset them.
 */
import type { Env } from "../env";
import { reportError } from "./monitoring";
import { adminClient } from "./supabase";

/** Count one attempt for `key`. Returns false once `max` attempts were made within `windowSeconds`. */
export async function allow(env: Env, key: string, max: number, windowSeconds: number): Promise<boolean> {
  const { data, error } = await adminClient(env).rpc("rate_limit_hit", { p_key: key, p_max: max, p_window_seconds: windowSeconds });
  if (error) {
    // A limiter problem shouldn't take the feature down with it: let the request through.
    console.error("Rate limit check failed", error);
    reportError(new Error(`Rate limit check failed: ${error.message}`), { limit: key.split(":")[0] });
    return true;
  }
  return data !== false;
}
