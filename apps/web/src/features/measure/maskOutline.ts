/**
 * From one of the model's guesses (samLocal.ts) to outlines: only the pieces asked about (under the
 * taps, or inside the box), without one-cell spurs, traced where the model's scores cross zero
 * (marching squares). The edge runs smoothly between grid points instead of in steps around whole
 * cells, the way SAM's own tools draw a mask, so a straight curb comes out straight.
 */
import { GRID, pieceAt, ringArea } from "./detect";

type Ring = number[][];

/** Cells where the score is above 0. */
export function threshold(logits: Float32Array): Uint8Array {
  const grid = new Uint8Array(logits.length);
  for (let i = 0; i < logits.length; i++) grid[i] = logits[i] > 0 ? 1 : 0;
  return grid;
}

/**
 * The grid opened: shrunk by a cell all round, then grown back. Spurs and strips one or two cells
 * wide (up to about 6 ft on a lot-sized view) go, so a lot's outline doesn't wander up a curb line
 * or between parked cars; anything thicker, square corners included, comes back as it was. Only
 * for lots: it would take a sidewalk away too.
 */
export function opened(grid: Uint8Array, cells = GRID): Uint8Array {
  const at = (g: Uint8Array, x: number, y: number) => (x >= 0 && y >= 0 && x < cells && y < cells ? g[y * cells + x] : 0);
  const around = (g: Uint8Array, x: number, y: number, all: boolean) => {
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (Boolean(at(g, x + dx, y + dy)) !== all) return !all;
    return all;
  };
  const shrunk = new Uint8Array(grid.length);
  for (let y = 0; y < cells; y++) for (let x = 0; x < cells; x++) shrunk[y * cells + x] = around(grid, x, y, true) ? 1 : 0;
  const out = new Uint8Array(grid.length);
  for (let y = 0; y < cells; y++) for (let x = 0; x < cells; x++) out[y * cells + x] = grid[y * cells + x] && around(shrunk, x, y, false) ? 1 : 0;
  return out;
}

/**
 * Outlines where the scores cross zero, in grid units with cell (x, y)'s score at (x + 0.5, y + 0.5).
 * Each polygon is an outer ring and its holes; an island inside a hole is a polygon of its own.
 * Rings smaller than a cell are noise and left out.
 */
export function contours(values: Float32Array, cells = GRID): Ring[][] {
  const v = (x: number, y: number) => (x < 0 || y < 0 || x >= cells || y >= cells ? -1 : values[y * cells + x]);
  // Crossing points are keyed by the edge they're on: horizontal from (x, y) to (x + 1, y) or
  // vertical from (x, y) to (x, y + 1), with x and y from -1 to `cells` (outside counts as out).
  const W = cells + 2;
  const h = (x: number, y: number) => ((y + 1) * W + (x + 1)) * 2;
  const vt = (x: number, y: number) => ((y + 1) * W + (x + 1)) * 2 + 1;
  const links = new Map<number, number[]>();
  const link = (a: number, b: number) => {
    links.set(a, [...(links.get(a) ?? []), b]);
    links.set(b, [...(links.get(b) ?? []), a]);
  };
  for (let y = -1; y < cells; y++) {
    for (let x = -1; x < cells; x++) {
      const [tl, tr, br, bl] = [v(x, y), v(x + 1, y), v(x + 1, y + 1), v(x, y + 1)];
      const c = (tl > 0 ? 8 : 0) | (tr > 0 ? 4 : 0) | (br > 0 ? 2 : 0) | (bl > 0 ? 1 : 0);
      if (c === 0 || c === 15) continue;
      const [T, B, L, R] = [h(x, y), h(x, y + 1), vt(x, y), vt(x + 1, y)];
      const middle = (tl + tr + br + bl) / 4 > 0;
      switch (c) {
        case 1: case 14: link(L, B); break;
        case 2: case 13: link(B, R); break;
        case 3: case 12: link(L, R); break;
        case 4: case 11: link(T, R); break;
        case 6: case 9: link(T, B); break;
        case 7: case 8: link(T, L); break;
        // Two corners in, diagonally: joined through the middle when it's in.
        case 5: if (middle) { link(T, L); link(B, R); } else { link(T, R); link(L, B); } break;
        case 10: if (middle) { link(T, R); link(L, B); } else { link(T, L); link(B, R); } break;
      }
    }
  }
  const point = (id: number): number[] => {
    const i = id >> 1;
    const [x, y] = [(i % W) - 1, Math.floor(i / W) - 1];
    if (id & 1) {
      const [a, b] = [v(x, y), v(x, y + 1)];
      return [x + 0.5, y + 0.5 + a / (a - b)];
    }
    const [a, b] = [v(x, y), v(x + 1, y)];
    return [x + 0.5 + a / (a - b), y + 0.5];
  };
  const rings: Ring[] = [];
  const seen = new Set<number>();
  for (const start of links.keys()) {
    if (seen.has(start)) continue;
    const ring: Ring = [];
    let [prev, cur] = [-1, start];
    while (!seen.has(cur)) {
      seen.add(cur);
      ring.push(point(cur));
      const next = links.get(cur) ?? [];
      const step = next[0] !== prev || next.length < 2 ? next[0] : next[1];
      if (step === undefined) break;
      [prev, cur] = [cur, step];
    }
    if (ring.length >= 3) rings.push([...ring, ring[0]]);
  }
  // Which rings are holes: the ones inside an odd number of others.
  const sized = rings.map((r) => ({ r, a: ringArea(r) })).filter((x) => x.a >= 1).sort((p, q) => q.a - p.a);
  const parent: number[] = [];
  const depth: number[] = [];
  sized.forEach(({ r }, i) => {
    let best = -1;
    for (let j = 0; j < i; j++) if (inside(sized[j].r, r[0]) && (best < 0 || sized[j].a < sized[best].a)) best = j;
    parent.push(best);
    depth.push(best < 0 ? 0 : depth[best] + 1);
  });
  const polygons = new Map<number, Ring[]>();
  sized.forEach(({ r }, i) => {
    if (depth[i] % 2 === 0) polygons.set(i, [r]);
    else polygons.get(parent[i])?.push(r);
  });
  return [...polygons.values()];
}

