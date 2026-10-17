#!/usr/bin/env node
/**
 * `npm run dev:api`: the API on http://localhost:8787 for local development, as the same Node server
 * that runs on Railway (apps/api/src/server.ts), rebuilt and restarted when a file changes. Settings
 * come from .dev.vars (copy .dev.vars.example). Its built-in scheduler runs the background tasks
 * (automations, campaigns, reminders, recurring visits...) on their production schedule.
 *
 * The web app (`npm run dev`, :5173) proxies /api to it. The database, sign-in and files come from
 * the local Supabase that `npx supabase start` runs, which also applies the migrations.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { context } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const varsFile = join(root, ".dev.vars");
if (!existsSync(varsFile)) {
  console.error("Missing .dev.vars: copy .dev.vars.example and fill in the values `npx supabase start` printed.");
  process.exit(1);
}
const vars = Object.fromEntries(
  readFileSync(varsFile, "utf8")
    .split("\n")
    .filter((line) => /^[A-Z_][A-Z0-9_]*=/.test(line))
    .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1).trim()]),
);

const outfile = join(root, "dist/dev/server.mjs");
// The web app comes from Vite in development; an empty folder keeps the server's static files quiet.
mkdirSync(join(root, "dist/dev/no-web-app"), { recursive: true });
const build = await context({
  entryPoints: [join(root, "apps/api/src/server.ts")],
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: "linked",
  logLevel: "warning",
  // Some dependencies still call require(); give ESM output a require that works.
  banner: { js: "import { createRequire as __devCreateRequire } from 'node:module'; const require = __devCreateRequire(import.meta.url);" },
});
await build.rebuild();
await build.watch();

const api = spawn(process.execPath, ["--watch-path", outfile, "--enable-source-maps", outfile], {
  cwd: root,
  stdio: "inherit",
  env: { ...process.env, ...vars, PORT: process.env.CREWTAVO_DEV_API_PORT ?? "8787", CREWTAVO_STATIC_DIR: join(root, "dist/dev/no-web-app") },
});
const stop = async () => {
  api.kill("SIGTERM");
  await build.dispose();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
api.on("exit", (code) => process.exit(code ?? 0));
