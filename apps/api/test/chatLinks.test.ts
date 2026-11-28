import dns from "node:dns";
import { createServer, type IncomingMessage, type RequestOptions, type Server, type ServerResponse } from "node:http";
import { createServer as createSecureServer } from "node:https";
import { isIP, type AddressInfo, type LookupFunction } from "node:net";
import { gzipSync } from "node:zlib";
import { encode } from "jpeg-js";
import { PNG } from "pngjs";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { app } from "../src/app";
import type { Env } from "../src/env";
import { fetchPreview, PREVIEW_LIMITS, previewable, readHead } from "../src/lib/linkPreview";

// Link previews in team chat (lib/linkPreview.ts, routes/chatLinks.ts): public pages only, on their
// usual ports, every redirect checked, five seconds and 512 KB of HTML at most, and the picture
// shrunk here so nobody's browser loads it from the site.

/**
 * "The internet", as in calendars.test.ts: names get their addresses from `names` below and the
 * code's own lookup decides on them. When it says yes, the connection goes to the server on this
 * machine instead (to its port, as the link's own is the usual one), and HTTPS still checks the
 * certificate against the link's name.
 */
const internet = vi.hoisted(() => ({
  requests: [] as string[],
  ports: { http: 0, https: 0 },
  onThisMachine: (lookup: LookupFunction): LookupFunction => (host, options, done) =>
    lookup(host, options, (error, address, family) =>
      error ? done(error, address, family) : done(null, Array.isArray(address) ? address.map(() => ({ address: "127.0.0.1", family: 4 })) : "127.0.0.1", 4)),
  // The self-signed certificate for "calendar.example.com" from calendars.test.ts (trusted nowhere else).
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
    internet.requests.push(String(url));
    return http.request(url, { ...options, port: internet.ports.http, lookup: internet.onThisMachine(options.lookup!) }, callback);
  };
  return { ...http, request, default: { ...http.default, request } };
});
vi.mock("node:https", async (importOriginal) => {
  const https = await importOriginal<typeof import("node:https") & { default: typeof import("node:https") }>();
  const request = (url: URL, options: RequestOptions, callback: (response: IncomingMessage) => void) => {
    internet.requests.push(String(url));
    return https.request(url, { ...options, port: internet.ports.https, ca: internet.CERT, lookup: internet.onThisMachine(options.lookup!) }, callback);
  };
  return { ...https, request, default: { ...https.default, request } };
});

// Every connection's lookup answers from here.
const names = new Map<string, string[]>();
function answer(host: string, options: { all?: boolean }, callback: (error: Error | null, address?: unknown, family?: number) => void) {
  const found = names.get(host)?.map((address) => ({ address, family: isIP(address) }));
  if (!found) return callback(Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: "ENOTFOUND" }));
  if (options.all) callback(null, found);
  else callback(null, found[0]!.address, found[0]!.family);
}

// The site: pages by path, each a status, headers and a body.
type Page = { status?: number; headers?: Record<string, string>; body?: string | Buffer; slow?: number };
let pages: Record<string, Page> = {};
const hits: string[] = [];
const serve = (req: IncomingMessage, res: ServerResponse) => {
  hits.push(`${req.headers.host?.replace(/:\d+$/, "")}${req.url}`);
  const page = pages[req.url ?? ""] ?? { status: 404, body: "Not found" };
  const send = () => res.writeHead(page.status ?? 200, { "Content-Type": "text/html; charset=utf-8", ...page.headers }).end(page.body ?? "");
  if (page.slow) setTimeout(send, page.slow);
  else send();
};
const plain = createServer(serve);
const secure = createSecureServer({ key: internet.KEY, cert: internet.CERT }, serve);
const listen = (server: Server) => new Promise<number>((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)));

beforeAll(async () => {
  internet.ports.http = await listen(plain);
  internet.ports.https = await listen(secure);
});
afterAll(() => {
  for (const server of [plain, secure]) {
    server.closeAllConnections();
    server.close();
  }
});
beforeEach(() => {
  names.set("news.example.com", ["203.0.113.7"]);
  names.set("calendar.example.com", ["203.0.113.8", "2001:db8::8"]);
  vi.spyOn(dns, "lookup").mockImplementation(answer as unknown as typeof dns.lookup);
  pages = {};
});
afterEach(() => {
  vi.restoreAllMocks();
  names.clear();
  hits.length = 0;
  internet.requests.length = 0;
});

