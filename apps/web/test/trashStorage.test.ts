/**
 * The Trash and how much storage is used (features/drive/DriveTrash.tsx): what's deleted for good,
 * one thing at a time or with Empty Trash, frees its space at once, so Drive's storage line and
 * Settings → Storage read the numbers again along with Drive's lists, not a minute later.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

const COMPANY = "0f0f0f0f-0000-4000-8000-000000000000";
type Options = { mutationFn: (arg: unknown) => Promise<unknown>; onSettled?: () => void };
const seen = vi.hoisted(() => ({ mutations: [] as Options[], called: [] as string[] }));

// The page's mutations, kept so the test can run them as React Query would.
vi.mock("@tanstack/react-query", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-query")>()),
  useMutation: (options: Options) => {
    seen.mutations.push(options);
    return { mutate: () => undefined, isPending: false };
  },
}));
vi.mock("../src/lib/session", () => ({
  useSession: () => ({ role: "owner", permissions: [], userId: "u-me", company: { id: COMPANY, name: "Green Acres", settings: {} }, config: {} }),
  hasRole: () => true,
  can: () => true,
  isSub: () => false,
}));
vi.mock("../src/features/drive/trash", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/features/drive/trash")>()),
  restoreTrash: async () => {
    seen.called.push("restore");
    return { result: "copied", fileId: "f-1" };
  },
  deleteForever: async () => {
    seen.called.push("delete forever");
    return { count: 1, removed: 1 };
  },
  emptyTrash: async () => {
    seen.called.push("empty");
    return { count: 3, removed: 3 };
  },
}));

const { TrashList } = await import("../src/features/drive/DriveTrash");

describe("deleting from the Trash for good", () => {
  it("reads how much storage is used again, for one thing and for Empty Trash", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(["drive", COMPANY, "trash"], []);
    const invalidated = vi.spyOn(client, "invalidateQueries");
    renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(MemoryRouter, null, createElement(TrashList))));

    const item = { kind: "file", id: "t-1", name: "Site plan.pdf" };
    const refreshed: Record<string, unknown[]> = {};
    for (const mutation of seen.mutations) {
      const before = seen.called.length;
      await mutation.mutationFn(item);
      const what = seen.called.slice(before).join();
      if (what === "restore") continue;
      invalidated.mockClear();
      mutation.onSettled?.();
      refreshed[what] = invalidated.mock.calls.map(([filters]) => (filters as { queryKey?: unknown[] } | undefined)?.queryKey);
    }

    expect(Object.keys(refreshed).sort()).toEqual(["delete forever", "empty"]);
    for (const [what, keys] of Object.entries(refreshed)) {
      expect(keys, what).toContainEqual(["storage"]);
      expect(keys, what).toContainEqual(["drive"]);
    }
  });
});
