/**
 * Quote templates stay out of the Quotes list's counts (only their own tab counts them), and a
 * deposit asked for as a percent is worked out on what the client chooses.
 */
import { describe, expect, it, vi } from "vitest";
import { depositToBook } from "../src/features/hub/document";
import { depositAsPercent } from "../src/features/quotes/QuotePage";
import { statusCount } from "../src/lib/listing";

// Each count's filters, as the query was built.
const asked = vi.hoisted(() => [] as Array<{ table: string; filters: string[] }>);
vi.mock("../src/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/api")>()),
  supabase: () => ({
    from: (table: string) => {
      const filters: string[] = [];
      asked.push({ table, filters });
      const query = {
        select: () => query,
        eq: (column: string, value: unknown) => (filters.push(`${column}=${value}`), query),
        in: (column: string, values: string[]) => (filters.push(`${column} in ${values.join(",")}`), query),
        filter: (column: string, op: string, value: unknown) => (filters.push(`${column} ${op} ${value}`), query),
        then: (resolve: (r: unknown) => unknown) => resolve({ count: 3, error: null }),
      };
      return query;
    },
  }),
}));

describe("quote templates in the Quotes list", () => {
  it("count only on their own tab", async () => {
    asked.length = 0;
    expect(await statusCount("quotes", "co", "draft", ["draft"])).toBe(3);
    await statusCount("quotes", "co", "open", ["draft", "sent", "changes_requested", "approved"]);
    await statusCount("quotes", "co", "templates", ["draft"]);
    expect(asked.map((a) => a.filters)).toEqual([
      ["company_id=co", "status in draft", "is_template eq false"],
      ["company_id=co", "status in draft,sent,changes_requested,approved", "is_template eq false"],
      ["company_id=co", "status in draft", "is_template eq true"],
    ]);
  });

  it("aren't a filter on the other lists", async () => {
    asked.length = 0;
    await statusCount("jobs", "co", "late", ["late"], "job_state");
    await statusCount("invoices", "co", "all", null);
    expect(asked.map((a) => a.filters)).toEqual([["company_id=co", "job_state in late"], ["company_id=co"]]);
  });
});

describe("a deposit as a percent", () => {
  it("is booked on what the client chooses, to the cent", () => {
    expect(depositToBook(275, 1466.66, 25)).toBe(366.67);
    // A cheaper option comes to less, and so does its deposit.
    expect(depositToBook(275, 800, 25)).toBe(200);
    expect(depositToBook(0, 1320, 33.33)).toBe(439.96);
    expect(depositToBook(500, 0, 25)).toBe(0);
  });

  it("is an amount as before without one, never above the total", () => {
    expect(depositToBook(1000, 14290.5, null)).toBe(1000);
    expect(depositToBook("5000.00", 4200)).toBe(4200);
  });

  it("starts at the percent the amount already asked for, when the office switches to one", () => {
    expect(depositAsPercent(275, 1100)).toBe(25);
    expect(depositAsPercent(100, 300)).toBe(33.33);
    expect(depositAsPercent(5000, 4200)).toBe(100);
    expect(depositAsPercent(100, 0)).toBe(0);
  });
});
