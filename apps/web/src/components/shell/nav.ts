import { isStaff, type Permission } from "@crewtavo/core/roles";
import { can, hasRole, type Session } from "@/lib/session";
import type { IconName } from "../ui/Icon";
import { msg, t } from "@/lib/i18n";

export interface NavItem {
  to: string;
  label: string;
  icon: IconName;
  roles?: string[]; // limit to these access levels (owners always see everything)
  perm?: Permission | Permission[]; // and to roles that include this area (all of them, for a list)
  only?: string[]; // only these access levels, owners included (e.g. "My day" for crews); a sub sees nothing else
  except?: string[]; // screens under this one that are a section of their own (not highlighted here)
  also?: string[]; // other screens that count as this section (highlighted in the sidebar)
  keywords?: string; // other words people search for it by
  feature?: "team_chat" | "website" | "careers" | "drive" | "marketing" | "paving_app" | "roofing_app" | "snow_app"; // only while the business has this app on (Apps)
  foot?: boolean; // kept with Settings at the sidebar's foot, in view however long the list is
  go?: string; // G then this key opens it from anywhere (shown in search beside it)
}

/**
 * Kept short on purpose: the day first, then the everyday work, the trade apps the business turned
 * on, and the tools for running it. Setup screens (automations, online booking) live in Settings,
 * the sales board and map measuring open from Quotes.
 */
export const NAV_GROUPS: NavItem[][] = [
  [
    { to: "/", label: msg("Home"), icon: "home", go: "H", keywords: "dashboard today overview" },
    { to: "/field", label: msg("My day"), icon: "clock", only: ["crew_lead", "field_crew", "subcontractor"], except: ["/field/paperwork", "/field/jobs"], go: "D", keywords: "today my visits route" },
    { to: "/field/jobs", label: msg("My jobs"), icon: "job", only: ["subcontractor"], keywords: "offers accept decline take turn down price owed paid 1099 total" },
    { to: "/field/paperwork", label: msg("My paperwork"), icon: "file", only: ["subcontractor"], keywords: "w-9 w9 insurance certificate liability workers comp upload send" },
    { to: "/schedule", label: msg("Schedule"), icon: "calendar", go: "S", keywords: "calendar visits appointments dispatch route crews tasks" },
    { to: "/chat", label: msg("Team chat"), icon: "chat", feature: "team_chat", go: "T", keywords: "chat channels messages talk team crew announcements" },
  ],
  [
    { to: "/clients", label: msg("Clients"), icon: "clients", go: "C", keywords: "customers contacts properties addresses client hub portal" },
    { to: "/requests", label: msg("Requests"), icon: "requests", go: "R", keywords: "inquiries leads assessments website form messages contact form" },
    { to: "/quotes", label: msg("Quotes"), icon: "quote", roles: ["admin", "office", "estimator"], also: ["/pipeline", "/measure"], go: "Q", keywords: "estimates proposals bids" },
    { to: "/jobs", label: msg("Jobs"), icon: "job", go: "J", keywords: "work orders projects recurring visits job costing" },
    { to: "/invoices", label: msg("Invoices"), icon: "invoice", roles: ["admin", "office"], perm: "invoices", also: ["/payouts"], go: "I", keywords: "billing bills payments batch invoicing collect payments" },
    { to: "/drive", label: msg("Drive"), icon: "folder", roles: ["admin", "office", "estimator"], feature: "drive", keywords: "files documents folders google drive upload pdf word docx trash" },
  ],
  [
    { to: "/paving", label: msg("Paving"), icon: "paving", roles: ["admin", "office", "estimator"], perm: "sales", feature: "paving_app", keywords: "takeoff asphalt sealcoat striping stalls parking lot estimate proposal find paving" },
    { to: "/roofing", label: msg("Roofing"), icon: "roofing", roles: ["admin", "office", "estimator"], perm: "sales", feature: "roofing_app", keywords: "roof estimate squares pitch shingles metal tear-off measure good better best proposal" },
    { to: "/snow", label: msg("Snow"), icon: "snow", roles: ["admin", "office"], perm: "schedule", feature: "snow_app", keywords: "snow plow plowing salt trigger inches storm forecast" },
  ],
  [
    { to: "/marketing", label: msg("Marketing"), icon: "marketing", roles: ["admin", "office"], perm: "marketing", feature: "marketing", keywords: "campaigns email blasts automated campaigns re-engage win back close pending quotes reviews google reviews referrals social facebook instagram posts promo promos codes coupons discounts website visits" },
    { to: "/website", label: msg("Website"), icon: "globe", roles: ["admin", "office"], perm: "marketing", feature: "website", keywords: "site web page blog posts edit content cms sveltia decap" },
    { to: "/finance", label: msg("Finance"), icon: "finance", roles: ["admin", "office"], perm: ["reports", "invoices"], go: "F", keywords: "reports revenue profit payments money collected net volume fees deposits owed goal job costing expenses" },
    { to: "/metrics", label: msg("Metrics"), icon: "metrics", roles: ["admin", "office"], perm: "reports", go: "M", keywords: "reports analytics numbers sales conversion lead sources visits hours team clients" },
    { to: "/timesheets", label: msg("Timesheets"), icon: "clock", keywords: "time clock hours payroll time tracking timesheet" },
    { to: "/applicants", label: msg("Applicants"), icon: "user", roles: ["admin", "office"], perm: "hiring", feature: "careers", keywords: "careers jobs hiring applications apply candidates resumes cv interviews employment" },
    { to: "/subs", label: msg("Subcontractors"), icon: "users", roles: ["admin", "office"], perm: "subs", keywords: "subs contractors 1099 w-9 w9 insurance certificates coi liability workers comp audit paperwork vendors" },
    { to: "/equipment", label: msg("Equipment"), icon: "truck", go: "E", keywords: "trucks mowers trailers tools fleet maintenance" },
    { to: "/kb", label: msg("Knowledge base"), icon: "book", go: "K", keywords: "sop procedures training how to guides" },
    { to: "/apps", label: msg("Apps"), icon: "apps", roles: ["admin"], perm: "apps", foot: true, go: "A", keywords: "integrations connect app store team chat website forms formspree contact form careers job applications hiring drive files documents google drive marketing reviews referrals campaigns google reviews google business profile facebook instagram social posts quickbooks zoho books stripe payments google calendar outlook twilio texts sms claude chatgpt ai assistant sveltia cms website" },
  ],
];

