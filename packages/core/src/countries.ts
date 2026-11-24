/**
 * The country a business works in (companies.country: Settings → Company, and sign-up), as an ISO
 * 3166-1 code: "US", "CA", "GB". It decides what follows the place rather than the language: how
 * addresses are found on the map and what their boxes are called, how a phone number typed without
 * its country code is completed, which US-only parts are offered (1099s, the FTC's 3-day notice,
 * postcards), and the paper PDFs are made on.
 *
 * Businesses made before it was asked got the guess from their time zone
 * (20261124100100_business_country.sql, private.country_for_zone: the same table as countryFor).
 */

/** Every ISO 3166-1 alpha-2 code in use; each one's name comes from Intl.DisplayNames. */
export const COUNTRY_CODES = [
  "AD", "AE", "AF", "AG", "AI", "AL", "AM", "AO", "AQ", "AR", "AS", "AT", "AU", "AW", "AX", "AZ",
  "BA", "BB", "BD", "BE", "BF", "BG", "BH", "BI", "BJ", "BL", "BM", "BN", "BO", "BQ", "BR", "BS", "BT", "BV", "BW", "BY", "BZ",
  "CA", "CC", "CD", "CF", "CG", "CH", "CI", "CK", "CL", "CM", "CN", "CO", "CR", "CU", "CV", "CW", "CX", "CY", "CZ",
  "DE", "DJ", "DK", "DM", "DO", "DZ", "EC", "EE", "EG", "EH", "ER", "ES", "ET", "FI", "FJ", "FK", "FM", "FO", "FR",
  "GA", "GB", "GD", "GE", "GF", "GG", "GH", "GI", "GL", "GM", "GN", "GP", "GQ", "GR", "GS", "GT", "GU", "GW", "GY",
  "HK", "HM", "HN", "HR", "HT", "HU", "ID", "IE", "IL", "IM", "IN", "IO", "IQ", "IR", "IS", "IT", "JE", "JM", "JO", "JP",
  "KE", "KG", "KH", "KI", "KM", "KN", "KP", "KR", "KW", "KY", "KZ", "LA", "LB", "LC", "LI", "LK", "LR", "LS", "LT", "LU", "LV", "LY",
  "MA", "MC", "MD", "ME", "MF", "MG", "MH", "MK", "ML", "MM", "MN", "MO", "MP", "MQ", "MR", "MS", "MT", "MU", "MV", "MW", "MX", "MY", "MZ",
  "NA", "NC", "NE", "NF", "NG", "NI", "NL", "NO", "NP", "NR", "NU", "NZ", "OM",
  "PA", "PE", "PF", "PG", "PH", "PK", "PL", "PM", "PN", "PR", "PS", "PT", "PW", "PY", "QA", "RE", "RO", "RS", "RU", "RW",
  "SA", "SB", "SC", "SD", "SE", "SG", "SH", "SI", "SJ", "SK", "SL", "SM", "SN", "SO", "SR", "SS", "ST", "SV", "SX", "SY", "SZ",
  "TC", "TD", "TF", "TG", "TH", "TJ", "TK", "TL", "TM", "TN", "TO", "TR", "TT", "TV", "TW", "TZ",
  "UA", "UG", "UM", "US", "UY", "UZ", "VA", "VC", "VE", "VG", "VI", "VN", "VU", "WF", "WS", "YE", "YT", "ZA", "ZM", "ZW",
] as const;

const KNOWN = new Set<string>(COUNTRY_CODES);

/** Whether a code is a country Crewtavo knows, in either case: "gb" is, "UK" isn't (it's GB). */
export const isCountryCode = (code: unknown): code is string => typeof code === "string" && KNOWN.has(code.trim().toUpperCase());

/** "GB" from " gb ", or null when it isn't a known country. */
export const countryCode = (code: unknown): string | null => (isCountryCode(code) ? code.trim().toUpperCase() : null);

/** The country's name, "United Kingdom", in English (the code itself where the runtime has no names). */
export function countryName(code: string): string {
  try {
    return new Intl.DisplayNames(["en"], { type: "region" }).of(code) ?? code;
  } catch {
    return code;
  }
}

/** The countries the choice lists first: the ones most businesses on Crewtavo are in. */
export const FIRST_COUNTRIES = ["US", "CA", "GB", "IE", "AU", "NZ", "ZA"] as const;

/** The countries to choose from: the first ones, then every other in name order. */
export function countryChoices(): Array<{ code: string; name: string }> {
  const first = new Set<string>(FIRST_COUNTRIES);
  const rest = COUNTRY_CODES.filter((c) => !first.has(c))
    .map((code) => ({ code, name: countryName(code) }))
    .sort((a, b) => a.name.localeCompare(b.name, "en"));
  return [...FIRST_COUNTRIES.map((code) => ({ code, name: countryName(code) })), ...rest];
}

