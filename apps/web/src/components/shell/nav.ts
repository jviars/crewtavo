import type { Permission } from "@crewtavo/core/roles";
import type { IconName } from "../ui/Icon";

export interface NavItem {
  to: string;
  label: string;
  icon: IconName;
  roles?: string[]; // limit to these access levels (owners always see everything)
  perm?: Permission; // and to roles that include this area
  only?: string[]; // only these access levels, owners included (e.g. "My day" for crews)
  also?: string[]; // other screens that count as this section (highlighted in the sidebar)
}

/**
 * Kept short on purpose: the everyday work first, then a few tools. Setup screens (automations,
 * online booking, apps) live in Settings, the sales board and map measuring open from Quotes.
 */
export const NAV_GROUPS: NavItem[][] = [
  [
    { to: "/", label: "Home", icon: "home" },
    { to: "/field", label: "My day", icon: "clock", only: ["crew_lead", "field_crew"] },
    { to: "/schedule", label: "Schedule", icon: "calendar" },
  ],
  [
    { to: "/clients", label: "Clients", icon: "clients" },
    { to: "/requests", label: "Requests", icon: "requests" },
    { to: "/quotes", label: "Quotes", icon: "quote", roles: ["admin", "office", "estimator"], also: ["/pipeline", "/measure"] },
    { to: "/jobs", label: "Jobs", icon: "job" },
    { to: "/invoices", label: "Invoices", icon: "invoice", roles: ["admin", "office"], perm: "invoices" },
  ],
  [
    { to: "/marketing", label: "Marketing", icon: "marketing", roles: ["admin", "office"], perm: "marketing" },
    { to: "/reports", label: "Reports", icon: "reports", roles: ["admin", "office"], perm: "reports" },
    { to: "/timesheets", label: "Timesheets", icon: "clock" },
    { to: "/equipment", label: "Equipment", icon: "truck" },
    { to: "/kb", label: "Knowledge base", icon: "book" },
  ],
];

export const SETTINGS_ITEM: NavItem = { to: "/settings", label: "Settings", icon: "settings", also: ["/automations", "/booking", "/apps"] };

/** Bottom bar on phones; everything else lives under More. */
export const MOBILE_TABS: NavItem[] = [
  { to: "/", label: "Home", icon: "home" },
  { to: "/field", label: "My day", icon: "clock" },
  { to: "/schedule", label: "Schedule", icon: "calendar" },
  { to: "/clients", label: "Clients", icon: "clients" },
];

/** Whether a person sees a navigation item. */
export function navVisible(session: { role: string; permissions: readonly string[] }, item: NavItem): boolean {
  if (item.only) return item.only.includes(session.role);
  if (session.role === "owner") return true;
  if (item.roles && !item.roles.includes(session.role)) return false;
  return !item.perm || session.permissions.includes(item.perm);
}
