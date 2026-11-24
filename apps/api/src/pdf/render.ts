/**
 * Drawing an estimate or invoice as a PDF with react-pdf (DocumentPdf.tsx), once its pictures are
 * loaded (services/documentPdf.ts). It takes the processor for as long as it takes, so the server
 * runs it on a thread of its own (worker.ts); it reads nothing but what it's given, and the fonts.
 */
import { inflateSync } from "node:zlib";
import { createElement } from "react";
import { Font, renderToBuffer } from "@react-pdf/renderer";
import type { TemplateSettings } from "@crewtavo/core/documents";
import type { DocumentCompany, DocumentData } from "../../../web/src/features/documents/types";
import { DocumentPdf, type PdfPicture } from "./DocumentPdf";

/**
 * Figtree, then for the letters it doesn't have, its Latin Extended part (Ł, ő, ș) and then Noto
 * Sans for Vietnamese (ễ, ơ, đ): each letter is printed in the first that has it.
 */
export const FONTS = ["Figtree", "Figtree Ext", "Noto Sans"];
let registered = false;

/** The fonts, from `dir` (assets/fonts next to the server, as the review card's are). Words aren't hyphenated. */
export function registerFonts(dir: string) {
  if (registered) return;
  const family = (family: string, file: string, styles: string[]) =>
    Font.register({
      family,
      fonts: styles.map((style) => {
        const [weight, italic] = style.split("-");
        return { src: `${dir}${file}-${style}.woff`, fontWeight: Number(weight), fontStyle: italic === "italic" ? "italic" : "normal" };
      }),
    });
  const figtree = ["400-normal", "400-italic", "500-normal", "600-normal", "700-normal", "700-italic"];
  family("Figtree", "figtree-latin", figtree);
  family("Figtree Ext", "figtree-latin-ext", figtree);
  family("Noto Sans", "noto-sans-vietnamese", ["400-normal", "400-italic", "700-normal", "700-italic"]);
  Font.registerHyphenationCallback((word) => [word]);
  registered = true;
}

/** What to draw: the document as the page sent it, and its pictures by the URL it has for each (null for one left off). */
export interface RenderJob {
  template: TemplateSettings;
  company: DocumentCompany;
  data: DocumentData;
  currency: string;
  timeZone?: string;
  /** The business's country (companies.country), whose way the dates are written. */
  country?: string | null;
  pictures: Array<[string, PdfPicture | null]>;
}

/** Samples in each pixel, by a PNG's color type: gray, RGB, palette, gray and alpha, RGBA. */
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

/**
 * Whether a PNG's pixel data, unpacked, is no bigger than its header says it is. react-pdf unpacks a
 * PNG with transparency (a drawn signature is one) whole: a few KB packed tightly could unpack to
 * gigabytes. So this unpacks it first, stopping at the most its size allows.
 */
export function pngUnpacksToItsSize(bytes: Uint8Array): boolean {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 33) return false;
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  const channels = CHANNELS[bytes[25]!];
  if (!channels || !width || !height) return false;
  const bits = channels * bytes[24]!;
  // Each row's filter byte and samples; an interlaced picture's seven passes add a few bytes a row.
  const most = (Math.ceil((width * bits) / 8) + 1) * height + 4 * height + 64;
  const data: Uint8Array[] = [];
  for (let at = 8; at + 12 <= bytes.length; ) {
    const length = view.getUint32(at);
    const type = String.fromCharCode(bytes[at + 4]!, bytes[at + 5]!, bytes[at + 6]!, bytes[at + 7]!);
    if (at + 12 + length > bytes.length) return false;
    if (type === "IDAT") data.push(bytes.subarray(at + 8, at + 8 + length));
    if (type === "IEND") break;
    at += 12 + length;
  }
  try {
    inflateSync(Buffer.concat(data), { maxOutputLength: most });
    return true;
  } catch {
    return false;
  }
}

/** The PDF, as its bytes. A PNG that unpacks to more than its size is left off, as a picture that didn't load. */
export async function renderDocument(job: RenderJob, fontDir: string): Promise<Uint8Array> {
  registerFonts(fontDir);
  const pictures = new Map<string, PdfPicture | null>();
  for (const [url, picture] of job.pictures) {
    // Bytes that came from another thread are a plain Uint8Array: react-pdf reads a Buffer.
    const data = picture && Buffer.from(picture.src.data.buffer, picture.src.data.byteOffset, picture.src.data.byteLength);
    pictures.set(url, picture && data && (picture.src.format !== "png" || pngUnpacksToItsSize(data)) ? { ...picture, src: { data, format: picture.src.format } } : null);
  }
  const { template, company, data, currency, timeZone, country } = job;
  const pdf = await renderToBuffer(createElement(DocumentPdf, { template, company, data, currency, timeZone, country, pictures, font: FONTS }) as Parameters<typeof renderToBuffer>[0]);
  return new Uint8Array(pdf.buffer, pdf.byteOffset, pdf.byteLength);
}
