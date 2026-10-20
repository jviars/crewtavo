import dns from "node:dns";
import type { IncomingMessage, OutgoingHttpHeaders, RequestOptions, ServerResponse } from "node:http";
import { createServer as createSecureServer } from "node:https";
import { isIP, type AddressInfo, type LookupFunction } from "node:net";
import { runInNewContext } from "node:vm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { app } from "../src/app";
import type { Env } from "../src/env";
import { checkWebsite, forgetPageViewLimits, PAGE_VIEWS_PER_ADDRESS, snippet, trackerScript, websiteAddress, websiteOf } from "../src/services/analytics";

// Website analytics: the script on a business's website, the page views it sends, installing it
// from Apps, the check that looks for it, and the visit behind a booking request.

const current = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("../src/lib/supabase", async (original) => ({
  ...(await original<typeof import("../src/lib/supabase")>()),
  adminClient: () => current.db,
  userClient: () => current.db,
}));

/**
 * "The internet" for the website check, as in calendars.test.ts: names get their addresses from
 * `names` below and the code's own lookup decides on them; when it says yes, the connection goes
 * to the server on this machine instead, and HTTPS still checks the certificate against the name.
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

const names = new Map<string, string[]>();
function answer(host: string, options: { all?: boolean }, callback: (error: Error | null, address?: unknown, family?: number) => void) {
  const found = names.get(host)?.map((address) => ({ address, family: isIP(address) }));
  if (!found) return callback(Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: "ENOTFOUND" }));
  if (options.all) callback(null, found);
  else callback(null, found[0]!.address, found[0]!.family);
}

type Page = { status?: number; headers?: OutgoingHttpHeaders; body?: string };
let pages: Record<string, Page> = {};
const site = createSecureServer({ key: internet.KEY, cert: internet.CERT }, (req: IncomingMessage, res: ServerResponse) => {
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

const env: Env = {
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
  SUPABASE_SECRET_KEY: "sb_secret_test",
  ENCRYPTION_KEY: btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => i * 7))),
  APP_URL: "https://crm.greenlawn.example",
};
const COMPANY = "00000000-0000-4000-8000-000000000001";
const USER = "00000000-0000-4000-8000-0000000000aa";
const headers = { Authorization: "Bearer token", "X-Company-Id": COMPANY, "Content-Type": "application/json" };
const SAFARI = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1";
const SCRIPT = "https://crm.greenlawn.example/v.js";

interface Query { table: string; calls: Array<[string, ...any[]]> }

/** A database that answers by table and function, and remembers what was asked of it. */
function fakeDb(answers: { tables?: Record<string, (q: Query) => unknown>; rpc?: Record<string, (args: any) => unknown> } = {}) {
  const queries: Query[] = [];
  const rpcs: Array<{ name: string; args: any }> = [];
  const chain = (q: Query): unknown =>
    new Proxy(
      {},
      {
        get: (_, name) =>
          name === "then"
            ? (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
                Promise.resolve()
                  .then(() => {
                    if (q.table === "memberships") return { data: { role: "owner", role_id: null }, error: null };
                    const result = answers.tables?.[q.table]?.(q);
                    return result && typeof result === "object" && "error" in result ? result : { data: result ?? null, error: null };
                  })
                  .then(resolve, reject)
            : (...args: unknown[]) => {
                q.calls.push([String(name), ...args]);
                return chain(q);
              },
      },
    );
  current.db = {
    from: (table: string) => {
      const q: Query = { table, calls: [] };
      queries.push(q);
      return chain(q);
    },
    rpc: async (name: string, args: unknown) => {
      rpcs.push({ name, args });
      const fn = answers.rpc?.[name];
      if (!fn) return { data: name === "rate_limit_hit" ? true : null, error: null };
      const result = fn(args);
      return result && typeof result === "object" && "error" in (result as object) ? result : { data: result, error: null };
    },
    auth: { getClaims: async () => ({ data: { claims: { sub: USER } }, error: null }) },
  };
  return { queries, rpcs };
}

beforeEach(() => forgetPageViewLimits());
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  names.clear();
  internet.requests.length = 0;
});

// ---------------------------------------------------------------------------------------------

