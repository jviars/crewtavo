/**
 * Single-process server for Railway, Docker and local runs: the web app, the API, and a built-in
 * scheduler for background tasks (Railway cron jobs can't run more often than every 5 minutes,
 * and automations need every minute).
 *
 * In a Crewtavo instance (JWT_SECRET set; see lib/stack.ts and deploy/README.md) it is also the
 * gateway to the instance's own Supabase services, and it applies database migrations as it starts:
 * /api/health answers 503 until they're done, so Railway keeps the previous deployment serving.
 *
 *   PORT              port to listen on (Railway sets it)
 *   CREWTAVO_STATIC_DIR     built web app (default: ./public next to this file)
 *   CREWTAVO_SCHEDULER=off  don't run background tasks here (for extra replicas)
 *   CREWTAVO_LOG_TASKS=1    log every background task run, even when it had nothing to do
 *   APP_URL           public address; defaults to https://$RAILWAY_PUBLIC_DOMAIN on Railway (see readEnv)
 *   CREWTAVO_SENTRY_DSN     report errors to Sentry or GlitchTip (see lib/monitoring.ts)
 *   CREWTAVO_VISITOR_IP     where visitors' addresses come from, behind other proxies (lib/visitor.ts)
 *   CREWTAVO_VERSION        the release, reported by /api/health (the Docker image sets it)
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import type { Server as HttpServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { serve, type HttpBindings } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono, type Context } from "hono";
import { app } from "./app";
import { readEnv } from "./env";
import { forwardTo } from "./lib/address";
import { closeAfterUnreadBodies } from "./lib/connection";
import { cronMatches } from "./lib/cron";
import { gateway } from "./lib/gateway";
import { reportError } from "./lib/monitoring";
import { describeRecovery } from "./lib/recovery";
import { startMonitoring } from "./lib/monitoring-node";
import { stackServices, withStack } from "./lib/stack";
import { retryStartup, setStartup, startup, whenIdle, worthRetrying, type Startup } from "./lib/startup";
import { CRON_TASKS, runTask, type TaskName } from "./tasks";

const here = dirname(fileURLToPath(import.meta.url));
const staticDir = process.env.CREWTAVO_STATIC_DIR ?? join(here, "public");
const port = Number(process.env.PORT ?? 8080);
const version = process.env.CREWTAVO_VERSION ?? "dev";
const stack = stackServices(process.env);
const env = readEnv(withStack(process.env, port));
startMonitoring(env);

const server = new Hono<{ Bindings: HttpBindings }>();
// The app gets the connection too: with no proxy in front, its address is the visitor's (lib/visitor.ts).
const api = (c: Context<{ Bindings: HttpBindings }>) => app.fetch(c.req.raw, { ...env, incoming: c.env.incoming });

// Railway routes traffic to a new deployment once this answers 200: after migrations, or when a
// brand-new instance couldn't finish them (the setup page then says why). A failed update answers
// 503, so the previous deployment keeps serving.
server.get("/api/health", (c) => {
  const s = startup();
  if (s?.state === "migrating") return c.json({ ok: false, version, starting: true }, 503);
  if (s?.state === "failed" && s.firstInstall === false) return c.json({ ok: false, version, problem: s.problem }, 503);
  // An older version on a newer database keeps serving (scripts/migrate.mjs says why), and says so here.
  if (s?.state === "ready" && s.problem) return c.json({ ok: true, version, problem: s.problem });
  return c.json({ ok: true, version });
});
server.all("/api/*", api);
server.all("/mcp", api);
server.all("/mcp/*", api);
server.all("/.well-known/*", api);
// Website analytics: the script on the business's website, and the page views it sends (routes/analytics.ts).
server.get("/v.js", api);
server.post("/v", api);
// Website forms: the address the business's own form sends to, and its thank-you page (routes/websiteForms.ts).
server.all("/f/*", api);

// Gateway to the instance's Supabase services (lib/gateway.ts).
if (stack) server.route("/", gateway(env, stack));

// After a switch in Settings → Web address, pages opened on an old address forward to the new one
// (lib/address.ts). Client links, webhooks and the API keep answering where they are.
server.use("*", async (c, next) => {
  const target = await forwardTo(env, c.req.raw);
  if (target) return c.redirect(target, 302);
  await next();
});

// The web app: fingerprinted assets cache forever; everything else falls back to index.html.
// Not a file under /assets/ that isn't there, though (one from a version before, or after, this
// one): that's a 404, never the app's page kept forever under a script's name. The app then
// reloads once into the version that's running (components/shell/RouteError.tsx).
// Its pages can't be shown inside another site, so a signed-in screen (Apps → Stripe, say) can't
// be dressed up to trick a click. Booking forms are left out: businesses put them on their own
// websites (features/booking/embed.ts), and they're public anyway. The API has its own headers (app.ts).
const indexPath = join(staticDir, "index.html");
const indexHtml = existsSync(indexPath) ? readFileSync(indexPath, "utf8") : null;
server.use("*", async (c, next) => {
  await next();
  if (c.res.headers.get("content-type")?.includes("text/html") && !c.req.path.startsWith("/book/")) {
    c.res.headers.set("X-Frame-Options", "SAMEORIGIN");
    c.res.headers.set("Content-Security-Policy", "frame-ancestors 'self'; object-src 'none'; base-uri 'self'");
  }
  if (c.res.status !== 200) return;
  if (c.req.path.startsWith("/assets/")) c.res.headers.set("Cache-Control", "public, max-age=31536000, immutable");
  else if (c.res.headers.get("content-type")?.includes("text/html")) c.res.headers.set("Cache-Control", "no-cache");
});
server.use("/*", serveStatic({ root: staticDir }));
server.all("/assets/*", (c) => c.text("Not found", 404, { "Cache-Control": "no-store" }));
server.get("*", (c) => {
  if (!indexHtml) return c.text("The web app isn't built. Run npm run build:server.", 500);
  return c.html(indexHtml, 200, { "Cache-Control": "no-cache" });
});

const listener = serve({ fetch: server.fetch, port, hostname: "0.0.0.0" }, () => {
  console.log(`Crewtavo listening on port ${port}${env.APP_URL ? ` (${env.APP_URL})` : ""}`);
});
closeAfterUnreadBodies(listener as HttpServer);

// ---------------------------------------------------------------------------------------------
// Migrations, as a separate process (scripts/migrate.mjs, next to this file in the build) so a
// failure is reported rather than crashing the server. Background tasks start once it's done,
// however many tries that takes.
// ---------------------------------------------------------------------------------------------
const migrateScript = join(here, "scripts/migrate.mjs");
/**
 * Whether this is a brand-new instance or an update, once a try has reached the database and seen.
 * A later try that can't reach it doesn't know, and mustn't make /api/health forget that this is an
 * update that failed, which answers 503 so the previous version keeps serving.
 */
