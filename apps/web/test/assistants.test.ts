/**
 * What each connected AI assistant can change (features/apps/assistantConnections.ts, in Settings →
 * AI assistants, and on the assistant pages under Apps): an assistant only reads until its person
 * chooses areas or gives it full access, including ones connected before access could be chosen, and
 * disconnecting one takes its access away first. Whatever their role, the person who connected one
 * finds it in Settings; owners and admins also find the company's own limits there.
 */
import type { Database } from "@crewtavo/core/database";
import type { SupabaseClient } from "@supabase/supabase-js";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import chatgptLogo from "../src/assets/apps/chatgpt.svg";
import claudeLogo from "../src/assets/apps/claude.svg";
import codexLogo from "../src/assets/apps/codex.svg";
import { disconnect, loadConnections, setAccess } from "../src/features/apps/assistantConnections";
import { AssistantSettings } from "../src/features/settings/AssistantSettings";
import { ProfileSettings } from "../src/features/settings/ProfileSettings";
import { settingsGroups } from "../src/features/settings/sections";

const session = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("../src/lib/session", () => ({
  useSession: () => session.current,
  hasRole: (s: { role: string }, ...roles: string[]) => s.role === "owner" || roles.includes(s.role),
  can: (s: { role: string; permissions: string[] }, p: string) => s.role === "owner" || s.permissions.includes(p),
}));
// The rest of the profile page, which needs a browser or other data.
vi.mock("../src/lib/theme", () => ({ useTheme: () => "system", setTheme: () => undefined }));
vi.mock("../src/components/shell/AppShell", () => ({ initials: (name: string) => name.slice(0, 2).toUpperCase() }));
vi.mock("../src/features/settings/CalendarFeedCard", () => ({ CalendarFeedCard: () => null }));
vi.mock("../src/features/settings/NotificationSettings", () => ({ NotificationSettings: () => null }));

type Row = { user_id?: string; client_id: string; level: string; areas: string[] };
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
        select: async () => ({ data: rows.map(({ client_id, level, areas }) => ({ client_id, level, areas })), error: null }),
        upsert: async (row: Row, { onConflict }: { onConflict: string }) => {
          steps.push(`save ${row.user_id} ${row.client_id} ${row.level} [${row.areas.join(",")}] on ${onConflict}`);
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
  // Connected before access could be chosen: it has no row.
  grant("cursor", " ", "2026-09-01T09:00:00Z"),
];

