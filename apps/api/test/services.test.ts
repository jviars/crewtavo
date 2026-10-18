/**
 * Background work and integrations against a stand-in for PostgREST and the providers: fetch is
 * stubbed, and each test answers the requests it expects. (What the database itself does, such as
 * claiming campaign recipients, is tested in supabase/tests.)
 */
import net from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { app } from "../src/app";
import type { Env } from "../src/env";
import { encryptJson, signToken } from "../src/lib/crypto";
import { clientLink } from "../src/lib/links";
import { sendWithMailbox } from "../src/lib/notify";
import { adminClient } from "../src/lib/supabase";
import { zohoAccountsServer, zohoApiDomain } from "../src/integrations/registry";
import { processCampaigns } from "../src/services/campaigns";
import { sendReviewRequest } from "../src/services/reviews";
import { runTask } from "../src/tasks";

const env: Env = {
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
  SUPABASE_SECRET_KEY: "sb_secret_test",
  ENCRYPTION_KEY: btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => i * 7))),
  APP_URL: "https://ops.example.com",
  RESEND_API_KEY: "re_test",
  EMAIL_FROM: "Crewtavo <noreply@example.com>",
};

interface Call {
  method: string;
  url: URL;
  /** The table or rpc/<name> for PostgREST calls. */
  path: string;
  body: any;
  signal?: AbortSignal | null;
}

/** Stub fetch: `answer` returns a Response, or rows to send back as JSON. */
function serve(answer: (call: Call) => Response | unknown) {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const text = typeof init?.body === "string" ? init.body : init?.body ? String(init.body) : "";
    let body: unknown = text;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      // form bodies stay text
    }
    const call: Call = { method: (init?.method ?? "GET").toUpperCase(), url, path: url.pathname.replace(/^\/rest\/v1\//, ""), body, signal: init?.signal };
    calls.push(call);
    const out = answer(call);
    return out instanceof Response ? out : Response.json(out ?? []);
  });
  return calls;
}
const counted = (n: number) => new Response(null, { status: 200, headers: { "Content-Range": `*/${n}` } });

afterEach(() => vi.unstubAllGlobals());

describe("campaign sending", () => {
  const campaign = { id: "camp-1", company_id: "co-1", subject: "Fall cleanup", body: "Hi {{client.first_name}}, leaves are coming.", company: { name: "Acme Lawn Care, LLC", email: null, phone: null, address: {} } };
  const recipients = [1, 2, 3].map((id) => ({ id, campaign_id: "camp-1", company_id: "co-1", client_id: `client-${id}`, email: `person${id}@example.com`, name: `Person ${id}`, status: "sending" }));

  /** One campaign with three claimed recipients; `onEmail` can change things as each email goes. */
  function run(options: { optedOut?: string[]; onEmail?: (count: number, state: { status: string }) => Response | void } = {}) {
    const state = { status: "sending", emails: [] as string[], claims: 0 };
    const calls = serve((call) => {
      if (call.url.host === "api.resend.com") {
        state.emails.push(call.body.to[0]);
        return options.onEmail?.(state.emails.length, state) ?? Response.json({ id: `email-${state.emails.length}` });
      }
      if (call.path === "rpc/claim_campaign_recipients") return state.claims++ ? [] : recipients;
      if (call.method === "GET" && call.path === "campaigns") return call.url.searchParams.get("select") === "status" ? [{ status: state.status }] : [campaign];
      if (call.method === "GET" && call.path === "clients") return [{ marketing_opt_out: (options.optedOut ?? []).includes(call.url.searchParams.get("id")!.slice(3)) }];
      if (call.method === "HEAD") return counted(0);
      return [];
    });
    const updates = () =>
      calls.filter((c) => c.method === "PATCH" && c.path === "campaign_recipients").map((c) => ({ id: c.url.searchParams.get("id"), status: c.url.searchParams.get("status"), body: c.body }));
    return { state, calls, updates, done: processCampaigns(env, { campaignId: "camp-1", baseUrl: "https://ops.example.com" }) };
  }

  it("claims its batch instead of reading pending recipients, so overlapping runs don't send twice", async () => {
    const { calls, done } = run();
    expect(await done).toMatchObject({ sent: 3 });
    expect(calls.find((c) => c.path === "rpc/claim_campaign_recipients")?.body).toEqual({ p_campaign: "camp-1", p_limit: 25 });
    expect(calls.some((c) => c.method === "GET" && c.path === "campaign_recipients")).toBe(false);
  });

  it("doesn't email people who unsubscribed after Send", async () => {
    const { state, updates, done } = run({ optedOut: ["client-2"] });
    expect(await done).toMatchObject({ sent: 2, skipped: 1 });
    expect(state.emails).toEqual(["person1@example.com", "person3@example.com"]);
    expect(updates()).toContainEqual({ id: "in.(2)", status: "eq.sending", body: { status: "skipped", error: "Unsubscribed" } });
  });

  it("stops partway through a batch when the campaign is stopped", async () => {
    const { state, updates, done } = run({
      onEmail: (count, s) => {
        if (count === 1) s.status = "cancelled"; // Stop pressed while the first email went out
      },
    });
    expect(await done).toMatchObject({ sent: 1, skipped: 2 });
    expect(state.emails).toEqual(["person1@example.com"]);
    expect(updates()).toContainEqual({ id: "in.(2,3)", status: "eq.sending", body: { status: "skipped", error: "Campaign stopped" } });
  });

  it("puts the rest of the batch back when the provider rate limits", async () => {
    const { updates, done } = run({ onEmail: (count) => (count === 2 ? Response.json({ message: "Too many requests" }, { status: 429 }) : undefined) });
    expect(await done).toMatchObject({ sent: 1, failed: 0 });
    expect(updates()).toContainEqual({ id: "in.(2,3)", status: "eq.sending", body: { status: "pending", claimed_at: null } });
  });
});

