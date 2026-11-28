/**
 * Team chat messages that wait on the phone for signal. A message sent with no signal, or whose
 * send the network never answered (not one the server refused: that's said in the composer as
 * before), is kept in the phone's own storage (IndexedDB, as lib/offlinePhotos.ts keeps visit
 * photos) with its photos and voice note, so closing the app doesn't lose it. It shows at the
 * bottom of its conversation as waiting, and goes by itself once there's signal again: when the
 * phone says it's back online, when the app comes back to the screen, and on a timer that waits
 * longer each time (core retryDelay). Tapped, it can be sent now or deleted.
 *
 * No message goes twice: its id is chosen here before the first try, and the server answers a send
 * whose id it already has with that message (POST /chat/channels/:id/messages). Its files go to
 * paths chosen first too (uploadOnce), so one stored before the answer was lost isn't stored again.
 * Kept per person and company, sent as the company it was written in, and cleared when the person
 * signs out (lib/offline.ts).
 */
import { retryDelay, waitsForSignal } from "@crewtavo/core/chatField";
import { onlineManager, type QueryClient } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";
import { api } from "@/lib/api";
import { ApiError, errorMessage, isAuthError } from "@/lib/errors";
import { storedExtension, uploadBody, uploadOnce } from "@/lib/files";
import { t } from "@/lib/i18n";
import { addMessage, type ChatAttachment, type ChatMessage } from "./data";

/** A file on a waiting message: stored already, or its bytes kept here until it is. */
export interface WaitingFile extends ChatAttachment {
  body?: Blob;
}

export interface WaitingMessage {
  /** Chosen here: the message's id on the server. */
  id: string;
  userId: string;
  companyId: string;
  channelId: string;
  body: string;
  attachments: WaitingFile[];
  job_id: string | null;
  reply_to: string | null;
  createdAt: number;
  attempts: number;
  /** When the timer tries it next (ms). */
  nextAt: number;
  sending: boolean;
  /** False when the phone wouldn't keep it: closing the app loses it. */
  kept: boolean;
  /** Why the server turned it down when it was tried again. It waits for Send now or Delete. */
  problem?: string;
}

/** As the phone's storage holds it: bytes rather than Blobs, which some iPhones can't read back. */
interface Stored extends Omit<WaitingMessage, "attachments" | "sending" | "kept" | "problem"> {
  attachments: Array<Omit<WaitingFile, "body"> & { bytes?: ArrayBuffer; bytesType?: string }>;
  problem?: string;
}

const DB = "crewtavo-chat";
const STORE = "outbox";
const STORAGE_WAIT = 5_000;

function inStore<T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const late = setTimeout(() => reject(new Error(t("The phone's storage didn't answer."))), STORAGE_WAIT);
    const fail = (error: unknown) => {
      clearTimeout(late);
      reject(error ?? new Error(t("The phone's storage refused.")));
    };
    const opening = indexedDB.open(DB, 1);
    opening.onupgradeneeded = () => void opening.result.createObjectStore(STORE, { keyPath: "id" });
    opening.onerror = () => fail(opening.error);
    opening.onsuccess = () => {
      const db = opening.result;
      try {
        const tx = db.transaction(STORE, mode);
        const request = work(tx.objectStore(STORE));
        tx.oncomplete = () => {
          db.close();
          clearTimeout(late);
          resolve(request?.result);
        };
        tx.onerror = tx.onabort = () => {
          db.close();
          fail(tx.error);
        };
      } catch (error) {
        db.close();
        fail(error);
      }
    };
  });
}

let waiting: readonly WaitingMessage[] = [];
const listeners = new Set<() => void>();
function set(next: readonly WaitingMessage[]) {
  waiting = next;
  listeners.forEach((listener) => listener());
}
const change = (id: string, patch: Partial<WaitingMessage>) => set(waiting.map((m) => (m.id === id ? { ...m, ...patch } : m)));
const held = (id: string) => waiting.find((m) => m.id === id);
const subscribeWaiting = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

