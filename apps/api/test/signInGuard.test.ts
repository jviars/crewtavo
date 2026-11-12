import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { allow } from "../src/lib/limit";
import { authRoute, GUESSES, guardLink, guardSignIn, isGuessable, openAuthToken, sealAuthToken, sendsAuthMail } from "../src/lib/signInGuard";

const env: Env = { SUPABASE_URL: "http://127.0.0.1:8080", SUPABASE_SECRET_KEY: "sb_secret_test" };

/** Postgres's rate_limit_hit, in memory: true for the first `max` hits of a key. */
function fakeLimiter() {
  const hits = new Map<string, number>();
  vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
    const { p_key, p_max } = JSON.parse(String(init?.body)) as { p_key: string; p_max: number };
    if (p_key.length > 200) return Response.json({ code: "22023", message: "A rate limit key is 1 to 200 characters." }, { status: 400 });
    const n = (hits.get(p_key) ?? 0) + 1;
    hits.set(p_key, n);
    return Response.json(n <= p_max);
  });
  return hits;
}

const signIn = (body: unknown, path = "/auth/v1/token?grant_type=password") =>
  new Request(`http://localhost:8080${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) });

/** GoTrue: the password "right" works, anything else is wrong. */
function gotrue() {
  const seen: unknown[] = [];
  const send = async (request: Request) => {
    const body = (await request.json()) as { password?: string; token?: string };
    seen.push(body);
    return body.password === "right" || body.token === "123456" ? Response.json({ access_token: "jwt" }) : Response.json({ error_code: "invalid_credentials" }, { status: 400 });
  };
  return { send, seen };
}

describe("sign-in guard", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("applies to password sign-in only", () => {
    const url = (path: string) => new URL(`http://x/auth/v1${path}`);
    expect(isGuessable("POST", url("/token?grant_type=password"), "/auth/v1")).toBe(true);
    expect(isGuessable("POST", url("/verify"), "/auth/v1")).toBe(false);
    expect(isGuessable("POST", url("/token?grant_type=refresh_token"), "/auth/v1")).toBe(false);
    expect(isGuessable("GET", url("/verify"), "/auth/v1")).toBe(false);
    expect(isGuessable("GET", url("/user"), "/auth/v1")).toBe(false);
  });

  it("pauses an account after 10 wrong passwords, without passing more guesses on", async () => {
    fakeLimiter();
    const { send, seen } = gotrue();
    for (let i = 0; i <= GUESSES; i++) expect((await guardSignIn(env, signIn({ email: "Owner@Example.com", password: `wrong-${i}` }), send)).status).toBe(400);
    const paused = await guardSignIn(env, signIn({ email: "owner@example.com", password: "right" }), send);
    expect(paused.status).toBe(429);
    expect(Number(paused.headers.get("Retry-After"))).toBeGreaterThan(800);
    expect(seen).toHaveLength(GUESSES + 1);
    // Someone else's sign-in isn't affected.
    expect((await guardSignIn(env, signIn({ email: "crew@example.com", password: "right" }), send)).status).toBe(200);
  });

  it("has nothing to sign in with but an email and a password", async () => {
    const { send, seen } = gotrue();
    expect((await guardSignIn(env, signIn({ type: "magiclink", token_hash: "x".repeat(56), token: "123456" }), send)).status).toBe(400);
    expect(seen).toHaveLength(0);
  });

  it("doesn't count successful sign-ins", async () => {
    const hits = fakeLimiter();
    const { send } = gotrue();
    for (let i = 0; i < 30; i++) expect((await guardSignIn(env, signIn({ email: "busy@example.com", password: "right" }), send)).status).toBe(200);
    expect(hits.size).toBe(0);
  });

  it("can't be skipped with a very long address", async () => {
    fakeLimiter();
    const { send } = gotrue();
    const email = `${"a".repeat(240)}@example.com`;
    for (let i = 0; i <= GUESSES; i++) await guardSignIn(env, signIn({ email, password: "wrong" }), send);
    expect((await guardSignIn(env, signIn({ email, password: "right" }), send)).status).toBe(429);
  });

  it("refuses oversized bodies before reading them all", async () => {
    const { send, seen } = gotrue();
    const response = await guardSignIn(env, signIn({ email: "big@example.com", password: "x".repeat(100_000) }), send);
    expect(response.status).toBe(413);
    expect(seen).toHaveLength(0);
  });

  it("refuses requests it can't read rather than passing them on unchecked", async () => {
    const { send, seen } = gotrue();
    expect((await guardSignIn(env, signIn("not json"), send)).status).toBe(400);
    expect((await guardSignIn(env, signIn([{ email: "a@example.com" }]), send)).status).toBe(400);
    expect((await guardSignIn(env, signIn({ password: "guess" }), send)).status).toBe(400);
    expect((await guardSignIn(env, signIn({ phone: "+15405550199", password: "guess" }), send)).status).toBe(400);
    expect(seen).toHaveLength(0);
  });

  it("counts an email however its field is spelled, as GoTrue reads it", async () => {
    fakeLimiter();
    const { send, seen } = gotrue();
    for (let i = 0; i <= GUESSES; i++) await guardSignIn(env, signIn({ EMAIL: "Spelled@Example.com", Password: `wrong-${i}` }), send);
    expect((await guardSignIn(env, signIn({ email: "spelled@example.com", password: "right" }), send)).status).toBe(429);
    // GoTrue got one spelling of each field: the one that was checked.
    expect(seen[0]).toEqual({ email: "Spelled@Example.com", password: "wrong-0" });
  });

  it("sends an account's attempts one at a time, so a burst can't outrun the limit", async () => {
    fakeLimiter();
    let open = 0;
    let most = 0;
    let reached = 0;
    const slow = async (request: Request) => {
      open++;
      most = Math.max(most, open);
      reached++;
      const body = (await request.json()) as { password?: string };
      await new Promise((resolve) => setTimeout(resolve, 5));
      open--;
      return body.password === "right" ? Response.json({ access_token: "jwt" }) : Response.json({ error_code: "invalid_credentials" }, { status: 400 });
    };
    // A few people signing in to one shared account at the same moment all get in, one after another.
    const shared = await Promise.all(Array.from({ length: 4 }, () => guardSignIn(env, signIn({ email: "shared@example.com", password: "right" }), slow)));
    expect(shared.map((r) => r.status)).toEqual([200, 200, 200, 200]);
    expect(most).toBe(1);

    reached = 0;
    const burst = await Promise.all(Array.from({ length: 200 }, (_, i) => guardSignIn(env, signIn({ email: "burst@example.com", password: `wrong-${i}` }), slow)));
    expect(most).toBe(1);
    expect(reached).toBe(5);
    expect(burst.filter((r) => r.status === 429)).toHaveLength(195);
    // Sent one after another, they stop at the limit.
    for (let i = 0; i < 30; i++) await guardSignIn(env, signIn({ email: "burst@example.com", password: `again-${i}` }), slow);
    expect(reached).toBe(GUESSES + 1);
  });
});

