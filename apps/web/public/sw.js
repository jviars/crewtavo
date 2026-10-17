/**
 * Crewtavo's service worker.
 *   - Push: shows notifications sent by the server (schedule changes, client messages...) and opens
 *     the right screen when one is tapped.
 *   - Offline (production builds, registered as /sw.js?cache=1): the app itself opens with no
 *     signal. Pages come from the network when possible and from the cache when not; the built
 *     files under /assets/ never change, so they're kept. Data and the API are left to the app,
 *     which keeps the crew's day on the phone and queues their changes until they're back online.
 */
const CACHE = "crewtavo-app-v1";
const OFFLINE = new URL(self.location.href).searchParams.get("cache") === "1";
const SHELL = ["/", "/manifest.webmanifest", "/icon-192.png", "/favicon.svg"];

self.addEventListener("install", (event) => {
  self.skipWaiting();
  if (OFFLINE) event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).catch(() => undefined));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== CACHE || !OFFLINE).map((k) => caches.delete(k)));
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
  if (/^\/(api|mcp|\.well-known|hub|book|u|refer)(\/|$)/.test(url.pathname)) return;

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

  if (url.pathname.startsWith("/assets/") || /\.(png|svg|ico|woff2?|webmanifest)$/.test(url.pathname)) {
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
      const open = windows.find((w) => new URL(w.url).origin === self.location.origin);
      if (open) {
        await open.focus();
        if ("navigate" in open) await open.navigate(link).catch(() => undefined);
        return;
      }
      await self.clients.openWindow(link);
    })(),
  );
});
