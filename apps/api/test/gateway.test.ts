/**
 * Uploads through the gateway (lib/gateway.ts): Storage checks a file sent as the bare body against
 * FILE_SIZE_LIMIT by its Content-Length, so the gateway passes that on, and refuses a bare upload
 * that doesn't say how big it is. Forms (what supabase-js and the plans uploader send) Storage checks
 * as they arrive. And stored files come back from this server's own address, so anything but a PDF
 * or a photo downloads instead of running as the app.
 */
import { createHmac } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { HttpBindings } from "@hono/node-server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { EMAIL_CHANGE_STALE, gateway, MAX_AUTH_BODY, MAX_REST_BODY, NO_S3, PASSWORD_LINK_STALE, safeFile, storesFile, unsizedUpload } from "../src/lib/gateway";
import { NO_AUTH_MAIL, sealAuthToken } from "../src/lib/signInGuard";
import { BIGGER_THAN_SAID, LINK_RUN_OUT, UPLOADS_PAUSED, type PublicUploads, type UploadRecord } from "../src/lib/publicUploads";
import { COUNTED_EVERY, forgetStorageUsage, ONE_REQUEST, type StorageSnapshot } from "../src/lib/storageLimits";
import { STORAGE_PAUSED } from "../src/services/storageBucket";

// Whether a storage move has uploads turned away right now (services/storageBucket.ts).
const pause = vi.hoisted(() => ({ on: false }));
vi.mock("../src/services/storageBucket", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/storageBucket")>()),
  storageWritesPaused: () => pause.on,
}));
afterEach(() => {
  pause.on = false;
});

// The rate limits' counts (lib/limit.ts): every key asked about, and the kinds that are used up.
const limits = vi.hoisted(() => ({ keys: [] as string[], full: [] as string[] }));
vi.mock("../src/lib/limit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/limit")>()),
  allow: async (_env: unknown, key: string) => (limits.keys.push(key), !limits.full.some((kind) => key.startsWith(kind))),
}));
afterEach(() => {
  limits.keys.length = 0;
  limits.full.length = 0;
});

const env: Env = { SUPABASE_URL: "http://127.0.0.1:8080", SUPABASE_SECRET_KEY: "sb_secret_test" };
const from = { incoming: { socket: { remoteAddress: "127.0.0.1" } } } as unknown as HttpBindings;

// A stand-in for Auth and Storage: answers with what it was sent (and turns down a file named "refuse").
let upstream: http.Server;
let base = "";
/** What reached the stand-in, by method and path. */
const reached: string[] = [];
/** The bytes of the files the stand-in kept (sent whole to object/files/... or to an upload link). */
let storedBytes = 0;
beforeAll(async () => {
  upstream = http.createServer((req, res) => {
    reached.push(`${req.method} ${req.url}`);
    if (req.url?.includes("refuse")) res.statusCode = 400;
    let bytes = 0;
    let text = "";
    req.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (text.length < 500) text += chunk.toString("utf8");
    });
    req.on("end", () => {
      if ((req.method === "POST" || req.method === "PUT") && /^\/object\/(?:upload\/sign\/)?files\//.test(req.url ?? "") && res.statusCode < 400) storedBytes += bytes;
      // A resumable upload: made at /upload/resumable (where its pieces go comes back in Location),
      // then its pieces, each answered with how much has arrived.
      if (req.method === "POST" && req.url === "/upload/resumable") res.setHeader("location", "http://127.0.0.1/storage/v1/upload/resumable/an-upload");
      if (req.method === "PATCH" && req.url?.startsWith("/upload/resumable/")) {
        storedBytes += bytes;
        res.statusCode = 204;
        res.setHeader("upload-offset", String(Number(req.headers["upload-offset"] ?? 0) + bytes));
        res.end();
        return;
      }
      // A stored file, served with the type it was uploaded with (?as=), as Storage does.
      const as = new URL(req.url ?? "/", "http://x").searchParams.get("as");
      if (as) {
        res.setHeader("content-type", as);
        if (req.url?.includes("download")) res.setHeader("content-disposition", 'attachment; filename="gl.pdf"');
        res.end("<script>steal()</script>");
        return;
      }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ url: req.url, length: req.headers["content-length"] ?? null, chunked: req.headers["transfer-encoding"] === "chunked", bytes, text }));
    });
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => upstream.close(() => resolve())));

const routes = () => gateway(env, { auth: base, rest: base, storage: base });
const stream = (bytes: number) => new ReadableStream({ start(c) { c.enqueue(new Uint8Array(bytes)); c.close(); } });

describe("uploads through the gateway", () => {
  it("tells Storage how big a file sent as the body is", async () => {
    const res = await routes().request("/storage/v1/object/files/co/plans/a.pdf", {
      method: "POST",
      headers: { "Content-Type": "application/pdf", "Content-Length": "4096" },
      body: stream(4096),
      duplex: "half",
    } as RequestInit, from);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ url: "/object/files/co/plans/a.pdf", length: "4096", chunked: false, bytes: 4096 });
  });

  it("refuses a file sent as the body without its size, so it can't get past the limit", async () => {
    const res = await routes().request("/storage/v1/object/files/co/plans/a.pdf", { method: "POST", headers: { "Content-Type": "application/pdf" }, body: stream(4096), duplex: "half" } as RequestInit, from);
    expect(res.status).toBe(411);
    expect((await res.json()).message).toMatch(/size/);
  });

  it("passes a form on without its size: Storage checks the file in it as it arrives", async () => {
    const form = new FormData();
    form.append("cacheControl", "3600");
    form.append("", new Blob([new Uint8Array(2048)], { type: "application/pdf" }), "plan.pdf");
    const body = new Request("http://x", { method: "POST", body: form });
    const res = await routes().request("/storage/v1/object/files/co/plans/b.pdf", {
      method: "POST",
      headers: { "Content-Type": body.headers.get("content-type")! },
      body: body.body,
      duplex: "half",
    } as RequestInit, from);
    expect(res.status).toBe(200);
    expect((await res.json()).bytes).toBeGreaterThan(2048);
  });

  it("still forwards a sign-in the guard rewrote, with its own length", async () => {
    const res = await routes().request("/auth/v1/token?grant_type=password", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": "999" },
      body: JSON.stringify({ email: "ana@example.com", password: "right", extra: "x".repeat(40) }),
    }, from);
    expect(res.status).toBe(200);
    const got = await res.json();
    expect(JSON.parse(got.text)).toEqual({ email: "ana@example.com", password: "right" });
  });

  it("knows which requests are unsized uploads", () => {
    const req = (method: string, headers: Record<string, string>, body: BodyInit | null = "x") => new Request("http://x/storage/v1/object/a", { method, headers, body, duplex: "half" } as RequestInit);
    expect(unsizedUpload(req("POST", { "content-type": "image/jpeg" }, stream(1) as unknown as BodyInit))).toBe(true);
    expect(unsizedUpload(req("PUT", { "content-type": "application/octet-stream", "content-length": "1" }))).toBe(false);
    expect(unsizedUpload(req("POST", { "content-type": "multipart/form-data; boundary=x" }, stream(1) as unknown as BodyInit))).toBe(false);
    expect(unsizedUpload(new Request("http://x/storage/v1/object/a"))).toBe(false);
    expect(unsizedUpload(req("DELETE", {}, null))).toBe(false);
  });
});

