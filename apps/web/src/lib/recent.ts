/** Recently opened records, per company, for the command palette. Stored on this device only. */
import { useEffect } from "react";

export interface RecentItem {
  kind: "client" | "request" | "quote" | "job" | "invoice" | "equipment";
  id: string;
  title: string;
  subtitle?: string;
  path: string;
}

const key = (companyId: string) => `crewtavo.recent.${companyId}`;

export function getRecents(companyId: string): RecentItem[] {
  try {
    return JSON.parse(localStorage.getItem(key(companyId)) ?? "[]") as RecentItem[];
  } catch {
    return [];
  }
}

export function rememberRecent(companyId: string, item: RecentItem) {
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
