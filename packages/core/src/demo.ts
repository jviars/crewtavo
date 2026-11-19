/**
 * The public demo (CREWTAVO_DEMO=1, docs/demo.md): what the start screen offers and the server
 * makes. Every visitor answers what trade they're in and gets their own sample business in it,
 * deleted after DEMO_HOURS.
 */

/** How long a visitor's sample business lasts. */
export const DEMO_HOURS = 24;

/**
 * The trades the start screen asks about first, each with a sample business written for it
 * (apps/api/src/services/demoStories.ts). "Something else" lists the other trade presets, which get
 * a business made from their own price list.
 */
export const DEMO_TRADES = [
  { preset: "lawn_exterior", label: "Lawn care", blurb: "Weekly mowing routes, fertilizer programs, cleanups and snow." },
  { preset: "roofing_exteriors", label: "Roofing", blurb: "Roofs measured on the aerial, insurance claims and crews on site." },
  { preset: "paving", label: "Paving", blurb: "Takeoffs on the aerial, sealcoat and striping, GC work and retainage." },
] as const;

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
