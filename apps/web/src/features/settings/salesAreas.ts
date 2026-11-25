/**
 * Sales areas (Settings → Sales areas): zip codes as the database keeps them (private.postal_key,
 * supabase/migrations/20261110000200_sales_areas.sql), reading what someone typed into a
 * salesperson's zips, and how the codes are explained where the business is. The database matches
 * them (private.postal_in_area, 20261124100210_postcode_districts.sql), as core forms.ts
 * postalInArea does a booking form's service areas: by their start, with a UK district whole.
 */
import { countryCode } from "@crewtavo/core/countries";

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

/** How the codes an area is made of are explained, in the words and examples of the business's country. */
export interface AreaWords {
  /** Settings → Sales areas' note. */
  note: string;
  /** What a salesperson's empty box shows. */
  placeholder: string;
  /** One code, in a sentence: "zip code", "postcode". */
  code: string;
  /** Codes, in a sentence: "zip codes", "postcodes". */
  codes: string;
  /** A booking form's service areas: the box's label, an example of what a code covers, and what it shows empty. */
  serviceLabel: string;
  serviceExample: string;
  servicePlaceholder: string;
}

export function areaWords(country: string | null | undefined): AreaWords {
  switch (countryCode(country) ?? "US") {
    case "US":
      return {
        note: "Put in whole zip codes, or the first digits for a wider area: 462 covers every zip that starts with 462, and 46201 still goes to whoever has it.",
        placeholder: "Like 46201, 46202, 462",
        code: "zip code",
        codes: "zip codes",
        serviceLabel: "Service area ZIP codes",
        serviceExample: "like 241 for 24141",
        servicePlaceholder: "24151, 24065, 24184",
      };
    case "CA":
      return {
        note: "Put in whole postal codes, or their first characters for a wider area: K1A covers every postal code that starts with K1A, and K1A 0B6 still goes to whoever has it.",
        placeholder: "Like K1A 0B6, K1A, K1",
        code: "postal code",
        codes: "postal codes",
        serviceLabel: "Service area postal codes",
        serviceExample: "like M5V for M5V 2T6",
        servicePlaceholder: "M5V, M5H, K1A",
      };
    case "GB":
      return {
        note: "Put in whole postcodes, or a sector, district or area for a wider one: SW1 covers SW1A 1AA but not SW10 1AA, and SW1A 1AA still goes to whoever has it.",
        placeholder: "Like SW1A 1AA, SW1, SW",
        code: "postcode",
        codes: "postcodes",
        serviceLabel: "Service area postcodes",
        serviceExample: "like SW1 for SW1A 1AA, though not for SW10 1AA",
        servicePlaceholder: "SW1, SW3, SW7",
      };
    default:
      return {
        note: "Put in whole postal codes, or their first characters for a wider area: a code covers every postal code that starts with it, and a longer one still goes to whoever has it.",
        placeholder: "Postal codes, or how they start",
        code: "postal code",
        codes: "postal codes",
        serviceLabel: "Service area postal codes",
        serviceExample: "like 1012 for 1012 AB",
        servicePlaceholder: "",
      };
  }
}
