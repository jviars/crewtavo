/**
 * The record of changes to someone's time (time_entry_changes, written by the database on every
 * change to a time entry: supabase/migrations/20261113001800_time_entry_changes.sql), put into
 * words for Timesheets: who or what changed an entry, what it said before and says now, and why.
 * The worker reads the changes to their own time, the office everyone's, a crew lead their crew's.
 */
import { supabase } from "@/lib/api";
import { dateIn, dateLocale, formatTime } from "@/lib/format";
import { t } from "@/lib/i18n";
import { everyRow } from "@/lib/paging";
import { CATEGORY_LABELS, type TimerCategory } from "../field/fieldData";

export interface TimeChange {
  id: string;
  entry_id: string;
  /** Whose time it is. */
  user_id: string;
  action: "added" | "changed" | "deleted";
  /** Who was signed in; null when Crewtavo did it by itself. */
  changed_by: string | null;
  /** What did it: person, assistant, geofence, finished_visit, next_clock, auto_stop, sub_off_clock or system. */
  source: string;
  reason: string | null;
  old_started_at: string | null;
  new_started_at: string | null;
  old_ended_at: string | null;
  new_ended_at: string | null;
  old_category: string | null;
  new_category: string | null;
  old_visit_id: string | null;
  new_visit_id: string | null;
  old_job_id: string | null;
  new_job_id: string | null;
  old_notes: string | null;
  new_notes: string | null;
  changed_at: string;
}

export const CHANGE_COLUMNS =
  "id, entry_id, user_id, action, changed_by, source, reason, old_started_at, new_started_at, old_ended_at, new_ended_at, old_category, new_category, old_visit_id, new_visit_id, old_job_id, new_job_id, old_notes, new_notes, changed_at";

/** Everything on record for one entry, oldest first: the clock's own stops as well as edits. */
export const loadEntryChanges = async (entryId: string): Promise<TimeChange[]> =>
  (await everyRow(() => supabase().from("time_entry_changes").select(CHANGE_COLUMNS).eq("entry_id", entryId), { order: "changed_at" })) as unknown as TimeChange[];

/**
 * The edits to the time that starts in a week, oldest first: time added for someone, starts moved,
 * finished entries changed, and entries deleted. A running clock simply stopped (a tap, a finished
 * visit, a clock left running) isn't one, and is on the entry's own history.
 */
export const loadWeekEdits = async (companyId: string, from: string, to: string): Promise<TimeChange[]> =>
  (await everyRow(
    () => supabase().from("time_entry_changes").select(CHANGE_COLUMNS).eq("company_id", companyId).eq("edit", true).gte("entry_started_at", from).lt("entry_started_at", to),
    { order: "changed_at" },
  )) as unknown as TimeChange[];

const same = (a: string | null, b: string | null) => (a == null || b == null ? a == b : Date.parse(a) === Date.parse(b));
const typeLabel = (category: string | null) => (category && category in CATEGORY_LABELS ? t(CATEGORY_LABELS[category as TimerCategory]) : t("Other work"));

/** Who or what made a change, as the person reading (`me`) is told it. */
export function changedBy(change: Pick<TimeChange, "changed_by" | "source">, me: string, name: (id: string) => string): string {
  const mine = change.changed_by === me;
  const who = change.changed_by ? name(change.changed_by) : null;
  switch (change.source) {
    case "person":
      return mine ? t("You") : (who ?? "Crewtavo");
    case "assistant":
      return mine ? t("Your AI assistant") : who ? t("{name}'s AI assistant", { name: who }) : t("An AI assistant");
    case "geofence":
      return t("The phone, at the property");
    case "finished_visit":
      return mine ? t("You completed the visit") : who ? t("{name} completed the visit", { name: who }) : t("The visit was completed");
    case "next_clock":
      return t("Another clock started");
    case "auto_stop":
      return t("Crewtavo, because the clock was left running");
    case "sub_off_clock":
      return t("Crewtavo, on being taken off the clock");
    default:
      return "Crewtavo";
  }
}

