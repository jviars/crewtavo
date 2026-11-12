/**
 * Photos added to a visit with no signal (lib/offlinePhotos.ts): kept on the phone until they've
 * uploaded, even if the app is closed in between; added once however often they're sent; said
 * plainly when the phone won't keep one; counted as waiting, and in the warning before signing out;
 * cleared when the person signs out, and kept when the app signs them out.
 */
import { onlineManager, QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeIndexedDb } from "./fakeIndexedDb";
import { FakeCaches } from "./serviceWorker";

/** The server's storage and the attachments table, as far as a photo upload goes. */
const server = vi.hoisted(() => ({
  files: new Map<string, number>(),
  rows: [] as Array<Record<string, unknown>>,
  uploads: 0,
  /** Answers that don't make it back to the phone, though the server did its part. */
  loseFileAnswers: 0,
  loseRowAnswers: 0,
  /** Turns every photo's row away: the visit was removed, or isn't this person's any more. */
  refuse: false,
}));
const lost = { message: "TypeError: Failed to fetch" };

/** The app's own errors, of the app that's open now (each time it opens, its modules load afresh). */
const open = vi.hoisted(() => ({ errors: null as null | typeof import("../src/lib/errors") }));

vi.mock("../src/lib/api", () => ({
  // What lib/api.ts's unwrap does with a database answer.
  unwrap: (result: { data: unknown; error: { message: string; code?: string } | null }) => {
    if (result.error) throw open.errors!.friendlyDbError(result.error);
    return result.data;
  },
  supabase: () => ({
    storage: {
      from: () => ({
        upload: async (path: string, body: Blob) => {
          server.uploads++;
          if (server.files.has(path)) return { data: null, error: { message: "The resource already exists", statusCode: "409" } };
          server.files.set(path, body.size);
          return server.loseFileAnswers-- > 0 ? { data: null, error: lost } : { data: { path }, error: null };
        },
      }),
    },
    from: () => ({
      insert: async (row: Record<string, unknown>) => {
        if (server.refuse) return { data: null, status: 403, error: { code: "42501", message: 'new row violates row-level security policy for table "attachments"' } };
        if (server.rows.some((r) => r.id === row.id)) return { data: null, status: 409, error: { code: "23505", message: 'duplicate key value violates unique constraint "attachments_pkey"' } };
        server.rows.push(row);
        return server.loseRowAnswers-- > 0 ? { data: null, status: 0, error: lost } : { data: null, status: 201, error: null };
      },
    }),
  }),
}));

const idb = { current: new FakeIndexedDb() };
const kept = () => idb.current.rows("crewtavo-phone", "photos") as Array<{ id: string; userId: string }>;
const photo = (name = "gate.jpg") => new File([new Uint8Array(2_000)], name, { type: "image/jpeg" });
const store = new Map<string, string>();

const closeApp: Array<() => void> = [];
/**
 * Crewtavo opened on the phone, with or without signal: its modules loaded fresh, as after the
 * phone closed it (whatever the last one held in memory is gone, and it sends nothing more).
 */
async function openApp(signal: boolean) {
  closeApp.splice(0).forEach((stop) => stop());
  vi.resetModules();
  onlineManager.setOnline(signal);
  open.errors = await import("../src/lib/errors");
  const photos = await import("../src/lib/offlinePhotos");
  const offline = await import("../src/lib/offline");
  const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  const closing = <A extends unknown[]>(start: (...args: A) => () => void) => (...args: A) => {
    const stop = start(...args);
    closeApp.push(stop);
    return stop;
  };
  return { onlineManager, queryClient, ...photos, ...offline, startPhotoQueue: closing(photos.startPhotoQueue), startOfflineCache: closing(offline.startOfflineCache) };
}
/** Long enough for whatever is under way to finish: many turns of the event loop, however busy the machine. */
async function settled() {
  for (let turn = 0; turn < 30; turn++) await new Promise((resolve) => setTimeout(resolve, 3));
}

beforeEach(() => {
  idb.current = new FakeIndexedDb();
  Object.assign(server, { uploads: 0, loseFileAnswers: 0, loseRowAnswers: 0, refuse: false, rows: [] });
  server.files.clear();
  store.clear();
  vi.stubGlobal("indexedDB", idb.current);
  vi.stubGlobal("navigator", { onLine: true });
  vi.stubGlobal("localStorage", { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) });
});

afterEach(() => {
  closeApp.splice(0).forEach((stop) => stop());
  onlineManager.setOnline(true);
  vi.unstubAllGlobals();
});

