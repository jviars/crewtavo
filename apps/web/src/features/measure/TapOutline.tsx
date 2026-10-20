/**
 * Tap to outline: Find paving for free. Tap the pavement on the aerial and a small Segment Anything
 * running in this browser (samLocal.ts) outlines the surface under the tap as an area of the chosen
 * takeoff item, with the islands and buildings in it cut out. Nothing is sent anywhere, and there's
 * no account or key. SAM gives a few answers for each tap (a stall, that part of the lot, the whole
 * lot): Smaller and Bigger on the banner swap the last outline for the next one.
 */
import { lineLengthM } from "@crewtavo/core/geo";
import { PAVING_ITEMS } from "@crewtavo/core/paving";
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { toast } from "@/lib/toast";
import { GRID, outlines, pieceAt } from "./detect";
import type { ImageryId } from "./imagery";
import type { MeasureMapHandle, ViewImage } from "./MeasureMap";
import type { LngLat } from "./planAlign";
import { embed, loadSam, masksAt, pickMask, SAM_SIZE, type Embedding } from "./samLocal";

/** What a tap can outline: the takeoff items that are areas. */
export const TAP_ITEMS = PAVING_ITEMS.filter((i) => i.geometry === "area");
/** Too small to be worth a shape, in square feet. */
const MIN_AREA_SQFT = 40;
/** Holes smaller than this are a parked car or a manhole, not an island. */
const MIN_HOLE_SQFT = 250;

type Status = "loading" | "reading" | "ready" | "working";
interface Answer { grid: Uint8Array; cells: number }
interface Last { view: ViewImage; answers: Answer[]; index: number; ids: string[]; item: string }

