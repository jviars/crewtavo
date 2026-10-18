/**
 * The migration runner the server starts with (scripts/migrate.mjs) keeps Postgres' notices out of
 * the log, but a migration's warning goes to it: one that couldn't do something (the
 * assistant_access migration pointing the Data API at hooks.before_request, on a database whose
 * postgres role can't change authenticator) says so, and what to run instead.
 */
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";

type Notice = { severity: string; message: string };
const pg = vi.hoisted(() => ({ onnotice: null as ((notice: Notice) => unknown) | null }));

const dir = fileURLToPath(new URL("../../../supabase/migrations", import.meta.url));
const versions = readdirSync(dir).filter((f) => /^\d+_.+\.sql$/.test(f)).map((f) => f.split("_")[0]);
const WARNING = "Couldn't point the Data API at hooks.before_request (permission denied to alter role). Run: alter role authenticator set pgrst.db_pre_request = 'hooks.before_request';";

// A database that has everything but the assistant_access migration, which warns as it runs.
vi.mock("postgres", () => ({
  default: (_url: string, options: { onnotice: (notice: Notice) => unknown }) => {
    pg.onnotice = options.onnotice;
    const sql = async (strings: TemplateStringsArray) => {
      const text = strings.join("?");
      if (text.includes("as ready")) return [{ ready: true }];
      if (text.includes("select version from")) return versions.filter((v) => v !== "20261019001040").map((version) => ({ version }));
      if (text.includes("as folds")) return [{ folds: false }];
      return [];
    };
    const tx = Object.assign((strings: TemplateStringsArray) => sql(strings), {
      unsafe: async () => {
        pg.onnotice!({ severity: "NOTICE", message: 'schema "hooks" already exists, skipping' });
        pg.onnotice!({ severity: "WARNING", message: WARNING });
      },
    });
    return Object.assign(sql, { begin: (run: (t: typeof tx) => Promise<void>) => run(tx), end: async () => {} });
  },
}));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

it("logs a migration's warnings, and leaves Postgres' notices out", async () => {
  vi.stubEnv("SUPABASE_DB_URL", "postgres://postgres:secret@db:5432/postgres");
  vi.stubEnv("CREWTAVO_MIGRATE_STATUS", "");
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  await import(new URL("../../../scripts/migrate.mjs", import.meta.url).href);
  expect(error).not.toHaveBeenCalled();
  expect(log).toHaveBeenCalledWith("migrate: applied 20261019001040_assistant_access.sql");
  expect(warn.mock.calls).toEqual([[`migrate: warning in 20261019001040_assistant_access.sql: ${WARNING}`]]);
  expect(process.exitCode).toBeUndefined();
});
