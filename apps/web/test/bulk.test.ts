/** Bulk actions on the list pages (lib/bulk.ts): picking rows, writing them in chunks, and what's said after. */
import { describe, expect, it, vi } from "vitest";
import { remindInChunks } from "../src/features/invoices/InvoicesPage";
import { bulkOutcome, inChunks, mergeResults, NOT_CHANGED, pageState, pickedOnPage, toggleAll, toggleOne } from "../src/lib/bulk";
import { ApiError, OFFLINE } from "../src/lib/errors";

const page = ["a", "b", "c"];
const words = { verb: "archived", one: "job", many: "jobs", name: (id: string) => `#${id}` };

describe("picking rows on a page", () => {
  it("keeps the page's order and only what's on it", () => {
    expect(pickedOnPage(new Set(["c", "x", "a"]), page)).toEqual(["a", "c"]);
  });

  it("says whether none, some or all of the page are picked", () => {
    expect(pageState(new Set(), page)).toBe("none");
    expect(pageState(new Set(["b", "elsewhere"]), page)).toBe("some");
    expect(pageState(new Set(page), page)).toBe("all");
    expect(pageState(new Set(), [])).toBe("none");
  });

  it("select all picks the rest of the page, then none of it", () => {
    const some = toggleAll(new Set(["b"]), page);
    expect([...some].sort()).toEqual(page);
    expect([...toggleAll(some, page)]).toEqual([]);
  });

  it("toggles one row without touching the others", () => {
    const picked = new Set(["a"]);
    expect([...toggleOne(picked, "b")].sort()).toEqual(["a", "b"]);
    expect([...toggleOne(picked, "a")]).toEqual([]);
    expect([...picked]).toEqual(["a"]);
  });
});

describe("writing in chunks", () => {
  it("sends the ids a chunk at a time, and one the write left out failed", async () => {
    const write = vi.fn(async (chunk: string[]) => chunk.filter((id) => id !== "e"));
    const result = await inChunks(["a", "b", "c", "d", "e"], write, undefined, 2);
    expect(write.mock.calls.map((c) => c[0])).toEqual([["a", "b"], ["c", "d"], ["e"]]);
    expect(result.done).toEqual(["a", "b", "c", "d"]);
    expect(result.failed).toEqual([{ id: "e", reason: NOT_CHANGED }]);
  });

  it("tries a refused chunk an id at a time, so one refusal doesn't stop the rest", async () => {
    const write = vi.fn(async (chunk: string[]) => {
      if (chunk.includes("b")) throw new ApiError("It's being charged now.", 400);
      return chunk;
    });
    const result = await inChunks(["a", "b", "c", "d"], write, undefined, 3);
    expect(result.done.sort()).toEqual(["a", "c", "d"]);
    expect(result.failed).toEqual([{ id: "b", reason: "It's being charged now." }]);
  });

  it("offline, says so for the chunk rather than trying each, and goes on to the next", async () => {
    const write = vi.fn(async (chunk: string[]) => {
      if (chunk[0] === "a") throw new ApiError(OFFLINE, 0, "network");
      return chunk;
    });
    const result = await inChunks(["a", "b", "c"], write, undefined, 2);
    expect(write).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ done: ["c"], failed: [{ id: "a", reason: OFFLINE }, { id: "b", reason: OFFLINE }] });
  });
});

describe("what's said after", () => {
  it("says how many when all of them worked", () => {
    expect(bulkOutcome({ done: ["a", "b"], failed: [] }, words)).toEqual({ kind: "success", title: "2 jobs archived" });
    expect(bulkOutcome({ done: ["a"], failed: [] }, words)).toEqual({ kind: "success", title: "1 job archived" });
  });

  it("says how many didn't and why, grouped by reason", () => {
    const outcome = bulkOutcome({ done: ["a"], failed: [{ id: "b", reason: "Already archived" }, { id: "c", reason: "You don't have permission to do that." }, { id: "d", reason: "Already archived" }] }, words);
    expect(outcome).toEqual({ kind: "warning", title: "1 job archived, 3 not", description: "#b, #d: Already archived. #c: You don't have permission to do that." });
  });

  it("is an error when none worked, and names five at most per reason", () => {
    const failed = ["a", "b", "c", "d", "e", "f", "g"].map((id) => ({ id, reason: "Nope" }));
    expect(bulkOutcome({ done: [], failed }, words)).toEqual({ kind: "error", title: "7 jobs not archived", description: "#a, #b, #c, #d, #e and 2 more: Nope." });
  });

  it("after an Undo toast said the count, only tells what didn't work", () => {
    expect(bulkOutcome({ done: ["a", "b"], failed: [] }, words, true)).toBeNull();
    expect(bulkOutcome(mergeResults({ done: ["a"], failed: [] }, { done: [], failed: [{ id: "b", reason: "It became a job" }] }), words, true)).toEqual({
      kind: "warning",
      title: "1 of 2 jobs not archived",
      description: "#b: It became a job.",
    });
    expect(bulkOutcome({ done: [], failed: [{ id: "a", reason: "Nope" }] }, words, true)?.kind).toBe("error");
  });
});

describe("payment reminders for picked invoices", () => {
  const inv = (id: string, number: number, status = "sent", balance_due = 100) => ({ id, number, status, balance_due });

  it("sends only those still owed, and says why the server skipped any", async () => {
    const post = vi.fn(async () => ({ sent: 1, skipped: [{ number: 2, reason: "A bank payment is on its way" }] }));
    const result = await remindInChunks([inv("a", 1), inv("b", 2, "overdue"), inv("c", 3, "partially_paid", 0), inv("d", 4, "draft")], post, async () => []);
    expect(post).toHaveBeenCalledWith(["a", "b"]);
    expect(result.done).toEqual(["a"]);
    expect(result.failed).toEqual([
      { id: "c", reason: "Nothing owed on it" },
      { id: "d", reason: "Not sent yet" },
      { id: "b", reason: "A bank payment is on its way" },
    ]);
  });

  it("looks up one the server left out without a word (paid since the list loaded)", async () => {
    const stillOwed = vi.fn(async () => ["a"]);
    const result = await remindInChunks([inv("a", 1), inv("b", 2)], async () => ({ sent: 1, skipped: [] }), stillOwed);
    expect(stillOwed).toHaveBeenCalledWith(["a", "b"]);
    expect(result).toEqual({ done: ["a"], failed: [{ id: "b", reason: "Nothing owed on it any more" }] });
  });

  it("a chunk that fails is said for each in it, and not tried again", async () => {
    const post = vi.fn(async () => {
      throw new ApiError("Email isn't set up.", 400);
    });
    const result = await remindInChunks([inv("a", 1), inv("b", 2)], post, async () => []);
    expect(post).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ done: [], failed: [{ id: "a", reason: "Email isn't set up." }, { id: "b", reason: "Email isn't set up." }] });
  });
});
