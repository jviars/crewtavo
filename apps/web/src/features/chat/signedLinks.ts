/**
 * Links to chat's photos and voice notes, kept for each file as long as they work. The files bucket
 * is private, so each needs a signed link that runs out after an hour. Asking for every link a
 * conversation has whenever one more photo came, or an older page loaded, gave every file a new
 * link: each photo loaded again, and a voice note that was playing stopped and went back to its
 * start. Here a file keeps its link until ten minutes before it runs out; only files with no link
 * (or one about to run out) are signed, all of them in one ask, and every screen showing a file
 * gets its link from the same place.
 */
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { signedUrls } from "@/lib/files";

export const LINK_SECONDS = 3600;
/** A link this close to running out is replaced (and kept showing until its new one comes). */
export const RENEW_MS = 10 * 60_000;
/** A file that got no link (gone, or a moment without signal) is asked about again after this. */
export const RETRY_MS = 15_000;

export interface Kept {
  url: string;
  until: number;
}

/** The links kept, and the files being signed now. Pure, so it can be tested without a page. */
export class LinkStore {
  readonly links = new Map<string, Kept>();
  readonly asking = new Set<string>();
  /** Files that got no link, and when to ask again. */
  readonly failed = new Map<string, number>();
  version = 0;

  /** The files among `paths` that need a link: none yet, or one about to run out, and not being signed already. */
  need(paths: readonly string[], now: number): string[] {
    return [...new Set(paths)].filter((path) => {
      if (this.asking.has(path) || (this.failed.get(path) ?? 0) > now) return false;
      const kept = this.links.get(path);
      return !kept || kept.until - now < RENEW_MS;
    });
  }

  /** Signing them has started. */
  start(paths: readonly string[]) {
    for (const path of paths) this.asking.add(path);
  }

  /** Their links came back. A file with none (gone, or not this person's) keeps what it had, and is asked about again later. */
  done(paths: readonly string[], urls: Record<string, string>, now: number) {
    for (const path of paths) {
      this.asking.delete(path);
      if (urls[path]) {
        this.links.set(path, { url: urls[path], until: now + LINK_SECONDS * 1000 });
        this.failed.delete(path);
      } else this.failed.set(path, now + RETRY_MS);
    }
    this.version += 1;
  }

  /** Each file's link, for those that have one: the same string for as long as it's kept. */
  get(paths: readonly string[]): Record<string, string> {
    const out: Record<string, string> = {};
    for (const path of paths) {
      const kept = this.links.get(path);
      if (kept) out[path] = kept.url;
    }
    return out;
  }

  /** When to look at these files again: the soonest a link should be renewed, or a file without one asked about again. Null for never. */
  nextLook(paths: readonly string[]): number | null {
    let soonest: number | null = null;
    const take = (at: number) => {
      if (soonest === null || at < soonest) soonest = at;
    };
    for (const path of paths) {
      const kept = this.links.get(path);
      if (kept) take(kept.until - RENEW_MS);
      const retry = this.failed.get(path);
      if (retry !== undefined) take(retry);
    }
    return soonest;
  }
}

const store = new LinkStore();
const listeners = new Set<() => void>();
const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};
const changed = () => listeners.forEach((fn) => fn());

/** Signed links for these stored files (photos, voice notes), each kept as it is for as long as it works. */
export function useSignedLinks(paths: readonly string[]): Record<string, string> {
  const version = useSyncExternalStore(subscribe, () => store.version);
  const key = [...new Set(paths)].sort().join("\n");
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const list = key ? key.split("\n") : [];
    const missing = store.need(list, Date.now());
    if (missing.length) {
      store.start(missing);
      // Either way the store has changed, and every screen looks again: at a new link, or when to retry.
      signedUrls(missing, LINK_SECONDS).then(
        (urls) => store.done(missing, urls, Date.now()),
        () => store.done(missing, {}, Date.now()),
      ).finally(changed);
    }
    // Look again when the soonest link should be renewed, or a file without one asked about again.
    const next = store.nextLook(list);
    const wait = next === null ? null : Math.max(1_000, next - Date.now() + 50);
    const timer = wait === null ? undefined : setTimeout(() => setTick((n) => n + 1), Math.min(wait, 2 ** 31 - 1));
    return () => clearTimeout(timer);
  }, [key, tick, version]);

  return useMemo(() => store.get(key ? key.split("\n") : []), [key, version]);
}
