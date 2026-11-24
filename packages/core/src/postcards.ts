/**
 * Postcards by mail: a one-off campaign printed and mailed through the business's own Lob account
 * (Apps → Lob; apps/api/src/integrations/lob.ts). Shared by the API, which builds what Lob prints,
 * and Marketing → Campaigns, which previews exactly that at its real size: the card's sizes, the
 * words on its back, the address it goes to, and why a client is left out. The database picks who
 * it goes to the same way (public.postcard_audience, 20261113001400_postcards.sql).
 */
import { renderTemplate, type TemplateVars } from "./automations";
import { countryCode, countryInText } from "./countries";

// ---------------------------------------------------------------------------------------------
// Sizes
// ---------------------------------------------------------------------------------------------

export const POSTCARD_SIZES = ["4x6", "6x9", "6x11"] as const;
export type PostcardSize = (typeof POSTCARD_SIZES)[number];
export const isPostcardSize = (value: unknown): value is PostcardSize => typeof value === "string" && (POSTCARD_SIZES as readonly string[]).includes(value);

/**
 * How long after a campaign's last card its front picture stays up and Lob is asked whether any
 * card failed. Lob fetches the picture from this server when it draws each card, soon after it
 * accepts it, and holds a card for its cancellation window before printing; a week covers both with
 * room to spare. The database keeps the campaign from being deleted for as long
 * (postcard_campaign_guard, 20261113001555_postcard_proofs_and_failures.sql).
 */
export const POSTCARD_KEEP_DAYS = 7;
/** Lob's link to its picture of a card stops working this long after it's given (docs.lob.com, the postcard object's `url`). */
export const LOB_PROOF_DAYS = 30;

/** What's printed past the edge on every side, so a picture runs to the edge once the card is cut. */
export const BLEED_IN = 0.125;

/**
 * Each size as mailed, wide side across, in inches. Lob names them height by width ("4x6" is 6 in
 * across and 4 in high). `maxMessage` is guidance for the page ("about 600 characters fit"): what
 * ordinary sentences of that length come to on the back as backFit measures it, with room to
 * spare. Whether a client's card really fits is backFit's to say, not this number's.
 */
export const POSTCARD_SIZE_INFO: Record<PostcardSize, { width: number; height: number; label: string; maxMessage: number; fontPt: number }> = {
  "4x6": { width: 6, height: 4, label: "4 × 6 in", maxMessage: 600, fontPt: 10 },
  "6x9": { width: 9, height: 6, label: "6 × 9 in", maxMessage: 1300, fontPt: 12 },
  "6x11": { width: 11, height: 6, label: "6 × 11 in", maxMessage: 1500, fontPt: 12 },
};

/** A card's size with its bleed, as Lob takes the artwork. */
export const artboard = (size: PostcardSize) => ({ width: POSTCARD_SIZE_INFO[size].width + 2 * BLEED_IN, height: POSTCARD_SIZE_INFO[size].height + 2 * BLEED_IN });

/**
 * Lob's ink-free area on the back, where it prints the business's return address, the client's
 * address, the barcode and the postage itself: nothing of ours may be there. From Lob's templates
 * for each size (help.lob.com → Designing mail creatives → Mail piece design specs → Postcards, the
 * templates dated 4.3.26, read 2026-11-14): 3.2835 × 2.375 in on a 4x6 and 4 × 2.375 in on a 6x9 and
 * a 6x11, 0.275 in from the right edge and 0.25 in from the bottom of the artwork with its bleed
 * (0.15 in and 0.125 in from the cut card's). The one place to change if Lob's templates do.
 */
export const LOB_ADDRESS_BLOCK: Record<PostcardSize, { width: number; height: number; right: number; bottom: number }> = {
  "4x6": { width: 3.2835, height: 2.375, right: 0.275, bottom: 0.25 },
  "6x9": { width: 4, height: 2.375, right: 0.275, bottom: 0.25 },
  "6x11": { width: 4, height: 2.375, right: 0.275, bottom: 0.25 },
};

const inches = (value: number) => Math.round(value * 10_000) / 10_000;

/** Lob's address block on the artwork (with its bleed): its left and top edges and its size, in inches. */
export function addressBlock(size: PostcardSize): { left: number; top: number; width: number; height: number } {
  const art = artboard(size);
  const block = LOB_ADDRESS_BLOCK[size];
  return { left: inches(art.width - block.right - block.width), top: inches(art.height - block.bottom - block.height), width: block.width, height: block.height };
}

