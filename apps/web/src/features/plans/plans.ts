/**
 * Plans and files: plan sets, specs, permits and addenda on quotes, jobs and properties, and the
 * company's own files in Drive's folders (public.plan_files; supabase/migrations/
 * 20261019001700_plan_files.sql and 20261028000300_drive.sql explain the rules). Files go to the
 * private files bucket at <company>/plans/<uuid>.<ext>, uploaded as they are: never shrunk, since
 * a plan sheet has to stay readable. Deleting one moves it to the Trash (features/drive/trash.ts);
 * only the server deletes stored files, 30 days later.
 */
import { extensionFor } from "@crewtavo/core/drive";
import { useQuery } from "@tanstack/react-query";
import { ApiError, loadConfig, supabase } from "@/lib/api";
import { friendlyDbError } from "@/lib/errors";
import { formatDate } from "@/lib/format";
import { resumableUpload, sendWhole, TooLargeError, type Upload } from "@/lib/resumable";

export { isAbort, TooLargeError, type Upload } from "@/lib/resumable";

export interface PlanFile {
  id: string;
  company_id: string;
  property_id: string | null;
  request_id: string | null;
  quote_id: string | null;
  job_id: string | null;
  /** The company folder it's in (Drive), if any: the company's root folder is "Company files". */
  folder_id: string | null;
  title: string;
  revision: string | null;
  notes: string | null;
  path: string;
  file_name: string;
  content_type: string | null;
  size_bytes: number | null;
  crew_visible: boolean;
  archived: boolean;
  replaces_id: string | null;
  superseded_at: string | null;
  created_by: string | null;
  created_at: string;
  /** Always null here: files in the Trash are hidden from every list (drive_trash lists them). */
  deleted_at: string | null;
}
export const PLAN_FIELDS =
  "id, company_id, property_id, request_id, quote_id, job_id, folder_id, title, revision, notes, path, file_name, content_type, size_bytes, crew_visible, archived, replaces_id, superseded_at, created_by, created_at, deleted_at";

/** Plan sets run big. The server's own limit (FILE_SIZE_LIMIT on the storage service) may be lower. */
export const PLAN_MAX_BYTES = 200 * 1024 * 1024;
export const PLAN_LIMIT_DOCS = "https://crewtavo.com/docs/getting-started/plans-and-files/#large-files";

export const isPdf = (f: Pick<PlanFile, "content_type" | "file_name">) => f.content_type === "application/pdf" || /\.pdf$/i.test(f.file_name);
export const isImage = (f: Pick<PlanFile, "content_type" | "file_name">) => Boolean(f.content_type?.startsWith("image/")) || /\.(png|jpe?g|webp|gif)$/i.test(f.file_name);
/** PDFs and pictures can go on the Measure map. */
export const canMap = (f: Pick<PlanFile, "content_type" | "file_name">) => isPdf(f) || (isImage(f) && !/\.(heic|heif|tiff?)$/i.test(f.file_name));

/** "C-101 Site Plan rev B.pdf" -> "C-101 Site Plan rev B". */
export function titleFromFileName(name: string): string {
  const base = name.replace(/\.[a-z0-9]{1,8}$/i, "").replace(/[_]+/g, " ").replace(/\s+/g, " ").trim();
  return (base || "Plan").slice(0, 200);
}

export function fileSize(bytes: number | null | undefined): string {
  if (bytes == null) return "";
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  const mb = bytes / (1024 * 1024);
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}

/** What kind of file, in a word or two. */
export function fileKind(f: Pick<PlanFile, "content_type" | "file_name">): string {
  if (isPdf(f)) return "PDF";
  if (isImage(f)) return "Picture";
  const ext = f.file_name.match(/\.([a-z0-9]{1,8})$/i)?.[1];
  return ext ? ext.toUpperCase() : "File";
}

// ---------------------------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------------------------

