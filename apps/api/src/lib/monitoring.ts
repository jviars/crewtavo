/**
 * Error reporting to Sentry, or to any Sentry-compatible service such as a self-hosted GlitchTip.
 * Off unless CREWTAVO_SENTRY_DSN is set. server.ts starts @sentry/node (monitoring-node.ts); everything
 * else reports through reportError(), which does nothing while reporting is off. Errors only: no
 * tracing or sessions. scrubEvent (packages/core/src/privacy.ts) strips personal data first.
 */
import { SENTRY_DATA_COLLECTION, scrubEvent } from "@crewtavo/core/privacy";
import { captureException, getClient } from "@sentry/core";
import type { Env } from "../env";

type MonitoringEnv = Pick<Env, "CREWTAVO_SENTRY_DSN" | "CREWTAVO_SENTRY_ENVIRONMENT">;

/** Options shared by both SDKs, or undefined when reporting is off. */
export function sentryOptions(env: MonitoringEnv) {
  if (!env.CREWTAVO_SENTRY_DSN) return undefined;
  return {
    dsn: env.CREWTAVO_SENTRY_DSN,
    environment: env.CREWTAVO_SENTRY_ENVIRONMENT || "production",
    dataCollection: SENTRY_DATA_COLLECTION,
    beforeSend: scrubEvent,
  };
}

let afterReport: (() => void) | undefined;
/** For entry points that must keep the process alive until a report is sent. */
export const onReport = (fn: () => void) => {
  afterReport = fn;
};

/** Report something unexpected. `context` should be ids and names of things, never people's data. */
export function reportError(error: unknown, context?: Record<string, unknown>) {
  if (!getClient()) return;
  captureException(error, context ? { extra: context } : undefined);
  afterReport?.();
}
