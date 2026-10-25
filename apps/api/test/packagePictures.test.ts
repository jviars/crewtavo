import { isPackagePicturePath } from "@crewtavo/core/presets";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";

// Stand-ins for the signed-in person's Supabase client and the service-role client. The viewer's
// membership is `state.role` (with the built-in role's permissions); `roof_packages` are rows that
// eq filters and update changes (returning what it changed; nothing once `state.gone`, as for a
// package deleted meanwhile); Storage records what's uploaded and removed; the rate limiter says no
// when `state.limited`.
const VIEWER = vi.hoisted(() => "00000000-0000-4000-8000-0000000000a1");
type Row = Record<string, unknown>;
const state = vi.hoisted(() => ({
  role: "office",
  limited: false,
  gone: false,
  packages: [] as Row[],
  uploads: [] as Array<{ path: string; contentType?: string; cacheControl?: string; upsert?: boolean }>,
  removed: [] as string[],
}));
vi.mock("../src/lib/supabase", () => {
  const client = () => ({
    auth: { getClaims: async () => ({ data: { claims: { sub: VIEWER } }, error: null }) },
    rpc: async (name: string) => ({ data: name === "rate_limit_hit" ? !state.limited : true, error: null }),
    storage: {
      from: () => ({
        upload: async (path: string, _body: Uint8Array, options: { contentType?: string; cacheControl?: string; upsert?: boolean }) => (state.uploads.push({ path, ...options }), { data: { path }, error: null }),
        remove: async (paths: string[]) => (state.removed.push(...paths), { data: [], error: null }),
      }),
    },
    from: (table: string) => {
      const filters: Array<(row: Row) => boolean> = [];
      let change: Row | null = null;
      const matching = () => (table === "roof_packages" ? state.packages : []).filter((row) => filters.every((keep) => keep(row)));
      const run = () => {
        const hit = change && state.gone ? [] : matching();
        if (change) for (const row of hit) Object.assign(row, change);
        return { data: hit, error: null };
      };
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: (column: string, value: unknown) => (filters.push((row) => row[column] === value), builder),
        update: (values: Row) => ((change = values), builder),
        maybeSingle: () => Promise.resolve(table === "memberships" ? { data: { role: state.role, role_id: null }, error: null } : { data: run().data[0] ?? null, error: null }),
        then: (resolve: (r: unknown) => unknown, reject: (e: unknown) => unknown) => Promise.resolve(run()).then(resolve, reject),
      };
      return builder;
    },
  });
  const user = client();
  const admin = client();
  return { userClient: () => user, adminClient: () => admin, publishableKey: () => "key" };
});
const { app } = await import("../src/app");
const { jpegSize } = await import("../src/services/packagePictures");

