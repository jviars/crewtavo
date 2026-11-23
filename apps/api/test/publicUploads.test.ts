/**
 * Strangers' uploads (lib/publicUploads.ts): what each visitor's address and each business may take
 * in a day, counted in the database; the records the gateway holds upload links to; and a link never
 * handed out without its record. The gateway's part is in gateway.test.ts; the table in
 * supabase/tests/public_upload_links_test.sql.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { publicUploadsFrom, spendUploadBytes, UPLOAD_BYTES_A_DAY, uploadLinks, uploadsLeftToday, VISITOR_BYTES_A_DAY } from "../src/lib/publicUploads";
import { adminClient } from "../src/lib/supabase";

const env = { SUPABASE_URL: "http://db.test", SUPABASE_SECRET_KEY: "secret" } as Env;
const CO = "0b0a0000-0000-4000-8000-000000000001";

interface Call {
  method: string;
  path: string;
  body: any;
}

/** PostgREST and Storage in memory: `answer` gives the reply for a call, or rows as JSON. */
function serve(answer: (call: Call) => unknown = () => []) {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const text = typeof init?.body === "string" ? init.body : "";
    const call = { method: (init?.method ?? "GET").toUpperCase(), path: url.pathname.replace(/^\/rest\/v1\//, ""), body: text ? JSON.parse(text) : undefined };
    calls.push(call);
    const out = answer(call);
    return out instanceof Response ? out : Response.json(out ?? []);
  });
  return calls;
}
afterEach(() => vi.unstubAllGlobals());

describe("a day's worth of strangers' files", () => {
  it("counts what a visitor sends against their address and the business, in KB, for a day", async () => {
    const calls = serve((call) => (call.path === "rpc/rate_limit_spend" ? true : []));
    expect(await spendUploadBytes(env, CO, "203.0.113.9", 2_500)).toBe(true);
    expect(calls.map((c) => c.body)).toEqual([
      { p_key: "upload-bytes:ip:203.0.113.9", p_amount: 3, p_max: VISITOR_BYTES_A_DAY / 1000, p_window_seconds: 86_400 },
      { p_key: `upload-bytes:company:${CO}`, p_amount: 3, p_max: UPLOAD_BYTES_A_DAY / 1000, p_window_seconds: 86_400 },
    ]);
  });

  it("counts an IPv6 visitor by their /64", async () => {
    const calls = serve((call) => (call.path === "rpc/rate_limit_spend" ? true : []));
    await spendUploadBytes(env, CO, "2001:db8:1:2:aaaa:bbbb:cccc:dddd", 1);
    expect(calls[0]!.body.p_key).toBe("upload-bytes:ip:2001:db8:1:2::/64");
  });

  it("stops at a visitor's day without using up the business's", async () => {
    const calls = serve((call) => (call.path === "rpc/rate_limit_spend" ? !call.body.p_key.startsWith("upload-bytes:ip:") : []));
    expect(await spendUploadBytes(env, CO, "203.0.113.9", 2_500)).toBe(false);
    expect(calls.filter((c) => c.path === "rpc/rate_limit_spend")).toHaveLength(1);
  });

  it("stops at the business's day, and tells its owners and admins once a day", async () => {
    let told = false;
    const calls = serve((call) => {
      if (call.path === "rpc/rate_limit_spend") return !call.body.p_key.startsWith("upload-bytes:company:");
      if (call.path === "rpc/rate_limit_hit") return !told && (told = true);
      if (call.path === "memberships") return [{ user_id: "owner-1" }, { user_id: "admin-1" }];
      return [];
    });
    expect(await spendUploadBytes(env, CO, "203.0.113.9", 2_500)).toBe(false);
    expect(await spendUploadBytes(env, CO, "203.0.113.10", 2_500)).toBe(false);
    const notices = calls.filter((c) => c.method === "POST" && c.path === "notifications");
    expect(notices).toHaveLength(1);
    expect(notices[0]!.body).toEqual([
      expect.objectContaining({ company_id: CO, user_id: "owner-1", kind: "hosting", title: "Files sent to you are paused for today", link: "/settings?tab=storage" }),
      expect.objectContaining({ user_id: "admin-1" }),
    ]);
  });

  it("lets uploads through when it can't be counted: a budget never stops normal use", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    serve(() => Response.json({ message: "the database is busy" }, { status: 503 }));
    expect(await spendUploadBytes(env, CO, "203.0.113.9", 2_500)).toBe(true);
    expect(await uploadsLeftToday(env, CO)).toBe(true);
  });

  it("asks whether the business has room today without counting anything", async () => {
    const calls = serve((call) => (call.path === "rpc/rate_limit_spend" ? false : []));
    expect(await uploadsLeftToday(env, CO)).toBe(false);
    expect(calls.map((c) => c.body)).toEqual([{ p_key: `upload-bytes:company:${CO}`, p_amount: 0, p_max: UPLOAD_BYTES_A_DAY / 1000, p_window_seconds: 86_400 }]);
  });
});

