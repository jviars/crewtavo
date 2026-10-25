/**
 * Which countries' numbers get sign-in codes by text (Subcontractors → Settings, docs/subcontractors-plan.md
 * §7). US and Canadian numbers always do; the office adds others by calling code
 * (set_sub_sign_in_countries, kept in companies.settings.subs.sign_in_countries).
 */
import { isCallingCode, phoneDisplay, phoneE164, textsCodesTo } from "@crewtavo/core/phone";

/** The most other countries a company can add (the database refuses more). */
export const MAX_SIGN_IN_COUNTRIES = 20;

/**
 * Countries by their calling code (ITU E.164), left out: +1, which is always on, and codes for
 * satellite phones and other services. A code that isn't here can't be added, so a short one like
 * "4" can't open texting to a whole region by accident.
 */
export const CALLING_CODES: Readonly<Record<string, string>> = {
  "7": "Russia and Kazakhstan", "20": "Egypt", "27": "South Africa", "30": "Greece", "31": "Netherlands", "32": "Belgium", "33": "France", "34": "Spain",
  "36": "Hungary", "39": "Italy", "40": "Romania", "41": "Switzerland", "43": "Austria", "44": "United Kingdom", "45": "Denmark", "46": "Sweden",
  "47": "Norway", "48": "Poland", "49": "Germany", "51": "Peru", "52": "Mexico", "53": "Cuba", "54": "Argentina", "55": "Brazil", "56": "Chile",
  "57": "Colombia", "58": "Venezuela", "60": "Malaysia", "61": "Australia", "62": "Indonesia", "63": "Philippines", "64": "New Zealand",
  "65": "Singapore", "66": "Thailand", "81": "Japan", "82": "South Korea", "84": "Vietnam", "86": "China", "90": "Turkey", "91": "India",
  "92": "Pakistan", "93": "Afghanistan", "94": "Sri Lanka", "95": "Myanmar", "98": "Iran",
  "211": "South Sudan", "212": "Morocco", "213": "Algeria", "216": "Tunisia", "218": "Libya", "220": "Gambia", "221": "Senegal", "222": "Mauritania",
  "223": "Mali", "224": "Guinea", "225": "Côte d'Ivoire", "226": "Burkina Faso", "227": "Niger", "228": "Togo", "229": "Benin", "230": "Mauritius",
  "231": "Liberia", "232": "Sierra Leone", "233": "Ghana", "234": "Nigeria", "235": "Chad", "236": "Central African Republic", "237": "Cameroon",
  "238": "Cape Verde", "239": "São Tomé and Príncipe", "240": "Equatorial Guinea", "241": "Gabon", "242": "Congo", "243": "DR Congo", "244": "Angola",
  "245": "Guinea-Bissau", "248": "Seychelles", "249": "Sudan", "250": "Rwanda", "251": "Ethiopia", "252": "Somalia", "253": "Djibouti", "254": "Kenya",
  "255": "Tanzania", "256": "Uganda", "257": "Burundi", "258": "Mozambique", "260": "Zambia", "261": "Madagascar", "262": "Réunion and Mayotte",
  "263": "Zimbabwe", "264": "Namibia", "265": "Malawi", "266": "Lesotho", "267": "Botswana", "268": "Eswatini", "269": "Comoros", "290": "Saint Helena",
  "291": "Eritrea", "297": "Aruba", "298": "Faroe Islands", "299": "Greenland",
  "350": "Gibraltar", "351": "Portugal", "352": "Luxembourg", "353": "Ireland", "354": "Iceland", "355": "Albania", "356": "Malta", "357": "Cyprus",
  "358": "Finland", "359": "Bulgaria", "370": "Lithuania", "371": "Latvia", "372": "Estonia", "373": "Moldova", "374": "Armenia", "375": "Belarus",
  "376": "Andorra", "377": "Monaco", "378": "San Marino", "380": "Ukraine", "381": "Serbia", "382": "Montenegro", "383": "Kosovo", "385": "Croatia",
  "386": "Slovenia", "387": "Bosnia and Herzegovina", "389": "North Macedonia", "420": "Czechia", "421": "Slovakia", "423": "Liechtenstein",
  "500": "Falkland Islands", "501": "Belize", "502": "Guatemala", "503": "El Salvador", "504": "Honduras", "505": "Nicaragua", "506": "Costa Rica",
  "507": "Panama", "508": "Saint Pierre and Miquelon", "509": "Haiti", "590": "Guadeloupe", "591": "Bolivia", "592": "Guyana", "593": "Ecuador",
  "594": "French Guiana", "595": "Paraguay", "596": "Martinique", "597": "Suriname", "598": "Uruguay", "599": "Curaçao",
  "670": "Timor-Leste", "673": "Brunei", "674": "Nauru", "675": "Papua New Guinea", "676": "Tonga", "677": "Solomon Islands", "678": "Vanuatu",
  "679": "Fiji", "680": "Palau", "681": "Wallis and Futuna", "682": "Cook Islands", "683": "Niue", "685": "Samoa", "686": "Kiribati",
  "687": "New Caledonia", "688": "Tuvalu", "689": "French Polynesia", "690": "Tokelau", "691": "Micronesia", "692": "Marshall Islands",
  "850": "North Korea", "852": "Hong Kong", "853": "Macau", "855": "Cambodia", "856": "Laos", "880": "Bangladesh", "886": "Taiwan",
  "960": "Maldives", "961": "Lebanon", "962": "Jordan", "963": "Syria", "964": "Iraq", "965": "Kuwait", "966": "Saudi Arabia", "967": "Yemen",
  "968": "Oman", "970": "Palestine", "971": "United Arab Emirates", "972": "Israel", "973": "Bahrain", "974": "Qatar", "975": "Bhutan",
  "976": "Mongolia", "977": "Nepal", "992": "Tajikistan", "993": "Turkmenistan", "994": "Azerbaijan", "995": "Georgia", "996": "Kyrgyzstan",
  "998": "Uzbekistan",
};