/** The name over each of NAV_GROUPS in the sidebar. The first, the day, needs none. */
export const NAV_GROUP_LABELS: Array<string | null> = [null, msg("Work"), msg("Trades"), msg("Business")];

/** Screens that open from another one rather than the sidebar. Search lists them with the rest. */
export const OTHER_SCREENS: NavItem[] = [
  { to: "/measure", label: msg("Measure"), icon: "area", roles: ["admin", "office", "estimator"], keywords: "measurement map draw area length count square feet acres satellite aerial property" },
  { to: "/pipeline", label: msg("Sales board"), icon: "pipeline", roles: ["admin", "office", "estimator"], keywords: "pipeline leads deals" },
  { to: "/messages", label: msg("Messages"), icon: "messages", keywords: "texts sms email inbox conversations" },
  { to: "/payouts", label: msg("Stripe deposits"), icon: "dollar", roles: ["admin", "office"], perm: "invoices", keywords: "payouts bank stripe fees" },
  // Marketing's own tabs, so searching for one opens it rather than Campaigns.
  { to: "/marketing?tab=reviews", label: msg("Reviews"), icon: "star", roles: ["admin", "office"], perm: "marketing", feature: "marketing", keywords: "marketing google reviews review requests ask for a review reminders ratings replies" },
  { to: "/marketing?tab=referrals", label: msg("Referrals"), icon: "gift", roles: ["admin", "office"], perm: "marketing", feature: "marketing", keywords: "marketing referral credits refer a friend rewards" },
  { to: "/marketing?tab=social", label: msg("Social posts"), icon: "share", roles: ["admin", "office"], perm: "marketing", feature: "marketing", keywords: "marketing social facebook instagram google posts photos share" },
  { to: "/marketing?tab=promos", label: msg("Promo codes"), icon: "tag", roles: ["admin", "office"], perm: "marketing", feature: "marketing", keywords: "marketing promo promos codes coupons discounts" },
  // Every file deleted in Crewtavo waits here, for the whole team, whether or not Drive is installed.
  { to: "/drive/trash", label: msg("Trash"), icon: "trash", keywords: "deleted files removed photos restore undo undelete recycle bin get back" },
  { to: "/clients/duplicates", label: msg("Possible duplicates"), icon: "users", roles: ["admin", "office"], perm: "invoices", keywords: "duplicate clients merge combine same email phone address" },
  { to: "/subs/1099", label: msg("Year-end totals"), icon: "dollar", roles: ["admin", "office"], perm: "subs", keywords: "1099 nec subcontractors subs paid this year tax report" },
  { to: "/subs/workers-comp", label: msg("Workers' comp audit"), icon: "clipboard", roles: ["admin", "office"], perm: "subs", keywords: "workers comp compensation audit subcontractors subs insurance report csv" },
  { to: "/roofing/catalog", label: msg("Roofing catalog"), icon: "truck", roles: ["admin", "office", "estimator"], perm: "sales", feature: "roofing_app", keywords: "abc supply materials catalog shingles products prices branch" },
  { to: "/chat/settings", label: msg("Chat settings"), icon: "chat", roles: ["admin"], feature: "team_chat", keywords: "team chat channels roles who can see post manage" },
];

