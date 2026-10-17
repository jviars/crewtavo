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
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import type { IncomingMessage, Server } from "node:http";
import { connect } from "node:net";
import type { Duplex } from "node:stream";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { app } from "./app";
import { readEnv } from "./env";
import { cronMatches } from "./lib/cron";
import { reportError } from "./lib/monitoring";
import { startMonitoring } from "./lib/monitoring-node";
import { stackServices, withStack } from "./lib/stack";
import { setStartup, startup, type Startup } from "./lib/startup";
import { CRON_TASKS, runTask, type TaskName } from "./tasks";

const here = dirname(fileURLToPath(import.meta.url));
const staticDir = process.env.CREWTAVO_STATIC_DIR ?? join(here, "public");
const port = Number(process.env.PORT ?? 8080);
const stack = stackServices(process.env);
const env = readEnv(withStack(process.env, port));
startMonitoring(env);

const server = new Hono();
const api = (request: Request) => app.fetch(request, env);

// Railway routes traffic to a new deployment once this answers 200: after migrations, or when a
// brand-new instance couldn't finish them (the setup page then says why). A failed update answers
// 503, so the previous deployment keeps serving.
server.get("/api/health", (c) => {
  const s = startup();
  if (s?.state === "migrating") return c.json({ ok: false, starting: true }, 503);
  if (s?.state === "failed" && s.firstInstall === false) return c.json({ ok: false, problem: s.problem }, 503);
  return c.json({ ok: true });
});
server.all("/api/*", (c) => api(c.req.raw));
server.all("/mcp", (c) => api(c.req.raw));
server.all("/mcp/*", (c) => api(c.req.raw));
server.all("/.well-known/*", (c) => api(c.req.raw));

// ---------------------------------------------------------------------------------------------
// Gateway to the instance's Supabase services, in place of Supabase's own API gateway: the browser
// and supabase-js use this server's address as the Supabase URL. (The WebSocket half of Realtime is
// handled on "upgrade" below.)
// ---------------------------------------------------------------------------------------------
if (stack) {
  server.all("/auth/v1/*", (c) => forward(c.req.raw, stack.auth, "/auth/v1"));
  server.all("/rest/v1/*", (c) => forward(c.req.raw, stack.rest, "/rest/v1"));
  server.all("/storage/v1/*", (c) => forward(c.req.raw, stack.storage, "/storage/v1", { "x-forwarded-prefix": "/storage/v1" }));
  server.all("/realtime/v1/api/*", (c) => forward(c.req.raw, stack.realtime, "/realtime/v1", { host: realtimeHost(stack.realtime) }));
}

async function forward(request: Request, upstream: string, prefix: string, extra: Record<string, string> = {}): Promise<Response> {
  const incoming = new URL(request.url);
  const target = new URL(upstream);
  target.pathname = target.pathname.replace(/\/$/, "") + (incoming.pathname.slice(prefix.length) || "/");
  target.search = incoming.search;
  const headers = new Headers(request.headers);
  for (const name of ["host", "connection", "accept-encoding", "content-length"]) headers.delete(name);
  headers.set("x-forwarded-host", incoming.host);
  headers.set("x-forwarded-proto", request.headers.get("x-forwarded-proto") ?? incoming.protocol.replace(":", ""));
  for (const [name, value] of Object.entries(extra)) headers.set(name, value);
  const hasBody = !["GET", "HEAD"].includes(request.method);
  try {
    const res = await fetch(target, {
      method: request.method,
      headers,
      body: hasBody ? request.body : undefined,
      redirect: "manual",
      ...(hasBody ? { duplex: "half" } : {}),
    } as RequestInit);
    const out = new Headers(res.headers);
    // fetch already decoded the body.
    for (const name of ["content-encoding", "content-length", "transfer-encoding", "connection"]) out.delete(name);
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers: out });
  } catch (error) {
    console.error(`Gateway: ${target.host} didn't answer`, (error as Error).message);
    return Response.json({ message: "This part of Crewtavo is still starting. Try again in a moment." }, { status: 503 });
  }
}

/** Realtime picks the tenant from the first label of the Host header; self-hosting seeds "realtime-dev". */
const realtimeHost = (upstream: string) => `realtime-dev.${new URL(upstream).hostname}`;

