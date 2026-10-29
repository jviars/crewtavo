/**
 * A plan sheet on the Measure map, for new paving where the aerial still shows dirt or the old site:
 * pick a plan (and a page of a PDF), line it up with the aerial by tapping the same two spots on
 * the plan and on the map, fade it or show just its lines, and draw over it with the usual tools.
 * Sizes always come from the map, so a plan lined up a little off shows up in the scale check: the
 * plan's printed scale ("1 in = 30 ft") should match what it lined up at. The plan opens full
 * screen in the viewer too, to read it; the office can mark it up there (a new version, which then
 * goes on the map in its place).
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { FileViewer } from "@/features/files/FileViewer";
import { refreshStorage, useStorageFull } from "@/features/settings/storage";
import { supabase, unwrap } from "@/lib/api";
import { hasRole, useSession } from "@/lib/session";
import { toast } from "@/lib/toast";
import { forgetPlanPdf, releasePlanImage, renderPlan, type PlanImage } from "../plans/planImage";
import { canMap, fileSize, isAbort, PLAN_FIELDS, planLink, titleFromFileName, TooLargeError, uploadPlanFile, type PlanFile } from "../plans/plans";
import type { MeasureMapHandle } from "./MeasureMap";
import {
  cornersOf, feetPerInch, fitToView, isCorners, lineUp, LineUpError, moveTo, pixelAt, placementFromCorners, pointAt, scaleLabel, type Corners, type LngLat, type Placement,
} from "./planAlign";

/** What's saved with a drawing (measurements.view.plan) so it reopens with the plan where it was. */
export interface SavedPlan {
  id: string;
  page: number;
  corners: Corners;
  size: [number, number];
  opacity: number;
  paper: boolean;
  hidden?: boolean;
}

interface Shown {
  file: PlanFile;
  page: number;
  image: PlanImage;
  placement: Placement;
  opacity: number;
  paper: boolean;
  hidden: boolean;
  linedUp: boolean;
}

type Stage = "plan1" | "map1" | "plan2" | "map2";
interface Step {
  stage: Stage;
  pixels: Array<[number, number]>;
  spots: LngLat[];
}

const STEPS: Record<Stage, { n: number; text: string }> = {
  plan1: { n: 1, text: "Tap a spot on the plan you can also find on the aerial: a building corner, a curb corner, the end of a drive." },
  map1: { n: 2, text: "Now tap that same spot on the aerial." },
  plan2: { n: 3, text: "Tap a second spot on the plan, far from the first (the opposite corner of the lot is best)." },
  map2: { n: 4, text: "And tap that second spot on the aerial." },
};

export const isSavedPlan = (value: unknown): value is SavedPlan => {
  const v = value as SavedPlan | null;
  return Boolean(v && typeof v.id === "string" && typeof v.page === "number" && isCorners(v.corners) && Array.isArray(v.size) && v.size.length === 2);
};

/**
 * Everything about the plan on the map. `where` is what the drawing is for: its property and
 * quote, whose plans are offered (and where a plan added here is kept).
 */
