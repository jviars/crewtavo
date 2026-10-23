/**
 * The measured roof, short: its squares and pitch, its edges with their colors from the map, the roof
 * area and what to order with waste, and the picture. "Measure again" goes back to the map.
 */
import { edgeLengths, ROOF_EDGES, type RoofEdge } from "@crewtavo/core/geo";
import { ROOF_EDGE_COLORS, savedRoofingQuantities, STEEP_RISE } from "@crewtavo/core/roofing";
import type { CSSProperties } from "react";
import { Link } from "react-router-dom";
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

export function RoofCard({ takeoff, picture, editLink }: { takeoff: TakeoffRow; picture?: string; editLink: string | null }) {
  const sections = sectionsOf(takeoff);
  const edges = edgeLengths({ sections });
  const values = savedRoofingQuantities(sections, takeoff.roof_pitch, Number(takeoff.waste_pct));
  const pitched = takeoff.roofing_squares != null && values.roof_squares != null;
  const pitch = pitchWords(takeoff);
  const marked = ROOF_EDGES.filter((e) => edges[e] > 0);
  const steep = values.steep_squares ?? 0;

  return (
    <div className={styles.roof}>
      {picture ? (
        <a href={picture} target="_blank" rel="noreferrer" className={styles.roofPicture} aria-label="Open the roof report picture">
          <img src={picture} alt={`The roof drawn on the aerial photo, ${takeoff.title}`} />
        </a>
      ) : (
        <div className={`${styles.roofPicture} ${styles.roofEmpty}`}>No picture yet. Save the roof on the map to make the report.</div>
      )}
      <div className={styles.roofInfo}>
        <div className={styles.roofHead}>
          <h3 className={styles.roofTitle}>
            {pitched ? (
              <>
                <span className={styles.roofCheck} aria-hidden="true"><Icon name="check" size={13} strokeWidth={3} /></span>
                Measured: {formatNumber(values.roof_squares!, 1)} squares{pitch ? (pitch === "flat" ? ", flat" : ` at ${pitch}`) : ""}
              </>
            ) : (
              <>
                <span className={styles.roofWarn} aria-hidden="true"><Icon name="alert" size={13} strokeWidth={2.5} /></span>
                Measured from above: {formatNumber(Number(takeoff.total_area_sqft))} sq ft
              </>
            )}
          </h3>
          {editLink && <Link to={editLink} className="small strong">Measure again</Link>}
        </div>
        {marked.length > 0 && (
          <ul className={styles.edges} aria-label="Roof edges">
            {marked.map((e) => (
              <li key={e} className={styles.edge} style={{ "--edge": ROOF_EDGE_COLORS[e] } as CSSProperties}>
                <i aria-hidden="true" />
                {EDGE_NAMES[e]} {formatNumber(edges[e])} ft
              </li>
            ))}
          </ul>
        )}
        {pitched ? (
          <p className={styles.roofNote}>
            {formatNumber(values.roof_sqft ?? 0)} sq ft of roof · {formatNumber(values.squares ?? 0, 1)} squares to order with {formatNumber(Number(takeoff.waste_pct))}% waste
            {steep > 0 ? ` · ${formatNumber(steep, 1)} squares steep (${STEEP_RISE}/12 and up)` : ""}
          </p>
        ) : (
          <p className={styles.roofNote}>The roof has no pitch yet, so it can't be priced by the square. Set its pitch on the map (flat counts).</p>
        )}
        {pitched && !marked.length && <p className={styles.roofNote}>No edges marked. Mark the eaves, rakes, ridges, hips and valleys on the map to price drip edge, ridge cap and flashing.</p>}
      </div>
    </div>
  );
}
