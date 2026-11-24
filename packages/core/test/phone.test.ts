import { describe, expect, it } from "vitest";
import { COUNTRY_CODES } from "../src/countries";
import { internationalPhone, phoneDisplay, phoneE164, phoneExample, signInPhone, textedNumber, textsCodesTo } from "../src/phone";
import { emailKey } from "../src/email";
import { signInCodeEmail, signInCodeText, subSettings } from "../src/subs";

/**
 * Numbers as people type them, and what each is in E.164. supabase/tests/sign_in_codes_test.sql
 * checks private.phone_e164() against the same list, so the server and the database agree.
 */
const SPELLINGS: Array<[string | null, string | null]> = [
  ["540-555-0101", "+15405550101"],
  ["(540) 555-0101", "+15405550101"],
  ["540.555.0101", "+15405550101"],
  [" 540 555 0101 ", "+15405550101"],
  ["1 540 555 0101", "+15405550101"],
  ["1-540-555-0101", "+15405550101"],
  ["+1 (540) 555-0101", "+15405550101"],
  ["15405550101", "+15405550101"],
  ["Cell: 540-555-0101", "+15405550101"],
  ["011 1 540 555 0101", "+15405550101"],
  ["+44 20 7946 0958", "+442079460958"],
  ["0044 20 7946 0958", "+442079460958"],
  ["011 44 20 7946 0958", "+442079460958"],
  ["+52 55 1234 5678", "+525512345678"],
  ["+223456789012345", "+223456789012345"],
  // Not a whole number: too short or long, an area code starting with 0 or 1, an extension, a + in the middle.
  ["555-0101", null],
  ["054-555-0101", null],
  ["154-555-0101", null],
  ["25405550101", null],
  ["540-555-0101 ext 12", null],
  ["540+5550101", null],
  ["+1 540 555 010", null],
  ["+0 123 456 789", null],
  ["+44 1", null],
  ["+2234567890123456", null],
  ["+", null],
  ["", null],
  [null, null],
];

describe("phone numbers", () => {
  it("come out in one spelling however they're typed", () => {
    for (const [typed, e164] of SPELLINGS) expect(phoneE164(typed), String(typed)).toBe(e164);
  });

  it("get codes in the US and Canada, and elsewhere only where the company adds the country", () => {
    expect(textsCodesTo("+15405550101", [])).toBe(true);
    expect(textsCodesTo("+442079460958", [])).toBe(false);
    expect(textsCodesTo("+442079460958", ["44"])).toBe(true);
    expect(textsCodesTo("+442079460958", ["52", "61"])).toBe(false);
    expect(textsCodesTo("+442079460958", ["UK", ""])).toBe(false);
    expect(signInPhone("(540) 555-0101")).toBe("+15405550101");
    expect(signInPhone("+44 20 7946 0958")).toBeNull();
    expect(signInPhone("+44 20 7946 0958", ["44"])).toBe("+442079460958");
    expect(signInPhone("555-0101", ["44"])).toBeNull();
  });

  it("read back the way people write them", () => {
    expect(phoneDisplay("+15405550101")).toBe("(540) 555-0101");
    expect(phoneDisplay("+442079460958")).toBe("+442079460958");
  });

  it("keep the company's countries as calling codes, each once", () => {
    expect(subSettings({})).toEqual({ remind_subs: true, sign_in_countries: [] });
    expect(subSettings({ subs: { sign_in_countries: ["44", 52, "1", "UK", "44", "0044"] } }).sign_in_countries).toEqual(["44", "52"]);
    expect(subSettings({ subs: { sign_in_countries: "44" } }).sign_in_countries).toEqual([]);
  });

  it("text the code first, with the company's name", () => {
    expect(signInCodeText("042517", "Oscar Roofing")).toBe(
      "042517 is your sign-in code for Oscar Roofing on Crewtavo. It runs out in 10 minutes. If you didn't ask for it, ignore this text.",
    );
  });
});

/** Numbers as an office outside North America types them, and the number each is texted at. */
const TEXTED: Array<[string, string, string]> = [
  // The UK: the 0 gives way to +44, however the number is laid out.
  ["GB", "07700 900123", "+447700900123"],
  ["GB", "07700 900 123", "+447700900123"],
  ["GB", "020 7946 0018", "+442079460018"],
  ["GB", "(020) 7946-0018", "+442079460018"],
  ["GB", "7700 900123", "7700 900123"],
  ["GB", "(540) 555-0101", "(540) 555-0101"],
  ["GB", "44 7700 900123", "+447700900123"],
  ["GB", "+44 7700 900123", "+447700900123"],
  ["GB", "+44 (0)20 7946 0018", "+442079460018"],
  ["GB", "0044 20 7946 0018", "+442079460018"],
  ["GB", "+1 540 555 0101", "+15405550101"],
  ["GB", "0113 496 0000", "+441134960000"],
  // Ireland, Australia (0011 to dial out), New Zealand, South Africa.
  ["IE", "087 123 4567", "+353871234567"],
  ["IE", "(01) 234 5678", "+35312345678"],
  ["AU", "0412 345 678", "+61412345678"],
  ["AU", "(02) 9876 5432", "+61298765432"],
  ["AU", "0011 44 20 7946 0018", "+442079460018"],
  ["AU", "61 412 345 678", "+61412345678"],
  ["NZ", "021 123 4567", "+64211234567"],
  ["NZ", "6421 123 456", "+6421123456"],
  ["ZA", "082 123 4567", "+27821234567"],
  ["ZA", "27 123 4567", "27 123 4567"],
  ["ZA", "27 82 123 4567", "+27821234567"],
  // The euro: France and Germany drop the 0, Spain has none, Italy keeps it.
  ["FR", "06 12 34 56 78", "+33612345678"],
  ["DE", "0151 23456789", "+4915123456789"],
  ["ES", "612 34 56 78", "+34612345678"],
  ["ES", "34 612 345 678", "+34612345678"],
  ["IT", "06 1234 5678", "+390612345678"],
  ["IT", "347 123 4567", "+393471234567"],
  ["IT", "393 123 4567", "+393931234567"],
  ["IT", "39 347 123 4567", "+393471234567"],
  ["gb", "07700 900123", "+447700900123"],
  // Left as typed: too short or long for the country, or not a number at all.
  ["GB", "07700 9001234", "07700 9001234"],
  ["GB", "900123", "900123"],
  ["GB", "07700 900123 ext 4", "07700 900123 ext 4"],
  ["GB", "0044", "0044"],
  ["GB", "07700+900123", "07700+900123"],
  ["GB", "call the office", "call the office"],
  ["GB", "", ""],
];

