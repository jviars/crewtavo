import { getPreset, LAWN_ADD_ONS } from "@crewtavo/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { checkFalKey, DETECT_TARGETS, detect, falProblem, SAM3_MAX_MASKS, type DetectTarget } from "../src/integrations/fal";
import { encryptJson } from "../src/lib/crypto";

// Stand-ins for the signed-in person's Supabase client and the service-role client: tables of rows
// that eq, in, is and not filter, with insert and upsert adding rows and update changing them. fal.ai is a fake fetch that keeps
// what it was sent.
type Row = Record<string, unknown>;
const state = vi.hoisted(() => ({ tables: {} as Record<string, Row[]>, rpcs: [] as Array<[string, unknown]> }));
vi.mock("../src/lib/supabase", () => {
  const client = () => ({
    auth: { getClaims: async () => ({ data: { claims: { sub: "viewer" } }, error: null }) },
    rpc: async (name: string, args: unknown) => (state.rpcs.push([name, args]), { data: true, error: null }),
    from: (table: string) => {
      const filters: Array<(row: Row) => boolean> = [];
      let change: Row | null = null;
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
        is: (column: string, value: unknown) => (filters.push((row) => (row[column] ?? null) === value), builder),
        not: () => builder,
        insert: add,
        upsert: add,
        update: (next: Row) => ((change = next), builder),
        maybeSingle: () => Promise.resolve({ data: rows()[0] ?? null, error: null }),
        then: (resolve: (r: unknown) => unknown, reject: (e: unknown) => unknown) => {
          if (change) for (const row of rows()) Object.assign(row, change);
          return Promise.resolve({ data: change ? null : rows(), error: null }).then(resolve, reject);
        },
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
  state.rpcs = [];
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
    expect(await checkFalKey({}, "abc:def", ok as never)).toBeNull();
    const [url, init] = ok.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("api.fal.ai/v1/models/pricing");
    expect((init.headers as Record<string, string>).Authorization).toBe("Key abc:def");
    expect(await checkFalKey({}, "nope", (async () => new Response("{}", { status: 401 })) as never)).toMatch(/didn't accept that key/);
    expect(await checkFalKey({}, "abc:def", (async () => { throw new Error("offline"); }) as never)).toMatch(/Couldn't reach fal\.ai/);
  });

  it("explains fal's errors to an office manager", () => {
    expect(falProblem(401, "")).toMatch(/didn't accept the key/);
    expect(falProblem(403, '{"detail":"User is locked. Reason: Exhausted balance."}')).toMatch(/out of credit/);
    expect(falProblem(429, "")).toMatch(/busy/);
    expect(falProblem(500, "")).toMatch(/had a problem/);
  });

  it("asks SAM 3 for each target and keeps the masks it sends inline", async () => {
    fal.mockImplementation(async () => Response.json({ masks: [{ url: MASK }, { url: "https://example.com/not-fal.png" }], scores: [0.9, 0.8] }));
    const { results, failed } = await detect({}, "abc:def", IMAGE, ["asphalt", "stalls"], fal as never);
    expect(failed).toEqual([]);
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

  it("finds a lawn, its trees and its play sets in one run", async () => {
    await paver({ falKey: "uniform:own-key" });
    fal.mockImplementation(async () => Response.json({ masks: [{ url: MASK }], scores: [0.7] }));
    const res = await send("/paving/detect", { image: IMAGE, targets: ["lawn", "trees", "trampolines", "playsets"] });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { results: Array<{ target: string }> }).results.map((r) => r.target)).toEqual(["lawn", "trees", "trampolines", "playsets"]);
    expect(fal.mock.calls.map(([, init]) => JSON.parse(String(init?.body)).prompt)).toEqual(["grass lawn", "tree", "trampoline", "playground equipment"]);
  });

  it("never asks SAM 3 for more masks than fal allows", async () => {
    // fal's schema for fal-ai/sam-3/image: max_masks is 1 to 32, and a larger number is refused with a 422.
    expect(SAM3_MAX_MASKS).toBe(32);
    for (const [target, { masks }] of Object.entries(DETECT_TARGETS)) expect(masks, target).toBeLessThanOrEqual(SAM3_MAX_MASKS);
    fal.mockImplementation(async () => Response.json({ masks: [], scores: [] }));
    await detect({}, "abc:def", IMAGE, Object.keys(DETECT_TARGETS) as DetectTarget[], fal as never);
    for (const [, init] of fal.mock.calls) {
      const sent = JSON.parse(String(init?.body)).max_masks;
      expect(sent).toBeGreaterThanOrEqual(1);
      expect(sent).toBeLessThanOrEqual(32);
    }
  });

  it("keeps what fal found when one target is refused, and says which one wasn't read", async () => {
    await paver({ falKey: "uniform:own-key" });
    const refusal = { detail: [{ loc: ["body", "max_masks"], msg: "Input should be less than or equal to 32", type: "less_than_equal", ctx: { le: 32 } }] };
    fal.mockImplementation(async (_url, init) =>
      JSON.parse(String(init?.body)).prompt === "tree" ? Response.json(refusal, { status: 422 }) : Response.json({ masks: [{ url: MASK }], scores: [0.7] }),
    );
    const res = await send("/paving/detect", { image: IMAGE, targets: ["lawn", "trees", "trampolines", "playsets"] });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { results: Array<{ target: string }>; failed: Array<{ target: string; error: string }> };
    expect(body.results.map((r) => r.target)).toEqual(["lawn", "trampolines", "playsets"]);
    expect(body.failed).toEqual([{ target: "trees", error: expect.stringMatching(/max_masks: Input should be less than or equal to 32/) }]);
    // Zooming can't fix a setting fal refused, so it isn't worded as a problem with the picture.
    expect(body.failed[0]!.error).not.toMatch(/map picture|Zoom in a little/);
  });

  it("fails the whole Find only when nothing answered, with fal's reason", async () => {
    await paver({ falKey: "uniform:own-key" });
    fal.mockImplementation(async () => new Response("{}", { status: 401 }));
    const res = await send("/paving/detect", { image: IMAGE, targets: ["lawn", "trees"] });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/didn't accept the key/);
  });

  it("words a 422 by what fal refused: the picture, or something else Crewtavo sent", () => {
    const about = (loc: string, type: string, msg: string) => JSON.stringify({ detail: [{ loc: ["body", loc], msg, type }] });
    expect(falProblem(422, about("image_url", "image_load_error", "Failed to load the image"))).toMatch(/couldn't read the map picture/);
    expect(falProblem(422, about("image_url", "image_too_large", "Image too large"))).toMatch(/couldn't read the map picture/);
    expect(falProblem(422, about("max_masks", "less_than_equal", "Input should be less than or equal to 32"))).toBe(
      "fal.ai refused part of what Crewtavo asked for (max_masks: Input should be less than or equal to 32). Zooming in won't change that.",
    );
    // An answer with no reason to read keeps the old advice.
    expect(falProblem(422, "")).toMatch(/couldn't read the map picture/);
    expect(falProblem(400, "Bad Request")).toMatch(/couldn't read the map picture/);
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

describe("lawn add-ons", () => {
  it("adds only the lawn add-ons a price list doesn't have, priced from the lawn's items and slope", async () => {
    await paver();
    // One from before mulch priced from beds, and one someone gave a formula of their own.
    state.tables.services.push({ id: "mulch", company_id: PAVER, name: "Mulch install", sort: 1 }, { id: "edging", company_id: PAVER, name: "Bed edging", sort: 2, formula: "length_ft" });
    const res = await send("/lawn/services", {});
    expect(res.status).toBe(200);
    const { added, filled } = (await res.json()) as { added: string[]; filled: string[] };
    expect(added).toEqual(["Steep slope mowing", "Trim around trees", "Trim around obstacles"]);
    expect(filled).toEqual(["Mulch install"]);
    expect(state.tables.services.find((s) => s.id === "mulch")).toMatchObject({ formula: "ceil(bed_sqft * depth_in / 12 / 27)", default_depth_in: 3 });
    expect(state.tables.services.find((s) => s.id === "edging")).toMatchObject({ formula: "length_ft" });
    expect(LAWN_ADD_ONS).toEqual(expect.arrayContaining([...added, ...filled, "Bed edging"]));
    expect(state.tables.services.find((s) => s.name === "Trim around trees")).toMatchObject({ formula: "trees", unit: "tree" });
    expect(state.tables.services.find((s) => s.name === "Steep slope mowing")).toMatchObject({ formula_target: "unit_price" });
    // Not the rest of the lawn starter list.
    expect(state.tables.services.some((s) => s.name === "Weekly mow")).toBe(false);
  });
});

describe("roofing price book", () => {
  it("adds the standard roofing services a price list doesn't have, pricing the roof from its squares", async () => {
    await paver();
    const res = await send("/roofing/services", {});
    expect(res.status).toBe(200);
    const { added } = (await res.json()) as { added: string[] };
    expect(added).toEqual(getPreset("roofing_exteriors").services.map((s) => s.name));
    expect(state.tables.services.find((s) => s.name === "Architectural shingle roof")).toMatchObject({ formula: "squares", unit: "square", category: "Roof" });
    expect(state.tables.services.find((s) => s.name === "Tear-off and disposal")).toMatchObject({ formula: "roof_squares" });
    expect(state.tables.services.find((s) => s.name === "Steep roof charge")).toMatchObject({ formula: "steep_squares" });
    expect(state.tables.services.find((s) => s.name === "Pipe boot")).toMatchObject({ formula: null, unit: "ea" });
  });
});

describe("Paving and Roofing as apps", () => {
  it("install and uninstall from Apps, for owners and admins who connect apps", async () => {
    await paver();
    expect(await (await send("/roofing/enabled", { enabled: true })).json()).toEqual({ enabled: true });
    expect(await (await send("/paving/enabled", { enabled: false })).json()).toEqual({ enabled: false });
    expect(state.rpcs.filter(([name]) => name === "trade_app_set_enabled")).toEqual([
      ["trade_app_set_enabled", { p_company: PAVER, p_app: "roofing", p_enabled: true }],
      ["trade_app_set_enabled", { p_company: PAVER, p_app: "paving", p_enabled: false }],
    ]);
    state.tables.memberships![0]!.role = "office";
    expect((await send("/roofing/enabled", { enabled: false })).status).toBe(403);
  });
});
