/**
 * Rate limits for endpoints where guessing or flooding is possible (promo codes, Client Hub
 * messages, assistant calls). Counts live in Postgres (public.rate_limit_hit, see the
 * rate_limits migration), so every replica shares them, and restarts and deploys don't reset them.
 *
 * A limit for each visitor has the visitor's address at the end of its key (`promo:<address>`,
 * `pay:ip:<address>`). An IPv6 address there is counted by its /64 (visitorBlock, lib/visitor.ts),
 * here and not where each key is made, so no limit can leave it out.
 */
import { isIP } from "node:net";
import type { Env } from "../env";
import { reportError } from "./monitoring";
import { adminClient } from "./supabase";
import { visitorBlock } from "./visitor";

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
    ({ data, error } = await adminClient(env).rpc("rate_limit_hit", { p_key: await limitKey(visitorKey(key)), p_max: max, p_window_seconds: windowSeconds }));
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
 * A key that ends in an IPv6 address, with the address's /64 in its place. Any other key (an IPv4
 * address, an id, an email address, a /64 already) is as it was. A key's parts are joined with
 * colons and so is the address, so the address is the longest ending that is one.
 */
function visitorKey(key: string): string {
  for (let colon = key.indexOf(":"); colon !== -1; colon = key.indexOf(":", colon + 1)) {
    const ending = key.slice(colon + 1);
    if (isIP(ending) === 6) return key.slice(0, colon + 1) + visitorBlock(ending);
  }
  return key;
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
