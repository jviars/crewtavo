import { afterEach, describe, expect, it } from "vitest";
import { setCountry } from "../src/lib/format";
import { formatPhoneTyping, isCompleteEmail, northAmericanPhones } from "../src/lib/validate";

/** Types each character at the end, the way a tel input's onChange sees it. */
const type = (text: string, start = "") => [...text].reduce((value, char) => formatPhoneTyping(value + char), start);

describe("phone numbers as they're typed", () => {
  it("lays out a US number digit by digit without losing any", () => {
    expect(type("5")).toBe("5");
    expect(type("5405")).toBe("(540) 5");
    expect(type("5405550")).toBe("(540) 555-0");
    expect(type("5405550142")).toBe("(540) 555-0142");
  });

  it("lays out a pasted number", () => {
    expect(formatPhoneTyping("5405550142")).toBe("(540) 555-0142");
  });

  it("backspaces from the end without fighting back", () => {
    let value = "(540) 555-0142";
    const seen: string[] = [];
    for (let i = 0; i < 6; i++) seen.push((value = formatPhoneTyping(value.slice(0, -1))));
    expect(seen).toEqual(["(540) 555-014", "(540) 555-01", "(540) 555-0", "(540) 555", "(540) 55", "(540) 5"]);
  });

  it("takes the digit before a separator backspaced from the middle", () => {
    expect(formatPhoneTyping("(540) 5550142")).toBe("(540) 550-142");
  });

  it("leaves international numbers, extensions and words as typed", () => {
    expect(type("+44 20 7946 0958")).toBe("+44 20 7946 0958");
    expect(formatPhoneTyping("540-555-0142 ext. 12")).toBe("540-555-0142 ext. 12");
    expect(formatPhoneTyping("15405550142")).toBe("15405550142");
  });
});

describe("phone numbers outside the US and Canada", () => {
  afterEach(() => setCountry(null));

  it("are laid out the US way for a Canadian business too", () => {
    setCountry({ country: "CA" });
    expect(northAmericanPhones()).toBe(true);
    expect(type("4165550199")).toBe("(416) 555-0199");
  });

  it("are left as typed for a business elsewhere, though they have 10 digits", () => {
    setCountry({ country: "AU" });
    expect(northAmericanPhones()).toBe(false);
    expect(type("02 9876 5432")).toBe("02 9876 5432");
    expect(formatPhoneTyping("0412345678")).toBe("0412345678");
    setCountry({ country: "GB" });
    expect(type("07700 900123")).toBe("07700 900123");
    expect(formatPhoneTyping("0201234567")).toBe("0201234567");
  });

  it("go by the time zone for a sub, whose company basics don't say the country", () => {
    setCountry({ timezone: "Europe/London" });
    expect(northAmericanPhones()).toBe(false);
    setCountry({ timezone: "America/Toronto" });
    expect(northAmericanPhones()).toBe(true);
  });
});

describe("emails", () => {
  it("needs a dot after the @", () => {
    expect(isCompleteEmail("jordan@gmail")).toBe(false);
    expect(isCompleteEmail("jordan@gmail.com")).toBe(true);
  });
});
