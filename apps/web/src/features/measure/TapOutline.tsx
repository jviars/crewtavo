/**
 * Tap to outline: Find paving for free. SAM 2.1 runs in this browser (samLocal.ts) and outlines the
 * pavement under a tap, or inside a box dragged around a lot, as an area of the chosen takeoff item.
 * There's no account or key, and the aerial isn't sent anywhere.
 *
 * - A single tap is ambiguous to the model (this aisle, this lot, or all the pavement around), and a
 *   box isn't. So where OpenStreetMap has the lot mapped, a tap on it asks about the lot's box.
 * - A box (dragged, or the mapped lot's) is read close up, at the screen's full detail rather than
 *   the whole view shrunk: parked cars are then big enough to read as part of the lot, not holes.
 * - OpenStreetMap's buildings come out of every outline: a grey roof reads as pavement.
 * - More taps add to the same outline; Take out (or Alt-tap) takes out what's under the tap, like an
 *   island or parked cars; New outline starts the next one. Smaller and Bigger swap the last tap's
 *   piece for the model's other guesses.
 *
 * Outlines are kept as polygons on the map (not masks), so adding and taking out still work after
 * the map moves and the view is read again.
 */
import { cutOut, mergePolygons, polygonAreaM2, SQFT_PER_SQM, type Position } from "@crewtavo/core/geo";
import { PAVING_ITEMS } from "@crewtavo/core/paving";
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { toast } from "@/lib/toast";
import { lotAt, lotsAndBuildingsIn } from "./buildings";
import type { ImageryId } from "./imagery";
import { ringArea } from "./detect";
import { guessPolygons } from "./maskOutline";
import type { MeasureMapHandle, SpotPicker, ViewImage } from "./MeasureMap";
import type { LngLat } from "./planAlign";
import { decode, embed, loadSam, pickMask, SAM_GRID, SAM_SIZE, type Embedding, type Prompt, type Sam } from "./samLocal";

/** What a tap can outline: the takeoff items that are areas. */
export const TAP_ITEMS = PAVING_ITEMS.filter((i) => i.geometry === "area");
/** Items a whole mapped lot is the likely answer for (a patch or a sidewalk inside one isn't). */
const LOT_ITEMS = new Set(["asphalt", "sealcoat", "gravel"]);
/** Too small to be worth a shape, in square feet. */
const MIN_AREA_SQFT = 40;
/** Holes smaller than this are a parked car or a manhole, not an island. */
const MIN_HOLE_SQFT = 250;
/** How long a tap waits for OpenStreetMap before going on without it. */
const OSM_WAIT_MS = 3000;

type Mode = "add" | "out" | "box";
type Status = "loading" | "reading" | "ready" | "working";
type Polygons = Position[][][];
type Box = [number, number, number, number];
interface Osm { lots: Position[][][]; buildings: Position[][][] }
interface Picture { key: string; view: ViewImage; embedding: Embedding; osm: OsmAsk }
/**
 * OpenStreetMap's answer for a view: waited for once, then whatever's there by then. Till then, the
 * buildings in the street map's tiles (taken before the picture: hiding the map's layers for it
 * makes the map let go of those tiles).
 */
interface OsmAsk { answer: Promise<Osm | null>; waited: boolean; got?: Osm | null; tiles: Position[][][] }
interface Pin { at: LngLat; out: boolean }
/** The outline taps add to: its shapes on the map and what they were made from. */
interface Outline { item: string; polygons: Polygons; ids: string[]; pins: Pin[]; osm: boolean }
/** One of the model's guesses for a tap or box, ready to add or take out. */
interface Guess { polygons: Polygons; osm: boolean }
/** The last tap or box, so Smaller and Bigger can redo it with another guess. */
interface Step { base: Outline | null; kind: "add" | "out"; guesses: Guess[]; index: number; item: string; pins: Pin[] }

