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

/**
 * Failures that pass by themselves: the database or the Auth and Storage services weren't up yet,
 * or the database was too busy to update. A wrong password, a bad address or a migration that
 * failed needs someone, so trying those again would only loop.
 */
const PASSES = new Set<MigrationProblem>(["services_not_ready", "unreachable", "busy"]);

export const worthRetrying = (s: Startup | null) => s?.state === "failed" && s.problem !== undefined && PASSES.has(s.problem);

/**
 * How long to wait before trying again: 5 seconds, then twice as long each time, up to five
 * minutes, where it stays. A try costs next to nothing, and this way an instance whose database
 * was down for an hour is back within five minutes of it.
 */
export const retryDelay = (attempt: number) => Math.min(5_000 * 2 ** attempt, 5 * 60_000);

/**
 * After a start that failed for a reason that passes by itself, runs `again` until the instance is
 * ready, or fails for a reason that doesn't, or the server is stopping. Without it the server stayed
 * up but failed, with no background tasks, until someone redeployed.
 */
export async function retryStartup(
  again: () => Promise<void>,
  pause: (ms: number) => Promise<unknown> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  stopping: () => boolean = () => false,
): Promise<void> {
  for (let attempt = 0; worthRetrying(current) && !stopping(); attempt++) {
    await pause(retryDelay(attempt));
    if (stopping()) return;
    await again();
  }
}
