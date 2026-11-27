import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { autoOrder, imageryCredit, mapKeys, openingImagery, overlaySource, probeImagery, resolveAuto, setMyDefault, SLOPE_CLASSES, type ImageryId } from "../src/features/measure/imagery";
import { flatPicture, tilePixels } from "../src/features/measure/tileCheck";

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

/** A picture's pixels, RGBA: `fill` everywhere, then each of `spots` as [pixel, r, g, b, a]. */
function picture(size: number, fill: [number, number, number, number], spots: Array<[number, number, number, number, number]> = []) {
  const pixels = new Uint8ClampedArray(size * size * 4);
  for (let i = 0; i < size * size; i++) pixels.set(fill, i * 4);
  for (const [at, ...rgba] of spots) pixels.set(rgba, at * 4);
  return pixels;
}

describe("a picture of nothing", () => {
  it("is one colour all over, and nothing else is", () => {
    expect(flatPicture(picture(256, [0, 0, 0, 255]))).toBe(true); // Maryland's answer for a house in Virginia
    expect(flatPicture(picture(256, [255, 255, 255, 255]))).toBe(true);
    expect(flatPicture(picture(256, [0, 0, 0, 0]))).toBe(true); // a see-through PNG
    // What JPEG does to a flat fill is still flat.
    expect(flatPicture(picture(256, [2, 2, 3, 255], [[10, 0, 0, 0, 255], [900, 6, 7, 8, 255]]))).toBe(true);
    // Dark water with a little texture, and a mown field with a path across it, are photos.
    const water = picture(256, [14, 26, 31, 255]);
    for (let i = 0; i < 256 * 256; i += 7) water.set([14 + (i % 11), 26 + (i % 13), 31 + (i % 17), 255], i * 4);
    expect(flatPicture(water)).toBe(false);
    expect(flatPicture(picture(256, [96, 128, 70, 255], [[30_000, 160, 150, 120, 255]]))).toBe(false);
    // Half photo, half blank, at the edge of what a state flew: a photo.
    const edge = picture(256, [0, 0, 0, 255]);
    for (let i = 0; i < 128 * 256; i++) edge.set([90 + (i % 60), 110, 80, 255], i * 4);
    expect(flatPicture(edge)).toBe(false);
    expect(flatPicture(picture(256, [0, 0, 0, 0], [[5, 0, 0, 0, 255]]))).toBe(false);
    expect(flatPicture([])).toBe(false);
  });
});

describe("checking a source has a picture here", () => {
  afterEach(() => vi.unstubAllGlobals());
  // Vienna, Virginia: inside Maryland's box and Virginia's, and Maryland's server has no photos of it.
  const VIENNA = [-77.2777, 38.8897] as const;
  // What Maryland's server sent for it (HTTP 200, image/jpeg): 256 × 256 pixels, every one black.
  const black = readFileSync(new URL("./fixtures/maryland-no-photos.jpg", import.meta.url));
  const answer = (body: Uint8Array, type = "image/jpeg") => vi.fn(async () => new Response(body as BodyInit, { headers: { "Content-Type": type } }));
  /** A browser that can decode a tile, to these pixels. */
  function decoding(pixels: Uint8ClampedArray) {
    const size = Math.sqrt(pixels.length / 4);
    const close = vi.fn();
    vi.stubGlobal("createImageBitmap", vi.fn(async () => ({ width: size, height: size, close })));
    vi.stubGlobal("OffscreenCanvas", class {
      getContext() {
        return { drawImage() {}, getImageData: () => ({ data: pixels }) };
      }
    });
    return { close };
  }

  it("calls a whole picture in one colour empty, so Auto goes on to the next source", async () => {
    expect(black.byteLength).toBe(1686); // too big for the size check alone to call blank
    const fetch = answer(black);
    vi.stubGlobal("fetch", fetch);
    const { close } = decoding(picture(256, [0, 0, 0, 255]));
    expect(await probeImagery("state:MD", {}, ...VIENNA)).toBe("empty");
    expect(String(fetch.mock.calls[0])).toContain("mdgeodata.md.gov/imagery/rest/services/SixInch/SixInchImagery/ImageServer/exportImage?bbox=");
    expect(close).toHaveBeenCalled();
    // Auto, which stopped on Maryland's black picture: Virginia's imagery, as it has photos here.
    decoding(picture(256, [0, 0, 0, 255]));
    const shown = async (id: ImageryId) => (id === "state:MD" ? probeImagery(id, {}, ...VIENNA) : "ok");
    expect(await resolveAuto(...VIENNA, 19, {}, shown)).toEqual({ id: "state:VA", passed: [{ id: "state:MD", why: "empty" }] });
  });

  it("keeps a photo, however dark, and a tile it can't look at when it's big enough to be one", async () => {
    const photo = new Uint8Array(15_866).fill(7);
    vi.stubGlobal("fetch", answer(photo));
    const water = picture(256, [14, 26, 31, 255]);
    for (let i = 0; i < 256 * 256; i += 7) water.set([14 + (i % 11), 26 + (i % 13), 31 + (i % 17), 255], i * 4);
    decoding(water);
    expect(await probeImagery("state:MD", {}, -76.6, 39.29)).toBe("ok");
    // No way to decode it here (an old browser, or these tests): its size decides, as it always did.
    vi.unstubAllGlobals();
    vi.stubGlobal("fetch", answer(black));
    expect(await tilePixels(new Blob([black as BlobPart]))).toBeNull();
    expect(await probeImagery("state:MD", {}, ...VIENNA)).toBe("ok");
    // Bytes that aren't a picture after all: the same.
    vi.stubGlobal("createImageBitmap", vi.fn(async () => Promise.reject(new DOMException("The source image could not be decoded.", "InvalidStateError"))));
    expect(await probeImagery("state:MD", {}, ...VIENNA)).toBe("ok");
  });

  it("still calls a tile of a few hundred bytes empty without looking, and a server that doesn't answer down", async () => {
    const decode = vi.fn();
    vi.stubGlobal("createImageBitmap", decode);
    vi.stubGlobal("fetch", answer(new Uint8Array(300)));
    expect(await probeImagery("state:MD", {}, ...VIENNA)).toBe("empty");
    expect(decode).not.toHaveBeenCalled();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("busy", { status: 503 })));
    expect(await probeImagery("state:MD", {}, ...VIENNA)).toBe("down");
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("Failed to fetch"))));
    expect(await probeImagery("state:MD", {}, ...VIENNA)).toBe("down");
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
