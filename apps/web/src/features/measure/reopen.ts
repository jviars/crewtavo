/**
 * A saved drawing put back on the map (MeasureMapHandle.load): which saved shape each shape on the
 * map is, so its name, item, pitch and slope go back on the right one.
 */
import type { Feature } from "@crewtavo/core/geo";

/** The shapes the map draws: areas, cutouts, lines and counts. Anything else saved is left out. */
export const drawable = (f: Feature) => Boolean(f.geometry) && ["Polygon", "LineString", "Point"].includes(f.geometry!.type);

/**
 * Each shape that went on the map, with the saved shape it is. `ids` is load's answer: one for every
 * saved shape, in order, null for one that isn't on the map. Paired by place, never by counting: a
 * shape the map turned away mustn't move every name after it onto the shape before.
 */
export function loadedShapes(saved: readonly Feature[], ids: ReadonlyArray<string | null>): Array<{ id: string; feature: Feature }> {
  return saved.flatMap((feature, i) => (ids[i] ? [{ id: ids[i], feature }] : []));
}
