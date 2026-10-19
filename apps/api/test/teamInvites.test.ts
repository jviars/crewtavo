import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";

// Stand-ins for the signed-in admin's Supabase client and the service-role client. Memberships
// answer by who's asked about: the viewer (`viewer`), anyone else (`target`), the team list
// (`team`), and other businesses the person belongs to (`elsewhere`). Accounts live in `accounts`.
const state = vi.hoisted(() => ({
  viewer: { role: "admin", role_id: null as string | null },
  target: null as { role: string; active: boolean } | null,
  team: [] as Array<{ user_id: string }>,
  elsewhere: [] as Array<{ company_id: string }>,
  existing: null as string | null,
  accounts: {} as Record<string, { id: string; email: string; created_at: string; last_sign_in_at?: string; invited_at?: string; recovery_sent_at?: string }>,
  names: {} as Record<string, string>,
  links: [] as Array<{ type: string; email: string }>,
  lookups: [] as string[],
  upserts: [] as unknown[],
  emailed: true,
  sent: [] as Array<{ to: string; subject: string; text: string }>,
}));
vi.mock("../src/lib/supabase", () => {
  const client = (kind: "user" | "admin") => ({
    auth: {
      getClaims: async () => ({ data: { claims: { sub: "viewer" } }, error: null }),
      admin: {
        getUserById: async (id: string) => {
          state.lookups.push(id);
          const user = state.accounts[id];
          return user ? { data: { user }, error: null } : { data: { user: null }, error: { message: "User not found" } };
        },
        generateLink: async ({ type, email }: { type: string; email: string }) => {
          state.links.push({ type, email });
          return { data: { user: { id: "new-person" }, properties: { hashed_token: `tok-${state.links.length}` } }, error: null };
        },
      },
    },
    rpc: async (fn: string) => ({ data: fn === "user_id_for_email" ? state.existing : true, error: null }),
    from: (table: string) => {
      const calls: unknown[][] = [];
      const about = () => (calls.find((c) => c[0] === "eq" && c[1] === "user_id")?.[2] as string | undefined) ?? null;
      const result = () => {
        if (table === "memberships") {
          if (kind === "admin") return state.elsewhere;
          if (calls.some((c) => c[0] === "maybeSingle")) return about() === "viewer" ? state.viewer : state.target;
          return state.team;
        }
        if (table === "companies") return { name: "Juliet Lawn", email: "office@juliet.test" };
        if (table === "profiles") return { full_name: state.names[about() ?? ""] ?? "" };
        return null;
      };
      const builder: Record<string, unknown> = {};
      for (const name of ["select", "eq", "neq", "in", "limit"]) {
        builder[name] = (...args: unknown[]) => (calls.push([name, ...args]), builder);
      }
      builder.upsert = (row: unknown) => (state.upserts.push(row), Promise.resolve({ data: null, error: null }));
      builder.maybeSingle = () => (calls.push(["maybeSingle"]), Promise.resolve({ data: result(), error: null }));
      builder.then = (resolve: (r: unknown) => unknown, reject: (e: unknown) => unknown) => Promise.resolve({ data: result(), error: null }).then(resolve, reject);
      return builder;
    },
  });
  const user = client("user");
  const admin = client("admin");
  return { userClient: () => user, adminClient: () => admin, publishableKey: () => "key" };
});
vi.mock("../src/lib/notify", async (original) => ({
  ...(await original<typeof import("../src/lib/notify")>()),
  sendEmail: async (_env: Env, message: { to: string; subject: string; text: string }) => {
    state.sent.push({ to: message.to, subject: message.subject, text: message.text });
    return state.emailed ? { sent: true } : { sent: false, reason: "Email isn't set up yet." };
  },
}));
const { app } = await import("../src/app");

