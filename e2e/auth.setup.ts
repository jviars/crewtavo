/**
 * Signs in through the real sign-in screen once per demo account and saves the browser state, so
 * the other tests start signed in (Supabase keeps the session in localStorage). The demo sub has no
 * password: they're signed in with a one-time link made with the server's key, the way the office's
 * Text sign-in link signs a sub in.
 */
import { test as setup, expect } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { authFile, PASSWORD, PEOPLE, SUPABASE_SECRET, SUPABASE_URL, withPassword, type Person } from "./support/env";

setup("sign in as the sub, with a one-time link", async ({ page }) => {
  if (!SUPABASE_URL || !SUPABASE_SECRET) throw new Error("No Supabase server key: fill in .dev.vars (see e2e/README.md).");
  const admin = createClient(SUPABASE_URL, SUPABASE_SECRET, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await admin.auth.admin.generateLink({ type: "magiclink", email: PEOPLE.sub.email });
  if (error || !data.properties?.hashed_token) throw new Error(`Couldn't make the demo sub's sign-in link (${error?.message ?? "no token"}). Run npm run seed:demo.`);
  await page.goto(`/?token_hash=${encodeURIComponent(data.properties.hashed_token)}&type=magiclink`);
  // A sub lands on My day.
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("heading", { name: "Sign in" })).toHaveCount(0);
  await page.context().storageState({ path: authFile("sub") });
});

for (const who of (Object.keys(PEOPLE) as Person[]).filter(withPassword)) {
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
      await page.getByRole("checkbox", { name: /agree to the Crewtavo Terms/ }).check();
      await page.getByRole("button", { name: "Agree and continue" }).click();
    }
    await expect(home).toBeVisible({ timeout: 20_000 });
    await page.context().storageState({ path: authFile(who) });
  });
}
