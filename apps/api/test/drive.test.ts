import { afterEach, describe, expect, it, vi } from "vitest";
import { app } from "../src/app";
import type { Env } from "../src/env";
import { forgetStorageUsage } from "../src/lib/storageLimits";
import { UPLOAD_LIMIT } from "../src/services/uploads";

// Crewtavo - Drive's API (routes/drive.ts): Install, importing from Google Drive, restoring a file
// from elsewhere into Drive, and Delete forever. The database's part (folders, the Trash, who sees
// and changes what) is in supabase/tests/drive_test.sql; the nightly purge is in planFiles.test.ts.
// Supabase is a stand-in that answers by table and function and remembers what was asked of it, by
// whom: the person (their own client, under row-level security) or the server (the admin client).

const current = vi.hoisted(() => ({ admin: null as unknown, user: null as unknown }));
vi.mock("../src/lib/supabase", async (original) => ({
  ...(await original<typeof import("../src/lib/supabase")>()),
  adminClient: () => current.admin,
  userClient: () => current.user,
}));

const GOOGLE_APP = "123456789012-abc123.apps.googleusercontent.com";
const env: Env = {
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
  SUPABASE_SECRET_KEY: "sb_secret_test",
  ENCRYPTION_KEY: btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => i * 7))),
  APP_URL: "https://crm.greenlawn.example",
  GOOGLE_CLIENT_ID: GOOGLE_APP,
  GOOGLE_CLIENT_SECRET: "google-secret",
  GOOGLE_PICKER_API_KEY: "picker-key",
};
const CO = "00000000-0000-4000-8000-000000000001";
const OTHER_CO = "00000000-0000-4000-8000-000000000002";
const USER = "00000000-0000-4000-8000-0000000000aa";
const SOMEONE = "00000000-0000-4000-8000-0000000000bb";
const ROOT = "00000000-0000-4000-8000-0000000000d0";
const FORMS = "00000000-0000-4000-8000-0000000000d1";
const JOB = "00000000-0000-4000-8000-0000000000e1";
const TOKEN = "ya29.a0-google-access-token";
const PLAN_PATH = new RegExp(`^${CO}/plans/[0-9a-f-]{36}\\.([a-z0-9]{1,8})$`);
const REFUSED = "You don't have permission to do that. Ask an admin if you need it.";

type Who = "admin" | "user";
interface Query { who: Who; table: string; calls: Array<[string, ...any[]]> }
type Answer = (q: Query) => unknown;
/** Storage refusing an upload, a removal or a copy: the error it answers with. */
type Refusals = { upload?: () => unknown; remove?: (paths: string[]) => unknown; copy?: () => unknown };

const opOf = (q: Query) => ["insert", "update", "delete", "upsert"].find((name) => q.calls.some(([n]) => n === name)) ?? "select";
const argOf = (q: Query, name: string) => q.calls.find(([n]) => n === name)?.[1];
const has = (q: Query, ...call: unknown[]) => q.calls.some((c) => JSON.stringify(c) === JSON.stringify(call));
/** The value a query filters a column on with eq(), or the list with in(). */
const eqOf = (q: Query, column: string) => q.calls.find((c) => c[0] === "eq" && c[1] === column)?.[2];
const inOf = (q: Query, column: string): string[] => q.calls.find((c) => c[0] === "in" && c[1] === column)?.[2] ?? [];

/**
 * A company's database and Storage. `role` is the person's level; `tables` and `rpc` answer by
 * name; `storage` can refuse. `log` keeps the order things happened in.
 */
