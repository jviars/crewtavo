/**
 * A quote that offers two options: the client picks the second in the customer portal, adds their
 * initials to the section that asks for them, and signs; the office turns it into a job, which gets
 * the shared lines and that option's, and none of the other's.
 */
import { expect, expectAccessible, makeClient, must, test } from "./support/fixtures";

test("two options → the client picks the second, initials and signs → a job with only its lines", async ({ as, browser, data }) => {
  const client = await makeClient(data, "Options");
  // A section of the contract that asks for the client's initials, on this job only.
  const section = must(
    await data.db
      .from("contract_sections")
      .insert({ company_id: data.id, title: "Your right to cancel", body: "<p>{Customer name} may cancel within three business days.</p>", place: "signatures", initials: true })
      .select("id")
      .single(),
    "contract section",
  );
  try {
    const quote = must(
      await data.db.from("quotes").insert({ company_id: data.id, client_id: client.id, property_id: client.propertyId, title: "Driveway options", tax_rate: 0, section_ids: [section.id] }).select("id").single(),
      "quote",
    );
    const options = must(
      await data.db
        .from("quote_options")
        .insert([
          { company_id: data.id, quote_id: quote.id, name: "Sealcoat only", tier: "Good", highlights: ["One coat of sealer"], warranty: "1-year workmanship warranty", sort: 0 },
          { company_id: data.id, quote_id: quote.id, name: "Sealcoat and crack fill", tier: "Better", highlights: ["Two coats", "Hot crack fill"], warranty: "2-year workmanship warranty", sort: 1 },
        ])
        .select("id, name"),
      "options",
    );
    const basic = options.find((o) => o.name === "Sealcoat only")!;
    const better = options.find((o) => o.name === "Sealcoat and crack fill")!;
    must(
      await data.db
        .from("quote_line_items")
        .insert([
          { company_id: data.id, quote_id: quote.id, option_id: null, name: "Edge and clean", quantity: 1, unit: "job", unit_price: 150, taxable: false, sort: 1 },
          { company_id: data.id, quote_id: quote.id, option_id: basic.id, name: "One coat of sealer", quantity: 1, unit: "job", unit_price: 600, taxable: false, sort: 2 },
          { company_id: data.id, quote_id: quote.id, option_id: better.id, name: "Two coats and crack fill", quantity: 1, unit: "job", unit_price: 950, taxable: false, sort: 3 },
        ])
        .select("id"),
      "lines",
    );

    // Sent by email from the office; the dialog shows the client's link.
    const page = await as("owner");
    await page.goto(`/quotes/${quote.id}`);
    await page.getByRole("button", { name: "Send quote" }).click();
    const send = page.getByRole("dialog", { name: "Send quote" });
    await send.getByRole("button", { name: "Send email" }).click();
    const sent = page.getByRole("dialog", { name: "Sent" });
    const token = (await sent.getByRole("textbox").inputValue()).match(/\/hub\/([\w.-]+)/)?.[1];
    expect(token, "the client link").toBeTruthy();
    await sent.getByRole("button", { name: "Done" }).click();

    // The client compares the two and picks the second. The page is #root: the copy that prints sits
    // beside it, hidden, with the same words.
    const portal = await (await browser.newContext()).newPage();
    await portal.goto(`/hub/${token}`);
    const hub = portal.locator("#root");
    await expect(hub.getByRole("heading", { name: "Choose your option" })).toBeVisible();
    await expect(hub.getByRole("heading", { name: "Sealcoat only" })).toBeVisible();
    await expect(hub.getByRole("heading", { name: "Sealcoat and crack fill" })).toBeVisible();
    await expectAccessible(portal, "choosing an option in the customer portal");
    await hub.getByRole("button", { name: "Choose this one (Sealcoat and crack fill)" }).click();
    await expect(hub.getByRole("button", { name: "Your choice (Sealcoat and crack fill)" })).toHaveAttribute("aria-pressed", "true");
    const included = hub.getByRole("region", { name: "What's included" });
    await expect(included).toContainText("Two coats and crack fill");
    await expect(included).toContainText("Edge and clean");
    await expect(included).not.toContainText("One coat of sealer");
    await expect(included).toContainText("$1,100.00");

    // The agreement, with the section that asks for initials: drawn once, then added to it.
    await hub.getByRole("button", { name: "Review the agreement" }).click();
    await expect(hub.getByRole("heading", { name: "Review the agreement" })).toBeVisible();
    await expect(hub.getByRole("region", { name: "The agreement", exact: true })).toContainText("may cancel within three business days");
    await expect(hub.getByRole("button", { name: "Continue to sign" })).toBeDisabled();
    const initialsPad = hub.getByRole("img", { name: "Draw your initials" });
    await initialsPad.scrollIntoViewIfNeeded();
    const initials = await initialsPad.boundingBox();
    await portal.mouse.move(initials!.x + 30, initials!.y + 60);
    await portal.mouse.down();
    await portal.mouse.move(initials!.x + 60, initials!.y + 25, { steps: 5 });
    await portal.mouse.move(initials!.x + 90, initials!.y + 60, { steps: 5 });
    await portal.mouse.up();
    await hub.getByRole("button", { name: "Add my initials to Your right to cancel" }).click();
    await expectAccessible(portal, "reviewing the agreement in the customer portal");
    await hub.getByRole("button", { name: "Continue to sign" }).click();

    // Signed for the option picked, at its price.
    await hub.getByLabel("Your full name").fill("Pat Client");
    const signaturePad = hub.getByRole("img", { name: /Sign with your finger or mouse/ });
    await signaturePad.scrollIntoViewIfNeeded();
    const pad = await signaturePad.boundingBox();
    await portal.mouse.move(pad!.x + 30, pad!.y + 80);
    await portal.mouse.down();
    await portal.mouse.move(pad!.x + 90, pad!.y + 50, { steps: 5 });
    await portal.mouse.move(pad!.x + 160, pad!.y + 90, { steps: 5 });
    await portal.mouse.up();
    await hub.getByRole("checkbox", { name: /I approve this quote for \$1,100\.00 \(Better · Sealcoat and crack fill\)/ }).check();
    await hub.getByRole("button", { name: "Approve quote" }).click();
    await expect(hub.getByText(/^Signed on/)).toBeVisible();
    await expect(hub.getByRole("region", { name: /Signed estimate/ })).toContainText("Your choice: Better · Sealcoat and crack fill");
    await portal.context().close();

    // Kept with the signature: the option chosen, and the contract as signed, initialed.
    const signed = must(await data.db.from("quotes").select("status, option_id, total, approval").eq("id", quote.id).single(), "signed quote");
    expect(signed).toMatchObject({ status: "approved", option_id: better.id });
    expect(Number(signed.total)).toBe(1100);
    expect(signed.approval).toMatchObject({
      option: { id: better.id, name: "Sealcoat and crack fill", tier: "Better" },
      contract: { sections: [{ id: section.id, title: "Your right to cancel", initials: true, initialed: true, body: `<p>${client.name} may cancel within three business days.</p>` }] },
      initials: { image: expect.stringMatching(/^data:image\/png;base64,/) },
    });

    // The office turns it into a job: the shared line and the chosen option's, never the other's.
    await page.reload();
    await expect(page.getByText("Approved", { exact: true }).first()).toBeVisible();
    await page.getByRole("button", { name: "Convert to job" }).first().click();
    await expect(page).toHaveURL(/\/jobs\/[0-9a-f-]{36}$/);
    const table = page.getByRole("table", { name: "Line items" });
    await expect(table).toContainText("Two coats and crack fill");
    await expect(table).toContainText("Edge and clean");
    await expect(table).not.toContainText("One coat of sealer");
    const jobId = page.url().split("/jobs/")[1]!;
    const jobLines = must(await data.db.from("job_line_items").select("name").eq("job_id", jobId), "job lines");
    expect(jobLines.map((l) => l.name).sort()).toEqual(["Edge and clean", "Two coats and crack fill"]);
  } finally {
    // The demo company's library stays as it was; the signed copy keeps the words it was signed with.
    await data.db.from("contract_sections").delete().eq("id", section.id);
  }
});