/** Realtime's WebSocket: /realtime/v1/websocket → the Realtime service's /socket/websocket, piped both ways. */
function proxyRealtime(req: IncomingMessage, socket: Duplex, head: Buffer) {
  if (!stack || !req.url?.startsWith("/realtime/v1/")) return socket.destroy();
  const target = new URL(stack.realtime);
  const upstream = connect(Number(target.port || 80), target.hostname.replace(/^\[|\]$/g, ""), () => {
    const lines = [`${req.method} /socket/${req.url!.slice("/realtime/v1/".length)} HTTP/1.1`, `Host: ${realtimeHost(stack.realtime)}`];
    for (let i = 0; i < req.rawHeaders.length; i += 2) if (req.rawHeaders[i].toLowerCase() !== "host") lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
    upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
    if (head.length) upstream.write(head);
    socket.pipe(upstream).pipe(socket);
  });
  upstream.on("error", () => socket.destroy());
  socket.on("error", () => upstream.destroy());
}

// The web app: fingerprinted assets cache forever; everything else falls back to index.html.
const indexPath = join(staticDir, "index.html");
const indexHtml = existsSync(indexPath) ? readFileSync(indexPath, "utf8") : null;
server.use("*", async (c, next) => {
  await next();
  if (c.res.status !== 200) return;
  if (c.req.path.startsWith("/assets/")) c.res.headers.set("Cache-Control", "public, max-age=31536000, immutable");
  else if (c.res.headers.get("content-type")?.includes("text/html")) c.res.headers.set("Cache-Control", "no-cache");
});
server.use("/*", serveStatic({ root: staticDir }));
server.get("*", (c) => {
  if (!indexHtml) return c.text("The web app isn't built. Run npm run build:server.", 500);
  return c.html(indexHtml, 200, { "Cache-Control": "no-cache" });
});

const listener = serve({ fetch: server.fetch, port, hostname: "0.0.0.0" }, () => {
  console.log(`Crewtavo listening on port ${port}${env.APP_URL ? ` (${env.APP_URL})` : ""}`);
});
if (stack) (listener as Server).on("upgrade", proxyRealtime);

// ---------------------------------------------------------------------------------------------
// Migrations, as a separate process (scripts/migrate.mjs, next to this file in the build) so a
// failure is reported rather than crashing the server. Background tasks start once it's done.
// ---------------------------------------------------------------------------------------------
const migrateScript = join(here, "scripts/migrate.mjs");

/**
 * In an instance, Auth and Storage set up their own tables as they start, and the migrations build
 * on those, so wait until both answer their health checks (up to five minutes on a cold start).
 */
async function waitForServices(): Promise<boolean> {
  if (!stack) return true;
  const deadline = Date.now() + 5 * 60_000;
  for (const url of [`${stack.auth}/health`, `${stack.storage}/status`]) {
    for (;;) {
      const ok = await fetch(url, { signal: AbortSignal.timeout(5_000) }).then((r) => r.ok, () => false);
      if (ok) break;
      if (Date.now() > deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
  }
  return true;
}

async function migrate(): Promise<void> {
  if (!existsSync(migrateScript) || !(process.env.SUPABASE_DB_URL || process.env.DATABASE_URL)) return;
  setStartup({ state: "migrating" });
  if (!(await waitForServices())) {
    console.error("Startup: Auth or Storage didn't come up within five minutes.");
    return setStartup({ state: "failed", problem: "services_not_ready" });
  }
  const statusFile = join(tmpdir(), `crewtavo-migrate-${process.pid}.json`);
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [migrateScript], { env: { ...process.env, CREWTAVO_MIGRATE_STATUS: statusFile }, stdio: "inherit" });
    child.on("exit", () => {
      let status: { ok?: boolean; firstInstall?: boolean; problem?: Startup["problem"]; detail?: string } = {};
      try {
        status = JSON.parse(readFileSync(statusFile, "utf8"));
        rmSync(statusFile, { force: true });
      } catch {
        status = { ok: false, problem: "migration_failed", detail: "The migration process stopped without a result." };
      }
      setStartup(status.ok ? { state: "ready" } : { state: "failed", firstInstall: status.firstInstall, problem: status.problem, detail: status.detail });
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

void migrate().then(() => {
  if (startup()?.state === "failed" || process.env.CREWTAVO_SCHEDULER === "off") return;
  scheduleNext();
  console.log("Background tasks: running in this process");
});

function shutdown(signal: string) {
  console.log(`${signal} received, shutting down`);
  if (timer) clearTimeout(timer);
  listener.close(() => process.exit(0));
  // Give in-flight requests and tasks a few seconds, then exit regardless.
  setTimeout(() => process.exit(0), 8_000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
