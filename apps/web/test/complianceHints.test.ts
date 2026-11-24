/**
 * One-line hints where a business sets up what it sends, for the things that are its own to see to:
 * who it may text, what a rule's email is for, turning Marketing back on for someone who
 * unsubscribed, and what Google doesn't allow of a review ask. They change nothing the app does.
 * Checked in the screens' own source.
 */
import { REVIEW_ASK_POLICY_URL, REVIEW_ASK_RULES, RESUBSCRIBE_HINT, RULE_EMAIL_HINT, RULE_TEXT_CONSENT_HINT, TEXT_CONSENT_HINT } from "@crewtavo/core/marketing";
import { readFileSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";
import { describe, expect, it } from "vitest";

const source = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");

describe("hints for the business", () => {
  it("say on the Twilio panel that clients must have agreed to texts, and promotional ones in writing", () => {
    expect(TEXT_CONSENT_HINT).toBe("Text only people who agreed to get texts from you. Texts that promote something (a sale, a discount, a new service) need their agreement in writing.");
    expect(source("../src/features/apps/TwilioPanel.tsx")).toContain('<p className={kit.note}>{TEXT_CONSENT_HINT}</p>');
  });

  it("say the same under a rule's text, and under its email that promotions belong in Campaigns", () => {
    const rule = source("../src/features/automations/RulePage.tsx");
    expect(RULE_TEXT_CONSENT_HINT).toBe("Goes to clients who agreed to get your texts. A text that promotes something needs their agreement in writing.");
    expect(rule).toContain("{RULE_TEXT_CONSENT_HINT}");
    expect(RULE_EMAIL_HINT).toBe("For messages about a client's own work. For promotions, use Marketing → Campaigns: a rule's email has no unsubscribe link.");
    // Not on an automated campaign's rule, whose email does go as a campaign's, with the link.
    expect(rule).toContain("{!campaign && <p className={styles.note}>{RULE_EMAIL_HINT}</p>}");
    expect(rule).toContain("campaign={Boolean(campaign)}");
  });

  it("say beside Marketing on a client who unsubscribed to turn it back on only if they asked", () => {
    expect(RESUBSCRIBE_HINT).toBe("They unsubscribed. Turn this back on only if they asked you to.");
    expect(source("../src/features/clients/ClientPage.tsx")).toContain("{c.marketing_opt_out && <span className={styles.hint}>{RESUBSCRIBE_HINT}</span>}");
  });

  it("say under the review ask's message not to offer anything for a review or ask only happy clients, with Google's policy", () => {
    expect(REVIEW_ASK_RULES).toBe("Don't offer anything for a review, and don't ask only your happy clients: Google doesn't allow either.");
    expect(REVIEW_ASK_POLICY_URL).toBe("https://support.google.com/contributionpolicy/answer/7400114");
    expect(source("../src/features/marketing/Reviews.tsx")).toContain('{REVIEW_ASK_RULES} <a href={REVIEW_ASK_POLICY_URL} target="_blank" rel="noreferrer" style={{ textDecoration: "underline" }}>Google\'s policy</a>');
  });

  it("say by the shop address that marketing emails show it and can't go out without it", () => {
    // In the words of the business's country, with the region only where it's needed: "city, state and ZIP code" in the US, "city and postcode" in the UK.
    expect(source("../src/features/settings/CompanySettings.tsx")).toContain("It's shown at the bottom of marketing emails, which can't go out without a street or PO box, city{regionNeeded(f.country) ? `, ${words.regionInText}` : \"\"} and {words.postalCodeInText}.");
  });
});