export const SETTINGS_ITEM: NavItem = { to: "/settings", label: msg("Settings"), icon: "settings", also: ["/automations", "/booking"] };
/** A sub's settings are their profile and notifications. */
export const PROFILE_ITEM: NavItem = { to: "/settings?tab=profile", label: msg("Profile"), icon: "user", only: ["subcontractor"] };

/** The sidebar's last link: Settings, or a sub's profile. */
export const settingsItem = (session: { role: string }) => (session.role === "subcontractor" ? PROFILE_ITEM : SETTINGS_ITEM);

/**
 * The phone's bottom bar for the team: the day's four, then More for everything else (Clients is the
 * first thing under Work there). Five tabs in all, as a phone's thumb reaches them.
 */
export const MOBILE_TABS: NavItem[] = [
  { to: "/", label: msg("Home"), icon: "home" },
  { to: "/field", label: msg("My day"), icon: "clock" },
  { to: "/schedule", label: msg("Schedule"), icon: "calendar" },
  { to: "/chat", label: msg("Chat"), icon: "chat", feature: "team_chat" },
];
/** In Chat's place while the business has team chat off, so the bar still has five tabs. */
export const CHAT_OFF_TAB: NavItem = { to: "/clients", label: msg("Clients"), icon: "clients" };
/** A sub's bottom bar: all they have, so there's no More. */
export const SUB_TABS: NavItem[] = [
  { to: "/field", label: msg("My day"), icon: "clock", only: ["subcontractor"], except: ["/field/paperwork", "/field/jobs"] },
  { to: "/field/jobs", label: msg("My jobs"), icon: "job", only: ["subcontractor"] },
  { to: "/field/paperwork", label: msg("Paperwork"), icon: "file", only: ["subcontractor"] },
  { to: "/settings?tab=profile", label: msg("Profile"), icon: "user", only: ["subcontractor"] },
];

/** The phone's bottom bar for this person (the team's More button comes after these). */
export function mobileTabs(session: { role: string; company?: { settings?: Record<string, unknown> | null } }): NavItem[] {
  if (session.role === "subcontractor") return SUB_TABS;
  return MOBILE_TABS.map((item) => (!item.feature || featureOn(session.company?.settings, item.feature) ? item : CHAT_OFF_TAB));
}

/**
 * The screens a sub can open: My day and their visits, My jobs and an offer in it, My paperwork, and
 * Settings (which shows them only their profile). Anything else opened by its address goes to My day.
 */
export const subCanOpen = (pathname: string) => /^\/field(\/paperwork|\/jobs(\/[^/]+)?|\/visits\/[^/]+)?\/?$/.test(pathname) || /^\/settings\/?$/.test(pathname);

/**
 * What people start most often: the sidebar's Create menu, the phone's More sheet and search. The
 * work's records first, in the order of the stages on Home (request, quote, job, invoice), then the
 * tools (`tool`), which the Create menu puts below a line.
 */