describe("connected assistants", () => {
  it("only read until they're given more, including ones connected before access could be chosen", async () => {
    const { db } = fakeSupabase(grants, [
      { client_id: "claude", level: "full", areas: [] },
      { client_id: "chatgpt", level: "areas", areas: ["prices", "crews"] },
      // A row for an assistant that's no longer connected doesn't bring it back.
      { client_id: "gone", level: "full", areas: [] },
    ]);
    expect((await loadConnections(db)).map((c) => [c.clientId, c.name, c.access])).toEqual([
      ["chatgpt", "ChatGPT", { level: "areas", areas: ["prices", "crews"] }],
      ["claude", "Claude", { level: "full", areas: [] }],
      ["cursor", "AI assistant", { level: "read", areas: [] }],
    ]);
  });

  it("can be given areas or full access, and put back to reading, by the person who connected them", async () => {
    const { db, steps } = fakeSupabase(grants, []);
    await setAccess(db, "user-1", "cursor", { level: "areas", areas: ["guides"] });
    expect((await loadConnections(db)).find((c) => c.clientId === "cursor")?.access).toEqual({ level: "areas", areas: ["guides"] });
    // Areas only count when the level is "areas".
    await setAccess(db, "user-1", "cursor", { level: "full", areas: ["guides"] });
    await setAccess(db, "user-1", "cursor", { level: "read", areas: [] });
    expect((await loadConnections(db)).find((c) => c.clientId === "cursor")?.access).toEqual({ level: "read", areas: [] });
    expect(steps).toEqual([
      "save user-1 cursor areas [guides] on user_id,client_id",
      "save user-1 cursor full [] on user_id,client_id",
      "save user-1 cursor read [] on user_id,client_id",
    ]);
  });

  it("lose their access before they're disconnected, so one that fails to disconnect still only reads", async () => {
    const ok = fakeSupabase(grants, [{ client_id: "claude", level: "full", areas: [] }]);
    await disconnect(ok.db, "claude");
    expect(ok.steps).toEqual(["forget client_id=claude", "revoke claude"]);
    expect((await loadConnections(ok.db)).map((c) => c.clientId)).toEqual(["chatgpt", "cursor"]);

    const failing = fakeSupabase(grants, [{ client_id: "claude", level: "full", areas: [] }], { revokeFails: true });
    await expect(disconnect(failing.db, "claude")).rejects.toThrow("It couldn't be disconnected. It can only read now; try again in a moment.");
    expect((await loadConnections(failing.db)).find((c) => c.clientId === "claude")?.access.level).toBe("read");
  });

  it("show the real logo for Codex, Claude and ChatGPT, and otherwise the one the assistant sent", async () => {
    const withLogo = { ...grant("other", "Other Assistant", "2026-10-01T09:00:00Z"), client: { id: "other", name: "Other Assistant", uri: "", logo_uri: "https://other.test/logo.png" } };
    const { db } = fakeSupabase([grant("codex", "Codex", "2026-10-15T09:00:00Z"), grant("claude-code", "Claude Code", "2026-10-14T09:00:00Z"), ...grants, withLogo], []);
    const logos = Object.fromEntries((await loadConnections(db)).map((c) => [c.clientId, c.logo]));
    expect(logos.codex).toBe(codexLogo);
    expect(logos.claude).toBe(claudeLogo);
    expect(logos["claude-code"]).toBe(claudeLogo);
    expect(logos.chatgpt).toBe(chatgptLogo);
    expect(logos.other).toBe("https://other.test/logo.png");
    expect(logos.cursor).toBeNull();
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

describe("Settings → AI assistants", () => {
  const as = (role: string) => {
    session.current = {
      userId: "user-1",
      role,
      permissions: role === "owner" ? [] : ["clients", "schedule"],
      company: { id: "company-1", name: "Kilo Gardens", settings: {} },
      profile: { full_name: "Fran Field", email: "fran@kilo.test", phone: null, color: null },
      config: { singleCompany: true },
      refresh: async () => undefined,
    };
  };
  /** The tab as someone with this role sees it, once their assistants have loaded (or not). */
  async function tab(role: string, db: SupabaseClient<Database>) {
    as(role);
    vi.stubGlobal("window", { location: { origin: "https://ops.example.com" } });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, retryOnMount: false } } });
    await client.prefetchQuery({ queryKey: ["assistant-connections", "user-1"], queryFn: () => loadConnections(db) });
    const html = renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(AssistantSettings)));
    vi.unstubAllGlobals();
    return html;
  }

  it("is in everyone's settings, and the profile no longer has it", () => {
    for (const role of ["owner", "admin", "office", "estimator", "crew_lead", "field_crew"]) {
      as(role);
      const items = settingsGroups(session.current as never).flatMap((g) => g.items);
      expect(items.some((i) => "tab" in i && i.tab === "assistants"), role).toBe(true);
    }
    as("field_crew");
    const client = new QueryClient();
    expect(renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(ProfileSettings)))).not.toContain("assistant");
  });

  it("gives the connector link and each assistant's access, whatever their role", async () => {
    for (const role of ["owner", "admin", "office", "estimator", "crew_lead", "field_crew"]) {
      const html = await tab(role, fakeSupabase(grants, [{ client_id: "claude", level: "full", areas: [] }, { client_id: "chatgpt", level: "areas", areas: ["prices", "crews"] }]).db);
      expect(html, role).toContain("https://ops.example.com/mcp");
      expect(html, role).toContain("Full access");
      expect(html, role).toContain("Can change: Price list, Crews");
      expect(html, role).toContain("Read only");
      expect(html.match(/>Access</g), role).toHaveLength(3);
      expect(html.match(/>Disconnect</g), role).toHaveLength(3);
      // The company's own limits are for owners and admins.
      expect(html.includes("Let my team use AI assistants"), role).toBe(role === "owner" || role === "admin");
    }
  });

  it("says when none are connected yet, or they can't be loaded", async () => {
    expect(await tab("field_crew", fakeSupabase([], []).db)).toContain("None yet.");
    const html = await tab("field_crew", fakeSupabase(grants, [], { grantsFail: { message: "Failed to fetch", status: 0 } }).db);
    expect(html).toContain("Your connected assistants couldn&#x27;t be loaded. Try again in a moment.");
  });
});
