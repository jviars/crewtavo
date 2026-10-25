import { polygonAreaM2, type Section } from "@crewtavo/core/geo";
import { optionTotals, quoteTotals } from "@crewtavo/core/money";
import { describe, expect, it } from "vitest";
import { centers, gridPolygons, outlines, pieceAt, ringArea, simplifyRing } from "../src/features/measure/detect";
import { lotAt } from "../src/features/measure/buildings";
import { contours, guessPolygons, opened } from "../src/features/measure/maskOutline";
import { pickMask, pixelValues, SAM_SIZE } from "../src/features/measure/samLocal";
import { combine, padBox, tidy, withoutBuildings, withoutScraps } from "../src/features/measure/TapOutline";
import { feetPerPixel, scaleLength } from "../src/features/measure/takeoffSheet";
import { currentStep, estimateSums, formulaValue, serviceKind, stageLabel, takeoffVariables, usesDepth, viewedLines, type SumsLine, type TakeoffRow } from "../src/features/paving/data";
import { lineDestination } from "../src/features/roofing/estimate/rows";

/** A cells × cells grid with the given rectangles filled ([x0, y0, x1, y1], end exclusive). */
function grid(cells: number, ...rects: Array<[number, number, number, number]>) {
  const g = new Uint8Array(cells * cells);
  for (const [x0, y0, x1, y1] of rects) for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) g[y * cells + x] = 1;
  return g;
}

describe("Find paving's outlines", () => {
  it("joins the filled cells into one outline per piece", () => {
    const pieces = gridPolygons(grid(20, [2, 2, 12, 8], [12, 4, 16, 8], [17, 15, 19, 19]), 20);
    expect(pieces).toHaveLength(2);
    const areas = pieces.map((p) => ringArea(p[0].map((pt) => [Number(pt[0]), Number(pt[1])]))).sort((a, b) => a - b);
    expect(areas).toEqual([8, 76]);
  });

  it("keeps a hole as a hole (an island in the lot)", () => {
    const lot = grid(30, [0, 0, 30, 30]);
    for (let y = 10; y < 16; y++) for (let x = 10; x < 18; x++) lot[y * 30 + x] = 0;
    const [piece] = gridPolygons(lot, 30);
    expect(piece).toHaveLength(2);
    const { areas, cutouts } = outlines(lot, 300, { cells: 30, minCells: 4, minHoleCells: 10 });
    expect(areas).toHaveLength(1);
    expect(cutouts).toHaveLength(1);
    expect(ringArea(cutouts[0])).toBeCloseTo(48 * 100, -1); // 8 × 6 cells of 10 px
    // A hole the size of a parked car is pavement, not a cutout.
    expect(outlines(lot, 300, { cells: 30, minCells: 4, minHoleCells: 60 }).cutouts).toHaveLength(0);
  });

  it("leaves specks out", () => {
    const { areas } = outlines(grid(20, [1, 1, 2, 2], [5, 5, 15, 15]), 200, { cells: 20, minCells: 4 });
    expect(areas).toHaveLength(1);
  });

  it("takes the staircase out of a slanted edge", () => {
    // A right triangle drawn in cells: its hypotenuse is a staircase of 40 corners.
    const cells = 40;
    const g = new Uint8Array(cells * cells);
    for (let y = 0; y < cells; y++) for (let x = 0; x <= y; x++) g[y * cells + x] = 1;
    const [[outer]] = gridPolygons(g, cells);
    const ring = outer.map((p) => [Number(p[0]), Number(p[1])]);
    const simple = simplifyRing(ring, 1.1);
    expect(ring.length).toBeGreaterThan(60);
    expect(simple.length).toBeLessThanOrEqual(6);
    expect(simple[0]).toEqual(simple[simple.length - 1]);
    expect(Math.abs(ringArea(simple) - ringArea(ring)) / ringArea(ring)).toBeLessThan(0.05);
  });

  it("puts a count at the middle of each stall it found", () => {
    expect(centers([grid(10, [0, 0, 2, 4]), grid(10, [6, 6, 10, 10]), grid(10)], 100, 10)).toEqual([[10, 20], [80, 80]]);
  });
});

