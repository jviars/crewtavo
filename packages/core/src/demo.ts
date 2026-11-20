import { msg } from "./i18n";

/**
 * The public demo (CREWTAVO_DEMO=1, docs/demo.md): what the start screen offers and the server
 * makes. Every visitor answers what trade they're in and gets their own sample business in it,
 * deleted after DEMO_HOURS.
 */

/** How long a visitor's sample business lasts. */
export const DEMO_HOURS = 24;

/**
 * The trades the start screen asks about first, each with a sample business written for it
 * (apps/api/src/services/demoStories.ts makes it under this name, signed in as this owner).
 * "Something else" lists the other trade presets, which get a business made from their own price
 * list (demoOtherBusiness).
 */
export const DEMO_TRADES = [
  {
    preset: "lawn_exterior", label: msg("Lawn care"), blurb: msg("Weekly mowing routes, fertilizer programs, cleanups and snow removal."),
    business: "Greenway Lawn Care", owner: "Chris Dalton",
  },
  {
    preset: "roofing_exteriors", label: msg("Roofing"), blurb: msg("Roofs measured on the aerial, insurance claims and crews on site."),
    business: "Ridgeline Roofing & Exteriors", owner: "Sam Whitaker",
  },
  {
    preset: "paving", label: msg("Paving"), blurb: msg("Takeoffs on the aerial, sealcoat and striping, GC work and retainage."),
    business: "Acme Paving", owner: "Dana Hale",
  },
] as const;

/** Every sample business's crew lead (the crew's phone signs in as them) and the client with a quote out. */
export const DEMO_CREW_LEAD = "Marcus Reed";
export const DEMO_CLIENT = "Jordan Rivera";
/** The owner of a business made from another trade's price list. */
export const DEMO_OTHER_OWNER = "Jamie Cole";

const OTHER_BUSINESSES: Record<string, string> = {
  cleaning: "Brightside Cleaning Co.",
  electrical: "Bright Line Electric",
  general: "Hale Field Services",
  handyman: "Fix-It Home Repair",
  hvac: "Comfort Air Heating & Cooling",
  landscaping: "Stone & Stem Landscapes",
  pest_control: "Shield Pest Control",
  plumbing: "Clearflow Plumbing",
  pool_service: "Bluewater Pool & Spa",
};

/** The name of the sample business made from another trade preset's price list. */
export function demoOtherBusiness(preset: { id: string; name: string }): string {
  return OTHER_BUSINESSES[preset.id] ?? `Hale ${preset.name.split(/[\s&/,]+/)[0]} Co.`;
}

export type DemoTrade = (typeof DEMO_TRADES)[number]["preset"];

/**
 * A trade as a link from the website names it (crewtavo.com/…?trade=lawn): the preset's id, or the
 * short word for a featured one. Null when it isn't one.
 */
export function demoTradeFromLink(value: string | null | undefined, presets: readonly string[]): string | null {
  const word = (value ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (!word) return null;
  const short: Record<string, string> = { lawn: "lawn_exterior", lawn_care: "lawn_exterior", roofing: "roofing_exteriors", roof: "roofing_exteriors" };
  const preset = short[word] ?? word;
  return presets.includes(preset) ? preset : null;
}
