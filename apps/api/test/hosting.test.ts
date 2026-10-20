/**
 * Settings → Hosting: Railway's usage and billing priced and turned into warnings, the twice-daily
 * check that sends each warning once, the usage limit, and when the owner is asked to connect
 * Railway. Railway's GraphQL API and PostgREST are stubbed through fetch.
 */
import type { HostingOverview } from "@crewtavo/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { SCOPE, type RailwayAccess } from "../src/integrations/railway";
import { encryptJson } from "../src/lib/crypto";
import { adminClient } from "../src/lib/supabase";
import { changeLimit, checkHosting, forgetHosting, hostingWarnings, readHosting } from "../src/services/hosting";
import { railwayClient, railwayNeeded } from "../src/services/railway";

const env: Env = {
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
  SUPABASE_SECRET_KEY: "sb_secret_test",
  ENCRYPTION_KEY: btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => i * 7))),
  APP_URL: "https://app.greenlawn.com",
  RAILWAY_PUBLIC_DOMAIN: "crewtavo-production.up.railway.app",
  RAILWAY_PROJECT_ID: "proj-1",
  RAILWAY_ENVIRONMENT_ID: "env-1",
  RAILWAY_SERVICE_ID: "svc-crewtavo",
  CREWTAVO_SINGLE_COMPANY: "1",
};
const oauth: RailwayAccess = { method: "oauth", token: "at", expires_at: Date.now() + 3_600_000 };
const NOW = new Date("2026-10-20T12:00:00Z");
const MONTH = 43_200;

interface Call {
  method: string;
  url: URL;
  path: string;
  body: any;
}

function serve(answer: (call: Call) => Response | unknown) {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const text = typeof init?.body === "string" ? init.body : "";
    const call: Call = { method: (init?.method ?? "GET").toUpperCase(), url, path: url.pathname.replace(/^\/rest\/v1\//, ""), body: text ? JSON.parse(text) : undefined };
    calls.push(call);
    const out = answer(call);
    return out instanceof Response ? out : Response.json(out ?? []);
  });
  return calls;
}

const refused = () => Response.json({ errors: [{ message: "Not Authorized" }] });

/** Railway's answers for a Hobby account that only runs this Crewtavo. `over` changes any of them. */
function railway(call: Call, over: Partial<Record<"project" | "workspace" | "usage" | "projectForecast" | "workspaceForecast" | "metrics" | "volumes", unknown>> = {}) {
  const query: string = call.body?.query ?? "";
  const pick = (name: keyof typeof over, fallback: unknown) => (name in over ? over[name] : fallback);
  const data = (value: unknown) => (value instanceof Response ? value : { data: value });
  if (query.includes("project(id")) {
    return data(pick("project", { project: { name: "crewtavo", subscriptionType: "hobby", workspaceId: "ws-1", services: { edges: [{ node: { id: "svc-db", name: "db" } }, { node: { id: "svc-crewtavo", name: "crewtavo" } }] } } }));
  }
  if (query.includes("workspace(workspaceId")) {
    return data(
      pick("workspace", {
        workspace: {
          plan: "HOBBY",
          projectCount: 1,
          customer: { id: "cus-1", currentUsage: 2.8, creditBalance: 0, isPrepaying: false, isTrialing: false, trialDaysRemaining: null, state: "ACTIVE", billingPeriod: { start: "2026-10-05T00:00:00Z", end: "2026-11-05T00:00:00Z" }, usageLimit: null },
        },
      }),
    );
  }
  if (query.includes("usage(projectId")) {
    return data(
      pick("usage", {
        usage: [
          { measurement: "MEMORY_USAGE_GB", value: 0.15 * MONTH * 0.5, tags: { serviceId: "svc-db" } },
          { measurement: "MEMORY_USAGE_GB", value: 0.05 * MONTH * 0.5, tags: { serviceId: "svc-crewtavo" } },
          { measurement: "CPU_USAGE", value: 0.01 * MONTH * 0.5, tags: { serviceId: "svc-crewtavo" } },
          { measurement: "NETWORK_TX_GB", value: 2, tags: { serviceId: "svc-crewtavo" } },
        ],
      }),
    );
  }
  if (query.includes("estimatedUsage")) {
    const forWorkspace = Boolean(call.body.variables.workspaceId);
    const months = [{ measurement: "MEMORY_USAGE_GB", estimatedValue: 0.2 * MONTH }, { measurement: "CPU_USAGE", estimatedValue: 0.01 * MONTH }];
    return data(pick(forWorkspace ? "workspaceForecast" : "projectForecast", { estimatedUsage: months }));
  }
  if (query.includes("metrics(")) {
    return data(
      pick("metrics", {
        metrics: [
          { measurement: "MEMORY_USAGE_GB", tags: { serviceId: "svc-db" }, values: [{ ts: 10_800, value: 0.14 }, { ts: 21_600, value: 0.15 }] },
          { measurement: "MEMORY_USAGE_GB", tags: { serviceId: "svc-crewtavo" }, values: [{ ts: 10_801, value: 0.05 }, { ts: 21_599, value: 0.05 }] },
          { measurement: "CPU_USAGE", tags: { serviceId: "svc-crewtavo" }, values: [{ ts: 10_800, value: 0.02 }] },
        ],
      }),
    );
  }
  if (query.includes("environment(id")) {
    return data(pick("volumes", { environment: { volumeInstances: { edges: [{ node: { serviceId: "svc-db", currentSizeMB: 1200, sizeMB: 5000 } }] } } }));
  }
  if (query.includes("usageLimitSet") || query.includes("usageLimitRemove")) return { data: { ok: true } };
  return Response.json({ errors: [{ message: `unexpected ${query.slice(0, 40)}` }] });
}

