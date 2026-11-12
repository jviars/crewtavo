/**
 * Database backups (services/backups.ts, routes/backups.ts, packages/core/src/backups.ts): which
 * dumps are kept, the nightly task (skipping without pg_dump, storing the dump in pieces, never
 * listing a run that failed as good, tidying up, telling the owners), and the owner's routes behind
 * their password. pg_dump is stood in for (backupTools), Storage and Auth are stubbed through fetch,
 * and the database is a small stand-in. (What claim_backup does is tested in supabase/tests.)
 */
import { backupNight, backupsToKeep, backupWarning } from "@crewtavo/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { app } from "../src/app";
import type { Env } from "../src/env";
import type { Db } from "../src/lib/supabase";
import { backupStatus, backupTools, DUMP_ARGS, dumpEnvironment, listBackups, openBackup, PART_BYTES, runBackups, tidyBackups, type Dump } from "../src/services/backups";

const current = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("../src/lib/supabase", async (original) => ({
  ...(await original<typeof import("../src/lib/supabase")>()),
  adminClient: () => current.db,
  userClient: () => current.db,
}));

const DB_PASSWORD = "s3cret-db-password";
const DB_URL = `postgres://postgres:${DB_PASSWORD}@db:5432/postgres`;
const env = {
  SUPABASE_URL: "http://127.0.0.1:8080",
  SUPABASE_ANON_KEY: "anon",
  SUPABASE_SERVICE_ROLE_KEY: "service",
  ENCRYPTION_KEY: btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => i * 7))),
  CREWTAVO_SINGLE_COMPANY: "1",
  JWT_SECRET: "x".repeat(64),
  SUPABASE_DB_URL: DB_URL,
} as unknown as Env;

const CO = "0b0a0000-0000-4000-8000-000000000001";
const OWNER = "00000000-0000-4000-8000-0000000000aa";
const ADMIN = "00000000-0000-4000-8000-0000000000bb";
const PASSWORD = "correct horse battery";
const NOW = new Date("2026-11-12T09:25:00Z"); // 3:25 in the morning in Chicago

type Row = Record<string, any>;

/** A stand-in for the database: the few tables and filters the backups use, and claim_backup. */
function fakeDb(tables: Record<string, Row[]>) {
  let n = 0;
  const claims: Row[] = [];
  const from = (table: string) => {
    const rows = (tables[table] ??= []);
    const filters: Array<(r: Row) => boolean> = [];
    let action: "select" | "update" | "delete" | "insert" = "select";
    let patch: Row = {};
    let sort: { column: string; ascending: boolean } | null = null;
    let max = Infinity;
    const run = () => {
      if (action === "insert") return { data: null, error: null };
      let found = rows.filter((r) => filters.every((f) => f(r)));
      if (sort) found = [...found].sort((a, b) => (a[sort!.column] < b[sort!.column] ? -1 : a[sort!.column] > b[sort!.column] ? 1 : 0) * (sort!.ascending ? 1 : -1));
      found = found.slice(0, max);
      if (action === "update") found.forEach((r) => Object.assign(r, patch));
      if (action === "delete") found.forEach((r) => rows.splice(rows.indexOf(r), 1));
      return { data: found.map((r) => ({ ...r })), error: null };
    };
    const q: Row = {
      select: () => q,
      insert: (added: Row | Row[]) => {
        action = "insert";
        rows.push(...[added].flat());
        return q;
      },
      update: (next: Row) => ((action = "update"), (patch = next), q),
      delete: () => ((action = "delete"), q),
      eq: (column: string, value: unknown) => (filters.push((r) => r[column] === value), q),
      match: (want: Row) => (filters.push((r) => Object.entries(want).every(([k, v]) => r[k] === v)), q),
      in: (column: string, values: unknown[]) => (filters.push((r) => values.includes(r[column])), q),
      is: (column: string, value: unknown) => (filters.push((r) => (r[column] ?? null) === value), q),
      lt: (column: string, value: string) => (filters.push((r) => r[column] < value), q),
      order: (column: string, options?: { ascending?: boolean }) => ((sort = { column, ascending: options?.ascending ?? true }), q),
      limit: (count: number) => ((max = count), q),
      maybeSingle: async () => ({ data: run().data?.[0] ?? null, error: null }),
      then: (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) => Promise.resolve(run()).then(resolve, reject),
    };
    return q;
  };
  const db = {
    from,
    auth: { getClaims: async (token: string) => ({ data: { claims: { sub: token === "admin" ? ADMIN : OWNER, session_id: "s1" } }, error: null }) },
    rpc: async (name: string, args: Row) => {
      if (name === "rate_limit_hit") return { data: true, error: null };
      if (name !== "claim_backup") return { data: null, error: { message: `unexpected ${name}` } };
      claims.push(args);
      const backups = (tables.backups ??= []);
      // As the database's function: one at a time, tonight's once, and three tries a night.
      if (backups.some((b) => b.status === "running")) return { data: null, error: null };
      if (args.p_kind === "nightly") {
        if (backups.some((b) => b.status === "ok" && b.started_at >= args.p_since)) return { data: null, error: null };
        if (backups.filter((b) => b.kind === "nightly" && b.status === "failed" && b.started_at >= args.p_since).length >= (args.p_tries ?? 3)) return { data: null, error: null };
      }
      const id = `00000000-0000-4000-9000-${String(++n).padStart(12, "0")}`;
      backups.push({ id, kind: args.p_kind, status: "running", started_at: new Date(NOW.getTime() + n).toISOString(), finished_at: null, bytes: null, parts: null, error: null, warned_at: null });
      return { data: id, error: null };
    },
  };
  return { db: db as unknown as Db, tables, claims };
}

