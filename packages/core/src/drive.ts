/**
 * Crewtavo - Drive (Apps → Crewtavo - Drive): every file in one place. Drive's files are plan files
 * (public.plan_files, supabase/migrations/20261028000300_drive.sql), stored at
 * <company>/plans/<uuid>.<ext>: in a company folder, or on a client's property, request, quote or
 * job. A file someone deletes, in Drive or anywhere else in Crewtavo, waits in the Trash for
 * TRASH_DAYS before the server's nightly purge deletes it for good (apps/api/src/tasks.ts, "trash").
 *
 * Files from Google Drive come in through the API (apps/api/src/routes/drive.ts): a file as it is,
 * and Google's own documents, which have no file to download, converted the way GOOGLE_EXPORTS says.
 */

/** How long a deleted file waits in the Trash before it's deleted for good. */
export const TRASH_DAYS = 30;

/**
 * What Restore does with an item in the Trash, for the person looking (public.drive_trash's restore):
 *   back      it goes back where it was (always, for Drive's own files, versions and folders)
 *   drive     where it was is gone, so it's copied into Company files (the office; never paperwork,
 *             résumés or receipts)
 *   download  where it was is gone, and it can't go into Drive for them: they download it instead
 *   none      nothing they can do with it
 */
export type TrashRestore = "back" | "drive" | "download" | "none";

const DAY_MS = 24 * 60 * 60 * 1000;

const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const PPTX = "application/vnd.openxmlformats-officedocument.presentationml.presentation";

/**
 * Google's own documents (Docs, Sheets, Slides, Drawings) have no file behind them: Google converts
 * each to a file people can open anywhere. Docs become Word documents and Sheets Excel workbooks, so
 * they stay editable; Slides become a PDF and Drawings a picture. Google converts up to 10 MB.
 */
export const GOOGLE_EXPORTS: Readonly<Record<string, { mime: string; ext: string }>> = {
  "application/vnd.google-apps.document": { mime: DOCX, ext: "docx" },
  "application/vnd.google-apps.spreadsheet": { mime: XLSX, ext: "xlsx" },
  "application/vnd.google-apps.presentation": { mime: "application/pdf", ext: "pdf" },
  "application/vnd.google-apps.drawing": { mime: "image/png", ext: "png" },
};

/** Extensions for files whose name doesn't have one, by their type. */
const EXTENSIONS: Readonly<Record<string, string>> = {
  "application/pdf": "pdf",
  [DOCX]: "docx",
  [XLSX]: "xlsx",
  [PPTX]: "pptx",
  "application/msword": "doc",
  "application/vnd.ms-excel": "xls",
  "application/vnd.ms-powerpoint": "ppt",
  "application/rtf": "rtf",
  "application/zip": "zip",
  "application/json": "json",
  "text/plain": "txt",
  "text/csv": "csv",
  "text/markdown": "md",
  "text/html": "html",
  "image/jpeg": "jpg",
  "image/svg+xml": "svg",
  "image/tiff": "tif",
};

/**
 * The extension a stored file gets (the stored path must end in one: lowercase, 1 to 8 letters and
 * digits): the name's own, else one for its type, else "bin".
 */
export function extensionFor(name: string, mime?: string | null): string {
  const own = name.trim().match(/\.([a-z0-9]{1,8})$/i)?.[1];
  if (own) return own.toLowerCase();
  const type = (mime ?? "").toLowerCase().split(";")[0]!.trim();
  const known = EXTENSIONS[type] ?? GOOGLE_EXPORTS[type]?.ext;
  if (known) return known;
  if (type.startsWith("image/")) {
    const subtype = type.slice(6).replace(/[^a-z0-9]/g, "").slice(0, 8);
    if (subtype) return subtype;
  }
  return "bin";
}

/** A file's title from its name: without the extension, underscores as spaces, up to 200 characters. */
export function fileTitle(name: string): string {
  const base = name.replace(/\.[a-z0-9]{1,8}$/i, "").replace(/_+/g, " ").replace(/\s+/g, " ").trim();
  return base.slice(0, 200).trim() || "Untitled";
}

/** When something in the Trash is deleted for good. */
export function trashPurgeAt(deletedAt: string | Date): Date {
  const from = typeof deletedAt === "string" ? Date.parse(deletedAt) : deletedAt.getTime();
  return new Date(from + TRASH_DAYS * DAY_MS);
}
