/**
 * Team chat messages that wait on the phone for signal (features/chat/outbox.ts): sent at once with
 * signal; kept, with their photos, when there's none or the network never answers, even across
 * closing the app; sent once when the signal comes back, however often they're tried; not kept when
 * the server refuses them; and gone when the person deletes them or signs out.
 */
import { onlineManager } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeIndexedDb } from "./fakeIndexedDb";

/** The server: its messages by id, the files stored, and what it does with each send. */
const server = vi.hoisted(() => ({
  messages: new Map<string, Record<string, unknown>>(),
  files: new Map<string, number>(),
  posts: 0,
  /** Sends that get there but whose answer never makes it back. */
  loseAnswers: 0,
  /** Every send turned down, as when the person can't post in the channel any more. */
  refuse: false,
}));
const open = vi.hoisted(() => ({ errors: null as null | typeof import("../src/lib/errors") }));

vi.mock("../src/lib/api", () => ({
  activeCompany: () => null,
  refreshSignIn: async () => "ok",
  api: {
    post: async (path: string, body: { id: string; body: string; attachments: unknown[] }) => {
      server.posts++;
      if (!onlineManager.isOnline()) throw new open.errors!.ApiError("No internet connection.", 0, "network");
      if (server.refuse) throw new open.errors!.ApiError("You can't post in this channel.", 403);
      const channel = path.split("/")[3]!;
      const message = server.messages.get(body.id) ?? { id: body.id, channel_id: channel, body: body.body, attachments: body.attachments, created_at: new Date().toISOString() };
      server.messages.set(body.id, message);
      if (server.loseAnswers-- > 0) throw new open.errors!.ApiError("No internet connection.", 0, "network");
      return { message };
    },
  },
  supabase: () => ({
    storage: {
      from: () => ({
        upload: async (path: string, body: Blob) => {
          if (!onlineManager.isOnline()) return { data: null, error: { message: "TypeError: Failed to fetch" } };
          if (server.files.has(path)) return { data: null, error: { message: "The resource already exists", statusCode: "409" } };
          server.files.set(path, body.size);
          return { data: { path }, error: null };
        },
      }),
    },
  }),
}));
vi.mock("../src/lib/session", () => ({ useSession: () => ({}) }));

const idb = { current: new FakeIndexedDb() };
const kept = () => idb.current.rows("crewtavo-chat", "outbox") as Array<{ id: string; userId: string; attachments: Array<{ bytes?: ArrayBuffer }>; problem?: string }>;
const photo = () => new Blob([new Uint8Array(1_500)], { type: "image/jpeg" });

const closeApp: Array<() => void> = [];
/** Crewtavo opened on the phone, its modules loaded fresh, with or without signal. */
async function openApp(signal: boolean) {
  closeApp.splice(0).forEach((stop) => stop());
  vi.resetModules();
  onlineManager.setOnline(signal);
  open.errors = await import("../src/lib/errors");
  const outbox = await import("../src/features/chat/outbox");
  return {
    ...outbox,
    start: (userId: string) => closeApp.push(outbox.startChatOutbox(userId, () => undefined)),
    send: (text: string, files: Array<{ path: string; body?: Blob }> = []) =>
      outbox.sendChatMessage({ userId: "u1", companyId: "c1", channelId: "ch1", body: text, attachments: files.map((f) => ({ ...f, name: "gate.jpg", type: "image/jpeg" })), job_id: null, reply_to: null }),
  };
}
async function settled() {
  for (let turn = 0; turn < 30; turn++) await new Promise((resolve) => setTimeout(resolve, 3));
}

beforeEach(() => {
  idb.current = new FakeIndexedDb();
  Object.assign(server, { posts: 0, loseAnswers: 0, refuse: false });
  server.messages.clear();
  server.files.clear();
  vi.stubGlobal("indexedDB", idb.current);
});
afterEach(() => {
  closeApp.splice(0).forEach((stop) => stop());
  onlineManager.setOnline(true);
  vi.unstubAllGlobals();
});

