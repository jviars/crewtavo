/**
 * Web Push (lib/webpush.ts): a notification goes to the device's push service, signed and
 * encrypted, on the public internet only (lib/publicHttp.ts), and a redirect isn't followed. A
 * device's address comes from its browser when it subscribes (routes/push.ts), so it's checked there
 * too.
 */
import dns from "node:dns";
import type { IncomingHttpHeaders, IncomingMessage, OutgoingHttpHeaders, RequestOptions, ServerResponse } from "node:http";
import { createServer as createSecureServer } from "node:https";
import { isIP, type AddressInfo, type LookupFunction } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { app } from "../src/app";
import type { Env } from "../src/env";
import { toBase64Url } from "../src/lib/crypto";
import { sendPush, type PushSubscription } from "../src/lib/webpush";

// The database: the install's VAPID keys (kept once made), and a signed-in member saving a device.
const db = vi.hoisted(() => ({ vapid: null as string | null, saved: [] as Array<Record<string, unknown>> }));
vi.mock("../src/lib/supabase", async (original) => {
  const client = {
    auth: { getClaims: async () => ({ data: { claims: { sub: "user-1" } }, error: null }) },
    from: (table: string) => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: db.vapid ? { ciphertext: db.vapid } : null, error: null }) }) }),
      delete: () => ({ eq: () => ({ neq: async () => ({ error: null }) }) }),
      upsert: async (row: Record<string, unknown>) => {
        if (table === "app_secrets") db.vapid ??= String(row.ciphertext);
        else db.saved.push(row);
        return { error: null };
      },
    }),
  };
  return { ...(await original<typeof import("../src/lib/supabase")>()), adminClient: () => client, userClient: () => client };
});

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
  // A self-signed certificate for "push.example.com", made for these tests (it's trusted nowhere else).
  KEY: `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgCunFm+M7rLNbx/Vk
y0A7rD7p/NVXV5WW38cYYM3HWTShRANCAAQZc98DvMi/p5l+wppt+IL8D/CXK+fh
Tv9sMdkwJH4zO10rT+QvbGQfc/J1VQ0ZP6ZV/XF+8SZ+Ic9gntQJFpis
-----END PRIVATE KEY-----`,
  CERT: `-----BEGIN CERTIFICATE-----
MIIBqjCCAVCgAwIBAgIUKTDuoOYVYgYY+urnzriUUShnoFMwCgYIKoZIzj0EAwIw
GzEZMBcGA1UEAwwQcHVzaC5leGFtcGxlLmNvbTAgFw0yNjExMTIwNTQ1NTVaGA8y
MTI2MTAxOTA1NDU1NVowGzEZMBcGA1UEAwwQcHVzaC5leGFtcGxlLmNvbTBZMBMG
ByqGSM49AgEGCCqGSM49AwEHA0IABBlz3wO8yL+nmX7Cmm34gvwP8Jcr5+FO/2wx
2TAkfjM7XStP5C9sZB9z8nVVDRk/plX9cX7xJn4hz2Ce1AkWmKyjcDBuMB0GA1Ud
DgQWBBTdsTmLGu8V4Pvmjf4ttPqGJhTN/TAfBgNVHSMEGDAWgBTdsTmLGu8V4Pvm
jf4ttPqGJhTN/TAbBgNVHREEFDASghBwdXNoLmV4YW1wbGUuY29tMA8GA1UdEwEB
/wQFMAMBAf8wCgYIKoZIzj0EAwIDSAAwRQIhALFtjZJ4PKtNwxqG2BHNo1x1tPmp
+5OMSyasP3xun2/RAiBrA5J/bFDHcc0l8QOx/sn9e3X4RhpBF4WXffmVO41FnQ==
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

// Every connection's lookup answers from here.
const names = new Map<string, string[]>();
function answer(host: string, options: { all?: boolean }, callback: (error: Error | null, address?: unknown, family?: number) => void) {
  const found = names.get(host)?.map((address) => ({ address, family: isIP(address) }));
  if (!found) return callback(Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: "ENOTFOUND" }));
  if (options.all) callback(null, found);
  else callback(null, found[0]!.address, found[0]!.family);
}

// The push service: remembers what it was sent, and answers as `reply` says (201, as they do, by default).
const received: Array<{ method: string; path: string; headers: IncomingHttpHeaders; bytes: number }> = [];
let reply: { status: number; headers?: OutgoingHttpHeaders } = { status: 201 };
const service = createSecureServer({ key: internet.KEY, cert: internet.CERT }, (req: IncomingMessage, res: ServerResponse) => {
  let bytes = 0;
  req.on("data", (chunk: Buffer) => (bytes += chunk.byteLength));
  req.on("end", () => {
    received.push({ method: req.method ?? "", path: req.url ?? "", headers: req.headers, bytes });
    res.writeHead(reply.status, reply.headers).end();
  });
});
let port = 0;

const env: Env = {
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
  SUPABASE_SECRET_KEY: "sb_secret_test",
  ENCRYPTION_KEY: btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => i * 7))),
  APP_URL: "https://ops.example.com",
};

// A phone's subscription: its own key and secret, as its browser makes them.
let keys: Pick<PushSubscription, "p256dh" | "auth">;
const device = (endpoint: string): PushSubscription => ({ endpoint, ...keys });
const send = (endpoint: string) => sendPush(env, device(endpoint), { title: "Visit moved to 2:00", link: "/field/visits/1" }, "https://ops.example.com");
const FAILED = { ok: false, gone: false, status: 0 };

beforeAll(async () => {
  port = await new Promise<number>((resolve) => service.listen(0, "127.0.0.1", () => resolve((service.address() as AddressInfo).port)));
  const pair = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
  keys = { p256dh: toBase64Url(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey))), auth: toBase64Url(crypto.getRandomValues(new Uint8Array(16))) };
});
afterAll(() => {
  service.closeAllConnections();
  service.close();
});
beforeEach(() => {
  names.clear();
  names.set("push.example.com", ["203.0.113.7"]);
  received.length = 0;
  internet.requests.length = 0;
  db.saved.length = 0;
  reply = { status: 201 };
  vi.spyOn(dns, "lookup").mockImplementation(answer as unknown as typeof dns.lookup);
  // Nothing goes out any other way.
  vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 201 })));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("a notification", () => {
  it("goes to the device's push service, signed and encrypted", async () => {
    expect(await send(`https://push.example.com:${port}/send/abc123`)).toEqual({ ok: true, gone: false, status: 201 });
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ method: "POST", path: "/send/abc123" });
    expect(received[0]!.headers).toMatchObject({ "content-encoding": "aes128gcm", "content-type": "application/octet-stream", ttl: "86400", urgency: "high" });
    expect(received[0]!.headers.authorization).toMatch(/^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]+$/);
    // All of the encrypted message arrived: its header (salt, record size, key) and then the message.
    expect(received[0]!.bytes).toBeGreaterThan(86);
    expect(received[0]!.headers["content-length"]).toBe(String(received[0]!.bytes));
    // The address that was checked is the one connected to.
    expect(dns.lookup).toHaveBeenCalledTimes(1);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("says when the device has unsubscribed", async () => {
    reply = { status: 410 };
    expect(await send(`https://push.example.com:${port}/send/abc123`)).toEqual({ ok: false, gone: true, status: 410 });
  });

  it("never goes to this server, its network or a cloud's metadata service", async () => {
    names.set("inside.example.com", ["10.0.0.5"]);
    names.set("metadata.example.com", ["169.254.169.254"]);
    // One public address among a name's answers doesn't make the others public.
    names.set("both.example.com", ["203.0.113.7", "127.0.0.1"]);
    for (const endpoint of [
      `https://127.0.0.1:${port}/send`,
      `https://localhost:${port}/send`,
      `https://[::1]:${port}/send`,
      "https://169.254.169.254/latest/meta-data/",
      "https://storage.railway.internal/send",
      `https://inside.example.com:${port}/send`,
      `https://metadata.example.com:${port}/send`,
      `https://both.example.com:${port}/send`,
      `http://push.example.com:${port}/send`,
    ]) {
      expect(await send(endpoint), endpoint).toEqual(FAILED);
    }
    expect(received).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("doesn't follow a redirect", async () => {
    names.set("inside.example.com", ["10.0.0.5"]);
    for (const location of [`https://inside.example.com:${port}/admin`, `https://push.example.com:${port}/elsewhere`, "http://169.254.169.254/latest/meta-data/"]) {
      received.length = 0;
      internet.requests.length = 0;
      reply = { status: 307, headers: { Location: location } };
      expect(await send(`https://push.example.com:${port}/send/abc123`), location).toEqual({ ok: false, gone: false, status: 307 });
      // Asked once, where the device said, and nowhere else.
      expect(received.map((r) => r.path)).toEqual(["/send/abc123"]);
      expect(internet.requests).toEqual([`https://push.example.com:${port}/send/abc123`]);
    }
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("turning notifications on", () => {
  const subscribe = (endpoint: string) =>
    app.request("/api/push/subscriptions", { method: "POST", headers: { Authorization: "Bearer token", "Content-Type": "application/json" }, body: JSON.stringify({ endpoint, keys }) }, env);

  it("saves the device with its push service's address", async () => {
    expect((await subscribe("https://fcm.googleapis.com/fcm/send/abc123")).status).toBe(201);
    expect(db.saved).toEqual([expect.objectContaining({ user_id: "user-1", endpoint: "https://fcm.googleapis.com/fcm/send/abc123" })]);
  });

  it("takes only an address on the public internet", async () => {
    for (const endpoint of ["https://127.0.0.1/send", "https://localhost:8080/send", "https://[::1]/send", "https://169.254.169.254/latest/meta-data/", "https://10.0.0.5/send", "https://storage.railway.internal/send", "http://push.example.com/send"]) {
      const res = await subscribe(endpoint);
      expect(res.status, endpoint).toBe(400);
    }
    expect(await (await subscribe("https://10.0.0.5/send")).json()).toEqual({ error: "Notifications can't be sent to that address." });
    expect(db.saved).toEqual([]);
  });
});
