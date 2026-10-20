import dns from "node:dns";
import type { IncomingMessage, OutgoingHttpHeaders, RequestOptions, ServerResponse } from "node:http";
import { createServer as createSecureServer } from "node:https";
import { isIP, type AddressInfo, type LookupFunction } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { app } from "../src/app";
import type { Env } from "../src/env";
import { checkSite, configHref, detectCms, framingOf, normalizeAddress, readBackend, WebsiteError } from "../src/integrations/website";

// Sveltia CMS on Apps: the website's editor by its address, checked from the public internet only.

/**
 * "The internet" for these tests, as in calendars.test.ts: names get their addresses from `names`
 * below and the code's own lookup decides on them; when it says yes, the connection goes to the
 * server on this machine instead, and HTTPS still checks the certificate against the name.
 */
const internet = vi.hoisted(() => ({
  requests: [] as string[],
  onThisMachine: (lookup: LookupFunction): LookupFunction => (host, options, done) =>
    lookup(host, options, (error, address, family) =>
      error ? done(error, address, family) : done(null, Array.isArray(address) ? address.map(() => ({ address: "127.0.0.1", family: 4 })) : "127.0.0.1", 4)),
  // A self-signed certificate for greenlawn.example and www.greenlawn.example, made for these tests (it's trusted nowhere else).
  KEY: `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgPIVXP284yHn5TQPB
0Zq6YONsTWFQi7yyed29vpLbJe2hRANCAASErUSz3qf4Jup0gJjCLAtml1AF9Dh7
RS/8UwsXZrsdaZbGGPKDOYnL+HPOjzw47m37PtksyurG32qXR4FObSAg
-----END PRIVATE KEY-----`,
  CERT: `-----BEGIN CERTIFICATE-----
MIIBxTCCAWygAwIBAgIUT6nTyegX5bnFqRZG/+39bOtx8vEwCgYIKoZIzj0EAwIw
HDEaMBgGA1UEAwwRZ3JlZW5sYXduLmV4YW1wbGUwIBcNMjYxMDIwMTYzNDU1WhgP
MjEyNjA5MjYxNjM0NTVaMBwxGjAYBgNVBAMMEWdyZWVubGF3bi5leGFtcGxlMFkw
EwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEhK1Es96n+CbqdICYwiwLZpdQBfQ4e0Uv
/FMLF2a7HWmWxhjygzmJy/hzzo88OO5t+z7ZLMrqxt9ql0eBTm0gIKOBiTCBhjAd
BgNVHQ4EFgQUAMdin8Y5V3ICBrHQBt+8cUyznnowHwYDVR0jBBgwFoAUAMdin8Y5
V3ICBrHQBt+8cUyznnowDwYDVR0TAQH/BAUwAwEB/zAzBgNVHREELDAqghFncmVl
bmxhd24uZXhhbXBsZYIVd3d3LmdyZWVubGF3bi5leGFtcGxlMAoGCCqGSM49BAMC
A0cAMEQCIE2VVuapkBdIaK5xg5pOQ6c6t2M4iuIaAVhIKbpls+l9AiBvyA5iD2fD
brgDvC5FU14G7YXN3GEtkUGNh1kaGZUVvw==
-----END CERTIFICATE-----`,
}));

vi.mock("node:https", async (importOriginal) => {
  const https = await importOriginal<typeof import("node:https") & { default: typeof import("node:https") }>();
  const request = (url: URL, options: RequestOptions, callback: (response: IncomingMessage) => void) => {
    internet.requests.push(String(url));
    return https.request(url, { ...options, ca: internet.CERT, lookup: internet.onThisMachine(options.lookup!) }, callback);
  };
  return { ...https, request, default: { ...https.default, request } };
});
vi.mock("node:http", async (importOriginal) => {
  const http = await importOriginal<typeof import("node:http") & { default: typeof import("node:http") }>();
  const request = (url: URL, options: RequestOptions, callback: (response: IncomingMessage) => void) => {
    internet.requests.push(String(url));
    return http.request(url, { ...options, lookup: internet.onThisMachine(options.lookup!) }, callback);
  };
  return { ...http, request, default: { ...http.default, request } };
});

const names = new Map<string, string[]>();
function answer(host: string, options: { all?: boolean }, callback: (error: Error | null, address?: unknown, family?: number) => void) {
  const found = names.get(host)?.map((address) => ({ address, family: isIP(address) }));
  if (!found) return callback(Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: "ENOTFOUND" }));
  if (options.all) callback(null, found);
  else callback(null, found[0]!.address, found[0]!.family);
}