/** The message stays this far inside the cut edge, and this far from Lob's address block. */
const EDGE_IN = 0.25;
const BLOCK_GAP_IN = 0.125;
/** A line longer than this is hard to read: the widest the message runs on the big cards. */
const MAX_LINE_IN = 7;
const LINE_HEIGHT = 1.35;
/** The space after a paragraph, in ems. */
const PARAGRAPH_GAP_EM = 0.6;

/**
 * Where the message goes on the back, in inches on the artwork: a box inside the cut edge, with its
 * bottom right corner cut out for Lob's address block and a gap round it. The words run the box's
 * full width above the block (`aboveBlock` high) and `besideBlock` wide down its left side.
 */
export function backLayout(size: PostcardSize) {
  const art = artboard(size);
  const block = addressBlock(size);
  const inset = BLEED_IN + EDGE_IN;
  const width = inches(Math.min(art.width - 2 * inset, MAX_LINE_IN));
  const height = inches(art.height - 2 * inset);
  const cutWidth = inches(Math.max(0, inset + width - (block.left - BLOCK_GAP_IN)));
  const aboveBlock = inches(Math.max(0, block.top - BLOCK_GAP_IN - inset));
  const fontIn = POSTCARD_SIZE_INFO[size].fontPt / 72;
  return { left: inset, top: inset, width, height, cutWidth, aboveBlock, cutHeight: inches(height - aboveBlock), besideBlock: inches(width - cutWidth), fontIn, lineIn: fontIn * LINE_HEIGHT, paragraphGapIn: fontIn * PARAGRAPH_GAP_EM };
}

/**
 * The fewest dots per inch Lob asks of a picture ("When using PNGs or JPEGs with Lob, we require a
 * minimum of 300 dpi": help.lob.com → Creative formatting; its example is a 1275 × 1875 pixel image
 * for a 4.25 × 6.25 in postcard). Measured over the artwork with its bleed.
 */
export const LOB_MIN_DPI = 300;

/**
 * How sharp a picture prints on the front of a card of this size, where it fills the card past its
 * edges (cropped, never stretched out of shape): the dots per inch it comes to, the pixels Lob's
 * minimum takes at this size, and the biggest size it's sharp enough for (null when none).
 */
export function frontResolution(size: PostcardSize, picture: { width: number; height: number }) {
  const dpiAt = (s: PostcardSize) => Math.min(picture.width / artboard(s).width, picture.height / artboard(s).height);
  const art = artboard(size);
  const dpi = Math.floor(dpiAt(size));
  const sharpAt = [...POSTCARD_SIZES].reverse().find((s) => dpiAt(s) >= LOB_MIN_DPI) ?? null;
  return { ok: dpiAt(size) >= LOB_MIN_DPI, dpi, need: { width: Math.round(art.width * LOB_MIN_DPI), height: Math.round(art.height * LOB_MIN_DPI) }, sharpAt };
}

/** What to say when the front's picture is below Lob's minimum for the size, with the numbers, or null. */
export function frontResolutionWarning(size: PostcardSize, picture: { width: number; height: number }): string | null {
  const r = frontResolution(size, picture);
  if (r.ok) return null;
  const n = (value: number) => value.toLocaleString("en-US");
  const other = r.sharpAt ? ` It's sharp enough for a ${POSTCARD_SIZE_INFO[r.sharpAt].label} card.` : "";
  return `This picture is ${n(picture.width)} × ${n(picture.height)} pixels, which prints at about ${r.dpi} dots per inch on a ${POSTCARD_SIZE_INFO[size].label} card. Lob asks for at least ${LOB_MIN_DPI}, which at this size is ${n(r.need.width)} × ${n(r.need.height)} pixels, so it may print soft.${other}`;
}

// ---------------------------------------------------------------------------------------------
// The message
// ---------------------------------------------------------------------------------------------

/**
 * The merge fields a card's back can use: an email campaign's, except that {{link}} is printed, so
 * it's the business's booking form (or its website), which someone can type, not a Client Hub link.
 */