describe("tap to outline (the free model)", () => {
  it("keeps only the piece under the tap", () => {
    const g = grid(20, [2, 2, 8, 8], [12, 2, 18, 8]);
    const piece = pieceAt(g, 4.5, 4.5, { cells: 20 });
    expect(piece.reduce((n, v) => n + v, 0)).toBe(36);
    expect(piece[3 * 20 + 14]).toBe(0); // the other lot stays out
  });

  it("takes the nearest piece for a tap just off it, and nothing for one far off", () => {
    const g = grid(20, [12, 2, 18, 8]);
    expect(pieceAt(g, 10, 4, { cells: 20 }).reduce((n, v) => n + v, 0)).toBe(36);
    expect(pieceAt(g, 2, 16, { cells: 20 }).reduce((n, v) => n + v, 0)).toBe(0);
  });

  it("starts a single tap on the whole lot, not the speck SAM scores highest", () => {
    // Answers from a tap on the Radford lot: the lot, then two specks around the tap.
    expect(pickMask([{ cells: 19526, score: 0.72 }, { cells: 21, score: 0.87 }, { cells: 18, score: 0.9 }])).toBe(0);
    expect(pickMask([{ cells: 2356, score: 0.44 }, { cells: 13251, score: 0.84 }, { cells: 900, score: 0.95 }])).toBe(1);
    // Not fairly sure of any: the surest.
    expect(pickMask([{ cells: 500, score: 0.3 }, { cells: 40, score: 0.45 }])).toBe(1);
    expect(pickMask([])).toBe(-1);
  });

  it("takes the surest guess to take something out: the thing under the tap", () => {
    // A tap on a planted island: the island, the island and the aisle beside it, the whole lot.
    expect(pickMask([{ cells: 120, score: 0.93 }, { cells: 900, score: 0.71 }, { cells: 19000, score: 0.62 }], { prefer: "surest" })).toBe(0);
  });

  it("normalizes the picture the way SAM was trained", () => {
    const rgba = new Uint8ClampedArray(SAM_SIZE * SAM_SIZE * 4);
    rgba.set([255, 255, 255, 255, 0, 0, 0, 255]); // white, then black
    const out = pixelValues(rgba);
    const plane = SAM_SIZE * SAM_SIZE;
    expect(out.length).toBe(3 * plane);
    expect(out[0]).toBeCloseTo((1 - 0.485) / 0.229, 4); // white's red
    expect(out[plane + 1]).toBeCloseTo(-0.456 / 0.224, 4); // black's green
  });
});

/** Scores over a cells-square grid: above 0 inside the rectangles, -2 elsewhere. */
function scores(cells: number, ...rects: Array<[number, number, number, number]>) {
  const out = new Float32Array(cells * cells).fill(-2);
  for (const [x0, y0, x1, y1] of rects) for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) out[y * cells + x] = 2;
  return out;
}

describe("outlines from the model's mask", () => {
  it("traces the edge halfway between grid points, not round whole cells", () => {
    const [polygon] = contours(scores(20, [5, 5, 15, 10]), 20);
    expect(polygon).toHaveLength(1);
    // Cells 5 to 14 have their scores at 5.5 to 14.5; the edge sits halfway to the next ones.
    const xs = polygon[0].map((p) => p[0]);
    const ys = polygon[0].map((p) => p[1]);
    expect(Math.min(...xs)).toBeCloseTo(5, 5);
    expect(Math.max(...xs)).toBeCloseTo(15, 5);
    expect(Math.min(...ys)).toBeCloseTo(5, 5);
    expect(Math.max(...ys)).toBeCloseTo(10, 5);
  });

  it("puts the edge where the scores cross zero", () => {
    const values = scores(10, [2, 2, 6, 6]);
    for (let y = 2; y < 6; y++) values[y * 10 + 5] = 0.5; // the right column only just in
    const [[ring]] = contours(values, 10);
    // Between 0.5 (at 5.5) and -2 (at 6.5): a fifth of the way.
    expect(Math.max(...ring.map((p) => p[0]))).toBeCloseTo(5.7, 5);
  });

  it("keeps an island as a hole, and an island in the island as a piece of its own", () => {
    const values = scores(30, [2, 2, 28, 28]);
    for (let y = 8; y < 22; y++) for (let x = 8; x < 22; x++) values[y * 30 + x] = -2;
    for (let y = 12; y < 18; y++) for (let x = 12; x < 18; x++) values[y * 30 + x] = 2;
    const polygons = contours(values, 30);
    expect(polygons).toHaveLength(2);
    expect(polygons[0]).toHaveLength(2); // the lot and its island
    expect(polygons[1]).toHaveLength(1);
    // Marching squares trims each square corner by an eighth of a cell.
    expect(ringArea(polygons[0][1])).toBeCloseTo(14 * 14 - 0.5, 5);
  });

  it("takes off a lot's spurs and keeps the rest, square corners and all", () => {
    const g = grid(20, [4, 4, 12, 12], [12, 7, 18, 8]); // a lot with a curb line running off it
    const open = opened(g, 20);
    expect(open.reduce((n, v) => n + v, 0)).toBe(64);
    expect(open[7 * 20 + 15]).toBe(0);
  });

  it("keeps a sidewalk a cell or two wide when it isn't a lot", () => {
    const walk = scores(40, [5, 10, 35, 12]); // two cells wide
    expect(guessPolygons(walk, { seeds: [[20, 11]], cells: 40 })).toHaveLength(1);
    expect(guessPolygons(walk, { seeds: [[20, 11]], open: true, cells: 40 })).toHaveLength(0);
  });

  it("outlines just the piece under the tap, or just what's in the box", () => {
    const values = scores(40, [2, 2, 18, 18], [24, 24, 38, 38]);
    const tapped = guessPolygons(values, { seeds: [[30, 30]], cells: 40 });
    expect(tapped).toHaveLength(1);
    expect(Math.abs(ringArea(tapped[0][0]) - 14 * 14)).toBeLessThan(1);
    const boxed = guessPolygons(values, { box: [0, 0, 20, 20], open: true, cells: 40 });
    expect(boxed).toHaveLength(1);
    expect(Math.abs(ringArea(boxed[0][0]) - 16 * 16)).toBeLessThan(1);
    // A straight edge comes out as a handful of corners.
    expect(boxed[0][0].length).toBeLessThanOrEqual(9);
  });
});