describe("a photo taken with no signal", () => {
  it("is kept on the phone, and goes up once when the app is opened again with signal, after it was closed", async () => {
    const app = await openApp(false);
    app.startPhotoQueue(app.queryClient, "u1", () => undefined);
    expect(await app.addVisitPhoto({ userId: "u1", companyId: "c1", visitId: "v1" }, photo())).toBe(true);
    await settled();
    expect(server.uploads).toBe(0);
    expect(kept()).toHaveLength(1);
    expect(app.phonePhotos()).toMatchObject([{ visitId: "v1", kept: true, sending: false }]);
    expect([app.photosNotSent("u1"), app.photosWaiting("u1")]).toEqual([1, 1]);

    // The phone closed Crewtavo while it was put away. Opened again, in town.
    const next = await openApp(true);
    expect(next.phonePhotos()).toEqual([]);
    const reloaded = vi.spyOn(next.queryClient, "invalidateQueries");
    next.startPhotoQueue(next.queryClient, "u1", () => undefined);
    await settled();
    expect(server.rows).toMatchObject([{ id: expect.any(String), company_id: "c1", owner_type: "visit", owner_id: "v1", file_name: "gate.jpg", content_type: "image/jpeg", size_bytes: 2_000 }]);
    expect(String(server.rows[0]!.path)).toBe(`c1/visit/v1/${String(server.rows[0]!.id)}.jpg`);
    expect([...server.files]).toEqual([[server.rows[0]!.path, 2_000]]);
    // Off the phone only now, and the visit's photos load again to show it.
    expect(kept()).toEqual([]);
    expect(next.phonePhotos()).toEqual([]);
    expect(reloaded).toHaveBeenCalledWith({ queryKey: ["photos", "v1"] });

    // Nothing left to send the time after.
    const later = await openApp(true);
    later.startPhotoQueue(later.queryClient, "u1", () => undefined);
    await settled();
    expect(server.uploads).toBe(1);
  });

  it("is added once, however often it's sent: an answer that never arrived doesn't make a second copy", async () => {
    const app = await openApp(false);
    const unreachable = vi.fn();
    app.startPhotoQueue(app.queryClient, "u1", unreachable);
    await app.addVisitPhoto({ userId: "u1", companyId: "c1", visitId: "v1" }, photo());

    // One bar: the file gets there, the answer doesn't.
    server.loseFileAnswers = 1;
    app.onlineManager.setOnline(true);
    await settled();
    expect(unreachable).toHaveBeenCalledTimes(1);
    expect(kept()).toHaveLength(1);
    expect(app.phonePhotos()).toMatchObject([{ sending: false }]);
    expect(app.phonePhotos()[0]!.problem).toBeUndefined();

    // Again: the file is there already, its row goes in, and that answer is lost too.
    server.loseRowAnswers = 1;
    app.onlineManager.setOnline(false);
    app.onlineManager.setOnline(true);
    await settled();

    expect(unreachable).toHaveBeenCalledTimes(2);
    expect(kept()).toHaveLength(1);

    // And closed before the third try, which finds both in place.
    const next = await openApp(true);
    next.startPhotoQueue(next.queryClient, "u1", () => undefined);
    await settled();
    expect(server.uploads).toBe(3);
    expect(server.files.size).toBe(1);
    expect(server.rows).toHaveLength(1);
    expect(kept()).toEqual([]);
  });

  it("when the phone has no room for it, says so as it's taken, holds it while the app stays open, and still sends it", async () => {
    const app = await openApp(false);
    app.startPhotoQueue(app.queryClient, "u1", () => undefined);
    idb.current.full = true;
    expect(await app.addVisitPhoto({ userId: "u1", companyId: "c1", visitId: "v1" }, photo())).toBe(false);
    expect(kept()).toEqual([]);
    expect(app.phonePhotos()).toMatchObject([{ kept: false }]);
    // Counted before signing out, but never as saved on the phone.
    expect([app.photosNotSent("u1"), app.photosWaiting("u1")]).toEqual([1, 0]);

    app.onlineManager.setOnline(true);
    await settled();
    expect(server.rows).toHaveLength(1);
    expect(app.phonePhotos()).toEqual([]);
  });

  it("the same on a phone with its storage turned off", async () => {
    vi.stubGlobal("indexedDB", undefined);
    const app = await openApp(false);
    app.startPhotoQueue(app.queryClient, "u1", () => undefined);
    expect(await app.addVisitPhoto({ userId: "u1", companyId: "c1", visitId: "v1" }, photo())).toBe(false);
    app.onlineManager.setOnline(true);
    await settled();
    expect(server.rows).toHaveLength(1);
  });

  it("for a visit the office removed meanwhile, stays on the phone and says why, without trying over and over; Try again sends it", async () => {
    const app = await openApp(false);
    app.startPhotoQueue(app.queryClient, "u1", () => undefined);
    await app.addVisitPhoto({ userId: "u1", companyId: "c1", visitId: "v1" }, photo("first.jpg"));
    await app.addVisitPhoto({ userId: "u1", companyId: "c1", visitId: "v2" }, photo("second.jpg"));

    server.refuse = true;
    app.onlineManager.setOnline(true);
    await settled();
    expect(app.phonePhotos()).toMatchObject([
      { fileName: "first.jpg", sending: false, problem: "You don't have permission to do that." },
      { fileName: "second.jpg", sending: false, problem: "You don't have permission to do that." },
    ]);
    expect(kept()).toHaveLength(2);
    expect(app.photosWaiting("u1")).toBe(0);
    app.onlineManager.setOnline(false);
    app.onlineManager.setOnline(true);
    await settled();
    expect(server.uploads).toBe(2);

    // The office put the visit back.
    server.refuse = false;
    app.retryPhonePhotos("u1");
    await settled();
    expect(server.rows.map((r) => r.file_name)).toEqual(["first.jpg", "second.jpg"]);
    expect(kept()).toEqual([]);
  });

  it("can be removed from the phone before it's sent", async () => {
    const app = await openApp(false);
    app.startPhotoQueue(app.queryClient, "u1", () => undefined);
    await app.addVisitPhoto({ userId: "u1", companyId: "c1", visitId: "v1" }, photo());
    app.removePhonePhoto(app.phonePhotos()[0]!.id);
    await settled();
    expect(kept()).toEqual([]);
    app.onlineManager.setOnline(true);
    await settled();
    expect(server.uploads).toBe(0);
  });
});

