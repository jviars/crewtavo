import { describe, expect, it } from "vitest";
import { formatPhoneTyping, isCompleteEmail } from "../src/lib/validate";

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

describe("emails", () => {
  it("needs a dot after the @", () => {
    expect(isCompleteEmail("jordan@gmail")).toBe(false);
    expect(isCompleteEmail("jordan@gmail.com")).toBe(true);
  });
});