const SVELTIA_PAGE = `<!doctype html><html><head><title>Content Manager</title></head>
<body><script src="https://unpkg.com/@sveltia/cms/dist/sveltia-cms.js"></script></body></html>`;
const CONFIG = `# Sveltia CMS
backend:
  name: github
  repo: "greenlawn/website" # where the site lives
  branch: main
  commit_messages:
    create: Create {{collection}} "{{slug}}"
media_folder: static/images
collections: []
`;

/** The website: /admin/ with Sveltia on it and its config beside it, unless a test says otherwise. */
type Page = { status?: number; headers?: OutgoingHttpHeaders; body?: string };
let pages: Record<string, Page> = {};
const hits: string[] = [];
const site = createSecureServer({ key: internet.KEY, cert: internet.CERT }, (req: IncomingMessage, res: ServerResponse) => {
  hits.push(`${req.headers.host?.split(":")[0]}${req.url}`);
  const page = pages[`${req.headers.host?.split(":")[0]}${req.url}`] ?? pages[req.url ?? ""] ?? { status: 404, body: "Not found" };
  res.writeHead(page.status ?? 200, page.headers).end(page.body ?? "");
});
let port = 0;
const at = (host: string, path = "/") => `https://${host}:${port}${path}`;

beforeAll(async () => {
  port = await new Promise<number>((resolve) => site.listen(0, "127.0.0.1", () => resolve((site.address() as AddressInfo).port)));
});
afterAll(() => {
  site.closeAllConnections();
  site.close();
});
beforeEach(() => {
  names.set("greenlawn.example", ["203.0.113.20"]);
  names.set("www.greenlawn.example", ["203.0.113.20"]);
  vi.spyOn(dns, "lookup").mockImplementation(answer as unknown as typeof dns.lookup);
  pages = { "/admin/": { body: SVELTIA_PAGE, headers: { "Content-Type": "text/html" } }, "/admin/config.yml": { body: CONFIG } };
});
afterEach(() => {
  vi.restoreAllMocks();
  names.clear();
  internet.requests.length = 0;
  hits.length = 0;
});

const CREWTAVO = "https://crm.greenlawn.example";

describe("a website's address", () => {
  it("is tidied into its editor's page, always on https", () => {
    expect(normalizeAddress(" greenlawn.com ").toString()).toBe("https://greenlawn.com/admin/");
    expect(normalizeAddress("www.greenlawn.com/admin").toString()).toBe("https://www.greenlawn.com/admin/");
    expect(normalizeAddress("http://greenlawn.com/cms?x=1#top").toString()).toBe("https://greenlawn.com/cms/");
    expect(normalizeAddress("https://greenlawn.com/admin/index.html").toString()).toBe("https://greenlawn.com/admin/index.html");
    expect(() => normalizeAddress("ftp://greenlawn.com")).toThrow(WebsiteError);
    expect(() => normalizeAddress("greenlawn")).toThrow(/whole address/);
    expect(() => normalizeAddress("not a website")).toThrow(WebsiteError);
  });

  it("tells Sveltia from Decap, and from a page that's neither", () => {
    expect(detectCms(SVELTIA_PAGE)).toBe("sveltia");
    expect(detectCms('<script src="https://unpkg.com/decap-cms@^3.0.0/dist/decap-cms.js"></script>')).toBe("decap");
    expect(detectCms('<script src="https://unpkg.com/netlify-cms@^2.0.0/dist/netlify-cms.js"></script>')).toBe("decap");
    expect(detectCms("<h1>Welcome to Green Lawn</h1>")).toBeNull();
  });

  it("finds a config the page points at", () => {
    expect(configHref('<link href="/cms/config.yml" type="application/yaml" rel="cms-config-url" />')).toBe("/cms/config.yml");
    expect(configHref("<link rel='cms-config-url' href='https://cdn.example/site.yml?a=1&amp;b=2'>")).toBe("https://cdn.example/site.yml?a=1&b=2");
    expect(configHref('<link rel="stylesheet" href="/style.css">')).toBeNull();
  });

  it("reads where the editor saves, and nothing deeper", () => {
    expect(readBackend(CONFIG)).toEqual({ backend: "github", repo: "greenlawn/website", branch: "main" });
    expect(readBackend("backend: { name: gitlab, repo: 'greenlawn/site' }\n")).toEqual({ backend: "gitlab", repo: "greenlawn/site", branch: null });
    expect(readBackend("backend:\n    name: test-repo\n\n    # nothing else\nlocal_backend: true\n")).toEqual({ backend: "test-repo", repo: null, branch: null });
    expect(readBackend("collections: []\n")).toEqual({ backend: null, repo: null, branch: null });
  });

  it("can be shown in Crewtavo unless the site says otherwise", () => {
    expect(framingOf({}, CREWTAVO)).toBe("ok");
    expect(framingOf({ "x-frame-options": "SAMEORIGIN" }, CREWTAVO)).toBe("blocked");
    expect(framingOf({ "content-security-policy": "default-src 'self'; frame-ancestors 'self'" }, CREWTAVO)).toBe("blocked");
    expect(framingOf({ "content-security-policy": "frame-ancestors 'none'" }, CREWTAVO)).toBe("blocked");
    // frame-ancestors decides when it's there: browsers then ignore X-Frame-Options.
    expect(framingOf({ "content-security-policy": `frame-ancestors 'self' ${CREWTAVO}`, "x-frame-options": "DENY" }, CREWTAVO)).toBe("ok");
    expect(framingOf({ "content-security-policy": "frame-ancestors https://*.greenlawn.example" }, CREWTAVO)).toBe("ok");
    expect(framingOf({ "content-security-policy": "frame-ancestors https://*.other.example" }, CREWTAVO)).toBe("blocked");
    expect(framingOf({ "content-security-policy": "frame-ancestors *" }, CREWTAVO)).toBe("ok");
    expect(framingOf({ "content-security-policy": "frame-ancestors http://crm.greenlawn.example" }, CREWTAVO)).toBe("blocked");
  });
});

