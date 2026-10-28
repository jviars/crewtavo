import { afterEach, describe, expect, it, vi } from "vitest";
import { app } from "../src/app";
import type { Env } from "../src/env";

// Careers: the business's own "Apply now" form posts to /f/<key>, résumé and all, and each
// application lands in Applicants. The database's part (the applicant, the notices, who sees them)
// is in supabase/tests/careers_test.sql; reading the fields is in packages/core/test/careers.test.ts.

const current = vi.hoisted(() => ({ db: null as unknown, background: [] as Array<Promise<unknown>>, emails: [] as Array<Record<string, unknown>> }));
vi.mock("../src/lib/supabase", async (original) => ({
  ...(await original<typeof import("../src/lib/supabase")>()),
  adminClient: () => current.db,
  userClient: () => current.db,
}));
vi.mock("../src/lib/background", () => ({
  runInBackground: (_c: unknown, work: Promise<unknown>) => void current.background.push(work),
  kickAutomations: () => undefined,
}));
vi.mock("../src/lib/notify", async (original) => ({
  ...(await original<typeof import("../src/lib/notify")>()),
  emailReady: async () => true,
  sendEmail: async (_env: unknown, message: Record<string, unknown>) => {
    current.emails.push(message);
    return { sent: true, id: "e1" };
  },
}));

const env: Env = {
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
  SUPABASE_SECRET_KEY: "sb_secret_test",
  ENCRYPTION_KEY: btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => i * 7))),
  APP_URL: "https://crm.greenlawn.example",
};
const COMPANY = "00000000-0000-4000-8000-000000000001";
const FORM_ID = "00000000-0000-4000-8000-0000000000f2";
const USER = "00000000-0000-4000-8000-0000000000aa";
const KEY = "7c1e0a9b42";
const THANKS = `https://crm.greenlawn.example/f/${KEY}/thanks`;

interface Query { table: string; calls: Array<[string, ...any[]]> }

const careersForm = (changes: Record<string, unknown> = {}) => ({
  id: FORM_ID, key: KEY, kind: "careers", name: "Job application", email_to: ["office@greenlawn.example"], redirect_url: null, allowed_sites: [],
  company: { id: COMPANY, name: "Green Lawn", settings: { careers: { enabled: true } } },
  ...changes,
});

/** A database with Storage that answers by table and function, and remembers what was asked of it. */
function fakeDb(answers: { tables?: Record<string, (q: Query) => unknown>; rpc?: Record<string, (args: any) => unknown>; uploadFails?: boolean } = {}) {
  const queries: Query[] = [];
  const rpcs: Array<{ name: string; args: any }> = [];
  const uploads: Array<{ path: string; bytes: number; contentType: string }> = [];
  const removed: string[] = [];
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
    storage: {
      from: () => ({
        upload: async (path: string, body: Uint8Array, options: { contentType: string }) => {
          if (answers.uploadFails && uploads.length) return { data: null, error: { message: "storage is full" } };
          uploads.push({ path, bytes: body.byteLength, contentType: options.contentType });
          return { data: { path }, error: null };
        },
        remove: async (paths: string[]) => {
          removed.push(...paths);
          return { data: [], error: null };
        },
      }),
    },
    auth: { getClaims: async () => ({ data: { claims: { sub: USER } }, error: null }) },
  };
  return { queries, rpcs, uploads, removed };
}

function withCareersForm(changes: Record<string, unknown> = {}, rpc: Record<string, (args: any) => unknown> = {}) {
  return fakeDb({ tables: { website_forms: () => careersForm(changes) }, rpc: { job_application: (args) => ({ applicant_id: args.p_id }), ...rpc } });
}

const resume = (name = "Jane Smith Resume.pdf", bytes = 2048, type = "application/pdf") => new File([new Uint8Array(bytes)], name, { type });

const apply = (fields: Record<string, string | File | File[]>, headers: Record<string, string> = {}) => {
  const body = new FormData();
  for (const [name, value] of Object.entries(fields)) for (const v of [value].flat()) body.append(name, v);
  return app.request(`/f/${KEY}`, { method: "POST", headers: { Origin: "https://www.greenlawn.example", ...headers }, body }, env);
};

