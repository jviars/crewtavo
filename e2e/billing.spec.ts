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
  await expect(main.getByText("$1,250.00").filter({ visible: true }).first()).toBeVisible();
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
  // On a computer the method is a list of its own (components/ui/Select), not the browser's.
  await payment.getByRole("combobox", { name: "Method" }).click();
  await page.getByRole("option", { name: "Check" }).click();
  await expect(payment.getByRole("combobox", { name: "Method" })).toHaveText(/Check/);
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

  // In Safari, Print opens the invoice as a PDF the server makes, in a new tab: the page asks the
  // link for a print ticket first and sends it with the invoice, in the form, never in the address.
  // (This browser says it's Safari: navigator.vendor is what the page goes by.)
  const safari = await browser.newContext();
  await safari.addInitScript(() => Object.defineProperty(Navigator.prototype, "vendor", { get: () => "Apple Computer, Inc." }));
  const client = await safari.newPage();
  await client.goto(`/hub/${token}`);
  await expect(client.locator("#root").getByText("Driveway sealcoat").first()).toBeVisible();
  const ticket = client.waitForResponse((r) => r.url().endsWith("/print-ticket"));
  const made = safari.waitForEvent("response", (r) => r.url().includes("/api/public/documents/"));
  await client.getByRole("button", { name: "Print or save as PDF" }).click();
  expect((await ticket).status()).toBe(200);
  const pdf = await made;
  expect(pdf.status()).toBe(200);
  expect(pdf.headers()["content-type"]).toBe("application/pdf");
  expect(new URL(pdf.url()).search).toBe("");
  // Without a ticket, the server makes none.
  const bare = await client.request.post(new URL(pdf.url()).pathname, { form: { document: "{}" } });
  expect(bare.status()).toBe(403);
  await safari.close();
});