/** A square ring in degrees, [west, south] corner and size. */
const square = (w: number, s: number, size: number) => [[w, s], [w + size, s], [w + size, s + size], [w, s + size], [w, s]];

describe("adding to and taking out of an outline", () => {
  const lot = [square(-79.183, 37.362, 0.001)];
  const lane = [square(-79.1822, 37.3622, 0.0005)];

  it("adds a tap's piece to the outline as one shape", () => {
    const joined = combine([lot], [lane], "add");
    expect(joined).toHaveLength(1);
    expect(polygonAreaM2(joined[0])).toBeGreaterThan(polygonAreaM2(lot));
  });

  it("takes out what's under a tap as a hole", () => {
    const island = [square(-79.1827, 37.3623, 0.0002)];
    const out = combine([lot], [island], "out");
    expect(out).toHaveLength(1);
    expect(out[0]).toHaveLength(2);
  });

  it("cuts OpenStreetMap's buildings out of a guess and says so", () => {
    const roof = [square(-79.1825, 37.3625, 0.0002)];
    const cut = withoutBuildings([lot], [roof]);
    expect(cut.osm).toBe(true);
    expect(polygonAreaM2(cut.polygons[0])).toBeLessThan(polygonAreaM2(lot));
    expect(withoutBuildings([lot], [[square(-79.2, 37.4, 0.0002)]]).osm).toBe(false);
  });

  it("drops scraps and car-sized holes", () => {
    const car = square(-79.1825, 37.3625, 0.00002); // about 2 m across
    const scrap = [square(-79.19, 37.36, 0.00001)];
    expect(tidy([[lot[0], car], scrap])).toEqual([[lot[0]]]);
  });

  it("drops a sliver left beside the lot when a building is cut out", () => {
    const sliver = [square(-79.1815, 37.362, 0.00008)]; // about 9 m across: big enough alone, tiny beside the lot
    expect(withoutScraps([lot, sliver])).toEqual([lot]);
    expect(withoutScraps([sliver])).toEqual([sliver]);
  });

  it("finds the mapped lot a tap is on, the smallest when lots are mapped inside lots", () => {
    const small = [square(-79.1828, 37.3622, 0.0003)];
    expect(lotAt([lot, small], [-79.1826, 37.3624])).toBe(small);
    expect(lotAt([lot, small], [-79.1822, 37.3628])).toBe(lot);
    expect(lotAt([lot], [-79.19, 37.36])).toBeNull();
  });

  it("pads a box a little and keeps it on the picture", () => {
    expect(padBox([[100, 100], [300, 200]], 1024, 800)).toEqual([88, 88, 312, 212]);
    expect(padBox([[0, 0], [1000, 790]], 1024, 800)).toEqual([0, 0, 1024, 800]);
  });
});

