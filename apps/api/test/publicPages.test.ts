/**
 * The business's privacy policy link (companies.settings.privacy_url) on the pages its clients and
 * the public use: the booking form, the referral page, the unsubscribe page and a website form's
 * own pages each get it when it's set, as a plain web address, and nothing when it isn't. And the
 * referral page tells the friend when the person recommending gets a credit. Those three pages also
 * get the business's brand color and logo, so they wear its look rather than Crewtavo's.
 * PostgREST is a stand-in answering over fetch.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { app } from "../src/app";
import { clientLink } from "../src/lib/links";
import { formPage } from "../src/services/websiteForms";

const env: Env = {
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
  SUPABASE_SECRET_KEY: "sb_secret_test",
  ENCRYPTION_KEY: btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => i * 7))),
  APP_URL: "https://ops.example.com",
};
const CO = "00000000-0000-4000-8000-0000000000c1";
const ANA = "00000000-0000-4000-8000-0000000000a1";
const POLICY = "https://acme.example/privacy";

type Row = Record<string, unknown>;

/** A company whose settings carry `privacy_url` as given, a booking form and a client. */
function world(privacy_url?: unknown) {
  const tables: Record<string, Row[]> = {
    companies: [{ id: CO, slug: "acme", name: "Acme Lawn", phone: "555-0100", website: null, timezone: "America/New_York", settings: privacy_url === undefined ? {} : { privacy_url } }],
    intake_forms: [{ id: "form-1", name: "Request a quote", kind: "request", questions: [], service_area_zips: [], lead_time_days: 0, slot_minutes: null, max_per_day: null, requires_approval: false, pick_time: false, crew_id: null }],
    clients: [{ id: ANA, company_id: CO, display_name: "Ana Smith", marketing_opt_out: false, links_reset_at: null }],
  };
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = url.pathname.replace(/^\/rest\/v1\//, "");
    if (path.startsWith("rpc/")) return Response.json(true);
    return Response.json((init?.method ?? "GET") === "GET" ? (tables[path] ?? []) : []);
  });
}
const tokenOf = (link: string) => link.split("/").pop()!;
const get = async (path: string) => (await app.request(`/api${path}`, {}, env)).json() as Promise<Record<string, any>>;

afterEach(() => vi.unstubAllGlobals());

describe("a referral page", () => {
  it("says the person recommending gets a credit when the business gives one, and nothing when it doesn't", async () => {
    const refer = tokenOf(await clientLink(env, env.APP_URL!, { c: CO, t: "refer", id: ANA }));
    const settings = (referrals: Row) => {
      world();
      const stub = globalThis.fetch;
      vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith("/companies")) return Response.json([{ id: CO, name: "Acme Lawn", phone: null, website: null, settings: { referrals } }]);
        return stub(input, init);
      });
    };
    settings({ reward: { kind: "amount", value: 50 }, offer: "10% off your first service" });
    expect(await get(`/public/refer/${refer}`)).toMatchObject({ referrer: "Ana", offer: "10% off your first service", disclosure: "Ana gets a credit from Acme Lawn if you become a client." });
    settings({ reward: { kind: "percent", value: 10 } });
    expect((await get(`/public/refer/${refer}`)).disclosure).toBe("Ana gets a credit from Acme Lawn if you become a client.");
    // An offer for the friend alone: the client who shares gets nothing, so there's nothing to say.
    settings({ offer: "10% off your first service" });
    expect(await get(`/public/refer/${refer}`)).toMatchObject({ offer: "10% off your first service", disclosure: null });
  });
});

