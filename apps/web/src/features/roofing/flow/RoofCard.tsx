/**
 * The measured roof, short: the picture, and beside it hairline rows of its squares and pitch, the
 * roof area, what to order with waste, the steep part, and each edge with its color from the map. A
 * roof typed in from a report (RoofReport.tsx) says so in place of the word "Measured" and has no
 * picture. The step's heading has the way back: "Measure again", or "Change the numbers".
 */
import { edgeLengths, ROOF_EDGES, type RoofEdge } from "@crewtavo/core/geo";
import { isReportRoof, ROOF_EDGE_COLORS, savedRoofingQuantities, STEEP_RISE } from "@crewtavo/core/roofing";
import type { CSSProperties } from "react";
import { Icon } from "@/components/ui/Icon";
import { formatNumber } from "@/lib/format";
import { sectionsOf, type TakeoffRow } from "../../paving/data";
import styles from "./flow.module.css";

const EDGE_NAMES: Record<RoofEdge, string> = { eave: "Eaves", rake: "Rakes", ridge: "Ridges", hip: "Hips", valley: "Valleys" };

/** "6/12", "6/12 and 10/12", or "flat". */
function pitchWords(takeoff: TakeoffRow): string | null {
  const pitches = [...new Set(sectionsOf(takeoff).filter((s) => s.kind === "Area").map((s) => s.pitch || takeoff.roof_pitch || "").filter(Boolean))];
  if (!pitches.length) return takeoff.roof_pitch ? (takeoff.roof_pitch === "0/12" ? "flat" : takeoff.roof_pitch) : null;
  const words = pitches.map((p) => (p === "0/12" ? "flat" : p));
  return words.length < 3 ? words.join(" and ") : `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`;
}

export function RoofCard({ takeoff, picture }: { takeoff: TakeoffRow; picture?: string }) {
  const fromReport = isReportRoof(takeoff);
  const sections = sectionsOf(takeoff);
  const edges = edgeLengths({ sections });
  const values = savedRoofingQuantities(sections, takeoff.roof_pitch, Number(takeoff.waste_pct));
  const pitched = takeoff.roofing_squares != null && values.roof_squares != null;
  const pitch = pitchWords(takeoff);
  const marked = ROOF_EDGES.filter((e) => edges[e] > 0);
  const steep = values.steep_squares ?? 0;

  return (
    <div className={styles.roof} data-picture={picture ? "" : undefined}>
      {picture && (
        <a href={picture} target="_blank" rel="noreferrer" className={styles.roofPicture} aria-label="Open the roof report picture">
          <img src={picture} alt={`The roof drawn on the aerial photo, ${takeoff.title}`} />
        </a>
      )}
      <div className={styles.roofInfo}>
        {pitched ? (
          <dl className={styles.quantities} aria-label="The measured roof">
            <div>
              <dt>{fromReport ? "From a report" : "Measured"}</dt>
              <dd>{formatNumber(values.roof_squares!, 1)} squares{pitch ? (pitch === "flat" ? ", flat" : ` at ${pitch}`) : ""}</dd>
            </div>
            <div>
              <dt>Roof area</dt>
              <dd>{formatNumber(values.roof_sqft ?? 0)} sq ft</dd>
            </div>
            <div>
              <dt>To order</dt>
              <dd>{formatNumber(values.squares ?? 0, 1)} squares <span className={styles.quiet}>with {formatNumber(Number(takeoff.waste_pct))}% waste</span></dd>
            </div>
            {steep > 0 && (
              <div>
                <dt>Steep ({STEEP_RISE}/12 and up)</dt>
                <dd>{formatNumber(steep, 1)} squares</dd>
              </div>
            )}
            {marked.map((e) => (
              <div key={e} style={{ "--edge": ROOF_EDGE_COLORS[e] } as CSSProperties}>
                <dt><i className={styles.edge} aria-hidden="true" />{EDGE_NAMES[e]}</dt>
                <dd>{formatNumber(edges[e])} ft</dd>
              </div>
            ))}
          </dl>
        ) : (
          <div className="callout callout-warning" role="note">
            <Icon name="alert" size={16} />
            <div className="grow">
              <div>Measured from above: {formatNumber(Number(takeoff.total_area_sqft))} sq ft</div>
              The roof has no pitch yet, so it can't be priced by the square. Set its pitch on the map (flat counts).
            </div>
          </div>
        )}
        {pitched && !marked.length && (
          <p className={styles.roofNote}>
            {fromReport
              ? "No edges entered. Add the report's eaves, rakes, ridges, hips and valleys to price drip edge, ridge cap and flashing."
              : "No edges marked. Mark the eaves, rakes, ridges, hips and valleys on the map to price drip edge, ridge cap and flashing."}
          </p>
        )}
        {!picture && <p className={styles.roofNote}>{fromReport ? "Entered from a report, so there's no picture of it on the map." : "No picture yet. Save the roof on the map to make the report."}</p>}
      </div>
    </div>
  );
}