describe("sender names", () => {
  it("quotes the company name for Resend, so a comma doesn't make two senders", async () => {
    const calls = serve(() => Response.json({ id: "email-1" }));
    const settings = { preset: "resend", kind: "resend" as const, from_email: "office@acme.example", from_name: 'Acme Lawn Care, LLC "Pros"' };
    const result = await sendWithMailbox(settings, { api_key: "re_company" }, { to: "ana@example.com", subject: "Hi", text: "Hello" });
    expect(result).toEqual({ sent: true, id: "email-1" });
    expect(calls[0]!.body.from).toBe('"Acme Lawn Care, LLC \\"Pros\\"" <office@acme.example>');
    expect(calls[0]!.signal).toBeInstanceOf(AbortSignal);
  });

  it("treats a provider that doesn't answer in time like one that can't be reached", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    });
    const settings = { preset: "resend", kind: "resend" as const, from_email: "office@acme.example" };
    expect(await sendWithMailbox(settings, { api_key: "re_company" }, { to: "ana@example.com", subject: "Hi", text: "Hello" })).toEqual({
      sent: false,
      reason: "Couldn't reach the email provider. Try again.",
    });
  });
});

describe("weather holds", () => {
  const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  const visit = { id: "visit-1", scheduled_on: tomorrow, hold_reason: "80% chance of rain", job: { weather_rules: [{ max_rain_pct: 50 }] }, property: { lat: 37.13, lng: -80.41 } };
  const forecast = (rain: number) => ({ daily: { time: [tomorrow], temperature_2m_min: [55], temperature_2m_max: [70], precipitation_probability_max: [rain] } });

  it("leaves holds alone when the forecast can't be fetched", async () => {
    const calls = serve((call) => (call.url.host === "api.open-meteo.com" ? Response.json({ reason: "Too many requests" }, { status: 429 }) : call.path === "visits" ? [visit] : []));
    expect(await runTask("weather", env)).toMatchObject({ checked: 1, flagged: 0, unknown: 1 });
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
    expect(calls.find((c) => c.url.host === "api.open-meteo.com")?.signal).toBeInstanceOf(AbortSignal);
  });

  it("still clears a hold when the forecast says the weather is fine", async () => {
    const calls = serve((call) => (call.url.host === "api.open-meteo.com" ? forecast(10) : call.method === "GET" && call.path === "visits" ? [visit] : []));
    await runTask("weather", env);
    expect(calls.filter((c) => c.method === "PATCH").map((c) => [c.url.searchParams.get("id"), c.body])).toEqual([["eq.visit-1", { hold_reason: null }]]);
  });
});

