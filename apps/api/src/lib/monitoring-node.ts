/** Error reporting for the server (server.ts), with @sentry/node. See monitoring.ts. */
import * as Sentry from "@sentry/node";
import type { Env } from "../env";
import { sentryOptions } from "./monitoring";

/** Start Sentry if CREWTAVO_SENTRY_DSN is set. Call once, before handling requests. */
export function startMonitoring(env: Env) {
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
      Sentry.onUnhandledRejectionIntegration(),
    ],
  });
}
