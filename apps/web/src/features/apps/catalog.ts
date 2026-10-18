/**
 * What the Apps pages show about each app. How an app connects, and whether this deployment can
 * offer it, comes from the API (apps/api/src/integrations/registry.ts); the words and pictures
 * people read live here.
 */
import { useQuery } from "@tanstack/react-query";
import type { IconName } from "@/components/ui/Icon";
import { api } from "@/lib/api";
import { can, hasRole, useSession } from "@/lib/session";

export interface AppRow {
  id: string;
  name: string;
  category: "Calendar" | "AI" | "Accounting" | "Payments" | "Messaging";
  description: string;
  auth: "oauth" | "api_key" | "link" | "connector";
  docs: string;
  available: boolean;
  redirect_uri: string | null;
  status: "connected" | "disconnected" | "error";
  account_label?: string | null;
  last_sync_at?: string | null;
  last_error?: string | null;
  /** Calendar apps: how many calendars were added from this app, and how many have a problem. */
  calendars?: number;
  calendar_errors?: number;
}

export interface AppsData {
  mcp_url: string;
  apps: AppRow[];
}

/** The Apps list, for owners and admins who can connect apps. */
export function useApps() {
  const session = useSession();
  const allowed = hasRole(session, "admin") && can(session, "apps");
  const query = useQuery({ queryKey: ["apps", session.company.id], enabled: allowed, queryFn: () => api.get<AppsData>("/apps") });
  return { allowed, ...query };
}

export const CATEGORY_LABELS: Record<AppRow["category"], string> = {
  Calendar: "Calendars",
  AI: "AI assistants",
  Accounting: "Accounting",
  Payments: "Payments",
  Messaging: "Messaging",
};

/** The row of related apps at the bottom of an app's page. */
export const MORE_LABELS: Record<AppRow["category"], string> = {
  Calendar: "More calendars",
  AI: "More AI assistants",
  Accounting: "More accounting apps",
  Payments: "More payment apps",
  Messaging: "More messaging apps",
};

/** "Add a Zoho calendar", "Add an Outlook calendar"... */
export const CALENDAR_NOUNS: Record<string, string> = {
  google_calendar: "a Google calendar",
  zoho_calendar: "a Zoho calendar",
  outlook_calendar: "an Outlook calendar",
  apple_calendar: "an iCloud calendar",
  ics_calendar: "a calendar",
};

export interface AppInfo {
  developer: string;
  /** One line under the name, like an app store subtitle. */
  tagline: string;
  about: string;
  highlights: Array<{ icon: IconName; title: string; text: string }>;
  /** What Crewtavo can see and do in the other app. */
  access: string[];
  connectsWith: string;
  /** Where to find a calendar's ICS link (calendar apps added by link). */
  steps?: string[];
  website: string;
}

const CALENDAR_HIGHLIGHTS: AppInfo["highlights"] = [
  { icon: "calendar", title: "Next to your visits", text: "Events show on the schedule in the calendar's color, by day, week and month." },
  { icon: "clock", title: "Find a time knows", text: "Busy time counts when Crewtavo suggests open slots, so nobody gets double-booked." },
  { icon: "refresh", title: "Always current", text: "Read again every 15 minutes, with repeats, moved meetings and cancellations." },
];

const LINK_ACCESS = ["Read the events on the calendars you add", "Nothing else: it can't change the calendar"];

