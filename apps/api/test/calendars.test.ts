import dns from "node:dns";
import { createServer, type IncomingMessage, type RequestOptions, type Server, type ServerResponse } from "node:http";
import { createServer as createSecureServer } from "node:https";
import { isIP, type AddressInfo, type LookupFunction } from "node:net";
import { deflateSync, gzipSync } from "node:zlib";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { app } from "../src/app";
import type { Env } from "../src/env";
import { CalendarError, clip, describeGoogleAccount, fetchIcs, googleEventId, normalizeLink } from "../src/integrations/calendars";
import { CATALOG, OAUTH } from "../src/integrations/registry";

/**
 * "The internet" for these tests: names get their addresses from `names` below, and the code's own
 * lookup decides on them as usual. When it says yes, the connection goes to a server on this
 * machine instead of that (made-up) public address; HTTPS still checks the certificate against the
 * link's name.
 */
const internet = vi.hoisted(() => ({
  requests: [] as Array<{ url: string; options: RequestOptions }>,
  onThisMachine: (lookup: LookupFunction): LookupFunction => (host, options, done) =>
    lookup(host, options, (error, address, family) =>
      error ? done(error, address, family) : done(null, Array.isArray(address) ? address.map(() => ({ address: "127.0.0.1", family: 4 })) : "127.0.0.1", 4)),
  // A self-signed certificate for "calendar.example.com", made for these tests (it's trusted nowhere else).
  KEY: `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgcG2Qxe/EWmbkmAVP
88oqvApREAb/8X8fu4GiynvpJ2ShRANCAATqaUXV8kbtVRR96IaW73eGMEunCaA4
B4iOa57TK5CncFpCJ3TXTHIGHyQGG3rYNDALn6xC46xfYnIQFoUEzFui
-----END PRIVATE KEY-----`,
  CERT: `-----BEGIN CERTIFICATE-----
MIIBtjCCAVygAwIBAgIUZKbcdnwzrXP9OEjE5k29Wgktun0wCgYIKoZIzj0EAwIw
HzEdMBsGA1UEAwwUY2FsZW5kYXIuZXhhbXBsZS5jb20wIBcNMjYxMDE4MDUwMTA3
WhgPMjEyNjA5MjQwNTAxMDdaMB8xHTAbBgNVBAMMFGNhbGVuZGFyLmV4YW1wbGUu
Y29tMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE6mlF1fJG7VUUfeiGlu93hjBL
pwmgOAeIjmue0yuQp3BaQid010xyBh8kBht62DQwC5+sQuOsX2JyEBaFBMxboqN0
MHIwHQYDVR0OBBYEFJnUFQIorgFzW+VGFcJ02rjk1MFjMB8GA1UdIwQYMBaAFJnU
FQIorgFzW+VGFcJ02rjk1MFjMB8GA1UdEQQYMBaCFGNhbGVuZGFyLmV4YW1wbGUu
Y29tMA8GA1UdEwEB/wQFMAMBAf8wCgYIKoZIzj0EAwIDSAAwRQIgPJUo81jJVB5b
9Pfp7Uc+XMUudig54jnSm9MXfYwlENICIQDF8I5sE3ikHpmALQC2j7EhJNhQFuvi
XkTVq3/Yn0mwYw==
-----END CERTIFICATE-----`,
}));

vi.mock("node:http", async (importOriginal) => {
  const http = await importOriginal<typeof import("node:http") & { default: typeof import("node:http") }>();
  const request = (url: URL, options: RequestOptions, callback: (response: IncomingMessage) => void) => {
    internet.requests.push({ url: String(url), options });
    return http.request(url, { ...options, lookup: internet.onThisMachine(options.lookup!) }, callback);
  };
  return { ...http, request, default: { ...http.default, request } };
});
vi.mock("node:https", async (importOriginal) => {
  const https = await importOriginal<typeof import("node:https") & { default: typeof import("node:https") }>();
  const request = (url: URL, options: RequestOptions, callback: (response: IncomingMessage) => void) => {
    internet.requests.push({ url: String(url), options });
    return https.request(url, { ...options, ca: internet.CERT, lookup: internet.onThisMachine(options.lookup!) }, callback);
  };
  return { ...https, request, default: { ...https.default, request } };
});

