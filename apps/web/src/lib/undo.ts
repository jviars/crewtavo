/**
 * Undo instead of "Are you sure?": the change shows at once, a toast offers Undo for six seconds, and
 * only when the toast leaves is it saved for real. Several can be waiting at once, each on its own.
 *
 *   const key = ["notes", clientId];
 *   undoable({
 *     title: "Note deleted",
 *     hide: () => queryClient.setQueryData<Note[]>(key, (notes) => notes?.filter((n) => n.id !== note.id)),
 *     restore: () => queryClient.setQueryData<Note[]>(key, (notes) => (notes ? [...notes, note].sort(byNewest) : notes)),
 *     commit: () => api.notes.remove(note.id).then(() => queryClient.invalidateQueries({ queryKey: key })),
 *   });
 *
 * Not from inside an open dialog: a modal dialog makes everything outside it inert, the toast
 * included, so Undo couldn't be pressed. Ask with confirm() there instead.
 */
import type { QueryKey } from "@tanstack/react-query";
import { errorMessage } from "./errors";
import { queryClient } from "./queryClient";
import { toast, type ToastTone } from "./toast";

export interface UndoableOptions {
  /** What happened, in the past tense: "Note deleted". */
  title: string;
  description?: string;
  tone?: ToastTone;
  /** Takes the change on screen straight away (say, removes the row from the query cache). */
  hide: () => void;
  /** Puts it back: after Undo, or when saving it fails. */
  restore: () => void;
  /** Saves the change for real, once the toast leaves without Undo. */
  commit: () => unknown;
}

/** Toast id -> saves that change now. */
const waiting = new Map<number, () => Promise<void>>();

export function undoable({ title, description, tone, hide, restore, commit }: UndoableOptions): void {
  const trigger = document.activeElement;
  const updates = recordCacheUpdates(hide);
  // Fresh data arriving before the change is saved (a refetch on window focus, another change on the
  // page) would bring the row back: apply hide()'s own cache updates to it again, until it's saved or
  // undone. Only those updates: hide() itself may cancel fetches or change what's selected.
  let watching = true;
  const unwatch = queryClient.getQueryCache().subscribe((event) => {
    if (event.type !== "updated" || event.action.type !== "success" || event.action.manual) return;
    for (const { queryKey, updater } of updates) {
      if (queryClient.getQueryCache().find({ queryKey, exact: true }) === event.query) queueMicrotask(() => watching && queryClient.setQueryData(queryKey, updater as never));
    }
  });
  const stopWatching = () => {
    if (!watching) return;
    watching = false;
    unwatch();
  };
  let settled = false;
  let id = -1;
  const save = async () => {
    if (settled) return;
    settled = true;
    waiting.delete(id);
    try {
      await commit();
      stopWatching();
    } catch (error) {
      stopWatching();
      restore();
      toast.error(errorMessage(error));
    }
  };
  id = toast.success(title, {
    description,
    tone,
    countdown: true,
    duration: 6000,
    action: {
      label: "Undo",
      onClick: () => {
        if (settled) return;
        settled = true;
        waiting.delete(id);
        stopWatching();
        restore();
      },
    },
    onClose: (reason) => {
      if (reason !== "action") void save();
    },
  });
  waiting.set(id, save);
  // The button pressed went with its row: put keyboard focus on Undo rather than leave it on the page.
  if (trigger instanceof HTMLElement && trigger !== document.body) {
    requestAnimationFrame(() => {
      if (trigger.isConnected || (document.activeElement && document.activeElement !== document.body)) return;
      document.querySelector<HTMLElement>(`.toast-action[data-toast="${id}"]`)?.focus({ preventScroll: true });
    });
  }
}

type Updater = Parameters<typeof queryClient.setQueryData>[1];

/**
 * Runs hide() and notes the query-cache updates it makes with an updater function (filtering a row
 * out), so they can be applied again to fresh data. Updates written as plain values aren't kept.
 */
function recordCacheUpdates(hide: () => void): Array<{ queryKey: QueryKey; updater: Updater }> {
  const updates: Array<{ queryKey: QueryKey; updater: Updater }> = [];
  const setQueryData = queryClient.setQueryData;
  queryClient.setQueryData = ((queryKey: QueryKey, updater: Updater, options?: unknown) => {
    if (typeof updater === "function") updates.push({ queryKey, updater });
    return setQueryData.call(queryClient, queryKey, updater, options as never);
  }) as typeof queryClient.setQueryData;
  try {
    hide();
  } finally {
    queryClient.setQueryData = setQueryData;
  }
  return updates;
}

/** Saves every change still waiting on its Undo toast now, and closes those toasts. Await it before signing out. */
export async function flushUndos(): Promise<void> {
  const saves = [...waiting.entries()];
  await Promise.all(
    saves.map(([id, save]) => {
      const done = save();
      toast.dismiss(id);
      return done;
    }),
  );
}

// Leaving the page (closing the tab, reloading) saves what's waiting rather than dropping it.
if (typeof window !== "undefined") window.addEventListener("pagehide", () => void flushUndos());
