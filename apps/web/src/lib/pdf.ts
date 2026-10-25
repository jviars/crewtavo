/**
 * pdf.js, loaded only when a PDF is first opened (it's large): plan sheets on the map, and a
 * business's letterhead in the estimate template builder.
 */
export type PdfModule = typeof import("pdfjs-dist/legacy/build/pdf.mjs");

let pdfjs: Promise<PdfModule> | null = null;
export function loadPdfJs(): Promise<PdfModule> {
  pdfjs ??= Promise.all([import("pdfjs-dist/legacy/build/pdf.mjs"), import("pdfjs-dist/legacy/build/pdf.worker.min.mjs?url")]).then(([lib, worker]) => {
    lib.GlobalWorkerOptions.workerSrc = worker.default;
    return lib;
  }).catch((error) => {
    pdfjs = null;
    throw error;
  });
  return pdfjs;
}
