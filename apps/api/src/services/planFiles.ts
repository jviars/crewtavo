/**
 * Upkeep for stored files: Plans and files (supabase/migrations/20261019001700_plan_files.sql, which
 * Drive's files are too), subs' paperwork (20261025001001_subcontractors.sql), applicants' résumés
 * (20261028000100_careers.sql), and the Trash (20261028000300_drive.sql).
 *
 * The daily "plans" task removes uploads nobody recorded:
 *   - A plan file uploaded but never recorded (a booking form closed before its files were recorded,
 *     an upload cut off before its row was saved) goes once it's a day old.
 *   - The same for a sub's paperwork: a file sent by link that was never recorded goes once it's a
 *     day old.
 *   - And for an applicant's files: one stored for an application that then wasn't kept goes once
 *     it's a day old.
 *   - And for a guide's cover, or a quote's or a visit's photo, uploaded for a save that then failed
 *     (unrecorded_files: the database looks through what's stored, and says which nothing uses).
 * A file in the Trash is recorded (a plan file keeps its row, marked deleted; any other file has a
 * trashed_files row), so it's never swept: it waits out its 30 days. A plan file whose client,
 * property, request, quote and job were all deleted goes to the Trash in the database itself.
 *
 * The daily "trash" task deletes for good what has been in the Trash for TRASH_DAYS (purgeTrash):
 * plan files, then Drive's folders, then the files from the rest of Crewtavo. The database decides
 * what goes (trash_purge): it deletes the rows still in the Trash, then hands over the stored files
 * nothing uses any more, and only those are removed here. One Storage won't remove is left behind;
 * no row ever points at a file that's gone. Drive's "Delete forever" (routes/drive.ts) works the same
 * way, before their time, for an owner. The database hands the files over in lists (a row for each
 * kind and company, or for each thing deleted), never a row a file: PostgREST answers with 1000 rows
 * at most, and a file it left out would never be removed.
 */
import { TRASH_DAYS } from "@crewtavo/core/drive";
import type { Db } from "../lib/supabase";

const DAY_MS = 24 * 60 * 60_000;
const PAGE = 1000;
/** Files removed from Storage in one request. */
const CHUNK = 100;
/** One night's purge asks the database this many times at most (PAGE of each kind each time); the rest wait for the next night. */
const PURGE_ROUNDS = 10;

type Files = ReturnType<Db["storage"]["from"]>;

/** A stored file of this company's: its path starts with the company's id. Anything else is never removed for it. */
export const inCompany = (companyId: string, path: string) => Boolean(companyId) && path.startsWith(`${companyId}/`);

/** Which of these paths are files in the Trash from outside Drive (trashed_files). A failed lookup throws. */
async function trashedPaths(admin: Db, paths: string[]): Promise<Set<string>> {
  const { data, error } = await admin.from("trashed_files").select("path").in("path", paths);
  if (error) throw new Error(error.message);
  return new Set((data ?? []).map((t) => t.path));
}

/**
 * Removes stored files, CHUNK at a time, and says which went. A chunk Storage refuses stays (and is
 * logged). A file already gone counts as removed.
 */
export async function removeStored(files: Files, paths: string[]): Promise<Set<string>> {
  const gone = new Set<string>();
  const unique = [...new Set(paths)];
  for (let i = 0; i < unique.length; i += CHUNK) {
    const chunk = unique.slice(i, i + CHUNK);
    const { error } = await files.remove(chunk);
    if (error) console.warn(`Couldn't remove ${chunk.length} stored files: ${error.message}`);
    else for (const path of chunk) gone.add(path);
  }
  return gone;
}

