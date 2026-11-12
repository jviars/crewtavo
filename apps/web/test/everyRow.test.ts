/**
 * Reading a whole list a page at a time (lib/everyRow.ts): the API hands over 1,000 rows a request at
 * most, so a list longer than that used to come back cut short with nothing to say so.
 */
import { describe, expect, it } from "vitest";
import { everyRow, type RowPage } from "../src/lib/everyRow";

/** A table of `total` rows behind an API that hands over `cap` rows a request at most, with or without the count. */
function table(total: number, cap: number, counted = true) {
  const rows = Array.from({ length: total }, (_, i) => ({ n: i }));
  const asked: Array<[number, number]> = [];
  const page = async (from: number, to: number): Promise<RowPage<{ n: number }>> => {
    asked.push([from, to]);
    return { data: rows.slice(from, Math.min(to + 1, from + cap)), error: null, count: counted ? total : null };
  };
  return { page, asked };
}

describe("reading every row of a list", () => {
  it("reads past the 1,000 rows one request hands over", async () => {
    const { page, asked } = table(2500, 1000);
    const rows = await everyRow(page);
    expect(rows.map((r) => r.n)).toEqual(Array.from({ length: 2500 }, (_, i) => i));
    expect(asked).toEqual([[0, 999], [1000, 1999], [2000, 2999]]);
  });

  it("is one request for a list that fits, and for one that fills a page exactly", async () => {
    const short = table(3, 1000);
    expect(await everyRow(short.page)).toHaveLength(3);
    expect(short.asked).toHaveLength(1);
    const full = table(1000, 1000);
    expect(await everyRow(full.page)).toHaveLength(1000);
    expect(full.asked).toHaveLength(1);
    const none = table(0, 1000);
    expect(await everyRow(none.page)).toEqual([]);
    expect(none.asked).toHaveLength(1);
  });

  it("doesn't take a short page for the end: a server that hands over fewer rows is still read to the end", async () => {
    const { page } = table(1200, 500);
    expect(await everyRow(page)).toHaveLength(1200);
  });

  it("without a count, carries on until a page comes back empty", async () => {
    const { page, asked } = table(1200, 500, false);
    expect(await everyRow(page)).toHaveLength(1200);
    expect(asked.at(-1)).toEqual([1200, 2199]);
  });

  it("fails as a whole when a page fails, rather than passing off part of the list as all of it", async () => {
    const { page } = table(2500, 1000);
    const failing = async (from: number, to: number) => (from === 0 ? page(from, to) : { data: null, error: { message: "canceling statement due to statement timeout", code: "57014" }, count: null });
    await expect(everyRow(failing)).rejects.toThrow();
  });

  it("stops when rows deleted meanwhile leave the next page past the end", async () => {
    const { page } = table(2500, 1000);
    const shrunk = async (from: number, to: number) => (from < 2000 ? page(from, to) : { data: null, error: { message: "Requested range not satisfiable", code: "PGRST103" }, count: null });
    expect(await everyRow(shrunk)).toHaveLength(2000);
  });
});
