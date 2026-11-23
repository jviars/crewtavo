/** The line over the schedule's board while a filter is on (features/schedule/filterLine.ts). */
import { describe, expect, it } from "vitest";
import { filterLine } from "../src/features/schedule/filterLine";

describe("the schedule's filter line", () => {
  it("says nothing with no filter on", () => {
    expect(filterLine("", "me", "Everyone")).toBeNull();
  });

  it("says whose visits, and the way back to everyone's", () => {
    expect(filterLine("luis", "me", "Luis Ortega")).toEqual({ text: "Showing Luis Ortega's visits", clear: "Show everyone" });
    expect(filterLine("me", "me", "You")).toEqual({ text: "Showing your visits", clear: "Show everyone" });
    expect(filterLine("none", "me", "Nobody assigned")).toEqual({ text: "Showing visits with nobody assigned", clear: "Show everyone" });
  });

  it("says which crew, and both when both are on", () => {
    expect(filterLine("", "me", "Everyone", "Paving crew")).toEqual({ text: "Showing Paving crew's visits", clear: "Show all crews" });
    expect(filterLine("luis", "me", "Luis Ortega", "Paving crew")).toEqual({ text: "Showing Luis Ortega's visits on Paving crew", clear: "Show all visits" });
    expect(filterLine("me", "me", "You", "Paving crew")?.text).toBe("Showing your visits on Paving crew");
    expect(filterLine("none", "me", "Nobody assigned", "Paving crew")?.text).toBe("Showing Paving crew's visits with nobody assigned");
  });
});
