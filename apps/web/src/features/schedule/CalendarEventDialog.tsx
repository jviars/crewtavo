/**
 * An event from another calendar (Zoho, Outlook, Google...), opened from the schedule: when and
 * where, its notes, and which calendar it's from. It's changed in its own calendar; people who
 * schedule can turn it into a visit.
 */
import type { CSSProperties } from "react";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Icon } from "@/components/ui/Icon";
import type { VisitInput } from "./VisitDialog";

export interface CalendarEvent {
  id: string;
  title: string;
  location: string | null;
  description: string | null;
  url: string | null;
  all_day: boolean;
  starts_at: string | null;
  ends_at: string | null;
  starts_on: string;
  ends_on: string;
  busy: boolean;
  source: { id: string; name: string; color: string | null; crew_id: string | null; blocks_time: boolean } | null;
}

const dayLabel = (date: string) => new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });

/** "Tue, Oct 20 · 9:00 AM – 10:30 AM", "Thu, Nov 26 (all day)", "Mon, Oct 5 – Wed, Oct 7". */
export function eventWhen(e: CalendarEvent, tz: string): string {
  if (e.all_day || !e.starts_at || !e.ends_at) {
    return e.starts_on === e.ends_on ? `${dayLabel(e.starts_on)} (all day)` : `${dayLabel(e.starts_on)} – ${dayLabel(e.ends_on)}`;
  }
  const time = (iso: string) => new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: tz });
  if (e.starts_on === e.ends_on) return `${dayLabel(e.starts_on)} · ${time(e.starts_at)} – ${time(e.ends_at)}`;
  return `${dayLabel(e.starts_on)} ${time(e.starts_at)} – ${dayLabel(e.ends_on)} ${time(e.ends_at)}`;
}

export function CalendarEventDialog({ event, tz, onClose, onAddVisit }: { event: CalendarEvent; tz: string; onClose: () => void; onAddVisit?: (visit: VisitInput) => void }) {
  const calendar = event.source?.name ?? "Another calendar";
  const timed = !event.all_day && Boolean(event.starts_at && event.ends_at) && event.starts_on === event.ends_on;
  const add = () =>
    onAddVisit?.({
      title: event.title === "Busy" ? "" : event.title,
      scheduled_on: event.starts_on,
      starts_at: timed ? event.starts_at : null,
      ends_at: timed ? event.ends_at : null,
      anytime: !timed,
      crew_id: event.source?.crew_id ?? null,
      notes: [event.location, event.description].filter(Boolean).join("\n\n") || null,
    });
  const multiDay = event.ends_on > event.starts_on;
  return (
    <Dialog
      open
      onClose={onClose}
      title={event.title}
      description={
        <span className="row" style={{ gap: 6 }}>
          <span className="cal-swatch" style={{ "--c": event.source?.color ?? "var(--text-4)" } as CSSProperties} aria-hidden="true" />
          {calendar}
        </span>
      }
    >
      <div className="dialog-body">
        <div className="row" style={{ gap: 10, alignItems: "flex-start" }}>
          <Icon name="clock" size={16} />
          <span>{eventWhen(event, tz)}</span>
        </div>
        {event.location && (
          <div className="row" style={{ gap: 10, alignItems: "flex-start" }}>
            <Icon name="pin" size={16} />
            <a href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(event.location)}`} target="_blank" rel="noreferrer" style={{ whiteSpace: "pre-line" }}>{event.location}</a>
          </div>
        )}
        {event.description && <p style={{ margin: 0, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{event.description}</p>}
        <span className="muted small">
          {event.busy ? "" : "Marked free in its calendar, so it doesn't count as busy. "}
          {multiDay ? "Spans several days. " : ""}
          From {calendar}: change it there, and the schedule catches up within 15 minutes.
        </span>
        <div className="form-actions">
          {event.url && <a className="btn" href={event.url} target="_blank" rel="noreferrer"><Icon name="external" size={16} />Open in its calendar</a>}
          {onAddVisit && <Button variant="primary" icon="plus" onClick={add}>Add to schedule</Button>}
          {!onAddVisit && !event.url && <Button onClick={onClose}>Close</Button>}
        </div>
      </div>
    </Dialog>
  );
}