function inside(ring: Ring, [x, y]: number[]): boolean {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

/**
 * One guess as polygons in grid units: the pieces under the seeds (grid points) or, with none, every
 * piece; only what's inside the box when there is one (grid units too); spurs taken off when it's a
 * lot (`open`); corners thinned so no point is more than half a cell off the traced edge.
 */
export function guessPolygons(
  logits: Float32Array,
  { seeds = [], box = null, open = false, cells = GRID }: { seeds?: Array<[number, number]>; box?: [number, number, number, number] | null; open?: boolean; cells?: number } = {},
): Ring[][] {
  let grid = threshold(logits);
  if (box) {
    const [x0, y0, x1, y1] = box;
    for (let y = 0; y < cells; y++) for (let x = 0; x < cells; x++) if (x + 0.5 < x0 || x + 0.5 > x1 || y + 0.5 < y0 || y + 0.5 > y1) grid[y * cells + x] = 0;
  }
  if (open) grid = opened(grid, cells);
  if (seeds.length) {
    const kept = new Uint8Array(grid.length);
    for (const [sx, sy] of seeds) pieceAt(grid, sx, sy, { cells }).forEach((on, i) => (kept[i] |= on));
    grid = kept;
  }
  // What's not kept is pushed below zero, so the trace goes round only what is; what is keeps the
  // model's own scores, which put the edge between grid points.
  const values = new Float32Array(logits.length);
  for (let i = 0; i < values.length; i++) values[i] = grid[i] ? logits[i] : Math.min(logits[i], -1);
  return contours(values, cells).map((polygon) => polygon.map((ring) => straighten(ring, 0.6)));
}

/** Indexes of the corners Douglas-Peucker keeps on an open run of points, ends included. */
function keep(points: Ring, from: number, to: number, tolerance: number, out: number[]) {
  const [ax, ay] = points[from];
  const [bx, by] = points[to % points.length];
  const len = Math.hypot(bx - ax, by - ay) || 1;
  let [far, max] = [-1, 0];
  for (let i = from + 1; i < to; i++) {
    const [px, py] = points[i];
    const d = Math.abs((bx - ax) * (ay - py) - (ax - px) * (by - ay)) / len;
    if (d > max) [far, max] = [i, d];
  }
  if (far < 0 || max <= tolerance) return;
  keep(points, from, far, tolerance, out);
  out.push(far);
  keep(points, far, to, tolerance, out);
}

/**
 * Fewer corners on a traced ring, with straight sides: Douglas-Peucker picks the corners (none of
 * the trace more than `tolerance` off), then each side becomes the line that best fits all the
 * traced points along it, and each corner moves to where its two sides meet. Picking points off
 * the trace instead would skew the sides (the trace trims square corners) and lose area.
 */
export function straighten(ring: Ring, tolerance: number): Ring {
  const open = ring.slice(0, -1);
  const n = open.length;
  if (n <= 4) return ring;
  // Split at the point farthest from the first, so both halves are open runs.
  let far = 0;
  for (let i = 1; i < n; i++) if (Math.hypot(open[i][0] - open[0][0], open[i][1] - open[0][1]) > Math.hypot(open[far][0] - open[0][0], open[far][1] - open[0][1])) far = i;
  const corners = [0];
  keep(open, 0, far, tolerance, corners);
  corners.push(far);
  keep(open, far, n, tolerance, corners);
  if (corners.length < 3) return ring;
  // The best-fit line through each side's points: a point on it and its direction.
  const sides = corners.map((from, i) => {
    const to = corners[(i + 1) % corners.length] || n;
    // The corners themselves sit on the trimmed corner, off both sides: fit the points between.
    const pts: Ring = [];
    const inner = to - from >= 3 ? 1 : 0;
    for (let k = from + inner; k <= to - inner; k++) pts.push(open[k % n]);
    const [cx, cy] = [pts.reduce((t, p) => t + p[0], 0) / pts.length, pts.reduce((t, p) => t + p[1], 0) / pts.length];
    let [sxx, sxy, syy] = [0, 0, 0];
    for (const [x, y] of pts) [sxx, sxy, syy] = [sxx + (x - cx) ** 2, sxy + (x - cx) * (y - cy), syy + (y - cy) ** 2];
    const angle = 0.5 * Math.atan2(2 * sxy, sxx - syy);
    return { cx, cy, dx: Math.cos(angle), dy: Math.sin(angle) };
  });
  const out: Ring = corners.map((at, i) => {
    const a = sides[(i - 1 + sides.length) % sides.length];
    const b = sides[i];
    const cross = a.dx * b.dy - a.dy * b.dx;
    // Nearly parallel sides (a gentle curve) keep the traced point.
    if (Math.abs(cross) < Math.sin((12 * Math.PI) / 180)) return open[at];
    const t = ((b.cx - a.cx) * b.dy - (b.cy - a.cy) * b.dx) / cross;
    const p = [a.cx + a.dx * t, a.cy + a.dy * t];
    // A meeting point far off the trace (a sharp spike) isn't a corner: keep the traced point.
    return Math.hypot(p[0] - open[at][0], p[1] - open[at][1]) > 3 * tolerance + 1 ? open[at] : p;
  });
  return [...out, out[0]];
}
