import { describe, expect, it } from "vitest";
import { lawnItem } from "@crewtavo/core/lawn";
import { pavingItem } from "@crewtavo/core/paving";
import { readFileSync } from "node:fs";
import { boxAround, buildingAt, buildingsOn } from "../src/features/measure/buildings";
import { lasHeader } from "../src/features/measure/lidar";
import { roofOrLawn } from "../src/features/measure/modes";
import { drawnAs, itemAfterTool } from "../src/features/measure/nextShape";
import { drawable, loadedShapes } from "../src/features/measure/reopen";
import { photoAngle, pitchFromAngle, startingHandles, tiltOf } from "../src/features/measure/pitchMath";
import { groupRows } from "../src/features/measure/TakeoffList";

describe("pitch gauges", () => {
  it("reads the phone's tilt whichever way it lies on the roof", () => {
    // 6/12 is 26.57 degrees, tipped front to back, side to side, or a bit of both.
    expect(tiltOf(26.57, 0)).toBeCloseTo(26.57, 2);
    expect(tiltOf(0, -26.57)).toBeCloseTo(26.57, 2);
    // Laid at an angle across the slope, it tips both ways and still reads 6/12.
    expect(tiltOf(18.43, 19.47)).toBeCloseTo(26.57, 1);
    expect(tiltOf(-26.57, 0)).toBeCloseTo(26.57, 2);
    expect(pitchFromAngle(26.57)).toBe("6/12");
    expect(pitchFromAngle(28.5)).toBe("6.5/12");
    expect(pitchFromAngle(0)).toBe("0/12");
  });

  it("measures the angle between the two lines on a photo of any shape", () => {
    for (const [w, h] of [[4032, 3024], [3024, 4032], [1000, 1000]]) {
      expect(photoAngle(startingHandles(w, h), w, h)).toBeCloseTo(26.565, 2);
    }
    // A tilted photo: the level line slopes too, and the angle between them is what counts.
    const tilted = { roof: [[0, 0.5], [0.5, 0.2]] as [[number, number], [number, number]], level: [[0, 0.6], [1, 0.55]] as [[number, number], [number, number]] };
    const roof = Math.atan2(-0.3, 0.5);
    const level = Math.atan2(-0.05, 1);
    expect(photoAngle(tilted, 1, 1)).toBeCloseTo(Math.abs(roof - level) * (180 / Math.PI), 6);
    // Drawn right to left, or with the ends swapped, reads the same.
    expect(photoAngle({ roof: [tilted.roof[1], tilted.roof[0]], level: tilted.level }, 1, 1)).toBeCloseTo(photoAngle(tilted, 1, 1), 6);
  });
});

describe("building outlines", () => {
  const square = (x: number, y: number, size: number) => [[[x, y], [x + size, y], [x + size, y + size], [x, y + size], [x, y]]];
  const yard = square(-80.5, 37.1, 0.001);
  const house = square(-80.4996, 37.1004, 0.0002);
  const nextDoor = square(-80.497, 37.1004, 0.0002);

  it("keeps the buildings on the areas, and skips ones already cut out", () => {
    expect(buildingsOn([house, nextDoor], [yard], [])).toEqual([house]);
    expect(buildingsOn([house, nextDoor], [yard], [house])).toEqual([]);
  });

  it("finds the building a spot is in, or the nearest one close by", () => {
    expect(buildingAt([nextDoor, house], [-80.4995, 37.1005])).toBe(house);
    expect(buildingAt([nextDoor, house], [-80.49938, 37.1005])).toBe(house); // a couple of meters outside
    expect(buildingAt([nextDoor], [-80.4995, 37.1005])).toBeNull();
    expect(boxAround([yard])![0]).toBeLessThan(-80.5);
  });
});

describe("lidar files", () => {
  it("reads what it needs from a LAS header", () => {
    // A LAS 1.2 header like USGS's: compressed point format 1, 29 bytes a point.
    const file = new Uint8Array(375);
    const view = new DataView(file.buffer);
    file.set([76, 65, 83, 70], 0); // "LASF"
    file[24] = 1;
    file[25] = 2;
    view.setUint8(104, 1 | 0x80);
    view.setUint16(105, 29, true);
    view.setUint32(107, 2775, true);
    [0.01, 0.01, 0.01, -9008040, 4537090, 982].forEach((n, i) => view.setFloat64(131 + i * 8, n, true));
    expect(lasHeader(file)).toEqual({ format: 1, length: 29, count: 2775, scale: [0.01, 0.01, 0.01], offset: [-9008040, 4537090, 982] });
    // LAS 1.4 keeps big counts in 64 bits.
    file[25] = 4;
    view.setUint32(107, 0, true);
    view.setBigUint64(247, 5_000_000_000n, true);
    expect(lasHeader(file).count).toBe(5_000_000_000);
    file[0] = 0;
    expect(() => lasHeader(file)).toThrow("Not a LAS file");
  });
});

