import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";

// Stand-ins for the signed-in person's Supabase client and the service-role client. The viewer's
// membership is `state.role` (with the built-in role's permissions); Storage holds `files` and
// records what's uploaded and removed.
const VIEWER = vi.hoisted(() => "00000000-0000-4000-8000-0000000000a1");
const state = vi.hoisted(() => ({
  role: "office",
  files: {} as Record<string, Uint8Array>,
  uploads: [] as Array<{ path: string; contentType?: string }>,
  removed: [] as string[],
}));
vi.mock("../src/lib/supabase", () => {
  const client = () => ({
    auth: { getClaims: async () => ({ data: { claims: { sub: VIEWER } }, error: null }) },
    rpc: async () => ({ data: true, error: null }),
    storage: {
      from: () => ({
        upload: async (path: string, body: Uint8Array, options: { contentType?: string }) => ((state.files[path] = body), state.uploads.push({ path, contentType: options.contentType }), { data: { path }, error: null }),
        remove: async (paths: string[]) => (paths.forEach((p) => delete state.files[p]), state.removed.push(...paths), { data: [], error: null }),
        // Whole, or as a stream (the public routes read it that way, up to a picture's size).
        download: (path: string) => {
          const found = () => (state.files[path] ? { data: new Blob([state.files[path]]), error: null } : { data: null, error: { message: "Not found" } });
          return Object.assign(Promise.resolve(found()), { asStream: async () => (state.files[path] ? { data: new Blob([state.files[path]]).stream(), error: null } : found()) });
        },
      }),
    },
    from: (table: string) => {
      const builder: Record<string, unknown> = {};
      for (const name of ["select", "eq", "in"]) builder[name] = () => builder;
      builder.maybeSingle = () => Promise.resolve({ data: table === "memberships" ? { role: state.role, role_id: null } : null, error: null });
      return builder;
    },
  });
  const user = client();
  const admin = client();
  return { userClient: () => user, adminClient: () => admin, publishableKey: () => "key" };
});
const { app } = await import("../src/app");
const { isLetterheadPath, templateSettings } = await import("@crewtavo/core/documents");

const env = { SUPABASE_URL: "https://example.supabase.co", SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test", SUPABASE_SECRET_KEY: "sb_secret_test" } as Env;
const COMPANY = "00000000-0000-4000-8000-000000000001";
const OTHER = "00000000-0000-4000-8000-000000000002";
const FILE = "11111111-1111-4111-8111-111111111111";
const headers = { Authorization: "Bearer token", "X-Company-Id": COMPANY, "Content-Type": "application/json" };

/** A PNG's signature and header (IHDR) with this width and height, then filler. */
function png(width: number, height: number, size = 200) {
  const bytes = Buffer.alloc(size, 7);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]).copy(bytes);
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}
const put = (picture = png(1540, 300).toString("base64")) => app.request("/api/templates/letterhead", { method: "PUT", headers, body: JSON.stringify({ picture }) }, env);
const fetchPicture = (file: string, company = COMPANY) => app.request(`/api/public/letterhead/${company}/${file}.png`, {}, env);

beforeEach(() => {
  state.role = "office";
  state.files = {};
  state.uploads = [];
  state.removed = [];
});

describe("letterhead pictures", () => {
  it("saves a PNG as a new picture and says where it went and its size, for the template to keep", async () => {
    const res = await put();
    expect(res.status).toBe(200);
    const picture = (await res.json()) as { path: string; width: number; height: number };
    expect(picture).toMatchObject({ width: 1540, height: 300 });
    expect(picture.path.startsWith(`${COMPANY}/letterhead/`)).toBe(true);
    expect(isLetterheadPath(picture.path)).toBe(true);
    expect(state.uploads).toEqual([{ path: picture.path, contentType: "image/png" }]);
    // What the route answers is what a template keeps.
    expect(templateSettings({ letterhead: "custom", letterhead_header: picture }).letterhead_header).toEqual(picture);
  });

  it("never replaces or deletes one, so signed estimates keep theirs", async () => {
    const first = (await (await put()).json()) as { path: string };
    const second = (await (await put()).json()) as { path: string };
    expect(second.path).not.toBe(first.path);
    expect(state.removed).toEqual([]);
  });

  it("only takes a PNG of a sensible size", async () => {
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 7)]).toString("base64");
    expect((await put(jpeg)).status).toBe(400);
    expect((await put(png(5000, 300).toString("base64"))).status).toBe(400);
    expect((await put(png(1540, 300, 1_400_100).toString("base64"))).status).toBe(413);
    expect(state.uploads).toEqual([]);
  });

  it("is for the people who change the templates", async () => {
    state.role = "estimator";
    expect((await put()).status).toBe(403);
    state.role = "field_crew";
    expect((await put()).status).toBe(403);
    state.role = "admin";
    expect((await put()).status).toBe(200);
  });

  it("shows any of the company's letterhead pictures to anyone, and nothing else", async () => {
    state.files[`${COMPANY}/letterhead/${FILE}.png`] = png(1540, 300);
    const res = await fetchPicture(FILE);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("cache-control")).toContain("immutable");
    // Another company's folder, another folder, a file that isn't a PNG, a name that isn't a uuid.
    expect((await fetchPicture(FILE, OTHER)).status).toBe(404);
    state.files[`${COMPANY}/logo/${FILE}.png`] = png(10, 10);
    state.files[`${COMPANY}/letterhead/${OTHER}.png`] = Buffer.from("<html><script>alert(1)</script></html>");
    expect((await fetchPicture(OTHER)).status).toBe(404);
    expect((await app.request(`/api/public/letterhead/${COMPANY}/..%2Flogo%2F${FILE}.png`, {}, env)).status).toBe(404);
    expect((await fetchPicture("not-a-uuid")).status).toBe(404);
  });

  it("shows none larger than the server saves one, as one uploaded straight to Storage could be", async () => {
    state.files[`${COMPANY}/letterhead/${FILE}.png`] = png(1540, 300, 1_400_001);
    expect((await fetchPicture(FILE)).status).toBe(404);
    state.files[`${COMPANY}/letterhead/${FILE}.png`] = png(1540, 300, 1_400_000);
    expect((await fetchPicture(FILE)).status).toBe(200);
  });
});
