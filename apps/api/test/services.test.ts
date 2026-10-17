/**
 * Background work and integrations against a stand-in for PostgREST and the providers: fetch is
 * stubbed, and each test answers the requests it expects. (What the database itself does, such as
 * claiming campaign recipients, is tested in supabase/tests.)
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { app } from "../src/app";
import type { Env } from "../src/env";
import { signToken } from "../src/lib/crypto";
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