afterEach(() => {
  vi.unstubAllGlobals();
  forgetHosting();
});

describe("reading Railway", () => {
  it("prices this Crewtavo per service, and takes the account's own figures from its billing", async () => {
    serve((call) => railway(call));
    const o = await readHosting(env, oauth, NOW);
    // Half a month of 0.15 GB is $0.75; 0.05 GB is $0.25, 0.01 vCPU $0.10 and 2 GB sent $0.10.
    expect(o.project).toEqual({
      cost: 1.2,
      forecast: 2.2,
      services: [
        { id: "svc-db", name: "db", cost: 0.75 },
        { id: "svc-crewtavo", name: "crewtavo", cost: 0.45 },
      ],
    });
    expect(o.plan).toBe("hobby");
    expect(o.period).toEqual({ start: "2026-10-05T00:00:00Z", end: "2026-11-05T00:00:00Z", billing: true });
    expect(o.account).toMatchObject({ usage: 2.8, forecast: 2.2, others: false, credit: null, limit: null, problem: null });
    expect(o.disks).toEqual([{ service: "db", usedGb: 1.2, sizeGb: 5 }]);
    // Samples a moment apart land in the same three-hour point, summed across services.
    expect(o.week).toEqual([
      { at: new Date(10_800_000).toISOString(), memory: 0.19, cpu: 0.02 },
      { at: new Date(21_600_000).toISOString(), memory: 0.2, cpu: 0 },
    ]);
    expect(o.missing).toEqual([]);
    expect(o.warnings).toEqual([]);
  });

  it("leaves out what a project token can't see, and counts the calendar month instead", async () => {
    const calls = serve((call) => railway(call));
    const o = await readHosting(env, { method: "token", token: "project-token" }, NOW);
    expect(calls.some((c) => c.body?.query.includes("workspace("))).toBe(false);
    expect(o.account).toBeNull();
    expect(o.missing).toEqual(["billing"]);
    expect(o.period).toEqual({ start: "2026-10-01T00:00:00.000Z", end: "2026-11-01T00:00:00.000Z", billing: false });
    expect(o.project?.cost).toBe(1.2);
  });

  it("carries on without the parts Railway refuses, but not without the project", async () => {
    serve((call) => railway(call, { workspace: refused(), metrics: refused() }));
    const o = await readHosting(env, oauth, NOW);
    expect(o.missing).toEqual(["billing", "charts"]);
    expect(o.week).toEqual([]);
    expect(o.project?.cost).toBe(1.2);

    serve((call) => railway(call, { project: refused() }));
    await expect(readHosting(env, oauth, NOW)).rejects.toThrow("Log in with Railway again");
  });

  it("knows the trial, and when other projects share the account", async () => {
    serve((call) =>
      railway(call, {
        workspace: { workspace: { plan: "HOBBY", projectCount: 3, customer: { id: "cus-1", currentUsage: 4, creditBalance: 1, isPrepaying: false, isTrialing: true, trialDaysRemaining: 6, state: "ACTIVE", billingPeriod: null, usageLimit: null } } },
      }),
    );
    const o = await readHosting(env, oauth, NOW);
    expect(o.plan).toBe("trial");
    expect(o.account).toMatchObject({ others: true, credit: 1, trialDaysLeft: 6 });
  });
});