describe("the business's own look", () => {
  /** The company with a brand color and a logo saved in its branding, or `branding` as given. */
  const branded = (branding: unknown) => {
    world();
    const stub = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/companies")) return Response.json([{ id: CO, slug: "acme", name: "Acme Lawn", phone: "555-0100", website: null, timezone: "America/New_York", settings: { branding } }]);
      return stub(input, init);
    });
  };

  it("goes to the booking form, the referral page and the unsubscribe page: its brand color and logo", async () => {
    branded({ color: "#1d6b66", logo: `${CO}/logo/00000000-0000-4000-8000-00000000106f.png` });
    const refer = tokenOf(await clientLink(env, env.APP_URL!, { c: CO, t: "refer", id: ANA }));
    const unsub = tokenOf(await clientLink(env, env.APP_URL!, { c: CO, t: "unsub", id: ANA }));
    for (const page of [(await get("/public/forms/acme/quote")).company, (await get(`/public/refer/${refer}`)).company, await get(`/public/unsubscribe/${unsub}`)]) {
      expect(page.color).toBe("#1d6b66");
      expect(page.logo).toMatch(/^\/api\/public\/logo\//);
    }
  });

  it("is null without one, or with something saved that isn't a hex color, so the page falls back", async () => {
    for (const branding of [undefined, {}, { color: "teal" }, { color: "#12345" }, { color: 42 }]) {
      branded(branding);
      const refer = tokenOf(await clientLink(env, env.APP_URL!, { c: CO, t: "refer", id: ANA }));
      const unsub = tokenOf(await clientLink(env, env.APP_URL!, { c: CO, t: "unsub", id: ANA }));
      const form = (await get("/public/forms/acme/quote")).company;
      expect([form.color, form.logo], JSON.stringify(branding)).toEqual([null, null]);
      expect((await get(`/public/refer/${refer}`)).company.color, JSON.stringify(branding)).toBeNull();
      expect((await get(`/public/unsubscribe/${unsub}`)).color, JSON.stringify(branding)).toBeNull();
    }
  });
});

describe("the business's privacy policy link", () => {
  it("goes to the booking form, the referral page and the unsubscribe page when it's set", async () => {
    world(POLICY);
    expect((await get("/public/forms/acme/quote")).company.privacy_url).toBe(POLICY);
    const refer = await clientLink(env, env.APP_URL!, { c: CO, t: "refer", id: ANA });
    expect((await get(`/public/refer/${tokenOf(refer)}`)).company.privacy_url).toBe(POLICY);
    const unsub = await clientLink(env, env.APP_URL!, { c: CO, t: "unsub", id: ANA });
    expect(await get(`/public/unsubscribe/${tokenOf(unsub)}`)).toEqual({ company: "Acme Lawn", logo: null, color: null, unsubscribed: false, privacy_url: POLICY });
  });

  it("isn't there for a business that set none, or saved something that isn't a web address", async () => {
    for (const saved of [undefined, "", "   ", "javascript:alert(1)", "privacy policy", "ftp://acme.example/privacy", 42, { href: POLICY }]) {
      world(saved);
      expect((await get("/public/forms/acme/quote")).company.privacy_url, JSON.stringify(saved)).toBeNull();
      const unsub = await clientLink(env, env.APP_URL!, { c: CO, t: "unsub", id: ANA });
      expect((await get(`/public/unsubscribe/${tokenOf(unsub)}`)).privacy_url, JSON.stringify(saved)).toBeNull();
    }
  });

  it("is under a website form's own pages, opening in a new tab", () => {
    const page = formPage({ title: "Thanks!", heading: "Thanks! Your message was sent.", text: "Acme Lawn will get back to you soon.", company: { name: "Acme Lawn", logo: null, privacy_url: `${POLICY}?a=1&b="2"` } });
    expect(page).toContain('<p class="foot"><a href="https://acme.example/privacy?a=1&amp;b=&quot;2&quot;" target="_blank" rel="noopener noreferrer">Privacy policy</a></p>');
    expect(formPage({ title: "Thanks!", heading: "Thanks!", text: "Soon.", company: { name: "Acme Lawn", logo: null, privacy_url: null } })).not.toContain("Privacy policy");
    expect(formPage({ title: "Not found", heading: "This form isn't here", text: "It may have moved." })).not.toContain("Privacy policy");
  });
});
