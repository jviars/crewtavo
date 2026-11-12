#!/usr/bin/env node
/**
 * `npm run instance`: run a whole Crewtavo instance on this computer with Docker, the same services
 * the Railway template creates (docker-compose.yml, deploy/README.md). The first run writes
 * .env.instance with random secrets; keep that file, since the database is locked with them.
 *
 *   npm run instance            start (or update) it, then print the address
 *   npm run instance -- stop    stop it; the data stays
 *   npm run instance -- logs    follow the logs
 *   npm run instance -- restore <backup.dump>   put a database backup into it (docs/deploy.md, Restoring a backup)
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const envFile = join(root, ".env.instance");
// Docker's standard builder, which is named after the current context ("desktop-linux" on Docker
// Desktop): a docker-container builder (a buildx multi-arch setup) can't use local images or load
// what it builds into Docker, so compose would hang.
const context = spawnSync("docker", ["context", "show"], { encoding: "utf8" }).stdout?.trim() || "default";
const env = { ...process.env, BUILDX_BUILDER: process.env.BUILDX_BUILDER ?? context };
const compose = (...args) => spawnSync("docker", ["compose", "--env-file", envFile, ...args], { cwd: root, stdio: "inherit", env }).status ?? 1;

if (spawnSync("docker", ["info"], { stdio: "ignore" }).status !== 0) {
  console.error("Docker isn't running. Install Docker Desktop (https://www.docker.com/products/docker-desktop/), start it, and try again.");
  process.exit(1);
}

if (!existsSync(envFile)) {
  const hex = (bytes) => randomBytes(bytes).toString("hex");
  writeFileSync(
    envFile,
    [
      "# Secrets for the Crewtavo instance on this computer (npm run instance). Keep this file:",
      "# the database and every sign-in depend on these values.",
      `POSTGRES_PASSWORD=${hex(24)}`,
      `JWT_SECRET=${hex(32)}`,
      "",
      "# The address you open Crewtavo at, and the port on this computer.",
      "APP_URL=http://localhost:8080",
      "CREWTAVO_PORT=8080",
      "",
      "# Optional features (see docs/deploy.md), e.g. RESEND_API_KEY=, TWILIO_ACCOUNT_SID=, STRIPE_SECRET_KEY=",
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  console.log("Wrote .env.instance with new secrets.");
}

const command = process.argv[2];
if (command === "stop") process.exit(compose("stop"));
if (command === "logs") process.exit(compose("logs", "-f", "--tail", "100"));

const url = readFileSync(envFile, "utf8").match(/^APP_URL=(.+)$/m)?.[1]?.trim() || "http://localhost:8080";
const port = readFileSync(envFile, "utf8").match(/^CREWTAVO_PORT=(\d+)$/m)?.[1] ?? "8080";

/** Starts (or updates) every service and waits until Crewtavo answers. */
async function start(waiting) {
  // --remove-orphans: services an older version had (such as realtime) are stopped and removed.
  if (compose("up", "--build", "--detach", "--remove-orphans") !== 0) process.exit(1);
  process.stdout.write(waiting);
  const deadline = Date.now() + 10 * 60_000;
  for (;;) {
    const ok = await fetch(`http://localhost:${port}/api/health`).then((r) => r.ok, () => false);
    if (ok) break;
    if (Date.now() > deadline) {
      console.log("\nStill not answering after 10 minutes. See what's happening with: npm run instance -- logs");
      process.exit(1);
    }
    process.stdout.write(".");
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }
  console.log("");
}

if (command === "restore") {
  const file = process.argv[3] && resolve(process.argv[3]);
  if (!file || !existsSync(file)) {
    console.error("Name the backup file: npm run instance -- restore path/to/crewtavo-backup.dump");
    process.exit(1);
  }
  // The instance is brought up first (a new one sets itself up), then everything but the database
  // stops while the backup goes in, so nothing reads a database that's being replaced.
  await start("Starting Crewtavo before restoring");
  if (compose("stop", "crewtavo", "auth", "rest", "storage") !== 0) process.exit(1);
  const restored = compose("run", "--rm", "--no-deps", "-v", `${dirname(file)}:/backup:ro`, "crewtavo", "node", "scripts/restore.mjs", `/backup/${basename(file)}`, ...process.argv.slice(4));
  // Started again either way: a restore that failed changed nothing.
  await start("Starting Crewtavo again");
  if (restored !== 0) process.exit(restored);
  console.log(`The backup is restored. Crewtavo is running at ${url}`);
  process.exit(0);
}

await start("Waiting for Crewtavo to start (the first time takes a couple of minutes)");
console.log(`Crewtavo is running at ${url}`);
