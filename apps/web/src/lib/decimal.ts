/**
 * Numbers as people type them in a box: with a decimal point in the US, and with a decimal comma in
 * much of the world ("12,50" in Canada, Europe or South Africa). The app keeps and saves numbers
 * with a point, so what's typed is read with decimalPoint first.
 */

/** Spaces between thousands, as Québec and much of Europe write them ("1 250,50", with a no-break space too). */
const GROUP_SPACE = /(\d)[ \u00A0\u202F\u2009](?=\d{3}(?!\d))/g;

/** One comma, with digits after it and digits before it (with dots only between thousands, "1.250,50"). */
const ONE_COMMA = /^(\s*[-+−]?\s*)(\d{1,3}(?:\.\d{3})+|\d*),(\d+)(\s*)$/;

/**
 * What's typed, with a decimal comma read as a point: "12,5" and "12,50" are 12.5, "0,125" is
 * 0.125, "1,2345" 1.2345, and "1.250,50" and "1 250,50" are 1250.50. A comma between one to three
 * digits (not a lone 0) and exactly three more stays a thousands separator, as in the US ("1,250"
 * is 1250, "1,250.50" 1250.50), and is left out, as is a comma still waiting for its digits ("12,"
 * while "12,5" is typed). Spaces between thousands are left out. Other text comes back as it is
 * ("2.", "0.50").
 */
export function decimalPoint(text: string): string {
  const typed = text.replace(GROUP_SPACE, "$1");
  if (!typed.includes(",")) return typed;
  const comma = ONE_COMMA.exec(typed);
  if (comma) {
    const [, sign, whole, fraction, end] = comma;
    const thousands = fraction!.length === 3 && /^[1-9]\d{0,2}$/.test(whole!);
    if (!thousands) return `${sign}${whole!.replace(/\./g, "")}.${fraction}${end}`;
  }
  return typed.replace(/,/g, "");
}

/**
 * An amount as typed with its currency ("£45", "$19,500.50", "R 1 250,50", "45 €"), as plain digits
 * with a point: the currency and spaces left out, a decimal comma read (decimalPoint).
 */
export const typedAmount = (text: string) => decimalPoint(text.replace(/\p{Sc}/gu, "").replace(/^\s*R(?=[\s\d])/, "")).replace(/\s/g, "");