/** Storage's "backups" bucket and Auth's password check, through fetch. */
function fakeServices({ refuse = 0 }: { refuse?: number } = {}) {
  const files = new Map<string, Uint8Array>();
  const writes: Array<{ name: string; bytes: number; key: string | null }> = [];
  const others: string[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const method = (init.method ?? "GET").toUpperCase();
    if (url.host === "auth:9999") {
      if (url.pathname === "/token") {
        const ok = JSON.parse(String(init.body)).password === PASSWORD;
        return ok
          ? Response.json({ access_token: "throwaway", refresh_token: "throwaway", token_type: "bearer", expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: OWNER, aud: "authenticated", email: "pat@greenlawn.example" } })
          : Response.json({ code: "invalid_credentials", error_code: "invalid_credentials", msg: "Invalid login credentials" }, { status: 400 });
      }
      return new Response(null, { status: 204 });
    }
    if (url.host !== "storage:5000") {
      others.push(String(input));
      return Response.json({});
    }
    const name = decodeURIComponent(url.pathname.replace(/^\/object\/(list\/)?backups\/?/, ""));
    if (method === "POST" && url.pathname.startsWith("/object/list/")) {
      const { prefix } = JSON.parse(String(init.body)) as { prefix: string };
      if (!prefix) return Response.json([...new Set([...files.keys()].map((k) => k.split("/")[0]))].map((folder) => ({ name: folder, id: null, metadata: null })));
      return Response.json([...files].filter(([k]) => k.startsWith(`${prefix}/`)).map(([k, v]) => ({ name: k.slice(prefix.length + 1), id: "object", metadata: { size: v.byteLength } })));
    }
    if (method === "POST") {
      if (refuse) return Response.json({ statusCode: "413", error: "Payload too large", message: "The object exceeded the maximum allowed size" }, { status: refuse });
      // Copied: the piece is sent from a buffer that's used again for the next one.
      const body = Uint8Array.from(init.body as Uint8Array);
      files.set(name, body);
      writes.push({ name, bytes: body.byteLength, key: new Headers(init.headers).get("authorization") });
      return Response.json({ Key: `backups/${name}` });
    }
    if (method === "DELETE") {
      for (const key of (JSON.parse(String(init.body)) as { prefixes: string[] }).prefixes) files.delete(key);
      return Response.json([]);
    }
    const file = files.get(name);
    return file ? new Response(file) : Response.json({ statusCode: "404", error: "not_found" }, { status: 400 });
  });
  return { files, writes, others };
}

/** pg_dump, writing `chunks` and ending with `code`. */
function dumpOf(chunks: Uint8Array[], code = 0, stderr = ""): () => Dump {
  return () => ({
    chunks: (async function* () {
      yield* chunks;
    })(),
    done: Promise.resolve({ code, stderr }),
    stop: () => undefined,
  });
}
const archive = (bytes: number) => {
  const data = new Uint8Array(bytes).map((_, i) => i % 251);
  data.set(new TextEncoder().encode("PGDMP"));
  return data;
};

