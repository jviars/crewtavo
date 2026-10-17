import { afterEach, describe, expect, it, vi } from "vitest";
import { app } from "../src/app";
import { readEnv, type Env } from "../src/env";
import { decryptJson, encryptJson, signToken, verifyToken } from "../src/lib/crypto";
import { createHmac } from "node:crypto";
import { emailAuthLink } from "../src/lib/auth";
import { apiKey, stackServices, withStack } from "../src/lib/stack";
import { setStartup } from "../src/lib/startup";

const base: Env = {
  SUPABASE_URL: "https://abcd1234.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
  SUPABASE_SECRET_KEY: "sb_secret_test",
};

describe("encryption key", () => {
  const exp = () => Date.now() / 1000 + 60;

  it("works without ENCRYPTION_KEY, from the Supabase secret key", async () => {
    const sealed = await encryptJson(base, { token: "abc" });
    expect(await decryptJson(base, sealed)).toEqual({ token: "abc" });
    const token = await signToken(base, { id: "x", exp: exp() });
    expect(await verifyToken(base, token)).toMatchObject({ id: "x" });
    // A different Supabase secret key can't read or verify them.
    const other = { ...base, SUPABASE_SECRET_KEY: "sb_secret_other" };
    await expect(decryptJson(other, sealed)).rejects.toThrow();
    expect(await verifyToken(other, token)).toBeNull();
  });

  it("keeps the derived key separate from an ENCRYPTION_KEY equal to the secret key", async () => {
    const token = await signToken(base, { id: "x", exp: exp() });
    expect(await verifyToken({ ...base, ENCRYPTION_KEY: "sb_secret_test" + "x".repeat(32) }, token)).toBeNull();
  });

  it("accepts a plain phrase of 32+ characters, and still reads base64 keys as before", async () => {
    const phrase = { ...base, ENCRYPTION_KEY: "correct horse battery staple, mowing on tuesdays!" };
    expect(await decryptJson(phrase, await encryptJson(phrase, { a: 1 }))).toEqual({ a: 1 });
    const b64 = { ...base, ENCRYPTION_KEY: btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => i * 7))) };
    const token = await signToken(b64, { id: "y", exp: exp() });
    expect(await verifyToken({ ...b64, SUPABASE_SECRET_KEY: "changed" }, token)).toMatchObject({ id: "y" });
  });

  it("explains a key that's too short", async () => {
    await expect(encryptJson({ ...base, ENCRYPTION_KEY: "short" }, {})).rejects.toThrow(/at least 32 characters/);
  });
});

describe("readEnv", () => {
  it("treats blank values as unset", () => {
    const env = readEnv({ SUPABASE_URL: "https://x.supabase.co", APP_URL: "", ENCRYPTION_KEY: "  ", RESEND_API_KEY: "re_1" });
    expect(env.APP_URL).toBeUndefined();
    expect(env.ENCRYPTION_KEY).toBeUndefined();
    expect(env.RESEND_API_KEY).toBe("re_1");
  });

  it("uses the platform's production address when APP_URL isn't set", () => {
    expect(readEnv({ RAILWAY_PUBLIC_DOMAIN: "crewtavo.up.railway.app" }).APP_URL).toBe("https://crewtavo.up.railway.app");
    expect(readEnv({ APP_URL: "https://ops.example.com", RAILWAY_PUBLIC_DOMAIN: "x.up.railway.app" }).APP_URL).toBe("https://ops.example.com");
  });
});

describe("emailed auth links", () => {
  it("open the app with the token, not Supabase's redirect", () => {
    expect(emailAuthLink("https://ops.example.com", "hash123", "invite")).toBe("https://ops.example.com/?token_hash=hash123&type=invite");
    expect(emailAuthLink("https://ops.example.com", "h", "recovery", true)).toBe("https://ops.example.com/?token_hash=h&type=recovery&welcome=1");
  });
});

describe("instance stack", () => {
  it("mints API keys Supabase's services accept: HS256 JWTs for the role, signed with JWT_SECRET", () => {
    const key = apiKey("a".repeat(64), "service_role");
    const [header, payload, signature] = key.split(".");
    expect(JSON.parse(Buffer.from(header, "base64url").toString())).toEqual({ alg: "HS256", typ: "JWT" });
    expect(JSON.parse(Buffer.from(payload, "base64url").toString())).toMatchObject({ role: "service_role" });
    expect(signature).toBe(createHmac("sha256", "a".repeat(64)).update(`${header}.${payload}`).digest("base64url"));
    expect(apiKey("a".repeat(64), "service_role")).toBe(key); // stable across restarts
  });

  it("turns on the gateway and single-company mode only when JWT_SECRET is set", () => {
    expect(withStack({ SUPABASE_URL: "https://x.supabase.co" }, 8080)).toEqual({ SUPABASE_URL: "https://x.supabase.co" });
    const env = withStack({ JWT_SECRET: "s".repeat(64) }, 8080);
    expect(env).toMatchObject({ SUPABASE_URL: "http://127.0.0.1:8080", CREWTAVO_GATEWAY: "1", CREWTAVO_SINGLE_COMPANY: "1" });
    expect(env.SUPABASE_SERVICE_ROLE_KEY).toBe(apiKey("s".repeat(64), "service_role"));
    expect(stackServices({ JWT_SECRET: "s", SUPABASE_AUTH_URL: "http://auth.railway.internal:9999" })?.auth).toBe("http://auth.railway.internal:9999");
  });
});

