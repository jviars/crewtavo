/**
 * Settings, grouped the way people look for things (sections.ts): you, the business, quotes and
 * invoices, scheduling, talking to clients, the team, what it connects to, and about. Automations, online booking and apps
 * have their own screens and open from here.
 *
 * Desktop (Page-Settings.dc.html): a quiet list of the sections on the left, the chosen one on the
 * right under its title and a line on what it's for, its parts as hairline groups (SettingsKit.tsx).
 * Phone (Mobile-Business.dc.html, Settings): a grouped list with your profile at the top and a search,
 * each section a screen of its own with a back button to the list.
 */
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Face } from "@/components/ui/Avatar";
import { Icon } from "@/components/ui/Icon";
import { Crumb, PageHeader, useDocumentTitle } from "@/components/ui/PageHeader";
import { SearchField } from "@/components/ui/Toolbar";
import { api } from "@/lib/api";
import { msg, t } from "@/lib/i18n";
import { hasRole, isSub, useSession, type Session } from "@/lib/session";
import { AssistantSettings } from "./AssistantSettings";
import { CalendarSettings } from "./CalendarSettings";
import { ChecklistSettings } from "./ChecklistSettings";
import { ClientNotificationSettings } from "./ClientNotificationSettings";
import { CompanySettings } from "./CompanySettings";
import { ContractSettings } from "./ContractSettings";
import { CrewSettings } from "./CrewSettings";
import { CustomFieldSettings } from "./CustomFieldSettings";
import { DataSettings } from "./DataSettings";
import { EmailSettings } from "./EmailSettings";
import { HostingSettings } from "./HostingSettings";
import { LicenseSettings } from "./LicenseSettings";
import { MapsSettings } from "./MapsSettings";
import { PaymentSettings } from "./PaymentSettings";
import { PriceList } from "./PriceList";
import { ProfileSettings } from "./ProfileSettings";
import { RolesSettings } from "./RolesSettings";
import { SalesAreaSettings } from "./SalesAreaSettings";
import { ScheduleSettings } from "./ScheduleSettings";
import { settingsGroups, type SettingsItem, type SettingsTab } from "./sections";
import { SettingsActionsSlot, usePhoneLayout } from "./SettingsKit";
import { StorageSettings } from "./StorageSettings";
import { TeamSettings } from "./TeamSettings";
import { TemplateSettings } from "./TemplateSettings";
import { WebAddressSettings } from "./WebAddressSettings";
import { WeatherSettings } from "./WeatherSettings";

/** One line under a section's title: what it's for. Sections with their own words at the top have none. */
const LEDES: Partial<Record<SettingsTab, string>> = {
  profile: msg("Your name, photo and password, and how Crewtavo looks and reaches you."),
  company: msg("Your business details, shown on quotes, invoices and the Client Hub."),
  schedule: msg("How the schedule snaps, and how each crew's stops are put in order."),
  templates: msg("How your estimates, proposals and invoices look. Change anything below and the page follows."),
  contracts: msg("Your contract's wording, a section at a time: payment, changes to the work, your warranty, the right to cancel. Each one prints above the signatures or on the terms pages after the estimate."),
  email: msg("Quotes, invoices, reminders, team invites and notifications go out from your business address, so clients see your name and replies land in your inbox."),
  weather: msg("The work that needs good weather, and how good. Visits in the next few days for jobs with that work get a weather warning on the schedule, on Home and on the crew's visit. Nothing is moved by itself."),
  "custom-fields": msg("Your own fields, like a gate code, a permit number or a unit's model. They're filled in where each record is edited, and show on it once they have a value. Crews see a visit's job and property fields."),
  maps: msg("The imagery Measure draws on, and where address suggestions come from."),
  data: msg("Bring work over from Jobber, download everything you keep here, and the nightly backups."),
  "client-notifications": msg("What Crewtavo tells your clients by itself. Each message is a rule in Automations, where you can change its words."),
  team: msg("Who can sign in, what they can do, and what an hour of their time costs."),
  roles: msg("What each kind of person on your team can see and change."),
  crews: msg("The people on a crew are on its visits: they see them on My day, get them in their calendar and hear when one changes. Pick people on a visit to send only them."),
  "sales-areas": msg("New requests go to the salesperson who covers the property's zip code, from your forms, the phone or anywhere else, and a quote made from one goes to the same person. They get a notification."),
  checklists: msg("What crews fill in on a visit: inspections, safety steps and sign-offs, each step able to open the guide for how it's done."),
  calendars: msg("Other calendars on your schedule, and your visits in your own calendar."),
  assistants: msg("Add Crewtavo to Claude or ChatGPT, and choose what each assistant may change."),
  license: msg("The Crewtavo Terms, the license, and who agreed to them."),
};