export const APP_INFO: Record<string, AppInfo> = {
  google_calendar: {
    developer: "Google",
    tagline: "Your Google calendars on the schedule, and visits on Google",
    about:
      "See appointments from your Google calendars next to your crews' visits, so nobody books over a supplier meeting or a day off. Crewtavo can also put every visit on a Google calendar it makes for you and keep it up to date as the schedule changes, so anyone you share it with sees the day on their phone.",
    highlights: [
      { icon: "calendar", title: "Pick your calendars", text: "Choose which calendars show on the schedule. Each one can belong to a crew." },
      { icon: "clock", title: "Find a time knows", text: "Busy time on those calendars counts when Crewtavo suggests an open slot." },
      { icon: "calendarCheck", title: "Visits on Google", text: "New, moved and finished visits update on Google within a few minutes." },
    ],
    access: [
      "See the list of your calendars",
      "Read events on the calendars you choose to show",
      "Make one calendar for your visits and keep it up to date",
      "It can't change or delete any of your own events",
    ],
    connectsWith: "Google sign-in",
    steps: [
      "In Google Calendar on a computer, open Settings (the gear at the top).",
      "Under Settings for my calendars, click the calendar.",
      "In Integrate calendar, copy the Secret address in iCal format.",
    ],
    website: "https://calendar.google.com/",
  },
  zoho_calendar: {
    developer: "Zoho",
    tagline: "Zoho calendars on your schedule",
    about:
      "Show any Zoho calendar next to your crews' visits: the office calendar, a crew's calendar or someone's days off. Crewtavo reads it from its private ICS link, including repeating events and the changes made to them.",
    highlights: CALENDAR_HIGHLIGHTS,
    access: LINK_ACCESS,
    connectsWith: "Calendar link (ICS)",
    steps: [
      "In Zoho Calendar, open the calendar's settings (Settings, then My Calendars, or the ⋮ menu next to it).",
      "Under Share or Publish, turn on the private address.",
      "Copy the private ICS link.",
    ],
    website: "https://www.zoho.com/calendar/",
  },
  outlook_calendar: {
    developer: "Microsoft",
    tagline: "Outlook and Microsoft 365 calendars on your schedule",
    about:
      "Show Outlook.com, Microsoft 365 and Exchange calendars next to your crews' visits. Crewtavo reads a published calendar's ICS link, with Outlook's time zones, repeating meetings and free or busy time.",
    highlights: CALENDAR_HIGHLIGHTS,
    access: LINK_ACCESS,
    connectsWith: "Calendar link (ICS)",
    steps: [
      "In Outlook on the web, open Settings, then Calendar, then Shared calendars.",
      "Under Publish a calendar, pick the calendar and Can view all details, then Publish.",
      "Copy the ICS link (not the HTML one).",
    ],
    website: "https://outlook.office.com/calendar/",
  },
  apple_calendar: {
    developer: "Apple",
    tagline: "iCloud calendars on your schedule",
    about:
      "Show calendars from iPhone, iPad and Mac (iCloud) next to your crews' visits. Turn on Public Calendar for the calendar and add its link here. Anyone with that link can see the calendar, so Crewtavo keeps it encrypted.",
    highlights: CALENDAR_HIGHLIGHTS,
    access: LINK_ACCESS,
    connectsWith: "Calendar link (webcal)",
    steps: [
      "On iPhone, open Calendar and tap Calendars at the bottom.",
      "Tap ⓘ next to the calendar and turn on Public Calendar.",
      "Tap Share Link, then Copy. (On a Mac or at icloud.com, the share button next to the calendar has the same option.)",
    ],
    website: "https://www.icloud.com/calendar/",
  },
  ics_calendar: {
    developer: "Any calendar app",
    tagline: "Any calendar with an ICS or webcal link",
    about:
      "Yahoo, Fastmail, Proton, Nextcloud, booking and rental tools, holiday and school calendars: if it gives you a subscribe link, its events can sit next to your crews' visits.",
    highlights: CALENDAR_HIGHLIGHTS,
    access: LINK_ACCESS,
    connectsWith: "Calendar link (ICS)",
    steps: [
      "In your calendar app, look for Share, Publish, Export or Subscribe.",
      "Copy the link that ends in .ics or starts with webcal://.",
    ],
    website: "https://en.wikipedia.org/wiki/ICalendar",
  },
  anthropic: {
    developer: "Anthropic",
    tagline: "Use Crewtavo from Claude",
    about:
      "Ask Claude about your clients and schedule, log new requests and add notes right from a chat. Each person signs in with their own Crewtavo account, and Claude can only see and do what that person's role allows. Add your own Anthropic key to power Crewtavo's writing help and answers from your guides.",
    highlights: [
      { icon: "search", title: "Look things up", text: "Clients, requests and the schedule, asked in plain words." },
      { icon: "plus", title: "Get things done", text: "Log a request or add a note without opening Crewtavo." },
      { icon: "lock", title: "Your rules", text: "Turn it off any time, or let it look things up only." },
    ],
    access: ["Search clients and see their details", "See requests and the schedule", "Log requests and add notes (unless set to look things up only)", "Search your guides"],
    connectsWith: "Connector link",
    website: "https://claude.ai/",
  },
  chatgpt: {
    developer: "OpenAI",
    tagline: "Use Crewtavo from ChatGPT",
    about:
      "Ask ChatGPT about your clients and schedule, log new requests and add notes from a chat. Each person signs in with their own Crewtavo account, and ChatGPT can only see and do what that person's role allows.",
    highlights: [
      { icon: "search", title: "Look things up", text: "Clients, requests and the schedule, asked in plain words." },
      { icon: "plus", title: "Get things done", text: "Log a request or add a note without opening Crewtavo." },
      { icon: "lock", title: "Your rules", text: "Turn it off any time, or let it look things up only." },
    ],
    access: ["Search clients and see their details", "See requests and the schedule", "Log requests and add notes (unless set to look things up only)", "Search your guides"],
    connectsWith: "Connector link",
    website: "https://chatgpt.com/",
  },
  quickbooks: {
    developer: "Intuit",
    tagline: "Your books, without typing anything twice",
    about:
      "When QuickBooks Online is your book of record, Crewtavo sends clients, invoices and payments there as they happen. Your bookkeeper works in QuickBooks; your team works in Crewtavo.",
    highlights: [
      { icon: "invoice", title: "Invoices", text: "Sent invoices arrive with their lines, discounts and tax." },
      { icon: "dollar", title: "Payments", text: "Each payment is recorded against the right invoice." },
      { icon: "users", title: "Customers", text: "Clients are matched by name, or added." },
    ],
    access: ["Read your company's name", "Add customers, invoices and payments"],
    connectsWith: "Intuit sign-in",
    website: "https://quickbooks.intuit.com/",
  },
  zoho_books: {
    developer: "Zoho",
    tagline: "Your books, without typing anything twice",
    about:
      "When Zoho Books is your book of record, Crewtavo sends clients, invoices and payments there as they happen, in whichever Zoho data center your account lives.",
    highlights: [
      { icon: "invoice", title: "Invoices", text: "Sent invoices arrive with their lines and discounts." },
      { icon: "dollar", title: "Payments", text: "Each payment is recorded against the right invoice." },
      { icon: "users", title: "Contacts", text: "Clients are added as customers." },
    ],
    access: ["Read your organization's name", "Add contacts, invoices and payments"],
    connectsWith: "Zoho sign-in",
    website: "https://www.zoho.com/books/",
  },
  stripe: {
    developer: "Stripe",
    tagline: "Get paid by card or bank",
    about: "Clients pay invoices by card or bank transfer (ACH) from the link you send or their client portal, and the payment is recorded on the invoice by itself.",
    highlights: [
      { icon: "dollar", title: "Card and bank", text: "Clients choose how to pay; you see it on the invoice." },
      { icon: "globe", title: "From anywhere", text: "Pay from the emailed link or the client portal." },
      { icon: "check", title: "Recorded for you", text: "Payments mark invoices paid, with no typing." },
    ],
    access: ["Start payments for invoices", "See when a payment succeeds"],
    connectsWith: "API key",
    website: "https://stripe.com/",
  },
  twilio: {
    developer: "Twilio",
    tagline: "Texts that reach your clients",
    about: "Send visit reminders and on-my-way texts, and keep two-way conversations with clients in Messages.",
    highlights: [
      { icon: "bell", title: "Reminders", text: "The day before, so clients leave the gate open." },
      { icon: "truck", title: "On my way", text: "One tap from the field when a crew heads out." },
      { icon: "messages", title: "Conversations", text: "Replies land in Messages for the whole office." },
    ],
    access: ["Send texts from your number", "Receive replies"],
    connectsWith: "API key",
    website: "https://www.twilio.com/",
  },
};

/** Shown when an app has no entry above (a newer API than this web app). */
export const infoFor = (app: Pick<AppRow, "id" | "name" | "description" | "docs">): AppInfo =>
  APP_INFO[app.id] ?? { developer: app.name, tagline: app.description, about: app.description, highlights: [], access: [], connectsWith: "", website: app.docs };
