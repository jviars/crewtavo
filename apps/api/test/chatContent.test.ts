import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { app } from "../src/app";
import type { Env } from "../src/env";
import { resetHub, subscribe, type ChatEvent } from "../src/lib/chatHub";

// Team chat's routes for what messages carry (routes/chat.ts reactions, chatSearch.ts,
// chatSaved.ts): reactions are a quick one or a listed emoji, search asks the database as the
// person and keeps its order, and saving tells the person's other tabs. Who may do what is the
// database's to decide (supabase/tests/chat_*_test.sql); these check what the routes send it.

const CO = "00000000-0000-4000-8000-000000000001";
const ME = "00000000-0000-4000-8000-0000000000aa";
const MSG = "00000000-0000-4000-8000-0000000000b1";
const CHANNEL = "00000000-0000-4000-8000-0000000000c1";

const db = vi.hoisted(() => ({
  calls: [] as Array<{ table: string; calls: Array<[string, ...unknown[]]> }>,
  rpcs: [] as Array<{ name: string; args: Record<string, unknown> }>,
  hits: [] as Array<{ id: string; channel_id: string; rank: number }>,
  reactions: [] as Array<{ user_id: string; kind: string; created_at: string }>,
  saved: [] as Array<{ message_id: string; created_at: string }>,
}));
vi.mock("../src/lib/supabase", async (original) => {
  const row = (id: string, body: string) => ({
    id, channel_id: CHANNEL, author_id: ME, body, attachments: [], job_id: null, reply_to: null, mention_users: [], mention_roles: [], mention_all: false,
    pinned_at: null, pinned_by: null, edited_at: null, deleted_at: null, created_at: "2026-11-28T00:00:00Z",
  });
  const answer = (table: string, calls: Array<[string, ...unknown[]]>) => {
    db.calls.push({ table, calls });
    const has = (name: string) => calls.find(([n]) => n === name);
    if (table === "memberships") return has("maybeSingle") ? { data: { role: "field_crew", role_id: null, subcontractor_id: null } } : { data: [{ user_id: ME, role: "field_crew", role_id: null }] };
    if (table === "companies") return { data: { settings: { team_chat: { enabled: true } } } };
    if (table === "profiles") return { data: [{ user_id: ME, full_name: "Kai Moana", email: "kai@example.test", color: null, avatar_url: null }] };
    if (table === "chat_messages") {
      const ids = (has("in")?.[2] as string[] | undefined) ?? [MSG];
      return has("maybeSingle") ? { data: row(MSG, "Hello") } : { data: ids.map((id) => row(id, `Message ${id.slice(-2)}`)) };
    }
    if (table === "chat_reactions") return { data: db.reactions };
    if (table === "chat_saved") return { data: db.saved };
    return { data: [] };
  };
  const chain = (table: string, calls: Array<[string, ...unknown[]]>): unknown =>
    new Proxy(
      {},
      {
        get: (_, name) =>
          name === "then"
            ? (resolve: (value: unknown) => unknown) => Promise.resolve({ error: null, ...answer(table, calls) }).then(resolve)
            : (...args: unknown[]) => chain(table, [...calls, [String(name), ...args]]),
      },
    );
  const client = {
    from: (table: string) => chain(table, []),
    rpc: async (name: string, args: Record<string, unknown>) => {
      db.rpcs.push({ name, args });
      return { data: name === "chat_search" ? db.hits : name === "chat_audience" ? [ME] : true, error: null };
    },
    auth: { getClaims: async () => ({ data: { claims: { sub: ME } }, error: null }) },
  };
  return { ...(await original<typeof import("../src/lib/supabase")>()), adminClient: () => client, userClient: () => client };
});

const env: Env = {
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
  SUPABASE_SECRET_KEY: "sb_secret_test",
  ENCRYPTION_KEY: btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => i * 7))),
  APP_URL: "https://ops.greenlawn.example",
};
const headers = { Authorization: "Bearer token", "X-Company-Id": CO, "Content-Type": "application/json" };
const writes = (table: string, kind: string) => db.calls.filter((c) => c.table === table).flatMap((c) => c.calls.filter(([n]) => n === kind));

beforeEach(() => {
  db.calls = [];
  db.rpcs = [];
  db.hits = [];
  db.reactions = [];
  db.saved = [];
});
afterEach(() => resetHub());

