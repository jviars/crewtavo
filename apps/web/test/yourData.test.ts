/** Settings → Your data is the owner's alone: the download holds every client, the team's pay and subs' details. */
import { describe, expect, it } from "vitest";
import { settingsGroups } from "../src/features/settings/sections";

describe("Settings → Your data", () => {
  const tabs = (role: string, permissions: string[]) =>
    settingsGroups({ role, permissions, config: { singleCompany: false, platform: "docker" } } as never)
      .flatMap((g) => g.items)
      .flatMap((i) => ("tab" in i ? [i.tab] : []));

  it("shows only to the owner, whatever areas another role has", () => {
    expect(tabs("owner", [])).toContain("data");
    for (const role of ["admin", "office", "estimator", "crew_lead", "field_crew", "subcontractor"]) {
      expect(tabs(role, ["settings", "team", "apps", "sales"]), role).not.toContain("data");
    }
  });
});