describe("a Team chat message", () => {
  it("goes at once with signal, by an id the phone chose, and nothing waits", async () => {
    const app = await openApp(true);
    app.start("u1");
    const sent = await app.send("On site", [{ path: "c1/chat/ch1/a.jpg", body: photo() }]);
    expect(sent).toMatchObject({ body: "On site", channel_id: "ch1" });
    expect([...server.messages.keys()]).toEqual([sent!.id]);
    expect([...server.files.keys()]).toEqual(["c1/chat/ch1/a.jpg"]);
    expect(app.waitingNow()).toEqual([]);
    expect(kept()).toEqual([]);
  });

  it("with no signal is kept on the phone with its photo, and goes once when the signal comes back", async () => {
    const app = await openApp(false);
    app.start("u1");
    expect(await app.send("Gate code is 4412", [{ path: "c1/chat/ch1/b.jpg", body: photo() }])).toBeNull();
    expect(app.waitingNow()).toMatchObject([{ body: "Gate code is 4412", channelId: "ch1", kept: true, sending: false }]);
    expect(kept()).toHaveLength(1);
    expect(kept()[0]!.attachments[0]!.bytes?.byteLength).toBe(1_500);
    expect(server.messages.size).toBe(0);

    onlineManager.setOnline(true);
    await settled();
    expect([...server.messages.values()]).toMatchObject([{ body: "Gate code is 4412", attachments: [{ path: "c1/chat/ch1/b.jpg", name: "gate.jpg" }] }]);
    expect(server.files.get("c1/chat/ch1/b.jpg")).toBe(1_500);
    expect(app.waitingNow()).toEqual([]);
    expect(kept()).toEqual([]);
  });

  it("whose answer never arrived waits, and is still only one message once it goes again", async () => {
    const app = await openApp(true);
    app.start("u1");
    server.loseAnswers = 1;
    expect(await app.send("Running late")).toBeNull();
    expect(server.messages.size).toBe(1);
    const [waiting] = app.waitingNow();
    app.sendWaitingNow(waiting!.id);
    await settled();
    expect(server.posts).toBe(2);
    expect([...server.messages.keys()]).toEqual([waiting!.id]);
    expect(app.waitingNow()).toEqual([]);
  });

  it("stays on the phone when the app is closed, and goes when it's opened again with signal", async () => {
    const app = await openApp(false);
    app.start("u1");
    await app.send("Truck 2 is at the yard");
    const next = await openApp(true);
    expect(next.waitingNow()).toEqual([]);
    next.start("u1");
    await settled();
    expect([...server.messages.values()]).toMatchObject([{ body: "Truck 2 is at the yard" }]);
    expect(kept()).toEqual([]);
  });

  it("the server refuses isn't kept: the composer says why", async () => {
    const app = await openApp(true);
    app.start("u1");
    server.refuse = true;
    await expect(app.send("Hello")).rejects.toThrow("You can't post in this channel.");
    expect(app.waitingNow()).toEqual([]);
    expect(kept()).toEqual([]);
  });

  it("refused when it's tried again waits with the reason, and Delete takes it off the phone", async () => {
    const app = await openApp(false);
    app.start("u1");
    await app.send("For the north crew");
    server.refuse = true;
    onlineManager.setOnline(true);
    await settled();
    expect(app.waitingNow()).toMatchObject([{ problem: "You can't post in this channel.", sending: false }]);
    expect(kept()[0]!.problem).toBe("You can't post in this channel.");
    app.deleteWaiting(app.waitingNow()[0]!.id);
    await settled();
    expect(app.waitingNow()).toEqual([]);
    expect(kept()).toEqual([]);
  });

  it("is someone else's to send: another person signed in on the phone doesn't send it, and signing out clears it", async () => {
    const app = await openApp(false);
    app.start("u1");
    await app.send("Mine");
    const other = await openApp(true);
    other.start("u2");
    await settled();
    expect(server.messages.size).toBe(0);
    other.forgetChatOutbox("u1");
    await settled();
    expect(kept()).toEqual([]);
  });
});