export const POSTCARD_TOKENS = [
  { token: "client.first_name", label: "First name" },
  { token: "client.name", label: "Full name" },
  { token: "company.name", label: "Your company" },
  { token: "company.phone", label: "Your phone" },
  { token: "link", label: "Booking link" },
] as const;

/** The words a client's card says. */
export function postcardMessage(template: string, vars: TemplateVars): string {
  return renderTemplate(template, vars).replace(/\r\n?/g, "\n").trim();
}

/**
 * How wide each character prints, in thousandths of the font size: Helvetica's widths (Arial's are
 * the same, as are the fonts made to stand in for them), for the space to the tilde. Anything else
 * (an accent, a dash, an emoji) is counted a whole em, which none of them is wider than.
 */
// prettier-ignore
const CHAR_WIDTHS = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, // space ! " # $ % & ' ( ) * + , - . /
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, // 0-9 : ; < = > ?
  1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, // @ A-O
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, // P-Z [ \ ] ^ _
  333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, // ` a-o
  556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584, // p-z { | } ~
];
/**
 * Lob prints with WebKit and doesn't say which fonts it has. If neither Helvetica nor Arial is there
 * the stand-in sans-serif can run wider (DejaVu Sans is about an eighth wider), so every line is
 * measured as if it did: a message that fits here fits there.
 */
const WIDTH_SAFETY = 1.15;

const charWidth = (ch: string, fontIn: number) => {
  const code = ch.codePointAt(0) ?? 0;
  return ((code >= 32 && code <= 126 ? CHAR_WIDTHS[code - 32]! : 1000) / 1000) * fontIn * WIDTH_SAFETY;
};

export interface BackFit {
  fits: boolean;
  /** How many lines the words take. */
  lines: number;
  /** How many of them run past the bottom of the card (0 when it fits). */
  over: number;
}

/**
 * Whether a message, as one client's card says it (merge fields filled in), fits the back at this
 * size, laid out as backHtml lays it out: wrapped a word at a time into lines the box's full width
 * above Lob's address block and the narrower width beside it, a word longer than a line broken
 * where the line ends, with the gap after each paragraph. Measured rather than counted in
 * characters, because a card whose words don't fit is cut off at the bottom when it's printed.
 */
export function backFit(size: PostcardSize, message: string): BackFit {
  const box = backLayout(size);
  const space = charWidth(" ", box.fontIn);
  let y = 0;
  let lines = 0;
  // A line that reaches down past where the block starts is one of the narrow ones.
  const room = () => (y + box.lineIn > box.aboveBlock + 1e-6 ? box.besideBlock : box.width);
  const endLine = () => {
    y += box.lineIn;
    lines++;
  };
  message.trim().split(/\n{2,}/).forEach((paragraph, index) => {
    if (index) y += box.paragraphGapIn;
    for (const typed of paragraph.trim().split("\n")) {
      let used = 0;
      for (const word of typed.trim().split(/\s+/).filter(Boolean)) {
        const width = [...word].reduce((sum, ch) => sum + charWidth(ch, box.fontIn), 0);
        if (used > 0 && used + space + width <= room()) {
          used += space + width;
          continue;
        }
        if (used > 0) {
          endLine();
          used = 0;
        }
        if (width <= room()) {
          used = width;
          continue;
        }
        for (const ch of word) {
          const w = charWidth(ch, box.fontIn);
          if (used > 0 && used + w > room()) {
            endLine();
            used = 0;
          }
          used += w;
        }
      }
      endLine();
    }
  });
  const over = Math.max(0, Math.ceil((y - box.height) / box.lineIn - 1e-6));
  return { fits: over === 0, lines, over };
}

/** Why a card's message can't be printed, or null. `message` is the words as a client's card says them. */
export function messageProblem(message: string, size: PostcardSize): string | null {
  const text = message.trim();
  if (text.length < 10) return "Write the message for the back of the card.";
  const fit = backFit(size, text);
  if (!fit.fits) return `The message is about ${fit.over} ${fit.over === 1 ? "line" : "lines"} too long for the back of a ${POSTCARD_SIZE_INFO[size].label} card. Shorten it or pick a bigger card.`;
  return null;
}

// ---------------------------------------------------------------------------------------------
// Mailing addresses
// ---------------------------------------------------------------------------------------------

export interface MailingAddress {
  line1: string;
  line2?: string | null;
  city: string;
  region: string;
  postal_code: string;
  country: "US";
}

