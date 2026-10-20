/**
 * Settings, grouped the way people look for things (sections.ts): you, the business, the team, and
 * what it connects to. Automations, online booking and apps have their own screens and open from here.
 */
import { Link, useSearchParams } from "react-router-dom";
import { Icon } from "@/components/ui/Icon";
import { PageHeader } from "@/components/ui/PageHeader";
import { hasRole, useSession } from "@/lib/session";
import { AssistantSettings } from "./AssistantSettings";
import { CalendarSettings } from "./CalendarSettings";
import { ChecklistSettings } from "./ChecklistSettings";
import { CompanySettings } from "./CompanySettings";
import { CrewSettings } from "./CrewSettings";
import { EmailSettings } from "./EmailSettings";
import { LicenseSettings } from "./LicenseSettings";
import { MapsSettings } from "./MapsSettings";
import { PriceList } from "./PriceList";
import { ProfileSettings } from "./ProfileSettings";
import { RolesSettings } from "./RolesSettings";
import { ScheduleSettings } from "./ScheduleSettings";
import { settingsGroups, type SettingsTab } from "./sections";
import { TeamSettings } from "./TeamSettings";
import { WebAddressSettings } from "./WebAddressSettings";

export function SettingsPage() {
  const session = useSession();
  const [params, setParams] = useSearchParams();
  const isAdmin = hasRole(session, "admin");
  const groups = settingsGroups(session);

  const tabs = groups.flatMap((g) => g.items).flatMap((i) => ("tab" in i ? [i.tab] : []));
  const requested = params.get("tab") as SettingsTab | null;
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
          {tab === "schedule" && <ScheduleSettings />}
          {tab === "address" && <WebAddressSettings />}
          {tab === "team" && <TeamSettings />}
          {tab === "roles" && <RolesSettings />}
          {tab === "crews" && <CrewSettings />}
          {tab === "prices" && <PriceList />}
          {tab === "checklists" && <ChecklistSettings />}
          {tab === "email" && <EmailSettings />}
          {tab === "calendars" && <CalendarSettings />}
          {tab === "assistants" && <AssistantSettings />}
          {tab === "maps" && <MapsSettings />}
          {tab === "license" && <LicenseSettings />}
        </div>
      </div>
    </>
  );
}