/** Sections whose lists or previews need more room than a form; the price list and people tables fill the page. */
const WIDE = new Set<SettingsTab>(["templates", "contracts", "checklists", "storage", "hosting"]);
const FILL = new Set<SettingsTab>(["prices", "team"]);

function SettingsBody({ tab }: { tab: SettingsTab }) {
  switch (tab) {
    case "profile": return <ProfileSettings />;
    case "company": return <CompanySettings />;
    case "payments": return <PaymentSettings />;
    case "schedule": return <ScheduleSettings />;
    case "address": return <WebAddressSettings />;
    case "hosting": return <HostingSettings />;
    case "storage": return <StorageSettings />;
    case "team": return <TeamSettings />;
    case "roles": return <RolesSettings />;
    case "crews": return <CrewSettings />;
    case "sales-areas": return <SalesAreaSettings />;
    case "prices": return <PriceList />;
    case "templates": return <TemplateSettings />;
    case "contracts": return <ContractSettings />;
    case "custom-fields": return <CustomFieldSettings />;
    case "checklists": return <ChecklistSettings />;
    case "weather": return <WeatherSettings />;
    case "client-notifications": return <ClientNotificationSettings />;
    case "email": return <EmailSettings />;
    case "calendars": return <CalendarSettings />;
    case "assistants": return <AssistantSettings />;
    case "maps": return <MapsSettings />;
    case "data": return <DataSettings />;
    case "license": return <LicenseSettings />;
  }
}

const itemKey = (item: SettingsItem) => ("tab" in item ? item.tab : item.to);

export function SettingsPage() {
  const session = useSession();
  const [params] = useSearchParams();
  const phone = usePhoneLayout();
  const isAdmin = hasRole(session, "admin");
  const groups = settingsGroups(session);
  // A sub has only their profile here.
  const sub = isSub(session);
  const items = groups.flatMap((g) => g.items);
  const requested = params.get("tab") as SettingsTab | null;
  const chosen = requested && items.some((i) => "tab" in i && i.tab === requested) ? requested : null;
  const tab: SettingsTab = chosen ?? (isAdmin ? "company" : "profile");
  const item = items.find((i) => "tab" in i && i.tab === tab);
  const label = item ? t(item.label) : t("Settings");
  const lede = LEDES[tab];
  // The header's actions, where a section puts its main one (SettingsActions).
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  const actions = useMemo(() => ({ el: slot }), [slot]);
  const body = (
    <SettingsActionsSlot.Provider value={actions}>
      <div className="settings-body">
        <SettingsBody tab={tab} />
      </div>
    </SettingsActionsSlot.Provider>
  );

  if (sub) {
    return (
      <div className={phone ? "settings-page m-grouped" : "settings-page"}>
        <div className="page-header">
          <h1 className="page-title">{t("Profile")}</h1>
          <div className="page-actions" ref={setSlot} />
        </div>
        <ProfileTitle />
        <div className="settings-main">{body}</div>
      </div>
    );
  }

  // A phone: the list of sections, or one of them with the way back.
  if (phone && !chosen) return <SettingsIndex session={session} groups={groups} />;
  if (phone) {
    return (
      <div className="settings-page m-grouped">
        <SectionTitle title={label} />
        <div className="page-header detail-head settings-phone-head">
          <div className="detail-crumb"><Crumb to="/settings">{t("Settings")}</Crumb></div>
          <h1 className="page-title">{label}</h1>
          <div className="page-actions" ref={setSlot} />
          {lede && <p className="page-lede">{t(lede)}</p>}
        </div>
        {body}
      </div>
    );
  }

  return (
    <>
      <PageHeader title={t("Settings")} />
      <div className="settings-layout">
        <nav className="settings-nav" aria-label={t("Settings sections")}>
          {groups.map((g) => (
            <div key={g.title} className="settings-group" role="group" aria-label={t(g.title)}>
              <span className="settings-group-title" aria-hidden="true">{t(g.title)}</span>
              {g.items.map((it) =>
                "tab" in it ? (
                  <Link key={it.tab} to={`?tab=${it.tab}`} replace className="settings-link" aria-current={tab === it.tab ? "page" : undefined}>
                    <Icon name={it.icon} size={14} />
                    {t(it.label)}
                  </Link>
                ) : (
                  // No ›: in menus › opens a submenu.
                  <Link key={it.to} to={it.to} className="settings-link">
                    <Icon name={it.icon} size={14} />
                    {t(it.label)}
                    <span className="sr-only">{t("Opens its own screen")}</span>
                  </Link>
                ),
              )}
            </div>
          ))}
        </nav>
        <div className="settings-main" data-wide={FILL.has(tab) ? "fill" : WIDE.has(tab) || undefined}>
          <div className="settings-head">
            <div className="settings-head-text">
              <h2 className="settings-title">{label}</h2>
              {lede && <p className="settings-lede">{t(lede)}</p>}
            </div>
            <div className="settings-head-actions page-actions" ref={setSlot} />
          </div>
          {body}
        </div>
      </div>
    </>
  );
}

