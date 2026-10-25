/**
 * Phone numbers in one spelling, E.164 ("+15405550101"), so a number typed on the sign-in page
 * matches the one the office keeps for a sub however either was written (Text me a code,
 * docs/subcontractors-plan.md §7). The same rules as private.phone_e164() in Postgres
 * (supabase/migrations/20261025005001_sign_in_codes.sql), which reads the office's numbers, so the
 * two always agree:
 *
 * - Spaces, dashes, dots, brackets and anything else that isn't a digit are left out. A + only
 *   counts at the start.
 * - 10 digits, or 11 starting with 1, are a US or Canadian number (+1, the North American plan). Its
 *   area code doesn't start with 0 or 1.
 * - Any other country's number starts with + (or 00, or 011 as dialed from the US) and the
 *   country's calling code: 7 to 15 digits in all.
 *
 * Codes are texted to US and Canadian numbers, and to other countries' only when the sub's company
 * lists their calling code (companies.settings.subs.sign_in_countries, subSettings in subs.ts).
 */

/** The number in E.164, or null when it isn't a whole phone number. */
export function phoneE164(input: string | null | undefined): string | null {
  const s = (input ?? "").replace(/[^0-9+]/g, "");
  if (!/^\+?[0-9]+$/.test(s)) return null;
  const digits = s.startsWith("+")
    ? s.slice(1)
    : s.startsWith("011")
      ? s.slice(3)
      : s.startsWith("00")
        ? s.slice(2)
        : s.length === 10
          ? `1${s}`
          : s.length === 11 && s.startsWith("1")
            ? s
            : null;
  if (digits === null) return null;
  if (digits.startsWith("1")) return /^1[2-9][0-9]{9}$/.test(digits) ? `+${digits}` : null;
  return /^[2-9][0-9]{6,14}$/.test(digits) ? `+${digits}` : null;
}

/** "44" for the UK, "52" for Mexico: a country's calling code, as the setting keeps it (1 is always on). */
export const isCallingCode = (code: string) => /^[1-9][0-9]{0,2}$/.test(code);

/**
 * Whether sign-in codes go to this E.164 number for a company: every +1 number, and another
 * country's only when the company lists its calling code. Calling codes never begin with another
 * one, so the number's start says which country it is.
 */
export function textsCodesTo(e164: string, countries: readonly string[]): boolean {
  if (e164.startsWith("+1")) return true;
  return countries.some((code) => isCallingCode(code) && e164.startsWith(`+${code}`));
}

/** What someone typed, in E.164, when it's a number sign-in codes go to for the company; otherwise null. */
export function signInPhone(input: string | null | undefined, countries: readonly string[] = []): string | null {
  const e164 = phoneE164(input);
  return e164 && textsCodesTo(e164, countries) ? e164 : null;
}

/** "(540) 555-0101" for a US or Canadian number in E.164 ("We texted a code to ..."); other countries' as they are. */
export function phoneDisplay(e164: string): string {
  const us = /^\+1([0-9]{3})([0-9]{3})([0-9]{4})$/.exec(e164);
  return us ? `(${us[1]}) ${us[2]}-${us[3]}` : e164;
}
