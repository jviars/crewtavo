import { describe, expect, it } from "vitest";
import { lidarPitch, readRoof, surveysAt, tileBox, toMercator, type LidarSurvey, type PointCloud } from "../src/roofPlanes";

// Made-up lidar around a house near Radford, VA, built in local meters (east, north, up).
const LNG = -80.5759;
const LAT = 37.1315;
const K = Math.cos((LAT * Math.PI) / 180);
const [OX, OY] = toMercator(LNG, LAT);
const R = 6378137;
const toLngLat = (x: number, y: number): [number, number] => {
  const [mx, my] = [OX + x / K, OY + y / K];
  return [((mx / R) * 180) / Math.PI, ((2 * Math.atan(Math.exp(my / R)) - Math.PI / 2) * 180) / Math.PI];
};
const box = (w: number, s: number, e: number, n: number) => [toLngLat(w, s), toLngLat(e, s), toLngLat(e, n), toLngLat(w, n), toLngLat(w, s)];

/** Deterministic noise, so the tests always see the same points. */
function noise(seed: number) {
  let a = seed;
  return () => {
    a = (a * 1664525 + 1013904223) % 4294967296;
    return a / 4294967296 - 0.5;
  };
}

type Pt = { x: number; y: number; z: number; cls?: number; returns?: number };
function cloud(points: Pt[]): PointCloud {
  const c: PointCloud = { count: points.length, x: new Float64Array(points.length), y: new Float64Array(points.length), z: new Float64Array(points.length), cls: new Uint8Array(points.length), returns: new Uint8Array(points.length) };
  points.forEach((p, i) => {
    c.x[i] = OX + p.x / K;
    c.y[i] = OY + p.y / K;
    c.z[i] = p.z;
    c.cls[i] = p.cls ?? 1;
    c.returns[i] = p.returns ?? 1;
  });
  return c;
}

const rand = noise(7);
/** Points every 0.45 m over a rectangle, at heights from `z(x, y)`, with 3 cm of noise. */
const surface = (w: number, s: number, e: number, n: number, z: (x: number, y: number) => number): Pt[] => {
  const out: Pt[] = [];
  for (let x = w; x <= e; x += 0.45) for (let y = s; y <= n; y += 0.45) out.push({ x: x + rand() * 0.2, y: y + rand() * 0.2, z: z(x, y) + rand() * 0.06 });
  return out;
};
const ground = surface(-16, -16, 16, 16, () => 0).filter((_, i) => i % 4 === 0).map((p) => ({ ...p, cls: 2 }));
// A 12 x 9 m house, ridge running east-west, eaves 5 m up, 6/12 both ways.
const gable = surface(-6, -4.5, 6, 4.5, (_, y) => 5 + (4.5 - Math.abs(y)) * 0.5);
// A tree hanging over the north-east corner: scattered points, several returns per pulse.
const tree: Pt[] = Array.from({ length: 250 }, () => ({ x: 5 + rand() * 4, y: 3.5 + rand() * 4, z: 6 + rand() * 6, returns: 2 + Math.round(rand() + 0.5) }));
// A porch off the south side, 3/12 sloping south, eaves 3 m up.
const porch = surface(-3, -7.5, 3, -4.6, (_, y) => 3 + (y + 7.5) * 0.25);

