/**
 * What a menu holds and the decisions about it that don't need a page (Menu.tsx draws it): which
 * entries show, the level a phone's sheet is on, where a flyout goes, which item a key picks, and
 * when a dragged sheet is let go of.
 */
import type { ReactNode } from "react";
import type { IconName } from "./Icon";

/** Something to do. */
export type MenuAction = {
  label: string;
  icon?: IconName;
  /** In place of the icon: an avatar, a swatch. */
  lead?: ReactNode;
  /** A second, quieter line under the label, for a choice that needs explaining. */
  description?: string;
  /** A key hint on the right ("E", "⌘K"). A single character also picks the item while the menu is open. */
  kbd?: string;
  /** Shown in kbd's place when the hint to show differs from the key that picks it: "N C", which works from anywhere. */
  kbdLabel?: string;
  /** Quiet words on the right: a count, a role, the current setting. */
  end?: string;
  /**
   * A check. On its own the item is one choice of several (a radio, menuitemradio): its check sits on
   * the right and picking it closes the menu. With `checkbox` it turns something on or off
   * (menuitemcheckbox): a box on the left, and the menu stays open so several can be picked.
   */
  checked?: boolean;
  checkbox?: boolean;
  onSelect: () => void;
  danger?: boolean;
  disabled?: boolean;
  hidden?: boolean;
  /** Shown on hover, e.g. why it's turned off. */
  title?: string;
};

/** A sub menu: a flyout beside its item on a desktop, the sheet's next level on a phone. */
export type MenuSub = {
  label: string;
  icon?: IconName;
  lead?: ReactNode;
  /** Quiet words before the chevron, such as the current choice ("Dark", "Nobody yet"). */
  end?: string;
  /** A key hint, as on an action; its key opens the sub menu. */
  kbd?: string;
  items: MenuEntry[];
  disabled?: boolean;
  hidden?: boolean;
};

export type MenuEntry = MenuAction | MenuSub | { separator: true; hidden?: boolean } | { heading: string; hidden?: boolean };

export const isAction = (entry: MenuEntry): entry is MenuAction => "onSelect" in entry;
export const isSub = (entry: MenuEntry): entry is MenuSub => "items" in entry;

/** The ARIA role an action's button takes. */
export const itemRole = (entry: MenuAction) => (entry.checked === undefined ? "menuitem" : entry.checkbox ? "menuitemcheckbox" : "menuitemradio");

/**
 * The entries that show: none hidden, a sub menu only when something in it can be picked, and no
 * separator at either end or twice in a row (where the entries between two were hidden). A heading
 * with nothing under it before the next separator goes too.
 */
export function visibleEntries(items: MenuEntry[]): MenuEntry[] {
  const shown: MenuEntry[] = [];
  for (const entry of items) {
    if (entry.hidden) continue;
    if (isSub(entry)) {
      const inner = visibleEntries(entry.items);
      if (inner.some((e) => isAction(e) || isSub(e))) shown.push({ ...entry, items: inner });
      continue;
    }
    shown.push(entry);
  }
  const tidy: MenuEntry[] = [];
  for (const [i, entry] of shown.entries()) {
    const previous = tidy[tidy.length - 1];
    if ("separator" in entry && (!previous || "separator" in previous)) continue;
    if ("heading" in entry) {
      const next = shown[i + 1];
      if (!next || "separator" in next || "heading" in next) continue;
    }
    tidy.push(entry);
  }
  while (tidy.length && "separator" in tidy[tidy.length - 1]!) tidy.pop();
  return tidy;
}

/** True when there's anything in the menu to pick. */
export const hasActions = (items: MenuEntry[]) => visibleEntries(items).some((e) => isAction(e) || isSub(e));

/**
 * The level a phone's sheet shows: the top, or the sub menu reached by `path` (each number an index
 * into the level above's visible entries). A path that no longer leads anywhere (the entries changed
 * under it) goes back as far as it still does.
 */
export function sheetLevel(items: MenuEntry[], path: number[]): { entries: MenuEntry[]; title?: string; path: number[] } {
  let entries = visibleEntries(items);
  let title: string | undefined;
  const reached: number[] = [];
  for (const index of path) {
    const entry = entries[index];
    if (!entry || !isSub(entry)) break;
    entries = entry.items;
    title = entry.label;
    reached.push(index);
  }
  return { entries, title, path: reached };
}

/** The next item for an arrow key, wrapping at the ends; Home and End go to the first and last. */
export function nextIndex(count: number, current: number, key: "ArrowDown" | "ArrowUp" | "Home" | "End"): number {
  if (count <= 0) return -1;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  if (current < 0) return key === "ArrowDown" ? 0 : count - 1;
  return (current + (key === "ArrowDown" ? 1 : -1) + count) % count;
}

/** The enabled action or sub menu whose single-character key hint is `key`, as an index into `entries`, or -1. */
export function shortcutIndex(entries: MenuEntry[], key: string): number {
  if (key.length !== 1 || key === " ") return -1;
  const wanted = key.toLowerCase();
  return entries.findIndex((e) => (isAction(e) || isSub(e)) && !e.disabled && e.kbd?.length === 1 && e.kbd.toLowerCase() === wanted);
}

type Box = { left: number; top: number; right: number; bottom: number; width: number; height: number };

/**
 * Where a flyout goes: beside its parent menu, its first item level with the item that opened it, on
 * the right unless there's no room there (then the left, or whichever side has more), and inside the
 * window top to bottom. `gap` is the space between the two menus, `inset` how far its first item sits
 * from its top edge (padding and border), `margin` the space kept from the window's edges.
 */
export function flyoutPlacement(
  parent: Box,
  item: Box,
  size: { width: number; height: number },
  viewport: { width: number; height: number },
  { gap = 4, inset = 5, margin = 8 } = {},
): { left: number; top: number; side: "right" | "left" } {
  const roomRight = viewport.width - margin - (parent.right + gap);
  const roomLeft = parent.left - gap - margin;
  const side = roomRight >= size.width || roomRight >= roomLeft ? "right" : "left";
  const left = side === "right" ? Math.min(parent.right + gap, viewport.width - margin - size.width) : Math.max(margin, parent.left - gap - size.width);
  const top = Math.max(margin, Math.min(item.top - inset, viewport.height - margin - size.height));
  return { left: Math.max(margin, left), top, side };
}

/** A sheet dragged down this far (px), or flicked down this fast (px/ms) past a short way, is put away. */
export const SHEET_DISMISS = { distance: 96, flick: 0.6, flickFrom: 24 };
export const sheetDismissed = (dy: number, velocity: number) => dy >= SHEET_DISMISS.distance || (dy >= SHEET_DISMISS.flickFrom && velocity >= SHEET_DISMISS.flick);

/**
 * When a menu is a bottom sheet: a phone's width, where the shell is the phone's too (the tab bar,
 * Help and Notifications as sheets). A tablet or touch laptop wider than that has the desktop shell,
 * so its menus drop down like the desktop's rather than sheet across a wide window.
 */
export const SHEET_QUERY = "(max-width: 900px)";
