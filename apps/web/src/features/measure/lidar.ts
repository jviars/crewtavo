/**
 * Roof pitch from free USGS lidar, the browser's part: find a survey with points over the drawn roof
 * (lidarSurveys.json, refreshed by scripts/lidar-surveys.mjs), download just the tiles over it (a few
 * MB, straight from USGS's public bucket on AWS, nothing through our server), decode them with laz-perf
 * (WebAssembly, loaded only when someone asks) and hand the points to readRoof in @crewtavo/core.
 * No key and no cost; the data is public domain.
 */
import { boxesMeet, readRoof, surveysAt, surveyUrl, tileBox, toMercator, type LidarSurvey, type PointCloud, type RoofOutline, type RoofReading } from "@crewtavo/core/roofPlanes";
import surveysFile from "./lidarSurveys.json?url";

export const LIDAR_CREDIT = "Lidar courtesy of the U.S. Geological Survey (3D Elevation Program)";

export interface LidarResult {
  survey: { name: string; year: number | null };
  reading: RoofReading;
  /** Megabytes downloaded. */
  downloaded: number;
}
export type LidarStep = "survey" | "download" | "read";
export class LidarError extends Error {}

/** Meters around the roof to bring in too, for the ground beside it. */
const AROUND = 8;
/** Tiles narrower than this (meters) hitting the roof mean the survey really has points there. */
const FINE_TILE = 600;
const PARALLEL = 6;

let surveys: Promise<LidarSurvey[]> | null = null;
const loadSurveys = () =>
  (surveys ??= fetch(surveysFile)
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
    .then((body: { surveys: LidarSurvey[] }) => body.surveys)
    .catch((error) => {
      surveys = null;
      throw error;
    }));

/** The roof's pitch from the newest survey that has points over it. */
export async function roofFromLidar(outlines: RoofOutline[], onStep: (step: LidarStep, detail?: string) => void = () => {}, signal?: AbortSignal): Promise<LidarResult> {
  if (!outlines.length) throw new LidarError("Draw the roof with Area first, then try again.");
  onStep("survey");
  const ring = outlines.flatMap((o) => o.ring);
  const lng = ring.reduce((s, p) => s + Number(p[0]), 0) / ring.length;
  const lat = ring.reduce((s, p) => s + Number(p[1]), 0) / ring.length;
  let candidates: LidarSurvey[];
  try {
    candidates = surveysAt(await loadSurveys(), lng, lat).slice(0, 4);
  } catch {
    throw new LidarError("Couldn't load the list of lidar surveys. Check your connection and try again.");
  }
  if (!candidates.length) throw new LidarError("USGS doesn't have lidar for this spot. Measure the pitch with your phone or from a photo instead.");

  // The box to bring in, in the surveys' web-mercator meters.
  const k = Math.cos((lat * Math.PI) / 180);
  const merc = ring.map((p) => toMercator(Number(p[0]), Number(p[1])));
  const pad = AROUND / k;
  const box = [Math.min(...merc.map((p) => p[0])) - pad, Math.min(...merc.map((p) => p[1])) - pad, Math.max(...merc.map((p) => p[0])) + pad, Math.max(...merc.map((p) => p[1])) + pad];
  if ((box[2] - box[0]) * k > 400 || (box[3] - box[1]) * k > 400) throw new LidarError("That's bigger than a roof. Lidar pitch works one building at a time.");

  let bytes = 0;
  const get = async (url: string) => {
    const response = await fetch(url, { signal });
    if (!response.ok) throw new Error(`${response.status}`);
    const data = new Uint8Array(await response.arrayBuffer());
    bytes += data.byteLength;
    return data;
  };
  const json = async <T,>(url: string) => JSON.parse(new TextDecoder().decode(await get(url))) as T;

  for (const survey of candidates) {
    const base = surveyUrl(survey.n);
    let tiles: string[];
    try {
      const ept = await json<{ bounds: number[]; srs?: { horizontal?: string } }>(`${base}/ept.json`);
      if (ept.srs?.horizontal && ept.srs.horizontal !== "3857") continue;
      tiles = await tilesOver(ept.bounds, box, base, json);
      // Only big, coarse tiles reach this spot: it's inside the survey's outline but not in its data.
      if (!tiles.some((key) => (tileBox(ept.bounds, key)[2] - tileBox(ept.bounds, key)[0]) * k < FINE_TILE)) continue;
    } catch (error) {
      if (signal?.aborted) throw error;
      continue; // this survey isn't answering; try an older one
    }
    onStep("download", `${survey.y ?? "undated"}`);
    let files: Uint8Array[];
    try {
      files = [];
      for (let i = 0; i < tiles.length; i += PARALLEL) files.push(...(await Promise.all(tiles.slice(i, i + PARALLEL).map((key) => get(`${base}/ept-data/${key}.laz`)))));
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new LidarError("USGS's lidar server stopped answering partway. Try again in a minute.");
    }
    onStep("read");
    const cloud = await decode(files, box);
    const reading = readRoof(cloud, outlines);
    if (!reading.sections.some((s) => s.pitch)) {
      throw new LidarError(
        `The lidar here (flown ${survey.y ?? "some years ago"}) doesn't show a roof inside your outline. The building may be newer than the survey, or trees may cover it. Measure the pitch with your phone or from a photo instead.`,
      );
    }
    return { survey: { name: survey.n, year: survey.y }, reading, downloaded: bytes / 1_048_576 };
  }
  throw new LidarError("USGS doesn't have lidar for this spot. Measure the pitch with your phone or from a photo instead.");
}

