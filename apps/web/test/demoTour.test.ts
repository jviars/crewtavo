/**
 * The demo's guided tour (features/demo/Tour.tsx): every trade gets one, written for lawn care,
 * roofing and paving, and each step points at something the app has.
 */
import { DEMO_TRADES } from "@crewtavo/core/demo";
import { describe, expect, it } from "vitest";
import { tourSteps } from "../src/features/demo/Tour";

describe("the demo's tour", () => {
  it("welcomes the visitor by their business, and ends on getting Crewtavo", () => {
    const tour = tourSteps("lawn_exterior", "Greenway Lawn Care");
    expect(tour[0]!.title).toBe("Welcome to Greenway Lawn Care");
    expect(tour.at(-1)!.target).toBe('[data-tour="get"]');
  });

  it("shows lawn care its snow removal", () => {
    expect(tourSteps("lawn_exterior", "x").some((s) => s.to === "/snow" && s.target === 'a[href="/snow"]')).toBe(true);
    expect(tourSteps("paving", "x").some((s) => s.to === "/snow")).toBe(false);
  });

  it("has steps of its own for each trade the start screen asks about, and a general one for the rest", () => {
    const general = tourSteps("hvac", "x").map((s) => s.title);
    for (const { preset } of DEMO_TRADES) expect(tourSteps(preset, "x").map((s) => s.title)).not.toEqual(general);
    expect(tourSteps("pool_service", "x").map((s) => s.title)).toEqual(general);
  });

  it("points at the crew's phone and the client's view in the demo bar", () => {
    const targets = tourSteps("roofing_exteriors", "x").map((s) => s.target);
    expect(targets).toContain('[data-tour="crew"]');
    expect(targets).toContain('[data-tour="client"]');
  });
});