describe("review requests", () => {
  it("asks again when the last request within the window failed to send", async () => {
    const calls = serve((call) => {
      if (call.url.host === "api.resend.com") return Response.json({ id: "email-1" });
      if (call.path === "companies") return [{ name: "Acme", phone: null, email: null, settings: { review_url: "https://g.page/r/acme" } }];
      // The only request in the last 30 days failed.
      if (call.method === "HEAD" && call.path === "review_requests") return counted(call.url.searchParams.get("status") === "neq.failed" ? 0 : 1);
      if (call.method === "POST" && call.path === "review_requests") return Response.json({ id: "rr-2" });
      return [];
    });
    const result = await sendReviewRequest(env, adminClient(env), {
      companyId: "co-1",
      client: { id: "client-1", display_name: "Ana Smith", email: "ana@example.com", phone: null },
      channel: "email",
      baseUrl: "https://ops.example.com",
      skipIfRecentDays: 30,
      createdBy: null,
    });
    expect(result).toMatchObject({ sent: true, id: "rr-2" });
    expect(calls.some((c) => c.url.host === "api.resend.com")).toBe(true);
  });
});

describe("Zoho data centers", () => {
  it("accepts only Zoho's own accounts and API servers over https", () => {
    expect(zohoAccountsServer("https://accounts.zoho.eu")).toBe("https://accounts.zoho.eu");
    expect(zohoAccountsServer("https://accounts.zoho.com.au/")).toBe("https://accounts.zoho.com.au");
    expect(zohoAccountsServer("https://accounts.zohocloud.ca")).toBe("https://accounts.zohocloud.ca");
    for (const bad of ["https://attacker.example", "http://accounts.zoho.com", "https://accounts.zoho.com.attacker.example", "https://accounts.zoho.com:8443", "https://x@accounts.zoho.com", "not a url", "https://www.zohoapis.com"]) {
      expect(() => zohoAccountsServer(bad), bad).toThrow("isn't Zoho's");
    }
    expect(zohoApiDomain("https://www.zohoapis.in")).toBe("https://www.zohoapis.in");
    expect(zohoApiDomain(undefined)).toBe("https://www.zohoapis.com");
    for (const bad of ["http://169.254.169.254/latest/meta-data", "https://www.zohoapis.com.attacker.example", "http://www.zohoapis.com", "https://accounts.zoho.com"]) {
      expect(() => zohoApiDomain(bad), bad).toThrow("isn't one of Zoho's");
    }
  });

  const zohoEnv: Env = { ...env, ZOHO_CLIENT_ID: "zoho-client", ZOHO_CLIENT_SECRET: "zoho-secret" };
  async function callback(query: Record<string, string>) {
    const state = await signToken(zohoEnv, { company: "co-1", user: "user-1", provider: "zoho_books", nonce: "nonce-1", exp: Math.floor(Date.now() / 1000) + 600 });
    const res = await app.request(`/api/apps/zoho_books/callback?${new URLSearchParams({ code: "code-1", state, ...query })}`, { headers: { Cookie: "crewtavo_oauth_nonce=nonce-1" } }, zohoEnv);
    expect(res.status).toBe(302);
    return new URL(res.headers.get("Location")!).searchParams;
  }

  it("never sends the client secret to an accounts server that isn't Zoho's", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const calls = serve(() => ({}));
    const result = await callback({ "accounts-server": "https://attacker.example" });
    expect(calls).toEqual([]);
    expect(result.get("status")).toBe("error");
    expect(result.get("message")).toContain("isn't Zoho's");
  });

  it("refuses an API domain that isn't Zoho's before calling it", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const calls = serve((call) => (call.url.pathname === "/oauth/v2/token" ? { access_token: "token-1", refresh_token: "refresh-1", api_domain: "http://169.254.169.254" } : []));
    const result = await callback({ "accounts-server": "https://accounts.zoho.eu" });
    expect(calls.map((c) => c.url.origin)).toEqual(["https://accounts.zoho.eu"]);
    expect(calls[0]!.signal).toBeInstanceOf(AbortSignal);
    expect(result.get("status")).toBe("error");
    expect(result.get("message")).toContain("isn't one of Zoho's");
  });
});

