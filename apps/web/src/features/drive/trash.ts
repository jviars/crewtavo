/**
 * The Trash, for everywhere in Crewtavo (supabase/migrations/20261028000300_drive.sql): a file someone
 * deletes waits there for TRASH_DAYS, then the server's nightly purge deletes it for good. The
 * browser never deletes a stored file. Moving a plan file, one of its versions or a folder to the
 * Trash and putting things back go through the database's drive_* functions, which decide who may.
 * Files from elsewhere (a visit photo, a quote photo, paperwork, an applicant's file) go to the Trash
 * by themselves when their row is deleted; putting one back puts its row back too, where its record
 * still exists. Where it's gone, the office can have a copy put in Company files (POST
 * /api/drive/trash/:id/to-drive), except a sub's paperwork, an applicant's files and receipts: those
 * are downloaded from the Trash by whoever may see them, never copied where more people would. An
 * owner can delete things for good sooner (deleteForever, emptyTrash): the server does that too.
 */
import { TRASH_DAYS } from "@crewtavo/core/drive";
import { api, supabase, unwrap } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import { toast } from "@/lib/toast";

export type TrashKind = "file" | "version" | "folder" | "other";

/** What a toast says after something goes to the Trash. */
export const IN_TRASH = `It's in the Trash for ${TRASH_DAYS} days.`;
/** Where the Trash is (it opens even with Drive not installed). */
export const TRASH_PATH = "/drive/trash";

/** Moves a file to the Trash with every one of its versions. Resolves with how many went. */
export async function trashFile(id: string): Promise<number> {
  return unwrap(await supabase().rpc("drive_trash_file", { p_file: id })) as number;
}

/**
 * Moves just the current version of a file to the Trash; the version before it is the current one
 * again. Resolves with that version's id.
 */
export async function trashVersion(id: string): Promise<string> {
  return unwrap(await supabase().rpc("drive_trash_version", { p_file: id })) as string;
}

/** Moves a folder to the Trash with everything in it. Resolves with how many folders and files went. */
export async function trashFolder(id: string): Promise<number> {
  return unwrap(await supabase().rpc("drive_trash_folder", { p_folder: id })) as number;
}

/** What putting something back did. */
export interface Restored {
  /** "copied": where it was is gone, so a copy is in Company files, under Restored files. */
  result: "restored" | "copied";
  /** The plan file it is now (a file or version put back, or the copy); null for anything else. */
  fileId: string | null;
}

/** A file that can't go back and isn't copied: whoever may see it downloads it from the Trash. */
const DOWNLOAD_INSTEAD = "This file can't go back where it was, because that was deleted. Download it from the Trash instead.";

/**
 * Puts something back from the Trash. A file from elsewhere whose record is gone (a photo whose
 * visit was deleted) can't go back where it was, so it's copied into Company files instead:
 * "copied". The server copies only for the office and never a restricted paper; `copy: false`
 * (someone the copy isn't for) says to download it instead without asking the server.
 */
export async function restoreTrash(kind: TrashKind, id: string, { copy = true }: { copy?: boolean } = {}): Promise<Restored> {
  const result = unwrap(await supabase().rpc("drive_restore", { p_kind: kind, p_id: id })) as string;
  if (result !== "needs_copy") return { result: "restored", fileId: kind === "file" || kind === "version" ? id : null };
  if (!copy) throw new Error(DOWNLOAD_INSTEAD);
  const res = await api.post<{ file?: { id?: string } | null }>(`/drive/trash/${id}/to-drive`);
  return { result: "copied", fileId: res?.file?.id ?? null };
}

/**
 * Puts back a file from elsewhere (a visit or quote photo, paperwork, an applicant's file) by where
 * it's stored: its row was just deleted, so the Trash has it under that path.
 */
export async function restoreStored(companyId: string, path: string): Promise<Restored> {
  const items = unwrap(await supabase().rpc("drive_trash", { p_company: companyId })) as unknown as Array<{ kind: string; id: string; path: string | null }>;
  const item = items.find((i) => i.kind === "other" && i.path === path);
  if (!item) throw new Error("It's not in the Trash any more.");
  // One that can't go back is refused in the database's words (download it from the Trash instead).
  return restoreTrash("other", item.id);
}

/** The most the Trash lists at a time (public.drive_trash), newest first. */
export const TRASH_LIST_MAX = 500;
/** The most the API deletes for good in one request. */
const DELETE_BATCH = 200;

/** What Delete forever or Empty Trash did. */
export interface DeletedForever {
  /** How many things it was asked to delete. */
  count: number;
  /**
   * How many the server deleted (whether or not their stored files could be removed straight away).
   * Anything short of `count` had already left the Trash: someone put it back, or it was deleted.
   */
  removed: number;
  /** What stopped Empty Trash part way, after `removed` were deleted. */
  error?: unknown;
}

type TrashRef = { kind: TrashKind; id: string };
const refKey = (t: TrashRef) => `${t.kind}:${t.id}`;

