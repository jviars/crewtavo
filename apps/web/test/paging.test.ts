/**
 * Reading long results a page at a time (lib/paging.ts), against a database that sends 1,000 rows a
 * request at most and sends ties in any order (fakeDb.ts): every row comes back once, in order, a
 * read that goes past its ceiling says so, and "Load more" keeps going past the first 1,000.
 */
import { describe, expect, it } from "vitest";
import { ApiError } from "../src/lib/errors";
import { everyRow, firstRows, MOST_ROWS, PAGE_ROWS, TooManyRows, type PagedQuery } from "../src/lib/paging";
import { FakeDb, MAX_ROWS, type Row } from "./fakeDb";

interface Entry { id: string; company_id: string; day: string; hours: number }
const id = (n: number) => `e${String(n).padStart(5, "0")}`;
/** `count` time entries over ten days, so a day has hundreds that tie. */
const entries = (count: number): Entry[] => Array.from({ length: count }, (_, i) => ({ id: id(i), company_id: "c1", day: `2026-11-${String(1 + (i % 10)).padStart(2, "0")}`, hours: 1 + (i % 8) }));
const reading = (db: FakeDb) => () => db.from("time_entries").select("id, day, hours").eq("company_id", "c1") as unknown as PagedQuery<Entry>;
const ids = (rows: ReadonlyArray<{ id: string }>) => rows.map((r) => r.id);

describe("the fake database", () => {
  it("sends 1,000 rows at most, whatever limit is asked for", async () => {
    const db = new FakeDb({ time_entries: entries(2500) });
    expect((await db.from("time_entries").select("id").limit(5000)).data).toHaveLength(MAX_ROWS);
    expect((await db.from("time_entries").select("id").order("id").range(0, 4999)).data).toHaveLength(MAX_ROWS);
    expect((await db.from("time_entries").select("id").order("id").range(2000, 2999)).data).toHaveLength(500);
  });

  it("loses rows for a read that pages without an order, or by a column with ties", async () => {
    const db = new FakeDb({ time_entries: entries(2500) });
    // As the old private helpers read: offsets, and whatever order the database felt like.
    const paged = async (query: () => { range(from: number, to: number): PromiseLike<{ data: Row[] | null }> }) => {
      const rows: Row[] = [];
      for (let from = 0; ; from += 1000) {
        const page = (await query().range(from, from + 999)).data!;
        rows.push(...page);
        if (page.length < 1000) return rows;
      }
    };
    const unordered = await paged(() => db.from("time_entries").select("id"));
    expect(unordered).toHaveLength(2500);
    expect(new Set(unordered.map((r) => r.id)).size).toBeLessThan(2500);
    const tied = await paged(() => db.from("time_entries").select("id").order("hours"));
    expect(new Set(tied.map((r) => r.id)).size).toBeLessThan(2500);
  });
});

