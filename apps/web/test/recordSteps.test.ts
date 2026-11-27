/** A record's ‹ › through the list it was opened from (components/ui/RecordSteps.tsx). */
import { describe, expect, it } from "vitest";
import { listWalk, stepsFor, withWalk } from "../src/components/ui/RecordSteps";

/** A row's link in a list whose rows open these pages, as far as listWalk looks at it. */
const linkIn = (pages: string[] | null) =>
  ({ closest: () => (pages ? { querySelectorAll: () => pages.map((pathname) => ({ pathname })) } : null) }) as unknown as HTMLAnchorElement;

describe("a record's place in its list", () => {
  const walk = ["/quotes/a", "/quotes/b", "/quotes/c"];

  it("says where it is and what's before and after", () => {
    expect(stepsFor(walk, "/quotes/b")).toEqual({ index: 1, count: 3, before: "/quotes/a", after: "/quotes/c" });
    expect(stepsFor(walk, "/quotes/a")).toMatchObject({ before: null, after: "/quotes/b" });
    expect(stepsFor(walk, "/quotes/c")).toMatchObject({ before: "/quotes/b", after: null });
  });

  it("shows nothing without a list, outside it, or with one row", () => {
    expect(stepsFor(null, "/quotes/a")).toBeNull();
    expect(stepsFor(walk, "/quotes/z")).toBeNull();
    expect(stepsFor(["/quotes/a"], "/quotes/a")).toBeNull();
  });

  it("counts a record once in a list that links to it from several rows, so › moves on", () => {
    // Snow's storm log: a row for each storm on each job, all opening the job.
    const storms = listWalk(linkIn(["/jobs/a", "/jobs/b", "/jobs/a", "/jobs/c", "/jobs/b"]));
    expect(storms).toEqual(["/jobs/a", "/jobs/b", "/jobs/c"]);
    expect(stepsFor(storms, "/jobs/a")).toEqual({ index: 0, count: 3, before: null, after: "/jobs/b" });
    expect(stepsFor(storms, "/jobs/b")).toEqual({ index: 1, count: 3, before: "/jobs/a", after: "/jobs/c" });
    // Every row the same record: there's nowhere to step to.
    expect(withWalk(undefined, listWalk(linkIn(["/jobs/a", "/jobs/a"])))).toBeUndefined();
    expect(listWalk(linkIn(null))).toEqual([]);
  });

  it("adds the list to a row's own state, and leaves state it can't add to alone", () => {
    expect(withWalk(undefined, walk)).toEqual({ walk });
    expect(withWalk({ from: "home" }, walk)).toEqual({ from: "home", walk });
    expect(withWalk("tab", walk)).toBe("tab");
    expect(withWalk(undefined, ["/quotes/a"])).toBeUndefined();
  });
});