/** Deletes things in the Trash for good, now (owners only: POST /api/drive/trash/delete-forever). */
export async function deleteForever(items: TrashRef[]): Promise<DeletedForever> {
  let removed = 0;
  for (let i = 0; i < items.length; i += DELETE_BATCH) {
    const batch = items.slice(i, i + DELETE_BATCH).map(({ kind, id }) => ({ kind, id }));
    removed += (await api.post<{ removed: number }>("/drive/trash/delete-forever", { items: batch })).removed;
  }
  return { count: items.length, removed };
}

/**
 * Empty Trash: deletes for good everything in the Trash that went there up to `upTo` (the newest thing
 * the owner was shown when they said to), however much that is. The Trash lists TRASH_LIST_MAX at a
 * time, so it lists again until nothing that old is left. Anything moved to the Trash after that
 * waits its 30 days like everything else: nobody's just-deleted file is gone before they can undo it.
 */
export async function emptyTrash(companyId: string, upTo: string): Promise<DeletedForever> {
  const cutoff = new Date(upTo).getTime();
  if (Number.isNaN(cutoff)) throw new Error("Couldn't tell what's in the Trash. Refresh the page and try again.");
  const tried = new Set<string>();
  const done: DeletedForever = { count: 0, removed: 0 };
  try {
    for (;;) {
      const page = unwrap(await supabase().rpc("drive_trash", { p_company: companyId })) as unknown as Array<TrashRef & { deleted_at: string }>;
      // Each thing is asked for once, so something the server leaves (it went back meanwhile) can't loop.
      const due = page.filter((t) => new Date(t.deleted_at).getTime() <= cutoff && !tried.has(refKey(t)));
      if (!due.length) return done;
      for (let i = 0; i < due.length; i += DELETE_BATCH) {
        const batch = due.slice(i, i + DELETE_BATCH);
        batch.forEach((t) => tried.add(refKey(t)));
        const r = await deleteForever(batch);
        done.count += r.count;
        done.removed += r.removed;
      }
      // That was the whole Trash: nothing older is waiting behind it.
      if (page.length < TRASH_LIST_MAX) return done;
    }
  } catch (error) {
    // Nothing deleted yet: a plain failure. Otherwise, say how far it got.
    if (!done.count) throw error;
    return { ...done, error };
  }
}

/**
 * The toast after Delete forever or Empty Trash. A shortfall isn't a failure: the server deletes
 * everything it's asked for that's still in the Trash, so what it didn't delete had already left it
 * (put back by someone, or deleted by the nightly purge or another owner).
 */
export function deletedForeverToast(r: DeletedForever): { kind: "success" | "info" | "error"; title: string; description?: string } {
  const items = (n: number) => (n === 1 ? "One item" : `${n} items`);
  if (r.error) {
    return {
      kind: "error",
      title: r.removed ? `${items(r.removed)} deleted forever, then it stopped` : "Couldn't empty the Trash",
      description: `${errorMessage(r.error)} What's left is still in the Trash.`,
    };
  }
  if (r.count === 0) return { kind: "info", title: "Nothing to delete", description: "Everything had already left the Trash: put back by someone, or deleted." };
  if (r.removed >= r.count) return { kind: "success", title: r.count === 1 ? "Deleted forever" : `${r.count} items deleted forever` };
  const gone = r.count - r.removed;
  if (r.count === 1) return { kind: "info", title: "It wasn't in the Trash any more", description: "Someone put it back, or it was already deleted." };
  return {
    kind: "info",
    title: r.removed ? `${r.removed} of ${r.count} items deleted forever` : "Nothing was deleted",
    description: `${gone === 1 ? "One was" : `${gone} were`} no longer in the Trash: someone put ${gone === 1 ? "it" : "them"} back, or ${gone === 1 ? "it was" : "they were"} already deleted.`,
  };
}

/** The toast after something went to the Trash, with Undo to put it straight back. */
export function undoToast(message: string, kind: TrashKind, id: string, onDone?: () => void) {
  toast.success(message, { description: IN_TRASH, action: { label: "Undo", onClick: () => void undo(() => restoreTrash(kind, id), onDone) } });
}

/**
 * The toast after a file from elsewhere went to the Trash with its row (a visit or quote photo,
 * paperwork, an applicant's file), with Undo to put both back.
 */
export function storedUndoToast(message: string, companyId: string, path: string, onDone?: () => void) {
  toast.success(message, { description: IN_TRASH, action: { label: "Undo", onClick: () => void undo(() => restoreStored(companyId, path), onDone) } });
}

async function undo(restore: () => Promise<Restored>, onDone?: () => void) {
  try {
    const { result } = await restore();
    // Only if where it was went in the moments since (Undo is straight after): Drive shows Company files.
    toast.success("Restored", result === "copied" ? { description: "Where it was is gone, so it's in Company files, under Restored files." } : undefined);
  } catch (error) {
    toast.error("Couldn't put it back", { description: errorMessage(error) });
  } finally {
    onDone?.();
  }
}
