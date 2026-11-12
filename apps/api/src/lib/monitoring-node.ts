/** Error reporting for the server (server.ts), with @sentry/node. See monitoring.ts. */
import * as Sentry from "@sentry/node";
import type { Env } from "../env";
import { sentryOptions } from "./monitoring";

/**
 * A promise that failed with nothing waiting for it (work left to finish after an answer, say).
 * Node's own answer is to stop the server. One piece of background work isn't worth everyone's
 * requests, so it's logged and the server carries on, the same whether or not Sentry is on.
 */
export function logUnhandledRejection(reason: unknown) {
  console.error("A promise failed and nothing handled it:", reason instanceof Error ? reason.stack ?? reason.message : reason);
}

/** Start Sentry if CREWTAVO_SENTRY_DSN is set. Call once, before handling requests. */
export function startMonitoring(env: Env) {
  process.on("unhandledRejection", logUnhandledRejection);
  const options = sentryOptions(env);
  if (!options) return;
  Sentry.init({
    ...options,
    // Errors only: no tracing, no sessions, no patching of http or fetch.
    defaultIntegrations: false,
    integrations: [
      Sentry.eventFiltersIntegration(),
      Sentry.functionToStringIntegration(),
      Sentry.linkedErrorsIntegration(),
      Sentry.dedupeIntegration(),
      Sentry.nodeContextIntegration(),
      Sentry.onUncaughtExceptionIntegration(),
      // Reports it and no more: the logging is above.
      Sentry.onUnhandledRejectionIntegration({ mode: "none" }),
    ],
  });
}
