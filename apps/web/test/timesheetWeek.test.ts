/**
 * Timesheets' week (features/timesheets/weekData.ts) for a company with thirty people in the field:
 * more entries than the database sends at once (fakeDb.ts), so the end of the week used to be
 * missing from the hours, from "Approve all" and from the spreadsheet.
 */
import { zonedTimeToUtc } from "@crewtavo/core/time";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeDb, MAX_ROWS, type Row } from "./fakeDb";

const state = vi.hoisted(() => ({ db: null as unknown, team: [] as unknown[] }));
vi.mock("../src/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/api")>()),
  api: { get: async () => state.team },
  supabase: () => state.db,
}));
const { loadWeek } = await import("../src/features/timesheets/weekData");

const COMPANY = "c1";
const TZ = "America/New_York";
const WEEK = "2026-11-02";
const PEOPLE = 30;
const at = (day: number, time: string) => zonedTimeToUtc(`2026-11-${String(day).padStart(2, "0")}`, time, TZ).toISOString();

/** Monday to Saturday, each person clocking drive, job, break and job again, twice a day: 1,440 entries. */
function weekOfTime(): Row[] {
  const rows: Row[] = [];
  for (let day = 2; day <= 7; day++) {
    for (let person = 0; person < PEOPLE; person++) {
      ["07:00", "07:30", "09:30", "10:00", "12:00", "12:30", "14:30", "15:00"].forEach((start, i) => {
        const [h, m] = start.split(":").map(Number) as [number, number];
        rows.push({
          id: `t-${day}-${String(person).padStart(2, "0")}-${i}`, company_id: COMPANY, user_id: `u${person}`, category: i % 4 === 2 ? "break" : "job",
          started_at: at(day, start), ended_at: at(day, `${String(h + (m ? 1 : 0)).padStart(2, "0")}:${m ? "00" : "30"}`), approved_at: null, auto_stopped_at: null, notes: null, visit: null, job: null,
        });
      });
    }
  }
  return rows;
}

let db: FakeDb;
beforeEach(() => {
  const outside = [
    { id: "last-week", company_id: COMPANY, user_id: "u0", category: "job", started_at: at(1, "23:30"), ended_at: at(1, "23:45"), approved_at: null },
    { id: "next-week", company_id: COMPANY, user_id: "u0", category: "job", started_at: at(9, "00:00"), ended_at: at(9, "01:00"), approved_at: null },
    { id: "another-company", company_id: "c2", user_id: "u9", category: "job", started_at: at(3, "08:00"), ended_at: at(3, "09:00"), approved_at: null },
  ];
  db = new FakeDb({ time_entries: [...weekOfTime(), ...outside] }, {
    time_entry_places: ({ p_entries }: { p_entries: string[] }) => p_entries.map((id) => ({ id, in_place: { lat: 40.7, lng: -74 }, out_place: null, site: null })),
  });
  state.db = db;
  state.team = Array.from({ length: PEOPLE }, (_, i) => ({ user_id: `u${i}`, labor_rate: 20, active: true, profile: { full_name: `Person ${i}`, color: null } }));
});

describe("a week of time for thirty people", () => {
  it("is more than one request brings", async () => {
    const once = await db.from("time_entries").select("id").eq("company_id", COMPANY).gte("started_at", at(2, "00:00")).lt("started_at", at(9, "00:00")).order("started_at");
    expect(once.data).toHaveLength(MAX_ROWS);
    // What the page used to miss: the last 440 entries, most of Friday and all of Saturday.
    expect(Math.max(...once.data!.map((r) => Date.parse(r.started_at as string)))).toBeLessThan(Date.parse(at(7, "00:00")));
  });

  it("has every entry, in the order they started", async () => {
    const data = await loadWeek({ companyId: COMPANY, week: WEEK, timeZone: TZ, seesPlaces: false });
    expect(data.rows).toHaveLength(1440);
    expect(new Set(data.rows.map((r) => r.id)).size).toBe(1440);
    expect(data.rows.map((r) => r.started_at)).toEqual(data.rows.map((r) => r.started_at).sort());
    // The week only, and this company only.
    expect(data.rows.some((r) => ["last-week", "next-week", "another-company"].includes(r.id))).toBe(false);
    expect(data.team).toHaveLength(PEOPLE);
    expect(db.requests.map((r) => [r.order, r.from, r.to])).toEqual([["started_at.asc,id.asc", 0, 999], ["started_at.asc,id.asc", 1000, 1999]]);
    expect(db.calls).toEqual([]);
  });

  it("counts Saturday's hours, and offers them all for approval", async () => {
    const { rows } = await loadWeek({ companyId: COMPANY, week: WEEK, timeZone: TZ, seesPlaces: false });
    const saturday = rows.filter((r) => r.started_at >= at(7, "00:00"));
    expect(saturday).toHaveLength(PEOPLE * 8);
    // "Approve all (N)" and each person's "Approve N" count the entries that ended and aren't approved.
    expect(rows.filter((r) => r.ended_at && !r.approved_at)).toHaveLength(1440);
    for (let person = 0; person < PEOPLE; person++) expect(rows.filter((r) => r.user_id === `u${person}`), `u${person}`).toHaveLength(48);
  });

  it("has where each was clocked in, asked for in lots small enough to be answered whole", async () => {
    const data = await loadWeek({ companyId: COMPANY, week: WEEK, timeZone: TZ, seesPlaces: true });
    expect(Object.keys(data.places)).toHaveLength(1440);
    expect(data.rows.every((r) => data.places[r.id]?.in_place?.lat === 40.7)).toBe(true);
    expect(db.calls.map((c) => [c.name, (c.args.p_entries as string[]).length, c.args.p_company])).toEqual([["time_entry_places", 500, COMPANY], ["time_entry_places", 500, COMPANY], ["time_entry_places", 440, COMPANY]]);
  });

  it("asks for no places in an empty week", async () => {
    const data = await loadWeek({ companyId: COMPANY, week: "2026-11-16", timeZone: TZ, seesPlaces: true });
    expect(data).toMatchObject({ rows: [], places: {} });
    expect(db.calls).toEqual([]);
  });
});
