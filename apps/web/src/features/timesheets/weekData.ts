/**
 * A week of the company's time as Timesheets shows it: every entry that started in the week, the
 * team, and where people clocked in and out. Thirty people in the field clock more than 1,000
 * entries a week, which is more than the database sends at once, so the entries are read a page at
 * a time (lib/paging.ts): the hours, "Approve all" and the spreadsheet are all made from these rows,
 * and an entry left out would never be seen, approved or paid.
 */
import { zonedTimeToUtc } from "@crewtavo/core/time";
import { api, supabase, unwrap } from "@/lib/api";
import { addDaysIso } from "@/lib/format";
import { everyRow } from "@/lib/paging";
import type { TimerCategory } from "../field/fieldData";
import type { EntryPlaces } from "./clockPlace";

export interface Entry {
  id: string;
  user_id: string;
  category: TimerCategory;
  started_at: string;
  ended_at: string | null;
  approved_at: string | null;
  /** The clock was left running and stopped by Crewtavo: the end time is a guess. */
  auto_stopped_at: string | null;
  notes: string | null;
  visit: { title: string } | null;
  job: { title: string } | null;
}
export interface TeamMember { user_id: string; labor_rate: number | null; active: boolean; profile: { full_name: string; color: string | null; avatar_url?: string | null } | null; sub?: { id: string; name: string } }
/** A week of time as the page loads it. */
export interface WeekData { rows: Entry[]; team: TeamMember[]; places: Record<string, EntryPlaces | undefined> }

/** How many entries' places are asked for at once: the answer has a row for each, and is cut at 1,000 like any other. */
const PLACES_CHUNK = 500;

/**
 * The week starting on `week` (a Monday, in the company's time zone), entries in the order they
 * started. `seesPlaces`: also where each was clocked in and out, for the people who check time
 * (the database decides whose they may see).
 */
export async function loadWeek({ companyId, week, timeZone, seesPlaces }: { companyId: string; week: string; timeZone: string; seesPlaces: boolean }): Promise<WeekData> {
  const [rows, team] = await Promise.all([
    everyRow(
      () =>
        supabase()
          .from("time_entries")
          .select("id, user_id, category, started_at, ended_at, approved_at, auto_stopped_at, notes, visit:visits(title), job:jobs(title)")
          .eq("company_id", companyId)
          .gte("started_at", zonedTimeToUtc(week, "00:00", timeZone).toISOString())
          .lt("started_at", zonedTimeToUtc(addDaysIso(week, 7), "00:00", timeZone).toISOString()),
      { order: "started_at" },
    ),
    // Subs too, for one the office keeps hours for ("Uses the clock" on their page).
    api.get<TeamMember[]>("/team?with_subs=1"),
  ]);
  const entries = rows as unknown as Entry[];
  const chunks = seesPlaces ? Array.from({ length: Math.ceil(entries.length / PLACES_CHUNK) }, (_, i) => entries.slice(i * PLACES_CHUNK, (i + 1) * PLACES_CHUNK).map((e) => e.id)) : [];
  const places = (await Promise.all(chunks.map(async (ids) => unwrap(await supabase().rpc("time_entry_places", { p_company: companyId, p_entries: ids })) as unknown as EntryPlaces[]))).flat();
  return { rows: entries, team, places: Object.fromEntries(places.map((p) => [p.id, p])) as Record<string, EntryPlaces | undefined> };
}
