/**
 * Crewtavo - Paving and Crewtavo - Roofing as apps: the sidebar's Paving and Roofing follow the app
 * (companies.settings.paving_app and .roofing_app), never the trade, so a business can have both;
 * Settings → Packages goes where the packages are; and both are listed in Apps.
 */
import { STAFF } from "@crewtavo/core/roles";
import { describe, expect, it } from "vitest";
import { NAV_GROUPS, navVisible } from "../src/components/shell/nav";
import { APP_INFO } from "../src/features/apps/catalog";
import { settingsGroups } from "../src/features/settings/sections";

const PAVING = NAV_GROUPS.flat().find((item) => item.to === "/paving")!;
const ROOFING = NAV_GROUPS.flat().find((item) => item.to === "/roofing")!;
const BOTH = { paving_app: { enabled: true }, roofing_app: { enabled: true } };
const person = (role: string, settings: Record<string, unknown>, trade_preset = "general") => ({ role, permissions: ["sales"], company: { settings, trade_preset } });

describe("Paving and Roofing in the menu", () => {
  it("show while their app is installed, for the people who sell", () => {
    expect(STAFF.filter((role) => navVisible(person(role, BOTH), PAVING))).toEqual(["owner", "admin", "office", "estimator"]);
    expect(STAFF.filter((role) => navVisible(person(role, BOTH), ROOFING))).toEqual(["owner", "admin", "office", "estimator"]);
  });

  it("follow the app, not the trade", () => {
    expect(navVisible(person("owner", {}, "paving"), PAVING)).toBe(false);
    expect(navVisible(person("owner", {}, "roofing_exteriors"), ROOFING)).toBe(false);
    expect(navVisible(person("owner", { roofing_app: { enabled: true } }, "paving"), ROOFING)).toBe(true);
    expect(navVisible(person("owner", { roofing_app: { enabled: true } }, "paving"), PAVING)).toBe(false);
    expect(navVisible(person("owner", { paving_app: { enabled: false } }, "paving"), PAVING)).toBe(false);
    // settings.roofing holds the price ranges: it isn't the switch.
    expect(navVisible(person("owner", { roofing: { enabled: true, range_pct: 15 } }), ROOFING)).toBe(false);
    expect(NAV_GROUPS.flat().some((item) => "trade" in item)).toBe(false);
  });

  it("never show to crews or subs", () => {
    for (const role of ["crew_lead", "field_crew", "subcontractor"]) {
      expect(navVisible(person(role, BOTH), PAVING), role).toBe(false);
      expect(navVisible(person(role, BOTH), ROOFING), role).toBe(false);
    }
  });
});

describe("Settings → Packages", () => {
  const packages = (settings: Record<string, unknown>) =>
    settingsGroups({ role: "estimator", permissions: ["sales"], company: { settings }, config: { singleCompany: false, platform: "docker" } } as never)
      .flatMap((g) => g.items)
      .find((i) => i.label === "Packages");

  it("goes to Roofing → Packages with Roofing installed, and to Packages without it", () => {
    expect(packages({ roofing_app: { enabled: true } })).toMatchObject({ to: "/roofing/packages" });
    expect(packages({})).toMatchObject({ to: "/packages" });
  });
});

describe("Paving and Roofing in Apps", () => {
  it("say what each adds and open its section", () => {
    expect(APP_INFO.paving).toMatchObject({ developer: "Crewtavo", open: "/paving" });
    expect(APP_INFO.roofing).toMatchObject({ developer: "Crewtavo", open: "/roofing" });
    for (const info of [APP_INFO.paving!, APP_INFO.roofing!]) {
      expect(info.about).toContain("only picks your starter prices and terms");
      expect(info.access.at(-1)).toMatch(/^Uninstalling hides/);
    }
  });
});