/** Run the script in a pretend browser: what it sends, and the page's history to move around in. */
function browse(options: { href?: string; referrer?: string; attributes?: Record<string, string>; framed?: boolean; navigator?: Record<string, unknown>; window?: Record<string, unknown> } = {}) {
  const sent: Array<{ url: string; init: any; body: any }> = [];
  const location = { href: options.href ?? "https://greenlawn.example/" };
  const listeners: Record<string, Array<() => void>> = {};
  const history = { pushState: (_state: unknown, _title: string, url: string) => { location.href = new URL(url, location.href).href; } };
  const window: Record<string, any> = {
    ...options.window,
    history,
    addEventListener: (type: string, fn: () => void) => (listeners[type] ??= []).push(fn),
  };
  window.top = options.framed ? {} : window;
  const document = {
    referrer: options.referrer ?? "",
    currentScript: { getAttribute: (name: string) => options.attributes?.[name] ?? null },
    addEventListener: () => undefined,
  };
  const fetch = (url: string, init: any) => {
    sent.push({ url, init, body: JSON.parse(init.body) });
    return Promise.resolve();
  };
  runInNewContext(trackerScript("https://crm.greenlawn.example/v"), { window, document, navigator: { ...options.navigator }, location, screen: { width: 390 }, fetch, URL, JSON });
  return { sent, go: (url: string) => window.history.pushState({}, "", url), back: (url: string) => { location.href = url; listeners.popstate?.forEach((fn) => fn()); } };
}

describe("the script", () => {
  it("is served from Crewtavo's own address, cached for an hour", async () => {
    const res = await app.request("/v.js", {}, env);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/javascript");
    expect(res.headers.get("cache-control")).toBe("public, max-age=3600");
    const text = await res.text();
    expect(text).toContain('"https://crm.greenlawn.example/v"');
    expect(text).not.toContain("sendBeacon");
    expect(text.length).toBeLessThan(3000);
  });

  it("sends the page, where the visitor came from and the screen's width", () => {
    const { sent } = browse({ href: "https://greenlawn.example/services?utm_source=flyer#prices", referrer: "https://www.google.com/" });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe("https://crm.greenlawn.example/v");
    expect(sent[0]!.init).toMatchObject({ method: "POST", keepalive: true, mode: "no-cors", credentials: "omit" });
    expect(sent[0]!.body).toEqual({ u: "https://greenlawn.example/services?utm_source=flyer", r: "https://www.google.com/", w: 390 });
  });

  it("counts each page a website app moves to, once", () => {
    const visit = browse({ attributes: { "data-site": "green-lawn" } });
    visit.go("/about");
    visit.go("/about#team");
    visit.back("https://greenlawn.example/");
    expect(visit.sent.map((s) => [s.body.u, s.body.r ?? null, s.body.s])).toEqual([
      ["https://greenlawn.example/", null, "green-lawn"],
      ["https://greenlawn.example/about", "https://greenlawn.example/", "green-lawn"],
      ["https://greenlawn.example/", "https://greenlawn.example/about", "green-lawn"],
    ]);
  });

  it("counts nobody who asked not to be tracked, nor robots, nor a site builder's editor", () => {
    expect(browse({ navigator: { doNotTrack: "1" } }).sent).toHaveLength(0);
    expect(browse({ window: { doNotTrack: "1" } }).sent).toHaveLength(0);
    expect(browse({ navigator: { globalPrivacyControl: true } }).sent).toHaveLength(0);
    expect(browse({ navigator: { webdriver: true } }).sent).toHaveLength(0);
    expect(browse({ framed: true }).sent).toHaveLength(0);
    expect(browse({ window: { __crewtavoVisits: 1 } }).sent).toHaveLength(0);
  });

  it("on GoDaddy, counts the page the line names, on the website around its frame", () => {
    const { sent } = browse({ framed: true, href: "https://img1.wsimg.example/embed.html", referrer: "https://greenlawn.example/", attributes: { "data-page": "/services" } });
    expect(sent.map((s) => s.body.u)).toEqual(["https://greenlawn.example/services"]);
  });

  it("is one line to paste, naming the business only when the server has several", () => {
    expect(snippet(SCRIPT, null)).toBe('<script defer src="https://crm.greenlawn.example/v.js"></script>');
    expect(snippet(SCRIPT, "green-lawn")).toBe('<script defer data-site="green-lawn" src="https://crm.greenlawn.example/v.js"></script>');
  });
});

