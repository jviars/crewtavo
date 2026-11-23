/**
 * The ways to send a client something from the menu on their page (a review ask, an autopay invite, a
 * referral ask): each item's second line says where it goes, the client's own email or phone as the
 * server sends to, or, when it can't go, why, in a few words (ClientMenu.dc.html).
 */
import type { AskChannel, Reach } from "@crewtavo/core/marketing";

/** Why `way` can't reach them, or null when it can. */
export function wayBlocked(reach: Reach, way: AskChannel): string | null {
  if (way !== "sms" && !reach.hasEmail) return "No email on file";
  if (way !== "sms" && !reach.emailReady) return "Email isn't connected";
  if (way !== "email" && !reach.hasPhone) return "No mobile number on file";
  if (way !== "email" && reach.textsOff) return "Texts are off for them";
  if (way !== "email" && !reach.smsReady) return "Texting isn't set up";
  return null;
}

/** A way to send as a menu item: its second line, and whether it's turned off. `refused` is a reason every way shares (they opted out). */
export function sendWay(to: { email: string | null; phone: string | null }, reach: Reach, way: AskChannel, refused?: string | null): { description: string; disabled: boolean } {
  const why = refused || wayBlocked(reach, way);
  return { description: why ?? (way === "email" ? to.email! : way === "sms" ? to.phone! : "Both"), disabled: Boolean(why) };
}

/** Why a client isn't asked at all (core's notAsked and referralAskRefusal, in a few words), or null. */
export const askedNot = (c: { review_opt_out?: boolean | null; marketing_opt_out?: boolean | null; status?: string | null }) =>
  c.review_opt_out ? "Asked not to get review asks" : c.marketing_opt_out ? "Unsubscribed from marketing" : c.status === "archived" ? "Archived, so not asked" : null;