describe("stored files through the gateway", () => {
  const get = (path: string, method = "GET") => routes().request(path, { method }, from);

  it("downloads a file uploaded as a web page or a drawing, and never runs it as the app", async () => {
    for (const type of ["text/html", "image/svg+xml", "text/plain; charset=utf-8", "application/octet-stream", "application/xhtml+xml"]) {
      const res = await get(`/storage/v1/object/sign/files/co/subs/s/x?token=t&as=${encodeURIComponent(type)}`);
      expect(res.status, type).toBe(200);
      expect(res.headers.get("x-content-type-options"), type).toBe("nosniff");
      expect(res.headers.get("content-disposition"), type).toBe("attachment");
      expect(res.headers.get("content-security-policy"), type).toBe("sandbox; default-src 'none'");
    }
    const authenticated = await get("/storage/v1/object/authenticated/files/co/visit/v/x.html?as=text%2Fhtml");
    expect(authenticated.headers.get("content-disposition")).toBe("attachment");
  });

  it("shows PDFs and photos in place, not sandboxed (a PDF won't show in a sandbox)", async () => {
    for (const type of ["application/pdf", "image/jpeg", "image/png", "image/heic", "image/webp"]) {
      const res = await get(`/storage/v1/object/sign/files/co/subs/s/x?token=t&as=${encodeURIComponent(type)}`);
      expect(res.headers.get("x-content-type-options"), type).toBe("nosniff");
      expect(res.headers.get("content-disposition"), type).toBeNull();
      expect(res.headers.get("content-security-policy"), type).toBeNull();
    }
    const head = await get("/storage/v1/object/public/files/co/logo/x.png?as=image%2Fpng", "HEAD");
    expect(head.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("keeps the file's name when it downloads", async () => {
    const res = await get("/storage/v1/object/sign/files/co/x?token=t&download=1&as=text%2Fcsv");
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="gl.pdf"');
  });

  it("leaves uploads alone", () => {
    const html = new Response("x", { headers: { "content-type": "text/html" } });
    expect(safeFile(new Request("http://x/storage/v1/object/files/co/a.html", { method: "POST", body: "x" }), html)).toBe(html);
  });

  it("treats whatever Storage answers a GET with the same way, at any of its addresses", async () => {
    for (const path of ["/storage/v1/render/image/authenticated/files/co/a?as=text%2Fhtml", "/storage/v1/bucket?as=text%2Fhtml", "/storage/v1/anything/else?as=image%2Fsvg%2Bxml"]) {
      const res = await get(path);
      expect(res.headers.get("x-content-type-options"), path).toBe("nosniff");
      expect(res.headers.get("content-disposition"), path).toBe("attachment");
      expect(res.headers.get("content-security-policy"), path).toBe("sandbox; default-src 'none'");
    }
  });
});

describe("while files move to new storage", () => {
  const request = (method: string, path: string, headers: Record<string, string> = {}) => new Request(`http://x${path}`, { method, headers });

  it("turns away what puts a file where Storage keeps them: uploads, signed and resumable ones, copies and moves", () => {
    for (const [method, path, headers] of [
      ["POST", "/storage/v1/object/files/co/plans/a.pdf"],
      ["PUT", "/storage/v1/object/files/co/plans/a.pdf"],
      ["POST", "/storage/v1/object/upload/sign/files/co/plans/a.pdf"],
      ["PUT", "/storage/v1/object/upload/sign/files/co/plans/a.pdf?token=t"],
      ["POST", "/storage/v1/upload/resumable"],
      ["PATCH", "/storage/v1/upload/resumable/abc"],
      ["POST", "/storage/v1/upload/resumable/sign"],
      ["HEAD", "/storage/v1/upload/resumable/abc", { "X-HTTP-Method-Override": "PATCH" }],
      ["POST", "/storage/v1/object/copy"],
      ["POST", "/storage/v1/object/move"],
      // Storage takes these as uploads into a bucket named "sign" or "list", not as reads.
      ["PUT", "/storage/v1/object/sign/files/co/a.pdf"],
      ["POST", "/storage/v1/object/list/files/co/a.pdf"],
      ["POST", "/storage/v1/object/sign/"],
      ["POST", "/storage/v1/object/sign%2Ffiles/co/a.pdf"],
    ] as Array<[string, string, Record<string, string>?]>) {
      expect(storesFile(request(method, path, headers)), `${method} ${path}`).toBe(true);
    }
  });

  it("lets opening files, signing links to them, listing and deleting carry on", () => {
    for (const [method, path] of [
      ["GET", "/storage/v1/object/sign/files/co/plans/a.pdf?token=t"],
      ["GET", "/storage/v1/object/authenticated/files/co/plans/a.pdf"],
      ["GET", "/storage/v1/object/info/files/co/plans/a.pdf"],
      ["HEAD", "/storage/v1/object/files/co/plans/a.pdf"],
      ["HEAD", "/storage/v1/upload/resumable/abc"],
      ["OPTIONS", "/storage/v1/upload/resumable"],
      ["POST", "/storage/v1/object/sign/files/co/plans/a.pdf"],
      ["POST", "/storage/v1/object/sign/files"],
      ["POST", "/storage/v1/object/list/files"],
      ["POST", "/storage/v1/object/list-v2/files"],
      ["DELETE", "/storage/v1/object/files"],
      ["DELETE", "/storage/v1/object/files/co/plans/a.pdf"],
      ["DELETE", "/storage/v1/upload/resumable/abc"],
    ]) {
      expect(storesFile(request(method!, path!)), `${method} ${path}`).toBe(false);
    }
  });

  it("answers an upload with a minute's wait, and still signs links, lists and opens files", async () => {
    pause.on = true;
    const json = (method: string, path: string, body: unknown) => {
      const text = JSON.stringify(body);
      return routes().request(path, { method, headers: { "Content-Type": "application/json", "Content-Length": String(new TextEncoder().encode(text).length) }, body: text }, from);
    };
    const upload = () =>
      routes().request("/storage/v1/object/files/co/plans/a.pdf", { method: "POST", headers: { "Content-Type": "application/pdf", "Content-Length": "4096" }, body: stream(4096), duplex: "half" } as RequestInit, from);

    const refused = await upload();
    expect(refused.status).toBe(503);
    expect(refused.headers.get("retry-after")).toBe("30");
    expect((await refused.json()).message).toBe(STORAGE_PAUSED);
    for (const [method, path] of [["PATCH", "/storage/v1/upload/resumable/abc"], ["POST", "/storage/v1/object/copy"], ["POST", "/storage/v1/object/upload/sign/files/co/a.pdf"]]) {
      expect((await json(method!, path!, { sourceKey: "co/a.pdf", destinationKey: "co/b.pdf" })).status, `${method} ${path}`).toBe(503);
    }

    const signed = await json("POST", "/storage/v1/object/sign/files/co/plans/a.pdf", { expiresIn: 3600 });
    expect(signed.status).toBe(200);
    expect((await signed.json()).url).toBe("/object/sign/files/co/plans/a.pdf");
    const several = await json("POST", "/storage/v1/object/sign/files", { expiresIn: 3600, paths: ["co/plans/a.pdf", "co/visit/v/b.jpg"] });
    expect((await several.json()).url).toBe("/object/sign/files");
    const listed = await json("POST", "/storage/v1/object/list/files", { prefix: "co/plans" });
    expect((await listed.json()).url).toBe("/object/list/files");
    const opened = await routes().request("/storage/v1/object/sign/files/co/plans/a.pdf?token=t&as=application%2Fpdf", {}, from);
    expect(opened.status).toBe(200);
    const deleted = await json("DELETE", "/storage/v1/object/files", { prefixes: ["co/plans/a.pdf"] });
    expect((await deleted.json()).url).toBe("/object/files");

    // And uploads go through again once storage has switched.
    pause.on = false;
    expect((await upload()).status).toBe(200);
  });
});


describe("storage limits at the gateway", () => {
  const CO = "0b0a0000-0000-4000-8000-000000000001";
  const ANA = "00000000-0000-4000-8000-0000000000aa";
  const SECRET = "super-secret-jwt-token-with-at-least-32-characters-long";
  const part = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  /** A token signed as the instance's services sign them (HS256 with JWT_SECRET). */
  const sign = (claims: object) => {
    const unsigned = `${part({ alg: "HS256", typ: "JWT" })}.${part(claims)}`;
    return `${unsigned}.${createHmac("sha256", SECRET).update(unsigned).digest("base64url")}`;
  };
  const LATER = Math.floor(Date.now() / 1000) + 3600;
  const ana = sign({ sub: ANA, role: "authenticated", exp: LATER });
  const anon = sign({ role: "anon", iss: "supabase", exp: LATER });
  const service = sign({ role: "service_role", iss: "supabase", exp: LATER });
  /** A signed upload link's token: for `owner` when a team member asked for it, for nobody when the server did. */
  const link = (name: string, owner?: string) => sign({ ...(owner ? { owner } : {}), url: `files/${name}`, upsert: false, scope: "upload", exp: LATER });
  const b64 = (text: string) => Buffer.from(text).toString("base64");
  const FULL = (size: string) => `This ${size} file doesn't fit: 45 GB of the 45 GB storage limit is used. An owner or admin can raise it in Settings → Storage, or empty the Trash.`;

  let numbers: StorageSnapshot;
  let reads = 0;
  /** The records of the upload links the server made (public.upload_links), by stored name. */
  let records: Map<string, UploadRecord>;
  /** What was counted against the day's worth of strangers' uploads, whether there's room, and how much is left of the day. */
  let spent: Array<{ company: string; visitor: string; bytes: number }>;
  let room = true;
  let left = Infinity;
  let recordsDown = false;
  const uploads: PublicUploads = {
    find: async (path) => {
      if (recordsDown) throw new Error("the database is busy");
      return records.get(path) ?? null;
    },
    spend: async (company, visitor, bytes) => {
      spent.push({ company, visitor, bytes });
      left -= bytes;
      return room && left >= 0;
    },
  };
  /** What was counted, without the asks (0) before an upload starts. */
  const counted = () => spent.filter((s) => s.bytes > 0);
  const limited = (jwtSecret = SECRET) =>
    gateway(env, { auth: base, rest: base, storage: base }, {
      jwtSecret,
      storage: async () => {
        reads++;
        // The database has what the stand-in kept.
        return { ...numbers, companyUsed: numbers.companyUsed + storedBytes };
      },
      uploads,
    });
  /** A link the server made for `name`, on record for a file of `bytes`. */
  const made = (name: string, bytes = 4096, expiresAt = Date.now() + 3_600_000) => {
    records.set(name, { company: CO, maxBytes: bytes, expiresAt });
    return link(name);
  };
  beforeEach(() => {
    forgetStorageUsage();
    reads = 0;
    storedBytes = 0;
    reached.length = 0;
    numbers = { companyUsed: 45e9, companyLimit: 45e9, userUsed: 0, userLimit: null, owner: false, member: true };
    records = new Map();
    spent = [];
    room = true;
    left = Infinity;
    recordsDown = false;
  });

  /** A resumable upload being made (tus-js-client's first request): its size and where it goes, no file yet. */
  const create = (objectName: string, bytes: number, headers: Record<string, string> = {}, path = "/storage/v1/upload/resumable") =>
    limited().request(path, {
      method: "POST",
      headers: {
        "Tus-Resumable": "1.0.0",
        "Upload-Length": String(bytes),
        "Upload-Metadata": `bucketName ${b64("files")},objectName ${b64(objectName)},contentType ${b64("application/pdf")},cacheControl ${b64("3600")}`,
        "Content-Length": "0",
        Authorization: `Bearer ${ana}`,
        ...headers,
      },
    }, from);
  /** A file sent in one request (supabase-js, and the one-request fallback). */
  const upload = (path: string, bytes: number, bearer: string | null = ana, method = "POST", authorization = bearer ? `Bearer ${bearer}` : null) =>
    limited().request(path, {
      method,
      headers: { "Content-Type": "application/octet-stream", "Content-Length": String(bytes), ...(authorization ? { Authorization: authorization } : {}) },
      body: stream(bytes),
      duplex: "half",
    } as RequestInit, from);

  it("refuses a resumable upload into Drive when the company's storage is full, before Storage sees it", async () => {
    const res = await create(`${CO}/plans/a.pdf`, 20_000_000);
    expect(res.status).toBe(507);
    expect(await res.json()).toEqual({ statusCode: "507", error: "Storage full", message: FULL("20 MB") });
    expect(reached).toEqual([]);
  });

  it("refuses resumable uploads made every way Storage takes them", async () => {
    for (const [headers, path] of [
      [{}, "/storage/v1/upload/resumable/"],
      [{}, "/storage/v1/upload/resumable/anything"],
      [{}, "/storage/v1/upload/resum%61ble"],
      [{ "X-HTTP-Method-Override": "PATCH" }, "/storage/v1/upload/resumable"],
      // Without "Bearer ": Storage takes the whole header as the token.
      [{ Authorization: ana }, "/storage/v1/upload/resumable"],
    ] as const) {
      expect((await create(`${CO}/plans/a.pdf`, 4096, headers, path)).status, `${JSON.stringify(headers)} ${path}`).toBe(507);
    }
    expect(reached).toEqual([]);
  });

  it("isn't talked out of the folder by metadata tus reads differently", async () => {
    const res = await create(`${CO}/plans/a.pdf`, 4096, {
      "Upload-Metadata": `bucketName ${b64("files")},objectName ${b64(`${CO}/plans/a.pdf`)},\tbucketName ${b64("x")},\tobjectName ${b64(`${CO}/visit/v1/a.jpg`)}`,
    });
    expect(res.status).toBe(507);
  });

  it("refuses guides, résumés, chat and equipment photos too, sent in one request", async () => {
    for (const folder of ["kb", "applicants/a1", "chat/c1", "equipment"]) {
      const res = await upload(`/storage/v1/object/files/${CO}/${folder}/x.jpg`, 4096);
      expect(res.status, folder).toBe(507);
    }
    expect((await upload(`/storage/v1/object/files/${CO}/kb/y.jpg`, 4096, null, "POST", ana)).status).toBe(507);
    expect(reached).toEqual([]);
  });

  it("lets visit and quote photos, receipts and paperwork in however full it is, without looking", async () => {
    for (const folder of ["visit/v1", "quote/q1", "receipts", "subs/s1", "tickets/j1", "measurements"]) {
      const res = await upload(`/storage/v1/object/files/${CO}/${folder}/x.jpg`, 4096);
      expect(res.status, folder).toBe(200);
    }
    expect(reads).toBe(0);
  });

  it("never holds the server, or an upload link the server made, to the storage limits", async () => {
    expect((await upload(`/storage/v1/object/files/${CO}/plans/a.pdf`, 4096, service)).status).toBe(200);
    expect((await upload(`/storage/v1/object/upload/sign/files/${CO}/plans/b.pdf?token=${made(`${CO}/plans/b.pdf`)}`, 4096, anon, "PUT")).status).toBe(200);
    expect((await upload(`/storage/v1/object/upload/sign/files/${CO}/subs/s1/c.pdf?token=${made(`${CO}/subs/s1/c.pdf`)}`, 4096, null, "PUT")).status).toBe(200);
    // Storage goes by the link there, not by who's signed in.
    expect((await upload(`/storage/v1/object/upload/sign/files/${CO}/plans/e.pdf?token=${made(`${CO}/plans/e.pdf`)}`, 4096, ana, "PUT")).status).toBe(200);
    expect((await create(`${CO}/plans/d.pdf`, 4096, { Authorization: `Bearer ${service}` })).status).toBe(200);
    expect(reads).toBe(0);
  });

  it("holds an upload through a link the server made to the size its visitor gave, and counts it against the day", async () => {
    const token = made(`${CO}/plans/b.pdf`, 4096);
    expect((await upload(`/storage/v1/object/upload/sign/files/${CO}/plans/b.pdf?token=${token}`, 4096, null, "PUT")).status).toBe(200);
    // Asked first (counting nothing), then counted as it arrived.
    expect(spent).toEqual([{ company: CO, visitor: "127.0.0.1", bytes: 0 }, { company: CO, visitor: "127.0.0.1", bytes: 4096 }]);
    // A form's envelope is a little more than its file.
    expect((await upload(`/storage/v1/object/upload/sign/files/${CO}/plans/b.pdf?token=${token}`, 4096 + 1000, null, "PUT")).status).toBe(200);
    // Far more than its visitor said: refused before Storage sees a byte, and not counted.
    reached.length = 0;
    spent = [];
    const big = await upload(`/storage/v1/object/upload/sign/files/${CO}/plans/b.pdf?token=${token}`, 100_000, null, "PUT");
    expect(big.status).toBe(413);
    expect((await big.json()).message).toBe(BIGGER_THAN_SAID);
    expect(reached).toEqual([]);
    expect(spent).toEqual([]);
  });

  it("wants the size of an upload through a link the server made, however it's sent", async () => {
    const token = made(`${CO}/plans/b.pdf`);
    const form = new FormData();
    form.append("", new Blob([new Uint8Array(2048)], { type: "application/pdf" }), "plan.pdf");
    const body = new Request("http://x", { method: "PUT", body: form });
    const res = await limited().request(`/storage/v1/object/upload/sign/files/${CO}/plans/b.pdf?token=${token}`, {
      method: "PUT",
      headers: { "Content-Type": body.headers.get("content-type")! },
      body: body.body,
      duplex: "half",
    } as RequestInit, from);
    expect(res.status).toBe(411);
    expect(reached).toEqual([]);
  });

  it("takes nothing through a link the server made that isn't on record, or has run out", async () => {
    const unknown = await upload(`/storage/v1/object/upload/sign/files/${CO}/plans/x.pdf?token=${link(`${CO}/plans/x.pdf`)}`, 4096, null, "PUT");
    expect(unknown.status).toBe(403);
    expect((await unknown.json()).message).toBe(LINK_RUN_OUT);
    const old = made(`${CO}/plans/y.pdf`, 4096, Date.now() - 1000);
    expect((await upload(`/storage/v1/object/upload/sign/files/${CO}/plans/y.pdf?token=${old}`, 4096, null, "PUT")).status).toBe(403);
    expect(reached).toEqual([]);
  });

  it("takes no resumable upload through a link the server made: one could be made and never sent", async () => {
    const token = made(`${CO}/plans/r.pdf`, 4096);
    for (const headers of [{}, { "Upload-Length": "", "Upload-Defer-Length": "1" }] as Array<Record<string, string>>) {
      const res = await create(`${CO}/plans/r.pdf`, 4096, { Authorization: "", "x-signature": token, ...headers }, "/storage/v1/upload/resumable/sign");
      expect(res.status).toBe(400);
      expect((await res.json()).message).toBe(ONE_REQUEST);
    }
    expect(reached).toEqual([]);
    expect(spent).toEqual([]);
  });

  /** A body that sends `bytes` in pieces of `piece`, then (with `drop`) stops there as a dropped connection does. */
  const pieces = (bytes: number, piece: number, drop = false) => {
    let sent = 0;
    return new ReadableStream<Uint8Array>({
      pull(c) {
        if (sent >= bytes) return drop ? c.error(new Error("the connection dropped")) : c.close();
        const n = Math.min(piece, bytes - sent);
        sent += n;
        c.enqueue(new Uint8Array(n));
      },
    });
  };
  const putThrough = (name: string, token: string, said: number, body: ReadableStream<Uint8Array>) =>
    limited().request(`/storage/v1/object/upload/sign/files/${name}?token=${token}`, {
      method: "PUT",
      headers: { "Content-Type": "application/octet-stream", "Content-Length": String(said) },
      body,
      duplex: "half",
    } as RequestInit, from);

  it("counts nothing for a size said and never sent, however often it's said", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const name = `${CO}/plans/big.pdf`;
    const token = made(name, 200_000_000);
    for (let i = 0; i < 3; i++) await putThrough(name, token, 200_000_000, pieces(1000, 1000, true));
    expect(counted()).toEqual([]);
    expect(storedBytes).toBe(0);
  });

  it("counts a big file as it arrives, and all of it once it's in", async () => {
    const MB = 1024 * 1024;
    const name = `${CO}/plans/plan-set.pdf`;
    const res = await putThrough(name, made(name, 40 * MB), 40 * MB, pieces(40 * MB, MB));
    expect(res.status).toBe(200);
    expect(counted().map((s) => s.bytes)).toEqual([COUNTED_EVERY, COUNTED_EVERY, 40 * MB - 2 * COUNTED_EVERY]);
    expect(storedBytes).toBe(40 * MB);
  });

  it("cuts an upload off where the day runs out, and never sends Storage the end of a file it had no room for", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const MB = 1024 * 1024;
    left = 20 * MB;
    const name = `${CO}/plans/plan-set.pdf`;
    const res = await putThrough(name, made(name, 40 * MB), 40 * MB, pieces(40 * MB, MB));
    expect(res.status).toBe(429);
    expect((await res.json()).message).toBe(UPLOADS_PAUSED);
    expect(storedBytes).toBe(0);
    // A small file whose last piece goes over: counted before it goes on, so it isn't stored either.
    left = 1000;
    const small = `${CO}/plans/small.pdf`;
    const smallRes = await putThrough(small, made(small, 4096), 4096, pieces(4096, 4096));
    expect(smallRes.status).toBe(429);
    expect(storedBytes).toBe(0);
  });

  it("turns uploads through links the server made away once the day's worth has come in", async () => {
    room = false;
    const res = await upload(`/storage/v1/object/upload/sign/files/${CO}/plans/b.pdf?token=${made(`${CO}/plans/b.pdf`)}`, 4096, null, "PUT");
    expect(res.status).toBe(429);
    expect((await res.json()).message).toBe(UPLOADS_PAUSED);
    expect(reached).toEqual([]);
  });

  it("lets an upload through a link the server made go ahead when its record can't be read", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    recordsDown = true;
    expect((await upload(`/storage/v1/object/upload/sign/files/${CO}/plans/b.pdf?token=${link(`${CO}/plans/b.pdf`)}`, 4096, null, "PUT")).status).toBe(200);
  });

  it("checks an upload link a team member made, whoever uses it", async () => {
    const token = link(`${CO}/plans/b.pdf`, ANA);
    expect((await upload(`/storage/v1/object/upload/sign/files/${CO}/plans/b.pdf?token=${token}`, 4096, null, "PUT")).status).toBe(507);
    expect((await upload(`/storage/v1/object/upload/sign/files/${CO}/plans/b.pdf?token=${token}`, 4096, anon, "PUT")).status).toBe(507);
    const signedCreate = await create(`${CO}/plans/b.pdf`, 4096, { Authorization: "", "x-signature": token }, "/storage/v1/upload/resumable/sign");
    expect(signedCreate.status).toBe(507);
    expect(reached).toEqual([]);
  });

  it("reads nothing and says nothing for a token that isn't genuine: Storage turns it down", async () => {
    const forged = `${part({ alg: "HS256", typ: "JWT" })}.${part({ sub: ANA, role: "authenticated", exp: LATER })}.c2ln`;
    const res = await create(`${CO}/plans/a.pdf`, 1e13, { Authorization: `Bearer ${forged}` });
    expect(res.status).toBe(200);
    expect(await res.text()).not.toContain("45 GB");
    expect(reads).toBe(0);
    // The same goes for every token when the gateway has no secret to check them with.
    expect((await limited("").request(`/storage/v1/object/files/${CO}/plans/b.pdf`, { method: "POST", headers: { "Content-Length": "1", Authorization: `Bearer ${ana}` }, body: "x" }, from)).status).toBe(200);
    expect(reads).toBe(0);
  });

  it("never tells the company's numbers to someone not on its team", async () => {
    numbers = { companyUsed: 0, companyLimit: null, userUsed: 0, userLimit: null, owner: false, member: false };
    const res = await create(`${CO}/plans/a.pdf`, 1e13);
    expect(res.status).toBe(200);
  });

  it("refuses Drive files and guides for a person over their own limit, and nothing else of theirs", async () => {
    numbers = { companyUsed: 1e9, companyLimit: null, userUsed: 10e9, userLimit: 10e9, owner: false, member: true };
    const refused = await upload(`/storage/v1/object/files/${CO}/kb/cover.jpg`, 4096);
    expect(refused.status).toBe(507);
    expect((await refused.json()).message).toBe("This 4.1 KB file doesn't fit in your storage: you've used 10 GB of your 10 GB. Ask an owner to raise it, or move old files to the Trash.");
    expect((await create(`${CO}/plans/a.pdf`, 4096)).status).toBe(507);
    expect((await upload(`/storage/v1/object/files/${CO}/chat/c1/x.jpg`, 4096)).status).toBe(200);
  });

  it("never limits an owner by a personal limit", async () => {
    numbers = { companyUsed: 1e9, companyLimit: null, userUsed: 10e9, userLimit: 10e9, owner: true, member: true };
    expect((await create(`${CO}/plans/a.pdf`, 4096)).status).toBe(200);
  });

  it("leaves a resumable upload's pieces alone: only its start is checked", async () => {
    const piece = await limited().request("/storage/v1/upload/resumable/abc", {
      method: "PATCH",
      headers: { "Tus-Resumable": "1.0.0", "Upload-Offset": "0", "Content-Type": "application/offset+octet-stream", "Content-Length": "4096", Authorization: `Bearer ${ana}` },
      body: stream(4096),
      duplex: "half",
    } as RequestInit, from);
    expect(piece.status).toBe(204);
    expect(reads).toBe(0);
  });

  it("adds what it lets through to the numbers, and takes off what Storage turns down", async () => {
    numbers = { companyUsed: 0, companyLimit: 10_000, userUsed: 0, userLimit: null, owner: false, member: true };
    // Storage turns this one down, so it doesn't count.
    expect((await upload(`/storage/v1/object/files/${CO}/plans/refuse.pdf`, 6000)).status).toBe(400);
    expect((await upload(`/storage/v1/object/files/${CO}/plans/a.pdf`, 6000)).status).toBe(200);
    // 6,000 stored and 6,000 more is over 10,000: counted once, though it's read again before refusing.
    const refused = await upload(`/storage/v1/object/files/${CO}/plans/b.pdf`, 6000);
    expect(refused.status).toBe(507);
    expect((await refused.json()).message).toContain("6 KB of the 10 KB storage limit is used");
    expect((await upload(`/storage/v1/object/files/${CO}/plans/c.pdf`, 4000)).status).toBe(200);
    expect(reads).toBe(2);
  });

  it("wants a signed-in person's upload to say its size wherever a limit applies", async () => {
    numbers = { companyUsed: 0, companyLimit: null, userUsed: 0, userLimit: null, owner: false, member: true };
    // A resumable upload whose length comes later: its pieces aren't checked again.
    const deferred = await create(`${CO}/plans/a.pdf`, 0, { "Upload-Length": "", "Upload-Defer-Length": "1" });
    expect(deferred.status).toBe(411);
    expect(await deferred.json()).toEqual({ statusCode: "411", error: "Length Required", message: "Send the file's size (Upload-Length) when the upload starts." });
    // A form sent without a length.
    const form = await limited().request(`/storage/v1/object/files/${CO}/kb/a.jpg`, {
      method: "POST",
      headers: { "Content-Type": "multipart/form-data; boundary=x", Authorization: `Bearer ${ana}` },
      body: stream(64),
      duplex: "half",
    } as RequestInit, from);
    expect(form.status).toBe(411);
    expect(reached).toEqual([]);
    expect(reads).toBe(0);
    // Not where nothing's ever refused, nor for the server.
    expect((await create(`${CO}/visit/v1/a.jpg`, 0, { "Upload-Length": "", "Upload-Defer-Length": "1" })).status).toBe(200);
    expect((await create(`${CO}/plans/b.pdf`, 0, { "Upload-Length": "", "Upload-Defer-Length": "1", Authorization: `Bearer ${service}` })).status).toBe(200);
  });

  it("doesn't use Storage's S3 address at all: uploads there would skip the limits, and a file read there could be asked for as a web page", async () => {
    numbers = { companyUsed: 0, companyLimit: null, userUsed: 0, userLimit: null, owner: false, member: true };
    const s3 = (method: string, path: string) =>
      limited().request(path, { method, headers: { Authorization: "AWS4-HMAC-SHA256 Credential=crewtavo/20261028/stub/s3/aws4_request", "x-amz-security-token": ana, ...(method === "PUT" ? { "Content-Length": "4" } : {}) }, ...(method === "PUT" ? { body: "file" } : {}) }, from);
    for (const [method, path] of [
      ["PUT", `/storage/v1/s3/files/${CO}/plans/a.pdf`],
      ["POST", `/storage/v1/s3/files/${CO}/plans/a.pdf?uploads`],
      ["POST", "/storage/v1/s3/files"],
      ["PUT", `/storage/v1/%73%33/files/${CO}/plans/a.pdf`],
      ["GET", `/storage/v1/s3/files/${CO}/plans/a.pdf`],
      ["GET", `/storage/v1/s3/files/${CO}/plans/a.html?X-Amz-Signature=x&response-content-type=text%2Fhtml`],
      ["HEAD", `/storage/v1/s3/files/${CO}/plans/a.pdf`],
      ["GET", "/storage/v1/s3"],
      ["GET", `/storage/v1/S3/files/${CO}/plans/a.pdf`],
      ["GET", `/storage/v1//s3/files/${CO}/plans/a.pdf`],
    ] as const) {
      const res = await s3(method, path);
      expect(res.status, `${method} ${path}`).toBe(403);
      if (method !== "HEAD") expect((await res.json()).message).toBe(NO_S3);
    }
    expect(reached).toEqual([]);
  });

  it("counts a resumable upload once its last piece is in, not again on top of the database's number", async () => {
    numbers = { companyUsed: 0, companyLimit: 20e6, userUsed: 0, userLimit: null, owner: false, member: true };
    const made = await create(`${CO}/plans/a.pdf`, 13e6);
    expect(made.status).toBe(200);
    const piece = await limited().request(new URL(made.headers.get("location")!).pathname, {
      method: "PATCH",
      headers: { "Tus-Resumable": "1.0.0", "Upload-Offset": "0", "Content-Type": "application/offset+octet-stream", "Content-Length": String(13e6), Authorization: `Bearer ${ana}` },
      body: stream(13e6),
      duplex: "half",
    } as RequestInit, from);
    expect(piece.status).toBe(204);
    // 13 MB is stored now. The next 13 MB doesn't fit, and the refusal says 13 MB is used, not 26.
    const next = await create(`${CO}/plans/b.pdf`, 13e6);
    expect(next.status).toBe(507);
    expect((await next.json()).message).toBe("This 13 MB file doesn't fit: 13 MB of the 20 MB storage limit is used. An owner or admin can raise it in Settings → Storage, or empty the Trash.");
    // ...and 7 MB still does.
    expect((await create(`${CO}/plans/c.pdf`, 7e6)).status).toBe(200);
  });

  it("copies and moves stored files only as the server: a person's copy would skip the limits", async () => {
    numbers = { companyUsed: 0, companyLimit: null, userUsed: 0, userLimit: null, owner: false, member: true };
    const body = JSON.stringify({ bucketId: "files", sourceKey: `${CO}/visit/v/a.jpg`, destinationKey: `${CO}/plans/a.jpg` });
    const copy = (path: string, bearer: string | null) =>
      limited().request(path, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": String(body.length), ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) },
        body,
      }, from);
    for (const [path, bearer] of [
      ["/storage/v1/object/copy", ana],
      ["/storage/v1/object/move", ana],
      ["/storage/v1/object/%63opy", ana],
      ["/storage/v1/object/copy", anon],
      ["/storage/v1/object/copy", null],
    ] as const) {
      const res = await copy(path, bearer);
      expect(res.status, `${path} as ${bearer === ana ? "a person" : bearer ? "anon" : "nobody"}`).toBe(403);
      expect((await res.json()).message).toBe("Crewtavo copies and moves stored files itself. Upload the file where you want it instead.");
    }
    expect(reached).toEqual([]);
    expect((await copy("/storage/v1/object/copy", service)).status).toBe(200);
  });

  it("lets the next upload through at once when the limit is raised", async () => {
    expect((await create(`${CO}/plans/a.pdf`, 4096)).status).toBe(507);
    numbers = { ...numbers, companyLimit: 50e9 };
    expect((await create(`${CO}/plans/a.pdf`, 4096)).status).toBe(200);
    expect(reads).toBe(2);
  });

  it("lets uploads go ahead when the numbers can't be read", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const broken = gateway(env, { auth: base, rest: base, storage: base }, {
        jwtSecret: SECRET,
        storage: async () => {
          throw new Error("database down");
        },
      });
      const res = await broken.request(`/storage/v1/object/files/${CO}/plans/a.pdf`, { method: "POST", headers: { "Content-Length": "4096", Authorization: `Bearer ${ana}` }, body: stream(4096), duplex: "half" } as RequestInit, from);
      expect(res.status).toBe(200);
    } finally {
      warn.mockRestore();
    }
  });

  it("still turns uploads away while files move, before looking at the limits", async () => {
    pause.on = true;
    expect((await create(`${CO}/plans/a.pdf`, 4096)).status).toBe(503);
    expect(reads).toBe(0);
  });
});