describe("whose photos", () => {
  it("only the signed-in person's go up; another's wait on the phone for them", async () => {
    const app = await openApp(false);
    let stop = app.startPhotoQueue(app.queryClient, "u1", () => undefined);
    await app.addVisitPhoto({ userId: "u1", companyId: "c1", visitId: "v1" }, photo());
    stop();

    // Their sign-in expired, and a crewmate signs in on the same phone, with signal.
    stop = app.startPhotoQueue(app.queryClient, "u2", () => undefined);
    app.onlineManager.setOnline(true);
    await settled();
    expect(server.uploads).toBe(0);
    expect(kept()).toMatchObject([{ userId: "u1" }]);
    stop();

    app.startPhotoQueue(app.queryClient, "u1", () => undefined);
    await settled();
    expect(server.rows).toMatchObject([{ company_id: "c1", owner_id: "v1" }]);
  });

  it("signing out on purpose takes that person's photos off the phone; the app signing them out keeps them", async () => {
    const app = await openApp(false);
    app.startOfflineCache(app.queryClient, "u1", true);
    await app.addVisitPhoto({ userId: "u1", companyId: "c1", visitId: "v1" }, photo());
    await app.addVisitPhoto({ userId: "u2", companyId: "c1", visitId: "v1" }, photo());
    expect(app.signOutWarning(app.pendingFieldActions(app.queryClient), app.photosNotSent("u1"))).toEqual({
      title: "1 photo hasn't sent yet",
      body: "It's waiting on this phone and goes out when you have signal. Signing out now deletes it.",
    });

    app.keepQueuedFieldActions(app.queryClient, "u1");
    await settled();
    expect(kept().map((p) => p.userId)).toEqual(["u1", "u2"]);
    expect(app.photosNotSent("u1")).toBe(1);

    app.forgetOfflineCache("u1");
    await settled();
    expect(kept().map((p) => p.userId)).toEqual(["u2"]);
    expect(app.photosNotSent("u1")).toBe(0);
    app.onlineManager.setOnline(true);
    await settled();
    expect(server.uploads).toBe(0);
  });

  it("signing out on purpose clears photos this page never loaded, too", async () => {
    const before = await openApp(false);
    await before.addVisitPhoto({ userId: "u1", companyId: "c1", visitId: "v1" }, photo());
    const app = await openApp(false);
    app.forgetOfflineCache("u1");
    await settled();
    expect(kept()).toEqual([]);
  });
});

describe("waiting", () => {
  it("counts photos kept on the phone with the updates the service worker says are waiting, until they've gone", async () => {
    const caches = new FakeCaches();
    vi.stubGlobal("caches", caches);
    vi.stubGlobal("navigator", { onLine: true, serviceWorker: { getRegistration: async () => ({ sync: { register: async () => undefined }, getNotifications: async () => [] }) } });
    const app = await openApp(false);
    app.startOfflineCache(app.queryClient, "u1", true);
    await app.addVisitPhoto({ userId: "u1", companyId: "c1", visitId: "v1" }, photo());
    await app.addVisitPhoto({ userId: "u1", companyId: "c1", visitId: "v1" }, photo());
    await settled();
    expect(caches.entries(app.WAITING_CACHE)).toEqual({ "/waiting/u1": "2" });

    app.onlineManager.setOnline(true);
    await settled();
    expect(server.rows).toHaveLength(2);
    expect(caches.entries(app.WAITING_CACHE)).toEqual({});
  });

  it("says what signing out would delete: updates, photos, or both", async () => {
    const { signOutWarning } = await openApp(true);
    expect(signOutWarning(0, 0)).toBeNull();
    expect(signOutWarning(1, 0)?.title).toBe("1 update hasn't sent yet");
    expect(signOutWarning(3, 0)?.title).toBe("3 updates haven't sent yet");
    expect(signOutWarning(2, 1)).toEqual({ title: "2 updates and 1 photo haven't sent yet", body: "They're waiting on this phone and go out when you have signal. Signing out now deletes them." });
    expect(signOutWarning(0, 4)?.title).toBe("4 photos haven't sent yet");
  });
});
