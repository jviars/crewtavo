import { describe, expect, it } from "vitest";
import {
  addressBlock,
  artboard,
  backFit,
  backHtml,
  backLayout,
  frontResolution,
  frontResolutionWarning,
  POSTCARD_SIZES,
  frontHtml,
  hasPostalAddress,
  leftOutLine,
  mailable,
  mailingAddress,
  messageProblem,
  POSTCARD_SIZE_INFO,
  postcardMessage,
  postcardsMailHere,
  postcardsUsOnly,
  regionNeeded,
  usStateCode,
} from "../src/postcards";

describe("where a postcard goes", () => {
  it("takes a complete US address: a street, a city, a state and a ZIP code", () => {
    expect(mailable({ line1: " 12  Oak St ", city: "Springfield", region: "IL", postal_code: "62701" })).toEqual({
      line1: "12 Oak St", line2: null, city: "Springfield", region: "IL", postal_code: "62701", country: "US",
    });
    expect(mailable({ line1: "12 Oak St", line2: "Apt 2", city: "Springfield", state: "IL", zip: "62701-1234", country: "United States" })).toMatchObject({ line2: "Apt 2", region: "IL", postal_code: "62701-1234" });
  });

  it("calls an address with a part missing no address, and one abroad (or with a postcode that isn't a ZIP) outside the US", () => {
    expect(mailable({ line1: "12 Oak St", city: "Springfield", postal_code: "62701" })).toBe("no_address");
    expect(mailable({ line1: "", city: "Springfield", region: "IL", postal_code: "62701" })).toBe("no_address");
    expect(mailable(null)).toBe("no_address");
    expect(mailable({ line1: "1 King St", city: "Toronto", region: "ON", postal_code: "M5H 1A1", country: "CA" })).toBe("outside_us");
    expect(mailable({ line1: "1 King St", city: "Toronto", region: "ON", postal_code: "M5H 1A1" })).toBe("outside_us");
  });

  it("gives Lob the state as two letters and the ZIP with its hyphen, however they were typed", () => {
    // Lob's own patterns for a card's address (docs.lob.com, Postcards → Create).
    const LOB_STATE = /^[a-zA-Z]{2}$/;
    const LOB_ZIP = /^\d{5}(-\d{4})?$/;
    const typed = [
      { region: "Illinois", postal_code: "627011234" },
      { region: " new  york ", postal_code: "10001 1234" },
      { region: "il", postal_code: "62701-1234" },
      { region: "D.C.", postal_code: "20001" },
      { state: "Puerto Rico", zip: "00901" },
    ];
    for (const part of typed) {
      const found = mailable({ line1: "12 Oak St", city: "Springfield", ...part });
      expect(typeof found).toBe("object");
      const address = found as Exclude<typeof found, string>;
      expect(address.region).toMatch(LOB_STATE);
      expect(address.postal_code).toMatch(LOB_ZIP);
    }
    expect(mailable({ line1: "12 Oak St", city: "Springfield", region: "Illinois", postal_code: "627011234" })).toMatchObject({ region: "IL", postal_code: "62701-1234" });
    expect(usStateCode("West Virginia")).toBe("WV");
    expect(usStateCode("Ontario")).toBeNull();
  });

  it("leaves out what Lob would refuse, saying why: a state that isn't one, a line too long", () => {
    expect(mailable({ line1: "12 Oak St", city: "Springfield", region: "Ill.", postal_code: "62701" })).toBe("bad_state");
    expect(mailable({ line1: "x".repeat(65), city: "Springfield", region: "IL", postal_code: "62701" })).toBe("too_long");
    expect(mailable({ line1: "12 Oak St", line2: "x".repeat(65), city: "Springfield", region: "IL", postal_code: "62701" })).toBe("too_long");
    expect(mailable({ line1: "x".repeat(64), city: "Springfield", region: "IL", postal_code: "62701" })).toMatchObject({ region: "IL" });
    // The address worth fixing is the one named when none can be mailed to.
    expect(mailingAddress({ line1: "12 Oak St", city: "Springfield", region: "Ill.", postal_code: "62701" }, [{ line1: "no city" }])).toBe("bad_state");
    expect(leftOutLine({ bad_state: 2, too_long: 1 })).toBe("3 left out: 2 with a state that isn't a US state, 1 with an address line too long to mail");
    expect(leftOutLine({ same_address: 2, no_address: 1 })).toBe("3 left out: 2 at an address another client's card goes to, 1 with no complete mailing address");
  });

  it("uses the billing address when it's complete, else the first property that is, and says why when none is", () => {
    const property = { line1: "9 Elm Rd", city: "Peoria", region: "IL", postal_code: "61602" };
    expect(mailingAddress({ line1: "12 Oak St", city: "Springfield", region: "IL", postal_code: "62701" }, [property])).toMatchObject({ line1: "12 Oak St" });
    expect(mailingAddress({ line1: "12 Oak St" }, [{ line1: "no city" }, property])).toMatchObject({ line1: "9 Elm Rd" });
    expect(mailingAddress({}, [])).toBe("no_address");
    expect(mailingAddress({}, [{ line1: "1 King St", city: "Toronto", region: "ON", postal_code: "M5H 1A1", country: "CA" }])).toBe("outside_us");
  });

  it("says who's left out and why, the biggest group first", () => {
    expect(leftOutLine({ archived: 1, opted_out: 3, no_address: 8, outside_us: 0 })).toBe("12 left out: 8 with no complete mailing address, 3 opted out of marketing, 1 archived");
    expect(leftOutLine({ outside_us: 2 })).toBe("2 left out: 2 with an address outside the US");
    expect(leftOutLine({ archived: 0 })).toBeNull();
  });
});