describe("a new password straight through Auth", () => {
  const SECRET = "super-secret-jwt-token-with-at-least-32-characters-long";
  const part = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const NOW = Math.floor(Date.now() / 1000);
  /** A session's token as the instance's Auth signs it, signed in by `method` `ago` seconds back. */
  const session = (method: string, ago = 0, secret = SECRET) => {
    const unsigned = `${part({ alg: "HS256", typ: "JWT" })}.${part({ sub: "00000000-0000-4000-8000-0000000000aa", role: "authenticated", exp: NOW + 3600, amr: [{ method, timestamp: NOW - ago }] })}`;
    return `${unsigned}.${createHmac("sha256", secret).update(unsigned).digest("base64url")}`;
  };
  const put = (token: string, body: string, path = "/auth/v1/user") =>
    gateway(env, { auth: base, rest: base, storage: base }, { jwtSecret: SECRET }).request(path, { method: "PUT", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body }, from);
  beforeEach(() => {
    reached.length = 0;
  });

  it("goes ahead right after a reset, invitation or emailed sign-in link (the Choose a new password screen)", async () => {
    for (const method of ["recovery", "invite", "magiclink", "otp"]) {
      const res = await put(session(method, 60), JSON.stringify({ password: "a new one 123" }));
      expect(res.status, method).toBe(200);
      expect(JSON.parse((await res.json()).text)).toEqual({ password: "a new one 123" });
    }
    expect(reached).toEqual(Array(4).fill("PUT /user"));
  });

  it("is turned away from any other session, or 15 minutes after the link was opened", async () => {
    for (const token of [session("password"), session("oauth"), session("token_refresh"), session("recovery", 16 * 60), session("recovery", 0, "someone-else's-secret-that-is-32-chars-long")]) {
      const res = await put(token, JSON.stringify({ password: "a new one 123" }));
      expect(res.status).toBe(403);
      expect((await res.json()).msg).toBe(PASSWORD_LINK_STALE);
    }
    expect(reached).toEqual([]);
  });

  it("can't be slipped past under another spelling or address", async () => {
    const stale = session("password");
    expect((await put(stale, JSON.stringify({ PassWord: "x".repeat(10) }))).status).toBe(403);
    expect((await put(stale, JSON.stringify({ data: {}, password: "y".repeat(10) }), "/auth/v1/user/")).status).toBe(403);
    expect((await put(stale, JSON.stringify({ password: "y".repeat(10) }), "/auth/v1/%75ser")).status).toBe(403);
    expect((await put(stale, "{\"password\":\"y\"} trailing")).status).toBe(400);
    expect(reached).toEqual([]);
    // Auth matches "pasſword" to password; it never gets there.
    const res = await put(stale, JSON.stringify({ "pasſword": "z".repeat(10), data: { full_name: "Ana" } }));
    expect(res.status).toBe(200);
    expect(JSON.parse((await res.json()).text)).toEqual({ data: { full_name: "Ana" } });
  });

  it("keeps the email and phone to the same rule, so a session can't move them and get itself a link", async () => {
    for (const body of [{ email: "someone@else.test" }, { EMAIL: "someone@else.test" }, { phone: "+15555550100" }]) {
      const res = await put(session("password"), JSON.stringify(body));
      expect(res.status).toBe(403);
      expect((await res.json()).msg).toBe(EMAIL_CHANGE_STALE);
    }
    expect(reached).toEqual([]);
    const res = await put(session("magiclink", 60), JSON.stringify({ email: "new@crew.test" }));
    expect(res.status).toBe(200);
    expect(JSON.parse((await res.json()).text)).toEqual({ email: "new@crew.test" });
  });

  it("leaves the rest of the account alone", async () => {
    const stale = session("password", 3 * 86400);
    expect((await put(stale, JSON.stringify({ data: { full_name: "Ana" } }))).status).toBe(200);
    const read = await gateway(env, { auth: base, rest: base, storage: base }, { jwtSecret: SECRET }).request("/auth/v1/user", { headers: { Authorization: `Bearer ${stale}` } }, from);
    expect(read.status).toBe(200);
    expect(reached).toEqual(["PUT /user", "GET /user"]);
  });
});