describe("calendar feed queries", () => {
  it("reads a crew member's visits through their assignments in the feed's dates, a page at a time", async () => {
    const token = "a".repeat(43);
    const visit = (n: number) => ({ visit: { id: `visit-${String(n).padStart(4, "0")}`, title: `Mow ${n}`, status: "scheduled", scheduled_on: "2026-11-02", starts_at: null, ends_at: null, notes: null, updated_at: null, crew: null, job: null, property: null } });
    const calls = serve((call) => {
      if (call.path === "calendar_feeds" && call.method === "GET") return [{ id: "feed-1", company_id: "co-1", user_id: "user-1", scope: "mine", last_used_at: new Date().toISOString() }];
      if (call.path === "memberships") return [{ role: "field_crew" }];
      if (call.path === "companies") return Response.json({ name: "Acme", timezone: "America/New_York" });
      if (call.path === "visit_assignees") {
        const offset = Number(call.url.searchParams.get("offset") ?? 0);
        return Array.from({ length: offset === 0 ? 1000 : 5 }, (_, i) => visit(offset + i));
      }
      return [];
    });
    const res = await app.request(`/api/calendar/${token}.ics`, {}, env);
    expect(res.status).toBe(200);
    expect((await res.text()).split("BEGIN:VEVENT").length - 1).toBe(1005);
    const pages = calls.filter((c) => c.path === "visit_assignees").map((c) => c.url.searchParams);
    expect(pages.map((p) => [p.get("offset"), p.get("limit")])).toEqual([["0", "1000"], ["1000", "1000"]]);
    expect(pages[0]!.get("select")).toMatch(/^visit:visits!inner\(/);
    expect(pages[0]!.get("visit.scheduled_on")).toMatch(/^gte\./);
    expect(pages[0]!.getAll("visit.scheduled_on")[1]).toMatch(/^lte\./);
    expect(pages[0]!.get("order")).toBe("visit_id.asc");
    // No list of visit ids in a URL, however many visits someone has had.
    expect(calls.every((c) => !c.url.search.includes("id.in."))).toBe(true);
  });
});

describe("sign-in links", () => {
  /**
   * Ana is in one company, whose own mailbox is in `status`: Resend with the company's key, which
   * `companySends` says still works, or else the mail server on `smtpPort`. As in GoTrue, Supabase's
   * mailer won't send to her right after a link was made. Returns the emails that went out.
   */
  async function emailLink(options: { status: string; companySends?: boolean; smtpPort?: number; env?: Env }) {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const companyId = crypto.randomUUID(); // mailboxes are cached by company
    const mailbox = options.smtpPort
      ? { settings: { preset: "custom", kind: "smtp", host: "127.0.0.1", port: options.smtpPort, security: "tls", username: "office@acme.example", from_email: "office@acme.example" }, secret: { password: "app-password" } }
      : { settings: { preset: "resend", kind: "resend", from_email: "office@acme.example" }, secret: { api_key: "re_company" } };
    const ciphertext = await encryptJson(env, mailbox.secret);
    const calls = serve((call) => {
      if (call.path === "rpc/rate_limit_hit") return true;
      if (call.path === "rpc/user_id_for_email") return "user-1";
      if (call.path === "memberships") return [{ company_id: companyId, company: { name: "Acme Lawn Care", email: "office@acme.example" } }];
      if (call.method === "GET" && call.path === "integrations") return [{ status: options.status, settings: mailbox.settings }];
      if (call.path === "integration_secrets") return [{ ciphertext }];
      if (call.url.pathname === "/auth/v1/admin/generate_link") return { id: "user-1", email: "ana@example.com", hashed_token: "hashed-1", verification_type: "recovery" };
      if (call.url.pathname === "/auth/v1/recover") {
        const linked = calls.some((c) => c.url.pathname === "/auth/v1/admin/generate_link");
        return linked ? Response.json({ code: 429, error_code: "over_email_send_rate_limit", msg: "For security purposes, you can only request this after 59 seconds." }, { status: 429 }) : {};
      }
      if (call.url.host === "api.resend.com") {
        const fromCompany = call.body.from.includes("office@acme.example");
        return fromCompany && !options.companySends ? Response.json({ message: "API key is invalid" }, { status: 403 }) : Response.json({ id: "email-1" });
      }
      return [];
    });
    const res = await app.request("/api/auth/email-link", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "ana@example.com", kind: "recovery" }) }, options.env ?? env);
    expect(await res.json()).toEqual({ sent: true });
    const emails = calls.filter((c) => c.url.host === "api.resend.com").map((c) => ({ from: c.body.from as string, link: (c.body.text as string).includes("token_hash=hashed-1") }));
    return { emails, calls };
  }
  const company = '"Acme Lawn Care" <office@acme.example>';
  const server = "Crewtavo <noreply@example.com>";
  const noServerEmail = { ...env, RESEND_API_KEY: undefined, EMAIL_FROM: undefined };

  it("go out from the company's mailbox while it works", async () => {
    expect((await emailLink({ status: "connected", companySends: true })).emails).toEqual([{ from: company, link: true }]);
    expect((await emailLink({ status: "connected", companySends: true, env: noServerEmail })).emails).toEqual([{ from: company, link: true }]);
  });

  it("skip a company mailbox whose sign-in failed and use the server's email", async () => {
    expect((await emailLink({ status: "error", companySends: true })).emails).toEqual([{ from: server, link: true }]);
  });

  it("go out from the server's email when the company mailbox fails", async () => {
    expect((await emailLink({ status: "connected", companySends: false })).emails).toEqual([{ from: company, link: true }, { from: server, link: true }]);
  });

  it("without the server's email, check the mailbox signs in before making a link, and else use Supabase's mailer", async () => {
    const closed = net.createServer(); // a mail server that's gone
    await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
    const smtpPort = (closed.address() as net.AddressInfo).port;
    await new Promise((resolve) => closed.close(resolve));
    const { calls } = await emailLink({ status: "connected", smtpPort, env: noServerEmail });
    // No link first: that would have kept Supabase's mailer from sending.
    expect(calls.some((c) => c.url.pathname === "/auth/v1/admin/generate_link")).toBe(false);
    expect(calls.find((c) => c.url.pathname === "/auth/v1/recover")?.body).toMatchObject({ email: "ana@example.com" });
  });

  it("without the server's email, set aside a mailbox whose Resend key is refused, so the next link skips it", async () => {
    const { emails, calls } = await emailLink({ status: "connected", companySends: false, env: noServerEmail });
    expect(emails).toEqual([{ from: company, link: true }]);
    // Supabase's mailer would refuse right after the link, so it isn't asked.
    expect(calls.some((c) => c.url.pathname === "/auth/v1/recover")).toBe(false);
    expect(calls.find((c) => c.method === "PATCH" && c.path === "integrations")?.body).toEqual({ status: "error", last_error: "The email provider refused it (403: API key is invalid)." });
  });
});