/** Every tile with points that reaches the box: the hierarchy says how many points each tile has, and -1 means its children are listed in a file of their own. */
async function tilesOver(bounds: number[], box: number[], base: string, json: <T>(url: string) => Promise<T>): Promise<string[]> {
  const found: string[] = [];
  const walk = async (root: string) => {
    const counts = await json<Record<string, number>>(`${base}/ept-hierarchy/${root}.json`);
    const deeper: string[] = [];
    for (const [key, count] of Object.entries(counts)) {
      if (!boxesMeet(tileBox(bounds, key), box)) continue;
      if (count === -1) deeper.push(key);
      else if (count > 0) found.push(key);
    }
    await Promise.all(deeper.map(walk));
  };
  await walk("0-0-0-0");
  return found;
}

// ---------------------------------------------------------------------------------------------
// Decoding LAZ (compressed LAS) with laz-perf
// ---------------------------------------------------------------------------------------------

type LazPerf = Awaited<ReturnType<typeof import("laz-perf")["createLazPerf"]>>;
let lazPerf: Promise<LazPerf> | null = null;
const loadLazPerf = () =>
  (lazPerf ??= Promise.all([import("laz-perf"), import("laz-perf/lib/web/laz-perf.wasm?url")]).then(([{ createLazPerf }, wasm]) =>
    createLazPerf({ locateFile: () => wasm.default }),
  ));

/** What the reader needs from a LAS file's header (LAS 1.2 to 1.4). */
export function lasHeader(file: Uint8Array) {
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
  if (String.fromCharCode(...file.subarray(0, 4)) !== "LASF") throw new Error("Not a LAS file");
  const minor = file[25];
  const format = view.getUint8(104) & 0x3f; // the top bits only say it's compressed
  let count = view.getUint32(107, true);
  if (!count && minor >= 4) count = Number(view.getBigUint64(247, true));
  const triple = (at: number) => [view.getFloat64(at, true), view.getFloat64(at + 8, true), view.getFloat64(at + 16, true)];
  return { format, length: view.getUint16(105, true), count, scale: triple(131), offset: triple(155) };
}

/** The points inside the box from every file, as one cloud. */
async function decode(files: Uint8Array[], box: number[]): Promise<PointCloud> {
  const lp = await loadLazPerf();
  const kept: number[] = [];
  for (const file of files) {
    const header = lasHeader(file);
    // Point formats 6 and up (LAS 1.4) keep the return count and class in different bytes.
    const modern = header.format >= 6;
    const filePtr = lp._malloc(file.byteLength);
    const pointPtr = lp._malloc(header.length);
    const reader = new lp.LASZip();
    try {
      lp.HEAPU8.set(file, filePtr);
      reader.open(filePtr, file.byteLength);
      const count = reader.getCount();
      // The decoder can grow its memory while it reads (the first file especially), which leaves an
      // old view of it empty, so check it's still the same memory after each point.
      let heap = new DataView(lp.HEAPU8.buffer);
      const at = pointPtr;
      for (let i = 0; i < count; i++) {
        reader.getPoint(pointPtr);
        if (heap.buffer !== lp.HEAPU8.buffer) heap = new DataView(lp.HEAPU8.buffer);
        const x = heap.getInt32(at, true) * header.scale[0] + header.offset[0];
        const y = heap.getInt32(at + 4, true) * header.scale[1] + header.offset[1];
        if (x < box[0] || x > box[2] || y < box[1] || y > box[3]) continue;
        const z = heap.getInt32(at + 8, true) * header.scale[2] + header.offset[2];
        const flags = heap.getUint8(at + 14);
        kept.push(x, y, z, modern ? heap.getUint8(at + 16) : heap.getUint8(at + 15) & 31, modern ? flags >> 4 : (flags >> 3) & 7);
      }
    } finally {
      reader.delete();
      lp._free(filePtr);
      lp._free(pointPtr);
    }
    // Let the page breathe between files.
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  const count = kept.length / 5;
  const cloud: PointCloud = { count, x: new Float64Array(count), y: new Float64Array(count), z: new Float64Array(count), cls: new Uint8Array(count), returns: new Uint8Array(count) };
  for (let i = 0; i < count; i++) {
    cloud.x[i] = kept[i * 5];
    cloud.y[i] = kept[i * 5 + 1];
    cloud.z[i] = kept[i * 5 + 2];
    cloud.cls[i] = kept[i * 5 + 3];
    cloud.returns[i] = kept[i * 5 + 4];
  }
  return cloud;
}