export interface TapOutline {
  /** The item taps outline as; null while tap to outline is off. */
  item: string | null;
  status: Status;
  /** Bytes of the model downloaded so far and in all, the first time. */
  progress: { loaded: number; total: number } | null;
  /** Whether the last outline has a smaller or bigger answer to swap to. */
  resize: { smaller: boolean; bigger: boolean } | null;
  start(item: string): void;
  stop(): void;
  setItem(item: string): void;
  smaller(): void;
  bigger(): void;
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
  onFound: (ids: string[], item: string) => void;
}): TapOutline {
  const [item, setItem] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>("loading");
  const [progress, setProgress] = useState<TapOutline["progress"]>(null);
  const [resize, setResize] = useState<TapOutline["resize"]>(null);
  // The view the model has read, so taps on it don't read it again.
  const picture = useRef<{ key: string; view: ViewImage; embedding: Embedding } | null>(null);
  const reading = useRef<Promise<unknown>>(Promise.resolve());
  const last = useRef<Last | null>(null);
  const busy = useRef(false);
  const run = useRef(0); // bumped when stopped, so a download finishing late doesn't turn it back on
  const live = useRef({ item, imagery, pictureImagery, onFound });
  live.current = { item, imagery, pictureImagery, onFound };

  const viewKey = () => {
    const box = map.current?.viewBox();
    const zoom = map.current?.view().zoom ?? 0;
    return box ? `${[box.center[0], box.center[1], box.west, box.east, zoom].map((n) => n.toFixed(8)).join(",")}:${live.current.imagery}` : "";
  };
  /**
   * The view as the model has read it, read again if the map has moved since. One at a time: two
   * pictures at once would each hide and show the drawing.
   */
  const read = (fresh = false) => {
    const next = reading.current.catch(() => null).then(async () => {
      const sam = await loadSam();
      const key = viewKey();
      if (!fresh && picture.current?.key === key) return picture.current;
      const handle = map.current;
      if (!handle) throw new Error("The map isn't ready yet.");
      setStatus("reading");
      const { imagery: shown, pictureImagery: free } = live.current;
      const view = await handle.viewImage(SAM_SIZE, { whole: true, ...(shown === "google" ? { imagery: await free() } : {}) });
      if (!view) throw new Error("Couldn't take a picture of the map. Try again.");
      picture.current = { key, view, embedding: await embed(sam, view.canvas) };
      return picture.current;
    });
    reading.current = next;
    return next;
  };

  /** Puts an answer on the map as the item's areas, with its holes cut out. Returns the new ids. */
  const place = (view: ViewImage, grid: Uint8Array, as: string): string[] => {
    const handle = map.current;
    if (!handle) return [];
    const { width, height } = view.canvas;
    const ftPerPx = (lineLengthM([view.at(0, height / 2), view.at(width, height / 2)]) * 3.280_84) / width;
    const cellSqft = ((ftPerPx * SAM_SIZE) / GRID) ** 2;
    const { areas, cutouts } = outlines(grid, SAM_SIZE, { minCells: Math.max(2, MIN_AREA_SQFT / cellSqft), minHoleCells: Math.max(4, MIN_HOLE_SQFT / cellSqft) });
    const toMap = (ring: number[][]) => [ring.map(([x, y]) => view.at(x, y))];
    const ids = handle.add(areas.map(toMap), "Area");
    if (!ids.length) return [];
    live.current.onFound(ids, as);
    return [...ids, ...handle.add(cutouts.map(toMap), "Cutout")];
  };
  const showResize = (l: Last | null) => setResize(l ? { smaller: l.index > 0, bigger: l.index < l.answers.length - 1 } : null);

  const onTap = useCallback(async (at: LngLat) => {
    const as = live.current.item;
    if (busy.current || !as) return;
    busy.current = true;
    const mine = run.current;
    try {
      let { view, embedding } = await read();
      let [x, y] = view.px(at);
      // Off the picture (the map got bigger): read the view as it is now.
      if (x < 0 || y < 0 || x >= view.canvas.width || y >= view.canvas.height) {
        ({ view, embedding } = await read(true));
        [x, y] = view.px(at);
      }
      if (mine !== run.current) return;
      setStatus("working");
      const masks = await masksAt(await loadSam(), embedding, [{ x, y, positive: true }]);
      const scale = SAM_SIZE / GRID;
      // Each answer as just the piece under the tap, smallest first, without repeats.
      const answers: Answer[] = [];
      const scores: number[] = [];
      masks.grids
        .map((g, i) => ({ grid: pieceAt(g, x / scale, y / scale), score: masks.scores[i] }))
        .map((a) => ({ ...a, cells: a.grid.reduce((n, v) => n + v, 0) }))
        .filter((a) => a.cells > 0)
        .sort((p, q) => p.cells - q.cells)
        .forEach((a) => {
          const prev = answers[answers.length - 1];
          if (prev && a.cells - prev.cells < prev.cells * 0.03) return void (scores[scores.length - 1] = Math.max(scores[scores.length - 1], a.score));
          answers.push({ grid: a.grid, cells: a.cells });
          scores.push(a.score);
        });
      const index = pickMask(answers.map((a, i) => ({ cells: a.cells, score: scores[i] })));
      const ids = index < 0 ? [] : place(view, answers[index].grid, as);
      if (!ids.length) {
        last.current = null;
        showResize(null);
        return void toast.info("Nothing to outline there. Tap the middle of the pavement, or zoom in closer.");
      }
      last.current = { view, answers, index, ids, item: as };
      showResize(last.current);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Couldn't outline that. Try again.");
    } finally {
      busy.current = false;
      if (mine === run.current) setStatus("ready");
    }
    // Reads everything through refs, so it stays the same function for pickSpots.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Swaps the last outline for SAM's next smaller or bigger answer. */
  const step = (by: -1 | 1) => {
    const l = last.current;
    const next = l && l.answers[l.index + by];
    if (!l || !next || busy.current) return;
    for (const id of l.ids) map.current?.remove(id);
    const ids = place(l.view, next.grid, l.item);
    last.current = ids.length ? { ...l, index: l.index + by, ids } : null;
    showResize(last.current);
  };

  // Taps pick spots instead of drawing while it's on.
  useEffect(() => {
    if (item) map.current?.pickSpots(onTap);
    else map.current?.pickSpots(null, onTap);
  }, [map, item, onTap]);
  useEffect(() => () => map.current?.pickSpots(null, onTap), [map, onTap]);

  const start = (next: string) => {
    const mine = ++run.current;
    setItem(next);
    setStatus("loading");
    setProgress(null);
    last.current = null;
    showResize(null);
    loadSam((loaded, total) => mine === run.current && setProgress({ loaded, total }))
      // Read the view straight away, so the first tap is quick.
      .then(async () => {
        if (mine === run.current) await read();
        if (mine === run.current) setStatus("ready");
      })
      .catch((error) => {
        if (mine !== run.current) return;
        toast.error(error instanceof Error ? error.message : "Couldn't get the paving model ready. Try again.");
        run.current++;
        setItem(null);
      });
  };
  const stop = () => {
    run.current++;
    setItem(null);
    last.current = null;
    showResize(null);
  };

  return { item, status, progress, resize, start, stop, setItem: (next) => setItem(next), smaller: () => step(-1), bigger: () => step(1) };
}

/** Over the map while tap to outline is on: what it's doing, what taps outline as, and Done. */
export function TapBanner({ tap }: { tap: TapOutline }) {
  if (!tap.item) return null;
  const mb = (bytes: number) => (bytes / 1_000_000).toFixed(1);
  const { status, progress } = tap;
  return (
    <div className="measure-banner measure-banner-good" role="status" aria-live="polite">
      {status === "ready" ? <Icon name="sparkle" size={16} /> : <span className="spinner" style={{ width: 16, height: 16 }} />}
      <span className="grow">
        {status === "loading"
          ? <>Getting the free paving model{progress?.total ? `: ${mb(progress.loaded)} of ${mb(progress.total)} MB` : ""}. It downloads once, then stays in this browser.</>
          : status === "reading"
            ? "Reading the aerial in view…"
            : status === "working"
              ? "Outlining…"
              : <><strong>Tap the pavement</strong> to outline it as</>}
      </span>
      <select className="select measure-edge" value={tap.item} onChange={(e) => tap.setItem(e.target.value)} aria-label="Outline as">
        {TAP_ITEMS.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
      </select>
      {tap.resize && (
        <>
          <Button size="sm" onClick={tap.smaller} disabled={!tap.resize.smaller || status !== "ready"} title="Outline less around the last tap">Smaller</Button>
          <Button size="sm" onClick={tap.bigger} disabled={!tap.resize.bigger || status !== "ready"} title="Outline more around the last tap">Bigger</Button>
        </>
      )}
      <Button size="sm" variant="primary" onClick={tap.stop}>Done</Button>
    </div>
  );
}