/** An overview with nothing wrong, for changing one thing at a time. */
function calm(over: Partial<HostingOverview> = {}): Omit<HostingOverview, "warnings"> {
  return {
    projectName: "crewtavo",
    plan: "hobby",
    period: { start: "2026-10-05T00:00:00Z", end: "2026-11-05T00:00:00Z", billing: true },
    project: { cost: 2, forecast: 4, services: [] },
    account: { usage: 2, forecast: 4, others: false, credit: null, prepaid: false, trialDaysLeft: null, limit: null, alertAt: null, problem: null },
    disks: [],
    week: [],
    missing: [],
    links: { usage: "u", billing: "b", upgrade: "up", plans: "p", project: "pr" },
    checkedAt: NOW.toISOString(),
    ...over,
  };
}
const account = (over: Partial<NonNullable<HostingOverview["account"]>>) => ({ ...calm().account!, ...over });

describe("warnings", () => {
  it("says nothing when all is well", () => {
    expect(hostingWarnings(calm(), NOW)).toEqual([]);
  });

  it("counts down the trial at 7, 3 and 1 days, and warns when the credit is nearly gone", () => {
    const trial = (days: number, credit = 4) => hostingWarnings(calm({ plan: "trial", account: account({ trialDaysLeft: days, credit }) }), NOW);
    expect(trial(9)).toEqual([]);
    expect(trial(6)).toEqual([expect.objectContaining({ key: "trial-7", level: "warning", title: "Your Railway trial ends in 6 days", action: "upgrade" })]);
    expect(trial(2)[0]).toMatchObject({ key: "trial-3", level: "urgent" });
    expect(trial(0)[0]).toMatchObject({ key: "trial-1", title: "Your Railway trial ends today" });
    expect(trial(20, 0.5)).toEqual([expect.objectContaining({ key: "trial-credit", action: "upgrade", body: expect.stringContaining("$0.50 is left") })]);
  });

  it("puts a card Railway couldn't charge first", () => {
    const warnings = hostingWarnings(calm({ account: account({ problem: "past_due", forecast: 9 }) }), NOW);
    expect(warnings.map((w) => w.key)).toEqual(["card:2026-10-05", "over:2026-10-05"]);
    expect(warnings[0]).toMatchObject({ level: "urgent", action: "billing" });
  });

  it("says what Railway adds over the plan, but not for small change", () => {
    expect(hostingWarnings(calm({ account: account({ forecast: 8.4 }) }), NOW)).toEqual([
      expect.objectContaining({ key: "over:2026-10-05", title: "About $8.40 of Railway usage this month", body: expect.stringContaining("$3.40 more than the $5.00 Hobby includes") }),
    ]);
    expect(hostingWarnings(calm({ account: account({ forecast: 5.3 }) }), NOW)).toEqual([]);
  });

  it("warns before the usage limit stops Crewtavo, with when", () => {
    // $2 in the 15 days since the 5th is about 13 cents a day: $4 more takes 30 days, past the period's end.
    const warnings = hostingWarnings(calm({ account: account({ usage: 2, forecast: 12, limit: 10 }) }), NOW);
    expect(warnings[0]).toMatchObject({ key: "limit:2026-10-05", level: "urgent", action: "limit", title: "Railway will stop Crewtavo around November 5" });
  });

  it("warns when credit an account pays with runs low", () => {
    const warnings = hostingWarnings(calm({ account: account({ prepaid: true, credit: 0.5 }) }), NOW);
    expect(warnings).toEqual([expect.objectContaining({ key: "credit:2026-10-05:3", level: "urgent", action: "billing", title: "Your Railway credit runs out in about 3 days" })]);
  });

  it("warns about the Free plan and full volumes", () => {
    expect(hostingWarnings(calm({ plan: "free" }), NOW)[0]).toMatchObject({ key: "free", action: "upgrade" });
    const disks = hostingWarnings(calm({ disks: [{ service: "db", usedGb: 4.3, sizeGb: 5 }, { service: "storage", usedGb: 4.9, sizeGb: 5 }] }), NOW);
    expect(disks.map((w) => [w.key, w.level, w.title])).toEqual([
      ["disk:storage:95", "urgent", "Photos and files storage is 98% full"],
      ["disk:db:85", "warning", "Database storage is 86% full"],
    ]);
  });
});

