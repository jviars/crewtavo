/**
 * Marketing emails and the company's postal address, on the screens that write and send them: the
 * composer doesn't say the address is added when there's none, Send and Send test wait for it, and
 * Marketing says what isn't going out and where to add it. Checked in the screens' own source.
 */
import { hasPostalAddress } from "@crewtavo/core/postcards";
import { readFileSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";
import { describe, expect, it } from "vitest";

const source = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");

describe("a campaign's composer", () => {
  const composer = source("../src/features/marketing/CampaignPage.tsx");

  it("only says the address is added at the bottom when the company has one", () => {
    expect(composer).toContain('hasAddress ? "Your address and an unsubscribe link are added at the bottom." : "An unsubscribe link is added at the bottom. Your address goes there too, once it\'s filled in."');
    expect(composer).toContain("const hasAddress = hasPostalAddress(session.company.address, businessCountry(session.company));");
    // As the session has a company that skipped it, and one that didn't.
    expect(hasPostalAddress(null)).toBe(false);
    expect(hasPostalAddress({ line1: "1 Main St" })).toBe(false);
    expect(hasPostalAddress({ line1: "PO Box 12", city: "Radford", region: "VA", postal_code: "24141" })).toBe(true);
    // Read as addresses are written where the business is: a UK one needs no county.
    expect(hasPostalAddress({ line1: "12 High Street", city: "Leeds", postal_code: "LS1 4AP" }, "GB")).toBe(true);
    expect(hasPostalAddress({ line1: "12 High Street", city: "Leeds", postal_code: "LS1 4AP" }, "US")).toBe(false);
  });

  it("holds Send and Send test until there's an address, and says where to add it", () => {
    expect(composer).toContain("disabled={!session.config.features.email || !hasAddress || problems.slice(0, 2).length > 0}>Send test</Button>");
    expect(composer).toContain("disabled={problems.length > 0 || !session.config.features.email || !hasAddress}>Send</Button>");
    expect(composer).toContain('{editable && <SenderAddressNote what="this can\'t be sent or tested" />}');
  });
});

describe("Marketing", () => {
  it("says which emails aren't going out for want of an address, with a link to Settings → Company for those who can add it", () => {
    expect(source("../src/features/marketing/MarketingPage.tsx")).toContain('<SenderAddressNote what="campaigns, review asks and referral asks by email won\'t go out" />');
    const note = source("../src/features/marketing/SenderAddress.tsx");
    expect(note).toContain("if (hasPostalAddress(session.company.address, businessCountry(session.company))) return null;");
    expect(note).toContain("Marketing emails have to show your company's postal address, and it isn't filled in yet, so {what}.");
    expect(note).toContain('<Link to="/settings?tab=company" className="strong">Add it in Settings → Company</Link> (a PO box is fine).');
  });

  it("doesn't say an automated campaign's email carries an address there isn't", () => {
    const automated = source("../src/features/marketing/AutomatedCampaigns.tsx");
    expect(automated).toContain("Your address goes there too, once it's filled in: until then this isn't sent.");
    expect(automated).toContain("const hasAddress = useSenderAddress();");
  });
});