describe("checking a website's editor", () => {
  it("finds Sveltia, where it saves, and that Crewtavo can show it", async () => {
    const found = await checkSite(at("greenlawn.example"), CREWTAVO);
    expect(found).toMatchObject({ enabled: true, admin_url: at("greenlawn.example", "/admin/"), cms: "sveltia", backend: "github", repo: "greenlawn/website", branch: "main", framing: "ok" });
    expect(internet.requests).toEqual([at("greenlawn.example", "/admin/"), at("greenlawn.example", "/admin/config.yml")]);
  });

  it("follows the site's redirects, and keeps where they end", async () => {
    pages = { "greenlawn.example/admin/": { status: 301, headers: { Location: at("www.greenlawn.example", "/admin/") } }, "www.greenlawn.example/admin/": { body: SVELTIA_PAGE, headers: { "X-Frame-Options": "DENY" } } };
    const found = await checkSite(at("greenlawn.example", "/admin"), CREWTAVO);
    expect(found).toMatchObject({ admin_url: at("www.greenlawn.example", "/admin/"), cms: "sveltia", repo: null, framing: "blocked" });
  });

  it("says what's wrong with an address that isn't an editor", async () => {
    pages = {};
    await expect(checkSite(at("greenlawn.example"), CREWTAVO)).rejects.toThrow(/Nothing at greenlawn\.example:\d+\/admin\/\. If your editor isn't at \/admin/);
    pages = { "/admin/": { status: 401 } };
    await expect(checkSite(at("greenlawn.example"), CREWTAVO)).rejects.toThrow(/asks for a password/);
    names.delete("greenlawn.example");
    await expect(checkSite(at("greenlawn.example"), CREWTAVO)).rejects.toThrow("Couldn't find greenlawn.example. Check the spelling of your website's address.");
  });

  it("keeps a page that doesn't say Sveltia only when asked to", async () => {
    pages = { "/admin/": { body: '<script type="module" src="/_astro/admin.js"></script>' } };
    const refused = checkSite(at("greenlawn.example"), CREWTAVO);
    await expect(refused).rejects.toMatchObject({ code: "no_editor", message: expect.stringMatching(/Couldn't find Sveltia CMS/) });
    expect(await checkSite(at("greenlawn.example"), CREWTAVO, { anyway: true })).toMatchObject({ cms: null, backend: null, framing: "ok" });
  });

  it("never reaches this server, its network or cloud metadata", async () => {
    for (const address of ["localhost:8080", "127.0.0.1/admin", "10.0.0.5", "169.254.169.254/latest", "[::1]", "crewtavo.internal"]) {
      await expect(checkSite(address, CREWTAVO), address).rejects.toThrow(/private network/);
    }
    expect(internet.requests).toEqual([]);
    // A name pointed inside is refused as it's looked up for the connection.
    names.set("rebind.example", ["10.1.2.3"]);
    await expect(checkSite(`rebind.example:${port}`, CREWTAVO)).rejects.toThrow(/private network/);
    expect(hits).toEqual([]);
    // A redirect into the network is refused too, before it's followed.
    pages = { "/admin/": { status: 302, headers: { Location: "https://192.168.1.1/admin/" } } };
    await expect(checkSite(at("greenlawn.example"), CREWTAVO)).rejects.toThrow(/private network/);
    expect(hits).toEqual(["greenlawn.example/admin/"]);
  });
});

// ---------------------------------------------------------------------------------------------
// The routes: installing keeps the editor in the company's settings, where the menu reads it.
// ---------------------------------------------------------------------------------------------

const current = vi.hoisted(() => ({ settings: {} as Record<string, unknown>, role: "owner" }));
vi.mock("../src/lib/supabase", async (original) => {
  const answer = (table: string, calls: Array<[string, ...any[]]>) => {
    const update = calls.find(([n]) => n === "update");
    if (table === "memberships") return { data: { role: current.role, role_id: null } };
    if (table === "companies") {
      if (update) current.settings = update[1].settings;
      return { data: { settings: current.settings } };
    }
    if (table === "integration_secrets") return { data: null, count: 0 };
    return { data: [] };
  };
  const chain = (table: string, calls: Array<[string, ...any[]]>): unknown =>
    new Proxy(
      {},
      {
        get: (_, name) =>
          name === "then"
            ? (resolve: (value: unknown) => unknown) => Promise.resolve({ error: null, ...answer(table, calls) }).then(resolve)
            : (...args: unknown[]) => chain(table, [...calls, [String(name), ...args]]),
      },
    );
  const db = { from: (table: string) => chain(table, []), rpc: async () => ({ data: null, error: null }), auth: { getClaims: async () => ({ data: { claims: { sub: "00000000-0000-4000-8000-0000000000aa" } }, error: null }) } };
  return { ...(await original<typeof import("../src/lib/supabase")>()), adminClient: () => db, userClient: () => db };
});

const env: Env = {
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
  SUPABASE_SECRET_KEY: "sb_secret_test",
  ENCRYPTION_KEY: btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => i * 7))),
  APP_URL: CREWTAVO,
};
const headers = { Authorization: "Bearer token", "X-Company-Id": "00000000-0000-4000-8000-000000000001", "Content-Type": "application/json" };
const put = (body: unknown) => app.request("/api/apps/sveltia/site", { method: "PUT", headers, body: JSON.stringify(body) }, env);
const sveltiaApp = async () => ((await (await app.request("/api/apps", { headers }, env)).json()) as { apps: Array<Record<string, any>> }).apps.find((a) => a.id === "sveltia");

describe("Sveltia CMS on Apps", () => {
  beforeEach(() => {
    current.settings = { team_chat: { enabled: true } };
    current.role = "owner";
  });

  it("installs by its address, next to the company's other settings", async () => {
    expect(await sveltiaApp()).toMatchObject({ category: "Website", auth: "site", status: "disconnected", website: null });
    const res = await put({ address: at("greenlawn.example") });
    expect(res.status).toBe(200);
    expect(current.settings).toMatchObject({ team_chat: { enabled: true }, website: { enabled: true, admin_url: at("greenlawn.example", "/admin/"), repo: "greenlawn/website" } });
    expect(await sveltiaApp()).toMatchObject({ status: "connected", website: { cms: "sveltia", framing: "ok" } });
  });

  it("answers 422 for a page that isn't an editor, which can be kept anyway", async () => {
    pages = { "/admin/": { body: "<h1>Hi</h1>" } };
    const res = await put({ address: at("greenlawn.example") });
    expect(res.status).toBe(422);
    expect(current.settings).not.toHaveProperty("website");
    expect((await put({ address: at("greenlawn.example"), anyway: true })).status).toBe(200);
    expect(current.settings).toHaveProperty("website.cms", null);
  });

  it("uninstalls, leaving the rest of the settings", async () => {
    await put({ address: at("greenlawn.example") });
    const res = await app.request("/api/apps/sveltia/site", { method: "DELETE", headers }, env);
    expect(res.status).toBe(200);
    expect(current.settings).toEqual({ team_chat: { enabled: true } });
  });

  it("is only for owners and admins", async () => {
    current.role = "office";
    expect((await put({ address: at("greenlawn.example") })).status).toBe(403);
    expect(internet.requests).toEqual([]);
  });
});
