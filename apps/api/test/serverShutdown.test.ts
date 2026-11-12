/**
 * Stopping the server (shutdown in server.ts), which every update does to the version it replaces:
 * it takes no more connections and starts no more background tasks, lets the request and the task
 * under way finish, and only then exits. It used to exit as soon as its connections closed, with
 * tasks still running.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { type AddressInfo, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";

/** Lets a test finish something the server is waiting on, when it chooses. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

const state = vi.hoisted(() => ({
  listener: undefined as import("node:http").Server | undefined,
  /** The background task under way, and how the test ends it. */
  task: undefined as { resolve: (result: Record<string, number>) => void } | undefined,
  tasks: [] as string[],
}));
vi.mock("@hono/node-server", async (importOriginal) => {
  const real = await importOriginal<typeof import("@hono/node-server")>();
  return { ...real, serve: (...args: Parameters<typeof real.serve>) => (state.listener = real.serve(...args) as http.Server) };
});
// One task, every minute, that runs until the test says it's done.
vi.mock("../src/tasks", () => ({
  CRON_TASKS: { "* * * * *": ["automations"] },
  runTask: (task: string) => {
    state.tasks.push(task);
    if (task !== "automations") return Promise.resolve({});
    return new Promise((resolve) => (state.task = { resolve }));
  },
}));

let port = 0;
const web = mkdtempSync(join(tmpdir(), "crewtavo-web-"));
writeFileSync(join(web, "index.html"), "<!doctype html><title>Crewtavo</title>");
/** What server.ts does on each signal, kept here rather than left on the test's own process. */
const signals: Record<string, () => void> = {};
const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
/** The request to Auth the gateway is waiting on. */
const upstream = deferred<Response>();

beforeAll(async () => {
  port = await new Promise<number>((resolve) => {
    const probe = createServer().listen(0, "127.0.0.1", () => {
      const { port: free } = probe.address() as AddressInfo;
      probe.close(() => resolve(free));
    });
  });
  // An instance with Docker (so /auth/v1 is forwarded), with no database address: nothing to migrate.
  for (const [name, value] of Object.entries({ PORT: String(port), JWT_SECRET: "x".repeat(64), CREWTAVO_PLATFORM: "compose", CREWTAVO_STATIC_DIR: web })) vi.stubEnv(name, value);
  for (const name of ["SUPABASE_DB_URL", "DATABASE_URL", "CREWTAVO_SCHEDULER", "RAILWAY_PROJECT_ID", "RAILWAY_PUBLIC_DOMAIN", "CREWTAVO_VISITOR_IP", "SUPABASE_AUTH_URL", "SUPABASE_REST_URL", "SUPABASE_STORAGE_URL", "CREWTAVO_SENTRY_DSN", "APP_URL"]) vi.stubEnv(name, "");
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => (String(input).endsWith("/user") ? upstream.promise : Response.json({})));
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  const on = process.on.bind(process);
  vi.spyOn(process, "on").mockImplementation(((event: string, handler: () => void) => {
    if (event === "SIGTERM" || event === "SIGINT") signals[event] = handler;
    else on(event, handler);
    return process;
  }) as never);
  // The scheduler's clock only: the first tick is up to a minute away.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  await import("../src/server");
  const listener = state.listener!;
  if (!listener.listening) await new Promise((resolve) => listener.once("listening", resolve));
  await vi.advanceTimersByTimeAsync(61_000);
  vi.useRealTimers();
});

afterAll(async () => {
  if (state.listener?.listening) await new Promise((resolve) => state.listener?.close(resolve));
  rmSync(web, { recursive: true, force: true });
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const soon = (ms = 300) => new Promise((resolve) => setTimeout(resolve, ms));

it("lets the request and the task under way finish, then exits", async () => {
  expect(state.tasks).toContain("automations");
  // A request the server is still answering: the gateway is waiting for Auth.
  const answered = new Promise<number>((resolve, reject) => {
    http.get({ host: "127.0.0.1", port, path: "/auth/v1/user", agent: false }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode ?? 0));
    }).on("error", reject);
  });
  await soon(100);

  signals.SIGTERM();
  await soon();
  expect(exit).not.toHaveBeenCalled();
  // No new connections from here on.
  expect(state.listener!.listening).toBe(false);
  await expect(new Promise((resolve, reject) => http.get({ host: "127.0.0.1", port, path: "/api/health", agent: false }, resolve).on("error", reject))).rejects.toMatchObject({ code: "ECONNREFUSED" });

  // The request finishes, with its answer. The task is still running, so the server is too.
  upstream.resolve(Response.json({ id: "u1" }));
  expect(await answered).toBe(200);
  await soon();
  expect(exit).not.toHaveBeenCalled();

  state.task!.resolve({ sent: 1 });
  await soon();
  expect(exit).toHaveBeenCalledTimes(1);
  expect(exit).toHaveBeenCalledWith(0);
});
