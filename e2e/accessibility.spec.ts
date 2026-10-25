/**
 * axe-core scans (WCAG 2.1 A and AA) of each main screen with the demo company's data. The flow
 * tests scan the screens they pass through too; this covers the rest of the navigation.
 */
import { DEMO_SUB_ID } from "./support/env";
import { expect, expectAccessible, must, PHONE, test, type Company } from "./support/fixtures";

const OFFICE_SCREENS: Array<[string, string]> = [
  ["/", "Home"],
  ["/schedule", "Schedule"],
  ["/clients", "Clients"],
  ["/requests", "Requests"],
  ["/quotes", "Quotes"],
  ["/jobs", "Jobs"],
  ["/invoices", "Invoices"],
  ["/marketing", "Marketing"],
  ["/finance", "Finance"],
  ["/metrics", "Metrics"],
  ["/timesheets", "Timesheets"],
  ["/equipment", "Equipment"],
  ["/subs", "Subcontractors"],
  ["/subs/1099", "Year-end totals"],
  ["/subs/workers-comp", "Workers' comp audit"],
  ["/kb", "Knowledge base"],
  ["/settings", "Settings"],
];

async function firstId(data: Company, table: "clients" | "quotes" | "jobs" | "invoices" | "equipment" | "requests") {
  const row = must(await data.db.from(table).select("id").eq("company_id", data.id).order("created_at").limit(1).single(), `a ${table} row`);
  return row.id as string;
}

test.describe("accessibility", () => {
  for (const [path, name] of OFFICE_SCREENS) {
    test(`${name} screen`, async ({ as }) => {
      const page = await as("owner");
      await page.goto(path);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await expect(page.locator(".skeleton")).toHaveCount(0);
      await expectAccessible(page, name);
    });
  }

  test("detail screens", async ({ as, data }) => {
    const page = await as("owner");
    for (const [table, path] of [["clients", "/clients/"], ["requests", "/requests/"], ["quotes", "/quotes/"], ["jobs", "/jobs/"], ["invoices", "/invoices/"], ["equipment", "/equipment/"]] as const) {
      await page.goto(path + (await firstId(data, table)));
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await expect(page.locator(".skeleton")).toHaveCount(0);
      await expectAccessible(page, `a ${table.replace(/s$/, "")} page`);
    }
  });

  test("schedule week view", async ({ as }) => {
    const page = await as("owner");
    await page.goto("/schedule");
    await page.getByRole("group", { name: "View" }).getByRole("button", { name: "Week" }).click();
    await expect(page.getByRole("grid", { name: "Schedule" })).toBeVisible();
    await expectAccessible(page, "Schedule (week)");
  });

  test("a sub's page, with their paperwork, pay and sign-in", async ({ as }) => {
    const page = await as("owner");
    await page.goto(`/subs/${DEMO_SUB_ID}`);
    await expect(page.getByRole("heading", { level: 1, name: "Precision Striping LLC" })).toBeVisible();
    await expect(page.locator(".skeleton")).toHaveCount(0);
    await expectAccessible(page, "a sub's page");
  });

  test("a sub's own screens, on a phone", async ({ as }) => {
    const page = await as("sub", PHONE);
    for (const [path, name] of [["/field", "My day"], ["/field/jobs", "My jobs"], ["/field/paperwork", "My paperwork"], ["/settings?tab=profile", "Profile"]] as const) {
      await page.goto(path);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await expect(page.locator(".skeleton")).toHaveCount(0);
      await expectAccessible(page, `${name} for a sub (phone)`);
    }
  });

  test("a sub's paperwork page, from the office's link", async ({ as, data, browser }) => {
    const office = await as("owner");
    const { data: session } = await data.db.auth.getSession();
    const res = await office.request.post(`/api/subs/${DEMO_SUB_ID}/upload-link`, { headers: { Authorization: `Bearer ${session.session!.access_token}`, "X-Company-Id": data.id } });
    expect(res.ok()).toBe(true);
    const { link } = (await res.json()) as { link: string };
    // Opened by the sub, with no sign-in.
    const context = await browser.newContext({ ...PHONE });
    const page = await context.newPage();
    await page.goto(new URL(link).pathname);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expectAccessible(page, "a sub's paperwork page");
    await context.close();
  });

  test("getting a sign-in code, on a phone", async ({ browser }) => {
    const context = await browser.newContext({ ...PHONE });
    const page = await context.newPage();
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
    const offer = page.getByRole("button", { name: /^Subcontractor\? Get a sign-in code/ });
    if (await offer.count()) {
      await offer.first().click();
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await expectAccessible(page, "Get a sign-in code");
      // By email the answer is the same for any address, so a made-up one reaches the code step.
      const byEmail = page.getByRole("button", { name: /Get a code by email instead|No phone on file/ });
      if (await byEmail.count()) await byEmail.first().click();
      const email = page.getByLabel("Email");
      if (await email.count()) {
        await email.fill("nobody-pw-test@example.com");
        await page.getByRole("button", { name: "Email me a code" }).click();
        await expect(page.getByRole("heading", { level: 1, name: "Enter your code" })).toBeVisible();
        await expectAccessible(page, "Enter your code");
      }
    }
    await context.close();
  });

  test("My day and Home for the crew, on a phone", async ({ as }) => {
    const page = await as("foreman", PHONE);
    await page.goto("/field");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page.locator(".skeleton")).toHaveCount(0);
    await expectAccessible(page, "My day (phone)");
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expectAccessible(page, "Home (phone)");
  });
});
