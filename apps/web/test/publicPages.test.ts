/**
 * What the pages clients and the public use say for the business: its privacy policy link (one box
 * for it in Settings → Company, the link in each page's footer, and a note for owners on the booking
 * settings page while there's none), and on a referral page that the person recommending gets a
 * credit. Checked in the screens' own source.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";
import { describe, expect, it } from "vitest";

const source = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");

describe("a referral page", () => {
  it("shows the friend that the person recommending gets a credit, under the recommendation", () => {
    expect(source("../src/features/public/ReferralPage.tsx")).toContain("{view.data.disclosure && <p className={k.msg}>{view.data.disclosure}</p>}");
  });
});

describe("the privacy policy link", () => {
  it("is one setting in Settings → Company, saved as a web address or cleared", () => {
    const settings = source("../src/features/settings/CompanySettings.tsx");
    expect(settings).toContain('<Field label="Privacy policy link" optional hint="Shown at the bottom of your booking forms, Client Hub, referral, showcase and unsubscribe pages. Pages that collect personal details should link one.">');
    expect(settings).toContain('const privacy = privacyUrlTyped(v.privacy_url ?? "");');
    expect(settings).toContain("privacy_url: privacy,");
  });

  it("is in the footer of the booking form, the Client Hub, a showcase, the referral page and the unsubscribe page", () => {
    expect(source("../src/features/booking/BookingFormPage.tsx")).toContain("<PrivacyFooter url={view.data?.company.privacy_url} />");
    expect(source("../src/features/public/ReferralPage.tsx")).toContain("<PrivacyFooter url={view.data.company.privacy_url} />");
    expect(source("../src/features/public/ShowcasePage.tsx")).toContain("<PrivacyFooter url={d.company.privacy_url} />");
    expect(source("../src/features/public/UnsubscribePage.tsx")).toContain("<PrivacyFooter url={status.data?.privacy_url} />");
    expect(source("../src/features/hub/HubPage.tsx")).toContain("{company.privacy_url && <span><PrivacyLink url={company.privacy_url} /></span>}");
    // Nothing shows for a business that set none, and the link opens in its own tab.
    const link = source("../src/components/ui/PrivacyLink.tsx");
    expect(link).toContain("if (!url) return null;");
    expect(link).toContain('<a href={url} target="_blank" rel="noopener noreferrer" className={className}>{PRIVACY_LINK_LABEL}</a>');
  });

  it("is asked for on the booking settings page, of the people who can add it, while there's none", () => {
    const booking = source("../src/features/booking/BookingAdminPage.tsx");
    expect(booking).toContain('{hasRole(session, "admin") && !privacyUrl(company.settings) && (');
    expect(booking).toContain('Forms that collect personal details should link your privacy policy. <Link to="/settings?tab=company">Add the link in Settings → Company</Link> and it shows under every form.');
  });
});
