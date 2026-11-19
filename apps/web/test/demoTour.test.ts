/**
 * The demo's guided tour (features/demo/Tour.tsx): the same for every trade, pointing to Apps for
 * what's a trade's own, and each step at something the app has.
 */
import { describe, expect, it } from "vitest";
import { tourSteps } from "../src/features/demo/Tour";

describe("the demo's tour", () => {
  it("welcomes the visitor by their business, and ends on getting Crewtavo", () => {
    const tour = tourSteps("Greenway Lawn Care");
    expect(tour[0]!.title).toBe("Welcome to Greenway Lawn Care");
    expect(tour.at(-1)!.target).toBe('[data-tour="get"]');
  });

  it("is the same for every trade, and sends a trade's own to Apps", () => {
    const tour = tourSteps("x");
    const apps = tour.find((s) => s.to === "/apps");
    expect(apps?.target).toBe('a[href="/apps"]');
    expect(apps?.body).toMatch(/snow removal, paving takeoffs, roofing/);
    expect(tour.some((s) => s.to === "/snow")).toBe(false);
  });

  it("points at the crew's phone and the client's view in the demo bar", () => {
    const targets = tourSteps("x").map((s) => s.target);
    expect(targets).toContain('[data-tour="crew"]');
    expect(targets).toContain('[data-tour="client"]');
  });
});
