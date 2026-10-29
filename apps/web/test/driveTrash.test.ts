/**
 * Empty Trash (features/drive/trash.ts emptyTrash): the Trash lists 500 at a time, so emptying it
 * lists again and again until nothing that was there when the owner said to is left, deletes at most
 * 200 a request, asks for each thing once (so one that went back meanwhile can't loop), leaves alone
 * anything moved to the Trash after, and says how far it got when it's stopped part way.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = { kind: string; id: string; deleted_at: string };
const state = vi.hoisted(() => ({
  trash: [] as Row[],
  /** Ids the server skips as no longer in the Trash (put back meanwhile): never deleted. */
  restored: new Set<string>(),
  lists: 0,
  posts: [] as Array<Array<{ kind: string; id: string }>>,
  failOnPost: 0,
}));
vi.mock("../src/lib/api", () => ({
  api: {
    post: async (path: string, body: { items: Array<{ kind: string; id: string }> }) => {
      expect(path).toBe("/drive/trash/delete-forever");
      state.posts.push(body.items);
      if (state.failOnPost && state.posts.length === state.failOnPost) throw new Error("You're offline.");
      const gone = body.items.filter((i) => !state.restored.has(i.id));
      state.trash = state.trash.filter((t) => !gone.some((g) => g.id === t.id));
      return { removed: gone.length };
    },
  },
  unwrap: (r: { data: unknown; error: unknown }) => {
    if (r.error) throw r.error;
    return r.data;
  },
  supabase: () => ({
    rpc: async (name: string) => {
      expect(name).toBe("drive_trash");
      state.lists++;
      // Newest first, 500 at most, like public.drive_trash.
      return { data: [...state.trash].sort((a, b) => b.deleted_at.localeCompare(a.deleted_at)).slice(0, 500), error: null };
    },
  }),
}));
const { emptyTrash } = await import("../src/features/drive/trash");

/** `n` things deleted a minute apart, the newest at 12:00 on Oct 20. */
const fill = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ kind: i % 3 ? "other" : "file", id: `t${i}`, deleted_at: new Date(Date.UTC(2026, 9, 20, 12) - i * 60_000).toISOString() }));
const NEWEST = "2026-10-20T12:00:00.000Z";

beforeEach(() => {
  state.trash = [];
  state.restored = new Set();
  state.lists = 0;
  state.posts = [];
  state.failOnPost = 0;
});

describe("emptying the Trash", () => {
  it("empties all of it, past the 500 it lists, 200 at a time", async () => {
    state.trash = fill(1300);
    expect(await emptyTrash("co-1", NEWEST)).toEqual({ count: 1300, removed: 1300 });
    expect(state.trash).toEqual([]);
    expect(Math.max(...state.posts.map((p) => p.length))).toBe(200);
    expect(new Set(state.posts.flat().map((i) => i.id)).size).toBe(1300);
    expect(state.posts.flat()[0]).toEqual({ kind: "file", id: "t0" });
  });

  it("stops once the list wasn't full: that was everything", async () => {
    state.trash = fill(12);
    expect(await emptyTrash("co-1", NEWEST)).toEqual({ count: 12, removed: 12 });
    expect(state.lists).toBe(1);
  });

  it("leaves what was moved to the Trash after the owner said to empty it", async () => {
    const later = { kind: "other", id: "late", deleted_at: "2026-10-20T12:00:05.000Z" };
    state.trash = [later, ...fill(700)];
    expect(await emptyTrash("co-1", NEWEST)).toEqual({ count: 700, removed: 700 });
    expect(state.trash).toEqual([later]);
    expect(state.posts.flat().some((i) => i.id === "late")).toBe(false);
  });

  it("counts what had already left the Trash as not deleted, and asks for it only once", async () => {
    state.trash = fill(600);
    // Put back meanwhile, but still listed (the server skips them): they must not loop.
    state.restored = new Set(["t1", "t550"]);
    expect(await emptyTrash("co-1", NEWEST)).toEqual({ count: 600, removed: 598 });
    const asked = state.posts.flat().map((i) => i.id);
    expect(asked.filter((id) => id === "t1")).toHaveLength(1);
    expect(asked).toHaveLength(600);
  });

  it("says how far it got when it's stopped part way", async () => {
    state.trash = fill(900);
    state.failOnPost = 3;
    const r = await emptyTrash("co-1", NEWEST);
    expect(r).toMatchObject({ count: 400, removed: 400 });
    expect((r.error as Error).message).toBe("You're offline.");
  });

  it("fails plainly when nothing was deleted yet", async () => {
    state.trash = fill(3);
    state.failOnPost = 1;
    await expect(emptyTrash("co-1", NEWEST)).rejects.toThrow("You're offline.");
    await expect(emptyTrash("co-1", "not a date")).rejects.toThrow(/Refresh/);
  });

  it("has nothing to do when everything already left", async () => {
    expect(await emptyTrash("co-1", NEWEST)).toEqual({ count: 0, removed: 0 });
    expect(state.posts).toEqual([]);
  });
});
