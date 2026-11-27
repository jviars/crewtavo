/**
 * What the next shape becomes: the takeoff item picked under Next shape in the dock (asphalt, a
 * lawn's bed, a tree), until a plain tool is pressed. Only shapes a person draws take it.
 */
import { itemFits, type PavingItem } from "@crewtavo/core/paving";
import type { Shape, Tool } from "./MeasureMap";

/**
 * The item still picked once a tool in the dock is pressed. A plain tool draws plain shapes. Cut out
 * keeps an item that isn't a cutout itself (an island cut out of the asphalt, then more asphalt), but
 * not a lawn's bed: pressing Cut out means a plain cutout (the house), and Bed is picked again from
 * Next shape.
 */
export function itemAfterTool(item: PavingItem | null, tool: Tool): PavingItem | null {
  return tool === "cutout" && item?.geometry !== "cutout" ? item : null;
}

/**
 * The shapes just finished that become the item picked, by id: the ones a person drew that it fits.
 * Shapes put on the map for them (Shape.byCode) never do; Find names its own (addFound).
 */
export function drawnAs(fresh: ReadonlyArray<Pick<Shape, "id" | "kind" | "byCode">>, item: PavingItem | null): Record<string, string> {
  if (!item) return {};
  return Object.fromEntries(fresh.filter((s) => !s.byCode && itemFits(item.id, s.kind)).map((s) => [s.id, item.id]));
}
