/**
 * Numbers as people type them in a box: with a decimal point in the US, and with a decimal comma in
 * much of the world ("12,50" in Canada, Europe or South Africa). The app keeps and saves numbers
 * with a point, so what's typed is read with decimalPoint first.
 */

/** A decimal comma: one comma with one or two digits after it, and digits before it (with dots only between thousands, "1.250,50"). */
const DECIMAL_COMMA = /^(\s*[-+−]?\s*)(\d{1,3}(?:\.\d{3})+|\d*),(\d{1,2})(\s*)$/;

/**
 * What's typed, with a decimal comma read as a point: "12,5" and "12,50" are 12.5, as is "1.250,50"
 * 1250.50. A comma before three digits stays a thousands separator, as in the US ("1,250" is 1250,
 * "1,250.50" 1250.50), and is left out, as is a comma still waiting for its digits ("12," while
 * "12,5" is typed). Text without a comma comes back as it is ("2.", "0.50").
 */
export function decimalPoint(text: string): string {
  if (!text.includes(",")) return text;
  const comma = DECIMAL_COMMA.exec(text);
  if (comma) return `${comma[1]}${comma[2]!.replace(/\./g, "")}.${comma[3]}${comma[4]}`;
  return text.replace(/,/g, "");
}