function world(options: { role?: string; tables?: Record<string, Answer>; rpc?: Record<string, (args: any) => unknown>; storage?: Refusals } = {}) {
  const queries: Query[] = [];
  const rpcs: Array<{ who: Who; name: string; args: any }> = [];
  const uploads: Array<{ who: Who; path: string; bytes: number; contentType: string }> = [];
  const removed: string[][] = [];
  const copies: Array<[string, string]> = [];
  const log: string[] = [];
  const chain = (q: Query): unknown =>
    new Proxy(
      {},
      {
        get: (_, name) =>
          name === "then"
            ? (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
                Promise.resolve()
                  .then(() => {
                    log.push(`${q.who} ${opOf(q)} ${q.table}`);
                    if (q.table === "memberships") return { data: { role: options.role ?? "owner", role_id: null, subcontractor_id: null }, error: null };
                    const result = options.tables?.[q.table]?.(q);
                    return result && typeof result === "object" && "error" in result ? result : { data: result ?? null, error: null };
                  })
                  .then(resolve, reject)
            : (...args: unknown[]) => {
                q.calls.push([String(name), ...args]);
                return chain(q);
              },
      },
    );
  const client = (who: Who) => ({
    from: (table: string) => {
      const q: Query = { who, table, calls: [] };
      queries.push(q);
      return chain(q);
    },
    rpc: async (name: string, args: unknown) => {
      rpcs.push({ who, name, args });
      log.push(`${who} rpc ${name}`);
      const fn = options.rpc?.[name];
      const result = fn ? fn(args) : null;
      return result && typeof result === "object" && "error" in (result as object) ? result : { data: result, error: null };
    },
    storage: {
      from: () => ({
        upload: async (path: string, body: Uint8Array, opts: { contentType: string; upsert: boolean }) => {
          log.push(`storage upload ${path}`);
          const refused = options.storage?.upload?.();
          if (refused) return { data: null, error: refused };
          expect(opts.upsert).toBe(false);
          uploads.push({ who, path, bytes: body.byteLength, contentType: opts.contentType });
          return { data: { path }, error: null };
        },
        remove: async (paths: string[]) => {
          log.push(`storage remove ${paths.join(",")}`);
          removed.push(paths);
          const refused = options.storage?.remove?.(paths);
          return refused ? { data: null, error: refused } : { data: [], error: null };
        },
        copy: async (from: string, to: string) => {
          log.push(`storage copy ${from} ${to}`);
          copies.push([from, to]);
          const refused = options.storage?.copy?.();
          return refused ? { data: null, error: refused } : { data: { path: to }, error: null };
        },
      }),
    },
    auth: { getClaims: async () => ({ data: { claims: { sub: USER } }, error: null }) },
  });
  current.admin = client("admin");
  current.user = client("user");
  const find = (who: Who, table: string, op: string) => queries.filter((q) => q.who === who && q.table === table && opOf(q) === op);
  return { queries, rpcs, uploads, removed, copies, log, find };
}

const headers = { Authorization: "Bearer session", "X-Company-Id": CO, "Content-Type": "application/json" };
const post = (path: string, body: unknown, e: Env = env) => app.request(`/api${path}`, { method: "POST", headers, body: JSON.stringify(body) }, e);

afterEach(() => {
  vi.unstubAllGlobals();
  // The storage limits' numbers are kept for half a minute: each test has its own.
  forgetStorageUsage();
});

// ===== Google ===================================================================================

interface GoogleFile {
  meta?: Record<string, unknown>;
  /** What downloading (or converting) it answers: bytes, or a refusal. */
  bytes?: number;
  refuse?: { status: number; reason?: string };
  metaRefuse?: { status: number; reason?: string };
}

/** Google's sign-in check and Drive, for these files. Every request is kept, with the sign-in it carried. */
function google(files: Record<string, GoogleFile>, signIn: Record<string, unknown> | null = { aud: GOOGLE_APP, azp: GOOGLE_APP, scope: "https://www.googleapis.com/auth/drive.file", expires_in: "3599" }) {
  const requests: Array<{ url: URL; authorization: string | null }> = [];
  const refusal = (r: { status: number; reason?: string }) => Response.json({ error: { code: r.status, message: "no", errors: [{ reason: r.reason ?? "notFound" }] } }, { status: r.status });
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    requests.push({ url, authorization: new Headers(init?.headers).get("authorization") });
    if (url.host === "oauth2.googleapis.com" && url.pathname === "/tokeninfo") {
      return signIn ? Response.json(signIn) : Response.json({ error: "invalid_token", error_description: "Invalid Value" }, { status: 400 });
    }
    const match = url.host === "www.googleapis.com" && url.pathname.match(/^\/drive\/v3\/files\/([^/]+)(\/export)?$/);
    if (!match) throw new Error(`unexpected ${url}`);
    const file = files[decodeURIComponent(match[1]!)];
    if (!file) return refusal({ status: 404 });
    if (url.searchParams.has("fields")) return file.metaRefuse ? refusal(file.metaRefuse) : Response.json(file.meta);
    if (file.refuse) return refusal(file.refuse);
    // A download says its size; a conversion streams without one.
    const sent: Record<string, string> = { "content-type": "application/octet-stream" };
    if (!match[2]) sent["content-length"] = String(file.bytes ?? 0);
    return new Response(new Uint8Array(file.bytes ?? 0), { headers: sent });
  });
  return requests;
}

const pdf = (id: string, name: string, extra: Record<string, unknown> = {}) => ({ meta: { id, name, mimeType: "application/pdf", size: "2048", capabilities: { canDownload: true }, ...extra }, bytes: 2048 });

/** A company with a Forms folder and a job, where the person adds files (the inserted row comes back). */
function office(options: { role?: string; insert?: (row: any) => unknown; storage?: Refusals; rpc?: Record<string, (args: any) => unknown> } = {}) {
  return world({
    role: options.role,
    storage: options.storage,
    rpc: { drive_root: () => ROOT, ...options.rpc },
    tables: {
      drive_folders: (q) => ([FORMS, ROOT].includes(eqOf(q, "id")) ? { id: eqOf(q, "id") } : null),
      jobs: (q) => (eqOf(q, "id") === JOB ? { id: JOB } : null),
      plan_files: (q) => {
        if (opOf(q) !== "insert") return null;
        const row = argOf(q, "insert");
        return options.insert ? options.insert(row) : { id: `row-${row.file_name}`, ...row };
      },
    },
  });
}

// ===== Install ==================================================================================

