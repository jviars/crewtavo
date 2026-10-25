/**
 * Signing in with a code by text or email, for a sub on a new phone (docs/subcontractors-plan.md §7,
 * phases E and E2): the number, address and code as typed or pasted, the countdown to sending a new
 * code, which way and step shows with texting on and off, what someone sees when this Crewtavo can't
 * text, the sign-in itself (redeemed like an emailed link), the sub's own notes on getting back in,
 * the office's line on the sub's Sign-in card, and the office's setting for which countries' numbers
 * get codes.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { subCanOpen } from "../src/components/shell/nav";
import {
  afterAsking,
  ASK_THE_OFFICE,
  askFor,
  askForCode,
  askForEmailCode,
  codeDigits,
  codeProblem,
  emailInstead,
  emailProblem,
  filledAtOnce,
  newPhoneOffer,
  newPhoneOffers,
  NOTHING_CAME,
  phoneProblem,
  readAddress,
  RESEND_SECONDS,
  resendIn,
  resendLabel,
  sentTo,
  signingInNote,
  signInWith,
  signInWithCode,
  signInWithEmailCode,
  signOutNote,
  subCodeWays,
  subSignsInOnHomeScreen,
  homeScreenSignInNote,
  TEXTING_OFF,
  wholeCode,
} from "../src/features/auth/textCode";
import { newPhoneWay } from "../src/features/subs/newPhone";
import { CALLING_CODES, countryLabel, MAX_SIGN_IN_COUNTRIES, readCallingCode, signInPhoneNote, SUB_PHONE_HINT, withCountry } from "../src/features/subs/signInCountries";
import { signInCodeEmail } from "@crewtavo/core/subs";
import { ApiError, loadConfig, supabase } from "../src/lib/api";

const store = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => void store.set(key, value),
  removeItem: (key: string) => void store.delete(key),
});
let answer: (url: string, init: RequestInit) => Response = () => new Response("{}");
const sent: Array<{ url: string; body: unknown }> = [];
vi.stubGlobal(
  "fetch",
  vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    sent.push({ url, body: typeof init.body === "string" ? JSON.parse(init.body) : undefined });
    return answer(url, init);
  }),
);

beforeAll(async () => {
  answer = () => new Response(JSON.stringify({ supabaseUrl: "https://crewtavo.test", supabaseKey: "public-key", sentry: null, features: { sms: true } }));
  await loadConfig();
  sent.length = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
  sent.length = 0;
});

describe("the phone number", () => {
  it("takes it however it's written, with the area code", () => {
    for (const typed of ["(540) 555-0101", "540.555.0101", "540 555 0101", "1-540-555-0101", "+1 540 555 0101", "+44 20 7946 0958"]) expect(phoneProblem(typed), typed).toBeNull();
  });

  it("asks for the area code when the number isn't whole, and for a number when there's none", () => {
    for (const typed of ["555-0101", "5405550", "(140) 555-0101", "call me", "+1 540"]) expect(phoneProblem(typed), typed).toBe("Enter your phone number with the area code.");
    expect(phoneProblem("   ")).toBe("Enter your phone number.");
  });

  it("says where the code went without saying whether the number has a sign-in", () => {
    expect(sentTo("text", "+15551234567")).toBe("We texted a code to (555) 123-4567 if it belongs to a subcontractor's sign-in.");
    expect(sentTo("text", "+442079460958")).toBe("We texted a code to +442079460958 if it belongs to a subcontractor's sign-in.");
  });
});

describe("the code", () => {
  it("keeps only its 6 digits, however it's pasted", () => {
    expect(codeDigits("123456")).toBe("123456");
    expect(codeDigits("123 456")).toBe("123456");
    expect(codeDigits("123-456")).toBe("123456");
    expect(codeDigits("123456 is your sign-in code for Uniform Roofing on Crewtavo. It runs out in 10 minutes.")).toBe("123456");
    expect(codeDigits("12a")).toBe("12");
  });

  it("takes the code, not a company name's digits, from the whole email pasted in", () => {
    const { text } = signInCodeEmail({ code: "042517", companyName: "A1 Roofing", name: "Al" });
    expect(codeDigits(text)).toBe("042517");
    expect(codeDigits("042517 is your sign-in code for 4 Seasons Lawn on Crewtavo.")).toBe("042517");
    // A longer run of digits isn't a code on its own; the digits typed are still taken.
    expect(codeDigits("1234567")).toBe("123456");
  });

  it("is ready once all 6 digits are in", () => {
    expect(wholeCode("12345")).toBe(false);
    expect(wholeCode("123456")).toBe(true);
  });

  it("signs in straight away when the phone fills it in or it's pasted, not while it's typed", () => {
    expect(filledAtOnce("", "123456")).toBe(true);
    expect(filledAtOnce("1", "123456")).toBe(true);
    expect(filledAtOnce("12345", "123456")).toBe(false);
    expect(filledAtOnce("", "1234")).toBe(false);
  });
});

describe("sending a new code", () => {
  const sentAt = Date.parse("2026-10-25T14:00:00Z");

  it("waits 60 seconds after the last one, counting down", () => {
    expect(RESEND_SECONDS).toBe(60);
    expect(resendIn(sentAt, sentAt)).toBe(60);
    expect(resendIn(sentAt, sentAt + 400)).toBe(60);
    expect(resendIn(sentAt, sentAt + 1_000)).toBe(59);
    expect(resendIn(sentAt, sentAt + 59_001)).toBe(1);
    expect(resendIn(sentAt, sentAt + 60_000)).toBe(0);
    // A tab left in the background catches up rather than counting from where it stopped.
    expect(resendIn(sentAt, sentAt + 10 * 60_000)).toBe(0);
  });

  it("says how long is left, then offers it", () => {
    expect(resendLabel(42)).toBe("Send a new code in 42s");
    expect(resendLabel(0)).toBe("Send a new code");
  });
});

describe("which step shows", () => {
  it("offers a code by text on the sign-in page when this Crewtavo can text, by email when it can only email, or else the office", () => {
    expect(newPhoneOffer({ sms: true })).toBe("text");
    expect(newPhoneOffer({ sms: true, emailCodes: true })).toBe("text");
    expect(newPhoneOffer({ sms: false, emailCodes: true })).toBe("email");
    expect(newPhoneOffer({ sms: false, emailCodes: false })).toBe("ask_office");
    expect(newPhoneOffer({ sms: false })).toBe("ask_office");
    expect(newPhoneOffer(undefined)).toBe("ask_office");
  });

  it("puts the offers under the sign-in form, with email for a sub with no phone on file when both go out", () => {
    expect(newPhoneOffers({ sms: true, emailCodes: true })).toEqual([
      { way: "text", label: "Subcontractor? Get a sign-in code by text" },
      { way: "email", label: "No phone on file? Get a code by email instead" },
    ]);
    expect(newPhoneOffers({ sms: true, emailCodes: false })).toEqual([{ way: "text", label: "Subcontractor? Get a sign-in code by text" }]);
    expect(newPhoneOffers({ sms: false, emailCodes: true })).toEqual([{ way: "email", label: "Subcontractor? Get a sign-in code by email" }]);
    expect(newPhoneOffers({ sms: false, emailCodes: false })).toBe("ask_office");
    expect(newPhoneOffers(undefined)).toBe("ask_office");
  });

  it("offers email instead of text, for a sub with no phone on file, only when both go out", () => {
    expect(emailInstead({ sms: true, emailCodes: true })).toBe(true);
    expect(emailInstead({ sms: true, emailCodes: false })).toBe(false);
    expect(emailInstead({ sms: true })).toBe(false);
    // With texting off, email is the only way, not an alternative.
    expect(emailInstead({ sms: false, emailCodes: true })).toBe(false);
    expect(emailInstead(undefined)).toBe(false);
  });

  it("goes on to the code after asking by email, every time", () => {
    expect(afterAsking({ sent: true }, "jo@apexroofing.com", 1000)).toEqual({ step: "code", address: "jo@apexroofing.com", sentAt: 1000 });
  });

  it("says to ask the office for a new link when nothing comes, and to check spam for an email", () => {
    expect(NOTHING_CAME.text).toBe("Nothing after a few minutes? Ask the office for a new sign-in link.");
    expect(NOTHING_CAME.email).toBe("Nothing after a few minutes? Check your spam folder. Still nothing? Ask the office for a new sign-in link.");
  });

  it("goes on to the code once it's sent, and says to ask the office when texting is off", () => {
    expect(afterAsking({ sent: true }, "+15405550101", 1000)).toEqual({ step: "code", address: "+15405550101", sentAt: 1000 });
    expect(afterAsking({ sent: false }, "+15405550101", 1000)).toEqual({ step: "off" });
  });

  it("tells someone without texting how to get back in", () => {
    // On the sign-in page in place of the link, and after asking on a Crewtavo that turns out not to text.
    expect(ASK_THE_OFFICE).toBe("On a new phone? Ask the office to text you a new sign-in link.");
    expect(TEXTING_OFF).toBe("This Crewtavo isn't set up to send texts yet. On a new phone? Ask the office to text you a new sign-in link.");
  });
});

describe("asking for a code", () => {
  it("sends the number to the API", async () => {
    answer = () => new Response(JSON.stringify({ sent: true }));
    expect(await askForCode("+15405550101")).toEqual({ sent: true });
    expect(sent).toEqual([{ url: "/api/auth/text-code", body: { phone: "+15405550101" } }]);
  });

  it("goes to the texting-off step when this Crewtavo can't text", async () => {
    answer = () => new Response(JSON.stringify({ sent: false, reason: "sms_off" }));
    expect(afterAsking(await askForCode("+15405550101"), "+15405550101", 1000)).toEqual({ step: "off" });
  });

  it("shows the API's words when too many codes were asked for", async () => {
    answer = () => new Response(JSON.stringify({ error: "Too many codes asked for. Wait a while and try again, or ask the office for a sign-in link." }), { status: 429 });
    const error = await askForCode("+15405550101").catch((e: unknown) => e);
    expect(codeProblem(error)).toBe("Too many codes asked for. Wait a while and try again, or ask the office for a sign-in link.");
  });
});

describe("once signed in with a code", () => {
  it("opens the offer or visit link the sub came from, and sends them to My day from anywhere else", () => {
    // Nothing moves them after signing in; the app's own rule for subs (AppShell) decides.
    for (const path of ["/field", "/field/jobs/0b7c9d1e", "/field/visits/2f1a", "/field/paperwork", "/settings"]) expect(subCanOpen(path), path).toBe(true);
    for (const path of ["/", "/jobs", "/schedule"]) expect(subCanOpen(path), path).toBe(false);
  });
});

describe("the sub's Signing in note on their profile", () => {
  const both = { text: true, email: true };
  const textOnly = { text: true, email: false };
  const emailOnly = { text: false, email: true };
  const neither = { text: false, email: false };

  it("points to the code by text when this Crewtavo can text", () => {
    const note = signingInNote("Uniform Roofing", textOnly);
    expect(note).toContain("On a new phone, open Crewtavo and tap Get a sign-in code by text.");
    expect(note).toContain("the number Uniform Roofing has for you");
    expect(note).toContain("If no code comes, ask Uniform Roofing for a new sign-in link.");
    expect(note).not.toContain("email");
  });

  it("adds email for a sub with no number on file when both go out", () => {
    const note = signingInNote("Uniform Roofing", both);
    expect(note).toContain("Get a sign-in code by text.");
    expect(note).toContain("No number on file? Tap Get a code by email instead, and we'll email one to the address they have.");
  });

  it("points to the code by email when this Crewtavo can't text but the company's email goes out", () => {
    const note = signingInNote("Uniform Roofing", emailOnly);
    expect(note).toBe(
      "There's no password. You stay signed in on this phone until you sign out. On a new phone, open Crewtavo and tap Get a sign-in code by email. We'll email a code to the address Uniform Roofing has for you. If no code comes, ask Uniform Roofing for a new sign-in link.",
    );
    expect(note).not.toContain("text a code");
  });

  it("says to ask the office for a new link when no code can go", () => {
    const note = signingInNote("Uniform Roofing", neither);
    expect(note).toContain("On a new phone, ask Uniform Roofing to text you a new sign-in link.");
    expect(note).not.toContain("code");
  });
});

describe("the sub's Sign out? question", () => {
  it("points to the code by text when this Crewtavo can text", () => {
    expect(signOutNote("Uniform Roofing", { text: true, email: false })).toBe("There's no password. To get back in, open Crewtavo and tap Get a sign-in code by text.");
  });

  it("names both ways when both go out", () => {
    expect(signOutNote("Uniform Roofing", { text: true, email: true })).toBe("There's no password. To get back in, open Crewtavo and get a sign-in code by text or by email.");
  });

  it("points to the code by email when only email goes out", () => {
    expect(signOutNote("Uniform Roofing", { text: false, email: true })).toBe("There's no password. To get back in, open Crewtavo and tap Get a sign-in code by email.");
  });

  it("says to ask the office for a new link when no code can go", () => {
    expect(signOutNote("Uniform Roofing", { text: false, email: false })).toBe("There's no password. To get back in, ask Uniform Roofing to text you a new sign-in link.");
  });
});

describe("the Home Screen app on an iPhone, for a sub", () => {
  const all = { sms: true, emailCodes: true, email: true };
  it("is offered once they can sign in there: a code by text or email, or their own password", () => {
    expect(subSignsInOnHomeScreen(all, { own_sign_in: true, has_phone: true, has_email: false })).toBe(true);
    expect(subSignsInOnHomeScreen({ sms: false, emailCodes: true, email: true }, { own_sign_in: true, has_phone: true, has_email: true })).toBe(true);
    expect(subSignsInOnHomeScreen(all, { own_sign_in: false })).toBe(true);
    // Only links, which open in Safari: not offered.
    expect(subSignsInOnHomeScreen(all, { own_sign_in: true, has_phone: false, has_email: false })).toBe(false);
    expect(subSignsInOnHomeScreen({ sms: false, emailCodes: false, email: false }, { own_sign_in: true, has_phone: true, has_email: true })).toBe(false);
  });
  it("says how to sign in once it's there", () => {
    expect(homeScreenSignInNote(all, { own_sign_in: true, has_phone: true, has_email: true })).toBe("In the Home Screen app, tap Get a sign-in code by text to sign in.");
    expect(homeScreenSignInNote({ sms: false, emailCodes: true, email: true }, { own_sign_in: true, has_email: true })).toBe("In the Home Screen app, tap Get a sign-in code by email to sign in.");
    expect(homeScreenSignInNote(all, { own_sign_in: false })).toBeNull();
  });
});

describe("which ways a signed-in sub has", () => {
  const both = { has_phone: true, has_email: true };

  it("texts when this Crewtavo texts, and emails only when their company's email goes out", () => {
    expect(subCodeWays({ sms: true, emailCodes: true, email: true }, both)).toEqual({ text: true, email: true });
    // Some other company here has a mailbox, but theirs doesn't and there's no sender for all.
    expect(subCodeWays({ sms: true, emailCodes: true, email: false }, both)).toEqual({ text: true, email: false });
    expect(subCodeWays({ sms: false, emailCodes: true, email: true }, both)).toEqual({ text: false, email: true });
    // A config from before email codes: no email way.
    expect(subCodeWays({ sms: false, email: true }, both)).toEqual({ text: false, email: false });
    expect(subCodeWays(undefined, both)).toEqual({ text: false, email: false });
  });

  it("counts only what their own record has for a code to go to", () => {
    const all = { sms: true, emailCodes: true, email: true };
    expect(subCodeWays(all, { has_phone: false, has_email: true })).toEqual({ text: false, email: true });
    expect(subCodeWays(all, { has_phone: true, has_email: false })).toEqual({ text: true, email: false });
    expect(subCodeWays(all, { has_phone: false, has_email: false })).toEqual({ text: false, email: false });
    // A session from before the record said: no way is promised.
    expect(subCodeWays(all, {})).toEqual({ text: false, email: false });
    expect(subCodeWays(all, null)).toEqual({ text: false, email: false });
  });

  it("tells a sub with nothing on file to ask for a new link, even where codes go out", () => {
    // Email codes only, and no email on their record.
    const emailOnly = subCodeWays({ sms: false, emailCodes: true, email: true }, { has_phone: true, has_email: false });
    expect(signingInNote("Uniform Roofing", emailOnly)).toContain("On a new phone, ask Uniform Roofing to text you a new sign-in link.");
    expect(signOutNote("Uniform Roofing", emailOnly)).toBe("There's no password. To get back in, ask Uniform Roofing to text you a new sign-in link.");
    // Texting on, but no number on their record: email it is.
    const noPhone = subCodeWays({ sms: true, emailCodes: true, email: true }, { has_phone: false, has_email: true });
    expect(signOutNote("Uniform Roofing", noPhone)).toBe("There's no password. To get back in, open Crewtavo and tap Get a sign-in code by email.");
    expect(signingInNote("Uniform Roofing", noPhone)).toContain("tap Get a sign-in code by email. We'll email a code to the address Uniform Roofing has for you.");
  });
});

describe("signing in with the code", () => {
  it("sends the number and code, then redeems the token the way an emailed link is", async () => {
    answer = () => new Response(JSON.stringify({ token_hash: "hash-1", type: "magiclink" }));
    const verifyOtp = vi.spyOn(supabase().auth, "verifyOtp").mockResolvedValue({ data: { session: {}, user: {} }, error: null } as never);
    await signInWithCode("+15405550101", "123456");
    expect(sent).toEqual([{ url: "/api/auth/text-code/verify", body: { phone: "+15405550101", code: "123456" } }]);
    expect(verifyOtp).toHaveBeenCalledWith({ token_hash: "hash-1", type: "magiclink" });
  });

  it("shows the API's own words when the code is wrong, and doesn't try to sign in", async () => {
    answer = () => new Response(JSON.stringify({ error: "That code isn't right. Check the text and try again." }), { status: 400 });
    const verifyOtp = vi.spyOn(supabase().auth, "verifyOtp");
    const error = await signInWithCode("+15405550101", "000000").catch((e: unknown) => e);
    expect(codeProblem(error)).toBe("That code isn't right. Check the text and try again.");
    expect(verifyOtp).not.toHaveBeenCalled();
  });

  it("keeps the API's words for too many tries, rather than the sign-in page's general ones", () => {
    const tooMany = new ApiError("Too many codes asked for. Wait a while and try again, or ask the office for a sign-in link.", 429);
    expect(codeProblem(tooMany)).toBe("Too many codes asked for. Wait a while and try again, or ask the office for a sign-in link.");
  });

  it("says to ask for a new code when the token can't be redeemed", async () => {
    answer = () => new Response(JSON.stringify({ token_hash: "hash-1", type: "magiclink" }));
    vi.spyOn(supabase().auth, "verifyOtp").mockResolvedValue({ data: { session: null, user: null }, error: new Error("Token has expired or is invalid") } as never);
    const error = await signInWithCode("+15405550101", "123456").catch((e: unknown) => e);
    expect(codeProblem(error)).toBe("Couldn't sign you in. Ask for a new code and try again.");
  });
});

describe("the email address", () => {
  it("takes it however it's written, trimmed and lower-cased as the API compares it", () => {
    for (const typed of ["jo@apexroofing.com", " Jo@ApexRoofing.com ", "jo.smith+crew@mail.example.co"]) expect(emailProblem(typed), typed).toBeNull();
    expect(readAddress("email", "  Jo@ApexRoofing.COM ")).toEqual({ address: "jo@apexroofing.com" });
    expect(readAddress("text", "(540) 555-0101")).toEqual({ address: "+15405550101" });
  });

  it("asks for a whole address in the API's words, and for one when there's none", () => {
    for (const typed of ["jo", "jo@", "jo@apex", "@apex.com", "jo @apex.com", "jo@apex .com"]) expect(emailProblem(typed), typed).toBe("Enter your email address, like name@example.com.");
    expect(emailProblem("  ")).toBe("Enter your email address.");
    expect(readAddress("email", "jo@apex")).toEqual({ error: "Enter your email address, like name@example.com." });
    expect(readAddress("text", "555-0101")).toEqual({ error: "Enter your phone number with the area code." });
  });

  it("says where the code went, in full, without saying whether the address has a sign-in", () => {
    expect(sentTo("email", "jo@apexroofing.com")).toBe("We emailed a code to jo@apexroofing.com if it belongs to a subcontractor's sign-in.");
  });

  it("takes the code pasted from the email", () => {
    expect(codeDigits("482913")).toBe("482913");
    expect(codeDigits(" 482913\n")).toBe("482913");
  });
});

describe("asking for a code by email", () => {
  it("sends the address to the API", async () => {
    answer = () => new Response(JSON.stringify({ sent: true }));
    expect(await askForEmailCode("jo@apexroofing.com")).toEqual({ sent: true });
    expect(sent).toEqual([{ url: "/api/auth/email-code", body: { email: "jo@apexroofing.com" } }]);
  });

  it("goes the chosen way", async () => {
    answer = () => new Response(JSON.stringify({ sent: true }));
    await askFor("email", "jo@apexroofing.com");
    await askFor("text", "+15405550101");
    expect(sent.map((s) => s.url)).toEqual(["/api/auth/email-code", "/api/auth/text-code"]);
  });

  it("shows the API's words when too many codes were asked for", async () => {
    answer = () => new Response(JSON.stringify({ error: "Too many codes asked for. Wait a while and try again, or ask the office for a sign-in link." }), { status: 429 });
    const error = await askForEmailCode("jo@apexroofing.com").catch((e: unknown) => e);
    expect(codeProblem(error)).toBe("Too many codes asked for. Wait a while and try again, or ask the office for a sign-in link.");
  });
});

describe("signing in with the code from the email", () => {
  it("sends the address and code, then redeems the token the way an emailed link is", async () => {
    answer = () => new Response(JSON.stringify({ token_hash: "hash-2", type: "magiclink" }));
    const verifyOtp = vi.spyOn(supabase().auth, "verifyOtp").mockResolvedValue({ data: { session: {}, user: {} }, error: null } as never);
    await signInWithEmailCode("jo@apexroofing.com", "482913");
    expect(sent).toEqual([{ url: "/api/auth/email-code/verify", body: { email: "jo@apexroofing.com", code: "482913" } }]);
    expect(verifyOtp).toHaveBeenCalledWith({ token_hash: "hash-2", type: "magiclink" });
  });

  it("goes the chosen way", async () => {
    answer = () => new Response(JSON.stringify({ token_hash: "hash-3", type: "magiclink" }));
    vi.spyOn(supabase().auth, "verifyOtp").mockResolvedValue({ data: { session: {}, user: {} }, error: null } as never);
    await signInWith("email", "jo@apexroofing.com", "482913");
    await signInWith("text", "+15405550101", "123456");
    expect(sent.map((s) => s.url)).toEqual(["/api/auth/email-code/verify", "/api/auth/text-code/verify"]);
  });

  it("shows the API's own words when the code is wrong, and doesn't try to sign in", async () => {
    answer = () => new Response(JSON.stringify({ error: "That code isn't right. Check the email and try again." }), { status: 400 });
    const verifyOtp = vi.spyOn(supabase().auth, "verifyOtp");
    const error = await signInWithEmailCode("jo@apexroofing.com", "000000").catch((e: unknown) => e);
    expect(codeProblem(error)).toBe("That code isn't right. Check the email and try again.");
    expect(verifyOtp).not.toHaveBeenCalled();
  });

  it("says to ask for a new code when the token can't be redeemed", async () => {
    answer = () => new Response(JSON.stringify({ token_hash: "hash-2", type: "magiclink" }));
    vi.spyOn(supabase().auth, "verifyOtp").mockResolvedValue({ data: { session: null, user: null }, error: new Error("Token has expired or is invalid") } as never);
    const error = await signInWithEmailCode("jo@apexroofing.com", "482913").catch((e: unknown) => e);
    expect(codeProblem(error)).toBe("Couldn't sign you in. Ask for a new code and try again.");
  });
});

describe("the office's line on a sub's Sign-in card", () => {
  const base = { sms: true, email: true, phone: "540-555-0101", emailAddress: "Jo@ApexRoofing.com", countries: [] as string[] };

  it("names both ways when both are set up and on their record", () => {
    expect(newPhoneWay(base)).toEqual({
      text: "On a new phone, they can get a sign-in code by text at (540) 555-0101 or by email at jo@apexroofing.com.",
      warning: null,
    });
  });

  it("names the one way they have", () => {
    expect(newPhoneWay({ ...base, emailAddress: null }).text).toBe("On a new phone, they can get a sign-in code by text at (540) 555-0101.");
    expect(newPhoneWay({ ...base, email: false }).text).toBe("On a new phone, they can get a sign-in code by text at (540) 555-0101.");
    expect(newPhoneWay({ ...base, sms: false }).text).toBe("On a new phone, they can get a sign-in code by email at jo@apexroofing.com.");
    // A number codes don't go to (outside the countries on) leaves email.
    expect(newPhoneWay({ ...base, phone: "+44 7700 900123" }).text).toBe("On a new phone, they can get a sign-in code by email at jo@apexroofing.com.");
  });

  it("folds asking for their number into the same line, in the Details field's words", () => {
    expect(newPhoneWay({ ...base, phone: null }).text).toBe(
      "On a new phone, they can get a sign-in code by email at jo@apexroofing.com. Add their mobile number under Details to text them a link and let them get codes by text.",
    );
    expect(newPhoneWay({ ...base, sms: false, phone: "" }).text).toBe(
      "On a new phone, they can get a sign-in code by email at jo@apexroofing.com. Add their mobile number under Details to text them a link.",
    );
  });

  it("says the office sends a new link when neither works, and what to add", () => {
    expect(newPhoneWay({ ...base, phone: null, emailAddress: null }).text).toBe(
      "On a new phone, they need a new sign-in link from you. Add their mobile number under Details to text them a link and let them get codes by text, or their email so they can get codes by email.",
    );
    expect(newPhoneWay({ ...base, sms: false, emailAddress: null }).text).toBe("On a new phone, they need a new sign-in link from you. Add their email under Details so they can get a code themselves.");
    expect(newPhoneWay({ ...base, email: false, phone: "" }).text).toBe(
      "On a new phone, they need a new sign-in link from you. Add their mobile number under Details to text them a link and let them get codes by text. To send them codes by email, an owner can connect your email in Settings → Email.",
    );
    // A placeholder address isn't one: nothing is ever sent to it.
    expect(newPhoneWay({ ...base, sms: false, emailAddress: "sub-1@subs.crewtavo.invalid" }).text).toContain("Add their email under Details");
  });

  it("points to connecting email when nothing can send codes", () => {
    expect(newPhoneWay({ ...base, sms: false, email: false }).text).toBe(
      "On a new phone, they need a new sign-in link from you. To send them codes by email, an owner can connect your email in Settings → Email.",
    );
  });

  it("also says to add their email when connecting email alone wouldn't reach them", () => {
    const needsBoth = "On a new phone, they need a new sign-in link from you. To send them codes by email, an owner can connect your email in Settings → Email, and add their email under Details.";
    expect(newPhoneWay({ ...base, sms: false, email: false, emailAddress: null }).text).toBe(needsBoth);
    expect(newPhoneWay({ ...base, sms: false, email: false, emailAddress: "sub-1@subs.crewtavo.invalid" }).text).toBe(needsBoth);
  });

  it("warns when another sub's sign-in has the same email, since codes go to neither", () => {
    const shared = newPhoneWay({ ...base, sms: false, emailShared: true });
    expect(shared.text).toBe("On a new phone, they need a new sign-in link from you.");
    expect(shared.warning).toBe("Another sub's sign-in has this email too, so codes by email go to neither. Give each sub their own email.");
    expect(newPhoneWay({ ...base, emailShared: true })).toEqual({
      text: "On a new phone, they can get a sign-in code by text at (540) 555-0101.",
      warning: "Another sub's sign-in has this email too, so codes by email go to neither. Give each sub their own email.",
    });
    // Nothing to warn about while email doesn't go out at all.
    expect(newPhoneWay({ ...base, email: false, emailShared: true }).warning).toBeNull();
  });
});

describe("the countries whose numbers get codes", () => {
  it("reads a calling code however it's typed", () => {
    for (const typed of ["44", "+44", " + 44 ", "0044", "011 44"]) expect(readCallingCode(typed, []), typed).toEqual({ code: "44" });
    expect(readCallingCode("353", ["44"])).toEqual({ code: "353" });
  });

  it("explains what's wrong in plain words", () => {
    expect(readCallingCode("", [])).toEqual({ error: "Enter the country's calling code, like 44 for the UK." });
    expect(readCallingCode("+1", [])).toEqual({ error: "US and Canadian numbers always get codes." });
    expect(readCallingCode("4444", [])).toEqual({ error: "+4444 isn't a country's calling code. It's 1 to 3 digits, like 44 for the UK." });
    expect(readCallingCode("44", ["44"])).toEqual({ error: "+44 United Kingdom is already on." });
    const full = Object.keys(CALLING_CODES).slice(0, MAX_SIGN_IN_COUNTRIES);
    expect(readCallingCode("998", full)).toEqual({ error: "Add up to 20 countries." });
  });

  it("refuses a short code that would open texting to a whole region", () => {
    expect("error" in readCallingCode("4", [])).toBe(true);
    expect("error" in readCallingCode("35", [])).toBe(true);
    // No country's code starts with another's, so a number's start says which country it is.
    const codes = Object.keys(CALLING_CODES);
    for (const a of codes) for (const b of codes) if (a !== b) expect(b.startsWith(a), `${a} and ${b}`).toBe(false);
    expect(codes).not.toContain("1");
  });

  it("saves the list in number order, as the database keeps it", () => {
    expect(withCountry(["52", "353"], "44")).toEqual(["44", "52", "353"]);
    expect(withCountry(["44"], "44")).toEqual(["44"]);
  });

  it("tells the office how a sub's number reads for sign-in codes", () => {
    expect(signInPhoneNote("540-555-0101", [], true)).toEqual({ ok: true, text: "Sign-in codes by text go to (540) 555-0101." });
    // Mexico written without its +52 reads as a US number: the office sees which.
    expect(signInPhoneNote("55 1234 5678", ["52"], true)).toEqual({ ok: true, text: "Sign-in codes by text go to (551) 234-5678." });
    expect(signInPhoneNote("+52 55 1234 5678", ["52"], true)).toEqual({ ok: true, text: "Sign-in codes by text go to +525512345678." });
    const cant = "This number can't get sign-in codes. Write it with the area code, or with + and the country code for numbers outside the US and Canada.";
    for (const phone of ["540-555-0101 x23", "07700 900123", "555-0101"]) expect(signInPhoneNote(phone, ["44"], true), phone).toEqual({ ok: false, text: cant });
    expect(signInPhoneNote("+44 7700 900123", [], true)).toEqual({
      ok: false,
      text: "Sign-in codes don't go to numbers in United Kingdom yet. Add the country under Sign-in codes by text on the Subcontractors page.",
    });
    expect(signInPhoneNote("+44 7700 900123", ["44"], true)?.ok).toBe(true);
  });

  it("says nothing about codes without a number, or when this Crewtavo can't text", () => {
    expect(signInPhoneNote("", [], true)).toBeNull();
    expect(signInPhoneNote(null, [], true)).toBeNull();
    expect(signInPhoneNote("540-555-0101 x23", [], false)).toBeNull();
    expect(SUB_PHONE_HINT).toBe("With the area code. Outside the US and Canada, start with + and the country code.");
  });

  it("names the country next to its code", () => {
    expect(countryLabel("52")).toBe("+52 Mexico");
    expect(countryLabel("888")).toBe("+888");
  });
});