describe("a company's postal address under a marketing email", () => {
  it("needs its region in the US and Canada, and not where addresses leave it out", () => {
    expect([regionNeeded("US"), regionNeeded("CA"), regionNeeded(null), regionNeeded("GB"), regionNeeded("IE"), regionNeeded("AU")]).toEqual([true, true, true, false, false, false]);
    const leeds = { line1: "12 High Street", city: "Leeds", postal_code: "LS1 4AP" };
    expect(hasPostalAddress(leeds, "GB")).toBe(true);
    expect(hasPostalAddress(leeds, "CA")).toBe(false);
    expect(hasPostalAddress(leeds)).toBe(false);
    expect(hasPostalAddress({ ...leeds, city: "" }, "GB")).toBe(false);
  });
});

describe("where postcards are mailed", () => {
  it("in the US only, which a business elsewhere is told", () => {
    expect([postcardsMailHere("US"), postcardsMailHere(null), postcardsMailHere("CA"), postcardsMailHere("GB")]).toEqual([true, true, false, false]);
    expect(postcardsUsOnly("CA")).toMatch(/^Postcards are mailed in the US only: .*Your business is in Canada\.$/);
    expect(postcardsUsOnly("GB")).toMatch(/Your business is in the United Kingdom\.$/);
  });
});

