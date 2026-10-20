/**
 * "From lidar": the pitch of each drawn roof section from free USGS lidar (lidar.ts does the work).
 * It starts as soon as it opens, says which survey and year it used, and offers each section's pitch
 * on its own or all of them at once.
 */
import type { RoofOutline } from "@crewtavo/core/roofPlanes";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Icon } from "@/components/ui/Icon";
import { formatNumber } from "@/lib/format";
import { LIDAR_CREDIT, LidarError, roofFromLidar, type LidarResult, type LidarStep } from "./lidar";
import { pitchLabel, RoofGlyph, riseOf } from "./RoofPitch";

export interface NamedRoof extends RoofOutline {
  name: string;
}

const COMPASS = ["north", "north-east", "east", "south-east", "south", "south-west", "west", "north-west"];
const facingWord = (degrees: number) => COMPASS[Math.round(degrees / 45) % 8];
/** Under this many roof points per square meter, small parts of the roof get only a handful. */
const SPARSE = 2;

export function LidarPitch({
  roofs, onUse, onUseSection, onClose,
}: {
  roofs: NamedRoof[];
  /** The whole roof's pitch (the biggest section's). */
  onUse: (pitch: string) => void;
  /** One section's own pitch; with more than one section drawn. */
  onUseSection?: (id: string, pitch: string) => void;
  onClose: () => void;
}) {
  const [step, setStep] = useState<{ step: LidarStep; detail?: string }>({ step: "survey" });
  const [result, setResult] = useState<LidarResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const key = JSON.stringify(roofs.map((r) => r.ring));

  useEffect(() => {
    const abort = new AbortController();
    setResult(null);
    setError(null);
    roofFromLidar(roofs, (s, detail) => !abort.signal.aborted && setStep({ step: s, detail }), abort.signal)
      .then((r) => !abort.signal.aborted && setResult(r))
      .catch((e) => {
        if (abort.signal.aborted) return;
        if (!(e instanceof LidarError)) console.error("Lidar pitch failed", e);
        setError(e instanceof LidarError ? e.message : "Couldn't read the lidar here. Check your connection and try again.");
      });
    return () => abort.abort();
    // The outlines, not the array they came in, decide when to look again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const reading = result?.reading;
  const name = (id: string) => roofs.find((r) => r.id === id)?.name ?? "Roof";
  // The biggest section with a pitch sets the roof's; others that differ get their own.
  const found = (reading?.sections ?? []).filter((s) => s.pitch);
  const main = [...found].sort((a, b) => b.points - a.points)[0];
  const several = roofs.length > 1 && Boolean(onUseSection);
  const useAll = () => {
    if (!main?.pitch) return;
    onUse(main.pitch);
    if (several) for (const s of found) onUseSection!(s.id, s.pitch === main.pitch ? "" : s.pitch!);
    onClose();
  };

  return (
    <Dialog open onClose={onClose} title="Roof pitch from lidar" description="USGS has flown lidar over most of the US. This reads your roof's slope from it: free, and nothing to set up." size="md">
      <div className="dialog-body stack">
        {error ? (
          <div className="callout"><Icon name="info" size={18} /><span className="grow">{error}</span></div>
        ) : !reading ? (
          <div className="lidar-progress" role="status" aria-live="polite">
            <span className="spinner" style={{ width: 18, height: 18 }} />
            <span>
              {step.step === "survey" ? "Finding a lidar survey for this spot…" : step.step === "download" ? `Downloading the lidar over your roof (flown ${step.detail}, a few MB)…` : "Finding the roof's planes…"}
            </span>
          </div>
        ) : (
          <>
            <div className="lidar-sections">
              {reading.sections.map((s) => (
                <div key={s.id} className="lidar-section">
                  {s.pitch ? <RoofGlyph rise={riseOf(s.pitch) ?? 0} size={36} /> : <Icon name="alert" size={18} />}
                  <div className="grow stack-sm" style={{ gap: 2 }}>
                    <strong>{roofs.length > 1 ? name(s.id) : "Your roof"}{s.pitch ? `: ${pitchLabel(s.pitch)}` : ""}</strong>
                    <span className="muted small">
                      {s.pitch
                        ? `Measured ${formatNumber(s.rise!, 1)}/12 from ${formatNumber(s.points)} points.`
                        : "Too little of it showed up in the lidar (trees, or built since the survey)."}
                    </span>
                    {s.alsoPitch && <span className="small">Part of it reads {pitchLabel(s.alsoPitch)}, maybe a porch or dormer. Draw that part as its own area to give it its own pitch.</span>}
                  </div>
                  {several && s.pitch && <Button size="sm" onClick={() => onUseSection!(s.id, s.pitch!)}>Use</Button>}
                </div>
              ))}
            </div>
            {reading.density < SPARSE && <div className="callout"><Icon name="info" size={18} /><span className="grow">The lidar is thin here ({formatNumber(reading.density, 1)} points per square meter), so check the pitch on site before you order.</span></div>}
            {reading.planes.length > 0 && (
              <details className="small">
                <summary style={{ cursor: "pointer", fontWeight: 600 }}>What it found ({reading.planes.length} roof {reading.planes.length === 1 ? "plane" : "planes"})</summary>
                <ul className="lidar-planes">
                  {reading.planes.map((p, i) => (
                    <li key={i}>{formatNumber(p.rise, 1)}/12 facing {facingWord(p.facing)}, about {formatNumber(Math.round(p.planSqft / 10) * 10)} sq ft from above</li>
                  ))}
                </ul>
              </details>
            )}
            <span className="muted small">
              From USGS lidar flown in {result!.survey.year ?? "an unknown year"} ({result!.survey.name.replace(/_/g, " ")}). If the roof was replaced or added onto since, check it on site. {LIDAR_CREDIT}.
            </span>
          </>
        )}
        <div className="form-actions">
          <Button variant="ghost" onClick={onClose}>{reading || error ? "Close" : "Cancel"}</Button>
          {main?.pitch && <Button variant="primary" onClick={useAll}>{several && found.some((s) => s.pitch !== main.pitch) ? "Use these pitches" : `Use ${pitchLabel(main.pitch)}`}</Button>}
        </div>
      </div>
    </Dialog>
  );
}
