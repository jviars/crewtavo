import { describe, expect, it } from "vitest";
import { breakPay } from "../src/breaks";
import { clockMode } from "../src/clock";
import { fieldSettings, FIELD_APPS, FIELD_SETTINGS, SEES_ALL_SETTINGS, settingsFor } from "../src/companySettings";
import { geofence } from "../src/geofence";
import { contactMessages } from "../src/recipients";
import { ROLES } from "../src/roles";
import { scheduleSettings } from "../src/routing";
import { daysOff } from "../src/slots";
import { arrivalWindowMin } from "../src/time";

const saved = {
  minimum_charge: 75,
  late_fee: { type: "flat", amount: 25, grace_days: 7 },
  payment_terms_days: 15,
  default_tax_rate: 0.1,
  snow_storm_prices: [{ times: 1 }],
  profit_alert_percent: 20,
  revenue_goal: 500000,
  autopay: { enabled: true, max_amount: 500 },
  clock: { mode: "day", breaks: "short_paid", geofence: { mode: "remind", radius: 150 } },
  working_hours: { start: "07:00", end: "17:00", days: [1, 2, 3, 4, 5] },
  schedule: { timeStep: 15, returnToShop: false },
  arrival_window_min: 60,
  depot: { lat: 40.1, lng: -75.1 },
  contact_messages: { enabled: true },
  team_chat: { enabled: true, pinned: "x" },
  marketing: { enabled: true, review_message: "Thanks!" },
  roofing: { range_pct: 15 },
};

describe("what each level reads of the company's settings", () => {
  it("the roles that see prices read all of them", () => {
    for (const role of SEES_ALL_SETTINGS) expect(settingsFor(role, saved), role).toBe(saved);
    expect(SEES_ALL_SETTINGS).toEqual(["owner", "admin", "office", "estimator"]);
  });

  it("crew leads, field crew and subs never read the money settings", () => {
    for (const role of ROLES.filter((r) => !SEES_ALL_SETTINGS.includes(r))) {
      const seen = settingsFor(role, saved);
      for (const key of ["minimum_charge", "late_fee", "payment_terms_days", "default_tax_rate", "snow_storm_prices", "profit_alert_percent", "revenue_goal", "autopay", "roofing"]) {
        expect(seen, `${role} ${key}`).not.toHaveProperty(key);
      }
    }
  });

  it("but read what their screens use, as they use it", () => {
    const seen = fieldSettings(saved);
    expect(clockMode(seen)).toBe(clockMode(saved));
    expect(breakPay(seen)).toBe(breakPay(saved));
    expect(geofence(seen)).toEqual(geofence(saved));
    expect(daysOff(seen)).toEqual(daysOff(saved));
    expect(scheduleSettings(seen)).toEqual(scheduleSettings(saved));
    expect(arrivalWindowMin(seen)).toBe(60);
    expect(contactMessages(seen)).toEqual(contactMessages(saved));
    expect(seen.depot).toEqual(saved.depot);
  });

  it("and of an app, only whether it's on", () => {
    const seen = fieldSettings(saved);
    expect(seen.team_chat).toEqual({ enabled: true });
    expect(seen.marketing).toEqual({ enabled: true });
    expect(seen).not.toHaveProperty("drive");
    expect(fieldSettings({ drive: true, snow_app: {} })).toEqual({ drive: { enabled: null }, snow_app: { enabled: null } });
    for (const key of FIELD_APPS) expect(FIELD_SETTINGS as readonly string[]).not.toContain(key);
  });

  it("settings that aren't an object read as none", () => {
    expect(fieldSettings(null)).toEqual({});
    expect(fieldSettings([1])).toEqual({});
    expect(settingsFor("office", null)).toEqual({});
  });
});
