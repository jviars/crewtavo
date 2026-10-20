import { describe, expect, it } from "vitest";
import { guideFinder } from "../src/features/kb/finder";

describe("finding guides as you type", () => {
  const find = guideFinder(
    [
      { id: "seal", title: "Sealcoat application", tags: ["asphalt"], category_id: "paving" },
      { id: "fuel", title: "Fueling mowers", tags: ["safety"], category_id: null },
      { id: "crack", title: "Crack filling", tags: ["asphalt", "repair"], category_id: "paving" },
    ],
    [{ id: "paving", name: "Paving" }],
  );

  it("matches part of a word and small typos", () => {
    expect(find("seal")).toEqual(["seal"]);
    expect(find("sealcot")).toEqual(["seal"]);
  });

  it("matches tags and the category, title matches first", () => {
    expect(find("asph")).toEqual(expect.arrayContaining(["seal", "crack"]));
    expect(find("paving")).toEqual(expect.arrayContaining(["seal", "crack"]));
    expect(find("crack asphalt")[0]).toBe("crack");
  });

  it("needs every word to match", () => {
    expect(find("fuel safety")).toEqual(["fuel"]);
    expect(find("fuel paving")).toEqual([]);
  });
});
