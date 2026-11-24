/**
 * Sharing a guide by link (routes/guideShares.ts): owners and admins who edit guides choose who
 * may open it; the shared page says nothing of a guide for certain people until the browser has
 * proved an address that was added, with a code emailed to it; nobody learns from asking who a guide
 * is shared with; and the page's pictures are only the guide's own, with their metadata taken out.
 * The database's part (who sees and changes shares, what guide_share_view answers) is in
 * supabase/tests/guide_sharing_test.sql; here it answers what each test gives it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { app } from "../src/app";
import type { Env } from "../src/env";
import { signToken } from "../src/lib/crypto";
import { newToken } from "../src/routes/guideShares";
import { withoutMetadata } from "../src/services/guideShares";

const current = vi.hoisted(() => ({
  db: null as unknown,
  background: [] as Array<Promise<unknown>>,
  emails: [] as Array<Record<string, any>>,
  files: {} as Record<string, Uint8Array>,
  emailReady: true,
  sendFails: null as string | null,
}));
vi.mock("../src/lib/supabase", async (original) => ({ ...(await original<typeof import("../src/lib/supabase")>()), adminClient: () => current.db, userClient: () => current.db }));
vi.mock("../src/lib/storedFile", () => ({ storedFile: async (_admin: unknown, path: string) => current.files[path] ?? null }));
vi.mock("../src/lib/background", () => ({ runInBackground: (_c: unknown, work: Promise<unknown>) => void current.background.push(work), kickAutomations: () => undefined }));
vi.mock("../src/lib/notify", async (original) => ({
  ...(await original<typeof import("../src/lib/notify")>()),
  emailReady: async () => current.emailReady,
  sendEmail: async (_env: unknown, message: Record<string, unknown>) => {
    if (current.sendFails) return { sent: false, reason: current.sendFails };
    current.emails.push(message);
    return { sent: true, id: "e1" };
  },
}));

const env: Env = {
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
  SUPABASE_SECRET_KEY: "sb_secret_test",
  ENCRYPTION_KEY: btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => i * 5))),
  APP_URL: "https://crm.peaklawn.example",
};
const CO = "00000000-0000-4000-8000-0000000000c0";
const OTHER_CO = "00000000-0000-4000-8000-0000000000c9";
const GUIDE = "00000000-0000-4000-8000-0000000000a1";
const USER = "00000000-0000-4000-8000-0000000000aa";
const PERSON = "00000000-0000-4000-8000-0000000000b1";
const TOKEN = "0123456789abcdef0123456789abcdef";
const LINK = `https://crm.peaklawn.example/g/${TOKEN}`;
const PICTURE = `${CO}/kb/7c0a0000-0000-4000-8000-000000000001.jpg`;
const COVER = `${CO}/kb/7c0a0000-0000-4000-8000-000000000002.jpg`;
const THEIRS = `${OTHER_CO}/kb/7c0a0000-0000-4000-8000-000000000003.jpg`;
const RECEIPT = `${CO}/receipts/7c0a0000-0000-4000-8000-000000000004.jpg`;
const HTML = `<h2>Watering</h2><p>Twice a day.</p><img data-path="${PICTURE}" alt="Sprinkler"><img data-path="${THEIRS}"><img data-path="${RECEIPT}">`;

/** A small JPEG: JFIF, then EXIF (as a phone writes), a comment, a table, one scan, the end, and something riding after it. */
const segment = (marker: number, payload: number[]) => [0xff, marker, (payload.length + 2) >> 8, (payload.length + 2) & 0xff, ...payload];
const ascii = (text: string) => [...text].map((ch) => ch.charCodeAt(0));
const JFIF = segment(0xe0, [...ascii("JFIF\0"), 1, 1, 0, 0, 1, 0, 1, 0, 0]);
const EXIF = segment(0xe1, [...ascii("Exif\0\0"), ...ascii("GPS 37.27N 79.94W")]);
const ICC = segment(0xe2, [...ascii("ICC_PROFILE\0"), 1, 1, 9, 9, 9]);
const MPF = segment(0xe2, [...ascii("MPF\0"), 7, 7, 7]);
const COMMENT = segment(0xfe, ascii("taken at 12 Oak St"));
const TABLE = segment(0xdb, [0, 1, 2, 3]);
const SCAN = [...segment(0xda, [1, 1, 0, 0, 63, 0]), 0x12, 0xff, 0x00, 0x34, 0xff, 0xd0, 0x56];
const END = [0xff, 0xd9];
const jpeg = (...parts: number[][]) => new Uint8Array([0xff, 0xd8, ...parts.flat()]);
const PHOTO = jpeg(JFIF, EXIF, ICC, MPF, COMMENT, TABLE, SCAN, END, ascii("a second picture, or a video"));
const CLEAN = jpeg(JFIF, ICC, TABLE, SCAN, END);

