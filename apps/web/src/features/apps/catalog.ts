/**
 * What the Apps pages show about each app. How an app connects, and whether this deployment can
 * offer it, comes from the API (apps/api/src/integrations/registry.ts); the words and pictures
 * people read live here.
 */
import type { WebsiteSite } from "@crewtavo/core/website";
import { useQuery } from "@tanstack/react-query";
import type { IconName } from "@/components/ui/Icon";
import { api } from "@/lib/api";
import { can, hasRole, useSession } from "@/lib/session";

export interface AppRow {
  id: string;
  name: string;
  category: "Team" | "Calendar" | "AI" | "Accounting" | "Payments" | "Pricing" | "Messaging" | "Website";
  description: string;
  /** builtin: part of Crewtavo, turned on or off here (team chat). site: the website's editor, by its address (Sveltia CMS). */
  auth: "oauth" | "api_key" | "link" | "connector" | "builtin" | "site";
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
  /** Stripe only, once it's set up: the company's own key or the server's, and the last import. */
  stripe?: { own: boolean; webhook: boolean; livemode: boolean; import: StripeImport | null };
  /** QuickBooks and Zoho Books: the company can sign in with its own app there (AppKeysCard). */
  takes_app_keys?: boolean;
  /** That app's keys, once saved (never the secret). */
  app_keys?: { client_id: string; sandbox: boolean; accounts_server: string | null } | null;
  /** Sveltia CMS: the website's editor, once its address is added. */
  website?: WebsiteSite | null;
  /** ABC Supply, once it's connected: the account and branch prices come from, and the others to pick. */
  supplier?: SupplierSettings | null;
}

export interface SupplierSettings {
  environment: "production" | "sandbox";
  ship_to: string;
  ship_to_name: string;
  branch: string;
  branch_name: string;
  accounts: Array<{ number: string; name: string; city: string | null; state: string | null; branches: Array<{ number: string; name: string; home: boolean }> }>;
}

export interface StripeImport {
  status: "running" | "done" | "failed";
  since: string | null;
  started_at: string;
  finished_at?: string;
  error?: string;
  counts: { invoices: number; payments: number; clients: number; payouts: number };
}

/** An import that hasn't reported in this long died with its server (IMPORT_STALE_MS on the API). */
export const importRunning = (state: StripeImport | null | undefined) => state?.status === "running" && Date.now() - Date.parse(state.started_at) < 30 * 60_000;

export interface AppsData {
  mcp_url: string;
  apps: AppRow[];
}

/** The Apps list, for owners and admins who can connect apps. */
export function useApps() {
  const session = useSession();
  const allowed = hasRole(session, "admin") && can(session, "apps");
  const query = useQuery({
    queryKey: ["apps", session.company.id],
    enabled: allowed,
    queryFn: () => api.get<AppsData>("/apps"),
    // Follow a Stripe import while it runs.
    refetchInterval: (q) => (q.state.data?.apps.some((a) => importRunning(a.stripe?.import)) ? 3000 : false),
  });
  return { allowed, ...query };
}

export const CATEGORY_LABELS: Record<AppRow["category"], string> = {
  Team: "Built into Crewtavo",
  Calendar: "Calendars",
  AI: "AI",
  Accounting: "Accounting",
  Payments: "Payments",
  Pricing: "Material prices",
  Messaging: "Messaging",
  Website: "Your website",
};

/** An app's category on its own page: the built-in ones are simply Crewtavo's. */
export const categoryName = (category: AppRow["category"]) => (category === "Team" ? "Crewtavo" : (CATEGORY_LABELS[category] ?? category));

/** The row of related apps at the bottom of an app's page. */
export const MORE_LABELS: Record<AppRow["category"], string> = {
  Team: "More built-in apps",
  Calendar: "More calendars",
  AI: "More AI apps",
  Accounting: "More accounting apps",
  Payments: "More payment apps",
  Pricing: "More material prices",
  Messaging: "More messaging apps",
  Website: "More website apps",
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
  /** Where Open goes once it's installed, when not the website: a page in Crewtavo, or the app itself. */
  open?: string;
}

