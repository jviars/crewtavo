/**
 * Measuring a roof, step by step, at the top of the Measure panel for roofers and roofing projects:
 * outline the roof (from the building's outline, or drawn), set its pitch, mark its edges by drawing
 * them as eaves, rakes, ridges, hips or valleys, then save and go price it.
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
  return (
    <section className="card roof-steps" aria-labelledby="roof-steps-title">
      <div className="card-head"><strong id="roof-steps-title">Roof</strong>{squares !== null && <span className="muted small grow" style={{ textAlign: "right" }}>{formatNumber(squares, 1)} squares</span>}</div>
      <ol className="roof-step-list">
        <li data-done={areas > 0 || undefined}>
          <Dot n={1} done={areas > 0} />
          <div className="stack-sm grow">
            <strong>Outline the roof</strong>
            <span className="muted small">{areas > 0 ? `${areas} ${areas === 1 ? "section" : "sections"} drawn. Drag the corners out to the drip edge.` : "Start from the building's outline, then drag its corners out to the eaves. Draw porches or dormers at another pitch as their own areas."}</span>
            <div className="row wrap" style={{ gap: 6 }}>
              <Button size="sm" variant={areas ? undefined : "primary"} icon="home" loading={outlining} disabled={!ready || outlining} onClick={onOutline}>Outline the building</Button>
              <Button size="sm" icon="area" disabled={!ready} onClick={onDraw}>Draw it</Button>
            </div>
          </div>
        </li>
        <li data-done={Boolean(pitch) || undefined}>
          <Dot n={2} done={Boolean(pitch)} />
          <div className="stack-sm grow">
            <strong>Set the pitch</strong>
            <span className="muted small">{pitch ? `${pitch}. Each section can have its own: tap its pitch in Shapes.` : "Pick it, read it free from lidar where the US has flown it, or measure it with a phone."}</span>
            <Button size="sm" variant={areas && !pitch ? "primary" : undefined} icon="pitch" disabled={!areas} onClick={onPitch} style={{ justifySelf: "start" }}>{pitch ? "Change the pitch" : "Set the pitch"}</Button>
          </div>
        </li>
        <li data-done={marked || undefined}>
          <Dot n={3} done={marked} />
          <div className="stack-sm grow">
            <strong>Mark the edges <span className="muted small" style={{ fontWeight: 500 }}>(for drip edge, ridge cap and flashing)</span></strong>
            <span className="muted small">{activeEdge ? `Draw along ${EDGE_HINTS[activeEdge]}. Double-click to finish each one.` : "Pick one, then draw along each of those edges."}</span>
            <div className="roof-edge-picks" role="group" aria-label="Draw roof edges">
              {ROOF_EDGES.map((e) => (
                <button key={e} type="button" className="roof-edge-pick" aria-pressed={activeEdge === e} disabled={!ready} onClick={() => onEdge(activeEdge === e ? null : e)} title={`Draw ${EDGE_NAMES[e].toLowerCase()}: ${EDGE_HINTS[e]}`}>
                  <span className="paving-swatch" data-geometry="line" style={{ "--swatch": ROOF_EDGE_COLORS[e] } as React.CSSProperties} aria-hidden="true" />
                  <span>{EDGE_NAMES[e]}</span>
                  {edges[e] > 0 && <span className="muted small num">{formatNumber(edges[e])} ft</span>}
                </button>
              ))}
            </div>
          </div>
        </li>
        <li>
          <Dot n={4} done={false} />
          <div className="stack-sm grow">
            <strong>Save and price it</strong>
            <label className="row roof-waste" style={{ gap: 8 }}>
              <span className="muted small">Waste</span>
              <input className="input input-sm" inputMode="decimal" value={waste} onChange={(e) => onWaste(e.target.value.replace(/[^0-9.]/g, ""))} aria-label="Waste %" style={{ width: 64 }} />
              <span className="muted small">%</span>
              {Number(waste || 0) !== suggested && (
                <button type="button" className="link-btn small" onClick={() => onWaste(String(suggested))}>Use {suggested}%{suggested > 10 ? " (hips or valleys)" : ""}</button>
              )}
            </label>
            {finish}
          </div>
        </li>
      </ol>
    </section>
  );
}

function Dot({ n, done }: { n: number; done: boolean }) {
  return <span className="paving-progress-dot" data-done={done || undefined} aria-hidden="true">{done ? <Icon name="check" size={13} strokeWidth={3} /> : n}</span>;
}
