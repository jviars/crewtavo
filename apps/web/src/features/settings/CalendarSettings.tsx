/**
 * Settings → Calendars: every other calendar on the schedule in one place, a calendar file
 * uploaded from a computer (an export from Google, Apple or Outlook), and your visits in your own
 * calendar. Calendars that stay up to date are added on their app's page.
 */
import { Link } from "react-router-dom";
import { Icon } from "@/components/ui/Icon";
import { Skeleton } from "@/components/ui/Skeleton";
import { ErrorState } from "@/components/ui/States";
import { CalendarRow, UploadCalendarForm, useCalendars } from "../apps/CalendarPanels";
import { CalendarFeedCard } from "./CalendarFeedCard";

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
    <div className="stack" style={{ maxWidth: 860 }}>
      <section className="card" aria-labelledby="calendars-shown">
        <div className="card-pad stack-sm" style={{ gap: 4 }}>
          <h2 id="calendars-shown" className="section-title" style={{ fontSize: 16 }}>Calendars on your schedule</h2>
          <span className="muted small">Their events show next to your visits, and busy time counts in Find a time. Changes here only affect Crewtavo.</span>
        </div>
        {calendars.isPending ? (
          <div className="card-row"><Skeleton height={36} radius={8} style={{ flex: 1 }} /></div>
        ) : calendars.error ? (
          <ErrorState error={calendars.error} onRetry={() => calendars.refetch()} compact />
        ) : list.length ? (
          list.map((s) => <div key={s.id} className="card-row"><CalendarRow source={s} /></div>)
        ) : (
          <div className="card-row muted small">None yet. Upload a calendar file below, or add one that stays up to date.</div>
        )}
      </section>

      <section className="card card-pad stack" aria-labelledby="calendars-upload">
        <h2 id="calendars-upload" className="section-title" style={{ fontSize: 16 }}>Upload a calendar file</h2>
        <UploadCalendarForm />
      </section>

      <section className="card card-pad stack-sm" aria-labelledby="calendars-live">
        <h2 id="calendars-live" className="section-title" style={{ fontSize: 16 }}>Calendars that stay up to date</h2>
        <span className="muted small">Add a calendar by its link and Crewtavo reads it again every 15 minutes. No sign-in or setup needed.</span>
        <div className="row wrap" style={{ gap: 8 }}>
          {LIVE.map((app) => (
            <Link key={app.id} className="btn btn-sm" to={`/apps/${app.id}`}>
              <Icon name="calendar" size={14} />
              {app.name}
            </Link>
          ))}
        </div>
      </section>

      <CalendarFeedCard />
    </div>
  );
}
