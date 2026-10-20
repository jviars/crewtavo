#!/usr/bin/env node
/**
 * `npm run screenshots`: retakes the README's screenshots (docs/images) from a running Crewtavo,
 * signed in as a demo account. With the local stack running and `npm run seed:demo` loaded:
 *
 *   npm run dev:api        # in one terminal
 *   npm run dev            # in another
 *   npm run screenshots
 *
 * Settings (environment variables):
 *   CREWTAVO_URL                  the app (default http://localhost:5173)
 *   CREWTAVO_DEMO_EMAIL           the owner to sign in as (default: the seed-demo owner)
 *   CREWTAVO_DEMO_PASSWORD        their password (default: the seed-demo password)
 *   CREWTAVO_FIELD_EMAIL          a crew lead in the same company, for the phone shots
 *                                 (default: the seed-demo foreman; same password)
 *   CREWTAVO_SCREENSHOTS          only these, comma-separated (default: all)
 *
 * Needs Chromium for Playwright once: npx playwright install chromium
 */
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "docs/images");
const BASE = (process.env.CREWTAVO_URL ?? "http://localhost:5173").replace(/\/$/, "");
const EMAIL = process.env.CREWTAVO_DEMO_EMAIL ?? "demo@crewtavo.test";
const PASSWORD = process.env.CREWTAVO_DEMO_PASSWORD ?? "crewtavo-demo";
const FIELD_EMAIL = process.env.CREWTAVO_FIELD_EMAIL ?? "marcus@crewtavo.test";
const ONLY = process.env.CREWTAVO_SCREENSHOTS?.split(",").map((s) => s.trim());

const DESKTOP = { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 };
const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true };

mkdirSync(out, { recursive: true });
const browser = await chromium.launch();

async function signedIn(email, options, colorScheme = "light") {
  const context = await browser.newContext({ ...options, colorScheme, reducedMotion: "reduce", locale: "en-US", timezoneId: "America/New_York" });
  const page = await context.newPage();
  await page.goto(`${BASE}/`);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  // Signed in once Home greets them by name.
  await page.getByRole("heading", { level: 1, name: /^(Good|Welcome|Hi)\b/ }).waitFor({ timeout: 30_000 });
  return page;
}

/** Waits for data and charts to settle: no requests in flight and no loading placeholders. */
async function settle(page) {
  await page.waitForLoadState("networkidle");
  await page.waitForFunction(() => !document.querySelector(".skeleton, [aria-busy='true']"), null, { timeout: 15_000 }).catch(() => {});
  await page.waitForTimeout(600);
}

async function shot(page, name, path) {
  if (ONLY && !ONLY.includes(name)) return;
  if (path) await page.goto(`${BASE}${path}`);
  await settle(page);
  await page.screenshot({ path: join(out, `${name}.png`) });
  console.log(`docs/images/${name}.png`);
}

// --- The office, on a desktop ---------------------------------------------------------------------
const office = await signedIn(EMAIL, DESKTOP);
await shot(office, "dashboard", "/");
// The week gets the whole width: the Unscheduled panel starts closed.
await office.evaluate(() => localStorage.setItem("crewtavo.schedule.panel", "closed"));
await shot(office, "schedule", "/schedule?view=week");
await shot(office, "pipeline", "/pipeline");
await shot(office, "finance", "/finance");
await shot(office, "equipment", "/equipment");
await shot(office, "knowledge-base", "/kb");

// A sent quote, and the client's view of it in the Client Hub ("Preview as client").
await office.goto(`${BASE}/quotes`);
await settle(office);
await office.getByRole("link").filter({ hasText: /driveway replacement/i }).first().click();
await office.waitForURL(/\/quotes\/[\w-]+$/);
await shot(office, "quote");
await office.getByRole("button", { name: "More actions" }).click();
const [preview] = await Promise.all([office.context().waitForEvent("page"), office.getByRole("menuitem", { name: "Preview as client" }).click()]);
await preview.waitForURL(/\/hub\//);
const hubPath = new URL(preview.url()).pathname;
await office.context().close();

const dark = await signedIn(EMAIL, DESKTOP, "dark");
await shot(dark, "dashboard-dark", "/");
await dark.context().close();

// --- Clients and crews, on phones -----------------------------------------------------------------
const client = await (await browser.newContext({ ...PHONE, reducedMotion: "reduce", locale: "en-US" })).newPage();
await shot(client, "client-hub", hubPath);
await client.context().close();

const crew = await signedIn(FIELD_EMAIL, PHONE);
await shot(crew, "field", "/field");
await crew.context().close();

await browser.close();