describe("installing Drive", () => {
  it("is for owners and admins who connect apps", async () => {
    const db = world();
    const res = await post("/drive/enabled", { enabled: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ enabled: true });
    expect(db.rpcs).toEqual([{ who: "user", name: "drive_set_enabled", args: { p_company: CO, p_enabled: true } }]);

    const officeStaff = world({ role: "office" });
    const refused = await post("/drive/enabled", { enabled: false });
    expect(refused.status).toBe(403);
    expect((await refused.json()).error).toBe(REFUSED);
    expect(officeStaff.rpcs).toEqual([]);
  });
});

// ===== Import from Google Drive =================================================================

describe("importing from Google Drive", () => {
  it("isn't on until Google is set up", async () => {
    const db = office();
    const requests = google({});
    const res = await post("/drive/import", { accessToken: TOKEN, files: [{ id: "f1" }], target: { folder_id: FORMS } }, { ...env, GOOGLE_PICKER_API_KEY: undefined });
    expect(res.status).toBe(501);
    expect((await res.json()).error).toBe("Importing from Google Drive isn't turned on yet. Ask whoever set up Crewtavo to add it.");
    expect(requests).toEqual([]);
    expect(db.uploads).toEqual([]);
  });

  it("brings a file into a folder: stored by the server, recorded as the person, office only", async () => {
    const db = office();
    const requests = google({ "pdf-1": pdf("pdf-1", "Bid set rev 3.pdf") });
    const res = await post("/drive/import", { accessToken: TOKEN, files: [{ id: "pdf-1", name: "Bid set rev 3.pdf", mimeType: "application/pdf" }], target: { folder_id: FORMS } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.skipped).toEqual([]);

    expect(db.uploads).toHaveLength(1);
    const [upload] = db.uploads;
    expect(upload).toMatchObject({ who: "admin", bytes: 2048, contentType: "application/pdf" });
    expect(upload!.path).toMatch(PLAN_PATH);
    expect(upload!.path.endsWith(".pdf")).toBe(true);
    const [insert] = db.find("user", "plan_files", "insert");
    expect(argOf(insert!, "insert")).toEqual({
      company_id: CO, folder_id: FORMS, title: "Bid set rev 3", path: upload!.path, file_name: "Bid set rev 3.pdf", content_type: "application/pdf", size_bytes: 2048, crew_visible: false,
    });
    expect(body.files).toEqual([expect.objectContaining({ path: upload!.path, folder_id: FORMS })]);
    // The folder was looked up as the person: one they can't see isn't one to add to.
    expect(db.find("user", "drive_folders", "select")).toHaveLength(1);

    // The sign-in was checked, then used only with Google Drive, and never in an address but the check's.
    expect(requests.map((r) => `${r.url.host}${r.url.pathname}`)).toEqual(["oauth2.googleapis.com/tokeninfo", "www.googleapis.com/drive/v3/files/pdf-1", "www.googleapis.com/drive/v3/files/pdf-1"]);
    expect(requests.slice(1).every((r) => r.authorization === `Bearer ${TOKEN}` && !r.url.search.includes(TOKEN))).toBe(true);
    expect(requests[2]!.url.searchParams.get("alt")).toBe("media");
    expect(requests[1]!.url.searchParams.get("supportsAllDrives")).toBe("true");
    expect(JSON.stringify(body)).not.toContain(TOKEN);
  });

  it("converts Google's own documents, and puts them on a job for its crew", async () => {
    const db = office();
    const requests = google({
      doc: { meta: { id: "doc", name: "Scope of work", mimeType: "application/vnd.google-apps.document", capabilities: { canDownload: true } }, bytes: 900 },
      sheet: { meta: { id: "sheet", name: "Takeoff v1.2", mimeType: "application/vnd.google-apps.spreadsheet", capabilities: { canDownload: true } }, bytes: 500 },
    });
    const res = await post("/drive/import", { accessToken: TOKEN, files: [{ id: "doc" }, { id: "sheet" }], target: { job_id: JOB } });
    expect(res.status).toBe(200);
    const exports = requests.filter((r) => r.url.pathname.endsWith("/export")).map((r) => r.url.searchParams.get("mimeType"));
    expect(exports).toEqual(["application/vnd.openxmlformats-officedocument.wordprocessingml.document", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"]);
    const rows = db.find("user", "plan_files", "insert").map((q) => argOf(q, "insert"));
    expect(rows.map((r) => [r.file_name, r.title, r.job_id, r.crew_visible, r.folder_id])).toEqual([
      ["Scope of work.docx", "Scope of work", JOB, true, undefined],
      ["Takeoff v1.2.xlsx", "Takeoff v1.2", JOB, true, undefined],
    ]);
    expect(db.uploads.map((u) => u.path.split(".").pop())).toEqual(["docx", "xlsx"]);
    expect(db.find("user", "jobs", "select")).toHaveLength(1);
  });

  it("follows a shortcut to its file, and puts files with no folder named in Company files", async () => {
    const db = office();
    google({
      short: { meta: { id: "short", name: "Price sheet", mimeType: "application/vnd.google-apps.shortcut", shortcutDetails: { targetId: "real", targetMimeType: "image/jpeg" } } },
      real: { meta: { id: "real", name: "Price sheet.JPG", mimeType: "image/jpeg", size: "10", capabilities: { canDownload: true } }, bytes: 10 },
    });
    const res = await post("/drive/import", { accessToken: TOKEN, files: [{ id: "short", name: "Price sheet" }], target: { folder_id: null } });
    expect(res.status).toBe(200);
    expect(db.rpcs).toContainEqual({ who: "user", name: "drive_root", args: { p_company: CO } });
    expect(argOf(db.find("user", "plan_files", "insert")[0]!, "insert")).toMatchObject({ folder_id: ROOT, file_name: "Price sheet.JPG", content_type: "image/jpeg" });
    expect(db.uploads[0]!.path.endsWith(".jpg")).toBe(true);
  });

  it("skips what can't be brought in, and says why", async () => {
    const db = office();
    google({
      folder: { meta: { id: "folder", name: "Jobs 2026", mimeType: "application/vnd.google-apps.folder" } },
      form: { meta: { id: "form", name: "Survey", mimeType: "application/vnd.google-apps.form" } },
      locked: pdf("locked", "Contract.pdf", { capabilities: { canDownload: false } }),
      huge: pdf("huge", "Survey scan.pdf", { size: String(UPLOAD_LIMIT + 1) }),
      bigdoc: { meta: { id: "bigdoc", name: "Manual", mimeType: "application/vnd.google-apps.document" }, refuse: { status: 403, reason: "exportSizeLimitExceeded" } },
      empty: { ...pdf("empty", "Blank.pdf"), bytes: 0 },
    });
    const res = await post("/drive/import", {
      accessToken: TOKEN,
      files: ["folder", "form", "locked", "huge", "bigdoc", "empty", "gone"].map((id) => ({ id, name: `${id}.name` })),
      target: { folder_id: FORMS },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.files).toEqual([]);
    expect(body.skipped).toEqual([
      { name: "folder.name", reason: "Jobs 2026 is a folder. Open it and choose the files in it." },
      { name: "form.name", reason: "Survey is a kind of Google file that can't be downloaded." },
      { name: "locked.name", reason: "The owner of Contract.pdf doesn't allow downloading it." },
      { name: "huge.name", reason: "Survey scan.pdf is larger than 200 MB, the most Crewtavo takes." },
      { name: "bigdoc.name", reason: "Manual is too large for Google to convert (over 10 MB). Download it from Google Drive, then upload it here." },
      { name: "empty.name", reason: "Blank.pdf is empty." },
      { name: "gone.name", reason: "Google Drive didn't let Crewtavo open gone.name. Choose it again." },
    ]);
    expect(db.uploads).toEqual([]);
    expect(db.find("user", "plan_files", "insert")).toEqual([]);
  });

  it("refuses a Google sign-in made for another app, or one Google doesn't accept", async () => {
    for (const [signIn, status] of [[{ aud: "999-other.apps.googleusercontent.com", azp: "999-other.apps.googleusercontent.com" }, 403], [{ aud: GOOGLE_APP, azp: "999-other.apps.googleusercontent.com" }, 403], [{}, 403], [null, 400]] as const) {
      const db = office();
      const requests = google({ "pdf-1": pdf("pdf-1", "Bid set.pdf") }, signIn as Record<string, unknown> | null);
      const res = await post("/drive/import", { accessToken: TOKEN, files: [{ id: "pdf-1" }], target: { folder_id: FORMS } });
      expect(res.status).toBe(status);
      expect(requests.map((r) => r.url.host)).toEqual(["oauth2.googleapis.com"]);
      expect(db.uploads).toEqual([]);
    }
  });

  it("removes the stored file when the row isn't added", async () => {
    const db = office({ insert: () => ({ error: { code: "22023", message: "That folder is in the Trash. Restore it first." } }) });
    google({ "pdf-1": pdf("pdf-1", "Bid set.pdf") });
    const res = await post("/drive/import", { accessToken: TOKEN, files: [{ id: "pdf-1", name: "Bid set.pdf" }], target: { folder_id: FORMS } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ files: [], skipped: [{ name: "Bid set.pdf", reason: "Bid set.pdf wasn't added: That folder is in the Trash. Restore it first." }] });
    expect(db.removed).toEqual([[db.uploads[0]!.path]]);
    expect(db.log.indexOf(`storage remove ${db.uploads[0]!.path}`)).toBeGreaterThan(db.log.indexOf("user insert plan_files"));
  });

  it("says when storage is too small for a file", async () => {
    const db = office({ storage: { upload: () => ({ message: "The object exceeded the maximum allowed size", statusCode: "413" }) } });
    google({ "pdf-1": pdf("pdf-1", "Bid set.pdf") });
    const body = await (await post("/drive/import", { accessToken: TOKEN, files: [{ id: "pdf-1" }], target: { folder_id: FORMS } })).json();
    expect(body.skipped).toEqual([{ name: "That file", reason: "Bid set.pdf is larger than this Crewtavo's storage takes." }]);
    expect(db.find("user", "plan_files", "insert")).toEqual([]);
  });

  it("refuses a file when the company's storage is full, before downloading it, and says so", async () => {
    const db = office({ rpc: { storage_snapshot: () => [{ company_used: 45e9, company_limit: 45e9, user_used: 0, user_limit: null, user_is_owner: false }] } });
    const requests = google({ "pdf-1": pdf("pdf-1", "Bid set.pdf") });
    const body = await (await post("/drive/import", { accessToken: TOKEN, files: [{ id: "pdf-1", name: "Bid set.pdf" }], target: { folder_id: FORMS } })).json();
    expect(body).toEqual({
      files: [],
      skipped: [{ name: "Bid set.pdf", reason: "This 2 KB file doesn't fit: 45 GB of the 45 GB storage limit is used. An owner or admin can raise it in Settings → Storage, or empty the Trash.", full: true }],
    });
    // Asked about, by the server, for the person importing, and never downloaded or stored.
    expect(db.rpcs).toContainEqual({ who: "admin", name: "storage_snapshot", args: { p_company: CO, p_user: USER } });
    expect(requests.some((r) => r.url.searchParams.get("alt") === "media")).toBe(false);
    expect(db.uploads).toEqual([]);
    expect(db.find("user", "plan_files", "insert")).toEqual([]);
  });

  it("holds the person importing to their own limit, by what Google sends", async () => {
    // Room by Google's word (a converted document doesn't say its size), but not for what came.
    const db = office({ rpc: { storage_snapshot: () => [{ company_used: 1e9, company_limit: null, user_used: 9_999_000, user_limit: 10_000_000, user_is_owner: false }] } });
    google({ "doc-1": { meta: { id: "doc-1", name: "Scope", mimeType: "application/vnd.google-apps.document" }, bytes: 2048 } });
    const body = await (await post("/drive/import", { accessToken: TOKEN, files: [{ id: "doc-1", name: "Scope" }], target: { job_id: JOB } })).json();
    expect(body.skipped).toEqual([{ name: "Scope", reason: "This 2 KB file doesn't fit in your storage: you've used 10 MB of your 10 MB. Ask an owner to raise it, or move old files to the Trash.", full: true }]);
    expect(db.uploads).toEqual([]);
  });

  it("counts each file it brings in toward the next", async () => {
    // The database has what's been stored.
    const db = office({ rpc: { storage_snapshot: () => [{ company_used: db.uploads.reduce((sum, u) => sum + u.bytes, 0), company_limit: 3000, user_used: 0, user_limit: null, user_is_owner: false }] } });
    google({ "pdf-1": pdf("pdf-1", "One.pdf"), "pdf-2": pdf("pdf-2", "Two.pdf") });
    const body = await (await post("/drive/import", { accessToken: TOKEN, files: [{ id: "pdf-1", name: "One.pdf" }, { id: "pdf-2", name: "Two.pdf" }], target: { folder_id: FORMS } })).json();
    expect(body.files).toHaveLength(1);
    expect(body.skipped).toEqual([expect.objectContaining({ name: "Two.pdf", full: true })]);
    expect(db.uploads).toHaveLength(1);
    // Read once for both, and again before turning the second away (it's still too big).
    expect(db.rpcs.filter((r) => r.name === "storage_snapshot")).toHaveLength(2);
  });

  it("takes a file Storage didn't keep off the count again", async () => {
    let refuse = true;
    const db = office({
      rpc: { storage_snapshot: () => [{ company_used: 0, company_limit: 3000, user_used: 0, user_limit: null, user_is_owner: false }] },
      storage: { upload: () => (refuse ? ((refuse = false), { message: "Internal error", statusCode: "500" }) : null) },
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      google({ "pdf-1": pdf("pdf-1", "One.pdf"), "pdf-2": pdf("pdf-2", "Two.pdf") });
      const body = await (await post("/drive/import", { accessToken: TOKEN, files: [{ id: "pdf-1", name: "One.pdf" }, { id: "pdf-2", name: "Two.pdf" }], target: { folder_id: FORMS } })).json();
      expect(body.skipped).toEqual([{ name: "One.pdf", reason: "Crewtavo couldn't store One.pdf. Try again in a minute." }]);
      expect(body.files).toHaveLength(1);
      expect(db.uploads).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });

  it("needs one place the person can see, up to 20 files, and an office role", async () => {
    google({});
    office();
    const reasons = async (body: unknown) => {
      const res = await post("/drive/import", body);
      return [res.status, (await res.json()).error];
    };
    const files = [{ id: "pdf-1" }];
    const either = "Choose one place for the files: a folder, or a client's property, request, quote or job.";
    expect(await reasons({ accessToken: TOKEN, files, target: {} })).toEqual([400, either]);
    expect(await reasons({ accessToken: TOKEN, files, target: { folder_id: FORMS, job_id: JOB } })).toEqual([400, either]);
    expect(await reasons({ accessToken: TOKEN, files, target: { job_id: "00000000-0000-4000-8000-0000000000e9" } })).toEqual([404, "We couldn't find that job. It may have been deleted."]);
    expect(await reasons({ accessToken: TOKEN, files, target: { folder_id: "00000000-0000-4000-8000-0000000000d9" } })).toEqual([404, "That folder isn't here anymore. It may have been moved to the Trash."]);
    expect(await reasons({ accessToken: TOKEN, files: [], target: { folder_id: FORMS } })).toEqual([400, "Choose at least one file in Google Drive."]);
    expect(await reasons({ accessToken: TOKEN, files: Array.from({ length: 21 }, (_, i) => ({ id: `f${i}` })), target: { folder_id: FORMS } })).toEqual([400, "Choose up to 20 files at a time."]);
    expect(await reasons({ files, target: { folder_id: FORMS } })).toEqual([400, "Sign in to Google again, then choose the files."]);

    const crew = office({ role: "crew_lead" });
    expect(await reasons({ accessToken: TOKEN, files, target: { job_id: JOB } })).toEqual([403, REFUSED]);
    expect(crew.uploads).toEqual([]);
  });
});

// ===== Restoring a file from elsewhere into Drive ===============================================

const TRASHED = "00000000-0000-4000-8000-0000000000c1";
const RESTORED_FOLDER = "00000000-0000-4000-8000-0000000000d7";
const VISIT_PHOTO = `${CO}/visit/00000000-0000-4000-8000-0000000000f1/7b0c.jpg`;

function trashWorld(options: { trashed?: Record<string, unknown> | null; role?: string; restoredFolder?: string | null; insert?: () => unknown; storage?: Refusals; original?: () => unknown } = {}) {
  const trashed = options.trashed === undefined
    ? { id: TRASHED, company_id: CO, path: VISIT_PHOTO, file_name: "IMG_2041.jpg", content_type: "image/jpeg", size_bytes: 1234, source: "visit_photo", label: "Visit photo · Job #12", deleted_by: SOMEONE }
    : options.trashed;
  return world({
    role: options.role,
    storage: options.storage,
    // Out of the Trash, the database hands over the original's path unless something still uses it.
    rpc: { drive_root: () => ROOT, trash_copied_to_drive: () => (options.original ? options.original() : trashed?.path) },
    tables: {
      trashed_files: (q) => (opOf(q) === "select" ? trashed : null),
      drive_folders: (q) => (opOf(q) === "insert" ? { id: RESTORED_FOLDER } : options.restoredFolder ? { id: options.restoredFolder } : null),
      plan_files: (q) => (opOf(q) === "insert" ? (options.insert?.() ?? { id: "new-file", ...argOf(q, "insert") }) : null),
    },
  });
}

const DOWNLOAD_INSTEAD = "This file can't go back where it was, because that was deleted. Download it from the Trash instead.";

describe("restoring a file from elsewhere into Drive", () => {
  it("copies it into Company files › Restored files, office only, then takes it out of the Trash", async () => {
    const db = trashWorld();
    const res = await post(`/drive/trash/${TRASHED}/to-drive`, {});
    expect(res.status).toBe(201);
    const [[from, to]] = db.copies as [[string, string]];
    expect(from).toBe(VISIT_PHOTO);
    expect(to).toMatch(PLAN_PATH);
    expect(to.endsWith(".jpg")).toBe(true);

    // The folder, made under Company files the first time, as the person.
    expect(argOf(db.find("user", "drive_folders", "insert")[0]!, "insert")).toEqual({ company_id: CO, parent_id: ROOT, name: "Restored files" });
    expect(argOf(db.find("user", "plan_files", "insert")[0]!, "insert")).toEqual({
      company_id: CO, folder_id: RESTORED_FOLDER, title: "IMG 2041", notes: "Restored from the Trash. It was: Visit photo · Job #12",
      path: to, file_name: "IMG_2041.jpg", content_type: "image/jpeg", size_bytes: 1234, crew_visible: false,
    });
    expect((await res.json()).file).toMatchObject({ id: "new-file", path: to });
    // The Trash row was read for this company only.
    const read = db.find("admin", "trashed_files", "select")[0]!;
    expect(has(read, "eq", "company_id", CO) && has(read, "eq", "id", TRASHED)).toBe(true);
    // Copied and recorded; only then out of the Trash (the database's call), and only then the
    // original removed, as the database said.
    expect(db.rpcs.find((r) => r.name === "trash_copied_to_drive")).toEqual({ who: "admin", name: "trash_copied_to_drive", args: { p_company: CO, p_id: TRASHED } });
    expect(db.log.filter((l) => /storage|plan_files|trashed_files|trash_copied_to_drive/.test(l))).toEqual([
      "admin select trashed_files", `storage copy ${VISIT_PHOTO} ${to}`, "user insert plan_files", "admin rpc trash_copied_to_drive", `storage remove ${VISIT_PHOTO}`,
    ]);
    // Nothing here deletes a row of the Trash itself.
    expect(db.find("admin", "trashed_files", "delete")).toEqual([]);
  });

  it("uses the Restored files folder that's there, and names a file that came without a name", async () => {
    const db = trashWorld({ restoredFolder: RESTORED_FOLDER, trashed: { id: TRASHED, company_id: CO, path: `${CO}/kb/aa11.webp`, file_name: null, content_type: "image/webp", size_bytes: 10, source: "kb_cover", label: null, deleted_by: USER } });
    expect((await post(`/drive/trash/${TRASHED}/to-drive`, {})).status).toBe(201);
    expect(db.find("user", "drive_folders", "insert")).toEqual([]);
    expect(argOf(db.find("user", "plan_files", "insert")[0]!, "insert")).toMatchObject({ folder_id: RESTORED_FOLDER, file_name: "Guide cover.webp", title: "Guide cover", notes: "Restored from the Trash." });
  });

  it("only restores what the person sees in the Trash", async () => {
    const receipt = { id: TRASHED, company_id: CO, path: `${CO}/receipts/r1.jpg`, file_name: "receipt.jpg", content_type: "image/jpeg", size_bytes: 10, source: "receipt", label: null, deleted_by: SOMEONE };
    const cases: Array<[string, Record<string, unknown> | null]> = [
      // An estimator doesn't see job costs, and didn't delete this receipt.
      ["estimator", receipt],
      // Paperwork is for the office with the subs area; old map pictures and chat files are never listed.
      ["estimator", { ...receipt, source: "sub_document", path: `${CO}/subs/s1/w9.pdf` }],
      ["owner", { ...receipt, source: "chat_file", path: `${CO}/chat/c1/a.jpg` }],
      // A row naming another company's file.
      ["owner", { ...receipt, source: "visit_photo", path: `${OTHER_CO}/visit/v1/a.jpg` }],
      ["owner", null],
    ];
    for (const [role, trashed] of cases) {
      const db = trashWorld({ role, trashed });
      const res = await post(`/drive/trash/${TRASHED}/to-drive`, {});
      expect(res.status, `${role} ${trashed?.source}`).toBe(404);
      expect((await res.json()).error).toBe("That isn't in the Trash anymore.");
      expect(db.copies).toEqual([]);
    }
    // A crew lead can't use Drive at all.
    const crew = trashWorld({ role: "crew_lead" });
    expect((await post(`/drive/trash/${TRASHED}/to-drive`, {})).status).toBe(403);
    expect(crew.copies).toEqual([]);
  });

  it("never copies paperwork, résumés or receipts into Drive, where the whole office could open them", async () => {
    const restricted: Array<[string, Record<string, unknown>]> = [
      // Even an estimator who took the receipt out, and the owner with every area.
      ["estimator", { source: "receipt", path: `${CO}/receipts/r1.jpg`, deleted_by: USER }],
      ["owner", { source: "receipt", path: `${CO}/receipts/r1.jpg` }],
      ["owner", { source: "sub_document", path: `${CO}/subs/s1/w9.pdf` }],
      ["office", { source: "applicant_file", path: `${CO}/applicants/a1/1.pdf` }],
    ];
    for (const [role, kind] of restricted) {
      const db = trashWorld({ role, trashed: { id: TRASHED, company_id: CO, file_name: "x.pdf", content_type: "application/pdf", size_bytes: 10, label: null, deleted_by: SOMEONE, ...kind } });
      const res = await post(`/drive/trash/${TRASHED}/to-drive`, {});
      expect(res.status, `${role} ${kind.source}`).toBe(409);
      expect((await res.json()).error).toBe(DOWNLOAD_INSTEAD);
      expect(db.copies).toEqual([]);
      expect(db.find("user", "plan_files", "insert")).toEqual([]);
      expect(db.rpcs.filter((r) => r.name === "trash_copied_to_drive")).toEqual([]);
    }
  });

  it("keeps everything in the Trash when the copy can't be recorded, and never removes an original something uses", async () => {
    const failed = trashWorld({ insert: () => ({ error: { code: "42501", message: "permission denied" } }) });
    expect((await post(`/drive/trash/${TRASHED}/to-drive`, {})).status).toBe(403);
    expect(failed.removed).toEqual([[failed.copies[0]![1]]]);
    expect(failed.rpcs.filter((r) => r.name === "trash_copied_to_drive")).toEqual([]);

    // Something still uses the original: the database hands over nothing, and it stays.
    const inUse = trashWorld({ original: () => null });
    expect((await post(`/drive/trash/${TRASHED}/to-drive`, {})).status).toBe(201);
    expect(inUse.removed).toEqual([]);

    // A path that isn't this company's is never removed, whatever comes back.
    const theirs = trashWorld({ original: () => `${OTHER_CO}/visit/v1/a.jpg` });
    expect((await post(`/drive/trash/${TRASHED}/to-drive`, {})).status).toBe(201);
    expect(theirs.removed).toEqual([]);

    // Storage won't remove the original: the copy is in Drive and the original is left behind.
    const stuck = trashWorld({ storage: { remove: () => ({ message: "disk is busy" }) } });
    expect((await post(`/drive/trash/${TRASHED}/to-drive`, {})).status).toBe(201);
    expect(stuck.removed).toEqual([[VISIT_PHOTO]]);

    const gone = trashWorld({ storage: { copy: () => ({ message: "Object not found", statusCode: "404" }) } });
    const res = await post(`/drive/trash/${TRASHED}/to-drive`, {});
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("That file is gone from storage, so it can't be restored.");
    expect(gone.find("user", "plan_files", "insert")).toEqual([]);
  });
});

// ===== Delete forever ===========================================================================

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const plans = (n: number) => `${CO}/plans/${id(n)}.pdf`;
type Gone = { kind: string; id: string; paths: string[] };
// What the database deleted, a row for each thing with its files: a file with three versions, a
// folder with two files, a receipt, and a file from elsewhere still in use (no file handed over).
const GONE: Gone[] = [
  { kind: "file", id: id(3), paths: [plans(1), plans(2), plans(3)] },
  { kind: "folder", id: id(20), paths: [plans(30), plans(31)] },
  { kind: "other", id: id(40), paths: [`${CO}/receipts/r.jpg`] },
  { kind: "other", id: id(41), paths: [] },
];

function trashBin(options: { role?: string; gone?: Gone[] | { error: unknown }; storage?: Refusals } = {}) {
  return world({ role: options.role, storage: options.storage, rpc: { trash_delete_forever: () => options.gone ?? GONE } });
}

describe("delete forever", () => {
  it("is for owners only", async () => {
    for (const role of ["admin", "office", "estimator"]) {
      const db = trashBin({ role });
      const res = await post("/drive/trash/delete-forever", { items: [{ kind: "file", id: id(3) }] });
      expect(res.status).toBe(403);
      expect((await res.json()).error).toBe(REFUSED);
      expect(db.rpcs).toEqual([]);
      expect(db.removed).toEqual([]);
    }
  });

  it("has the database delete what's in the Trash, as the owner, then removes only the files it hands over", async () => {
    const db = trashBin();
    const items = [{ kind: "file", id: id(3) }, { kind: "folder", id: id(20) }, { kind: "other", id: id(40) }, { kind: "other", id: id(41) }, { kind: "file", id: id(3) }];
    const res = await post("/drive/trash/delete-forever", { items });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ removed: 4 });
    // Asked once, as the person (the database checks they're an owner too), each thing once.
    expect(db.rpcs).toEqual([{ who: "user", name: "trash_delete_forever", args: { p_company: CO, p_items: items.slice(0, 4) } }]);
    expect(db.removed.flat().sort()).toEqual([plans(1), plans(2), plans(3), plans(30), plans(31), `${CO}/receipts/r.jpg`].sort());
    // The rows are the database's to delete, and it did so first.
    expect(db.queries.filter((q) => opOf(q) === "delete")).toEqual([]);
    expect(db.log.indexOf("user rpc trash_delete_forever")).toBeLessThan(db.log.findIndex((l) => l.startsWith("storage remove")));
  });

  it("never removes another company's file, and a file Storage won't remove is left behind", async () => {
    const theirs = trashBin({ gone: [{ kind: "other", id: id(41), paths: [`${OTHER_CO}/receipts/r.jpg`] }] });
    expect(await (await post("/drive/trash/delete-forever", { items: [{ kind: "other", id: id(41) }] })).json()).toEqual({ removed: 1 });
    expect(theirs.removed.flat()).toEqual([]);

    const stuck = trashBin({ storage: { remove: () => ({ message: "disk is busy" }) } });
    expect(await (await post("/drive/trash/delete-forever", { items: [{ kind: "file", id: id(3) }] })).json()).toEqual({ removed: 4 });
    expect(stuck.removed.flat()).toHaveLength(6);
  });

  it("removes every file of a folder of thousands, and counts it as one thing", async () => {
    const many = Array.from({ length: 1500 }, (_, i) => plans(10_000 + i));
    const db = trashBin({ gone: [{ kind: "folder", id: id(21), paths: many }] });
    expect(await (await post("/drive/trash/delete-forever", { items: [{ kind: "folder", id: id(21) }] })).json()).toEqual({ removed: 1 });
    expect(db.removed.flat()).toEqual(many);
  });

  it("removes nothing when nothing asked for is in the Trash", async () => {
    const db = trashBin({ gone: [] });
    const res = await post("/drive/trash/delete-forever", { items: [{ kind: "file", id: id(77) }, { kind: "other", id: id(78) }] });
    expect(await res.json()).toEqual({ removed: 0 });
    expect(db.removed).toEqual([]);
  });

  it("says why when the database won't delete a folder", async () => {
    const message = "A folder in the Trash still has a folder in use inside it. Restore it and move that folder out first.";
    const db = trashBin({ gone: { error: { code: "22023", message } } });
    const res = await post("/drive/trash/delete-forever", { items: [{ kind: "folder", id: id(20) }] });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe(message);
    expect(db.removed).toEqual([]);
  });

  it("takes 1 to 200 things at a time", async () => {
    trashBin();
    expect((await (await post("/drive/trash/delete-forever", { items: [] })).json()).error).toBe("Choose what to delete.");
    const many = Array.from({ length: 201 }, (_, i) => ({ kind: "other", id: id(1000 + i) }));
    expect((await (await post("/drive/trash/delete-forever", { items: many })).json()).error).toBe("Delete up to 200 at a time.");
  });
});