export function usePlanOnMap({
  map, ready, companyId, where, saved, open, onTooLarge,
}: {
  map: RefObject<MeasureMapHandle | null>;
  ready: boolean;
  companyId: string;
  where: { property: string | null; quote: string | null };
  /** The plan saved with the drawing being reopened. */
  saved: SavedPlan | null;
  /** A plan to put on straight away (from "Put on the map" on a Plans and files card). */
  open: string | null;
  /** A plan added here was bigger than this Crewtavo takes (plans/UploadLimit.tsx). */
  onTooLarge: (error: TooLargeError) => void;
}) {
  const queryClient = useQueryClient();
  const storageFull = useStorageFull();
  const [shown, setShown] = useState<Shown | null>(null);
  const [loading, setLoading] = useState<string | null>(null);
  const [step, setStep] = useState<Step | null>(null);
  const [sending, setSending] = useState<{ name: string; progress: number; abort: () => void } | null>(null);
  // Unsaved changes to the plan in the viewer (PlanCard's "Open it"), for Measure's check before leaving.
  const [viewerDirty, setViewerDirty] = useState(false);
  const shownRef = useRef(shown);
  shownRef.current = shown;

  const plans = useQuery({
    queryKey: ["plans", "measure", where.property, where.quote],
    enabled: Boolean(where.property || where.quote),
    meta: { silent: true },
    queryFn: async () => {
      const filter = [where.property && `property_id.eq.${where.property}`, where.quote && `quote_id.eq.${where.quote}`].filter(Boolean).join(",");
      const rows = unwrap(await supabase().from("plan_files").select(PLAN_FIELDS).or(filter).is("superseded_at", null).eq("archived", false).order("created_at", { ascending: false }).limit(60)) as PlanFile[];
      return rows.filter(canMap);
    },
  });

  // ----- Loading a plan ----------------------------------------------------------------------
  const load = useCallback(
    async (file: PlanFile, page: number, from: Partial<Pick<Shown, "opacity" | "paper" | "hidden">> & { corners?: Corners; size?: [number, number]; keepPlacement?: boolean } = {}) => {
      setLoading(file.id);
      setStep(null);
      try {
        let image: PlanImage;
        try {
          image = await renderPlan(file, await planLink(file.path), page);
        } catch {
          // An hour-old link to a PDF that was already open: open it again with a fresh one.
          forgetPlanPdf(file.path);
          image = await renderPlan(file, await planLink(file.path), page);
        }
        const before = shownRef.current;
        let placement: Placement;
        let linedUp = false;
        if (from.corners) {
          placement = placementFromCorners(from.corners, from.size?.[0] ?? image.width);
          const ratio = (from.size?.[0] ?? image.width) / image.width;
          placement = { ...placement, a: placement.a * ratio, b: placement.b * ratio };
          linedUp = true;
        } else if (from.keepPlacement && before && before.image.width === image.width && before.image.height === image.height) {
          // Another sheet of the same set: same paper, usually the same drawing scale.
          placement = before.placement;
          linedUp = before.linedUp;
        } else {
          const box = map.current?.viewBox();
          if (!box) throw new Error("The map isn't ready yet.");
          placement = fitToView(box.center, box.west, box.east, image.width, image.height);
        }
        if (before && before.image !== image) releasePlanImage(before.image);
        setShown({
          file, page, image, placement, linedUp,
          opacity: from.opacity ?? before?.opacity ?? 0.85,
          paper: from.paper ?? before?.paper ?? false,
          hidden: from.hidden ?? false,
        });
        return !linedUp;
      } catch (error) {
        toast.error(`Couldn't put ${file.title} on the map.`, { description: error instanceof Error ? error.message : undefined });
        return false;
      } finally {
        setLoading(null);
      }
    },
    [map],
  );

  // The plan the drawing was saved with, or the one asked for, once the map is up.
  const started = useRef(false);
  useEffect(() => {
    if (!ready || started.current || !(saved || open)) return;
    started.current = true;
    void (async () => {
      const id = saved?.id ?? open!;
      const file = unwrap(await supabase().from("plan_files").select(PLAN_FIELDS).eq("id", id).maybeSingle()) as PlanFile | null;
      if (!file) return toast.error(saved ? "The plan saved with this drawing was deleted or moved to the Trash, so it's not on the map." : "That plan wasn't found. It may have been moved to the Trash.");
      if (saved) await load(file, saved.page, { corners: saved.corners, size: saved.size, opacity: saved.opacity, paper: saved.paper, hidden: saved.hidden });
      else if (await load(file, 1)) setStep({ stage: "plan1", pixels: [], spots: [] });
    })();
  }, [ready, saved, open, load]);

  // Hand the images back when leaving Measure.
  useEffect(() => () => releasePlanImage(shownRef.current?.image), []);

  // ----- What the map shows ------------------------------------------------------------------
  useEffect(() => {
    const m = map.current;
    if (!m || !ready) return;
    if (!shown) {
      m.setPlan(null);
      m.setPins([]);
      return;
    }
    const { image, placement } = shown;
    // Lining up: the plan on its own to find a spot on it, then out of the way to find it on the aerial.
    const opacity = step ? (step.stage.startsWith("plan") ? 1 : step.stage === "map2" ? 0.25 : 0) : shown.hidden ? 0 : shown.opacity;
    const paper = step ? step.stage.startsWith("plan") || shown.paper : shown.paper;
    m.setPlan({ url: paper ? image.url : image.linesUrl, corners: cornersOf(placement, image.width, image.height), opacity });
    m.setPins(
      step
        ? step.stage.startsWith("plan")
          ? step.pixels.map((px, i) => ({ at: pointAt(placement, px), label: String(i + 1), tone: "plan" as const }))
          : step.spots.map((at, i) => ({ at, label: String(i + 1), tone: "map" as const }))
        : [],
    );
  }, [map, ready, shown, step]);

  // ----- Lining up ---------------------------------------------------------------------------
  const onPick = useCallback(
    (at: LngLat) => {
      const s = shownRef.current;
      if (!s || !step) return;
      const { width, height } = s.image;
      if (step.stage === "plan1" || step.stage === "plan2") {
        const px = pixelAt(s.placement, at);
        if (px[0] < 0 || px[1] < 0 || px[0] > width || px[1] > height) return toast.info("Tap on the plan sheet itself.");
        if (step.stage === "plan2" && Math.hypot(px[0] - step.pixels[0][0], px[1] - step.pixels[0][1]) < 60) return toast.info("Pick a spot farther from the first one.");
        setStep({ ...step, stage: step.stage === "plan1" ? "map1" : "map2", pixels: [...step.pixels, px] });
        return;
      }
      if (step.stage === "map1") {
        // Pinned at the first spot, so the second is easier to find.
        setShown({ ...s, placement: moveTo(s.placement, step.pixels[0], at) });
        setStep({ ...step, stage: "plan2", spots: [at] });
        return;
      }
      try {
        const placement = lineUp([step.pixels[0], step.pixels[1]], [step.spots[0], at]);
        setShown({ ...s, placement, linedUp: true, hidden: false });
        setStep(null);
        toast.success("Lined up", { description: s.image.pxPerInch ? `The plan works out to ${scaleLabel(feetPerInch(placement, at[1], s.image.pxPerInch))}. Check that against the scale printed on it.` : "Draw a line along something you know the size of to check it." });
      } catch (error) {
        toast.error(error instanceof LineUpError ? error.message : "Couldn't line it up. Try again.");
        setStep({ stage: "plan1", pixels: [], spots: [] });
      }
    },
    [step],
  );
  useEffect(() => {
    if (!ready) return;
    map.current?.pickSpots(step ? onPick : null);
  }, [map, ready, step, onPick]);
  // Off when leaving the page mid-way.
  useEffect(() => () => map.current?.pickSpots(null), [map]);

  // ----- Adding a plan from here -------------------------------------------------------------
  const add = async (file: File) => {
    const target = where.quote ? { quote_id: where.quote } : where.property ? { property_id: where.property } : null;
    if (!target) return;
    const upload = uploadPlanFile(companyId, file, (progress) => setSending((s) => (s ? { ...s, progress } : s)));
    setSending({ name: file.name, progress: 0, abort: upload.abort });
    try {
      const path = await upload.promise;
      const row = await supabase()
        .from("plan_files")
        .insert({ company_id: companyId, ...target, title: titleFromFileName(file.name), path, file_name: file.name.slice(0, 255), content_type: file.type || null, size_bytes: file.size })
        .select(PLAN_FIELDS)
        .single();
      // A stored file with no row is tidied away by the server after a day.
      if (row.error) throw new Error(row.error.message);
      queryClient.invalidateQueries({ queryKey: ["plans"] });
      void refreshStorage(queryClient);
      if (await load(row.data as PlanFile, 1)) setStep({ stage: "plan1", pixels: [], spots: [] });
    } catch (error) {
      if (error instanceof TooLargeError) onTooLarge(error);
      else if (!isAbort(error) && !storageFull(error, `${file.name} wasn't added`)) toast.error(`${file.name}: ${error instanceof Error ? error.message : "Couldn't add it."}`);
    } finally {
      setSending(null);
    }
  };

  const remove = () => {
    setStep(null);
    releasePlanImage(shown?.image);
    setShown(null);
  };
  const patch = (next: Partial<Shown>) => setShown((s) => (s ? { ...s, ...next } : s));
  /** A new version saved in the viewer: it goes on the map where this one was. */
  const replace = (next: PlanFile) => {
    queryClient.invalidateQueries({ queryKey: ["plans"] });
    const s = shownRef.current;
    if (s && canMap(next)) void load(next, s.page, { keepPlacement: true });
  };

  const savedPlan: SavedPlan | null = shown
    ? { id: shown.file.id, page: shown.page, corners: cornersOf(shown.placement, shown.image.width, shown.image.height), size: [shown.image.width, shown.image.height], opacity: shown.opacity, paper: shown.paper, hidden: shown.hidden || undefined }
    : null;

  return {
    shown, loading, step, plans, sending, savedPlan, viewerDirty, setViewerDirty,
    choose: (file: PlanFile) => load(file, 1).then((fresh) => fresh && setStep({ stage: "plan1", pixels: [], spots: [] })),
    page: (page: number) => shown && load(shown.file, page, { keepPlacement: true }),
    startLineUp: () => setStep({ stage: "plan1", pixels: [], spots: [] }),
    cancelLineUp: () => setStep(null),
    add, remove, patch, replace,
  };
}

