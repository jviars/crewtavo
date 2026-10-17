/**
 * The crew's day on the phone, for job sites with no signal. What My day and a visit show is kept
 * in this browser's storage, and field actions (on my way, start, complete, checklist, notes) made
 * offline wait in order and go out when the connection is back, even if the app was closed in
 * between. Office screens aren't kept: they hold prices and client details that don't belong on a
 * crew phone. Cleared on sign-out.
 */
import { dehydrate, hydrate, onlineManager, type QueryClient } from "@tanstack/react-query";

// React Query assumes it's online until it hears otherwise; a phone that opens the app with no
// signal is offline from the start, so field actions queue instead of failing.
if (typeof navigator !== "undefined" && navigator.onLine === false) onlineManager.setOnline(false);

const VERSION = 1;
/** Queries worth having with no signal. */
const KEEP = new Set(["field", "field-visit", "checklist", "running-timer", "material-choices", "my-crews", "dispatch-options", "crew-clock", "job"]);
/** Mutations that can wait for a connection (their functions are registered with setMutationDefaults). */
export const OFFLINE_MUTATIONS = new Set(["visit-status", "checklist-save", "visit-notes"]);
/** Field actions run one at a time, in the order they were made. */
export const FIELD_SCOPE = { id: "field-sync" };

const storageKey = (userId: string) => `crewtavo.offline.v${VERSION}.${userId}`;

export function startOfflineCache(queryClient: QueryClient, userId: string, keepQueries: boolean): () => void {
  try {
    const saved = localStorage.getItem(storageKey(userId));
    if (saved) hydrate(queryClient, JSON.parse(saved));
  } catch {
    // Unreadable or full storage: start fresh.
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const save = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      try {
        const state = dehydrate(queryClient, {
          shouldDehydrateQuery: (q) => keepQueries && q.state.status === "success" && KEEP.has(String(q.queryKey[0])) && !(q.queryKey[0] === "job" && q.queryKey[2] !== "scope"),
          shouldDehydrateMutation: (m) => m.state.isPaused && OFFLINE_MUTATIONS.has(String(m.options.mutationKey?.[0])),
        });
        const text = JSON.stringify(state);
        if (text.length < 2_000_000) localStorage.setItem(storageKey(userId), text);
      } catch {
        // Private mode or storage full: offline support just isn't available.
      }
    }, 800);
  };
  const stopQueries = queryClient.getQueryCache().subscribe(save);
  const stopMutations = queryClient.getMutationCache().subscribe(save);
  if (navigator.onLine) queryClient.resumePausedMutations().catch(() => undefined);
  return () => {
    stopQueries();
    stopMutations();
    clearTimeout(timer);
  };
}

export function forgetOfflineCache(userId: string) {
  try {
    localStorage.removeItem(storageKey(userId));
  } catch {
    // Nothing to clear.
  }
}

/** Field actions waiting for a connection, for "3 updates waiting to send". */
export const pendingFieldActions = (queryClient: QueryClient) =>
  queryClient.getMutationCache().getAll().filter((m) => m.state.isPaused && OFFLINE_MUTATIONS.has(String(m.options.mutationKey?.[0]))).length;
