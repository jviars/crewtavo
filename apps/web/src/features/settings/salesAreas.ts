/**
 * Sales areas (Settings → Sales areas): zip codes as the database keeps and matches them
 * (private.postal_key, supabase/migrations/20261110000200_sales_areas.sql), and reading what
 * someone typed into a salesperson's zips.
 */

/** "46201-1234" -> "46201", "k1a 0b6" -> "K1A0B6". The same as private.postal_key. */
export function zipKey(text: string): string {
  const us = /^\s*(\d{5})/.exec(text);
  return us ? us[1]! : text.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/**
 * Whole zips or their first digits, split by commas, semicolons or lines (and spaces between
 * numbers, so "46201 46202" is two but "K1A 0B6" is one). Repeats once; anything that isn't a zip
 * comes back in `bad`.
 */
export function parseZips(text: string): { zips: string[]; bad: string[] } {
  const pieces = text.split(/[,;\n]+/).flatMap((p) => (/^[\d\s-]+$/.test(p) ? p.trim().split(/\s+/) : [p.trim()])).filter(Boolean);
  const zips: string[] = [];
  const bad: string[] = [];
  for (const piece of pieces) {
    const zip = zipKey(piece);
    if (!zip || zip.length > 10) bad.push(piece);
    else if (!zips.includes(zip)) zips.push(zip);
  }
  return { zips, bad };
}