describe("upload links' records", () => {
  it("are kept before any link is made, with each file's size, until a little after the link runs out", async () => {
    const calls = serve((call) => (call.path.startsWith("/storage/v1/object/upload/sign/") ? { url: `${call.path.replace("/storage/v1", "")}?token=tok` } : []));
    const expiresAt = Date.now() + 3 * 3600_000;
    const links = await uploadLinks(adminClient(env), { company: CO, kind: "form", files: [{ path: `${CO}/plans/a.pdf`, bytes: 4096 }, { path: `${CO}/plans/b.jpg`, bytes: 0.5 }], expiresAt });
    expect(links).toEqual([{ path: `${CO}/plans/a.pdf`, token: "tok" }, { path: `${CO}/plans/b.jpg`, token: "tok" }]);
    expect(calls[0]).toMatchObject({ method: "POST", path: "upload_links" });
    expect(calls[0]!.body).toEqual([
      { path: `${CO}/plans/a.pdf`, company_id: CO, kind: "form", max_bytes: 4096, expires_at: new Date(expiresAt + 10 * 60_000).toISOString() },
      { path: `${CO}/plans/b.jpg`, company_id: CO, kind: "form", max_bytes: 1, expires_at: new Date(expiresAt + 10 * 60_000).toISOString() },
    ]);
  });

  it("hand out no link at all when they can't be kept", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const calls = serve((call) => (call.path === "upload_links" ? Response.json({ message: "the database is busy" }, { status: 503 }) : []));
    expect(await uploadLinks(adminClient(env), { company: CO, kind: "paperwork", files: [{ path: `${CO}/subs/s1/a.pdf`, bytes: 10 }], expiresAt: Date.now() })).toEqual([null]);
    expect(calls.some((c) => c.path.startsWith("/storage/"))).toBe(false);
  });

  it("are read for the gateway by the file's name", async () => {
    const calls = serve((call) => (call.path === "upload_links" ? [{ company_id: CO, max_bytes: "4096", expires_at: "2026-11-22T15:00:00Z" }] : []));
    expect(await publicUploadsFrom(env).find(`${CO}/plans/a.pdf`)).toEqual({ company: CO, maxBytes: 4096, expiresAt: Date.parse("2026-11-22T15:00:00Z") });
    expect(calls[0]!.method).toBe("GET");
    serve(() => []);
    expect(await publicUploadsFrom(env).find(`${CO}/plans/x.pdf`)).toBeNull();
    // supabase-js asks again after a read's 503, three times, after what Retry-After says (else 1, 2
    // and 4 seconds): here at once, and it still throws once those run out.
    const busy = serve(() => Response.json({ message: "the database is busy" }, { status: 503, headers: { "Retry-After": "0" } }));
    await expect(publicUploadsFrom(env).find(`${CO}/plans/x.pdf`)).rejects.toThrow("the database is busy");
    expect(busy).toHaveLength(4);
  });
});