afterEach(() => {
  current.background.length = 0;
  current.emails.length = 0;
});

describe("an application from the website's careers form", () => {
  it("stores the résumé, makes the applicant, emails the office and goes to the thank-you page", async () => {
    const db = withCareersForm();
    const res = await apply({
      name: "Jane Smith", email: "Jane@Example.com", phone: "540 555 0101", position: "Crew member", start_date: "ASAP",
      drivers_license: "Yes", shirt_size: "L", resume: resume(), message: "I love being outside.",
    });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(THANKS);

    const made = db.rpcs.find((r) => r.name === "job_application")!;
    const id = made.args.p_id as string;
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(db.uploads).toEqual([{ path: `${COMPANY}/applicants/${id}/1.pdf`, bytes: 2048, contentType: "application/pdf" }]);
    expect(made.args).toMatchObject({
      p_form: FORM_ID, p_name: "Jane Smith", p_email: "jane@example.com", p_phone: "540 555 0101",
      p_details: { position: "Crew member", start_date: "ASAP", drivers_license: "Yes", message: "I love being outside." },
      p_answers: { shirt_size: "L" },
      p_files: [{ path: `${COMPANY}/applicants/${id}/1.pdf`, name: "Jane Smith Resume.pdf", type: "application/pdf", size: 2048, field: "resume" }],
    });
    expect(db.rpcs.some((r) => r.name === "website_form_request")).toBe(false);

    await Promise.all(current.background);
    expect(current.emails).toHaveLength(1);
    expect(current.emails[0]).toMatchObject({ to: "office@greenlawn.example", subject: "New application from Jane Smith for Crew member", replyTo: "jane@example.com", fromName: "Green Lawn" });
    expect(current.emails[0]!.text).toContain("Résumé: Jane Smith Resume.pdf (2 KB)");
    expect(current.emails[0]!.text).toContain(`https://crm.greenlawn.example/applicants/${id}`);
    expect(current.emails[0]!.html).toContain("Open the application");
  });

  it("takes an application without files, and answers fetch() with JSON", async () => {
    const db = withCareersForm();
    const res = await app.request(`/f/${KEY}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ name: "Sam", phone: "540 555 0199", position: "Driver" }),
    }, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, next: THANKS });
    expect(db.uploads).toEqual([]);
    expect(db.rpcs.find((r) => r.name === "job_application")!.args.p_files).toEqual([]);
  });

  it("skips a file field left empty", async () => {
    const db = withCareersForm();
    expect((await apply({ email: "a@x.test", resume: new File([], "", { type: "application/octet-stream" }) })).status).toBe(303);
    expect(db.uploads).toEqual([]);
  });

  it("refuses a file that isn't a document, one that's too large, or too many, keeping nothing", async () => {
    const db = withCareersForm();
    const exe = await apply({ email: "a@x.test", resume: resume("setup.exe", 10, "application/x-msdownload") });
    expect(exe.status).toBe(415);
    const page = await exe.text();
    expect(page).toContain("Your application wasn't sent");
    expect(page).toContain("setup.exe can't be sent");
    const big = await apply({ email: "a@x.test", resume: resume("huge.pdf", 10 * 1024 * 1024 + 1) }, { Accept: "application/json" });
    expect(big.status).toBe(413);
    expect((await big.json()).error).toBe("huge.pdf is too large. Each file can be up to 10 MB.");
    const many = await apply({ email: "a@x.test", files: [resume("a.pdf"), resume("b.pdf"), resume("c.pdf"), resume("d.pdf")] });
    expect(many.status).toBe(413);
    expect(db.uploads).toEqual([]);
    expect(db.rpcs.some((r) => r.name === "job_application")).toBe(false);
  });

  it("removes stored files when the rest can't be stored or the applicant isn't kept", async () => {
    const half = fakeDb({ tables: { website_forms: () => careersForm() }, uploadFails: true });
    expect((await apply({ email: "a@x.test", resume: resume("cv.pdf"), cover_letter: resume("letter.docx", 100, "") })).status).toBe(500);
    expect(half.removed).toEqual([half.uploads[0]!.path]);
    expect(half.rpcs.some((r) => r.name === "job_application")).toBe(false);

    const refused = withCareersForm({}, { job_application: () => ({ error: { message: "An email or phone number is needed", code: "22023" } }) });
    expect((await apply({ email: "a@x.test", resume: resume() })).status).toBeGreaterThanOrEqual(400);
    expect(refused.removed).toEqual([refused.uploads[0]!.path]);
  });

  it("tells a bot it worked, and keeps nothing", async () => {
    const db = withCareersForm();
    expect((await apply({ email: "bot@spam.example", _gotcha: "x", resume: resume() })).status).toBe(303);
    expect(db.uploads).toEqual([]);
    expect(db.rpcs.some((r) => r.name === "job_application")).toBe(false);
  });

  it("isn't taken while Careers is uninstalled, even with Website Forms installed", async () => {
    withCareersForm({ company: { id: COMPANY, name: "Green Lawn", settings: { website_forms: { enabled: true }, careers: { enabled: false } } } });
    expect((await apply({ email: "a@x.test" })).status).toBe(404);
  });

  it("says too large on a page, not a server error, when the whole post is over the limit", async () => {
    withCareersForm();
    const res = await app.request(`/f/${KEY}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": String(40 * 1024 * 1024) },
      body: "x".repeat(33 * 1024 * 1024),
    }, env);
    expect(res.status).toBe(413);
    expect(await res.text()).toContain("Attach smaller files");
  });

  it("has a careers thank-you page and says what the address is for", async () => {
    withCareersForm();
    const thanks = await (await app.request(`/f/${KEY}/thanks`, {}, env)).text();
    expect(thanks).toContain("Thanks! Your application was sent.");
    expect(thanks).toContain("Green Lawn will be in touch.");
    expect(await (await app.request(`/f/${KEY}`, {}, env)).text()).toContain("takes job applications from a form on Green Lawn&#39;s website".replace("&#39;", "'"));
  });
});