interface Query { table: string; calls: Array<[string, ...any[]]> }
const did = (q: Query, op: string) => q.calls.find(([name]) => name === op);

/** The guide and its share as the database holds them, for the fake below to answer from. */
function world(changes: Partial<ReturnType<typeof base>> = {}) {
  return { ...base(), ...changes };
}
function base() {
  return {
    role: "owner" as string,
    guide: { id: GUIDE, title: "Caring for new sod", status: "published" } as { id: string; title: string; status: string } | null,
    share: { page_id: GUIDE, token: TOKEN, access: "restricted" } as { page_id: string; token: string; access: string } | null,
    people: [{ id: PERSON, email: "dana@example.com", created_at: "2026-11-17T12:00:00Z", last_opened_at: null as string | null }],
    html: HTML,
    cover: COVER as string | null,
  };
}

/** A database that answers by table and function from `w`, counts limits as Postgres does, and remembers what was asked of it. */
function fakeDb(w: ReturnType<typeof world>) {
  const queries: Query[] = [];
  const rpcs: Array<{ name: string; args: any }> = [];
  const hits = new Map<string, number>();
  const spent = new Map<string, number>();
  const opened: string[] = [];
  const answer = (q: Query): unknown => {
    switch (q.table) {
      // One person's membership, or the owners and admins told something.
      case "memberships": return did(q, "in") ? [{ user_id: USER }] : { role: w.role, role_id: null };
      case "sop_pages": return w.guide;
      case "companies": return { name: "Peak Lawn", phone: "540 555 0100", website: "https://peaklawn.example", country: "GB", settings: { branding: { color: "#226644" } } };
      case "profiles": return { full_name: "Pat Owner" };
      case "sop_shares": {
        const insert = did(q, "insert");
        if (insert) w.share = { page_id: insert[1].page_id, token: TOKEN, access: "restricted" };
        const update = did(q, "update");
        if (update && w.share) w.share = { ...w.share, ...update[1] };
        return w.share;
      }
      case "sop_share_people": {
        const upsert = did(q, "upsert");
        if (upsert) for (const row of upsert[1] as Array<{ email: string }>) w.people.push({ id: `id-${row.email}`, email: row.email, created_at: "2026-11-17T13:00:00Z", last_opened_at: null });
        if (did(q, "delete")) w.people = w.people.filter((p) => !q.calls.some(([name, column, value]) => name === "eq" && column === "id" && value === p.id));
        // One person of this guide: asked for by their row and the guide, both.
        if (did(q, "maybeSingle")) {
          const by = (column: string) => q.calls.find(([name, c]) => name === "eq" && c === column)?.[2];
          return by("page_id") === GUIDE ? (w.people.find((p) => p.id === by("id")) ?? null) : null;
        }
        return w.people;
      }
      default: return null;
    }
  };
  const chain = (q: Query): unknown =>
    new Proxy({}, {
      get: (_, name) =>
        name === "then"
          ? (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) => Promise.resolve().then(() => ({ data: answer(q), error: null })).then(resolve, reject)
          : (...args: unknown[]) => {
              q.calls.push([String(name), ...args]);
              return chain(q);
            },
    });
  current.db = {
    from: (table: string) => {
      const q: Query = { table, calls: [] };
      queries.push(q);
      return chain(q);
    },
    rpc: async (name: string, args: any) => {
      rpcs.push({ name, args });
      if (name === "rate_limit_hit") {
        const n = (hits.get(args.p_key) ?? 0) + 1;
        hits.set(args.p_key, n);
        return { data: n <= args.p_max, error: null };
      }
      if (name === "rate_limit_spend") {
        const n = Math.min(spent.get(args.p_key) ?? 0, args.p_max) + args.p_amount;
        spent.set(args.p_key, n);
        return { data: n <= args.p_max, error: null };
      }
      if (name !== "guide_share_view") return { data: null, error: null };
      if (!w.share || args.p_token !== w.share.token || w.guide?.status !== "published") return { data: null, error: null };
      const email = typeof args.p_email === "string" ? args.p_email.trim().toLowerCase() : null;
      const who = w.people.find((p) => (email ? p.email === email : args.p_person ? p.id === args.p_person : false));
      const added = Boolean(who);
      const whose = { company_id: CO, page_id: GUIDE, access: w.share.access };
      if (w.share.access !== "anyone" && !added) return { data: { ...whose, allowed: false }, error: null };
      if (args.p_opened && who) opened.push(who.email);
      return { data: { ...whose, allowed: true, person_id: who?.id ?? null, title: w.guide.title, body_html: w.html, cover_path: w.cover, revised_at: "2026-11-10T09:00:00Z", category: "Aftercare" }, error: null };
    },
    auth: { getClaims: async () => ({ data: { claims: { sub: USER } }, error: null }) },
  };
  return { queries, rpcs, opened, w, spent };
}

