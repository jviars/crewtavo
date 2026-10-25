/**
 * Subcontractors' paperwork links (routes/subs.ts, services/subs.ts) against a stand-in for
 * PostgREST, Storage and the email and text providers: fetch is stubbed, and each test answers the
 * requests it expects. (Who can reach subs and their files, and the reminders' timing, are tested
 * in supabase/tests/subcontractors_test.sql.)
 */
import { addDays } from "@crewtavo/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { app } from "../src/app";
import type { Env } from "../src/env";
import { signToken } from "../src/lib/crypto";
import { clientLink } from "../src/lib/links";
import { adminClient } from "../src/lib/supabase";
import { remindSubs } from "../src/services/subs";

const env: Env = {
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
  SUPABASE_SECRET_KEY: "sb_secret_test",
  ENCRYPTION_KEY: btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => i * 7))),
  APP_URL: "https://ops.example.com",
  RESEND_API_KEY: "re_test",
  EMAIL_FROM: "Crewtavo <noreply@example.com>",
  TWILIO_ACCOUNT_SID: "AC123",
  TWILIO_AUTH_TOKEN: "twilio-token",
  TWILIO_FROM_NUMBER: "+15405550000",
};
const CO = "00000000-0000-4000-8000-0000000000a1";
const SUB = "00000000-0000-4000-8000-0000000000b1";
const OTHER_SUB = "00000000-0000-4000-8000-0000000000b2";

interface Call {
  method: string;
  url: URL;
  /** The table or rpc/<name> for PostgREST calls. */
  path: string;
  body: any;
}

/** Signed-in tokens for the office routes (getClaims asks /auth/v1/user about HS256 ones). */
const part = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
const session = `${part({ alg: "HS256", typ: "JWT" })}.${part({ sub: "user-1", role: "authenticated", exp: Math.floor(Date.now() / 1000) + 600 })}.c2ln`;

interface World {
  /** The signed-in person's membership, and their custom role's areas when they have one. */
  member?: { role: string; role_id: string | null };
  custom?: string[];
  sub?: Record<string, unknown> | null;
  paperwork?: Array<{ requirement: string; state: string; expires_on: string | null; verified: boolean | null }>;
  /** Rate limits whose key matches are used up. */
  full?: RegExp;
  /** Storage objects that arrived, by path, with the type Storage took them as. */
  arrived?: Record<string, string>;
  /** The email provider answers with an error. */
  emailDown?: boolean;
}

const apex = { id: SUB, company_id: CO, name: "Apex Roofing LLC", contact_name: "Al Apex", email: "al@apex.test", phone: "+15405550101", active: true };
const company = { id: CO, name: "Uniform Roofing", email: "office@uniform.test", settings: { branding: { logo: `${CO}/logo/00000000-0000-4000-8000-0000000000c1.png`, logo_size: [96, 48] }, default_tax_rate: 0.05 } };