export interface PlanEntry {
  /** The current version. */
  file: PlanFile;
  /** Older versions, newest first (only the office can see them). */
  older: PlanFile[];
  /** 1 for a file with no earlier versions. */
  version: number;
  /** It has older versions this person can't see (crews only get the current one). */
  hiddenHistory: boolean;
}

/** Each current file with its history, newest first. */
export function planEntries(rows: PlanFile[]): PlanEntry[] {
  const byId = new Map(rows.map((r) => [r.id, r]));
  return rows
    .filter((r) => !r.superseded_at)
    .map((file) => {
      const older: PlanFile[] = [];
      const seen = new Set([file.id]);
      for (let prev = file.replaces_id ? byId.get(file.replaces_id) : undefined; prev && !seen.has(prev.id); prev = prev.replaces_id ? byId.get(prev.replaces_id) : undefined) {
        older.push(prev);
        seen.add(prev.id);
      }
      return { file, older, version: older.length + 1, hiddenHistory: Boolean(file.replaces_id) && !older.length };
    })
    .sort((a, b) => b.file.created_at.localeCompare(a.file.created_at));
}

/** "Version 2 · Rev B · 12 MB · PDF · Oct 19", or "Rev B · 12 MB · PDF · updated Oct 19" for a crew. */
export function planMeta(entry: PlanEntry): string {
  const f = entry.file;
  const when = entry.hiddenHistory || entry.version > 1 ? `updated ${formatDate(f.created_at)}` : formatDate(f.created_at);
  return [entry.version > 1 && `Version ${entry.version}`, f.revision?.trim(), fileSize(f.size_bytes), fileKind(f), when].filter(Boolean).join(" · ");
}

// ---------------------------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------------------------

/** Links that open each file in the browser for an hour, and links that save it with its own name. */
export function usePlanLinks(files: Array<Pick<PlanFile, "path" | "file_name">>) {
  const list = [...new Map(files.map((f) => [f.path, f])).values()].sort((a, b) => a.path.localeCompare(b.path));
  return useQuery({
    queryKey: ["plan-links", list.map((f) => f.path)],
    enabled: list.length > 0,
    staleTime: 50 * 60_000,
    meta: { silent: true },
    queryFn: async () => {
      const { data, error } = await supabase().storage.from("files").createSignedUrls(list.map((f) => f.path), 3600);
      if (error) throw new Error(error.message);
      const names = new Map(list.map((f) => [f.path, f.file_name]));
      const open: Record<string, string> = {};
      const save: Record<string, string> = {};
      for (const d of data ?? []) {
        if (!d.signedUrl || !d.path) continue;
        open[d.path] = d.signedUrl;
        save[d.path] = `${d.signedUrl}${d.signedUrl.includes("?") ? "&" : "?"}download=${encodeURIComponent(names.get(d.path) ?? "plan")}`;
      }
      return { open, save };
    },
  });
}

export async function planLink(path: string, seconds = 3600): Promise<string> {
  const { data, error } = await supabase().storage.from("files").createSignedUrl(path, seconds);
  if (error || !data?.signedUrl) throw new Error(error?.message ?? "Couldn't open that file.");
  return data.signedUrl;
}

// ---------------------------------------------------------------------------------------------
// Uploading
// ---------------------------------------------------------------------------------------------

/** A file's type from its name, for one made here without a type (an edited PDF or Word document). */
const typeFromName = (name: string) =>
  /\.pdf$/i.test(name) ? "application/pdf" : /\.docx$/i.test(name) ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document" : null;

const refused = (error: unknown): Upload => {
  const promise = Promise.reject(error);
  promise.catch(() => undefined); // the caller hears of it when it waits for the upload
  return { promise, abort: () => undefined };
};

/** Over 200 MB, or empty: never sent. */
function unsendable(size: number, name: string): Error | null {
  if (size > PLAN_MAX_BYTES) return new TooLargeError(`${name} is larger than ${fileSize(PLAN_MAX_BYTES)}.`);
  if (size === 0) return new Error(`${name} is empty.`);
  return null;
}

