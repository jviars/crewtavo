/**
 * Team chat for people in the field, the rules the web app and the API share: voice notes (the
 * recording type a browser can make, how long one is), messages that wait on the phone for signal
 * (when to try again), a person's status (the choices, when it clears, what the clock says), and
 * times to send a message later or be reminded of one, in the business's own time zone.
 */
import { msg } from "./i18n";
import { addDays, localDate, localTime, zonedTimeToUtc } from "./time";

// ---------------------------------------------------------------------------------------------
// Voice notes
// ---------------------------------------------------------------------------------------------

/** The longest voice note, in seconds. */
export const VOICE_MAX_SECONDS = 5 * 60;

/** What a browser can record, best first: Opus in WebM on Chrome, Android and Firefox; AAC in MP4 on Safari and iPhones. */
const RECORDING_TYPES = [
  { mimeType: "audio/webm;codecs=opus", type: "audio/webm", ext: "webm" },
  { mimeType: "audio/webm", type: "audio/webm", ext: "webm" },
  { mimeType: "audio/mp4;codecs=mp4a.40.2", type: "audio/mp4", ext: "m4a" },
  { mimeType: "audio/mp4", type: "audio/mp4", ext: "m4a" },
  { mimeType: "audio/ogg;codecs=opus", type: "audio/ogg", ext: "ogg" },
] as const;

export interface RecordingType {
  /** What to ask MediaRecorder for, or "" to let it choose. */
  mimeType: string;
  /** The file's type, without its codecs. */
  type: string;
  /** The ending it's stored under (one private.chat_file_endings() takes). */
  ext: string;
}

/** The best recording type this browser supports (MediaRecorder.isTypeSupported), or the browser's own choice. */
export function recordingType(isSupported: (mimeType: string) => boolean): RecordingType {
  for (const t of RECORDING_TYPES) {
    try {
      if (isSupported(t.mimeType)) return t;
    } catch {
      // An old browser that throws for a type it doesn't know: try the next.
    }
  }
  return { mimeType: "", type: "audio/webm", ext: "webm" };
}

/** The type and ending a finished recording is stored with: what the recorder says it made, else what was asked for. */
export function recordedFile(made: string | undefined, asked: RecordingType): { type: string; ext: string } {
  const type = (made || asked.type).split(";")[0]!.trim().toLowerCase();
  if (type === "audio/mp4" || type === "audio/x-m4a" || type === "audio/aac") return { type: "audio/mp4", ext: "m4a" };
  if (type === "audio/ogg") return { type, ext: "ogg" };
  if (type === "audio/webm" || type === "video/webm") return { type: "audio/webm", ext: "webm" };
  return { type: asked.type, ext: asked.ext };
}

/**
 * Whether a message's file is a voice note (or any recording): played in the message, not opened.
 * By the ending it's stored under, which the database holds to (private.chat_file_endings), not the
 * type the sender gave it: a document called audio/webm is still a document. Only a file not stored
 * yet goes by its type.
 */
export const isAudio = (file: { type?: string | null; path?: string | null }) =>
  file.path ? /\.(webm|weba|m4a|aac|mp3|mpga|ogg|oga|opus|wav)$/i.test(file.path) : Boolean(file.type?.startsWith("audio/"));

