/**
 * The parts of the Sentry browser SDK that monitoring.ts uses, imported by name so the bundler
 * leaves out tracing, replays and feedback. Loaded on demand; nothing else should import it.
 */
import { SENTRY_DATA_COLLECTION, scrubEvent } from "@crewtavo/core/privacy";
import {
  breadcrumbsIntegration,
  browserApiErrorsIntegration,
  captureException,
  dedupeIntegration,
  eventFiltersIntegration,
  functionToStringIntegration,
  globalHandlersIntegration,
  httpContextIntegration,
  init,
  linkedErrorsIntegration,
} from "@sentry/browser";

export { captureException };

export function start(dsn: string, environment: string) {
  init({
    dsn,
    environment,
    dataCollection: SENTRY_DATA_COLLECTION,
    // Errors and the breadcrumbs that explain them; no sessions, tracing or replays.
    defaultIntegrations: false,
    integrations: [
      eventFiltersIntegration(),
      functionToStringIntegration(),
      browserApiErrorsIntegration(),
      breadcrumbsIntegration(),
      globalHandlersIntegration(),
      linkedErrorsIntegration(),
      dedupeIntegration(),
      httpContextIntegration(),
    ],
    // A view transition that's skipped or cut short by the next navigation rejects; that's normal.
    ignoreErrors: [/Transition was aborted because of invalid state/, /Transition was skipped/],
    beforeSend: scrubEvent,
  });
}
