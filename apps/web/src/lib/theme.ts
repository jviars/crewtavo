/**
 * Light, dark, or follow the device. The choice is kept per device and applied as a `dark` class on
 * <html>; index.html does the same before first paint so there's no flash. Pages clients see (their
 * hub, booking forms, referral and unsubscribe links) always stay light: they carry the business's
 * own branding.
 */
import { useSyncExternalStore } from "react";

export type ThemeChoice = "light" | "dark" | "system";

const KEY = "crewtavo.theme"; // also read by the script in index.html
const CLIENT_FACING = /^\/(hub|book|u|refer)\//;
const media = window.matchMedia("(prefers-color-scheme: dark)");
const listeners = new Set<() => void>();

function stored(): ThemeChoice {
  try {
    const value = localStorage.getItem(KEY);
    return value === "light" || value === "dark" ? value : "system";
  } catch {
    return "system";
  }
}

let choice = stored();

function apply() {
  const dark = !CLIENT_FACING.test(window.location.pathname) && (choice === "dark" || (choice === "system" && media.matches));
  document.documentElement.classList.toggle("dark", dark);
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", dark ? "#191918" : "#F6F5F1");
}

function changed() {
  listeners.forEach((listener) => listener());
}

export function setTheme(next: ThemeChoice) {
  choice = next;
  try {
    if (next === "system") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, next);
  } catch {
    // Private mode: the choice lasts until the tab closes.
  }
  // Cross-fade the whole page rather than letting every color transition on its own.
  // (A background tab skips the transition; the change still applies.)
  if (document.startViewTransition) document.startViewTransition(apply).ready.catch(() => undefined);
  else apply();
  changed();
}

export function useTheme(): ThemeChoice {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => choice,
  );
}

/** Keep up with the device switching modes, and with the choice changing in another tab. */
export function initTheme() {
  media.addEventListener("change", apply);
  window.addEventListener("storage", (e) => {
    if (e.key !== KEY && e.key !== null) return;
    choice = stored();
    apply();
    changed();
  });
  apply();
}
