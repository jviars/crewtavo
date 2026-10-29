/**
 * Sending a file to Storage in pieces, with tus (the resumable upload protocol Storage answers at
 * /storage/v1/upload/resumable): 6 MB at a time, so a big plan set gets past a proxy that takes
 * at most 100 MB in one request, a dropped connection picks up where it stopped, and the same file
 * added again after a failed try carries on from there. Every request signs in afresh, since an
 * access token lasts an hour and a slow upload can take longer. Where Storage has no resumable
 * endpoint (an older storage service), the file goes in one request, the way it always did.
 *
 * Two uploads of the same file at once (dropped on two jobs, or in two tabs) never share one upload:
 * only the first carries on with an unfinished one and is kept for next time; the other starts
 * afresh and keeps nothing.
 *
 * Storage that's full (507: the company's storage limit, or the person's own, is used up) is never
 * tried again: it's a StorageFullError with the server's sentence, which says who can raise it.
 *
 * Nothing here ever deletes a stored file: Stop only stops sending.
 */
import type { DetailedError, HttpRequest, Upload as TusUpload } from "tus-js-client";
import { loadConfig, supabase } from "./api";
import { StorageFullError } from "./errors";

export { StorageFullError } from "./errors";

/** A file too big to send: over the app's own limit (`fromServer` false), or over the server's, lower one. */
export class TooLargeError extends Error {
  constructor(message: string, readonly fromServer = false) {
    super(message);
  }
}

/** A file on its way: resolves with where it's stored. */
export interface Upload {
  promise: Promise<string>;
  abort: () => void;
}

export const isAbort = (error: unknown) => error instanceof DOMException && error.name === "AbortError";

/** Storage's resumable endpoint takes 6 MB pieces (Supabase: "must be set to 6MB (for now)"). */
export const CHUNK_BYTES = 6 * 1024 * 1024;
/** A dropped piece is tried again at once, then after 3, 5, 10 and 20 seconds. */
export const RETRY_DELAYS = [0, 3000, 5000, 10000, 20000];
/** How long Storage keeps an unfinished upload (TUS_URL_EXPIRY_MS on the storage service is a day). */
const RESUMABLE_FOR_MS = 23 * 60 * 60_000;

const SIGNED_OUT = "You're signed out. Sign in again, then add the file.";
const STOPPED = "The upload stopped. Check the connection and try again.";

class SignedOutError extends Error {
  constructor() {
    super(SIGNED_OUT);
  }
}

type PreviousUpload = Awaited<ReturnType<TusUpload["findPreviousUploads"]>>[number];

/** Storage turned out to have no resumable endpoint: the rest of this visit sends files in one request. */
let wholeFilesOnly = false;
/** Picked files this tab is sending now (by sameFile), so a second one of the same file starts afresh. */
const sending = new Set<string>();

export interface ResumableOptions {
  /** Where it goes in the files bucket: <company>/<folder>/<uuid>.<ext>. */
  path: string;
  file: Blob;
  contentType: string;
  /** How far along, 0 to 1. */
  onProgress: (fraction: number) => void;
  /** Its name in messages ("Site plan.pdf is bigger than…"); a File's own name otherwise. */
  name?: string;
}

/**
 * Sends a file to `path` in the files bucket, never over one that's there (x-upsert: false).
 * Resolves with the path it's stored at: `path`, or the path an unfinished upload of the same file
 * to the same folder was already going to (that upload is finished instead of starting again).
 */
