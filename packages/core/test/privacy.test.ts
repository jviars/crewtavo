import { describe, expect, it } from "vitest";
import { scrubEvent, scrubText, scrubUrl } from "../src/privacy";

const LINK = "eyJjIjoiY28iLCJ0IjoicXVvdGUiLCJpZCI6InEifQ.c2lnbmF0dXJlLWJ5dGVz";

describe("scrubText", () => {
  it("masks emails and phone numbers", () => {
    expect(scrubText("Key (email)=(dana.hale+ops@mail.example.co.uk) already exists")).toBe("Key (email)=([email]) already exists");
    for (const phone of ["(540) 555-0199", "540-555-0199", "540.555.0199", "5405550199", "+15405550199", "+1 540 555 0199"]) {
      expect(scrubText(`Call ${phone} today`)).toBe("Call [phone] today");
    }
  });

  it("masks tokens and signed client links", () => {
    expect(scrubText(`GET /api/hub/${LINK}/promo failed`)).toBe("GET /api/hub/[token]/promo failed");
    expect(scrubText("Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.abc_DEF-123")).toBe("Bearer [token]");
    expect(scrubText("/u/abc123def456 and /refer/xyz and /api/calendar/feedtoken.ics")).toBe("/u/[token] and /refer/[token] and /api/calendar/[token]");
  });

  it("drops query strings from URLs in text", () => {
    expect(scrubText("Failed https://db.example.co/rest/v1/clients?display_name=ilike.*Dana*&select=id (500)")).toBe(
      "Failed https://db.example.co/rest/v1/clients (500)",
    );
  });

  it("leaves ids, dates, amounts and code locations alone", () => {
    const text = "Visit a7000000-0000-0000-0000-000000000001 on 2026-10-16 at 07:00 for $12,500.00 (index-KuLrDpN1.js:1:23456)";
    expect(scrubText(text)).toBe(text);
  });

  it("masks phone numbers after a colon or x, with extensions, and in tel: and sms: links", () => {
    expect(scrubText("Phone:5405550199")).toBe("Phone:[phone]");
    expect(scrubText("mobile:+1 540 555 0199 or x5405550199")).toBe("mobile:[phone] or x[phone]");
    expect(scrubText("Call 540-555-0199x204")).toBe("Call [phone]x204");
    expect(scrubText('<a href="tel:+15405550199">call</a> or sms:540.555.0199?body=Running%20late')).toBe('<a href="tel:[phone]">call</a> or sms:[phone]');
    expect(scrubText("tel:%2B1-540-555-0199")).toBe("tel:[phone]");
  });

  it("drops query strings and fragments from relative URLs too", () => {
    expect(scrubText("GET /auth/v1/verify?token_hash=4f9a1c&type=recovery failed")).toBe("GET /auth/v1/verify failed");
    expect(scrubText("Redirected to /login#refresh_token=v1Kq8s&expires_in=3600")).toBe("Redirected to /login");
    expect(scrubText("POST /auth/v1/token?grant_type=refresh_token (400)")).toBe("POST /auth/v1/token (400)");
    expect(scrubText("Bad #access_token=eyJa.b.c&refresh_token=v1Kq8s")).toBe("Bad ");
    expect(scrubText("What? It's #1 in the list.")).toBe("What? It's #1 in the list.");
  });

  it("stays fast on huge strings and cuts them", () => {
    const started = Date.now();
    const scrubbed = scrubText(`${"a".repeat(100_000)} dana@example.com`);
    expect(Date.now() - started).toBeLessThan(500); // was 8 seconds
    expect(scrubbed).toBe(`${"a".repeat(10_000)} [truncated]`);
    expect(scrubText("x".repeat(30_000)).length).toBe(10_000 + " [truncated]".length);
    // Something cut in half at the limit is still masked.
    expect(scrubText(`${"a ".repeat(4_997)}call 540-555-0199 now${" b".repeat(500)}`)).not.toMatch(/\d{3}/);
  });
});