export interface TapOutline {
  /** The item taps outline as; null while tap to outline is off. */
  item: string | null;
  mode: Mode;
  status: Status;
  /** Bytes of the model downloaded so far and in all, the first time. */
  progress: { loaded: number; total: number } | null;
  /** There's an outline that taps add to. */
  active: boolean;
  /** Whether the last tap has a smaller or bigger guess to swap to. */
  resize: { smaller: boolean; bigger: boolean } | null;
  /** Why the model is running on the processor, when it is (the banner says so). */
  slow: Sam["slow"] | null;
  start(item: string): void;
  stop(): void;
  setItem(item: string): void;
  setMode(mode: Mode): void;
  newOutline(): void;
  smaller(): void;
  bigger(): void;
}

const sqft = (rings: Position[][]) => polygonAreaM2(rings) * SQFT_PER_SQM;
const asPolygon = (coordinates: Position[][]) => ({ type: "Polygon", coordinates });
const areaOf = (polygons: Polygons) => polygons.reduce((n, p) => n + sqft(p), 0);

/** Pieces too small to keep and holes too small to cut out (a parked car) dropped. */
export function tidy(polygons: Polygons): Polygons {
  return polygons.filter((p) => sqft([p[0]]) >= MIN_AREA_SQFT).map((p) => [p[0], ...p.slice(1).filter((h) => sqft([h]) >= MIN_HOLE_SQFT)]);
}

/** Scraps beside a guess's main piece (a sliver left when a building is cut out of the lot) dropped. */
export function withoutScraps(polygons: Polygons): Polygons {
  const biggest = Math.max(0, ...polygons.map((p) => sqft([p[0]])));
  return polygons.filter((p) => sqft([p[0]]) >= biggest * 0.03);
}

/** A guess with the buildings on it cut out, and whether that changed it (for the OpenStreetMap credit). */
export function withoutBuildings(polygons: Polygons, buildings: Position[][][]): Guess {
  const [w, s, e, n] = boxOf(polygons.map((p) => p[0]));
  const near = buildings.filter((b) => b[0].some(([x, y]) => x >= w && x <= e && y >= s && y <= n));
  if (!near.length) return { polygons, osm: false };
  const cut = polygons.flatMap((p) => cutOut(asPolygon(p), near.map(asPolygon)));
  return { polygons: cut, osm: Math.abs(areaOf(cut) - areaOf(polygons)) > 1 };
}

/** An outline with a guess added to it or taken out of it. */
export function combine(base: Polygons, guess: Polygons, kind: "add" | "out"): Polygons {
  if (kind === "add") return base.length ? mergePolygons([...base, ...guess]) : guess;
  return guess.length ? base.flatMap((p) => cutOut(asPolygon(p), guess.map(asPolygon))) : base;
}

function boxOf(rings: Position[][]): Box {
  let [w, s, e, n] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const r of rings) for (const [x, y] of r) [w, s, e, n] = [Math.min(w, x), Math.min(s, y), Math.max(e, x), Math.max(n, y)];
  return [w, s, e, n];
}