// A rebinding name gives a lookup made ahead of the connection a public address, and the one made
// for the connection an inside one. Here a lookup made ahead always gets the public answer, and
// the connection's gets the one in `names`: only checking the address connected to keeps it out.
vi.mock("node:dns/promises", async (original) => ({ ...(await original<typeof import("node:dns/promises")>()), lookup: async () => [{ address: "203.0.113.7", family: 4 }] }));

// Every connection's lookup (the code's own, or Node's when a request brings none) answers from here.
const names = new Map<string, string[]>();
function answer(host: string, options: { all?: boolean }, callback: (error: Error | null, address?: unknown, family?: number) => void) {
  const found = names.get(host)?.map((address) => ({ address, family: isIP(address) }));
  if (!found) return callback(Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: "ENOTFOUND" }));
  if (options.all) callback(null, found);
  else callback(null, found[0]!.address, found[0]!.family);
}

const env: Env = {
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
  SUPABASE_SECRET_KEY: "sb_secret_test",
  ENCRYPTION_KEY: btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => i * 7))),
  APP_URL: "https://ops.example.com",
};

const CALENDAR = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n";

// The calendar servers: one for http://, one for https://, both answering with `handler`.
const hits: string[] = [];
let handler: (req: IncomingMessage, res: ServerResponse) => void = (_req, res) => res.end(CALENDAR);
const serve = (req: IncomingMessage, res: ServerResponse) => {
  hits.push(`${req.method} ${req.url}`);
  handler(req, res);
};
const plain = createServer(serve);
const secure = createSecureServer({ key: internet.KEY, cert: internet.CERT }, serve);
let port = 0;
let tlsPort = 0;
const listen = (server: Server) => new Promise<number>((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)));

beforeAll(async () => {
  port = await listen(plain);
  tlsPort = await listen(secure);
});
afterAll(() => {
  for (const server of [plain, secure]) {
    server.closeAllConnections();
    server.close();
  }
});
beforeEach(() => {
  names.set("calendar.example.com", ["203.0.113.7", "2001:db8::7"]);
  vi.spyOn(dns, "lookup").mockImplementation(answer as unknown as typeof dns.lookup);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  names.clear();
  hits.length = 0;
  internet.requests.length = 0;
  handler = (_req, res) => res.end(CALENDAR);
});

