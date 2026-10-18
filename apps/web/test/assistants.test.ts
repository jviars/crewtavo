/**
 * The "Allow changes" switch for each connected AI assistant (features/apps/assistantConnections.ts,
 * on the assistant pages under Settings → Apps): an assistant only reads until its person turns
 * the switch on, including ones connected before the switch existed, and disconnecting one takes
 * the switch away first.
 */
import type { Database } from "@crewtavo/core/database";
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { disconnect, loadConnections, setAllowChanges } from "../src/features/apps/assistantConnections";

type Row = { user_id?: string; client_id: string; allow_changes: boolean };
const grant = (id: string, name: string, granted_at: string) => ({ client: { id, name, uri: "", logo_uri: "" }, scopes: ["openid"], granted_at });

/** The person's grants on Supabase Auth's OAuth server and their assistant_connections rows. */
function fakeSupabase(grants: ReturnType<typeof grant>[], rows: Row[], options: { revokeFails?: boolean; grantsFail?: boolean } = {}) {
  const steps: string[] = [];
  const db = {
    auth: {
      oauth: {
        listGrants: async () => (options.grantsFail ? { data: null, error: { message: "OAuth server is disabled", status: 404 } } : { data: grants, error: null }),
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
    const { db } = fakeSupabase(grants, [], { grantsFail: true });
    await expect(loadConnections(db)).rejects.toThrow("Your connected assistants couldn't be loaded. Try again in a moment.");
  });
});
