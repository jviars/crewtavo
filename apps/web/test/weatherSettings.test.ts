/**
 * Settings → Weather rules (features/settings/WeatherSettings.tsx): who sees it, and what finds it.
 * The rules' one-line summaries are tested with the rules themselves (packages/core/test/core.test.ts).
 */
import { describe, expect, it } from "vitest";
import { settingsGroups } from "../src/features/settings/sections";

const items = (role: string, permissions: string[]) => settingsGroups({ role, permissions, config: { singleCompany: false, platform: "docker" } } as never).flatMap((g) => g.items);
const has = (role: string, permissions: string[], tab: string) => items(role, permissions).some((i) => "tab" in i && i.tab === tab);

describe("Settings → Weather rules", () => {
  it("is for the people who change the price list and checklists (set_weather_rules)", () => {
    for (const [role, permissions] of [["owner", []], ["admin", ["settings"]], ["office", ["settings"]]] as const) {
      expect(has(role, [...permissions], "weather"), role).toBe(true);
      expect(has(role, [...permissions], "checklists"), role).toBe(true);
    }
    for (const [role, permissions] of [["office", ["sales", "schedule"]], ["estimator", ["sales", "settings"]], ["crew_lead", ["schedule"]], ["field_crew", []]] as const) {
      expect(has(role, [...permissions], "weather"), role).toBe(false);
      expect(has(role, [...permissions], "checklists"), role).toBe(false);
    }
  });

  it("is in Business, found by searching for the weather", () => {
    const business = settingsGroups({ role: "owner", permissions: [], config: { singleCompany: false, platform: "docker" } } as never).find((g) => g.title === "Business")!.items;
    const weather = business.find((i) => i.label === "Weather rules")!;
    expect(weather).toMatchObject({ tab: "weather", icon: "sun" });
    expect(weather.keywords).toContain("weather rain wind temperature hold");
  });
});
