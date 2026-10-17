/** Trade weather rules (rain days, paving temperatures, sealcoat dry time). Fetching lives in the API. */
import { addDays } from "./time";

export interface WeatherRule {
  applies_to?: string;          // service name; omitted = whole job
  min_temp_f?: number;          // e.g. hot-mix asphalt needs 50°F
  max_rain_pct?: number;        // e.g. mowing skips above 70%
  requires_dry_hours?: number;  // e.g. sealcoat needs 24 dry hours after
}

export interface DayOutlook {
  date: string; // YYYY-MM-DD
  temp_min_f: number | null;
  temp_max_f: number | null;
  rain_chance_pct: number | null;
}

/**
 * The rules a job's visits are checked against: the job's own when it has any, otherwise the
 * company's (settings.weather_rules, from its trade preset) for the services on the job, plus those
 * without applies_to. Both come from JSON people can edit, so anything that isn't a rule is skipped.
 */
export function jobWeatherRules(jobRules: unknown, companyRules: unknown, services: string[]): WeatherRule[] {
  const list = (rules: unknown) => (Array.isArray(rules) ? (rules.filter((r) => r && typeof r === "object") as WeatherRule[]) : []);
  const own = list(jobRules);
  if (own.length) return own;
  const names = new Set(services.map((s) => s.trim().toLowerCase()));
  return list(companyRules).filter((r) => !r.applies_to || names.has(String(r.applies_to).trim().toLowerCase()));
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
    if (day && rule.max_rain_pct != null && day.rain_chance_pct != null && day.rain_chance_pct > rule.max_rain_pct) {
      reasons.push(`${label}${day.rain_chance_pct}% chance of rain`);
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
