/**
 * How starting up went: server.ts applies database migrations before the instance takes traffic
 * and records the outcome here, for /api/health (Railway waits on it) and /api/setup (the
 * "Finish setting up" page explains a failure in plain words). Unset when nothing ran them.
 */
export type MigrationProblem = "wrong_password" | "unreachable" | "bad_url" | "services_not_ready" | "busy" | "newer_database" | "migration_failed";

export interface Startup {
  state: "migrating" | "ready" | "failed";
  /** No migrations had been applied before: a brand-new instance, not an update. */
  firstInstall?: boolean;
  /**
   * Why it failed. One problem doesn't stop it and comes with "ready": newer_database, an older
   * Crewtavo started on a database a newer one has already updated (scripts/migrate.mjs says why
   * that keeps running).
   */
  problem?: MigrationProblem;
  /** For migration_failed and busy: which file and what Postgres said (no secrets). For newer_database: how far ahead the database is. */
  detail?: string;
}

let current: Startup | null = null;

export const startup = () => current;
export const setStartup = (next: Startup | null) => {
  current = next;
};
