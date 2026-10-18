/**
 * Visitors' addresses (lib/visitor.ts): only what the deployment's own proxy says counts, or the
 * connection's address with nothing in front. Docker publishes the port on this computer only, which
 * that rule depends on. And the gateway (lib/gateway.ts) tells Auth, REST and Storage that address,
 * not the headers the visitor sent.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { HttpBindings } from "@hono/node-server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { gateway } from "../src/lib/gateway";
import { visitorIp } from "../src/lib/visitor";

const env: Env = { SUPABASE_URL: "http://127.0.0.1:8080", SUPABASE_SECRET_KEY: "sb_secret_test" };
const railway: Env = { ...env, RAILWAY_PROJECT_ID: "proj-1", RAILWAY_PUBLIC_DOMAIN: "crewtavo-production.up.railway.app" };

/** Headers a visitor made up, before any proxy adds its own. */
const forged = { "X-Forwarded-For": "198.51.100.1", "X-Real-IP": "198.51.100.2" };
// Caddy on the same machine reaches the container from Docker's network.
const CADDY = "172.18.0.1";

const ip = (e: Env, headers: Record<string, string>, connection?: string) => visitorIp(e, new Headers(headers), connection);

afterEach(() => vi.unstubAllGlobals());

describe("visitor addresses", () => {
  it("on Railway, go by the X-Real-IP its edge sets, not what the visitor sent", () => {
    // The edge replaces X-Real-IP; X-Forwarded-For may still carry the visitor's own entries.
    expect(ip(railway, { ...forged, "X-Real-IP": "203.0.113.9" }, "100.64.0.7")).toBe("203.0.113.9");
    expect(ip(railway, { "X-Forwarded-For": "198.51.100.1, 203.0.113.9" }, "100.64.0.7")).toBe("100.64.0.7");
    // Another service in the project, over the private network: its own address.
    expect(ip(railway, {}, "fd12:3456::1")).toBe("fd12:3456::1");
  });

  it("elsewhere, go by the X-Forwarded-For entry the web server in front adds last", () => {
    // Caddy replaces what the visitor sent, or adds to it (a proxy it trusts, an older version).
    expect(ip(env, { ...forged, "X-Forwarded-For": "203.0.113.9" }, CADDY)).toBe("203.0.113.9");
    expect(ip(env, { ...forged, "X-Forwarded-For": "198.51.100.1, 198.51.100.3,203.0.113.9" }, CADDY)).toBe("203.0.113.9");
    expect(ip(env, { "X-Forwarded-For": "203.0.113.9" }, "::ffff:127.0.0.1")).toBe("203.0.113.9");
    expect(ip(env, { "X-Forwarded-For": "2001:db8::9" }, "::1")).toBe("2001:db8::9");
    // Nothing added: the web server's own address, never X-Real-IP.
    expect(ip(env, { "X-Real-IP": "198.51.100.2" }, CADDY)).toBe(CADDY);
  });

  it("use the connection's address when it came straight to the port", () => {
    expect(ip(env, forged, "203.0.113.50")).toBe("203.0.113.50");
    expect(ip(env, { "X-Forwarded-For": "198.51.100.1, 203.0.113.9" }, "::ffff:203.0.113.50")).toBe("203.0.113.50");
    expect(ip(env, {}, "2001:db8::50")).toBe("2001:db8::50");
    // Not served by server.ts at all: nothing to go by, so no header is believed either.
    expect(ip(env, forged)).toBe("unknown");
  });

  it("follow CREWTAVO_VISITOR_IP when something else is in front", () => {
    // Cloudflare, then Caddy: two entries added.
    const twoHops = { ...env, CREWTAVO_VISITOR_IP: "X-Forwarded-For:2" };
    expect(ip(twoHops, { "X-Forwarded-For": "198.51.100.1, 203.0.113.9, 172.70.1.1" }, CADDY)).toBe("203.0.113.9");
    // A request that skipped Cloudflare has only Caddy's entry, which is the visitor.
    expect(ip(twoHops, { "X-Forwarded-For": "203.0.113.9" }, CADDY)).toBe("203.0.113.9");

    const cloudflare = { ...env, CREWTAVO_VISITOR_IP: "cf-connecting-ip" };
    expect(ip(cloudflare, { ...forged, "CF-Connecting-IP": "203.0.113.9" }, "172.70.1.1")).toBe("203.0.113.9");
    expect(ip(cloudflare, forged, "172.70.1.1")).toBe("172.70.1.1");

    // nginx with proxy_set_header X-Real-IP $remote_addr, which replaces the visitor's own.
    const nginx = { ...env, CREWTAVO_VISITOR_IP: "x-real-ip" };
    expect(ip(nginx, { ...forged, "X-Real-IP": "203.0.113.9" }, "127.0.0.1")).toBe("203.0.113.9");

    const none = { ...railway, CREWTAVO_VISITOR_IP: "connection" };
    expect(ip(none, { ...forged, "X-Real-IP": "203.0.113.9" }, "10.0.0.5")).toBe("10.0.0.5");
  });

  it("take an address with a port or brackets, and nothing that isn't one", () => {
    expect(ip(env, { "X-Forwarded-For": "203.0.113.9:51234" }, CADDY)).toBe("203.0.113.9");
    expect(ip(env, { "X-Forwarded-For": "[2001:DB8::9]:443" }, CADDY)).toBe("2001:db8::9");
    expect(ip(env, { "X-Forwarded-For": "203.0.113.9, unknown" }, CADDY)).toBe(CADDY);
    expect(ip(railway, { "X-Real-IP": "<script>" }, "100.64.0.7")).toBe("100.64.0.7");
  });

  it("go by the default when CREWTAVO_VISITOR_IP isn't something it understands", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    for (const setting of ["x-forwarded-for:0", "X Real IP"]) {
      const e = { ...env, CREWTAVO_VISITOR_IP: setting };
      expect(ip(e, { ...forged, "X-Forwarded-For": "203.0.113.9" }, CADDY)).toBe("203.0.113.9");
      expect(ip(e, forged, "203.0.113.50")).toBe("203.0.113.50");
    }
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("CREWTAVO_VISITOR_IP=x-forwarded-for:0"));
    warn.mockRestore();
  });
});

