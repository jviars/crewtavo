/**
 * /api/health on the server itself (server.ts). Railway sends a new deployment traffic once this
 * answers 200, and keeps the previous one serving while it answers 503 (deploy/README.md, Updates),
 * so what it answers in each state of starting up (lib/startup.ts) is what makes an update safe.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { type AddressInfo, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { setStartup, type Startup } from "../src/lib/startup";

// server.ts starts listening as it loads; keep hold of the listener to close it afterwards.
const started = vi.hoisted(() => ({ listener: undefined as http.Server | undefined }));
vi.mock("@hono/node-server", async (importOriginal) => {
  const real = await importOriginal<typeof import("@hono/node-server")>();
  return { ...real, serve: (...args: Parameters<typeof real.serve>) => (started.listener = real.serve(...args) as http.Server) };
});

let port = 0;
const web = mkdtempSync(join(tmpdir(), "crewtavo-web-"));
writeFileSync(join(web, "index.html"), "<!doctype html><title>Crewtavo</title>");

beforeAll(async () => {
  port = await new Promise<number>((resolve) => {
    const probe = createServer().listen(0, "127.0.0.1", () => {
      const { port: free } = probe.address() as AddressInfo;
      probe.close(() => resolve(free));
    });
  });
  // No database address, so the server doesn't run migrations itself: each test sets how they went.
  for (const [name, value] of Object.entries({ PORT: String(port), CREWTAVO_SCHEDULER: "off", CREWTAVO_STATIC_DIR: web, CREWTAVO_VERSION: "0.4.11" })) vi.stubEnv(name, value);
  for (const name of ["SUPABASE_DB_URL", "DATABASE_URL", "JWT_SECRET", "RAILWAY_PROJECT_ID", "RAILWAY_PUBLIC_DOMAIN", "CREWTAVO_SENTRY_DSN", "APP_URL"]) vi.stubEnv(name, "");
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  await import("../src/server");
  const listener = started.listener!;
  if (!listener.listening) await new Promise((resolve) => listener.once("listening", resolve));
});

afterEach(() => setStartup(null));

afterAll(async () => {
  await new Promise((resolve) => started.listener?.close(resolve));
  rmSync(web, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function health(state: Startup | null) {
  setStartup(state);
  return new Promise<{ status: number; body: unknown }>((resolve, reject) => {
    // A connection of its own each time: one kept open would hold up closing the server afterwards.
    http.get({ host: "127.0.0.1", port, path: "/api/health", agent: false }, (res) => {
      let text = "";
      res.on("data", (chunk) => (text += chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(text) }));
    }).on("error", reject);
  });
}

it("answers 200 once it's ready, and when nothing ran migrations", async () => {
  expect(await health(null)).toEqual({ status: 200, body: { ok: true, version: "0.4.11" } });
  expect(await health({ state: "ready" })).toEqual({ status: 200, body: { ok: true, version: "0.4.11" } });
});

it("answers 503 while migrations run, and after an update's failed, so the previous version keeps serving", async () => {
  expect(await health({ state: "migrating" })).toEqual({ status: 503, body: { ok: false, version: "0.4.11", starting: true } });
  expect(await health({ state: "failed", firstInstall: false, problem: "migration_failed" })).toEqual({ status: 503, body: { ok: false, version: "0.4.11", problem: "migration_failed" } });
  expect(await health({ state: "failed", firstInstall: false, problem: "busy" })).toMatchObject({ status: 503 });
});

it("answers 200 when a brand-new instance couldn't finish, so its setup page can say why", async () => {
  expect(await health({ state: "failed", firstInstall: true, problem: "wrong_password" })).toEqual({ status: 200, body: { ok: true, version: "0.4.11" } });
  expect(await health({ state: "failed", problem: "services_not_ready" })).toMatchObject({ status: 200 });
});

it("keeps answering 200 on a database a newer version has updated, and says so", async () => {
  expect(await health({ state: "ready", problem: "newer_database", detail: "2 newer migrations, up to 29990101000200" })).toEqual({ status: 200, body: { ok: true, version: "0.4.11", problem: "newer_database" } });
});
