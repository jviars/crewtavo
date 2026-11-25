/**
 * App icons and the directory's cards (App-Directory.dc.html). Another company's app shows its own logo
 * on a white tile, like a phone's home screen (see assets/apps/README.md). An app built into Crewtavo
 * is one of a family in the logo's colors: its menu icon, filled, in the logo's amber on its navy, so
 * the nine read as Crewtavo's and can still be told apart at a glance. Flat: a hairline, no shadow.
 */
import { Link } from "react-router-dom";
import { Icon, type IconName } from "@/components/ui/Icon";
import abcSupplyLogo from "@/assets/apps/abc-supply.svg";
import chatgptLogo from "@/assets/apps/chatgpt.svg";
import claudeLogo from "@/assets/apps/claude.svg";
import falLogo from "@/assets/apps/fal.svg";
import openMeteoLogo from "@/assets/apps/open-meteo.png";
import googleBusinessLogo from "@/assets/apps/google-business.svg";
import googleCalendarLogo from "@/assets/apps/google-calendar.svg";
import lobLogo from "@/assets/apps/lob.svg";
import metaLogo from "@/assets/apps/meta.svg";
import outlookLogo from "@/assets/apps/outlook.svg";
import quickbooksLogo from "@/assets/apps/quickbooks.svg";
import stripeLogo from "@/assets/apps/stripe.svg";
import sveltiaLogo from "@/assets/apps/sveltia.svg";
import twilioLogo from "@/assets/apps/twilio.svg";
import zohoLogo from "@/assets/apps/zoho.svg";
import { APP_INFO, categoryName, infoFor, type AppRow } from "./catalog";
import { dateLocale } from "@/lib/format";

/** The apps built into Crewtavo, each with the icon its screen has in the menu (components/shell/nav.ts). */
export const OWN_ICONS: Record<string, IconName> = {
  team_chat: "chat",
  website_analytics: "metrics",
  website_forms: "requests",
  careers: "user",
  drive: "folder",
  marketing: "marketing",
  paving: "paving",
  roofing: "roofing",
  snow: "snow",
};

const LOGOS: Record<string, string> = {
  google_business: googleBusinessLogo,
  meta: metaLogo,
  google_calendar: googleCalendarLogo,
  zoho_calendar: zohoLogo,
  outlook_calendar: outlookLogo,
  quickbooks: quickbooksLogo,
  zoho_books: zohoLogo,
  stripe: stripeLogo,
  abc_supply: abcSupplyLogo,
  twilio: twilioLogo,
  lob: lobLogo,
  anthropic: claudeLogo,
  fal: falLogo,
  open_meteo: openMeteoLogo,
  chatgpt: chatgptLogo,
  sveltia: sveltiaLogo,
};
/** Wordmark-shaped logos get more width. */
const WIDE = new Set(["zoho_calendar", "zoho_books", "abc_supply"]);
/** Logos that are already a whole app icon fill the tile. */
const FULL = new Set(["sveltia", "open_meteo"]);

/** sm: 36px (a collection's icons); md: a card's 48px; lg: 64px; xl: the top of an app's own page, 88px (64px on a phone). */
export type IconSize = "sm" | "md" | "lg" | "xl";

export function AppIcon({ id, name, size = "md" }: { id: string; name: string; size?: IconSize }) {
  const own = OWN_ICONS[id];
  if (own) {
    return (
      <span className="app-icon app-icon-own" data-size={size} aria-hidden="true">
        {/* Snow's filled glyph is a solid disc; its bold line sits evenly with the others. */}
        <Icon name={own} size={20} filled={own !== "snow"} bold={own === "snow"} />
      </span>
    );
  }
  if (id === "apple_calendar") {
    // Like the calendar app on a phone: today's weekday and date.
    const now = new Date();
    return (
      <span className="app-icon app-icon-date" data-size={size} aria-hidden="true">
        <span>{now.toLocaleDateString(dateLocale(), { weekday: "short" })}</span>
        <strong>{now.getDate()}</strong>
      </span>
    );
  }
  if (id === "ics_calendar") {
    return (
      <span className="app-icon app-icon-generic" data-size={size} aria-hidden="true">
        <Icon name="calendar" size={20} />
      </span>
    );
  }
  const src = LOGOS[id];
  return (
    <span className="app-icon" data-size={size} data-wide={WIDE.has(id) || undefined} data-full={FULL.has(id) || undefined} aria-hidden="true">
      {src ? <img src={src} alt="" /> : <span className="app-icon-letter">{name.slice(0, 1)}</span>}
    </span>
  );
}

/** An app's name where Crewtavo is already said around it: "Team Chat", not "Team Chat - Crewtavo". */
export const shortName = (app: Pick<AppRow, "name">) => app.name.replace(/\s+-\s+Crewtavo$/, "");

/** Installed (or how many calendars), or needs attention: said on the right of the app's row. */
export function appState(app: AppRow, installed: boolean): { tone: "good" | "danger"; label: string } | null {
  if (app.status === "error" || app.calendar_errors) return { tone: "danger", label: "Needs attention" };
  if (!installed) return null;
  return { tone: "good", label: app.calendars ? `${app.calendars} ${app.calendars === 1 ? "calendar" : "calendars"}` : "Installed" };
}

/**
 * One app on a card, as an app store shows it (the directory, and More apps on an app's page): its icon,
 * name and who it's from, one line on what it does, and on the right Get, or whether it's installed. The
 * whole card opens the app's page, where it's installed and set up; the state is said for a screen reader.
 */
export function AppCard({ app, installed }: { app: AppRow; installed: boolean }) {
  const state = appState(app, installed);
  // Not proven everywhere yet (catalog.ts): said after the name, and on its page.
  const beta = Boolean(APP_INFO[app.id]?.beta);
  return (
    <Link to={`/apps/${app.id}`} className="app-card">
      <AppIcon id={app.id} name={app.name} size="md" />
      <span className="app-card-head">
        <span className="app-card-name">
          {shortName(app)}
          {beta && <span className="app-beta">Beta</span>}
        </span>
        <span className="app-card-from">{categoryName(app.category)}</span>
      </span>
      <span className="app-get" data-tone={state?.tone}>
        {state && <Icon name={state.tone === "good" ? "check" : "alert"} size={12} bold />}
        {state ? state.label : "Get"}
      </span>
      <span className="app-card-tag">{infoFor(app).tagline}</span>
    </Link>
  );
}
