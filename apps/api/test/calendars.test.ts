import { afterEach, describe, expect, it, vi } from "vitest";
import { app } from "../src/app";
import type { Env } from "../src/env";
import { CalendarError, fetchIcs, googleEventId, normalizeLink } from "../src/integrations/calendars";
import { CATALOG, OAUTH } from "../src/integrations/registry";

const env: Env = {
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
  SUPABASE_SECRET_KEY: "sb_secret_test",
  ENCRYPTION_KEY: btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => i * 7))),
  APP_URL: "https://ops.example.com",
};

const CALENDAR = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n";

describe("calendar links", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("tidies pasted links", () => {
    expect(normalizeLink(" webcal://p01-caldav.icloud.com/published/2/abc ").toString()).toBe("https://p01-caldav.icloud.com/published/2/abc");
    expect(normalizeLink("calendar.zoho.com/ical/xyz#top").toString()).toBe("https://calendar.zoho.com/ical/xyz");
    expect(() => normalizeLink("ftp://example.com/cal.ics")).toThrow(CalendarError);
    expect(() => normalizeLink("not a link at all")).toThrow(CalendarError);
  });

  it("never fetches this server, its network or cloud metadata", async () => {
    const fetched = vi.fn();
    vi.stubGlobal("fetch", fetched);
    for (const link of [
      "http://localhost:8080/api/calendar/x.ics",
      "http://127.0.0.1/cal.ics",
      "http://10.0.0.5/cal.ics",
      "http://169.254.169.254/latest/meta-data",
      "http://[::1]/cal.ics",
      "http://[::ffff:7f00:1]/cal.ics",
      "http://supabase.internal/cal.ics",
    ]) {
      await expect(fetchIcs(link), link).rejects.toThrow(/private address/);
    }
    expect(fetched).not.toHaveBeenCalled();
  });

  it("checks every redirect too", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 302, headers: { location: "http://192.168.1.10/cal.ics" } })));
    await expect(fetchIcs("https://203.0.113.7/cal.ics")).rejects.toThrow(/private address/);
  });

  it("reads a calendar and explains links that aren't one", async () => {
    const respond = (body: string, status = 200) => vi.stubGlobal("fetch", vi.fn(async () => new Response(body, { status })));
    respond(CALENDAR);
    expect(await fetchIcs("https://203.0.113.7/cal.ics")).toBe(CALENDAR);
    respond("<!doctype html><title>Sign in</title>");
    await expect(fetchIcs("https://203.0.113.7/cal.ics")).rejects.toThrow(/web page, not a calendar/);
    respond("nope", 404);
    await expect(fetchIcs("https://203.0.113.7/cal.ics")).rejects.toThrow(/No calendar at that link/);
    respond("nope", 401);
    await expect(fetchIcs("https://203.0.113.7/cal.ics")).rejects.toThrow(/needs a sign-in/);
  });

  it("signs in with a name and password in the link, without sending them in the address", async () => {
    const fetched = vi.fn(async (_url: URL, _init?: RequestInit) => new Response(CALENDAR));
    vi.stubGlobal("fetch", fetched);
    await fetchIcs("https://me:s%40cret@203.0.113.7/dav/cal.ics");
    const [url, init] = fetched.mock.calls[0]!;
    expect(String(url)).toBe("https://203.0.113.7/dav/cal.ics");
    expect(new Headers(init?.headers).get("authorization")).toBe(`Basic ${btoa("me:s@cret")}`);
  });
});

describe("Google Calendar", () => {
  it("gives each visit a fixed event ID Google accepts (0-9 and a-v)", () => {
    const id = googleEventId("0b9d3a6e-6f1c-4c0e-9a7f-3f6c2d1e8b4a");
    expect(id).toBe("ctv0b9d3a6e6f1c4c0e9a7f3f6c2d1e8b4a");
    expect(id).toMatch(/^[0-9a-v]{5,1024}$/);
  });

  it("asks only to read calendars and keep the one it makes", () => {
    const scopes = OAUTH.google_calendar!.scope.split(" ");
    expect(scopes).toEqual([
      "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
      "https://www.googleapis.com/auth/calendar.events.readonly",
      "https://www.googleapis.com/auth/calendar.app.created",
    ]);
  });

  it("lists every calendar app once, with a way in", () => {
    const ids = CATALOG.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(CATALOG.filter((a) => a.category === "Calendar").map((a) => a.id)).toEqual(["google_calendar", "zoho_calendar", "outlook_calendar", "apple_calendar", "ics_calendar"]);
    for (const a of CATALOG) if (a.auth === "oauth") expect(OAUTH[a.id as keyof typeof OAUTH], a.id).toBeDefined();
  });

  it("requires a session to manage calendars", async () => {
    for (const [method, path] of [["GET", "/api/calendars"], ["POST", "/api/calendars"], ["GET", "/api/calendars/google"], ["PUT", "/api/calendars/google/visits"]] as const) {
      expect((await app.request(path, { method }, env)).status, `${method} ${path}`).toBe(401);
    }
  });
});
