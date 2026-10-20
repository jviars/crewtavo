import { describe, expect, it } from "vitest";
import { NAV_GROUPS, navVisible } from "../src/components/shell/nav";
import { isInstalled } from "../src/features/apps/installed";
import type { AppRow } from "../src/features/apps/catalog";

const WEBSITE = NAV_GROUPS.flat().find((item) => item.to === "/website")!;
const site = { enabled: true, admin_url: "https://greenlawn.com/admin/" };
const person = (role: string, permissions: string[], settings: Record<string, unknown> = { website: site }) => ({ role, permissions, company: { settings } });

describe("Website in the menu", () => {
  it("shows once the editor is added, for owners, admins and office with Marketing", () => {
    expect(navVisible(person("owner", []), WEBSITE)).toBe(true);
    expect(navVisible(person("admin", ["marketing"]), WEBSITE)).toBe(true);
    expect(navVisible(person("office", ["marketing"]), WEBSITE)).toBe(true);
    expect(navVisible(person("office", ["invoices"]), WEBSITE)).toBe(false);
    expect(navVisible(person("estimator", ["sales"]), WEBSITE)).toBe(false);
    expect(navVisible(person("field_crew", []), WEBSITE)).toBe(false);
    expect(navVisible(person("owner", [], {}), WEBSITE)).toBe(false);
  });

  it("counts Sveltia CMS as installed by its address", () => {
    const sveltia = { id: "sveltia", auth: "site", status: "disconnected" } as AppRow;
    expect(isInstalled(sveltia, new Set())).toBe(false);
    expect(isInstalled({ ...sveltia, status: "connected" }, new Set())).toBe(true);
  });
});
