/**
 * Signs in through the real sign-in screen once per demo account and saves the browser state, so
 * the other tests start signed in (Supabase keeps the session in localStorage).
 */
import { test as setup, expect } from "@playwright/test";
import { authFile, PASSWORD, PEOPLE, type Person } from "./support/env";

for (const who of Object.keys(PEOPLE) as Person[]) {
  setup(`sign in as ${who}`, async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
    await page.getByLabel("Email").fill(PEOPLE[who].email);
    await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    // Everyone lands on Home with their first name in the greeting.
    const home = page.getByRole("heading", { level: 1, name: new RegExp(PEOPLE[who].name.split(" ")[0]!) });
    // A demo company seeded before the license step asks its owner and admins to agree once.
    const terms = page.getByRole("heading", { level: 1, name: "Before you continue" });
    await expect(home.or(terms)).toBeVisible({ timeout: 20_000 });
    if (await terms.isVisible()) {
      await page.getByRole("checkbox", { name: /agree to the Crewtavo License/ }).check();
      await page.getByRole("button", { name: "Agree and continue" }).click();
    }
    await expect(home).toBeVisible({ timeout: 20_000 });
    await page.context().storageState({ path: authFile(who) });
  });
}