function serve(world: World = {}) {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const text = typeof init?.body === "string" ? init.body : init?.body ? String(init.body) : "";
    let body: unknown = text;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      // form bodies stay text
    }
    const call: Call = { method: (init?.method ?? "GET").toUpperCase(), url, path: url.pathname.replace(/^\/rest\/v1\//, ""), body };
    calls.push(call);
    const out = answer(call, url);
    return out instanceof Response ? out : Response.json(out ?? []);
  });
  function answer(call: Call, url: URL): unknown {
    const eq = (column: string) => url.searchParams.get(column)?.replace(/^eq\./, "");
    if (url.host === "api.resend.com") return world.emailDown ? Response.json({ message: "Service unavailable" }, { status: 503 }) : Response.json({ id: "email-1" });
    if (url.host === "api.twilio.com") return Response.json({ sid: "SM1" });
    if (url.pathname === "/auth/v1/user") return Response.json({ id: "user-1", aud: "authenticated", role: "authenticated" });
    if (url.pathname.startsWith("/storage/v1/object/upload/sign/")) return { url: `${url.pathname.replace("/storage/v1", "")}?token=tok-upload` };
    if (url.pathname.startsWith("/storage/v1/object/info/")) {
      const type = world.arrived?.[url.pathname.replace("/storage/v1/object/info/files/", "")];
      return type ? { size: 250_000, content_type: type } : Response.json({ statusCode: "404", error: "not_found", message: "Object not found" }, { status: 400 });
    }
    if (url.pathname === "/storage/v1/object/files" && call.method === "DELETE") return [];
    switch (call.path) {
      case "rpc/rate_limit_hit":
        return !world.full?.test(call.body.p_key);
      case "memberships":
        return world.member ? [world.member] : [{ role: "office", role_id: null }];
      case "company_roles":
        return [{ permissions: world.custom ?? [] }];
      case "subcontractors": {
        const sub = world.sub === undefined ? apex : world.sub;
        const id = url.searchParams.get("id");
        const wanted = !id || id === `eq.${sub?.id}` || (id.startsWith("in.(") && id.slice(4, -1).split(",").includes(String(sub?.id)));
        return sub && wanted && (!eq("company_id") || eq("company_id") === sub.company_id) ? [sub] : [];
      }
      case "companies":
        return [company];
      case "sub_paperwork":
        return world.paperwork ?? [
          { requirement: "w9", state: "missing", expires_on: null, verified: null },
          { requirement: "liability", state: "expiring", expires_on: "2026-11-10", verified: true },
          { requirement: "workers_comp", state: "ok", expires_on: "2027-03-01", verified: false },
        ];
      case "sub_documents":
        return call.method === "POST" ? Response.json([{ id: "doc-1" }], { status: 201 }) : [];
      default:
        return [];
    }
  }
  const limits = () => calls.filter((c) => c.path === "rpc/rate_limit_hit").map((c) => [c.body.p_key, c.body.p_max, c.body.p_window_seconds]);
  const emails = () => calls.filter((c) => c.url.host === "api.resend.com").map((c) => c.body);
  const texts = () => calls.filter((c) => c.url.host === "api.twilio.com").map((c) => Object.fromEntries(new URLSearchParams(c.body as string)));
  return { calls, limits, emails, texts };
}
afterEach(() => vi.unstubAllGlobals());