describe("roof pitch from lidar", () => {
  it("reads both sides of a gable, past the tree over it", () => {
    const reading = readRoof(cloud([...ground, ...gable, ...tree]), [{ id: "roof", ring: box(-6.3, -4.8, 6.3, 4.8) }]);
    const [section] = reading.sections;
    expect(section.pitch).toBe("6/12");
    expect(section.rise!).toBeCloseTo(6, 0);
    expect(section.alsoPitch).toBeNull();
    const big = reading.planes.filter((p) => p.planSqft > 300);
    expect(big).toHaveLength(2);
    const facings = big.map((p) => Math.round(p.facing / 90) % 4).sort();
    expect(facings).toEqual([0, 2]); // north and south
    for (const p of big) expect(Math.abs(p.rise - 6)).toBeLessThan(0.25);
    expect(reading.density).toBeGreaterThan(3);
  });

  it("gives a porch drawn as its own section its own pitch", () => {
    const reading = readRoof(cloud([...ground, ...gable, ...porch]), [
      { id: "main", ring: box(-6.3, -4.6, 6.3, 4.8) },
      { id: "porch", ring: box(-3.2, -7.7, 3.2, -4.6) },
    ]);
    const by = Object.fromEntries(reading.sections.map((s) => [s.id, s.pitch]));
    expect(by).toEqual({ main: "6/12", porch: "3/12" });
  });

  it("gives a porch drawn over the whole house its own pitch too", () => {
    const reading = readRoof(cloud([...ground, ...gable, ...porch]), [
      { id: "all", ring: box(-6.3, -7.7, 6.3, 4.8) },
      { id: "porch", ring: box(-3.2, -7.7, 3.2, -4.6) },
    ]);
    const by = Object.fromEntries(reading.sections.map((s) => [s.id, s]));
    expect(by.porch.pitch).toBe("3/12");
    expect(by.all).toMatchObject({ pitch: "6/12", alsoPitch: null });
  });

  it("says so when part of a section is at another pitch", () => {
    const reading = readRoof(cloud([...ground, ...gable, ...porch]), [{ id: "all", ring: box(-6.3, -7.7, 6.3, 4.8) }]);
    expect(reading.sections[0]).toMatchObject({ pitch: "6/12", alsoPitch: "3/12" });
  });

  it("reads a flat roof as flat, and nothing as nothing", () => {
    const flat = surface(-8, -6, 8, 6, (x) => 6 + x * 0.004); // a quarter inch per foot for drainage
    expect(readRoof(cloud([...ground, ...flat]), [{ id: "store", ring: box(-8, -6, 8, 6) }]).sections[0].pitch).toBe("0/12");
    const empty = readRoof(cloud(ground), [{ id: "store", ring: box(-8, -6, 8, 6) }]);
    expect(empty.sections[0]).toMatchObject({ pitch: null, points: 0 });
    expect(empty.planes).toEqual([]);
  });

  it("rounds to the half inch", () => {
    expect(lidarPitch(5.8)).toBe("6/12");
    expect(lidarPitch(6.3)).toBe("6.5/12");
    expect(lidarPitch(0.4)).toBe("0/12");
    expect(lidarPitch(0.9)).toBe("1/12");
  });

  it("finds the surveys over a spot, newest first", () => {
    const square = (w: number, s: number, e: number, n: number) => [w, s, e, s, e, n, w, n, w, s];
    const surveys: LidarSurvey[] = [
      { n: "VA_Old_2012", y: 2012, r: [square(-81, 37, -80, 38)] },
      { n: "VA_New_B23", y: 2023, r: [square(-80.6, 37.1, -80.5, 37.2)] },
      { n: "TX_Far_2018", y: 2018, r: [square(-97, 32, -96, 33)] },
      { n: "VA_Edge_2019", y: 2019, r: [square(-80.57, 37.2, -80.4, 37.3)] }, // 7 km north: not this spot
    ];
    expect(surveysAt(surveys, LNG, LAT).map((s) => s.n)).toEqual(["VA_New_B23", "VA_Old_2012"]);
    expect(surveysAt(surveys, -80.55, 37.199).map((s) => s.n)).toEqual(["VA_New_B23", "VA_Edge_2019", "VA_Old_2012"]); // close to its edge counts
  });

  it("works out where an Entwine tile is", () => {
    const bounds = [0, 0, 0, 1024, 1024, 1024];
    expect(tileBox(bounds, "0-0-0-0")).toEqual([0, 0, 1024, 1024]);
    expect(tileBox(bounds, "2-3-1-0")).toEqual([768, 256, 1024, 512]);
  });
});
