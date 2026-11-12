#!/usr/bin/env node
/**
 * Puts a database backup (Settings → Your data → Database backups) into a Crewtavo instance,
 * replacing what's in its database. Made for a NEW instance: one that already has a business set up
 * is refused unless you add --replace. docs/deploy.md ("Restoring a backup") has the steps for
 * Railway and for Docker.
 *
 *   node scripts/restore.mjs <backup.dump> [--db <database address>] [--replace]
 *
 * The database address is SUPABASE_DB_URL (or DATABASE_URL) unless --db gives one; inside an
 * instance's crewtavo container it's already set. It needs pg_restore and psql (Postgres 17), which
 * Crewtavo's Docker image has.
 *
 * What it does, in one transaction, so a restore that fails leaves the database exactly as it was:
 *  1. drops the schemas a backup holds (Crewtavo's own, sign-ins and stored files' records), which
 *     a new instance has already made empty copies of;
 *  2. loads the backup: tables, data, and the list of migrations applied, so the server applies only
 *     newer ones when it next starts;
 *  3. empties the list of backups: the dumps it names are in the old instance's storage, not here.
 * It signs in as supabase_admin, the database image's own administrator, with the password from the
 * address (every role shares POSTGRES_PASSWORD): only it can replace the sign-in and storage tables.
 * The password in the backup's instance doesn't matter; roles and their passwords aren't in a backup.
 *
 * Afterwards restart crewtavo, auth, rest and storage. Photos and files aren't in a backup: they come
 * back only if the files volume or bucket was restored too. And the new instance needs the old one's
 * JWT_SECRET (and ENCRYPTION_KEY, if it had one) to read connected apps and honour links already sent.
 */
import { spawn, spawnSync } from "node:child_process";
import { closeSync, openSync, readSync, statSync } from "node:fs";

/** The schemas a backup holds (apps/api/src/services/backups.ts, BACKUP_SCHEMAS). */
const SCHEMAS = ["public", "private", "hooks", "supabase_migrations", "auth", "storage"];

const stop = (message) => {
  console.error(`restore: ${message}`);
  process.exit(1);
};

const args = process.argv.slice(2);
const replace = args.includes("--replace");
const dbAt = args.indexOf("--db");
const given = dbAt >= 0 ? args[dbAt + 1] : undefined;
// The file is the argument that isn't an option, or --db's address.
const file = args.find((a, i) => !a.startsWith("--") && !(dbAt >= 0 && i === dbAt + 1));
if (!file) stop("name the backup file: node scripts/restore.mjs <backup.dump> [--db <database address>] [--replace]");

// The file is a pg_dump custom-format archive: those start with "PGDMP".
let size = 0;
try {
  size = statSync(file).size;
  const fd = openSync(file, "r");
  const head = Buffer.alloc(5);
  readSync(fd, head, 0, 5, 0);
  closeSync(fd);
  if (head.toString("latin1") !== "PGDMP") stop(`${file} isn't a Crewtavo database backup (a .dump file from Settings → Your data).`);
} catch (error) {
  stop(`can't read ${file}: ${error.message}`);
}

const address = given || process.env.SUPABASE_DB_URL || process.env.DATABASE_URL;
if (!address) stop("no database address. Run it inside the instance's crewtavo container, or add --db postgres://postgres:PASSWORD@HOST:PORT/postgres");
let url;
try {
  url = new URL(address);
} catch {
  stop("the database address isn't one (it looks like postgres://postgres:PASSWORD@HOST:PORT/postgres).");
}

for (const tool of ["pg_restore", "psql"]) {
  if (spawnSync(tool, ["--version"], { stdio: "ignore" }).status !== 0) stop(`${tool} isn't installed here. Run this with Crewtavo's Docker image, which has it (docs/deploy.md, Restoring a backup).`);
}

