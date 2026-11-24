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
 * 5678); the prefix dialled before another country's code besides 00; how many digits a
 * number has after its calling code, fewest and most; and a mobile number written as it is there,
 * for a phone box's example (phoneExample).
 */
interface Dialing {
  code: string;
  trunk: string;
  exit?: string;
  digits: [number, number];
  example: string;
}

/**
 * The countries whose numbers internationalPhone completes. The US and Canada aren't here: their
 * numbers go to Twilio as typed, as they always have, and it reads them. Nor is a country whose
 * rules aren't certain here: its numbers stay as typed too.
 */
const DIALING: Record<string, Dialing> = {
  GB: { code: "44", trunk: "0", digits: [9, 10], example: "07700 900123" },
  IE: { code: "353", trunk: "0", digits: [7, 9], example: "087 123 4567" },
  AU: { code: "61", trunk: "0", exit: "0011", digits: [9, 9], example: "0412 345 678" },
  NZ: { code: "64", trunk: "0", digits: [8, 10], example: "021 123 4567" },
  ZA: { code: "27", trunk: "0", digits: [9, 9], example: "082 123 4567" },
  AT: { code: "43", trunk: "0", digits: [4, 13], example: "0664 1234567" },
  BE: { code: "32", trunk: "0", digits: [8, 9], example: "0470 12 34 56" },
  BG: { code: "359", trunk: "0", digits: [7, 9], example: "087 123 4567" },
  CY: { code: "357", trunk: "", digits: [8, 8], example: "96 123456" },
  DE: { code: "49", trunk: "0", digits: [6, 13], example: "0151 23456789" },
  EE: { code: "372", trunk: "", digits: [7, 8], example: "5123 4567" },
  ES: { code: "34", trunk: "", digits: [9, 9], example: "612 34 56 78" },
  FI: { code: "358", trunk: "0", digits: [5, 12], example: "040 1234567" },
  FR: { code: "33", trunk: "0", digits: [9, 9], example: "06 12 34 56 78" },
  GR: { code: "30", trunk: "", digits: [10, 10], example: "691 234 5678" },
  HR: { code: "385", trunk: "0", digits: [8, 9], example: "091 234 5678" },
  IT: { code: "39", trunk: "", digits: [6, 11], example: "347 123 4567" },
  LU: { code: "352", trunk: "", digits: [4, 11], example: "621 123 456" },
  LV: { code: "371", trunk: "", digits: [8, 8], example: "21 234 567" },
  MT: { code: "356", trunk: "", digits: [8, 8], example: "9912 3456" },
  NL: { code: "31", trunk: "0", digits: [9, 9], example: "06 12345678" },
  PT: { code: "351", trunk: "", digits: [9, 9], example: "912 345 678" },
  SI: { code: "386", trunk: "0", digits: [8, 8], example: "031 234 567" },
  SK: { code: "421", trunk: "0", digits: [9, 9], example: "0912 123 456" },
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
 * - One without either, in a country with a trunk prefix, is completed only when it starts with the
 *   calling code ("44 7700 900123"): its own numbers are written with the 0, so "540 555 0101" is
 *   more likely an American client's kept without its +1 than a UK number missing its 0, and is
 *   left as typed rather than sent to +44 5405 550101.
 * - In a country without one, it's the country's own number ("612 345 678" in Spain), or one with
 *   the calling code but no + ("34 612 345 678"): told apart by how many digits the country's
 *   numbers have; where both fit, it's taken as the country's own (Italy's 393 mobiles).
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
  if (dialing.trunk) return withCode ? `+${s}` : input;
  if (withCode && !fits(s)) return `+${s}`;
  return fits(s) ? `+${dialing.code}${s}` : input;
}

const lastTen = (number: string) => number.replace(/\D/g, "").slice(-10);

/**
 * The number a text is sent to: internationalPhone's, when replies and STOPs from it will still find
 * the client. Those are matched by the number's last 10 digits (recipients.ts phoneMatchKey, the
 * API's phoneKey), which a UK number keeps when "07700 900123" becomes +447700900123. Where the
 * country code changes them, an Irish "087 123 4567" becoming +353871234567, the number goes as
 * typed, as it always did, rather than reach someone whose "stop" Crewtavo couldn't match to them.
 */
export function textedNumber(input: string, country: string | null | undefined): string {
  const done = internationalPhone(input, country);
  return done === input || lastTen(done) === lastTen(input) ? done : input;
}

/**
 * A mobile number as people in `country` write it, for a phone box's example: "07700 900123" in
 * the UK. Null in the US and Canada, and where Crewtavo doesn't know how the country's numbers are
 * written: the box keeps its own US example there, "(555) 555-0123".
 */
export const phoneExample = (country: string | null | undefined): string | null => DIALING[(country ?? "").trim().toUpperCase()]?.example ?? null;

/** "(540) 555-0101" for a US or Canadian number in E.164 ("We texted a code to ..."); other countries' as they are. */
export function phoneDisplay(e164: string): string {
  const us = /^\+1([0-9]{3})([0-9]{3})([0-9]{4})$/.exec(e164);
  return us ? `(${us[1]}) ${us[2]}-${us[3]}` : e164;
}
