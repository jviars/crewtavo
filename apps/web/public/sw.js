/**
 * Crewtavo's service worker.
 *   - Push: shows notifications sent by the server (schedule changes, client messages...) and opens
 *     the right screen when one is tapped.
 *   - Offline (production builds, registered as /sw.js?cache=1): the app itself opens with no
 *     signal. Pages come from the network when possible and from the cache when not; the built
 *     files under /assets/ never change, so they're kept. Data and the API are left to the app,
 *     which keeps the crew's day on the phone and queues their changes until they're back online.
 *     Stored files (/storage/) are never kept: a file moved to the Trash or deleted must stop
 *     opening, and each link to one is new.
 *   - Updates waiting: the app sends the crew's queued changes while it's on the screen
 *     (src/lib/offline.ts). Where there's Background Sync (Android), it asks to hear when the phone
 *     has signal; if Crewtavo isn't on the screen then, a notification says how many are waiting
 *     and opens the app.
 */
// A new name empties what older versions kept (stored pictures, before /storage/ was left out).
const CACHE = "crewtavo-app-v2";
const OFFLINE = new URL(self.location.href).searchParams.get("cache") === "1";
const SHELL = ["/", "/manifest.webmanifest", "/icon-192.png", "/favicon.svg"];
// Shared with src/lib/offline.ts (SYNC_TAG, WAITING_CACHE).
const SYNC_TAG = "crewtavo-field-sync";
const WAITING = "crewtavo-waiting";
/** Pages for clients (Client Hub, booking forms, referrals): they don't run the crew's app. */
const CLIENT_PAGES = /^\/(hub|book|u|refer)(\/|$)/;
const ours = (w) => new URL(w.url).origin === self.location.origin;
/** A window running Crewtavo itself, which sends the crew's queued updates. */
const appWindow = (w) => ours(w) && !CLIENT_PAGES.test(new URL(w.url).pathname);

self.addEventListener("install", (event) => {
  self.skipWaiting();
  if (OFFLINE) event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).catch(() => undefined));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      // The count of waiting updates belongs to the app, not to this worker's version: it stays.
      await Promise.all(keys.filter((k) => k !== WAITING && (k !== CACHE || !OFFLINE)).map((k) => caches.delete(k)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  if (!OFFLINE) return;
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (/^\/(api|mcp|\.well-known|storage|hub|book|u|refer)(\/|$)/.test(url.pathname)) return;

  if (request.mode === "navigate") {
    // Network first so a deploy shows up at once; the saved app when there's no signal.
    event.respondWith(
      (async () => {
        try {
          const fresh = await fetch(request);
          const cache = await caches.open(CACHE);
          cache.put("/", fresh.clone()).catch(() => undefined);
          return fresh;
        } catch {
          return (await caches.match("/")) ?? Response.error();
        }
      })(),
    );
    return;
  }

  // The manifest from the network too, so installed apps pick up a new name, icons or shortcuts.
  if (url.pathname === "/manifest.webmanifest") {
    event.respondWith(
      fetch(request)
        .then((fresh) => {
          if (fresh.ok) {
            const copy = fresh.clone();
            caches.open(CACHE).then((cache) => cache.put(request, copy)).catch(() => undefined);
          }
          return fresh;
        })
        .catch(async () => (await caches.match(request)) ?? Response.error()),
    );
    return;
  }

  if (url.pathname.startsWith("/assets/") || /\.(png|svg|ico|woff2?)$/.test(url.pathname)) {
    event.respondWith(
      (async () => {
        const cached = await caches.match(request);
        if (cached) return cached;
        const response = await fetch(request);
        if (response.ok) (await caches.open(CACHE)).put(request, response.clone()).catch(() => undefined);
        return response;
      })(),
    );
  }
});

// The page lists the files it loaded (and the screens it fetched ahead), so the whole app is
// saved the first time, not only after a second visit.
self.addEventListener("message", (event) => {
  if (!OFFLINE || event.data?.type !== "cache-assets" || !Array.isArray(event.data.urls)) return;
  const urls = event.data.urls.filter((u) => typeof u === "string" && new URL(u, self.location.origin).origin === self.location.origin && new URL(u, self.location.origin).pathname.startsWith("/assets/"));
  event.waitUntil(
    caches.open(CACHE).then(async (cache) => {
      for (const u of urls.slice(0, 300)) if (!(await cache.match(u))) await cache.add(u).catch(() => undefined);
    }),
  );
});

self.addEventListener("push", (event) => {
  let message = { title: "Crewtavo", body: "", link: "/", tag: undefined };
  try {
    message = { ...message, ...event.data.json() };
  } catch {
    if (event.data) message.body = event.data.text();
  }
  event.waitUntil(
    self.registration.showNotification(message.title, {
      body: message.body,
      tag: message.tag,
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      data: { link: message.link || "/" },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const link = new URL(event.notification.data?.link || "/", self.location.origin).href;
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      if (event.notification.tag === SYNC_TAG) {
        // Updates waiting go out once Crewtavo is back on the screen, whatever it shows. Loading My day
        // instead would lose what's only on that screen (a note typed, checklist answers not saved).
        const app = windows.find(appWindow);
        if (app) await app.focus();
        else await self.clients.openWindow(link);
        return;
      }
      const open = windows.find(ours);
      if (open) {
        await open.focus();
        if ("navigate" in open) await open.navigate(link).catch(() => undefined);
        return;
      }
      await self.clients.openWindow(link);
    })(),
  );
});

// Background Sync (Android): the phone has signal again and crew updates wait to be sent. Crewtavo
// sends them itself while it's on the screen, so then this fails on purpose: the browser tries it
// again in a few minutes, in case the app is put away or closed by then. Put away (in a pocket,
// behind another app), an action that was already waiting there waits to be back on the screen
// (React Query carries on with a paused action only on a visible page); closed, it can't send.
// Either way a notification says how many are waiting, and opening Crewtavo sends them. (One put
// back from the phone's storage does go while put away; the app takes it off the count as it goes.)
self.addEventListener("sync", (event) => {
  if (event.tag !== SYNC_TAG) return;
  event.waitUntil(
    (async () => {
      const waiting = await waitingUpdates();
      if (!waiting || self.Notification?.permission !== "granted") return;
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const onScreen = (w) => appWindow(w) && (w.visibilityState === "visible" || w.focused);
      if (windows.some(onScreen)) {
        if (event.lastChance) return;
        throw new Error("Crewtavo is open on the screen: it sends them itself.");
      }
      await self.registration.showNotification("Crewtavo", {
        body: `${waiting === 1 ? "1 update is" : `${waiting} updates are`} waiting to be sent. Open Crewtavo to send them.`,
        tag: SYNC_TAG,
        icon: "/icon-192.png",
        badge: "/icon-192.png",
        data: { link: "/field" },
      });
    })(),
  );
});

/** Everyone's updates waiting on this phone, as the app last counted them. */
async function waitingUpdates() {
  const cache = await caches.open(WAITING);
  let total = 0;
  for (const entry of await cache.keys()) total += Number(await (await cache.match(entry))?.text()) || 0;
  return total;
}
