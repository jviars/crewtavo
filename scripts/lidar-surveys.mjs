#!/usr/bin/env node
/**
 * Refreshes the list of USGS lidar surveys that Measure's "From lidar" roof pitch looks through
 * (apps/web/src/features/measure/lidarSurveys.json). USGS hosts its 3D Elevation Program surveys on
 * AWS (s3://usgs-lidar-public, as Entwine point clouds) and lists them all, with their outlines, in
 * one 9 MB file. This keeps each survey's name, year and an outline simplified to about a kilometer,
 * small enough to ship with the app. The app checks a survey really has points at an address before
 * using it, so a rough outline is fine. Run it now and then to pick up new surveys:
 *   node scripts/lidar-surveys.mjs
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SOURCE = "https://usgs.entwine.io/boundaries/resources.geojson";
const OUT = join(dirname(fileURLToPath(import.meta.url)), "../apps/web/src/features/measure/lidarSurveys.json");
const TOLERANCE = 0.01; // degrees, about a kilometer

/** The year it was flown: "VA_South_Central_B1_2017" is 2017, "AL_19Co_1_B24" (a 3DEP work package) 2024. */
function yearOf(name) {
  const full = name.match(/(?<!\d)(19[89]\d|20[0-4]\d)(?!\d)/);
  if (full) return Number(full[1]);
  const pkg = name.match(/_[A-Z](\d\d)$/);
  return pkg ? 2000 + Number(pkg[1]) : null;
}

/** Douglas-Peucker on a ring of [lng, lat]. */
function simplify(points, tolerance) {
  if (points.length < 4) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const [ax, ay] = points[a];
    const [bx, by] = points[b];
    const len = Math.hypot(bx - ax, by - ay) || 1e-12;
    let worst = -1;
    let at = -1;
    for (let i = a + 1; i < b; i++) {
      const [px, py] = points[i];
      const d = Math.abs((bx - ax) * (ay - py) - (ax - px) * (by - ay)) / len;
      if (d > worst) [worst, at] = [d, i];
    }
    if (worst > tolerance) {
      keep[at] = 1;
      stack.push([a, at], [at, b]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

const round = (n) => Math.round(n * 1000) / 1000;
const response = await fetch(SOURCE);
if (!response.ok) throw new Error(`${SOURCE} answered ${response.status}`);
const { features } = await response.json();

const surveys = features.map((f) => {
  const { name } = f.properties;
  const polygons = f.geometry.type === "MultiPolygon" ? f.geometry.coordinates : [f.geometry.coordinates];
  const rings = polygons.map(([outer]) => {
    let ring = simplify(outer, TOLERANCE);
    if (ring.length < 4) {
      // Too small to keep a shape at this size: its box will do.
      const xs = outer.map((p) => p[0]);
      const ys = outer.map((p) => p[1]);
      const [w, e, s, n] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
      ring = [[w, s], [e, s], [e, n], [w, n], [w, s]];
    }
    return ring.flatMap(([x, y]) => [round(x), round(y)]);
  });
  return { n: name, y: yearOf(name), r: rings };
});

const json = JSON.stringify({ source: SOURCE, updated: new Date().toISOString().slice(0, 10), surveys });
writeFileSync(OUT, json);
console.log(`${surveys.length} surveys, ${Math.round(json.length / 1024)} KB → ${OUT}`);