describe("numbers texted for a business", () => {
  it("get the country's calling code when they were typed without it", () => {
    for (const [country, typed, texted] of TEXTED) expect(internationalPhone(typed, country), `${country} ${typed}`).toBe(texted);
  });

  it("go as typed in the US and Canada, and in a country whose numbers aren't known", () => {
    for (const typed of ["(540) 555-0101", "540-555-0101", "1 540 555 0101", "+1 540 555 0101", "011 44 20 7946 0958", "07700 900123", "555-0101", ""]) {
      for (const country of ["US", "CA", "MX", "JP", "", null, undefined]) expect(internationalPhone(typed, country), `${country} ${typed}`).toBe(typed);
    }
  });

  it("are completed only where replies and STOPs from them still find the client by their last 10 digits", () => {
    expect(textedNumber("07700 900123", "GB")).toBe("+447700900123");
    expect(textedNumber("020 7946 0018", "GB")).toBe("+442079460018");
    expect(textedNumber("0151 23456789", "DE")).toBe("+4915123456789");
    expect(textedNumber("0044 20 7946 0018", "GB")).toBe("+442079460018");
    // The country code changes the last 10 digits of these: they go as typed, as before.
    expect(textedNumber("087 123 4567", "IE")).toBe("087 123 4567");
    expect(textedNumber("0412 345 678", "AU")).toBe("0412 345 678");
    expect(textedNumber("612 34 56 78", "ES")).toBe("612 34 56 78");
    // A US or Canadian business's, and a number already international, as before.
    expect(textedNumber("(540) 555-0101", "US")).toBe("(540) 555-0101");
    expect(textedNumber("(540) 555-0101", "GB")).toBe("(540) 555-0101");
    expect(textedNumber("+61 412 345 678", "GB")).toBe("+61412345678");
  });

  it("are whole E.164 numbers, which phoneE164 alone doesn't make of a UK one", () => {
    expect(phoneE164(internationalPhone("07700 900123", "GB"))).toBe("+447700900123");
    expect(phoneE164("07700 900123")).toBeNull();
  });

  it("have an example as the country writes them, which is completed like any number typed there", () => {
    expect(phoneExample("GB")).toBe("07700 900123");
    expect(phoneExample("gb")).toBe("07700 900123");
    for (const country of ["US", "CA", "MX", "", null, undefined]) expect(phoneExample(country), String(country)).toBeNull();
    const known = COUNTRY_CODES.filter((country) => phoneExample(country));
    expect(known).toEqual(expect.arrayContaining(["GB", "IE", "AU", "NZ", "ZA", "DE", "FR", "ES", "IT"]));
    for (const country of known) {
      const texted = internationalPhone(phoneExample(country)!, country);
      expect(texted, country).toMatch(/^\+[2-9][0-9]{6,14}$/);
      expect(phoneE164(texted), country).toBe(texted);
    }
  });
});

/**
 * Email addresses as people type them, for a sign-in code by email. supabase/tests/email_sign_in_codes_test.sql
 * checks that private.email_key() spells the office's addresses the same way.
 */
describe("email addresses for sign-in codes", () => {
  it("come out in one spelling, trimmed and lower-cased", () => {
    expect(emailKey("al@apex.test")).toBe("al@apex.test");
    expect(emailKey("  Al@Apex.TEST ")).toBe("al@apex.test");
    expect(emailKey("\tAL@apex.test\n")).toBe("al@apex.test");
  });

  it("are whole addresses, or nothing", () => {
    for (const typed of ["", "   ", null, undefined, "al@apex", "@apex.test", "al apex@apex.test", "Al at Apex", "al@apex.test, bo@birch.test", `${"a".repeat(250)}@apex.test`]) {
      expect(emailKey(typed), String(typed)).toBeNull();
    }
  });

  it("get an email with the code on its own line, from the company", () => {
    expect(signInCodeEmail({ code: "042517", companyName: "Oscar Roofing", name: "Al Apex" })).toEqual({
      subject: "Your sign-in code for Oscar Roofing",
      text: "Hi Al,\n\nHere's your code to sign in to Oscar Roofing on Crewtavo:\n\n042517\n\nIt runs out in 10 minutes. If you didn't ask for it, ignore this email.\n\nThanks,\nOscar Roofing",
    });
    expect(signInCodeEmail({ code: "042517", companyName: "Oscar Roofing" }).text).toMatch(/^Hi there,/);
  });
});
