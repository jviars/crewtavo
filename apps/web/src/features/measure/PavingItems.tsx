/**
 * Takeoff items on the measuring map, paving's and a lawn's: what the next shape is (the item button
 * in the tool dock) and what a shape is (its card and its menu), each from the same grouped menu, and
 * each item's total in the list beside the map. Square feet can read as square yards. Items live in
 * paving.ts and lawn.ts (core).
 */
import type { Section } from "@crewtavo/core/geo";
import { LAWN_ITEMS } from "@crewtavo/core/lawn";
import { itemTotal, PAVING_GROUPS, PAVING_ITEMS, type PavingItem } from "@crewtavo/core/paving";
import type { MenuEntry } from "@/components/ui/Menu";
import { formatNumber } from "@/lib/format";

export type AreaUnit = "sqft" | "sqyd";

/** An item's total for the list and the takeoff sheet: "12,400 sq ft", "1,377.8 sq yd", "320 ft", "46". */
export function formatItemTotal(sections: readonly Section[], item: PavingItem, unit: AreaUnit = "sqft"): string {
  const { value } = itemTotal(sections, item.id);
  if (item.geometry === "cutout") return `${formatNumber(value)} sq ft`;
  if (item.geometry === "area") return unit === "sqyd" ? `${formatNumber(value / 9, 1)} sq yd` : `${formatNumber(value)} sq ft`;
  if (item.geometry === "line" && item.id !== "stall_row") return `${formatNumber(value)} ft`;
  return item.id === "stall_row" ? `${formatNumber(value)} stalls` : formatNumber(value);
}

export function ItemSwatch({ item }: { item: PavingItem }) {
  return <span className="paving-swatch" data-geometry={item.geometry === "cutout" ? "area" : item.geometry} style={{ "--swatch": item.color } as React.CSSProperties} aria-hidden="true" />;
}

const KIND_WORD = { area: "Area", cutout: "Cut out", line: "Line", count: "Count" } as const;

/** Items under their heading, in the order the menus and the list show them. */
export interface ItemGroup { name: string; items: readonly PavingItem[] }
export const PAVING_MENU: ItemGroup[] = PAVING_GROUPS.map((name) => ({ name, items: PAVING_ITEMS.filter((i) => i.group === name) }));
export const LAWN_MENU: ItemGroup[] = [{ name: "Lawn items", items: LAWN_ITEMS }];

/**
 * The items as a menu under their groups' headings, the one picked checked. `geometry` keeps to the
 * items a shape of that kind can be (a shape's own menu); `search` narrows them by name. `none` is the
 * first entry, for no item at all.
 */
export function itemEntries({ current, geometry, search = "", none, onPick, groups = PAVING_MENU }: {
  current: string | null;
  geometry?: PavingItem["geometry"] | null;
  search?: string;
  none: string;
  onPick: (item: PavingItem | null) => void;
  /** Whose items: paving's (the default), a lawn's, or both. */
  groups?: readonly ItemGroup[];
}): MenuEntry[] {
  const words = search.trim().toLowerCase();
  return [
    ...(words ? [] : [{ label: none, checked: !current, onSelect: () => onPick(null) }]),
    ...groups.flatMap(({ name, items }): MenuEntry[] => {
      const options = items.filter((i) => (!geometry || i.geometry === geometry) && (!words || i.name.toLowerCase().includes(words)));
      return options.length
        ? [{ heading: name }, ...options.map((i) => ({ label: i.name, lead: <ItemSwatch item={i} />, end: geometry ? undefined : KIND_WORD[i.geometry], checked: current === i.id, onSelect: () => onPick(i) }))]
        : [];
    }),
  ];
}
