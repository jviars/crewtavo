/**
 * The migration runner (scripts/migrate.mjs) on a database that's in use:
 *  - a database that holds migrations this build has no file for was updated by a newer Crewtavo
 *    (the owner set the image back, or Railway rolled back). The runner says so and carries on;
 *  - a migration waits ten seconds at most for a table, and a file that couldn't get one (or lost a
 *    deadlock to the app) is tried again a few times. Past that the problem is "busy", which the
 *    server waits out, not "migration_failed", which it doesn't.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";

const dir = fileURLToPath(new URL("../../../supabase/migrations", import.meta.url));
const files = readdirSync(dir).filter((f) => /^\d+_.+\.sql$/.test(f)).sort();
const versions = files.map((f) => f.split("_")[0]);
const last = files[files.length - 1];

/** The database the runner finds: what's applied, and what each go at a migration's body throws. */
const pg = vi.hoisted(() => ({ applied: [] as string[], errors: [] as Array<{ code: string; message: string }>, transactions: 0, lockTimeouts: [] as unknown[] }));

vi.mock("postgres", () => ({
  default: () => {
    const sql = async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.join("?");
      if (text.includes("as ready")) return [{ ready: true }];
      if (text.includes("select version from")) return pg.applied.map((version) => ({ version }));
      if (text.includes("as folds")) return [{ folds: false }];
      if (text.includes("set_config('lock_timeout'")) pg.lockTimeouts.push(values[0]);
      return [];
    };
    const tx = Object.assign((strings: TemplateStringsArray, ...values: unknown[]) => sql(strings, ...values), {
      unsafe: async (text: string) => {
        if (text.includes("set constraints")) return;
        const error = pg.errors.shift();
        if (error) throw Object.assign(new Error(error.message), { code: error.code });
      },
    });
    return Object.assign(sql, {
      begin: async (run: (t: typeof tx) => Promise<void>) => {
        pg.transactions++;
        await run(tx);
      },
      end: async () => {},
    });
  },
}));

const folder = mkdtempSync(join(tmpdir(), "crewtavo-migrate-"));
const statusFile = join(folder, "status.json");
const LOCK_TIMEOUT = { code: "55P03", message: "canceling statement due to lock timeout" };
const DEADLOCK = { code: "40P01", message: "deadlock detected" };

/** Runs the runner to its end, with the pauses between tries skipped. What it reported to the server. */
async function migrate() {
  vi.resetModules();
  let settled = false;
  const run = import(new URL("../../../scripts/migrate.mjs", import.meta.url).href).finally(() => (settled = true));
  while (!settled) {
    await vi.advanceTimersByTimeAsync(1_000);
    await new Promise((resolve) => setImmediate(resolve));
  }
  await run;
  return JSON.parse(readFileSync(statusFile, "utf8")) as { ok: boolean; firstInstall?: boolean; applied?: number; problem?: string; detail?: string };
}

let log: ReturnType<typeof vi.spyOn>;
let warn: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  Object.assign(pg, { applied: versions, errors: [], transactions: 0, lockTimeouts: [] });
  vi.stubEnv("SUPABASE_DB_URL", "postgres://postgres:secret@db:5432/postgres");
  vi.stubEnv("CREWTAVO_MIGRATE_STATUS", statusFile);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  log = vi.spyOn(console, "log").mockImplementation(() => {});
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  error = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

afterAll(() => rmSync(folder, { recursive: true, force: true }));

it("says nothing more than usual about a database it knows", async () => {
  expect(await migrate()).toEqual({ ok: true, firstInstall: false, applied: 0 });
  expect(warn).not.toHaveBeenCalled();
});

it("says when a newer Crewtavo has already updated the database, and carries on", async () => {
  pg.applied = [...versions, "29990101000100", "29990101000200"];
  expect(await migrate()).toEqual({ ok: true, firstInstall: false, applied: 0, problem: "newer_database", detail: "2 newer migrations, up to 29990101000200" });
  expect(warn).toHaveBeenCalledTimes(1);
  expect(String(warn.mock.calls[0][0])).toContain("older than its database");
  expect(error).not.toHaveBeenCalled();
  expect(process.exitCode).toBeUndefined();
});

it("still applies what it has to a database that's also ahead of it", async () => {
  pg.applied = [...versions.slice(0, -1), "29990101000100"];
  expect(await migrate()).toMatchObject({ ok: true, applied: 1, problem: "newer_database", detail: "1 newer migration, up to 29990101000100" });
  expect(log).toHaveBeenCalledWith(`migrate: applied ${last}`);
});

it("gives a migration ten seconds to get a table, in its own transaction", async () => {
  pg.applied = versions.slice(0, -2);
  expect(await migrate()).toMatchObject({ ok: true, applied: 2 });
  expect(pg.lockTimeouts).toEqual(["10s", "10s"]);
});

it("tries a file again when the database was busy", async () => {
  pg.applied = versions.slice(0, -1);
  pg.errors = [LOCK_TIMEOUT, DEADLOCK];
  expect(await migrate()).toEqual({ ok: true, firstInstall: false, applied: 1 });
  expect(pg.transactions).toBe(3);
  expect(warn).toHaveBeenCalledTimes(2);
  expect(String(warn.mock.calls[0][0])).toContain(`${last} (canceling statement due to lock timeout)`);
  expect(log).toHaveBeenCalledWith(`migrate: applied ${last}`);
});

it("gives up on a database that stays busy, and says busy rather than a failed migration", async () => {
  pg.applied = versions.slice(0, -1);
  pg.errors = Array.from({ length: 10 }, () => LOCK_TIMEOUT);
  expect(await migrate()).toEqual({ ok: false, firstInstall: false, problem: "busy", detail: `${last}: canceling statement due to lock timeout` });
  expect(pg.transactions).toBe(5);
  expect(process.exitCode).toBe(1);
});

it("doesn't try a migration again when the migration itself is wrong", async () => {
  pg.applied = versions.slice(0, -1);
  pg.errors = [{ code: "23502", message: 'column "probe" of relation "clients" contains null values' }];
  expect(await migrate()).toEqual({ ok: false, firstInstall: false, problem: "migration_failed", detail: `${last}: column "probe" of relation "clients" contains null values` });
  expect(pg.transactions).toBe(1);
});
