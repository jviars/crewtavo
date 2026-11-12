/**
 * Recently opened records, per company and person, for the command palette. Stored on this device
 * only, and cleared when the person signs out (lib/offline.ts forgetOfflineCache): they hold
 * clients' names and addresses, and the next person on a shared tablet shouldn't see them.
 */
import { useEffect } from "react";

export interface RecentItem {
  kind: "client" | "request" | "quote" | "job" | "invoice" | "equipment" | "sub";
  id: string;
  title: string;
  subtitle?: string;
  path: string;
}

const PREFIX = "crewtavo.recent.";
/** Whose recents are read and written: the signed-in person (lib/session.tsx). */
let person: string | null = null;

const key = (companyId: string) => `${PREFIX}${companyId}.${person}`;
/** Kept per company alone, by versions before this one: nobody's in particular, so never read again. */
const unowned = (name: string) => name.startsWith(PREFIX) && !name.slice(PREFIX.length).includes(".");

function forget(which: (name: string) => boolean) {
  try {
    const names = Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i) ?? "");
    for (const name of names) if (which(name)) localStorage.removeItem(name);
  } catch {
    // Storage blocked: nothing was kept.
  }
}

export function setRecentsPerson(userId: string | null) {
  if (userId === person) return;
  person = userId;
  if (userId) forget(unowned);
}

/** Signed out on purpose: their recents go from this device, with any kept before recents were per person. */
export function forgetRecents(userId: string) {
  forget((name) => unowned(name) || (name.startsWith(PREFIX) && name.endsWith(`.${userId}`)));
}

export function getRecents(companyId: string): RecentItem[] {
  if (!person) return [];
  try {
    return JSON.parse(localStorage.getItem(key(companyId)) ?? "[]") as RecentItem[];
  } catch {
    return [];
  }
}

export function rememberRecent(companyId: string, item: RecentItem) {
  if (!person) return;
  try {
    const items = [item, ...getRecents(companyId).filter((i) => !(i.kind === item.kind && i.id === item.id))].slice(0, 8);
    localStorage.setItem(key(companyId), JSON.stringify(items));
  } catch {
    // Storage full or blocked: recents are a convenience.
  }
}

export function useRememberRecent(companyId: string, item: RecentItem | null) {
  const signature = item ? `${item.kind}:${item.id}:${item.title}:${item.subtitle ?? ""}` : "";
  useEffect(() => {
    if (item) rememberRecent(companyId, item);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyId, signature]);
}
