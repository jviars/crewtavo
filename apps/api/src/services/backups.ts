/**
 * Built-in database backups (Settings → Your data; packages/core/src/backups.ts; the database's
 * part is supabase/migrations/20261112000200_backups.sql). Railway backs up volumes only on its Pro
 * plan, so every instance keeps its own: each night the "backups" task
 *  1. claims the night's run (claim_backup: one at a time across every server, and once a night);
 *  2. runs pg_dump (custom format, compressed) over the schemas that hold the business: Crewtavo's
 *     own tables, sign-ins (auth) and the records of stored files (storage), with the same database
 *     address scripts/migrate.mjs uses;
 *  3. sends the dump to Storage as it's made, in pieces of PART_BYTES (Storage refuses a file over
 *     its FILE_SIZE_LIMIT, 50 MB on older instances, and the server has little memory: only the
 *     piece being sent is ever held), into the private "backups" bucket, which no signed-in person's
 *     key can read. Storage is reached at its private address with the service key, as a storage
 *     move does, so the company's storage limits (lib/storageLimits.ts, the gateway's) never apply;
 *  4. checks every piece is stored at its size, and only then marks the run "ok". A run that fails
 *     or dies partway stays "failed", its pieces are taken out, and it's never offered as a backup;
 *  5. keeps the last of each of the 7 newest days and of the 4 newest weeks, and deletes the rest;
 *  6. tells the owners (the bell, plus email and push by the "hosting" topic) when the night's
 *     backup failed every try, or when there's been no good one for two days.
 *
 * The dump covers the database. Photos and files are on the storage service's volume or bucket and
 * aren't in it; their records are, so a restore without the files shows them as missing.
 *
 * While a storage move switches storage over (services/storageBucket.ts), nothing is written for
 * those few minutes, as for anyone's uploads; the rest of a move carries on around new and deleted
 * files, a backup's pieces included.
 *
 * Where pg_dump isn't installed (local development) or this isn't Crewtavo's own instance, the task
 * does nothing. scripts/restore.mjs puts a downloaded dump into a new instance (docs/deploy.md).
 */
import { spawn, spawnSync } from "node:child_process";
import { backupNight, backupsToKeep, backupWarning, BACKUP_STALE_HOURS, BACKUP_WARN_AGAIN_HOURS, type BackupEntry, type BackupStatus } from "@crewtavo/core";
import type { Env } from "../env";
import { HttpError } from "../lib/http";
import { apiKey, stackServices } from "../lib/stack";
import type { Db } from "../lib/supabase";
import { storageWritesPaused } from "./storageBucket";

/** Storage's bucket for the dumps: private, with no policies (the migration makes it). */
export const BACKUPS_BUCKET = "backups";
/** A dump is stored in pieces this big, well under any instance's FILE_SIZE_LIMIT. */
export const PART_BYTES = 16 * 1024 * 1024;
/**
 * What's dumped: Crewtavo's own schemas (public, private, hooks), the migrations applied
 * (supabase_migrations), sign-ins (auth) and stored files' records (storage). The rest of the
 * database is the image's own setup (extensions, roles' helpers), which a new instance already has.
 */
export const BACKUP_SCHEMAS = ["public", "private", "hooks", "supabase_migrations", "auth", "storage"] as const;
/** The server doing a run says so this often; claim_backup closes a run that's been quiet for 10 minutes. */
const HEARTBEAT_MS = 30_000;
/** A run is given up on after this long. */
const RUN_LIMIT_MS = 3 * 60 * 60_000;
/** How long a piece waits while a storage move switches storage over. */
const PAUSE_WAIT_MS = 10 * 60_000;
/** Failed runs stay on the list this long. */
const FAILED_KEPT_MS = 14 * 24 * 60 * 60_000;
/** The night's backup is tried this many times, an hour apart. */
const TRIES = 3;

const HOUR_MS = 60 * 60_000;

/** pg_dump as it runs: what it writes, how it ended, and a way to stop it. */
export interface Dump {
  chunks: AsyncIterable<Uint8Array>;
  done: Promise<{ code: number | null; stderr: string }>;
  stop: () => void;
}

