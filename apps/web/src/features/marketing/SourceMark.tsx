/**
 * A network's or a lead source's mark, so Marketing's lists read at a glance (Buffer and Later badge
 * each post with its network): Google, Facebook, Instagram and the other networks as their logo in
 * their brand's color (Phosphor's glyphs, MIT, one color like the rest of the app's icons), and the
 * usual ways work comes in (a referral, a call, a postcard, a yard sign, a bid, the website, an
 * email) as a plain icon. Anything else has none.
 */
import { Icon, type IconName } from "@/components/ui/Icon";

export type Mark = { icon: IconName; color?: string };

// First match wins, so "Website form · Google" is Google's and "Google Business Profile" is too.
const MARKS: Array<[RegExp, Mark]> = [
  [/google/i, { icon: "google", color: "#4285F4" }],
  [/facebook|\bfb\b/i, { icon: "facebook", color: "#1877F2" }],
  [/instagram/i, { icon: "instagram", color: "#E1306C" }],
  [/youtube/i, { icon: "youtube", color: "#FF0000" }],
  [/tiktok/i, { icon: "tiktok" }],
  [/^x$|twitter|\bx\.com\b/i, { icon: "xLogo" }],
  [/referr|word of mouth/i, { icon: "handshake" }],
  [/postcard|mailer|flyer|direct mail/i, { icon: "mailbox" }],
  [/\b(yard )?signs?\b/i, { icon: "signpost" }],
  [/\bbids?\b/i, { icon: "gavel" }],
  [/phone|\bcall/i, { icon: "phone" }],
  // Not "Campaign": a tagged link may be a flyer's QR code as much as an email.
  [/e-?mail|newsletter/i, { icon: "mail" }],
  [/website|web form|\bform\b/i, { icon: "globe" }],
];

/** The mark for a network ("facebook") or a lead source as it's written ("Yard sign"), or null. */
export function sourceMark(name: string | null | undefined): Mark | null {
  return name ? (MARKS.find(([pattern]) => pattern.test(name))?.[1] ?? null) : null;
}

/** Decorative: the name it marks is always written beside it. */
export function SourceMark({ name, size = 14 }: { name: string | null | undefined; size?: number }) {
  const mark = sourceMark(name);
  if (!mark) return null;
  return (
    <span aria-hidden="true" style={{ display: "inline-grid", placeItems: "center", flex: "none", color: mark.color ?? "var(--text-3)" }}>
      <Icon name={mark.icon} size={size} />
    </span>
  );
}
