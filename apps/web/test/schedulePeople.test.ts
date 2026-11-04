/**
 * The schedule's People view (features/schedule/people.ts): who gets a row, which visits and
 * calendar events sit on each row, who's on a visit after it's dragged from one row to another,
 * and when someone is on two visits at once (TimeGrid's place, by person).
 */
import { describe, expect, it } from "vitest";
import { doubleBookings, eventOnRow, movePeople, onRow, peopleRows } from "../src/features/schedule/people";
import { conflictsOf, place, type GridExternal, type GridVisit } from "../src/features/schedule/TimeGrid";

const on = (...ids: string[]) => ({ assignees: ids.map((user_id) => ({ user_id })) });

describe("rows in the People view", () => {
  const names: Record<string, string> = { me: "You", ana: "Ana", bo: "Bo", gone: "Cal", sub: "Leafy Subs", idle: "Dee" };
  const nameOf = (id: string) => names[id]!;
  const team = [
    { user_id: "bo", active: true },
    { user_id: "gone", active: false },
    { user_id: "sub", active: true, sub: { id: "s1", name: "Leafy Subs" } },
    { user_id: "ana", active: true },
    { user_id: "me", active: true },
    { user_id: "idle", active: false },
  ];

  it("gives everyone active on the team a row, you first, then by name", () => {
    expect(peopleRows(team, [], nameOf, "me").map((p) => p.user_id)).toEqual(["me", "ana", "bo"]);
  });

  it("adds anyone else on a visit shown, so their visits don't go missing", () => {
    expect(peopleRows(team, [on("gone"), on("sub", "ana")], nameOf, "me").map((p) => p.user_id)).toEqual(["me", "ana", "bo", "gone", "sub"]);
  });

  it("puts a visit on the row of each person assigned to it, and nobody's on the empty row", () => {
    expect(onRow(on("ana", "bo"), "ana")).toBe(true);
    expect(onRow(on("ana", "bo"), "me")).toBe(false);
    expect(onRow(on(), "")).toBe(true);
    expect(onRow(on("ana"), "")).toBe(false);
  });
});

describe("dragging a visit between people", () => {
  it("adds the person it's dropped on when it comes from Unscheduled or the nobody row", () => {
    expect(movePeople([], undefined, "ana")).toEqual(["ana"]);
    expect(movePeople([], "", "ana")).toEqual(["ana"]);
    expect(movePeople(["bo"], undefined, "ana")).toEqual(["bo", "ana"]);
  });

  it("moves it from one person to another, keeping anyone else on it", () => {
    expect(movePeople(["ana", "bo"], "ana", "me")).toEqual(["bo", "me"]);
    // Already on it: the one it came from just comes off.
    expect(movePeople(["ana", "bo"], "ana", "bo")).toEqual(["bo"]);
  });

  it("takes the person off when it's dropped on the nobody row", () => {
    expect(movePeople(["ana", "bo"], "ana", "")).toEqual(["bo"]);
  });

  it("changes nobody when it stays on its row or the person is already on it", () => {
    expect(movePeople(["ana"], "ana", "ana")).toBeNull();
    expect(movePeople(["ana"], undefined, "ana")).toBeNull();
    expect(movePeople([], "", "")).toBeNull();
    expect(movePeople(["ana"], undefined, "")).toBeNull();
  });
});