const office = (method: string, path: string, body?: unknown) =>
  app.request(`/api${path}`, { method, headers: { Authorization: "Bearer t", "X-Company-Id": CO, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }, env);
const visitor = (path: string, body: unknown = {}) => app.request(`/api/public/guides/${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }, env);
const picture = (name: string, pass?: string, method = "GET") => app.request(`/api/public/guides/${TOKEN}/pictures/${name}${pass ? `?k=${encodeURIComponent(pass)}` : ""}`, { method }, env);
const codeIn = (email: Record<string, any>) => /\n\n(\d{6})\n\n/.exec(email.text as string)![1]!;

/** Asks for a code as `email` and waits for whatever is sent. */
async function askCode(email: string) {
  const res = await visitor(`${TOKEN}/code`, { email });
  await Promise.all(current.background);
  return { res, body: (await res.json()) as { sent?: boolean; challenge?: string; error?: string } };
}

beforeEach(() => {
  current.emailReady = true;
  current.sendFails = null;
  current.files = { [PICTURE]: PHOTO, [COVER]: PHOTO, [THEIRS]: PHOTO, [RECEIPT]: PHOTO };
});
afterEach(() => {
  current.background.length = 0;
  current.emails.length = 0;
});

describe("sharing a guide, for the office", () => {
  it("gives a guide its link the first time Share is opened, for nobody outside the team yet", async () => {
    const db = fakeDb(world({ share: null, people: [] }));
    const res = await office("POST", `/guides/${GUIDE}/share`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ access: "restricted", url: LINK, published: true, email_ready: true, people: [] });
    const made = db.queries.find((q) => q.table === "sop_shares" && did(q, "insert"))!;
    expect(did(made, "insert")![1]).toEqual({ page_id: GUIDE, company_id: CO });
  });

  it("doesn't make another when it has one, and lists who it's shared with", async () => {
    const db = fakeDb(world());
    const body = (await (await office("POST", `/guides/${GUIDE}/share`)).json()) as { people: Array<{ email: string }> };
    expect(body.people.map((p) => p.email)).toEqual(["dana@example.com"]);
    expect(db.queries.some((q) => q.table === "sop_shares" && did(q, "insert"))).toBe(false);
  });

  it("is for owners and admins: office staff who edit guides don't share them", async () => {
    for (const role of ["office", "estimator", "field_crew"]) {
      const db = fakeDb(world({ role }));
      for (const [method, path, body] of [["POST", "/share", undefined], ["PATCH", "/share", { access: "anyone" }], ["POST", "/share/people", { emails: ["x@example.com"] }], ["POST", "/share/link", undefined], ["DELETE", `/share/people/${PERSON}`, undefined], ["POST", `/share/people/${PERSON}/email`, undefined]] as const) {
        expect((await office(method, `/guides/${GUIDE}${path}`, body)).status, `${role} ${method} ${path}`).toBe(403);
      }
      expect(db.queries.every((q) => q.table === "memberships")).toBe(true);
    }
  });

  it("says a guide that isn't there isn't", async () => {
    fakeDb(world({ guide: null }));
    expect((await office("POST", `/guides/${GUIDE}/share`)).status).toBe(404);
    expect((await office("POST", "/guides/not-a-guide/share")).status).toBe(404);
  });

  it("opens it to anyone with the link, or back to only the people added", async () => {
    const db = fakeDb(world());
    const res = await office("PATCH", `/guides/${GUIDE}/share`, { access: "anyone" });
    expect(((await res.json()) as { access: string }).access).toBe("anyone");
    expect(did(db.queries.find((q) => q.table === "sop_shares" && did(q, "update"))!, "update")![1]).toEqual({ access: "anyone" });
    expect((await office("PATCH", `/guides/${GUIDE}/share`, { access: "everyone" })).status).toBe(400);
    expect(db.w.share!.access).toBe("anyone");
  });

  it("adds people by address, each once in one spelling, and emails each new one the link", async () => {
    const db = fakeDb(world());
    const res = await office("POST", `/guides/${GUIDE}/share/people`, { emails: [" Sam@Example.com ", "sam@example.com", "dana@example.com", "lee@example.com"] });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { added: string[]; emailed: string[]; not_emailed: string[]; problem: string | null; people: Array<{ email: string }> };
    expect(body).toMatchObject({ added: ["sam@example.com", "lee@example.com"], emailed: ["sam@example.com", "lee@example.com"], not_emailed: [], problem: null });
    expect(body.people.map((p) => p.email)).toEqual(["dana@example.com", "sam@example.com", "lee@example.com"]);
    const saved = did(db.queries.find((q) => q.table === "sop_share_people" && did(q, "upsert"))!, "upsert")!;
    expect(saved[1]).toEqual([{ company_id: CO, page_id: GUIDE, email: "sam@example.com" }, { company_id: CO, page_id: GUIDE, email: "lee@example.com" }]);
    expect(saved[2]).toEqual({ onConflict: "page_id,email", ignoreDuplicates: true });

    expect(current.emails.map((e) => e.to)).toEqual(["sam@example.com", "lee@example.com"]);
    expect(current.emails[0]).toMatchObject({ subject: "Peak Lawn shared a guide with you: Caring for new sod", fromName: "Peak Lawn" });
    expect(current.emails[0]!.text).toContain("Pat Owner at Peak Lawn shared a guide with you: Caring for new sod.");
    expect(current.emails[0]!.text).toContain(LINK);
    expect(current.emails[0]!.text).toContain("sent a code");
    expect(current.emails[0]!.html).toContain("Open the guide");
  });

  it("saves nobody when something typed isn't an address", async () => {
    const db = fakeDb(world());
    const res = await office("POST", `/guides/${GUIDE}/share/people`, { emails: ["sam@example.com", "sam at example"] });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("sam at example isn't an email address.");
    expect(db.queries.some((q) => q.table === "sop_share_people")).toBe(false);
    expect((await office("POST", `/guides/${GUIDE}/share/people`, { emails: [] })).status).toBe(400);
    expect((await office("POST", `/guides/${GUIDE}/share/people`, { emails: Array.from({ length: 21 }, (_, i) => `p${i}@example.com`) })).status).toBe(400);
  });

  it("adds nobody when the list would pass fifty, and says how many more fit", async () => {
    const db = fakeDb(world({ people: Array.from({ length: 48 }, (_, i) => ({ id: `id-${i}`, email: `p${i}@example.com`, created_at: "", last_opened_at: null })) }));
    const res = await office("POST", `/guides/${GUIDE}/share/people`, { emails: ["a@example.com", "b@example.com", "c@example.com"] });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("A guide can be shared with up to 50 people, and this one has 48, so 2 more can be added. To reach more, let anyone with the link open it.");
    expect(db.queries.some((q) => q.table === "sop_share_people" && did(q, "upsert"))).toBe(false);
    expect(current.emails).toEqual([]);
    expect((await office("POST", `/guides/${GUIDE}/share/people`, { emails: ["a@example.com", "b@example.com"] })).status).toBe(200);
  });

  it("adds people to a draft, or with no email set up, without emailing them, and says why", async () => {
    fakeDb(world({ guide: { id: GUIDE, title: "Caring for new sod", status: "draft" } }));
    const draft = (await (await office("POST", `/guides/${GUIDE}/share/people`, { emails: ["sam@example.com"] })).json()) as { added: string[]; not_emailed: string[]; problem: string; published: boolean };
    expect(draft).toMatchObject({ added: ["sam@example.com"], not_emailed: ["sam@example.com"], published: false });
    expect(draft.problem).toContain("It's a draft");

    current.emailReady = false;
    fakeDb(world());
    const unset = (await (await office("POST", `/guides/${GUIDE}/share/people`, { emails: ["sam@example.com"] })).json()) as { not_emailed: string[]; problem: string; email_ready: boolean };
    expect(unset).toMatchObject({ not_emailed: ["sam@example.com"], email_ready: false });
    expect(unset.problem).toContain("Email isn't set up");
    expect(current.emails).toEqual([]);
  });

  it("says why when the email couldn't be sent, and keeps the person", async () => {
    current.sendFails = "The mailbox's password was turned down.";
    const db = fakeDb(world());
    const body = (await (await office("POST", `/guides/${GUIDE}/share/people`, { emails: ["sam@example.com"] })).json()) as { emailed: string[]; not_emailed: string[]; problem: string };
    expect(body).toMatchObject({ emailed: [], not_emailed: ["sam@example.com"], problem: "The mailbox's password was turned down." });
    expect(db.w.people.map((p) => p.email)).toContain("sam@example.com");
  });

  it("emails someone the link again, and takes someone off", async () => {
    const db = fakeDb(world());
    const again = await office("POST", `/guides/${GUIDE}/share/people/${PERSON}/email`);
    expect(await again.json()).toEqual({ emailed: "dana@example.com" });
    expect(current.emails.map((e) => e.to)).toEqual(["dana@example.com"]);

    const res = await office("DELETE", `/guides/${GUIDE}/share/people/${PERSON}`);
    expect(((await res.json()) as { people: unknown[] }).people).toEqual([]);
    const removed = db.queries.find((q) => q.table === "sop_share_people" && did(q, "delete"))!;
    expect(removed.calls).toContainEqual(["eq", "id", PERSON]);
    expect(removed.calls).toContainEqual(["eq", "page_id", GUIDE]);
  });

  it("says a link to a draft can't be emailed yet", async () => {
    fakeDb(world({ guide: { id: GUIDE, title: "Caring for new sod", status: "draft" } }));
    const res = await office("POST", `/guides/${GUIDE}/share/people/${PERSON}/email`);
    expect(res.status).toBe(409);
    expect(current.emails).toEqual([]);
  });

  it("swaps the link for a new random one, for this company's guide", async () => {
    const db = fakeDb(world());
    const res = await office("POST", `/guides/${GUIDE}/share/link`);
    const swapped = db.queries.find((q) => q.table === "sop_shares" && did(q, "update"))!;
    const token = did(swapped, "update")![1].token as string;
    expect(token).toMatch(/^[0-9a-f]{32}$/);
    expect(token).not.toBe(TOKEN);
    expect(swapped.calls).toContainEqual(["eq", "company_id", CO]);
    expect(((await res.json()) as { url: string }).url).toBe(`https://crm.peaklawn.example/g/${token}`);
    expect(new Set(Array.from({ length: 50 }, newToken)).size).toBe(50);
  });
});

