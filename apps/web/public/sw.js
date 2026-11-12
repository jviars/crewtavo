/**
 * Crewtavo's service worker.
 *   - Push: shows notifications sent by the server (schedule changes, client messages...) and opens
 *     the right screen when one is tapped.
 *   - Offline (production builds, registered as /sw.js?cache=1): the app itself opens with no
 *     signal. Its page comes from the network when that answers in a few seconds, and from the
 *     copy kept here when not; only the app's own page, answered OK, is kept as that copy (never
 *     an error page from a restart, nor a page the server makes itself). The built files under
 *     /assets/ never change, so they're kept, and those of older versions are cleared once a new
 *     version's page is running. Data and the API are left to the app, which keeps the crew's day
 *     on the phone and queues their changes until they're back online. Stored files (/storage/)
 *     are never kept: a file moved to the Trash or deleted must stop opening, and each link to
 *     one is new.
 *   - Updates waiting: the app sends the crew's queued changes while it's on the screen
 *     (src/lib/offline.ts). Where there's Background Sync (Android), it asks to hear when the phone
 *     has signal; if Crewtavo isn't on the screen then, a notification says how many are waiting
 *     and opens the app.
 */
// A new name empties what older versions kept (stored pictures, before /storage/ was left out). It
// also empties the app's own files, which a phone then has to download again before it can open
// with no signal: change it only when what's kept must go. A new version of this file takes over
// on its own (skipWaiting, clients.claim) and carries on with the same cache.
const CACHE = "crewtavo-app-v2";
const OFFLINE = new URL(self.location.href).searchParams.get("cache") === "1";
const SHELL = ["/", "/manifest.webmanifest", "/icon-192.png", "/favicon.svg"];
// Shared with src/lib/offline.ts (SYNC_TAG, WAITING_CACHE).
const SYNC_TAG = "crewtavo-field-sync";
const WAITING = "crewtavo-waiting";
/** Pages for clients (Client Hub, booking forms, referrals): they don't run the crew's app. */
const CLIENT_PAGES = /^\/(hub|book|u|refer)(\/|$)/;
/**
 * Left to the browser, with nothing kept: what the server answers itself (the API, sign-in links
 * under /auth/, the database and stored files, a website form's thank-you page under /f/) and the
 * clients' pages.
 */
const NOT_THE_APP = /^\/(api|mcp|\.well-known|storage|auth|rest|f|hub|book|u|refer)(\/|$)/;
/** How long opening the app waits for the network before using the copy kept here: on one bar a page can hang for a minute. */
const NAVIGATE_WAIT = 4000;
/** Where the page that old files were last cleared for is noted (pruneAssets). */
const PRUNED_FOR = "/pruned-for";
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
  if (NOT_THE_APP.test(url.pathname)) return;

  if (request.mode === "navigate") {
    event.respondWith(openApp(event));
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

/** The app's own page, fit to keep: answered OK, as HTML. Not an error page while the server restarts (502, 503), nor a redirect. */
const isAppPage = (response) => response.ok && (response.headers.get("content-type") ?? "").includes("text/html");
/** Answered for the server while it restarts or deploys, by the proxy in front of it. */
const isRestarting = (response) => response.status === 502 || response.status === 503 || response.status === 504;

/**
 * Opening the app. From the network first, so a deploy shows up at once, and that page is kept for
 * next time. With a copy kept here, the network gets a few seconds: on no answer in that time, or
 * an error page from a restart, the kept copy opens instead and the crew gets My day from the
 * phone. An answer that arrives late is still kept.
 */
async function openApp(event) {
  const cache = await caches.open(CACHE);
  const saved = await cache.match("/");
  const fresh = fetch(event.request).then(async (response) => {
    if (isAppPage(response)) await cache.put("/", response.clone()).catch(() => undefined);
    return response;
  });
  if (!saved) return fresh.catch(() => Response.error());
  event.waitUntil(fresh.catch(() => undefined));
  const answer = await Promise.race([fresh.catch(() => null), new Promise((resolve) => setTimeout(() => resolve(null), NAVIGATE_WAIT))]);
  return !answer || isRestarting(answer) ? saved : answer;
}

// The page lists the files it loaded (and the screens it fetched ahead), so the whole app is
// saved the first time, not only after a second visit. Once they're in, the files of versions
// before this one are cleared.
self.addEventListener("message", (event) => {
  if (!OFFLINE || event.data?.type !== "cache-assets" || !Array.isArray(event.data.urls)) return;
  const urls = event.data.urls.filter((u) => typeof u === "string" && new URL(u, self.location.origin).origin === self.location.origin && new URL(u, self.location.origin).pathname.startsWith("/assets/"));
  event.waitUntil(
    caches.open(CACHE).then(async (cache) => {
      for (const u of urls.slice(0, 300)) if (!(await cache.match(u))) await cache.add(u).catch(() => undefined);
      await pruneAssets(cache, urls).catch(() => undefined);
    }),
  );
});

/**
 * Clears the built files of older versions, which would otherwise pile up on the phone for good
 * (every deploy renames most of them). A file stays when the running page loaded it (`loaded`), or
 * when this version uses it: its name appears in the kept page, or in a script or stylesheet that
 * is itself in use (a screen not opened yet is named in the script that would load it).
 *
 * Done once per version of the page, and only once every file the page itself names is kept:
 * before that, the files in use can't be told from the old ones. A page of an older version still
 * open elsewhere may find a screen gone; it then reloads into the new version, as it would have.
 */
async function pruneAssets(cache, loaded) {
  const page = await cache.match("/");
  if (!page) return;
  const html = await page.text();
  const noted = await cache.match(PRUNED_FOR);
  if (noted && (await noted.text()) === html) return;

  const nameOf = (address) => new URL(address, self.location.origin).pathname.split("/").pop();
  const kept = new Map();
  for (const request of await cache.keys()) if (new URL(request.url).pathname.startsWith("/assets/")) kept.set(nameOf(request.url), request);
  const namedIn = (text) => (text.match(/[\w@~+.-]+\.\w{2,5}/g) ?? []).filter((name) => kept.has(name));
  const named = [...html.matchAll(/\/assets\/([\w@~+.-]+)/g)].map((m) => m[1]);
  if (!named.length || named.some((name) => !kept.has(name))) return;

  const used = new Set(loaded.map(nameOf));
  const toRead = [html];
  for (const name of used) if (kept.has(name) && /\.(m?js|css)$/.test(name)) toRead.push(await (await cache.match(kept.get(name))).text());
  while (toRead.length) {
    for (const name of namedIn(toRead.pop())) {
      if (used.has(name)) continue;
      used.add(name);
      if (/\.(m?js|css)$/.test(name)) toRead.push(await (await cache.match(kept.get(name))).text());
    }
  }
  for (const [name, request] of kept) if (!used.has(name)) await cache.delete(request);
  await cache.put(PRUNED_FOR, new Response(html));
}

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
