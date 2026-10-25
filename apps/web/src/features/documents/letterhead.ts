/**
 * The business's own letterhead, for an estimate template (Settings → Estimate template). The first
 * page of a PDF of its stationery, or a picture of it, is drawn on white, and the paper of a photo
 * or scan is made white too (whitenPaper), so it doesn't print as a gray box; Crewtavo suggests where
 * the printed top ends and the printed bottom starts; the person moves those lines if they like;
 * and the two bands are cut into PNGs and uploaded (PUT /api/templates/letterhead, which keeps each
 * for good). Each band loses the blank paper along its edges, up to the 0.4 in the printed page
 * leaves (PrintableDocument), so it prints where it sits on the stationery and at the same size.
 */
import { LETTERHEAD_MAX_PIXELS, type LetterheadPicture } from "@crewtavo/core/documents";
import { api } from "@/lib/api";
import { base64Of } from "@/lib/files";
import { loadPdfJs } from "@/lib/pdf";

/** Pixels per inch a PDF is drawn at: sharp on paper, and a band of a letter page is a few hundred KB. */
export const LETTERHEAD_DPI = 200;
/** A letter page is 8.5 in wide; a picture of one is taken to be that wide. */
const PAGE_WIDTH_IN = 8.5;
/** The printed page's margin (PrintableDocument). */
const PRINT_MARGIN_IN = 0.4;
/** What the API takes (services/letterhead.ts); a bigger band is made smaller. */
const MAX_BYTES = 1_400_000;
/** A band shorter than this (about a line of small print) is none at all. */
const MIN_BAND_IN = 0.15;

/** Where the header ends and the footer starts, in pixels from the top: 0 for no header, the page's height for no footer. */
export interface LetterheadBands {
  headerEnd: number;
  footerStart: number;
}

export interface LetterheadPage {
  /** The page on white, its paper made white. */
  canvas: HTMLCanvasElement;
  /** Its pixels per inch. */
  dpi: number;
  /** Where Crewtavo suggests the header ends and the footer starts. */
  bands: LetterheadBands;
  /** A photo that still isn't a clean page with its paper made white (roughPage): a PDF or a scan would print better. */
  rough: boolean;
}

/** The pictures cut from a letterhead, ready to go on a template. */
export interface LetterheadPictures {
  header: LetterheadPicture | null;
  footer: LetterheadPicture | null;
}

const isPdfFile = (file: File) => file.type === "application/pdf" || /\.pdf$/i.test(file.name);

/** Whether a pixel is printing rather than paper (once the paper is white: whitenPaper): anything a little darker than white. */
const INK = 232;

/** Paper at least this white in every channel is left as it is: a PDF from Word, a design file, a clean scan. */
const WHITE_PAPER = 245;
/** Of the paper's own white, as light as this or lighter prints as white paper (the levels a scanner app sets). */
const WHITE_POINT = 0.92;
/** A patch darker than this much of the lightest paper near it is printing (a logo, a band of color, the table around a photo), not paper. */
const PAPER_NEAR = 0.9;
/** Nor is a patch darker than this much of the page's lightest (the inside of a big dark logo or band). */
const PAPER_FLOOR = 0.6;
/** How far around a patch to look for the paper near it, in patches (about 1.5 in). */
const NEAR = 3;

/**
 * A photo or scan of the stationery with its paper made white, so it prints as white paper rather
 * than a gray (or cream) box around the letterhead, and the printing on it is found the same as on
 * a PDF. The paper's white is found in patches about half an inch square (each one's lightest, but
 * for specks), taken from the patches around it where a patch is all printing, and smoothed; each
 * pixel is then lightened by the paper's white where it is, so light that falls unevenly or warmly
 * on a photo comes out white everywhere. Paper that's white already is left as it is, light tints
 * printed on it included.
 *
 * Changes `data` (RGBA). Returns how light the paper was (its darkest channel, 0 to 255), or null
 * when it was white already and nothing changed.
 */
