/**
 * Sharing a guide by link: the owner opens Share on a guide, which starts for only the people
 * added; a stranger with the link is asked for an email address and learns nothing of the guide.
 * Opened to anyone with the link, a browser with no sign-in reads it; a new link shuts the old one.
 * A crew member has no Share. The emailed code is covered in apps/api/test/guideShares.test.ts.
 */
import { expect, expectAccessible, must, test, unique } from "./support/fixtures";

test("a guide shared by link: only people added → anyone with the link → a new link", async ({ as, browser, data }) => {
  const title = unique("Caring for new sod");
  const guide = must(
    await data.db
      .from("sop_pages")
      .insert({ company_id: data.id, title, body: { type: "html" }, body_html: '<h2>Watering</h2><p>Twice a day for two weeks.</p><h2>Mowing</h2><p>Wait until it has rooted. See <a href="/kb">our other guides</a>.</p>', body_text: "Watering Twice a day for two weeks. Mowing Wait until it has rooted." })
      .select("id")
      .single(),
    "guide",
  );
  // Someone outside the team: a browser with no sign-in.
  const outside = await browser.newContext();
  try {
    const office = await as("owner");
    await office.goto(`/kb/${guide.id}`);
    await expect(office.getByRole("heading", { level: 1, name: title })).toBeVisible();
    await office.getByRole("button", { name: "More actions" }).click();
    await office.getByRole("menuitem", { name: "Share with a link" }).click();

    const share = office.getByRole("dialog", { name: /^Share / });
    // It starts restricted, with nobody but the team.
    await expect(share.getByRole("button", { name: "General access: Restricted" })).toBeVisible();
    await expect(share.getByRole("list", { name: "People with access" }).getByRole("listitem")).toHaveText(["Your teamReads it in Crewtavo, signed in"]);
    // The link Copy link copies: /g/ and the share's token, which the owner can read.
    const linkOf = async () => `/g/${must(await data.db.from("sop_shares").select("token").eq("page_id", guide.id).single(), "share").token}`;
    const link = await linkOf();
    expect(link).toMatch(/^\/g\/[0-9a-f]{32}$/);
    await expectAccessible(office, "the Share dialog");

    // For certain people: a stranger is asked for an address, and sees nothing of the guide.
    const stranger = await outside.newPage();
    await stranger.goto(link);
    await expect(stranger.getByRole("heading", { level: 1, name: /shared a guide with you/ })).toBeVisible();
    await expect(stranger.getByLabel("Your email address")).toBeVisible();
    await expect(stranger.getByText(title)).toHaveCount(0);
    await expect(stranger.getByText("Twice a day")).toHaveCount(0);
    await expectAccessible(stranger, "a shared guide's door");

    // Opened to anyone with the link.
    await share.getByRole("button", { name: "General access: Restricted" }).click();
    await office.getByRole("menuitemradio", { name: /^Anyone with the link/ }).click();
    await expect(share.getByRole("button", { name: "General access: Anyone with the link" })).toBeVisible();
    await stranger.reload();
    await expect(stranger.getByRole("heading", { level: 1, name: title })).toBeVisible();
    await expect(stranger.getByText("Twice a day for two weeks.")).toBeVisible();
    // A link to a screen in Crewtavo is plain words to someone outside.
    await expect(stranger.getByText("our other guides")).toBeVisible();
    await expect(stranger.getByRole("link", { name: "our other guides" })).toHaveCount(0);
    await expectAccessible(stranger, "a shared guide");

    // The guide's own page says it's shared, to the people who edit it.
    await share.getByRole("button", { name: "Done" }).click();
    await expect(office.getByText("Anyone with the link can read this")).toBeVisible();

    // A new link: the old one stops working.
    await office.getByRole("button", { name: "More actions" }).click();
    await office.getByRole("menuitem", { name: "Share with a link" }).click();
    await share.getByRole("button", { name: "Get a new link" }).click();
    await office.getByRole("dialog", { name: "Get a new link for this guide?" }).getByRole("button", { name: "Get a new link" }).click();
    await expect.poll(linkOf).not.toBe(link);
    const next = await linkOf();
    await stranger.reload();
    await expect(stranger.getByRole("heading", { level: 1, name: "This guide isn't available" })).toBeVisible();
    await stranger.goto(next);
    await expect(stranger.getByRole("heading", { level: 1, name: title })).toBeVisible();

    // A crew member reads the guide in Crewtavo and has no Share.
    const crew = await as("employee");
    await crew.goto(`/kb/${guide.id}`);
    await expect(crew.getByRole("heading", { level: 1, name: title })).toBeVisible();
    // Someone who can't share has Print on its own, with no menu to share from.
    await expect(crew.getByRole("button", { name: "Print" })).toBeVisible();
    await expect(crew.getByRole("button", { name: "More actions" })).toHaveCount(0);
    await expect(crew.getByRole("menuitem", { name: "Share with a link" })).toHaveCount(0);
    await expect(crew.getByText("Anyone with the link can read this")).toHaveCount(0);
  } finally {
    await outside.close();
    // Its link and the people it's shared with go with it.
    await data.db.from("sop_pages").delete().eq("id", guide.id);
  }
});
