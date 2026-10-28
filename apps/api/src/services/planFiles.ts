/**
 * The daily "plans" task: tidies Plans and files (supabase/migrations/20261019001700_plan_files.sql),
 * subs' paperwork (20261025001001_subcontractors.sql) and applicants' résumés (20261028000100_careers.sql).
 *   - A file whose property, request, quote and job were all deleted (a spam request, say) is on
 *     nothing anyone can open: its file and row go.
 *   - A file uploaded but never recorded (a booking form closed before its files were recorded, an
 *     upload cut off before its row was saved) goes once it's a day old.
 *   - The same for a sub's paperwork: a file sent by link that was never recorded, or one left
 *     behind when its sub was deleted, goes once it's a day old.
 *   - And for an applicant's files: one stored for an application that then wasn't kept, or left
 *     behind when the applicant was deleted, goes once it's a day old.
 */
import type { Db } from "../lib/supabase";

const DAY_MS = 24 * 60 * 60_000;
const PAGE = 1000;

type Files = ReturnType<Db["storage"]["from"]>;

/** Removes the day-old files in one folder that `known` has no row for. Returns how many went. */
async function sweepFolder(files: Files, folder: string, known: (paths: string[]) => Promise<Set<string>>, now: number) {
  let removed = 0;
  for (let offset = 0; ; offset += PAGE) {
    const { data: objects, error } = await files.list(folder, { limit: PAGE, offset, sortBy: { column: "created_at", order: "asc" } });
    if (error || !objects?.length) break;
    const old = objects.filter((o) => o.id && o.created_at && now - Date.parse(o.created_at) > DAY_MS).map((o) => `${folder}/${o.name}`);
    for (let i = 0; i < old.length; i += 100) {
      const chunk = old.slice(i, i + 100);
      const recorded = await known(chunk);
      const strays = chunk.filter((path) => !recorded.has(path));
      if (strays.length && !(await files.remove(strays)).error) removed += strays.length;
    }
    if (objects.length < PAGE) break;
  }
  return removed;
}

/** Storage lists one level at a time; these are the folders in one (they come back without an id). */
async function subfolders(files: Files, folder: string): Promise<string[]> {
  const names: string[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await files.list(folder, { limit: PAGE, offset, sortBy: { column: "name", order: "asc" } });
    if (error || !data?.length) break;
    names.push(...data.filter((o) => !o.id).map((o) => o.name));
    if (data.length < PAGE) break;
  }
  return names;
}

export async function tidyPlanFiles(admin: Db, now = Date.now()): Promise<{ detached: number; unrecorded: number }> {
  const files = admin.storage.from("files");

  // On nothing at all.
  const { data: lost, error } = await admin
    .from("plan_files")
    .select("id, path")
    .is("property_id", null)
    .is("request_id", null)
    .is("quote_id", null)
    .is("job_id", null)
    .limit(500);
  if (error) throw new Error(error.message);
  let detached = 0;
  for (const row of lost ?? []) {
    await files.remove([row.path]);
    const { error: gone } = await admin.from("plan_files").delete().eq("id", row.id);
    if (!gone) detached++;
  }

  // Never recorded.
  const { data: companies, error: listError } = await admin.from("companies").select("id").limit(1000);
  if (listError) throw new Error(listError.message);
  // A failed lookup must not read as "no rows": that would remove every file in the folder.
  const known = async (paths: string[]) => {
    const { data, error: lookup } = await admin.from("plan_files").select("path").in("path", paths);
    if (lookup) throw new Error(lookup.message);
    return new Set((data ?? []).map((k) => k.path));
  };
  let unrecorded = 0;
  for (const { id } of companies ?? []) unrecorded += await sweepFolder(files, `${id}/plans`, known, now);
  return { detached, unrecorded };
}

/** A sub's paperwork files with no row: sent by link and never recorded, or left by a deleted sub. */
export async function tidySubFiles(admin: Db, now = Date.now()): Promise<{ unrecorded: number }> {
  const files = admin.storage.from("files");
  const { data: companies, error } = await admin.from("companies").select("id").limit(1000);
  if (error) throw new Error(error.message);
  const known = async (paths: string[]) => {
    const { data, error: lookup } = await admin.from("sub_documents").select("path").in("path", paths);
    if (lookup) throw new Error(lookup.message);
    return new Set((data ?? []).map((k) => k.path));
  };
  let unrecorded = 0;
  for (const { id } of companies ?? []) {
    for (const sub of await subfolders(files, `${id}/subs`)) unrecorded += await sweepFolder(files, `${id}/subs/${sub}`, known, now);
  }
  return { unrecorded };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** An applicant's files with no row: stored for an application that wasn't kept, or left by a deleted applicant. */
export async function tidyApplicantFiles(admin: Db, now = Date.now()): Promise<{ unrecorded: number }> {
  const files = admin.storage.from("files");
  const { data: companies, error } = await admin.from("companies").select("id").limit(1000);
  if (error) throw new Error(error.message);
  let unrecorded = 0;
  for (const { id } of companies ?? []) {
    // Each applicant's folder is named by their id, and their row lists the files in it.
    for (const applicant of await subfolders(files, `${id}/applicants`)) {
      if (!UUID.test(applicant)) continue;
      const known = async () => {
        const { data, error: lookup } = await admin.from("job_applicants").select("files").eq("id", applicant).maybeSingle();
        if (lookup) throw new Error(lookup.message);
        return new Set(((data?.files ?? []) as Array<{ path?: string }>).map((f) => f.path ?? ""));
      };
      unrecorded += await sweepFolder(files, `${id}/applicants/${applicant}`, known, now);
    }
  }
  return { unrecorded };
}
