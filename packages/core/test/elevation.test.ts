/// <reference lib="dom" />
import { afterEach, describe, expect, it, vi } from "vitest";
import { readSlope, slopeFrom, slopeFromGrid, slopeGrid } from "../src/elevation";
import { pickedSlope } from "../src/lawn";
import { summarizeFeatureCollection } from "../src/geo";

const yard = (lng: number, lat: number) => ({ type: "Polygon", coordinates: [[[lng, lat], [lng + 0.0004, lat], [lng + 0.0004, lat + 0.0003], [lng, lat + 0.0003], [lng, lat]]] });

describe("Lawn slope from USGS", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("counts how much of the lawn is steeper than 3:1", () => {
    // Four bins from 0 to 40%: the last runs from 30 to 40, so 0.67 of its 30 is past 33.3%.
    const slope = slopeFrom({ statistics: [{ mean: 12.345, count: 100 }], histograms: [{ min: 0, max: 40, counts: [40, 30, 0, 30] }] });
    expect(slope).toEqual({ mean_pct: 12.3, steep_pct: 20.1 });
    // Every pixel at one grade: all of it or none of it.
    expect(slopeFrom({ statistics: [{ mean: 50, count: 9 }], histograms: [{ min: 50, max: 50, counts: [9] }] })?.steep_pct).toBe(100);
    // Nothing back (outside USGS's elevation): no reading.
    expect(slopeFrom({ statistics: [], histograms: [] })).toBeNull();
    expect(slopeFrom({ statistics: [{ mean: 0, count: 0 }], histograms: [{ min: 0, max: 0, counts: [0] }] })).toBeNull();
  });

  it("asks USGS for the lawn less its cutouts, and nothing outside the US", async () => {
    const fetch = vi.fn(async () => Response.json({ statistics: [{ mean: 3, count: 4 }], histograms: [{ min: 1, max: 5, counts: [2, 2] }] }));
    vi.stubGlobal("fetch", fetch);
    const lawn = yard(-79.87, 37.05);
    const house = { type: "Polygon", coordinates: [[[-79.8699, 37.0501], [-79.8698, 37.0501], [-79.8698, 37.0502], [-79.8699, 37.0502], [-79.8699, 37.0501]]] };
    expect(await readSlope(lawn, [house])).toEqual({ mean_pct: 3, steep_pct: 0 });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, { method: string; body: string }];
    const form = new URLSearchParams(init.body);
    expect(url).toMatch(/3DEPElevation\/ImageServer\/computeStatisticsHistograms$/);
    expect(init.method).toBe("POST");
    // The house goes as a hole in the lawn.
    expect(JSON.parse(form.get("geometry")!).rings).toHaveLength(2);
    expect(JSON.parse(form.get("renderingRule")!).rasterFunction).toBe("Slope");

    expect(await readSlope(yard(-0.13, 51.5), [])).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("is only asked inside the United States: nothing for a place the address or the business says is abroad", async () => {
    const fetch = vi.fn(async () => Response.json({ statistics: [{ mean: 2.3, count: 4 }], histograms: [{ min: 1, max: 5, counts: [2, 2] }] }));
    vi.stubGlobal("fetch", fetch);
    // USGS answers for Toronto with coarse numbers that look real: a Canadian address or business gets no reading, to pick one or ask Google.
    const toronto = yard(-79.3832, 43.6532);
    expect(await readSlope(toronto, [], { country: "CA" })).toBeNull();
    expect(await readSlope(yard(-100.31, 25.67), [], { country: "MX" })).toBeNull(); // Monterrey
    // Even on the US side of the line, when the place is said to be abroad.
    expect(await readSlope(yard(-79.87, 37.05), [], { country: "ca" })).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
    // Abroad by where it is, whatever country is given or not: Edmonton, Mexico City, Havana, London.
    for (const [lng, lat] of [[-113.49, 53.54], [-99.13, 19.43], [-82.38, 23.13], [-0.13, 51.5]]) {
      expect(await readSlope(yard(lng, lat), [])).toBeNull();
      expect(await readSlope(yard(lng, lat), [], { country: "US" })).toBeNull();
    }
    expect(fetch).not.toHaveBeenCalled();
    // The United States, as before: the states, Puerto Rico and the US Virgin Islands, with the US or no country given.
    const us = [[-79.87, 37.05], [-81.8, 24.555], [-124.7, 48.37], [-67.0, 44.81], [-95.15, 49.36], [-149.9, 61.2], [-130.03, 55.91], [-157.86, 21.3], [-66.1, 18.4], [-64.75, 17.72]];
    for (const [lng, lat] of us) expect(await readSlope(yard(lng, lat), [], { country: lng > -64.9 ? "VI" : lng > -67 && lat < 19 ? "PR" : "US" })).toEqual({ mean_pct: 2.3, steep_pct: 0 });
    expect(await readSlope(yard(-79.87, 37.05), [])).not.toBeNull();
    expect(await readSlope(yard(-79.87, 37.05), [], { country: null })).not.toBeNull();
    expect(fetch).toHaveBeenCalledTimes(us.length + 2);
    // A box can't tell Windsor from Detroit, so with no country (or the US) given, just over the line is still asked.
    expect(await readSlope(toronto, [])).not.toBeNull();
  });

  it("tries again when USGS times out, and says so after three tries", async () => {
    vi.useFakeTimers();
    try {
      const fetch = vi.fn(async () => Response.json({ statistics: [{ mean: 3, count: 4 }], histograms: [{ min: 1, max: 5, counts: [2, 2] }] }));
      vi.stubGlobal("fetch", fetch);
      // A gateway time-out reaches the browser as a failed fetch.
      fetch.mockRejectedValueOnce(new TypeError("Failed to fetch"));
      const later = readSlope(yard(-79.87, 37.05), []);
      await vi.advanceTimersByTimeAsync(1500);
      expect(await later).toEqual({ mean_pct: 3, steep_pct: 0 });
      expect(fetch).toHaveBeenCalledTimes(2);

      // An error from USGS every time is a failed read, not a flat lawn.
      fetch.mockImplementation(async () => Response.json({ error: { message: "Unable to complete operation." } }));
      const failing = expect(readSlope(yard(-79.87, 37.05), [])).rejects.toThrow("Unable to complete");
      await vi.advanceTimersByTimeAsync(1500 + 3000);
      await failing;
      expect(fetch).toHaveBeenCalledTimes(5);
    } finally {
      vi.useRealTimers();
    }
  });

  it("works out a slope from heights on a grid over the lawn, less its cutouts", () => {
    // A 40 m by 30 m yard with a 10 m square house in it.
    const lat = 37.05;
    const dx = (m: number) => m / (111_320 * Math.cos((lat * Math.PI) / 180));
    const dy = (m: number) => m / 110_574;
    const box = (x: number, y: number, w: number, h: number) => [[-79.87 + dx(x), lat + dy(y)], [-79.87 + dx(x + w), lat + dy(y)], [-79.87 + dx(x + w), lat + dy(y + h)], [-79.87 + dx(x), lat + dy(y + h)], [-79.87 + dx(x), lat + dy(y)]];
    const grid = slopeGrid([[box(0, 0, 40, 30), box(15, 10, 10, 10)]], 300);
    expect(grid.step).toBeGreaterThanOrEqual(2);
    // About 1,100 square meters at 2 m: under 300 points, none in the house.
    expect(grid.points.length).toBeGreaterThan(200);
    expect(grid.points.length).toBeLessThanOrEqual(300);
    const east = (p: { lng: number }) => (p.lng + 79.87) * 111_320 * Math.cos((lat * Math.PI) / 180);
    expect(grid.points.some((p) => east(p) > 16 && east(p) < 24 && (p.lat - lat) * 110_574 > 11 && (p.lat - lat) * 110_574 < 19)).toBe(false);
    // Rising 1 m every 10 m east: 10%, none of it steep. Five times that: all steeper than 3:1.
    expect(slopeFromGrid(grid, grid.points.map((p) => east(p) / 10))).toEqual({ mean_pct: 10, steep_pct: 0, from: "google" });
    expect(slopeFromGrid(grid, grid.points.map((p) => east(p) / 2))?.steep_pct).toBe(100);
    // No heights: nothing to say.
    expect(slopeFromGrid(grid, grid.points.map(() => Number.NaN))).toBeNull();
  });

  it("keeps a slope picked by hand through a save, and drops one that isn't a choice", () => {
    const lawn = (slope: unknown) => summarizeFeatureCollection({ type: "FeatureCollection", features: [{ type: "Feature", properties: { slope }, geometry: { type: "Polygon", coordinates: [yard(-0.13, 51.5).coordinates[0]] } }] }).sections[0].slope;
    expect(lawn(pickedSlope("hilly"))).toEqual({ mean_pct: 15, steep_pct: 10, picked: "hilly" });
    expect(lawn({ mean_pct: 15, steep_pct: 10, picked: "very" })).toEqual({ mean_pct: 15, steep_pct: 10 });
  });
});
