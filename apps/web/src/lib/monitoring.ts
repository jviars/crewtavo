/**
 * Error reporting to Sentry, or to any Sentry-compatible service such as a self-hosted GlitchTip.
 * Off unless the deployment sets CREWTAVO_SENTRY_DSN (the API passes it in /api/config). The SDK
 * (sentry.ts) is downloaded only then, so it never adds to the main bundle. scrubEvent strips
 * personal data before anything leaves the browser.
 */
export interface MonitoringConfig {
  dsn: string;
  environment: string;
}

let sdk: typeof import("./sentry") | null = null;
/** Errors from before the config arrived; dropped if reporting turns out to be off. */
let early: Array<[unknown, Record<string, unknown> | undefined]> | null = [];

export function startMonitoring(config: MonitoringConfig | null | undefined) {
  if (!config?.dsn) {
    early = null;
    return;
  }
  if (sdk) return;
  import("./sentry")
    .then((loaded) => {
      loaded.start(config.dsn, config.environment);
      sdk = loaded;
      for (const [error, context] of early ?? []) report(error, context);
      early = null;
    })
    .catch(() => {
      early = null; // Blocked by an ad blocker or offline: carry on without reporting.
    });
}

function report(error: unknown, context?: Record<string, unknown>) {
  sdk?.captureException(error, context ? { extra: context } : undefined);
}

/** Report something unexpected. `context` should be names and ids of things, never people's data. */
export function reportError(error: unknown, context?: Record<string, unknown>) {
  if (sdk) report(error, context);
  else if (early && early.length < 20) early.push([error, context]);
}