describe("public submissions", () => {
  /** The database for one company's forms; rate limits whose key matches `full` are used up. */
  function database(options: { full?: RegExp } = {}) {
    const calls = serve((call) => {
      if (call.path === "rpc/rate_limit_hit") return !options.full?.test(call.body.p_key);
      if (call.path === "companies") return [{ id: "co-1", name: "Acme Lawn Care", phone: null, timezone: "America/New_York", settings: {} }];
      if (call.path === "intake_forms") return [{ id: "form-1", name: "Request a quote", kind: "request", questions: [], service_area_zips: [], lead_time_days: 0, slot_minutes: null }];
      if (call.method === "GET" && call.path === "clients") return [{ id: "client-1", display_name: "Ana Smith" }];
      if (call.method === "POST" && call.path === "clients") return Response.json({ id: "client-2" }, { status: 201 });
      if (call.method === "POST" && call.path === "properties") return Response.json({ id: "property-2" }, { status: 201 });
      if (call.method === "POST" && call.path === "requests") return Response.json({ id: "request-2", number: 1042 }, { status: 201 });
      return [];
    });
    const made = () => calls.filter((c) => c.method === "POST" && ["clients", "properties", "requests", "referrals"].includes(c.path)).map((c) => c.path);
    const limits = () => calls.filter((c) => c.path === "rpc/rate_limit_hit").map((c) => [c.body.p_key, c.body.p_max, c.body.p_window_seconds]);
    return { calls, made, limits };
  }
  const post = (path: string, body: unknown) =>
    app.request(`/api${path}`, { method: "POST", headers: { "Content-Type": "application/json", "X-Real-IP": "203.0.113.9" }, body: JSON.stringify(body) }, env);
  const lead = { name: "Bob Jones", email: "bob@example.com", address: { line1: "12 Main St", city: "Radford", postal_code: "24141" } };
  const token = async (t: "refer" | "client" | "quote", id: string) => (await clientLink(env, "https://ops.example.com", { c: "co-1", t, id })).split(/\/(?:refer|hub)\//)[1]!;

  it("limits booking forms per visitor and per company, before anything is made", async () => {
    const ok = database();
    expect((await post("/public/forms/acme/quote", lead)).status).toBe(201);
    expect(ok.limits()).toEqual([["form:ip:203.0.113.9", 10, 3600], ["form:company:co-1", 100, 3600]]);
    expect(ok.made()).toEqual(["clients", "properties", "requests"]);

    for (const full of [/^form:ip:/, /^form:company:/]) {
      const limited = database({ full });
      const res = await post("/public/forms/acme/quote", lead);
      expect(res.status).toBe(429);
      expect(await res.json()).toEqual({ error: "Too many requests. Try again later, or call us." });
      expect(limited.made()).toEqual([]);
      // No address lookup either.
      expect(limited.calls.every((c) => c.url.host === "example.supabase.co")).toBe(true);
    }
  });

  it("keeps booking form answers to the size and shape of real ones", async () => {
    const answers = { details: "Front and back yard", extras: ["Edging", "Leaf pickup"], acres: 2, gate: true };
    const ok = database();
    expect((await post("/public/forms/acme/quote", { ...lead, answers })).status).toBe(201);
    expect(ok.calls.find((c) => c.method === "POST" && c.path === "requests")?.body.answers).toEqual(answers);

    const tooMany = Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`q${i}`, "yes"]));
    const bulky = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`q${i}`, "x".repeat(3000)]));
    for (const bad of [{ details: "x".repeat(4001) }, { details: { nested: "object" } }, { extras: Array(51).fill("Edging") }, tooMany, bulky]) {
      const db = database();
      expect((await post("/public/forms/acme/quote", { ...lead, answers: bad })).status).toBe(400);
      expect(db.made()).toEqual([]);
    }
  });

  it("limits referrals per visitor and per company", async () => {
    const path = `/public/refer/${await token("refer", "client-1")}`;
    const ok = database();
    expect((await post(path, lead)).status).toBe(201);
    expect(ok.limits()).toEqual([["referral:ip:203.0.113.9", 10, 3600], ["referral:company:co-1", 100, 3600]]);

    const limited = database({ full: /^referral:company:/ });
    expect((await post(path, lead)).status).toBe(429);
    expect(limited.made()).toEqual([]);
  });

  it("limits work requests from the Client Hub, and counts their promo codes with other promo checks", async () => {
    const path = `/hub/${await token("client", "client-1")}/request`;
    const ok = database();
    expect((await post(path, { title: "Gutter cleaning", promo_code: "spring10" })).status).toBe(201);
    expect(ok.limits()).toEqual([["hub-request:ip:203.0.113.9", 10, 3600], ["hub-request:company:co-1", 100, 3600], ["promo:203.0.113.9", 10, 600]]);
    expect(ok.calls.find((c) => c.path === "requests")?.body.promo_code).toBe("SPRING10");

    for (const full of [/^hub-request:/, /^promo:/]) {
      const limited = database({ full });
      expect((await post(path, { title: "Gutter cleaning", promo_code: "SPRING10" })).status).toBe(429);
      // Whether the code is real isn't checked (or given away), and nothing is made.
      expect(limited.calls.some((c) => c.path === "rpc/check_promo_code")).toBe(false);
      expect(limited.made()).toEqual([]);
    }
  });
});

