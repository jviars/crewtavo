/**
 * Plan files on their way up, kept outside any screen: a plan set can take minutes, and leaving the
 * quote or job mustn't stop it. Each file is a background task (lib/tasks.ts, shown on the task
 * island) with its own Cancel, and the Plans card that started them shows their progress whenever
 * it's on the screen (usePlanUploads). As each one finishes, the plans lists load again.
 */
import { useSyncExternalStore } from "react";
import { supabase } from "@/lib/api";
import { queryClient } from "@/lib/queryClient";
import { startTask } from "@/lib/tasks";
import type { ApiError } from "@/lib/errors";
import { RefusedForSpace } from "../settings/storage";
import { fileSize, isAbort, titleFromFileName, TooLargeError, uploadPlanFile, type PlanFile, type Upload } from "./plans";

/** Where a new file goes: the request, quote or job (the database adds the property), or a property. */
export type PlanTarget = { request_id?: string; quote_id?: string; job_id?: string; property_id?: string };

export interface PlanUpload {
  key: string;
  /** The Plans card that shows it (PlansCard's scope). */
  card: string;
  name: string;
  size: number;
  /** 0 to 1, or null while it waits for the files ahead of it. */
  progress: number | null;
  /** Stops it, or takes it out of the line if it hasn't started. */
  stop: () => void;
}

let uploads: PlanUpload[] = [];
const listeners = new Set<() => void>();

function update(next: PlanUpload[]) {
  uploads = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The files the card `card` sent that are still on their way, from wherever it was when they started. */
export function usePlanUploads(card: string): PlanUpload[] {
  return useSyncExternalStore(subscribe, () => uploads).filter((u) => u.card === card);
}

/**
 * What the card that sent the files says itself, as before there was a task island. It's called
 * whether or not the card is still on the screen, so it checks; the island says the outcome either way.
 */
export interface PlanUploadScreen {
  /** A file too big for this Crewtavo: the card offers the way to raise the limit. */
  tooLarge?: (error: TooLargeError) => void;
  failed?: (name: string, message: string) => void;
  /** Files refused for space, said once at the end: the first refusal and a title naming them all. */
  refused?: (first: ApiError, title: string) => void;
  /** Once the last file is through, when any went in (`lastId`, the newest). */
  added?: (count: number, lastId: string | null) => void;
}

/**
 * Sends the files one after another and adds each to the plans: as new files on `target`, or the
 * first as a new version of `replaces`. Resolves once they're all through, stopped or failed.
 */
export async function addPlanFiles({ companyId, card, files, target, replaces = null, screen = {} }: {
  companyId: string;
  card: string;
  files: File[];
  target: PlanTarget;
  replaces?: PlanFile | null;
  screen?: PlanUploadScreen;
}): Promise<void> {
  const queue = files.map((file) => {
    const key = crypto.randomUUID();
    const control: { stopped: boolean; upload: Upload | null } = { stopped: false, upload: null };
    const stop = () => {
      control.stopped = true;
      if (control.upload) control.upload.abort();
      else {
        // Still waiting its turn: out of the line now, not once the files ahead of it are through.
        update(uploads.filter((u) => u.key !== key));
        task.dismiss();
      }
    };
    const task = startTask({ label: `Uploading ${file.name}`, detail: fileSize(file.size), total: file.size, cancel: stop });
    const entry: PlanUpload = { key, card, name: file.name, size: file.size, progress: null, stop };
    return { key, file, control, task, entry };
  });
  update([...uploads, ...queue.map((q) => q.entry)]);
  const progress = (key: string, value: number) => update(uploads.map((u) => (u.key === key ? { ...u, progress: value } : u)));

  let added = 0;
  let lastId: string | null = null;
  // Storage checks each file against the room left, so one refused doesn't stop the rest; a file at
  // least as big as one already refused isn't sent (see RefusedForSpace).
  const refused = new RefusedForSpace();
  for (const { key, file, control, task } of queue) {
    // Taken out of the line before its turn (stop): already gone from the card and the island.
    if (control.stopped) continue;
    if (refused.skips(file.name, file.size)) {
      task.fail(`${file.name} wasn't added. ${refused.first?.message ?? ""}`.trim());
      update(uploads.filter((u) => u.key !== key));
      continue;
    }
    try {
      control.upload = uploadPlanFile(companyId, file, (fraction) => {
        progress(key, fraction);
        task.progress(fraction * file.size);
      });
      progress(key, 0);
      const path = await control.upload.promise;
      const { data, error } = await supabase()
        .from("plan_files")
        .insert({
          company_id: companyId,
          ...target,
          replaces_id: replaces?.id ?? null,
          title: replaces?.title ?? titleFromFileName(file.name),
          path,
          file_name: file.name.slice(0, 255),
          content_type: (file.type || null)?.slice(0, 150) ?? null,
          size_bytes: file.size,
          crew_visible: replaces?.crew_visible ?? true,
        })
        .select("id")
        .single();
      // A stored file with no row is tidied away by the server after a day.
      if (error) throw new Error(error.message);
      added++;
      lastId = data.id;
      task.done(replaces ? `New version of ${replaces.title} added` : `${file.name} added`);
      // Files show on plans cards, crews' visits and in Drive, and count toward storage.
      for (const shows of ["plans", "field-visit", "drive", "storage"]) void queryClient.invalidateQueries({ queryKey: [shows] });
    } catch (error) {
      // Stopped by the person: nothing to say.
      if (isAbort(error)) task.dismiss();
      else if (refused.add(error, file.name, file.size)) task.fail(`${file.name} wasn't added. ${(error as ApiError).message}`);
      else if (error instanceof TooLargeError) {
        task.fail(error.message);
        screen.tooLarge?.(error);
      } else {
        const message = error instanceof Error ? error.message : "Couldn't add it.";
        task.fail(`${file.name}: ${message}`);
        screen.failed?.(file.name, message);
      }
    } finally {
      update(uploads.filter((u) => u.key !== key));
    }
  }
  if (refused.first) screen.refused?.(refused.first, refused.title());
  if (added) screen.added?.(added, lastId);
}
