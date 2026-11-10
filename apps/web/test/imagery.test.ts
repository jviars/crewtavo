import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { autoOrder, imageryCredit, mapKeys, openingImagery, overlaySource, resolveAuto, setMyDefault, SLOPE_CLASSES, type ImageryId } from "../src/features/measure/imagery";

const ROCKY_MOUNT = [-79.8717, 37.0547] as const;
const LONDON = [-0.13, 51.5] as const;

describe("Auto imagery", () => {
  it("tries the state's own imagery, then NAIP, then USGS, and the street map last", () => {
    expect(autoOrder(...ROCKY_MOUNT, 19, {})).toEqual(["state:VA", "naip", "usgs-naip", "usgs", "street"]);
    // Esri only with a key, and Google only when the key is the company's own.
    expect(autoOrder(...LONDON, 19, { esri_key: "AAPTkey", google_key: "AIza" })).toEqual(["naip", "usgs-naip", "usgs", "esri", "street"]);
    // Zoomed out: the USGS basemap, without asking anyone.
    expect(autoOrder(...ROCKY_MOUNT, 6, {})).toEqual(["usgs", "street"]);
  });

  it("starts on Google satellite when the company added its own Google key", async () => {
    const own = mapKeys({ maps: { google_key: " AIzaOwn " } }, "AIzaDeployment");
    expect(own).toEqual({ esri_key: null, google_key: "AIzaOwn", google_own: true });
    expect(autoOrder(...ROCKY_MOUNT, 19, own)).toEqual(["google", "state:VA", "naip", "usgs-naip", "usgs", "street"]);
    expect(autoOrder(...ROCKY_MOUNT, 6, own)).toEqual(["google", "usgs", "street"]);
    // Zoomed out, Google covers the world: nothing to ask.
    const probe = vi.fn(async () => "ok" as const);
    expect(await resolveAuto(...LONDON, 6, own, probe)).toEqual({ id: "google", passed: [] });
    expect(probe).not.toHaveBeenCalled();
    // Google not answering: the free imagery, as before.
    expect((await resolveAuto(...ROCKY_MOUNT, 19, own, async () => "ok", (id) => id === "google")).id).toBe("state:VA");

    // The deployment's key is a choice on the Imagery button, not something Auto spends.
    const deployment = mapKeys({}, "AIzaDeployment");
    expect(deployment).toEqual({ esri_key: null, google_key: "AIzaDeployment", google_own: false });
    expect(autoOrder(...ROCKY_MOUNT, 19, deployment)[0]).toBe("state:VA");
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

describe("what Measure opens on", () => {
  beforeEach(() => {
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v), removeItem: (k: string) => store.delete(k) });
  });
  afterEach(() => vi.unstubAllGlobals());

  const google = { google_key: "AIzaKey" };
  const team = (default_imagery: string) => ({ maps: { default_imagery } });

  it("opens on Auto unless the team or the person picked something", () => {
    expect(openingImagery({}, {})).toBe("auto");
    expect(openingImagery(team("terrain"), {})).toBe("terrain");
  });

  it("passes over a default whose key is gone, and anything that isn't a default", () => {
    expect(openingImagery(team("google"), google)).toBe("google");
    expect(openingImagery(team("google"), {})).toBe("auto");
    expect(openingImagery(team("state:VA"), {})).toBe("auto");
    expect(openingImagery(team("bogus"), {})).toBe("auto");
  });

  it("lets each person pick their own, Auto included, and go back to the team's", () => {
    setMyDefault("street");
    expect(openingImagery(team("google"), google)).toBe("street");
    setMyDefault("auto");
    expect(openingImagery(team("google"), google)).toBe("auto");
    setMyDefault(null);
    expect(openingImagery(team("google"), google)).toBe("google");
    // Their pick needs its key too.
    setMyDefault("esri");
    expect(openingImagery(team("terrain"), google)).toBe("terrain");
  });
});
