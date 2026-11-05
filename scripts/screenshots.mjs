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

/** Opens a list and follows the link to one of its rows, by the row's text. */
async function follow(page, path, text, url) {
  await page.goto(`${BASE}${path}`);
  await settle(page);
  await page.getByRole("link").filter({ hasText: text }).first().click();
  await page.waitForURL(url);
  await settle(page);
}

// --- The office, on a desktop ---------------------------------------------------------------------
const office = await signedIn(EMAIL, DESKTOP);
await shot(office, "dashboard", "/");
// The week gets the whole width: the Unscheduled panel starts closed.
await office.evaluate(() => localStorage.setItem("crewtavo.schedule.panel", "closed"));
await shot(office, "schedule", "/schedule?view=week");
await shot(office, "pipeline", "/pipeline");
await shot(office, "finance", "/finance?range=90d");
await shot(office, "equipment", "/equipment");
await shot(office, "knowledge-base", "/kb");
await shot(office, "jobs", "/jobs");
await shot(office, "invoices", "/invoices");
await shot(office, "timesheets", "/timesheets");
await shot(office, "marketing", "/marketing");
await shot(office, "automations", "/automations");
await shot(office, "apps", "/apps");
await follow(office, "/clients", /Summit Ridge Builders/, /\/clients\/[\w-]+$/);
await shot(office, "client");
await follow(office, "/jobs", /Phase 2 subdivision roads/, /\/jobs\/[\w-]+$/);
await shot(office, "job");
await follow(office, "/invoices", /Town of Rocky Mount/, /\/invoices\/[\w-]+$/);
await shot(office, "invoice");

// The paving takeoff: its drawing on the aerial, and the project it prices.
await follow(office, "/paving", /Clubhouse lot/, /\/paving\/[\w-]+$/);
const project = new URL(office.url()).pathname;
const noPicture = await office.getByText(/No picture saved yet/).isVisible();
await office.evaluate(() => localStorage.setItem("crewtavo.measureHelpSeen", "1"));
await office.getByRole("link", { name: "Edit the takeoff" }).click();
await office.waitForURL(/\/measure\?/);
await office.getByRole("button", { name: "Saved" }).waitFor();
await office.locator(".measure-tool", { hasText: "Edit" }).click(); // so no drawing hint covers the map
await office.waitForTimeout(3000); // aerial tiles
await shot(office, "measure");
if (noPicture) {
  // The seed can't draw the map picture the project shows, so save the takeoff once to make it.
  await office.getByLabel("Name this measurement").fill("Clubhouse lot "); // a change; the server trims it
  await office.getByRole("button", { name: "Save changes" }).click();
  await office.getByRole("button", { name: "Saved" }).waitFor({ timeout: 30_000 });
}
await shot(office, "paving", project);

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
await follow(crew, "/field", /Stone base/, /\/field\/visits\/[\w-]+$/);
await shot(crew, "field-visit");
await crew.context().close();

const owner = await signedIn(EMAIL, PHONE);
await shot(owner, "dashboard-phone", "/");
await owner.context().close();

await browser.close();