const company = { id: CO, name: "Green Lawn", timezone: "America/Chicago", created_at: "2026-10-01T00:00:00Z" };
const people = () => ({
  companies: [company],
  memberships: [
    { company_id: CO, user_id: OWNER, role: "owner", role_id: null, active: true, subcontractor_id: null },
    { company_id: CO, user_id: ADMIN, role: "admin", role_id: null, active: true, subcontractor_id: null },
  ],
  profiles: [{ user_id: OWNER, email: "pat@greenlawn.example", full_name: "Pat Owner" }],
});
const good = (id: string, startedAt: string, extra: Row = {}): Row => ({ id, kind: "nightly", status: "ok", started_at: startedAt, finished_at: startedAt, bytes: 10, parts: 1, error: null, warned_at: null, ...extra });

const tools = { ...backupTools };
beforeEach(() => {
  backupTools.installed = () => true;
  backupTools.wait = async () => undefined;
});
afterEach(() => {
  Object.assign(backupTools, tools);
  vi.unstubAllGlobals();
});

describe("which backups are kept", () => {
  // One a night for 40 nights, at 2:05 in the morning in Chicago (07:05 or 08:05 UTC).
  const nightly = Array.from({ length: 40 }, (_, i) => ({ id: `n${i}`, startedAt: new Date(Date.UTC(2026, 10, 12 - i, 8, 5)).toISOString() }));

  it("keeps the last 7 days and the last of each of the last 4 weeks", () => {
    const keep = backupsToKeep(nightly, "America/Chicago");
    // Thursday Nov 12 back to Friday Nov 6; the four weeks are this one, last week (Nov 8, a day already
    // kept) and the Sundays that end the two before: Nov 1 and Oct 25.
    expect([...keep].sort()).toEqual(["n0", "n1", "n2", "n3", "n4", "n5", "n6", "n11", "n18"].sort());
  });

  it("keeps only the newest of a day's backups, and never empties the list after days without one", () => {
    const sameDay = [{ id: "morning", startedAt: "2026-11-12T08:05:00Z" }, { id: "afternoon", startedAt: "2026-11-12T21:00:00Z" }];
    expect([...backupsToKeep(sameDay, "America/Chicago")]).toEqual(["afternoon"]);
    // The server was off for two months: the old ones are still the 7 newest days that have one.
    const old = nightly.map((b) => ({ ...b, startedAt: new Date(Date.parse(b.startedAt) - 60 * 86_400_000).toISOString() }));
    expect([...backupsToKeep(old, "America/Chicago")]).toEqual(expect.arrayContaining(["n0", "n1", "n2", "n3", "n4", "n5", "n6"]));
  });

  it("counts a day where the business is, not in UTC", () => {
    // 11pm and 1am Chicago time are two days there, and the same day in UTC.
    const two = [{ id: "late", startedAt: "2026-11-12T05:00:00Z" }, { id: "early", startedAt: "2026-11-12T07:00:00Z" }];
    expect(backupsToKeep(two, "America/Chicago").size).toBe(2);
    expect(backupsToKeep(two, "UTC").size).toBe(1);
  });

  it("starts the night at 2 in the morning where the business is", () => {
    expect(backupNight(new Date("2026-11-12T09:25:00Z"), "America/Chicago").toISOString()).toBe("2026-11-12T08:00:00.000Z");
    // 1:25 in the morning: still last night's.
    expect(backupNight(new Date("2026-11-12T07:25:00Z"), "America/Chicago").toISOString()).toBe("2026-11-11T08:00:00.000Z");
  });

  it("warns when the last run failed, or the last good one is over 48 hours old", () => {
    const at = (hoursAgo: number) => new Date(NOW.getTime() - hoursAgo * 3_600_000).toISOString();
    expect(backupWarning({ lastGoodAt: at(5), lastRun: { ok: true }, since: at(500) }, NOW)).toBeNull();
    expect(backupWarning({ lastGoodAt: at(5), lastRun: { ok: false }, since: at(500) }, NOW)).toBe("failed");
    expect(backupWarning({ lastGoodAt: at(49), lastRun: { ok: true }, since: at(500) }, NOW)).toBe("stale");
    // A new instance isn't behind before it has had its first night.
    expect(backupWarning({ lastGoodAt: null, lastRun: null, since: null }, NOW)).toBeNull();
  });
});

