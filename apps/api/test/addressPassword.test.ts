/**
 * Choosing Crewtavo's web address, and giving it Railway access (which switches the address by
 * itself), ask for the person's own password (routes/address.ts confirmAddressChange, with
 * lib/auth.ts confirmPassword): the address is where every reset, invite and client link points,
 * so a session left open somewhere can't move it. Stand-ins for the Supabase clients, the password
 * check (one password is right), and the address and Railway services keep what they were asked.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AddressOverview } from "@crewtavo/core/address";
import type { Env } from "../src/env";

type Row = Record<string, unknown>;
const RIGHT = "correct horse battery";
const state = vi.hoisted(() => ({
  tables: {} as Record<string, Row[]>,
  tries: [] as string[],
  started: [] as string[],
  saved: [] as unknown[],
  clients: 0,
}));
vi.mock("../src/lib/supabase", () => {
  const client = () => ({
    auth: { getClaims: async () => ({ data: { claims: { sub: "viewer", session_id: "s1" } }, error: null }) },
    rpc: async (fn: string) => ({ data: fn === "rate_limit_hit" ? true : null, error: null }),
    from: (table: string) => {
      const filters: Array<(row: Row) => boolean> = [];
      const rows = () => (state.tables[table] ?? []).filter((row) => filters.every((keep) => keep(row)));
      const builder: Record<string, unknown> = {
        eq: (column: string, value: unknown) => (filters.push((row) => row[column] === value), builder),
        maybeSingle: () => Promise.resolve({ data: rows()[0] ?? null, error: null }),
        then: (resolve: (r: unknown) => unknown, reject: (e: unknown) => unknown) => Promise.resolve({ data: rows(), error: null }).then(resolve, reject),
      };
      // Anything else the route chains on (select, order...) changes nothing here.
      return new Proxy(builder, { get: (target, key) => (key in target ? target[key as string] : () => builder) });
    },
  });
  const user = client();
  const admin = client();
  return { userClient: () => user, adminClient: () => admin, publishableKey: () => "key" };
});
vi.mock("../src/lib/auth", async (original) => {
  const real = await original<typeof import("../src/lib/auth")>();
  const { HttpError } = await import("../src/lib/http");
  return {
    ...real,
    confirmPassword: async (_c: unknown, password: string, limit: string) => {
      state.tries.push(limit);
      if (password !== RIGHT) throw new HttpError(400, real.WRONG_PASSWORD);
      return { email: "olga@greenlawn.test", full_name: "Olga Owner" };
    },
  };
});
const OVERVIEW = { current: "https://app.greenlawn.com", platform: "railway", railway: null, suggestion: null, change: null } satisfies AddressOverview;
vi.mock("../src/services/address", async (original) => ({
  ...(await original<typeof import("../src/services/address")>()),
  startChange: async (_env: unknown, _admin: unknown, _company: string, _user: string, domain: string) => (state.started.push(domain), OVERVIEW),
  addressOverview: async () => OVERVIEW,
  adoptRailway: async () => undefined,
}));
vi.mock("../src/services/railway", async (original) => ({
  ...(await original<typeof import("../src/services/railway")>()),
  saveRailwayAccess: async (_env: unknown, _admin: unknown, _company: string, _user: string, access: unknown) => {
    state.saved.push(access);
  },
  railwayClient: async () => {
    state.clients++;
    return { client_id: "cid", client_secret: "secret", redirect_uri: "https://app.greenlawn.com/api/railway/callback", scope: "project:viewer" };
  },
}));
vi.mock("../src/integrations/railway", async (original) => ({
  ...(await original<typeof import("../src/integrations/railway")>()),
  authorizationUrl: () => "https://backboard.railway.com/oauth/auth?client_id=cid",
}));
const { app } = await import("../src/app");
const { ADDRESS_PASSWORD, RAILWAY_PASSWORD } = await import("../src/routes/address");
const { WRONG_PASSWORD } = await import("../src/lib/auth");

const CO = "00000000-0000-4000-8000-0000000000c6";
const env = {
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
  SUPABASE_SECRET_KEY: "sb_secret_test",
  ENCRYPTION_KEY: btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => i * 7))),
  APP_URL: "https://app.greenlawn.com",
  CREWTAVO_SINGLE_COMPANY: "1",
  RAILWAY_PUBLIC_DOMAIN: "crewtavo-production.up.railway.app",
  RAILWAY_PROJECT_ID: "proj-1",
} as Env;

const post = (path: string, body: object) => {
  // Nothing here should reach the network: Railway and Auth are stood in for above.
  vi.stubGlobal("fetch", async () => Response.json([]));
  state.tables = {
    memberships: [{ company_id: CO, user_id: "viewer", active: true, role: "owner", role_id: null, subcontractor_id: null }],
    companies: [{ id: CO, name: "Green Lawn" }],
  };
  return app.request(path, { method: "POST", headers: { Authorization: "Bearer token", "X-Company-Id": CO, "Content-Type": "application/json" }, body: JSON.stringify(body) }, env);
};

afterEach(() => {
  vi.unstubAllGlobals();
  state.tries = [];
  state.started = [];
  state.saved = [];
  state.clients = 0;
});

describe("choosing the web address", () => {
  it("asks for the password before anything starts", async () => {
    const res = await post("/api/address/start", { domain: "crm.greenlawn.com" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: ADDRESS_PASSWORD });
    expect(state.started).toEqual([]);
  });

  it("starts nothing with the wrong one", async () => {
    const res = await post("/api/address/start", { domain: "crm.greenlawn.com", password: "guess" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: WRONG_PASSWORD });
    expect(state.tries).toEqual(["web-address"]);
    expect(state.started).toEqual([]);
  });

  it("starts with the right one", async () => {
    const res = await post("/api/address/start", { domain: "crm.greenlawn.com", password: RIGHT });
    expect(res.status).toBe(200);
    expect(state.started).toEqual(["crm.greenlawn.com"]);
  });
});

describe("connecting Railway", () => {
  it("takes a project token only with the password", async () => {
    for (const [body, error] of [
      [{ token: "railway-project-token-1234" }, RAILWAY_PASSWORD],
      [{ token: "railway-project-token-1234", password: "guess" }, WRONG_PASSWORD],
    ] as const) {
      const res = await post("/api/railway/token", body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(await res.json()).toEqual({ error });
    }
    expect(state.saved).toEqual([]);
    const res = await post("/api/railway/token", { token: "railway-project-token-1234", password: RIGHT });
    expect(res.status).toBe(200);
    expect(state.saved).toEqual([{ method: "token", token: "railway-project-token-1234" }]);
    // Choosing an address and connecting Railway count their tries together.
    expect(new Set(state.tries)).toEqual(new Set(["web-address"]));
  });

  it("opens Railway's sign-in only with the password", async () => {
    let res = await post("/api/railway/connect", { return_to: "settings" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: RAILWAY_PASSWORD });
    res = await post("/api/railway/connect", { return_to: "settings", password: "guess" });
    expect(res.status).toBe(400);
    expect(state.clients).toBe(0);
    expect(res.headers.get("set-cookie")).toBeNull();

    res = await post("/api/railway/connect", { return_to: "setup", password: RIGHT });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ authorization_url: "https://backboard.railway.com/oauth/auth?client_id=cid" });
    expect(res.headers.get("set-cookie")).toContain("crewtavo_railway=");
  });
});
