/**
 * The words and colors of an estimate or invoice: the business's initials, its website, license and
 * tax number as they print, the tax's line in the totals, the colors that read on its paper,
 * quantities and dates. Plain functions, so the server's PDF (apps/api/src/pdf) draws them the same
 * as the pages do; build.ts passes them on.
 */
import { taxLineLabel, taxNumberLabel, type Amount } from "@crewtavo/core/money";
import { dateTag } from "@crewtavo/core/regional";

/** "Ridgeline Roofing Co." -> "RR", for a business with no logo. */
export function initials(name: string): string {
  const words = name.replace(/[^\p{L}\p{N}\s&]/gu, " ").split(/\s+/).filter((w) => w && !/^(co|inc|llc|ltd|the|and|&)$/i.test(w));
  return (words.length ? words : [name]).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("") || "?";
}

/** A website as people read it: no "https://", no trailing slash. */
export const websiteLabel = (url: string | null | undefined) => (url ?? "").trim().replace(/^https?:\/\//i, "").replace(/\/$/, "");

/** The license line: "License #RC-104882", unless they typed the word themselves. */
export const licenseLine = (license: string) => (/^lic/i.test(license.trim()) ? license.trim() : `License ${license.trim()}`);

/** The business's tax number as it prints with its details: "VAT number GB123456789", "GST/HST number 123456789 RT0001". Null without one. */
export const taxNumberLine = (company: { taxName?: string; taxNumber?: string | null }) =>
  company.taxNumber?.trim() ? `${taxNumberLabel(company.taxName?.trim() || "Tax")} ${company.taxNumber.trim()}` : null;

/** The tax's line in the totals: its name and rate, "VAT (20%)", "Tax (8.875%)" (core taxLineLabel). */
export const taxLine = (company: { taxName?: string }, data: { taxRate?: number | null }) => taxLineLabel(company.taxName?.trim() || "Tax", data.taxRate);

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

/** How well two colors read against each other, as a contrast ratio from 1 to 21 (WCAG). Not a hex color: 1. */
export function contrastRatio(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)];
  if (x === null || y === null) return 1;
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/**
 * The text color for words on a band or a button of `hex` (a business's brand color, a template's
 * color): always at least 4.5:1 against it, which body-size text needs (WCAG 1.4.3). White or ink,
 * whichever reads better, where that's enough; on the mid-tones where neither is (white and ink
 * both come to about 3.9:1 on a medium orange or green), black, which is 4.58:1 at its worst.
 */
export function inkOn(hex: string): string {
  if (luminance(hex) === null) return "#ffffff";
  const [white, ink] = [contrastRatio("#ffffff", hex), contrastRatio(INK, hex)];
  if (Math.max(white, ink) >= 4.5) return white >= ink ? "#ffffff" : INK;
  return "#000000";
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

/**
 * "2026-10-22" or a timestamp -> "October 22, 2026", or "22 October 2026" for a business in a country
 * that writes the day first (`country`, core regional.ts dateTag); the US's way without one.
 */
export function longDate(value: string | null | undefined, country?: string | null): string {
  if (!value) return "";
  const d = new Date(value.length === 10 ? `${value}T12:00:00` : value);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString(dateTag(country), { month: "long", day: "numeric", year: "numeric" });
}

/**
 * "2026-10-24T18:14:00Z" -> "Oct 24, 2026" ("24 Oct 2026" where the day comes first: `country`), for
 * the date beside a signature: a moment's day where it's read, or in `timeZone` (the server's PDF says
 * whose). A day ("2026-10-24") is that day anywhere.
 */
export function shortDate(value: string | null | undefined, timeZone?: string, country?: string | null): string {
  if (!value) return "";
  const day = value.length === 10;
  const d = new Date(day ? `${value}T12:00:00` : value);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString(dateTag(country), { month: "short", day: "numeric", year: "numeric", ...(!day && timeZone && { timeZone }) });
}
