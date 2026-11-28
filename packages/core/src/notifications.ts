import { msg } from "./i18n";
import { addDays, isTimeZoneName, localDate, localTime, zonedTimeToUtc } from "./time";

/**
 * Kinds of notification a person can also get by email, text or a push to their phone (the bell in
 * the app always shows everything). Mirrors the check on public.notification_prefs. The words are
 * shown with t() (Settings → Profile can be in Spanish).
 */
export const NOTIFICATION_TOPICS = [
  { key: "schedule", label: msg("My schedule changes"), hint: msg("Added to or taken off a visit, moved or cancelled") },
  { key: "client", label: msg("Messages from clients"), hint: msg("Texts and Client Hub messages") },
  { key: "time", label: msg("Clock reminders"), hint: msg("When a clock has been running too long") },
  { key: "equipment", label: msg("Equipment maintenance"), hint: msg("Service coming due or overdue, tags and inspection stickers running out") },
  // People with the subs area only (packages/core/src/roles.ts).
  { key: "subs", label: msg("Subcontractors"), hint: msg("Insurance running out, paperwork a sub sends in, and answers to job offers") },
  // Owners, admins and office staff with the marketing area, while Google Business Profile brings
  // reviews in (apps/api/src/services/googleReviews.ts). By email only 1 and 2 stars (byEmail).
  // Owners and admins who connect apps hear when it needs them (reviewNoticesFor).
  { key: "reviews", label: msg("Google reviews"), hint: msg("New reviews, low ratings first. Email only for 1 and 2 stars") },
  // The same people, while Marketing → Social posts (apps/api/src/services/social.ts): an automatic
  // post scheduled (push only, byEmail), and a post that didn't all go or may have gone.
  { key: "social", label: msg("Social posts"), hint: msg("Automatic posts coming up, and posts that didn't go. Email only for those that didn't") },
  // Subs only: their job offers and their pay (on by default, texts too: an offer waits for their answer).
  { key: "jobs", label: msg("My jobs"), hint: msg("Job offers, and what you're owed and paid") },
  { key: "alerts", label: msg("Other alerts"), hint: msg("Leads handed to you, and your company's automations, like a quote being approved") },
  { key: "chat", label: msg("Team chat"), hint: msg("Direct messages, @mentions of you or your role, replies to you and threads you follow. Each channel's bell can change it") },
  // Owners and admins: Railway's warnings (services/hosting.ts) and storage nearing its limit
  // (services/storageUsage.ts), and owners: the nightly database backup failing (services/backups.ts).
  // Off Railway, Settings → Profile calls it "Storage and backups".
  { key: "hosting", label: msg("Railway"), hint: msg("Before the trial runs out, or when the bill goes over the plan, storage fills up or the nightly backup stops working") },
] as const;
export type NotificationTopic = (typeof NOTIFICATION_TOPICS)[number]["key"];

export const NOTIFICATION_CHANNELS = ["email", "sms", "push"] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

/** Defaults until a person changes them (same as the column defaults). */
export const DEFAULT_NOTIFICATION_PREFS: Record<NotificationChannel, NotificationTopic[]> = {
  email: ["schedule", "jobs", "hosting", "reviews", "social"],
  sms: ["jobs"],
  push: ["schedule", "client", "equipment", "subs", "jobs", "time", "alerts", "chat", "hosting", "reviews", "social"],
};

/**
 * notifications.kind -> topic. Automations use the subject's type (quote, invoice...) as the kind.
 */
export function notificationTopic(kind: string): NotificationTopic {
  // Snow tomorrow (Apps → Crewtavo - Snow) is schedule news: the crew may be going out.
  if (kind === "snow") return "schedule";
  if (kind === "schedule" || kind === "client" || kind === "equipment" || kind === "time" || kind === "chat" || kind === "hosting" || kind === "subs" || kind === "jobs") return kind;
  // Team chat's reminders, and a scheduled message that couldn't be sent, come as Team chat does.
  if (kind === "chat_reminder" || kind === "chat_scheduled") return "chat";
  // A new review, one of 1 or 2 stars (or changed down to that), and Google access starting or stopping.
  if (kind === "review" || kind === "review_low" || kind === "review_access") return "reviews";
  // An automatic post scheduled, and a post that didn't all go or Facebook & Instagram needing a sign-in.
  if (kind === "social_scheduled" || kind === "social_failed") return "social";
  return "alerts";
}

