/**
 * Settings, grouped the way people look for things: you, the business, the team, and what it
 * connects to. Automations, online booking and apps have their own screens and open from here.
 */
import { Link, useSearchParams } from "react-router-dom";
import { Icon, type IconName } from "@/components/ui/Icon";
import { PageHeader } from "@/components/ui/PageHeader";
import { can, hasRole, useSession } from "@/lib/session";
import { ChecklistSettings } from "./ChecklistSettings";
import { CompanySettings } from "./CompanySettings";
import { CrewSettings } from "./CrewSettings";
import { EmailSettings } from "./EmailSettings";
import { LicenseSettings } from "./LicenseSettings";
import { MapsSettings } from "./MapsSettings";
import { PriceList } from "./PriceList";
import { ProfileSettings } from "./ProfileSettings";
import { RolesSettings } from "./RolesSettings";
import { TeamSettings } from "./TeamSettings";
import { WebAddressSettings } from "./WebAddressSettings";

type Tab = "profile" | "company" | "address" | "team" | "roles" | "crews" | "prices" | "checklists" | "email" | "maps" | "license";
type Item = { label: string; icon: IconName; hint?: string } & ({ tab: Tab } | { to: string });

export function SettingsPage() {
  const session = useSession();
  const [params, setParams] = useSearchParams();
  const isAdmin = hasRole(session, "admin");
  const isOffice = hasRole(session, "admin", "office");
  const managesTeam = isAdmin && can(session, "team");
  const managesSettings = isOffice && can(session, "settings");
  const canSell = hasRole(session, "admin", "office", "estimator");
  const managesEmail = isAdmin && (can(session, "apps") || can(session, "settings"));

  const groups: Array<{ title: string; items: Item[] }> = [
    { title: "You", items: [{ tab: "profile", label: "Profile", icon: "user" } as Item] },
    {
      title: "Business",
      items: [
        ...(isAdmin ? [{ tab: "company", label: "Company", icon: "home" } as Item] : []),
        ...(isAdmin && session.config.singleCompany ? [{ tab: "address", label: "Web address", icon: "globe" } as Item] : []),
        ...(canSell ? [{ tab: "prices", label: "Price list", icon: "list" } as Item] : []),
        ...(isAdmin ? [{ tab: "maps", label: "Maps", icon: "map" } as Item] : []),
        ...(managesSettings ? [{ to: "/booking", label: "Online booking", icon: "globe" } as Item] : []),
      ],
    },
    {
      title: "Team",
      items: [
        ...(managesTeam ? [{ tab: "team", label: "People", icon: "users" } as Item, { tab: "roles", label: "Roles", icon: "lock" } as Item] : []),
        ...(managesSettings ? [{ tab: "crews", label: "Crews", icon: "clients" } as Item, { tab: "checklists", label: "Checklists", icon: "clipboard" } as Item] : []),
      ],
    },
    {
      title: "Automate and connect",
      items: [
        ...(managesEmail ? [{ tab: "email", label: "Email", icon: "mail" } as Item] : []),
        ...(isOffice && can(session, "automations") ? [{ to: "/automations", label: "Automations", icon: "bolt" } as Item] : []),
        ...(isAdmin && can(session, "apps") ? [{ to: "/apps", label: "Apps", icon: "apps" } as Item] : []),
      ],
    },
    { title: "About", items: [{ tab: "license", label: "License", icon: "file" } as Item] },
  ].filter((g) => g.items.length);

  const tabs = groups.flatMap((g) => g.items).flatMap((i) => ("tab" in i ? [i.tab] : []));
  const requested = params.get("tab") as Tab | null;
  const tab = requested && tabs.includes(requested) ? requested : isAdmin ? "company" : "profile";

  return (
    <>
      <PageHeader title="Settings" />
      <div className="settings-layout">
        <nav className="settings-nav" aria-label="Settings sections">
          {groups.map((g) => (
            <div key={g.title} className="settings-group">
              <span className="settings-group-title">{g.title}</span>
              {g.items.map((item) =>
                "tab" in item ? (
                  <button key={item.tab} type="button" className="nav-link" aria-current={tab === item.tab ? "page" : undefined} onClick={() => setParams({ tab: item.tab }, { replace: true })}>
                    <Icon name={item.icon} />
                    {item.label}
                  </button>
                ) : (
                  <Link key={item.to} to={item.to} className="nav-link">
                    <Icon name={item.icon} />
                    {item.label}
                    <span className="settings-out" aria-hidden="true"><Icon name="chevronRight" size={14} /></span>
                  </Link>
                ),
              )}
            </div>
          ))}
        </nav>
        <div className="settings-body">
          {tab === "profile" && <ProfileSettings />}
          {tab === "company" && <CompanySettings />}
          {tab === "address" && <WebAddressSettings />}
          {tab === "team" && <TeamSettings />}
          {tab === "roles" && <RolesSettings />}
          {tab === "crews" && <CrewSettings />}
          {tab === "prices" && <PriceList />}
          {tab === "checklists" && <ChecklistSettings />}
          {tab === "email" && <EmailSettings />}
          {tab === "maps" && <MapsSettings />}
          {tab === "license" && <LicenseSettings />}
        </div>
      </div>
    </>
  );
}
