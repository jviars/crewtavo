/**
 * Weather rules (Settings → Weather rules): the work that needs good weather, and how good. Saved
 * all at once with set_weather_rules, which checks them, as a change to the price list.
 */
import { namedWeatherRules, weatherRuleSummary, type WeatherRule } from "@crewtavo/core";
import { z } from "zod";
import { companyArg, friendly, one, tool } from "./tool";

const rule = z.object({
  service_id: z.uuid().optional().describe("The price list item's id (from list_services): visits for jobs with it are checked. Better than applies_to: it keeps working when the item is renamed."),
  applies_to: z.string().trim().max(200).optional().describe("A price list item's name, when there's no service_id. Both left out: every job."),
  max_rain_pct: z.number().min(0).max(100).optional().describe("Most chance of rain, in percent."),
  min_temp_f: z.number().min(-40).max(130).optional().describe("Lowest temperature (the day's low), °F."),
  max_temp_f: z.number().min(-40).max(130).optional().describe("Highest temperature (the day's high), °F."),
  max_wind_mph: z.number().min(0).max(100).optional().describe("Most wind, mph."),
  requires_dry_hours: z.number().int().min(1).max(168).optional().describe("Hours that have to stay dry after, the visit day included: likely rain (50% or more) during them is a warning."),
});

export const weatherTools = {
  list_weather_rules: tool({
    description:
      "The company's weather rules, each with a one-line summary. Visits in the next few days for jobs with a rule's work get a weather warning when the forecast breaks it; nothing is moved by itself.",
    input: z.object({ ...companyArg }),
    run: async (ctx) => {
      const [c, services] = await Promise.all([
        one(ctx.db.from("companies").select("settings").eq("id", ctx.companyId).maybeSingle(), "The company"),
        ctx.db.from("services").select("id, name").eq("company_id", ctx.companyId),
      ]);
      const list = (c.settings as { weather_rules?: unknown } | null)?.weather_rules;
      const rules = Array.isArray(list) ? (list.filter((r) => r && typeof r === "object") as WeatherRule[]) : [];
      // Each item called what it's called now, since it may have been renamed since.
      return namedWeatherRules(rules, new Map((services.data ?? []).map((s) => [s.id, s.name]))).map((r) => ({ ...r, summary: weatherRuleSummary(r) }));
    },
  }),
  set_weather_rules: tool({
    description:
      "Replace the company's weather rules with this list (read them first with list_weather_rules and send the whole list, changed). Each needs at least one limit. [] removes them all.",
    input: z.object({ rules: z.array(rule).max(50), ...companyArg }),
    area: "prices",
    run: async (ctx, a) => {
      const { data, error } = await ctx.db.rpc("set_weather_rules", { p_company: ctx.companyId, p_rules: a.rules as never });
      if (error) throw new Error(friendly(error.message));
      return { saved: (data as WeatherRule[]).map(weatherRuleSummary) };
    },
  }),
};
