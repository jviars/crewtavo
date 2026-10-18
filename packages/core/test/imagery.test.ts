import { describe, expect, it } from "vitest";
import { esriImageryTiles, googleSatelliteTiles, inBounds, LOWER_48, STATE_IMAGERY, stateImagery, stateImageryAt, stateTileUrl } from "../src/imagery";

describe("state imagery", () => {
  it("lists each state once, with a box that holds its capital", () => {
    const capitals: Record<string, [number, number]> = {
      AR: [-92.29, 34.75], CT: [-72.68, 41.76], DC: [-77.01, 38.89], DE: [-75.52, 39.16], IN: [-86.16, 39.77], KY: [-84.87, 38.19],
      MA: [-71.06, 42.36], MD: [-76.49, 38.98], NC: [-78.64, 35.78], ND: [-100.78, 46.81], NJ: [-74.76, 40.22], NY: [-73.76, 42.65],
      OH: [-83.0, 39.96], OR: [-123.03, 44.94], RI: [-71.41, 41.82], TN: [-86.78, 36.16], VA: [-77.43, 37.54], VT: [-72.58, 44.26],
    };
    expect(new Set(STATE_IMAGERY.map((s) => s.state)).size).toBe(STATE_IMAGERY.length);
    expect(STATE_IMAGERY.map((s) => s.state).sort()).toEqual(Object.keys(capitals).sort());
    for (const s of STATE_IMAGERY) {
      const [lng, lat] = capitals[s.state];
      expect(inBounds(s.bounds, lng, lat), s.state).toBe(true);
      expect(s.url.startsWith("https://"), s.state).toBe(true);
      expect(inBounds(LOWER_48, lng, lat), s.state).toBe(true);
    }
  });

  it("offers the state under the map, the smallest box first", () => {
    // 160 Energy Blvd, Rocky Mount VA.
    expect(stateImageryAt(-79.8717, 37.0547).map((s) => s.state)).toEqual(["VA"]);
    // The Capitol: DC's own imagery before Maryland's and Virginia's.
    expect(stateImageryAt(-77.009, 38.8899)[0].state).toBe("DC");
    // Austin TX and London: nothing.
    expect(stateImageryAt(-97.74, 30.27)).toEqual([]);
    expect(stateImageryAt(-0.13, 51.5)).toEqual([]);
    expect(stateImagery("va")?.name).toBe("Virginia");
    expect(stateImagery("TX")).toBeNull();
  });

  it("asks a tile cache for z/y/x and a drawing service for the tile's box", () => {
    expect(stateTileUrl(stateImagery("VA")!)).toMatch(/\/MapServer\/tile\/\{z\}\/\{y\}\/\{x\}$/);
    expect(stateTileUrl(stateImagery("KY")!)).toContain("/ImageServer/exportImage?bbox={bbox-epsg-3857}&bboxSR=3857&imageSR=3857&size=256,256");
    expect(stateTileUrl(stateImagery("NY")!)).toContain("/MapServer/export?bbox={bbox-epsg-3857}");
  });

  it("puts keys in the URL safely", () => {
    expect(esriImageryTiles("AAPT a&b")).toMatch(/\?token=AAPT%20a%26b$/);
    expect(googleSatelliteTiles("k&", "s/1")).toContain("session=s%2F1&key=k%26");
  });
});
