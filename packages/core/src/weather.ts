/**
 * Trade weather rules (rain days, paving temperatures, sealcoat dry time). Each business starts with
 * its trade preset's and changes them in Settings → Weather rules (set_weather_rules). Fetching lives
 * in the API.
 */
import { addDays } from "./time";

export interface WeatherRule {
  service_id?: string;          // the price list item's id: matched first, so renaming the item keeps its rule
  applies_to?: string;          // its name (all a rule had before ids); neither = whole job
  min_temp_f?: number;          // e.g. hot-mix asphalt needs 50°F
  max_temp_f?: number;          // e.g. shingles scuff above 90°F
  max_rain_pct?: number;        // e.g. mowing skips above 70%
  max_wind_mph?: number;        // e.g. spraying stops above 10 mph
  requires_dry_hours?: number;  // e.g. sealcoat needs 24 dry hours after
}

export interface DayOutlook {
  date: string; // YYYY-MM-DD
  temp_min_f: number | null;
  temp_max_f: number | null;
  rain_chance_pct: number | null;
  wind_max_mph?: number | null;
}

/** A rule in one line, as Settings lists it: "Paver patio: at most 50% rain, 24 dry hours after". */
export function weatherRuleSummary(rule: WeatherRule): string {
  const { min_temp_f: low, max_temp_f: high } = rule;
  const parts = [
    rule.max_rain_pct != null && `at most ${rule.max_rain_pct}% rain`,
    low != null && high != null ? `${low}°F to ${high}°F` : low != null ? `at least ${low}°F` : high != null && `at most ${high}°F`,
    rule.max_wind_mph != null && `wind at most ${rule.max_wind_mph} mph`,
    rule.requires_dry_hours && `${rule.requires_dry_hours} dry hours after`,
  ].filter(Boolean);
  return `${rule.applies_to || "Every job"}: ${parts.join(", ") || "no limits"}`;
}

/** The rules with each one's price list item called what it's called now (`names`: id → name). */
export function namedWeatherRules(rules: WeatherRule[], names: Map<string, string>): WeatherRule[] {
  return rules.map((r) => (r.service_id && names.has(r.service_id) ? { ...r, applies_to: names.get(r.service_id) } : r));
}

/**
 * The rules a job's visits are checked against: the job's own when it has any, otherwise the
 * company's (settings.weather_rules, set in Settings) for the services on the job, plus those for
 * every job. A rule's item is matched by id first (`serviceIds`: the job's items' ids → their names
 * now), then by name: rules saved before ids have only that. Both come from JSON people can edit,
 * so anything that isn't a rule is skipped.
 */
export function jobWeatherRules(jobRules: unknown, companyRules: unknown, services: string[], serviceIds = new Map<string, string>()): WeatherRule[] {
  const list = (rules: unknown) => (Array.isArray(rules) ? (rules.filter((r) => r && typeof r === "object") as WeatherRule[]) : []);
  const own = list(jobRules);
  if (own.length) return own;
  const names = new Set(services.map((s) => s.trim().toLowerCase()));
  const applies = (r: WeatherRule) =>
    (!r.applies_to && !r.service_id) || (r.service_id != null && serviceIds.has(r.service_id)) || (r.applies_to != null && names.has(String(r.applies_to).trim().toLowerCase()));
  return namedWeatherRules(list(companyRules).filter(applies), serviceIds);
}

/** Reasons a visit on `date` breaks its rules; empty when the weather is fine. */
export function weatherRisks(rules: WeatherRule[], date: string, outlook: DayOutlook[]): string[] {
  const byDate = new Map(outlook.map((d) => [d.date, d]));
  const day = byDate.get(date);
  const reasons: string[] = [];
  for (const rule of rules) {
    const label = rule.applies_to ? `${rule.applies_to}: ` : "";
    if (day && rule.min_temp_f != null && day.temp_min_f != null && day.temp_min_f < rule.min_temp_f) {
      reasons.push(`${label}low of ${Math.round(day.temp_min_f)}°F is below ${rule.min_temp_f}°F`);
    }
    if (day && rule.max_temp_f != null && day.temp_max_f != null && day.temp_max_f > rule.max_temp_f) {
      reasons.push(`${label}high of ${Math.round(day.temp_max_f)}°F is above ${rule.max_temp_f}°F`);
    }
    if (day && rule.max_rain_pct != null && day.rain_chance_pct != null && day.rain_chance_pct > rule.max_rain_pct) {
      reasons.push(`${label}${day.rain_chance_pct}% chance of rain`);
    }
    if (day && rule.max_wind_mph != null && day.wind_max_mph != null && day.wind_max_mph > rule.max_wind_mph) {
      reasons.push(`${label}wind up to ${Math.round(day.wind_max_mph)} mph`);
    }
    if (rule.requires_dry_hours) {
      // The dry time starts on the visit day itself, so rain that day counts too.
      const days = Math.max(1, Math.ceil(rule.requires_dry_hours / 24));
      for (let i = 0; i <= days; i++) {
        const next = byDate.get(addDays(date, i));
        if (next?.rain_chance_pct != null && next.rain_chance_pct >= 50) {
          reasons.push(`${label}rain likely on ${next.date} during the ${rule.requires_dry_hours}-hour dry time`);
        }
      }
    }
  }
  return reasons;
}
