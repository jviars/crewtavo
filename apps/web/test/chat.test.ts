import { describe, expect, it, vi } from "vitest";

// data.ts talks to the backend; these tests only use what it does with what comes back.
vi.mock("@/lib/api", () => ({ activeCompany: () => null, api: {}, refreshSignIn: async () => "ok", supabase: () => ({}) }));
vi.mock("@/lib/session", () => ({ useSession: () => ({}) }));

const { readEvents } = await import("../src/features/chat/data");
const { groupMembers } = await import("../src/features/chat/Members");
const { dayLabel, isNewDay, startsGroup } = await import("../src/features/chat/ui");

function stream(chunks: string[]) {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
}

describe("the live connection", () => {
  it("reads events split anywhere across chunks, and skips pings", async () => {
    const seen: unknown[] = [];
    await readEvents(
      stream([
        'event: hello\ndata: {"type":"hello","online":["a"]}\n\n',
        "event: ping\ndata: {}\n\nevent: mess",
        'age\ndata: {"type":"message","channel_id":"c","message":{"id":"m","body":"two\\nlines"}}',
        "\n\n",
        "event: broken\ndata: {not json\n\n",
        'data: {"type":"channels"}\n\n',
      ]),
      (e) => seen.push(e),
    );
    expect(seen).toEqual([
      { type: "hello", online: ["a"] },
      { type: "message", channel_id: "c", message: { id: "m", body: "two\nlines" } },
      { type: "channels" },
    ]);
  });
});

describe("the member list", () => {
  const person = (id: string, role_key: string, role_label: string, show_separately: boolean, online: boolean) => ({
    id, name: id, avatar_color: null, avatar_url: null, role: role_key, role_key, role_label, color: "default" as const, show_separately, online,
  });

  it("groups online people by role (owner first), the rest online together, then offline", () => {
    const groups = groupMembers(
      [
        person("tyler", "field_crew", "Field crew", true, true),
        person("jess", "owner", "Owner", true, true),
        person("sam", "x1", "Seasonal help", false, true),
        person("ben", "field_crew", "Field crew", true, false),
        person("marcus", "crew_lead", "Crew lead", true, false),
      ],
      new Set(["marcus"]),
    );
    expect(groups.map((g) => [g.title, g.people.map((p) => p.id)])).toEqual([
      ["Owner", ["jess"]],
      ["Crew lead", ["marcus"]],
      ["Field crew", ["tyler"]],
      ["Online", ["sam"]],
      ["Offline", ["ben"]],
    ]);
  });
});

describe("message grouping", () => {
  it("shows the sender again for a new person, a new day, or after five minutes", () => {
    const at = (iso: string, author: string | null = "a") => ({ author_id: author, created_at: iso });
    expect(startsGroup(undefined, at("2026-10-19T10:00:00"))).toBe(true);
    expect(startsGroup(at("2026-10-19T10:00:00"), at("2026-10-19T10:04:00"))).toBe(false);
    expect(startsGroup(at("2026-10-19T10:00:00"), at("2026-10-19T10:06:00"))).toBe(true);
    expect(startsGroup(at("2026-10-19T10:00:00"), at("2026-10-19T10:01:00", "b"))).toBe(true);
    expect(isNewDay(at("2026-10-18T23:59:00"), at("2026-10-19T00:01:00"))).toBe(true);
  });

  it("calls days Today, Yesterday, or by name", () => {
    const now = new Date("2026-10-19T15:00:00");
    expect(dayLabel("2026-10-19T08:00:00", now)).toBe("Today");
    expect(dayLabel("2026-10-18T08:00:00", now)).toBe("Yesterday");
    expect(dayLabel("2026-10-16T08:00:00", now)).toMatch(/Friday/);
    expect(dayLabel("2025-10-16T08:00:00", now)).toMatch(/2025/);
  });
});
