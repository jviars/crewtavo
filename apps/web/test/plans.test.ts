import { describe, expect, it } from "vitest";
import {
  cornersOf, feetPerInch, feetPerPixel, fitToView, lineUp, LineUpError, moveTo, pixelAt, placementFromCorners, pointAt, scaleLabel, toMercator, turnDegrees, type LngLat,
} from "../src/features/measure/planAlign";
import { takeOutPaper } from "../src/features/plans/planImage";
import { canMap, fileSize, PLAN_FIELDS, planEntries, planMeta, titleFromFileName, type PlanFile } from "../src/features/plans/plans";

// Arrington's yard in Rocky Mount, VA.
const YARD: LngLat = [-79.8717, 37.0547];
const FT_PER_DEG_LAT = 364_000; // about right in southern Virginia

const close = (a: LngLat, b: LngLat, feet = 0.05) => {
  const dy = (a[1] - b[1]) * FT_PER_DEG_LAT;
  const dx = (a[0] - b[0]) * FT_PER_DEG_LAT * Math.cos((b[1] * Math.PI) / 180);
  expect(Math.hypot(dx, dy)).toBeLessThan(feet);
};
/** A spot so many feet east and north of another. */
const offset = ([lng, lat]: LngLat, east: number, north: number): LngLat => [lng + east / (FT_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180)), lat + north / FT_PER_DEG_LAT];

describe("lining a plan up with the map", () => {
  it("puts both spots exactly where they were tapped, and reads the plan's scale back", () => {
    // A 36x24 inch sheet drawn at 1 in = 30 ft, rendered at 100 pixels per inch.
    const pxPerInch = 100;
    const width = 3600;
    const height = 2400;
    // Two curb corners on the sheet, 2400 px (24 in = 720 ft) apart along the top edge.
    const pixels: [[number, number], [number, number]] = [[600, 400], [3000, 400]];
    // On the ground: the second is 720 ft due east of the first.
    const first = YARD;
    const second = offset(YARD, 720, 0);
    const p = lineUp(pixels, [first, second]);
    close(pointAt(p, pixels[0]), first);
    close(pointAt(p, pixels[1]), second);
    expect(feetPerPixel(p, YARD[1])).toBeCloseTo(0.3, 2);
    expect(scaleLabel(feetPerInch(p, YARD[1], pxPerInch))).toBe("1 in = 30 ft");
    expect(turnDegrees(p)).toBeCloseTo(0, 3);
    // And back: the pixel under a spot.
    const [u, v] = pixelAt(p, second);
    expect(u).toBeCloseTo(3000, 1);
    expect(v).toBeCloseTo(400, 1);
    // The corners describe the same placement, so a saved plan reopens where it was.
    const corners = cornersOf(p, width, height);
    const again = placementFromCorners(corners, width);
    close(pointAt(again, [1800, 1200]), pointAt(p, [1800, 1200]));
  });

  it("turns a plan drawn with north to the left", () => {
    // The sheet's "up" points west: going right on the sheet is going north on the ground.
    const p = lineUp([[0, 0], [1000, 0]], [YARD, offset(YARD, 0, 300)]);
    expect(turnDegrees(p)).toBeCloseTo(270, 1);
    // Going down the sheet is then going east.
    const below = pointAt(p, [0, 1000]);
    expect(below[0]).toBeGreaterThan(YARD[0]);
    close([below[0], YARD[1]], below);
  });

  it("starts the sheet upright in the middle of the view, and moves it without resizing", () => {
    const p = fitToView(YARD, YARD[0] - 0.002, YARD[0] + 0.002, 4000, 2000);
    expect(turnDegrees(p)).toBe(0);
    close(pointAt(p, [2000, 1000]), YARD);
    const moved = moveTo(p, [100, 100], offset(YARD, 50, 50));
    close(pointAt(moved, [100, 100]), offset(YARD, 50, 50));
    expect(moved.a).toBe(p.a);
  });

  it("says when the spots don't work", () => {
    expect(() => lineUp([[10, 10], [20, 20]], [YARD, offset(YARD, 100, 0)])).toThrow(LineUpError);
    expect(() => lineUp([[0, 0], [2000, 0]], [YARD, YARD])).toThrow(LineUpError);
  });

  it("uses the map's own projection", () => {
    expect(toMercator([0, 0])).toEqual([0.5, 0.5]);
    expect(toMercator([-180, 0])[0]).toBe(0);
  });
});