/** pg_dump itself and waiting, swapped out by the tests. */
export const backupTools = {
  installed: pgDumpInstalled,
  dump: startDump,
  wait: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms).unref?.()),
};

let installed: boolean | null = null;
function pgDumpInstalled(): boolean {
  installed ??= spawnSync("pg_dump", ["--version"], { stdio: "ignore", timeout: 10_000 }).status === 0;
  return installed;
}

/** The database's address as pg_dump takes it from its environment, so the password is never on a command line. */
export function dumpEnvironment(dbUrl: string): Record<string, string> {
  const url = new URL(dbUrl);
  // No TLS on Railway's private network or a compose network; anything else requires it (as scripts/migrate.mjs).
  const host = url.hostname;
  const local = !host.includes(".") || host === "127.0.0.1" || host.endsWith(".railway.internal") || /sslmode=disable/.test(dbUrl);
  return {
    PGHOST: host,
    PGPORT: url.port || "5432",
    PGUSER: decodeURIComponent(url.username) || "postgres",
    PGPASSWORD: decodeURIComponent(url.password),
    PGDATABASE: decodeURIComponent(url.pathname.replace(/^\//, "")) || "postgres",
    PGSSLMODE: local ? "disable" : "require",
    PGCONNECT_TIMEOUT: "15",
  };
}

/** pg_dump's arguments: one compressed file pg_restore reads, of BACKUP_SCHEMAS, never waiting on a password or forever on a lock. */
export const DUMP_ARGS = ["--format=custom", "--no-password", "--lock-wait-timeout=120000", ...BACKUP_SCHEMAS.map((s) => `--schema=${s}`)];

function startDump(dbUrl: string): Dump {
  const child = spawn("pg_dump", DUMP_ARGS, { env: { PATH: process.env.PATH ?? "", ...dumpEnvironment(dbUrl) }, stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (text: string) => {
    stderr = (stderr + text).slice(-4000);
  });
  const done = new Promise<{ code: number | null; stderr: string }>((resolve) => {
    child.on("error", (error) => resolve({ code: null, stderr: error.message }));
    child.on("close", (code) => resolve({ code, stderr }));
  });
  return { chunks: child.stdout, done, stop: () => void child.kill("SIGKILL") };
}

// ---------------------------------------------------------------------------------------------
// This instance, and Storage at its private address with the service key
// ---------------------------------------------------------------------------------------------

/** Settings an instance has that the app's Env doesn't name (lib/stack.ts, scripts/migrate.mjs). */
type InstanceEnv = Env & { SUPABASE_DB_URL?: string; DATABASE_URL?: string; JWT_SECRET?: string };

interface Instance {
  storageUrl: string;
  serviceKey: string;
  dbUrl: string;
}

const NOT_AN_INSTANCE = "Crewtavo makes backups where it runs its own database (the Railway template or docker compose). This one uses another database, so back it up there.";
const NO_PG_DUMP = "This Crewtavo was started without the database's backup tool (pg_dump), so it can't make backups. Crewtavo's Docker image has it.";

/** What a backup needs from this instance, or why it can't make one. */
function instanceOf(env: Env): Instance | string {
  const vars = env as InstanceEnv;
  const stack = stackServices(vars as unknown as Record<string, string | undefined>);
  const dbUrl = vars.SUPABASE_DB_URL || vars.DATABASE_URL;
  // One business per instance: a dump of a database several businesses share would hand each owner the others' data.
  if (!stack || !vars.JWT_SECRET || !dbUrl || env.CREWTAVO_SINGLE_COMPANY !== "1") return NOT_AN_INSTANCE;
  if (!backupTools.installed()) return NO_PG_DUMP;
  return { storageUrl: stack.storage.replace(/\/$/, ""), serviceKey: env.SUPABASE_SERVICE_ROLE_KEY ?? apiKey(vars.JWT_SECRET, "service_role"), dbUrl };
}

const segment = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const partName = (id: string, part: number) => `${id}/part-${String(part).padStart(4, "0")}`;

/** A reason in the owner's words. */
export class BackupFailed extends Error {}

class BackupStore {
  constructor(private readonly base: string, private readonly key: string) {}

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return { Authorization: `Bearer ${this.key}`, apikey: this.key, ...extra };
  }

  private url(name: string) {
    return `${this.base}/object/${BACKUPS_BUCKET}/${name.split("/").map(segment).join("/")}`;
  }

  /** Stores one piece, trying again when Storage is busy or restarting. Writing over a piece of the same name makes another try safe. */
  async write(name: string, body: Uint8Array): Promise<void> {
    let last = "";
    for (let attempt = 0; attempt < 4; attempt++) {
      if (attempt) await backupTools.wait(attempt * 5_000);
      let res: Response;
      try {
        res = await fetch(this.url(name), {
          method: "POST",
          headers: this.headers({ "Content-Type": "application/octet-stream", "Cache-Control": "no-store", "Content-Length": String(body.byteLength), "x-upsert": "true" }),
          body,
          signal: AbortSignal.timeout(10 * 60_000),
        });
      } catch (error) {
        last = error instanceof Error ? error.message : String(error);
        continue;
      }
      if (res.ok) {
        await res.body?.cancel().catch(() => undefined);
        return;
      }
      const said = await res.text().catch(() => "");
      last = `${res.status}${said ? `: ${said.slice(0, 200)}` : ""}`;
      // Storage's own no (too big, not allowed) won't change by asking again.
      if (res.status < 500 && res.status !== 408 && res.status !== 429) break;
    }
    throw new BackupFailed(`Storage didn't take the backup (${last}). If its volume is full, make room or make the volume bigger, then press Back up now.`);
  }

  /** What's directly under `prefix`: files with their sizes, and folders (no size). */
  async list(prefix: string): Promise<Array<{ name: string; size: number | null; folder: boolean }>> {
    const found: Array<{ name: string; size: number | null; folder: boolean }> = [];
    for (let offset = 0; ; offset += 1000) {
      const res = await fetch(`${this.base}/object/list/${BACKUPS_BUCKET}`, {
        method: "POST",
        headers: this.headers({ "Content-Type": "application/json" }),
        body: JSON.stringify({ prefix, limit: 1000, offset, sortBy: { column: "name", order: "asc" } }),
        signal: AbortSignal.timeout(60_000),
      });
      if (!res.ok) throw new BackupFailed(`Storage didn't list the backups (${res.status}).`);
      const rows = (await res.json()) as Array<{ name: string; id: string | null; metadata: { size?: number } | null }>;
      for (const row of rows) found.push({ name: row.name, size: row.id ? Number(row.metadata?.size ?? Number.NaN) : null, folder: !row.id });
      if (rows.length < 1000) return found;
    }
  }

  read(name: string, signal?: AbortSignal): Promise<Response> {
    return fetch(this.url(name), { headers: this.headers(), signal });
  }

  /** Takes out every piece under a backup's id. */
  async removeAll(id: string): Promise<void> {
    const pieces = (await this.list(id)).filter((p) => !p.folder);
    for (let i = 0; i < pieces.length; i += 100) {
      const res = await fetch(`${this.base}/object/${BACKUPS_BUCKET}`, {
        method: "DELETE",
        headers: this.headers({ "Content-Type": "application/json" }),
        body: JSON.stringify({ prefixes: pieces.slice(i, i + 100).map((p) => `${id}/${p.name}`) }),
        signal: AbortSignal.timeout(60_000),
      });
      if (!res.ok) throw new BackupFailed(`Storage didn't delete an old backup (${res.status}).`);
      await res.body?.cancel().catch(() => undefined);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// One run
// ---------------------------------------------------------------------------------------------

/** What pg_dump said went wrong, as one line without the database's password. */
function dumpProblem(stderr: string, dbUrl: string): string {
  const lines = stderr.split("\n").map((l) => l.trim()).filter(Boolean);
  const line = (lines.filter((l) => /error|fatal/i.test(l)).pop() ?? lines.pop() ?? "it stopped without saying why").replace(/^pg_dump: (error: )?/, "");
  let password = "";
  try {
    password = decodeURIComponent(new URL(dbUrl).password);
  } catch {
    // An address that can't be read has no password to hide.
  }
  return (password ? line.split(password).join("***") : line).replace(/postgres(ql)?:\/\/\S+/gi, "(the database's address)").slice(0, 300);
}

/**
 * Dumps the database into Storage under the run's id and marks the run "ok", or marks it "failed"
 * with why and takes its pieces out. Resolves either way: true when the backup is good.
 */
async function runBackup(admin: Db, instance: Instance, id: string): Promise<boolean> {
  const store = new BackupStore(instance.storageUrl, instance.serviceKey);
  const dump = backupTools.dump(instance.dbUrl);
  // Whatever stops the run early (another server closed it as dead, or it ran too long) ends pg_dump too.
  let stopped: string | null = null;
  const stop = (why: string) => {
    stopped ??= why;
    dump.stop();
  };
  const beat = setInterval(() => {
    void admin.from("backups").update({ heartbeat_at: new Date().toISOString() }).match({ id, status: "running" }).select("id").then(({ data, error }) => {
      if (!error && !data?.length) stop("Another Crewtavo server closed this backup while it was still being made.");
    });
  }, HEARTBEAT_MS);
  const limit = setTimeout(() => stop("The backup took more than three hours, so Crewtavo stopped it."), RUN_LIMIT_MS);
  try {
    const piece = Buffer.allocUnsafe(PART_BYTES);
    let filled = 0;
    let parts = 0;
    let bytes = 0;
    const send = async () => {
      // A storage move is switching storage over: nothing is written until it has, as for uploads.
      for (let waited = 0; storageWritesPaused(); waited += 5_000) {
        if (waited >= PAUSE_WAIT_MS) throw new BackupFailed("Files were moving to new storage for too long. Crewtavo tries again within the hour.");
        await backupTools.wait(5_000);
      }
      if (parts === 0 && piece.subarray(0, 5).toString("latin1") !== "PGDMP") throw new BackupFailed("pg_dump didn't write a backup file.");
      parts++;
      await store.write(partName(id, parts), piece.subarray(0, filled));
      bytes += filled;
      filled = 0;
    };
    for await (const chunk of dump.chunks) {
      for (let at = 0; at < chunk.byteLength; ) {
        const take = Math.min(chunk.byteLength - at, PART_BYTES - filled);
        piece.set(chunk.subarray(at, at + take), filled);
        filled += take;
        at += take;
        // The dump waits while a piece is sent: pg_dump writes no faster than Storage takes it.
        if (filled === PART_BYTES) await send();
      }
    }
    const { code, stderr } = await dump.done;
    if (stopped) throw new BackupFailed(stopped);
    if (code !== 0) throw new BackupFailed(`The database couldn't be read for the backup (pg_dump said: ${dumpProblem(stderr, instance.dbUrl)}).`);
    if (filled) await send();
    if (!bytes) throw new BackupFailed("pg_dump didn't write a backup file.");
    // Every piece is where it should be, at its size, before the run counts.
    const stored = (await store.list(id)).filter((p) => !p.folder);
    const size = stored.reduce((sum, p) => sum + (p.size ?? Number.NaN), 0);
    if (stored.length !== parts || size !== bytes) throw new BackupFailed(`Storage has ${stored.length} of the backup's ${parts} pieces (${Number.isFinite(size) ? size : "an unknown number"} of ${bytes} bytes).`);
    const { data, error } = await admin.from("backups").update({ status: "ok", finished_at: new Date().toISOString(), bytes, parts }).match({ id, status: "running" }).select("id");
    if (error) throw new BackupFailed(`The backup was made but couldn't be recorded (${error.message}).`);
    if (!data?.length) throw new BackupFailed("Another Crewtavo server closed this backup while it was still being made.");
    return true;
  } catch (error) {
    dump.stop();
    const why = error instanceof BackupFailed ? error.message : `Something went wrong while making the backup (${error instanceof Error ? error.message : String(error)}).`;
    if (!(error instanceof BackupFailed)) console.error("Backup failed", error);
    // Only a run still open is closed here; one another server closed keeps that server's reason.
    await admin.from("backups").update({ status: "failed", finished_at: new Date().toISOString(), error: why.slice(0, 500) }).match({ id, status: "running" });
    // Its pieces go now; if Storage can't be reached, the next tidy-up takes them (no "ok" row names them).
    await store.removeAll(id).catch(() => undefined);
    return false;
  } finally {
    clearInterval(beat);
    clearTimeout(limit);
  }
}

// ---------------------------------------------------------------------------------------------
// Keeping 7 daily and 4 weekly
// ---------------------------------------------------------------------------------------------

/**
 * Deletes the backups that aren't kept any more (backupsToKeep) and the failed runs' rows after two
 * weeks, then takes out any pieces in Storage that no good or running backup owns (a run that died,
 * or a delete that didn't finish). A row goes before its pieces, so a backup on the list always has
 * all of them. Safe to run twice.
 */
export async function tidyBackups(admin: Db, store: Pick<BackupStore, "list" | "removeAll">, timeZone: string, now = new Date()): Promise<number> {
  const { data: good, error } = await admin.from("backups").select("id, started_at").eq("status", "ok").order("started_at", { ascending: false }).limit(1000);
  if (error) throw new Error(error.message);
  const keep = backupsToKeep((good ?? []).map((b) => ({ id: b.id, startedAt: b.started_at })), timeZone);
  const expired = (good ?? []).filter((b) => !keep.has(b.id)).map((b) => b.id);
  if (expired.length) {
    const { error: dropError } = await admin.from("backups").delete().in("id", expired).eq("status", "ok");
    if (dropError) throw new Error(dropError.message);
  }
  const { error: oldError } = await admin.from("backups").delete().eq("status", "failed").lt("started_at", new Date(now.getTime() - FAILED_KEPT_MS).toISOString());
  if (oldError) throw new Error(oldError.message);
  // Folders are listed before the rows are read, so a run that began in between has its row by then.
  const folders = (await store.list("")).filter((f) => f.folder).map((f) => f.name);
  const { data: live, error: liveError } = await admin.from("backups").select("id").in("status", ["ok", "running"]).limit(1000);
  if (liveError) throw new Error(liveError.message);
  const owned = new Set((live ?? []).map((b) => b.id));
  for (const folder of folders) {
    if (!owned.has(folder)) await store.removeAll(folder);
  }
  return expired.length;
}

// ---------------------------------------------------------------------------------------------
// The "backups" task
// ---------------------------------------------------------------------------------------------

/** The instance's business: its time zone decides when the night is, and its owners hear what goes wrong. */
async function theCompany(admin: Db): Promise<{ id: string; timezone: string } | null> {
  const { data, error } = await admin.from("companies").select("id, timezone").order("created_at").limit(1);
  if (error) throw new Error(error.message);
  const company = data?.[0];
  return company ? { id: company.id, timezone: company.timezone || "UTC" } : null;
}

/**
 * The "backups" task, every hour: makes the night's backup once it's past 2 in the morning where
 * the business is (and tries twice more, an hour apart, if it fails), tidies old ones away, and
 * tells the owners when backups have stopped. Does nothing where backups can't be made.
 */
export async function runBackups(env: Env, admin: Db, now = new Date()): Promise<Record<string, unknown>> {
  const instance = instanceOf(env);
  if (typeof instance === "string") return { skipped: instance === NO_PG_DUMP ? "pg_dump isn't installed" : "not an instance" };
  const company = await theCompany(admin);
  // Nothing to keep until the owner has set the business up.
  if (!company) return { skipped: "no business yet" };
  if (storageWritesPaused()) return { skipped: "files are moving" };
  const { data: id, error } = await admin.rpc("claim_backup", { p_kind: "nightly", p_since: backupNight(now, company.timezone).toISOString(), p_tries: TRIES });
  if (error) throw new Error(error.message);
  let made = 0;
  let failed = 0;
  let removed = 0;
  if (id) {
    if (await runBackup(admin, instance, id)) made++;
    else failed++;
    // Old ones go only after a new one is in, and by the server that made it.
    if (made) removed = await tidyBackups(admin, new BackupStore(instance.storageUrl, instance.serviceKey), company.timezone, now);
  }
  const warned = await warnOwners(admin, company, now);
  return { made, failed, removed, warned };
}

/**
 * "Back up now": starts a run and returns its id; `finished` resolves when it's done. Refused while
 * another is running.
 */
export async function startBackup(env: Env, admin: Db): Promise<{ id: string; finished: Promise<unknown> }> {
  const instance = instanceOf(env);
  if (typeof instance === "string") throw new HttpError(409, instance);
  if (storageWritesPaused()) throw new HttpError(409, "Files are moving to new storage. Try again in a few minutes.");
  const { data: id, error } = await admin.rpc("claim_backup", { p_kind: "manual" });
  if (error) throw new Error(error.message);
  if (!id) throw new HttpError(409, "A backup is being made right now. It shows here when it's done.");
  const finished = (async () => {
    if (!(await runBackup(admin, instance, id))) return;
    const company = await theCompany(admin);
    await tidyBackups(admin, new BackupStore(instance.storageUrl, instance.serviceKey), company?.timezone ?? "UTC");
  })();
  return { id, finished };
}

// ---------------------------------------------------------------------------------------------
// What the owner sees, and hears
// ---------------------------------------------------------------------------------------------

type Row = { id: string; kind: string; status: string; started_at: string; finished_at: string | null; bytes: number | null; error: string | null; warned_at: string | null };
const FIELDS = "id, kind, status, started_at, finished_at, bytes, error, warned_at";

async function rows(admin: Db, limit: number): Promise<Row[]> {
  const { data, error } = await admin.from("backups").select(FIELDS).order("started_at", { ascending: false }).limit(limit);
  if (error) throw new Error(error.message);
  return (data ?? []) as Row[];
}

const entry = (r: Row): BackupEntry => ({
  id: r.id,
  kind: r.kind === "manual" ? "manual" : "nightly",
  status: r.status === "ok" ? "ok" : r.status === "running" ? "running" : "failed",
  startedAt: r.started_at,
  finishedAt: r.finished_at,
  bytes: r.status === "ok" && r.bytes !== null ? Number(r.bytes) : null,
  error: r.status === "failed" ? r.error ?? "It didn't finish." : null,
});

/** The backups there are, newest first: the good ones kept, the one being made, and the last two weeks' failures. */
export async function listBackups(admin: Db): Promise<BackupEntry[]> {
  return (await rows(admin, 100)).map(entry);
}

function summarize(list: Row[], now: Date): Omit<BackupStatus, "available" | "unavailable"> & { since: string | null } {
  const finished = list.filter((r) => r.status !== "running");
  const good = finished.find((r) => r.status === "ok");
  const last = finished[0];
  const lastRun = last ? { at: last.finished_at ?? last.started_at, ok: last.status === "ok", error: last.status === "ok" ? null : last.error ?? "It didn't finish." } : null;
  const since = list.length ? list[list.length - 1]!.started_at : null;
  const lastGoodAt = good?.started_at ?? null;
  return { running: list.some((r) => r.status === "running"), lastGoodAt, lastRun, since, warning: backupWarning({ lastGoodAt, lastRun, since }, now) };
}

/** GET /api/backups: whether backups are made here, when the last good one was, and how the last run went. */
export async function backupStatus(env: Env, admin: Db, now = new Date()): Promise<BackupStatus> {
  const instance = instanceOf(env);
  if (typeof instance === "string") return { available: false, unavailable: instance, running: false, lastGoodAt: null, lastRun: null, warning: null };
  const { since: _since, ...status } = summarize(await rows(admin, 100), now);
  return { available: true, unavailable: null, ...status };
}

const dayOf = (iso: string, timeZone: string) => new Date(iso).toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone });

/**
 * Tells the owners, once, when the night's backup has failed every try, and when there's been no
 * good backup for BACKUP_STALE_HOURS (again after a week, while it lasts). What was told is marked
 * on the run it was about (warned_at), claimed in one update so two servers don't both tell.
 */
async function warnOwners(admin: Db, company: { id: string; timezone: string }, now: Date): Promise<number> {
  const list = await rows(admin, 100);
  const { lastGoodAt, lastRun, since } = summarize(list, now);
  const latest = list.find((r) => r.status !== "running");
  if (!latest || !lastRun || (lastRun.ok && backupWarning({ lastGoodAt, lastRun, since }, now) === null)) return 0;
  const night = backupNight(now, company.timezone).getTime();
  const tonight = list.filter((r) => r.kind === "nightly" && r.status === "failed" && Date.parse(r.started_at) >= night);
  const stale = Boolean(lastGoodAt ?? since) && now.getTime() - Date.parse((lastGoodAt ?? since)!) > BACKUP_STALE_HOURS * HOUR_MS;
  let warning: { title: string; body: string } | null = null;
  if (tonight.length >= TRIES && !tonight.some((r) => r.warned_at)) {
    warning = {
      title: "Last night's database backup didn't work",
      body: `${latest.error ?? "It didn't finish."} Crewtavo tries again tomorrow night. ${lastGoodAt ? `Your last good backup is from ${dayOf(lastGoodAt, company.timezone)}.` : "There's no good backup yet."} Settings → Your data has Back up now.`,
    };
  } else if (stale && !list.some((r) => r.warned_at && now.getTime() - Date.parse(r.warned_at) < BACKUP_WARN_AGAIN_HOURS * HOUR_MS)) {
    warning = {
      title: "Crewtavo hasn't backed up its database for over two days",
      body: `${lastGoodAt ? `The last good backup is from ${dayOf(lastGoodAt, company.timezone)}.` : "No backup has worked yet."} Open Settings → Your data to see why, and press Back up now.`,
    };
  }
  if (!warning) return 0;
  const { data: mine, error } = await admin.from("backups").update({ warned_at: now.toISOString() }).eq("id", latest.id).is("warned_at", null).select("id");
  if (error) throw new Error(error.message);
  if (!mine?.length) return 0;
  // Owners only: Settings → Your data is theirs alone.
  const { data: owners, error: ownersError } = await admin.from("memberships").select("user_id").eq("company_id", company.id).eq("active", true).eq("role", "owner");
  if (ownersError) throw new Error(ownersError.message);
  if (!owners?.length) return 0;
  const { error: sendError } = await admin.from("notifications").insert(owners.map((o) => ({ company_id: company.id, user_id: o.user_id, kind: "hosting", title: warning.title, body: warning.body, link: "/settings?tab=data" })));
  if (sendError) throw new Error(sendError.message);
  return 1;
}

// ---------------------------------------------------------------------------------------------
// Download
// ---------------------------------------------------------------------------------------------

/**
 * A good backup as one file, streamed from Storage a piece at a time (never held in memory). Checked
 * first: every piece is there, at the size recorded when it was made.
 */
export async function openBackup(env: Env, admin: Db, id: string): Promise<{ name: string; bytes: number; body: ReadableStream<Uint8Array> }> {
  const instance = instanceOf(env);
  if (typeof instance === "string") throw new HttpError(409, instance);
  const { data: row, error } = await admin.from("backups").select("id, status, started_at, bytes, parts").eq("id", id).maybeSingle();
  if (error) throw new Error(error.message);
  if (!row || row.status !== "ok" || !row.parts || !row.bytes) throw new HttpError(404, "That backup isn't there any more. Refresh the list.");
  const store = new BackupStore(instance.storageUrl, instance.serviceKey);
  const pieces = (await store.list(id)).filter((p) => !p.folder).sort((a, b) => a.name.localeCompare(b.name));
  const size = pieces.reduce((sum, p) => sum + (p.size ?? Number.NaN), 0);
  if (pieces.length !== row.parts || size !== Number(row.bytes)) {
    throw new HttpError(409, "This backup's file isn't all in storage any more, so it can't be downloaded. Press Back up now to make a new one.");
  }
  let next = 0;
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  const gone = new AbortController();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      for (;;) {
        if (!reader) {
          if (next >= pieces.length) return controller.close();
          const res = await store.read(`${id}/${pieces[next++]!.name}`, gone.signal);
          if (!res.ok || !res.body) throw new Error(`Storage didn't give a piece of the backup (${res.status}).`);
          reader = res.body.getReader();
        }
        const { done, value } = await reader.read();
        if (done) {
          reader = null;
          continue;
        }
        return controller.enqueue(value);
      }
    },
    // The owner's browser went away: stop reading from Storage.
    cancel() {
      gone.abort();
    },
  });
  const stamp = new Date(row.started_at).toISOString().slice(0, 16).replace(/[-:]/g, "").replace("T", "-");
  return { name: `crewtavo-backup-${stamp}.dump`, bytes: Number(row.bytes), body };
}
