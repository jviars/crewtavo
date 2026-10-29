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
 */
import { errorMessage } from "./errors";
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
  hide();
  let settled = false;
  let id = -1;
  const save = async () => {
    if (settled) return;
    settled = true;
    waiting.delete(id);
    try {
      await commit();
    } catch (error) {
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
        restore();
      },
    },
    onClose: (reason) => {
      if (reason !== "action") void save();
    },
  });
  waiting.set(id, save);
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
