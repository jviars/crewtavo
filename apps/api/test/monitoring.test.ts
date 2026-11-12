import * as Sentry from "@sentry/node";
import type { Envelope, Event } from "@sentry/core";
import { describe, expect, it, vi } from "vitest";
import { app } from "../src/app";
import type { Env } from "../src/env";
import { reportError, sentryOptions } from "../src/lib/monitoring";
import { logUnhandledRejection, startMonitoring } from "../src/lib/monitoring-node";

const env = { SUPABASE_URL: "https://example.supabase.co", ENCRYPTION_KEY: "x" } as Env;

// A route that crashes, registered before the app handles its first request.
app.post("/api/test/crash", async (c) => {
  const body = await c.req.json();
  throw new Error(`Couldn't text ${body.phone} or email ${body.email}`);
});

describe("error reporting", () => {
  it("is off unless CREWTAVO_SENTRY_DSN is set", async () => {
    expect(sentryOptions(env)).toBeUndefined();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const res = await app.request("/api/test/crash", { method: "POST", body: JSON.stringify({ phone: "x", email: "y" }) }, env);
    expect(res.status).toBe(500);
    expect(() => reportError(new Error("nothing to report to"))).not.toThrow();
  });

  it("reports crashes without personal data", async () => {
    const events: Event[] = [];
    const options = sentryOptions({ CREWTAVO_SENTRY_DSN: "https://public@errors.example.com/1", CREWTAVO_SENTRY_ENVIRONMENT: "test" })!;
    expect(options.dataCollection).toMatchObject({ userInfo: false, cookies: false, httpBodies: [], urlQueryParams: false });
    Sentry.init({
      ...options,
      defaultIntegrations: false,
      transport: () => ({
        send: async (envelope: Envelope) => {
          for (const [header, item] of envelope[1]) if (header.type === "event") events.push(item as Event);
          return {};
        },
        flush: async () => true,
      }),
    });

    const res = await app.request(
      "/api/test/crash?email=dana@example.com",
      { method: "POST", headers: { Authorization: "Bearer eyJhbGciOi.eyJzdWIi.sig", Cookie: "sb=1" }, body: JSON.stringify({ phone: "(540) 555-0199", email: "dana@example.com" }) },
      env,
    );
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Something went wrong. Try again." });
    await Sentry.flush(1000);

    expect(events).toHaveLength(1);
    const [event] = events;
    expect(event!.environment).toBe("test");
    expect(event!.exception?.values?.[0]?.value).toBe("Couldn't text [phone] or email [email]");
    expect(event!.extra).toEqual({ route: "/api/test/crash", method: "POST" });
    expect(event!.user).toBeUndefined();
    expect(JSON.stringify(event)).not.toMatch(/dana@example\.com|555-0199|eyJ|sb=1/);
    await Sentry.close();
  });
});

describe("a promise that fails with nothing handling it", () => {
  /** Start the server's monitoring, and give back what it now does with such a promise. */
  function started(e: Env) {
    const before = process.listeners("unhandledRejection");
    const crashes = process.listeners("uncaughtException");
    startMonitoring(e);
    const added = process.listeners("unhandledRejection").filter((listener) => !before.includes(listener));
    // Taken off again, so nothing here is left listening while the tests run.
    for (const listener of added) process.off("unhandledRejection", listener);
    for (const listener of process.listeners("uncaughtException")) if (!crashes.includes(listener)) process.off("uncaughtException", listener);
    return added;
  }
  const failure = new Error("Couldn't reach the mail server");

  it("is logged, and the server carries on, when Sentry is off", () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    // Node stops the process when nothing listens for these.
    const added = started(env);
    expect(added).toEqual([logUnhandledRejection]);
    expect(() => added[0]!(failure, Promise.resolve())).not.toThrow();
    expect(logged).toHaveBeenCalledTimes(1);
    expect(logged.mock.calls[0]).toEqual(["A promise failed and nothing handled it:", expect.stringContaining("Couldn't reach the mail server")]);
    // Whatever was thrown, an error or not.
    expect(() => added[0]!("timed out", Promise.resolve())).not.toThrow();
    expect(logged).toHaveBeenLastCalledWith("A promise failed and nothing handled it:", "timed out");
    logged.mockRestore();
  });

  it("is logged the same way when Sentry is on, which only reports it", async () => {
    const added = started({ ...env, CREWTAVO_SENTRY_DSN: "https://public@errors.example.com/1" });
    // Ours logs; Sentry's own is there to report, and is told not to log or stop the server ("none").
    expect(added).toContain(logUnhandledRejection);
    expect(added).toHaveLength(2);
    expect(Sentry.getClient()?.getIntegrationByName("OnUnhandledRejection")).toBeDefined();
    await Sentry.close();
  });
});
