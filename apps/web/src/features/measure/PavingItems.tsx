/**
 * Paving takeoff items beside the measuring map (like a takeoff app's Items panel): pick what you're
 * drawing (asphalt, a stall row, crack seal...) and new shapes are that item, in its color. Each
 * item shows its running total, and square feet can read as square yards. Find paving (fal.ai)
 * starts from here when the business has it installed. Items live in paving.ts (core).
 */
import type { Section } from "@crewtavo/core/geo";
import { itemTotal, PAVING_GROUPS, PAVING_ITEMS, pavingItem, type PavingItem } from "@crewtavo/core/paving";
import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { formatNumber } from "@/lib/format";

export type AreaUnit = "sqft" | "sqyd";

/** An item's total for the list and the takeoff sheet: "12,400 sq ft", "1,377.8 sq yd", "320 ft", "46". */
export function formatItemTotal(sections: readonly Section[], item: PavingItem, unit: AreaUnit = "sqft"): string {
  const { value } = itemTotal(sections, item.id);
  if (item.geometry === "area") return unit === "sqyd" ? `${formatNumber(value / 9, 1)} sq yd` : `${formatNumber(value)} sq ft`;
  if (item.geometry === "line" && item.id !== "stall_row") return `${formatNumber(value)} ft`;
  return item.id === "stall_row" ? `${formatNumber(value)} stalls` : formatNumber(value);
}

export function PavingItemsCard({
  sections,
  active,
  onPick,
  finder,
}: {
  sections: readonly Section[];
  /** The item new shapes become, or null for plain shapes. */
  active: string | null;
  onPick: (item: PavingItem | null) => void;
  /** The Find paving button, when the map is ready for it. */
  finder?: React.ReactNode;
}) {
  const [unit, setUnit] = useState<AreaUnit>("sqft");
  const [showAll, setShowAll] = useState(false);
  const used = new Set(sections.map((s) => s.item).filter(Boolean));
  const activeItem = pavingItem(active);
  return (
    <div className="card paving-items">
      <div className="card-head">
        <strong>Takeoff items</strong>
        <div className="segmented paving-unit" role="group" aria-label="Show areas in">
          <button type="button" aria-pressed={unit === "sqft"} onClick={() => setUnit("sqft")}>SF</button>
          <button type="button" aria-pressed={unit === "sqyd"} onClick={() => setUnit("sqyd")}>SY</button>
        </div>
      </div>
      {finder && <div className="card-row paving-find">{finder}</div>}
      <div className="paving-item-hint muted small" role="status" aria-live="polite">
        {activeItem ? (
          <>
            <strong style={{ color: "var(--ink)" }}>Drawing {activeItem.name.toLowerCase()}.</strong> {activeItem.hint}{" "}
            <button type="button" className="link-btn small" onClick={() => onPick(null)}>Stop</button>
          </>
        ) : (
          "Pick an item, then draw it on the map. Each item prices on its own line."
        )}
      </div>
      {PAVING_GROUPS.map((group) => {
        const items = PAVING_ITEMS.filter((i) => i.group === group && (showAll || used.has(i.id) || COMMON.has(i.id) || i.id === active));
        if (!items.length) return null;
        return (
          <div key={group} className="paving-group" role="group" aria-label={group}>
            <span className="paving-group-name">{group}</span>
            {items.map((item) => {
              const total = itemTotal(sections, item.id).value;
              return (
                <button
                  key={item.id}
                  type="button"
                  className="paving-item"
                  aria-pressed={active === item.id}
                  // Always picks it (and its tool), even when it's picked already: after Cut out,
                  // clicking Asphalt goes back to drawing asphalt. Stop, in the hint, unpicks it.
                  onClick={() => onPick(item)}
                  title={item.hint}
                >
                  <ItemSwatch item={item} />
                  <span className="grow">{item.name}</span>
                  <span className="paving-item-kind muted small">{item.geometry === "area" ? "Area" : item.geometry === "line" ? "Line" : "Count"}</span>
                  <strong className="num" data-zero={total ? undefined : true}>{total ? formatItemTotal(sections, item, unit) : "—"}</strong>
                </button>
              );
            })}
          </div>
        );
      })}
      <button type="button" className="link-btn small paving-more" onClick={() => setShowAll(!showAll)}>
        <Icon name={showAll ? "chevronUp" : "chevronDown"} size={14} /> {showAll ? "Fewer items" : "All items: curb, bollards, drains, red lines and more"}
      </button>
    </div>
  );
}

/** Shown before anything is drawn; the rest are under All items. */
const COMMON = new Set(["asphalt", "concrete", "sealcoat", "crack", "stall_row", "ada_stall", "stripe_white", "stripe_yellow", "crosswalk", "arrow", "symbol", "wheel_stop"]);

export function ItemSwatch({ item }: { item: PavingItem }) {
  return <span className="paving-swatch" data-geometry={item.geometry} style={{ "--swatch": item.color } as React.CSSProperties} aria-hidden="true" />;
}

/** What a shape is, in the shape list: the items its kind of shape can be. */
export function ItemSelect({ kind, value, label, onChange }: { kind: Section["kind"]; value: string | undefined; label: string; onChange: (item: string) => void }) {
  const geometry = kind === "Area" ? "area" : kind === "Length" ? "line" : kind === "Count" ? "count" : null;
  if (!geometry) return null;
  return (
    <select className="select measure-edge" value={value ?? ""} onChange={(e) => onChange(e.target.value)} aria-label={`Takeoff item for ${label}`}>
      <option value="">No takeoff item</option>
      {PAVING_GROUPS.map((group) => {
        const options = PAVING_ITEMS.filter((i) => i.group === group && i.geometry === geometry);
        return options.length ? (
          <optgroup key={group} label={group}>
            {options.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
          </optgroup>
        ) : null;
      })}
    </select>
  );
}

/** Find paving (fal.ai): a button that says what it needs when it can't run yet. */
export function FindPavingButton({ ready, busy, onClick }: { ready: boolean; busy: boolean; onClick: () => void }) {
  return (
    <Button size="sm" variant={ready ? "primary" : undefined} icon="sparkle" loading={busy} onClick={onClick} style={{ justifySelf: "start" }}>
      Find paving
    </Button>
  );
}