/** The tab's title: the section, then Settings. */
function SectionTitle({ title }: { title: string }) {
  useDocumentTitle(`${title} · ${t("Settings")}`);
  return null;
}

function ProfileTitle() {
  useDocumentTitle(t("Profile"));
  return null;
}

/**
 * A phone's Settings: you at the top (your profile), a search, then each group of sections as an
 * inset list. Every row opens its section, or its own screen (Packages, Online booking, Automations).
 */
function SettingsIndex({ session, groups }: { session: Session; groups: ReturnType<typeof settingsGroups> }) {
  const [search, setSearch] = useState("");
  const managesTeam = groups.some((g) => g.items.some((i) => "tab" in i && i.tab === "team"));
  // How many people have access, beside People (the same list People and Roles load).
  const team = useQuery({ queryKey: ["team", session.company.id], queryFn: () => api.get<Array<{ active: boolean }>>("/team"), enabled: managesTeam, meta: { silent: true } });
  const counts: Partial<Record<string, number>> = { team: team.data?.filter((m) => m.active).length };
  const words = search.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const matches = (item: SettingsItem) => words.every((w) => `${t(item.label)} ${item.label} ${item.keywords}`.toLowerCase().includes(w));
  const found = words.length ? groups.flatMap((g) => g.items.filter(matches)) : [];
  const profile = session.profile;

  return (
    <div className="settings-page settings-index m-grouped">
      <PageHeader title={t("Settings")} />
      <SearchField value={search} onChange={setSearch} placeholder={t("Search settings")} label={t("Search settings")} shortcut={false} />
      {words.length ? (
        found.length ? (
          <IndexList label={t("Search results")}>{found.map((i) => <IndexRow key={itemKey(i)} item={i} />)}</IndexList>
        ) : (
          <p className="settings-index-none">{t("No settings match “{query}”.", { query: search.trim() })}</p>
        )
      ) : (
        <>
          <Link to="?tab=profile" className="settings-me">
            <span className="avatar" style={{ background: profile.color || "var(--avatar)" }}><Face name={profile.full_name || profile.email} photo={profile.avatar_url} /></span>
            <span className="settings-me-text">
              <span className="settings-me-name">{profile.full_name || profile.email}</span>
              <span className="settings-me-sub">{session.roleName} · {t("Your profile")}</span>
            </span>
            <Icon name="chevronRight" size={16} />
          </Link>
          {groups.map((g) => {
            const rows = g.items.filter((i) => !("tab" in i && i.tab === "profile"));
            if (!rows.length) return null;
            return (
              <section key={g.title} className="settings-index-group" aria-label={t(g.title)}>
                <h2 className="settings-index-title">{t(g.title)}</h2>
                <IndexList>{rows.map((i) => <IndexRow key={itemKey(i)} item={i} count={"tab" in i ? counts[i.tab] : undefined} />)}</IndexList>
              </section>
            );
          })}
        </>
      )}
    </div>
  );
}

function IndexList({ children, label }: { children: ReactNode; label?: string }) {
  return <ul className="settings-index-list" role="list" aria-label={label}>{children}</ul>;
}

function IndexRow({ item, count }: { item: SettingsItem; count?: number }) {
  return (
    <li>
      <Link to={"tab" in item ? `?tab=${item.tab}` : item.to} className="settings-index-link">
        <span className="settings-index-icon" aria-hidden="true"><Icon name={item.icon} size={17} /></span>
        <span className="settings-index-label">{t(item.label)}</span>
        {count !== undefined && <span className="settings-index-count">{count}</span>}
        <Icon name="chevronRight" size={16} />
      </Link>
    </li>
  );
}