const env = { SUPABASE_URL: "https://example.supabase.co", SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test", SUPABASE_SECRET_KEY: "sb_secret_test" } as Env;
const COMPANY = "00000000-0000-4000-8000-000000000001";
const OTHER = "00000000-0000-4000-8000-000000000002";
const PACKAGE = "00000000-0000-4000-8000-0000000000c1";
const THEIRS = "00000000-0000-4000-8000-0000000000c2";
const headers = { Authorization: "Bearer token", "X-Company-Id": COMPANY, "Content-Type": "application/json" };

/**
 * A JPEG's start, a JFIF header, its frame header (SOF0, or `frame`) with this width and height, the
 * start of its picture data, then filler.
 */
function jpeg(width: number, height: number, { size = 400, frame = 0xc0 } = {}) {
  const head = [
    0xff, 0xd8,
    0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
    0xff, frame, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
    0xff, 0xda, 0x00, 0x0c, 0x03, 0x01, 0x00, 0x02, 0x11, 0x03, 0x11, 0x00, 0x3f, 0x00,
  ];
  const bytes = Buffer.alloc(Math.max(size, head.length + 2), 7);
  Buffer.from(head).copy(bytes);
  bytes.writeUInt16BE(0xffd9, bytes.length - 2);
  return bytes;
}
const put = (picture = jpeg(1600, 1000).toString("base64"), id = PACKAGE) => app.request(`/api/packages/${id}/picture`, { method: "PUT", headers, body: JSON.stringify({ picture }) }, env);
const remove = (id = PACKAGE) => app.request(`/api/packages/${id}/picture`, { method: "DELETE", headers }, env);
const ours = () => state.packages.find((p) => p.id === PACKAGE)!;

beforeEach(() => {
  state.role = "office";
  state.limited = false;
  state.gone = false;
  state.packages = [
    { id: PACKAGE, company_id: COMPANY, name: "Architectural shingle", picture: null, picture_width: null, picture_height: null },
    { id: THEIRS, company_id: OTHER, name: "Their shingle", picture: null, picture_width: null, picture_height: null },
  ];
  state.uploads = [];
  state.removed = [];
});

describe("package pictures", () => {
  it("saves a JPEG as the package's picture, kept for good, and says where it went and its size", async () => {
    const res = await put();
    expect(res.status).toBe(200);
    const picture = (await res.json()) as { path: string; width: number; height: number };
    expect(picture).toMatchObject({ width: 1600, height: 1000 });
    expect(picture.path.startsWith(`${COMPANY}/packages/`)).toBe(true);
    expect(isPackagePicturePath(picture.path)).toBe(true);
    expect(state.uploads).toEqual([{ path: picture.path, contentType: "image/jpeg", cacheControl: "31536000", upsert: false }]);
    expect(ours()).toMatchObject({ picture: picture.path, picture_width: 1600, picture_height: 1000 });
  });

  it("never replaces or deletes one, so options already offered keep theirs", async () => {
    const first = (await (await put()).json()) as { path: string };
    const second = (await (await put(jpeg(1200, 900).toString("base64"))).json()) as { path: string };
    expect(second.path).not.toBe(first.path);
    expect(ours()).toMatchObject({ picture: second.path, picture_width: 1200, picture_height: 900 });

    const res = await remove();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(ours()).toMatchObject({ picture: null, picture_width: null, picture_height: null });
    expect(state.removed).toEqual([]);
  });

  it("only takes a JPEG of a sensible size", async () => {
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(200, 7)]).toString("base64");
    const html = Buffer.from(`<html><script>alert(1)</script>${" ".repeat(200)}</html>`).toString("base64");
    const noFrame = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xda, 0x00, 0x04, 0x00, 0x00]), Buffer.alloc(200, 7)]).toString("base64");
    for (const [why, picture] of [["a PNG", png], ["a page", html], ["no frame header", noFrame], ["too wide", jpeg(5000, 1000).toString("base64")], ["no height", jpeg(1600, 0).toString("base64")]]) {
      const res = await put(picture);
      expect(res.status, why).toBe(400);
      expect((await res.json()).error, why).toBe("That picture didn't come through. Try a different one.");
    }
    // Too large is a 413 however large: just over, well over, and over what a request may carry.
    for (const size of [1_400_100, 1_450_000]) {
      const big = await put(jpeg(1600, 1000, { size }).toString("base64"));
      expect(big.status, String(size)).toBe(413);
      expect((await big.json()).error, String(size)).toBe("That picture is too large. Try a smaller one.");
    }
    expect((await put(jpeg(1600, 1000, { size: 1_600_000 }).toString("base64"))).status).toBe(413);
    expect((await put("not base64 at all!")).status).toBe(400);
    expect(state.uploads).toEqual([]);
    expect(ours().picture).toBeNull();
  });

  it("reads the size from the frame header, whichever kind it is", () => {
    expect(jpegSize(jpeg(1600, 1000))).toEqual([1600, 1000]);
    // Progressive (SOF2), after the JFIF header.
    expect(jpegSize(jpeg(321, 4000, { frame: 0xc2 }))).toEqual([321, 4000]);
    // A Huffman table (C4) isn't a frame header: the picture data starts before one.
    expect(jpegSize(jpeg(1600, 1000, { frame: 0xc4 }))).toBeNull();
    expect(jpegSize(Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00]))).toBeNull();
    expect(jpegSize(Buffer.from([0xff, 0xd8, 0x00, 0x00]))).toBeNull();
  });

  it("is only for the business's own packages", async () => {
    for (const res of [await put(undefined, THEIRS), await remove(THEIRS)]) {
      expect(res.status).toBe(404);
      expect((await res.json()).error).toBe("That package wasn't found. It may have been deleted.");
    }
    expect((await put(undefined, "not-a-uuid")).status).toBe(404);
    expect(state.uploads).toEqual([]);
    expect(state.packages.find((p) => p.id === THEIRS)?.picture).toBeNull();
  });

  it("takes the file back off when the package went while it was saving", async () => {
    state.gone = true;
    const res = await put();
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("That package wasn't found. It may have been deleted.");
    expect(state.uploads).toHaveLength(1);
    expect(state.removed).toEqual([state.uploads[0]!.path]);
  });

  it("is for the people who set up the packages", async () => {
    for (const role of ["estimator", "crew_lead", "field_crew"]) {
      state.role = role;
      expect((await put()).status, role).toBe(403);
      expect((await remove()).status, role).toBe(403);
    }
    expect(state.uploads).toEqual([]);
    for (const role of ["owner", "admin", "office"]) {
      state.role = role;
      expect((await put()).status, role).toBe(200);
    }
  });

  it("slows down a run of changes", async () => {
    state.limited = true;
    const res = await put();
    expect(res.status).toBe(429);
    expect((await res.json()).error).toBe("Too many picture changes. Wait a while and try again.");
    expect(state.uploads).toEqual([]);
  });
});
