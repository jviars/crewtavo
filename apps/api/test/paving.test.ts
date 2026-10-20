import { getPreset } from "@crewtavo/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { checkFalKey, DETECT_TARGETS, detect, falProblem } from "../src/integrations/fal";
import { encryptJson } from "../src/lib/crypto";

// Stand-ins for the signed-in person's Supabase client and the service-role client: tables of rows
// that eq, in and not filter, with insert and upsert adding rows. fal.ai is a fake fetch that keeps
// what it was sent.
type Row = Record<string, unknown>;
const state = vi.hoisted(() => ({ tables: {} as Record<string, Row[]> }));
vi.mock("../src/lib/supabase", () => {
  const client = () => ({
    auth: { getClaims: async () => ({ data: { claims: { sub: "viewer" } }, error: null }) },
    rpc: async () => ({ data: true, error: null }),
    from: (table: string) => {
      const filters: Array<(row: Row) => boolean> = [];
      const rows = () => (state.tables[table] ?? []).filter((row) => filters.every((keep) => keep(row)));
      const add = (list: Row | Row[]) => {
        state.tables[table] = [...(state.tables[table] ?? []), ...[list].flat()];
        return Promise.resolve({ data: null, error: null });
      };
      const builder: Record<string, unknown> = {
        select: () => builder,
        order: () => builder,
        limit: () => builder,
        eq: (column: string, value: unknown) => (filters.push((row) => row[column] === value), builder),
        neq: (column: string, value: unknown) => (filters.push((row) => row[column] !== value), builder),
        in: (column: string, values: unknown[]) => (filters.push((row) => values.includes(row[column])), builder),
        not: () => builder,
        insert: add,
        upsert: add,
        maybeSingle: () => Promise.resolve({ data: rows()[0] ?? null, error: null }),
        then: (resolve: (r: unknown) => unknown, reject: (e: unknown) => unknown) => Promise.resolve({ data: rows(), error: null }).then(resolve, reject),
      };
      return builder;
    },
  });
  const user = client();
  const admin = client();
  return { userClient: () => user, adminClient: () => admin, publishableKey: () => "key" };
});
const { app } = await import("../src/app");

