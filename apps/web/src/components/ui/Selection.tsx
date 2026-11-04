/**
 * Picking rows on a list page to act on them at once: a box on each row, one in the heading for
 * every row on the page, and a bar above the list with how many are picked and what can be done.
 * The logic, and writing them in chunks, is lib/bulk.ts.
 */
import type { QueryKey } from "@tanstack/react-query";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { inChunks, mergeResults, pageState, pickedOnPage, reportBulk, toggleAll, toggleOne, type BulkResult, type BulkWords } from "@/lib/bulk";
import { queryClient } from "@/lib/queryClient";
import type { ToastTone } from "@/lib/toast";
import { undoable } from "@/lib/undo";
import { Button, cx } from "./Button";

/** What's picked among `pageIds`. A new `reset` (another filter, a search) starts with nothing picked. */
export function useSelection(pageIds: readonly string[], reset: string) {
  const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set());
  const [shown, setShown] = useState(reset);
  if (shown !== reset) {
    setShown(reset);
    setPicked(new Set());
  }
  return {
    /** Picked and on the page, in its order. */
    ids: pickedOnPage(picked, pageIds),
    state: pageState(picked, pageIds),
    has: (id: string) => picked.has(id),
    toggle: (id: string) => setPicked((p) => toggleOne(p, id)),
    toggleAll: () => setPicked((p) => toggleAll(p, pageIds)),
    clear: () => setPicked(new Set()),
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

/** A row's box. A click on it, or near it, picks the row rather than opening it. */
export function SelectCell({ selection, id, label }: { selection: Selection; id: string; label: string }) {
  return (
    <td className="select-cell" onClick={(e) => e.stopPropagation()}>
      <label><input type="checkbox" aria-label={label} checked={selection.has(id)} onChange={() => selection.toggle(id)} /></label>
    </td>
  );
}

/**
 * Above the list, in view as it scrolls: how many are picked, the actions, and Clear. On a phone,
 * where the table's headings are hidden, it's where Select all is too, so it shows before any are.
 */
export function SelectionBar({ selection, noun, children }: { selection: Selection; noun: string; children: ReactNode }) {
  const count = selection.ids.length;
  return (
    <>
      <span className="sr-only" role="status">{count ? `${count} selected` : ""}</span>
      <div className={cx("select-bar", !count && "mobile-only")}>
        <label className="select-bar-all">
          <SelectAllBox selection={selection} label={`Select all ${noun} on this page`} />
          <span aria-hidden="true">{count ? `${count} selected` : "Select all"}</span>
        </label>
        {count > 0 && (
          <>
            <div className="select-bar-actions">{children}</div>
            <Button size="sm" variant="ghost" onClick={selection.clear}>Clear</Button>
          </>
        )}
      </div>
    </>
  );
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