const tokenFor = async (link: { t: "sub" | "client" | "quote"; id: string; c?: string }) =>
  (await clientLink(env, "https://ops.example.com", { c: link.c ?? CO, t: link.t, id: link.id })).split(/\/(?:paperwork|hub)\//)[1]!;
const visitor = { "Content-Type": "application/json", "X-Forwarded-For": "203.0.113.9" };
const page = async (token: string, path = "", body?: unknown) =>
  app.request(`/api/public/paperwork/${token}${path}`, body === undefined ? { headers: visitor } : { method: "POST", headers: visitor, body: JSON.stringify(body) }, { ...env, incoming: { socket: { remoteAddress: "203.0.113.9" } } } as Env);
const officeRequest = (path: string, body: unknown = {}) =>
  app.request(`/api${path}`, { method: "POST", headers: { Authorization: `Bearer ${session}`, "X-Company-Id": CO, "Content-Type": "application/json" }, body: JSON.stringify(body) }, env);

describe("a sub's paperwork page", () => {
  it("shows the company's name and logo, the sub's business name and what's still needed, and nothing else", async () => {
    const db = serve();
    const res = await page(await tokenFor({ t: "sub", id: SUB }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      company: { name: "Uniform Roofing", logo: `/api/public/logo/${CO}/00000000-0000-4000-8000-0000000000c1.png` },
      sub: { name: "Apex Roofing LLC" },
      needed: [
        { requirement: "w9", label: "W-9", state: "missing", expires_on: null },
        { requirement: "liability", label: "Liability insurance", state: "expiring", expires_on: "2026-11-10" },
      ],
      waiting: ["workers_comp"],
      kinds: expect.arrayContaining([{ key: "w9", label: "W-9", expires: false }, { key: "liability", label: "Liability insurance", expires: true }]),
      max_bytes: 209_715_200,
    });
    expect(JSON.stringify(body)).not.toMatch(/al@apex|5550101|office@uniform|tax_rate/);
    // Every lookup is held to the company and the sub in the link.
    const sub = db.calls.find((c) => c.path === "subcontractors")!.url.searchParams;
    expect([sub.get("company_id"), sub.get("id")]).toEqual([`eq.${CO}`, `eq.${SUB}`]);
    const status = db.calls.find((c) => c.path === "sub_paperwork")!.url.searchParams;
    expect([status.get("company_id"), status.get("subcontractor_id")]).toEqual([`eq.${CO}`, `eq.${SUB}`]);
    expect(db.limits()).toEqual([["paperwork-page:ip:203.0.113.9", 60, 3600], [`paperwork-page:sub:${SUB}`, 60, 3600]]);
  });

  it("only opens with a sub's link that hasn't run out, for a sub still on the books", async () => {
    for (const token of [await tokenFor({ t: "client", id: SUB }), await tokenFor({ t: "quote", id: SUB }), "not-a-token"]) {
      serve();
      const res = await page(token);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "This link has expired or isn't valid. Ask for a new one." });
    }
    serve();
    const expired = await signToken(env, { c: CO, t: "sub", id: SUB, exp: Math.floor(Date.now() / 1000) - 60 });
    expect((await page(expired)).status).toBe(404);
    const forged = await tokenFor({ t: "sub", id: SUB });
    expect((await page(`${forged.slice(0, -2)}xx`)).status).toBe(404);
    // Turned off, or removed, or not this company's.
    serve({ sub: { ...apex, active: false } });
    expect((await page(await tokenFor({ t: "sub", id: SUB }))).status).toBe(404);
    serve({ sub: null });
    expect((await page(await tokenFor({ t: "sub", id: SUB }))).status).toBe(404);
    serve();
    expect((await page(await tokenFor({ t: "sub", id: SUB, c: "00000000-0000-4000-8000-0000000000a2" }))).status).toBe(404);
  });

  it("limits tries by visitor, before looking at the link, and by link", async () => {
    const byIp = serve({ full: /:ip:/ });
    const res = await page(await tokenFor({ t: "sub", id: SUB }));
    expect(res.status).toBe(429);
    expect(byIp.calls.some((c) => c.path === "subcontractors")).toBe(false);
    const bySub = serve({ full: /:sub:/ });
    expect((await page(await tokenFor({ t: "sub", id: SUB }))).status).toBe(429);
    expect(bySub.calls.some((c) => c.path === "subcontractors")).toBe(false);
  });
});

