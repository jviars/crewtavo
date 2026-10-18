/**
 * Installing Crewtavo as an app on this device. Chrome and Edge (on Android, and on computers) offer
 * an install prompt, which we hold on to and open from our own button. Safari on an iPhone or iPad
 * has no prompt: the crew get a tip instead (Share, then Add to Home Screen). Nothing shows once
 * Crewtavo runs as an installed app, nor on the pages clients see. The crew can put the tip away for
 * good on this device; Settings keeps the button.
 */
import { useSyncExternalStore } from "react";

/** Chrome's `beforeinstallprompt` event. */
interface InstallPrompt extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

export type InstallHint = "prompt" | "ios" | null;

/** Pages clients see (their hub, booking forms, referral and unsubscribe links): never about installing Crewtavo. */
const CLIENT_FACING = /^\/(hub|book|u|refer)(\/|$)/;
const DISMISSED = "crewtavo.install-tip.dismissed";

interface Device {
  userAgent: string;
  platform: string;
  maxTouchPoints: number;
}

/** An iPhone or iPad, the iPad included when it asks for desktop sites (it then says it's a Mac, but has a touch screen). */
export const isIos = (device: Device = navigator) =>
  /iPad|iPhone|iPod/.test(device.userAgent) || (device.platform === "MacIntel" && device.maxTouchPoints > 1);

/** Safari itself, the only browser on an iPhone that can add Crewtavo to the Home Screen with the tip's steps (not Chrome, Firefox or an app's built-in browser). */
export const isIosSafari = (device: Device = navigator) =>
  isIos(device) && /Version\/[\d.]+.*Safari\//.test(device.userAgent) && !/CriOS|FxiOS|EdgiOS|OPiOS|OPT\/|GSA\/|YaBrowser|DuckDuckGo|FBAN|FBAV|Instagram|Line\//.test(device.userAgent);

/** Running as an installed app (from the home screen) rather than in a browser tab. */
export const isStandalone = (win: Pick<Window, "matchMedia"> & { navigator: Partial<Navigator> & { standalone?: boolean } } = window) =>
  Boolean(win.matchMedia?.("(display-mode: standalone)").matches) || win.navigator.standalone === true;

/** What to offer: our install button where the browser has a prompt, the tip in Safari on an iPhone or iPad, or nothing. */
export function installHint(state: { standalone: boolean; installed: boolean; canPrompt: boolean; iosSafari: boolean; path: string }): InstallHint {
  if (state.standalone || state.installed || CLIENT_FACING.test(state.path)) return null;
  if (state.canPrompt) return "prompt";
  return state.iosSafari ? "ios" : null;
}

let held: InstallPrompt | null = null;
let installed = false;
let dismissed: boolean | undefined;
const listeners = new Set<() => void>();
const changed = () => listeners.forEach((listener) => listener());

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Listen for the browser's install prompt and for Crewtavo being installed. Call once, early (the
 * prompt can come before the screens load). Holding the prompt also keeps the browser's own install
 * banner away, the pages clients see included.
 */
export function watchInstall(win: Window = window) {
  win.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    held = event as InstallPrompt;
    changed();
  });
  win.addEventListener("appinstalled", () => {
    held = null;
    installed = true;
    changed();
  });
  // Opened from the home screen in the same tab (some browsers move the tab into the app).
  win.matchMedia?.("(display-mode: standalone)").addEventListener?.("change", changed);
}

/** The install hint for this device and page, kept up to date. */
export function currentInstallHint(): InstallHint {
  if (typeof window === "undefined") return null;
  return installHint({ standalone: isStandalone(), installed, canPrompt: held !== null, iosSafari: isIosSafari(), path: window.location.pathname });
}

export const useInstallHint = () => useSyncExternalStore(subscribe, currentInstallHint);

/** Open the browser's install prompt. True when the person installed Crewtavo. */
export async function installApp(): Promise<boolean> {
  const prompt = held;
  if (!prompt) return false;
  // A prompt opens once: the browser offers a new one later if they said no.
  held = null;
  changed();
  await prompt.prompt();
  const { outcome } = await prompt.userChoice;
  return outcome === "accepted";
}

/** The crew put the tip away on this device. */
export function installTipDismissed(): boolean {
  if (dismissed === undefined) {
    try {
      dismissed = localStorage.getItem(DISMISSED) === "1";
    } catch {
      dismissed = false;
    }
  }
  return dismissed;
}

export function dismissInstallTip() {
  dismissed = true;
  try {
    localStorage.setItem(DISMISSED, "1");
  } catch {
    // Private mode: put away until the app is next opened.
  }
  changed();
}

export const useInstallTipDismissed = () => useSyncExternalStore(subscribe, installTipDismissed);