type LooseAddress = { line1?: unknown; line2?: unknown; city?: unknown; region?: unknown; state?: unknown; postal_code?: unknown; zip?: unknown; country?: unknown } | null | undefined;

const text = (value: unknown) => (typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "");
const US = new Set(["", "us", "usa", "u.s.", "u.s.a.", "united states", "united states of america"]);
/** A US ZIP code, five digits or ZIP+4, however the last four are joined on ("62701-1234", "627011234", "62701 1234"). */
export const ZIP = /^(\d{5})(?:[- ]?(\d{4}))?$/;

/**
 * The two-letter codes the US Postal Service uses, with each one's name: the states, the District
 * of Columbia, the territories, and the three for armed forces mail. Lob takes a state only as two
 * letters (docs.lob.com, Postcards → Create: address_state is ^[a-zA-Z]{2}$), and the app's State
 * box takes anything, so "Illinois" has to become "IL" before a card is counted as mailable.
 * private.us_state_code (20261113001550_postcard_addresses.sql) has the same list.
 */
// prettier-ignore
export const US_STATES: Record<string, string> = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California", CO: "Colorado", CT: "Connecticut", DE: "Delaware",
  DC: "District of Columbia", FL: "Florida", GA: "Georgia", HI: "Hawaii", ID: "Idaho", IL: "Illinois", IN: "Indiana", IA: "Iowa",
  KS: "Kansas", KY: "Kentucky", LA: "Louisiana", ME: "Maine", MD: "Maryland", MA: "Massachusetts", MI: "Michigan", MN: "Minnesota",
  MS: "Mississippi", MO: "Missouri", MT: "Montana", NE: "Nebraska", NV: "Nevada", NH: "New Hampshire", NJ: "New Jersey", NM: "New Mexico",
  NY: "New York", NC: "North Carolina", ND: "North Dakota", OH: "Ohio", OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania", RI: "Rhode Island",
  SC: "South Carolina", SD: "South Dakota", TN: "Tennessee", TX: "Texas", UT: "Utah", VT: "Vermont", VA: "Virginia", WA: "Washington",
  WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming",
  AS: "American Samoa", GU: "Guam", MP: "Northern Mariana Islands", PR: "Puerto Rico", VI: "Virgin Islands",
  AA: "Armed Forces Americas", AE: "Armed Forces Europe", AP: "Armed Forces Pacific",
};
/** Other ways the same places are written. */
const STATE_ALIASES: Record<string, string> = { "washington dc": "DC", "washington, dc": "DC", "us virgin islands": "VI", "u s virgin islands": "VI" };
const STATE_BY_NAME = new Map<string, string>([...Object.entries(US_STATES).map(([code, name]) => [name.toLowerCase(), code] as const), ...Object.entries(STATE_ALIASES)]);

/** A state as typed ("IL", "il", "Illinois", "D.C.") as its two-letter code, or null when it isn't a US state. */
export function usStateCode(value: unknown): string | null {
  const typed = text(value).replace(/\./g, "").replace(/\s+/g, " ").trim().toLowerCase();
  if (!typed) return null;
  if (typed.length === 2 && typed.toUpperCase() in US_STATES) return typed.toUpperCase();
  return STATE_BY_NAME.get(typed) ?? null;
}

/** Lob's limits on what it takes for a street line and a city (docs.lob.com, Postcards → Create). */
const MAX_LINE = 64;
const MAX_CITY = 200;

/** Why an address can't be mailed to. */
export type AddressProblem = "no_address" | "outside_us" | "bad_state" | "too_long";

/**
 * Why an address can't be mailed to, or the address as Lob takes it. Complete is a street, a city,
 * a state and a US ZIP code; a blank country is the US, as everywhere in the app. The state comes
 * back as its two-letter code whether it was typed that way or in full, and the ZIP as 12345 or
 * 12345-6789. A state that isn't a US state ("bad_state") or a line longer than Lob takes
 * ("too_long") isn't mailable: Lob would refuse the card, so it isn't counted as one that goes.
 */
