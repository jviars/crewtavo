/**
 * Settings → Calendars: every other calendar on the schedule in one place, a calendar file
 * uploaded from a computer (an export from Google, Apple or Outlook), and your visits in your own
 * calendar. Calendars that stay up to date are added on their app's page.
 */
import { Icon } from "@/components/ui/Icon";
import { RelatedRow, Section } from "@/components/ui/Section";
import { EmptyState, ErrorState } from "@/components/ui/States";
import { AppIcon } from "../apps/AppIcon";
import { CalendarList, UploadCalendarForm, useCalendars } from "../apps/CalendarPanels";
import { RowsSkeleton } from "../apps/PanelKit";
import { CalendarFeedCard } from "./CalendarFeedCard";
import styles from "./settings.module.css";

const LIVE = [
  { id: "google_calendar", name: "Google Calendar" },
  { id: "outlook_calendar", name: "Outlook" },
  { id: "apple_calendar", name: "Apple Calendar" },
  { id: "zoho_calendar", name: "Zoho Calendar" },
  { id: "ics_calendar", name: "Any calendar link" },
];

export function CalendarSettings() {
  const calendars = useCalendars();
  const list = calendars.data?.calendars ?? [];
  return (
    <>
      <Section level={3} title="Calendars on your schedule" count={list.length || undefined}>
        <p className="set-note">Their events show next to your visits, and busy time counts in Find a time. Changes here only affect Crewtavo.</p>
        {calendars.isPending ? (
          <RowsSkeleton rows={2} />
        ) : calendars.error ? (
          <ErrorState error={calendars.error} onRetry={() => calendars.refetch()} compact />
        ) : list.length ? (
          <CalendarList sources={list} />
        ) : (
          <EmptyState inline title="None yet">Upload a calendar file below, or add one that stays up to date.</EmptyState>
        )}
      </Section>

      <Section level={3} title="Upload a calendar file">
        <UploadCalendarForm />
      </Section>

      <Section level={3} title="Calendars that stay up to date">
        <p className="set-note">Add a calendar by its link and Crewtavo reads it again every 15 minutes. No sign-in or setup needed.</p>
        <ul className={`rel ${styles.liveApps}`} role="list">
          {LIVE.map((app) => (
            // A phone draws its own chevron on a row that opens something.
            <RelatedRow key={app.id} to={`/apps/${app.id}`} lead={<AppIcon id={app.id} name={app.name} size="sm" />} title={app.name} end={<Icon name="chevronRight" size={14} className="hide-mobile" />} />
          ))}
        </ul>
      </Section>

      <CalendarFeedCard />
    </>
  );
}