describe("reactions", () => {
  const react = (kind: string, on = true) => app.request(`/api/chat/messages/${MSG}/reactions`, { method: "POST", headers, body: JSON.stringify({ kind, on }) }, env);

  it("take a quick one or a listed emoji, and nothing else", async () => {
    expect((await react("on_it")).status).toBe(200);
    expect((await react("🔥")).status).toBe(200);
    expect((await react("😮‍💨")).status).toBe(200);
    for (const kind of ["🦄", "hello", "<script>", "🔥🔥"]) expect((await react(kind)).status, kind).toBe(400);
    expect(writes("chat_reactions", "upsert").map(([, value]) => (value as { kind: string }).kind)).toEqual(["on_it", "🔥", "😮‍💨"]);
  });

  it("make 👍 the quick thumbs up", async () => {
    await react("👍");
    expect(writes("chat_reactions", "upsert").map(([, value]) => (value as { kind: string }).kind)).toEqual(["thumbs_up"]);
  });

  it("come back with the quick ones first, then the emoji as they came", async () => {
    db.reactions = [
      { user_id: "a", kind: "🔥", created_at: "1" },
      { user_id: "b", kind: "seen", created_at: "2" },
      { user_id: "c", kind: "🎉", created_at: "3" },
      { user_id: "d", kind: "🔥", created_at: "4" },
      { user_id: "e", kind: "thumbs_up", created_at: "5" },
    ];
    const res = await react("🎉");
    expect(((await res.json()) as { reactions: unknown }).reactions).toEqual([
      { kind: "thumbs_up", users: ["e"] },
      { kind: "seen", users: ["b"] },
      { kind: "🔥", users: ["a", "d"] },
      { kind: "🎉", users: ["c"] },
    ]);
  });
});

describe("searching", () => {
  it("asks the database as the person, with the filters, and keeps its order", async () => {
    db.hits = [
      { id: "00000000-0000-4000-8000-0000000000e2", channel_id: CHANNEL, rank: 0.5 },
      { id: "00000000-0000-4000-8000-0000000000e1", channel_id: CHANNEL, rank: 0.2 },
    ];
    const res = await app.request(`/api/chat/search?q=gate%20code&channel=${CHANNEL}&from=${ME}&has=photo,link,nonsense&after=2026-11-01T00:00:00.000Z&order=best&offset=30`, { headers }, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { messages: Array<{ id: string }>; has_more: boolean; next: number };
    expect(body.messages.map((m) => m.id)).toEqual(db.hits.map((h) => h.id));
    expect(body).toMatchObject({ has_more: false, next: 32 });
    expect(db.rpcs.find((r) => r.name === "chat_search")?.args).toMatchObject({
      p_company: CO, p_query: "gate code", p_channel: CHANNEL, p_author: ME, p_has: ["photo", "link"], p_after: "2026-11-01T00:00:00.000Z", p_order: "best", p_limit: 31, p_offset: 30,
    });
  });

  it("refuses what isn't a search", async () => {
    expect((await app.request("/api/chat/search?q=a&channel=nope", { headers }, env)).status).toBe(400);
    expect((await app.request(`/api/chat/search?q=${"x".repeat(201)}`, { headers }, env)).status).toBe(400);
  });
});

describe("saved for later", () => {
  it("saves and takes out the person's own, and tells their other tabs", async () => {
    const got: ChatEvent[] = [];
    subscribe(CO, ME, (e) => got.push(e));
    const save = (saved: boolean) => app.request(`/api/chat/messages/${MSG}/saved`, { method: "PUT", headers, body: JSON.stringify({ saved }) }, env);
    expect(await (await save(true)).json()).toEqual({ saved: true });
    expect(writes("chat_saved", "upsert")[0]![1]).toMatchObject({ message_id: MSG, user_id: ME });
    expect(await (await save(false)).json()).toEqual({ saved: false });
    expect(writes("chat_saved", "match")[0]![1]).toEqual({ message_id: MSG, user_id: ME });
    expect(got.filter((e) => e.type === "saved")).toEqual([{ type: "saved", message_id: MSG, saved: true }, { type: "saved", message_id: MSG, saved: false }]);
  });

  it("lists them newest saved first, with every id for the marks", async () => {
    db.saved = [
      { message_id: "00000000-0000-4000-8000-0000000000f2", created_at: "2026-11-28T10:00:00Z" },
      { message_id: "00000000-0000-4000-8000-0000000000f1", created_at: "2026-11-27T10:00:00Z" },
    ];
    const body = (await (await app.request("/api/chat/saved", { headers }, env)).json()) as { ids: string[]; items: Array<{ saved_at: string; message: { id: string } }> };
    expect(body.ids).toEqual(db.saved.map((s) => s.message_id));
    expect(body.items.map((i) => [i.saved_at, i.message.id])).toEqual(db.saved.map((s) => [s.created_at, s.message_id]));
  });
});
