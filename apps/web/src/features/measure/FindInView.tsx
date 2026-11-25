/**
 * Finding paving or a lawn on the aerial, two ways. The free one is the Find tool in the map's dock
 * (TapOutline.tsx): put a box round a lot or a yard, press Outline, and SAM 2.1 in the browser
 * outlines it. This is the panel's row for **Find everything in view**, the upgrade: with Meta's
 * SAM 3 on the business's own fal.ai account (Apps → fal.ai; routes/paving.ts on the server), it
 * outlines all the asphalt and concrete and counts the stalls, or outlines the lawn and marks its
 * trees and play sets, which the free model can't pick out by name. Without fal.ai installed, its
 * dialog says how to get it. What either finds lands on the map as ordinary shapes with their
 * takeoff item, to check before pricing.
 */
import { lineLengthM, polygonAreaM2, SQFT_PER_SQM, type Position } from "@crewtavo/core/geo";
import { useMutation } from "@tanstack/react-query";
import { useState, type RefObject } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { FormError } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { api } from "@/lib/api";
import { toast } from "@/lib/toast";
import { buildingsIn, lotAt } from "./buildings";
import { anyOf, centers, GRID, maskGrid, outlines } from "./detect";
import type { ImageryId } from "./imagery";
import type { MeasureMapHandle } from "./MeasureMap";
import { LAWN_TAP, lawnShape } from "./TapOutline";

/** What the server asks SAM 3 for (DETECT_TARGETS in integrations/fal.ts). */
type Ask = "asphalt" | "concrete" | "stalls" | "lawn" | "trees" | "trampolines" | "playsets";
interface Result { target: Ask; masks: string[]; scores: number[] }
/** A choice in the dialog: what it asks for, and how what comes back lands on the map. */
interface Target { id: string; label: string; detail: string; ask: Ask[]; item: string; as: "area" | "points"; word: [string, string] }

const PAVING_TARGETS: Target[] = [
  { id: "asphalt", label: "Asphalt", detail: "Lots, drives and lanes, with islands and buildings cut out", ask: ["asphalt"], item: "asphalt", as: "area", word: ["asphalt area", "asphalt areas"] },
  { id: "concrete", label: "Concrete", detail: "Sidewalks, pads and aprons", ask: ["concrete"], item: "concrete", as: "area", word: ["concrete area", "concrete areas"] },
  { id: "stalls", label: "Stalls", detail: "Counts the striped spaces it can see, up to 32 a run. Best on sharp state imagery.", ask: ["stalls"], item: "stall", as: "points", word: ["stall", "stalls"] },
];
const LAWN_TARGETS: Target[] = [
  { id: "lawn", label: "Lawn", detail: "The grass, with the buildings cut out and the shade under trees kept in", ask: ["lawn"], item: LAWN_TAP, as: "area", word: ["lawn", "lawns"] },
  { id: "trees", label: "Trees", detail: "Marks each tree on the lawn to trim around", ask: ["trees"], item: "tree", as: "points", word: ["tree", "trees"] },
  { id: "play", label: "Trampolines and play sets", detail: "Marked as obstacles to trim around", ask: ["trampolines", "playsets"], item: "obstacle", as: "points", word: ["obstacle", "obstacles"] },
];
/** The picture sent to fal: the middle square of the map, this many pixels across. */
const SIZE = 1024;
/** Too small to be worth a shape, in square feet (bits of curb, shadows, a strip by the road). */
const MIN_AREA_SQFT: Record<string, number> = { asphalt: 250, concrete: 60, lawn: 150 };
/** Holes smaller than this are a parked car, not an island. */
const MIN_HOLE_SQFT = 250;
/** Points closer than this, in feet, are one thing found twice. */
const SAME_SPOT_FT: Record<string, number> = { stall: 4, tree: 6, obstacle: 4 };
/** Masks SAM 3 isn't at least this sure of are left out. */
const MIN_SCORE = 0.3;

