#!/usr/bin/env node
/**
 * Applies supabase/migrations/*.sql in order, each in a transaction, recording them in the same
 * table the Supabase CLI uses (supabase_migrations.schema_migrations), so `supabase db push` and
 * this script can be used interchangeably.
 *
 * Database URL (first that's set): SUPABASE_DB_URL, DATABASE_URL. Use a direct or session-mode
 * connection, not transaction pooling.
 *
 * In a Crewtavo instance (deploy/README.md) the server runs this as it starts. On a brand-new
 * instance the database and the Auth and Storage services are starting at the same time, so it
 * waits (up to CREWTAVO_MIGRATE_WAIT seconds, default 180) for the database and for the tables those
 * services create (auth.users, storage.buckets), which the migrations build on.
 * CREWTAVO_MIGRATE_STATUS names a file to write the outcome to (see apps/api/src/lib/startup.ts).
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const url = process.env.SUPABASE_DB_URL || process.env.DATABASE_URL;
const statusFile = process.env.CREWTAVO_MIGRATE_STATUS;
const waitSeconds = Number(process.env.CREWTAVO_MIGRATE_WAIT ?? 180);
const report = (status) => statusFile && writeFileSync(statusFile, JSON.stringify(status));

if (!url) {
  console.log("migrate: no database URL set (SUPABASE_DB_URL); skipping.");
  report({ ok: true, skipped: true });
  process.exit(0);
}

const dir = join(dirname(fileURLToPath(import.meta.url)), "../supabase/migrations");
const files = readdirSync(dir).filter((f) => /^\d+_.+\.sql$/.test(f)).sort();

/** Errors that mean "not up yet" while an instance is starting, so worth waiting out. */
const TRANSIENT = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ETIMEDOUT", "EHOSTUNREACH", "ENETUNREACH", "ECONNRESET", "CONNECT_TIMEOUT", "57P03"]);
const UNREACHABLE = new Set([...TRANSIENT, "SERVICES_NOT_READY"]);

function problemOf(error) {
  if (error?.code === "28P01") return "wrong_password";
  if (error?.code === "SERVICES_NOT_READY") return "services_not_ready";
  if (UNREACHABLE.has(error?.code)) return "unreachable";
  if (error instanceof TypeError && /url/i.test(error.message)) return "bad_url";
  return "migration_failed";
}

let sql;
let firstInstall;
let current = null;
try {
  // No TLS on a private network: localhost, a docker compose service name ("db"), or Railway's
  // *.railway.internal. Anything else (a hosted database) requires it.
  const host = new URL(url).hostname;
  const local = !host.includes(".") || host === "127.0.0.1" || host.endsWith(".railway.internal") || /sslmode=disable/.test(url);
  sql = postgres(url, { max: 1, ssl: local ? false : "require", onnotice: () => {}, connect_timeout: 10 });

  const deadline = Date.now() + waitSeconds * 1000;
  const until = async (ready, what) => {
    let logged = false;
    for (;;) {
      try {
        if (await ready()) return;
      } catch (error) {
        if (!TRANSIENT.has(error?.code) || Date.now() > deadline) throw error;
      }
      if (Date.now() > deadline) throw Object.assign(new Error(`timed out waiting for ${what}`), { code: "SERVICES_NOT_READY" });
      if (!logged) console.log(`migrate: waiting for ${what}…`);
      logged = true;
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  };
  await until(async () => (await sql`select 1`, true), "the database");
  await until(
    async () => {
      const [row] = await sql`select to_regclass('auth.users') is not null and to_regclass('storage.buckets') is not null as ready`;
      return row.ready;
    },
    "the Auth and Storage services to create their tables",
  );

  // Two deploys starting at once (two replicas, or a restart during a deploy) take turns.
  await sql`select pg_advisory_lock(hashtext('crewtavo:migrate'))`;
  await sql`create schema if not exists supabase_migrations`;
  await sql`create table if not exists supabase_migrations.schema_migrations (version text primary key, statements text[], name text)`;
  const applied = new Set((await sql`select version from supabase_migrations.schema_migrations`).map((r) => r.version));
  firstInstall = applied.size === 0;

  let count = 0;
  for (const file of files) {
    const [version, ...rest] = file.replace(/\.sql$/, "").split("_");
    if (applied.has(version)) continue;
    current = file;
    const body = readFileSync(join(dir, file), "utf8");
    await sql.begin(async (tx) => {
      await tx.unsafe(body);
      await tx`insert into supabase_migrations.schema_migrations (version, name, statements) values (${version}, ${rest.join("_")}, ${[body]})`;
    });
    console.log(`migrate: applied ${file}`);
    count++;
  }
  current = null;
  // PostgREST caches the schema; tell it about the new tables and functions.
  if (count) await sql`notify pgrst, 'reload schema'`;
  console.log(count ? `migrate: ${count} migration(s) applied.` : "migrate: database is up to date.");
  report({ ok: true, firstInstall, applied: count });
} catch (error) {
  const problem = problemOf(error);
  console.error(`migrate: failed${current ? ` in ${current}` : ""}:`, error.message);
  report({ ok: false, firstInstall, problem, detail: problem === "migration_failed" ? `${current ?? "setup"}: ${error.message}` : undefined });
  process.exitCode = 1;
} finally {
  await sql?.end({ timeout: 5 });
}
