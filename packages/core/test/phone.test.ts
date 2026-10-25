import { describe, expect, it } from "vitest";
import { phoneDisplay, phoneE164, signInPhone, textsCodesTo } from "../src/phone";
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