/** One line under an entry that was edited: "Changed by Pat Owner". */
export function editNote(change: Pick<TimeChange, "action" | "changed_by" | "source">, me: string, name: (id: string) => string): string {
  const person = change.source === "person" || change.source === "assistant";
  if (person && change.source === "person" && change.changed_by === me) return change.action === "added" ? t("You added this") : change.action === "deleted" ? t("You deleted this") : t("You changed this");
  const who = person ? changedBy(change, me, name) : "Crewtavo";
  return change.action === "added" ? t("Added by {who}", { who }) : change.action === "deleted" ? t("Deleted by {who}", { who }) : t("Changed by {who}", { who });
}

/** A time, with its day when the two times being compared fall on different days. */
function stamp(iso: string, other: string | null, timeZone: string): string {
  const time = formatTime(iso, timeZone);
  if (!other || dateIn(iso, timeZone) === dateIn(other, timeZone)) return time;
  return `${new Date(iso).toLocaleDateString(dateLocale(), { weekday: "short", month: "short", day: "numeric", timeZone })} ${time}`;
}

/** "8:00 AM – 12:00 PM", or "8:00 AM – now" for a clock still running. */
export const spanLabel = (start: string, end: string | null, timeZone: string) => `${formatTime(start, timeZone)} – ${end ? stamp(end, start, timeZone) : t("now")}`;

/** What a change did, a line for each thing: "Start: 8:00 AM → 9:00 AM". */
export function changeLines(c: TimeChange, timeZone: string): string[] {
  if (c.action === "added") {
    return [t("Added {span}, {type}", { span: spanLabel(c.new_started_at!, c.new_ended_at, timeZone), type: typeLabel(c.new_category) }), ...(c.new_notes ? [t("Note: {note}", { note: c.new_notes })] : [])];
  }
  if (c.action === "deleted") {
    return [t("Deleted {span}, {type}", { span: spanLabel(c.old_started_at!, c.old_ended_at, timeZone), type: typeLabel(c.old_category) }), ...(c.old_notes ? [t("Note: {note}", { note: c.old_notes })] : [])];
  }
  const lines: string[] = [];
  if (!same(c.old_started_at, c.new_started_at)) lines.push(t("Start: {old} → {new}", { old: stamp(c.old_started_at!, c.new_started_at, timeZone), new: stamp(c.new_started_at!, c.old_started_at, timeZone) }));
  if (!same(c.old_ended_at, c.new_ended_at)) {
    if (c.old_ended_at == null) lines.push(t("Stopped at {time}", { time: stamp(c.new_ended_at!, c.new_started_at, timeZone) }));
    else if (c.new_ended_at == null) lines.push(t("Set running again (it had stopped at {time})", { time: stamp(c.old_ended_at, c.old_started_at, timeZone) }));
    else lines.push(t("End: {old} → {new}", { old: stamp(c.old_ended_at, c.new_ended_at, timeZone), new: stamp(c.new_ended_at, c.old_ended_at, timeZone) }));
  }
  if (c.old_category !== c.new_category) lines.push(t("Type: {old} → {new}", { old: typeLabel(c.old_category), new: typeLabel(c.new_category) }));
  if (c.old_visit_id !== c.new_visit_id) lines.push(c.new_visit_id == null ? t("Taken off its visit") : c.old_visit_id == null ? t("Put on a visit") : t("Moved to another visit"));
  else if (c.old_job_id !== c.new_job_id) lines.push(c.new_job_id == null ? t("Taken off its job") : c.old_job_id == null ? t("Put on a job") : t("Moved to another job"));
  if ((c.old_notes ?? "") !== (c.new_notes ?? "")) lines.push(c.new_notes ? t("Note: {note}", { note: c.new_notes }) : t("Note removed"));
  return lines;
}

/** The edits of each entry, and the entries that were deleted (their last record), by person. */
export function sortEdits(changes: readonly TimeChange[]): { byEntry: Map<string, TimeChange[]>; deleted: TimeChange[] } {
  const byEntry = new Map<string, TimeChange[]>();
  for (const change of changes) byEntry.set(change.entry_id, [...(byEntry.get(change.entry_id) ?? []), change]);
  const deleted = [...byEntry.values()].map((list) => list.at(-1)!).filter((last) => last.action === "deleted");
  deleted.sort((a, b) => (a.old_started_at ?? "").localeCompare(b.old_started_at ?? ""));
  return { byEntry, deleted };
}
