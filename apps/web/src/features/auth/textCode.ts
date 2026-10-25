/**
 * Signing in with a code, for a sub on a new phone (docs/subcontractors-plan.md §7, phases E and E2):
 * their phone number or email address, then the 6-digit code texted or emailed to it
 * (apps/api/src/routes/signInCodes.ts). A right code comes back as a one-time sign-in token, redeemed
 * the way emailed sign-in links are (redeemEmailLink in lib/session.tsx). Unlike a link, this works
 * inside an app added to the Home Screen, which keeps its own sign-in. Texts come first; email is the
 * way in when this Crewtavo can't text, and for a sub with no phone on file when it can.
 */
import { emailKey } from "@crewtavo/core/email";
import { phoneDisplay, phoneE164 } from "@crewtavo/core/phone";
import { SIGN_IN_CODE_DIGITS } from "@crewtavo/core/subs";
import { api, supabase, type AppConfig } from "@/lib/api";
import type { SubLogin } from "@/lib/session";

/** How long before "Send a new code" works again. The API allows 3 codes per number or address in 15 minutes. */
export const RESEND_SECONDS = 60;

/** Which way the code goes: by text to a phone number, or by email to an address. */
export type CodeWay = "text" | "email";

/**
 * Where the sign-in with a code stands: typing the number or address, typing the code that went to
 * it (`address` as the API takes it, `sentAt` for the countdown), or this Crewtavo can't text.
 */
export type CodeStep = { step: "address" } | { step: "code"; address: string; sentAt: number } | { step: "off" };

/** After asking for a code: on to typing it, or (no texting set up) how else to get back in. Email always goes on. */
export function afterAsking(answer: { sent: boolean }, address: string, now: number): CodeStep {
  return answer.sent ? { step: "code", address, sentAt: now } : { step: "off" };
}

type CodeFeatures = Partial<Pick<AppConfig["features"], "sms" | "emailCodes" | "email">> | undefined;

/**
 * What the sign-in page offers someone on a new phone: a code by text, by email (this Crewtavo can't
 * text but can email), or asking the office. It goes by the whole Crewtavo, since nobody is known yet.
 */
export function newPhoneOffer(features: CodeFeatures): CodeWay | "ask_office" {
  if (features?.sms) return "text";
  return features?.emailCodes ? "email" : "ask_office";
}

/** With texting on, the code by text comes first, and email is there for a sub with no phone on file. */
export const emailInstead = (features: CodeFeatures) => Boolean(features?.sms && features.emailCodes);

/**
 * The links under the sign-in form for someone on a new phone, first one first: a code by text and,
 * when email codes go out too, a smaller one by email for a sub with no phone on file; a code by email
 * alone when this Crewtavo can't text; or, with neither, asking the office.
 */
export function newPhoneOffers(features: CodeFeatures): Array<{ way: CodeWay; label: string }> | "ask_office" {
  const offer = newPhoneOffer(features);
  if (offer === "ask_office") return offer;
  if (offer === "email") return [{ way: "email", label: "Subcontractor? Get a sign-in code by email" }];
  const text = { way: "text" as const, label: "Subcontractor? Get a sign-in code by text" };
  return emailInstead(features) ? [text, { way: "email", label: "No phone on file? Get a code by email instead" }] : [text];
}

/**
 * How a signed-in sub gets back in on a new phone: by text when this Crewtavo texts and their record
 * has a number codes go to, and by email when their company's email goes out (its own mailbox, or this
 * Crewtavo's sender) and their record has an email. A session's features are already its company's
 * (companyFeatures in lib/api.ts). With neither, they need a new link from the office.
 */
export const subCodeWays = (features: CodeFeatures, sub: Pick<SubLogin, "has_phone" | "has_email"> | null | undefined) => ({
  text: Boolean(features?.sms && sub?.has_phone),
  email: Boolean(features?.emailCodes && features.email && sub?.has_email),
});

export type CodeWays = ReturnType<typeof subCodeWays>;