describe("someone on two visits at once", () => {
  const tz = "America/New_York";
  const at = (id: string, start: string, end: string, crew_id: string | null = null, status = "scheduled"): GridVisit => ({
    id, title: id, kind: "job", status, crew_id, starts_at: `2026-10-16T${start}:00-04:00`, ends_at: `2026-10-16T${end}:00-04:00`,
  });
  const busy = (person: string | null, start: string, end: string): GridExternal => ({
    id: `e-${start}`, title: "Dentist", starts_at: `2026-10-16T${start}:00-04:00`, ends_at: `2026-10-16T${end}:00-04:00`, color: null, busy: true, calendar: "Ana (personal)", crew_id: null, person,
  });
  const marks = (visits: GridVisit[], person?: string) => Object.fromEntries(place(visits, tz, person).map((p) => [p.v.id, p.conflict]));

  it("marks both visits on a person's row when they overlap, whatever their crews", () => {
    expect(marks([at("a", "09:00", "11:00", "north"), at("b", "10:00", "12:00", "south")], "ana")).toEqual({ a: "visit", b: "visit" });
    // The same two visits in Crew view: different crews, so no crew is double-booked.
    expect(marks([at("a", "09:00", "11:00", "north"), at("b", "10:00", "12:00", "south")])).toEqual({ a: false, b: false });
  });

  it("doesn't mark visits that only touch, are done or called off, or sit on the nobody row", () => {
    expect(marks([at("a", "09:00", "10:00"), at("b", "10:00", "11:00")], "ana")).toEqual({ a: false, b: false });
    expect(marks([at("done", "09:00", "11:00", null, "completed"), at("next", "10:00", "12:00")], "ana")).toEqual({ done: false, next: false });
    expect(marks([at("a", "09:00", "11:00"), at("b", "10:00", "12:00")], "")).toEqual({ a: false, b: false });
  });

  it("marks a visit when the person's own calendar shows them busy, not someone else's", () => {
    expect(conflictsOf([at("a", "09:00", "11:00")], [busy("ana", "10:00", "10:30")], tz, "ana").get("a")?.conflict).toBe("calendar");
    expect(conflictsOf([at("a", "09:00", "11:00")], [busy(null, "10:00", "10:30")], tz, "ana").get("a")?.conflict).toBe(false);
  });

  it("says which visits clash, for the visit form", () => {
    const draft = at("new", "09:30", "10:30");
    expect(conflictsOf([draft, at("smith", "09:00", "10:00"), at("jones", "13:00", "14:00")], [], tz, "ana").get("new")?.clashes.map((v) => v.id)).toEqual(["smith"]);
  });

  it("checks every day of a multi-day booking, not only the first, for each person on it", () => {
    // Three days at 9:30, Oct 16, 19 and 20 (the weekend skipped).
    const draft = at("new", "09:30", "10:30");
    const on = (id: string, date: string, start: string, end: string, ...people: string[]) => ({
      ...at(id, start, end), starts_at: `${date}T${start}:00-04:00`, ends_at: `${date}T${end}:00-04:00`, scheduled_on: date, assignees: people.map((user_id) => ({ user_id })),
    });
    const visits = [
      on("fri-mow", "2026-10-16", "13:00", "14:00", "ana"),
      on("mon-hedge", "2026-10-19", "09:00", "10:00", "ana", "bo"),
      on("tue-gutters", "2026-10-20", "10:00", "11:00", "bo"),
      // Saturday isn't one of the booking's days, and Ana's Tuesday visit is someone else's time.
      on("sat-mow", "2026-10-17", "09:30", "10:30", "ana"),
      on("tue-cy", "2026-10-20", "09:30", "10:30", "cy"),
    ];
    const found = doubleBookings(draft, ["2026-10-16", "2026-10-19", "2026-10-20"], ["ana", "bo", "dee"], visits, tz);
    expect(found.map(({ id, clashes }) => [id, clashes.map((c) => `${c.day} ${c.id}`)])).toEqual([
      ["ana", ["2026-10-19 mon-hedge"]],
      ["bo", ["2026-10-19 mon-hedge", "2026-10-20 tue-gutters"]],
    ]);
    // One day, as when a visit is changed: only that day's.
    expect(doubleBookings(draft, ["2026-10-16"], ["ana", "bo"], visits, tz)).toEqual([]);
  });
});

describe("other calendars' events in the People view", () => {
  const rows = new Set(["me", "ana"]);

  it("go on their owner's row", () => {
    expect(eventOnRow("ana", "ana", rows)).toBe(true);
    expect(eventOnRow("ana", "me", rows)).toBe(false);
    expect(eventOnRow("ana", "", rows)).toBe(false);
  });

  it("stay on the nobody row with no owner, or an owner who has no row", () => {
    expect(eventOnRow(null, "", rows)).toBe(true);
    expect(eventOnRow(undefined, "ana", rows)).toBe(false);
    expect(eventOnRow("gone", "", rows)).toBe(true);
    expect(eventOnRow("gone", "ana", rows)).toBe(false);
  });
});
