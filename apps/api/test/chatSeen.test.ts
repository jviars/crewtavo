import { afterEach, describe, expect, it, vi } from "vitest";
import { resetHub, subscribe, type ChatEvent } from "../src/lib/chatHub";
import { noteSeen, resetSeen, SEEN_MS } from "../src/lib/chatSeen";
import type { Db } from "../src/lib/supabase";

// The service-role client, answering "who can see this channel?" the way public.chat_audience does.
const admin = (audience: string[]) => ({ rpc: vi.fn(async () => ({ data: audience, error: null })) }) as unknown as Db;

afterEach(() => {
  resetSeen();
  resetHub();
  vi.useRealTimers();
});

describe("seen, live", () => {
  it("tells a conversation's people who read it, once for a burst of reads", async () => {
    vi.useFakeTimers();
    const got: ChatEvent[] = [];
    subscribe("kilo", "dana", (e) => e.type === "seen" && got.push(e));
    const db = admin(["dana", "marcus", "tyler"]);
    const dm = { id: "dm", kind: "direct" };
    noteSeen(db, "kilo", dm, "marcus", "2026-11-28T10:00:00Z", () => undefined);
    noteSeen(db, "kilo", dm, "marcus", "2026-11-28T10:00:02Z", () => undefined);
    noteSeen(db, "kilo", dm, "tyler", "2026-11-28T10:00:01Z", () => undefined);
    expect(got).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(SEEN_MS);
    expect(got).toEqual([{ type: "seen", channel_id: "dm", reads: [{ user_id: "marcus", at: "2026-11-28T10:00:02Z" }, { user_id: "tyler", at: "2026-11-28T10:00:01Z" }] }]);
    // The next read after that goes in a new round.
    noteSeen(db, "kilo", dm, "tyler", "2026-11-28T10:01:00Z", () => undefined);
    await vi.advanceTimersByTimeAsync(SEEN_MS);
    expect(got).toHaveLength(2);
  });

  it("says only that an announcement was read, and nothing for other channels", async () => {
    vi.useFakeTimers();
    const got: ChatEvent[] = [];
    subscribe("kilo", "dana", (e) => e.type === "seen" && got.push(e));
    const db = admin(["dana", "tyler"]);
    noteSeen(db, "kilo", { id: "ann", kind: "announcement" }, "tyler", "2026-11-28T10:00:00Z", () => undefined);
    noteSeen(db, "kilo", { id: "general", kind: "text" }, "tyler", "2026-11-28T10:00:00Z", () => undefined);
    await vi.advanceTimersByTimeAsync(SEEN_MS);
    expect(got).toEqual([{ type: "seen", channel_id: "ann" }]);
  });
});