/**
 * Sends a file to <company>/plans/ as it is, reporting progress (0 to 1). Resolves with its storage
 * path. In 6 MB pieces that carry on after a dropped connection (lib/resumable.ts), so plan sets
 * bigger than a proxy takes in one request get through. Storage's own limit (FILE_SIZE_LIMIT) still
 * applies.
 */
export function uploadPlanFile(companyId: string, file: File, onProgress: (fraction: number) => void): Upload {
  const problem = unsendable(file.size, file.name);
  if (problem) return refused(problem);
  const path = `${companyId}/plans/${crypto.randomUUID()}.${extensionFor(file.name, file.type)}`;
  return resumableUpload({ path, file, contentType: file.type || "application/octet-stream", onProgress });
}

/**
 * The file a new version replaces: a whole row, or what Drive's list has of one. Where it is that
 * isn't given, the new version takes from the old one in the database (private.plan_files_fill).
 */
export type VersionOf = Pick<PlanFile, "id" | "title" | "crew_visible"> &
  Partial<Pick<PlanFile, "content_type" | "property_id" | "request_id" | "quote_id" | "job_id" | "folder_id">>;

/**
 * Saves an edited file (a marked-up PDF, a Word document) as the newest version of `previous`: a
 * new stored file and a new row that replaces the old one, which stays in the file's history.
 * Nothing is overwritten. It keeps the file's name, who sees it, and where it is (its property,
 * request, quote or job, and its folder); the revision label starts empty.
 */
export async function addVersion(companyId: string, previous: VersionOf, blob: Blob, fileName: string, onProgress: (fraction: number) => void = () => undefined): Promise<PlanFile> {
  const problem = unsendable(blob.size, fileName);
  if (problem) throw problem;
  const contentType = blob.type || typeFromName(fileName) || previous.content_type || "application/octet-stream";
  const path = await resumableUpload({
    path: `${companyId}/plans/${crypto.randomUUID()}.${extensionFor(fileName, contentType)}`,
    file: blob,
    contentType,
    name: fileName,
    onProgress,
  }).promise;
  const { data, error } = await supabase()
    .from("plan_files")
    .insert({
      company_id: companyId,
      property_id: previous.property_id,
      request_id: previous.request_id,
      quote_id: previous.quote_id,
      job_id: previous.job_id,
      folder_id: previous.folder_id,
      replaces_id: previous.id,
      title: previous.title,
      revision: null,
      path,
      file_name: fileName.slice(0, 255),
      content_type: contentType.slice(0, 150),
      size_bytes: blob.size,
      crew_visible: previous.crew_visible,
    })
    .select(PLAN_FIELDS)
    .single();
  // The stored file stays behind on a refusal; the nightly tidy-up takes it away after a day.
  if (error) throw versionRefused(error);
  return data as unknown as PlanFile;
}

/** The database's own sentences ("A newer version of Site plan was already added…") as they are. */
function versionRefused(error: { message: string; code?: string; details?: string | null; hint?: string | null }): Error {
  if (/newer version|in the Trash/i.test(error.message)) return new ApiError(error.message, 409, error.code);
  return friendlyDbError(error);
}

/**
 * Sends a file on a one-time upload link (a booking form's files: the visitor isn't signed in).
 * Resolves with the path the link is for.
 */
export function uploadToLink(link: { path: string; token: string }, file: File, onProgress: (fraction: number) => void): Upload {
  const problem = unsendable(file.size, file.name);
  if (problem) return refused(problem);
  return sendWhole(file, file.type || "application/octet-stream", file.name, onProgress, async () => {
    const config = await loadConfig();
    const url = `${config.supabaseUrl}/storage/v1/object/upload/sign/files/${link.path}?token=${encodeURIComponent(link.token)}`;
    return { method: "PUT", url, headers: { apikey: config.supabaseKey }, path: link.path };
  });
}