async function keep(message: WaitingMessage): Promise<boolean> {
  try {
    const { sending: _sending, kept: _kept, attachments, ...rest } = message;
    const files = await Promise.all(
      attachments.map(async ({ body, ...file }) => (body ? { ...file, bytes: await body.arrayBuffer(), bytesType: body.type } : file)),
    );
    await inStore("readwrite", (store) => store.put({ ...rest, attachments: files } satisfies Stored));
    return true;
  } catch {
    return false; // No room, a private window, or storage turned off: it waits in memory only.
  }
}
const unkeep = (id: string) => inStore("readwrite", (store) => store.delete(id)).catch(() => undefined);

async function load(userId: string) {
  let stored: Stored[];
  try {
    stored = (await inStore("readonly", (store) => store.getAll() as IDBRequest<Stored[]>)) ?? [];
  } catch {
    return;
  }
  const fresh = stored
    .filter((m) => m.userId === userId && !held(m.id))
    .map(({ attachments, ...rest }): WaitingMessage => ({
      ...rest,
      attachments: attachments.map(({ bytes, bytesType, ...file }) => (bytes ? { ...file, body: new Blob([bytes], { type: bytesType || file.type || "" }) } : file)),
      // Opened again: tried at once.
      nextAt: 0,
      sending: false,
      kept: true,
    }));
  if (fresh.length) set([...waiting, ...fresh].sort((a, b) => a.createdAt - b.createdAt));
}

// ---------------------------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------------------------

/** A file picked for a message, ready to store: shrunk if it's a photo, and the path it goes to in its channel's folder. */
export async function prepareChatFile(companyId: string, channelId: string, file: File): Promise<{ path: string; body: Blob; type: string }> {
  const body = await uploadBody(file);
  const path = `${companyId}/chat/${channelId}/${crypto.randomUUID()}.${storedExtension(file, body)}`;
  return { path, body, type: body.type || file.type || "application/octet-stream" };
}

/** Whether a failure is the network's (the message waits) rather than the server's answer. */
export const noSignal = (error: unknown) => (error instanceof ApiError && waitsForSignal(error.status)) || isAuthError(error);

/** The files, each stored once, then the message, by its own id. */
async function deliver(message: WaitingMessage): Promise<ChatMessage> {
  for (const file of message.attachments) if (file.body) await uploadOnce(file.path, file.body);
  const res = await api.post<{ message: ChatMessage }>(
    `/chat/channels/${message.channelId}/messages`,
    { id: message.id, body: message.body, attachments: message.attachments.map(({ body: _body, ...file }) => file), job_id: message.job_id, reply_to: message.reply_to },
    { companyId: message.companyId },
  );
  return res.message;
}

export type NewMessage = Pick<WaitingMessage, "userId" | "companyId" | "channelId" | "body" | "attachments" | "job_id" | "reply_to"> & { id?: string };

/**
 * Sends a message now, or keeps it to send once there's signal. The message sent, or null when it
 * waits. Throws what the server said when it refused the message (it isn't kept).
 */
export async function sendChatMessage(queryClient: QueryClient, input: NewMessage): Promise<ChatMessage | null> {
  const message: WaitingMessage = { ...input, id: input.id ?? crypto.randomUUID(), createdAt: Date.now(), attempts: 0, nextAt: 0, sending: false, kept: false };
  if (onlineManager.isOnline()) {
    try {
      const sent = await deliver(message);
      addMessage(queryClient, message.companyId, sent);
      return sent;
    } catch (error) {
      if (!noSignal(error)) throw error;
    }
  }
  message.attempts = 1;
  message.nextAt = Date.now() + retryDelay(0, Math.random());
  askToStay();
  message.kept = await keep(message);
  set([...waiting, message]);
  plan();
  return null;
}

interface Sender {
  userId: string;
  queryClient: QueryClient;
}
let sender: Sender | null = null;
let busy = false;
let timer: ReturnType<typeof setTimeout> | undefined;

/** The timer for the next one due. */
function plan() {
  clearTimeout(timer);
  const to = sender;
  const next = to ? waiting.filter((m) => m.userId === to.userId && !m.problem && !m.sending).sort((a, b) => a.nextAt - b.nextAt)[0] : undefined;
  if (!next) return;
  timer = setTimeout(() => void flush(), Math.max(0, next.nextAt - Date.now()));
}

/**
 * Sends this person's waiting messages one at a time, oldest first, so a conversation keeps its
 * order. `now`: whatever their timers say (signal came back, the app came back, Send now).
 */