describe("the backups task", () => {
  it("does nothing, quietly, where pg_dump isn't installed", async () => {
    backupTools.installed = () => false;
    const dump = vi.fn();
    backupTools.dump = dump;
    const { db, claims } = fakeDb(people());
    const services = fakeServices();
    expect(await runBackups(env, db, NOW)).toEqual({ skipped: "pg_dump isn't installed" });
    expect(dump).not.toHaveBeenCalled();
    expect(claims).toEqual([]);
    expect(services.writes).toEqual([]);
    expect(await backupStatus(env, db, NOW)).toMatchObject({ available: false, warning: null });
  });

  it("does nothing where Crewtavo doesn't run its own database, or serves more than one business", async () => {
    const { db, claims } = fakeDb(people());
    fakeServices();
    expect(await runBackups({ ...env, JWT_SECRET: undefined } as unknown as Env, db, NOW)).toEqual({ skipped: "not an instance" });
    expect(await runBackups({ ...env, CREWTAVO_SINGLE_COMPANY: "0" } as Env, db, NOW)).toEqual({ skipped: "not an instance" });
    expect(await runBackups(env, fakeDb({}).db, NOW)).toEqual({ skipped: "no business yet" });
    expect(claims).toEqual([]);
  });

  it("asks pg_dump for one compressed file of every schema the business is in, with the password out of sight", () => {
    expect(DUMP_ARGS).toEqual(expect.arrayContaining(["--format=custom", "--no-password", "--schema=public", "--schema=private", "--schema=auth", "--schema=storage", "--schema=supabase_migrations"]));
    expect(DUMP_ARGS.join(" ")).not.toContain(DB_PASSWORD);
    expect(dumpEnvironment(DB_URL)).toMatchObject({ PGHOST: "db", PGPORT: "5432", PGUSER: "postgres", PGPASSWORD: DB_PASSWORD, PGDATABASE: "postgres", PGSSLMODE: "disable" });
    expect(dumpEnvironment("postgres://postgres:p%40ss@db.example.com/crew")).toMatchObject({ PGPASSWORD: "p@ss", PGDATABASE: "crew", PGSSLMODE: "require" });
  });

  it("stores the night's dump in pieces with the service key, and only then lists it as good", async () => {
    const { db, tables, claims } = fakeDb(people());
    const services = fakeServices();
    // pg_dump writes in chunks that don't line up with the pieces: a piece and a half in all.
    const whole = archive(PART_BYTES + PART_BYTES / 2);
    backupTools.dump = dumpOf([whole.subarray(0, 1000), whole.subarray(1000, PART_BYTES + 5), whole.subarray(PART_BYTES + 5)]);
    expect(await runBackups(env, db, NOW)).toEqual({ made: 1, failed: 0, removed: 0, warned: 0 });
    expect(claims).toEqual([{ p_kind: "nightly", p_since: "2026-11-12T08:00:00.000Z", p_tries: 3 }]);
    const [row] = tables.backups!;
    expect(row).toMatchObject({ status: "ok", bytes: whole.byteLength, parts: 2, error: null });
    expect(services.writes).toEqual([
      { name: `${row!.id}/part-0001`, bytes: PART_BYTES, key: "Bearer service" },
      { name: `${row!.id}/part-0002`, bytes: PART_BYTES / 2, key: "Bearer service" },
    ]);
    // Nothing went anywhere but Storage's own address: not through the gateway, where limits apply.
    expect(services.others).toEqual([]);
    // Put back together, the pieces are the dump.
    const file = await openBackup(env, db, row!.id);
    expect(file).toMatchObject({ name: "crewtavo-backup-20261112-0925.dump", bytes: whole.byteLength });
    expect(Buffer.from(await new Response(file.body).arrayBuffer()).equals(Buffer.from(whole))).toBe(true);
    expect(await backupStatus(env, db, NOW)).toMatchObject({ available: true, running: false, lastGoodAt: row!.started_at, lastRun: { ok: true }, warning: null });
    // Tonight's is made: the next hour's run makes no other.
    backupTools.dump = vi.fn();
    expect(await runBackups(env, db, new Date(NOW.getTime() + 3_600_000))).toMatchObject({ made: 0, failed: 0 });
    expect(backupTools.dump).not.toHaveBeenCalled();
  });

  it("lists a run pg_dump failed as failed, says why without the database's password, and leaves no pieces", async () => {
    const { db, tables } = fakeDb(people());
    const services = fakeServices();
    // A full piece went to Storage before pg_dump gave up.
    backupTools.dump = dumpOf([archive(PART_BYTES + 10)], 1, `pg_dump: error: connection to server at "db" failed: FATAL: password authentication failed (${DB_PASSWORD}) postgres://postgres:${DB_PASSWORD}@db:5432/postgres\n`);
    expect(await runBackups(env, db, NOW)).toMatchObject({ made: 0, failed: 1 });
    const [row] = tables.backups!;
    expect(row).toMatchObject({ status: "failed", bytes: null });
    expect(row!.error).toContain("pg_dump said: connection to server");
    expect(row!.error).not.toContain(DB_PASSWORD);
    expect(services.writes.length).toBe(1);
    expect(services.files.size).toBe(0);
    expect(await listBackups(db)).toEqual([expect.objectContaining({ status: "failed", bytes: null, error: row!.error })]);
    expect(await backupStatus(env, db, NOW)).toMatchObject({ lastGoodAt: null, lastRun: { ok: false, error: row!.error }, warning: "failed" });
    await expect(openBackup(env, db, row!.id)).rejects.toThrow("isn't there any more");
  });

  it("fails a run in words when Storage won't take it, or what pg_dump wrote isn't a dump", async () => {
    const { db, tables } = fakeDb(people());
    fakeServices({ refuse: 413 });
    backupTools.dump = dumpOf([archive(2000)]);
    expect(await runBackups(env, db, NOW)).toMatchObject({ made: 0, failed: 1 });
    expect(tables.backups![0]).toMatchObject({ status: "failed" });
    expect(tables.backups![0]!.error).toContain("Storage didn't take the backup (413");

    const second = fakeDb(people());
    const services = fakeServices();
    backupTools.dump = dumpOf([new TextEncoder().encode("not a dump at all")]);
    expect(await runBackups(env, second.db, NOW)).toMatchObject({ made: 0, failed: 1 });
    expect(second.tables.backups![0]!.error).toBe("pg_dump didn't write a backup file.");
    expect(services.writes).toEqual([]);
  });

  it("tries a failed night twice more, then tells the owners once", async () => {
    const { db, tables } = fakeDb({ ...people(), backups: [good("old", "2026-11-11T08:05:00.000Z")] });
    fakeServices();
    backupTools.dump = () => dumpOf([archive(100)], 1, "pg_dump: error: out of memory\n")();
    const hour = (n: number) => new Date(NOW.getTime() + n * 3_600_000);
    expect(await runBackups(env, db, hour(0))).toMatchObject({ failed: 1, warned: 0 });
    expect(await runBackups(env, db, hour(1))).toMatchObject({ failed: 1, warned: 0 });
    expect(await runBackups(env, db, hour(2))).toMatchObject({ failed: 1, warned: 1 });
    // No fourth try tonight, and nobody is told twice.
    expect(await runBackups(env, db, hour(3))).toEqual({ made: 0, failed: 0, removed: 0, warned: 0 });
    expect(tables.backups!.filter((b) => b.status === "failed").length).toBe(3);
    // The owner, not the admin: Settings → Your data is the owner's alone.
    expect(tables.notifications).toEqual([
      expect.objectContaining({ company_id: CO, user_id: OWNER, kind: "hosting", title: "Last night's database backup didn't work", link: "/settings?tab=data" }),
    ]);
    expect(tables.notifications![0]!.body).toContain("out of memory");
    expect(tables.notifications![0]!.body).toContain("Your last good backup is from November 11.");
  });

  it("tells the owners when there's been no good backup for over two days, and not again for a week", async () => {
    const { db, tables } = fakeDb({
      ...people(),
      backups: [good("old", "2026-11-09T08:05:00.000Z"), { ...good("bad", "2026-11-12T08:10:00.000Z"), status: "failed", error: "Storage didn't take the backup (500).", kind: "manual" }],
    });
    fakeServices();
    // Storage is still refusing tonight.
    backupTools.dump = () => dumpOf([archive(100)], 1, "pg_dump: error: could not connect\n")();
    expect(await runBackups(env, db, NOW)).toMatchObject({ failed: 1, warned: 1 });
    expect(tables.notifications![0]).toMatchObject({ user_id: OWNER, title: "Crewtavo hasn't backed up its database for over two days" });
    expect(tables.notifications![0]!.body).toContain("The last good backup is from November 9.");
    expect(await runBackups(env, db, new Date(NOW.getTime() + 3_600_000))).toMatchObject({ warned: 0 });
    expect(tables.notifications!.length).toBe(1);
  });

  it("deletes the backups that aren't kept any more, and pieces no good backup owns", async () => {
    const rows = Array.from({ length: 12 }, (_, i) => good(`g${String(i).padStart(2, "0")}`, new Date(Date.UTC(2026, 10, 11 - i, 8, 5)).toISOString()));
    const { db, tables } = fakeDb({ ...people(), backups: [...rows, { ...good("died", "2026-11-10T09:00:00.000Z"), status: "failed" }, { ...good("ancient", "2026-10-01T09:00:00.000Z"), status: "failed" }] });
    const services = fakeServices();
    for (const row of rows) services.files.set(`${row.id}/part-0001`, new Uint8Array(10));
    // A run that died left a piece behind, and so did a backup whose row is long gone.
    services.files.set("died/part-0001", new Uint8Array(5));
    services.files.set("gone/part-0001", new Uint8Array(5));
    backupTools.dump = dumpOf([archive(300)]);
    const result = await runBackups(env, db, NOW);
    expect(result).toMatchObject({ made: 1 });
    const kept = tables.backups!.filter((b) => b.status === "ok").map((b) => b.id);
    // Tonight's and the six days before it; of the four weeks, only Nov 1 (a Sunday) isn't one of those days.
    const tonight = kept.find((id) => id.startsWith("0000"))!;
    expect(kept.sort()).toEqual([tonight, "g00", "g01", "g02", "g03", "g04", "g05", "g10"].sort());
    expect(result.removed).toBe(5);
    // Each kept backup still has its piece; nothing else is left in the bucket.
    expect([...services.files.keys()].sort()).toEqual(kept.map((id) => `${id}/part-0001`).sort());
    // A failed run stays on the list for two weeks.
    expect(tables.backups!.filter((b) => b.status === "failed").map((b) => b.id)).toEqual(["died"]);
  });

  it("never takes the pieces of a backup that's still being made", async () => {
    const { db } = fakeDb({ ...people(), backups: [{ ...good("making", NOW.toISOString()), status: "running" }, good("done", "2026-11-11T08:05:00.000Z")] });
    const removed: string[] = [];
    const store = {
      list: async () => [{ name: "making", size: null, folder: true }, { name: "done", size: null, folder: true }, { name: "stray", size: null, folder: true }],
      removeAll: async (id: string) => void removed.push(id),
    };
    expect(await tidyBackups(db, store, "America/Chicago", NOW)).toBe(0);
    expect(removed).toEqual(["stray"]);
  });
});