describe("a shared guide's page", () => {
  it("isn't there for a link that isn't one, a draft, or a deleted guide, and is never for search engines", async () => {
    fakeDb(world());
    const wrong = await visitor("ffffffffffffffffffffffffffffffff");
    expect(wrong.status).toBe(404);
    expect(wrong.headers.get("x-robots-tag")).toBe("noindex");
    expect((await visitor("not-a-link")).status).toBe(404);
    fakeDb(world({ guide: { id: GUIDE, title: "Caring for new sod", status: "draft" } }));
    expect((await visitor(TOKEN)).status).toBe(404);
    fakeDb(world({ share: null }));
    expect((await visitor(TOKEN)).status).toBe(404);
  });

  it("opens for anyone when the link is for anyone, with only the guide's own pictures", async () => {
    fakeDb(world({ share: { page_id: GUIDE, token: TOKEN, access: "anyone" } }));
    const res = await visitor(TOKEN);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-robots-tag")).toBe("noindex");
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as Record<string, any>;
    expect(body).toMatchObject({
      locked: false, title: "Caring for new sod", category: "Aftercare", revised_at: "2026-11-10T09:00:00Z", html: HTML, email: null,
      company: { name: "Peak Lawn", phone: "540 555 0100", color: "#226644", country: "GB" },
      cover: `/api/public/guides/${TOKEN}/pictures/7c0a0000-0000-4000-8000-000000000002.jpg`,
    });
    // Another company's file and one outside kb/ are named in the guide, and never offered.
    expect(body.pictures).toEqual({ [PICTURE]: `/api/public/guides/${TOKEN}/pictures/7c0a0000-0000-4000-8000-000000000001.jpg` });
    expect(JSON.stringify(body)).not.toContain("Pat Owner");
  });

  it("says nothing of a guide for certain people to a browser that hasn't proved an address", async () => {
    fakeDb(world());
    const res = await visitor(TOKEN);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;
    expect(body).toEqual({ locked: true, company: expect.objectContaining({ name: "Peak Lawn" }) });
    expect(JSON.stringify(body)).not.toContain("sod");
    // Something that isn't a key from here opens nothing.
    const forged = await signToken({ ...env, ENCRYPTION_KEY: btoa("x".repeat(32)) }, { k: "guide-reader", e: "dana@example.com", exp: Math.floor(Date.now() / 1000) + 600 });
    const pass = await signToken(env, { k: "guide-pic", t: TOKEN, p: PERSON, exp: Math.floor(Date.now() / 1000) + 600 });
    for (const key of ["nonsense", forged, pass, "a".repeat(700)]) {
      const tried = await visitor(TOKEN, { key });
      expect(tried.status === 400 || ((await tried.json()) as { locked: boolean }).locked === true, key.slice(0, 20)).toBe(true);
    }
  });

  it("emails a code to someone who was added, and the code lets their browser in", async () => {
    const db = fakeDb(world());
    const { res, body } = await askCode(" Dana@Example.com ");
    expect(res.status).toBe(200);
    expect(body).toEqual({ sent: true, challenge: expect.any(String) });
    expect(current.emails).toHaveLength(1);
    expect(current.emails[0]).toMatchObject({ to: "dana@example.com", subject: "Your code to open Caring for new sod", fromName: "Peak Lawn" });
    const code = codeIn(current.emails[0]!);
    // What the browser holds never says the code.
    expect(atob(body.challenge!.split(".")[0]!.replace(/-/g, "+").replace(/_/g, "/"))).not.toContain(code);

    const wrong = await visitor(`${TOKEN}/code/check`, { challenge: body.challenge, code: code === "000000" ? "000001" : "000000" });
    expect(wrong.status).toBe(400);
    expect(((await wrong.json()) as { error: string }).error).toBe("That code isn't right. Check the email and try again.");

    const right = await visitor(`${TOKEN}/code/check`, { challenge: body.challenge, code: ` ${code.slice(0, 3)} ${code.slice(3)} ` });
    expect(right.status).toBe(200);
    const { key, email } = (await right.json()) as { key: string; email: string };
    expect(email).toBe("dana@example.com");

    const open = await visitor(TOKEN, { key });
    const guide = (await open.json()) as Record<string, any>;
    expect(guide).toMatchObject({ locked: false, title: "Caring for new sod", html: HTML, email: "dana@example.com" });
    expect(db.opened).toEqual(["dana@example.com"]);

    // Its pictures load with a pass of their own, and not without one.
    const src = guide.pictures[PICTURE] as string;
    expect(src).toMatch(new RegExp(`^/api/public/guides/${TOKEN}/pictures/7c0a0000-0000-4000-8000-000000000001\\.jpg\\?k=`));
    const shown = await app.request(src, {}, env);
    expect(shown.status).toBe(200);
    expect(shown.headers.get("cache-control")).toBe("private, max-age=300");
    expect((await picture("7c0a0000-0000-4000-8000-000000000001.jpg")).status).toBe(404);
    // The key itself isn't a pass for pictures.
    expect((await picture("7c0a0000-0000-4000-8000-000000000001.jpg", key)).status).toBe(404);
    // The picture's link says nothing of who is reading, and is the same when the page asks again, so the picture isn't loaded twice.
    const passed = new URL(src, "https://x.example").searchParams.get("k")!;
    expect(atob(passed.split(".")[0]!.replace(/-/g, "+").replace(/_/g, "/"))).not.toMatch(/@|dana/);
    expect(((await (await visitor(TOKEN, { key })).json()) as Record<string, any>).pictures[PICTURE]).toBe(src);
    // A pass for another link, or naming someone who isn't on this guide, shows nothing.
    const exp = Math.floor(Date.now() / 1000) + 600;
    for (const made of [{ k: "guide-pic", t: "f".repeat(32), p: PERSON, exp }, { k: "guide-pic", t: TOKEN, p: "00000000-0000-4000-8000-0000000000b9", exp }, { k: "guide-pic", t: TOKEN, p: "not-a-row", exp }, { k: "guide-pic", t: TOKEN, e: "dana@example.com", exp }]) {
      expect((await picture("7c0a0000-0000-4000-8000-000000000001.jpg", await signToken(env, made))).status, JSON.stringify(made)).toBe(404);
    }

    // The code worked once.
    const again = await visitor(`${TOKEN}/code/check`, { challenge: body.challenge, code });
    expect(again.status).toBe(400);
    expect(((await again.json()) as { error: string }).error).toBe("That code has run out. Ask for a new one.");
  });

  it("answers the same for an address that wasn't added, sends nothing, and no code works", async () => {
    fakeDb(world());
    const added = await askCode("dana@example.com");
    const stranger = await askCode("stranger@example.com");
    expect(stranger.res.status).toBe(200);
    expect(Object.keys(stranger.body)).toEqual(Object.keys(added.body));
    // What each browser holds has the same parts, of the same sizes but for the address typed.
    const parts = (challenge: string) => JSON.parse(atob(challenge.split(".")[0]!.replace(/-/g, "+").replace(/_/g, "/"))) as Record<string, string>;
    const [mine, theirs] = [parts(added.body.challenge!), parts(stranger.body.challenge!)];
    expect(Object.keys(theirs)).toEqual(Object.keys(mine));
    expect(theirs.h).toHaveLength(mine.h!.length);
    expect(current.emails.map((e) => e.to)).toEqual(["dana@example.com"]);
    const tried = await visitor(`${TOKEN}/code/check`, { challenge: stranger.body.challenge, code: codeIn(current.emails[0]!) });
    expect(tried.status).toBe(400);
    expect(((await tried.json()) as { error: string }).error).toBe("That code isn't right. Check the email and try again.");
  });

  it("gives a code five tries, then asks for a new one", async () => {
    fakeDb(world());
    const { body } = await askCode("dana@example.com");
    const code = codeIn(current.emails[0]!);
    const wrong = code === "111111" ? "222222" : "111111";
    for (let i = 0; i < 5; i++) expect((await visitor(`${TOKEN}/code/check`, { challenge: body.challenge, code: wrong })).status).toBe(400);
    const spent = await visitor(`${TOKEN}/code/check`, { challenge: body.challenge, code });
    expect(spent.status).toBe(429);
    expect(((await spent.json()) as { error: string }).error).toBe("Too many tries. Ask for a new code.");
  });

  it("limits how often a code is asked for an address", async () => {
    fakeDb(world());
    for (let i = 0; i < 3; i++) expect((await askCode("dana@example.com")).res.status).toBe(200);
    const fourth = await askCode("dana@example.com");
    expect(fourth.res.status).toBe(429);
    expect(fourth.body.error).toBe("Too many codes asked for. Wait a while and try again.");
    expect(current.emails).toHaveLength(3);
  });

  it("counts an address's asks at a link that is one, so a stranger without the link can't use them up", async () => {
    fakeDb(world());
    for (let i = 0; i < 9; i++) expect((await visitor("ffffffffffffffffffffffffffffffff/code", { email: "dana@example.com" })).status).toBe(404);
    expect((await askCode("dana@example.com")).res.status).toBe(200);
    expect(current.emails).toHaveLength(1);
  });

  it("stops one visitor asking without end, and says a new code won't help", async () => {
    fakeDb(world());
    let last = { status: 0, error: "" };
    for (let i = 0; i < 31; i++) {
      const res = await visitor(`${TOKEN}/code`, { email: `person${i}@example.com` });
      last = { status: res.status, error: ((await res.json()) as { error?: string }).error ?? "" };
      if (i < 30) expect(res.status, String(i)).toBe(200);
    }
    expect(last).toEqual({ status: 429, error: "Too many tries from this network. Wait an hour and try again." });
    expect(current.emails).toEqual([]);
  });

  it("refuses a code when the limit can't be counted, rather than emailing without one", async () => {
    const db = fakeDb(world());
    const rpc = (current.db as { rpc: (name: string, args: unknown) => Promise<unknown> }).rpc;
    (current.db as { rpc: unknown }).rpc = async (name: string, args: unknown) => (name === "rate_limit_hit" ? { data: null, error: { message: "down" } } : rpc(name, args));
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect((await askCode("dana@example.com")).res.status).toBe(429);
    errors.mockRestore();
    expect(current.emails).toEqual([]);
    expect(db.rpcs.some((r) => r.name === "guide_share_view")).toBe(false);
  });

  it("doesn't take a code asked for at another link, or anything that isn't one", async () => {
    fakeDb(world());
    const { body } = await askCode("dana@example.com");
    const code = codeIn(current.emails[0]!);
    const elsewhere = await visitor("ffffffffffffffffffffffffffffffff/code/check", { challenge: body.challenge, code });
    expect(elsewhere.status).toBe(400);
    const made = await signToken(env, { k: "guide-reader", e: "dana@example.com", exp: Math.floor(Date.now() / 1000) + 600 });
    for (const challenge of ["nonsense", made]) {
      const res = await visitor(`${TOKEN}/code/check`, { challenge, code });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe("That code has run out. Ask for a new one.");
    }
    expect((await visitor(`${TOKEN}/code`, { email: "not an address" })).status).toBe(400);
  });

  it("shuts someone out as soon as they're taken off, whatever their browser holds", async () => {
    const db = fakeDb(world());
    const { body } = await askCode("dana@example.com");
    const code = codeIn(current.emails[0]!);
    const { key } = (await (await visitor(`${TOKEN}/code/check`, { challenge: body.challenge, code })).json()) as { key: string };
    const guide = (await (await visitor(TOKEN, { key })).json()) as Record<string, any>;
    db.w.people = [];
    expect(await (await visitor(TOKEN, { key })).json()).toEqual({ locked: true, company: expect.anything() });
    expect((await app.request(guide.pictures[PICTURE], {}, env)).status).toBe(404);

    // Taken off between asking and typing the code.
    db.w.people = [{ id: PERSON, email: "dana@example.com", created_at: "", last_opened_at: null }];
    current.emails.length = 0;
    const asked = await askCode("dana@example.com");
    db.w.people = [];
    const late = await visitor(`${TOKEN}/code/check`, { challenge: asked.body.challenge, code: codeIn(current.emails[0]!) });
    expect(late.status).toBe(403);
    expect(await late.json()).toEqual({ error: "This guide isn't shared with that address any more." });
  });

  it("needs no code when the link is for anyone", async () => {
    fakeDb(world({ share: { page_id: GUIDE, token: TOKEN, access: "anyone" } }));
    expect((await askCode("dana@example.com")).res.status).toBe(409);
    expect(current.emails).toEqual([]);
  });
});