/**
 * Whether a signed-in sub could sign in again inside an app added to the Home Screen (on an iPhone it
 * keeps its own sign-in, apart from Safari's, and a sign-in link opens in Safari): with a code by text
 * or email, or with their own account's password. Only then is the iPhone install shown to them.
 */
export const subSignsInOnHomeScreen = (features: CodeFeatures, sub: Pick<SubLogin, "own_sign_in" | "has_phone" | "has_email"> | null | undefined) => {
  if (sub?.own_sign_in === false) return true;
  const ways = subCodeWays(features, sub);
  return ways.text || ways.email;
};

/** On the iPhone install steps for a sub: how to sign in, once in the Home Screen app. */
export function homeScreenSignInNote(features: CodeFeatures, sub: Pick<SubLogin, "own_sign_in" | "has_phone" | "has_email"> | null | undefined): string | null {
  if (!sub || sub.own_sign_in === false) return null;
  const ways = subCodeWays(features, sub);
  if (ways.text) return "In the Home Screen app, tap Get a sign-in code by text to sign in.";
  if (ways.email) return "In the Home Screen app, tap Get a sign-in code by email to sign in.";
  return null;
}

export const ASK_THE_OFFICE = "On a new phone? Ask the office to text you a new sign-in link.";

/** After asking for a code on a Crewtavo that can't text (the API's { sent: false, reason: "sms_off" }). */
export const TEXTING_OFF = `This Crewtavo isn't set up to send texts yet. ${ASK_THE_OFFICE}`;

/** Under the code: what to do when nothing comes, since the answer never says whether the number or address has a sign-in. */
export const NOTHING_CAME: Record<CodeWay, string> = {
  text: "Nothing after a few minutes? Ask the office for a new sign-in link.",
  email: "Nothing after a few minutes? Check your spam folder. Still nothing? Ask the office for a new sign-in link.",
};

/** The sub's Profile → Signing in: how to get back in on a new phone. */
export function signingInNote(companyName: string, ways: CodeWays): string {
  const start = "There's no password. You stay signed in on this phone until you sign out.";
  const fallback = `If no code comes, ask ${companyName} for a new sign-in link.`;
  if (ways.text) {
    const email = ways.email ? " No number on file? Tap Get a code by email instead, and we'll email one to the address they have." : "";
    return `${start} On a new phone, open Crewtavo and tap Get a sign-in code by text. We'll text a code to the number ${companyName} has for you.${email} ${fallback}`;
  }
  if (ways.email) return `${start} On a new phone, open Crewtavo and tap Get a sign-in code by email. We'll email a code to the address ${companyName} has for you. ${fallback}`;
  return `${start} On a new phone, ask ${companyName} to text you a new sign-in link.`;
}

/** The "Sign out?" question a sub is asked first, since there's no password: how they get back in. */
export function signOutNote(companyName: string, ways: CodeWays): string {
  if (ways.text && ways.email) return "There's no password. To get back in, open Crewtavo and get a sign-in code by text or by email.";
  if (ways.text) return "There's no password. To get back in, open Crewtavo and tap Get a sign-in code by text.";
  if (ways.email) return "There's no password. To get back in, open Crewtavo and tap Get a sign-in code by email.";
  return `There's no password. To get back in, ask ${companyName} to text you a new sign-in link.`;
}

/** What's wrong with the number typed, in the API's words, or null when it's a whole number. */
export function phoneProblem(input: string): string | null {
  if (!input.trim()) return "Enter your phone number.";
  return phoneE164(input) ? null : "Enter your phone number with the area code.";
}

/** What's wrong with the email address typed, in the API's words, or null when it's a whole address. */
export function emailProblem(input: string): string | null {
  if (!input.trim()) return "Enter your email address.";
  return emailKey(input) ? null : "Enter your email address, like name@example.com.";
}