export function useTapOutline({
  map,
  imagery,
  pictureImagery,
  onFound,
}: {
  map: RefObject<MeasureMapHandle | null>;
  imagery: ImageryId | null;
  /** The free imagery to look at when the map shows Google's, whose terms don't allow this. */
  pictureImagery: () => Promise<ImageryId>;
  /** New areas, as their item; `osm` when OpenStreetMap's buildings shaped them (they carry its credit). */
  onFound: (ids: string[], item: string, osm: boolean) => void;
}): TapOutline {
  const [item, setItemState] = useState<string | null>(null);
  const [mode, setModeState] = useState<Mode>("add");
  const [status, setStatus] = useState<Status>("loading");
  const [progress, setProgress] = useState<TapOutline["progress"]>(null);
  const [active, setActive] = useState(false);
  const [resize, setResize] = useState<TapOutline["resize"]>(null);
  const [slow, setSlow] = useState<TapOutline["slow"]>(null);
  // The view the model has read, so taps on it don't read it again.
  const picture = useRef<Picture | null>(null);
  const reading = useRef<Promise<unknown>>(Promise.resolve());
  const outline = useRef<Outline | null>(null);
  const last = useRef<Step | null>(null);
  const busy = useRef(false);
  const run = useRef(0); // bumped when stopped, so a download finishing late doesn't turn it back on
  const live = useRef({ item, mode, imagery, pictureImagery, onFound });
  live.current = { item, mode, imagery, pictureImagery, onFound };

  const viewKey = () => {
    const box = map.current?.viewBox();
    const zoom = map.current?.view().zoom ?? 0;
    return box ? `${[box.center[0], box.center[1], box.west, box.east, zoom].map((n) => n.toFixed(8)).join(",")}:${live.current.imagery}` : "";
  };
  /**
   * The view as the model has read it, read again if the map has moved since, with OpenStreetMap's
   * lots and buildings for it on the way. One at a time: two pictures at once would each hide and
   * show the drawing.
   */
  const read = (fresh = false) => {
    const next = reading.current.catch(() => null).then(async (): Promise<Picture> => {
      const sam = await loadSam();
      const key = viewKey();
      if (!fresh && picture.current?.key === key) return picture.current;
      const handle = map.current;
      if (!handle) throw new Error("The map isn't ready yet.");
      setStatus("reading");
      const tiles = handle.buildings() ?? [];
      const { imagery: shown, pictureImagery: free } = live.current;
      const view = await handle.viewImage(SAM_SIZE, { whole: true, ...(shown === "google" ? { imagery: await free() } : {}) });
      if (!view) throw new Error("Couldn't take a picture of the map. Try again.");
      const [a, b] = [view.at(0, view.canvas.height), view.at(view.canvas.width, 0)];
      const osm: OsmAsk = { answer: lotsAndBuildingsIn([a[0], a[1], b[0], b[1]]).catch(() => null), waited: false, tiles };
      void osm.answer.then((got) => (osm.got = got));
      picture.current = { key, view, embedding: await embed(sam, view.canvas), osm };
      return picture.current;
    });
    reading.current = next;
    return next;
  };
  /** A close-up picture of part of the view (a box around a lot), read after any picture before it. */
  const crop = (bounds: Box, base: Picture) => {
    const next = reading.current.catch(() => null).then(async (): Promise<Picture> => {
      const sam = await loadSam();
      const handle = map.current;
      if (!handle) throw new Error("The map isn't ready yet.");
      setStatus("reading");
      const { imagery: shown, pictureImagery: free } = live.current;
      const view = await handle.viewImage(SAM_SIZE, { bounds, ...(shown === "google" ? { imagery: await free() } : {}) });
      if (!view) throw new Error("Couldn't take a picture of the map. Try again.");
      const embedding = await embed(sam, view.canvas);
      setStatus("working");
      return { key: "crop", view, embedding, osm: base.osm };
    });
    reading.current = next;
    return next;
  };
  /** OpenStreetMap's answer for the view, or what the street map's tiles have when it's slow. */
  const osmFor = async (p: Picture): Promise<Osm> => {
    const ask = p.osm;
    if (ask.got === undefined && !ask.waited) {
      ask.waited = true;
      await Promise.race([ask.answer, new Promise<null>((resolve) => setTimeout(() => resolve(null), OSM_WAIT_MS))]);
    }
    return ask.got ?? { lots: [], buildings: ask.tiles };
  };

  /** The model's guesses for a prompt, as map polygons without the buildings, smallest first. */
  const guessesFor = async (p: Picture, prompt: Prompt, { seed, prefer, lot }: { seed: [number, number] | null; prefer: "biggest" | "surest"; lot: boolean }): Promise<{ guesses: Guess[]; index: number }> => {
    const { view, embedding } = p;
    const { width, height } = view.canvas;
    const [gx, gy] = [SAM_GRID / width, SAM_GRID / height];
    const answers = await decode(await loadSam(), embedding, prompt);
    if (!answers.found) return { guesses: [], index: -1 };
    const { buildings } = await osmFor(p);
    const box = prompt.box ? ([prompt.box[0] * gx, prompt.box[1] * gy, prompt.box[2] * gx, prompt.box[3] * gy] as Box) : null;
    const options = answers.logits
      .map((logits, i) => {
        let rings = guessPolygons(logits, { seeds: seed ? [[seed[0] * gx, seed[1] * gy]] : [], box, open: lot });
        // Everything in a box is kept, but not specks beside the lot.
        if (!seed) {
          const biggest = Math.max(0, ...rings.map((r) => ringArea(r[0])));
          rings = rings.filter((r) => ringArea(r[0]) >= biggest * 0.05);
        }
        const polygons = rings.map((rs) => rs.map((r) => r.map(([x, y]) => view.at(x / gx, y / gy))));
        const guess = withoutBuildings(tidy(polygons), buildings);
        return { ...guess, polygons: withoutScraps(tidy(guess.polygons)), score: answers.scores[i] };
      })
      .map((g) => ({ ...g, area: areaOf(g.polygons) }))
      .filter((g) => g.area > 0)
      .sort((x, y) => x.area - y.area);
    // Guesses within a few percent of each other are the same one.
    const kept: typeof options = [];
    for (const g of options) {
      const prev = kept[kept.length - 1];
      if (prev && g.area - prev.area < prev.area * 0.03) kept[kept.length - 1] = g.score > prev.score ? g : prev;
      else kept.push(g);
    }
    const index = pickMask(kept.map((g) => ({ cells: g.area, score: g.score })), { prefer });
    return { guesses: kept.map(({ polygons, osm }) => ({ polygons, osm })), index };
  };

  /** The outline taps add to, if its shapes are all still on the map (Undo can take them away). */
  const current = (): Outline | null => {
    const o = outline.current;
    if (o && !o.ids.every((id) => map.current?.has(id))) outline.current = null;
    return outline.current;
  };
  const showPins = (pins: Pin[]) => map.current?.setPins(pins.map((p) => ({ at: p.at, label: p.out ? "−" : "+", tone: p.out ? "out" : "map" })));

  /** Does a step with one of its guesses: the outline's shapes are replaced with the result. */
  const apply = (s: Step, index: number): boolean => {
    const handle = map.current;
    const guess = s.guesses[index];
    if (!handle || !guess) return false;
    const base = s.base;
    const polygons = tidy(combine(base?.polygons ?? [], guess.polygons, s.kind));
    const osm = Boolean(base?.osm) || guess.osm;
    for (const id of current()?.ids ?? []) handle.remove(id);
    const areas = handle.add(polygons.map((p) => [p[0]]), "Area");
    if (areas.length) live.current.onFound(areas, s.item, osm);
    const cuts = handle.add(polygons.flatMap((p) => p.slice(1).map((h) => [h])), "Cutout");
    outline.current = areas.length ? { item: s.item, polygons, ids: [...areas, ...cuts], pins: s.pins, osm } : null;
    last.current = { ...s, index };
    setActive(Boolean(outline.current));
    if (!outline.current) setModeState((m) => (m === "out" ? "add" : m)); // nothing left to take out of
    setResize({ smaller: index > 0, bigger: index < s.guesses.length - 1 });
    showPins(outline.current ? s.pins : []);
    return true;
  };

  /** Runs a tap or a box: reads the view if need be, asks the model, and adds or takes out. */
  const ask = async (work: (p: Picture) => Promise<void>) => {
    if (busy.current || !live.current.item) return;
    busy.current = true;
    const mine = run.current;
    try {
      const p = await read();
      if (mine !== run.current) return;
      setStatus("working");
      await work(p);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Couldn't outline that. Try again.");
    } finally {
      busy.current = false;
      if (mine === run.current) setStatus("ready");
    }
  };

  const onTap: SpotPicker = useCallback((at: LngLat, { alt }: { alt: boolean }) => {
    const { item: as, mode: now } = live.current;
    if (!as || now === "box") return;
    const kind = alt || now === "out" ? "out" : "add";
    const base = current();
    if (kind === "out" && !base) return void toast.info("Outline something first, then tap what to leave out of it.");
    void ask(async (first) => {
      let p = first;
      let [x, y] = p.view.px(at);
      // Off the picture (the map got bigger): read the view as it is now.
      if (x < 0 || y < 0 || x >= p.view.canvas.width || y >= p.view.canvas.height) {
        p = await read(true);
        [x, y] = p.view.px(at);
      }
      // A tap on a lot OpenStreetMap has mapped asks about the lot's box, close up: far less ambiguous.
      let box: Box | null = null;
      if (kind === "add" && LOT_ITEMS.has(as)) {
        const lot = lotAt((await osmFor(p)).lots, at);
        if (lot) {
          const ring = lot[0].map((pt): LngLat => [Number(pt[0]), Number(pt[1])]);
          p = await crop(padBounds(boxOf([ring]), 0.12), p);
          box = padBox(ring.map((pt) => p.view.px(pt)), p.view.canvas.width, p.view.canvas.height);
          [x, y] = p.view.px(at);
        }
      }
      // Taking out asks what the thing under the tap is (an island, a row of cars), so the surest guess.
      const { guesses, index } = await guessesFor(p, { points: [{ x, y, positive: true }], box }, { seed: [x, y], prefer: kind === "add" ? "biggest" : "surest", lot: kind === "add" && LOT_ITEMS.has(as) });
      if (index < 0) return void toast.info("Nothing to outline there. Tap the middle of the pavement, or drag a box around the lot.");
      const pins = [...(base?.pins ?? []), { at, out: kind === "out" }];
      apply({ base, kind, guesses, index, item: base?.item ?? as, pins }, index);
    });
    // Reads everything through refs, so it stays the same function for pickSpots.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onBox = useCallback((a: LngLat, b: LngLat) => {
    const as = live.current.item;
    if (!as) return;
    void ask(async (whole) => {
      // Read close up: the box and a margin round it, so the model sees where the lot ends.
      const p = await crop(padBounds([Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])], 0.12), whole);
      const box = padBox([p.view.px(a), p.view.px(b)], p.view.canvas.width, p.view.canvas.height, 0);
      const { guesses, index } = await guessesFor(p, { points: [], box }, { seed: null, prefer: "biggest", lot: LOT_ITEMS.has(as) });
      if (index < 0) return void toast.info("Nothing to outline in that box. Drag it around the pavement, a little bigger than the lot.");
      const base = current();
      apply({ base, kind: "add", guesses, index, item: base?.item ?? as, pins: base?.pins ?? [] }, index);
      // Next, taps add to it or take out of it.
      setModeState("add");
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const step = (by: -1 | 1) => {
    const s = last.current;
    if (!s || busy.current || !s.guesses[s.index + by]) return;
    apply(s, s.index + by);
  };
  const newOutline = () => {
    outline.current = null;
    last.current = null;
    setActive(false);
    setModeState((m) => (m === "out" ? "add" : m));
    setResize(null);
    showPins([]);
  };

  // Taps pick spots instead of drawing while it's on; in Box, dragging draws a box.
  useEffect(() => {
    if (item) map.current?.pickSpots(onTap);
    else map.current?.pickSpots(null, onTap);
  }, [map, item, onTap]);
  useEffect(() => {
    map.current?.pickBox(item && mode === "box" ? onBox : null);
  }, [map, item, mode, onBox]);
  useEffect(
    () => () => {
      map.current?.pickSpots(null, onTap);
      map.current?.pickBox(null);
    },
    [map, onTap],
  );

  const start = (next: string) => {
    const mine = ++run.current;
    setItemState(next);
    setModeState("add");
    setStatus("loading");
    setProgress(null);
    newOutline();
    loadSam((loaded, total) => mine === run.current && setProgress({ loaded, total }))
      // Read the view straight away, so the first tap is quick.
      .then(async (sam) => {
        setSlow(sam.slow ?? null);
        if (mine === run.current) await read();
        if (mine === run.current) setStatus("ready");
      })
      .catch((error) => {
        if (mine !== run.current) return;
        toast.error(error instanceof Error ? error.message : "Couldn't get the paving model ready. Try again.");
        run.current++;
        setItemState(null);
      });
  };
  const stop = () => {
    run.current++;
    setItemState(null);
    newOutline();
  };
  // Another item is another outline.
  const setItem = (next: string) => {
    if (next !== live.current.item) newOutline();
    setItemState(next);
  };

  return { item, mode, status, progress, active, resize, slow, start, stop, setItem, setMode: setModeState, newOutline, smaller: () => step(-1), bigger: () => step(1) };
}

/** A [west, south, east, north] box made bigger by a share of its longer side. */
export function padBounds([w, s, e, n]: Box, share: number): Box {
  const m = share * Math.max(e - w, n - s);
  return [w - m, s - m, e + m, n + m];
}

/** The box around some picture points, a little bigger, kept on the picture. */
export function padBox(points: Array<[number, number] | number[]>, width: number, height: number, pad = 0.06): Box {
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [x, y] of points) [x0, y0, x1, y1] = [Math.min(x0, x), Math.min(y0, y), Math.max(x1, x), Math.max(y1, y)];
  const m = pad * Math.max(x1 - x0, y1 - y0);
  return [Math.max(0, x0 - m), Math.max(0, y0 - m), Math.min(width, x1 + m), Math.min(height, y1 + m)];
}

/** What to say when the browser has no WebGPU, here and in the Find paving dialog. */
export const SLOW_NO_WEBGPU = "This browser can't run the model on the graphics card (it doesn't offer WebGPU), so it runs on the processor: each new view or box takes about 10 seconds instead of under one. Chrome, Edge and Safari 26 are fast.";

/** Over the map while tap to outline is on: what it's doing, what taps do, and Done. */
export function TapBanner({ tap }: { tap: TapOutline }) {
  if (!tap.item) return null;
  const mb = (bytes: number) => (bytes / 1_000_000).toFixed(1);
  const { status, progress, mode, active } = tap;
  const ready = status === "ready";
  return (
    <div className="measure-banner measure-banner-good" role="status" aria-live="polite">
      {ready ? <Icon name="sparkle" size={16} /> : <span className="spinner" style={{ width: 16, height: 16 }} />}
      <span className="grow">
        {status === "loading"
          ? <>Getting the free paving model{progress?.total ? `: ${mb(progress.loaded)} of ${mb(progress.total)} MB` : ""}. It downloads once, then stays in this browser.</>
          : status === "reading"
            ? "Reading the aerial in view…"
            : status === "working"
              ? "Outlining…"
              : mode === "box"
                ? <><strong>Drag a box</strong> around the lot to outline it as</>
                : mode === "out"
                  ? <><strong>Tap what to leave out</strong> of this outline: an island, a building, parked cars</>
                  : active
                    ? <><strong>Tap more</strong> to add to this outline, as</>
                    : <><strong>Tap the pavement</strong> to outline it as</>}
      </span>
      {mode !== "out" && (
        <select className="select measure-edge" value={tap.item} onChange={(e) => tap.setItem(e.target.value)} aria-label="Outline as">
          {TAP_ITEMS.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
        </select>
      )}
      <div className="segmented measure-tap-modes" role="group" aria-label="What taps do">
        <button type="button" aria-pressed={mode === "add"} onClick={() => tap.setMode("add")} title="Tap to outline, or to add to the outline">Add</button>
        <button type="button" aria-pressed={mode === "out"} onClick={() => tap.setMode("out")} disabled={!active} title="Tap to take something out of the outline (or Alt-tap)">Take out</button>
        <button type="button" aria-pressed={mode === "box"} onClick={() => tap.setMode("box")} title="Drag a box around a lot">Box</button>
      </div>
      {tap.resize && (
        <>
          <Button size="sm" onClick={tap.smaller} disabled={!tap.resize.smaller || !ready} title="Use less around the last tap">Smaller</Button>
          <Button size="sm" onClick={tap.bigger} disabled={!tap.resize.bigger || !ready} title="Use more around the last tap">Bigger</Button>
        </>
      )}
      {active && <Button size="sm" onClick={tap.newOutline} disabled={!ready} title="Finish this outline; the next tap starts another">New outline</Button>}
      <Button size="sm" variant="primary" onClick={tap.stop}>Done</Button>
      {tap.slow && (
        <span className="measure-tap-slow" role="note">
          <Icon name="alert" size={14} />
          <span>{tap.slow === "no-webgpu" ? SLOW_NO_WEBGPU : "The graphics card wouldn't run the model, so it's running on the processor instead: each new view or box takes about 10 seconds, where the graphics card takes under one."}</span>
        </span>
      )}
    </div>
  );
}
