import type { Permission } from "@crewtavo/core/roles";
import { can, hasRole, type Session } from "@/lib/session";
import type { IconName } from "../ui/Icon";

export interface NavItem {
  to: string;
  label: string;
  icon: IconName;
  roles?: string[]; // limit to these access levels (owners always see everything)
  perm?: Permission | Permission[]; // and to roles that include this area (all of them, for a list)
  only?: string[]; // only these access levels, owners included (e.g. "My day" for crews)
  also?: string[]; // other screens that count as this section (highlighted in the sidebar)
  keywords?: string; // other words people search for it by
  feature?: "team_chat"; // only while the business has this app on (Apps)
  trade?: string; // only for businesses set up for this trade (companies.trade_preset)
}

/**
 * Kept short on purpose: the everyday work first, then a few tools. Setup screens (automations,
 * online booking, apps) live in Settings, the sales board and map measuring open from Quotes.
 */
export const NAV_GROUPS: NavItem[][] = [
  [
    { to: "/", label: "Home", icon: "home", keywords: "dashboard today overview" },
    { to: "/paving", label: "Paving", icon: "paving", roles: ["admin", "office", "estimator"], perm: "sales", trade: "paving", keywords: "takeoff asphalt sealcoat striping stalls parking lot estimate proposal find paving" },
    { to: "/field", label: "My day", icon: "clock", only: ["crew_lead", "field_crew"], keywords: "today my visits route" },
    { to: "/schedule", label: "Schedule", icon: "calendar", keywords: "calendar visits appointments dispatch route crews tasks" },
    { to: "/chat", label: "Team chat", icon: "chat", feature: "team_chat", keywords: "chat channels messages talk team crew announcements" },
  ],
  [
    { to: "/clients", label: "Clients", icon: "clients", keywords: "customers contacts properties addresses" },
    { to: "/requests", label: "Requests", icon: "requests", keywords: "inquiries leads assessments" },
    { to: "/quotes", label: "Quotes", icon: "quote", roles: ["admin", "office", "estimator"], also: ["/pipeline", "/measure"], keywords: "estimates proposals bids" },
    { to: "/jobs", label: "Jobs", icon: "job", keywords: "work orders projects recurring" },
    { to: "/invoices", label: "Invoices", icon: "invoice", roles: ["admin", "office"], perm: "invoices", also: ["/payouts"], keywords: "billing bills payments" },
  ],
  [
    { to: "/marketing", label: "Marketing", icon: "marketing", roles: ["admin", "office"], perm: "marketing", keywords: "campaigns email blasts reviews referrals" },
    { to: "/finance", label: "Finance", icon: "finance", roles: ["admin", "office"], perm: ["reports", "invoices"], keywords: "reports revenue profit payments money collected net volume fees deposits owed goal" },
    { to: "/metrics", label: "Metrics", icon: "metrics", roles: ["admin", "office"], perm: "reports", keywords: "reports analytics numbers sales conversion lead sources visits hours team clients" },
    { to: "/timesheets", label: "Timesheets", icon: "clock", keywords: "time clock hours payroll" },
    { to: "/equipment", label: "Equipment", icon: "truck", keywords: "trucks mowers trailers tools fleet maintenance" },
    { to: "/kb", label: "Knowledge base", icon: "book", keywords: "sop procedures training how to guides" },
    { to: "/apps", label: "Apps", icon: "apps", roles: ["admin"], perm: "apps", keywords: "integrations connect app store team chat quickbooks zoho books stripe payments google calendar outlook twilio texts sms claude chatgpt ai assistant" },
  ],
];

/** Screens that open from another one rather than the sidebar. Search lists them with the rest. */
export const OTHER_SCREENS: NavItem[] = [
  { to: "/measure", label: "Measure", icon: "area", roles: ["admin", "office", "estimator"], keywords: "measurement map draw area length count square feet acres satellite aerial property" },
  { to: "/pipeline", label: "Sales board", icon: "pipeline", roles: ["admin", "office", "estimator"], keywords: "pipeline leads deals" },
  { to: "/messages", label: "Messages", icon: "messages", keywords: "texts sms email inbox conversations" },
  { to: "/payouts", label: "Stripe deposits", icon: "dollar", roles: ["admin", "office"], perm: "invoices", keywords: "payouts bank stripe fees" },
];

export const SETTINGS_ITEM: NavItem = { to: "/settings", label: "Settings", icon: "settings", also: ["/automations", "/booking"] };

/** Bottom bar on phones; everything else lives under More. */
export const MOBILE_TABS: NavItem[] = [
  { to: "/", label: "Home", icon: "home" },
  { to: "/field", label: "My day", icon: "clock" },
  { to: "/schedule", label: "Schedule", icon: "calendar" },
  { to: "/chat", label: "Chat", icon: "chat", feature: "team_chat" },
  { to: "/clients", label: "Clients", icon: "clients" },
];

/** What people start most often: the sidebar's Create menu, the phone's More sheet and search. */
export function createItems(session: Pick<Session, "role" | "permissions">): Array<{ to: string; label: string; icon: IconName; keywords: string }> {
  const canSell = hasRole(session, "admin", "office", "estimator");
  return [
    ...(canSell
      ? [
          { to: "/clients?new=1", label: "Client", icon: "clients" as const, keywords: "add customer lead" },
          { to: "/requests?new=1", label: "Request", icon: "requests" as const, keywords: "inquiry lead" },
          ...(can(session, "sales") ? [{ to: "/quotes?new=1", label: "Quote", icon: "quote" as const, keywords: "estimate proposal" }] : []),
          { to: "/measure", label: "Measurement", icon: "area" as const, keywords: "measure map draw area" },
        ]
      : []),
    ...(hasRole(session, "admin", "office") && can(session, "invoices") ? [{ to: "/invoices?new=1", label: "Invoice", icon: "invoice" as const, keywords: "bill" }] : []),
    ...(hasRole(session, "admin", "office", "estimator", "crew_lead") && can(session, "schedule") ? [{ to: "/schedule?new=1", label: "Visit or task", icon: "calendar" as const, keywords: "schedule appointment" }] : []),
  ];
}

/** Whether a person sees a navigation item. */
export function navVisible(session: { role: string; permissions: readonly string[]; company?: { settings?: Record<string, unknown> | null; trade_preset?: string } }, item: NavItem): boolean {
  if (item.feature && !featureOn(session.company?.settings, item.feature)) return false;
  if (item.trade && session.company?.trade_preset !== item.trade) return false;
  if (item.only) return item.only.includes(session.role);
  if (session.role === "owner") return true;
  if (item.roles && !item.roles.includes(session.role)) return false;
  return [item.perm ?? []].flat().every((p) => session.permissions.includes(p));
}

/** A built-in app the business turned on in Apps (companies.settings.team_chat.enabled). */
export function featureOn(settings: Record<string, unknown> | null | undefined, feature: NonNullable<NavItem["feature"]>): boolean {
  return (settings?.[feature] as { enabled?: boolean } | undefined)?.enabled === true;
}