describe("takeoff sheet", () => {
  it("draws a graphic scale a round number of feet long", () => {
    expect(scaleLength(0.5, 180)).toBe(100);
    expect(scaleLength(0.12, 180)).toBe(20);
    expect(scaleLength(3, 180)).toBe(500);
  });

  it("knows how many feet a pixel is at a zoom and latitude", () => {
    // At zoom 19 on the equator a 512 px tile spans about 76.4 m, so a pixel is about 0.49 ft.
    expect(feetPerPixel(19, 0)).toBeCloseTo(0.4897, 3);
    expect(feetPerPixel(19, 60)).toBeCloseTo(0.4897 / 2, 3);
    expect(feetPerPixel(19, 0, 2)).toBeCloseTo(0.4897 / 2, 3);
  });
});

const section = (item: string, kind: Section["kind"], value: number): Section => ({ feature_id: item, label: item, kind, value, unit: kind === "Area" ? "sq ft" : kind === "Length" ? "ft" : "ea", manual_override: false, item });
const takeoff = (sections: Section[]): TakeoffRow => ({
  id: "m1", title: "Lot", sections, total_area_sqft: sections.filter((s) => s.kind === "Area").reduce((t, s) => t + s.value, 0), total_area_sqyd: 0,
  total_length_ft: 0, roof_pitch: null, waste_pct: 0, roofing_squares: null, snapshot_path: null, show_on_quote: false, updated_at: "2026-10-20T12:00:00Z",
});

describe("the paving flow", () => {
  it("prices services from a takeoff's items", () => {
    const vars = takeoffVariables(takeoff([section("asphalt", "Area", 18_000), section("crack", "Length", 450), section("ada_stall", "Count", 1)]), 2);
    expect(formulaValue("sealcoat_sqft", vars)).toBe(18_000);
    expect(formulaValue("crack_ft", vars)).toBe(450);
    expect(formulaValue("asphalt_sqyd * depth_in * 110 / 2000", vars)).toBeCloseTo(220, 0);
    expect(formulaValue("nonsense_ft", vars)).toBeNull();
  });

  it("tells sealing the asphalt from paving it", () => {
    expect(serviceKind("sealcoat_sqft")).toBe("seal");
    expect(serviceKind("area_sqft", "Sealcoat")).toBe("seal"); // a price list from before paving items
    expect(serviceKind("asphalt_sqyd * depth_in * 110 / 2000")).toBe("pave");
    expect(serviceKind("stripe_ft")).toBe("other");
    expect(serviceKind(null)).toBe("other");
    expect(usesDepth("asphalt_sqyd * depth_in")).toBe(true);
    expect(usesDepth("stripe_ft")).toBe(false);
  });

  it("knows which step a project is on", () => {
    const m = takeoff([section("asphalt", "Area", 1000)]);
    expect(currentStep(null, null)).toBe("takeoff");
    expect(currentStep({ status: "draft", lines: [], jobs: [] }, m)).toBe("estimate");
    expect(currentStep({ status: "draft", lines: [{}], jobs: [] }, m)).toBe("proposal");
    expect(currentStep({ status: "sent", lines: [{}], jobs: [] }, m)).toBe("proposal");
    expect(currentStep({ status: "approved", lines: [{}], jobs: [] }, m)).toBe("schedule");
    expect(currentStep({ status: "converted", lines: [{}], jobs: [{ id: "j", status: "active" }] }, m)).toBe("invoice");
    expect(currentStep({ status: "converted", lines: [{}], jobs: [{ id: "j", status: "active" }] }, m, [{ status: "sent" }])).toBe("invoice");
    expect(currentStep({ status: "converted", lines: [{}], jobs: [{ id: "j", status: "completed" }] }, m, [{ status: "paid" }])).toBe("done");
    expect(stageLabel({ status: "sent", lines: [{}] }, true).label).toBe("Proposal sent");
    expect(stageLabel({ status: "draft", lines: [] }, true).label).toBe("Estimate");
  });
});