describe("scrubUrl", () => {
  it("keeps the path and drops the query and fragment", () => {
    expect(scrubUrl("https://ops.example.com/clients?q=Dana#top")).toBe("https://ops.example.com/clients");
    expect(scrubUrl(`https://ops.example.com/hub/${LINK}`)).toBe("https://ops.example.com/hub/[token]");
    expect(scrubUrl("/login#access_token=eyJabc.def.ghi&type=recovery")).toBe("/login");
  });
});

describe("scrubEvent", () => {
  it("removes request bodies, cookies, headers and the user", () => {
    const event = scrubEvent({
      request: {
        url: "https://ops.example.com/api/clients?search=dana@example.com",
        method: "POST",
        data: '{"email":"dana@example.com","phone":"5405550199"}',
        cookies: { sb: "secret" },
        query_string: "search=dana@example.com",
        headers: { Authorization: "Bearer eyJa.b.c", Cookie: "sb=1", "User-Agent": "Mozilla/5.0", "X-Forwarded-For": "203.0.113.9" },
        env: { REMOTE_ADDR: "203.0.113.9" },
      },
      user: { id: "u1", email: "dana@example.com", ip_address: "203.0.113.9" },
    });
    expect(event).toEqual({ request: { url: "https://ops.example.com/api/clients", method: "POST", headers: { "User-Agent": "Mozilla/5.0" } } });
  });

  it("masks messages, error values and breadcrumbs", () => {
    const event = scrubEvent({
      message: "Couldn't text 540-555-0199",
      transaction: `POST /api/hub/${LINK}/message`,
      exception: { values: [{ type: "Error", value: "duplicate key: (email)=(a@b.co)", stacktrace: { frames: [{ filename: "app.js", lineno: 12 }] } }] },
      breadcrumbs: [
        { category: "fetch", data: { method: "GET", url: "https://db.example.co/rest/v1/clients?or=(email.eq.a@b.co)", status_code: 200 } },
        { category: "navigation", data: { from: `/hub/${LINK}`, to: "/clients?q=Dana" } },
        { category: "console", message: "Saved client a@b.co" },
      ],
    });
    expect(event.message).toBe("Couldn't text [phone]");
    expect(event.transaction).toBe("POST /api/hub/[token]/message");
    expect(event.exception.values[0]).toEqual({ type: "Error", value: "duplicate key: (email)=([email])", stacktrace: { frames: [{ filename: "app.js", lineno: 12 }] } });
    expect(event.breadcrumbs[0]!.data).toEqual({ method: "GET", url: "https://db.example.co/rest/v1/clients", status_code: 200 });
    expect(event.breadcrumbs[1]!.data).toEqual({ from: "/hub/[token]", to: "/clients" });
    expect(event.breadcrumbs[2]!.message).toBe("Saved client [email]");
  });

  it("redacts sensitive keys anywhere in extra data, contexts and tags", () => {
    const event = scrubEvent({
      extra: { query: "clients", client: { display_name: "Dana", email: "dana@example.com", gate_code: "#2468", notes: "call 540 555 0199" } },
      contexts: { os: { name: "iOS" }, response: { status_code: 500 } },
      tags: { task: "outbox", access_token: "abc" },
    });
    expect(event.extra).toEqual({ query: "clients", client: { display_name: "Dana", email: "[redacted]", gate_code: "[redacted]", notes: "call [phone]" } });
    expect(event.contexts).toEqual({ os: { name: "iOS" }, response: { status_code: 500 } });
    expect(event.tags).toEqual({ task: "outbox", access_token: "[redacted]" });
  });

  it("redacts lockbox, alarm and other access codes but keeps status and error codes", () => {
    const event = scrubEvent({
      extra: {
        property: { lockbox_code: "4417", alarm_code: "1234#", door_code: "88", entryCode: "2468", postal_code: "24151", notes: "side gate" },
        error: { code: "23505", status_code: 409, statusCode: 409, error_code: "PGRST116", country_code: "US" },
      },
    });
    expect(event.extra).toEqual({
      property: { lockbox_code: "[redacted]", alarm_code: "[redacted]", door_code: "[redacted]", entryCode: "[redacted]", postal_code: "[redacted]", notes: "side gate" },
      error: { code: "23505", status_code: 409, statusCode: 409, error_code: "PGRST116", country_code: "US" },
    });
  });
});
