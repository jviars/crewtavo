/**
 * The "Allow changes" switch for each connected AI assistant (features/apps/assistantConnections.ts,
 * in Settings → Profile → AI assistants, and on the assistant pages under Apps): an assistant only
 * reads until its person turns the switch on, including ones connected before the switch existed,
 * and disconnecting one takes the switch away first. Whatever their role, the person who connected
 * one finds the switch in their profile.
 */
import type { Database } from "@crewtavo/core/database";
import type { SupabaseClient } from "@supabase/supabase-js";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { disconnect, loadConnections, setAllowChanges } from "../src/features/apps/assistantConnections";
import { ProfileSettings } from "../src/features/settings/ProfileSettings";

const session = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("../src/lib/session", () => ({ useSession: () => session.current }));
// The rest of the profile page, which needs a browser or other data.
vi.mock("../src/lib/theme", () => ({ useTheme: () => "system", setTheme: () => undefined }));
vi.mock("../src/components/shell/AppShell", () => ({ initials: (name: string) => name.slice(0, 2).toUpperCase() }));
vi.mock("../src/features/settings/CalendarFeedCard", () => ({ CalendarFeedCard: () => null }));
vi.mock("../src/features/settings/NotificationSettings", () => ({ NotificationSettings: () => null }));

type Row = { user_id?: string; client_id: string; allow_changes: boolean };
const grant = (id: string, name: string, granted_at: string) => ({ client: { id, name, uri: "", logo_uri: "" }, scopes: ["openid"], granted_at });

/** The person's grants on Supabase Auth's OAuth server and their assistant_connections rows. */
function fakeSupabase(grants: ReturnType<typeof grant>[], rows: Row[], options: { revokeFails?: boolean; grantsFail?: { message: string; status: number; code?: string } } = {}) {
  const steps: string[] = [];
  const db = {
    auth: {
      oauth: {
        listGrants: async () => (options.grantsFail ? { data: null, error: options.grantsFail } : { data: grants, error: null }),
        revokeGrant: async ({ clientId }: { clientId: string }) => {
          steps.push(`revoke ${clientId}`);
          if (options.revokeFails) return { data: null, error: { message: "Failed to fetch", status: 0 } };
          grants = grants.filter((g) => g.client.id !== clientId);
          return { data: {}, error: null };
        },
      },
    },
    from: (table: string) => {
      expect(table).toBe("assistant_connections");
      return {
        select: async () => ({ data: rows.map((r) => ({ client_id: r.client_id, allow_changes: r.allow_changes })), error: null }),
        upsert: async (row: Row, { onConflict }: { onConflict: string }) => {
          steps.push(`save ${row.user_id} ${row.client_id} ${row.allow_changes} on ${onConflict}`);
          rows = [...rows.filter((r) => r.client_id !== row.client_id), row];
          return { data: null, error: null };
        },
        delete: () => ({
          eq: async (column: string, value: string) => {
            steps.push(`forget ${column}=${value}`);
            rows = rows.filter((r) => r.client_id !== value);
            return { data: null, error: null };
          },
        }),
      };
    },
  };
  return { db: db as unknown as SupabaseClient<Database>, steps };
}

const grants = [
  grant("claude", "Claude", "2026-10-10T09:00:00Z"),
  grant("chatgpt", "ChatGPT", "2026-10-12T09:00:00Z"),
  // Connected before the switch existed: it has no row.
  grant("cursor", " ", "2026-09-01T09:00:00Z"),
];

