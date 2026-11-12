/**
 * Photos added to a visit, kept on this phone until they've uploaded. Job sites often have no
 * signal, and a phone closes an app it has put away: a photo held only in memory would be gone with
 * no trace. So each photo is written to the phone's own storage (IndexedDB, which holds pictures)
 * as it's taken, goes up once there's signal, even if the app was closed in between, and is taken
 * off the phone only once the server has it.
 *
 * Like the field actions (lib/offline.ts): kept per person, sent as the company it was taken in,
 * cleared when the person signs out, and left in place when the app signs them out. A photo's id
 * and its name in storage are made on the phone, so sending it again after an answer that never
 * arrived adds it once.
 *
 * When the phone won't keep a photo (no room, or storage turned off), it's held in memory as
 * before and the screens say so: nothing here is called saved unless it is.
 */
import { onlineManager, type QueryClient } from "@tanstack/react-query";
import { supabase, unwrap } from "./api";
import { ApiError, errorMessage, isAuthError, isNetworkError, isRestarting } from "./errors";
import { storedExtension, storedType, uploadBody, uploadOnce } from "./files";
import { toast } from "./toast";

export interface PhonePhoto {
  /** Made on the phone: the attachment's id and the file's name in storage. */
  id: string;
  userId: string;
  companyId: string;
  visitId: string;
  path: string;
  fileName: string;
  /** What the attachment says it is (a photo that was shrunk is a JPEG). */
  contentType: string;
  /** The size of the file as it was picked, as attachments record it. */
  size: number;
  /** What goes up: the photo, already shrunk. */
  body: Blob;
  takenAt: number;
  /** False when the phone wouldn't keep it: it's only in memory, and closing the app loses it. */
  kept: boolean;
  sending: boolean;
  /** Why the server turned it down. It stays on the phone until it's tried again or removed. */
  problem?: string;
}

/** A photo as the phone's storage holds it: its bytes rather than a Blob, which some iPhones can't read back. */
interface StoredPhoto extends Omit<PhonePhoto, "body" | "kept" | "sending" | "problem"> {
  bytes: ArrayBuffer;
  type: string;
}

const DB = "crewtavo-phone";
const STORE = "photos";
/** Some iPhones never answer when their storage is opened: past this, the photo counts as not kept. */
const STORAGE_WAIT = 5_000;

/**
 * One read or write in the phone's storage, done once its transaction is: only then is it really
 * there. Opened each time: a phone can drop the connection of an app it has put away.
 */
function inStore<T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const late = setTimeout(() => reject(new Error("The phone's storage didn't answer.")), STORAGE_WAIT);
    const fail = (error: unknown) => {
      clearTimeout(late);
      reject(error ?? new Error("The phone's storage refused."));
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

let photos: readonly PhonePhoto[] = [];
const listeners = new Set<() => void>();

function set(next: readonly PhonePhoto[]) {
  photos = next;
  listeners.forEach((listener) => listener());
}
const change = (id: string, patch: Partial<PhonePhoto>) => set(photos.map((p) => (p.id === id ? { ...p, ...patch } : p)));
const drop = (id: string) => set(photos.filter((p) => p.id !== id));
const held = (id: string) => photos.find((p) => p.id === id);

/** For screens (useSyncExternalStore): every photo not uploaded yet, whoever took it. */
export const subscribePhonePhotos = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};
export const phonePhotos = () => photos;

/** This person's photos not uploaded yet, for "2 photos haven't sent yet" before signing out. */
export const photosNotSent = (userId: string) => photos.filter((p) => p.userId === userId).length;
/** Those the service worker counts as waiting (lib/offline.ts): on the phone, and not on their way. */
export const photosWaiting = (userId: string) => photos.filter((p) => p.userId === userId && p.kept && !p.sending && !p.problem).length;

async function keep(photo: PhonePhoto): Promise<boolean> {
  try {
    const { body, kept: _kept, sending: _sending, problem: _problem, ...rest } = photo;
    const stored: StoredPhoto = { ...rest, bytes: await body.arrayBuffer(), type: body.type };
    await inStore("readwrite", (store) => store.put(stored));
    return true;
  } catch {
    return false; // No room, a private window, or storage turned off.
  }
}

const unkeep = (id: string) => inStore("readwrite", (store) => store.delete(id)).catch(() => undefined);

let askedToStay = false;
/**
 * Asks the phone not to clear Crewtavo's storage when it runs low. An iPhone clears what a website
 * kept after a week unused, unless it's on the Home Screen; this is the most a web app can ask.
 */
function askToStay() {
  if (askedToStay || typeof navigator === "undefined") return;
  askedToStay = true;
  void navigator.storage?.persist?.().catch(() => undefined);
}

/**
 * Adds a photo to a visit: shrunk, written to the phone, then sent (now, or once there's signal).
 * Resolves false when the phone wouldn't keep it, so the screen can say so as it's taken. Throws
 * when the photo can't be sent at all (too big).
 */
export async function addVisitPhoto(at: { userId: string; companyId: string; visitId: string }, file: File): Promise<boolean> {
  const body = await uploadBody(file);
  const id = crypto.randomUUID();
  const path = `${at.companyId}/visit/${at.visitId}/${id}.${storedExtension(file, body)}`;
  const photo: PhonePhoto = { userId: at.userId, companyId: at.companyId, visitId: at.visitId, id, path, fileName: file.name.slice(0, 200), contentType: storedType(path, file), size: file.size, body, takenAt: Date.now(), kept: false, sending: false };
  askToStay();
  photo.kept = await keep(photo);
  set([...photos, photo]);
  void send();
  return photo.kept;
}

