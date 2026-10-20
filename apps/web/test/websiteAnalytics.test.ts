import { describe, expect, it } from "vitest";
import { leadSource, periodTotals, type WebDay } from "../src/features/marketing/website";
import { pageLine } from "../src/features/apps/AnalyticsPanel";

// Website analytics in Marketing, Metrics and on the Apps page.

const day = (d: string, visitors: number, requests = 0): WebDay => ({ day: d, visitors, pageviews: visitors * 2, visits: visitors, requests });

describe("a period's visits", () => {
  it("add up the days in the range, and the same length of time before it", () => {
    const range = { from: "2026-10-08", to: "2026-10-14", days: 7 };
    const days = [day("2026-09-30", 50), day("2026-10-01", 3), day("2026-10-07", 4, 1), day("2026-10-08", 10, 2), day("2026-10-14", 5), day("2026-10-15", 99)];
    expect(periodTotals(days, range)).toEqual({
      now: { visitors: 15, pageviews: 30, visits: 15, requests: 2 },
      before: { visitors: 7, pageviews: 14, visits: 7, requests: 1 },
    });
  });

  it("are zero with nothing counted", () => {
    expect(periodTotals([], { from: "2026-10-01", to: "2026-10-31", days: 31 }).now).toEqual({ visitors: 0, pageviews: 0, visits: 0, requests: 0 });
  });
});

describe("lead sources in Metrics", () => {
  it("split website-form leads by where their visit came from", () => {
    expect(leadSource("Website form", [{ web_visit: null }, { web_visit: { source: "Google", channel: "search" } }])).toBe("Website form · Google");
    expect(leadSource("Website form", [{ web_visit: null }])).toBe("Website form");
    expect(leadSource("Website form", undefined)).toBe("Website form");
    expect(leadSource(" Referral ", [{ web_visit: { source: "Google" } }])).toBe("Referral");
    expect(leadSource(null, null)).toBe("Not recorded");
  });
});

describe("the line for GoDaddy", () => {
  it("names its page, since GoDaddy runs it in a frame", () => {
    expect(pageLine('<script defer src="https://crm.greenlawn.com/v.js"></script>')).toBe('<script defer data-page="/" src="https://crm.greenlawn.com/v.js"></script>');
    expect(pageLine('<script defer data-site="green-lawn" src="https://crm.greenlawn.com/v.js"></script>', "/services")).toBe(
      '<script defer data-site="green-lawn" data-page="/services" src="https://crm.greenlawn.com/v.js"></script>',
    );
  });
});