describe("GET /api/setup", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    setStartup(null);
  });

  const status = async (env: object) => (await (await app.request("/api/setup", {}, env)).json()) as Record<string, unknown>;

  /** Answers Supabase's auth settings and the companies table the way an instance in that state would. */
  const supabase = (auth: number, table: () => Response, users: unknown[] = []) =>
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/auth/v1/settings")) return new Response("{}", { status: auth });
      if (url.includes("/auth/v1/admin/users")) return Response.json({ users, aud: "authenticated" });
      if (url.includes("/rest/v1/companies")) return table();
      throw new Error(`unexpected ${url}`);
    });

  it("says when it's running without its database", async () => {
    expect(await status({ RAILWAY_PROJECT_ID: "p" })).toMatchObject({ ready: false, platform: "railway", database: "not_connected", needsOwner: false });
  });

  it("says it's starting while migrations run, and why they failed", async () => {
    setStartup({ state: "migrating" });
    expect(await status(base)).toMatchObject({ ready: false, database: "starting" });
    setStartup({ state: "failed", firstInstall: true, problem: "wrong_password" });
    expect(await status(base)).toMatchObject({ ready: false, database: "migration_failed", migration: { problem: "wrong_password" } });
  });

  it("says when the schema hasn't been applied", async () => {
    supabase(200, () => Response.json({ code: "PGRST205", message: "Could not find the table 'public.companies' in the schema cache" }, { status: 404 }));
    expect(await status({ ...base, SUPABASE_URL: "https://empty0001.supabase.co" })).toMatchObject({ ready: false, database: "empty" });
  });

  it("asks for the owner's account on a new single-company instance", async () => {
    supabase(200, () => Response.json([]));
    expect(await status({ ...base, SUPABASE_URL: "http://127.0.0.1:9001", CREWTAVO_SINGLE_COMPANY: "1" })).toMatchObject({ ready: true, needsOwner: true });
    supabase(200, () => Response.json([]), [{ id: "u1" }]);
    expect(await status({ ...base, SUPABASE_URL: "http://127.0.0.1:9002", CREWTAVO_SINGLE_COMPANY: "1" })).toMatchObject({ ready: true, needsOwner: false });
  });

  it("is ready once the schema answers, and never echoes secrets", async () => {
    supabase(200, () => Response.json([]));
    const body = await status({ ...base, SUPABASE_URL: "https://ready0001.supabase.co" });
    expect(body).toMatchObject({ ready: true, database: "ok", needsOwner: false });
    expect(JSON.stringify(body)).not.toContain("sb_secret_test");
  });
});

describe("POST /api/setup/owner", () => {
  afterEach(() => vi.unstubAllGlobals());
  const post = (env: object) =>
    app.request("/api/setup/owner", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ full_name: "Pat Owner", email: "pat@example.com", password: "long-enough-pw" }) }, env);

  it("only exists on single-company instances", async () => {
    expect((await post(base)).status).toBe(404);
  });

  type User = { id: string; created_at: string };
  const ME = "00000000-0000-4000-8000-00000000000a";
  const THEM = "00000000-0000-4000-8000-00000000000b";
  /** Supabase with `existing` accounts. Creating ours (at 12:00:00.500) also brings in `concurrent` ones, set up at the same moment. */
  const supabase = (existing: User[], concurrent: User[] = []) => {
    const created = { id: ME, created_at: "2026-10-17T12:00:00.500Z" };
    let users = existing;
    const deleted: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/rpc/rate_limit_hit")) return Response.json(true);
      if (url.endsWith("/auth/v1/settings")) return Response.json({});
      if (url.includes("/rest/v1/companies")) return Response.json([]);
      if (url.includes("/auth/v1/admin/users") && init?.method === "POST") {
        users = [...users, ...concurrent, created];
        return Response.json({ ...created, aud: "authenticated", email: "pat@example.com" });
      }
      if (url.includes("/auth/v1/admin/users/") && init?.method === "DELETE") {
        deleted.push(url.split("/").pop()!);
        return Response.json({});
      }
      if (url.includes("/auth/v1/admin/users")) return Response.json({ users, aud: "authenticated" });
      throw new Error(`unexpected ${url}`);
    });
    return deleted;
  };

  it("refuses once someone has an account", async () => {
    supabase([{ id: "u1", created_at: "2026-10-17T12:00:00.000Z" }]);
    const res = await post({ ...base, CREWTAVO_SINGLE_COMPANY: "1" });
    expect(res.status).toBe(409);
  });

  it("keeps the first of two owners set up at the same moment, and only the first", async () => {
    // Someone else's account appeared between our check and our own: theirs is older, so we step back.
    let deleted = supabase([], [{ id: THEM, created_at: "2026-10-17T12:00:00.100Z" }]);
    const later = await post({ ...base, CREWTAVO_SINGLE_COMPANY: "1", SUPABASE_URL: "https://race-1.supabase.co" });
    expect(later.status).toBe(409);
    expect(deleted).toEqual([ME]);

    // The older account keeps going even though it sees the newer one too.
    deleted = supabase([], [{ id: THEM, created_at: "2026-10-17T12:00:00.900Z" }]);
    const first = await post({ ...base, CREWTAVO_SINGLE_COMPANY: "1", SUPABASE_URL: "https://race-2.supabase.co" });
    expect(first.status).toBe(201);
    expect(deleted).toEqual([]);
  });
});