export function resumableUpload({ path, file, contentType, onProgress, name }: ResumableOptions): Upload {
  const label = name ?? (file instanceof File && file.name ? file.name : "The file");
  let stopped = false;
  let tus: TusUpload | null = null;
  let whole: Upload | null = null;
  let previous: PreviousUpload | null = null;
  let stop: () => void = () => undefined;
  // This file, claimed while it's sent (see claimFile), and how to let it go.
  let claimed: string | null = null;
  let letGo: () => void = () => undefined;
  const release = () => {
    if (claimed) sending.delete(claimed);
    claimed = null;
    letGo();
    letGo = () => undefined;
  };

  const promise = new Promise<string>((resolve, reject) => {
    stop = () => reject(new DOMException("Stopped", "AbortError"));
    void (async () => {
      const config = await loadConfig();
      const base = config.supabaseUrl || location.origin;
      // `elsewhere`: Storage already began a resumable upload to `path`, so this goes to a new name beside it.
      const inOneGo = (elsewhere = false) => {
        const to = elsewhere ? `${path.slice(0, path.lastIndexOf("/") + 1)}${crypto.randomUUID()}${path.slice(path.lastIndexOf("."))}` : path;
        whole = sendWhole(file, contentType, label, onProgress, async () => ({
          url: `${base}/storage/v1/object/files/${to}`,
          headers: { Authorization: `Bearer ${await accessToken()}`, apikey: config.supabaseKey },
          path: to,
        }));
        whole.promise.then(resolve, reject);
      };
      if (stopped) return;
      // Its code loads with the first upload. If it can't (an old tab after an update), one request still works.
      const tusClient = wholeFilesOnly ? null : await import("tus-js-client").catch(() => null);
      if (stopped) return;
      if (!tusClient) return inOneGo();

      const endpoint = `${base}/storage/v1/upload/resumable`;
      // Only a picked file can be told apart from another of the same size (by its name and when it
      // was last changed); one made here (an edited PDF) always starts afresh. Of the same file sent
      // twice at once, only the first may carry on with an unfinished upload or leave one to carry on
      // with: the other starts afresh and keeps nothing, so the two never send to one upload.
      const same = recognizable(file) ? sameFile(file as File, endpoint) : null;
      let only = false;
      if (same && !sending.has(same)) {
        sending.add(same);
        claimed = same;
        only = await claimFile(same, (fn) => (letGo = fn));
        if (!only) release();
      }
      if (stopped) return release();
      const upload = new tusClient.Upload(file, {
        endpoint,
        chunkSize: CHUNK_BYTES,
        uploadDataDuringCreation: false,
        removeFingerprintOnSuccess: true,
        storeFingerprintForResuming: only,
        retryDelays: RETRY_DELAYS,
        headers: { apikey: config.supabaseKey, "x-upsert": "false" },
        metadata: { bucketName: "files", objectName: path, contentType, cacheControl: "3600" },
        onBeforeRequest: async (req: HttpRequest) => {
          req.setHeader("authorization", `Bearer ${await accessToken()}`);
        },
        onProgress: (sent, total) => {
          if (total > 0) onProgress(Math.min(1, sent / total));
        },
        onShouldRetry: (error) => !stopped && shouldRetry(error),
        onUploadUrlAvailable: () => {
          if (stopped || !upload.url || under(upload.url, endpoint)) return;
          // Storage named an address that doesn't lead back to it (a proxy in front of it that doesn't
          // say where it is): the pieces would go nowhere, so the file goes in one request instead.
          wholeFilesOnly = true;
          release();
          void upload.abort(false);
          inOneGo(true);
        },
        onError: (error) => {
          release();
          if (stopped) return;
          if (noResumableEndpoint(error)) {
            wholeFilesOnly = true;
            return inOneGo(statusOf(error) < 300);
          }
          reject(uploadError(error, label, file.size));
        },
        onSuccess: () => {
          release();
          onProgress(1);
          // Carried on with an unfinished upload: the file is where that one was going.
          resolve(previous && upload.url === previous.uploadUrl ? previous.metadata.objectName : path);
        },
      });
      tus = upload;
      const found = only ? await unfinished(upload, path) : null;
      if (stopped) return;
      if (found?.uploadUrl) {
        previous = found;
        upload.resumeFromPreviousUpload(found);
      }
      upload.start();
    })().catch((error: unknown) => {
      release();
      if (!stopped) reject(error);
    });
  });

  return {
    promise,
    abort: () => {
      if (stopped) return;
      stopped = true;
      release();
      // Stop sending, and never terminate: an upload that had just finished would lose its file.
      void tus?.abort(false);
      whole?.abort();
      stop();
    },
  };
}

/**
 * Sends a file in one request (multipart, as supabase-js does: Storage checks a form's file against
 * its size limit as it arrives), over XMLHttpRequest so it can say how far along it is. For
 * Storage without a resumable endpoint, and for one-time upload links. Resolves with the path.
 */
export function sendWhole(
  file: Blob,
  contentType: string,
  label: string,
  onProgress: (fraction: number) => void,
  target: () => Promise<{ url: string; headers: Record<string, string>; path: string; method?: "POST" | "PUT" }>,
): Upload {
  const xhr = new XMLHttpRequest();
  let aborted = false;
  const promise = (async () => {
    const { url, headers, path, method = "POST" } = await target();
    await new Promise<void>((resolve, reject) => {
      if (aborted) return reject(new DOMException("Stopped", "AbortError"));
      xhr.open(method, url);
      for (const [header, value] of Object.entries(headers)) xhr.setRequestHeader(header, value);
      xhr.setRequestHeader("x-upsert", "false");
      xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
      xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(storageError(xhr.status, xhr.responseText, label, file.size)));
      xhr.onerror = () => reject(new Error(STOPPED));
      xhr.onabort = () => reject(new DOMException("Stopped", "AbortError"));
      const form = new FormData();
      form.append("cacheControl", "3600");
      form.append("", file.type === contentType ? file : new Blob([file], { type: contentType }), file instanceof File && file.name ? file.name : label);
      xhr.send(form);
    });
    onProgress(1);
    return path;
  })();
  return {
    promise,
    abort: () => {
      aborted = true;
      xhr.abort();
    },
  };
}

/**
 * What Storage said, as a sentence: too big (so the way to raise the limit is offered), full (the
 * server's own sentence), not allowed, or why it failed.
 */