export function createItems(session: Pick<Session, "role" | "permissions">): Array<{ to: string; label: string; newLabel: string; icon: IconName; keywords: string; key: string; tool?: boolean }> {
  if (!isStaff(session.role)) return [];
  const canSell = hasRole(session, "admin", "office", "estimator");
  // newLabel whole, not "New " + the label: Spanish says "Nuevo cliente" but "Nueva cotización".
  // key: picks it in the Create menu, and after N from anywhere (shortcutTarget).
  return [
    ...(canSell
      ? [
          { to: "/clients?new=1", label: msg("Client"), newLabel: t("New client"), icon: "clients" as const, keywords: "add customer lead", key: "C" },
          { to: "/requests?new=1", label: msg("Request"), newLabel: t("New request"), icon: "requests" as const, keywords: "inquiry lead", key: "R" },
        ]
      : []),
    // The Jobs page lets the same people start a job as a quote.
    ...(canSell && can(session, "sales")
      ? [
          { to: "/quotes?new=1", label: msg("Quote"), newLabel: t("New quote"), icon: "quote" as const, keywords: "estimate proposal", key: "Q" },
          { to: "/jobs?new=1", label: msg("Job"), newLabel: t("New job"), icon: "job" as const, keywords: "work order project", key: "J" },
        ]
      : []),
    ...(hasRole(session, "admin", "office") && can(session, "invoices") ? [{ to: "/invoices?new=1", label: msg("Invoice"), newLabel: t("New invoice"), icon: "invoice" as const, keywords: "bill", key: "I" }] : []),
    ...(canSell ? [{ to: "/measure", label: msg("Measurement"), newLabel: t("New measurement"), icon: "area" as const, keywords: "measure map draw area", key: "M", tool: true }] : []),
    // A crew lead always schedules their own crew; "Schedule the whole team" opens the rest.
    ...(hasRole(session, "admin", "office", "estimator", "crew_lead") && (session.role === "crew_lead" || can(session, "schedule")) ? [{ to: "/schedule?new=1", label: msg("Visit or task"), newLabel: t("New visit or task"), icon: "calendar" as const, keywords: "schedule appointment", key: "V", tool: true }] : []),
  ];
}

/**
 * Two-key shortcuts from anywhere outside a field: G then a screen's key goes there (G S, Schedule),
 * N then a Create item's key starts it (N R, a new request). Search shows each beside its row. Only
 * what this person can open; null for anything else.
 */
export function shortcutTarget(session: Pick<Session, "role" | "permissions"> & { company?: { settings?: Record<string, unknown> | null } }, prefix: string, key: string): string | null {
  const k = key.toUpperCase();
  if (prefix.toLowerCase() === "g") return NAV_GROUPS.flat().find((item) => item.go === k && navVisible(session, item))?.to ?? null;
  if (prefix.toLowerCase() === "n") return createItems(session).find((item) => item.key === k)?.to ?? null;
  return null;
}

/** The sidebar groups this person folded, by their English names; remembered on this device. */
const foldKey = (userId: string) => `crewtavo.nav-folded.${userId}`;
export function foldedGroups(userId: string): string[] {
  try {
    const saved = JSON.parse(localStorage.getItem(foldKey(userId)) ?? "[]") as unknown;
    return Array.isArray(saved) ? saved.filter((g): g is string => typeof g === "string") : [];
  } catch {
    return [];
  }
}
export function saveFoldedGroups(userId: string, folded: string[]) {
  try {
    localStorage.setItem(foldKey(userId), JSON.stringify(folded));
  } catch {
    // Private mode: it just won't be remembered.
  }
}

/** Whether a person sees a navigation item. */
export function navVisible(session: { role: string; permissions: readonly string[]; company?: { settings?: Record<string, unknown> | null } }, item: NavItem): boolean {
  // A sub sees only what's listed for them by name: everything else is the team's.
  if (session.role === "subcontractor") return Boolean(item.only?.includes("subcontractor"));
  if (item.feature && !featureOn(session.company?.settings, item.feature)) return false;
  if (item.only) return item.only.includes(session.role);
  if (session.role === "owner") return true;
  if (item.roles && !item.roles.includes(session.role)) return false;
  return [item.perm ?? []].flat().every((p) => session.permissions.includes(p));
}

/**
 * An app the business turned on in Apps: companies.settings.team_chat.enabled, .careers.enabled,
 * .drive.enabled, .marketing.enabled, .paving_app.enabled, .roofing_app.enabled, .snow_app.enabled (not .roofing, which
 * holds the price ranges), or .website.enabled once its editor is added.
 */
export function featureOn(settings: Record<string, unknown> | null | undefined, feature: NonNullable<NavItem["feature"]>): boolean {
  return (settings?.[feature] as { enabled?: boolean } | undefined)?.enabled === true;
}
