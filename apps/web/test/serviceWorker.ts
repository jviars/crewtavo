/**
 * For the tests: the browser's Cache Storage, which the app and its service worker share, and
 * public/sw.js itself, run in a sandbox with fake windows, notifications and network.
 */
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { fileURLToPath, URL } from "node:url";
import { vi } from "vitest";

const ORIGIN = "https://crew.example.com";
const keyOf = (request: string | { url: string }) => new URL(typeof request === "string" ? request : request.url, ORIGIN).href;

/** Cache Storage, kept in memory. Entries are saved as their text, and what kind of file each said it was. */
export class FakeCaches {
  readonly stores = new Map<string, Map<string, string>>();
  private readonly types = new Map<string, string>();

  async open(name: string) {
    const store = this.stores.get(name) ?? new Map<string, string>();
    this.stores.set(name, store);
    const typeKey = (request: string | { url: string }) => `${name} ${keyOf(request)}`;
    return {
      put: async (request: string | { url: string }, response: Response) => {
        this.types.set(typeKey(request), response.headers.get("content-type") ?? "");
        store.set(keyOf(request), await response.text());
      },
      match: async (request: string | { url: string }) => (store.has(keyOf(request)) ? new Response(store.get(keyOf(request)), { headers: { "content-type": this.types.get(typeKey(request)) ?? "" } }) : undefined),
      delete: async (request: string | { url: string }) => store.delete(keyOf(request)),
      keys: async () => [...store.keys()].map((url) => ({ url })),
      addAll: async (requests: string[]) => requests.forEach((r) => store.set(keyOf(r), `saved ${r}`)),
    };
  }

  async match(request: string | { url: string }) {
    for (const store of this.stores.values()) if (store.has(keyOf(request))) return new Response(store.get(keyOf(request)));
    return undefined;
  }

  async keys() {
    return [...this.stores.keys()];
  }

  async delete(name: string) {
    return this.stores.delete(name);
  }

  /** What one cache holds, by path. */
  entries(name: string) {
    return Object.fromEntries([...(this.stores.get(name) ?? [])].map(([url, text]) => [new URL(url).pathname, text]));
  }
}

type Listener = (event: Record<string, unknown>) => void;

/** A browser window the worker can see. Given by its address alone, it's on the screen and focused. */
export type FakeWindow = string | { url: string; visibilityState?: DocumentVisibilityState; focused?: boolean };

/** public/sw.js, registered as /sw.js?cache=1 in production builds (offline) or /sw.js. */
export function loadServiceWorker(options: { offline?: boolean; caches?: FakeCaches; windows?: FakeWindow[]; permission?: string; network?: (request: { url: string }) => Promise<Response> } = {}) {
  const listeners = new Map<string, Listener>();
  const caches = options.caches ?? new FakeCaches();
  const network = options.network ?? (async () => Promise.reject(new TypeError("Failed to fetch")));
  const windows = (options.windows ?? []).map((w) => ({
    ...(typeof w === "string" ? { url: w, visibilityState: "visible", focused: true } : { visibilityState: "visible", focused: false, ...w }),
    focus: vi.fn(async () => undefined),
    navigate: vi.fn(async () => undefined),
  }));
  const showNotification = vi.fn(async (_title: string, _options: Record<string, unknown>) => undefined);
  const openWindow = vi.fn(async (_url: string) => undefined);
  const scope = {
    location: new URL(`${ORIGIN}/sw.js${options.offline ? "?cache=1" : ""}`),
    addEventListener: (type: string, listener: Listener) => listeners.set(type, listener),
    skipWaiting: () => undefined,
    clients: { matchAll: vi.fn(async () => windows), claim: async () => undefined, openWindow },
    registration: { showNotification },
    Notification: { permission: options.permission ?? "granted" },
  };
  runInNewContext(readFileSync(fileURLToPath(new URL("../public/sw.js", import.meta.url)), "utf8"), {
    self: scope,
    caches,
    fetch: network,
    URL,
    Response,
    Error,
    // The test's own clock, so a test can move it on (vi.useFakeTimers).
    setTimeout: (run: () => void, ms: number) => setTimeout(run, ms),
  });

  /** Fires an event at the worker; resolves with what it waited on (rejecting if that failed), or "unhandled". */
  async function dispatch(type: string, fields: Record<string, unknown> = {}) {
    const waits: Array<Promise<unknown>> = [];
    let response: Promise<Response> | undefined;
    const listener = listeners.get(type);
    if (!listener) return "unhandled";
    listener({ ...fields, waitUntil: (p: Promise<unknown>) => void waits.push(p), respondWith: (r: Promise<Response>) => void (response = r) });
    if (response) return response;
    if (!waits.length) return "unhandled";
    await Promise.all(waits);
    return "done";
  }

  return { dispatch, caches, windows, showNotification, openWindow, listeners };
}