describe("a shared guide's pictures", () => {
  it("are the guide's own, as JPEGs with what a camera wrote taken out", async () => {
    fakeDb(world({ share: { page_id: GUIDE, token: TOKEN, access: "anyone" } }));
    const res = await picture("7c0a0000-0000-4000-8000-000000000001.jpg");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/jpeg");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-robots-tag")).toBe("noindex");
    expect(res.headers.get("cache-control")).toBe("public, max-age=300");
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(bytes).toEqual(CLEAN);
    expect(new TextDecoder("latin1").decode(bytes)).not.toMatch(/GPS|Oak St|second picture/);
    const head = await picture("7c0a0000-0000-4000-8000-000000000002.jpg", undefined, "HEAD");
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe(String(CLEAN.length));
  });

  it("are never another company's file, a file outside the guide, or anything that isn't a JPEG", async () => {
    fakeDb(world({ share: { page_id: GUIDE, token: TOKEN, access: "anyone" } }));
    // Named in the guide, but not its company's kb/ pictures.
    expect((await picture("7c0a0000-0000-4000-8000-000000000003.jpg")).status).toBe(404);
    expect((await picture("7c0a0000-0000-4000-8000-000000000004.jpg")).status).toBe(404);
    // In the folder, but not in this guide.
    current.files[`${CO}/kb/other.jpg`] = PHOTO;
    expect((await picture("other.jpg")).status).toBe(404);
    expect((await picture("..%2F..%2Fsecret.jpg")).status).toBe(404);
    current.files[PICTURE] = new TextEncoder().encode("<html><script>alert(1)</script></html>");
    expect((await picture("7c0a0000-0000-4000-8000-000000000001.jpg")).status).toBe(404);
    current.files[PICTURE] = PHOTO.subarray(0, PHOTO.length - 40);
    expect((await picture("7c0a0000-0000-4000-8000-000000000001.jpg")).status).toBe(404);
  });

  it("send at most a day's worth through one link, and the office hears once which link it was", async () => {
    const { spent, queries } = fakeDb(world({ share: { page_id: GUIDE, token: TOKEN, access: "anyone" } }));
    expect((await picture("7c0a0000-0000-4000-8000-000000000001.jpg")).status).toBe(200);
    // Counted in KB against 2 GB a day, for this link.
    expect(spent.get(`link-bytes:guide:${TOKEN}`)).toBe(Math.ceil(CLEAN.length / 1000));
    spent.set(`link-bytes:guide:${TOKEN}`, 2_000_000);
    const paused = await picture("7c0a0000-0000-4000-8000-000000000001.jpg");
    expect(paused.status).toBe(429);
    expect(((await paused.json()) as { error: string }).error).toBe("This link has sent a lot today, so its pictures are paused until tomorrow.");
    expect((await picture("7c0a0000-0000-4000-8000-000000000002.jpg")).status).toBe(429);
    const told = queries.filter((q) => q.table === "notifications").map((q) => did(q, "insert")?.[1]);
    expect(told).toEqual([[expect.objectContaining({ company_id: CO, user_id: USER, kind: "hosting", title: "A shared guide's pictures are paused for the day", link: `/kb/${GUIDE}` })]]);
    // The page itself still opens.
    expect((await visitor(TOKEN)).status).toBe(200);
  });

  it("go when the guide isn't shown any more", async () => {
    fakeDb(world({ share: { page_id: GUIDE, token: TOKEN, access: "anyone" }, guide: { id: GUIDE, title: "Caring for new sod", status: "draft" } }));
    expect((await picture("7c0a0000-0000-4000-8000-000000000001.jpg")).status).toBe(404);
  });
});

