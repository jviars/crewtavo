/**
 * React Query setup with app-wide feedback: every failed action shows a toast unless the screen
 * shows the error inline (meta.inline), and actions can announce success with meta.success.
 */
import { MutationCache, QueryCache, QueryClient } from "@tanstack/react-query";
import { activeCompany, api, refreshSignIn } from "./api";
import { ApiError, errorMessage, isAuthError, OFFLINE, SESSION_EXPIRED } from "./errors";
import { reportError } from "./monitoring";
import { toast } from "./toast";

/**
 * After any change, ask the API to run automations that are due now (notifications, follow-ups),
 * so they happen within a second or two rather than on the next scheduled run. Debounced.
 */
let kickTimer: ReturnType<typeof setTimeout> | undefined;
function kickAutomations() {
  if (!activeCompany()) return;
  clearTimeout(kickTimer);
  kickTimer = setTimeout(() => {
    api.post("/automations/process").catch(() => undefined);
  }, 900);
}

declare module "@tanstack/react-query" {
  interface Register {
    mutationMeta: {
      /** Toast after success. A function can build the message from the result, or return null for none. */
      success?: string | ((data: never, variables: never) => string | null | undefined);
      /** The screen shows this mutation's error itself (forms in dialogs). */
      inline?: boolean;
    };
    queryMeta: {
      /** Don't toast when a background refresh of this query fails. */
      silent?: boolean;
    };
  }
}

let onSessionExpired: (() => void) | null = null;
export const setSessionExpiredHandler = (fn: () => void) => {
  onSessionExpired = fn;
};

/** Failures the app explains (ApiError) are expected; anything else thrown is a bug worth reporting. */
function reportUnexpected(error: unknown, context: Record<string, unknown>) {
  if (!(error instanceof ApiError)) reportError(error, context);
}

/**
 * A 401. The access token may only have expired (say while the phone was offline), so unless the
 * API already refreshed it and was still turned away, refresh the sign-in once before signing the
 * person out. When they're still signed in (or the refresh couldn't get through), `stillSignedIn` decides what's next.
 */
function handleAuth(error: unknown, stillSignedIn: (outcome: "ok" | "offline") => void): boolean {
  if (!isAuthError(error)) return false;
  const signIn = (error as ApiError).code === SESSION_EXPIRED ? Promise.resolve("expired" as const) : refreshSignIn();
  void signIn.then((outcome) => {
    if (outcome !== "expired") return stillSignedIn(outcome);
    toast.info("Your session expired. Sign in again to continue.");
    onSessionExpired?.();
  });
  return true;
}

/** Queries already loaded again after a refreshed sign-in, so one that keeps being turned away doesn't loop. */
const reloadedAfterRefresh = new WeakSet<object>();

export const queryClient = new QueryClient({
  queryCache: new QueryCache({
    onError: (error, query) => {
      const reload = (outcome: "ok" | "offline") => {
        if (outcome !== "ok" || reloadedAfterRefresh.has(query)) return;
        reloadedAfterRefresh.add(query);
        queryClient.invalidateQueries({ queryKey: query.queryKey, exact: true });
      };
      if (handleAuth(error, reload)) return;
      reportUnexpected(error, { query: String(query.queryKey[0]) });
      // A first load that fails shows an error state on the screen. A refresh that fails while
      // data is already showing gets a toast instead, so stale data isn't silently presented as fresh.
      if (query.state.data !== undefined && !query.meta?.silent) toast.error("Couldn't refresh", { description: errorMessage(error) });
    },
  }),
  mutationCache: new MutationCache({
    onSuccess: (data, variables, _context, mutation) => {
      const success = mutation.meta?.success;
      const message = typeof success === "function" ? (success as (d: unknown, v: unknown) => string | null | undefined)(data, variables) : success;
      if (message) toast.success(message);
      kickAutomations();
      // Sidebar badges are cheap to recount after any change.
      queryClient.invalidateQueries({ queryKey: ["nav-counts"] });
    },
    onError: (error, _variables, _context, mutation) => {
      const tryAgain = (outcome: "ok" | "offline") => !mutation.meta?.inline && toast.error(outcome === "offline" ? OFFLINE : "That didn't go through. Try again.");
      if (handleAuth(error, tryAgain)) return;
      reportUnexpected(error, { mutation: String(mutation.options.mutationKey?.[0] ?? "") });
      if (!mutation.meta?.inline) toast.error(errorMessage(error));
    },
  }),
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: true,
      // Don't retry permission, validation or not-found errors; they won't fix themselves.
      retry: (count, error) => !(error instanceof ApiError && error.status >= 400 && error.status < 500) && count < 2,
    },
    mutations: { retry: false },
  },
});
