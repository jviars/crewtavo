/**
 * What's drawn, as one list beside the map. With takeoff items it's grouped the way the items are
 * (Pavement, Striping, Lawn items...), each item with its total and, when it has several shapes, those shapes
 * under it to open; the rest by kind: areas (a roof's sections), cut outs, a roof's edges, lines and
 * counts, each group with its total. The page draws each shape's own row (`row`).
 */
import { ROOF_EDGES, type RoofEdge, type Section } from "@crewtavo/core/geo";
import { itemFits, type PavingItem } from "@crewtavo/core/paving";
import { useState, type ReactNode } from "react";
import { Icon } from "@/components/ui/Icon";
import { formatNumber } from "@/lib/format";
import { formatItemTotal, ItemSwatch, LAWN_MENU, PAVING_MENU, type AreaUnit } from "./PavingItems";

export interface ListRow { id: string; kind: Section["kind"]; value: number }

const EDGE_PLURALS: Record<RoofEdge, string> = { eave: "Eaves", rake: "Rakes", ridge: "Ridges", hip: "Hips", valley: "Valleys" };

type Entry = { item: PavingItem; rows: ListRow[] } | { row: ListRow };
interface Group { title: string; total?: string; entries: Entry[] }

const area = (sqft: number, unit: AreaUnit) => (unit === "sqyd" ? `${formatNumber(sqft / 9, 1)} sq yd` : `${formatNumber(sqft)} sq ft`);

/**
 * The groups, in the list's order: the items' groups first, then whatever isn't an item, by kind. On a
 * lawn (`lawn`) the areas are the lawn.
 */
export function groupRows(rows: ListRow[], items: Record<string, string>, edges: Record<string, RoofEdge>, roofing: boolean, unit: AreaUnit, lawn = false): Group[] {
  const groups: Group[] = [];
  const asItem = (r: ListRow) => (itemFits(items[r.id], r.kind) ? items[r.id] : null);
  for (const { name, items: catalog } of [...LAWN_MENU, ...PAVING_MENU]) {
    const entries = catalog.flatMap((item) => {
      const mine = rows.filter((r) => asItem(r) === item.id);
      return mine.length ? [{ item, rows: mine }] : [];
    });
    if (entries.length) groups.push({ title: name, entries });
  }
  const rest = rows.filter((r) => !asItem(r));
  const sum = (list: ListRow[]) => list.reduce((t, r) => t + r.value, 0);
  const byKind = (title: string, list: ListRow[], total: (list: ListRow[]) => string) => {
    if (list.length) groups.push({ title, total: total(list), entries: list.map((row) => ({ row })) });
  };
  byKind(roofing ? "Roof sections" : lawn ? "Lawn" : "Areas", rest.filter((r) => r.kind === "Area"), (l) => area(sum(l), unit));
  byKind("Cut out", rest.filter((r) => r.kind === "Cutout"), (l) => `−${formatNumber(sum(l))} sq ft`);
  const lines = rest.filter((r) => r.kind === "Length");
  for (const edge of ROOF_EDGES) byKind(EDGE_PLURALS[edge], lines.filter((r) => edges[r.id] === edge), (l) => `${formatNumber(sum(l))} ft`);
  byKind("Lines", lines.filter((r) => !edges[r.id]), (l) => `${formatNumber(sum(l))} ft`);
  byKind("Counts", rest.filter((r) => r.kind === "Count"), (l) => formatNumber(l.length));
  return groups;
}

export function TakeoffList({
  rows, sections, items, edges, roofing, lawn = false, unit, selected, row,
}: {
  rows: ListRow[];
  sections: readonly Section[];
  items: Record<string, string>;
  edges: Record<string, RoofEdge>;
  roofing: boolean;
  lawn?: boolean;
  unit: AreaUnit;
  selected: string | null;
  /** A shape's own row; `nested` when it sits under its item. */
  row: (row: ListRow, nested: boolean) => ReactNode;
}) {
  // Items someone opened or closed; the rest start open for areas, or when their shape is picked.
  const [toggled, setToggled] = useState<Record<string, boolean>>({});
  return (
    <div className="measure-list">
      {groupRows(rows, items, edges, roofing, unit, lawn).map((group) => (
        <div key={group.title} className="measure-group" role="group" aria-label={group.title}>
          <div className="measure-group-head">
            <span>{group.title}</span>
            {group.total && <span className="num">{group.total}</span>}
          </div>
          {group.entries.map((entry) => {
            if ("row" in entry) return row(entry.row, false);
            const { item, rows: mine } = entry;
            // One shape: its own row says what it is.
            if (mine.length === 1) return row(mine[0], false);
            const open = toggled[item.id] ?? (item.geometry === "area" || item.geometry === "cutout" || mine.some((r) => r.id === selected));
            const noun = item.geometry === "area" || item.geometry === "cutout" ? "areas" : item.id === "stall_row" ? "rows" : item.geometry === "line" ? "lines" : "spots";
            return (
              <div key={item.id} className="measure-item-group">
                <div className="measure-item">
                  <button type="button" className="measure-item-btn" aria-expanded={open} onClick={() => setToggled((t) => ({ ...t, [item.id]: !open }))}>
                    <Icon name={open ? "chevronDown" : "chevronRight"} size={14} />
                    <ItemSwatch item={item} />
                    <span className="measure-item-name">{item.name}</span>
                    <span className="measure-item-meta">{mine.length} {noun}</span>
                  </button>
                  <span className="measure-item-total num">{formatItemTotal(sections, item, unit)}</span>
                </div>
                {open && mine.map((r) => row(r, true))}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}
