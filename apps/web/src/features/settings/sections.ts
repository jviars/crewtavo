/**
 * The sections of Settings each person sees, grouped the way people look for things: you, the
 * business, the team, and what it connects to. Search (the command palette) lists the same ones,
 * with the words people type when they're looking for them.
 */
import type { IconName } from "@/components/ui/Icon";
import { can, hasRole, type Session } from "@/lib/session";

export type SettingsTab = "profile" | "company" | "schedule" | "address" | "team" | "roles" | "crews" | "prices" | "checklists" | "email" | "calendars" | "assistants" | "maps" | "license";
export type SettingsItem = { label: string; icon: IconName; keywords: string } & ({ tab: SettingsTab } | { to: string });

export function settingsGroups(session: Session): Array<{ title: string; items: SettingsItem[] }> {
  const isAdmin = hasRole(session, "admin");
  const isOffice = hasRole(session, "admin", "office");
  const managesTeam = isAdmin && can(session, "team");
  const managesSettings = isOffice && can(session, "settings");
  const canSell = hasRole(session, "admin", "office", "estimator");
  const managesEmail = isAdmin && (can(session, "apps") || can(session, "settings"));
  const connectsApps = isAdmin && can(session, "apps");

  const groups: Array<{ title: string; items: Array<SettingsItem | false | undefined> }> = [
    { title: "You", items: [{ tab: "profile", label: "Profile", icon: "user", keywords: "my account name password phone notifications theme dark mode appearance spare keys recovery calendar feed directions maps app measure map default imagery" }] },
    {
      title: "Business",
      items: [
        isAdmin && { tab: "company", label: "Company", icon: "home", keywords: "business name address phone email website brand color sales tax time zone workday hours quotes valid invoice due" },
        isAdmin && { tab: "schedule", label: "Schedule and routes", icon: "navigation", keywords: "routes route optimize organize order stops lawn mowing drive time driving speed shop automatic time steps 5 minutes 15 minutes precision calendar snap" },
        isAdmin && session.config.singleCompany && { tab: "address", label: "Web address", icon: "globe", keywords: "domain url custom domain cloudflare railway link" },
        canSell && { tab: "prices", label: "Price list", icon: "list", keywords: "services products prices rates costs catalog formulas materials import" },
        isAdmin && { tab: "maps", label: "Maps", icon: "map", keywords: "imagery satellite aerial google esri measure key api cloud default map" },
        managesSettings && { to: "/booking", label: "Online booking", icon: "globe", keywords: "booking form request form website embed intake" },
      ],
    },
    {
      title: "Team",
      items: [
        managesTeam && { tab: "team", label: "People", icon: "users", keywords: "team members staff employees invite users" },
        managesTeam && { tab: "roles", label: "Roles", icon: "lock", keywords: "permissions access levels custom roles" },
        managesSettings && { tab: "crews", label: "Crews", icon: "clients", keywords: "teams groups" },
        managesSettings && { tab: "checklists", label: "Checklists", icon: "clipboard", keywords: "forms inspections job checklist" },
      ],
    },
    {
      title: "Automate and connect",
      items: [
        managesEmail && { tab: "email", label: "Email", icon: "mail", keywords: "smtp outgoing mail sender gmail outlook mailbox" },
        connectsApps && { tab: "calendars", label: "Calendars", icon: "calendar", keywords: "google calendar outlook apple ics calendar file import sync" },
        { tab: "assistants", label: "AI assistants", icon: "sparkle", keywords: "claude chatgpt mcp connector ai assistant access permissions read only full access" },
        isOffice && can(session, "automations") && { to: "/automations", label: "Automations", icon: "bolt", keywords: "rules reminders follow ups workflows" },
      ],
    },
    { title: "About", items: [{ tab: "license", label: "License", icon: "file", keywords: "terms version updates about" }] },
  ];
  return groups.map((g) => ({ title: g.title, items: g.items.filter((i): i is SettingsItem => Boolean(i)) })).filter((g) => g.items.length);
}