export function FindInView({
  map,
  ready,
  connected,
  isAdmin,
  imagery,
  pictureImagery,
  zoom,
  paving,
  lawn,
  lawns,
  onFound,
}: {
  map: RefObject<MeasureMapHandle | null>;
  ready: boolean;
  /** The business has fal.ai installed. */
  connected: boolean;
  isAdmin: boolean;
  imagery: ImageryId | null;
  /** The free imagery to look at when the map shows Google's, which can't be sent on. */
  pictureImagery: () => Promise<ImageryId>;
  zoom: number;
  /** Offer paving (asphalt, concrete, stalls). */
  paving: boolean;
  /** Offer a lawn, its trees and its play sets. */
  lawn: boolean;
  /** The lawns already drawn: trees and play sets are only marked on a lawn. */
  lawns: Position[][][];
  onFound: (ids: string[], item: string, osm?: boolean) => void;
}) {
  const offered = [...(paving ? PAVING_TARGETS : []), ...(lawn ? LAWN_TARGETS : [])];
  const [open, setOpen] = useState(false);
  // What's turned off, so a choice offered later (the lawn turned on) starts ticked. Stalls cost the most and need sharp imagery.
  const [off, setOff] = useState<string[]>(["stalls"]);
  const targets = offered.filter((t) => !off.includes(t.id));
  const notAerial = imagery === "street" || imagery === "terrain";
  const tooFar = zoom < 16;
  const place = paving && !lawn ? "lot" : lawn && !paving ? "yard" : "property";

  const run = useMutation({
    meta: { inline: true },
    mutationFn: async () => {
      const handle = map.current;
      if (!handle) throw new Error("The map isn't ready yet.");
      const view = await handle.viewImage(SIZE, imagery === "google" ? { imagery: await pictureImagery() } : {});
      if (!view) throw new Error("Couldn't take a picture of the map. Try again.");
      const image = view.canvas.toDataURL("image/jpeg", 0.9);
      const wantsLawn = targets.some((t) => t.id === "lawn");
      // The buildings in view come out of a lawn, asked while fal looks.
      const [w, n] = view.at(0, 0);
      const [e, s] = view.at(SIZE, SIZE);
      const buildings = wantsLawn ? buildingsIn([w, s, e, n]).catch(() => []) : Promise.resolve([]);
      const { results } = await api.post<{ results: Result[] }>("/paving/detect", { image, targets: targets.flatMap((t) => t.ask) });
      // How many feet a picture pixel is, for leaving out specks and car-sized holes.
      const ftPerPx = (lineLengthM([view.at(0, SIZE / 2), view.at(SIZE, SIZE / 2)]) * 3.280_84) / SIZE;
      const cellSqft = ((ftPerPx * SIZE) / GRID) ** 2;
      const toMap = (ring: number[][]) => ring.map(([x, y]) => view.at(x, y));
      const sqft = (ring: number[][]) => polygonAreaM2([ring]) * SQFT_PER_SQM;
      const found: Array<{ target: Target; count: number }> = [];
      /** Lawns found now, or else the ones drawn: where trees and play sets count. */
      let onLawn = lawns;
      // A lawn first, so the trees and play sets can be kept to it.
      for (const target of [...targets].sort((a, b) => Number(b.id === "lawn") - Number(a.id === "lawn"))) {
        const grids = await Promise.all(
          results.filter((r) => target.ask.includes(r.target)).flatMap((r) => r.masks.filter((_, i) => (r.scores[i] ?? 1) >= MIN_SCORE)).map((m) => maskGrid(m)),
        );
        if (!grids.length) continue;
        if (target.as === "points") {
          const spots = dedupe(centers(grids, SIZE).map(([x, y]) => view.at(x, y)), SAME_SPOT_FT[target.item] ?? 4);
          const kept = target.item === "stall" || !onLawn.length ? spots : spots.filter((p) => lotAt(onLawn, p));
          const ids = handle.addPoints(kept);
          if (ids.length) {
            onFound(ids, target.item);
            found.push({ target, count: ids.length });
          }
          continue;
        }
        const min = MIN_AREA_SQFT[target.id] ?? 100;
        const { areas, cutouts } = outlines(anyOf(grids), SIZE, { minCells: Math.max(4, min / cellSqft), minHoleCells: Math.max(4, MIN_HOLE_SQFT / cellSqft) });
        const shapes = areas.map(toMap).filter((ring) => sqft(ring) >= min);
        if (target.id === "lawn") {
          const lawnFound = lawnShape(shapes.map((ring) => [ring]), await buildings);
          const ids = handle.add(lawnFound.polygons, "Area");
          if (ids.length) {
            onFound(ids, target.item, lawnFound.osm);
            found.push({ target, count: ids.length });
            onLawn = lawnFound.polygons;
          }
          continue;
        }
        const ids = handle.add(shapes.map((ring) => [ring]), "Area");
        if (ids.length) {
          onFound(ids, target.item);
          found.push({ target, count: ids.length });
        }
        // Islands and buildings in the asphalt come out of it.
        if (target.id === "asphalt") handle.add(cutouts.map(toMap).filter((ring) => sqft(ring) >= MIN_HOLE_SQFT).map((ring) => [ring]), "Cutout");
      }
      return found;
    },
    onSuccess: (found) => {
      setOpen(false);
      if (!found.length) return void toast.info(`Nothing found here. Zoom so the ${place} fills the map, or outline it with Find in the dock.`);
      const words = found.map(({ target, count }) => `${count} ${target.word[count === 1 ? 0 : 1]}`);
      toast.success(`Found ${list(words)}. Check them against the imagery and drag any corners that are off.`);
    },
  });

  const toggle = (id: string, on: boolean) => setOff((t) => (on ? t.filter((x) => x !== id) : [...t, id]));
  const blocked = notAerial ? `Switch to aerial imagery first: this needs a photo of the ${place}.` : tooFar ? `Zoom in closer to the ${place} first.` : null;
  const what = [paving && "all the asphalt and concrete, and the stalls counted", lawn && "the lawn, with its trees and play sets marked"].filter(Boolean).join("; or ");

  return (
    <>
      <div className="measure-row">
        <Icon name="sparkle" size={17} />
        <span className="grow">Find everything in view <span className="measure-row-meta">· fal.ai</span></span>
        <button type="button" className="link-btn" disabled={!ready} onClick={() => setOpen(true)}>Open</button>
      </div>
      {open && (
        <Dialog open onClose={() => !run.isPending && setOpen(false)} title="Find everything in view" description={`With fal.ai, on the aerial at once: ${what}.`} size="md">
          <form
            className="dialog-body stack"
            onSubmit={(e) => {
              e.preventDefault();
              if (!blocked && connected) run.mutate();
            }}
          >
            {connected ? (
              <>
                <fieldset className="stack-sm" style={{ border: 0, padding: 0, margin: 0 }}>
                  <legend className="small strong" style={{ marginBottom: 6 }}>What to find</legend>
                  {offered.map((t) => (
                    <label key={t.id} className="check-row">
                      <input type="checkbox" checked={!off.includes(t.id)} onChange={(e) => toggle(t.id, e.target.checked)} disabled={run.isPending} />
                      <span className="grow" style={{ display: "grid", gap: 1 }}>
                        <strong>{t.label}</strong>
                        <span className="muted small">{t.detail}</span>
                      </span>
                    </label>
                  ))}
                </fieldset>
                <div className="callout" role="note">
                  <Icon name="info" size={16} />
                  <span className="small" style={{ fontWeight: 400 }}>
                    It looks at the map as it is now, so zoom until the {place} fills it. Each thing it looks for costs about half a cent on your fal.ai account{targets.length ? `: ${cents(targets.flatMap((t) => t.ask).length)} for this` : ""}.
                    {imagery === "google" ? " Google's imagery can't be sent on, so it looks at the free imagery here instead." : ""}
                  </span>
                </div>
              </>
            ) : (
              <p className="muted small" style={{ margin: 0 }}>
                It uses Meta's Segment Anything model (SAM 3) through <strong>fal.ai</strong>, on your own fal.ai account: about half a cent for each thing it looks for. The free way (<strong>Find</strong> in the dock: a box round the {place}, then <strong>Outline</strong>) needs none of this, but it outlines one surface at a time{lawn ? " and can't pick out trees or play sets" : ""}.{" "}
                {isAdmin ? "Installing fal.ai takes about two minutes: make an account, add a few dollars of credit and paste your key." : "Ask an owner or admin to install fal.ai on the Apps page. It takes about two minutes."}
              </p>
            )}
            {connected && blocked && <div className="field-error" role="alert">{blocked}</div>}
            {run.isPending && <span className="muted small row" style={{ gap: 8 }} role="status"><span className="spinner" style={{ width: 14, height: 14 }} /> Looking at the aerial. This takes about 10 to 30 seconds.</span>}
            <FormError error={run.error} />
            <div className="form-actions">
              <Button onClick={() => setOpen(false)} disabled={run.isPending}>{connected ? "Cancel" : "Not now"}</Button>
              {connected ? (
                <Button type="submit" variant="primary" icon="sparkle" loading={run.isPending} disabled={!targets.length || Boolean(blocked)}>Find</Button>
              ) : (
                isAdmin && <Link className="btn btn-primary" to="/apps/fal">Set up fal.ai</Link>
              )}
            </div>
          </form>
        </Dialog>
      )}
    </>
  );
}

/** Points closer than `feet` to one already kept are the same thing found twice. */
function dedupe(points: Array<[number, number]>, feet: number): Array<[number, number]> {
  const kept: Array<[number, number]> = [];
  for (const p of points) if (!kept.some((k) => lineLengthM([k, p]) * 3.280_84 < feet)) kept.push(p);
  return kept;
}

/** What this many requests cost at fal's half a cent each, in words. */
const cents = (requests: number) => (requests % 2 ? `${(requests / 2).toFixed(1)}¢` : `${requests / 2}¢`);

const list = (words: string[]) => (words.length < 2 ? words.join("") : `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`);
