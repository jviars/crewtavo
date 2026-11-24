/**
 * Measuring a roof, step by step, in the Measure panel for roofers and roofing projects:
 * outline the roof (from the building's outline, or drawn), set its pitch, mark its edges by drawing
 * them as eaves, rakes, ridges, hips or valleys, then save and go price it.
 */
import { ROOF_EDGES, type RoofEdge } from "@crewtavo/core/geo";
import { ROOF_EDGE_COLORS, suggestedWaste } from "@crewtavo/core/roofing";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/Button";
import { DecimalInput } from "@/components/ui/DecimalInput";
import { Icon } from "@/components/ui/Icon";
import { Section } from "@/components/ui/Section";
import { formatNumber } from "@/lib/format";

export const EDGE_HINTS: Record<RoofEdge, string> = {
  eave: "the bottom edges, where the gutters go",
  rake: "the sloped ends of a gable",
  ridge: "the level peaks at the top",
  hip: "the sloped corners where two slopes meet going up",
  valley: "where two slopes meet going down",
};
const EDGE_NAMES: Record<RoofEdge, string> = { eave: "Eaves", rake: "Rakes", ridge: "Ridges", hip: "Hips", valley: "Valleys" };

export function RoofSteps({
  areas, pitch, squares, waste, edges, activeEdge, outlining, ready, finish, onOutline, onDraw, onPitch, onEdge, onWaste,
}: {
  /** Roof sections drawn. */
  areas: number;
  /** "6/12", "Flat" or "Mixed", or blank before it's set. */
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
  onEdge: (edge: RoofEdge | null) => void;
  onWaste: (waste: string) => void;
}) {
  const marked = ROOF_EDGES.some((e) => edges[e] > 0);
  const suggested = suggestedWaste(edges);
  // The step it's at shows its number in ink; done ones a green check; the rest stay quiet.
  const done = [areas > 0, Boolean(pitch), marked, false];
  const at = done.indexOf(false);
  return (
    <Section title="Roof" count={squares !== null ? `${formatNumber(squares, 1)} squares` : undefined} className="roof-steps">
      <ol className="roof-step-list">
        <li>
          <Dot n={1} done={done[0]} current={at === 0} />
          <div className="roof-step-body">
            <strong>Outline the roof</strong>
            <span className="roof-step-note">{areas > 0 ? `${areas} ${areas === 1 ? "section" : "sections"} drawn. Drag the corners out to the drip edge.` : "Start from the building's outline, then drag its corners out to the eaves. Draw porches or dormers at another pitch as their own areas."}</span>
            <div className="roof-step-actions">
              <Button size="sm" icon="home" loading={outlining} disabled={!ready || outlining} onClick={onOutline}>Outline the building</Button>
              <Button size="sm" variant="ghost" icon="area" disabled={!ready} onClick={onDraw}>Draw it</Button>
            </div>
          </div>
        </li>
        <li>
          <Dot n={2} done={done[1]} current={at === 1} />
          <div className="roof-step-body">
            <strong>Set the pitch</strong>
            <span className="roof-step-note">{pitch ? `${pitch}. Each section can have its own: tap its pitch in Shapes.` : "Pick it, read it free from lidar where the US has flown it, or measure it with a phone."}</span>
            <div className="roof-step-actions">
              <Button size="sm" icon="pitch" disabled={!areas} onClick={onPitch}>{pitch ? "Change the pitch" : "Set the pitch"}</Button>
            </div>
          </div>
        </li>
        <li>
          <Dot n={3} done={done[2]} current={at === 2} />
          <div className="roof-step-body">
            <strong>Mark the edges</strong>
            <span className="roof-step-note">{activeEdge ? `Draw along ${EDGE_HINTS[activeEdge]}. Double-click to finish each one.` : "For drip edge, ridge cap and flashing. Pick one, then draw along each of those edges."}</span>
            <div className="roof-edge-picks" role="group" aria-label="Draw roof edges">
              {ROOF_EDGES.map((e) => (
                <button key={e} type="button" className="roof-edge-pick" aria-pressed={activeEdge === e} disabled={!ready} onClick={() => onEdge(activeEdge === e ? null : e)} title={`Draw ${EDGE_NAMES[e].toLowerCase()}: ${EDGE_HINTS[e]}`}>
                  <span className="paving-swatch" data-geometry="line" style={{ "--swatch": ROOF_EDGE_COLORS[e] } as React.CSSProperties} aria-hidden="true" />
                  <span>{EDGE_NAMES[e]}</span>
                  {edges[e] > 0 && <span className="roof-edge-length num">{formatNumber(edges[e])} ft</span>}
                </button>
              ))}
            </div>
          </div>
        </li>
        <li>
          <Dot n={4} done={false} current={at === 3} />
          <div className="roof-step-body">
            <strong>Save and price it</strong>
            <label className="roof-waste">
              <span>Waste</span>
              <DecimalInput className="input input-sm" inputMode="decimal" value={waste} onChange={(e) => onWaste(e.target.value.replace(/[^0-9.]/g, ""))} aria-label="Waste %" />
              <span>%</span>
              {Number(waste || 0) !== suggested && (
                <button type="button" className="link-btn small" onClick={() => onWaste(String(suggested))}>Use {suggested}%{suggested > 10 ? " (hips or valleys)" : ""}</button>
              )}
            </label>
            <div className="roof-step-actions">{finish}</div>
          </div>
        </li>
      </ol>
    </Section>
  );
}

function Dot({ n, done, current }: { n: number; done: boolean; current: boolean }) {
  return <span className="roof-step-dot" data-done={done || undefined} data-current={(current && !done) || undefined} aria-hidden="true">{done ? <Icon name="check" size={12} bold /> : n}</span>;
}