/**
 * What the Google reviews topic brings someone, so it's offered to everyone it reaches: "reviews"
 * (new reviews and Google's first sync, for owners, admins and office staff with the marketing
 * area, as private.marketing_office picks them), "access" (Google Business Profile needing a
 * sign-in or a location picked, for owners and admins with the apps area but not marketing, as
 * private.apps_admins picks them), or null. Nothing goes while Marketing is uninstalled.
 */
export function reviewNoticesFor(who: { role: string; permissions: readonly string[] }, marketingInstalled: boolean): "reviews" | "access" | null {
  if (!marketingInstalled) return null;
  const has = (area: string) => who.role === "owner" || who.permissions.includes(area);
  if ((who.role === "owner" || who.role === "admin" || who.role === "office") && has("marketing")) return "reviews";
  if (who.role === "admin" && has("apps")) return "access";
  return null;
}

/** The topic's words for someone who hears only when Google Business Profile needs them. */
export const REVIEW_ACCESS_HINT = msg("When Google Business Profile needs signing in again or a location picked");
/** The Social posts topic's hint for those same owners and admins: they hear only about Facebook & Instagram's sign-in. */
export const SOCIAL_ACCESS_HINT = msg("When Facebook & Instagram needs signing in again");

/**
 * The kinds that tell owners and admins the company's email or texts have stopped going out
 * (public.note_sending). They come under "Other alerts", and never by the channel they're about.
 */
export const SENDING_WARNINGS = { email: "email_failing", sms: "texts_failing" } as const;

/**
 * Whether a kind goes by email for someone who has its topic on. A review of 3 stars or more is
 * only for the bell and the phone: an email is for the ones to answer first (review_low). An
 * automatic post scheduled is the same: only one that didn't go is worth an email. And a warning
 * that email isn't going out can't come by email.
 */
export const byEmail = (kind: string) => kind !== "review" && kind !== "social_scheduled" && kind !== SENDING_WARNINGS.email;

/** Whether a kind goes by text: all but the warning that texts aren't going out. */
export const byText = (kind: string) => kind !== SENDING_WARNINGS.sms;

/**
 * Team chat's quiet hours and pause for one person (public.chat_quiet_hours): during either, chat
 * notifications stay on the bell, with no push, email or text (services/delivery.ts). Times are
 * "21:00" (Postgres sends "21:00:00"), days 0 (Sunday) to 6, and the zone is the person's, or the
 * business's when they didn't pick one.
 */
export interface ChatQuiet {
  quiet_on: boolean;
  starts: string;
  ends: string;
  days: readonly number[];
  time_zone: string | null;
  paused_until: string | null;
}

/** The zone quiet hours are read in: the person's, else the business's, else UTC. */
export const quietZone = (quiet: Pick<ChatQuiet, "time_zone"> | null | undefined, companyZone: string | null | undefined) =>
  [quiet?.time_zone, companyZone].find((z): z is string => Boolean(z) && isTimeZoneName(z!)) ?? "UTC";

/**
 * Whether Team chat is quiet for someone at `at`: paused until later, or in their quiet hours. Each
 * chosen day's quiet time starts at `starts` and runs to `ends`, past midnight when that's earlier (a
 * Friday's 21:00 to 07:00 ends on Saturday morning). The same start and end is the whole day.
 */
export function chatQuietAt(at: Date, quiet: ChatQuiet | null | undefined, companyZone: string | null | undefined): boolean {
  if (!quiet) return false;
  if (quiet.paused_until && Date.parse(quiet.paused_until) > at.getTime()) return true;
  if (!quiet.quiet_on || !quiet.days.length) return false;
  const zone = quietZone(quiet, companyZone);
  const time = localTime(at, zone);
  const day = new Date(`${localDate(at, zone)}T12:00:00Z`).getUTCDay();
  const starts = quiet.starts.slice(0, 5);
  const ends = quiet.ends.slice(0, 5);
  const on = (d: number) => quiet.days.includes(d);
  if (starts === ends) return on(day);
  if (starts < ends) return on(day) && time >= starts && time < ends;
  return (on(day) && time >= starts) || (on((day + 6) % 7) && time < ends);
}

/** "Pause until tomorrow morning": 8:00 the next morning where they are (this morning's, in the small hours). */
export function nextMorning(now: Date, zone: string): Date {
  const today = localDate(now, zone);
  return zonedTimeToUtc(localTime(now, zone) < "04:00" ? today : addDays(today, 1), "08:00", zone);
}