export function mailable(address: LooseAddress): MailingAddress | AddressProblem {
  const line1 = text(address?.line1);
  const line2 = text(address?.line2);
  const city = text(address?.city);
  const region = text(address?.region) || text(address?.state);
  const zip = ZIP.exec(text(address?.postal_code) || text(address?.zip));
  if (!line1 || !city || !region || !(text(address?.postal_code) || text(address?.zip))) return "no_address";
  if (!US.has(text(address?.country).toLowerCase()) || !zip) return "outside_us";
  const state = usStateCode(region);
  if (!state) return "bad_state";
  if (line1.length > MAX_LINE || line2.length > MAX_LINE || city.length > MAX_CITY) return "too_long";
  return { line1, line2: line2 || null, city, region: state, postal_code: zip[2] ? `${zip[1]}-${zip[2]}` : zip[1]!, country: "US" };
}

/**
 * Whether a company's own address is complete enough to stand under a marketing email. The FTC's
 * CAN-SPAM guide: "Your message must include your valid physical postal address. This can be your
 * current street address, a post office box you've registered with the U.S. Postal Service, or a
 * private mailbox you've registered with a commercial mail receiving agency". Read as a postcard's
 * return address is (mailable): a street or box, a city, a state and a ZIP code. Lob's own limits
 * (US only, two-letter states, 64 characters a line) are for cards alone, so an address that's all
 * there but that Lob wouldn't take still counts, and one outside the US needs no state.
 *
 * An address that doesn't say its country (the company's, from Settings → Company, never does) is
 * in the business's `country` (companies.country): in the US as before, and in Canada, whose
 * addresses always have their province; elsewhere the region can be left out, as the UK's county
 * usually is. With no country given, the US.
 */
export function hasPostalAddress(address: LooseAddress, country?: string | null): boolean {
  if (mailable(address) !== "no_address") return true;
  const named = text(address?.country);
  const abroad = named ? !US.has(named.toLowerCase()) : !regionNeeded(country);
  return abroad && Boolean(text(address?.line1) && text(address?.city) && (text(address?.postal_code) || text(address?.zip)));
}

/** Whether a business's postal address needs its region in this country: the state in the US (and where it isn't known), the province in Canada. */
export const regionNeeded = (country: string | null | undefined): boolean => ["US", "CA"].includes(countryCode(country) ?? "US");

/**
 * Lob mails these cards in the US only (apps/api/src/integrations/lob.ts sends every address as the
 * US's), to clients' US addresses with the business's own as the return address. Whether postcards
 * are for a business in this country, and what a business elsewhere is told where they're offered
 * (Apps → Lob, Marketing → Campaigns) and when Send is refused.
 */
export const postcardsMailHere = (country: string | null | undefined): boolean => (countryCode(country) ?? "US") === "US";
export const postcardsUsOnly = (country: string | null | undefined): string =>
  `Postcards are mailed in the US only: Lob sends each card to a US address, and prints your company's address from Settings → Company as the return address, which has to be in the US too. Your business is in ${countryInText(countryCode(country) ?? "US")}.`;

/** Why a marketing email can't go from a company with no complete postal address, and where to add it. */
export const SENDER_ADDRESS_NEEDED = "Add your company's full postal address in Settings → Company first: every marketing email has to show it. A PO box is fine.";

/** Which problem to show when none of a client's addresses can be mailed to: the one most worth fixing. */
const PROBLEM_RANK: Record<AddressProblem, number> = { bad_state: 3, too_long: 2, outside_us: 1, no_address: 0 };

/** Where a client's card goes: their billing address when it's complete, else their first property's that is. */
export function mailingAddress(billing: LooseAddress, properties: ReadonlyArray<LooseAddress>): MailingAddress | AddressProblem {
  let problem: AddressProblem = "no_address";
  for (const address of [billing, ...properties]) {
    const found = mailable(address);
    if (typeof found === "object") return found;
    if (PROBLEM_RANK[found] > PROBLEM_RANK[problem]) problem = found;
  }
  return problem;
}

/** Why a client in the segment doesn't get a card, in the order they're counted. */
export const LEFT_OUT = ["archived", "opted_out", "no_address", "outside_us", "bad_state", "too_long", "same_address"] as const;
export type LeftOut = (typeof LEFT_OUT)[number];
export const LEFT_OUT_WORDS: Record<LeftOut, string> = {
  archived: "archived",
  opted_out: "opted out of marketing",
  no_address: "no complete mailing address",
  outside_us: "an address outside the US",
  bad_state: "a state that isn't a US state",
  too_long: "an address line too long to mail",
  same_address: "at an address another client's card goes to",
};
/** Said after the count as they are ("3 archived"); the rest take "with" ("8 with no complete mailing address"). */
const LEFT_OUT_PLAIN: ReadonlySet<LeftOut> = new Set(["archived", "opted_out", "same_address"]);