describe("sign-in links through the gateway", () => {
  const SECRET = "super-secret-jwt-token-with-at-least-32-characters-long";
  const instance: Env = { ...env, CREWTAVO_GATEWAY: "1" };
  const part = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const key = (role: string, secret = SECRET) => {
    const unsigned = `${part({ alg: "HS256", typ: "JWT" })}.${part({ role, iss: "supabase", exp: Math.floor(Date.now() / 1000) + 3600 })}`;
    return `${unsigned}.${createHmac("sha256", secret).update(unsigned).digest("base64url")}`;
  };
  const auth = (path: string, init: { method?: string; body?: unknown; token?: string } = {}) =>
    gateway(instance, { auth: base, rest: base, storage: base }, { jwtSecret: SECRET }).request(
      `/auth/v1${path}`,
      { method: init.method ?? "POST", headers: { "Content-Type": "application/json", ...(init.token ? { Authorization: `Bearer ${init.token}` } : {}) }, ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }) },
      from,
    );
  const TOKEN = "cd34".repeat(14);
  beforeEach(() => {
    reached.length = 0;
  });

  it("redeems a link this server sent, handing Auth the token it made", async () => {
    const res = await auth("/verify", { body: { type: "invite", token_hash: await sealAuthToken(instance, TOKEN, "invite") } });
    expect(res.status).toBe(200);
    expect(JSON.parse(((await res.json()) as { text: string }).text)).toEqual({ type: "invite", token_hash: TOKEN });
    expect(reached).toEqual(["POST /verify"]);
  });

  it("never asks Auth about a token without the signature, by any address or method", async () => {
    for (const [path, init] of [
      ["/verify", { body: { type: "invite", token_hash: TOKEN } }],
      ["/verify", { body: { type: "magiclink", email: "owner@example.com", token: "123456" } }],
      ["/verify/", { body: { type: "invite", token_hash: TOKEN } }],
      ["/VERIFY", { body: { type: "invite", token_hash: TOKEN } }],
      ["/v%65rify", { body: { type: "invite", token_hash: TOKEN } }],
      [`/verify?token=${TOKEN}&type=invite&redirect_to=https://ops.example.com`, { method: "GET" }],
      // Not even as the server: nothing of its own redeems a link.
      ["/verify", { body: { type: "invite", token_hash: TOKEN }, token: key("service_role") }],
    ] as const) {
      const res = await auth(path, init);
      expect(res.status, path).toBe(403);
      expect(((await res.json()) as { error_code: string }).error_code).toBe("otp_expired");
    }
    expect(reached).toEqual([]);
  });

  it("leaves Auth's own emails to the server: a stranger can't have a token made, or a waiting link replaced", async () => {
    for (const path of ["/recover", "/otp", "/magiclink", "/resend", "/RECOVER", "/recover/", "/%6ftp"]) {
      for (const token of [undefined, key("anon"), key("authenticated"), key("service_role", "another-secret-of-at-least-32-characters-long")]) {
        const res = await auth(path, { body: { email: "owner@example.com" }, token });
        expect(res.status, path).toBe(403);
        expect(((await res.json()) as { msg: string }).msg).toBe(NO_AUTH_MAIL);
      }
    }
    expect(reached).toEqual([]);
    expect((await auth("/recover", { body: { email: "owner@example.com" }, token: key("service_role") })).status).toBe(200);
    expect(reached).toEqual(["POST /recover"]);
  });

  it("leaves the rest of Auth as it was", async () => {
    expect((await auth("/token?grant_type=refresh_token", { body: { refresh_token: "r" } })).status).toBe(200);
    expect((await auth("/user", { method: "GET", token: key("authenticated") })).status).toBe(200);
    expect((await auth("/logout", { body: {} })).status).toBe(200);
    expect(reached).toEqual(["POST /token?grant_type=refresh_token", "GET /user", "POST /logout"]);
  });
});