export type PlanOnMap = ReturnType<typeof usePlanOnMap>;

// ---------------------------------------------------------------------------------------------
// On the map: what to tap next
// ---------------------------------------------------------------------------------------------

export function LineUpBanner({ plan }: { plan: PlanOnMap }) {
  if (!plan.step) return null;
  const s = STEPS[plan.step.stage];
  return (
    <div className="measure-banner measure-banner-good" role="status" aria-live="polite">
      <span className="chip chip-green tabular">Step {s.n} of 4</span>
      <span className="grow"><strong>{plan.step.stage.startsWith("plan") ? "On the plan: " : "On the aerial: "}</strong>{s.text}</span>
      <Button size="sm" onClick={plan.cancelLineUp}>Cancel</Button>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Beside the map: which plan, which page, how it looks
// ---------------------------------------------------------------------------------------------

export function PlanCard({ plan, canAdd, hasPlace }: { plan: PlanOnMap; canAdd: boolean; hasPlace: boolean }) {
  const session = useSession();
  const input = useRef<HTMLInputElement>(null);
  const [viewing, setViewing] = useState(false);
  const { shown, plans, sending } = plan;
  const list = plans.data ?? [];
  const scale = shown?.linedUp && shown.image.pxPerInch ? scaleLabel(feetPerInch(shown.placement, pointAt(shown.placement, [shown.image.width / 2, shown.image.height / 2])[1], shown.image.pxPerInch)) : null;
  // Nothing to offer and nowhere to keep a new plan: say how to get one.
  if (!shown && !list.length && !hasPlace) {
    return (
      <div className="card card-pad stack-sm">
        <strong>Plan on the map</strong>
        <span className="muted small">To measure from a site plan, open Measure from the client's property, quote or job, or pick the client's property in the search above.</span>
      </div>
    );
  }
  return (
    <div className="card card-pad stack-sm">
      <div className="row-between">
        <strong>Plan on the map</strong>
        {shown && <Button size="sm" variant="ghost" icon="x" onClick={plan.remove}>Take it off</Button>}
      </div>
      <input ref={input} type="file" accept="application/pdf,.pdf,image/png,image/jpeg,image/webp" hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void plan.add(f); }} />
      {!shown && (
        <>
          <span className="muted small">For new paving, where the aerial still shows dirt or the old site: put the site plan on the map, line it up, and draw over it.</span>
          {list.length > 0 && (
            <label className="field">
              <span>Plan</span>
              <select className="select" value="" disabled={Boolean(plan.loading)} onChange={(e) => { const f = list.find((p) => p.id === e.target.value); if (f) void plan.choose(f); }}>
                <option value="">{plan.loading ? "Opening the plan…" : "Choose a plan…"}</option>
                {list.map((p) => <option key={p.id} value={p.id}>{p.title}{p.revision ? ` · ${p.revision}` : ""}</option>)}
              </select>
            </label>
          )}
          {plans.data && !list.length && hasPlace && <span className="muted small">No plans for this property or quote yet.</span>}
        </>
      )}
      {sending && (
        <div className="stack-sm" role="status">
          <div className="row-between small"><span className="strong" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{sending.name}</span><span className="muted tabular">{Math.round(sending.progress * 100)}%</span></div>
          <div className="progress"><span style={{ width: `${Math.round(sending.progress * 100)}%` }} /></div>
        </div>
      )}
      {!shown && canAdd && hasPlace && !sending && (
        <Button size="sm" icon="upload" style={{ justifySelf: "start" }} disabled={Boolean(plan.loading)} onClick={() => input.current?.click()}>Add a plan (PDF or picture)</Button>
      )}
      {plan.loading && shown && <span className="muted small"><span className="spinner" style={{ width: 12, height: 12 }} /> Opening the page…</span>}
      {shown && (
        <>
          <div className="stack-sm" style={{ gap: 2 }}>
            <span className="strong text-sm">{shown.file.title}{shown.file.revision ? ` · ${shown.file.revision}` : ""}</span>
            <span className="muted small">
              {fileSize(shown.file.size_bytes)}{shown.image.pages > 1 ? ` · ${shown.image.pages} pages` : ""} ·{" "}
              <button type="button" className="link-btn" onClick={() => setViewing(true)}>Open it</button>
            </span>
          </div>
          {shown.image.pages > 1 && (
            <label className="field">
              <span>Page</span>
              <select className="select" value={shown.page} disabled={Boolean(plan.loading) || Boolean(plan.step)} onChange={(e) => void plan.page(Number(e.target.value))}>
                {Array.from({ length: shown.image.pages }, (_, i) => <option key={i} value={i + 1}>Page {i + 1}</option>)}
              </select>
            </label>
          )}
          {!plan.step && (
            <Button size="sm" variant={shown.linedUp ? "secondary" : "primary"} icon="pin" style={{ justifySelf: "start" }} onClick={plan.startLineUp}>
              {shown.linedUp ? "Line it up again" : "Line it up with the aerial"}
            </Button>
          )}
          {!shown.linedUp && !plan.step && <span className="small" style={{ color: "var(--warning)" }}>Not lined up yet, so sizes drawn on it won't be right.</span>}
          {scale && <span className="small"><Icon name="check" size={13} /> Lined up at <strong>{scale}</strong>. The scale printed on the plan should say the same; if it's off, line it up again with spots farther apart.</span>}
          <label className="field">
            <span>See-through</span>
            <input type="range" min={10} max={100} step={5} value={Math.round(shown.opacity * 100)} disabled={shown.hidden} onChange={(e) => plan.patch({ opacity: Number(e.target.value) / 100 })} aria-label="How solid the plan is" />
          </label>
          <label className="switch-row" style={{ fontWeight: 500 }}>
            <input type="checkbox" className="switch" checked={shown.paper} onChange={(e) => plan.patch({ paper: e.target.checked })} />
            Show the white paper
          </label>
          <span className="muted small" style={{ marginTop: -4 }}>Off shows just the plan's lines on the aerial.</span>
          <label className="switch-row" style={{ fontWeight: 500 }}>
            <input type="checkbox" className="switch" checked={!shown.hidden} onChange={(e) => plan.patch({ hidden: !e.target.checked })} />
            Show the plan
          </label>
          <span className="muted small">Draw over it with Area, Line and Count. Sizes come from the map, so they're right once the plan is lined up.</span>
        </>
      )}
      {viewing && shown && (
        <FileViewer
          file={shown.file}
          // Crews only look; a marked-up plan is a new version, for the office.
          canEdit={hasRole(session, "admin", "office", "estimator")}
          // Measure's own check before leaving covers changes here too: the router heeds only one.
          blockNavigation={false}
          onDirtyChange={plan.setViewerDirty}
          onClose={() => setViewing(false)}
          onSaved={(next) => {
            setViewing(false);
            plan.replace(next);
          }}
        />
      )}
    </div>
  );
}