/** The number or address as the API takes it (E.164, or trimmed and lower-cased), or what's wrong with it. */
export function readAddress(way: CodeWay, input: string): { address: string } | { error: string } {
  const problem = way === "text" ? phoneProblem(input) : emailProblem(input);
  if (problem) return { error: problem };
  return { address: way === "text" ? phoneE164(input)! : emailKey(input)! };
}

/** "We texted a code to (540) 555-0101 …", without saying whether that number or address has a sign-in. */
export const sentTo = (way: CodeWay, address: string) =>
  way === "text"
    ? `We texted a code to ${phoneDisplay(address)} if it belongs to a subcontractor's sign-in.`
    : `We emailed a code to ${address} if it belongs to a subcontractor's sign-in.`;

/** 6 digits standing on their own, not part of a longer number. */
const WHOLE_CODE = new RegExp(`(?<![0-9])[0-9]{${SIGN_IN_CODE_DIGITS}}(?![0-9])`);

/**
 * The code from what was typed or pasted. The whole text or email pasted in ("123456 is your sign-in
 * code…", or "…sign in to A1 Roofing on Crewtavo:" and the code on its own line) gives the 6 digits
 * that stand on their own, so a company name's digits aren't taken for the code's. Otherwise its
 * digits, at most 6, so "123 456" or "123-456" works too.
 */
export const codeDigits = (input: string) => WHOLE_CODE.exec(input)?.[0] ?? input.replace(/[^0-9]/g, "").slice(0, SIGN_IN_CODE_DIGITS);

export const wholeCode = (code: string) => code.length === SIGN_IN_CODE_DIGITS;

/**
 * The whole code arrived in one go (the phone filled it in from the text or email, or it was pasted),
 * so signing in can start without a tap. Typed one digit at a time, it waits for Sign in.
 */
export const filledAtOnce = (before: string, after: string) => wholeCode(after) && after.length - before.length > 1;

/** Seconds until "Send a new code" works again, counted from when the last one went. */
export const resendIn = (sentAt: number, now: number) => Math.max(0, Math.ceil(RESEND_SECONDS - (now - sentAt) / 1000));

export const resendLabel = (seconds: number) => (seconds > 0 ? `Send a new code in ${seconds}s` : "Send a new code");

/**
 * What went wrong, in the API's own words ("That code isn't right…", "Too many codes asked for…"),
 * which say what to do next. Not the sign-in page's general wording for Supabase's errors.
 */
export const codeProblem = (error: unknown) => (error instanceof Error && error.message ? error.message : "Something went wrong. Try again.");

/** Texts a code to the number, if it belongs to a sub's sign-in. `sent` is false when this Crewtavo can't text. */
export const askForCode = (phone: string) => api.post<{ sent: boolean; reason?: string }>("/auth/text-code", { phone });

/** Emails a code to the address, if it's the one the office keeps for a sub's sign-in. Always `sent`, either way. */
export const askForEmailCode = (email: string) => api.post<{ sent: boolean }>("/auth/email-code", { email });

/** Asks for a code the chosen way. */
export const askFor = (way: CodeWay, address: string) => (way === "text" ? askForCode(address) : askForEmailCode(address));

/** Redeems the API's one-time sign-in token; SessionProvider takes it from there. */
async function redeem(answer: Promise<{ token_hash: string; type: "magiclink" }>): Promise<void> {
  const { token_hash, type } = await answer;
  const { error } = await supabase().auth.verifyOtp({ token_hash, type });
  if (error) throw new Error("Couldn't sign you in. Ask for a new code and try again.");
}

/** Signs in with the code from the text. Throws the API's plain words when it's wrong. */
export const signInWithCode = (phone: string, code: string) => redeem(api.post("/auth/text-code/verify", { phone, code }));

/** Signs in with the code from the email. Throws the API's plain words when it's wrong. */
export const signInWithEmailCode = (email: string, code: string) => redeem(api.post("/auth/email-code/verify", { email, code }));

/** Signs in with the code that went the chosen way. */
export const signInWith = (way: CodeWay, address: string, code: string) => (way === "text" ? signInWithCode(address, code) : signInWithEmailCode(address, code));
