/**
 * First run of a Crewtavo instance (one business per Railway project or docker compose stack; see
 * deploy/README.md):
 *   GET  /api/setup        whether the instance is ready, for the "Finish setting up" screen
 *                          (apps/web/src/features/setup). Public, so it only ever says whether
 *                          each piece is in place, never a value.
 *   POST /api/setup/owner  creates the owner's account, once: sign-ups are closed in an instance,
 *                          so the first person to open it sets it up and invites everyone else.
 */
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv, Env } from "../env";
import { clientIp, HttpError, readJson } from "../lib/http";
import { allow } from "../lib/limit";
import { startup, type MigrationProblem } from "../lib/startup";
import { adminClient } from "../lib/supabase";

export type Platform = "railway" | "compose" | "server";
export type DatabaseStatus = "ok" | "starting" | "not_connected" | "wrong_keys" | "unreachable" | "empty" | "migration_failed";

export const setup = new Hono<AppEnv>();

let cached: { at: number; key: string; database: DatabaseStatus } | null = null;

const singleCompany = (env: Env) => env.CREWTAVO_SINGLE_COMPANY === "1";

setup.get("/setup", async (c) => {
  const env = c.env;
  const vars = env as unknown as Record<string, unknown>;
  const connected = Boolean(env.SUPABASE_URL && (env.SUPABASE_PUBLISHABLE_KEY || env.SUPABASE_ANON_KEY) && (env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY));
  const run = startup();
  let migration: { problem?: MigrationProblem; detail?: string } | null = null;
  let database: DatabaseStatus;
  if (run?.state === "migrating") database = "starting";
  else if (run?.state === "failed") {
    database = "migration_failed";
    migration = { problem: run.problem, detail: run.detail };
  } else database = connected ? await databaseStatus(env) : "not_connected";

  const ready = database === "ok";
  return c.json(
    {
      ready,
      platform: (vars.RAILWAY_PROJECT_ID || vars.RAILWAY_PUBLIC_DOMAIN ? "railway" : vars.CREWTAVO_PLATFORM === "compose" ? "compose" : "server") satisfies Platform,
      database,
      migration,
      /** No account yet: the first visitor creates the owner's (POST /api/setup/owner). */
      needsOwner: ready && singleCompany(env) ? !(await anyUser(env)) : false,
    },
    200,
    { "Cache-Control": "no-store" },
  );
});

setup.post("/setup/owner", async (c) => {
  const env = c.env;
  if (!singleCompany(env)) throw new HttpError(404, "Not found");
  const body = await readJson(
    c,
    z.object({ full_name: z.string().trim().min(2, "Enter your name.").max(120), email: z.email(), password: z.string().min(8, "Use at least 8 characters.").max(200) }),
  );
  const ip = clientIp(c);
  if (!(await allow(env, `setup-owner:${ip}`, 10, 3600))) throw new HttpError(429, "Too many tries. Wait a few minutes and try again.");
  if (await anyUser(env)) throw new HttpError(409, "This Crewtavo is already set up. Sign in instead.");

  const admin = adminClient(env);
  const { data, error } = await admin.auth.admin.createUser({ email: body.email.trim().toLowerCase(), password: body.password, email_confirm: true, user_metadata: { full_name: body.full_name } });
  if (error || !data.user) {
    console.error("Owner account failed", error);
    throw new HttpError(400, "Couldn't create the account. Check the email address and try again.");
  }
  // Two people setting up at the same moment: the first account wins.
  const { data: list } = await admin.auth.admin.listUsers({ page: 1, perPage: 2 });
  if ((list?.users.length ?? 0) > 1) {
    await admin.auth.admin.deleteUser(data.user.id);
    throw new HttpError(409, "Someone else just set up this Crewtavo. Sign in instead.");
  }
  return c.json({ ok: true }, 201);
});

async function anyUser(env: Env): Promise<boolean> {
  const { data, error } = await adminClient(env).auth.admin.listUsers({ page: 1, perPage: 1 });
  if (error) throw new HttpError(503, "Crewtavo is still starting. Try again in a moment.");
  return data.users.length > 0;
}

/** Can the server reach Supabase with these keys, and has the schema been applied? Cached for a few seconds. */
async function databaseStatus(env: Env): Promise<DatabaseStatus> {
  const key = `${env.SUPABASE_URL}|${env.SUPABASE_PUBLISHABLE_KEY ?? env.SUPABASE_ANON_KEY}`;
  if (cached && cached.key === key && Date.now() - cached.at < 10_000) return cached.database;
  const database = await checkDatabase(env);
  cached = { at: Date.now(), key, database };
  return database;
}

async function checkDatabase(env: Env): Promise<DatabaseStatus> {
  try {
    const settings = await fetch(`${env.SUPABASE_URL.replace(/\/$/, "")}/auth/v1/settings`, {
      headers: { apikey: (env.SUPABASE_PUBLISHABLE_KEY || env.SUPABASE_ANON_KEY) as string },
      signal: AbortSignal.timeout(8_000),
    });
    if (settings.status === 401 || settings.status === 403) return "wrong_keys";
    if (!settings.ok) return "unreachable";
    const { error, status } = await adminClient(env).from("companies").select("id").limit(1);
    if (!error) return "ok";
    if (status === 401 || status === 403) return "wrong_keys";
    // PGRST205: no such table in the schema cache (42P01 from older PostgREST versions).
    if (error.code === "PGRST205" || error.code === "42P01" || status === 404) return "empty";
    return "unreachable";
  } catch {
    return "unreachable";
  }
}