describe("sending paperwork by link", () => {
  const pdf = { name: "COI next year.pdf", size: 250_000, type: "application/pdf" };
  // A year from now: an end date that's still to come (and within five years) whenever the tests run.
  const ends = new Date(Date.now() + 365 * 86_400_000).toISOString().slice(0, 10);

  it("hands out a one-time upload link in the sub's own folder, then records the file once it's there", async () => {
    const token = await tokenFor({ t: "sub", id: SUB });
    const db = serve();
    const res = await page(token, "/uploads", { kind: "liability", file: pdf });
    expect(res.status).toBe(201);
    const sent = (await res.json()) as { path: string; token: string; files_token: string };
    expect(sent.path).toMatch(new RegExp(`^${CO}/subs/${SUB}/[0-9a-f-]{36}\\.pdf$`));
    expect(sent.token).toBe("tok-upload");
    expect(db.limits()).toEqual([["paperwork-upload:ip:203.0.113.9", 20, 3600], [`paperwork-upload:sub:${SUB}`, 20, 3600]]);

    // Not there yet: nothing is recorded.
    const early = serve();
    expect(await (await page(token, "/files", { files_token: sent.files_token, expires_on: ends })).json()).toEqual({ added: 0 });
    expect(early.calls.some((c) => c.path === "sub_documents")).toBe(false);

    const done = serve({ arrived: { [sent.path]: "application/pdf" } });
    const recorded = await page(token, "/files", { files_token: sent.files_token, expires_on: ends, carrier: "Acme Mutual", policy_number: "GL-77" });
    expect(recorded.status).toBe(200);
    expect(await recorded.json()).toEqual({ added: 1 });
    const insert = done.calls.find((c) => c.method === "POST" && c.path === "sub_documents")!;
    expect(insert.url.searchParams.get("on_conflict")).toBe("path");
    expect(insert.body).toEqual({
      company_id: CO, subcontractor_id: SUB, kind: "liability", title: "Liability insurance", path: sent.path, file_name: "COI next year.pdf", content_type: "application/pdf",
      size_bytes: 250_000, expires_on: ends, carrier: "Acme Mutual", policy_number: "GL-77", uploaded_via: "link",
    });
  });

  it("takes PDFs and pictures only, up to the booking form's size", async () => {
    const token = await tokenFor({ t: "sub", id: SUB });
    for (const file of [{ name: "virus.exe", size: 10 }, { name: "coi.pdf", size: 10, type: "text/html" }, { name: "coi", size: 10 }, { name: "big.pdf", size: 300 * 1024 * 1024 }]) {
      const db = serve();
      expect((await page(token, "/uploads", { kind: "liability", file })).status).toBe(400);
      expect(db.calls.some((c) => c.url.pathname.startsWith("/storage/"))).toBe(false);
    }
    serve();
    expect((await page(token, "/uploads", { kind: "insurance", file: pdf })).status).toBe(400);
    for (const name of ["photo.HEIC", "scan.jpg", "w9.png"]) {
      serve();
      expect((await page(token, "/uploads", { kind: "w9", file: { name, size: 10 } })).status).toBe(201);
    }

    // A file that arrives as something else is removed, not recorded.
    serve();
    const sent = (await (await page(token, "/uploads", { kind: "liability", file: pdf })).json()) as { path: string; files_token: string };
    const db = serve({ arrived: { [sent.path]: "text/html" } });
    expect((await page(token, "/files", { files_token: sent.files_token, expires_on: ends })).status).toBe(400);
    expect(db.calls.some((c) => c.path === "sub_documents")).toBe(false);
    expect(db.calls.find((c) => c.method === "DELETE" && c.url.pathname === "/storage/v1/object/files")?.body).toEqual({ prefixes: [sent.path] });
  });

  it("needs the date a certificate ends, not one already past or years away", async () => {
    const token = await tokenFor({ t: "sub", id: SUB });
    const today = new Date().toISOString().slice(0, 10); // the company in the stand-in has no time zone: UTC
    const record = async (kind: string, expires_on?: string | null) => {
      serve();
      const sent = (await (await page(token, "/uploads", { kind, file: pdf })).json()) as { path: string; files_token: string };
      const db = serve({ arrived: { [sent.path]: "application/pdf" } });
      const res = await page(token, "/files", { files_token: sent.files_token, ...(expires_on === undefined ? {} : { expires_on }) });
      return { status: res.status, body: (await res.json()) as { error?: string; added?: number }, db };
    };
    for (const kind of ["liability", "workers_comp"]) {
      for (const missing of [undefined, null]) {
        const { status, body, db } = await record(kind, missing);
        expect(status).toBe(400);
        expect(body.error).toBe("Enter the date it ends. It's on the certificate.");
        // Turned away before anything is looked up or recorded.
        expect(db.calls.some((c) => c.url.pathname.startsWith("/storage/") || c.path === "sub_documents")).toBe(false);
      }
    }
    expect((await record("liability", addDays(today, -1))).body.error).toBe("That date has already passed. Check it, or send the newer one.");
    expect((await record("workers_comp", addDays(today, 6 * 366))).body.error).toBe("Check the date it ends. It's more than five years away.");
    expect((await record("liability", today)).body).toEqual({ added: 1 });
    // An exemption may have no end date.
    const exempt = await record("wc_exemption", null);
    expect(exempt.body).toEqual({ added: 1 });
    expect(exempt.db.calls.find((c) => c.path === "sub_documents")!.body).toMatchObject({ kind: "wc_exemption", expires_on: null });
  });

  it("keeps a W-9 without an end date, and an upload to its own sub", async () => {
    const token = await tokenFor({ t: "sub", id: SUB });
    serve();
    const sent = (await (await page(token, "/uploads", { kind: "w9", file: pdf })).json()) as { path: string; files_token: string };
    const db = serve({ arrived: { [sent.path]: "application/pdf" } });
    expect(await (await page(token, "/files", { files_token: sent.files_token, expires_on: "2030-01-01" })).json()).toEqual({ added: 1 });
    expect(db.calls.find((c) => c.path === "sub_documents")!.body).toMatchObject({ kind: "w9", expires_on: null });

    // Another sub's link can't record this upload, and a changed token isn't one.
    serve({ sub: { ...apex, id: OTHER_SUB }, arrived: { [sent.path]: "application/pdf" } });
    expect((await page(await tokenFor({ t: "sub", id: OTHER_SUB }), "/files", { files_token: sent.files_token })).status).toBe(400);
    serve({ arrived: { [sent.path]: "application/pdf" } });
    expect((await page(token, "/files", { files_token: `${sent.files_token}x` })).status).toBe(400);
    const pageToken = await tokenFor({ t: "sub", id: SUB });
    expect((await page(token, "/files", { files_token: pageToken })).status).toBe(400);
  });

  it("limits uploads and records by visitor and by link", async () => {
    const token = await tokenFor({ t: "sub", id: SUB });
    const db = serve({ full: /^paperwork-upload:sub:/ });
    expect((await page(token, "/uploads", { kind: "liability", file: pdf })).status).toBe(429);
    expect(db.calls.some((c) => c.url.pathname.startsWith("/storage/"))).toBe(false);
    serve({ full: /^paperwork-files:ip:/ });
    expect((await page(token, "/files", { files_token: "x" })).status).toBe(429);
  });
});

