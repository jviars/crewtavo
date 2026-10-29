/**
 * The file viewer's shared parts: which files it can show or edit, fetching a file's bytes with
 * progress, and the sums behind panning and zooming a picture. Importing this touches nothing on the
 * page, so the viewer's entry (FileViewer.tsx) stays small and the unit tests can load it.
 */

/** A stored file the viewer can open: a plan_files row, or the fields of one Drive lists. */
export interface ViewerFile {
  id: string;
  company_id: string;
  path: string;
  title: string;
  file_name: string;
  content_type: string | null;
  size_bytes: number | null;
  revision?: string | null;
  crew_visible: boolean;
  /** Archived: kept for the record, never edited into a new version. */
  archived?: boolean;
  replaces_id?: string | null;
  superseded_at?: string | null;
  created_at?: string;
}

export type PreviewKind = "pdf" | "docx" | "image" | "text";
export type EditKind = "pdf" | "docx";

type Named = { content_type: string | null; file_name: string };

export const DOCX_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

const IMAGE_NAME = /\.(png|jpe?g|gif|webp|avif|bmp|svg|heic|heif|tiff?)$/i;
const TEXT_NAME = /\.(txt|text|csv|tsv|md|markdown|json|log)$/i;
const TEXT_TYPES = new Set(["application/json", "application/csv", "application/x-ndjson"]);

/** Plain text bigger than this isn't shown: a <pre> that long locks up a phone. */
export const TEXT_MAX_BYTES = 1024 * 1024;

const typeOf = (f: Named) => (f.content_type ?? "").split(";")[0]!.trim().toLowerCase();

/** How the viewer shows a file, or null when it can't (it offers a download instead). */
export function previewKind(f: Named): PreviewKind | null {
  const type = typeOf(f);
  const name = f.file_name.toLowerCase();
  if (type === "application/pdf" || name.endsWith(".pdf")) return "pdf";
  if (type === DOCX_TYPE || name.endsWith(".docx")) return "docx";
  if (type.startsWith("image/") || IMAGE_NAME.test(name)) return "image";
  if (type.startsWith("text/") || TEXT_TYPES.has(type) || TEXT_NAME.test(name)) return "text";
  return null;
}

/** Which editor a file opens in: PDFs get markup and form filling, Word documents the docx editor. */
export function editKind(f: Named): EditKind | null {
  const kind = previewKind(f);
  return kind === "pdf" || kind === "docx" ? kind : null;
}

/** What an open editor hands back when it's saved: the whole file, as it now is. */
export interface FileEditor {
  save(): Promise<Blob>;
}

/**
 * A stored file's bytes from its signed link, reporting progress (0 to 1) when the size is known.
 * Read with fetch rather than shown in a frame: the gateway serves Word files as downloads.
 */
export async function fetchBytes(url: string, { signal, onProgress }: { signal?: AbortSignal; onProgress?: (fraction: number) => void } = {}): Promise<ArrayBuffer> {
  const res = await fetch(url, { signal });
  if (!res.ok) {
    throw new Error(res.status === 404 || res.status === 400 ? "This file wasn't found. It may have been moved to the Trash." : "Couldn't open this file. Try again.");
  }
  const total = Number(res.headers.get("content-length")) || 0;
  if (!res.body || !total || !onProgress) return res.arrayBuffer();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.byteLength;
    onProgress(Math.min(1, loaded / total));
  }
  const out = new Uint8Array(loaded);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out.buffer;
}

/** A signed link that saves the file under its own name rather than opening it. */
export const downloadLink = (link: string, fileName: string) => `${link}${link.includes("?") ? "&" : "?"}download=${encodeURIComponent(fileName)}`;

/** Typing in a field (or in a document being edited) keeps Escape and shortcuts for itself. */
export function isTyping(target: EventTarget | null): boolean {
  const el = target as (Element & { isContentEditable?: boolean }) | null;
  if (!el || typeof el.closest !== "function") return false;
  return Boolean(el.isContentEditable) || Boolean(el.closest("input, textarea, select, [contenteditable]:not([contenteditable='false'])"));
}

// ---------------------------------------------------------------------------------------------
// Pan and zoom (pictures)
// ---------------------------------------------------------------------------------------------

export interface Size {
  width: number;
  height: number;
}

/** Where a picture sits: its top-left corner in the stage, and how much it's scaled. */
export interface View {
  x: number;
  y: number;
  scale: number;
}

export const ZOOM_MAX = 8;
export const ZOOM_STEP = 1.25;

export const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** The whole picture in the stage, centered, never blown up past its own size. */
export function fitView(stage: Size, image: Size, margin = 16): View {
  const scale = Math.min(1, (stage.width - margin * 2) / image.width, (stage.height - margin * 2) / image.height);
  const s = scale > 0 && Number.isFinite(scale) ? scale : 1;
  return { scale: s, x: (stage.width - image.width * s) / 2, y: (stage.height - image.height * s) / 2 };
}

/** Smallest zoom: half the fitted size, so a fitted picture can still shrink a little. */
export const minScale = (stage: Size, image: Size) => Math.max(0.02, fitView(stage, image).scale / 2);

/**
 * Keeps the picture in reach: a side smaller than the stage is centered on it, a bigger one can't be
 * dragged so far that blank space shows past its edge.
 */
export function clampView(view: View, stage: Size, image: Size): View {
  const w = image.width * view.scale;
  const h = image.height * view.scale;
  const x = w <= stage.width ? (stage.width - w) / 2 : clamp(view.x, stage.width - w, 0);
  const y = h <= stage.height ? (stage.height - h) / 2 : clamp(view.y, stage.height - h, 0);
  return { scale: view.scale, x, y };
}

/** Zooms by `factor` around a point in the stage, which stays where it is under the finger or pointer. */
export function zoomAt(view: View, factor: number, point: { x: number; y: number }, stage: Size, image: Size): View {
  const scale = clamp(view.scale * factor, minScale(stage, image), ZOOM_MAX);
  const k = scale / view.scale;
  return clampView({ scale, x: point.x - (point.x - view.x) * k, y: point.y - (point.y - view.y) * k }, stage, image);
}