describe("page views", () => {
  const view = (body: unknown, extra: Record<string, string> = {}) =>
    app.request("/v", { method: "POST", headers: { "Content-Type": "text/plain;charset=UTF-8", "User-Agent": SAFARI, ...extra }, body: typeof body === "string" ? body : JSON.stringify(body) }, env);

  it("are counted in the business's database, with where the visit came from", async () => {
    const db = fakeDb({ rpc: { web_record_hit: () => true } });
    const res = await view({ s: "green-lawn", u: "https://www.greenlawn.example/lawn-care/?utm_campaign=spring", r: "https://l.facebook.com/", w: 390 });
    expect(res.status).toBe(202);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(db.rpcs).toEqual([{
      name: "web_record_hit",
      args: { p_ip: "unknown", p_agent: SAFARI, p_host: "www.greenlawn.example", p_path: "/lawn-care", p_device: "phone", p_site: "green-lawn", p_source: "Facebook", p_channel: "social", p_campaign: "spring", p_referrer: "facebook.com" },
    }]);
  });

  it("leave out where from for a page within a visit", async () => {
    const db = fakeDb({ rpc: { web_record_hit: () => true } });
    await view({ u: "https://greenlawn.example/contact", r: "https://greenlawn.example/services", w: 1440 });
    expect(db.rpcs[0]!.args).toEqual({ p_ip: "unknown", p_agent: SAFARI, p_host: "greenlawn.example", p_path: "/contact", p_device: "phone" });
  });

  it("aren't counted from robots, people who asked not to be tracked, pages being built, or anything else", async () => {
    const db = fakeDb();
    const page = { u: "https://greenlawn.example/", w: 1440 };
    for (const res of [
      await view(page, { "User-Agent": "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)" }),
      await view(page, { "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/140.0.0.0 Safari/537.36" }),
      await view(page, { "User-Agent": "curl/8.7.1" }),
      await view(page, { DNT: "1" }),
      await view(page, { "Sec-GPC": "1" }),
      await view({ u: "http://localhost:4321/", w: 1440 }),
      await view({ u: "file:///Users/me/site/index.html" }),
      await view({ u: "https://greenlawn.example/", w: "wide" }),
      await view("not json"),
      await view({ u: `https://greenlawn.example/${"x".repeat(6000)}` }),
    ]) expect(res.status).toBe(202);
    expect(db.rpcs).toEqual([]);
  });

  it(`stop counting from one address after ${PAGE_VIEWS_PER_ADDRESS} a minute`, async () => {
    const db = fakeDb({ rpc: { web_record_hit: () => true } });
    for (let i = 0; i < PAGE_VIEWS_PER_ADDRESS + 5; i++) await view({ u: `https://greenlawn.example/p${i}` });
    expect(db.rpcs).toHaveLength(PAGE_VIEWS_PER_ADDRESS);
  });

  it("don't fail the website when the database does", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    fakeDb({ rpc: { web_record_hit: () => ({ data: null, error: { message: "connection refused" } }) } });
    expect((await view({ u: "https://greenlawn.example/" })).status).toBe(202);
    expect(console.error).toHaveBeenCalled();
  });
});

