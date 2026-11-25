/**
 * Google's attribution on the measuring map while it shows Google's tiles
 * (features/measure/googleAttribution.ts, imagery.ts): the credit Google gives for what's on screen,
 * asked with the tiles' session once the map rests, the plain credit only when Google can't be
 * asked, and the logo file as Google publishes it.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GOOGLE_CREDIT_FALLBACK, watchCredit } from "../src/features/measure/googleAttribution";
import { googleViewport, googleViewportCredit, rasterSource } from "../src/features/measure/imagery";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const VIEW = { zoom: 20, north: 37.06, south: 37.05, east: -79.86, west: -79.88 };

/** Google's session and viewport answers; says what was asked. */
function google(answer: (url: URL) => Response | unknown = () => ({ copyright: "Imagery ©2026 Airbus, Maxar Technologies" })) {
  const asked: URL[] = [];
  vi.stubGlobal("navigator", { language: "en-US" });
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    asked.push(url);
    if (url.pathname === "/v1/createSession") return Response.json({ session: "session-1", expiry: String(Math.floor(Date.now() / 1000) + 14 * 86_400) });
    const out = answer(url);
    return out instanceof Response ? out : Response.json(out);
  });
  return asked;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("Google's credit for what's on screen", () => {
  it("asks about the tiles in view: one zoom level in from the map's, edges kept on the globe", () => {
    expect(googleViewport({ north: 37.0612345678, south: 37.05, east: -79.86, west: -79.88 }, 19.4)).toEqual({ zoom: 20, north: 37.061235, south: 37.05, east: -79.86, west: -79.88 });
    expect(googleViewport({ north: 37, south: 36, east: -79, west: -80 }, 21.5).zoom).toBe(22);
    expect(googleViewport({ north: 37, south: 36, east: -79, west: -80 }, 0).zoom).toBe(1);
    // Across the date line, as Google takes it: west positive, east negative.
    expect(googleViewport({ north: 10, south: -10, east: 190, west: 170 }, 5)).toMatchObject({ east: -170, west: 170 });
    // The whole world, and past the poles.
    expect(googleViewport({ north: 95, south: -95, east: 400, west: -400 }, 1)).toEqual({ zoom: 2, north: 89.999999, south: -89.999999, east: 179.999999, west: -179.999999 });
  });

  it("asks Google's viewport request with the session the tiles use, and gives its copyright line", async () => {
    const asked = google();
    expect(await googleViewportCredit("AIzaKey", VIEW)).toBe("Imagery ©2026 Airbus, Maxar Technologies");
    const viewport = asked.find((u) => u.pathname === "/tile/v1/viewport")!;
    expect(viewport.host).toBe("tile.googleapis.com");
    expect(Object.fromEntries(viewport.searchParams)).toEqual({ session: "session-1", key: "AIzaKey", zoom: "20", north: "37.06", south: "37.05", east: "-79.86", west: "-79.88" });
  });

  it("gives nothing when Google can't be asked or doesn't say", async () => {
    google(() => new Response("no", { status: 403 }));
    expect(await googleViewportCredit("AIzaKey", VIEW)).toBeNull();
    google(() => ({ maxZoomRects: [] }));
    expect(await googleViewportCredit("AIzaKey", VIEW)).toBeNull();
    google(() => ({ copyright: "   " }));
    expect(await googleViewportCredit("AIzaKey", VIEW)).toBeNull();
    vi.stubGlobal("fetch", async () => {
      throw new Error("offline");
    });
    expect(await googleViewportCredit("AIzaKey", VIEW)).toBeNull();
  });

  it("leaves Google's credit off the map's own folding credits, and keeps every other source's there", async () => {
    google();
    const source = await rasterSource("google", { google_key: "AIzaKey" });
    expect(source?.tiles?.[0]).toContain("session=session-1");
    expect(source?.attribution).toBeUndefined();
    expect((await rasterSource("usgs", {}))?.attribution).toContain("U.S. Geological Survey");
  });
});

