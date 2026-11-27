/**
 * Marketing's setup folded to a line once it's done (Reviews, Referrals), where new clients came
 * from (Campaigns), and the figures shown once, on Campaigns.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { askSendProblems, askSummary } from "../src/features/marketing/askForm";
import { sourceCounts } from "../src/features/marketing/LeadSources";
import { referralSummary } from "../src/features/marketing/referralForm";
import { sourceMark } from "../src/features/marketing/SourceMark";

const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

describe("folded setup", () => {
  it("says how review asks go in one line", () => {
    expect(askSummary({ channel: "email", reminders: 2, days: [3, 5], recurring: true, visits: 3 })).toBe("By email · reminders 3 and 5 days after · recurring jobs after the 3rd visit");
    expect(askSummary({ channel: "both", reminders: 1, days: [1, 5], recurring: false, visits: 1 })).toBe("By text and email · a reminder 1 day after · not on recurring work");
    expect(askSummary({ channel: "sms", reminders: 0, days: [3, 5], recurring: true, visits: 1 })).toBe("By text · no reminders · recurring jobs after the 1st visit");
  });

  it("says under the folded line that asks can't go out, as the open form does under Send by", () => {
    const on = { sms: true, email: true };
    expect(askSendProblems("both", on)).toEqual({ text: null, email: null });
    expect(askSendProblems("sms", { sms: false, email: true })).toEqual({ text: "Texting isn't set up on this Crewtavo, so asks can't go by text.", email: null });
    expect(askSendProblems("both", { sms: false, email: true }).text).toBe("Texting isn't set up on this Crewtavo, so asks go by email only, or fail for clients with no email.");
    expect(askSendProblems("both", { sms: false, email: false })).toEqual({ text: "Texting isn't set up on this Crewtavo, so asks can't go by text.", email: "Email isn't connected yet, so asks can't go by email." });
    expect(askSendProblems("email", { sms: false, email: false })).toEqual({ text: null, email: "Email isn't connected yet, so asks can't go by email." });
    expect(askSendProblems("email", { sms: false, email: true })).toEqual({ text: null, email: null });
    // The folded switch turns asking on at once, so what it can't do is said there too, not only once Edit is pressed.
    const reviews = source("../src/features/marketing/Reviews.tsx");
    expect(reviews).toContain("<SetupSummary lines={[timing, askSummary(form)]} warnings={sendWarnings}");
    expect(source("../src/features/marketing/SetupSummary.tsx")).toContain("styles.warnLine");
  });

  it("says what clients and friends get from a referral", () => {
    expect(referralSummary({ referrals: { reward: { kind: "amount", value: 50 }, offer: "10% off your first service" } })).toBe("$50 credit for each friend who becomes a client · friends see “10% off your first service”");
    expect(referralSummary({ referrals: { reward: { kind: "percent", value: 12.5 }, offer: null } })).toBe("12.5% of each friend's first job as credit · no offer for friends");
    expect(referralSummary({ referrals: { offer: "A free crack fill" } })).toBe("No credit for clients · friends see “A free crack fill”");
  });

  it("puts the review link and the credit first until they're set, and asking first on a phone", () => {
    const reviews = source("../src/features/marketing/Reviews.tsx");
    expect(reviews).toContain("{!linked && <ReviewLink google={g} />}");
    expect(reviews).toContain("Add your Google review link above first.");
    expect(reviews).toContain("sideFirst");
    const referrals = source("../src/features/marketing/Referrals.tsx");
    expect(referrals).toContain("{!ready && <CreditAndOffer />}");
    expect(referrals).toContain("Add a credit or an offer above first.");
    // An example never reads as a value that's already set.
    expect(referrals).toContain('placeholder={percent ? "e.g. 10" : "e.g. 50"}');
  });
});

describe("Campaigns", () => {
  it("counts new clients by where they came from, most first, the long tail as one", () => {
    const clients = [
      ...Array.from({ length: 4 }, () => ({ lead_source: "Google" })),
      ...Array.from({ length: 2 }, () => ({ lead_source: "Referral" })),
      { lead_source: null },
      { lead_source: "Website form", requests: [{ web_visit: { source: "Facebook" } }] },
      { lead_source: "Postcard" },
      { lead_source: "Yard sign" },
    ];
    expect(sourceCounts(clients, 4)).toEqual([
      { source: "Google", count: 4 },
      { source: "Referral", count: 2 },
      { source: "Not recorded", count: 1 },
      { source: "Everything else", count: 3 },
    ]);
    expect(sourceCounts(clients).map((s) => s.source)).toContain("Website form · Facebook");
  });

  it("shows Marketing's figures once, on Campaigns", () => {
    const page = source("../src/features/marketing/MarketingPage.tsx");
    expect(page).toContain('{tab === "campaigns" && strip}');
    expect(page).not.toContain("usePhone");
  });
});

describe("logos for networks and lead sources", () => {
  it("gives the networks their logo and the usual sources a plain icon", () => {
    const icon = (name: string) => sourceMark(name)?.icon ?? null;
    expect(icon("facebook")).toBe("facebook");
    expect(icon("Website form · Google")).toBe("google");
    expect(icon("Google Business Profile")).toBe("google");
    expect(icon("instagram.com")).toBe("instagram");
    expect(icon("Referral")).toBe("handshake");
    expect(icon("Yard sign")).toBe("signpost");
    expect(icon("Postcard")).toBe("mailbox");
    expect(icon("Bid")).toBe("gavel");
    expect(icon("Phone")).toBe("phone");
    expect(icon("Website form")).toBe("globe");
    // Words that only look like one aren't marked.
    expect(icon("Design build")).toBeNull();
    expect(icon("Not recorded")).toBeNull();
    expect(icon("Everything else")).toBeNull();
    expect(icon("Campaign")).toBeNull();
    expect(icon("Email campaign")).toBe("mail");
    // Brand logos carry their color; plain icons stay quiet.
    expect(sourceMark("facebook")?.color).toBe("#1877F2");
    expect(sourceMark("Referral")?.color).toBeUndefined();
  });
});