describe("what the Data API and Auth take", () => {
  const SECRET = "super-secret-jwt-token-with-at-least-32-characters-long";
  const part = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const key = (role: string) => {
    const unsigned = `${part({ alg: "HS256", typ: "JWT" })}.${part({ role, iss: "supabase", exp: Math.floor(Date.now() / 1000) + 3600 })}`;
    return `${unsigned}.${createHmac("sha256", SECRET).update(unsigned).digest("base64url")}`;
  };
  const guarded = () => gateway(env, { auth: base, rest: base, storage: base }, { jwtSecret: SECRET });
  const send = (path: string, init: { length?: number; body?: BodyInit; token?: string } = {}) =>
    guarded().request(
      path,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(init.length === undefined ? {} : { "Content-Length": String(init.length) }), ...(init.token ? { Authorization: `Bearer ${init.token}` } : {}) },
        body: init.body ?? "{}",
        duplex: "half",
      } as RequestInit,
      from,
    );
  beforeEach(() => {
    reached.length = 0;
  });

  it("turns away a body far bigger than the app ever sends, before the service sees it", async () => {
    const rest = await send("/rest/v1/clients", { length: MAX_REST_BODY + 1 });
    expect(rest.status).toBe(413);
    expect((await rest.json()).message).toBe("That's too much to send at once. Send it in smaller parts.");
    const auth = await send("/auth/v1/token?grant_type=refresh_token", { length: MAX_AUTH_BODY + 1 });
    expect(auth.status).toBe(413);
    expect((await auth.json()).error_code).toBe("request_too_large");
    expect(reached).toEqual([]);
  });

  it("counts one that doesn't say its size as it arrives", async () => {
    expect((await send("/rest/v1/clients", { body: stream(MAX_REST_BODY + 1) as unknown as BodyInit })).status).toBe(413);
    expect((await send("/auth/v1/oauth/clients/register", { body: stream(MAX_AUTH_BODY + 1) as unknown as BodyInit })).status).toBe(413);
    // Within the limit it goes through whole.
    const ok = await send("/rest/v1/clients", { body: stream(1024 * 1024) as unknown as BodyInit });
    expect(ok.status).toBe(200);
    expect((await ok.json()).bytes).toBe(1024 * 1024);
  });

  it("takes what the app does send, and anything from this server itself", async () => {
    const batch = JSON.stringify(Array.from({ length: 200 }, (_, i) => ({ display_name: `Client ${i}`, notes: "x".repeat(5000) })));
    expect((await send("/rest/v1/clients", { body: batch, length: Buffer.byteLength(batch) })).status).toBe(200);
    expect((await send("/rest/v1/rpc/import_jobber", { length: MAX_REST_BODY + 1, token: key("service_role") })).status).toBe(200);
    expect(reached).toEqual(["POST /clients", "POST /rpc/import_jobber"]);
  });

  it("lets each visitor sign only so many apps up with Auth's OAuth server an hour, by any spelling of its address", async () => {
    const register = (path = "/auth/v1/oauth/clients/register", token?: string) => send(path, { body: JSON.stringify({ client_name: "Claude", redirect_uris: ["https://claude.ai/api/mcp/auth_callback"] }), token });
    expect((await register()).status).toBe(200);
    expect(limits.keys).toEqual([expect.stringMatching(/^oauth-register:ip:/)]);
    limits.full.push("oauth-register:");
    for (const path of ["/auth/v1/oauth/clients/register", "/auth/v1/oauth/clients/register/", "/auth/v1/OAuth/Clients/Register", "/auth/v1//oauth/clients/%72egister"]) {
      const res = await register(path);
      expect(res.status, path).toBe(429);
      expect((await res.json()).msg).toBe("Too many apps signed up from here. Try again in an hour.");
    }
    // Nothing else of Auth's is counted, and the server itself isn't held to it.
    expect((await send("/auth/v1/token?grant_type=refresh_token", { body: JSON.stringify({ refresh_token: "r" }) })).status).toBe(200);
    expect((await register("/auth/v1/oauth/clients/register", key("service_role"))).status).toBe(200);
    expect(reached).toEqual(["POST /oauth/clients/register", "POST /token?grant_type=refresh_token", "POST /oauth/clients/register"]);
  });
});