describe("keeping the credit in step with the map", () => {
  beforeEach(() => vi.useFakeTimers());
  const setup = (ask: (key: string, view: typeof VIEW) => Promise<string | null>) => {
    const shown: string[] = [];
    let view = VIEW;
    const asked: Array<typeof VIEW> = [];
    const watch = watchCredit({
      key: () => "AIzaKey",
      view: () => view,
      set: (text) => shown.push(text),
      ask: (key, v) => {
        asked.push(v);
        return ask(key, v);
      },
      wait: 400,
    });
    return { watch, shown, asked, move: (next: typeof VIEW) => (view = next) };
  };

  it("shows the plain credit at once when Google's tiles come on, then Google's own", async () => {
    const { watch, shown, asked } = setup(async () => "Imagery ©2026 Maxar Technologies");
    watch.show(true);
    expect(shown).toEqual([GOOGLE_CREDIT_FALLBACK]);
    await vi.advanceTimersByTimeAsync(0);
    expect(asked).toEqual([VIEW]);
    expect(shown).toEqual([GOOGLE_CREDIT_FALLBACK, "Imagery ©2026 Maxar Technologies"]);
  });

  it("asks once the map rests, not at every move, and not again for the same view", async () => {
    const { watch, asked, move } = setup(async (_key, view) => `Imagery ©2026 for ${view.west}`);
    watch.show(true);
    await vi.advanceTimersByTimeAsync(0);
    const next = { ...VIEW, west: -80.5 };
    move(next);
    for (let i = 0; i < 5; i++) {
      watch.moved();
      await vi.advanceTimersByTimeAsync(100);
    }
    expect(asked).toEqual([VIEW]);
    await vi.advanceTimersByTimeAsync(400);
    expect(asked).toEqual([VIEW, next]);
    // Settling again in the same place asks nothing.
    watch.moved();
    await vi.advanceTimersByTimeAsync(400);
    expect(asked).toHaveLength(2);
  });

  it("drops an answer for a view the map has left, and puts the plain credit back when Google doesn't answer", async () => {
    const answers: Array<(text: string | null) => void> = [];
    const { watch, shown, move } = setup(() => new Promise((done) => answers.push(done)));
    watch.show(true);
    await vi.advanceTimersByTimeAsync(0);
    move({ ...VIEW, west: -81 });
    watch.moved();
    await vi.advanceTimersByTimeAsync(400);
    expect(answers).toHaveLength(2);
    // The first view's answer comes back late.
    answers[0]!("Imagery ©2026 for the first view");
    await vi.advanceTimersByTimeAsync(0);
    expect(shown).toEqual([GOOGLE_CREDIT_FALLBACK]);
    answers[1]!("Imagery ©2026 for the second view");
    await vi.advanceTimersByTimeAsync(0);
    expect(shown.at(-1)).toBe("Imagery ©2026 for the second view");
    // Somewhere Google doesn't answer about: not the last place's credit.
    move({ ...VIEW, west: -82 });
    watch.moved();
    await vi.advanceTimersByTimeAsync(400);
    answers[2]!(null);
    await vi.advanceTimersByTimeAsync(0);
    expect(shown.at(-1)).toBe(GOOGLE_CREDIT_FALLBACK);
    // And the same view is asked about again next time.
    watch.moved();
    await vi.advanceTimersByTimeAsync(400);
    expect(answers).toHaveLength(4);
  });

  it("asks nothing with other imagery, and drops what was asked when Google's tiles go", async () => {
    const answers: Array<(text: string | null) => void> = [];
    const { watch, shown, asked } = setup(() => new Promise((done) => answers.push(done)));
    watch.moved();
    await vi.advanceTimersByTimeAsync(1000);
    expect(asked).toEqual([]);
    watch.show(true);
    await vi.advanceTimersByTimeAsync(0);
    watch.show(false);
    answers[0]!("Imagery ©2026 Maxar Technologies");
    await vi.advanceTimersByTimeAsync(0);
    expect(shown).toEqual([GOOGLE_CREDIT_FALLBACK]);
    watch.moved();
    await vi.advanceTimersByTimeAsync(1000);
    expect(asked).toHaveLength(1);
  });
});

describe("Google's logo and where its attribution sits", () => {
  it("is Google's own file, unchanged, shown at its own size with its label", () => {
    const logo = readFileSync(new URL("../src/assets/maps/google-maps-logo.svg", import.meta.url));
    // GoogleMaps_Logo_WithDarkOutline.svg from Google's attribution assets (assets/maps/README.md).
    expect(createHash("sha256").update(logo).digest("hex")).toBe("1974830500ca480c8c81daf95b049441927f18061fff040be607467c6b42bc39");
    expect(logo.toString("utf8")).toContain('width="105px" height="22px"');
    const code = read("../src/features/measure/googleAttribution.ts");
    expect(code).toContain('image.alt = "Google Maps"');
    expect(code).toContain("image.width = 105");
    expect(code).toContain("image.height = 22");
    const css = read("../src/styles/features.css");
    expect(css).toContain(".measure-google-logo img { display: block; width: 105px; height: 22px;");
    expect(read("../src/assets/maps/README.md")).toContain("GoogleMaps_Logo_WithDarkOutline.svg");
  });

  it("goes in the bottom corners, under the credits that fold away, and shows only with Google's tiles", () => {
    const map = read("../src/features/measure/MeasureMap.tsx");
    // First on each side is the corner: what's added later sits above it. (The zoom buttons are the page's own, over the map.)
    const order = ["map.addControl(google.credit, \"bottom-right\")", "new maplibregl.AttributionControl({ compact: true })", "map.addControl(google.logo, \"bottom-left\")", "new maplibregl.ScaleControl"].map((text) => map.indexOf(text));
    expect(map).not.toContain("new maplibregl.NavigationControl");
    expect(order.every((at) => at > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(map).toContain("attributionControl: false");
    expect(map).toContain('googleRef.current?.show(id === "google" && Boolean(source))');
    expect(map).toContain("google.moved()");
  });
});
