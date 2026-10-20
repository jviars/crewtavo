import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";

// Stand-ins for the signed-in person's Supabase client and the service-role client. Memberships
// answer by who's asked about: the viewer (`viewer`) or anyone else (`target`). Profiles hold each
// person's photo path (`photos`); Storage records what's uploaded and removed.
const VIEWER = vi.hoisted(() => "00000000-0000-4000-8000-0000000000a1");
const state = vi.hoisted(() => ({
  viewer: { role: "field_crew", role_id: null as string | null },
  target: { role: "field_crew" } as { role: string } | null,
  photos: {} as Record<string, string | null>,
  uploads: [] as Array<{ path: string; size: number; contentType?: string }>,
  removed: [] as string[],
}));
vi.mock("../src/lib/supabase", () => {
  const client = (kind: "user" | "admin") => ({
    auth: { getClaims: async () => ({ data: { claims: { sub: VIEWER } }, error: null }) },
    rpc: async () => ({ data: true, error: null }),
    storage: {
      from: () => ({
        upload: async (path: string, body: Uint8Array, options: { contentType?: string }) => (state.uploads.push({ path, size: body.length, contentType: options.contentType }), { data: { path }, error: null }),
        remove: async (paths: string[]) => (state.removed.push(...paths), { data: [], error: null }),
      }),
    },
    from: (table: string) => {
      const calls: unknown[][] = [];
      const about = () => (calls.find((c) => c[0] === "eq" && c[1] === "user_id")?.[2] as string | undefined) ?? "";
      const result = () => {
        if (table === "memberships" && kind === "user") return about() === VIEWER ? state.viewer : state.target;
        if (table === "profiles") return { avatar_url: state.photos[about()] ?? null };
        return null;
      };
      const builder: Record<string, unknown> = {};
      for (const name of ["select", "eq", "in"]) builder[name] = (...args: unknown[]) => (calls.push([name, ...args]), builder);
      builder.update = (row: { avatar_url: string | null }) => {
        const done = { eq: (_: string, id: string) => ((state.photos[id] = row.avatar_url), Promise.resolve({ data: null, error: null })) };
        return done;
      };
      builder.maybeSingle = () => Promise.resolve({ data: result(), error: null });
      return builder;
    },
  });
  const user = client("user");
  const admin = client("admin");
  return { userClient: () => user, adminClient: () => admin, publishableKey: () => "key" };
});
const { app } = await import("../src/app");
const { isPhotoPath } = await import("../src/services/photos");

const env = { SUPABASE_URL: "https://example.supabase.co", SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test", SUPABASE_SECRET_KEY: "sb_secret_test" } as Env;
const COMPANY = "00000000-0000-4000-8000-000000000001";
const TEAMMATE = "00000000-0000-4000-8000-0000000000b2";
const headers = { Authorization: "Bearer token", "X-Company-Id": COMPANY, "Content-Type": "application/json" };
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 7)]).toString("base64");
const put = (who: string, photo = JPEG) => app.request(`/api/team/${who}/photo`, { method: "PUT", headers, body: JSON.stringify({ photo }) }, env);
const remove = (who: string) => app.request(`/api/team/${who}/photo`, { method: "DELETE", headers }, env);
const pathOf = (who: string, id = "11111111-1111-4111-8111-111111111111") => `${COMPANY}/avatars/${who}/${id}.jpg`;

beforeEach(() => {
  state.viewer = { role: "field_crew", role_id: null };
  state.target = { role: "field_crew" };
  state.photos = {};
  state.uploads = [];
  state.removed = [];
});

describe("profile photos", () => {
  it("lets anyone set their own, and replacing it deletes the old one", async () => {
    state.photos[VIEWER] = pathOf(VIEWER);
    const res = await put(VIEWER);
    expect(res.status).toBe(200);
    const { avatar_url } = (await res.json()) as { avatar_url: string };
    expect(isPhotoPath(avatar_url, VIEWER)).toBe(true);
    expect(avatar_url.startsWith(`${COMPANY}/avatars/${VIEWER}/`)).toBe(true);
    expect(state.uploads).toEqual([{ path: avatar_url, size: 204, contentType: "image/jpeg" }]);
    expect(state.photos[VIEWER]).toBe(avatar_url);
    expect(state.removed).toEqual([pathOf(VIEWER)]);
  });

  it("only takes a JPEG", async () => {
    const page = Buffer.from(`<html><script>alert(1)</script>${" ".repeat(200)}</html>`).toString("base64");
    const res = await put(VIEWER, page);
    expect(res.status).toBe(400);
    expect(state.uploads).toEqual([]);
  });

  it("keeps crew from changing someone else's", async () => {
    const res = await put(TEAMMATE);
    expect(res.status).toBe(403);
    expect(state.uploads).toEqual([]);
  });

  it("lets admins set a teammate's, but only owners set an owner's", async () => {
    state.viewer = { role: "admin", role_id: null };
    expect((await put(TEAMMATE)).status).toBe(200);
    expect(isPhotoPath(state.photos[TEAMMATE]!, TEAMMATE)).toBe(true);
    state.target = { role: "owner" };
    expect((await put(TEAMMATE)).status).toBe(403);
    state.target = null;
    expect((await put(TEAMMATE)).status).toBe(404);
  });

  it("removes a photo, and never deletes a file that isn't the person's photo", async () => {
    state.photos[VIEWER] = pathOf(VIEWER);
    expect((await remove(VIEWER)).status).toBe(200);
    expect(state.photos[VIEWER]).toBeNull();
    expect(state.removed).toEqual([pathOf(VIEWER)]);

    state.removed = [];
    state.photos[VIEWER] = `${COMPANY}/plans/11111111-1111-4111-8111-111111111111.pdf`;
    expect((await remove(VIEWER)).status).toBe(200);
    expect(state.removed).toEqual([]);
  });
});
