/** Small checks and formatting for what people type into contact fields (components/ui/Field.tsx uses them too). */
import { companyCountry } from "./format";

/** Just the digits of a phone number: "(540) 555-0123" -> "5405550123". */
export const phoneDigits = (value: string) => value.replace(/\D/g, "");

/**
 * Phone numbers are written the North American way, 10 digits with the area code: the business is
 * in the US or Canada (lib/format.ts companyCountry). Elsewhere numbers have other lengths and
 * layouts, and are left as typed.
 */
export const northAmericanPhones = () => ["US", "CA"].includes(companyCountry());

/** An email with a name, an @ and a domain with a dot in it: "sam@acme.co" but not "sam@acme". */
export const isCompleteEmail = (value: string) => /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(value.trim());

/** A US number laid out the way it's read: up to 3 digits as typed, then "(540) 5", "(540) 555-0", "(540) 555-0123". */
function layoutPhone(digits: string): string {
  if (digits.length <= 3) return digits;
  if (digits.length <= 6) return `(${digits.slice(0, 3)}) ${digits.slice(3)}`;
  return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
}

/**
 * Formats a US phone number as it's typed, for a tel input's onChange:
 * onChange={(e) => setPhone(formatPhoneTyping(e.target.value))}.
 * International numbers ("+44…"), numbers with a leading 1 or more than 10 digits, and anything with
 * words or an extension in it ("ext. 12", "cell") are left as typed. A separator is only added once a
 * digit follows it, and backspacing over one removes the digit before it, so deleting never fights back.
 * Only for a business in the US or Canada (northAmericanPhones): elsewhere a 10-digit number isn't
 * a US one ("02 9876 5432"), so every number is left as typed.
 */
export function formatPhoneTyping(value: string): string {
  if (!northAmericanPhones()) return value;
  const trimmed = value.trimStart();
  if (trimmed.startsWith("+") || /[^\d\s().-]/.test(value)) return value;
  const digits = phoneDigits(value);
  if (digits.startsWith("1") || digits.length > 10) return value;
  const laidOut = layoutPhone(digits);
  if (value === laidOut) return value;
  // One separator gone from inside a laid-out number means it was just backspaced over: take the digit
  // before it too. Gone right before the last digit, it's the digit just typed that needs one.
  if (value.length === laidOut.length - 1) {
    let at = 0;
    while (at < value.length && value[at] === laidOut[at]) at++;
    if (!/\d/.test(laidOut[at]) && value.length - at > 1 && value === laidOut.slice(0, at) + laidOut.slice(at + 1)) {
      const before = phoneDigits(laidOut.slice(0, at)).length;
      if (!before) return value;
      return layoutPhone(digits.slice(0, before - 1) + digits.slice(before));
    }
  }
  return laidOut;
}
