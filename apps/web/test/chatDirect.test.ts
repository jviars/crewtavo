import { describe, expect, it, vi } from "vitest";

// data.ts talks to the backend; these tests only use what it does with what comes back.
vi.mock("@/lib/api", () => ({ activeCompany: () => null, api: {}, refreshSignIn: async () => "ok", supabase: () => ({}) }));
vi.mock("@/lib/session", () => ({ useSession: () => ({}) }));

const { directList, directName, directPeople, seenText, withDirectNames } = await import("../src/features/chat/direct");
type State = Parameters<typeof withDirectNames>[0];

const person = (id: string, name: string) => ({ id, name, avatar_color: null, avatar_url: null, role_key: "field_crew", role_label: "Field crew", color: "default" as const });
const channel = (id: string, extra: Partial<State["channels"][number]> = {}): State["channels"][number] => ({
  id, kind: "direct", name: `dm-${id}`, category: "Direct messages", topic: null, crew_id: null, position: 0, archived: false,
  can_post: true, can_manage: false, unread: 0, mentions: 0, last_message_at: null, created_at: "2026-11-20T10:00:00Z", people: [], closed: false, ...extra,
});

describe("naming a direct conversation", () => {
  it("is the other person's name, or the group's first names", () => {
    expect(directName([person("m", "Marcus Reyes")])).toBe("Marcus Reyes");
    expect(directName([person("m", "Marcus Reyes"), person("t", "Tyler Brooks")])).toBe("Marcus and Tyler");
    expect(directName([person("m", "Marcus Reyes"), person("t", "Tyler Brooks"), person("s", "Sam Ortiz")])).toBe("Marcus, Tyler and Sam");
    expect(directName(["Marcus Reyes", "Tyler Brooks", "Sam Ortiz", "Ben Carter", "Ruth Kim"].map((n, i) => person(String(i), n)))).toBe("Marcus, Tyler, Sam and 2 others");
    expect(directName(["Marcus Reyes", "Tyler Brooks", "Sam Ortiz", "Ben Carter"].map((n, i) => person(String(i), n)))).toBe("Marcus, Tyler, Sam and 1 other");
  });

  it("uses full names when two people share a first name, and says when nobody else is left", () => {
    expect(directName([person("a", "Sam Ortiz"), person("b", "Sam Lee")])).toBe("Sam Ortiz and Sam Lee");
    expect(directName([])).toBe("Only you");
  });

  it("names each conversation in the state by its people, and leaves channels alone", () => {
    const state: State = {
      enabled: true, direct_messages: true, me: null, roles: [],
      people: { m: person("m", "Marcus Reyes"), t: person("t", "Tyler Brooks") },
      channels: [channel("1", { people: ["m", "t"] }), { ...channel("2"), kind: "text", name: "general", people: null }],
    };
    expect(withDirectNames(state).channels.map((c) => c.name)).toEqual(["Marcus and Tyler", "general"]);
    // Someone the server didn't describe still shows.
    expect(directPeople({ people: ["x"] }, {}).map((p) => p.name)).toEqual(["Someone"]);
  });
});

describe("the Direct messages list", () => {
  it("puts the latest first, a new conversation by when it started, and leaves out closed ones unless open", () => {
    const list = directList(
      [
        channel("old", { last_message_at: "2026-11-21T09:00:00Z" }),
        channel("new", { last_message_at: "2026-11-27T09:00:00Z" }),
        channel("empty", { created_at: "2026-11-25T09:00:00Z" }),
        channel("closed", { last_message_at: "2026-11-28T09:00:00Z", closed: true }),
        { ...channel("general"), kind: "text" },
      ],
      undefined,
    );
    expect(list.map((c) => c.id)).toEqual(["new", "empty", "old"]);
    expect(directList([channel("closed", { closed: true })], "closed").map((c) => c.id)).toEqual(["closed"]);
  });
});

describe("seen, in a direct conversation", () => {
  it("says Seen with one other person, and who in a group", () => {
    expect(seenText([], 1)).toBeNull();
    expect(seenText([person("m", "Marcus Reyes")], 1)).toBe("Seen");
    expect(seenText([person("m", "Marcus Reyes")], 3)).toBe("Seen by Marcus Reyes");
    expect(seenText([person("m", "Marcus Reyes"), person("t", "Tyler Brooks")], 3)).toBe("Seen by Marcus and Tyler");
    expect(seenText([person("m", "Marcus Reyes"), person("t", "Tyler Brooks"), person("s", "Sam Ortiz")], 3)).toBe("Seen by everyone");
  });
});