/** "0:42", "4:05". */
export function clockText(seconds: number): string {
  const s = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** The speeds a voice note plays at, in turn. */
export const PLAY_SPEEDS = [1, 1.5, 2] as const;
export const nextSpeed = (speed: number) => PLAY_SPEEDS[(PLAY_SPEEDS.indexOf(speed as (typeof PLAY_SPEEDS)[number]) + 1) % PLAY_SPEEDS.length]!;

// ---------------------------------------------------------------------------------------------
// Messages waiting on the phone for signal
// ---------------------------------------------------------------------------------------------

/**
 * How long a message that couldn't go waits before it's tried again by itself: 5 seconds, then
 * twice as long each time up to 5 minutes, each a little earlier or later (`random`, 0 to 1) so
 * phones that lost signal together don't all try at the same moment. Coming back online and
 * coming back to the app try at once anyway.
 */
export function retryDelay(attempts: number, random = 0.5): number {
  const base = Math.min(5 * 60_000, 5_000 * 2 ** Math.max(0, Math.min(attempts, 10)));
  return Math.round(base * (0.8 + Math.min(1, Math.max(0, random)) * 0.4));
}

/**
 * Whether a send that failed waits for signal: the network didn't answer (status 0) or the server
 * was restarting (502 to 504). Anything the server answered (it refused the message) isn't kept.
 */
export const waitsForSignal = (status: number | undefined) => status === 0 || status === 502 || status === 503 || status === 504;

// ---------------------------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------------------------

export const STATUS_KINDS = [
  { key: "on_job", label: msg("On a job") },
  { key: "driving", label: msg("Driving") },
  { key: "break", label: msg("On a break") },
  { key: "off", label: msg("Off today") },
  { key: "office", label: msg("In the office") },
  { key: "busy", label: msg("Busy") },
] as const;
export type StatusKind = (typeof STATUS_KINDS)[number]["key"];
/** A status in someone's own words. */
export const CUSTOM_STATUS = "custom";
export const STATUS_TEXT_MAX = 60;
export const isStatusKind = (value: unknown): value is StatusKind => STATUS_KINDS.some((k) => k.key === value);

/** What the clock says someone is doing while it runs (time_entries.category), or null. */
export function clockStatus(category: string | null | undefined): StatusKind | null {
  if (category === "drive") return "driving";
  if (category === "break") return "break";
  if (category === "visit" || category === "assessment") return "on_job";
  return null;
}

export const STATUS_CLEARS = [
  { key: "30m", label: msg("In 30 minutes") },
  { key: "1h", label: msg("In 1 hour") },
  { key: "4h", label: msg("In 4 hours") },
  { key: "today", label: msg("At the end of today") },
  { key: "week", label: msg("At the end of this week") },
  { key: "never", label: msg("Never") },
] as const;
export type StatusClear = (typeof STATUS_CLEARS)[number]["key"];

/** The weekday of a YYYY-MM-DD date: 0 Sunday to 6 Saturday. */
export function weekdayOf(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay();
}

/** When a status set now clears, in the business's time zone: the end of today is its midnight, the end of the week Sunday's. Null for never. */
export function statusUntil(clear: StatusClear, now: Date, timeZone: string): Date | null {
  if (clear === "30m") return new Date(now.getTime() + 30 * 60_000);
  if (clear === "1h") return new Date(now.getTime() + 60 * 60_000);
  if (clear === "4h") return new Date(now.getTime() + 4 * 60 * 60_000);
  if (clear === "never") return null;
  const today = localDate(now, timeZone);
  const days = clear === "today" ? 1 : 8 - (weekdayOf(today) || 7);
  return zonedTimeToUtc(addDays(today, days), "00:00", timeZone);
}

// ---------------------------------------------------------------------------------------------
// Sending later, and reminders
// ---------------------------------------------------------------------------------------------

/** The day after `now`'s date where the business is, at `time` there. */
export function tomorrowAt(time: string, now: Date, timeZone: string): Date {
  return zonedTimeToUtc(addDays(localDate(now, timeZone), 1), time, timeZone);
}

/** The next Monday after today where the business is (a week on, on a Monday), at `time` there. */
export function nextMondayAt(time: string, now: Date, timeZone: string): Date {
  const today = localDate(now, timeZone);
  return zonedTimeToUtc(addDays(today, 8 - (weekdayOf(today) || 7)), time, timeZone);
}

/** The quick choices to send a message later: tomorrow at 6:30 AM, and Monday at 7:00 AM, where the business is. */
export function sendLaterChoices(now: Date, timeZone: string) {
  return [
    { key: "tomorrow", label: msg("Tomorrow at 6:30 AM"), at: tomorrowAt("06:30", now, timeZone) },
    { key: "monday", label: msg("Monday at 7:00 AM"), at: nextMondayAt("07:00", now, timeZone) },
  ] as const;
}

/** The quick choices for a reminder: in an hour, and tomorrow at 9:00 AM where the business is. */
export function remindChoices(now: Date, timeZone: string) {
  return [
    { key: "hour", label: msg("In 1 hour"), at: new Date(now.getTime() + 60 * 60_000) },
    { key: "tomorrow", label: msg("Tomorrow at 9:00 AM"), at: tomorrowAt("09:00", now, timeZone) },
  ] as const;
}

/** A date and time picked in a form, read in the business's time zone; null while it's partial or not in the future. */
export function pickedTime(date: string, time: string, now: Date, timeZone: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) return null;
  const at = zonedTimeToUtc(date, time, timeZone);
  return Number.isNaN(at.getTime()) || at.getTime() <= now.getTime() ? null : at;
}

/** What a date and time picker starts on: an hour from now, on the quarter hour, where the business is. */
export function pickerStart(now: Date, timeZone: string): { date: string; time: string } {
  const later = new Date(Math.ceil((now.getTime() + 60 * 60_000) / (15 * 60_000)) * 15 * 60_000);
  return { date: localDate(later, timeZone), time: localTime(later, timeZone) };
}

/** How far ahead a message can be scheduled or a reminder set. */
export const LATER_MAX_DAYS = 365;
