/**
 * Settings → Company and Settings → Schedule save only their own settings, merged into the ones
 * saved (public.merge_company_settings, tested in supabase/tests/company_settings_merge_test.sql),
 * so a page open since before a newer change (a weather rule, an app turned on) doesn't undo it.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const source = (file: string) => readFileSync(fileURLToPath(new URL(`../src/features/settings/${file}`, import.meta.url)), "utf8");

describe("saving company settings", () => {
  it("merges the screen's own keys instead of writing back the whole settings it loaded", () => {
    for (const file of ["CompanySettings.tsx", "ScheduleSettings.tsx"]) {
      const code = source(file);
      expect(code, file).toContain(`rpc("merge_company_settings", { p_company: company.id, p_settings:`);
      expect(code, file).not.toMatch(/\.\.\.previous\b/);
      expect(code, file).not.toMatch(/from\("companies"\)\s*\.update\(\{[^}]*settings:/);
    }
  });

  it("saves the workdays with the workday hours", () => {
    expect(source("CompanySettings.tsx")).toContain(`working_hours: { start: v.hours_start, end: v.hours_end, days: v.workdays.split(",").map(Number) }`);
  });
});