const env = {
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
  SUPABASE_SECRET_KEY: "sb_secret_test",
  ENCRYPTION_KEY: btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => i * 5))),
  APP_URL: "https://ops.example.com",
} as Env;
const PAVER = "00000000-0000-4000-8000-0000000000b1";
const send = (path: string, body?: unknown, method = body === undefined ? "GET" : "POST") =>
  app.request(`/api${path}`, { method, headers: { Authorization: "Bearer token", "X-Company-Id": PAVER, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }, env);
const IMAGE = `data:image/jpeg;base64,${btoa("not really a jpeg")}`;
const MASK = `data:image/png;base64,${btoa("mask")}`;

const fal = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();
beforeEach(() => {
  fal.mockReset();
  vi.stubGlobal("fetch", fal);
});
afterEach(() => {
  vi.unstubAllGlobals();
  state.tables = {};
});

async function paver({ falKey }: { falKey?: string } = {}) {
  state.tables = {
    profiles: [{ user_id: "viewer", email: "pat@uniform.test", full_name: "Pat", phone: null }],
    memberships: [{ company_id: PAVER, user_id: "viewer", active: true, role: "owner", role_id: null, company: { id: PAVER, name: "Uniform Paving", slug: "uniform", trade_preset: "paving", timezone: "America/New_York", currency: "USD", settings: {} } }],
    integrations: falKey ? [{ company_id: PAVER, provider: "fal", status: "connected" }] : [],
    integration_secrets: falKey ? [{ company_id: PAVER, provider: "fal", ciphertext: await encryptJson(env, { api_key: falKey }) }] : [],
    services: [{ company_id: PAVER, name: "Sealcoat", sort: 0 }],
  };
}

describe("fal.ai", () => {
  it("checks a key against fal's free price list", async () => {
    const ok = vi.fn(async () => new Response("{}", { status: 200 }));
    expect(await checkFalKey("abc:def", ok as never)).toBeNull();
    const [url, init] = ok.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("api.fal.ai/v1/models/pricing");
    expect((init.headers as Record<string, string>).Authorization).toBe("Key abc:def");
    expect(await checkFalKey("nope", (async () => new Response("{}", { status: 401 })) as never)).toMatch(/didn't accept that key/);
    expect(await checkFalKey("abc:def", (async () => { throw new Error("offline"); }) as never)).toMatch(/Couldn't reach fal\.ai/);
  });

  it("explains fal's errors to an office manager", () => {
    expect(falProblem(401, "")).toMatch(/didn't accept the key/);
    expect(falProblem(403, '{"detail":"User is locked. Reason: Exhausted balance."}')).toMatch(/out of credit/);
    expect(falProblem(429, "")).toMatch(/busy/);
    expect(falProblem(500, "")).toMatch(/had a problem/);
  });

  it("asks SAM 3 for each target and keeps the masks it sends inline", async () => {
    fal.mockImplementation(async () => Response.json({ masks: [{ url: MASK }, { url: "https://example.com/not-fal.png" }], scores: [0.9, 0.8] }));
    const results = await detect("abc:def", IMAGE, ["asphalt", "stalls"], fal as never);
    expect(results).toEqual([
      { target: "asphalt", masks: [MASK], scores: [0.9] },
      { target: "stalls", masks: [MASK], scores: [0.9] },
    ]);
    const bodies = fal.mock.calls.map(([, init]) => JSON.parse(String(init?.body)));
    expect(bodies.map((b) => b.prompt)).toEqual([DETECT_TARGETS.asphalt.prompt, DETECT_TARGETS.stalls.prompt]);
    expect(bodies[0]).toMatchObject({ image_url: IMAGE, apply_mask: false, sync_mode: true, return_multiple_masks: true });
  });

  it("finds paving with the business's own key, and says how to get one without it", async () => {
    await paver();
    const missing = await send("/paving/detect", { image: IMAGE, targets: ["asphalt"] });
    expect(missing.status).toBe(400);
    expect(((await missing.json()) as { error: string }).error).toMatch(/needs fal\.ai/);
    expect(fal).not.toHaveBeenCalled();

    await paver({ falKey: "uniform:own-key" });
    fal.mockImplementation(async () => Response.json({ masks: [{ url: MASK }], scores: [0.7] }));
    const res = await send("/paving/detect", { image: IMAGE, targets: ["asphalt", "concrete"] });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { results: unknown[] }).results).toHaveLength(2);
    expect(fal.mock.calls.every(([url, init]) => String(url).startsWith("https://fal.run/") && (init?.headers as Record<string, string>).Authorization === "Key uniform:own-key")).toBe(true);
  });

  it("refuses a picture that isn't one", async () => {
    await paver({ falKey: "uniform:own-key" });
    const res = await send("/paving/detect", { image: "https://example.com/lot.jpg", targets: ["asphalt"] });
    expect(res.status).toBe(400);
    expect(fal).not.toHaveBeenCalled();
  });

  it("checks a pasted key before saving it, and turns Find paving on", async () => {
    await paver();
    fal.mockImplementation(async () => new Response("{}", { status: 401 }));
    const bad = await send("/apps/fal/key", { api_key: "wrong-key-123" }, "PUT");
    expect(bad.status).toBe(400);
    expect(state.tables.integration_secrets).toEqual([]);

    fal.mockImplementation(async () => new Response("{}", { status: 200 }));
    expect((await send("/apps/fal/key", { api_key: "uniform:good-key" }, "PUT")).status).toBe(200);
    expect(state.tables.integrations).toEqual([expect.objectContaining({ provider: "fal", status: "connected", account_label: "Key ending -key" })]);
    const me = (await (await send("/me")).json()) as { memberships: Array<{ fal_connected: boolean }> };
    expect(me.memberships[0].fal_connected).toBe(true);
  });
});

describe("paving price book", () => {
  it("adds the standard paving services a price list doesn't have", async () => {
    await paver();
    const res = await send("/paving/services", {});
    expect(res.status).toBe(200);
    const { added } = (await res.json()) as { added: string[] };
    const standard = getPreset("paving").services.map((s) => s.name);
    expect(added).toEqual(standard.filter((name) => name !== "Sealcoat"));
    const crack = state.tables.services.find((s) => s.name === "Hot-pour crack seal");
    expect(crack).toMatchObject({ formula: "crack_ft", unit: "ft", unit_cost: 0.85, category: "Sealcoat and repair" });
  });
});
