/**
 * Snow (Apps → Crewtavo - Snow): what a forecast calls for at a snow customer, and what its people are
 * told. The forecast is the snow from 6pm today through tomorrow (an overnight storm counts whole)
 * and the hours around it; fetching it lives in the API (services/forecast.ts), and the customers in
 * the database (snow_sites, 20261113000100_snow_app.sql).
 */
import { clockStyle, writtenDate } from "./regional";
import type { Sky } from "./weather";

/** A snow customer's triggers. */
export interface SnowRules {
  trigger_in: number;              // plow at this much
  salt_trigger_in?: number | null; // salt at this much, and for ice; null: no salting
  repeat_in?: number | null;       // another push for every this much past the trigger; null: one push
}

/** What a forecast calls for: the plow, so many times, or a salt run. */
export interface SnowPlan { kind: "plow" | "salt"; pushes: number }

/** The most pushes one storm is planned as, however much is forecast. */
export const MAX_PUSHES = 6;

/** What `snow_in` inches call for at a customer: nothing (null) under its triggers, or with no forecast. */
export function snowPlan(rules: SnowRules, snow_in: number | null | undefined): SnowPlan | null {
  if (snow_in == null) return null;
  if (snow_in >= rules.trigger_in) {
    // 8 in on a 2 in trigger, pushing again every 3: at 2, 5 and 8.
    const again = rules.repeat_in ? Math.floor((snow_in - rules.trigger_in) / rules.repeat_in + 1e-9) : 0;
    return { kind: "plow", pushes: Math.min(MAX_PUSHES, 1 + again) };
  }
  return rules.salt_trigger_in != null && snow_in >= rules.salt_trigger_in ? { kind: "salt", pushes: 1 } : null;
}

/** A storm's price by how much fell: the last tier is open-ended (up_to_in null). */
export interface SnowTier { up_to_in: number | null; price: number }

/** What a storm of `depth` inches bills: the first tier it fits under, past them all the highest; null with no tiers (each push bills the job's lines). As private.snow_price. */
export function snowTierPrice(tiers: SnowTier[], depth: number): number | null {
  const sorted = [...tiers].sort((a, b) => (a.up_to_in ?? Infinity) - (b.up_to_in ?? Infinity));
  return (sorted.find((t) => t.up_to_in == null || depth <= t.up_to_in) ?? sorted[sorted.length - 1])?.price ?? null;
}

/**
 * The business's standard storm prices (companies.settings.snow_storm_prices, set_snow_storm_prices):
 * what a storm bills by how much fell, as a multiple of what one push bills that customer. The last
 * band, with no depth, covers anything deeper.
 */
export interface SnowBand { up_to_in: number | null; times: number }

/** The standard as saved, shallowest first, with anything that isn't a band left out. */
export const snowBands = (saved: unknown): SnowBand[] =>
  (Array.isArray(saved) ? saved : [])
    .flatMap((b) => {
      const band = b as { up_to_in?: unknown; times?: unknown } | null;
      return band && typeof band.times === "number" && band.times > 0 ? [{ up_to_in: typeof band.up_to_in === "number" ? band.up_to_in : null, times: band.times }] : [];
    })
    .sort((a, b) => (a.up_to_in ?? Infinity) - (b.up_to_in ?? Infinity));

/** A customer's storm prices from the standard: each band's multiple of what one push bills them, to the cent. */
export const standardTiers = (bands: SnowBand[], push: number): SnowTier[] => bands.map((b) => ({ up_to_in: b.up_to_in, price: Math.round(push * b.times * 100) / 100 }));

export const inchesText = (n: number) => `${Math.round(n * 10) / 10} in`;
/**
 * "07:00:00" as "7 AM", "13:30" as "1:30 PM"; where the business's country keeps time another way
 * (core regional), "7 a.m." in Canada, "7 am" in Australia, "07:00" and "13:30" in the UK.
 */
export function clockText(time: string, country?: string | null): string {
  const [hour = 0, minute = 0] = time.split(":").map(Number);
  if (clockStyle(country) !== "AM") return writtenDate(new Date(Date.UTC(2000, 0, 1, hour, minute)), "FMHH12:MI AM", country).replace(":00 ", " ");
  return `${hour % 12 || 12}${minute ? `:${String(minute).padStart(2, "0")}` : ""} ${hour < 12 ? "AM" : "PM"}`;
}

/** A snow customer whose forecast calls for something, as its people are told about it. */
export interface SnowSite {
  name: string;             // the place as the crew knows it: client and address
  trigger_in: number;
  snow_in: number;          // the forecast there from 6pm today through tomorrow
  plan: SnowPlan;
  clear_by?: string | null; // "07:00:00"
  priority?: number;        // 1 first
  people: string[];         // the crew and the people listed on the job
}

const MAX_LINES = 30;

/** Which storm a notice is about: tomorrow's, told the day before, or one that's here today and wasn't told about. */
export type SnowDay = "today" | "tomorrow";

function snowLine(s: SnowSite, day: SnowDay, country?: string | null): string {
  const what = s.plan.kind === "salt" ? `salt only (it plows at ${inchesText(s.trigger_in)})` : `trigger ${inchesText(s.trigger_in)}${s.plan.pushes > 1 ? `, ${s.plan.pushes} pushes` : ""}`;
  const when = day === "today" ? "today, counted from 6pm last night" : "from 6pm tonight through tomorrow";
  return `${s.name}: ${inchesText(s.snow_in)} ${when}, ${what}${s.clear_by ? `, clear by ${clockText(s.clear_by, country)}` : ""}`;
}

