/**
 * A roof measured by someone else's report (EagleView, Hover, the insurer's): its numbers typed in
 * instead of the roof traced on the map. Saved as a measurement like a drawn one (POST
 * /measurements, provider "report"), made of placeholder shapes that carry the report's numbers
 * (core roofReportCollection), so the packages, the formulas and the estimate price from it exactly
 * as they do from a drawing. It's called "Roof measurements from a report" wherever a drawing would
 * be named, and has no map picture.
 */
import { suggestedWaste, REPORT_PROVIDER, REPORT_TITLE, reportPitch, roofReportCollection, roofReportOf, roofReportProblem, type RoofReport } from "@crewtavo/core/roofing";
import { useMutation } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/Button";
import { DecimalInput } from "@/components/ui/DecimalInput";
import { Dialog } from "@/components/ui/Dialog";
import { Field, FormError } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { api, supabase, unwrap } from "@/lib/api";
import type { TakeoffRow } from "../../paving/data";
import { useRefreshProject } from "./data";
import styles from "./flow.module.css";
import { Select } from "@/components/ui/Select";

const EDGES = [
  ["eave_ft", "Eaves"],
  ["rake_ft", "Rakes"],
  ["ridge_ft", "Ridges"],
  ["hip_ft", "Hips"],
  ["valley_ft", "Valleys"],
] as const;
type EdgeField = (typeof EDGES)[number][0];

/** What's typed: the size in squares or square feet, the pitch, each edge in feet and the waste. */
export interface ReportDraft {
  size: string;
  by: "squares" | "sqft";
  pitch: string;
  edges: Record<EdgeField, string>;
  /** Blank: what the edges suggest (10%, or 15% with hips or valleys). */
  waste: string;
}

const text = (n: number) => (n ? String(n) : "");

/** A saved report as the form shows it, or an empty form. */
export function reportDraft(saved: RoofReport | null): ReportDraft {
  return {
    size: saved ? text(saved.squares) : "",
    by: "squares",
    pitch: saved?.pitch ?? "",
    edges: Object.fromEntries(EDGES.map(([field]) => [field, saved ? text(saved[field]) : ""])) as Record<EdgeField, string>,
    waste: saved ? String(saved.waste_pct) : "",
  };
}

/** The form as a report: square feet become squares, an empty edge is none, and blank waste is what the edges suggest. */
export function draftReport(draft: ReportDraft): RoofReport {
  const size = Number(draft.size);
  const feet = Object.fromEntries(EDGES.map(([field]) => [field, Number(draft.edges[field] || 0)])) as Record<EdgeField, number>;
  return {
    squares: draft.by === "sqft" ? Math.round(size) / 100 : size,
    pitch: draft.pitch,
    ...feet,
    waste_pct: draft.waste.trim() ? Number(draft.waste) : suggestedWaste({ hip: feet.hip_ft, valley: feet.valley_ft }),
  };
}

const numeric = (value: string) => value.replace(/[^0-9.]/g, "");

/**
 * "Enter measurements from a report", or "Change the numbers" on a roof that was: quiet words (a
 * step heading's action, with `icon`), or a button beside the way to the map (`button`).
 */
export function RoofReportButton({ quote, takeoff, label, button, icon }: { quote: { id: string; property: { id: string } | null }; takeoff?: TakeoffRow | null; label: string; button?: boolean; icon?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className={button ? "btn" : icon ? `${styles.linkBtn} ${styles.stepAction}` : styles.linkBtn} onClick={() => setOpen(true)}>
        {(button || icon) && <Icon name={button ? "clipboard" : "edit"} size={button ? 16 : 14} />}
        {icon ? <span className={styles.actionWords}>{label}</span> : label}
      </button>
      {open && <RoofReportDialog quote={quote} takeoff={takeoff ?? null} onClose={() => setOpen(false)} />}
    </>
  );
}

function RoofReportDialog({ quote, takeoff, onClose }: { quote: { id: string; property: { id: string } | null }; takeoff: TakeoffRow | null; onClose: () => void }) {
  const refresh = useRefreshProject(quote.id);
  const [draft, setDraft] = useState(() => reportDraft(takeoff ? roofReportOf(takeoff) : null));
  const report = draftReport(draft);
  const save = useMutation({
    meta: { inline: true, success: takeoff ? "Roof measurements saved" : "Roof measurements entered" },
    mutationFn: async () => {
      const problem = roofReportProblem(report);
      if (problem) throw new Error(problem);
      // The placeholder shapes sit at the property, when it's on the map.
      const place = quote.property ? unwrap(await supabase().from("properties").select("lat, lng").eq("id", quote.property.id).maybeSingle()) : null;
      const at = place?.lat != null && place.lng != null ? { lat: Number(place.lat), lng: Number(place.lng) } : null;
      await api.post("/measurements", {
        ...(takeoff ? { id: takeoff.id } : { quote_id: quote.id }),
        title: REPORT_TITLE,
        property_id: quote.property?.id ?? undefined,
        provider: REPORT_PROVIDER,
        roof_pitch: reportPitch(report.pitch),
        waste_pct: report.waste_pct,
        geojson: roofReportCollection(report, at),
      });
    },
    onSuccess: () => {
      refresh();
      onClose();
    },
  });
  return (
    <Dialog open onClose={onClose} title="Roof measurements from a report" description="Type in what the report says (EagleView, Hover, the insurer's). The estimate prices from these numbers the way it does from a roof drawn on the map, and says they came from a report.">
      <form onSubmit={(e: FormEvent) => { e.preventDefault(); save.mutate(); }}>
        <div className="form-grid">
          <Field label={draft.by === "squares" ? "Roof size, in squares" : "Roof size, in square feet"} hint="The roof's surface, before waste." requiredMessage="Enter the roof's size.">
            <DecimalInput className="input" inputMode="decimal" value={draft.size} onChange={(e) => setDraft({ ...draft, size: numeric(e.target.value) })} required autoFocus />
          </Field>
          <Field label="The report gives it in">
            <Select className="select" value={draft.by} onChange={(e) => setDraft({ ...draft, by: e.target.value as ReportDraft["by"] })}>
              <option value="squares">Squares</option>
              <option value="sqft">Square feet</option>
            </Select>
          </Field>
          <Field label="Predominant pitch" hint="Like 6/12. Flat is 0/12." requiredMessage="Enter the pitch.">
            <input className="input" value={draft.pitch} maxLength={20} placeholder="6/12" onChange={(e) => setDraft({ ...draft, pitch: e.target.value })} required />
          </Field>
          <Field label="Waste (%)" optional hint="Left empty: 10%, or 15% with hips or valleys.">
            <DecimalInput className="input" inputMode="decimal" value={draft.waste} onChange={(e) => setDraft({ ...draft, waste: numeric(e.target.value) })} />
          </Field>
          {EDGES.map(([field, label]) => (
            <Field key={field} label={`${label} (ft)`} optional>
              <DecimalInput className="input" inputMode="decimal" value={draft.edges[field]} onChange={(e) => setDraft({ ...draft, edges: { ...draft.edges, [field]: numeric(e.target.value) } })} />
            </Field>
          ))}
        </div>
        <span className="muted small">The edges price drip edge, ridge cap, valley flashing and the like. Leave out any the report doesn't give.</span>
        <FormError error={save.error} />
        <div className="form-actions">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" icon="check" loading={save.isPending}>{takeoff ? "Save" : "Use these measurements"}</Button>
        </div>
      </form>
    </Dialog>
  );
}
