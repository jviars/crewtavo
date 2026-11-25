/**
 * Picking rows on a list page to act on them at once: a box on each row, one in the heading for
 * every row on the page, and a bar above the list with how many are picked and what can be done.
 * The logic, and writing them in chunks, is lib/bulk.ts.
 */
import type { QueryKey } from "@tanstack/react-query";
import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { inChunks, mergeResults, pageState, pickedOnPage, reportBulk, toggleAll, toggleOne, toggleRange, type BulkResult, type BulkWords } from "@/lib/bulk";
import { queryClient } from "@/lib/queryClient";
import type { ToastTone } from "@/lib/toast";
import { undoable } from "@/lib/undo";
import { Button, cx } from "./Button";
import { t } from "@/lib/i18n";

/**
 * What's picked among `pageIds`. A new `reset` (another filter, a search) starts with nothing picked.
 * A phone picks in a mode of its own, as its mail app does: the boxes show once Select is pressed
 * (`start`) or something is picked (`active`), and Cancel, Escape or clearing the picks ends it. A
 * desktop's boxes show under the pointer or the keyboard, and on every row once something is picked.
 */
export function useSelection(pageIds: readonly string[], reset: string) {
  const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set());
  const [picking, setPicking] = useState(false);
  const [shown, setShown] = useState(reset);
  // The row clicked last, where a shift-click's range starts.
  const last = useRef<string | null>(null);
  if (shown !== reset) {
    setShown(reset);
    setPicked(new Set());
    setPicking(false);
  }
  const ids = pickedOnPage(picked, pageIds);
  return {
    /** Picked and on the page, in its order. */
    ids,
    state: pageState(picked, pageIds),
    /** Picking (a phone's Select mode), or something is picked. */
    active: picking || ids.length > 0,
    has: (id: string) => picked.has(id),
    /** One row, or with `range` (shift held) every row from the one clicked last to this one. */
    toggle: (id: string, range = false) => {
      const from = last.current;
      last.current = id;
      setPicked((p) => (range ? toggleRange(p, pageIds, from, id) : toggleOne(p, id)));
    },
    toggleAll: () => setPicked((p) => toggleAll(p, pageIds)),
    /** A phone's Select: the boxes show. */
    start: () => setPicking(true),
    /** Nothing picked, and a phone's boxes put away (Cancel, Escape, or done with an action on them). */
    clear: () => {
      setPicked(new Set());
      setPicking(false);
    },
  };
}
export type Selection = ReturnType<typeof useSelection>;

function SelectAllBox({ selection, label }: { selection: Selection; label: string }) {
  const box = useRef<HTMLInputElement>(null);
  // A dash when only some are picked: there's no attribute for it, only the property.
  useEffect(() => {
    if (box.current) box.current.indeterminate = selection.state === "some";
  });
  return <input ref={box} type="checkbox" aria-label={label} checked={selection.state === "all"} onChange={selection.toggleAll} />;
}

/** The heading cell: picks every row on this page (a dash when only some are). */
export function SelectAllCell({ selection, label }: { selection: Selection; label: string }) {
  return <th className="select-cell"><label><SelectAllBox selection={selection} label={label} /></label></th>;
}

/** Whether a box was clicked with shift held: a checkbox's change comes from its click. */
export const shiftHeld = (e: { nativeEvent: Event }) => e.nativeEvent instanceof MouseEvent && e.nativeEvent.shiftKey;

/** A row's box. A click on it, or near it, picks the row rather than opening it; shift picks a range. */
export function SelectCell({ selection, id, label }: { selection: Selection; id: string; label: string }) {
  return (
    <td className="select-cell" data-pick={id} onClick={(e) => e.stopPropagation()}>
      <label><input type="checkbox" aria-label={label} checked={selection.has(id)} onChange={(e) => selection.toggle(id, shiftHeld(e))} /></label>
    </td>
  );
}

/** How long a finger rests on a row before it's picked, and how far it can wander meanwhile. */
const HOLD_MS = 500;
const HOLD_SLOP = 10;
/** How long after a hold picked a row the tap that ended it is ignored, rather than opening the row. */
const HOLD_TAP = 800;

/**
 * On a touch screen, holding a finger on a row picks it (or puts it back), as a phone's own lists do,
 * with a short buzz where the phone can; a tap still opens it, and a scroll or a drag is left alone.
 * Spread on a table's <tbody> or an InboxRow: the row is the one with a box ([data-pick]). Only touches count, and
 * nothing here stops or cancels an ordinary click, so a mouse, a keyboard and the boxes and links in
 * the rows work as before. The tap that ends a hold, and the phone's own long-press menu, are kept
 * from doing anything else.
 */