export function whitenPaper(data: Uint8ClampedArray, width: number, height: number, dpi: number): number | null {
  const size = Math.max(8, Math.round(dpi / 2));
  const cols = Math.ceil(width / size);
  const rows = Math.ceil(height / size);
  const tiles = cols * rows;
  // Each patch's white, a channel at a time: its lightest, past the lightest 5% (specks and glare).
  const white = new Float32Array(tiles * 3);
  const histogram = new Uint32Array(768);
  for (let ty = 0; ty < rows; ty++) {
    for (let tx = 0; tx < cols; tx++) {
      histogram.fill(0);
      const x0 = tx * size;
      const x1 = Math.min(width, x0 + size);
      const y1 = Math.min(height, (ty + 1) * size);
      for (let y = ty * size; y < y1; y++) {
        for (let x = x0, i = (y * width + x0) * 4; x < x1; x++, i += 4) {
          histogram[data[i]!]++;
          histogram[256 + data[i + 1]!]++;
          histogram[512 + data[i + 2]!]++;
        }
      }
      const skip = Math.floor((x1 - x0) * (y1 - ty * size) * 0.05);
      for (let c = 0; c < 3; c++) {
        let v = 255;
        for (let seen = 0; v > 0; v--) if ((seen += histogram[c * 256 + v]!) > skip) break;
        white[(ty * cols + tx) * 3 + c] = v;
      }
    }
  }

  // Patches much darker than the paper near them, or than the page's lightest, are printing.
  const level = (t: number) => Math.min(white[t * 3]!, white[t * 3 + 1]!, white[t * 3 + 2]!);
  const levels = Array.from({ length: tiles }, (_, t) => level(t)).sort((a, b) => a - b);
  const lightest = levels[Math.floor((tiles - 1) * 0.95)]!;
  let known = new Uint8Array(tiles);
  for (let ty = 0; ty < rows; ty++) {
    for (let tx = 0; tx < cols; tx++) {
      let near = 0;
      for (let y = Math.max(0, ty - NEAR); y <= Math.min(rows - 1, ty + NEAR); y++) for (let x = Math.max(0, tx - NEAR); x <= Math.min(cols - 1, tx + NEAR); x++) near = Math.max(near, level(y * cols + x));
      const here = level(ty * cols + tx);
      known[ty * cols + tx] = here >= PAPER_NEAR * near && here >= PAPER_FLOOR * lightest ? 1 : 0;
    }
  }
  // The paper as it is: white already when a patch of it in four is (a photo's never is; light tints on white paper are printing).
  const paper = Array.from({ length: tiles }, (_, t) => t)
    .filter((t) => known[t])
    .map(level)
    .sort((a, b) => a - b);
  if (!paper.length || paper[Math.floor((paper.length - 1) * 0.75)]! >= WHITE_PAPER) return null;

  // The printing's paper comes from the patches around it.
  for (let filled = true; filled && known.includes(0); ) {
    filled = false;
    const next = known.slice();
    for (let t = 0; t < tiles; t++) {
      if (known[t]) continue;
      const sum = [0, 0, 0];
      let count = 0;
      const tx = t % cols;
      const ty = (t - tx) / cols;
      for (let y = Math.max(0, ty - 1); y <= Math.min(rows - 1, ty + 1); y++) {
        for (let x = Math.max(0, tx - 1); x <= Math.min(cols - 1, tx + 1); x++) {
          if (!known[y * cols + x]) continue;
          for (let c = 0; c < 3; c++) sum[c] += white[(y * cols + x) * 3 + c]!;
          count++;
        }
      }
      if (!count) continue;
      for (let c = 0; c < 3; c++) white[t * 3 + c] = sum[c] / count;
      next[t] = 1;
      filled = true;
    }
    known = next;
  }

  // Smoothed, so the light changes gently from patch to patch.
  const smooth = new Float32Array(tiles * 3);
  for (let ty = 0; ty < rows; ty++) {
    for (let tx = 0; tx < cols; tx++) {
      for (let c = 0; c < 3; c++) {
        let sum = 0;
        let count = 0;
        for (let y = Math.max(0, ty - 1); y <= Math.min(rows - 1, ty + 1); y++) {
          for (let x = Math.max(0, tx - 1); x <= Math.min(cols - 1, tx + 1); x++) {
            sum += white[(y * cols + x) * 3 + c]!;
            count++;
          }
        }
        smooth[(ty * cols + tx) * 3 + c] = Math.max(1, sum / count);
      }
    }
  }

  // Each pixel lightened by the paper's white where it is, between the middles of the patches around it.
  const between = (at: number, count: number) => {
    const g = Math.min(Math.max((at + 0.5) / size - 0.5, 0), count - 1);
    const from = Math.min(Math.floor(g), count - 1);
    return { from, to: Math.min(from + 1, count - 1), f: g - from };
  };
  const across = Array.from({ length: width }, (_, x) => between(x, cols));
  const row = new Float32Array(cols * 3);
  for (let y = 0; y < height; y++) {
    const down = between(y, rows);
    for (let i = 0; i < cols * 3; i++) row[i] = smooth[down.from * cols * 3 + i]! * (1 - down.f) + smooth[down.to * cols * 3 + i]! * down.f;
    for (let x = 0, i = y * width * 4; x < width; x++, i += 4) {
      const { from, to, f } = across[x]!;
      for (let c = 0; c < 3; c++) {
        const paperHere = row[from * 3 + c]! * (1 - f) + row[to * 3 + c]! * f;
        data[i + c] = (data[i + c]! * 255) / (WHITE_POINT * paperHere);
      }
    }
  }
  return paper[Math.floor((paper.length - 1) / 2)]!;
}