const env = { SUPABASE_URL: "https://example.supabase.co", SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test", SUPABASE_SECRET_KEY: "sb_secret_test", APP_URL: "https://ops.example.com" } as Env;
const COMPANY = "00000000-0000-4000-8000-000000000001";
const SAM = "00000000-0000-4000-8000-0000000000c1";
const headers = { Authorization: "Bearer token", "X-Company-Id": COMPANY, "Content-Type": "application/json" };
const request = (path: string, body?: unknown) => app.request(`/api${path}`, body === undefined ? { headers } : { method: "POST", headers, body: JSON.stringify(body) }, env);

/** Sam, invited two days ago, never signed in. */
const samInvited = () => {
  state.accounts[SAM] = { id: SAM, email: "sam@juliet.test", created_at: "2026-10-17T12:00:00Z", invited_at: "2026-10-17T12:00:00Z" };
  state.names[SAM] = "Sam Rivera";
  state.target = { role: "field_crew", active: true };
};

afterEach(() => {
  state.viewer = { role: "admin", role_id: null };
  state.target = null;
  state.team = [];
  state.elsewhere = [];
  state.existing = null;
  state.accounts = {};
  state.names = {};
  state.links = [];
  state.lookups = [];
  state.upserts = [];
  state.emailed = true;
  state.sent = [];
});

describe("inviting someone", () => {
  it("emails the link and hands it back, so it can be texted too", async () => {
    const res = await request("/team/invite", { email: "New@Juliet.test", full_name: "Robin Lee" });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ user_id: "new-person", invited: true, emailed: true, reason: null, link: "https://ops.example.com/?token_hash=tok-1&type=invite" });
    expect(state.sent).toEqual([expect.objectContaining({ to: "new@juliet.test", subject: "Join Juliet Lawn on Crewtavo" })]);
    expect(state.sent[0]!.text).toContain("Hi Robin,");
  });

  it("still gives the link when email isn't connected", async () => {
    state.emailed = false;
    const body = await (await request("/team/invite", { email: "new@juliet.test" })).json();
    expect(body).toMatchObject({ emailed: false, reason: "Email isn't set up yet.", link: "https://ops.example.com/?token_hash=tok-1&type=invite" });
  });

  it("sends a fresh set-up link to someone invited before who never signed in", async () => {
    samInvited();
    state.existing = SAM;
    const body = await (await request("/team/invite", { email: "sam@juliet.test" })).json();
    expect(state.links).toEqual([{ type: "recovery", email: "sam@juliet.test" }]);
    expect(body).toMatchObject({ invited: false, emailed: true, link: "https://ops.example.com/?token_hash=tok-1&type=recovery&welcome=1" });
  });

  it("just tells someone who already signed in that they have access", async () => {
    samInvited();
    state.accounts[SAM]!.last_sign_in_at = "2026-10-18T09:00:00Z";
    state.existing = SAM;
    const body = await (await request("/team/invite", { email: "sam@juliet.test" })).json();
    expect(body).toMatchObject({ invited: false, link: null });
    expect(state.links).toEqual([]);
    expect(state.sent[0]!.subject).toBe("You now have access to Juliet Lawn");
  });
});

describe("pending invites", () => {
  it("lists who hasn't set up their account, with when their latest link went out", async () => {
    samInvited();
    state.accounts[SAM]!.recovery_sent_at = "2026-10-18T15:30:00Z";
    state.accounts.joined = { id: "joined", email: "kim@juliet.test", created_at: "2026-10-01T12:00:00Z", last_sign_in_at: "2026-10-02T12:00:00Z" };
    state.team = [{ user_id: SAM }, { user_id: "joined" }];
    const res = await request("/team/invites");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([{ user_id: SAM, sent_at: "2026-10-18T15:30:00.000Z" }]);
  });

  it("is only for people who manage the team", async () => {
    for (const role of ["office", "crew_lead", "field_crew"]) {
      state.viewer = { role, role_id: null };
      expect((await request("/team/invites")).status).toBe(403);
    }
    expect(state.lookups).toEqual([]);
  });
});

describe("resending an invite", () => {
  const resend = () => request(`/team/${SAM}/invite-link`, {});

  it("emails a new set-up link and hands it back", async () => {
    samInvited();
    const res = await resend();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ emailed: true, reason: null, link: "https://ops.example.com/?token_hash=tok-1&type=recovery&welcome=1" });
    expect(state.links).toEqual([{ type: "recovery", email: "sam@juliet.test" }]);
    expect(state.sent).toEqual([expect.objectContaining({ to: "sam@juliet.test", subject: "Join Juliet Lawn on Crewtavo" })]);
    expect(state.sent[0]!.text).toContain("Hi Sam,");
  });

  it("gives the link to copy when email isn't connected", async () => {
    samInvited();
    state.emailed = false;
    expect(await (await resend()).json()).toMatchObject({ emailed: false, link: expect.stringContaining("welcome=1") });
  });

  it("refuses once they've signed in, or when another business has them too", async () => {
    samInvited();
    state.elsewhere = [{ company_id: "another" }];
    expect((await resend()).status).toBe(403);
    state.elsewhere = [];
    state.accounts[SAM]!.last_sign_in_at = "2026-10-18T09:00:00Z";
    const joined = await resend();
    expect(joined.status).toBe(400);
    expect((await joined.json()).error).toContain("Reset password");
    expect(state.links).toEqual([]);
    expect(state.sent).toEqual([]);
  });

  it("is only for someone on the team, and only an owner resends to an owner", async () => {
    samInvited();
    state.target = { role: "field_crew", active: false };
    expect((await resend()).status).toBe(404);
    state.target = null;
    expect((await resend()).status).toBe(404);
    state.target = { role: "owner", active: true };
    expect((await resend()).status).toBe(403);
    state.viewer = { role: "field_crew", role_id: null };
    state.target = { role: "field_crew", active: true };
    expect((await resend()).status).toBe(403);
    expect(state.links).toEqual([]);
  });
});