describe("what's printed", () => {
  it("fills in the campaign merge fields on the back", () => {
    const vars = { client: { first_name: "Ann", name: "Ann Oak" }, company: { name: "Sketchy Gutters", phone: "(540) 555-0100" }, link: "https://crew.example.com/book/sketchy/spring" };
    expect(postcardMessage("Hi {{client.first_name}},\r\n\r\nBook at {{link}}\n{{company.name}} {{company.phone}}  ", vars)).toBe(
      "Hi Ann,\n\nBook at https://crew.example.com/book/sketchy/spring\nSketchy Gutters (540) 555-0100",
    );
  });

  it("refuses a message whose end would be cut off, by how it lays out rather than by its length", () => {
    expect(messageProblem("Hi", "4x6")).toMatch(/Write the message/);
    expect(messageProblem(prose(400), "4x6")).toBeNull();
    expect(messageProblem(prose(1400), "4x6")).toMatch(/lines too long for the back of a 4 × 6 in card/);
    expect(messageProblem(prose(1400), "6x9")).toBeNull();
    // The same number of characters as short lines takes far more room: 40 lines don't fit a 4x6.
    const list = Array.from({ length: 40 }, (_, i) => `Line ${i + 1}`).join("\n");
    expect(list.length).toBeLessThan(400);
    expect(backFit("4x6", list)).toMatchObject({ fits: false, lines: 40 });
    expect(backFit("4x6", "Hi Ann,\n\nSee you soon.")).toEqual({ fits: true, lines: 2, over: 0 });
  });

  it("measures each client's own card: a long name can push a full message over", () => {
    const template = `Hi {{client.name}},\n\n${prose(1450)}`;
    const vars = (name: string) => ({ client: { first_name: name.split(" ")[0]!, name }, company: { name: "Sketchy Gutters", phone: "" }, link: "" });
    expect(backFit("6x9", postcardMessage(template, vars("Ann Oak"))).fits).toBe(true);
    // A link or a name longer than a line breaks where the line ends, and takes the lines it takes.
    expect(backFit("6x9", postcardMessage(template, vars("Maximiliana-Alexandrina ".repeat(12).trim()))).fits).toBe(false);
    expect(backFit("4x6", "x".repeat(300)).lines).toBeGreaterThan(3);
  });

  it("says about how many characters fit each size, and ordinary sentences that long do fit", () => {
    for (const size of POSTCARD_SIZES) {
      const about = POSTCARD_SIZE_INFO[size].maxMessage;
      expect(backFit(size, prose(about)).fits).toBe(true);
      // In three paragraphs, as a card is usually written.
      const third = Math.floor(about / 3);
      expect(backFit(size, [prose(third), prose(third), prose(third)].join("\n\n")).fits).toBe(true);
    }
  });

  it("draws each side at the size with its bleed, and the front's picture to the edges", () => {
    expect(artboard("4x6")).toEqual({ width: 6.25, height: 4.25 });
    expect(artboard("6x11")).toEqual({ width: 11.25, height: 6.25 });
    const front = frontHtml("6x9", 'https://crew.example.com/api/public/postcards/abc.jpg?x="1"');
    expect(front).toContain("width:9.25in;height:6.25in");
    expect(front).toContain("center/cover");
    expect(front).toContain("&quot;1&quot;");
  });

  it("warns, with the numbers, when the front's picture is below Lob's 300 dots per inch at the size", () => {
    // Lob's numbers: 300 dpi over the artwork with its bleed, 1275 × 1875 pixels for a 4.25 × 6.25 in card.
    expect(frontResolution("4x6", { width: 1875, height: 1275 })).toMatchObject({ ok: true, dpi: 300, need: { width: 1875, height: 1275 } });
    expect(frontResolution("6x9", { width: 2775, height: 1875 }).ok).toBe(true);
    expect(frontResolution("6x11", { width: 3375, height: 1875 }).ok).toBe(true);
    expect(frontResolution("6x11", { width: 3374, height: 1875 }).ok).toBe(false);
    // A job photo as the app keeps it, 2,000 pixels at most: fine on a 4x6, soft on the big cards.
    const jobPhoto = { width: 2000, height: 1500 };
    expect(frontResolutionWarning("4x6", jobPhoto)).toBeNull();
    expect(frontResolutionWarning("6x9", jobPhoto)).toBe(
      "This picture is 2,000 × 1,500 pixels, which prints at about 216 dots per inch on a 6 × 9 in card. Lob asks for at least 300, which at this size is 2,775 × 1,875 pixels, so it may print soft. It's sharp enough for a 4 × 6 in card.",
    );
    expect(frontResolutionWarning("6x11", jobPhoto)).toMatch(/about 177 dots per inch on a 6 × 11 in card.*3,375 × 1,875 pixels/);
    // Held upright, the same photo is cropped across the card: fewer dots still, and no size is sharp.
    expect(frontResolutionWarning("4x6", { width: 1000, height: 1500 })).toMatch(/about 160 dots per inch.*may print soft\.$/);
    // An upload at 3,400 pixels across is enough everywhere.
    expect(frontResolutionWarning("6x11", { width: 3400, height: 2267 })).toBeNull();
  });

  it("escapes what's written and keeps paragraphs", () => {
    const html = backHtml({ size: "4x6", message: "Hi <b>Ann</b> & co,\n\nLine one\nline two" });
    expect(html).toContain("<p>Hi &lt;b&gt;Ann&lt;/b&gt; &amp; co,</p><p>Line one<br>line two</p>");
    expect(html).not.toContain("<script");
  });
});

/**
 * Lob's own numbers for the back of each size, from its design-spec page and the template for each
 * size (help.lob.com/print-and-mail/designing-mail-creatives/mail-piece-design-specs/postcards,
 * templates dated 4.3.26): the artwork with its bleed, the ink-free area where Lob prints the
 * addresses and postage, 0.275 in from the artwork's right edge and 0.25 in from its bottom, and
 * the safe zone text should stay inside (an eighth of an inch inside the cut, so a quarter inside
 * the artwork). Written out here, not read from the code, so the layout is held to Lob's sheet.
 */
const LOB_BACK = {
  "4x6": { art: { width: 6.25, height: 4.25 }, block: { width: 3.2835, height: 2.375 } },
  "6x9": { art: { width: 9.25, height: 6.25 }, block: { width: 4, height: 2.375 } },
  "6x11": { art: { width: 11.25, height: 6.25 }, block: { width: 4, height: 2.375 } },
} as const;
const LOB_BLOCK_RIGHT = 0.275;
const LOB_BLOCK_BOTTOM = 0.25;
const LOB_SAFE = 0.25;