/**
 * Whether a picture whose paper was made white (whitenPaper) still isn't a clean page of stationery:
 * the paper was very dark, or there's printing across most of the page (the table around a photo
 * of the sheet, say). Never for a PDF or a picture whose paper was white already (`paper` null).
 */
export function roughPage(paper: number | null, ink: ArrayLike<number>): boolean {
  if (paper === null) return false;
  let printed = 0;
  for (let y = 0; y < ink.length; y++) if (ink[y]) printed++;
  return paper < 170 || printed > ink.length * 0.6;
}

/** For each row of the picture, whether anything is printed on it (scanner specks aside). */
export function inkRows(data: Uint8ClampedArray, width: number, height: number): Uint8Array {
  const rows = new Uint8Array(height);
  const specks = Math.max(2, Math.round(width / 1000));
  for (let y = 0; y < height; y++) {
    let count = 0;
    for (let x = 0, i = y * width * 4; x < width; x++, i += 4) {
      if (Math.min(data[i]!, data[i + 1]!, data[i + 2]!) < INK && ++count >= specks) break;
    }
    rows[y] = count >= specks ? 1 : 0;
  }
  return rows;
}

/**
 * Where a letterhead's printed top ends and its printed bottom starts, from which rows have
 * printing (inkRows). The top is the first block of printing, up to a third of an inch of blank
 * paper, within the top 40% of the page; the bottom is the last block, within the bottom 30%. A
 * picture wider than it is tall by more than 2 to 1 is taken to be the top alone.
 */
export function suggestBands(ink: ArrayLike<number>, width: number, dpi: number): LetterheadBands {
  const height = ink.length;
  if (width > height * 2) return { headerEnd: height, footerStart: height };
  const gap = Math.round(0.33 * dpi);
  const pad = Math.round(0.1 * dpi);
  const block = (from: number, to: number, step: 1 | -1) => {
    let last = -1;
    for (let y = from; y !== to; y += step) {
      if (ink[y]) last = y;
      else if (last >= 0 && Math.abs(y - last) >= gap) break;
    }
    return last;
  };
  const topLimit = Math.round(height * 0.4);
  const bottomLimit = Math.round(height * 0.7);
  const top = block(0, topLimit, 1);
  const bottom = block(height - 1, bottomLimit, -1);
  return {
    headerEnd: top < 0 ? 0 : Math.min(top + 1 + pad, topLimit),
    footerStart: bottom < 0 ? height : Math.max(bottom - pad, bottomLimit),
  };
}

/** The first page of a PDF, or a picture, drawn on white with its paper made white and the bands Crewtavo suggests. Null when it can't be opened. */
export async function readLetterhead(file: File): Promise<LetterheadPage | null> {
  try {
    const canvas = document.createElement("canvas");
    let dpi: number;
    if (isPdfFile(file)) {
      const lib = await loadPdfJs();
      const task = lib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) });
      try {
        const page = await (await task.promise).getPage(1);
        const base = page.getViewport({ scale: 1 }); // in points, 72 to the inch
        const scale = Math.min(LETTERHEAD_DPI / 72, LETTERHEAD_MAX_PIXELS / Math.max(base.width, base.height));
        const viewport = page.getViewport({ scale });
        canvas.width = Math.round(viewport.width);
        canvas.height = Math.round(viewport.height);
        await page.render({ canvas, viewport, background: "#ffffff" }).promise;
        dpi = scale * 72;
      } finally {
        void task.destroy();
      }
    } else {
      // An <img> opens SVGs too, which createImageBitmap doesn't.
      const url = URL.createObjectURL(file);
      try {
        const image = new Image();
        image.src = url;
        await image.decode();
        const vector = file.type === "image/svg+xml" || /\.svg$/i.test(file.name);
        const natural = image.naturalWidth || 1700;
        // Never larger than it is (a vector, as sharp as a PDF), nor than a letter page at 200 dpi.
        const width = Math.min(vector ? Infinity : natural, PAGE_WIDTH_IN * LETTERHEAD_DPI);
        const scale = width / natural;
        canvas.width = Math.max(1, Math.round(width));
        canvas.height = Math.max(1, Math.min(LETTERHEAD_MAX_PIXELS, Math.round((image.naturalHeight || 2200) * scale)));
        const ctx = canvas.getContext("2d")!;
        // A see-through picture prints on white paper.
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(image, 0, 0, canvas.width, Math.round((image.naturalHeight || 2200) * scale));
        dpi = canvas.width / PAGE_WIDTH_IN;
      } finally {
        URL.revokeObjectURL(url);
      }
    }
    const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
    const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height);
    // The paper of a photo or scan made white before anything reads the page, so the dialog shows what prints.
    const paper = whitenPaper(pixels.data, canvas.width, canvas.height, dpi);
    if (paper !== null) ctx.putImageData(pixels, 0, 0);
    const ink = inkRows(pixels.data, canvas.width, canvas.height);
    return { canvas, dpi, bands: suggestBands(ink, canvas.width, dpi), rough: roughPage(paper, ink) };
  } catch {
    return null; // not a PDF or picture, a locked PDF, or HEIC in a browser that can't open it
  }
}

