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
  // A limiter problem (null) shouldn't take the feature down with it: let the request through.
  return (await hit(env, key, max, windowSeconds)) !== false;
}

/**
 * The same, but a request that can't be counted is refused: for endpoints that spend money or open a
 * way in, where letting a flood through costs more than turning someone away for a moment (texting
 * sign-in codes, services/signInCodes.ts).
 */
export async function allowStrict(env: Env, key: string, max: number, windowSeconds: number): Promise<boolean> {
  return (await hit(env, key, max, windowSeconds)) === true;
}

/** What Postgres answered (true within the limit, false past it), or null when it couldn't be asked. */
async function hit(env: Env, key: string, max: number, windowSeconds: number): Promise<unknown> {
  let error: { message: string } | null;
  let data: unknown;
  try {
    ({ data, error } = await adminClient(env).rpc("rate_limit_hit", { p_key: await limitKey(key), p_max: max, p_window_seconds: windowSeconds }));
  } catch (thrown) {
    data = null;
    error = { message: thrown instanceof Error ? thrown.message : String(thrown) };
  }
  if (error) {
    console.error("Rate limit check failed", error);
    reportError(new Error(`Rate limit check failed: ${error.message}`), { limit: key.split(":")[0] });
    return null;
  }
  return data;
}

/**
 * Postgres takes keys of up to 200 characters. A longer one (a long email address, or a forged
 * address header) would be refused and so let through, so it's shortened to its kind and a hash.
 */
async function limitKey(key: string): Promise<string> {
  if (key.length <= 200) return key;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key)));
  return `${key.split(":")[0]!.slice(0, 40)}:sha256:${Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}
