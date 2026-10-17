/**
 * The field queue for crews with no signal (lib/offline.ts): queued actions are sent once, the
 * saved copy never lists actions that have gone out, a weak signal queues instead of failing, and
 * each action goes to the company it was made in.
 */
import { onlineManager, QueryClient, QueryObserver } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saveVisitNotes, setVisitStatus } from "../src/features/field/fieldActions";
import { api, setActiveCompany } from "../src/lib/api";
import { ApiError, OFFLINE } from "../src/lib/errors";
import { FIELD_SCOPE, forgetOfflineCache, keepQueuedFieldActions, pendingFieldActions, startOfflineCache } from "../src/lib/offline";

// The phone's storage, which can be made to run out of room.
const store = new Map<string, string>();
let room = Infinity;
const storage = {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => {
    if (value.length > room) throw new Error("QuotaExceededError");
    store.set(key, value);
  },
  removeItem: (key: string) => void store.delete(key),
  clear: () => store.clear(),
  key: (i: number) => [...store.keys()][i] ?? null,
  get length() {
    return store.size;
  },
};
type Saved = { mutations: Array<{ state: { variables: unknown } }>; queries: Array<{ queryKey: unknown[]; state: { data: { status?: string } } }> };
const saved = (userId: string) => JSON.parse(store.get(`crewtavo.offline.v1.${userId}`) ?? "null") as Saved | null;

const clients: QueryClient[] = [];
/** Configured like lib/queryClient.ts (no retries by default), and mounted like the app's. */
function newClient() {
  const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  qc.mount();
  clients.push(qc);
  return qc;
}
/** A field action made on a screen, as useMutation would (onMutate is the screen's optimistic change). */
function tap(qc: QueryClient, key: string, variables: object, onMutate?: (v: never) => void) {
  return qc
    .getMutationCache()
    .build(qc, { mutationKey: [key], scope: FIELD_SCOPE, onMutate })
    .execute(variables)
    .then(
      () => "sent",
      () => "failed",
    );
}
/** Past the 800 ms save delay, with whatever requests are under way answered. */
const settle = (ms = 1_000) => vi.advanceTimersByTimeAsync(ms);

beforeEach(() => {
  store.clear();
  room = Infinity;
  vi.stubGlobal("localStorage", storage);
  vi.stubGlobal("navigator", { onLine: true });
  vi.useFakeTimers();
  onlineManager.setOnline(true);
});

