/**
 * Password and code guessing, stopped at the instance's gateway (server.ts). GoTrue only limits
 * sign-in attempts per address when told which header to trust, and no header can be trusted on
 * every host (Railway's edge sets one; a Docker install reached directly or through Caddy doesn't),
 * so failures are counted per account instead. After 10 wrong passwords or codes for an email in
 * 15 minutes, password and code sign-in for that email pause for 15 minutes. Successful sign-ins
 * don't count, and an emailed sign-in link (a long token, not a code) still works, so a stranger
 * can't lock anyone out of their account.
 *
 * Counts are shared through Postgres (lib/limit.ts); each process remembers the accounts it has
 * seen paused, so a paused account's attempts never reach GoTrue.
 */
import type { Env } from "../env";
import { allow } from "./limit";

export const GUESSES = 10;
export const GUESS_WINDOW_SECONDS = 15 * 60;
/** A sign-in request is a few hundred bytes; anything far bigger isn't one. */
const MAX_BODY = 64 * 1024;

const paused = new Map<string, number>();

/** Requests that carry an email and a secret someone could guess: a password, or a 6-digit code. */
export function isGuessable(method: string, url: URL, prefix: string): boolean {
  if (method !== "POST") return false;
  const path = url.pathname.slice(prefix.length);
  return (path === "/token" && url.searchParams.get("grant_type") === "password") || path === "/verify";
}

export async function guardSignIn(env: Env, request: Request, send: (request: Request) => Promise<Response>): Promise<Response> {
  const body = await readUpTo(request, MAX_BODY);
  if (body === null) return Response.json({ code: 413, error_code: "request_too_large", msg: "That request is too large." }, { status: 413 });
  const replay = new Request(request.url, { method: request.method, headers: request.headers, body });

  let email = "";
  try {
    const parsed = JSON.parse(body) as { email?: unknown };
    if (typeof parsed?.email === "string") email = parsed.email.trim().toLowerCase();
  } catch {
    // Not JSON: GoTrue will say so.
  }
  // A link's token_hash is long and random; only an email with a password or code can be guessed.
  if (!email) return send(replay);

  const key = `sign-in-guess:${email}`;
  const now = Date.now();
  const until = paused.get(key);
  if (until && until > now) return tooMany(until - now);
  if (until) paused.delete(key);

  const response = await send(replay);
  if (response.status >= 400 && response.status < 500 && response.status !== 429) {
    if (!(await allow(env, key, GUESSES, GUESS_WINDOW_SECONDS))) {
      if (paused.size > 10_000) for (const [k, t] of paused) if (t <= now) paused.delete(k);
      paused.set(key, now + GUESS_WINDOW_SECONDS * 1000);
    }
  }
  return response;
}

function tooMany(ms: number): Response {
  const seconds = Math.ceil(ms / 1000);
  return Response.json(
    { code: 429, error_code: "over_request_rate_limit", msg: "Too many wrong attempts for this account. Wait 15 minutes, or sign in with an emailed link." },
    { status: 429, headers: { "Retry-After": String(seconds) } },
  );
}

/** The body as text, or null once it passes `max` bytes (without reading the rest). */
async function readUpTo(request: Request, max: number): Promise<string | null> {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}
