import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";

// Stand-ins for the signed-in person's Supabase client and the service-role client. The viewer's
// membership is `state.role`; the company's settings are `state.settings`; Storage holds `files`
// and records what's uploaded and removed.
const VIEWER = vi.hoisted(() => "00000000-0000-4000-8000-0000000000a1");
const state = vi.hoisted(() => ({
  role: "admin",
  settings: {} as Record<string, any>,
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
        download: async (path: string) => (state.files[path] ? { data: new Blob([state.files[path]]), error: null } : { data: null, error: { message: "Not found" } }),
      }),
    },
    from: (table: string) => {
      const builder: Record<string, unknown> = {};
      for (const name of ["select", "eq", "in"]) builder[name] = () => builder;
      builder.update = (row: { settings: Record<string, any> }) => ({ eq: () => ((state.settings = row.settings), Promise.resolve({ data: null, error: null })) });
      builder.maybeSingle = () => Promise.resolve({ data: table === "memberships" ? { role: state.role, role_id: null } : table === "companies" ? { settings: state.settings } : null, error: null });
      return builder;
    },
  });
  const user = client();
  const admin = client();
  return { userClient: () => user, adminClient: () => admin, publishableKey: () => "key" };
});
const { app } = await import("../src/app");
const { isLogoPath, logoImage } = await import("../src/services/logo");
const { renderEmail } = await import("../src/lib/email");

const env = { SUPABASE_URL: "https://example.supabase.co", SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test", SUPABASE_SECRET_KEY: "sb_secret_test" } as Env;
const COMPANY = "00000000-0000-4000-8000-000000000001";
const OLD = "11111111-1111-4111-8111-111111111111";
const headers = { Authorization: "Bearer token", "X-Company-Id": COMPANY, "Content-Type": "application/json" };

/** A PNG's signature and header (IHDR) with this width and height, then filler. */
function png(width: number, height: number) {
  const bytes = Buffer.alloc(200, 7);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]).copy(bytes);
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}
const put = (logo = png(600, 200).toString("base64")) => app.request("/api/company/logo", { method: "PUT", headers, body: JSON.stringify({ logo }) }, env);
const remove = () => app.request("/api/company/logo", { method: "DELETE", headers }, env);
const fetchLogo = (file: string, company = COMPANY) => app.request(`/api/public/logo/${company}/${file}.png`, {}, env);

beforeEach(() => {
  state.role = "admin";
  state.settings = { payment_terms_days: 14, branding: { color: "#1d4ed8" } };
  state.files = {};
  state.uploads = [];
  state.removed = [];
});

describe("business logo", () => {
  it("saves a PNG with its size, keeps the other settings, and deletes the logo it replaces", async () => {
    state.settings.branding.logo = `${COMPANY}/logo/${OLD}.png`;
    state.files[`${COMPANY}/logo/${OLD}.png`] = png(10, 10);
    const res = await put();
    expect(res.status).toBe(200);
    const { logo } = (await res.json()) as { logo: string };
    expect(isLogoPath(logo, COMPANY)).toBe(true);
    expect(state.uploads).toEqual([{ path: logo, contentType: "image/png" }]);
    expect(state.settings).toEqual({ payment_terms_days: 14, branding: { color: "#1d4ed8", logo, logo_size: [600, 200] } });
    expect(state.removed).toEqual([`${COMPANY}/logo/${OLD}.png`]);
  });

  it("only takes a PNG", async () => {
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 7)]).toString("base64");
    expect((await put(jpeg)).status).toBe(400);
    expect(state.uploads).toEqual([]);
  });

  it("is for owners and admins", async () => {
    state.role = "office";
    expect((await put()).status).toBe(403);
    expect((await remove()).status).toBe(403);
    expect(state.uploads).toEqual([]);
  });

  it("removes the logo and its file", async () => {
    state.settings.branding = { color: "#1d4ed8", logo: `${COMPANY}/logo/${OLD}.png`, logo_size: [10, 10] };
    expect((await remove()).status).toBe(200);
    expect(state.settings.branding).toEqual({ color: "#1d4ed8" });
    expect(state.removed).toEqual([`${COMPANY}/logo/${OLD}.png`]);
  });

  it("serves only the company's own logo, and the current one for an old link", async () => {
    const res = await put();
    const { logo } = (await res.json()) as { logo: string };
    const file = logo.split("/").pop()!.replace(/\.png$/, "");
    const current = await fetchLogo(file);
    expect(current.status).toBe(200);
    expect(current.headers.get("content-type")).toBe("image/png");
    expect(current.headers.get("cache-control")).toContain("immutable");
    const old = await fetchLogo(OLD);
    expect(old.status).toBe(200);
    expect(old.headers.get("cache-control")).toBe("public, max-age=3600");
    // Settings pointing anywhere else (another folder, another company's) serve nothing.
    state.settings.branding.logo = `${COMPANY}/receipts/${OLD}.png`;
    state.files[`${COMPANY}/receipts/${OLD}.png`] = png(10, 10);
    expect((await fetchLogo(OLD)).status).toBe(404);
    expect((await fetchLogo("not-a-uuid")).status).toBe(404);
  });

  it("sizes it for emails: 48 pixels tall, narrower when very wide", () => {
    const settings = { branding: { logo: `${COMPANY}/logo/${OLD}.png`, logo_size: [600, 200] } };
    expect(logoImage("https://crew.example.com", COMPANY, settings)).toEqual({ src: `https://crew.example.com/api/public/logo/${COMPANY}/${OLD}.png`, width: 144, height: 48 });
    expect(logoImage("", COMPANY, { branding: { ...settings.branding, logo_size: [1200, 100] } })).toMatchObject({ width: 220, height: 18 });
    expect(logoImage("", COMPANY, { branding: { color: "#000" } })).toBeNull();
    expect(logoImage("", "00000000-0000-4000-8000-000000000002", settings)).toBeNull();
  });

  it("puts the logo at the top of emails in place of the name", () => {
    const logo = { src: "https://crew.example.com/api/public/logo/a/b.png", width: 144, height: 48 };
    const { html } = renderEmail({ companyName: "Kilo & Sons", logo, text: "Hi" });
    expect(html).toContain('<img src="https://crew.example.com/api/public/logo/a/b.png" width="144" height="48" alt="Kilo &amp; Sons"');
    expect(renderEmail({ companyName: "Kilo & Sons", text: "Hi" }).html).toContain(">Kilo &amp; Sons</td>");
  });
});