describe("the takeoff list", () => {
  const rows = [
    { id: "a", kind: "Area" as const, value: 1000 },
    { id: "b", kind: "Area" as const, value: 500 },
    { id: "c", kind: "Length" as const, value: 40 },
    { id: "d", kind: "Length" as const, value: 30 },
    { id: "e", kind: "Count" as const, value: 1 },
    { id: "f", kind: "Cutout" as const, value: 200 },
  ];

  it("groups items the way the items are, and the rest by kind with their totals", () => {
    // "c" is crack seal; "b" says it's a stall row, which an area can't be, so it stays a plain area.
    const groups = groupRows(rows, { a: "asphalt", b: "stall_row", c: "crack" }, {}, false, "sqft");
    expect(groups.map((g) => g.title)).toEqual(["Pavement", "Sealcoat and repair", "Areas", "Cut out", "Lines", "Counts"]);
    expect(groups[0].entries).toEqual([{ item: expect.objectContaining({ id: "asphalt" }), rows: [rows[0]] }]);
    expect(groups.find((g) => g.title === "Areas")?.total).toBe("500 sq ft");
    expect(groups.find((g) => g.title === "Cut out")?.total).toBe("−200 sq ft");
    expect(groups.find((g) => g.title === "Counts")?.total).toBe("1");
  });

  it("puts a lawn's beds, edging and counts under Lawn items, and calls its areas the lawn", () => {
    // "f" is a bed (a cutout), "c" edging, "e" a tree; the rest stay plain.
    const groups = groupRows(rows, { f: "bed", c: "edging", e: "tree" }, {}, false, "sqft", true);
    expect(groups.map((g) => g.title)).toEqual(["Lawn items", "Lawn", "Lines"]);
    expect(groups[0].entries.map((e) => ("item" in e ? e.item.id : null))).toEqual(["bed", "edging", "tree"]);
    expect(groups.find((g) => g.title === "Lawn")?.total).toBe("1,500 sq ft");
  });

  it("puts a roof's lines under their edges, and its areas as sections, in square yards when asked", () => {
    const groups = groupRows(rows, {}, { c: "ridge" }, true, "sqyd");
    expect(groups.map((g) => [g.title, g.total])).toEqual([
      ["Roof sections", "166.7 sq yd"],
      ["Cut out", "−200 sq ft"],
      ["Ridges", "40 ft"],
      ["Lines", "30 ft"],
      ["Counts", "1"],
    ]);
  });
});

