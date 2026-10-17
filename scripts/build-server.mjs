#!/usr/bin/env node
/**
 * Builds the single-process server used by the Dockerfile (Railway, Docker, any Node host):
 *   dist/server/server.mjs              web app + API + scheduler (apps/api/src/server.ts)
 *   dist/server/public/                 the built web app
 *   dist/server/scripts/migrate.mjs     applies database migrations (node scripts/migrate.mjs)
 *   dist/server/supabase/migrations/    the migrations it applies
 * Run with: node dist/server/server.mjs
 */
import { execSync } from "node:child_process";
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "dist/server");
const run = (cmd) => execSync(cmd, { cwd: root, stdio: "inherit" });

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, "scripts"), { recursive: true });

if (process.env.CREWTAVO_SKIP_WEB_BUILD !== "1") run("npm run build -w @crewtavo/web");
cpSync(join(root, "apps/web/dist"), join(out, "public"), { recursive: true });
cpSync(join(root, "supabase/migrations"), join(out, "supabase/migrations"), { recursive: true });

const common = {
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: "linked",
  minify: true,
  logLevel: "warning",
  // Some dependencies still call require(); give ESM output a require that works.
  banner: { js: "import { createRequire as __gwCreateRequire } from 'node:module'; const require = __gwCreateRequire(import.meta.url);" },
};
await build({ ...common, entryPoints: [join(root, "apps/api/src/server.ts")], outfile: join(out, "server.mjs") });
await build({ ...common, entryPoints: [join(root, "scripts/migrate.mjs")], outfile: join(out, "scripts/migrate.mjs") });
console.log("Server build written to dist/server (run: node dist/server/server.mjs)");