describe("plan files", () => {
  const file = (over: Partial<PlanFile>): PlanFile => ({
    id: "f1", company_id: "c", property_id: "p", request_id: null, quote_id: null, job_id: "j", folder_id: null, title: "Site plan", revision: null, notes: null, path: "c/plans/f1.pdf",
    file_name: "Site plan.pdf", content_type: "application/pdf", size_bytes: 12_400_000, crew_visible: true, archived: false, replaces_id: null, superseded_at: null, created_by: null,
    created_at: "2026-10-01T12:00:00Z", deleted_at: null, ...over,
  });

  it("puts versions under the current one, newest first", () => {
    const v1 = file({ id: "v1", superseded_at: "2026-10-05T00:00:00Z", created_at: "2026-10-01T12:00:00Z" });
    const v2 = file({ id: "v2", replaces_id: "v1", superseded_at: "2026-10-09T00:00:00Z", created_at: "2026-10-05T12:00:00Z" });
    const v3 = file({ id: "v3", replaces_id: "v2", revision: "Rev C", created_at: "2026-10-09T12:00:00Z" });
    const other = file({ id: "o", title: "Specs", created_at: "2026-10-10T12:00:00Z" });
    const entries = planEntries([v1, v3, other, v2]);
    expect(entries.map((e) => e.file.id)).toEqual(["o", "v3"]);
    expect(entries[1].older.map((f) => f.id)).toEqual(["v2", "v1"]);
    expect(entries[1].version).toBe(3);
    expect(planMeta(entries[1])).toBe("Version 3 · Rev C · 12 MB · PDF · updated Oct 9, 2026");
  });

  it("tells a crew the plan was updated without counting versions they can't see", () => {
    const [entry] = planEntries([file({ id: "v3", replaces_id: "v2" })]);
    expect(entry.hiddenHistory).toBe(true);
    expect(planMeta(entry)).toBe("12 MB · PDF · updated Oct 1, 2026");
  });

  it("reads every column a file needs to open in the viewer and be versioned in place, Drive folder included", () => {
    const columns = PLAN_FIELDS.split(",").map((c) => c.trim());
    expect(columns).toEqual(expect.arrayContaining(["id", "company_id", "path", "file_name", "content_type", "size_bytes", "crew_visible", "replaces_id", "superseded_at", "folder_id", "property_id", "request_id", "quote_id", "job_id"]));
    // Every column the list reads is on the type the screens use.
    const sample = file({});
    for (const c of columns) expect(sample).toHaveProperty(c);
  });

  it("names files and sizes the way people read them", () => {
    expect(titleFromFileName("C-101_Site_Plan rev B.pdf")).toBe("C-101 Site Plan rev B");
    expect(titleFromFileName(".pdf")).toBe("Plan");
    expect(fileSize(900)).toBe("1 KB");
    expect(fileSize(4_500_000)).toBe("4.3 MB");
    expect(fileSize(48_000_000)).toBe("46 MB");
    expect(canMap({ content_type: "application/pdf", file_name: "x.pdf" })).toBe(true);
    expect(canMap({ content_type: "image/jpeg", file_name: "scan.jpg" })).toBe(true);
    expect(canMap({ content_type: "image/heic", file_name: "IMG_1.heic" })).toBe(false);
    expect(canMap({ content_type: null, file_name: "drawing.dwg" })).toBe(false);
  });

  it("takes the paper out and keeps the lines", () => {
    const pixels = new Uint8ClampedArray([255, 255, 255, 255, /* paper */ 0, 0, 0, 255, /* black line */ 240, 240, 240, 255, /* scanner grey */ 200, 30, 30, 255 /* red line */]);
    takeOutPaper(pixels);
    expect(pixels[3]).toBe(0);
    expect(pixels[7]).toBe(255);
    expect(pixels[11]).toBe(0);
    expect(pixels[15]).toBe(255);
    expect([pixels[12], pixels[13], pixels[14]]).toEqual([200, 30, 30]);
  });
});