describe("the office's link for a sub", () => {
  it("makes the link to copy, good for 30 days", async () => {
    serve();
    const res = await officeRequest(`/subs/${SUB}/upload-link`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { link: string; expires_at: string };
    expect(body.link).toMatch(/^https:\/\/ops\.example\.com\/paperwork\/.+/);
    expect(Math.round((Date.parse(body.expires_at) - Date.now()) / 86_400_000)).toBe(30);
    // The link opens the sub's page.
    serve();
    expect((await page(body.link.split("/paperwork/")[1]!)).status).toBe(200);
  });

  it("is only for owners, admins and office staff with the subs area", async () => {
    for (const role of ["estimator", "crew_lead", "field_crew"]) {
      const db = serve({ member: { role, role_id: null } });
      expect((await officeRequest(`/subs/${SUB}/upload-link`)).status).toBe(403);
      expect((await officeRequest(`/subs/${SUB}/send-upload-link`, { channels: ["email"] })).status).toBe(403);
      expect(db.calls.some((c) => c.path === "subcontractors")).toBe(false);
    }
    serve({ member: { role: "office", role_id: "role-1" }, custom: ["schedule", "job_costs"] });
    expect((await officeRequest(`/subs/${SUB}/upload-link`)).status).toBe(403);
    serve({ member: { role: "office", role_id: "role-1" }, custom: ["subs"] });
    expect((await officeRequest(`/subs/${SUB}/upload-link`)).status).toBe(200);
    serve({ member: { role: "admin", role_id: null } });
    expect((await officeRequest(`/subs/${SUB}/upload-link`)).status).toBe(200);
  });

  it("isn't made for a sub the office can't see, or one that's turned off", async () => {
    serve({ sub: null });
    expect((await officeRequest(`/subs/${SUB}/upload-link`)).status).toBe(404);
    serve({ sub: { ...apex, active: false } });
    expect((await officeRequest(`/subs/${SUB}/upload-link`)).status).toBe(400);
    serve();
    expect((await officeRequest("/subs/not-an-id/upload-link")).status).toBe(404);
  });

  it("emails and texts it to the sub, asking for what's missing or running out, and hands it back", async () => {
    const db = serve();
    const res = await officeRequest(`/subs/${SUB}/send-upload-link`, { channels: ["email", "sms"] });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { link: string; email: unknown; sms: unknown };
    expect(body).toMatchObject({ email: { sent: true, reason: null }, sms: { sent: true, reason: null } });
    const [email] = db.emails();
    expect(email).toMatchObject({ to: ["al@apex.test"], subject: "Paperwork for Uniform Roofing", reply_to: "office@uniform.test", from: "Crewtavo <noreply@example.com>" });
    expect(email.text).toContain("Hi Al,");
    expect(email.text).toContain("Please send us your W-9 and liability insurance.");
    expect(email.text).toContain(body.link);
    expect(db.texts()).toEqual([expect.objectContaining({ To: "+15405550101", From: "+15405550000" })]);
    expect(db.texts()[0]!.Body).toBe(`Uniform Roofing: Please send us your W-9 and liability insurance. You can upload them from your phone or computer here: ${body.link}`);
  });

  it("sends the office's own words when it writes them", async () => {
    const db = serve();
    const res = await officeRequest(`/subs/${SUB}/send-upload-link`, { channels: ["email", "sms"], message: "  Need your new COI before Monday.  " });
    const body = (await res.json()) as { link: string };
    const [email] = db.emails();
    expect(email.text).toBe(`Hi Al,\n\nNeed your new COI before Monday.\n\n${body.link}\n\nThe link works for 30 days.\n\nThanks,\nUniform Roofing`);
    expect(db.texts()[0]!.Body).toBe(`Uniform Roofing: Need your new COI before Monday. ${body.link}`);
    expect(JSON.stringify([email, db.texts()])).not.toContain("Please send us");
  });

  it("doesn't send to a sub that's turned off", async () => {
    const db = serve({ sub: { ...apex, active: false } });
    expect((await officeRequest(`/subs/${SUB}/send-upload-link`, { channels: ["email", "sms"] })).status).toBe(400);
    expect(db.emails()).toEqual([]);
    expect(db.texts()).toEqual([]);
  });

  it("still gives the link when the email provider fails", async () => {
    const db = serve({ emailDown: true });
    const res = await officeRequest(`/subs/${SUB}/send-upload-link`, { channels: ["email", "sms"] });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { link: string; email: { sent: boolean; reason: string | null }; sms: { sent: boolean } };
    expect(body.link).toContain("/paperwork/");
    expect(body.email.sent).toBe(false);
    expect(body.email.reason).toBeTruthy();
    expect(body.sms.sent).toBe(true);
    expect(db.texts()).toHaveLength(1);
  });

  it("says why when it can't send, and still gives the link", async () => {
    serve({ sub: { ...apex, email: null } });
    const noEmail = await (await officeRequest(`/subs/${SUB}/send-upload-link`, { channels: ["email"] })).json();
    expect(noEmail).toMatchObject({ link: expect.stringContaining("/paperwork/"), email: { sent: false, reason: "Add an email address for this sub first." }, sms: null });
    const noTexting = serve();
    const res = await app.request(
      `/api/subs/${SUB}/send-upload-link`,
      { method: "POST", headers: { Authorization: `Bearer ${session}`, "X-Company-Id": CO, "Content-Type": "application/json" }, body: JSON.stringify({ channels: ["sms"], message: "Need your new COI before Monday." }) },
      { ...env, TWILIO_ACCOUNT_SID: undefined },
    );
    expect(await res.json()).toMatchObject({ sms: { sent: false, reason: "Texting isn't set up. Copy the link and text it yourself." }, email: null });
    expect(noTexting.texts()).toEqual([]);
    serve();
    expect((await officeRequest(`/subs/${SUB}/send-upload-link`, { channels: [] })).status).toBe(400);
  });
});

describe("reminding subs before a certificate runs out", () => {
  const alert = (values: Partial<{ subcontractor_id: string; kind: string; expires_on: string; days_left: number; alert: string; remind_sub: boolean }> = {}) => ({
    company_id: CO, subcontractor_id: SUB, document_id: crypto.randomUUID(), kind: "liability", expires_on: "2026-11-24", days_left: 30, alert: "d30", remind_sub: true, ...values,
  });

  it("sends each sub one message about everything running out, by email and text, with their link", async () => {
    const db = serve();
    const counts = await remindSubs(env, adminClient(env), [
      alert(),
      alert({ kind: "workers_comp", expires_on: "2026-11-01", days_left: 7, alert: "d7" }),
      alert({ subcontractor_id: OTHER_SUB, remind_sub: false }),
    ]);
    expect(counts).toEqual({ subs: 1, email: 1, sms: 1, failed: 0 });
    expect(db.calls.find((c) => c.path === "subcontractors")?.url.searchParams.get("id")).toBe(`in.(${SUB})`);
    const [email] = db.emails();
    expect(email.subject).toBe("Your paperwork on file with Uniform Roofing");
    expect(email.text).toContain("Liability insurance ends Nov 24, 2026\nWorkers' comp certificate ends Nov 1, 2026");
    expect(email.text).toMatch(/Please send us the new ones here:\n\nhttps:\/\/ops\.example\.com\/paperwork\/\S+/);
    expect(db.texts()[0]!.Body).toMatch(/^Uniform Roofing: Liability insurance ends Nov 24, 2026, Workers' comp certificate ends Nov 1, 2026\. Please send us the new ones: https:\/\/ops\.example\.com\/paperwork\//);
  });

  it("says when one has run out, and doesn't text without texting set up", async () => {
    const db = serve();
    const counts = await remindSubs({ ...env, TWILIO_ACCOUNT_SID: undefined }, adminClient(env), [alert({ days_left: 0, alert: "expired", expires_on: "2026-10-25" })]);
    expect(counts).toEqual({ subs: 1, email: 1, sms: 0, failed: 0 });
    expect(db.emails()[0]!.subject).toBe("Your liability insurance on file with Uniform Roofing is running out");
    const lapsed = serve();
    await remindSubs(env, adminClient(env), [alert({ days_left: -2, alert: "expired", expires_on: "2026-10-23" })]);
    expect(lapsed.emails()[0]!.subject).toBe("Your liability insurance on file with Uniform Roofing has run out");
    expect(lapsed.emails()[0]!.text).toContain("Liability insurance ended Oct 23, 2026");
  });

  it("counts a sub there was no way to reach", async () => {
    const db = serve({ sub: { ...apex, email: null } });
    expect(await remindSubs({ ...env, TWILIO_ACCOUNT_SID: undefined }, adminClient(env), [alert()])).toEqual({ subs: 1, email: 0, sms: 0, failed: 1 });
    expect(db.texts()).toEqual([]);
  });

  it("sends nothing when no sub is to be reminded, or there's no address for the link", async () => {
    const none = serve();
    expect(await remindSubs(env, adminClient(env), [alert({ remind_sub: false })])).toEqual({ subs: 0, email: 0, sms: 0, failed: 0 });
    expect(await remindSubs({ ...env, APP_URL: undefined }, adminClient(env), [alert()])).toEqual({ subs: 0, email: 0, sms: 0, failed: 0 });
    expect(none.calls).toEqual([]);
  });
});
