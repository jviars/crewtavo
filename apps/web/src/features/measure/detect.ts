/**
 * Turning what Find paving found (SAM 3's mask pictures, white where the pavement is) into shapes
 * people can edit: the masks go onto a grid, the grid's filled cells are joined into outlines, and
 * the outlines lose the staircase of the grid (Douglas-Peucker) so each has a handful of corners.
 * Holes big enough to be an island or a building become cutouts; smaller ones (a parked car) don't.
 */
import { mergePolygons, type Position } from "@crewtavo/core/geo";

/** Cells across the grid: about 4 px each on the 1024 px picture, plenty for a parking lot. */
export const GRID = 256;

type Ring = number[][];

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("That mask couldn't be read."));
    img.src = src;
  });
}

/** One mask picture as on/off cells (white and not see-through is on). */
export async function maskGrid(src: string, cells = GRID): Promise<Uint8Array> {
  const img = await loadImage(src);
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = cells;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("This browser can't read pictures.");
  ctx.drawImage(img, 0, 0, cells, cells);
  const data = ctx.getImageData(0, 0, cells, cells).data;
  const grid = new Uint8Array(cells * cells);
  for (let i = 0; i < grid.length; i++) {
    const [r, g, b, a] = [data[i * 4], data[i * 4 + 1], data[i * 4 + 2], data[i * 4 + 3]];
    grid[i] = a > 127 && (r + g + b) / 3 > 127 ? 1 : 0;
  }
  return grid;
}

/** Cells on in any of the grids. */
export function anyOf(grids: Uint8Array[], cells = GRID): Uint8Array {
  const out = new Uint8Array(cells * cells);
  for (const g of grids) for (let i = 0; i < out.length; i++) out[i] |= g[i];
  return out;
}

/**
 * The filled cells as polygons, in cell units: runs along each row, stacked into rectangles where
 * the next row's run is the same, then joined.
 */
export function gridPolygons(grid: Uint8Array, cells = GRID): Position[][][] {
  const rects: Array<[number, number, number, number]> = []; // x0, y0, x1, y1
  let open = new Map<string, number>(); // "x0:x1" -> index in rects
  for (let y = 0; y < cells; y++) {
    const next = new Map<string, number>();
    let x = 0;
    while (x < cells) {
      if (!grid[y * cells + x]) {
        x++;
        continue;
      }
      const x0 = x;
      while (x < cells && grid[y * cells + x]) x++;
      const key = `${x0}:${x}`;
      const at = open.get(key);
      if (at !== undefined) {
        rects[at][3] = y + 1;
        next.set(key, at);
      } else {
        next.set(key, rects.push([x0, y, x, y + 1]) - 1);
      }
    }
    open = next;
  }
  if (!rects.length) return [];
  const polygons = rects.map(([x0, y0, x1, y1]) => [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]]);
  return polygons.length === 1 ? polygons : mergePolygons(polygons);
}

/** Shoelace area of a ring, in its own units squared. */
export function ringArea(ring: Ring): number {
  let a = 0;
  for (let i = 0; i < ring.length - 1; i++) a += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  return Math.abs(a) / 2;
}

/** Fewer corners on a closed ring: none moves more than `tolerance` off the original. */
export function simplifyRing(ring: Ring, tolerance: number): Ring {
  const open = ring.slice(0, -1);
  if (open.length <= 4) return ring;
  // Split at the corner farthest from the first, so the two halves are open lines.
  let far = 0;
  let best = -1;
  for (let i = 1; i < open.length; i++) {
    const d = Math.hypot(open[i][0] - open[0][0], open[i][1] - open[0][1]);
    if (d > best) [best, far] = [d, i];
  }
  const a = simplifyLine(open.slice(0, far + 1), tolerance);
  const b = simplifyLine([...open.slice(far), open[0]], tolerance);
  const out = [...a, ...b.slice(1)];
  return out.length >= 4 ? out : ring;
}

function simplifyLine(points: Ring, tolerance: number): Ring {
  if (points.length < 3) return points;
  const [ax, ay] = points[0];
  const [bx, by] = points[points.length - 1];
  const len = Math.hypot(bx - ax, by - ay) || 1;
  let index = 0;
  let max = 0;
  for (let i = 1; i < points.length - 1; i++) {
    const d = Math.abs((bx - ax) * (ay - points[i][1]) - (ax - points[i][0]) * (by - ay)) / len;
    if (d > max) [max, index] = [d, i];
  }
  if (max <= tolerance) return [points[0], points[points.length - 1]];
  return [...simplifyLine(points.slice(0, index + 1), tolerance).slice(0, -1), ...simplifyLine(points.slice(index), tolerance)];
}

export interface FoundAreas {
  /** Outer outlines, one ring each (Terra Draw draws areas without holes). */
  areas: Ring[];
  /** Holes worth cutting out: islands and buildings in the pavement. */
  cutouts: Ring[];
}

/**
 * Outlines in picture pixels from a grid of the `size` px picture. Pieces under `minCells` cells and
 * holes under `minHoleCells` are left out.
 */
export function outlines(grid: Uint8Array, size: number, { minCells = 12, minHoleCells = 10, cells = GRID } = {}): FoundAreas {
  const scale = size / cells;
  const toPixels = (ring: Position[]) => simplifyRing(ring.map((p) => [Number(p[0]), Number(p[1])]), 1.1).map(([x, y]) => [x * scale, y * scale]);
  const areas: Ring[] = [];
  const cutouts: Ring[] = [];
  for (const polygon of gridPolygons(grid, cells)) {
    const [outer, ...holes] = polygon;
    if (!outer || ringArea(outer.map((p) => [Number(p[0]), Number(p[1])])) < minCells) continue;
    areas.push(toPixels(outer));
    for (const hole of holes) if (ringArea(hole.map((p) => [Number(p[0]), Number(p[1])])) >= minHoleCells) cutouts.push(toPixels(hole));
  }
  return { areas, cutouts };
}

/** Where each separate thing in a set of masks is (the middle of its cells), in picture pixels. */
export function centers(grids: Uint8Array[], size: number, cells = GRID): Array<[number, number]> {
  const scale = size / cells;
  const out: Array<[number, number]> = [];
  for (const grid of grids) {
    let [sx, sy, n] = [0, 0, 0];
    for (let i = 0; i < grid.length; i++) {
      if (!grid[i]) continue;
      sx += i % cells;
      sy += Math.floor(i / cells);
      n++;
    }
    if (n >= 2) out.push([((sx / n) + 0.5) * scale, ((sy / n) + 0.5) * scale]);
  }
  return out;
}
