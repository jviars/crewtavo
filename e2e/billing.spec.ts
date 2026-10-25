/**
 * Getting paid: invoice a finished job, send it, record the client's check, and the client sees
 * it paid in the portal.
 */
import { expect, expectAccessible, makeJob, must, test } from "./support/fixtures";

test("invoice a job, send it, and record the payment", async ({ as, browser, data }) => {
  const job = await makeJob(data, "Billing", { price: 1250 });
  const page = await as("owner");

  await page.goto(`/jobs/${job.id}`);
  await expect(page.getByRole("heading", { level: 1, name: job.title })).toBeVisible();
  await page.getByRole("button", { name: "Create invoice" }).first().click();
  const create = page.getByRole("dialog", { name: "Create invoice" });
  await expectAccessible(page, "the create invoice dialog");
  await create.getByRole("button", { name: "Create invoice" }).click();

  // The new invoice carries the job's line.
  await expect(page).toHaveURL(/\/invoices\/[0-9a-f-]{36}$/);
  const invoiceId = page.url().split("/invoices/")[1]!;
  const main = page.getByRole("main");
  await expect(main.getByText("Driveway sealcoat").first()).toBeVisible();
  await expect(main.getByText("$1,250.00").first()).toBeVisible();
  await expectAccessible(page, "a draft invoice");

  // Sent by email; the dialog shows the client's link.
  await page.getByRole("button", { name: "Send invoice" }).click();
  const send = page.getByRole("dialog", { name: "Send invoice" });
  await send.getByRole("button", { name: "Send email" }).click();
  const sent = page.getByRole("dialog", { name: "Sent" });
  const token = (await sent.getByRole("textbox").inputValue()).match(/\/hub\/([\w.-]+)/)?.[1];
  expect(token, "the client link").toBeTruthy();
  await sent.getByRole("button", { name: "Done" }).click();
  await expect.poll(async () => must(await data.db.from("invoices").select("status").eq("id", invoiceId).single(), "invoice").status).toBe("sent");

  // The client pays by check; the office records it.
  await page.getByRole("button", { name: "Record payment" }).click();
  const payment = page.getByRole("dialog", { name: "Record payment" });
  await expect(payment.getByLabel("Amount")).toHaveValue("1250.00");
  await payment.getByLabel("Method").selectOption("check");
  await payment.getByLabel("Reference").fill("Check #4417");
  await expectAccessible(page, "the record payment dialog");
  await payment.getByRole("button", { name: "Record $1,250.00" }).click();
  await expect(payment).toBeHidden();
  await expect(main.getByText(/Check #4417/)).toBeVisible();
  await expectAccessible(page, "a paid invoice");

  const invoice = must(await data.db.from("invoices").select("status, balance_due, total").eq("id", invoiceId).single(), "paid invoice");
  expect(invoice).toMatchObject({ status: "paid" });
  expect(Number(invoice.balance_due)).toBe(0);
  expect(Number(invoice.total)).toBe(1250);

  // The client's portal shows it paid, with nothing left to pay. The page is #root: the copy that
  // prints (and the one measured for its pages) sits beside it, hidden, with the same words.
  const portal = await (await browser.newContext()).newPage();
  await portal.goto(`/hub/${token}`);
  const hub = portal.locator("#root");
  await expect(hub.getByText("Driveway sealcoat").first()).toBeVisible();
  await expect(hub.getByText(/paid/i).first()).toBeVisible();
  // The invoice itself, on the paper it prints on.
  await expect(hub.getByRole("region", { name: /as it prints/ })).toContainText("Driveway sealcoat");
  await expect(hub.getByRole("button", { name: /^Pay / })).toHaveCount(0);
  await expectAccessible(portal, "a paid invoice in the customer portal");
  await portal.context().close();
});