describe("the twice-daily check", () => {
  async function connected(scope = SCOPE) {
    return encryptJson(env, { access_token: "at", refresh_token: "rt", expires_at: Date.now() + 3_600_000, extra: { method: "oauth", client_id: "cid", client_secret: "sec", redirect_uri: "https://x/cb", scope } });
  }

  it("tells the owner and admins about each new warning once", async () => {
    const secret = await connected();
    const trial = { workspace: { workspace: { plan: "HOBBY", projectCount: 1, customer: { id: "cus-1", currentUsage: 1, creditBalance: 4, isPrepaying: false, isTrialing: true, trialDaysRemaining: 5, state: "ACTIVE", billingPeriod: null, usageLimit: null } } } };
    let alerts: Record<string, string> = { "trial-7": NOW.toISOString(), "over:2026-01-01": "2026-01-01T00:00:00Z" };
    const calls = serve((call) => {
      if (call.url.host === "backboard.railway.com") return railway(call, trial);
      if (call.path === "companies" && call.method === "GET") return [{ id: "co-1", settings: { payment_terms_days: 30, hosting_alerts: alerts } }];
      if (call.path === "integrations") return [{ status: "connected", settings: { method: "oauth", scope: SCOPE } }];
      if (call.path === "integration_secrets") return [{ ciphertext: secret }];
      if (call.path === "memberships") return [{ user_id: "owner-1" }, { user_id: "admin-1" }];
      return [];
    });
    // trial-7 was sent already, so nothing new.
    expect(await checkHosting(env, adminClient(env), NOW)).toEqual({ companies: 1, sent: 0, unreadable: 0 });
    expect(calls.some((c) => c.path === "notifications")).toBe(false);
    // The January key is forgotten after 90 days.
    expect(calls.find((c) => c.path === "companies" && c.method === "PATCH")?.body).toEqual({ settings: { payment_terms_days: 30, hosting_alerts: { "trial-7": NOW.toISOString() } } });

    alerts = {};
    calls.length = 0;
    expect(await checkHosting(env, adminClient(env), NOW)).toMatchObject({ sent: 1 });
    const sent = calls.find((c) => c.path === "notifications")!.body;
    expect(sent).toEqual([
      expect.objectContaining({ user_id: "owner-1", kind: "hosting", title: "Your Railway trial ends in 5 days", link: "/settings?tab=hosting" }),
      expect.objectContaining({ user_id: "admin-1", kind: "hosting" }),
    ]);
    expect(calls.find((c) => c.path === "companies" && c.method === "PATCH")?.body.settings.hosting_alerts).toEqual({ "trial-7": NOW.toISOString() });
  });

  it("says when Railway stopped accepting the sign-in", async () => {
    const calls = serve((call) => {
      if (call.path === "companies" && call.method === "GET") return [{ id: "co-1", settings: {} }];
      if (call.path === "integrations") return [{ status: "error", settings: {} }];
      if (call.path === "memberships") return [{ user_id: "owner-1" }];
      return [];
    });
    await checkHosting(env, adminClient(env), NOW);
    expect(calls.find((c) => c.path === "notifications")?.body).toEqual([expect.objectContaining({ title: "Crewtavo lost its Railway connection" })]);
  });

  it("does nothing off Railway", async () => {
    const calls = serve(() => []);
    expect(await checkHosting({ ...env, RAILWAY_PROJECT_ID: undefined, RAILWAY_PUBLIC_DOMAIN: undefined }, adminClient(env), NOW)).toEqual({ skipped: "not on Railway" });
    expect(calls).toHaveLength(0);
  });
});