/** Where the euro is the money: the euro area (Bulgaria from 2026), and the small states that use it. */
export const EURO_COUNTRIES = [
  "AT", "BE", "BG", "CY", "DE", "EE", "ES", "FI", "FR", "GR", "HR", "IE", "IT", "LT", "LU", "LV", "MT", "NL", "PT", "SI", "SK",
  "AD", "MC", "ME", "SM", "VA",
] as const;

/** The currency a business in this country most likely charges in, of the ones Crewtavo offers (core money CURRENCIES); US dollars otherwise. */
export function currencyForCountry(country: string | null | undefined): string {
  switch (country) {
    case "CA": return "CAD";
    case "AU": return "AUD";
    case "NZ": return "NZD";
    case "GB": return "GBP";
    case "ZA": return "ZAR";
    default: return (EURO_COUNTRIES as readonly string[]).includes(country ?? "") ? "EUR" : "USD";
  }
}

const CANADA_ZONES = new Set([
  "Toronto", "Montreal", "Vancouver", "Edmonton", "Calgary", "Winnipeg", "Regina", "Swift_Current", "Halifax", "Glace_Bay", "Moncton",
  "Goose_Bay", "St_Johns", "Whitehorse", "Dawson", "Dawson_Creek", "Fort_Nelson", "Creston", "Yellowknife", "Inuvik", "Iqaluit",
  "Rankin_Inlet", "Cambridge_Bay", "Resolute", "Atikokan", "Nipigon", "Thunder_Bay", "Rainy_River",
]);

/** Europe's zones by the country they're in, for the euro countries, the UK and Ireland. */
const EUROPE_ZONES: Record<string, string> = {
  London: "GB", Belfast: "GB", Guernsey: "GB", Jersey: "GB", Isle_of_Man: "GB", Dublin: "IE",
  Andorra: "AD", Monaco: "MC", Podgorica: "ME", San_Marino: "SM", Vatican: "VA",
  Amsterdam: "NL", Athens: "GR", Berlin: "DE", Busingen: "DE", Bratislava: "SK", Brussels: "BE", Helsinki: "FI", Lisbon: "PT",
  Ljubljana: "SI", Luxembourg: "LU", Madrid: "ES", Malta: "MT", Paris: "FR", Riga: "LV", Rome: "IT", Sofia: "BG", Tallinn: "EE",
  Vienna: "AT", Vilnius: "LT", Zagreb: "HR",
};

/**
 * The country a business in this time zone is most likely in, for the ones Crewtavo knows best;
 * the US otherwise (every zone before the country was asked was taken as the US). The database's
 * private.country_for_zone is the same table.
 */
export function countryFor(timeZone: string | null | undefined): string {
  const [area, city = ""] = String(timeZone ?? "").split("/");
  if (area === "America" && CANADA_ZONES.has(city)) return "CA";
  if (area === "Australia") return "AU";
  if (timeZone === "Pacific/Auckland" || timeZone === "Pacific/Chatham") return "NZ";
  if (timeZone === "Africa/Johannesburg") return "ZA";
  if (timeZone === "Atlantic/Madeira" || timeZone === "Atlantic/Azores") return "PT";
  if (timeZone === "Atlantic/Canary" || timeZone === "Africa/Ceuta") return "ES";
  if (timeZone === "Asia/Nicosia" || timeZone === "Asia/Famagusta" || timeZone === "Europe/Nicosia") return "CY";
  if (area === "Europe" && EUROPE_ZONES[city]) return EUROPE_ZONES[city];
  return "US";
}

/** A business's country: the one it chose, or the guess from its time zone for a business the database hasn't said (a sub's basics). */
export const businessCountry = (company: { country?: string | null; timezone?: string | null } | null | undefined): string =>
  countryCode(company?.country) ?? countryFor(company?.timezone);

/** What an address's boxes are called in a country, as a label and inside a sentence. */
export interface AddressLabels {
  /** The region box: "State", "Province", "County". */
  region: string;
  /** "state", "province", "county". */
  regionInText: string;
  /** Whether addresses there usually leave the region out: the UK's county. */
  regionOptional: boolean;
  /** The postal code box: "ZIP code", "Postal code", "Postcode". */
  postalCode: string;
  /** "ZIP code", "postal code", "postcode". */
  postalCodeInText: string;
}

/** The words an address form uses where the business is (core businessCountry); the US's when it isn't known. */
export function addressLabels(country: string | null | undefined): AddressLabels {
  switch (countryCode(country) ?? "US") {
    case "US": return { region: "State", regionInText: "state", regionOptional: false, postalCode: "ZIP code", postalCodeInText: "ZIP code" };
    case "CA": return { region: "Province", regionInText: "province", regionOptional: false, postalCode: "Postal code", postalCodeInText: "postal code" };
    case "GB": return { region: "County", regionInText: "county", regionOptional: true, postalCode: "Postcode", postalCodeInText: "postcode" };
    default: return { region: "State / Province / Region", regionInText: "state, province or region", regionOptional: false, postalCode: "Postal code", postalCodeInText: "postal code" };
  }
}

/** How long a region may be: long enough for "Newfoundland and Labrador" and "Australian Capital Territory". */
export const REGION_MAX = 100;
