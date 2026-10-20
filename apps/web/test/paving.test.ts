import type { Section } from "@crewtavo/core/geo";
import { describe, expect, it } from "vitest";
import { centers, gridPolygons, outlines, pieceAt, ringArea, simplifyRing } from "../src/features/measure/detect";
import { maskGrids, pickMask, pixelValues, SAM_GRID, SAM_SIZE } from "../src/features/measure/samLocal";
import { feetPerPixel, scaleLength } from "../src/features/measure/takeoffSheet";
import { currentStep, formulaValue, serviceKind, stageLabel, takeoffVariables, usesDepth, type TakeoffRow } from "../src/features/paving/data";

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

  it("turns the model's masks into grids, leaving the padding under the picture off", () => {
    const side = 256;
    const logits = new Float32Array(3 * side * side).fill(-5);
    const on = (m: number, x0: number, y0: number, x1: number, y1: number) => {
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) logits[m * side * side + y * side + x] = 3;
    };
    on(0, 10, 10, 20, 20);
    on(1, 0, 100, 50, 200); // half of it below a 1024 × 512 picture
    const { grids, scores } = maskGrids(logits, [1, 1, 3, side, side], [0.9, 0.8, 0.1], SAM_SIZE, 512);
    expect(grids).toHaveLength(3);
    expect(scores).toEqual([0.9, 0.8, 0.1]);
    expect(grids[0].reduce((n, v) => n + v, 0)).toBe(100);
    expect(grids[1].reduce((n, v) => n + v, 0)).toBe(50 * 28); // rows 100 to 127 only
    expect(grids[2].every((v) => v === 0)).toBe(true);
    expect(grids[0].length).toBe(SAM_GRID * SAM_GRID);
  });

  it("starts on the whole lot, not the speck SAM scores highest", () => {
    // Answers from a tap on the Radford lot: the lot, then two specks around the tap.
    expect(pickMask([{ cells: 19526, score: 0.72 }, { cells: 21, score: 0.87 }, { cells: 18, score: 0.9 }])).toBe(0);
    expect(pickMask([{ cells: 2356, score: 0.44 }, { cells: 13251, score: 0.84 }, { cells: 900, score: 0.95 }])).toBe(1);
    // Not fairly sure of any: the surest.
    expect(pickMask([{ cells: 500, score: 0.3 }, { cells: 40, score: 0.45 }])).toBe(1);
    expect(pickMask([])).toBe(-1);
  });

  it("normalizes the picture the way SAM was trained, top-left in the padded square", () => {
    const rgba = new Uint8ClampedArray([255, 255, 255, 255, 0, 0, 0, 255]); // white, black
    const out = pixelValues(rgba, 2, 1);
    const plane = SAM_SIZE * SAM_SIZE;
    expect(out.length).toBe(3 * plane);
    expect(out[0]).toBeCloseTo((1 - 0.485) / 0.229, 4); // white's red
    expect(out[plane + 1]).toBeCloseTo(-0.456 / 0.224, 4); // black's green
    expect(out[2]).toBe(0); // padding
    expect(out[SAM_SIZE]).toBe(0);
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
  total_length_ft: 0, roof_pitch: null, waste_pct: 0, snapshot_path: null, show_on_quote: false, updated_at: "2026-10-20T12:00:00Z",
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
