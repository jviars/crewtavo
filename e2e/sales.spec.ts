/**
 * The office's core path: a new client calls in, their request becomes a quote, the client approves
 * it in the customer portal (signed link, no account), and the quote becomes a job.
 */
import { expect, expectAccessible, must, test, unique } from "./support/fixtures";

test("new client → request → quote → approved in the portal → job", async ({ as, browser, data }) => {
  const page = await as("owner");
  const name = unique("Client");
  const email = `${name.toLowerCase().replace(/\W+/g, ".")}@example.com`;

  // A new client with a service address.
  await page.goto("/clients");
  await expect(page.getByRole("heading", { level: 1, name: "Clients" })).toBeVisible();
  await page.getByRole("button", { name: "New client" }).click();
  const newClient = page.getByRole("dialog", { name: "New client" });
  await newClient.getByLabel("Name", { exact: true }).fill(name);
  await newClient.getByLabel("Email").fill(email);
  await newClient.getByLabel("Phone").fill("(540) 555-0142");
  await newClient.getByLabel("Street address").fill("88 Orchard Way");
  await newClient.getByLabel("City").fill("Roanoke");
  await newClient.getByLabel("State").fill("VA");
  await newClient.getByLabel("ZIP").fill("24014");
  await newClient.getByRole("button", { name: "Create client" }).click();
  await expect(page.getByRole("heading", { level: 1, name })).toBeVisible();
  await expect(page.getByText("88 Orchard Way").first()).toBeVisible();
  await expectAccessible(page, "a new client's page");

  // Their request.
  await page.getByRole("button", { name: "New request" }).click();
  const newRequest = page.getByRole("dialog", { name: "New request" });
  await newRequest.getByLabel("What do they need?").fill("Driveway sealcoat");
  await newRequest.getByRole("button", { name: "Create request" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Driveway sealcoat" })).toBeVisible();
  await expectAccessible(page, "a request");

  // A quote from it, with one priced line.
  await page.getByRole("button", { name: "Create quote" }).click();
  await expect(page).toHaveURL(/\/quotes\/[0-9a-f-]{36}$/);
  await page.getByRole("button", { name: "Custom item" }).click();
  const line = page.getByRole("row").filter({ has: page.getByLabel("Item name") }).last();
  await line.getByLabel("Item name").fill("Sealcoat and crack fill");
  await line.getByLabel("Quantity").fill("1");
  await line.getByLabel("Unit price").fill("845");
  await line.getByLabel("Unit price").press("Enter");
  await expect(page.getByText("$845.00").first()).toBeVisible();
  await expectAccessible(page, "a draft quote");

  // Sent by email; the dialog shows the client's link.
  await page.getByRole("button", { name: "Send quote" }).click();
  const send = page.getByRole("dialog", { name: "Send quote" });
  await expect(send.getByRole("textbox", { name: "To", exact: true })).toHaveValue(email);
  await send.getByRole("button", { name: "Send email" }).click();
  const sent = page.getByRole("dialog", { name: "Sent" });
  await expect(sent.getByText(`Emailed to ${email}`)).toBeVisible();
  const link = await sent.getByRole("textbox").inputValue();
  const token = link.match(/\/hub\/([\w.-]+)/)?.[1];
  expect(token, "the client link").toBeTruthy();
  await sent.getByRole("button", { name: "Done" }).click();

  // The client approves in the customer portal, without an account. The page is #root: the copy
  // that prints (and the one measured for its pages) sits beside it, hidden, with the same words.
  const portal = await (await browser.newContext()).newPage();
  await portal.goto(`/hub/${token}`);
  const hub = portal.locator("#root");
  await expect(hub.getByText("Sealcoat and crack fill").first()).toBeVisible();
  // The agreement first (the template's terms), on the paper it prints on, then signing.
  await expect(hub.getByRole("heading", { name: "Review the agreement" })).toBeVisible();
  await expectAccessible(portal, "the customer portal quote");
  await hub.getByRole("button", { name: "Continue to sign" }).click();
  await hub.getByLabel("Your full name").fill("Pat Client");
  // Sign on the pad: a short stroke with the mouse.
  const signaturePad = hub.getByRole("img", { name: /Sign with your finger or mouse/ });
  await signaturePad.scrollIntoViewIfNeeded();
  const pad = await signaturePad.boundingBox();
  await portal.mouse.move(pad!.x + 30, pad!.y + 80);
  await portal.mouse.down();
  await portal.mouse.move(pad!.x + 90, pad!.y + 50, { steps: 5 });
  await portal.mouse.move(pad!.x + 160, pad!.y + 90, { steps: 5 });
  await portal.mouse.up();
  await hub.getByRole("checkbox", { name: /I approve this quote/ }).check();
  await hub.getByRole("button", { name: "Approve quote" }).click();
  await expect(hub.getByText(/^Signed on/)).toBeVisible();
  await portal.context().close();

  // Back in the office the quote shows as approved and becomes a job.
  await page.reload();
  await expect(page.getByText("Approved", { exact: true }).first()).toBeVisible();
  await page.getByRole("button", { name: "Convert to job" }).first().click();
  await expect(page).toHaveURL(/\/jobs\/[0-9a-f-]{36}$/);
  await expect(page.getByRole("heading", { level: 1, name: "Driveway sealcoat" })).toBeVisible();
  await expect(page.getByRole("table", { name: "Line items" })).toContainText("Sealcoat and crack fill");
  await expectAccessible(page, "a new job");

  const jobId = page.url().split("/jobs/")[1]!;
  const job = must(await data.db.from("jobs").select("status, client:clients(display_name, status)").eq("id", jobId).single(), "job");
  expect(job.status).toBe("active");
  expect(job.client).toMatchObject({ display_name: name, status: "active" });
});