describe("the Docker instance", () => {
  /** The ports docker-compose.yml publishes, with its ${NAME:-default} settings filled in from `vars`. */
  function published(vars: Record<string, string> = {}) {
    const compose = readFileSync(fileURLToPath(new URL("../../../docker-compose.yml", import.meta.url)), "utf8");
    return [...compose.matchAll(/^\s+ports:\n((?:\s+- .*\n)+)/gm)]
      .flatMap((m) => m[1]!.trim().split("\n"))
      .map((line) => line.trim().replace(/^- "?|"?$/g, "").replace(/\$\{(\w+):-([^}]*)\}/g, (_, name: string, fallback: string) => vars[name] || fallback));
  }

  it("publishes Crewtavo's port on this computer only, unless CREWTAVO_BIND opens it", () => {
    // On every address, Docker hands some outside connections over from its own network (over IPv6,
    // or all of them on Docker Desktop), and those would pass for the web server's.
    expect(published()).toEqual(["127.0.0.1:8080:8080"]);
    expect(published({ CREWTAVO_PORT: "9090" })).toEqual(["127.0.0.1:9090:8080"]);
    expect(published({ CREWTAVO_BIND: "0.0.0.0" })).toEqual(["0.0.0.0:8080:8080"]);
  });
});

describe("the gateway", () => {
  const stack = { auth: "http://auth:9999", rest: "http://rest:3000", storage: "http://storage:5000" };
  const from = (remoteAddress: string) => ({ incoming: { socket: { remoteAddress } } }) as unknown as HttpBindings;

  /** Auth, REST and Storage: each answers 200 and remembers the headers it got. */
  function services() {
    const seen: Array<{ url: string; forwardedFor: string | null; realIp: string | null }> = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      seen.push({ url: String(input), forwardedFor: headers.get("x-forwarded-for"), realIp: headers.get("x-real-ip") });
      return Response.json({ access_token: "jwt" });
    });
    return seen;
  }

  it("tells Auth, REST and Storage the visitor's address, not the headers the visitor sent", async () => {
    const seen = services();
    const routes = gateway(env, stack);
    const signIn = { method: "POST", headers: { "Content-Type": "application/json", ...forged, "X-Forwarded-For": "198.51.100.1, 203.0.113.9" }, body: JSON.stringify({ email: "ana@example.com", password: "right" }) };
    // A password sign-in goes through the sign-in guard first.
    expect((await routes.request("/auth/v1/token?grant_type=password", signIn, from(CADDY))).status).toBe(200);
    expect((await routes.request("/auth/v1/user", { headers: { ...forged, "X-Forwarded-For": "198.51.100.1, 203.0.113.9" } }, from(CADDY))).status).toBe(200);
    expect((await routes.request("/rest/v1/jobs", { headers: { ...forged, "X-Forwarded-For": "203.0.113.9" } }, from(CADDY))).status).toBe(200);
    expect((await routes.request("/storage/v1/object/photos/a.jpg", { headers: forged }, from("203.0.113.50"))).status).toBe(200);
    expect(seen).toEqual([
      { url: "http://auth:9999/token?grant_type=password", forwardedFor: "203.0.113.9", realIp: "203.0.113.9" },
      { url: "http://auth:9999/user", forwardedFor: "203.0.113.9", realIp: "203.0.113.9" },
      { url: "http://rest:3000/jobs", forwardedFor: "203.0.113.9", realIp: "203.0.113.9" },
      { url: "http://storage:5000/object/photos/a.jpg", forwardedFor: "203.0.113.50", realIp: "203.0.113.50" },
    ]);
  });

  it("on Railway, passes on the X-Real-IP its edge set", async () => {
    const seen = services();
    await gateway(railway, stack).request("/auth/v1/user", { headers: { ...forged, "X-Real-IP": "203.0.113.9" } }, from("100.64.0.7"));
    expect(seen).toEqual([{ url: "http://auth:9999/user", forwardedFor: "203.0.113.9", realIp: "203.0.113.9" }]);
  });
});
