/**
 * Web Push: notifications on phones and computers, free, with nothing to sign up for. Messages go
 * to the browser vendor's push service (Apple, Google, Mozilla), signed with this install's VAPID
 * key (RFC 8292) and encrypted for the device (RFC 8291, aes128gcm). The key pair is made on first
 * use and kept, encrypted, in public.app_secrets. Web Crypto only, so it runs on Workers and Node.
 */
import type { Env } from "../env";
import { decryptJson, encryptJson, fromBase64Url, toBase64Url } from "./crypto";
import { adminClient } from "./supabase";

export interface PushSubscription {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export interface PushMessage {
  title: string;
  body?: string;
  /** Where tapping it goes, e.g. /field/visits/123. */
  link?: string;
  /** Replaces an earlier notification with the same tag on the device. */
  tag?: string;
}

interface VapidKeys {
  publicKey: string; // base64url, uncompressed P-256 point (what the browser's applicationServerKey wants)
  privateJwk: JsonWebKey;
}

const encoder = new TextEncoder();
let cached: Promise<VapidKeys> | null = null;

/** This install's VAPID keys, made the first time they're needed. */
export function vapidKeys(env: Env): Promise<VapidKeys> {
  cached ??= (async () => {
    const admin = adminClient(env);
    const read = async () => {
      const { data } = await admin.from("app_secrets").select("ciphertext").eq("name", "vapid").maybeSingle();
      return data ? decryptJson<VapidKeys>(env, data.ciphertext) : null;
    };
    const existing = await read();
    if (existing) return existing;
    const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
    const keys: VapidKeys = {
      publicKey: toBase64Url(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey))),
      privateJwk: await crypto.subtle.exportKey("jwk", pair.privateKey),
    };
    // Two servers starting at once: the first one in wins, and both use it.
    await admin.from("app_secrets").upsert({ name: "vapid", ciphertext: await encryptJson(env, keys) }, { onConflict: "name", ignoreDuplicates: true });
    return (await read()) ?? keys;
  })().catch((error) => {
    cached = null;
    throw error;
  });
  return cached;
}

const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

async function hmac(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, data));
}

/** RFC 8291: encrypt `payload` for one subscription. Returns the aes128gcm request body. */
export async function encryptPayload(sub: Pick<PushSubscription, "p256dh" | "auth">, payload: Uint8Array, salt = crypto.getRandomValues(new Uint8Array(16))): Promise<Uint8Array> {
  const uaPublic = fromBase64Url(sub.p256dh);
  const authSecret = fromBase64Url(sub.auth);
  const local = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
  const asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", local.publicKey));
  const uaKey = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, local.privateKey, 256));

  const prkKey = await hmac(authSecret, ecdhSecret);
  const ikm = await hmac(prkKey, concat(encoder.encode("WebPush: info\0"), uaPublic, asPublic, new Uint8Array([1])));
  const prk = await hmac(salt, ikm);
  const cek = (await hmac(prk, concat(encoder.encode("Content-Encoding: aes128gcm\0"), new Uint8Array([1])))).slice(0, 16);
  const nonce = (await hmac(prk, concat(encoder.encode("Content-Encoding: nonce\0"), new Uint8Array([1])))).slice(0, 12);

  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, concat(payload, new Uint8Array([2]))));
  const header = new Uint8Array(21 + asPublic.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096);
  header[20] = asPublic.length;
  header.set(asPublic, 21);
  return concat(header, ciphertext);
}

/** RFC 8292: the VAPID JWT for one push service, signed ES256. */
async function vapidJwt(keys: VapidKeys, audience: string, subject: string): Promise<string> {
  const key = await crypto.subtle.importKey("jwk", keys.privateJwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const segment = (value: unknown) => toBase64Url(encoder.encode(JSON.stringify(value)));
  const unsigned = `${segment({ typ: "JWT", alg: "ES256" })}.${segment({ aud: audience, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject })}`;
  const signature = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, encoder.encode(unsigned)));
  return `${unsigned}.${toBase64Url(signature)}`;
}

/** Send one notification. `gone` means the device unsubscribed: delete it. */
export async function sendPush(env: Env, sub: PushSubscription, message: PushMessage, contact: string): Promise<{ ok: boolean; gone: boolean; status: number }> {
  const keys = await vapidKeys(env);
  const body = await encryptPayload(sub, encoder.encode(JSON.stringify(message)));
  const jwt = await vapidJwt(keys, new URL(sub.endpoint).origin, contact);
  const response = await fetch(sub.endpoint, {
    method: "POST",
    headers: {
      Authorization: `vapid t=${jwt}, k=${keys.publicKey}`,
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      TTL: "86400",
      Urgency: "high",
    },
    body,
  }).catch(() => null);
  if (!response) return { ok: false, gone: false, status: 0 };
  return { ok: response.ok, gone: response.status === 404 || response.status === 410, status: response.status };
}