describe("installing it", () => {
  const company = (settings: Record<string, unknown> = {}, website: string | null = "greenlawn.example") => ({ slug: "green-lawn", website, settings });

  it("is a built-in app, installed once it's on", async () => {
    for (const enabled of [false, true]) {
      fakeDb({ tables: { companies: () => ({ settings: { website_analytics: { enabled } } }), integrations: () => [], calendar_sources: () => [], integration_secrets: () => null } });
      const res = await app.request("/api/apps", { headers }, env);
      const listed = ((await res.json()) as { apps: Array<Record<string, unknown>> }).apps.find((a) => a.id === "website_analytics");
      expect(listed).toMatchObject({ name: "Crewtavo - Website Analytics", category: "Team", auth: "builtin", available: true, status: enabled ? "connected" : "disconnected" });
    }
  });

  it("turns on and off in the business's settings", async () => {
    const db = fakeDb({ rpc: { web_analytics_save: (args) => args.p_changes } });
    const res = await app.request("/api/analytics/enabled", { method: "POST", headers, body: JSON.stringify({ enabled: true }) }, env);
    expect(await res.json()).toEqual({ enabled: true });
    expect(db.rpcs).toEqual([{ name: "web_analytics_save", args: { p_company: COMPANY, p_changes: { enabled: true } } }]);
  });

  it("gives the line to paste, the website and the last visit", async () => {
    fakeDb({ tables: { companies: () => company({ website_analytics: { enabled: true } }), web_hits: () => ({ at: "2026-10-20T15:00:00Z" }), web_daily: () => null } });
    const setup = await (await app.request("/api/analytics/setup", { headers }, { ...env, CREWTAVO_SINGLE_COMPANY: "1" })).json();
    expect(setup).toEqual({ enabled: true, snippet: '<script defer src="https://crm.greenlawn.example/v.js"></script>', site: "greenlawn.example", counting: null, check: null, last_visit_at: "2026-10-20T15:00:00Z", last_visit_day: null });
    const shared = await (await app.request("/api/analytics/setup", { headers }, env)).json();
    expect(shared.snippet).toContain('data-site="green-lawn"');
  });

  it("finds the website where the business keeps it", () => {
    expect(websiteOf({ website: "greenlawn.example", settings: {} })).toBe("greenlawn.example");
    expect(websiteOf({ website: "greenlawn.example", settings: { website_analytics: { site: "https://www.greenlawn.example/" } } })).toBe("https://www.greenlawn.example/");
    // The Sveltia CMS app's editor, when the business hasn't typed its website anywhere.
    expect(websiteOf({ website: null, settings: { website: { admin_url: "https://www.greenlawn.example/admin/" } } })).toBe("https://www.greenlawn.example");
    expect(websiteOf({ website: " ", settings: null })).toBeNull();
  });

  it("only owners and admins who connect apps change it", async () => {
    current.db = { ...(fakeDb() as unknown as object), from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { role: "office", role_id: null }, error: null }) }) }) }) }) }), auth: { getClaims: async () => ({ data: { claims: { sub: USER } }, error: null }) } };
    for (const [path, method] of [["/api/analytics/setup", "GET"], ["/api/analytics/enabled", "POST"], ["/api/analytics/check", "POST"]] as const) {
      const res = await app.request(path, { method, headers, ...(method === "POST" ? { body: JSON.stringify({ enabled: true }) } : {}) }, env);
      expect(res.status).toBe(403);
    }
  });
});