describe("taking a JPEG's metadata out", () => {
  it("drops EXIF, comments, a phone's picture index and whatever follows the picture, and keeps the picture and its colours", () => {
    expect(withoutMetadata(PHOTO)).toEqual(CLEAN);
    const adobe = segment(0xee, [...ascii("Adobe"), 0, 100, 0, 0, 0, 0, 1]);
    expect(withoutMetadata(jpeg(JFIF, adobe, EXIF, TABLE, SCAN, END))).toEqual(jpeg(JFIF, adobe, TABLE, SCAN, END));
  });

  it("reads a picture drawn in several passes to its real end", () => {
    const second = [...segment(0xc4, [0, 9, 9]), ...segment(0xda, [1, 1, 0, 1, 5, 2]), 0x77, 0xff, 0x00, 0xff, 0xd7, 0x88];
    expect(withoutMetadata(jpeg(JFIF, EXIF, TABLE, SCAN, second, END, [1, 2, 3]))).toEqual(jpeg(JFIF, TABLE, SCAN, second, END));
  });

  it("leaves a clean one as it is", () => {
    expect(withoutMetadata(CLEAN)).toEqual(CLEAN);
  });

  it("answers nothing for what isn't a whole JPEG", () => {
    expect(withoutMetadata(new TextEncoder().encode("not a picture"))).toBeNull();
    expect(withoutMetadata(new Uint8Array([0xff, 0xd8, 0xff]))).toBeNull();
    // No end, a segment longer than the file, an end before any picture, junk between segments.
    expect(withoutMetadata(jpeg(JFIF, TABLE, SCAN))).toBeNull();
    expect(withoutMetadata(new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0xff, 0xff, 1, 2, 3]))).toBeNull();
    expect(withoutMetadata(jpeg(JFIF, END))).toBeNull();
    expect(withoutMetadata(jpeg(JFIF, [0x00, 0x01], TABLE, SCAN, END))).toBeNull();
  });
});