const ARTICLE = `<!doctype html><html><head>
<meta charset="utf-8">
<title>Ignored when there's og:title</title>
<meta property="og:title" content="Spring aeration &amp; overseeding &#8212; what to know">
<meta property="og:description" content="  Core aeration
 opens the soil.  ">
<meta property="og:site_name" content="Lawn News">
<meta property="og:image" content="/pictures/lawn.png">
</head><body><p>Body text</p></body></html>`;

/** A small picture, as a site would serve it. */
function png(width = 600, height = 315): Buffer {
  const picture = new PNG({ width, height });
  for (let i = 0; i < picture.data.length; i += 4) picture.data.set([40, 160, 60, 255], i);
  return PNG.sync.write(picture);
}
function jpeg(width = 800, height = 400): Buffer {
  const data = Buffer.alloc(width * height * 4, 200);
  return Buffer.from(encode({ data, width, height }, 80).data);
}

describe("which links get a preview", () => {
  it("only public http and https pages on their usual ports", () => {
    expect(previewable("https://news.example.com/a#part")?.toString()).toBe("https://news.example.com/a");
    expect(previewable("http://news.example.com:80/a")?.toString()).toBe("http://news.example.com/a");
    expect(previewable("https://news.example.com:443/a")?.toString()).toBe("https://news.example.com/a");
    for (const link of [
      "ftp://news.example.com/a",
      "javascript:alert(1)",
      "file:///etc/passwd",
      "https://news.example.com:8443/a",
      "http://news.example.com:22/",
      "https://me:secret@news.example.com/",
      "http://localhost/",
      "http://router/",
      "http://127.0.0.1/",
      "http://2130706433/", // 127.0.0.1 written as a number
      "http://0x7f.1/",
      "http://10.0.0.5/",
      "http://172.16.0.1/",
      "http://192.168.1.1/",
      "http://169.254.169.254/latest/meta-data/", // cloud metadata
      "http://100.100.100.200/", // carrier-grade NAT, and a cloud's metadata
      "http://224.0.0.1/", // multicast
      "http://0.0.0.0/",
      "http://[::1]/",
      "http://[fd00:ec2::254]/", // unique local (a cloud's metadata over IPv6)
      "http://[fe80::1]/", // link-local
      "http://[ff02::1]/", // multicast
      "http://[::ffff:169.254.169.254]/",
      "http://metadata.google.internal/",
      "http://printer.local/",
      "not a link",
    ]) {
      expect(previewable(link), link).toBeNull();
    }
  });
});

