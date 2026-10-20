/**
 * axe-core scans (WCAG 2.1 A and AA) of each main screen with the demo company's data. The flow
 * tests scan the screens they pass through too; this covers the rest of the navigation.
 */
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