describe("rate limit keys", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("shortens keys Postgres would refuse, instead of letting the request through", async () => {
    const keys: string[] = [];
    vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
      keys.push((JSON.parse(String(init?.body)) as { p_key: string }).p_key);
      return Response.json(false);
    });
    expect(await allow(env, `promo:${"9".repeat(300)}`, 10, 600)).toBe(false);
    expect(await allow(env, "promo:203.0.113.9", 10, 600)).toBe(false);
    expect(keys[0]).toMatch(/^promo:sha256:[0-9a-f]{64}$/);
    expect(keys[1]).toBe("promo:203.0.113.9");
  });
});

describe("emailed links", () => {
  const instance: Env = { ...env, CREWTAVO_GATEWAY: "1" };
  const TOKEN = "ab12".repeat(14);
  const verify = (body: unknown, method = "POST") =>
    new Request("http://localhost:8080/auth/v1/verify", { method, headers: { "content-type": "application/json" }, ...(method === "POST" ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}) });
  /** GoTrue: takes any token it's handed, and keeps what it was sent. */
  function gotrue() {
    const seen: Array<Record<string, unknown>> = [];
    const send = async (request: Request) => {
      seen.push((await request.json()) as Record<string, unknown>);
      return Response.json({ access_token: "jwt" });
    };
    return { send, seen };
  }

  it("go out with the server's signature in an instance, and as Auth made them without the gateway", async () => {
    expect(await sealAuthToken(env, TOKEN, "invite")).toBe(TOKEN);
    const sealed = await sealAuthToken(instance, TOKEN, "invite");
    expect(sealed).toMatch(new RegExp(`^${TOKEN}\\.[0-9a-f]{40}$`));
    expect(await openAuthToken(instance, sealed, "invite")).toBe(TOKEN);
  });

  it("are redeemed as the token Auth made, with nothing else alongside", async () => {
    const { send, seen } = gotrue();
    const sealed = await sealAuthToken(instance, TOKEN, "recovery");
    expect((await guardLink(instance, verify({ type: "recovery", token_hash: sealed, email: "owner@example.com", token: "123456", redirect_to: "https://ops.example.com/" }), send)).status).toBe(200);
    expect(seen).toEqual([{ type: "recovery", token_hash: TOKEN, redirect_to: "https://ops.example.com/" }]);
  });

  it("never reach Auth without the signature, however the token is guessed at", async () => {
    const { send, seen } = gotrue();
    const sealed = await sealAuthToken(instance, TOKEN, "magiclink");
    const other = await sealAuthToken({ ...instance, SUPABASE_SECRET_KEY: "sb_secret_other" }, TOKEN, "magiclink");
    for (const body of [
      { type: "magiclink", token_hash: TOKEN }, // Auth's token alone, as a guess would be
      { type: "magiclink", token_hash: `${TOKEN}.` },
      { type: "magiclink", token_hash: `${TOKEN}.${"0".repeat(40)}` },
      { type: "magiclink", token_hash: other }, // another server's signature
      { type: "recovery", token_hash: sealed }, // signed as another kind of link
      { type: "magiclink", token_hash: sealed.replace(/^ab/, "ac") }, // the signature of a different token
      { type: "magiclink", token_hash: `${"a".repeat(500)}.${"0".repeat(40)}` },
      { type: "magiclink", email: "owner@example.com", token: "123456" }, // a code typed with an email
      { token_hash: sealed },
      "not json",
      [{ type: "magiclink", token_hash: sealed }],
    ]) {
      const response = await guardLink(instance, verify(body), send);
      expect(response.status, JSON.stringify(body)).toBe(403);
      expect(((await response.json()) as { error_code: string }).error_code).toBe("otp_expired");
    }
    expect((await guardLink(instance, verify(null, "GET"), send)).status).toBe(403);
    expect(seen).toHaveLength(0);
    // The real one still works after all that: nothing was counted against it.
    expect((await guardLink(instance, verify({ type: "magiclink", token_hash: sealed }), send)).status).toBe(200);
  });

  it("reads a field's name whatever its case, as Auth does", async () => {
    const { send, seen } = gotrue();
    const sealed = await sealAuthToken(instance, TOKEN, "invite");
    expect((await guardLink(instance, verify({ TYPE: "invite", Token_Hash: sealed }), send)).status).toBe(200);
    expect(seen).toEqual([{ type: "invite", token_hash: TOKEN }]);
  });

  it("knows a route by any spelling of its address", () => {
    const route = (path: string) => authRoute(new URL(`http://x/auth/v1${path}`), "/auth/v1");
    for (const path of ["/verify", "/verify/", "//verify", "/VERIFY", "/v%65rify", "/verify?token=1"]) expect(route(path), path).toBe("/verify");
    expect(route("/token")).toBe("/token");
    for (const path of ["/recover", "/otp", "/magiclink", "/resend"]) expect(sendsAuthMail(route(path)), path).toBe(true);
    for (const path of ["/token", "/user", "/logout", "/verify", "/authorize"]) expect(sendsAuthMail(route(path)), path).toBe(false);
  });
});
