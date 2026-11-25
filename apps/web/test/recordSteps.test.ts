/** A record's ‹ › through the list it was opened from (components/ui/RecordSteps.tsx). */
import { describe, expect, it } from "vitest";
import { stepsFor, withWalk } from "../src/components/ui/RecordSteps";

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

  it("adds the list to a row's own state, and leaves state it can't add to alone", () => {
    expect(withWalk(undefined, walk)).toEqual({ walk });
    expect(withWalk({ from: "home" }, walk)).toEqual({ from: "home", walk });
    expect(withWalk("tab", walk)).toBe("tab");
    expect(withWalk(undefined, ["/quotes/a"])).toBeUndefined();
  });
});
