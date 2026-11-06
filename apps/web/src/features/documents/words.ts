/**
 * The words and colors of an estimate or invoice: the business's initials, its website and license
 * as they print, the colors that read on its paper, quantities and dates. Plain functions, so the
 * server's PDF (apps/api/src/pdf) draws them the same as the pages do; build.ts passes them on.
 */
import type { Amount } from "@crewtavo/core/money";

/** "Ridgeline Roofing Co." -> "RR", for a business with no logo. */
export function initials(name: string): string {
  const words = name.replace(/[^\p{L}\p{N}\s&]/gu, " ").split(/\s+/).filter((w) => w && !/^(co|inc|llc|ltd|the|and|&)$/i.test(w));
  return (words.length ? words : [name]).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("") || "?";
}

/** A website as people read it: no "https://", no trailing slash. */
export const websiteLabel = (url: string | null | undefined) => (url ?? "").trim().replace(/^https?:\/\//i, "").replace(/\/$/, "");

/** The license line: "License #RC-104882", unless they typed the word themselves. */
export const licenseLine = (license: string) => (/^lic/i.test(license.trim()) ? license.trim() : `License ${license.trim()}`);

// ---------------------------------------------------------------------------------------------
// Colors on paper
// ---------------------------------------------------------------------------------------------

function luminance(hex: string): number | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1]!, 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

const INK = "#0f2a35";

/** The text color that reads best on a band of `hex`: white, or ink on a light color. */
export function inkOn(hex: string): string {
  const l = luminance(hex);
  if (l === null) return "#ffffff";
  return 1.05 / (l + 0.05) >= (l + 0.05) / (luminance(INK)! + 0.05) ? "#ffffff" : INK;
}

/** The color for words on white paper: the document's color, or ink when it's too light to read. */
export function readableOnWhite(hex: string): string {
  const l = luminance(hex);
  return l !== null && 1.05 / (l + 0.05) >= 3 ? hex : INK;
}

// ---------------------------------------------------------------------------------------------
// Words and numbers on the page
// ---------------------------------------------------------------------------------------------

const BARE = new Set(["", "ea", "each", "lump sum", "ls", "lot"]);
const SHORT: Record<string, string> = { square: "sq", squares: "sq", sq: "sq", hour: "hr", hours: "hr", hrs: "hr", foot: "ft", feet: "ft", "linear ft": "ft", "lin ft": "ft", lf: "ft", sqft: "sq ft", "square feet": "sq ft" };
const ABBREVIATED = new Set(["sq", "ft", "sq ft", "sq yd", "yd", "cu yd", "cy", "hr", "sf", "in", "lb", "lbs", "gal", "mo", "wk", "km", "m", "m2", "sq m", "kg", "l"]);

function plural(word: string): string {
  if (/(s|x|z|ch|sh)$/i.test(word)) return `${word}es`;
  if (/[^aeiou]y$/i.test(word)) return `${word.slice(0, -1)}ies`;
  return `${word}s`;
}

/** A quantity as written on the page: "24.2 sq", "210 ft", "6 sheets", or just "3" for each. */
export function quantityLabel(quantity: Amount, unit: string | null | undefined): string {
  const q = Number(quantity ?? 0);
  const number = q.toLocaleString("en-US", { maximumFractionDigits: 2 });
  const u = (unit ?? "").trim().toLowerCase();
  if (BARE.has(u)) return number;
  const short = SHORT[u] ?? u;
  if (ABBREVIATED.has(short) || q === 1 || /\s/.test(short) || /s$/.test(short)) return `${number} ${short}`;
  return `${number} ${plural(short)}`;
}

/** "2026-10-22" or a timestamp -> "October 22, 2026". */
export function longDate(value: string | null | undefined): string {
  if (!value) return "";
  const d = new Date(value.length === 10 ? `${value}T12:00:00` : value);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
}

/**
 * "2026-10-24T18:14:00Z" -> "Oct 24, 2026", for the date beside a signature: a moment's day where
 * it's read, or in `timeZone` (the server's PDF says whose). A day ("2026-10-24") is that day anywhere.
 */
export function shortDate(value: string | null | undefined, timeZone?: string): string {
  if (!value) return "";
  const day = value.length === 10;
  const d = new Date(day ? `${value}T12:00:00` : value);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", ...(!day && timeZone && { timeZone }) });
}
