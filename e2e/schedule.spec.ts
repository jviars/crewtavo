/**
 * Scheduling: book a visit of any length for a job, then move it by dragging it on the Schedule's
 * day grid.
 */
import { dateIn, expect, expectAccessible, makeJob, must, test, zonedIso } from "./support/fixtures";

test("schedule a visit, then drag it to a new time on the Schedule", async ({ as, data }) => {
  const job = await makeJob(data, "Schedule");
  // A quiet day a month out, so nothing else on the grid gets in the way.
  const day = dateIn(data.timezone, 30);
  const at = (time: string) => new Date(zonedIso(day, time, data.timezone)).getTime();
  const visitTimes = async () => {
    const row = must(await data.db.from("visits").select("id, starts_at, ends_at, crew_id").eq("job_id", job.id).single(), "the visit");
    return { ...row, start: new Date(row.starts_at!).getTime(), end: new Date(row.ends_at!).getTime() };
  };
  const page = await as("owner");

  await page.goto(`/jobs/${job.id}`);
  await expect(page.getByRole("heading", { level: 1, name: job.title })).toBeVisible();
  await page.getByRole("button", { name: "Add visit" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByLabel("Title")).toHaveValue(job.title);
  await dialog.getByLabel("Date", { exact: true }).fill(day);
  await dialog.getByLabel("Anytime that day").uncheck();
  await dialog.getByLabel("Starts").fill("09:00");
  // Any length, like Google Calendar: 50 minutes.
  await dialog.getByLabel("Ends").fill("09:50");
  await expect(dialog.getByText("50 min")).toBeVisible();
  await expect(dialog.getByLabel("Crew", { exact: true })).toHaveValue(job.crewId);
  await expectAccessible(page, "the visit dialog");
  await dialog.getByRole("button", { name: "Schedule", exact: true }).click();
  await expect(dialog).toBeHidden();

  const booked = await visitTimes();
  expect(booked.start).toBe(at("09:00"));
  expect(booked.end).toBe(at("09:50"));
  expect(booked.crew_id).toBe(job.crewId);

  // On the Schedule's day view, drag it two hours later.
  await page.goto(`/schedule?date=${day}`);
  await page.getByRole("group", { name: "View" }).getByRole("button", { name: "Day" }).click();
  const grid = page.getByRole("grid", { name: "Schedule" });
  const card = grid.getByRole("button", { name: new RegExp(job.title) });
  await expect(card).toBeVisible();
  await expectAccessible(page, "the Schedule (day)");

  const column = grid.locator(`[data-drop="slot"][data-crew="${job.crewId}"]`);
  const ppm = Number(await column.getAttribute("data-ppm"));
  await card.scrollIntoViewIfNeeded();
  const box = (await card.boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + 6;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y + 10, { steps: 2 });
  await page.mouse.move(x, y + 120 * ppm, { steps: 12 });
  await page.mouse.up();

  // The toast says where it went and offers Undo.
  await expect(page.getByText(/ at 11 AM/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Undo" })).toBeVisible();
  await expect.poll(async () => (await visitTimes()).start).toBe(at("11:00"));
  await expect(card).toContainText("11:00 AM");
  // Moving keeps the length.
  expect((await visitTimes()).end).toBe(at("11:50"));
});