/** Takes a photo that hasn't uploaded off the phone, for good. */
export function removePhonePhoto(id: string) {
  drop(id);
  void unkeep(id);
}

/** Tries again the photos the server turned down. */
export function retryPhonePhotos(userId: string) {
  set(photos.map((p) => (p.userId === userId && p.problem ? { ...p, problem: undefined } : p)));
  void send();
}

/** Signed out on purpose: none of their photos stay on this phone (lib/offline.ts forgetOfflineCache). */
export function forgetPhonePhotos(userId: string) {
  set(photos.filter((p) => p.userId !== userId));
  // Read from the phone rather than from this page's list: it may not have loaded them yet.
  inStore("readwrite", (store) => {
    const all = store.getAll() as IDBRequest<StoredPhoto[]>;
    all.onsuccess = () => all.result.filter((p) => p.userId === userId).forEach((p) => store.delete(p.id));
  }).catch(() => undefined);
}

/** Puts back this person's photos from the phone's storage. Ones this page already holds aren't added again. */
async function load(userId: string) {
  let stored: StoredPhoto[];
  try {
    stored = (await inStore("readonly", (store) => store.getAll() as IDBRequest<StoredPhoto[]>)) ?? [];
  } catch {
    return; // No storage on this phone: only what's in memory.
  }
  const fresh = stored
    .filter((p) => p.userId === userId && !held(p.id))
    .sort((a, b) => a.takenAt - b.takenAt)
    .map(({ bytes, type, ...rest }): PhonePhoto => ({ ...rest, body: new Blob([bytes], { type }), kept: true, sending: false }));
  if (fresh.length) set([...fresh, ...photos]);
}

/**
 * Sends one photo: the file, then its row on the visit. Both are safe to repeat: the file's path is
 * taken already (uploadOnce), and a row with this id is this same photo.
 */
export async function uploadPhonePhoto(photo: PhonePhoto) {
  await uploadOnce(photo.path, photo.body);
  try {
    unwrap(await supabase().from("attachments").insert({ id: photo.id, company_id: photo.companyId, owner_type: "visit", owner_id: photo.visitId, path: photo.path, file_name: photo.fileName, content_type: photo.contentType, size_bytes: photo.size }));
  } catch (error) {
    if (!(error instanceof ApiError && error.code === "23505")) throw error;
  }
}

interface Sender {
  userId: string;
  upload: (photo: PhonePhoto) => Promise<void>;
  /** No answer from the server though the phone says it's online: the app waits as if offline (lib/offline.ts). */
  unreachable: () => void;
  sent: (photo: PhonePhoto) => void;
}
let sender: Sender | null = null;
let busy = false;

/** Sends the signed-in person's photos one at a time, oldest first, while there's signal. */
async function send() {
  if (busy) return;
  busy = true;
  try {
    for (;;) {
      const to = sender;
      const next = to && onlineManager.isOnline() ? photos.find((p) => p.userId === to.userId && !p.problem) : undefined;
      if (!to || !next) return;
      change(next.id, { sending: true });
      let failure: unknown;
      try {
        await to.upload(next);
      } catch (error) {
        failure = error ?? new Error("Upload failed.");
      }
      // Removed, or signed out, meanwhile: nothing more to do with it.
      if (!held(next.id)) continue;
      if (!failure) {
        drop(next.id);
        await unkeep(next.id);
        to.sent(next);
        continue;
      }
      // No answer, or the sign-in needs renewing: it waits, and goes when the app next has signal.
      const noAnswer = isNetworkError(failure) || (failure instanceof ApiError && isRestarting(failure.status));
      if (noAnswer || isAuthError(failure)) {
        change(next.id, { sending: false });
        if (noAnswer && sender === to) to.unreachable();
        return;
      }
      // Turned down (the office changed or removed the visit, or the business's storage is full): it
      // stays on the phone, and isn't tried again until the person asks or the app next opens.
      const problem = errorMessage(failure);
      change(next.id, { sending: false, problem });
      toast.error("A photo didn't upload", { description: `${problem} It's still on this phone.` });
    }
  } finally {
    busy = false;
  }
}

/**
 * Starts sending this person's photos: those the phone kept from before, and those added from now
 * on. Returns how to stop (signed out, or another person signed in).
 */
export function startPhotoQueue(queryClient: QueryClient, userId: string, unreachable: () => void, upload: (photo: PhonePhoto) => Promise<void> = uploadPhonePhoto): () => void {
  const mine: Sender = { userId, upload, unreachable, sent: (photo) => void queryClient.invalidateQueries({ queryKey: ["photos", photo.visitId] }) };
  sender = mine;
  // The server may have turned one down for a reason that's gone since: each start tries again.
  if (photos.some((p) => p.userId === userId && p.problem)) set(photos.map((p) => (p.userId === userId && p.problem ? { ...p, problem: undefined } : p)));
  void load(userId).then(send);
  const stopOnline = onlineManager.subscribe((online) => void (online && send()));
  const onVisible = () => void (document.visibilityState === "visible" && send());
  if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVisible);
  return () => {
    if (sender === mine) sender = null;
    stopOnline();
    if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisible);
  };
}
