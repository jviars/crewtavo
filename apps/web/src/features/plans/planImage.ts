/**
 * A plan sheet as a picture the map can show: one page of a PDF drawn with pdf.js (loaded only when
 * a plan goes on the map), or a picture of a plan, scaled to fit a map texture. Also a "lines only"
 * copy with the white paper taken out, so the drawing sits on the aerial instead of covering it.
 */
import { loadPdfJs, type PdfModule } from "@/lib/pdf";
import { isPdf, type PlanFile } from "./plans";

export interface PlanImage {
  /** Object URLs of the sheet, as is and with the paper taken out. Revoke with releasePlanImage. */
  url: string;
  linesUrl: string;
  width: number;
  height: number;
  /** Pixels per inch of the printed sheet (PDFs only; a picture has no printed size). */
  pxPerInch: number | null;
  /** Pages in the PDF (1 for a picture). */
  pages: number;
}

/** Bigger than this is more than many phones' graphics can take as one picture. */
const MAX_SIDE = 4096;

type PdfTask = ReturnType<PdfModule["getDocument"]>;
type PdfDocument = Awaited<PdfTask["promise"]>;

// The PDF stays open while its pages are looked through (by storage path: links change).
const open = new Map<string, Promise<PdfTask>>();
function openPdf(path: string, link: string): Promise<PdfDocument> {
  let task = open.get(path);
  if (!task) {
    // Big plan sets load as needed: pdf.js asks for the parts of the file a page uses.
    task = loadPdfJs().then((lib) => lib.getDocument({ url: link, disableAutoFetch: true }));
    open.set(path, task);
  }
  const doc = task.then((t) => t.promise);
  doc.catch(() => forgetPlanPdf(path));
  return doc;
}

/** Close the open PDF (its link expired, say), so the next page opens it afresh. */
export function forgetPlanPdf(path: string) {
  const task = open.get(path);
  open.delete(path);
  void task?.then((t) => t.destroy()).catch(() => undefined);
}

function toBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Couldn't make a picture of the plan."))), type, quality));
}

/** The dark lines of the sheet with the paper see-through: the lighter a spot, the clearer. */
export function takeOutPaper(data: Uint8ClampedArray): void {
  for (let i = 0; i < data.length; i += 4) {
    const darkness = 255 - Math.min(data[i], data[i + 1], data[i + 2]);
    // Faint scanner grey and paper texture go entirely; real lines stay solid.
    data[i + 3] = darkness < 24 ? 0 : Math.min(255, Math.round(darkness * 1.6));
  }
}

async function finish(canvas: HTMLCanvasElement, pxPerInch: number | null, pages: number): Promise<PlanImage> {
  // Work on a copy held in memory rather than on the graphics card: pdf.js draws on an opaque
  // canvas (which ignores see-through pixels), and saving one on the graphics card as a picture
  // takes seconds. WebP is quick to make; browsers that can't make it make a PNG instead.
  const work = document.createElement("canvas");
  work.width = canvas.width;
  work.height = canvas.height;
  const ctx = work.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(canvas, 0, 0);
  canvas.width = canvas.height = 0;
  // toBlob takes the picture as it is now, so the paper can come out while it's being saved.
  const paper = toBlob(work, "image/webp", 0.95);
  const pixels = ctx.getImageData(0, 0, work.width, work.height);
  takeOutPaper(pixels.data);
  ctx.putImageData(pixels, 0, 0);
  const [paperBlob, linesBlob] = await Promise.all([paper, toBlob(work, "image/webp", 0.95)]);
  work.width = work.height = 0; // hand the memory back
  return { url: URL.createObjectURL(paperBlob), linesUrl: URL.createObjectURL(linesBlob), width: pixels.width, height: pixels.height, pxPerInch, pages };
}

/** One page of a plan as pictures for the map. `link` is a signed link to the file. */
export async function renderPlan(file: Pick<PlanFile, "path" | "content_type" | "file_name">, link: string, page = 1): Promise<PlanImage> {
  const canvas = document.createElement("canvas");
  if (isPdf(file)) {
    const doc = await openPdf(file.path, link);
    const sheet = await doc.getPage(Math.min(Math.max(1, page), doc.numPages));
    const base = sheet.getViewport({ scale: 1 }); // in points, 72 to the inch
    const scale = Math.min(MAX_SIDE / Math.max(base.width, base.height), 6);
    const viewport = sheet.getViewport({ scale });
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    await sheet.render({ canvas, viewport, background: "#ffffff" }).promise;
    return finish(canvas, scale * 72, doc.numPages);
  }
  const res = await fetch(link);
  if (!res.ok) throw new Error("Couldn't load the plan.");
  const bitmap = await createImageBitmap(await res.blob());
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return finish(canvas, null, 1);
}

export function releasePlanImage(image: PlanImage | null | undefined) {
  if (!image) return;
  URL.revokeObjectURL(image.url);
  URL.revokeObjectURL(image.linesUrl);
}
