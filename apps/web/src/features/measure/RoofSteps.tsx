/**
 * Measuring a roof, step by step, in the Measure panel for roofers and roofing projects. On top, the
 * roofing squares with the edges' totals under them; then the steps: outline the roof (from the
 * building's outline, or drawn), set its pitch (each section's on its own row), mark its edges by
 * drawing them as eaves, rakes, ridges, hips or valleys (also from the tool dock), then the waste,
 * and save and go price it.
 */
import { ROOF_EDGES, type RoofEdge } from "@crewtavo/core/geo";
import { ROOF_EDGE_COLORS, suggestedWaste } from "@crewtavo/core/roofing";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { formatNumber } from "@/lib/format";

export const EDGE_HINTS: Record<RoofEdge, string> = {
  eave: "the bottom edges, where the gutters go",
  rake: "the sloped ends of a gable",
  ridge: "the level peaks at the top",
  hip: "the sloped corners where two slopes meet going up",
  valley: "where two slopes meet going down",
};
const EDGE_NAMES: Record<RoofEdge, string> = { eave: "Eaves", rake: "Rakes", ridge: "Ridges", hip: "Hips", valley: "Valleys" };

export interface RoofSection { id: string; label: string; pitch: string; squares: number | null }

export function RoofSteps({
  sections, planArea, roofArea, pitch, squares, waste, edges, activeEdge, outlining, ready, finish, onOutline, onDraw, onPitch, onSectionPitch, onEdge, onWaste,
}: {
  /** Each roof section drawn, at its pitch ("6/12", "Flat", or blank before it's set). */
  sections: RoofSection[];
  /** Square feet seen from above, and of roof once the pitch stretches them. */
  planArea: number;
  roofArea: number | null;
  /** "6/12", "Flat" or "Mixed pitches", or blank before it's set. */
  pitch: string;
  squares: number | null;
  waste: string;
  edges: Record<RoofEdge, number>;
  activeEdge: RoofEdge | null;
  outlining: boolean;
  ready: boolean;
  /** The last step's button: save, or on to the estimate. */
  finish: ReactNode;
  onOutline: () => void;
  onDraw: () => void;
  onPitch: () => void;
  onSectionPitch: (id: string) => void;
  onEdge: (edge: RoofEdge | null) => void;
  onWaste: (waste: string) => void;
}) {
  const areas = sections.length;
  const marked = ROOF_EDGES.some((e) => edges[e] > 0);
  const suggested = suggestedWaste(edges);
  // The step it's at shows its number in ink; done ones a green check; the rest stay quiet.
  const done = [areas > 0, Boolean(pitch), marked, false];
  const at = done.indexOf(false);
  const step = (i: number) => ({ "data-state": done[i] ? "done" : at === i ? "current" : undefined, "aria-current": at === i ? ("step" as const) : undefined });
  return (
    <>
      <section className="roof-hero" aria-label="Roof totals">
        <span className="measure-fig-label">Squares, with {waste || 0}% waste</span>
        <span className="roof-hero-value num">{squares !== null ? formatNumber(squares, 1) : "—"}</span>
        <span className="measure-fig-note num">
          {areas === 0 ? "Outline the roof to start." : roofArea !== null ? `${formatNumber(roofArea)} sq ft of roof · ${formatNumber(planArea)} sq ft from above${pitch ? ` · ${pitch.toLowerCase()}` : ""}` : `${formatNumber(planArea)} sq ft from above. Set the pitch for the squares.`}
        </span>
        {marked && (
          <div className="measure-sum roof-hero-edges">
            <Fig label="Drip edge" value={edges.eave + edges.rake} />
            <Fig label="Ridge cap" value={edges.ridge + edges.hip} />
            <Fig label="Valleys" value={edges.valley} />
          </div>
        )}
      </section>
      <ol className="roof-step-list" aria-label="Steps">
        <li {...step(0)}>
          <Dot n={1} done={done[0]} current={at === 0} />
          <div className="roof-step-body">
            <div className="roof-step-head">
              <strong>Outline the roof</strong>
              {areas > 0 && <button type="button" className="link-btn small" disabled={!ready || outlining} onClick={onOutline}>{outlining ? "Outlining…" : "Outline the building"}</button>}
            </div>
            <span className="roof-step-note">{areas > 0 ? `${areas} ${areas === 1 ? "section" : "sections"} · ${formatNumber(planArea)} sq ft from above. Drag the corners out to the drip edge.` : "Start from the building's outline, then drag its corners out to the eaves. Draw porches or dormers at another pitch as their own areas."}</span>
            {areas === 0 && (
              <div className="roof-step-actions">
                <Button size="sm" icon="home" loading={outlining} disabled={!ready || outlining} onClick={onOutline}>Outline the building</Button>
                <Button size="sm" variant="ghost" icon="area" disabled={!ready} onClick={onDraw}>Draw it</Button>
              </div>
            )}
          </div>
        </li>
        <li {...step(1)}>
          <Dot n={2} done={done[1]} current={at === 1} />
          <div className="roof-step-body">
            <div className="roof-step-head">
              <strong>Set the pitch</strong>
              {areas > 0 && <button type="button" className="link-btn small" onClick={onPitch}>{pitch ? "Change" : "Set the pitch"}</button>}
            </div>
            {areas > 1 && pitch ? (
              <div className="roof-sections">
                {sections.map((s) => (
                  <button key={s.id} type="button" className="roof-section" onClick={() => onSectionPitch(s.id)} aria-label={`Pitch for ${s.label}: ${s.pitch || "not set"}. Change it`}>
                    <span className="grow">{s.label}</span>
                    <strong className="num">{s.pitch || "Not set"}</strong>
                    <span className="roof-section-squares num">{s.squares !== null ? `${formatNumber(s.squares, 1)} sq` : ""}</span>
                  </button>
                ))}
              </div>
            ) : (
              <span className="roof-step-note">{pitch ? `${pitch}. A porch or dormer at another pitch can have its own: pick it on the map.` : "Pick it, read it free from lidar where the US has flown it, or measure it with a phone."}</span>
            )}
          </div>
        </li>
        <li {...step(2)}>
          <Dot n={3} done={done[2]} current={at === 2} />
          <div className="roof-step-body">
            <strong>Mark the edges</strong>
            <span className="roof-step-note">{activeEdge ? `Draw along ${EDGE_HINTS[activeEdge]}. Double-click, or press Finish, to end each one.` : "Pick one, then draw along each of those edges. Rakes, hips and valleys are stretched by the pitch."}</span>
            <div className="roof-edges" role="group" aria-label="Draw roof edges">
              {ROOF_EDGES.map((e) => (
                <button key={e} type="button" className="roof-edge" aria-pressed={activeEdge === e} disabled={!ready} onClick={() => onEdge(activeEdge === e ? null : e)} title={`Draw ${EDGE_NAMES[e].toLowerCase()}: ${EDGE_HINTS[e]}`}>
                  <span className="paving-swatch" data-geometry="line" style={{ "--swatch": ROOF_EDGE_COLORS[e] } as React.CSSProperties} aria-hidden="true" />
                  <span className="grow">{EDGE_NAMES[e]}{activeEdge === e ? " · drawing" : ""}</span>
                  <span className="num roof-edge-length">{edges[e] > 0 ? `${formatNumber(edges[e])} ft` : "None"}</span>
                </button>
              ))}
            </div>
          </div>
        </li>
        <li {...step(3)}>
          <Dot n={4} done={false} current={at === 3} />
          <div className="roof-step-body">
            <strong>Waste and save</strong>
            <div className="roof-waste">
              <label>
                <span>Waste</span>
                <input className="input input-sm" inputMode="decimal" value={waste} onChange={(e) => onWaste(e.target.value.replace(/[^0-9.]/g, ""))} aria-label="Waste %" />
                <span>%</span>
              </label>
              {Number(waste || 0) !== suggested && (
                <button type="button" className="link-btn small" onClick={() => onWaste(String(suggested))}>Use {suggested}%{suggested > 10 ? " (hips or valleys)" : ""}</button>
              )}
              <span className="roof-waste-finish">{finish}</span>
            </div>
          </div>
        </li>
      </ol>
    </>
  );
}

function Fig({ label, value }: { label: string; value: number }) {
  return (
    <div className="measure-fig">
      <span className="measure-fig-label">{label}</span>
      <span className="measure-fig-value measure-fig-small">{formatNumber(value)}<small>ft</small></span>
    </div>
  );
}

function Dot({ n, done, current }: { n: number; done: boolean; current: boolean }) {
  return <span className="roof-step-dot" data-done={done || undefined} data-current={(current && !done) || undefined} aria-hidden="true">{done ? <Icon name="check" size={12} bold /> : n}</span>;
}
