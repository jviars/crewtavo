/**
 * Getting back into an account when email can't reach you (an instance has no mail server of its
 * own until the company connects a mailbox). The ways in, all in routes/recovery.ts:
 *
 * - An admin makes a one-time reset link for someone on their team (canMakeResetLink in
 *   packages/core/src/roles.ts says for whom).
 * - The owner uses one of their spare keys: one-time codes they saved when they set up Crewtavo,
 *   like two-factor backup codes. They only work while none of the owner's companies can send
 *   email; once one can, "Forgot password" is the way in. Stored as keyed hashes
 *   (private.spare_keys), so a copy of the database alone can't be searched for them.
 * - The last resort, for whoever helps an owner who lost their spare keys too: prove control of the
 *   server by setting CREWTAVO_RECOVERY_EMAIL and CREWTAVO_RECOVERY_CODE on it, then type the code
 *   where a spare key goes. Whoever can set those variables already controls the instance, so this
 *   opens no new way in. The code never appears in logs, works only for an hour after the server
 *   starts with it, and only once (claimed in public.app_secrets, so restarts and replicas can't
 *   reuse it).
 */
import type { Env } from "../env";
import { keyedHash } from "./crypto";
import { emailConfigured } from "./notify";
import { adminClient } from "./supabase";

export const RECOVERY_WINDOW_MS = 60 * 60_000;
export const MIN_RECOVERY_CODE = 12;

/** When this server process started: the recovery window counts from here. */
const startedAt = Date.now();

export type RecoverySetting =
  | { on: true; email: string; code: string; until: Date }
  | { on: false; reason: "unset" | "short" | "expired" };

export function recoverySetting(env: Env, now = Date.now(), started = startedAt): RecoverySetting {
  const email = env.CREWTAVO_RECOVERY_EMAIL?.trim().toLowerCase();
  const code = env.CREWTAVO_RECOVERY_CODE?.trim();
  if (!email || !code) return { on: false, reason: "unset" };
  if (code.length < MIN_RECOVERY_CODE) return { on: false, reason: "short" };
  const until = started + RECOVERY_WINDOW_MS;
  if (now > until) return { on: false, reason: "expired" };
  return { on: true, email, code, until: new Date(until) };
}

/** The name a used code is recorded under in public.app_secrets (a hash, never the code). */
export const usedCodeName = async (setting: { email: string; code: string }) => `recovery-used:${await sha256Hex(`${setting.email}\n${setting.code}`)}`;

/** A line for the server log at startup (never the code itself), or null when recovery isn't set. */
export async function describeRecovery(env: Env): Promise<string | null> {
  const setting = recoverySetting(env);
  if (setting.on) {
    const { data } = await adminClient(env).from("app_secrets").select("name").eq("name", await usedCodeName(setting)).maybeSingle();
    if (data) return "Account recovery: this CREWTAVO_RECOVERY_CODE was already used. Remove it, or set a new one to recover again.";
    return `Account recovery is on for ${setting.email} until ${setting.until.toISOString()} (one use). Remove CREWTAVO_RECOVERY_CODE once you're back in.`;
  }
  if (setting.reason === "short") return `Account recovery is off: CREWTAVO_RECOVERY_CODE needs at least ${MIN_RECOVERY_CODE} characters.`;
  return null;
}

/** The account signing in with this email (its sign-in email, not the profile's copy), or null. */
export async function accountForEmail(env: Env, email: string): Promise<{ user_id: string; full_name: string | null } | null> {
  const admin = adminClient(env);
  const { data: userId } = await admin.rpc("user_id_for_email", { p_email: email.trim().toLowerCase() });
  if (!userId) return null;
  const { data: profile } = await admin.from("profiles").select("full_name").eq("user_id", userId).maybeSingle();
  return { user_id: userId, full_name: profile?.full_name ?? null };
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

// ---------------------------------------------------------------------------------------------
// Spare keys
// ---------------------------------------------------------------------------------------------

export const SPARE_KEY_COUNT = 8;
/** Crockford's base32: no I, L, O or U, so no character reads two ways on paper. */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** A new set, like 7K4M-PQ2X-9DRF: 12 random characters (60 bits) each. */
export function newSpareKeys(count = SPARE_KEY_COUNT): string[] {
  return Array.from({ length: count }, () => {
    // 256 is a multiple of 32, so taking each byte mod 32 favors no character.
    const chars = Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => ALPHABET[b % 32]).join("");
    return `${chars.slice(0, 4)}-${chars.slice(4, 8)}-${chars.slice(8)}`;
  });
}

/** A key as typed, the way it's stored: capitals, no spaces or dashes, O as zero and I or L as one. */
export function normalizeSpareKey(input: string): string {
  return input.toUpperCase().replace(/[^0-9A-Z]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");
}

/** Bound to the account, so a key only ever opens the account it was made for. */
export const spareKeyHash = (env: Env, userId: string, key: string) => keyedHash(env, `spare-key:${userId}:${normalizeSpareKey(key)}`);

/** Can any of this person's companies send email (its own working mailbox, or the server's)? */
export async function accountCanEmail(env: Env, userId: string): Promise<boolean> {
  if (emailConfigured(env)) return true;
  const admin = adminClient(env);
  const { data: memberships } = await admin.from("memberships").select("company_id").eq("user_id", userId).eq("active", true);
  const companies = (memberships ?? []).map((m) => m.company_id);
  if (!companies.length) return false;
  // A mailbox whose sign-in failed can't send a reset link either, so it doesn't count.
  const { data } = await admin.from("integrations").select("company_id").eq("provider", "email").eq("status", "connected").in("company_id", companies).limit(1);
  return Boolean(data?.length);
}

/** Make and save a new set for an account (the old set stops working), returning the keys to show once. */
export async function replaceSpareKeys(env: Env, userId: string): Promise<string[]> {
  const keys = newSpareKeys();
  const hashes = await Promise.all(keys.map((key) => spareKeyHash(env, userId, key)));
  const { error } = await adminClient(env).rpc("spare_keys_replace", { p_user: userId, p_hashes: hashes });
  if (error) throw new Error(`Couldn't save spare keys: ${error.message}`);
  return keys;
}
