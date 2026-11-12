/**
 * Settings → Email: connecting the company's email again ends the warning that emails aren't going
 * out (routes/email.ts). It has just signed in and sent its test, so the owners needn't wait for
 * the next quote or reminder to see the warning go. Stand-ins for the Supabase clients keep what the
 * database was asked; Resend takes the test email; the person's password is taken as right.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";

type Row = Record<string, unknown>;
const state = vi.hoisted(() => ({
  tables: {} as Record<string, Row[]>,
  rpcs: [] as Array<{ fn: string; args: Record<string, unknown> }>,
  writes: [] as Array<{ table: string; row: Row }>,
}));
vi.mock("../src/lib/supabase", () => {
  const client = () => ({
    auth: { getClaims: async () => ({ data: { claims: { sub: "viewer" } }, error: null }) },
    rpc: async (fn: string, args: Record<string, unknown>) => (state.rpcs.push({ fn, args }), { data: fn === "rate_limit_hit" ? true : null, error: null }),
    from: (table: string) => {
      const filters: Array<(row: Row) => boolean> = [];
      const rows = () => (state.tables[table] ?? []).filter((row) => filters.every((keep) => keep(row)));
      const builder: Record<string, unknown> = {
        eq: (column: string, value: unknown) => (filters.push((row) => row[column] === value), builder),
        upsert: (row: Row) => (state.writes.push({ table, row }), builder),
        maybeSingle: () => Promise.resolve({ data: rows()[0] ?? null, error: null }),
        then: (resolve: (r: unknown) => unknown, reject: (e: unknown) => unknown) => Promise.resolve({ data: rows(), error: null }).then(resolve, reject),
      };
      // Anything else the route chains on (select, order, insert...) changes nothing here.
      return new Proxy(builder, { get: (target, key) => (key in target ? target[key as string] : () => builder) });
    },
  });
  const user = client();
  const admin = client();
  return { userClient: () => user, adminClient: () => admin, publishableKey: () => "key" };
});
vi.mock("../src/lib/auth", async (original) => ({
  ...(await original<typeof import("../src/lib/auth")>()),
  confirmPassword: async () => ({ email: "olga@oscar.test", full_name: "Olga Owner" }),
}));
const { app } = await import("../src/app");

const env = {
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
  SUPABASE_SECRET_KEY: "sb_secret_test",
  ENCRYPTION_KEY: btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => i * 7))),
  APP_URL: "https://ops.example.com",
} as Env;
const OSCAR = "00000000-0000-4000-8000-0000000000c6";

afterEach(() => {
  vi.unstubAllGlobals();
  state.tables = {};
  state.rpcs = [];
  state.writes = [];
});

describe("connecting the company's email again", () => {
  const connect = (resend: () => Response) => {
    state.tables = {
      profiles: [{ user_id: "viewer", email: "olga@oscar.test", full_name: "Olga Owner", phone: null }],
      memberships: [{ company_id: OSCAR, user_id: "viewer", active: true, role: "owner", role_id: null, company: { id: OSCAR, name: "Oscar Roofing", slug: "oscar", trade_preset: "roofing", timezone: "America/New_York", settings: {} } }],
      companies: [{ id: OSCAR, name: "Oscar Roofing", email: "office@oscar.test", settings: {}, trade_preset: "roofing" }],
    };
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => (String(input instanceof Request ? input.url : input).startsWith("https://api.resend.com/") ? resend() : Response.json([])));
    return app.request(
      "/api/email",
      {
        method: "PUT",
        headers: { Authorization: "Bearer token", "X-Company-Id": OSCAR, "Content-Type": "application/json" },
        body: JSON.stringify({ preset: "resend", api_key: "re_new_key", from_email: "office@oscar.test", current_password: "hunter2hunter2" }),
      },
      env,
    );
  };
  const cleared = () => state.rpcs.filter((r) => r.fn === "note_sending").map((r) => r.args);

  it("clears the warning as soon as its test email has gone", async () => {
    const res = await connect(() => Response.json({ id: "email-1" }));
    expect(res.status).toBe(200);
    expect(state.writes.map((w) => [w.table, w.row.status ?? null])).toEqual([["integrations", "connected"], ["integration_secrets", null]]);
    expect(cleared()).toEqual([{ p_company: OSCAR, p_channel: "email", p_ok: true }]);
  });

  it("leaves it standing when the new key doesn't work either", async () => {
    const res = await connect(() => Response.json({ message: "API key is invalid" }, { status: 401 }));
    expect(res.status).toBe(400);
    expect(state.writes).toEqual([]);
    expect(cleared()).toEqual([]);
  });
});
