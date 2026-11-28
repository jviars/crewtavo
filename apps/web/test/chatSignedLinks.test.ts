import { describe, expect, it, vi } from "vitest";

// signedLinks.ts signs with lib/files; these tests only use the store that decides what to sign.
vi.mock("@/lib/files", () => ({ signedUrls: async () => ({}) }));

const { LINK_SECONDS, LinkStore, RENEW_MS, RETRY_MS } = await import("../src/features/chat/signedLinks");

const HOUR = LINK_SECONDS * 1000;

describe("chat's links to photos and voice notes", () => {
  it("sign only the files without a link, and keep each link as it was", () => {
    const store = new LinkStore();
    expect(store.need(["a.jpg", "b.m4a", "a.jpg"], 0)).toEqual(["a.jpg", "b.m4a"]);
    store.start(["a.jpg", "b.m4a"]);
    // Asked for again while they're being signed (another screen): not twice.
    expect(store.need(["a.jpg", "b.m4a"], 1)).toEqual([]);
    store.done(["a.jpg", "b.m4a"], { "a.jpg": "https://files/a?1", "b.m4a": "https://files/b?1" }, 0);
    // One more photo comes, or older messages load: only the new file is signed.
    expect(store.need(["a.jpg", "b.m4a", "c.jpg"], 1_000)).toEqual(["c.jpg"]);
    store.start(["c.jpg"]);
    store.done(["c.jpg"], { "c.jpg": "https://files/c?1" }, 1_000);
    expect(store.get(["a.jpg", "b.m4a", "c.jpg"])).toEqual({ "a.jpg": "https://files/a?1", "b.m4a": "https://files/b?1", "c.jpg": "https://files/c?1" });
  });

  it("renew a link before it runs out, keeping the old one until the new one comes", () => {
    const store = new LinkStore();
    store.start(["a.jpg"]);
    store.done(["a.jpg"], { "a.jpg": "https://files/a?1" }, 0);
    expect(store.nextLook(["a.jpg"])).toBe(HOUR - RENEW_MS);
    expect(store.need(["a.jpg"], HOUR - RENEW_MS - 1)).toEqual([]);
    expect(store.need(["a.jpg"], HOUR - RENEW_MS + 1)).toEqual(["a.jpg"]);
    store.start(["a.jpg"]);
    expect(store.get(["a.jpg"])).toEqual({ "a.jpg": "https://files/a?1" });
    store.done(["a.jpg"], { "a.jpg": "https://files/a?2" }, HOUR - RENEW_MS + 1);
    expect(store.get(["a.jpg"])).toEqual({ "a.jpg": "https://files/a?2" });
  });

  it("ask again a little later about a file that got no link, not over and over", () => {
    const store = new LinkStore();
    store.start(["gone.jpg"]);
    store.done(["gone.jpg"], {}, 0);
    expect(store.get(["gone.jpg"])).toEqual({});
    expect(store.need(["gone.jpg"], 1)).toEqual([]);
    expect(store.nextLook(["gone.jpg"])).toBe(RETRY_MS);
    expect(store.need(["gone.jpg"], RETRY_MS + 1)).toEqual(["gone.jpg"]);
  });
});
