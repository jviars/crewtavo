import { PASSWORD, PEOPLE } from "./support/env";
import { expect, expectAccessible, test } from "./support/fixtures";

test.describe("sign in", () => {
  test("a wrong password is explained, the right one opens Home", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
    await expectAccessible(page, "Sign in");

    await page.getByLabel("Email").fill(PEOPLE.owner.email);
    await page.getByLabel("Password", { exact: true }).fill("not-the-password");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText(/password/i);

    await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page.getByRole("heading", { level: 1, name: /Dana/ })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole("navigation").first()).toBeVisible();
  });

  test("screens are fetched in the background after sign-in", async ({ as }) => {
    const page = await as("owner");
    const screens: string[] = [];
    page.on("request", (request) => {
      const name = request.url().match(/\/assets\/([A-Za-z]+Page)-[\w-]+\.js$/)?.[1];
      if (name) screens.push(name);
    });
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1, name: /Dana/ })).toBeVisible();
    // prefetchScreens (routes.tsx) warms every screen while the browser is idle.
    // They're requested one after another, so wait for the ones checked here rather than a count.
    await expect.poll(() => screens, { timeout: 15_000 }).toEqual(expect.arrayContaining(["SchedulePage", "ClientsPage", "QuotePage", "JobPage", "InvoicePage", "FieldTodayPage", "EquipmentPage"]));
    expect(screens.length).toBeGreaterThanOrEqual(20);

    // Opening one afterwards needs no new download.
    const before = screens.length;
    await page.getByRole("navigation").first().getByRole("link", { name: "Clients" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Clients" })).toBeVisible();
    expect(screens.slice(before)).not.toContain("ClientsPage");
  });
});
