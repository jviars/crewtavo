#!/usr/bin/env node
/**
 * `npm run instance`: run a whole Crewtavo instance on this computer with Docker, the same services
 * the Railway template creates (docker-compose.yml, deploy/README.md). The first run writes
 * .env.instance with random secrets; keep that file, since the database is locked with them.
 *
 *   npm run instance            start (or update) it, then print the address
 *   npm run instance -- stop    stop it; the data stays
 *   npm run instance -- logs    follow the logs
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
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

// --remove-orphans: services an older version had (such as realtime) are stopped and removed.
if (compose("up", "--build", "--detach", "--remove-orphans") !== 0) process.exit(1);

const url = readFileSync(envFile, "utf8").match(/^APP_URL=(.+)$/m)?.[1]?.trim() || "http://localhost:8080";
const port = readFileSync(envFile, "utf8").match(/^CREWTAVO_PORT=(\d+)$/m)?.[1] ?? "8080";
process.stdout.write("Waiting for Crewtavo to start (the first time takes a couple of minutes)");
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
console.log(`\nCrewtavo is running at ${url}`);
