/**
 * Error reporting in the browser: the Sentry SDK downloads only when the deployment sets a DSN,
 * and what it sends has no personal data or tokens in it.
 */
import { expect, test } from "./support/fixtures";

test("errors are reported only when a DSN is set, without personal data", async ({ page }) => {
  const sdk: string[] = [];
  page.on("request", (request) => {
    if (/\/assets\/sentry-[\w-]+\.js$/.test(request.url())) sdk.push(request.url());
  });

  // The local stack has no DSN: nothing is downloaded.
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await page.waitForLoadState("networkidle");
  expect(sdk).toEqual([]);

  // With one (as /api/config would give it), errors go out scrubbed.
  const envelopes: string[] = [];
  await page.route("**/api/config", async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, json: { ...(await response.json()), sentry: { dsn: "https://public@errors.example.com/7", environment: "browser-test" } } });
  });
  await page.route("https://errors.example.com/**", async (route) => {
    envelopes.push(route.request().postData() ?? "");
    await route.fulfill({ status: 200, body: "{}" });
  });
  await page.goto("/?search=dana@example.com#access_token=eyJhbGciOi.eyJzdWIi.c2ln");
  await expect.poll(() => sdk.length).toBe(1);
  await page.evaluate(() => {
    // A view transition skipped by a quick second navigation: normal, so not reported.
    void Promise.reject(new DOMException("Transition was skipped", "AbortError"));
    setTimeout(() => {
      throw new Error("Couldn't save dana@example.com, call (540) 555-0199");
    }, 50);
  });
  await expect.poll(() => envelopes.join("\n")).toContain("Couldn't save [email], call [phone]");
  const sent = envelopes.join("\n");
  expect(sent).toContain('"environment":"browser-test"');
  expect(sent).not.toContain("Transition was skipped");
  expect(sent).not.toMatch(/dana@example\.com|555-0199|access_token|eyJhbGciOi|search=/);
});