const CALENDAR_HIGHLIGHTS: AppInfo["highlights"] = [
  { icon: "calendar", title: "Next to your visits", text: "Events show on the schedule in the calendar's color, by day, week and month." },
  { icon: "clock", title: "Find a time knows", text: "Busy time counts when Crewtavo suggests open slots, so nobody gets double-booked." },
  { icon: "refresh", title: "Always current", text: "Read again every 15 minutes, with repeats, moved meetings and cancellations." },
];

export const LINK_ACCESS = ["Read the events on the calendars you add", "Nothing else: it can't change the calendar"];

export const APP_INFO: Record<string, AppInfo> = {
  team_chat: {
    developer: "Crewtavo",
    tagline: "Channels for the whole team, each crew and the office",
    about:
      "Talk to your team where the work already is. Post news everyone reads in Announcements, keep each crew's day in its own channel, and keep quotes and billing in the office's. Who sees each channel goes by role, the same roles as Settings → Roles, so field crew only see what's theirs. Share photos from the job, link a job so everyone opens the same one, and @mention a person or a whole role to get their attention, with a push to their phone.",
    highlights: [
      { icon: "hash", title: "Channels by role", text: "Announcements, the whole team, each crew and the office. You decide who sees and posts in each." },
      { icon: "mention", title: "@mentions", text: "Mention someone or a whole role, like @Field crew. They get a push on their phone." },
      { icon: "camera", title: "Photos and jobs", text: "Send photos from the job site and link a job so everyone opens the same one." },
    ],
    access: ["Show chat to the people on your team, by their role", "Keep messages and photos in your own Crewtavo, like everything else", "Turning it off hides chat and keeps every message"],
    connectsWith: "Crewtavo",
    website: "https://crewtavo.com/docs/connections/team-chat/",
    open: "/chat",
  },
  website_analytics: {
    developer: "Crewtavo",
    tagline: "Who visits your website, and what brings in work",
    about:
      "Paste one line into your website and see how many people visit it, which pages they read, where they came from (Google, Facebook, Yelp, an email or a campaign) and whether they were on a phone or a computer, in Marketing. Booking requests from your website's form say which page and source brought them in, so you can tell what's worth your time and money. It works like Google Analytics without the cookies: nothing that tells who a visitor is gets kept, so most businesses don't need a cookie banner for it, and it's all in your own Crewtavo.",
    highlights: [
      { icon: "metrics", title: "Visits and pages", text: "Visitors and page views against the period before, and the pages people read most." },
      { icon: "globe", title: "Where they came from", text: "Search, social, directories like Yelp, AI assistants, emails and your own campaign links." },
      { icon: "requests", title: "What brings in work", text: "Booking requests from your website show the page and source behind each one." },
    ],
    access: [
      "Count page views on your website, with the page, where the visitor came from and their kind of device",
      "No cookies, and nothing kept that tells who a visitor is: a visitor is a code that changes every day",
      "Skip people who asked websites not to track them",
      "Uninstalling stops counting and keeps your numbers",
    ],
    connectsWith: "A line on your website",
    website: "https://crewtavo.com/docs/connections/website-analytics/",
    open: "/marketing?tab=website",
  },
  google_calendar: {
    developer: "Google",
    tagline: "Your Google calendars on the schedule, and visits on Google",
    about:
      "See appointments from your Google calendars next to your crews' visits, so nobody books over a supplier meeting or a day off. Crewtavo can also put every visit on a Google calendar it makes for you and keep it up to date as the schedule changes, so anyone you share it with sees the day on their phone.",
    highlights: [
      { icon: "calendar", title: "Pick your calendars", text: "Choose which calendars show on the schedule. Each one can belong to a crew." },
      { icon: "clock", title: "Find a time knows", text: "Busy time on those calendars counts when Crewtavo suggests an open slot." },
      { icon: "calendarCheck", title: "Visits on Google", text: "New, moved and finished visits show up in Google Calendar too, so the day is on everyone's phone." },
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
    open: "/schedule",
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
    open: "/schedule",
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
    open: "/schedule",
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
    open: "/schedule",
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
    open: "/schedule",
  },
  anthropic: {
    developer: "Anthropic",
    tagline: "Use Crewtavo from Claude",
    about:
      "Ask Claude about your clients and schedule, log requests and notes, or have it set up your price list, crews, checklists, booking forms, guides and automations, right from a chat. Each person signs in with their own Crewtavo account, and Claude can only see and do what that person's role allows. Add your own Anthropic key to power Crewtavo's writing help and answers from your guides.",
    highlights: [
      { icon: "search", title: "Look things up", text: "Clients, requests and the schedule, asked in plain words." },
      { icon: "plus", title: "Get things done", text: "Log a request, add a note, or set up your price list and booking forms without opening Crewtavo." },
      { icon: "lock", title: "Your rules", text: "It only looks things up until you choose what it can change. Turn it off any time." },
    ],
    access: ["Search clients and see their details", "See requests, the schedule, your guides and your setup", "Log requests and add notes, once you allow it", "Change company details, the price list, crews, checklists, booking forms, guides and automations, once you allow it", "Delete things, only with full access"],
    connectsWith: "Connector link",
    website: "https://claude.ai/",
  },
  fal: {
    developer: "fal",
    tagline: "Find all the paving in view at once",
    about:
      "With fal.ai, Find paving outlines all the asphalt and concrete on the aerial at once, cuts the islands and buildings out of the lot, and counts the striped stalls, so a takeoff starts drawn and you check it instead of tracing it. It runs Meta's Segment Anything model (SAM 3) on fal.ai, with your own fal.ai account: about half a cent for each thing it looks for, billed by fal. Only the aerial picture of the lot you're measuring goes to fal.ai. Without it, Find paving's free Tap to outline still outlines one surface per tap, right in the browser.",
    highlights: [
      { icon: "sparkle", title: "Outlined for you", text: "Asphalt and concrete come back as shapes on the map, each marked as its takeoff item and ready to edit." },
      { icon: "scissors", title: "Islands cut out", text: "Planted islands and buildings in the lot come out of the asphalt, so sealcoat isn't priced on grass." },
      { icon: "pin", title: "Stalls counted", text: "Striped stalls are counted where the imagery is sharp enough to see the lines." },
    ],
    access: ["Send fal.ai the aerial picture of the lot when someone uses Find paving's Find everything in view", "Nothing else: no clients, prices or anything else from Crewtavo", "fal.ai bills your account directly, about half a cent per thing found"],
    connectsWith: "Key from fal.ai",
    website: "https://fal.ai/",
    open: "/measure",
  },
  chatgpt: {
    developer: "OpenAI",
    tagline: "Use Crewtavo from ChatGPT",
    about:
      "Ask ChatGPT about your clients and schedule, log requests and notes, or have it set up your price list, crews, checklists, booking forms, guides and automations, from a chat. Each person signs in with their own Crewtavo account, and ChatGPT can only see and do what that person's role allows.",
    highlights: [
      { icon: "search", title: "Look things up", text: "Clients, requests and the schedule, asked in plain words." },
      { icon: "plus", title: "Get things done", text: "Log a request, add a note, or set up your price list and booking forms without opening Crewtavo." },
      { icon: "lock", title: "Your rules", text: "It only looks things up until you choose what it can change. Turn it off any time." },
    ],
    access: ["Search clients and see their details", "See requests, the schedule, your guides and your setup", "Log requests and add notes, once you allow it", "Change company details, the price list, crews, checklists, booking forms, guides and automations, once you allow it", "Delete things, only with full access"],
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
    open: "https://qbo.intuit.com/",
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
    open: "https://books.zoho.com/",
  },
  stripe: {
    developer: "Stripe",
    tagline: "Invoices, payments and deposits, in step with Stripe",
    about:
      "Invoices you send from Crewtavo go to Stripe too, and clients pay them by card or bank from their link or client portal, once. Invoices you make in Stripe, like a big job you'd rather bill by hand, come into Crewtavo by themselves. Every payment shows the fee Stripe kept and the bank deposit it arrived in, and your past invoices can come in from Stripe without anyone being emailed.",
    highlights: [
      { icon: "invoice", title: "Both ways", text: "Sent invoices appear in Stripe; invoices made in Stripe come in here." },
      { icon: "dollar", title: "Paid once", text: "Card or bank. A bank payment shows as on its way until it clears." },
      { icon: "receipt", title: "Fees and deposits", text: "See what Stripe kept and which deposit each payment arrived in." },
    ],
    access: [
      "Add customers, invoices and invoice items, and void invoices it made",
      "Read invoices, payments, refunds, disputes and deposits",
      "Add one webhook to your account so payments show up right away",
    ],
    connectsWith: "Key from Stripe",
    website: "https://stripe.com/",
    open: "https://dashboard.stripe.com/",
  },
  abc_supply: {
    developer: "ABC Supply",
    tagline: "Your own material prices in every roofing estimate",
    about:
      "Connect your ABC Supply account and your estimates price their materials at your branch, at your prices: the shingles, underlayment, drip edge and everything else, in whole bundles, rolls and pieces. Pick each material from ABC's catalog once and say how many go into a square or a foot; after that every roof you measure comes out with exactly what to order and what it costs, next to the labor and your margin. Connecting also adds a Catalog to Roofing: ABC's items at your branch with your price on each, what your account buys most up front, every color and size with its specs, and your materials checked with ABC in one tap, so one ABC stops carrying is swapped out everywhere it's used. It uses an app you make in ABC's developer portal for your own company, so your prices stay between you and ABC.",
    highlights: [
      { icon: "search", title: "A catalog in Roofing", text: "Browse ABC's items at your branch with your price on each: what you buy most, every color and size, and its specs." },
      { icon: "roofing", title: "Priced from the roof", text: "Squares and edges from the measurement become bundles, rolls and pieces, rounded up, at today's prices." },
      { icon: "dollar", title: "Costs you can see", text: "Each material, what it comes to, and the materials total sit next to the labor and the margin." },
    ],
    access: [
      "Read your ABC account and branch, and ABC's catalog",
      "Ask ABC for your prices on the materials your estimates use",
      "Nothing else: it can't place orders or see your invoices",
      "Prices are kept with your price list and estimates, never shown next to another supplier's",
    ],
    connectsWith: "Keys from ABC Supply",
    website: "https://www.abcsupply.com/",
    open: "/roofing/catalog",
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
    open: "/messages",
  },
  sveltia: {
    developer: "Sveltia",
    tagline: "Edit your website without leaving Crewtavo",
    about:
      "Sveltia CMS is the editor many fast, modern websites come with: pages, blog posts, services and photos, with a preview as you type. Add your website's address once and Website appears in the menu with your editor right there, next to your clients and schedule. Sign in the way you do on your site, with GitHub or a token, and changes save to your website exactly as they do when you open it on its own. Decap CMS (once called Netlify CMS) works too.",
    highlights: [
      { icon: "globe", title: "Your site, in Crewtavo", text: "Website in the menu opens your site's editor, for owners, admins and anyone with Marketing." },
      { icon: "edit", title: "Pages, posts and photos", text: "Write a post, change a price or swap a photo, and see it as visitors will before it goes live." },
      { icon: "lock", title: "Your own sign-in", text: "Sign in with GitHub, as you do on your site. Crewtavo never sees it." },
    ],
    access: [
      "Show your website's editor (its /admin page) inside Crewtavo",
      "Read that page and its settings, to check the editor is there and where it saves",
      "Nothing else: it can't see your sign-in or change your website. Sveltia saves your edits, as it does on your site",
    ],
    connectsWith: "Your website's address",
    website: "https://sveltiacms.app/",
    open: "/website",
  },
};

/** Shown when an app has no entry above (a newer API than this web app). */
export const infoFor = (app: Pick<AppRow, "id" | "name" | "description" | "docs">): AppInfo =>
  APP_INFO[app.id] ?? { developer: app.name, tagline: app.description, about: app.description, highlights: [], access: [], connectsWith: "", website: app.docs };