describe("quote approval", () => {
  it("records the amounts the client approved, with the options they picked", async () => {
    const option = crypto.randomUUID();
    const calls = serve((call) => {
      const picked = calls.some((c) => c.method === "PATCH" && c.path === "quote_line_items" && c.body.selected === true);
      if (call.method === "GET" && call.path === "quotes") {
        if (call.url.searchParams.get("select") === "id,status") return [{ id: "quote-1", status: "sent" }];
        // The database's totals follow the lines picked.
        return [picked ? { subtotal: 1450, discount_amount: 100, tax_amount: 70.2, total: 1420.2 } : { subtotal: 1200, discount_amount: 100, tax_amount: 57.2, total: 1157.2 }];
      }
      if (call.method === "GET" && call.path === "quote_line_items") return [{ id: option }];
      if (call.method === "PATCH" && call.path === "quotes") return [{ id: "quote-1" }];
      return [];
    });
    const quote = (await clientLink(env, "https://ops.example.com", { c: "co-1", t: "quote", id: "quote-1" })).split("/hub/")[1];
    const res = await app.request(
      `/api/hub/${quote}/approve`,
      { method: "POST", headers: { "Content-Type": "application/json", "X-Real-IP": "203.0.113.9" }, body: JSON.stringify({ name: "Ana Smith", selected_line_ids: [option] }) },
      env,
    );
    expect(await res.json()).toEqual({ status: "approved" });
    expect(calls.find((c) => c.method === "PATCH" && c.path === "quotes")?.body.approval).toMatchObject({
      name: "Ana Smith", selected_line_ids: [option], subtotal: 1450, discount_amount: 100, tax_amount: 70.2, total: 1420.2, ip: "203.0.113.9",
    });
  });
});