export function storageError(status: number, body: string, label: string, size: number): Error {
  let message = "";
  try {
    const json = JSON.parse(body) as { message?: string; error?: string };
    message = String(json.message ?? json.error ?? "");
  } catch {
    // A proxy's error page says nothing useful.
    message = /^\s*</.test(body ?? "") ? "" : (body ?? "").trim().slice(0, 200);
  }
  if (status === 507) return new StorageFullError(message);
  if (status === 413 || /maximum allowed size|too large/i.test(message)) return new TooLargeError(`${label} (${megabytes(size)}) is bigger than this Crewtavo accepts.`, true);
  if (status === 401 || status === 403 || /row-level security|unauthorized/i.test(message)) return new Error("You don't have permission to add files here.");
  return new Error(`Upload failed${message ? `: ${message.replace(/[.\s]+$/, "")}` : ""}. Try again.`);
}

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

/** The current access token (supabase-js refreshes one that has expired), fetched for each request. */
async function accessToken(): Promise<string> {
  const token = (await supabase().auth.getSession()).data.session?.access_token;
  if (!token) throw new SignedOutError();
  return token;
}

/** An upload's address is on the same server, under the endpoint it was made at. */
function under(url: string, endpoint: string): boolean {
  try {
    const at = new URL(url);
    const base = new URL(endpoint);
    return at.origin === base.origin && at.pathname.startsWith(`${base.pathname}/`);
  } catch {
    return false;
  }
}

/** A picked file, which tus can recognize when it's added again. */
const recognizable = (file: Blob) => file instanceof File && Boolean(file.name) && file.lastModified > 0;

/** The same file sent to the same Storage, as tus tells them apart (its fingerprint). */
const sameFile = (file: File, endpoint: string) => ["crewtavo-upload", file.name, file.type, file.size, file.lastModified, endpoint].join("-");

/**
 * Claims this file for the upload about to send it, across the browser's tabs (Web Locks), until
 * `held` is handed the way to let it go. False when another tab is sending the same file now. A
 * browser without Web Locks knows only about this tab (sending).
 */
function claimFile(same: string, held: (letGo: () => void) => void): Promise<boolean> {
  const locks = typeof navigator !== "undefined" ? navigator.locks : undefined;
  if (!locks?.request) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    try {
      locks
        .request(same, { ifAvailable: true }, (lock) => {
          if (!lock) return resolve(false);
          resolve(true);
          // Held until the upload is done with it.
          return new Promise<void>((done) => held(done));
        })
        .catch(() => resolve(true));
    } catch {
      resolve(true);
    }
  });
}

/**
 * An unfinished upload of this same file, started less than a day ago, to the same folder of the
 * same company with the same extension.
 */
async function unfinished(upload: TusUpload, path: string): Promise<PreviousUpload | null> {
  const folder = path.slice(0, path.lastIndexOf("/") + 1);
  const ext = path.slice(path.lastIndexOf("."));
  try {
    const fresh = (await upload.findPreviousUploads())
      .filter((p) => {
        const object = p.metadata?.objectName ?? "";
        return (
          Boolean(p.uploadUrl) && Date.now() - Date.parse(p.creationTime) < RESUMABLE_FOR_MS &&
          p.metadata?.bucketName === "files" && object.startsWith(folder) && !object.slice(folder.length).includes("/") && object.endsWith(ext)
        );
      })
      .sort((a, b) => Date.parse(b.creationTime) - Date.parse(a.creationTime));
    return fresh[0] ?? null;
  } catch {
    // Browser storage turned off (private browsing): start afresh.
    return null;
  }
}

const statusOf = (error: Error | DetailedError) => ("originalResponse" in error && error.originalResponse ? error.originalResponse.getStatus() : 0);
const methodOf = (error: Error | DetailedError) => ("originalRequest" in error && error.originalRequest ? error.originalRequest.getMethod() : "");
const offline = () => typeof navigator !== "undefined" && navigator.onLine === false;

/** Try again when the connection dropped or the server stumbled, not when Storage said no (full is a no). */
function shouldRetry(error: DetailedError): boolean {
  if (error.causingError instanceof SignedOutError || offline()) return false;
  const status = statusOf(error);
  if (status === 507) return false;
  if (status === 0 || status >= 500) return true;
  // While sending, 409 and 423 mean "check where it got to and carry on"; on creating it, a 409 is final.
  return (status === 409 && methodOf(error) !== "POST") || status === 423;
}

/** Storage answered creating the upload as if there's no such thing: 404, 405 or 501, or no Location to send to. */
function noResumableEndpoint(error: Error | DetailedError): boolean {
  if (methodOf(error) !== "POST") return false;
  const status = statusOf(error);
  return status === 404 || status === 405 || status === 501 || (status >= 200 && status < 300);
}

function uploadError(error: Error | DetailedError, label: string, size: number): Error {
  if ("causingError" in error && error.causingError instanceof SignedOutError) return new Error(SIGNED_OUT);
  const status = statusOf(error);
  if (!status) return new Error(STOPPED);
  const body = "originalResponse" in error && error.originalResponse ? error.originalResponse.getBody() : "";
  return storageError(status, body, label, size);
}

/** As fileSize in features/plans/plans.ts writes it ("4.3 MB"). */
function megabytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  const mb = bytes / (1024 * 1024);
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}