async function flush(now = false) {
  if (busy) return;
  busy = true;
  try {
    for (;;) {
      const to = sender;
      if (!to || !onlineManager.isOnline()) return;
      const next = waiting.filter((m) => m.userId === to.userId && !m.problem).sort((a, b) => a.createdAt - b.createdAt)[0];
      if (!next || (!now && next.nextAt > Date.now())) return;
      change(next.id, { sending: true });
      let failure: unknown = null;
      let sent: ChatMessage | null = null;
      try {
        sent = await deliver(next);
      } catch (error) {
        failure = error ?? new Error(t("Sending failed."));
      }
      // Deleted meanwhile, or signed out: nothing more to do with it.
      if (!held(next.id)) continue;
      if (sent) {
        set(waiting.filter((m) => m.id !== next.id));
        await unkeep(next.id);
        addMessage(to.queryClient, next.companyId, sent);
        continue;
      }
      if (noSignal(failure)) {
        // Still no signal: it and the ones after it wait for the next try.
        const attempts = next.attempts + 1;
        change(next.id, { sending: false, attempts, nextAt: Date.now() + retryDelay(attempts, Math.random()) });
        return;
      }
      // Refused (the person can't post there any more, a reply's message is gone): it waits for them to decide.
      const problem = errorMessage(failure);
      change(next.id, { sending: false, problem });
      void keep({ ...held(next.id)!, problem });
    }
  } finally {
    busy = false;
    plan();
  }
}

let askedToStay = false;
function askToStay() {
  if (askedToStay || typeof navigator === "undefined") return;
  askedToStay = true;
  void navigator.storage?.persist?.().catch(() => undefined);
}

/** Send now: tried at once, even one the server turned down before. */
export function sendWaitingNow(id: string) {
  const message = held(id);
  if (!message || message.sending) return;
  change(id, { problem: undefined, nextAt: 0 });
  void flush(true);
}

/** Takes a waiting message off the phone, for good. */
export function deleteWaiting(id: string) {
  set(waiting.filter((m) => m.id !== id));
  void unkeep(id);
  plan();
}

/**
 * Starts sending this person's waiting messages: those the phone kept from before, and those
 * kept from now on, on the triggers above. Returns how to stop (signed out, or chat turned off).
 */
export function startChatOutbox(queryClient: QueryClient, userId: string): () => void {
  const mine: Sender = { userId, queryClient };
  sender = mine;
  void load(userId).then(() => flush(true));
  const stopOnline = onlineManager.subscribe((online) => void (online && flush(true)));
  const onVisible = () => void (document.visibilityState === "visible" && flush(true));
  if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVisible);
  return () => {
    if (sender === mine) sender = null;
    clearTimeout(timer);
    stopOnline();
    if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisible);
  };
}

/** Signed out on purpose: none of their messages stay on this phone. */
export function forgetChatOutbox(userId: string) {
  set(waiting.filter((m) => m.userId !== userId));
  inStore("readwrite", (store) => {
    const all = store.getAll() as IDBRequest<Stored[]>;
    all.onsuccess = () => all.result.filter((m) => m.userId === userId).forEach((m) => store.delete(m.id));
  }).catch(() => undefined);
}

// ---------------------------------------------------------------------------------------------
// For screens
// ---------------------------------------------------------------------------------------------

const all = () => waiting;

/** This person's waiting messages in a conversation, oldest first. */
export function useWaiting(userId: string, companyId: string, channelId: string): WaitingMessage[] {
  const list = useSyncExternalStore(subscribeWaiting, all);
  return list.filter((m) => m.userId === userId && m.companyId === companyId && m.channelId === channelId);
}

/** How many of this person's messages wait in each conversation, for the channel list. */
export function useWaitingCounts(userId: string, companyId: string): Map<string, number> {
  const list = useSyncExternalStore(subscribeWaiting, all);
  const counts = new Map<string, number>();
  for (const m of list) if (m.userId === userId && m.companyId === companyId) counts.set(m.channelId, (counts.get(m.channelId) ?? 0) + 1);
  return counts;
}

/** For tests: what's waiting, and a clean start. */
export const waitingNow = () => waiting;
export function resetOutbox() {
  sender = null;
  clearTimeout(timer);
  busy = false;
  set([]);
}
