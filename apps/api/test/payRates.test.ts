/**
 * The rate each time entry is costed at (services/payRates.ts), for more entries than it used to
 * read: it stopped without a word after 25 pages of 1,000, so in a long report every entry after
 * the first 25,000 was costed at nothing. The database here sends 1,000 rows a request at most, as
 * PostgREST does, and rows in no set order unless one is asked for.
 */
import { describe, expect, it } from "vitest";
import type { Db } from "../src/lib/supabase";
import { timeRates } from "../src/services/payRates";

interface Entry { id: string; company_id: string; user_id: string; job_id: string; started_at: string; labor_rate: number | null }

/** A database with memberships and time entries. `orders` collects how each page of entries was sorted and cut. */
function database(entries: Entry[], orders: string[] = []) {
  const members = [{ company_id: "c1", user_id: "u1", labor_rate: 25 }, { company_id: "c1", user_id: "u2", labor_rate: null }];
  const read = (table: string) => {
    const tests: Array<(row: Record<string, unknown>) => boolean> = [];
    let order: string | null = null;
    let window: [number, number] | null = null;
    const query = {
      select: () => query,
      eq: (column: string, value: unknown) => (tests.push((r) => r[column] === value), query),
      in: (column: string, values: unknown[]) => (tests.push((r) => values.includes(r[column])), query),
      gte: (column: string, value: string) => (tests.push((r) => (r[column] as string) >= value), query),
      lt: (column: string, value: string) => (tests.push((r) => (r[column] as string) < value), query),
      order: (column: string) => ((order = column), query),
      range: (from: number, to: number) => ((window = [from, to]), query),
      then: (resolve: (answer: { data: unknown[]; error: null }) => unknown) => {
        const rows = ((table === "memberships" ? members : entries) as unknown as Array<Record<string, unknown>>).filter((r) => tests.every((t) => t(r)));
        // No order asked: whichever way round the database likes, here backwards.
        const sorted = order ? [...rows].sort((a, b) => String(a[order!]).localeCompare(String(b[order!]))) : [...rows].reverse();
        if (table === "time_entries") orders.push(`${order} ${window?.join("-")}`);
        const from = window?.[0] ?? 0;
        return Promise.resolve({ data: sorted.slice(from, Math.min((window?.[1] ?? Infinity) + 1, from + 1000)), error: null }).then(resolve);
      },
    };
    return query;
  };
  return { from: read } as unknown as Db;
}

const entry = (n: number, more: Partial<Entry> = {}): Entry => ({ id: `t${String(n).padStart(6, "0")}`, company_id: "c1", user_id: "u1", job_id: `j${n % 3}`, started_at: "2026-10-05T12:00:00.000Z", labor_rate: null, ...more });

describe("the rate each time entry is costed at", () => {
  it("is the rate it was approved at, else the person's rate now, else none", async () => {
    const rates = await timeRates(database([entry(1, { labor_rate: 30 }), entry(2), entry(3, { user_id: "u2" }), entry(4, { company_id: "c2" })]), "c1", { from: "2026-10-01T00:00:00.000Z", to: "2026-11-01T00:00:00.000Z" });
    expect(rates).toEqual({ t000001: 30, t000002: 25 });
  });

  it("reads past 25,000 entries, to the last one", async () => {
    const orders: string[] = [];
    const rates = await timeRates(database(Array.from({ length: 26_500 }, (_, n) => entry(n)), orders), "c1", { from: "2026-10-01T00:00:00.000Z", to: "2026-11-01T00:00:00.000Z" });
    expect(Object.keys(rates)).toHaveLength(26_500);
    expect(rates.t026499).toBe(25);
    // 27 pages, each sorted by id.
    expect(orders).toHaveLength(27);
    expect(orders[0]).toBe("id 0-999");
    expect(orders.at(-1)).toBe("id 26000-26999");
  });

  it("reads some jobs' entries only, and the dates' only", async () => {
    const entries = [...Array.from({ length: 1500 }, (_, n) => entry(n)), entry(9000, { started_at: "2026-09-30T12:00:00.000Z" })];
    expect(Object.keys(await timeRates(database(entries), "c1", { job_ids: ["j0"] }))).toHaveLength(501);
    expect(Object.keys(await timeRates(database(entries), "c1", { from: "2026-10-01T00:00:00.000Z", to: "2026-11-01T00:00:00.000Z" }))).toHaveLength(1500);
  });
});