describe("calendar links", () => {
  it("tidies pasted links", () => {
    expect(normalizeLink(" webcal://p01-caldav.icloud.com/published/2/abc ").toString()).toBe("https://p01-caldav.icloud.com/published/2/abc");
    expect(normalizeLink("calendar.zoho.com/ical/xyz#top").toString()).toBe("https://calendar.zoho.com/ical/xyz");
    expect(() => normalizeLink("ftp://example.com/cal.ics")).toThrow(CalendarError);
    expect(() => normalizeLink("not a link at all")).toThrow(CalendarError);
  });

  it("never fetches this server, its network or cloud metadata", async () => {
    for (const link of [
      "http://localhost:8080/api/calendar/x.ics",
      "http://127.0.0.1/cal.ics",
      "http://10.0.0.5/cal.ics",
      "http://169.254.169.254/latest/meta-data",
      "http://[::1]/cal.ics",
      "http://[::ffff:7f00:1]/cal.ics",
      "http://supabase.internal/cal.ics",
      // IPv6 addresses that lead to an inside IPv4 address, or to a private network.
      "http://[::127.0.0.1]/cal.ics", // IPv4-compatible
      "http://[::ffff:0:127.0.0.1]/cal.ics", // IPv4-translated
      "http://[64:ff9b::169.254.169.254]/cal.ics", // NAT64
      "http://[2002:a00:5::]/cal.ics", // 6to4 for 10.0.0.5
      "http://[2001:0:4136:e378:8000:63bf:3fff:fdd2]/cal.ics", // Teredo
      "http://[64:ff9b:1::a00:5]/cal.ics", // local-use NAT64
      "http://[fec0::1]/cal.ics", // site-local
      "http://[fd12:3456::1]/cal.ics", // unique local (Railway's private network)
    ]) {
      await expect(fetchIcs(link), link).rejects.toThrow(/private address/);
    }
    expect(internet.requests).toEqual([]);
  });

  it("checks the address it connects to, so a name can't be pointed inside after a check", async () => {
    names.set("rebind.example", ["127.0.0.1"]);
    await expect(fetchIcs(`http://u:p@rebind.example:${port}/internal?q=1`)).rejects.toThrow(/private address/);
    // Any inside address among a name's answers is enough to refuse it.
    names.set("mixed.example", ["203.0.113.7", "10.0.0.5"]);
    await expect(fetchIcs(`https://mixed.example:${tlsPort}/cal.ics`)).rejects.toThrow(/private address/);
    names.set("nat64.example", ["64:ff9b::a9fe:a9fe"]);
    await expect(fetchIcs(`http://nat64.example:${port}/latest/meta-data`)).rejects.toThrow(/private address/);
    expect(hits).toEqual([]);
    // On an IPv6-only network, a public server's NAT64 address is fine.
    names.set("calendar.example.com", ["64:ff9b::cb00:7107"]);
    expect(await fetchIcs(`http://calendar.example.com:${port}/cal.ics`)).toBe(CALENDAR);
  });

  it("checks every redirect too, as it connects", async () => {
    names.set("inside.example", ["192.168.1.10"]);
    handler = (req, res) => res.writeHead(302, { location: req.url === "/a" ? "http://192.168.1.10/cal.ics" : `http://inside.example:${port}/cal.ics` }).end();
    await expect(fetchIcs(`http://calendar.example.com:${port}/a`)).rejects.toThrow(/private address/);
    await expect(fetchIcs(`http://calendar.example.com:${port}/b`)).rejects.toThrow(/private address/);
    expect(hits).toEqual(["GET /a", "GET /b"]);
  });

  it("follows a few redirects, but not forever", async () => {
    handler = (req, res) => res.writeHead(301, { location: req.url === "/old" ? `https://calendar.example.com:${tlsPort}/new` : "/loop" }).end();
    await expect(fetchIcs(`http://calendar.example.com:${port}/old`)).rejects.toThrow(/redirected too many times/);
    expect(hits).toEqual(["GET /old", "GET /new", "GET /loop", "GET /loop", "GET /loop"]);
    handler = (req, res) => (req.url === "/old" ? res.writeHead(302, { location: "/cal.ics" }).end() : res.end(CALENDAR));
    expect(await fetchIcs(`https://calendar.example.com:${tlsPort}/old`)).toBe(CALENDAR);
  });

  it("reads a calendar over HTTPS, checking the certificate is for the link's name", async () => {
    expect(await fetchIcs(`https://calendar.example.com:${tlsPort}/cal.ics`)).toBe(CALENDAR);
    expect(dns.lookup).toHaveBeenCalledTimes(1); // the lookup that was checked is the one connected with
    // The same server under a name its certificate isn't for.
    names.set("elsewhere.example.com", ["203.0.113.8"]);
    await expect(fetchIcs(`https://elsewhere.example.com:${tlsPort}/cal.ics`)).rejects.toThrow(/Couldn't reach that calendar/);
    names.delete("calendar.example.com");
    await expect(fetchIcs(`https://calendar.example.com:${tlsPort}/cal.ics`)).rejects.toThrow("Couldn't find calendar.example.com. Check the link and try again.");
  });

  it("reads a calendar and explains links that aren't one", async () => {
    const respond = (body: string, status = 200) => (handler = (_req, res) => res.writeHead(status).end(body));
    const link = `https://calendar.example.com:${tlsPort}/cal.ics`;
    respond(CALENDAR);
    expect(await fetchIcs(link)).toBe(CALENDAR);
    respond("<!doctype html><title>Sign in</title>");
    await expect(fetchIcs(link)).rejects.toThrow(/web page, not a calendar/);
    respond("nope", 404);
    await expect(fetchIcs(link)).rejects.toThrow(/No calendar at that link/);
    respond("nope", 401);
    await expect(fetchIcs(link)).rejects.toThrow(/needs a sign-in/);
    respond("nope", 503);
    await expect(fetchIcs(link)).rejects.toThrow("The calendar's server had a problem (503). It will try again later.");
    handler = (req) => req.socket.destroy();
    await expect(fetchIcs(link)).rejects.toThrow(/Couldn't reach that calendar/);
    // Each read gives up after a while.
    expect(internet.requests.every((r) => r.options.signal instanceof AbortSignal)).toBe(true);
  });

  it("unpacks compressed calendars, and stops reading past 10 MB", async () => {
    const link = `http://calendar.example.com:${port}/cal.ics`;
    handler = (_req, res) => res.writeHead(200, { "Content-Encoding": "gzip" }).end(gzipSync(CALENDAR));
    expect(await fetchIcs(link)).toBe(CALENDAR);
    expect(internet.requests[0]!.options.headers).toMatchObject({ "Accept-Encoding": "gzip, br" });
    handler = (_req, res) => res.writeHead(200, { "Content-Encoding": "deflate" }).end(deflateSync(CALENDAR));
    expect(await fetchIcs(link)).toBe(CALENDAR);
    const big = Buffer.concat([Buffer.from(CALENDAR), Buffer.alloc(11 * 1024 * 1024, " ")]);
    handler = (_req, res) => res.end(big);
    await expect(fetchIcs(link)).rejects.toThrow(/too big to read/);
    // Counted once unpacked: 11 MB of spaces packs into a few kilobytes.
    handler = (_req, res) => res.writeHead(200, { "Content-Encoding": "gzip" }).end(gzipSync(big));
    await expect(fetchIcs(link)).rejects.toThrow(/too big to read/);
  });

  it("signs in with a name and password in the link, without sending them in the address", async () => {
    let signIn: string | undefined;
    handler = (req, res) => {
      signIn = req.headers.authorization;
      res.end(CALENDAR);
    };
    await fetchIcs(`https://me:s%40cret@calendar.example.com:${tlsPort}/dav/cal.ics`);
    expect(internet.requests.map((r) => r.url)).toEqual([`https://calendar.example.com:${tlsPort}/dav/cal.ics`]);
    expect(signIn).toBe(`Basic ${btoa("me:s@cret")}`);
  });
});

describe("names and notes from other calendars", () => {
  it("are cut to a number of characters, never through an emoji", () => {
    expect(clip("Team calendar", 80)).toBe("Team calendar");
    expect(clip("abc", 2)).toBe("ab");
    expect(clip(`${"x".repeat(79)}📅 and more`, 80)).toBe(`${"x".repeat(79)}📅`);
    // 80 characters, though 159 UTF-16 units.
    expect(clip(`a${"📅".repeat(90)}`, 80)).toBe(`a${"📅".repeat(79)}`);
  });
});

describe("Google Calendar", () => {
  it("gives each visit a fixed event ID Google accepts (0-9 and a-v)", () => {
    const id = googleEventId("0b9d3a6e-6f1c-4c0e-9a7f-3f6c2d1e8b4a");
    expect(id).toBe("ctv0b9d3a6e6f1c4c0e9a7f3f6c2d1e8b4a");
    expect(id).toMatch(/^[0-9a-v]{5,1024}$/);
  });

  it("asks only to read calendars and keep the one it makes", () => {
    const scopes = OAUTH.google_calendar!.scope.split(" ");
    expect(scopes).toEqual([
      "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
      "https://www.googleapis.com/auth/calendar.events.readonly",
      "https://www.googleapis.com/auth/calendar.app.created",
    ]);
  });

  it("gives up on Google after a while when asking which account was connected", async () => {
    const fetched = vi.fn(async (_url: string, _init?: RequestInit) => Response.json({ id: "office@example.com", summary: "Office" }));
    vi.stubGlobal("fetch", fetched);
    expect(await describeGoogleAccount("token")).toEqual({ external_account_id: null, account_label: "office@example.com" });
    expect(fetched.mock.calls[0]![1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it("lists every calendar app once, with a way in", () => {
    const ids = CATALOG.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(CATALOG.filter((a) => a.category === "Calendar").map((a) => a.id)).toEqual(["google_calendar", "zoho_calendar", "outlook_calendar", "apple_calendar", "ics_calendar"]);
    for (const a of CATALOG) if (a.auth === "oauth") expect(OAUTH[a.id as keyof typeof OAUTH], a.id).toBeDefined();
  });

  it("requires a session to manage calendars", async () => {
    for (const [method, path] of [["GET", "/api/calendars"], ["POST", "/api/calendars"], ["GET", "/api/calendars/google"], ["PUT", "/api/calendars/google/visits"]] as const) {
      expect((await app.request(path, { method }, env)).status, `${method} ${path}`).toBe(401);
    }
  });
});