describe("reading a preview", () => {
  it("reads a page's title, description, site and picture, shrunk to a small JPEG", async () => {
    pages = { "/spring": { body: ARTICLE }, "/pictures/lawn.png": { headers: { "Content-Type": "image/png" }, body: png() } };
    const preview = await fetchPreview("http://news.example.com/spring");
    expect(preview).toMatchObject({
      url: "http://news.example.com/spring",
      title: "Spring aeration & overseeding — what to know",
      description: "Core aeration opens the soil.",
      site_name: "Lawn News",
    });
    expect(preview!.image).toMatch(/^data:image\/jpeg;base64,/);
    const picture = Buffer.from(preview!.image!.split(",")[1]!, "base64");
    expect(picture.length).toBeLessThan(20_000);
    expect(hits).toEqual(["news.example.com/spring", "news.example.com/pictures/lawn.png"]);
  });

  it("over HTTPS, checking the certificate is for the link's name", async () => {
    pages = { "/": { body: "<html><head><title>Calendar</title><meta name=description content='Plans for the week'></head></html>" } };
    expect(await fetchPreview("https://calendar.example.com/")).toMatchObject({ title: "Calendar", description: "Plans for the week", site_name: "calendar.example.com", image: null });
    names.set("other.example.com", ["203.0.113.9"]);
    expect(await fetchPreview("https://other.example.com/")).toBeNull();
  });

  it("reads a JPEG picture too, and makes nothing of a picture it can't open", async () => {
    pages = { "/a": { body: ARTICLE.replace("/pictures/lawn.png", "/p.jpg") }, "/p.jpg": { headers: { "Content-Type": "image/jpeg" }, body: jpeg() } };
    expect((await fetchPreview("http://news.example.com/a"))?.image).toMatch(/^data:image\/jpeg;base64,/);
    pages["/p.jpg"] = { headers: { "Content-Type": "image/jpeg" }, body: "not a picture" };
    expect(await fetchPreview("http://news.example.com/a")).toMatchObject({ title: expect.any(String), image: null });
  });

  it("never connects to this server, its network or cloud metadata, whatever a name says", async () => {
    pages = { "/": { body: ARTICLE } };
    for (const [name, address] of [
      ["rebind.example", "127.0.0.1"],
      ["inside.example", "10.0.0.5"],
      ["meta.example", "169.254.169.254"],
      ["cgnat.example", "100.64.0.1"],
      ["multicast.example", "239.1.2.3"],
      ["ula.example", "fd12:3456::1"],
      ["linklocal.example", "fe80::1"],
      ["mapped.example", "::ffff:127.0.0.1"],
      ["nat64.example", "64:ff9b::a9fe:a9fe"],
    ] as const) {
      names.set(name, [address]);
      expect(await fetchPreview(`http://${name}/`), name).toBeNull();
    }
    // One inside address among a name's answers is enough to refuse it.
    names.set("mixed.example", ["203.0.113.7", "10.0.0.5"]);
    expect(await fetchPreview("http://mixed.example/")).toBeNull();
    expect(hits).toEqual([]);
  });

  it("checks every redirect, and follows three at most", async () => {
    names.set("inside.example", ["192.168.1.10"]);
    pages = {
      "/to-ip": { status: 302, headers: { Location: "http://169.254.169.254/latest/meta-data/" } },
      "/to-name": { status: 301, headers: { Location: "http://inside.example/admin" } },
      "/to-port": { status: 302, headers: { Location: "http://news.example.com:8080/" } },
      "/to-file": { status: 302, headers: { Location: "file:///etc/passwd" } },
      "/one": { status: 302, headers: { Location: "/two" } },
      "/two": { status: 302, headers: { Location: "https://calendar.example.com/three" } },
      "/three": { status: 302, headers: { Location: "http://news.example.com/end" } },
      "/end": { body: "<head><title>The end</title></head>" },
      "/loop": { status: 302, headers: { Location: "/loop" } },
    };
    for (const path of ["/to-ip", "/to-name", "/to-port", "/to-file"]) expect(await fetchPreview(`http://news.example.com${path}`), path).toBeNull();
    expect(hits).toEqual(["news.example.com/to-ip", "news.example.com/to-name", "news.example.com/to-port", "news.example.com/to-file"]);
    hits.length = 0;
    expect(await fetchPreview("http://news.example.com/one")).toMatchObject({ title: "The end", url: "http://news.example.com/end" });
    expect(hits).toEqual(["news.example.com/one", "news.example.com/two", "calendar.example.com/three", "news.example.com/end"]);
    hits.length = 0;
    expect(await fetchPreview("http://news.example.com/loop")).toBeNull();
    expect(hits.length).toBe(4);
  });

  it("checks a picture's address and its redirects the same way", async () => {
    pages = {
      "/a": { body: ARTICLE.replace("/pictures/lawn.png", "http://169.254.169.254/p.png") },
      "/b": { body: ARTICLE.replace("/pictures/lawn.png", "/moved.png") },
      "/moved.png": { status: 302, headers: { Location: "http://10.0.0.5/p.png" } },
      "/c": { body: ARTICLE.replace("/pictures/lawn.png", "https://calendar.example.com:8443/p.png") },
    };
    for (const path of ["/a", "/b", "/c"]) expect(await fetchPreview(`http://news.example.com${path}`), path).toMatchObject({ title: expect.any(String), image: null });
    expect(hits).toEqual(["news.example.com/a", "news.example.com/b", "news.example.com/moved.png", "news.example.com/c"]);
  });

  it("only reads web pages, and only pictures for the picture", async () => {
    pages = {
      "/data": { headers: { "Content-Type": "application/json" }, body: '{"title":"x"}' },
      "/file": { headers: { "Content-Type": "application/pdf" }, body: "%PDF-1.7" },
      "/none": { headers: { "Content-Type": "" }, body: "<title>No type</title>" },
      "/page": { body: ARTICLE.replace("/pictures/lawn.png", "/not-a-picture") },
      "/not-a-picture": { body: "<html>hello</html>" },
      "/gone": { status: 404, body: "<title>Not found</title>" },
      "/empty": { body: "<html><head></head><body>Nothing to say</body></html>" },
    };
    for (const path of ["/data", "/file", "/none", "/gone", "/empty"]) expect(await fetchPreview(`http://news.example.com${path}`), path).toBeNull();
    expect(await fetchPreview("http://news.example.com/page")).toMatchObject({ title: expect.any(String), image: null });
  });

  it("reads 512 KB of a page at most, unpacked, and a picture of 2 MB at most", async () => {
    const filler = `<!-- ${"x".repeat(600 * 1024)} -->`;
    pages = {
      "/late": { body: `<html><head>${filler}<meta property="og:title" content="Too late"></head></html>` },
      "/early": { body: `<html><head><title>Early</title>${filler}<meta property="og:title" content="Too late"></head></html>` },
      "/packed": { headers: { "Content-Encoding": "gzip" }, body: gzipSync(Buffer.from(`<html><head>${" ".repeat(30 * 1024 * 1024)}<title>Packed</title></head></html>`)) },
      "/big-picture": { body: ARTICLE.replace("/pictures/lawn.png", "/big.png") },
      "/big.png": { headers: { "Content-Type": "image/png" }, body: Buffer.concat([png(), Buffer.alloc(PREVIEW_LIMITS.imageBytes)]) },
    };
    expect(await fetchPreview("http://news.example.com/late")).toBeNull();
    expect(await fetchPreview("http://news.example.com/early")).toMatchObject({ title: "Early" });
    const started = Date.now();
    expect(await fetchPreview("http://news.example.com/packed")).toBeNull();
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(await fetchPreview("http://news.example.com/big-picture")).toMatchObject({ title: expect.any(String), image: null });
  });

  it("gives up on a slow site", async () => {
    pages = { "/slow": { body: ARTICLE, slow: 1_500 } };
    const started = Date.now();
    expect(await fetchPreview("http://news.example.com/slow", { ...PREVIEW_LIMITS, timeoutMs: 300 })).toBeNull();
    expect(Date.now() - started).toBeLessThan(1_200);
  });

  it("reads a page's own tags, Twitter's, or its title", () => {
    const page = new URL("https://news.example.com/x/y");
    expect(readHead(`<head><meta name="twitter:title" content='Quoted "title"'><meta name="twitter:image" content="pic.jpg"></head>`, page)).toMatchObject({ title: 'Quoted "title"', image: "https://news.example.com/x/pic.jpg", site_name: "news.example.com" });
    expect(readHead(`<HEAD><TITLE> A&nbsp;title </TITLE><META NAME="Description" CONTENT="${"d".repeat(400)}"></HEAD>`, page)).toMatchObject({ title: "A title", description: `${"d".repeat(299)}…` });
    // Tags in the page's body aren't its head's.
    expect(readHead(`<head></head><body><meta property="og:title" content="Not this"></body>`, page).title).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// The route: only a link in a message the person can read, kept a week, and asked for in moderation.
// ---------------------------------------------------------------------------------------------

const CO = "00000000-0000-4000-8000-000000000001";
const MESSAGE = "00000000-0000-4000-8000-0000000000b1";
const db = vi.hoisted(() => ({
  body: "",
  deleted: false,
  kept: null as Record<string, unknown> | null,
  saved: [] as Array<Record<string, unknown>>,
  allow: true,
}));
vi.mock("../src/lib/supabase", async (original) => {
  const answer = (table: string, calls: Array<[string, ...any[]]>) => {
    const upsert = calls.find(([n]) => n === "upsert");
    if (table === "memberships") return { data: { role: "field_crew", role_id: null, subcontractor_id: null } };
    if (table === "companies") return { data: { settings: { team_chat: { enabled: true } } } };
    if (table === "chat_messages") {
      return { data: { id: MESSAGE, channel_id: "00000000-0000-4000-8000-0000000000c1", author_id: null, body: db.body, attachments: [], deleted_at: db.deleted ? "2026-11-28T00:00:00Z" : null, created_at: "2026-11-28T00:00:00Z" } };
    }
    if (table === "chat_link_previews") {
      if (upsert) db.saved.push(upsert[1]);
      return { data: calls.some(([n]) => n === "delete") ? null : db.kept };
    }
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
  const client = {
    from: (table: string) => chain(table, []),
    rpc: async (name: string) => ({ data: name === "rate_limit_hit" ? db.allow : null, error: null }),
    auth: { getClaims: async () => ({ data: { claims: { sub: "00000000-0000-4000-8000-0000000000aa" } }, error: null }) },
  };
  return { ...(await original<typeof import("../src/lib/supabase")>()), adminClient: () => client, userClient: () => client };
});

const env: Env = {
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
  SUPABASE_SECRET_KEY: "sb_secret_test",
  ENCRYPTION_KEY: btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => i * 7))),
  APP_URL: "https://ops.greenlawn.example",
};
const headers = { Authorization: "Bearer token", "X-Company-Id": CO };
const ask = (url: string) => app.request(`/api/chat/preview?message=${MESSAGE}&url=${encodeURIComponent(url)}`, { headers }, env);

describe("GET /api/chat/preview", () => {
  beforeEach(() => {
    db.body = "Have a look: http://news.example.com/spring and https://ops.greenlawn.example/quotes/00000000-0000-4000-8000-0000000000d1";
    db.deleted = false;
    db.kept = null;
    db.saved = [];
    db.allow = true;
    pages = { "/spring": { body: ARTICLE }, "/pictures/lawn.png": { headers: { "Content-Type": "image/png" }, body: png() } };
  });

  it("reads a link in the message and keeps what it found", async () => {
    const res = await ask("http://news.example.com/spring");
    expect(res.status).toBe(200);
    expect(((await res.json()) as { preview: { title: string } }).preview.title).toBe("Spring aeration & overseeding — what to know");
    expect(db.saved).toEqual([expect.objectContaining({ company_id: CO, url: "http://news.example.com/spring", ok: true, site_name: "Lawn News", image: expect.stringMatching(/^data:image\/jpeg/) })]);
  });

  it("only for a link that's in the message, and not a deleted one", async () => {
    expect((await ask("http://news.example.com/other")).status).toBe(404);
    db.deleted = true;
    expect((await ask("http://news.example.com/spring")).status).toBe(404);
    expect(hits).toEqual([]);
  });

  it("never reads Crewtavo's own pages, or a link it may not", async () => {
    db.body = "https://ops.greenlawn.example/quotes/00000000-0000-4000-8000-0000000000d1 http://169.254.169.254/latest/meta-data/";
    for (const link of db.body.split(" ")) expect(await (await ask(link)).json()).toEqual({ preview: null });
    expect(hits).toEqual([]);
    expect(db.saved).toEqual([]);
  });

  it("answers from what it kept for a week, without asking the site", async () => {
    db.kept = { ok: true, final_url: "http://news.example.com/spring", title: "Kept", description: null, site_name: "Lawn News", image: null, fetched_at: new Date(Date.now() - 6 * 86_400_000).toISOString() };
    expect(await (await ask("http://news.example.com/spring")).json()).toEqual({ preview: { url: "http://news.example.com/spring", title: "Kept", description: null, site_name: "Lawn News", image: null } });
    expect(hits).toEqual([]);
    db.kept.fetched_at = new Date(Date.now() - 8 * 86_400_000).toISOString();
    expect(((await (await ask("http://news.example.com/spring")).json()) as { preview: { title: string } }).preview.title).toContain("Spring");
  });

  it("asks for pages it hasn't kept in moderation", async () => {
    db.allow = false;
    expect((await ask("http://news.example.com/spring")).status).toBe(429);
    expect(hits).toEqual([]);
  });
});
