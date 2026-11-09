import { describe, expect, it } from "vitest";
import { onSiteReason } from "../src/features/roofing/flow/MeasureOnSite";
import { parseZips, zipKey } from "../src/features/settings/salesAreas";

describe("sales area zips", () => {
  it("keeps a zip the way the database matches it", () => {
    expect(zipKey("46032-1234")).toBe("46032");
    expect(zipKey(" 46201 ")).toBe("46201");
    expect(zipKey("462")).toBe("462");
    expect(zipKey("k1a 0b6")).toBe("K1A0B6");
  });

  it("reads whole zips and first digits, split by commas, spaces between numbers, or lines", () => {
    expect(parseZips("46201, 46202 462\n46032-1234; 46201")).toEqual({ zips: ["46201", "46202", "462", "46032"], bad: [] });
    expect(parseZips("K1A 0B6, k1b")).toEqual({ zips: ["K1A0B6", "K1B"], bad: [] });
    expect(parseZips("")).toEqual({ zips: [], bad: [] });
    expect(parseZips("46201, #, ABCDEFGHIJK")).toEqual({ zips: ["46201"], bad: ["#", "ABCDEFGHIJK"] });
    // Nine digits is a zip and its +4, like the database reads a property's.
    expect(parseZips("462011234")).toEqual({ zips: ["46201"], bad: [] });
  });
});

describe("why a roof is measured on site", () => {
  it("says the reason, with the note after it", () => {
    expect(onSiteReason("Trees cover the roof", "")).toBe("Trees cover the roof");
    expect(onSiteReason("Trees cover the roof", " back half under the oaks ")).toBe("Trees cover the roof. back half under the oaks");
    expect(onSiteReason("Something else", "Solar panels hide the ridge")).toBe("Solar panels hide the ridge");
    expect(onSiteReason("Something else", "  ")).toBe("");
  });
});