describe("connected assistants", () => {
  it("only read until their switch is on, including ones connected before it existed", async () => {
    const { db } = fakeSupabase(grants, [
      { client_id: "claude", allow_changes: true },
      { client_id: "chatgpt", allow_changes: false },
      // A row for an assistant that's no longer connected doesn't bring it back.
      { client_id: "gone", allow_changes: true },
    ]);
    expect((await loadConnections(db)).map((c) => [c.clientId, c.name, c.allowChanges])).toEqual([
      ["chatgpt", "ChatGPT", false],
      ["claude", "Claude", true],
      ["cursor", "AI assistant", false],
    ]);
  });

  it("can be allowed to change things, and switched back to reading, by the person who connected them", async () => {
    const { db, steps } = fakeSupabase(grants, []);
    await setAllowChanges(db, "user-1", "cursor", true);
    expect((await loadConnections(db)).find((c) => c.clientId === "cursor")?.allowChanges).toBe(true);
    await setAllowChanges(db, "user-1", "cursor", false);
    expect((await loadConnections(db)).find((c) => c.clientId === "cursor")?.allowChanges).toBe(false);
    expect(steps).toEqual(["save user-1 cursor true on user_id,client_id", "save user-1 cursor false on user_id,client_id"]);
  });

  it("lose the switch before they're disconnected, so one that fails to disconnect still only reads", async () => {
    const ok = fakeSupabase(grants, [{ client_id: "claude", allow_changes: true }]);
    await disconnect(ok.db, "claude");
    expect(ok.steps).toEqual(["forget client_id=claude", "revoke claude"]);
    expect((await loadConnections(ok.db)).map((c) => c.clientId)).toEqual(["chatgpt", "cursor"]);

    const failing = fakeSupabase(grants, [{ client_id: "claude", allow_changes: true }], { revokeFails: true });
    await expect(disconnect(failing.db, "claude")).rejects.toThrow("It couldn't be disconnected. It can only read now; try again in a moment.");
    expect((await loadConnections(failing.db)).find((c) => c.clientId === "claude")?.allowChanges).toBe(false);
  });

  it("say plainly when they can't be loaded", async () => {
    const { db } = fakeSupabase(grants, [], { grantsFail: { message: "Failed to fetch", status: 0 } });
    await expect(loadConnections(db)).rejects.toThrow("Your connected assistants couldn't be loaded. Try again in a moment.");
  });

  it("are none while Auth's OAuth server is off, since then nothing can connect", async () => {
    const { db } = fakeSupabase(grants, [], { grantsFail: { message: "OAuth server is disabled", status: 404, code: "feature_disabled" } });
    expect(await loadConnections(db)).toEqual([]);
  });
});

describe("Settings → Profile", () => {
  /** The profile page as someone with this role sees it, once their assistants have loaded (or not). */
  async function profile(role: string, db: SupabaseClient<Database>) {
    session.current = {
      userId: "user-1",
      role,
      // Only owners, and admins whose role has "apps", can open the Apps pages.
      permissions: role === "owner" ? [] : ["clients", "schedule"],
      company: { id: "company-1", name: "Kilo Gardens", settings: {} },
      profile: { full_name: "Fran Field", email: "fran@kilo.test", phone: null, color: null },
      refresh: async () => undefined,
    };
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, retryOnMount: false } } });
    await client.prefetchQuery({ queryKey: ["assistant-connections", "user-1"], queryFn: () => loadConnections(db) });
    return renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(ProfileSettings)));
  }
  const toggle = (html: string, name: string) => new RegExp(`<input[^>]*aria-label="Allow changes for ${name}"[^>]*>`).exec(html)?.[0];

  it("has the switch for each assistant its person connected, whatever their role", async () => {
    for (const role of ["owner", "admin", "office", "estimator", "crew_lead", "field_crew", "custom"]) {
      const html = await profile(role, fakeSupabase(grants, [{ client_id: "claude", allow_changes: true }]).db);
      expect(html, role).toContain("<strong>AI assistants</strong>");
      expect(toggle(html, "Claude"), role).toContain('checked=""');
      expect(toggle(html, "ChatGPT"), role).not.toContain("checked");
      expect(toggle(html, "AI assistant"), role).not.toContain("checked");
      expect(html, role).toContain("Assistants connected before this switch");
      expect(html.match(/>Disconnect</g), role).toHaveLength(3);
    }
  });

  it("shows nothing about assistants until one is connected, or while Auth's OAuth server is off", async () => {
    expect(await profile("field_crew", fakeSupabase([], []).db)).not.toContain("AI assistants");
    const off = fakeSupabase(grants, [], { grantsFail: { message: "OAuth server is disabled", status: 404, code: "feature_disabled" } });
    expect(await profile("field_crew", off.db)).not.toContain("assistant");
  });

  it("says so when they can't be loaded", async () => {
    const html = await profile("field_crew", fakeSupabase(grants, [], { grantsFail: { message: "Failed to fetch", status: 0 } }).db);
    expect(html).toContain("<strong>AI assistants</strong>");
    expect(html).toContain("Your connected assistants couldn&#x27;t be loaded. Try again in a moment.");
  });
});