describe("the next shape's item", () => {
  const bed = lawnItem("bed")!;
  const asphalt = pavingItem("asphalt")!;
  const read = (file: string) => readFileSync(new URL(`../src/features/measure/${file}`, import.meta.url), "utf8");

  it("is a bed only while Bed is picked: pressing Cut out goes back to a plain cutout", () => {
    expect(itemAfterTool(bed, "cutout")).toBeNull();
    // Cutting an island out of the asphalt keeps asphalt picked, as it always did.
    expect(itemAfterTool(asphalt, "cutout")).toBe(asphalt);
    expect(itemAfterTool(asphalt, "polygon")).toBeNull();
    expect(itemAfterTool(bed, "select")).toBeNull();
    const page = read("MeasurePage.tsx");
    expect(page).toContain("setActiveItem((item) => itemAfterTool(item, next));");
  });

  it("goes on the shapes a person draws, never on ones put on the map for them", () => {
    // A bed drawn by hand; a house cut out by Find or from OpenStreetMap's buildings while Bed is picked.
    expect(drawnAs([{ id: "drawn", kind: "Cutout" }, { id: "house", kind: "Cutout", byCode: true }], bed)).toEqual({ drawn: "bed" });
    // An item only goes on the kind of shape it can be.
    expect(drawnAs([{ id: "island", kind: "Cutout" }, { id: "lot", kind: "Area" }, { id: "found", kind: "Area", byCode: true }], asphalt)).toEqual({ lot: "asphalt" });
    expect(drawnAs([{ id: "drawn", kind: "Cutout" }], null)).toEqual({});
    // The map says which shapes it was handed: Find's and the buildings' (add), counts found (addPoints),
    // a reopened drawing (load) and an area made a cutout (convert).
    const map = read("MeasureMap.tsx");
    expect(map.match(/byCode\.current\.add\(/g)).toHaveLength(4);
    expect(map).toContain("...(byCode.current.has(String(f.id)) ? { byCode: true as const } : {})");
    expect(read("MeasurePage.tsx")).toContain("const tagged = drawnAs(fresh, activeItem);");
  });
});

describe("reopening a saved drawing", () => {
  const read = (file: string) => readFileSync(new URL(`../src/features/measure/${file}`, import.meta.url), "utf8");
  const shape = (label: string, type = "Polygon", properties: Record<string, unknown> = {}) => ({ type: "Feature" as const, geometry: { type, coordinates: [] }, properties: { label, ...properties } });

  it("puts each name, item and slope back on its own shape when the map turns one away", () => {
    const saved = [shape("Front lawn", "Polygon", { slope: { mean_pct: 4, steep_pct: 0 } }), shape("House", "Polygon", { cutout: true }), shape("Both lots", "MultiPolygon"), shape("Rose bed", "Polygon", { cutout: true, item: "bed" }), shape("Oak", "Point", { item: "tree" })];
    // The map took the lawn, the bed and the tree: it refused the house, and doesn't draw the two lots.
    const loaded = loadedShapes(saved, ["1", null, null, "2", "3"]);
    expect(loaded.map((l) => [l.id, l.feature.properties?.label])).toEqual([["1", "Front lawn"], ["2", "Rose bed"], ["3", "Oak"]]);
    expect(loaded[1].feature.properties?.item).toBe("bed");
    // Everything it draws, it took: nothing to warn about. One fewer, and the page says so.
    expect(saved.filter(drawable)).toHaveLength(4);
    expect(loadedShapes(saved, ["1", "2", null, "3", "4"])).toHaveLength(4);
    expect(loadedShapes(saved, [])).toEqual([]);
  });

  it("rounds a saved shape's points to what the map takes, so a drawing an assistant saved opens whole", () => {
    const map = read("MeasureMap.tsx");
    const load = map.slice(map.indexOf("    load(features) {"), map.indexOf("    async capture("));
    expect(load).toContain("geometry: { ...f.geometry, coordinates: roundCoordinates(f.geometry.coordinates) }");
    // One answer for every saved shape, so the page never pairs by counting.
    expect(load).toContain("return rows.map((r) => (r && results[added++]?.valid !== false ? String(r.id) : null));");
    const page = read("MeasurePage.tsx");
    expect(page).toContain("const loaded = loadedShapes(saved, mapRef.current?.load(saved) ?? []);");
    expect(page).toContain("if (ids.length < saved.filter(drawable).length) toast.error(");
  });
});

describe("a lawn's slope in Measure", () => {
  it("is asked of USGS with the country the place is in, so a Canadian lawn has none and can be picked or asked of Google", () => {
    const page = readFileSync(new URL("../src/features/measure/MeasurePage.tsx", import.meta.url), "utf8");
    // The address last searched or picked, else the property's, else the business's (core readSlope and inUs decide).
    expect(page).toContain("const slopeCountry = placeCountry ?? ctx?.property?.country ?? companyCountry();");
    expect(page).toContain("readSlope(area, cutouts, { country: slopeCountry })");
    expect(page).toContain("setPlaceCountry(to.country);");
    expect(page).toContain('select("id, line1, city, region, postal_code, country, lat, lng, client:clients(id, display_name)")');
  });
});

describe("the Depth card", () => {
  it("stays as the person left it while a depth is typed: open through 0, 0. and 0.5", () => {
    const page = readFileSync(new URL("../src/features/measure/MeasurePage.tsx", import.meta.url), "utf8");
    const card = page.slice(page.indexOf("const depthCard = ("), page.indexOf("const lawnCard = ("));
    // Whether it's open is the person's doing alone. It used to follow the depth typed (open while it
    // read as 0, shut once it read as a number), which shut it between "0" and "0.5".
    expect(card).toContain("<details key=\"depth\" className=\"measure-extra\" open={depthOpen} onToggle={(e) => setDepthOpen(e.currentTarget.open)}>");
    expect(card).not.toMatch(/open=\{[^}]*depthIn/);
    expect(card).not.toMatch(/open=\{[^}]*\(depth\)/);
    expect(page).toContain("const [depthOpen, setDepthOpen] = useState(false);");
  });
});

describe("roof tools and lawn tools", () => {
  it("keeps a lawn's tools when Roof pitch and edges is only opened", () => {
    // A lawn care business looks into the roof card: its lawn items, Find, slope and Lawn card stay.
    expect(roofOrLawn({ roof: false, roofCardOpen: true, lawn: true })).toEqual({ roofing: false, lawn: true });
    expect(roofOrLawn({ roof: false, roofCardOpen: false, lawn: true })).toEqual({ roofing: false, lawn: true });
    // Once a pitch or an edge is set it's a roof, as before; so is anything with Roofing installed.
    expect(roofOrLawn({ roof: true, roofCardOpen: true, lawn: true })).toEqual({ roofing: true, lawn: false });
    expect(roofOrLawn({ roof: true, roofCardOpen: false, lawn: true })).toEqual({ roofing: true, lawn: false });
    // With no lawn in it, opening the card still brings out the roof tools.
    expect(roofOrLawn({ roof: false, roofCardOpen: true, lawn: false })).toEqual({ roofing: true, lawn: false });
    expect(roofOrLawn({ roof: false, roofCardOpen: false, lawn: false })).toEqual({ roofing: false, lawn: false });
    const page = readFileSync(new URL("../src/features/measure/MeasurePage.tsx", import.meta.url), "utf8");
    expect(page).toContain("const { roofing, lawn } = roofOrLawn({ roof: roofSet, roofCardOpen: roofOpen, lawn: lawnTrade || lawnDrawing || lawnOn });");
    // The card itself opens and shuts by its own switch, a roof or not.
    expect(page).toContain("<details key=\"roof\" className=\"measure-extra\" open={roofing || roofOpen} onToggle={(e) => setRoofOpen(e.currentTarget.open)}>");
  });
});
