/**
 * Calendar files from a computer: an .ics file, or the .zip of them that Google Calendar's Export
 * downloads (opened here, so nobody has to unzip it first). The server reads each calendar's events.
 */
import { isZip, unzip, ZipError } from "@/lib/unzip";

export interface CalendarFile {
  /** The file's own name, like "Work_abc@group.calendar.google.com.ics". */
  fileName: string;
  /** The calendar's name inside the file (X-WR-CALNAME), if it has one. */
  name: string | null;
  text: string;
}

export const CALENDAR_FILE_TYPES = ".ics,.ical,.ifb,.icalendar,.zip,text/calendar,application/zip";
const CALENDAR_NAME = /\.(ics|ical|ifb|icalendar)$/i;
const MAX_BYTES = 10 * 1024 * 1024;
const TOO_BIG = "That calendar file is too big to read (over 10 MB). Try exporting a calendar with fewer past events.";

/** The calendar's own name, from X-WR-CALNAME (its lines unfolded and its escapes undone). */
export function calendarName(text: string): string | null {
  const head = text.slice(0, 20_000).replace(/\r?\n[ \t]/g, "");
  const raw = /^X-WR-CALNAME(?:;[^:\r\n]*)?:(.*)$/im.exec(head)?.[1];
  const name = raw?.replace(/\\([\\;,])/g, "$1").replace(/\\n/gi, " ").trim();
  return name || null;
}

const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

/** Every calendar in a chosen file. Throws a message the person can act on when there's none. */
export async function readCalendarFiles(file: File): Promise<CalendarFile[]> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (isZip(bytes)) {
    const inside = await unzip(bytes, (name) => CALENDAR_NAME.test(name), MAX_BYTES).catch((error: unknown) => {
      throw error instanceof ZipError && /too big/.test(error.message) ? new ZipError(TOO_BIG) : error;
    });
    if (!inside.length) throw new ZipError("That .zip file has no calendar (.ics) files in it.");
    return inside.map((f) => {
      const text = decode(f.bytes);
      return { fileName: f.name.split("/").pop() ?? f.name, name: calendarName(text), text };
    });
  }
  if (bytes.length > MAX_BYTES) throw new Error(TOO_BIG);
  const text = decode(bytes);
  return [{ fileName: file.name, name: calendarName(text), text }];
}

/** For uploading one calendar again: the file's calendar, or from a .zip the one with this name (or its only one). */
export function pickCalendar(files: CalendarFile[], name: string): CalendarFile {
  if (files.length === 1) return files[0]!;
  const same = files.find((f) => f.name?.toLowerCase() === name.trim().toLowerCase());
  if (same) return same;
  throw new Error(`That .zip has ${files.length} calendars, and none is called ${name}. Choose the calendar's own .ics file instead.`);
}
