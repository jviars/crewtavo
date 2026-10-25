/**
 * How a sub with a sign-in gets back in on a new phone, for their Sign-in card (docs/subcontractors-plan.md
 * §7): a code by text to the number on their record (when this Crewtavo texts), a code by email to the
 * address on their record (when the company's email goes out), or, with neither, a new link from the office.
 */
import { emailKey, isPlaceholderEmail } from "@crewtavo/core/email";
import { phoneDisplay, phoneE164, textsCodesTo } from "@crewtavo/core/phone";

export interface NewPhoneInput {
  /** This Crewtavo texts. */
  sms: boolean;
  /** The company's email goes out: its own mailbox, or this Crewtavo's sender. */
  email: boolean;
  phone: string | null | undefined;
  emailAddress: string | null | undefined;
  /** The countries whose numbers get codes (companies.settings.subs.sign_in_countries). */
  countries: readonly string[];
  /** Another sub's sign-in has the same email, so codes by email go to neither. */
  emailShared?: boolean;
}

/**
 * The one line, and a warning when the address on file can't get codes because another of your
 * subs' sign-ins has it too. (Another business's sub with the same address doesn't stop it: each
 * business's sign-in gets its own code.) With no number on file, the line also says to add one to
 * text them a link, so the card has one line about it, not two.
 */
export function newPhoneWay(input: NewPhoneInput): { text: string; warning: string | null } {
  const noPhone = !input.phone?.trim();
  const e164 = noPhone ? null : phoneE164(input.phone);
  const byText = input.sms && e164 && textsCodesTo(e164, input.countries) ? e164 : null;
  const address = input.emailAddress && !isPlaceholderEmail(input.emailAddress) ? emailKey(input.emailAddress) : null;
  const byEmail = input.email && address && !input.emailShared ? address : null;
  const warning = input.email && address && input.emailShared ? "Another sub's sign-in has this email too, so codes by email go to neither. Give each sub their own email." : null;
  const addPhone = input.sms ? "Add their mobile number under Details to text them a link and let them get codes by text" : "Add their mobile number under Details to text them a link";

  if (byText && byEmail) return { text: `On a new phone, they can get a sign-in code by text at ${phoneDisplay(byText)} or by email at ${byEmail}.`, warning };
  if (byText) return { text: `On a new phone, they can get a sign-in code by text at ${phoneDisplay(byText)}.`, warning };
  if (byEmail) return { text: `On a new phone, they can get a sign-in code by email at ${byEmail}.${noPhone ? ` ${addPhone}.` : ""}`, warning };

  // Neither: a new link from the office, and what would let them get a code themselves.
  const parts = ["On a new phone, they need a new sign-in link from you."];
  if (input.email && !address) parts.push(noPhone ? `${addPhone}, or their email so they can get codes by email.` : "Add their email under Details so they can get a code themselves.");
  else if (noPhone) parts.push(`${addPhone}.`);
  if (!input.email) parts.push(`To send them codes by email, an owner can connect your email in Settings → Email${address ? "." : ", and add their email under Details."}`);
  return { text: parts.join(" "), warning };
}
