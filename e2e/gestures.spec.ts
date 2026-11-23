/**
 * What a finger does on a phone: pulling the More sheet and a dialog's sheet down to close them,
 * and holding a row on a list to pick it. Real touches through Chrome's DevTools protocol, since
 * Playwright's own tap() can't drag or hold.
 */
import type { CDPSession, Page } from "@playwright/test";
import { expect, makeJob, PHONE, test, unique } from "./support/fixtures";

type Point = { x: number; y: number };

async function touches(page: Page): Promise<CDPSession> {
  return page.context().newCDPSession(page);
}

/** A finger put down at `from`, moved to `to` in steps, and lifted. */
async function drag(cdp: CDPSession, from: Point, to: Point, steps = 12) {
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [from] });
  for (let i = 1; i <= steps; i++) {
    const at = { x: from.x + ((to.x - from.x) * i) / steps, y: from.y + ((to.y - from.y) * i) / steps };
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [at] });
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}

/** A finger held still at `at` for `ms`, then lifted. */
async function hold(page: Page, cdp: CDPSession, at: Point, ms: number) {
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [at] });
  await page.waitForTimeout(ms);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}

async function centre(page: Page, selector: string): Promise<Point> {
  const box = await page.locator(selector).first().boundingBox();
  if (!box) throw new Error(`${selector} isn't on the screen`);
  return { x: box.x + box.width / 2, y: box.y + Math.min(box.height / 2, 16) };
}

test("the More sheet and a dialog close when pulled down on a phone", async ({ as }) => {
  const page = await as("owner", PHONE);
  const cdp = await touches(page);
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

  // Pulled a little and let go, the More sheet springs back; pulled well down, it goes.
  await page.locator(".mobile-nav").getByRole("button", { name: "More" }).click();
  const sheet = page.getByRole("dialog", { name: "All sections" });
  await expect(sheet).toBeVisible();
  // Once it has slid all the way up, so the grip is found where it stays.
  await sheet.evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)));
  const grip = await centre(page, ".more-sheet .sheet-grab");
  await drag(cdp, grip, { x: grip.x, y: grip.y + 30 });
  await expect(sheet).toBeVisible();
  await page.waitForTimeout(600);
  await drag(cdp, grip, { x: grip.x, y: grip.y + 420 });
  await expect(sheet).toBeHidden();

  // A dialog's header is its handle on a phone.
  await page.goto("/clients?new=1");
  const dialog = page.getByRole("dialog", { name: "New client" });
  await expect(dialog).toBeVisible();
  const head = await centre(page, "dialog[open] .dialog-head");
  await drag(cdp, head, { x: head.x, y: head.y + 40 });
  await expect(dialog).toBeVisible();
  // Once it has sprung back into place.
  await page.waitForTimeout(600);
  await drag(cdp, head, { x: head.x, y: head.y + 500 });
  await expect(dialog).toBeHidden();
  await expect(page).toHaveURL(/\/clients(\?|$)/);
});

test("holding a job on a phone picks it instead of opening it", async ({ as, data }) => {
  const job = await makeJob(data, unique("Hold"));
  const page = await as("owner", PHONE);
  const cdp = await touches(page);
  await page.goto("/jobs");
  await page.getByLabel("Search jobs").fill(String(job.number));
  const row = page.locator(".il-row").filter({ hasText: job.title });
  await expect(row).toBeVisible();

  const box = await row.boundingBox();
  if (!box) throw new Error("The job's row isn't on the screen");
  await hold(page, cdp, { x: box.x + box.width / 2, y: box.y + box.height / 2 }, 800);
  await expect(page.getByRole("status").filter({ hasText: "1 selected" })).toHaveCount(1);
  await expect(row.getByRole("checkbox")).toBeChecked();
  await expect(page).toHaveURL(/\/jobs(\?|$)/);

  // A tap still opens it.
  await row.getByText(job.title).tap();
  await expect(page).toHaveURL(new RegExp(`/jobs/${job.id}`));
});
