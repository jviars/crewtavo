/**
 * iCalendar (RFC 5545) output for calendar feeds: Google, Apple and Outlook calendars subscribe to
 * these. Timed events are written in UTC; anytime visits are all-day events.
 */

export interface IcsEvent {
  uid: string;
  title: string;
  /** Timed event (UTC instants)... */
  start?: Date;
  end?: Date;
  /** ...or an all-day event (YYYY-MM-DD, local to the company). */
  date?: string;
  location?: string | null;
  description?: string | null;
  url?: string | null;
  cancelled?: boolean;
  updated?: Date;
}

// Any line break (\r\n, \n or a lone \r, which would end the line) becomes \n; other control
// characters aren't allowed in text values, so they're dropped.
const escape = (text: string) =>
  text
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r\n|\r|\n/g, "\\n")
    .replace(/[\x00-\x08\x0a-\x1f\x7f]/g, "");
const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
const day = (iso: string) => iso.replace(/-/g, "");
const nextDay = (iso: string) => {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return day(d.toISOString().slice(0, 10));
};

/** Lines longer than 75 bytes are folded onto continuation lines that start with a space. */
function fold(line: string): string {
  const bytes = new TextEncoder().encode(line);
  if (bytes.length <= 75) return line;
  const parts: string[] = [];
  let current = "";
  let size = 0;
  for (const ch of line) {
    const len = new TextEncoder().encode(ch).length;
    if (size + len > (parts.length ? 74 : 75)) {
      parts.push(current);
      current = "";
      size = 0;
    }
    current += ch;
    size += len;
  }
  parts.push(current);
  return parts.join("\r\n ");
}

export function buildCalendar(name: string, events: IcsEvent[]): string {
  const now = stamp(new Date());
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Crewtavo//Schedule//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${escape(name)}`,
    "REFRESH-INTERVAL;VALUE=DURATION:PT30M",
    "X-PUBLISHED-TTL:PT30M",
  ];
  for (const e of events) {
    lines.push("BEGIN:VEVENT", `UID:${e.uid}`, `DTSTAMP:${e.updated ? stamp(e.updated) : now}`);
    if (e.start && e.end) lines.push(`DTSTART:${stamp(e.start)}`, `DTEND:${stamp(e.end)}`);
    else if (e.date) lines.push(`DTSTART;VALUE=DATE:${day(e.date)}`, `DTEND;VALUE=DATE:${nextDay(e.date)}`, "TRANSP:TRANSPARENT");
    lines.push(`SUMMARY:${escape(e.title)}`);
    if (e.location) lines.push(`LOCATION:${escape(e.location)}`);
    if (e.description) lines.push(`DESCRIPTION:${escape(e.description)}`);
    if (e.url) lines.push(`URL:${e.url}`);
    if (e.cancelled) lines.push("STATUS:CANCELLED");
    lines.push("END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return lines.map(fold).join("\r\n") + "\r\n";
}