export interface SnowNotice { user_id: string; office: boolean; title: string; body: string }

/** One notice a person: `lines` for their sites, the first priority first. The people in `asked` are asked whether they can go out. */
function notices<T extends { people: string[]; priority?: number }>(sites: T[], office: string[], title: (mine: T[]) => string, line: (site: T) => string, asked: string[]): SnowNotice[] {
  if (!sites.length) return [];
  const byPerson = new Map<string, T[]>();
  for (const site of sites) for (const p of site.people) byPerson.set(p, [...(byPerson.get(p) ?? []), site]);
  for (const p of office) byPerson.set(p, sites);
  return [...byPerson].map(([user_id, mine]) => {
    const lines = mine.slice(0, MAX_LINES).map(line);
    if (mine.length > MAX_LINES) lines.push(`and ${mine.length - MAX_LINES} more`);
    const isOffice = office.includes(user_id);
    if (asked.includes(user_id)) lines.push("Can you go out? Say yes or no on My day.");
    return { user_id, office: isOffice, title: title(mine).slice(0, 300), body: lines.join("\n") };
  });
}

/**
 * Who hears about the snow coming by tomorrow (or, for `day` "today", a storm that's here and they
 * weren't told about), and what: each site goes to its people, and every one of them to the office
 * (`office`: the people who schedule the team). The first priority first, then the most snow.
 * `asked` are the ones asked whether they can go out: the subcontractors, who work for themselves;
 * the business's own people are told. Empty for no sites. Times are as the business's `country`
 * keeps them (the US's way without one).
 */
export function snowNotices(sites: SnowSite[], office: string[], asked: string[] = [], day: SnowDay = "tomorrow", country?: string | null): SnowNotice[] {
  const ordered = [...sites].sort((a, b) => (a.priority ?? 2) - (b.priority ?? 2) || b.snow_in - a.snow_in);
  const when = day === "today" ? "today" : "by tomorrow";
  return notices(
    ordered,
    office,
    (mine) => {
      const one = mine[0]!;
      if (mine.length > 1) return `Snow ${when}: ${mine.length} properties to service`;
      return `${one.plan.kind === "salt" ? "Salt run" : "Snow"} ${when} at ${one.name}: ${inchesText(one.snow_in)}${day === "today" ? "" : " forecast"}`;
    },
    (site) => snowLine(site, day, country),
    asked,
  );
}

/** Ice on the way at a salting customer: freezing rain, or wet pavement that then freezes. */
export interface IceRisk { kind: "ice" | "refreeze"; at: string; low_f?: number }

/** "2026-11-14T03:00" as "3 AM tonight" or "3 AM tomorrow", going by the day the window opens. */
const hourText = (time: string, from: string, country?: string | null) => `${clockText(time.slice(11, 16), country)} ${time.slice(0, 10) === from.slice(0, 10) ? "tonight" : "tomorrow"}`;

/**
 * Ice between `from` and `to` (the place's own hours, as "2026-11-13T18:00"): freezing rain, or
 * failing that a refreeze, which is pavement made wet (rain above freezing, or snow at 34° or more,
 * which melts as it lands) and then 30° or colder. A cold dry night isn't one: it has nothing to freeze.
 */
export function iceRisk(hours: Array<{ time: string; temp_f: number | null; sky: Sky; snow_in: number }>, from: string, to: string): IceRisk | null {
  const window = hours.filter((h) => h.time >= from && h.time < to);
  const freezing = window.find((h) => h.sky === "freezing_rain");
  if (freezing) return { kind: "ice", at: freezing.time };
  const wet = window.findIndex((h) => h.temp_f != null && ((h.temp_f > 32 && (h.sky === "rain" || h.sky === "drizzle" || h.sky === "storm")) || (h.temp_f >= 34 && h.snow_in > 0)));
  if (wet < 0) return null;
  const frozen = window.slice(wet + 1).find((h) => h.temp_f != null && h.temp_f <= 30);
  return frozen ? { kind: "refreeze", at: frozen.time, low_f: Math.min(...window.slice(wet + 1).flatMap((h) => (h.temp_f == null ? [] : [h.temp_f]))) } : null;
}

/**
 * Who's warned about ice at their salting customers, and what; the office about all of them. `from`
 * is when the window opens; times are as the business's `country` keeps them.
 */
export function iceNotices(sites: Array<{ name: string; risk: IceRisk; people: string[]; priority?: number }>, office: string[], from: string, country?: string | null): SnowNotice[] {
  const ordered = [...sites].sort((a, b) => (a.priority ?? 2) - (b.priority ?? 2) || a.risk.at.localeCompare(b.risk.at));
  return notices(
    ordered,
    office,
    (mine) => (mine.length > 1 ? `Ice by tomorrow: ${mine.length} properties to salt` : `${mine[0]!.risk.kind === "ice" ? "Freezing rain" : "Refreeze"} by tomorrow at ${mine[0]!.name}`),
    (s) => (s.risk.kind === "ice" ? `${s.name}: freezing rain around ${hourText(s.risk.at, from, country)}` : `${s.name}: wet, then ${s.risk.low_f}° by ${hourText(s.risk.at, from, country)}: it will refreeze`),
    [],
  );
}
