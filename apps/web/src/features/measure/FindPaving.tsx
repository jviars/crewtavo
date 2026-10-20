/**
 * Find paving: outlines the asphalt and concrete on the aerial in view, and counts its stalls, with
 * Meta's SAM 3 on the business's own fal.ai account (Apps → fal.ai; routes/paving.ts on the server).
 * What it finds lands on the map as ordinary shapes with their takeoff item, to check and fix
 * before pricing. Without fal.ai installed, the button says how to get it.
 */
import { lineLengthM, polygonAreaM2, SQFT_PER_SQM } from "@crewtavo/core/geo";
import { useMutation } from "@tanstack/react-query";
import { useState, type RefObject } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { FormError } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { api } from "@/lib/api";
import { toast } from "@/lib/toast";
import { anyOf, centers, GRID, maskGrid, outlines } from "./detect";
import type { ImageryId } from "./imagery";
import type { MeasureMapHandle } from "./MeasureMap";

type Target = "asphalt" | "concrete" | "stalls";
interface Result { target: Target; masks: string[]; scores: number[] }

const TARGETS: Array<{ id: Target; label: string; detail: string; item: string }> = [
  { id: "asphalt", label: "Asphalt", detail: "Lots, drives and lanes, with islands and buildings cut out", item: "asphalt" },
  { id: "concrete", label: "Concrete", detail: "Sidewalks, pads and aprons", item: "concrete" },
  { id: "stalls", label: "Stalls", detail: "Counts the striped spaces it can see, up to 32 a run. Best on sharp state imagery.", item: "stall" },
];
/** The picture sent to fal: the middle square of the map, this many pixels across. */
const SIZE = 1024;
/** Too small to be worth a shape, in square feet (bits of curb, shadows). */
const MIN_AREA_SQFT = { asphalt: 250, concrete: 60 } as const;
/** Holes smaller than this are a parked car, not an island. */
const MIN_HOLE_SQFT = 250;
/** Masks SAM 3 isn't at least this sure of are left out. */
const MIN_SCORE = 0.3;