describe("the usage limit", () => {
  it("raises it on the workspace's billing, keeping a lower email level or making one", async () => {
    const secret = await encryptJson(env, { access_token: "at", refresh_token: "rt", expires_at: Date.now() + 3_600_000, extra: { method: "oauth", scope: SCOPE } });
    const limited = (alertAt: number | null) => ({ workspace: { workspace: { plan: "HOBBY", projectCount: 1, customer: { id: "cus-1", currentUsage: 2, creditBalance: 0, isPrepaying: false, isTrialing: false, trialDaysRemaining: null, state: "ACTIVE", billingPeriod: null, usageLimit: { hardLimit: 10, softLimit: alertAt } } } } });
    let alertAt: number | null = 8;
    const calls = serve((call) => {
      if (call.url.host === "backboard.railway.com") return railway(call, limited(alertAt));
      if (call.path === "integrations") return [{ status: "connected", settings: { method: "oauth", scope: SCOPE } }];
      if (call.path === "integration_secrets") return [{ ciphertext: secret }];
      return [];
    });
    const set = () => calls.filter((c) => c.body?.query?.startsWith("mutation")).map((c) => c.body.variables.input);

    await changeLimit(env, adminClient(env), "co-1", 25);
    alertAt = 40;
    await changeLimit(env, adminClient(env), "co-1", 30);
    await changeLimit(env, adminClient(env), "co-1", null);
    expect(set()).toEqual([
      { customerId: "cus-1", hardLimitDollars: 25, softLimitDollars: 8 },
      { customerId: "cus-1", hardLimitDollars: 30, softLimitDollars: 22 },
      { customerId: "cus-1" },
    ]);
  });

  it("says where to change it when the connection can't", async () => {
    const secret = await encryptJson(env, { api_key: "project-token", extra: { method: "token" } });
    serve((call) => {
      if (call.url.host === "backboard.railway.com") return railway(call);
      if (call.path === "integrations") return [{ status: "connected", settings: { method: "token" } }];
      if (call.path === "integration_secrets") return [{ ciphertext: secret }];
      return [];
    });
    await expect(changeLimit(env, adminClient(env), "co-1", 25)).rejects.toThrow("Change it in Railway's usage settings instead");
  });
});

describe("asking the owner to connect Railway", () => {
  const settings = (scope: string | undefined, method = "oauth") => ({ method, scope });

  it("asks until Crewtavo is connected with everything it asks for now", () => {
    expect(railwayNeeded(env, null, {})).toBe(true);
    expect(railwayNeeded(env, { status: "error", settings: settings(SCOPE) }, {})).toBe(true);
    // A sign-in from before billing access.
    expect(railwayNeeded(env, { status: "connected", settings: {} }, {})).toBe(true);
    expect(railwayNeeded(env, { status: "connected", settings: settings("openid project:member offline_access") }, {})).toBe(true);
    expect(railwayNeeded(env, { status: "connected", settings: settings(SCOPE) }, {})).toBe(false);
    // A project token can't have billing access, so it's enough.
    expect(railwayNeeded(env, { status: "connected", settings: settings(undefined, "token") }, {})).toBe(false);
  });

  it("waits a day after Ask me tomorrow, and never asks off Railway", () => {
    expect(railwayNeeded(env, null, { railway_later: new Date(NOW.getTime() + 60_000).toISOString() }, NOW.getTime())).toBe(false);
    expect(railwayNeeded(env, null, { railway_later: new Date(NOW.getTime() - 60_000).toISOString() }, NOW.getTime())).toBe(true);
    expect(railwayNeeded({ ...env, CREWTAVO_SINGLE_COMPANY: undefined }, null, {})).toBe(false);
    expect(railwayNeeded({ ...env, RAILWAY_PROJECT_ID: undefined, RAILWAY_PUBLIC_DOMAIN: undefined }, null, {})).toBe(false);
  });

  it("registers a new OAuth client when the old one was made to ask for less", async () => {
    const old = await encryptJson(env, { extra: { method: "oauth", client_id: "old", client_secret: "sec", redirect_uri: "https://x/cb", registration_access_token: "rat", registration_client_uri: "https://backboard.railway.com/oauth/register/old" } });
    const calls = serve((call) => {
      if (call.path === "integration_secrets" && call.method === "GET") return [{ ciphertext: old }];
      if (call.url.pathname === "/oauth/register") return Response.json({ client_id: "new", client_secret: "sec2" }, { status: 201 });
      return [];
    });
    const client = await railwayClient(env, adminClient(env), "co-1", "https://x/cb", "Crewtavo");
    expect(client).toMatchObject({ client_id: "new", scope: SCOPE });
    expect(calls.find((c) => c.url.pathname === "/oauth/register")?.body.scope).toBe(SCOPE);
    expect(calls.some((c) => c.method === "DELETE" && c.url.pathname === "/oauth/register/old")).toBe(true);
  });
});