/**
 * How much blank paper comes off a band: the same at the left and right (so it stays centered) and
 * at its outer edge (the top of the header, the bottom of the footer), each up to the print margin.
 */
export function blankEdges(data: Uint8ClampedArray, width: number, height: number, margin: number, outer: "top" | "bottom"): { side: number; outer: number } {
  const printed = (x: number, y: number) => {
    const i = (y * width + x) * 4;
    return Math.min(data[i]!, data[i + 1]!, data[i + 2]!) < INK;
  };
  const columnBlank = (x: number) => {
    for (let y = 0; y < height; y++) if (printed(x, y)) return false;
    return true;
  };
  const rowBlank = (y: number) => {
    for (let x = 0; x < width; x++) if (printed(x, y)) return false;
    return true;
  };
  let left = 0;
  while (left < margin && left < width / 2 && columnBlank(left)) left++;
  let right = 0;
  while (right < margin && right < width / 2 && columnBlank(width - 1 - right)) right++;
  let edge = 0;
  while (edge < margin && edge < height - 1 && rowBlank(outer === "top" ? edge : height - 1 - edge)) edge++;
  return { side: Math.min(left, right), outer: edge };
}

function toPng(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Couldn't make a picture of the letterhead."))), "image/png"));
}

/** One band of the page as a PNG, its blank edges cut off, made smaller until the API takes it. */
async function cutBand(page: LetterheadPage, top: number, bottom: number, outer: "top" | "bottom"): Promise<{ png: Blob; width: number; height: number } | null> {
  const { canvas, dpi } = page;
  if (bottom - top < MIN_BAND_IN * dpi) return null;
  const { data } = canvas.getContext("2d", { willReadFrequently: true })!.getImageData(0, top, canvas.width, bottom - top);
  const edges = blankEdges(data, canvas.width, bottom - top, Math.round(PRINT_MARGIN_IN * dpi), outer);
  const sx = edges.side;
  const sw = canvas.width - 2 * edges.side;
  const sy = outer === "top" ? top + edges.outer : top;
  const sh = bottom - top - edges.outer;
  if (sh < MIN_BAND_IN * dpi) return null;
  for (const scale of [1, 0.75, 0.5]) {
    const out = document.createElement("canvas");
    out.width = Math.round(sw * scale);
    out.height = Math.round(sh * scale);
    const ctx = out.getContext("2d")!;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(canvas, sx, sy, sw, sh, 0, 0, out.width, out.height);
    const png = await toPng(out);
    const size = { width: out.width, height: out.height };
    out.width = out.height = 0; // hand the memory back
    if (png.size <= MAX_BYTES) return { png, ...size };
  }
  throw new Error("That letterhead is too detailed to use. Try a simpler PDF or picture of it.");
}

async function upload(band: { png: Blob } | null): Promise<LetterheadPicture | null> {
  if (!band) return null;
  return api.put<LetterheadPicture>("/templates/letterhead", { picture: await base64Of(band.png) });
}

/** Cuts the header and footer out of the page where the lines are, and uploads them. */
export async function saveLetterhead(page: LetterheadPage, bands: LetterheadBands): Promise<LetterheadPictures> {
  const height = page.canvas.height;
  const [header, footer] = await Promise.all([
    cutBand(page, 0, Math.min(bands.headerEnd, height), "top"),
    cutBand(page, Math.max(bands.footerStart, 0), height, "bottom"),
  ]);
  if (!header && !footer) throw new Error("Move the lines to take in your letterhead's top, its bottom, or both.");
  const [h, f] = await Promise.all([upload(header), upload(footer)]);
  return { header: h, footer: f };
}