export function FindPaving({
  map,
  ready,
  connected,
  isAdmin,
  imagery,
  pictureImagery,
  zoom,
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
  onFound: (ids: string[], item: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [targets, setTargets] = useState<Target[]>(["asphalt", "concrete"]);
  const notAerial = imagery === "street" || imagery === "terrain";
  const tooFar = zoom < 16;

  const run = useMutation({
    meta: { inline: true },
    mutationFn: async () => {
      const handle = map.current;
      if (!handle) throw new Error("The map isn't ready yet.");
      const view = await handle.viewImage(SIZE, imagery === "google" ? { imagery: await pictureImagery() } : {});
      if (!view) throw new Error("Couldn't take a picture of the map. Try again.");
      const image = await blobToDataUri(view.image);
      const { results } = await api.post<{ results: Result[] }>("/paving/detect", { image, targets });
      // How many feet a picture pixel is, for leaving out specks and car-sized holes.
      const ftPerPx = (lineLengthM([view.at(0, SIZE / 2), view.at(SIZE, SIZE / 2)]) * 3.280_84) / SIZE;
      const cellSqft = ((ftPerPx * SIZE) / GRID) ** 2;
      const toMap = (ring: number[][]) => ring.map(([x, y]) => view.at(x, y));
      const sqft = (ring: number[][]) => polygonAreaM2([ring]) * SQFT_PER_SQM;
      const found: Array<{ item: string; count: number; unit: "area" | "count" }> = [];
      for (const result of results) {
        const sure = result.masks.filter((_, i) => (result.scores[i] ?? 1) >= MIN_SCORE);
        if (!sure.length) continue;
        const grids = await Promise.all(sure.map((m) => maskGrid(m)));
        const spec = TARGETS.find((t) => t.id === result.target)!;
        if (result.target === "stalls") {
          const points = dedupe(centers(grids, SIZE).map(([x, y]) => view.at(x, y)), 4);
          const ids = handle.addPoints(points);
          if (ids.length) {
            onFound(ids, spec.item);
            found.push({ item: "stalls", count: ids.length, unit: "count" });
          }
          continue;
        }
        const min = MIN_AREA_SQFT[result.target];
        const { areas, cutouts } = outlines(anyOf(grids), SIZE, { minCells: Math.max(4, min / cellSqft), minHoleCells: Math.max(4, MIN_HOLE_SQFT / cellSqft) });
        const shapes = areas.map(toMap).filter((ring) => sqft(ring) >= min);
        const ids = handle.add(shapes.map((ring) => [ring]), "Area");
        if (ids.length) {
          onFound(ids, spec.item);
          found.push({ item: spec.label.toLowerCase(), count: ids.length, unit: "area" });
        }
        // Islands and buildings in the asphalt come out of it.
        if (result.target === "asphalt") handle.add(cutouts.map(toMap).filter((ring) => sqft(ring) >= MIN_HOLE_SQFT).map((ring) => [ring]), "Cutout");
      }
      return found;
    },
    onSuccess: (found) => {
      setOpen(false);
      if (!found.length) return void toast.info("Nothing found here. Zoom so the lot fills the map, or draw it with the items list.");
      const words = found.map((f) => (f.unit === "count" ? `${f.count} ${f.count === 1 ? "stall" : "stalls"}` : `${f.count} ${f.item} ${f.count === 1 ? "area" : "areas"}`));
      toast.success(`Found ${list(words)}. Check them against the imagery and drag any corners that are off.`);
    },
  });

  const toggle = (id: Target, on: boolean) => setTargets((t) => (on ? [...t.filter((x) => x !== id), id] : t.filter((x) => x !== id)));

  return (
    <>
      <Button size="sm" variant={connected ? "primary" : undefined} icon="sparkle" disabled={!ready} onClick={() => setOpen(true)}>
        Find paving
      </Button>
      <span className="muted small">{connected ? "Outlines what's on the aerial for you." : "Outlines the lot for you, with fal.ai."}</span>
      {open && (
        <Dialog open onClose={() => !run.isPending && setOpen(false)} title="Find paving" description="Outlines what's on the aerial in view, then you check it." size="md">
          {connected ? (
            <form className="dialog-body stack" onSubmit={(e) => { e.preventDefault(); run.mutate(); }}>
              <fieldset className="stack-sm" style={{ border: 0, padding: 0, margin: 0 }}>
                <legend className="small strong" style={{ marginBottom: 6 }}>What to find</legend>
                {TARGETS.map((t) => (
                  <label key={t.id} className="check-row">
                    <input type="checkbox" checked={targets.includes(t.id)} onChange={(e) => toggle(t.id, e.target.checked)} disabled={run.isPending} />
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
                  It looks at the map as it is now, so zoom until the lot fills it. Each thing you find costs about half a cent on your fal.ai account.
                  {imagery === "google" ? " Google's imagery can't be sent on, so it looks at the free imagery here instead." : ""}
                </span>
              </div>
              {notAerial && <div className="field-error" role="alert">Switch to aerial imagery first: Find paving needs a photo of the lot.</div>}
              {!notAerial && tooFar && <div className="field-error" role="alert">Zoom in closer to the lot first.</div>}
              {run.isPending && <span className="muted small row" style={{ gap: 8 }} role="status"><span className="spinner" style={{ width: 14, height: 14 }} /> Looking at the aerial. This takes about 10 to 30 seconds.</span>}
              <FormError error={run.error} />
              <div className="form-actions">
                <Button onClick={() => setOpen(false)} disabled={run.isPending}>Cancel</Button>
                <Button type="submit" variant="primary" icon="sparkle" loading={run.isPending} disabled={!targets.length || notAerial || tooFar}>Find</Button>
              </div>
            </form>
          ) : (
            <div className="dialog-body stack">
              <p style={{ margin: 0 }}>
                Find paving outlines the asphalt and concrete on the aerial, cuts out islands and buildings, and counts stalls, so you check a takeoff instead of drawing it.
                It uses Meta's Segment Anything model through <strong>fal.ai</strong>, on your own fal.ai account: about half a cent for each thing it finds.
              </p>
              <p className="muted small" style={{ margin: 0 }}>
                {isAdmin ? "Installing fal.ai takes about two minutes: make an account, add a few dollars of credit and paste your key." : "Ask an owner or admin to install fal.ai on the Apps page. It takes about two minutes."}
              </p>
              <div className="form-actions">
                <Button onClick={() => setOpen(false)}>Not now</Button>
                {isAdmin && <Link className="btn btn-primary" to="/apps/fal">Set up fal.ai</Link>}
              </div>
            </div>
          )}
        </Dialog>
      )}
    </>
  );
}

function blobToDataUri(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("Couldn't read the map picture."));
    reader.readAsDataURL(blob);
  });
}

/** Points closer than `feet` to one already kept are the same stall found twice. */
function dedupe(points: Array<[number, number]>, feet: number): Array<[number, number]> {
  const kept: Array<[number, number]> = [];
  for (const p of points) if (!kept.some((k) => lineLengthM([k, p]) * 3.280_84 < feet)) kept.push(p);
  return kept;
}

const list = (words: string[]) => (words.length < 2 ? words.join("") : `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`);