/** Removes the day-old files in one folder that `known` has no row for. Returns how many went. */
async function sweepFolder(files: Files, folder: string, known: (paths: string[]) => Promise<Set<string>>, now: number) {
  let removed = 0;
  for (let offset = 0; ; offset += PAGE) {
    const { data: objects, error } = await files.list(folder, { limit: PAGE, offset, sortBy: { column: "created_at", order: "asc" } });
    if (error || !objects?.length) break;
    const old = objects.filter((o) => o.id && o.created_at && now - Date.parse(o.created_at) > DAY_MS).map((o) => `${folder}/${o.name}`);
    for (let i = 0; i < old.length; i += CHUNK) {
      const chunk = old.slice(i, i + CHUNK);
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

/** The only folders unrecorded_files looks in: guide covers, and quote and visit photos. */
const UNRECORDED_FOLDERS = new Set(["kb", "quote", "visit"]);
/** A file unrecorded_files may hand over for a company: the company's own, in one of those folders, with no "." or ".." in its path. */
const sweepable = (companyId: string, path: string) => {
  const parts = path.split("/");
  return inCompany(companyId, path) && UNRECORDED_FOLDERS.has(parts[1] ?? "") && !parts.some((part) => part === "." || part === "..");
};

/**
 * Guide covers (kb/), and quote and visit photos (quote/, visit/), uploaded for a save that then
 * failed: the database (unrecorded_files) says which stored files there are over a day old, used by
 * nothing and not in the Trash, PAGE at a time, and they're removed here. Nothing outside those
 * folders, or outside the company each is handed over for, is ever removed. Stops for the night
 * after PURGE_ROUNDS, or when Storage won't remove any of a round. kept counts the ones it wouldn't.
 */
export async function tidyUnrecordedFiles(admin: Db): Promise<{ unrecorded: number; kept: number }> {
  const storage = admin.storage.from("files");
  const counts = { unrecorded: 0, kept: 0 };
  for (let round = 0; round < PURGE_ROUNDS; round++) {
    const { data, error } = await admin.rpc("unrecorded_files", { p_limit: PAGE });
    if (error) throw new Error(error.message);
    const paths = [...new Set((data ?? []).flatMap((row) => (row.paths ?? []).filter((path) => sweepable(row.company_id, path))))];
    if (!paths.length) break;
    const gone = await removeStored(storage, paths);
    counts.unrecorded += gone.size;
    counts.kept += paths.length - gone.size;
    if (!gone.size || paths.length < PAGE) break;
  }
  return counts;
}

/** Plan files uploaded but never recorded. One in the Trash still has its row, so it stays. */
export async function tidyPlanFiles(admin: Db, now = Date.now()): Promise<{ unrecorded: number }> {
  const files = admin.storage.from("files");
  const { data: companies, error } = await admin.from("companies").select("id").limit(1000);
  if (error) throw new Error(error.message);
  // A failed lookup must not read as "no rows": that would remove every file in the folder.
  const known = async (paths: string[]) => {
    const { data, error: lookup } = await admin.from("plan_files").select("path").in("path", paths);
    if (lookup) throw new Error(lookup.message);
    return new Set([...(data ?? []).map((k) => k.path), ...(await trashedPaths(admin, paths))]);
  };
  let unrecorded = 0;
  for (const { id } of companies ?? []) unrecorded += await sweepFolder(files, `${id}/plans`, known, now);
  return { unrecorded };
}

/**
 * A sub's paperwork files with no row: sent by link and never recorded. Paperwork someone deleted, or
 * that went with its sub, is in the Trash (trashed_files) for its 30 days, so it stays.
 */
export async function tidySubFiles(admin: Db, now = Date.now()): Promise<{ unrecorded: number }> {
  const files = admin.storage.from("files");
  const { data: companies, error } = await admin.from("companies").select("id").limit(1000);
  if (error) throw new Error(error.message);
  const known = async (paths: string[]) => {
    const { data, error: lookup } = await admin.from("sub_documents").select("path").in("path", paths);
    if (lookup) throw new Error(lookup.message);
    return new Set([...(data ?? []).map((k) => k.path), ...(await trashedPaths(admin, paths))]);
  };
  let unrecorded = 0;
  for (const { id } of companies ?? []) {
    for (const sub of await subfolders(files, `${id}/subs`)) unrecorded += await sweepFolder(files, `${id}/subs/${sub}`, known, now);
  }
  return { unrecorded };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * An applicant's files with no row: stored for an application that wasn't kept. A file someone
 * removed, or one that went with its applicant, is in the Trash (trashed_files), so it stays.
 */
export async function tidyApplicantFiles(admin: Db, now = Date.now()): Promise<{ unrecorded: number }> {
  const files = admin.storage.from("files");
  const { data: companies, error } = await admin.from("companies").select("id").limit(1000);
  if (error) throw new Error(error.message);
  let unrecorded = 0;
  for (const { id } of companies ?? []) {
    // Each applicant's folder is named by their id, and their row lists the files in it.
    for (const applicant of await subfolders(files, `${id}/applicants`)) {
      if (!UUID.test(applicant)) continue;
      const known = async (paths: string[]) => {
        const { data, error: lookup } = await admin.from("job_applicants").select("files").eq("id", applicant).maybeSingle();
        if (lookup) throw new Error(lookup.message);
        const listed = ((data?.files ?? []) as Array<{ path?: string }>).map((f) => f.path ?? "");
        return new Set([...listed, ...(await trashedPaths(admin, paths))]);
      };
      unrecorded += await sweepFolder(files, `${id}/applicants/${applicant}`, known, now);
    }
  }
  return { unrecorded };
}

/**
 * The nightly purge: everything in the Trash for over TRASH_DAYS is deleted for good. The database
 * deletes the rows (trash_purge: plan files, every version that went at one moment together, then
 * Drive's folders, a folder holding one in use staying, then the files from the rest of Crewtavo),
 * each only while it's still in the Trash, so one restored meanwhile stays; then it hands over the
 * stored files nothing uses any more, which are removed here: a row for each kind and company, with
 * how many rows went and their files. kept counts the files Storage wouldn't remove: left behind,
 * their rows gone. Safe to run twice: a file already gone counts as removed.
 */
export async function purgeTrash(admin: Db, now = Date.now()): Promise<{ files: number; folders: number; other: number; kept: number }> {
  const storage = admin.storage.from("files");
  const cutoff = new Date(now - TRASH_DAYS * DAY_MS).toISOString();
  const counts = { files: 0, folders: 0, other: 0, kept: 0 };
  for (let round = 0; round < PURGE_ROUNDS; round++) {
    const { data, error } = await admin.rpc("trash_purge", { p_cutoff: cutoff, p_limit: PAGE });
    if (error) throw new Error(error.message);
    if (!data?.length) break;
    for (const row of data) {
      if (row.source === "plan_files") counts.files += row.deleted;
      else if (row.source === "drive_folders") counts.folders += row.deleted;
      else counts.other += row.deleted;
    }
    // Only this company's own files (the database says so too), and only those nothing uses.
    const paths = [...new Set(data.flatMap((row) => (row.paths ?? []).filter((path) => inCompany(row.company_id, path))))];
    const gone = await removeStored(storage, paths);
    counts.kept += paths.length - gone.size;
  }
  return counts;
}
