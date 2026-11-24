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

/**
 * How a country's numbers are written at home, for completing one typed without its country code
 * (internationalPhone): the calling code; the trunk prefix dialled before the area code at home and
 * dropped after the calling code ("07700 900123" is +44 7700 900123), or "" where there's none
 * (Spain's "612 345 678" is +34 612 345 678, and Italy keeps its 0: "06 1234 5678" is +39 06 1234
 * 5678); the prefix dialled before another country's code besides 00; and how many digits a
 * number has after its calling code, fewest and most.
 */
interface Dialing {
  code: string;
  trunk: string;
  exit?: string;
  digits: [number, number];
}

/**
 * The countries whose numbers internationalPhone completes. The US and Canada aren't here: their
 * numbers go to Twilio as typed, as they always have, and it reads them. Nor is a country whose
 * rules aren't certain here: its numbers stay as typed too.
 */
const DIALING: Record<string, Dialing> = {
  GB: { code: "44", trunk: "0", digits: [9, 10] },
  IE: { code: "353", trunk: "0", digits: [7, 9] },
  AU: { code: "61", trunk: "0", exit: "0011", digits: [9, 9] },
  NZ: { code: "64", trunk: "0", digits: [8, 10] },
  ZA: { code: "27", trunk: "0", digits: [9, 9] },
  AT: { code: "43", trunk: "0", digits: [4, 13] },
  BE: { code: "32", trunk: "0", digits: [8, 9] },
  BG: { code: "359", trunk: "0", digits: [7, 9] },
  CY: { code: "357", trunk: "", digits: [8, 8] },
  DE: { code: "49", trunk: "0", digits: [6, 13] },
  EE: { code: "372", trunk: "", digits: [7, 8] },
  ES: { code: "34", trunk: "", digits: [9, 9] },
  FI: { code: "358", trunk: "0", digits: [5, 12] },
  FR: { code: "33", trunk: "0", digits: [9, 9] },
  GR: { code: "30", trunk: "", digits: [10, 10] },
  HR: { code: "385", trunk: "0", digits: [8, 9] },
  IT: { code: "39", trunk: "", digits: [6, 11] },
  LU: { code: "352", trunk: "", digits: [4, 11] },
  LV: { code: "371", trunk: "", digits: [8, 8] },
  MT: { code: "356", trunk: "", digits: [8, 8] },
  NL: { code: "31", trunk: "0", digits: [9, 9] },
  PT: { code: "351", trunk: "", digits: [9, 9] },
  SI: { code: "386", trunk: "0", digits: [8, 8] },
  SK: { code: "421", trunk: "0", digits: [9, 9] },
};

/**
 * The number to send a text to, for a business in `country` (core countries.ts): completed with the
 * country's calling code when it was typed without one, in E.164, which Twilio wants. Client and
 * contact numbers are kept as the office typed them, so a UK business's "07700 900123" is texted
 * as +447700900123, and its "020 7946 0018" as +442079460018.
 *
 * - A US or Canadian business's numbers are returned as typed, as they were always sent; so is
 *   every number for a country not in DIALING, and anything that isn't a phone number.
 * - A number starting with + or 00 (Australia's 0011 too) already has its country code: it's
 *   only spelled in E.164. "+44 (0)20 7946 0018" leaves out the (0).
 * - One starting with the trunk prefix ("07700 900123") gets the calling code in its place.
 * - One without either is the country's own number written without its trunk prefix ("7700
 *   900123"), or one with the calling code but no + ("44 7700 900123"): told apart by how many
 *   digits the country's numbers have. Where both fit, a country with a trunk prefix takes it as
 *   having the calling code (its own numbers are written with the 0), one without takes it as its
 *   own (Italy's 393 mobiles).
 * - A number too long or short for the country is left as typed.
 *
 * Not phoneE164: that one reads every number as North American unless it says otherwise, as
 * private.phone_e164 does for a sub's sign-in.
 */
export function internationalPhone(input: string, country: string | null | undefined): string {
  const dialing = DIALING[(country ?? "").trim().toUpperCase()];
  if (!dialing) return input;
  const s = input.replace(/\(0\)/g, "").replace(/[^0-9+]/g, "");
  if (!/^\+?[0-9]+$/.test(s)) return input;
  if (s.startsWith("+")) return s;
  const fits = (digits: string) => digits.length >= dialing.digits[0] && digits.length <= dialing.digits[1];
  for (const exit of [dialing.exit, "00"]) {
    if (exit && s.startsWith(exit)) return /^[1-9][0-9]{6,14}$/.test(s.slice(exit.length)) ? `+${s.slice(exit.length)}` : input;
  }
  if (dialing.trunk && s.startsWith(dialing.trunk)) {
    const national = s.slice(dialing.trunk.length);
    return fits(national) ? `+${dialing.code}${national}` : input;
  }
  const withCode = s.startsWith(dialing.code) && fits(s.slice(dialing.code.length));
  if (withCode && (dialing.trunk !== "" || !fits(s))) return `+${s}`;
  return fits(s) ? `+${dialing.code}${s}` : input;
}

/** "(540) 555-0101" for a US or Canadian number in E.164 ("We texted a code to ..."); other countries' as they are. */
export function phoneDisplay(e164: string): string {
  const us = /^\+1([0-9]{3})([0-9]{3})([0-9]{4})$/.exec(e164);
  return us ? `(${us[1]}) ${us[2]}-${us[3]}` : e164;
}