let firstInstall: boolean | undefined;

/**
 * In an instance, Auth and Storage set up their own tables as they start, and the migrations build
 * on those, so wait until both answer their health checks: up to five minutes on a cold start, and
 * one look at each when a failed start is tried again.
 */
async function waitForServices(limit: number): Promise<boolean> {
  if (!stack) return true;
  const deadline = Date.now() + limit;
  for (const url of [`${stack.auth}/health`, `${stack.storage}/status`]) {
    for (;;) {
      const ok = await fetch(url, { signal: AbortSignal.timeout(5_000) }).then((r) => r.ok, () => false);
      if (ok) break;
      if (Date.now() >= deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
  }
  return true;
}

/**
 * One go at starting up. `again` is a further try after a start that failed because the database or
 * its services weren't there (retryStartup in lib/startup.ts): it looks rather than waits, so the
 * failure, and what the setup page says to check, stays on show until there's something to run.
 */
async function migrate(again = false): Promise<void> {
  if (!existsSync(migrateScript) || !(process.env.SUPABASE_DB_URL || process.env.DATABASE_URL)) return;
  if (!again) setStartup({ state: "migrating" });
  if (!(await waitForServices(again ? 0 : 5 * 60_000))) {
    if (again) return;
    console.error("Startup: Auth or Storage didn't come up within five minutes.");
    return setStartup({ state: "failed", problem: "services_not_ready" });
  }
  // From here migrations may be running, so /api/health and the setup page say "starting" again,
  // and nobody can create the owner's account on a half-made database (routes/setup.ts).
  setStartup({ state: "migrating" });
  const statusFile = join(tmpdir(), `crewtavo-migrate-${process.pid}.json`);
  return new Promise((resolve) => {
    // CREWTAVO_SINGLE_COMPANY as this server reads it (on by default in an instance), so the
    // database refuses a second business too, not just this API. A further try doesn't wait three
    // minutes for the database as the first does: it has all the tries it needs, and the setup page
    // says "starting" for as long as the runner is out.
    const child = spawn(process.execPath, [migrateScript], {
      env: { ...process.env, CREWTAVO_SINGLE_COMPANY: env.CREWTAVO_SINGLE_COMPANY ?? "", CREWTAVO_MIGRATE_STATUS: statusFile, ...(again ? { CREWTAVO_MIGRATE_WAIT: "0" } : {}) },
      stdio: "inherit",
    });
    child.on("exit", () => {
      let status: { ok?: boolean; firstInstall?: boolean; problem?: Startup["problem"]; detail?: string } = {};
      try {
        status = JSON.parse(readFileSync(statusFile, "utf8"));
        rmSync(statusFile, { force: true });
      } catch {
        status = { ok: false, problem: "migration_failed", detail: "The migration process stopped without a result." };
      }
      firstInstall = status.firstInstall ?? firstInstall;
      // Ready can come with a problem that doesn't stop it (newer_database). Error monitoring hears
      // of it too: nobody may be reading this instance's log.
      if (status.ok && status.problem) reportError(new Error(`Crewtavo ${version} started on a database a newer version has updated (${status.detail ?? "no detail"})`), { startup: status.problem });
      setStartup(
        status.ok
          ? { state: "ready", ...(status.problem ? { problem: status.problem, detail: status.detail } : {}) }
          : { state: "failed", firstInstall, problem: status.problem, detail: status.detail },
      );
      resolve();
    });
  });
}

// ---------------------------------------------------------------------------------------------
// Scheduler: once a minute, run every task whose cron expression matches. A task still running
// from the last tick is skipped rather than started twice. Tasks are safe to run concurrently
// across replicas, but CREWTAVO_SCHEDULER=off keeps extra replicas quiet.
// ---------------------------------------------------------------------------------------------
const running = new Set<TaskName>();
let timer: ReturnType<typeof setTimeout> | undefined;
/** Set once the server has been asked to stop (shutdown, below): nothing new starts after that. */
let stopping = false;

async function tick() {
  const now = new Date();
  for (const [expression, tasks] of Object.entries(CRON_TASKS)) {
    if (!cronMatches(expression, now)) continue;
    for (const task of tasks) {
      if (running.has(task)) continue;
      running.add(task);
      runTask(task, env)
        .then((result) => {
          if (process.env.CREWTAVO_LOG_TASKS === "1" || Object.values(result).some((v) => typeof v === "number" && v > 0)) console.log(JSON.stringify({ task, ...result }));
        })
        .catch((error) => {
          console.error(`Task ${task} failed`, error);
          reportError(error, { task });
        })
        .finally(() => running.delete(task));
    }
  }
}

function scheduleNext() {
  const delay = 60_000 - (Date.now() % 60_000) + 250; // just after the next minute starts
  timer = setTimeout(() => {
    void tick();
    scheduleNext();
  }, delay);
}

void migrate().then(async () => {
  void describeRecovery(env).then((line) => line && console.log(line), () => undefined);
  // A start that failed because the database or its services weren't up is tried again, a little
  // later each time, until it works: otherwise the server stays up with no background tasks
  // (reminders, automations, autopay) until someone redeploys. A migration that failed stays failed.
  if (worthRetrying(startup())) console.error(`Startup: not ready (${startup()?.problem}). Trying again by itself until it is.`);
  await retryStartup(() => migrate(true), undefined, () => stopping);
  if (stopping || startup()?.state === "failed" || process.env.CREWTAVO_SCHEDULER === "off") return;
  scheduleNext();
  console.log("Background tasks: running in this process");
  // Started with a new web address (Settings → Web address)? Say so now rather than at the next tick.
  runTask("address", env).catch((error) => console.error("Task address failed", error));
});

/**
 * How long stopping waits for the requests and background tasks under way: a little under the 30
 * seconds Railway (RAILWAY_DEPLOYMENT_DRAINING_SECONDS in .railway/railway.ts) and Docker
 * (stop_grace_period in docker-compose.yml) give the process before they kill it.
 */
const DRAIN_MS = 25_000;

/**
 * Asked to stop, which every update does to the version it replaces: no more background tasks are
 * started and no more connections taken, then it waits for what's under way, so a request isn't cut
 * off and a task isn't killed half-way through a charge or a send. It stops as soon as that's done.
 */
async function shutdown(signal: string) {
  // Asked a second time (Ctrl-C again): stop now.
  if (stopping) process.exit(0);
  stopping = true;
  console.log(`${signal} received, shutting down`);
  if (timer) clearTimeout(timer);
  let closed = false;
  listener.close(() => (closed = true));
  const idle = await whenIdle(() => {
    // A connection kept open between requests (a browser's, Railway's proxy's) would hold the server
    // open until it timed out. One with a request under way is left alone until it has answered.
    (listener as HttpServer).closeIdleConnections();
    return closed && running.size === 0;
  }, DRAIN_MS);
  if (!idle) console.log(`Still busy after ${DRAIN_MS / 1000} seconds (${[...running].join(", ") || "open requests"}); stopping anyway`);
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
