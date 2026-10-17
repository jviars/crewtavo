/**
 * How starting up went: server.ts applies database migrations before the instance takes traffic
 * and records the outcome here, for /api/health (Railway waits on it) and /api/setup (the
 * "Finish setting up" page explains a failure in plain words). Unset when nothing ran them.
 */
export type MigrationProblem = "wrong_password" | "unreachable" | "bad_url" | "services_not_ready" | "migration_failed";

export interface Startup {
  state: "migrating" | "ready" | "failed";
  /** No migrations had been applied before: a brand-new instance, not an update. */
  firstInstall?: boolean;
  problem?: MigrationProblem;
  /** For migration_failed: which file and what Postgres said (no secrets). */
  detail?: string;
}

let current: Startup | null = null;

export const startup = () => current;
export const setStartup = (next: Startup | null) => {
  current = next;
};