describe("checking the website", () => {
  const LINE = '<script defer src="https://crm.greenlawn.example/v.js"></script>';
  beforeEach(() => {
    names.set("greenlawn.example", ["203.0.113.20"]);
    names.set("www.greenlawn.example", ["203.0.113.20"]);
    vi.spyOn(dns, "lookup").mockImplementation(answer as unknown as typeof dns.lookup);
  });

  it("finds the line on the home page, after the website's redirects", async () => {
    pages = {
      "greenlawn.example/": { status: 301, headers: { Location: at("www.greenlawn.example") } },
      "www.greenlawn.example/": { body: `<!doctype html><html><head><title>Green Lawn</title>${LINE}</head><body></body></html>` },
    };
    expect(await checkWebsite(at("greenlawn.example"), SCRIPT)).toEqual({ url: at("www.greenlawn.example"), host: "www.greenlawn.example", found: true });
  });

  it("finds it as Next.js leaves it, and says when it isn't there", async () => {
    pages = { "/": { body: '<script>(self.__next_s=self.__next_s||[]).push(["https:\\/\\/crm.greenlawn.example\\/v.js",{}])</script>' } };
    expect(await checkWebsite(at("greenlawn.example"), SCRIPT)).toMatchObject({ found: true });
    pages = { "/": { body: "<h1>Green Lawn</h1>" } };
    expect(await checkWebsite(at("greenlawn.example"), SCRIPT)).toEqual({ url: at("greenlawn.example"), host: "greenlawn.example", found: false });
  });

  it("says why it couldn't look", async () => {
    pages = { "/": { status: 403 } };
    expect((await checkWebsite(at("greenlawn.example"), SCRIPT)).problem).toMatch(/didn't let Crewtavo look at it \(it answered 403\)/);
    pages = { "/": { status: 500 } };
    expect((await checkWebsite(at("greenlawn.example"), SCRIPT)).problem).toMatch(/answered with an error \(500\)/);
    expect((await checkWebsite(at("nowhere.example"), SCRIPT)).problem).toMatch(/Couldn't find nowhere\.example/);
  });

  it("only reads the public internet", async () => {
    names.set("sneaky.example", ["10.0.0.5"]);
    expect((await checkWebsite(at("sneaky.example"), SCRIPT)).problem).toMatch(/private network/);
    pages = { "/": { status: 302, headers: { Location: "http://169.254.169.254/latest/meta-data/" } } };
    expect((await checkWebsite(at("greenlawn.example"), SCRIPT)).problem).toMatch(/private network/);
    expect(internet.requests.some((url) => url.includes("169.254"))).toBe(false);
    expect(() => websiteAddress("localhost:3000")).toThrow(/public address/);
    expect(() => websiteAddress("127.0.0.1")).toThrow(/public address/);
    expect(websiteAddress("greenlawn.example").href).toBe("https://greenlawn.example/");
  });

  it("keeps the address and what it found, and counts only that website once it's there", async () => {
    pages = { "/": { body: LINE } };
    const db = fakeDb({ tables: { companies: () => ({ website: "greenlawn.example", settings: {} }) }, rpc: { web_analytics_save: (args) => args.p_changes } });
    const res = await app.request("/api/analytics/check", { method: "POST", headers, body: JSON.stringify({ site: at("greenlawn.example") }) }, env);
    const body = await res.json();
    expect(body).toMatchObject({ site: at("greenlawn.example"), check: { found: true, url: at("greenlawn.example") }, counting: "greenlawn.example" });
    expect(db.rpcs[0]!.args.p_changes).toMatchObject({ site: at("greenlawn.example"), host: "greenlawn.example", check: { found: true } });

    pages = { "/": { body: "<h1>Green Lawn</h1>" } };
    const missing = fakeDb({ tables: { companies: () => ({ website: "greenlawn.example", settings: {} }) }, rpc: { web_analytics_save: (args) => args.p_changes } });
    await app.request("/api/analytics/check", { method: "POST", headers, body: JSON.stringify({ site: at("greenlawn.example") }) }, env);
    expect(missing.rpcs[0]!.args.p_changes).not.toHaveProperty("host");
  });
});

describe("booking requests", () => {
  it("remember the website visit that brought them in", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", async () => { throw new Error("no network in tests"); });
    const visit = { landing_page: "/aeration", page: "/contact", source: "Yelp", channel: "directory", device: "phone", visited_at: "2026-10-20T14:58:00Z" };
    const inserted: Record<string, unknown>[] = [];
    const db = fakeDb({
      tables: {
        companies: () => ({ id: COMPANY, name: "Green Lawn", phone: null, timezone: "America/Chicago" }),
        intake_forms: () => ({ id: "00000000-0000-4000-8000-0000000000f1", name: "Get a quote", kind: "quote", questions: [], service_area_zips: [], lead_time_days: 0, slot_minutes: 60 }),
        clients: () => ({ id: "00000000-0000-4000-8000-0000000000c1" }),
        properties: () => ({ id: "00000000-0000-4000-8000-0000000000b1" }),
        requests: (q) => {
          const insert = q.calls.find(([n]) => n === "insert");
          if (insert) inserted.push(insert[1]);
          return { id: "00000000-0000-4000-8000-0000000000d1", number: 1001 };
        },
      },
      rpc: { web_visit_for: () => visit },
    });
    const res = await app.request("/api/public/forms/green-lawn/quote", {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": SAFARI },
      body: JSON.stringify({ name: "Lee Park", phone: "555-0100", address: { line1: "12 Elm St" } }),
    }, env);
    expect(res.status).toBe(201);
    expect(db.rpcs.find((r) => r.name === "web_visit_for")?.args).toEqual({ p_company: COMPANY, p_ip: "unknown", p_agent: SAFARI });
    expect(inserted[0]).toMatchObject({ source: "web_form", web_visit: visit });
  });

  it("still go in when the visit can't be looked up", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", async () => { throw new Error("no network in tests"); });
    const inserted: Record<string, unknown>[] = [];
    fakeDb({
      tables: {
        companies: () => ({ id: COMPANY, name: "Green Lawn", phone: null, timezone: "America/Chicago" }),
        intake_forms: () => ({ id: "00000000-0000-4000-8000-0000000000f1", name: "Get a quote", kind: "quote", questions: [], service_area_zips: [] }),
        clients: () => ({ id: "00000000-0000-4000-8000-0000000000c1" }),
        properties: () => ({ id: "00000000-0000-4000-8000-0000000000b1" }),
        requests: (q) => {
          const insert = q.calls.find(([n]) => n === "insert");
          if (insert) inserted.push(insert[1]);
          return { id: "00000000-0000-4000-8000-0000000000d1", number: 1001 };
        },
      },
      rpc: { web_visit_for: () => ({ data: null, error: { message: "function web_visit_for does not exist" } }) },
    });
    const res = await app.request("/api/public/forms/green-lawn/quote", {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": SAFARI },
      body: JSON.stringify({ name: "Lee Park", phone: "555-0100", address: { line1: "12 Elm St" } }),
    }, env);
    expect(res.status).toBe(201);
    expect(inserted[0]).toMatchObject({ web_visit: null });
  });
});