describe("Careers' app page", () => {
  const headers = { Authorization: "Bearer token", "X-Company-Id": COMPANY, "Content-Type": "application/json" };

  it("lists careers forms, with their latest applicant", async () => {
    const db = fakeDb({
      tables: {
        companies: () => ({ settings: { careers: { enabled: true } } }),
        website_forms: () => [{ id: FORM_ID, key: KEY, name: "Job application", email_to: [], redirect_url: null, allowed_sites: [], created_at: "2026-10-28T00:00:00Z" }],
        job_applicants: () => ({ created_at: "2026-10-28T12:00:00Z" }),
      },
    });
    const res = await app.request("/api/website-forms?kind=careers", { headers }, env);
    expect(await res.json()).toEqual({
      enabled: true,
      email_ready: true,
      forms: [expect.objectContaining({ url: `https://crm.greenlawn.example/f/${KEY}`, last_message_at: "2026-10-28T12:00:00Z" })],
    });
    expect(db.queries.find((q) => q.table === "website_forms")!.calls).toContainEqual(["eq", "kind", "careers"]);
  });

  it("installs Careers, and adds careers forms", async () => {
    const db = fakeDb({ tables: { website_forms: () => ({ id: FORM_ID, key: KEY, name: "Seasonal crew" }) } });
    await app.request("/api/website-forms/enabled", { method: "POST", headers, body: JSON.stringify({ enabled: true, kind: "careers" }) }, env);
    expect(db.rpcs).toContainEqual({ name: "careers_set_enabled", args: { p_company: COMPANY, p_enabled: true } });
    await app.request("/api/website-forms/enabled", { method: "POST", headers, body: JSON.stringify({ enabled: true }) }, env);
    expect(db.rpcs).toContainEqual({ name: "website_forms_set_enabled", args: { p_company: COMPANY, p_enabled: true } });

    await app.request("/api/website-forms", { method: "POST", headers, body: JSON.stringify({ name: "Seasonal crew", kind: "careers" }) }, env);
    const insert = db.queries.filter((q) => q.table === "website_forms").flatMap((q) => q.calls).find(([name]) => name === "insert")![1];
    expect(insert).toMatchObject({ name: "Seasonal crew", kind: "careers" });
  });
});