describe("a paving estimate that offers options", () => {
  // Good (shown) is sealcoat; Better is sealcoat and crack fill, with an add-on nobody picked. Striping is on every option.
  const line = (id: string, option_id: string | null, quantity: number, unit_price: number, unit_cost: number | null, patch: Partial<SumsLine> = {}): SumsLine & { id: string; service_id: string } => ({
    id, service_id: `s-${id.replace(/^(good|better)-/, "")}`, option_id, quantity, unit_price, unit_cost, taxable: true, optional: false, selected: option_id === null || option_id === "good", material_cost: null, materials: null, ...patch,
  });
  const lines = [
    line("good-seal", "good", 18_000, 0.18, 0.09),
    line("better-seal", "better", 18_000, 0.22, 0.1),
    line("better-crack", "better", 450, 1.5, 0.6),
    line("better-edge", "better", 1, 400, 150, { optional: true, selected: false }),
    line("stripe", null, 1_200, 0.5, 0.2),
  ];
  const money = { taxRate: 0.07, discountAmount: 100, promo: null };
  // What the database has with Good shown: its lines and the shared ones selected.
  const saved = quoteTotals(lines, money);
  const quote = { option_id: "good", subtotal: saved.subtotal, total: saved.total, tax_rate: 0.07, discount_amount: 100, promo: null, lines };

  it("lists the option looked at with the shared lines", () => {
    expect(viewedLines(lines, "better").map((l) => l.id)).toEqual(["better-seal", "better-crack", "better-edge", "stripe"]);
    expect(viewedLines(lines, "good").map((l) => l.id)).toEqual(["good-seal", "stripe"]);
    expect(viewedLines(lines, null).map((l) => l.id)).toEqual(["stripe"]);
  });

  it("prices the option shown as the quote's saved totals", () => {
    const sums = estimateSums(quote, "good");
    expect(sums.price).toBe(3240 + 600);
    expect(sums.total).toBe(saved.total);
    expect(sums.cost).toBe(1620 + 240);
    expect(sums.profit).toBe(3840 - 1860);
    expect(sums.margin).toBe(Math.round((1980 / 3840) * 100));
    expect(sums.costKnown).toBe(true);
  });

  it("prices another option as the database will once it's shown, without its add-on nobody picked", () => {
    const sums = estimateSums(quote, "better");
    const totals = optionTotals(lines, "better", "good", money);
    expect(sums.price).toBe(totals.subtotal);
    expect(sums.price).toBe(3960 + 675 + 600);
    expect(sums.total).toBe(totals.total);
    expect(sums.cost).toBe(1800 + 270 + 240);
    expect(sums.margin).toBe(Math.round(((5235 - 2310) / 5235) * 100));
    // A line that counts with no cost: the cost is at least what's known.
    expect(estimateSums({ ...quote, lines: lines.map((l) => (l.id === "better-crack" ? { ...l, unit_cost: null } : l)) }, "better")).toMatchObject({ costKnown: false, margin: null, cost: 1800 + 240 });
    // The add-on nobody picked doesn't make it unknown.
    expect(estimateSums({ ...quote, lines: lines.map((l) => (l.id === "better-edge" ? { ...l, unit_cost: null } : l)) }, "better").costKnown).toBe(true);
  });

  it("counts the materials priced for the option looked at", () => {
    const priced = lines.map((l) => (l.id === "better-seal" ? { ...l, material_cost: 1500.5, materials: { items: [{ total: 1500.5, quantity: 30 }, { total: null, quantity: 2 }] } } : l.id === "good-seal" ? { ...l, material_cost: 1200 } : l));
    expect(estimateSums({ ...quote, lines: priced }, "better")).toMatchObject({ materials: 1500.5, materialsPartial: true });
    expect(estimateSums({ ...quote, lines: priced }, "good")).toMatchObject({ materials: 1200, materialsPartial: false });
    expect(estimateSums(quote, "good").materials).toBeNull();
  });

  it("prices an estimate without options from its saved totals", () => {
    const single = lines.filter((l) => l.option_id === null || l.option_id === "good").map((l) => ({ ...l, option_id: null }));
    const totals = quoteTotals(single, money);
    expect(estimateSums({ ...quote, option_id: null, subtotal: totals.subtotal, total: totals.total, lines: single }, null)).toMatchObject({ price: totals.subtotal, total: totals.total, cost: 1860 });
  });

  it("ticks a service another option has its own line of onto the option looked at only", () => {
    // Looking at Good, ticking crack fill: on every option, Better would have it twice.
    expect(lineDestination({ id: "s-crack", name: "Crack fill" }, "good", { lines, place: "every" })).toBe("good");
    expect(lineDestination({ id: "s-sealer-edge", name: "Edging" }, "good", { lines, place: "every" })).toBeNull();
    expect(lineDestination({ id: "s-sealer-edge", name: "Edging" }, "good", { lines, place: "only" })).toBe("good");
  });
});