/** A CSS rule's lengths in inches, from the page backHtml makes. */
function rule(html: string, selector: string): Record<string, number> {
  const body = new RegExp(`${selector.replace(".", "\\.")}\\{([^}]*)\\}`).exec(html)?.[1] ?? "";
  return Object.fromEntries([...body.matchAll(/([a-z-]+):(-?[\d.]+)in/g)].map((m) => [m[1]!, Number(m[2])]));
}

describe("the back, against Lob's address block", () => {
  for (const size of POSTCARD_SIZES) {
    it(`keeps every line of the message out of Lob's block on a ${size}`, () => {
      const lob = LOB_BACK[size];
      const blockLeft = lob.art.width - LOB_BLOCK_RIGHT - lob.block.width;
      const blockTop = lob.art.height - LOB_BLOCK_BOTTOM - lob.block.height;
      const html = backHtml({ size, message: prose(900) });
      expect(html).toContain(`width:${lob.art.width}in;height:${lob.art.height}in`);
      const box = rule(html, ".message");
      const above = rule(html, ".above");
      const cut = rule(html, ".block");
      // Inside Lob's safe zone on every side.
      expect(box.left).toBeGreaterThanOrEqual(LOB_SAFE);
      expect(box.top).toBeGreaterThanOrEqual(LOB_SAFE);
      expect(box.left! + box.width!).toBeLessThanOrEqual(lob.art.width - LOB_SAFE + 1e-9);
      expect(box.top! + box.height!).toBeLessThanOrEqual(lob.art.height - LOB_SAFE + 1e-9);
      // Lines beside the block end to its left, with a gap; lines the full width end above it, with a gap.
      expect(box.left! + box.width! - cut.width!).toBeLessThanOrEqual(blockLeft - 0.1);
      expect(box.top! + above.height!).toBeLessThanOrEqual(blockTop - 0.1);
      // The cut-out starts where the full-width lines stop and runs to the bottom of the box.
      expect(above.height! + cut.height!).toBeGreaterThanOrEqual(box.height! - 1e-9);
      expect(html).toContain(".above{float:right;width:0;");
      // And the layout the fit is measured with is the one that's printed.
      const layout = backLayout(size);
      expect(layout).toMatchObject({ left: box.left, top: box.top, width: box.width, height: box.height, cutWidth: cut.width, aboveBlock: above.height });
      const block = addressBlock(size);
      expect([block.width, block.height]).toEqual([lob.block.width, lob.block.height]);
      expect(block.left).toBeCloseTo(blockLeft, 6);
      expect(block.top).toBeCloseTo(blockTop, 6);
    });

    it(`fits no more lines on a ${size} than Lob's sheet has room for`, () => {
      const lob = LOB_BACK[size];
      const fontIn = POSTCARD_SIZE_INFO[size].fontPt / 72;
      const lineIn = fontIn * 1.35;
      // The most lines that could stand inside the safe zone at this type size, whatever their width.
      const most = Math.floor((lob.art.height - 2 * LOB_SAFE) / lineIn);
      const full = backFit(size, Array.from({ length: most + 1 }, () => "x").join("\n"));
      expect(full.fits).toBe(false);
      // Beside the block a line holds only what its narrow width does: a line of W's as wide as the
      // room left of Lob's block can't fit there, so it wraps.
      const besideIn = lob.art.width - LOB_BLOCK_RIGHT - lob.block.width - LOB_SAFE;
      const wide = "W".repeat(Math.ceil(besideIn / (0.944 * fontIn)) + 1);
      const linesAbove = Math.floor((lob.art.height - LOB_BLOCK_BOTTOM - lob.block.height - LOB_SAFE) / lineIn);
      const message = [...Array.from({ length: linesAbove }, () => "x"), wide].join("\n");
      expect(backFit(size, message).lines).toBeGreaterThan(linesAbove + 1);
    });
  }

  it("leaves the return address to Lob, which prints it in its block", () => {
    const html = backHtml({ size: "6x9", message: "Hi Ann, see you in the spring." });
    expect(html).not.toContain("class=\"from\"");
  });
});

/** Ordinary sentences, `length` characters of them. */
function prose(length: number): string {
  const sentences = "Spring is nearly here and the crew is booking up fast. We would love to get your lawn, beds and gutters ready before the first warm weekend. Book this month and we will take ten percent off your first visit. Call us or book online any time, and thank you for being a client. ";
  return sentences.repeat(Math.ceil(length / sentences.length)).slice(0, length).trim();
}
