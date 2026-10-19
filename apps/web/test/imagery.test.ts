import { describe, expect, it } from "vitest";
import { autoOrder, imageryCredit, overlaySource, resolveAuto, SLOPE_CLASSES, type ImageryId } from "../src/features/measure/imagery";

const ROCKY_MOUNT = [-79.8717, 37.0547] as const;
const LONDON = [-0.13, 51.5] as const;

describe("Auto imagery", () => {
  it("tries the state's own imagery, then NAIP, then USGS, and the street map last", () => {
    expect(autoOrder(...ROCKY_MOUNT, 19, {})).toEqual(["state:VA", "naip", "usgs-naip", "usgs", "street"]);
    // Esri only with a key, and never Google.
    expect(autoOrder(...LONDON, 19, { esri_key: "AAPTkey", google_key: "AIza" })).toEqual(["naip", "usgs-naip", "usgs", "esri", "street"]);
    // Zoomed out: the USGS basemap, without asking anyone.
    expect(autoOrder(...ROCKY_MOUNT, 6, {})).toEqual(["usgs", "street"]);
  });

  it("takes the first source with a picture here, and skips ones that aren't answering", async () => {
    const asked: ImageryId[] = [];
    const answers: Partial<Record<ImageryId, "ok" | "empty" | "down">> = { "state:VA": "ok" };
    const probe = async (id: ImageryId) => {
      asked.push(id);
      return answers[id] ?? "ok";
    };
    expect((await resolveAuto(...ROCKY_MOUNT, 19, {}, probe)).id).toBe("state:VA");

    // Virginia's server is down: NAIP, and it says why.
    asked.length = 0;
    const down = await resolveAuto(...ROCKY_MOUNT, 19, {}, probe, (id) => id === "state:VA");
    expect(down).toEqual({ id: "naip", passed: [{ id: "state:VA", why: "down" }] });
    expect(asked).toEqual(["naip"]);

    // London with no Esri key: nothing aerial, so the street map.
    const empty = async () => "empty" as const;
    expect((await resolveAuto(...LONDON, 19, {}, empty)).id).toBe("street");
    expect((await resolveAuto(...LONDON, 19, { esri_key: "AAPTkey" }, async (id) => (id === "esri" ? "ok" : "empty"))).id).toBe("esri");
  });

  it("credits the source it picked", () => {
    expect(imageryCredit("state:VA")).toBe("Imagery courtesy of the Commonwealth of Virginia (VGIN)");
    expect(imageryCredit("state:DC")).toContain("CC BY 4.0");
    expect(imageryCredit("street")).toContain("OpenStreetMap contributors");
    expect(imageryCredit("esri")).toMatch(/^Powered by Esri/);
  });
});

describe("slope and contours", () => {
  it("colors slope by grade, ending at steeper than 3:1", () => {
    expect(SLOPE_CLASSES.map((c) => c.upTo)).toEqual([2, 5, 10, 33.3, Infinity]);
    const rule = JSON.parse(decodeURIComponent(overlaySource("slope").tiles![0].match(/renderingRule=([^&]+)/)![1]));
    const ranges: number[] = rule.rasterFunctionArguments.Raster.rasterFunctionArguments.InputRanges;
    // 2% grade is about 1.15 degrees; 33.3% is about 18.4.
    expect(ranges[1]).toBeCloseTo(1.146, 2);
    expect(ranges[7]).toBeCloseTo(18.42, 1);
    expect(ranges.at(-1)).toBe(90);
  });

  it("asks USGS for each tile's box, with the drawing rule escaped", () => {
    const url = overlaySource("contours").tiles![0];
    expect(url).toContain("bbox={bbox-epsg-3857}");
    expect(url).not.toMatch(/renderingRule=\{/);
  });
});
