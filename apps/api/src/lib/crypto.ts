/**
 * Encryption for third-party tokens (AES-256-GCM) and signed links (HMAC-SHA256), using Web
 * Crypto. Both keys derive from ENCRYPTION_KEY with HKDF, or from the Supabase secret key when
 * ENCRYPTION_KEY isn't set (in an instance, the service key minted from JWT_SECRET), so a new
 * instance needs no extra secret.
 */
import type { Env } from "../env";
import { HttpError } from "./http";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const toBase64Url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export function fromBase64Url(text: string): Uint8Array {
  const b64 = text.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (text.length % 4)) % 4);
  return Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
}

const keyCache = new Map<string, Promise<CryptoKey>>();

/**
 * The secret both keys derive from. ENCRYPTION_KEY may be base64 (32+ bytes) or any phrase of 32+
 * characters. Without it, the Supabase secret key is used under a different salt; it never leaves
 * the server and already unlocks all the data, so it adds no new exposure. Rotating it then has the
 * same effect as changing ENCRYPTION_KEY: apps must be reconnected and old client links stop working.
 */
function keyMaterial(env: Env): { raw: Uint8Array; salt: string } {
  const explicit = env.ENCRYPTION_KEY?.trim();
  if (explicit) {
    try {
      const decoded = Uint8Array.from(atob(explicit), (ch) => ch.charCodeAt(0));
      if (decoded.length >= 32) return { raw: decoded, salt: "" };
    } catch {
      // Not base64: use the phrase itself.
    }
    if (explicit.length >= 32) return { raw: encoder.encode(explicit), salt: "" };
    throw new HttpError(500, "ENCRYPTION_KEY is too short. Use at least 32 characters, or remove it to use the built-in key.");
  }
  const supabaseSecret = (env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY)?.trim();
  if (supabaseSecret) return { raw: encoder.encode(supabaseSecret), salt: "crewtavo/supabase-secret" };
  throw new HttpError(500, "Crewtavo isn't fully set up yet (missing the database secret key). Ask whoever installed it to finish setup.");
}

function deriveKey(env: Env, purpose: "encrypt" | "sign"): Promise<CryptoKey> {
  const { raw, salt } = keyMaterial(env);
  const cacheKey = `${purpose}:${salt}:${toBase64Url(raw)}`;
  let key = keyCache.get(cacheKey);
  if (!key) {
    key = (async () => {
      const base = await crypto.subtle.importKey("raw", raw, "HKDF", false, ["deriveKey"]);
      const params = { name: "HKDF", hash: "SHA-256", salt: encoder.encode(salt), info: encoder.encode(`crewtavo/${purpose}/v1`) };
      return purpose === "encrypt"
        ? crypto.subtle.deriveKey(params, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"])
        : crypto.subtle.deriveKey(params, base, { name: "HMAC", hash: "SHA-256", length: 256 }, false, ["sign", "verify"]);
    })();
    keyCache.set(cacheKey, key);
  }
  return key;
}

export async function encryptJson(env: Env, value: unknown): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(env, "encrypt");
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoder.encode(JSON.stringify(value))));
  return `v1.${toBase64Url(iv)}.${toBase64Url(ciphertext)}`;
}

export async function decryptJson<T>(env: Env, sealed: string): Promise<T> {
  const [version, iv, data] = sealed.split(".");
  if (version !== "v1" || !iv || !data) throw new Error("Unrecognized ciphertext");
  const key = await deriveKey(env, "encrypt");
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64Url(iv) }, key, fromBase64Url(data));
  return JSON.parse(decoder.decode(plain)) as T;
}

/** Compact signed token: base64url(JSON payload) + "." + base64url(HMAC). Payload must include exp (seconds). */
export async function signToken(env: Env, payload: Record<string, unknown> & { exp: number }): Promise<string> {
  const body = toBase64Url(encoder.encode(JSON.stringify(payload)));
  const key = await deriveKey(env, "sign");
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(body)));
  return `${body}.${toBase64Url(mac)}`;
}

export async function verifyToken<T extends { exp: number }>(env: Env, token: string): Promise<T | null> {
  const [body, mac] = token.split(".");
  if (!body || !mac) return null;
  const key = await deriveKey(env, "sign");
  let signature: Uint8Array;
  try {
    signature = fromBase64Url(mac);
  } catch {
    return null; // Not base64url: a link cut short or mangled on its way here.
  }
  const ok = await crypto.subtle.verify("HMAC", key, signature, encoder.encode(body));
  if (!ok) return null;
  const payload = JSON.parse(decoder.decode(fromBase64Url(body))) as T;
  return payload.exp > Date.now() / 1000 ? payload : null;
}

export const randomId = (bytes = 16) => toBase64Url(crypto.getRandomValues(new Uint8Array(bytes)));

/** Constant-time comparison for shared secrets. */
export function safeEqual(a: string, b: string): boolean {
  const x = encoder.encode(a);
  const y = encoder.encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

export async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(message)));
  return Array.from(mac, (b) => b.toString(16).padStart(2, "0")).join("");
}