describe("reading every row", () => {
  it("brings back each row once, in id order, across pages", async () => {
    const all = entries(2500);
    const db = new FakeDb({ time_entries: all, other: [] });
    const rows = await everyRow(reading(db));
    expect(ids(rows)).toEqual(ids(all));
    expect(db.requests.map((r) => [r.order, r.from, r.to, r.sent])).toEqual([["id.asc", 0, 999, 1000], ["id.asc", 1000, 1999, 1000], ["id.asc", 2000, 2999, 500]]);
  });

  it("sorts as asked, with the id after it to settle ties", async () => {
    const all = entries(2500);
    const db = new FakeDb({ time_entries: all });
    // Eight different hours among 2,500 entries: each page ends among rows that tie.
    const rows = await everyRow(reading(db), { order: { column: "hours", ascending: false } });
    expect(ids(rows)).toEqual(ids([...all].sort((a, b) => b.hours - a.hours || a.id.localeCompare(b.id))));
    expect(new Set(db.requests.map((r) => r.order))).toEqual(new Set(["hours.desc,id.asc"]));
    // The id isn't asked for twice when the order already has it.
    await everyRow(reading(db), { order: ["day", { column: "id", ascending: false }] });
    expect(db.requests.at(-1)!.order).toBe("day.asc,id.desc");
  });

  it("asks once when there's a page or less, and once more when a page comes back full", async () => {
    const db = new FakeDb({ time_entries: entries(40) });
    expect(await everyRow(reading(db))).toHaveLength(40);
    expect(db.requests).toHaveLength(1);
    const full = new FakeDb({ time_entries: entries(PAGE_ROWS) });
    expect(await everyRow(reading(full))).toHaveLength(PAGE_ROWS);
    expect(full.requests.map((r) => r.sent)).toEqual([1000, 0]);
    expect(await everyRow(reading(new FakeDb({ time_entries: [] })))).toEqual([]);
  });

  it("reads a table without an id by the columns that tell its rows apart", async () => {
    const pairs = Array.from({ length: 1200 }, (_, i) => ({ visit_id: `v${String(i % 400).padStart(3, "0")}`, user_id: `u${Math.floor(i / 400)}` }));
    const db = new FakeDb({ visit_assignees: pairs });
    const query = () => db.from("visit_assignees").select("visit_id, user_id") as unknown as PagedQuery<(typeof pairs)[number]>;
    const rows = await everyRow(query, { key: ["visit_id", "user_id"] });
    expect(new Set(rows.map((r) => `${r.visit_id} ${r.user_id}`)).size).toBe(1200);
    expect(db.requests[0]!.order).toBe("visit_id.asc,user_id.asc");
    // Left to sort by an id it doesn't have, the database refuses, and so does the read.
    await expect(everyRow(query)).rejects.toBeInstanceOf(ApiError);
  });

  it("says so when there's more than it may read, rather than handing back part of it", async () => {
    const db = new FakeDb({ time_entries: entries(2500) });
    const failure = await everyRow(reading(db), { most: 2000 }).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(TooManyRows);
    expect((failure as TooManyRows).message).toBe("That's more than 2,000 records, too many to read at once. Try a shorter date range.");
    // Not retried or reported as a fault: it's a 4xx the screen shows.
    expect((failure as TooManyRows).status).toBe(400);
    // Exactly as many as it may read is fine, and so is any number when everything is wanted.
    expect(await everyRow(reading(db), { most: 2500 })).toHaveLength(2500);
    expect(await everyRow(reading(new FakeDb({ time_entries: entries(2000) })), { most: 2000 })).toHaveLength(2000);
    expect(await everyRow(reading(db), { most: Infinity })).toHaveLength(2500);
    expect(MOST_ROWS).toBe(100_000);
  });

  it("fails when a page fails, in words for people", async () => {
    const db = new FakeDb({ time_entries: entries(2500) });
    db.beforeAnswer = (answered) => {
      if (answered === 1) db.failing = { message: "permission denied for table time_entries", code: "42501" };
    };
    await expect(everyRow(reading(db))).rejects.toThrow("You don't have permission to do that.");
  });
});

describe("the first rows of a list (Load more)", () => {
  const listing = (db: FakeDb) => () => db.from("time_entries").select("id, day, hours", { count: "exact" }).eq("company_id", "c1") as unknown as PagedQuery<Entry>;

  it("reads just what's asked, and how many there are in all", async () => {
    const all = entries(2500);
    const db = new FakeDb({ time_entries: all });
    const { rows, total } = await firstRows(listing(db), 50);
    expect(ids(rows)).toEqual(ids(all.slice(0, 50)));
    expect(total).toBe(2500);
    expect(db.requests.map((r) => [r.from, r.to])).toEqual([[0, 49]]);
  });

  it("keeps going past the first 1,000", async () => {
    const all = entries(2500);
    const db = new FakeDb({ time_entries: all });
    const sorted = [...all].sort((a, b) => b.hours - a.hours || a.id.localeCompare(b.id));
    const { rows, total } = await firstRows(listing(db), 1050, { order: { column: "hours", ascending: false } });
    expect(ids(rows)).toEqual(ids(sorted.slice(0, 1050)));
    expect(total).toBe(2500);
    expect(db.requests.map((r) => [r.from, r.to])).toEqual([[0, 999], [1000, 1049]]);
    expect((await firstRows(listing(db), 2400)).rows).toHaveLength(2400);
  });

  it("stops at the last row without asking again", async () => {
    const db = new FakeDb({ time_entries: entries(PAGE_ROWS) });
    const { rows, total } = await firstRows(listing(db), 1050);
    expect(rows).toHaveLength(1000);
    expect(total).toBe(1000);
    expect(db.requests).toHaveLength(1);
    // Without a count there's no total, and a full page is followed by one more look.
    const uncounted = await firstRows(reading(db), 1050);
    expect(uncounted).toMatchObject({ total: null });
    expect(uncounted.rows).toHaveLength(1000);
  });

  it("ends quietly when rows went while it was reading", async () => {
    const db = new FakeDb({ time_entries: entries(2000) });
    db.beforeAnswer = (answered) => {
      if (answered === 1) db.tables.time_entries = db.tables.time_entries!.slice(0, 900);
    };
    const { rows } = await firstRows(listing(db), 1500);
    expect(rows).toHaveLength(1000);
  });
});
