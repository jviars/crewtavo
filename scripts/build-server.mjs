#!/usr/bin/env node
/**
 * Builds the single-process server used by the Dockerfile (Railway, Docker, any Node host):
 *   dist/server/server.mjs              web app + API + scheduler (apps/api/src/server.ts)
 *   dist/server/pdf-worker.mjs          the thread an estimate's or invoice's PDF is made on (apps/api/src/pdf/worker.ts)
 *   dist/server/public/                 the built web app
 *   dist/server/scripts/migrate.mjs     applies database migrations (node scripts/migrate.mjs)
 *   dist/server/scripts/restore.mjs     puts a database backup into an instance (node scripts/restore.mjs)
 *   dist/server/supabase/migrations/    the migrations it applies
 *   dist/server/assets/                 the review card's renderer (resvg.wasm), fonts and their licences, and the PDF's built-in fonts
 *   dist/server/package.json            where the PDF's maker finds its built-in fonts
 *   dist/server/scripts/render-card.mjs renders a sample review card (node scripts/render-card.mjs --check)
 *   dist/server/server-licenses.txt     the open-source packages in all of the above, and their licenses
 * Run with: node dist/server/server.mjs
 */
import { execSync } from "node:child_process";
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { licensesText, packagesIn } from "./licenses.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "dist/server");
const run = (cmd) => execSync(cmd, { cwd: root, stdio: "inherit" });

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, "scripts"), { recursive: true });

if (process.env.CREWTAVO_SKIP_WEB_BUILD !== "1") run("npm run build -w @crewtavo/web");
cpSync(join(root, "apps/web/dist"), join(out, "public"), { recursive: true });
cpSync(join(root, "supabase/migrations"), join(out, "supabase/migrations"), { recursive: true });
// Restoring a backup needs nothing but Node, pg_restore and psql, so it goes in as it is.
cpSync(join(root, "scripts/restore.mjs"), join(out, "scripts/restore.mjs"));
// The review card (apps/api/src/lib/reviewCard.ts) reads these next to the bundle: no node_modules there.
cpSync(join(root, "apps/api/assets/fonts"), join(out, "assets/fonts"), { recursive: true });
cpSync(join(root, "apps/api/assets/licenses"), join(out, "assets/licenses"), { recursive: true });
const resvgWasm = createRequire(join(root, "apps/api/package.json")).resolve("@resvg/resvg-wasm/index_bg.wasm");
cpSync(resvgWasm, join(out, "assets/resvg.wasm"));
// The PDF's maker (pdfkit, under react-pdf: apps/api/src/pdf/render.ts) loads its built-in fonts at run
// time, as "#standard-fonts/Helvetica" from its own package: here they're in assets, and the
// package.json next to the bundle says so.
const standardFonts = join(dirname(createRequire(join(root, "apps/api/package.json")).resolve("pdfkit")), "standard-fonts");
cpSync(standardFonts, join(out, "assets/standard-fonts"), { recursive: true, filter: (f) => !f.endsWith(".mjs") });
writeFileSync(join(out, "package.json"), `${JSON.stringify({ private: true, imports: { "#standard-fonts/*": "./assets/standard-fonts/*.cjs" } }, null, 2)}\n`);

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

// The image has no node_modules: the packages' code is in these bundles, minified, without their
// copyright and license text. server-licenses.txt carries it (scripts/licenses.mjs), for every
// package with code in a bundle or a file copied above.
const shipped = [resvgWasm, standardFonts];
const bundle = async (entry, outfile) => {
  const { metafile } = await build({ ...common, metafile: true, entryPoints: [entry], outfile });
  // Paths relative to where this runs. Code left out entirely (tree-shaken) doesn't count.
  for (const output of Object.values(metafile.outputs)) for (const [file, { bytesInOutput }] of Object.entries(output.inputs)) if (bytesInOutput) shipped.push(resolve(file));
};
await bundle(join(root, "apps/api/src/server.ts"), join(out, "server.mjs"));
// The server starts it next to itself (services/documentPdf.ts), so a PDF never holds up its own thread.
await bundle(join(root, "apps/api/src/pdf/worker.ts"), join(out, "pdf-worker.mjs"));
await bundle(join(root, "scripts/migrate.mjs"), join(out, "scripts/migrate.mjs"));
await bundle(join(root, "apps/api/src/scripts/renderCard.ts"), join(out, "scripts/render-card.mjs"));
const intro = `Open-source software in Crewtavo's server

This lists the open-source software included in Crewtavo's server (server.mjs and the files next to
it), and its licenses. Crewtavo itself is free software under the GNU Affero General Public License,
version 3, with additional terms: see LICENSE and NOTICE.`;
writeFileSync(join(out, "server-licenses.txt"), licensesText(intro, packagesIn(shipped)));
console.log("Server build written to dist/server (run: node dist/server/server.mjs)");
