/**
 * Settings → Hosting: Railway's usage priced and turned into warnings, the twice-daily check that
 * sends each warning once, and when the owner is asked to connect Railway. Railway's GraphQL API
 * and PostgREST are stubbed through fetch, shaped like what Railway answered a project's sign-in on
 * 2026-10-20.
 */
import type { HostingOverview } from "@crewtavo/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { SCOPE, type RailwayAccess } from "../src/integrations/railway";
import { encryptJson } from "../src/lib/crypto";
import { adminClient } from "../src/lib/supabase";
import { checkHosting, forgetHosting, hostingWarnings, readHosting } from "../src/services/hosting";
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
/** The 20th at noon: 19.5 days into October, 11.5 left. */
const NOW = new Date("2026-10-20T12:00:00Z");
const DAY_MINUTES = 1440;

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

/**
 * Railway's answers for a Hobby project made in September, running the same all month: the db at
 * 0.3 GB and the app at 0.1 GB and 0.01 vCPU, sending 0.1 GB a day ($0.145 a day). There's no usage
 * from before the project was made. `over` changes any of them.
 */
function railway(call: Call, over: Partial<Record<"project" | "usage" | "metrics" | "volumes" | "buckets" | "bucket", unknown>> = {}) {
  const query: string = call.body?.query ?? "";
  const pick = (name: keyof typeof over, fallback: unknown) => (name in over ? over[name] : fallback);
  const data = (value: unknown) => (value instanceof Response ? value : { data: value });
  // The project's buckets: none unless a test adds them.
  if (query.includes("buckets(first")) return data(pick("buckets", { project: { buckets: { edges: [] } } }));
  if (query.includes("bucketInstanceDetails(")) return data(pick("bucket", { bucketInstanceDetails: null }));
  if (query.includes("project(id")) {
    return data(pick("project", { project: { name: "Crewtavo", subscriptionType: "hobby", createdAt: "2026-09-01T00:00:00Z", services: { edges: [{ node: { id: "svc-db", name: "db" } }, { node: { id: "svc-crewtavo", name: "crewtavo" } }] } } }));
  }
  if (query.includes("usage(projectId")) {
    const { start, end } = call.body.variables;
    const made = (over.project as { project?: { createdAt?: string } } | undefined)?.project?.createdAt ?? "2026-09-01T00:00:00Z";
    const minutes = Math.max(0, (Date.parse(end) - Math.max(Date.parse(start), Date.parse(made))) / 60_000);
    const days = minutes / DAY_MINUTES;
    return data(
      pick("usage", {
        usage: [
          { measurement: "MEMORY_USAGE_GB", value: 0.3 * minutes, tags: { serviceId: "svc-db" } },
          { measurement: "MEMORY_USAGE_GB", value: 0.1 * minutes, tags: { serviceId: "svc-crewtavo" } },
          { measurement: "CPU_USAGE", value: 0.01 * minutes, tags: { serviceId: "svc-crewtavo" } },
          { measurement: "NETWORK_TX_GB", value: 0.1 * days, tags: { serviceId: "svc-crewtavo" } },
          { measurement: "NETWORK_TX_GB", value: 0, tags: { serviceId: "svc-db" } },
        ],
      }),
    );
  }
  if (query.includes("metrics(")) {
    return data(
      pick("metrics", {
        metrics: [
          // Railway sends a series with no service, all zeros.
          { measurement: "MEMORY_USAGE_GB", tags: { serviceId: null }, values: [{ ts: 10_800, value: 0 }] },
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
  return Response.json({ errors: [{ message: `unexpected ${query.slice(0, 40)}` }] });
}

/** usage() calls, as [start, end]. */
const usageCalls = (calls: Call[]) => calls.filter((c) => c.body?.query?.includes("usage(projectId")).map((c) => [c.body.variables.start, c.body.variables.end]);

afterEach(() => {
  vi.unstubAllGlobals();
  forgetHosting();
});

describe("reading Railway", () => {
  it("prices this month per service, and forecasts the rest of it at the last day's rate", async () => {
    const calls = serve((call) => railway(call));
    const o = await readHosting(env, oauth, NOW);
    // 0.3 GB for 19.5 days is $1.95; 0.1 GB $0.65, 0.01 vCPU $0.13 and 1.95 GB sent $0.10.
    // A day costs $0.145, so the 11.5 days left add about $1.67.
    expect(o.project).toEqual({
      cost: 2.83,
      perDay: 0.14,
      forecast: 4.5,
      services: [
        { id: "svc-db", name: "db", cost: 1.95 },
        { id: "svc-crewtavo", name: "crewtavo", cost: 0.88 },
      ],
    });
    expect(usageCalls(calls)).toEqual([
      ["2026-10-01T00:00:00.000Z", NOW.toISOString()],
      ["2026-10-19T12:00:00.000Z", NOW.toISOString()],
    ]);
    expect(o.plan).toBe("hobby");
    expect(o.trial).toBeNull();
    expect(o.period).toEqual({ start: "2026-10-01T00:00:00.000Z", end: "2026-11-01T00:00:00.000Z" });
    expect(o.disks).toEqual([{ service: "db", kind: "volume", usedGb: 1.2, sizeGb: 5 }]);
    // Samples a moment apart land in the same three-hour point, summed across services.
    expect(o.week).toEqual([
      { at: new Date(10_800_000).toISOString(), memory: 0.19, cpu: 0.02 },
      { at: new Date(21_600_000).toISOString(), memory: 0.2, cpu: 0 },
    ]);
    expect(o.missing).toEqual([]);
    expect(o.warnings).toEqual([]);
    // Nothing about the workspace: a project's sign-in can't see its billing.
    expect(calls.some((c) => c.body?.query?.includes("workspace"))).toBe(false);
  });

  it("counts the trial's days and credit from when the project was made", async () => {
    // Made 2.5 days ago: $0.36 of credit used.
    const calls = serve((call) => railway(call, { project: { project: { name: "Crewtavo", subscriptionType: "trial", createdAt: "2026-10-18T00:00:00Z", services: { edges: [] } } } }));
    const o = await readHosting(env, oauth, NOW);
    expect(o.plan).toBe("trial");
    expect(o.trial).toEqual({ daysLeft: 28, creditLeft: 4.64 });
    expect(usageCalls(calls)).toHaveLength(2);

    // Made last month: the credit is counted from then, in a usage call of its own.
    forgetHosting();
    const before = serve((call) => railway(call, { project: { project: { name: "Crewtavo", subscriptionType: "trial", createdAt: "2026-09-30T12:00:00Z", services: { edges: [] } } } }));
    const late = await readHosting(env, oauth, NOW);
    expect(usageCalls(before)).toContainEqual(["2026-09-30T12:00:00.000Z", NOW.toISOString()]);
    expect(late.trial).toEqual({ daysLeft: 10, creditLeft: 2.1 });
    expect(late.warnings.map((w) => w.key)).toEqual([]);
  });

  it("doesn't forecast from less than an hour of use", async () => {
    serve((call) => railway(call, { project: { project: { name: "Crewtavo", subscriptionType: "trial", createdAt: new Date(NOW.getTime() - 20 * 60_000).toISOString(), services: { edges: [] } } } }));
    const o = await readHosting(env, oauth, NOW);
    expect(o.project).toMatchObject({ perDay: null, forecast: null });
  });

  it("shows a bucket with what it holds, and adds keeping it to the month at $0.015 a GB", async () => {
    serve((call) =>
      railway(call, {
        buckets: { project: { buckets: { edges: [{ node: { id: "bkt-1", name: "files" } }, { node: { id: "bkt-2", name: "elsewhere" } }] } } },
        // 20 GB in this environment's files bucket (Railway sends BigInts as strings); the other isn't here.
        bucket: call.body.variables.bucketId === "bkt-1" ? { bucketInstanceDetails: { sizeBytes: "20000000000", objectCount: "1234" } } : { bucketInstanceDetails: null },
      }),
    );
    const o = await readHosting(env, oauth, NOW);
    expect(o.disks).toEqual([
      { service: "db", kind: "volume", usedGb: 1.2, sizeGb: 5 },
      { service: "files", kind: "bucket", usedGb: 20, sizeGb: null, objects: 1234, monthly: 0.3 },
    ]);
    // $0.30 a month is about $0.19 by the 20th of October, and a cent a day.
    expect(o.project?.services).toContainEqual({ id: "bkt-1", name: "files", cost: 0.19 });
    expect(o.project?.cost).toBe(3.02);
    expect(o.project?.forecast).toBeCloseTo(4.8, 1);
    expect(o.warnings).toEqual([]);
  });

  it("carries on without the parts Railway refuses, but not without the project", async () => {
    serve((call) => railway(call, { metrics: refused(), volumes: refused() }));
    const o = await readHosting(env, oauth, NOW);
    expect(o.missing).toEqual(["charts"]);
    expect(o.week).toEqual([]);
    expect(o.disks).toEqual([]);
    expect(o.project?.cost).toBe(2.83);

    serve((call) => railway(call, { project: refused() }));
    await expect(readHosting(env, oauth, NOW)).rejects.toThrow("Log in with Railway again");
  });
});

/** An overview with nothing wrong, for changing one thing at a time. */
function calm(over: Partial<HostingOverview> = {}): Omit<HostingOverview, "warnings"> {
  return {
    projectName: "Crewtavo",
    plan: "hobby",
    period: { start: "2026-10-01T00:00:00.000Z", end: "2026-11-01T00:00:00.000Z" },
    project: { cost: 2, perDay: 0.15, forecast: 4, services: [] },
    trial: null,
    disks: [],
    week: [],
    missing: [],
    links: { usage: "u", billing: "b", upgrade: "up", plans: "p", project: "pr" },
    checkedAt: NOW.toISOString(),
    ...over,
  };
}

describe("warnings", () => {
  it("says nothing when all is well", () => {
    expect(hostingWarnings(calm())).toEqual([]);
  });

  it("counts down the trial at 7, 3 and 1 days, and warns when its credit runs out first", () => {
    const trial = (daysLeft: number, creditLeft = 4) => hostingWarnings(calm({ plan: "trial", trial: { daysLeft, creditLeft } }));
    expect(trial(9)).toEqual([]);
    expect(trial(6)).toEqual([expect.objectContaining({ key: "trial-7", level: "warning", title: "Your Railway trial ends in about 6 days", action: "upgrade" })]);
    expect(trial(2)[0]).toMatchObject({ key: "trial-3", level: "urgent" });
    expect(trial(0)[0]).toMatchObject({ key: "trial-1", title: "Your Railway trial ends today" });
    expect(trial(20, 0.9)).toEqual([expect.objectContaining({ key: "trial-credit", action: "upgrade", body: expect.stringContaining("About $0.90 of the $5 is left, about 6 days at this rate") })]);
    // $0.40 lasts 2 days at $0.15 a day, before the trial's 20 days are up.
    expect(trial(20, 1.2).map((w) => w.key)).toEqual([]);
    expect(hostingWarnings(calm({ plan: "trial", trial: { daysLeft: 20, creditLeft: 1.2 }, project: { cost: 3.8, perDay: 0.5, forecast: null, services: [] } })).map((w) => w.key)).toEqual(["trial-credit"]);
  });

  it("says what Railway adds over the plan, but not for small change", () => {
    expect(hostingWarnings(calm({ project: { cost: 4, perDay: 0.4, forecast: 8.4, services: [] } }))).toEqual([
      expect.objectContaining({ key: "over:2026-10", title: "About $8.40 of Railway usage this month", body: expect.stringContaining("$3.40 more than the $5.00 Hobby includes") }),
    ]);
    expect(hostingWarnings(calm({ project: { cost: 3, perDay: 0.2, forecast: 5.3, services: [] } }))).toEqual([]);
  });

  it("warns about the Free plan and full volumes", () => {
    expect(hostingWarnings(calm({ plan: "free" }))[0]).toMatchObject({ key: "free", action: "upgrade" });
    const disks = hostingWarnings(calm({ disks: [{ service: "db", kind: "volume", usedGb: 4.3, sizeGb: 5 }, { service: "storage", kind: "volume", usedGb: 4.9, sizeGb: 5 }] }));
    expect(disks.map((w) => [w.key, w.level, w.title])).toEqual([
      ["disk:storage:95", "urgent", "Photos and files storage is 98% full"],
      ["disk:db:85", "warning", "Database storage is 86% full"],
    ]);
    expect(disks[0]?.body).toContain("move photos and files to a Railway bucket");
    // A bucket has no size to fill.
    expect(hostingWarnings(calm({ disks: [{ service: "files", kind: "bucket", usedGb: 900, sizeGb: null, objects: 10, monthly: 13.5 }] }))).toEqual([]);
  });
});

describe("the twice-daily check", () => {
  const trialProject = { project: { project: { name: "Crewtavo", subscriptionType: "trial", createdAt: "2026-09-25T12:00:00Z", services: { edges: [] } } } };

  it("tells the owner and admins about each new warning once", async () => {
    const secret = await encryptJson(env, { access_token: "at", refresh_token: "rt", expires_at: Date.now() + 3_600_000, extra: { method: "oauth", client_id: "cid", client_secret: "sec", redirect_uri: "https://x/cb", scope: SCOPE } });
    let alerts: Record<string, string> = { "trial-7": NOW.toISOString(), "over:2026-01": "2026-01-01T00:00:00Z" };
    const calls = serve((call) => {
      if (call.url.host === "backboard.railway.com") return railway(call, trialProject);
      if (call.path === "companies" && call.method === "GET") return [{ id: "co-1", settings: { payment_terms_days: 30, hosting_alerts: alerts } }];
      if (call.path === "integrations") return [{ status: "connected", settings: { method: "oauth", scope: SCOPE } }];
      if (call.path === "integration_secrets") return [{ ciphertext: secret }];
      if (call.path === "memberships") return [{ user_id: "owner-1" }, { user_id: "admin-1" }];
      return [];
    });
    // Made 25 days ago: 5 days left, and trial-7 was sent already, so nothing new.
    expect(await checkHosting(env, adminClient(env), NOW)).toEqual({ companies: 1, sent: 0, unreadable: 0 });
    expect(calls.some((c) => c.path === "notifications")).toBe(false);
    // The January key is forgotten after 90 days.
    expect(calls.find((c) => c.path === "companies" && c.method === "PATCH")?.body).toEqual({ settings: { payment_terms_days: 30, hosting_alerts: { "trial-7": NOW.toISOString() } } });

    alerts = {};
    calls.length = 0;
    expect(await checkHosting(env, adminClient(env), NOW)).toMatchObject({ sent: 1 });
    const sent = calls.find((c) => c.path === "notifications")!.body;
    expect(sent).toEqual([
      expect.objectContaining({ user_id: "owner-1", kind: "hosting", title: "Your Railway trial ends in about 5 days", link: "/settings?tab=hosting" }),
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

describe("asking the owner to connect Railway", () => {
  it("asks until Railway is connected, by any sign-in that works", () => {
    expect(railwayNeeded(env, null, {})).toBe(true);
    expect(railwayNeeded(env, { status: "error" }, {})).toBe(true);
    expect(railwayNeeded(env, { status: "disconnected" }, {})).toBe(true);
    expect(railwayNeeded(env, { status: "connected" }, {})).toBe(false);
  });

  it("waits a day after Ask me tomorrow, and never asks off Railway", () => {
    expect(railwayNeeded(env, null, { railway_later: new Date(NOW.getTime() + 60_000).toISOString() }, NOW.getTime())).toBe(false);
    expect(railwayNeeded(env, null, { railway_later: new Date(NOW.getTime() - 60_000).toISOString() }, NOW.getTime())).toBe(true);
    expect(railwayNeeded({ ...env, CREWTAVO_SINGLE_COMPANY: undefined }, null, {})).toBe(false);
    expect(railwayNeeded({ ...env, RAILWAY_PROJECT_ID: undefined, RAILWAY_PUBLIC_DOMAIN: undefined }, null, {})).toBe(false);
  });

  it("asks only for the project, and replaces a client made to ask for more", async () => {
    expect(SCOPE).toBe("openid project:member offline_access");
    const client = (scope?: string) =>
      encryptJson(env, { extra: { method: "oauth", client_id: "old", client_secret: "sec", redirect_uri: "https://x/cb", ...(scope ? { scope } : {}), registration_access_token: "rat", registration_client_uri: "https://backboard.railway.com/oauth/register/old" } });
    const answer = (ciphertext: string) => (call: Call) => {
      if (call.path === "integration_secrets" && call.method === "GET") return [{ ciphertext }];
      if (call.url.pathname === "/oauth/register") return Response.json({ client_id: "new", client_secret: "sec2" }, { status: 201 });
      return [];
    };

    // One from before the scope was recorded asked for the project too: it's kept.
    const kept = serve(answer(await client()));
    expect(await railwayClient(env, adminClient(env), "co-1", "https://x/cb", "Crewtavo")).toMatchObject({ client_id: "old" });
    expect(kept.some((c) => c.url.pathname === "/oauth/register")).toBe(false);

    const calls = serve(answer(await client("openid project:member workspace:admin offline_access")));
    expect(await railwayClient(env, adminClient(env), "co-1", "https://x/cb", "Crewtavo")).toMatchObject({ client_id: "new", scope: SCOPE });
    expect(calls.find((c) => c.url.pathname === "/oauth/register")?.body.scope).toBe(SCOPE);
    expect(calls.some((c) => c.method === "DELETE" && c.url.pathname === "/oauth/register/old")).toBe(true);
  });
});
