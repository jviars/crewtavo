/**
 * The Apps directory (features/apps/AppsPage.tsx, App-Directory.dc.html): what each app's row says
 * on its right, its name where Crewtavo is already said, and what the search finds.
 */
import { describe, expect, it } from "vitest";
import { appState, OWN_ICONS, shortName } from "../src/features/apps/AppIcon";
import { appMatches, featuredApp } from "../src/features/apps/AppsPage";
import type { AppRow } from "../src/features/apps/catalog";

const app = (over: Partial<AppRow> = {}): AppRow => ({
  id: "stripe",
  name: "Stripe",
  category: "Payments",
  description: "Card and bank payments",
  auth: "api_key",
  docs: "https://crewtavo.com/docs/connections/stripe/",
  available: true,
  redirect_uri: null,
  status: "disconnected",
  ...over,
});

describe("an app's row in the directory", () => {
  it("says Installed, how many calendars, or Needs attention in red, and nothing when it isn't installed", () => {
    expect(appState(app(), false)).toBeNull();
    expect(appState(app({ status: "connected" }), true)).toEqual({ tone: "good", label: "Installed" });
    expect(appState(app({ calendars: 2 }), true)).toEqual({ tone: "good", label: "2 calendars" });
    expect(appState(app({ calendars: 1 }), true)?.label).toBe("1 calendar");
    expect(appState(app({ status: "error" }), true)).toEqual({ tone: "danger", label: "Needs attention" });
    expect(appState(app({ calendar_errors: 1 }), false)?.tone).toBe("danger");
  });

  it("drops \" - Crewtavo\" from a built-in app's name, under Built by Crewtavo", () => {
    expect(shortName({ name: "Team Chat - Crewtavo" })).toBe("Team Chat");
    expect(shortName({ name: "Facebook & Instagram" })).toBe("Facebook & Instagram");
  });

  it("gives each built-in app its own menu icon, so the nine can be told apart", () => {
    expect(Object.keys(OWN_ICONS).sort()).toEqual(["careers", "drive", "marketing", "paving", "roofing", "snow", "team_chat", "website_analytics", "website_forms"]);
    expect(new Set(Object.values(OWN_ICONS)).size).toBe(Object.keys(OWN_ICONS).length);
  });

  it("finds an app by its name, what it does, its category or who makes it", () => {
    expect(appMatches(app(), "")).toBe(true);
    expect(appMatches(app(), "STRIPE")).toBe(true);
    expect(appMatches(app(), "deposits")).toBe(true); // its tagline
    expect(appMatches(app(), "payments")).toBe(true);
    expect(appMatches(app(), "calendar")).toBe(false);
  });
});

describe("Discover's featured app", () => {
  it("is the first featured app this business doesn't have yet, or the first when it has them all", () => {
    const stripe = app();
    const twilio = app({ id: "twilio", name: "Twilio", category: "Messaging" });
    expect(featuredApp([twilio, stripe], (a) => a.id === "stripe")?.id).toBe("twilio");
    expect(featuredApp([twilio, stripe], () => false)?.id).toBe("stripe");
    expect(featuredApp([twilio, stripe], () => true)?.id).toBe("stripe");
    expect(featuredApp([app({ available: false })], () => false)).toBeUndefined();
  });
});