/** "+44 United Kingdom"; a code saved before it was checked against the list shows on its own. */
export const countryLabel = (code: string) => (CALLING_CODES[code] ? `+${code} ${CALLING_CODES[code]}` : `+${code}`);

/**
 * The calling code typed ("44", "+44", "0044" or "011 44" as dialed from the US), checked against
 * the list already on: the code to add, or what's wrong in plain words.
 */
export function readCallingCode(input: string, current: readonly string[]): { code: string } | { error: string } {
  const code = input.replace(/[^0-9+]/g, "").replace(/^\+/, "").replace(/^(011|00)/, "");
  if (!code) return { error: "Enter the country's calling code, like 44 for the UK." };
  if (code === "1") return { error: "US and Canadian numbers always get codes." };
  if (!isCallingCode(code) || !CALLING_CODES[code]) return { error: `+${code} isn't a country's calling code. It's 1 to 3 digits, like 44 for the UK.` };
  if (current.includes(code)) return { error: `${countryLabel(code)} is already on.` };
  if (current.length >= MAX_SIGN_IN_COUNTRIES) return { error: `Add up to ${MAX_SIGN_IN_COUNTRIES} countries.` };
  return { code };
}

/** The list to save with a code added, in the order the database keeps it (by number). */
export const withCountry = (current: readonly string[], code: string) => [...new Set([...current, code])].sort((a, b) => Number(a) - Number(b));

/** How to write a sub's mobile number so it gets sign-in codes, under the Mobile phone field. */
export const SUB_PHONE_HINT = "With the area code. Outside the US and Canada, start with + and the country code.";

/**
 * What a sub's sign-in code by text does with the number the office keeps for them (the sub's
 * dialog and their Sign-in card): the number codes go to, as it was read, which catches a number
 * read as another one ("55 1234 5678" is a US number without its +52); or why none can go. Null
 * when there's nothing to say: no number, or this Crewtavo can't text.
 */
export function signInPhoneNote(phone: string | null | undefined, countries: readonly string[], sms: boolean): { ok: boolean; text: string } | null {
  if (!sms || !phone?.trim()) return null;
  const e164 = phoneE164(phone);
  if (!e164) return { ok: false, text: "This number can't get sign-in codes. Write it with the area code, or with + and the country code for numbers outside the US and Canada." };
  if (!textsCodesTo(e164, countries)) {
    const code = Object.keys(CALLING_CODES).find((c) => e164.startsWith(`+${c}`));
    return { ok: false, text: `Sign-in codes don't go to ${code ? `numbers in ${CALLING_CODES[code]}` : "this country's numbers"} yet. Add the country under Sign-in codes by text on the Subcontractors page.` };
  }
  return { ok: true, text: `Sign-in codes by text go to ${phoneDisplay(e164)}.` };
}