describe("the owner's routes", () => {
  const headers = (token = "owner") => ({ Authorization: `Bearer ${token}`, "X-Company-Id": CO, "Content-Type": "application/json" });
  const post = (path: string, body: unknown, token?: string) => app.request(path, { method: "POST", headers: headers(token), body: JSON.stringify(body) }, env);
  const errorOf = async (res: Response) => ((await res.json()) as { error: string }).error;
  let db: ReturnType<typeof fakeDb>;
  let services: ReturnType<typeof fakeServices>;
  beforeEach(() => {
    db = fakeDb({ ...people(), backups: [good("00000000-0000-4000-9000-00000000000a", "2026-11-12T08:05:00.000Z", { bytes: 8, parts: 2 }), { ...good("00000000-0000-4000-9000-00000000000b", "2026-11-11T08:05:00.000Z"), status: "failed", bytes: null, error: "Storage didn't take the backup (500)." }] });
    current.db = db.db;
    services = fakeServices();
    services.files.set("00000000-0000-4000-9000-00000000000a/part-0001", new TextEncoder().encode("PGDMP"));
    services.files.set("00000000-0000-4000-9000-00000000000a/part-0002", new TextEncoder().encode("abc"));
  });

  it("are the owner's alone", async () => {
    expect((await app.request("/api/backups", { headers: headers("admin") }, env)).status).toBe(403);
    expect((await post("/api/backups/list", { password: PASSWORD }, "admin")).status).toBe(403);
    expect((await post("/api/backups", { password: PASSWORD }, "admin")).status).toBe(403);
    expect((await post("/api/backups/00000000-0000-4000-9000-00000000000a/download", { password: PASSWORD }, "admin")).status).toBe(403);
    expect((await app.request("/api/backups", {}, env)).status).toBe(401);
  });

  it("say how the backups are doing without a password, and nothing more", async () => {
    const res = await app.request("/api/backups", { headers: headers() }, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ available: true, running: false, lastGoodAt: "2026-11-12T08:05:00.000Z", lastRun: { ok: true } });
    expect(Object.keys(body).sort()).toEqual(["available", "lastGoodAt", "lastRun", "running", "unavailable", "warning"]);
  });

  it("list the backups only for the password", async () => {
    expect((await post("/api/backups/list", {})).status).toBe(400);
    const wrong = await post("/api/backups/list", { password: "guess" });
    expect(wrong.status).toBe(400);
    expect(await errorOf(wrong)).toBe("That password isn't right.");
    const res = await post("/api/backups/list", { password: PASSWORD });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { backups: Row[] }).backups).toEqual([
      { id: "00000000-0000-4000-9000-00000000000a", kind: "nightly", status: "ok", startedAt: "2026-11-12T08:05:00.000Z", finishedAt: "2026-11-12T08:05:00.000Z", bytes: 8, error: null },
      { id: "00000000-0000-4000-9000-00000000000b", kind: "nightly", status: "failed", startedAt: "2026-11-11T08:05:00.000Z", finishedAt: "2026-11-11T08:05:00.000Z", bytes: null, error: "Storage didn't take the backup (500)." },
    ]);
  });

  it("download a good backup as one file for the password, and tell every owner", async () => {
    expect((await post("/api/backups/00000000-0000-4000-9000-00000000000a/download", { password: "guess" })).status).toBe(400);
    const res = await post("/api/backups/00000000-0000-4000-9000-00000000000a/download", { password: PASSWORD });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="crewtavo-backup-20261112-0805.dump"');
    expect(res.headers.get("content-length")).toBe("8");
    expect(await res.text()).toBe("PGDMPabc");
    await vi.waitFor(() => expect(db.tables.notifications).toEqual([expect.objectContaining({ user_id: OWNER, kind: "security", title: "A database backup was downloaded" })]));
    expect(db.tables.activity).toEqual([expect.objectContaining({ actor_id: OWNER, verb: "backup.downloaded" })]);
  });

  it("don't give a failed backup, one that isn't there, or one with a piece missing", async () => {
    expect((await post("/api/backups/00000000-0000-4000-9000-00000000000b/download", { password: PASSWORD })).status).toBe(404);
    expect((await post("/api/backups/00000000-0000-4000-9000-0000000000ff/download", { password: PASSWORD })).status).toBe(404);
    expect((await post("/api/backups/not-an-id/download", { password: PASSWORD })).status).toBe(404);
    services.files.delete("00000000-0000-4000-9000-00000000000a/part-0002");
    const res = await post("/api/backups/00000000-0000-4000-9000-00000000000a/download", { password: PASSWORD });
    expect(res.status).toBe(409);
    expect(await errorOf(res)).toContain("isn't all in storage any more");
  });

  it("make a backup now for the password, one at a time", async () => {
    expect((await post("/api/backups", { password: "guess" })).status).toBe(400);
    let release = () => undefined as void;
    const held = new Promise<void>((resolve) => (release = resolve));
    backupTools.dump = () => ({
      chunks: (async function* () {
        await held;
        yield archive(64);
      })(),
      done: held.then(() => ({ code: 0, stderr: "" })),
      stop: () => undefined,
    });
    const res = await post("/api/backups", { password: PASSWORD });
    expect(res.status).toBe(202);
    const { id } = (await res.json()) as { id: string };
    expect(db.claims.at(-1)).toEqual({ p_kind: "manual" });
    // It's still being made: another isn't started, and it isn't offered yet.
    const again = await post("/api/backups", { password: PASSWORD });
    expect(again.status).toBe(409);
    expect(await errorOf(again)).toContain("A backup is being made right now");
    expect((await post(`/api/backups/${id}/download`, { password: PASSWORD })).status).toBe(404);
    release();
    await vi.waitFor(() => expect(db.tables.backups!.find((b) => b.id === id)).toMatchObject({ status: "ok", kind: "manual", bytes: 64, parts: 1 }));
  });
});