afterEach(async () => {
  onlineManager.setOnline(true);
  await vi.runOnlyPendingTimersAsync(); // let a pending connection check finish
  clients.splice(0).forEach((qc) => qc.unmount());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** The server side of a visit status change, with the clock rules of fieldData.clockVisit. */
function fakeServer() {
  const s = { patches: [] as string[], entries: [] as Array<{ visit_id: string; started_at: string; ended_at: string | null }> };
  const setVisitStatus = async (v: { visitId: string; status: string; at: string }) => {
    await new Promise((r) => setTimeout(r, 5));
    s.patches.push(v.status);
    const action = v.status === "in_progress" ? "start" : v.status === "completed" ? "stop" : null;
    if (!action) return;
    for (const e of s.entries.filter((e) => e.ended_at === null)) {
      if (action === "start" && e.visit_id === v.visitId) return;
      if (e.started_at >= v.at) continue;
      e.ended_at = v.at;
    }
    if (action === "start") s.entries.push({ visit_id: v.visitId, started_at: v.at, ended_at: null });
  };
  return { s, setVisitStatus };
}

describe("restoring the saved queue", () => {
  it("sends each queued action once when the offline cache starts again (StrictMode, a remount, a new role)", async () => {
    const qc = newClient();
    const server = fakeServer();
    qc.setMutationDefaults(["visit-status"], { mutationFn: server.setVisitStatus });
    onlineManager.setOnline(false);
    let stop = startOfflineCache(qc, "u1", true);
    void tap(qc, "visit-status", { visitId: "v1", status: "en_route", at: "2026-10-17T13:00:00.000Z" });
    void tap(qc, "visit-status", { visitId: "v1", status: "in_progress", at: "2026-10-17T13:20:00.000Z" });
    void tap(qc, "visit-status", { visitId: "v1", status: "completed", at: "2026-10-17T15:20:00.000Z" });
    await settle();
    expect(saved("u1")!.mutations).toHaveLength(3);

    stop();
    stop = startOfflineCache(qc, "u1", true);
    stop();
    stop = startOfflineCache(qc, "u1", true);
    expect(pendingFieldActions(qc)).toBe(3);

    onlineManager.setOnline(true);
    await settle();
    expect(server.s.patches).toEqual(["en_route", "in_progress", "completed"]);
    // One two-hour entry on the timesheet, not two.
    expect(server.s.entries).toEqual([{ visit_id: "v1", started_at: "2026-10-17T13:20:00.000Z", ended_at: "2026-10-17T15:20:00.000Z" }]);
    expect(saved("u1")!.mutations).toHaveLength(0);
    stop();
  });

  it("keeps the queue when the app signs the person out, and sends it once they sign back in", async () => {
    const qc = newClient();
    const sent: unknown[] = [];
    qc.setMutationDefaults(["visit-notes"], { mutationFn: async (v: unknown) => void sent.push(v) });
    onlineManager.setOnline(false);
    const stop = startOfflineCache(qc, "u2", true);
    qc.setQueryData(["field-visit", "v1"], { id: "v1", status: "in_progress" });
    void tap(qc, "visit-notes", { visitId: "v1", notes: "Gate was open" });
    await settle();

    // SIGNED_OUT (an expired sign-in), sometimes twice in a row.
    keepQueuedFieldActions(qc, "u2");
    qc.clear();
    keepQueuedFieldActions(qc, "u2");
    stop();
    await settle();
    expect(saved("u2")).toMatchObject({ mutations: [{ state: { variables: { notes: "Gate was open" } } }], queries: [] });

    onlineManager.setOnline(true);
    const again = startOfflineCache(qc, "u2", true);
    await settle();
    expect(sent).toEqual([{ visitId: "v1", notes: "Gate was open" }]);
    expect(saved("u2")!.mutations).toHaveLength(0);
    again();
  });

  it("forgets everything when the person signs out, even with a save due", async () => {
    const qc = newClient();
    startOfflineCache(qc, "u3", true);
    qc.setQueryData(["field-visit", "v1"], { id: "v1", status: "scheduled" });
    await settle();
    qc.setQueryData(["field-visit", "v1"], { id: "v1", status: "en_route" });
    forgetOfflineCache("u3");
    qc.clear();
    await settle();
    expect(store.size).toBe(0);
  });
});

describe("saving the queue", () => {
  it("past the 2 MB budget, still saves the queue (without cached screens), so sent actions don't come back", async () => {
    const qc = newClient();
    let sent = 0;
    qc.setMutationDefaults(["visit-notes"], { mutationFn: async () => void sent++ });
    onlineManager.setOnline(false);
    const stop = startOfflineCache(qc, "u4", true);
    qc.setQueryData(["field", "c1", "2026-10-17"], { today: [] });
    void tap(qc, "visit-notes", { visitId: "v1", notes: "Gate was open" });
    await settle();
    expect(saved("u4")!.queries).toHaveLength(1);

    // Big visits (checklists with drawn signatures) push the cached screens past the budget.
    qc.setQueryData(["checklist", "v9"], { blob: "x".repeat(2_100_000) });
    await settle();
    expect(saved("u4")).toMatchObject({ mutations: [{ state: { variables: { notes: "Gate was open" } } }], queries: [] });

    onlineManager.setOnline(true);
    await settle();
    expect(sent).toBe(1);
    expect(saved("u4")!.mutations).toHaveLength(0);
    stop();

    // The next time the app opens on this phone.
    const next = newClient();
    next.setMutationDefaults(["visit-notes"], { mutationFn: async () => void sent++ });
    const stopNext = startOfflineCache(next, "u4", true);
    await settle();
    expect(sent).toBe(1);
    stopNext();
  });

  it("with storage full, saves the queue alone, and if even that won't fit, drops the old copy", async () => {
    const qc = newClient();
    let sent = 0;
    qc.setMutationDefaults(["visit-notes"], { mutationFn: async () => void sent++ });
    onlineManager.setOnline(false);
    const stop = startOfflineCache(qc, "u5", true);
    qc.setQueryData(["field-visit", "v1"], { id: "v1", notes: "x".repeat(5_000) });
    void tap(qc, "visit-notes", { visitId: "v1", notes: "Gate was open" });
    await settle();
    expect(saved("u5")!.queries).toHaveLength(1);

    room = 1_000;
    qc.setQueryData(["field-visit", "v1"], { id: "v1", notes: "y".repeat(5_000) });
    await settle();
    expect(saved("u5")).toMatchObject({ mutations: [{ state: { variables: { notes: "Gate was open" } } }], queries: [] });

    room = 10;
    onlineManager.setOnline(true);
    await settle();
    expect(sent).toBe(1);
    expect(saved("u5")).toBeNull();
    stop();
  });
});

describe("weak signal", () => {
  it("a field action that can't reach the server, though the phone says it's online, waits and goes out once requests get through", async () => {
    const qc = newClient();
    let reachable = false;
    const sent: unknown[] = [];
    qc.setMutationDefaults(["visit-status"], {
      mutationFn: async (v: unknown) => {
        if (!reachable) throw new ApiError(OFFLINE, 0, "network");
        sent.push(v);
      },
    });
    const check = vi.fn(async () => {
      if (!reachable) throw new TypeError("Failed to fetch");
      return new Response("{}");
    });
    vi.stubGlobal("fetch", check);
    const stop = startOfflineCache(qc, "u6", true);
    qc.setQueryData(["field-visit", "v1"], { id: "v1", status: "scheduled" });
    const result = tap(qc, "visit-status", { visitId: "v1", status: "in_progress", at: "2026-10-17T13:20:00.000Z" }, (v: { status: string }) =>
      qc.setQueryData(["field-visit", "v1"], (old: object) => ({ ...old, status: v.status })),
    );
    await settle(1_500);

    const [action] = qc.getMutationCache().getAll();
    expect(action!.state).toMatchObject({ status: "pending", isPaused: true });
    expect(onlineManager.isOnline()).toBe(false); // so later taps queue too
    expect(pendingFieldActions(qc)).toBe(1);
    expect(saved("u6")!.mutations).toHaveLength(1);

    await settle(10_000);
    expect(check).toHaveBeenCalled();
    expect(sent).toHaveLength(0);
    expect(action!.state.status).toBe("pending");

    reachable = true;
    await settle(31_000);
    expect(onlineManager.isOnline()).toBe(true);
    await expect(result).resolves.toBe("sent");
    expect(sent).toHaveLength(1);
    expect(qc.getQueryData(["field-visit", "v1"])).toMatchObject({ status: "in_progress" });
    expect(saved("u6")!.mutations).toHaveLength(0);
    stop();
  });

  it("a refusal from the server still fails, isn't retried, and what the screen showed ahead of it is undone", async () => {
    const qc = newClient();
    let calls = 0;
    qc.setMutationDefaults(["visit-status"], {
      mutationFn: async () => {
        calls++;
        throw new ApiError("The office cancelled this visit.", 409);
      },
    });
    const stop = startOfflineCache(qc, "u7", true);
    const screen = new QueryObserver(qc, { queryKey: ["field-visit", "v1"], queryFn: async () => ({ id: "v1", status: "scheduled" }) });
    const unsubscribe = screen.subscribe(() => undefined);
    await settle();

    // No onSettled refresh, like an action restored after a restart.
    const result = tap(qc, "visit-status", { visitId: "v1", status: "in_progress", at: "2026-10-17T13:20:00.000Z" }, (v: { status: string }) =>
      qc.setQueryData(["field-visit", "v1"], (old: object) => ({ ...old, status: v.status })),
    );
    await settle();
    await expect(result).resolves.toBe("failed");
    expect(calls).toBe(1);
    expect(onlineManager.isOnline()).toBe(true);
    expect(qc.getQueryData(["field-visit", "v1"])).toEqual({ id: "v1", status: "scheduled" });
    expect(pendingFieldActions(qc)).toBe(0);
    expect(saved("u7")!.mutations).toHaveLength(0);
    expect(saved("u7")!.queries.find((q) => q.queryKey[0] === "field-visit")!.state.data.status).toBe("scheduled");
    unsubscribe();
    stop();
  });
});

describe("company", () => {
  it("sends a field action as the company it was made in, even after switching company", async () => {
    const sentAs: Array<string | undefined> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        sentAs.push((init.headers as Record<string, string>)["X-Company-Id"]);
        return new Response("{}");
      }),
    );
    setActiveCompany("company-b");
    await setVisitStatus({ companyId: "company-a", userId: "u1", visitId: "v1", jobId: null, status: "en_route", at: "2026-10-17T13:00:00.000Z" });
    await saveVisitNotes({ companyId: "company-a", visitId: "v1", notes: "Gate code changed" });
    // Notes queued before they recorded their company, and everything else, go as the company on screen.
    await saveVisitNotes({ visitId: "v1", notes: "Side gate" });
    await api.get("/me");
    expect(sentAs).toEqual(["company-a", "company-a", "company-b", "company-b"]);
    setActiveCompany(null);
  });
});
