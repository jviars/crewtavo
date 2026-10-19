/**
 * Plans and files: plan sets, specs, permits and addenda on quotes, jobs and properties
 * (public.plan_files; supabase/migrations/20261019001700_plan_files.sql explains the rules). Files
 * go to the private files bucket at <company>/plans/<uuid>.<ext>, uploaded as they are: never
 * shrunk, since a plan sheet has to stay readable.
 */
import { useQuery } from "@tanstack/react-query";
import { loadConfig, supabase } from "@/lib/api";
import { formatDate } from "@/lib/format";

export interface PlanFile {
  id: string;
  property_id: string | null;
  request_id: string | null;
  quote_id: string | null;
  job_id: string | null;
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
}
export const PLAN_FIELDS =
  "id, property_id, request_id, quote_id, job_id, title, revision, notes, path, file_name, content_type, size_bytes, crew_visible, archived, replaces_id, superseded_at, created_by, created_at";

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

/** A file too big to send: over 200 MB (`fromServer` false), or over the server's own, lower limit. */
export class TooLargeError extends Error {
  constructor(message: string, readonly fromServer = false) {
    super(message);
  }
}

function extensionOf(file: File): string {
  const fromName = file.name.match(/\.([a-z0-9]{1,8})$/i)?.[1]?.toLowerCase();
  if (fromName) return fromName;
  if (file.type === "application/pdf") return "pdf";
  if (file.type.startsWith("image/")) return file.type.slice(6).replace(/[^a-z0-9]/g, "").slice(0, 8) || "img";
  return "bin";
}

export interface Upload {
  promise: Promise<string>;
  abort: () => void;
}

/**
 * Sends a file to <company>/plans/ as it is, reporting progress (0 to 1). Resolves with its storage
 * path. Straight to Storage like supabase-js does, but over XMLHttpRequest so big plan sets can
 * show how far along they are. Storage's own limit (FILE_SIZE_LIMIT) still applies.
 */
export function uploadPlanFile(companyId: string, file: File, onProgress: (fraction: number) => void): Upload {
  const path = `${companyId}/plans/${crypto.randomUUID()}.${extensionOf(file)}`;
  return sendFile(file, onProgress, async () => {
    const config = await loadConfig();
    const token = (await supabase().auth.getSession()).data.session?.access_token;
    if (!token) throw new Error("You're signed out. Sign in again, then add the file.");
    return { method: "POST", url: `${config.supabaseUrl}/storage/v1/object/files/${path}`, headers: { Authorization: `Bearer ${token}`, apikey: config.supabaseKey }, path };
  });
}

/**
 * Sends a file on a one-time upload link (a booking form's files: the visitor isn't signed in).
 * Resolves with the path the link is for.
 */
export function uploadToLink(link: { path: string; token: string }, file: File, onProgress: (fraction: number) => void): Upload {
  return sendFile(file, onProgress, async () => {
    const config = await loadConfig();
    const url = `${config.supabaseUrl}/storage/v1/object/upload/sign/files/${link.path}?token=${encodeURIComponent(link.token)}`;
    return { method: "PUT", url, headers: { apikey: config.supabaseKey }, path: link.path };
  });
}

function sendFile(file: File, onProgress: (fraction: number) => void, target: () => Promise<{ method: string; url: string; headers: Record<string, string>; path: string }>): Upload {
  const xhr = new XMLHttpRequest();
  let aborted = false;
  const promise = (async () => {
    if (file.size > PLAN_MAX_BYTES) throw new TooLargeError(`${file.name} is larger than ${fileSize(PLAN_MAX_BYTES)}.`);
    if (file.size === 0) throw new Error(`${file.name} is empty.`);
    const { method, url, headers, path } = await target();
    await new Promise<void>((resolve, reject) => {
      if (aborted) return reject(new DOMException("Stopped", "AbortError"));
      xhr.open(method, url);
      for (const [name, value] of Object.entries(headers)) xhr.setRequestHeader(name, value);
      xhr.setRequestHeader("x-upsert", "false");
      xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) return resolve();
        let message = "";
        try {
          message = String((JSON.parse(xhr.responseText) as { message?: string; error?: string }).message ?? "");
        } catch {
          message = xhr.responseText.slice(0, 200);
        }
        if (xhr.status === 413 || /maximum allowed size|too large/i.test(message)) {
          reject(new TooLargeError(`${file.name} (${fileSize(file.size)}) is bigger than this Crewtavo accepts.`, true));
        } else if (xhr.status === 401 || xhr.status === 403 || /row-level security|unauthorized/i.test(message)) {
          reject(new Error("You don't have permission to add files here."));
        } else reject(new Error(`Upload failed${message ? `: ${message}` : ""}. Try again.`));
      };
      xhr.onerror = () => reject(new Error("The upload stopped. Check the connection and try again."));
      xhr.onabort = () => reject(new DOMException("Stopped", "AbortError"));
      // As a form, the way supabase-js sends a file: Storage checks a form's file against its size
      // limit as it arrives.
      const form = new FormData();
      form.append("cacheControl", "3600");
      form.append("", file, file.name);
      xhr.send(form);
    });
    onProgress(1);
    return path;
  })();
  return {
    promise,
    abort: () => {
      aborted = true;
      xhr.abort();
    },
  };
}

export const isAbort = (error: unknown) => error instanceof DOMException && error.name === "AbortError";