/**
 * How one card per address is chosen, for the page to say: two clients at one address (the same
 * street line, unit and ZIP) get one card, addressed to the one who has been a client longest.
 * public.postcard_audience (20261113001560_postcard_households.sql) does the choosing.
 */
export const ONE_PER_ADDRESS = "One card goes to each address. When two clients share one, it's addressed to the one who has been your client longest.";

/** "12 left out: 8 with no complete mailing address, 3 opted out of marketing, 1 archived", or null with none. */
export function leftOutLine(counts: Partial<Record<LeftOut, number>>): string | null {
  const parts = LEFT_OUT.filter((k) => (counts[k] ?? 0) > 0).sort((a, b) => (counts[b] ?? 0) - (counts[a] ?? 0));
  if (!parts.length) return null;
  const total = parts.reduce((sum, k) => sum + (counts[k] ?? 0), 0);
  const words = parts.map((k) => `${(counts[k] ?? 0).toLocaleString("en-US")} ${LEFT_OUT_PLAIN.has(k) ? LEFT_OUT_WORDS[k] : `with ${LEFT_OUT_WORDS[k]}`}`);
  return `${total.toLocaleString("en-US")} left out: ${words.join(", ")}`;
}

/** An address on one line: "12 Oak St, Apt 2, Springfield, IL 62701". */
export const addressLine = (a: Pick<MailingAddress, "line1" | "line2" | "city" | "region" | "postal_code">) =>
  [a.line1, a.line2, a.city, `${a.region} ${a.postal_code}`.trim()].filter(Boolean).join(", ");

// ---------------------------------------------------------------------------------------------
// What Lob prints
// ---------------------------------------------------------------------------------------------

export const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);

const page = (size: PostcardSize, style: string, body: string) => {
  const { width, height } = artboard(size);
  return `<!doctype html><html><head><meta charset="utf-8"><style>*{margin:0;padding:0;box-sizing:border-box}html,body{width:${width}in;height:${height}in;overflow:hidden}${style}</style></head><body>${body}</body></html>`;
};

/** The front: the picture, filling the card to past its edges. */
export function frontHtml(size: PostcardSize, imageUrl: string): string {
  return page(size, `body{background:#fff url("${escapeHtml(imageUrl)}") center/cover no-repeat}`, "");
}

export interface BackInput {
  size: PostcardSize;
  message: string;
}

/**
 * The back: the message, a quarter inch inside the cut edge, with Lob's address block cut out of
 * its bottom right corner (backLayout), so the words run the full width above the block and down
 * its left side and can never be under it. Two floats on the right make the cut: one of no width
 * as high as the room above the block, and under it one the size of the block and its gap. Lob
 * prints the business's return address in that block itself (the card's `from`), so it isn't
 * printed here as well. What doesn't fit is cut off at the box's bottom, which is why a card is
 * only made once backFit says its words fit.
 */
export function backHtml({ size, message }: BackInput): string {
  const info = POSTCARD_SIZE_INFO[size];
  const box = backLayout(size);
  const paragraphs = message
    .trim()
    .split(/\n{2,}/)
    .map((p) => `<p>${escapeHtml(p.trim()).replace(/\n/g, "<br>")}</p>`)
    .join("");
  const style = [
    "body{background:#fff;color:#1d1d1b;font-family:Helvetica,Arial,sans-serif}",
    `.message{position:absolute;left:${box.left}in;top:${box.top}in;width:${box.width}in;height:${box.height}in;overflow:hidden;overflow-wrap:anywhere;font-size:${info.fontPt}pt;line-height:${LINE_HEIGHT}}`,
    `.above{float:right;width:0;height:${box.aboveBlock}in}`,
    `.block{float:right;clear:right;width:${box.cutWidth}in;height:${box.cutHeight}in}`,
    `.message p{margin:0 0 ${PARAGRAPH_GAP_EM}em}`,
  ].join("");
  return page(size, style, `<div class="message"><div class="above"></div><div class="block"></div>${paragraphs}</div>`);
}
