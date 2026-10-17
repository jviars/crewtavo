/**
 * The service worker (public/sw.js) and push notifications on this device. Push works in Chrome,
 * Edge, Firefox and Safari; on an iPhone, only after Crewtavo is added to the Home Screen.
 */
import { api } from "./api";

const fromBase64Url = (text: string) => {
  const b64 = text.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (text.length % 4)) % 4);
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
};

/** Register the worker. Production builds also keep the app on the phone for when there's no signal. */
export function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  const offline = import.meta.env.PROD;
  navigator.serviceWorker
    .register(offline ? "/sw.js?cache=1" : "/sw.js")
    .then(async (registration) => {
      if (!offline) return;
      await navigator.serviceWorker.ready;
      // Save every app file loaded so far, now and again once the other screens have downloaded.
      const send = () => {
        const urls = performance.getEntriesByType("resource").map((e) => e.name).filter((u) => new URL(u).pathname.startsWith("/assets/"));
        (registration.active ?? navigator.serviceWorker.controller)?.postMessage({ type: "cache-assets", urls });
      };
      send();
      setTimeout(send, 15_000);
    })
    .catch(() => undefined);
}

export type PushState = "unsupported" | "needs-install" | "blocked" | "off" | "on";

const isIos = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const standalone = () => window.matchMedia("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone === true;

export async function pushState(): Promise<PushState> {
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
    return isIos() && !standalone() ? "needs-install" : "unsupported";
  }
  if (Notification.permission === "denied") return "blocked";
  const registration = await navigator.serviceWorker.getRegistration();
  const subscription = await registration?.pushManager.getSubscription();
  return subscription ? "on" : "off";
}

/** Ask permission, subscribe, and tell the server about this device. */
export async function enablePush(): Promise<void> {
  const permission = await Notification.requestPermission();
  if (permission !== "granted") throw new Error(permission === "denied" ? "Notifications are blocked for Crewtavo in this browser's settings." : "Notifications weren't allowed.");
  const registration = (await navigator.serviceWorker.getRegistration()) ?? (await navigator.serviceWorker.register("/sw.js"));
  await navigator.serviceWorker.ready;
  const { publicKey } = await api.get<{ publicKey: string }>("/push/key");
  let subscription = await registration.pushManager.getSubscription();
  subscription ??= await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: fromBase64Url(publicKey) });
  const json = subscription.toJSON() as { endpoint: string; keys: { p256dh: string; auth: string } };
  await api.post("/push/subscriptions", { endpoint: json.endpoint, keys: json.keys, device: deviceName() });
}

export async function disablePush(): Promise<void> {
  const registration = await navigator.serviceWorker.getRegistration();
  const subscription = await registration?.pushManager.getSubscription();
  if (!subscription) return;
  await api.post("/push/unsubscribe", { endpoint: subscription.endpoint }).catch(() => undefined);
  await subscription.unsubscribe();
}

function deviceName(): string {
  const ua = navigator.userAgent;
  const os = /iPhone|iPad/.test(ua) ? "iPhone" : /Android/.test(ua) ? "Android" : /Mac/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : "Device";
  const browser = /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome" : /Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : "browser";
  return `${os} · ${browser}`;
}