export function useHoldToPick(selection: Selection | undefined) {
  const hold = useRef<{ x: number; y: number; timer: number } | null>(null);
  const pickedAt = useRef(0);
  const cancel = () => {
    if (hold.current) window.clearTimeout(hold.current.timer);
    hold.current = null;
  };
  useEffect(() => cancel, []);
  const justPicked = () => Date.now() - pickedAt.current < HOLD_TAP;
  if (!selection) return {};
  return {
    // For components.css: a held row's words aren't selected, nor the phone's copy menu shown.
    "data-hold": "",
    onPointerDown(e: ReactPointerEvent) {
      cancel();
      // A new touch: whatever a hold before it was keeping from opening has passed.
      pickedAt.current = 0;
      if (e.pointerType !== "touch" || !e.isPrimary) return;
      const id = (e.target as Element).closest("tr, .il-row")?.querySelector<HTMLElement>("[data-pick]")?.dataset.pick;
      if (!id) return;
      const timer = window.setTimeout(() => {
        hold.current = null;
        selection.toggle(id);
        pickedAt.current = Date.now();
        navigator.vibrate?.(10);
      }, HOLD_MS);
      hold.current = { x: e.clientX, y: e.clientY, timer };
    },
    onPointerMove(e: ReactPointerEvent) {
      const h = hold.current;
      if (h && Math.hypot(e.clientX - h.x, e.clientY - h.y) > HOLD_SLOP) cancel();
    },
    onPointerUp: cancel,
    onPointerCancel: cancel,
    onContextMenu(e: ReactMouseEvent) {
      if (hold.current || justPicked()) e.preventDefault();
    },
    onClickCapture(e: ReactMouseEvent) {
      if (!justPicked()) return;
      pickedAt.current = 0;
      e.preventDefault();
      e.stopPropagation();
    },
  };
}

/**
 * Above the list, in view as it scrolls: how many are picked, the actions, and Clear. On a phone,
 * where the table's headings are hidden, it's where Select all is too, so it shows before any are.
 * Over an InboxList (which has no heading row for a Select all box) pass `always`, so a desktop
 * has it too: out of sight until something is picked or the keyboard reaches its box (components.css).
 *
 * On a phone (components.css) the rows keep their room until someone means to pick: the bar is just
 * a quiet Select on the right, which turns the boxes on and becomes Cancel (one button, so the focus
 * stays on it). Picking, it's one line: the count, the actions (scrolling sideways if they must) and
 * Cancel. Escape cancels too.
 */
export function SelectionBar({ selection, noun, children, always }: { selection: Selection; noun: string; children: ReactNode; always?: boolean }) {
  const count = selection.ids.length;
  const { active, clear } = selection;
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      // A dialog or a menu open over the list takes its own Escape.
      if (document.querySelector("dialog[open]") || popoverOpen()) return;
      clear();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [active, clear]);
  return (
    <>
      <span className="sr-only" role="status">{count ? t("{count} selected", { count }) : ""}</span>
      <div className={cx("select-bar", !count && !always && "mobile-only")} data-picked={count || undefined} data-mode={active ? "on" : "off"}>
        <label className="select-bar-all">
          <SelectAllBox selection={selection} label={t("Select all {noun} on this page", { noun })} />
          <span aria-hidden="true">{count ? t("{count} selected", { count }) : t("Select all")}</span>
        </label>
        {count > 0 && (
          <>
            <div className="select-bar-actions">{children}</div>
            <Button size="sm" variant="ghost" className="select-bar-clear" onClick={selection.clear}>{t("Clear")}</Button>
          </>
        )}
        <button type="button" className="select-bar-mode" onClick={active ? selection.clear : selection.start}>{active ? t("Cancel") : t("Select")}</button>
      </div>
    </>
  );
}

/** Whether a menu or a panel (a popover) is open. */
function popoverOpen(): boolean {
  try {
    return Boolean(document.querySelector(".menu:popover-open, .panel:popover-open"));
  } catch {
    return false;
  }
}

/**
 * Archiving picked rows, once the count is confirmed: they leave the list at once with Undo
 * (lib/undo.ts) and are archived when the toast goes, `write` a chunk at a time. Then any that
 * couldn't be (and `skipped`, left out before) are said with why, and the list is fetched again.
 */
export function archiveWithUndo<T>(o: {
  key: QueryKey;
  ids: string[];
  title: string;
  tone?: ToastTone;
  /** The list without the archived rows, or with them shown as archived where its filter keeps them. */
  hide: (data: T, ids: ReadonlySet<string>) => T;
  write: (chunk: string[]) => Promise<readonly string[]>;
  words: BulkWords;
  skipped?: BulkResult;
  refresh: () => Promise<unknown>;
}) {
  const before = queryClient.getQueryData<T>(o.key);
  const picked = new Set(o.ids);
  undoable({
    title: o.title,
    tone: o.tone,
    hide: () => {
      void queryClient.cancelQueries({ queryKey: o.key });
      queryClient.setQueryData<T>(o.key, (data) => (data === undefined ? data : o.hide(data, picked)));
    },
    restore: () => queryClient.setQueryData<T>(o.key, before),
    commit: async () => {
      const result = await inChunks(o.ids, o.write);
      reportBulk(o.skipped ? mergeResults(result, o.skipped) : result, o.words, { said: true, tone: o.tone });
      await o.refresh();
    },
  });
}