// No TLS on a private network (localhost, a compose service name, Railway's *.railway.internal) or
// when the address says sslmode=disable; anything else requires it, as scripts/migrate.mjs does.
const host = url.hostname;
const local = !host.includes(".") || host === "127.0.0.1" || host.endsWith(".railway.internal");
const connection = (user) => ({
  PATH: process.env.PATH ?? "",
  PGHOST: host,
  PGPORT: url.port || "5432",
  PGUSER: user,
  PGPASSWORD: decodeURIComponent(url.password),
  PGDATABASE: decodeURIComponent(url.pathname.replace(/^\//, "")) || "postgres",
  PGSSLMODE: url.searchParams.get("sslmode") || (local ? "disable" : "require"),
  PGCONNECT_TIMEOUT: "15",
});

/** One value from the database, or null with what went wrong. */
function ask(env, sql) {
  const out = spawnSync("psql", ["--no-password", "-X", "-At", "-v", "ON_ERROR_STOP=1", "-c", sql], { env, encoding: "utf8" });
  return out.status === 0 ? { value: out.stdout.trim(), error: null } : { value: null, error: (out.stderr || "").trim().split("\n").pop() ?? "no answer" };
}

// The image's administrator, or whoever the address names if that's a superuser too.
let admin = connection("supabase_admin");
let who = ask(admin, "select rolsuper from pg_roles where rolname = current_user");
if (who.value !== "t") {
  const named = connection(decodeURIComponent(url.username) || "postgres");
  const other = ask(named, "select rolsuper from pg_roles where rolname = current_user");
  if (other.value === null) stop(`couldn't sign in to the database: ${who.error ?? other.error}. Check the address and its password.`);
  if (other.value !== "t") stop("the database didn't let supabase_admin in, and the role in the address can't replace the sign-in tables. Use the instance's own POSTGRES_PASSWORD in the address.");
  admin = named;
  who = other;
}

// What the backup holds.
const listing = spawnSync("pg_restore", ["--list", file], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
if (listing.status !== 0) stop(`pg_restore can't read ${file}: ${(listing.stderr || "").trim().split("\n").pop()}`);
const inBackup = SCHEMAS.filter((schema) => new RegExp(`^\\d+; \\d+ \\d+ SCHEMA - ${schema} `, "m").test(listing.stdout));
for (const needed of ["public", "auth", "storage", "supabase_migrations"]) {
  if (!inBackup.includes(needed)) stop(`${file} doesn't hold the "${needed}" schema, so it isn't a whole Crewtavo backup.`);
}

// A new instance has no business yet. One that has is only replaced when asked to.
const companies = ask(admin, "select case when to_regclass('public.companies') is null then '' else (select coalesce(string_agg(name, ', '), '') from public.companies) end");
if (companies.value === null) stop(`couldn't read the database: ${companies.error}`);
if (companies.value && !replace) {
  stop(`this Crewtavo already has a business set up (${companies.value}). Restoring replaces everything in its database with the backup. If that's what you want, run it again with --replace at the end.`);
}

console.log(`restore: putting ${file} (${(size / 1e6).toFixed(1)} MB) into the database at ${host}${companies.value ? `, replacing ${companies.value}` : ""}…`);

const quoted = (name) => `"${name.replace(/"/g, '""')}"`;
const list = inBackup.map((s) => `'${s}'`).join(", ");
// Which tables the image's publication carried, to put the restored ones back in it (a backup of
// schemas doesn't say). A lock nobody gives up within a minute stops the restore rather than hanging.
const before = `
set lock_timeout = '60s';
set client_min_messages = warning;
create temp table restore_published on commit drop as
  select schemaname, tablename from pg_publication_tables where pubname = 'supabase_realtime' and schemaname in (${list});
${inBackup.map((s) => `drop schema if exists ${quoted(s)} cascade;`).join("\n")}
`;
const after = `
do $$
declare t record;
begin
  for t in select p.schemaname, p.tablename from restore_published p
            where to_regclass(format('%I.%I', p.schemaname, p.tablename)) is not null
              and not exists (select 1 from pg_publication_tables x where x.pubname = 'supabase_realtime' and x.schemaname = p.schemaname and x.tablename = p.tablename)
  loop
    execute format('alter publication supabase_realtime add table %I.%I', t.schemaname, t.tablename);
  end loop;
  -- The backups this list names are in the old instance's storage; this one starts its own list.
  if to_regclass('public.backups') is not null then
    delete from public.backups;
  end if;
end $$;
notify pgrst, 'reload schema';
`;

// pg_restore turns the backup into SQL and psql runs it, all in one transaction: an error anywhere
// undoes everything, the drops included.
const psql = spawn("psql", ["--no-password", "-X", "--quiet", "--single-transaction", "-v", "ON_ERROR_STOP=1", "-f", "-"], { env: admin, stdio: ["pipe", "ignore", "pipe"] });
let problems = "";
psql.stderr.setEncoding("utf8").on("data", (text) => {
  problems = (problems + text).slice(-4000);
});
const restore = spawn("pg_restore", ["--no-password", "-f", "-", file], { stdio: ["ignore", "pipe", "pipe"] });
let restoreProblems = "";
restore.stderr.setEncoding("utf8").on("data", (text) => {
  restoreProblems = (restoreProblems + text).slice(-4000);
});
psql.stdin.on("error", () => undefined); // psql stopped early; its exit code says why
psql.stdin.write(before);
restore.stdout.pipe(psql.stdin, { end: false });
const restored = new Promise((resolve) => restore.on("close", resolve));
const loaded = new Promise((resolve) => psql.on("close", resolve));
const restoreCode = await restored;
// A backup that couldn't be read all the way must not be committed: the broken statement stops psql.
psql.stdin.end(restoreCode === 0 ? after : "\nselect restore_failed_reading_the_backup();\n");
const code = await loaded;
if (restoreCode !== 0) stop(`pg_restore couldn't read the whole backup, so nothing was changed: ${restoreProblems.trim().split("\n").pop()}`);
if (code !== 0) stop(`the database refused part of the backup, so nothing was changed:\n${problems.trim().split("\n").slice(-6).join("\n")}`);

const counts = ask(admin, "select (select count(*) from public.companies) || ' business, ' || (select count(*) from auth.users) || ' sign-ins, ' || (select count(*) from public.clients) || ' clients'");
console.log(`restore: done. The database now holds ${counts.value ?? "the backup"}.`);
console.log("restore: now restart the crewtavo, auth, rest and storage services (npm run instance with Docker; Restart on each in Railway).");
console.log("restore: the instance needs the old one's JWT_SECRET (and ENCRYPTION_KEY, if it had one) for connected apps and links already sent to clients.");
