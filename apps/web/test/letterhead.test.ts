/**
 * The business's own letterhead (features/documents/letterhead.ts): finding its printed top and
 * bottom on a page, the blank paper that comes off each band's edges, and the paper of a photo or
 * scan made white first.
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_TEMPLATE } from "@crewtavo/core/documents";
import { blankEdges, inkRows, roughPage, suggestBands, whitenPaper } from "@/features/documents/letterhead";
import { letterheadSummary } from "@/features/settings/TemplateSettings";

const DPI = 100;

/** A white page `w` × `h` with black boxes [x, y, width, height] printed on it. */
function page(w: number, h: number, boxes: Array<[number, number, number, number]>) {
  const data = new Uint8ClampedArray(w * h * 4).fill(255);
  for (const [bx, by, bw, bh] of boxes) {
    for (let y = by; y < by + bh; y++) for (let x = bx; x < bx + bw; x++) data.set([0, 0, 0, 255], (y * w + x) * 4);
  }
  return data;
}

/** Rows with printing, from row ranges [from, to). */
function rows(height: number, ranges: Array<[number, number]>) {
  const ink = new Uint8Array(height);
  for (const [from, to] of ranges) ink.fill(1, from, to);
  return ink;
}

describe("letterhead bands", () => {
  it("finds the printed rows, ignoring a speck", () => {
    const data = page(200, 10, [[10, 2, 50, 2], [100, 7, 1, 1]]);
    expect(Array.from(inkRows(data, 200, 10))).toEqual([0, 0, 1, 1, 0, 0, 0, 0, 0, 0]);
  });

  it("takes the first block of printing as the header and the last as the footer", () => {
    // A letter page at 100 dpi: a logo and an address line close under it, then the license along the bottom.
    const ink = rows(1100, [[50, 120], [135, 160], [1010, 1040]]);
    expect(suggestBands(ink, 850, DPI)).toEqual({ headerEnd: 170, footerStart: 1000 });
  });

  it("has no header or footer where nothing is printed", () => {
    expect(suggestBands(rows(1100, [[1010, 1040]]), 850, DPI)).toEqual({ headerEnd: 0, footerStart: 1000 });
    expect(suggestBands(rows(1100, [[50, 120]]), 850, DPI)).toEqual({ headerEnd: 130, footerStart: 1100 });
    // Printing in the middle of the page (a watermark) is neither.
    expect(suggestBands(rows(1100, [[500, 600]]), 850, DPI)).toEqual({ headerEnd: 0, footerStart: 1100 });
  });

  it("stops at 40% of the page from the top and 30% from the bottom", () => {
    // A border down the whole page: the lines start at the limits, to be moved by hand.
    expect(suggestBands(rows(1100, [[0, 1100]]), 850, DPI)).toEqual({ headerEnd: 440, footerStart: 770 });
  });

  it("takes a wide, short picture as the header alone", () => {
    expect(suggestBands(rows(200, [[20, 180]]), 1700, DPI)).toEqual({ headerEnd: 200, footerStart: 200 });
  });

  it("cuts blank paper off the sides evenly and off the outer edge, up to the print margin", () => {
    // Printing from x 30 to 170 of 200 and y 25 to 45 of 50, with a 40 px margin.
    const data = page(200, 50, [[30, 25, 140, 20]]);
    expect(blankEdges(data, 200, 50, 40, "top")).toEqual({ side: 30, outer: 25 });
    expect(blankEdges(data, 200, 50, 40, "bottom")).toEqual({ side: 30, outer: 5 });
    // Printing off-center keeps it where it is: only as much comes off each side as the narrower blank.
    expect(blankEdges(page(200, 50, [[10, 0, 140, 50]]), 200, 50, 40, "top")).toEqual({ side: 10, outer: 0 });
    // Never more than the margin, so it prints where it sits on the stationery.
    expect(blankEdges(page(200, 100, [[90, 90, 20, 10]]), 200, 100, 40, "top")).toEqual({ side: 40, outer: 40 });
  });
});

/** A letter page at 100 dpi on `paper` (its color at each point), with black boxes [x, y, width, height] printed on it, and a little noise as a camera has. */
function photo(paper: (x: number, y: number) => [number, number, number], boxes: Array<[number, number, number, number]>, w = 850, h = 1100) {
  const data = new Uint8ClampedArray(w * h * 4);
  let seed = 11;
  const noise = () => ((seed = (seed * 16807) % 2147483647) % 7) - 3;
  const put = (x: number, y: number, [r, g, b]: readonly number[]) => {
    const i = (y * w + x) * 4;
    data[i] = r!;
    data[i + 1] = g!;
    data[i + 2] = b!;
    data[i + 3] = 255;
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b] = paper(x, y);
      put(x, y, [r + noise(), g + noise(), b + noise()]);
    }
  }
  for (const [bx, by, bw, bh] of boxes) {
    for (let y = by; y < by + bh; y++) for (let x = bx; x < bx + bw; x++) put(x, y, [20, 24, 30]);
  }
  return data;
}

describe("a photo or scan of the stationery", () => {
  // A logo and an address line close under it at the top, the license along the bottom.
  const BOXES: Array<[number, number, number, number]> = [[100, 50, 200, 70], [100, 135, 400, 25], [100, 1010, 650, 30]];
  const read = (data: Uint8ClampedArray) => {
    const ink = inkRows(data, 850, 1100);
    return { bands: suggestBands(ink, 850, DPI), header: blankEdges(data.subarray(0, 170 * 850 * 4), 850, 170, 40, "top"), ink };
  };
  const white = read(photo(() => [255, 255, 255], BOXES));
  const at = (data: Uint8ClampedArray, x: number, y: number) => Array.from(data.subarray((y * 850 + x) * 4, (y * 850 + x) * 4 + 3));

  it("finds the same top and bottom on gray, cream or unevenly lit paper as on white, once its paper is made white", () => {
    expect(white.bands).toEqual({ headerEnd: 170, footerStart: 1000 });
    const papers: Record<string, (x: number, y: number) => [number, number, number]> = {
      "gray paper": () => [222, 222, 222],
      "warm light": () => [232, 226, 205],
      "light from one side": (_, y) => {
        const v = Math.round(190 + (40 * y) / 1100);
        return [v, v, v];
      },
    };
    for (const [name, paper] of Object.entries(papers)) {
      const data = photo(paper, BOXES);
      // Unchanged, the paper reads as printing all the way down: the lines go to their limits.
      expect(suggestBands(inkRows(data, 850, 1100), 850, DPI), name).toEqual({ headerEnd: 440, footerStart: 770 });
      expect(whitenPaper(data, 850, 1100, DPI), name).toBeLessThan(245);
      const { bands, header, ink } = read(data);
      expect(bands, name).toEqual(white.bands);
      expect(header, name).toEqual(white.header);
      expect(roughPage(222, ink), name).toBe(false);
      // The paper is white paper now, and the printing is still printing.
      expect(at(data, 600, 600), name).toEqual([255, 255, 255]);
      expect(at(data, 20, 1090), name).toEqual([255, 255, 255]);
      expect(Math.max(...at(data, 150, 80)), name).toBeLessThan(60);
    }
  });

  it("leaves paper that's white already as it is, with the light tints printed on it", () => {
    // A light gray band across half the page, between the top and the bottom.
    const data = photo(() => [254, 254, 254], BOXES);
    data.fill(236, 200 * 850 * 4, 750 * 850 * 4);
    const before = Buffer.from(data);
    expect(whitenPaper(data, 850, 1100, DPI)).toBeNull();
    expect(before.equals(Buffer.from(data))).toBe(true);
    expect(roughPage(null, inkRows(data, 850, 1100))).toBe(false);
    // A design with a dark band down a third of the page is still white paper.
    const banded = photo((x) => (x < 280 ? [20, 40, 90] : [255, 255, 255]), BOXES);
    const plain = Buffer.from(banded);
    expect(whitenPaper(banded, 850, 1100, DPI)).toBeNull();
    expect(plain.equals(Buffer.from(banded))).toBe(true);
  });

  it("says when a photo still isn't a clean page: the table around the sheet, or very dark paper", () => {
    // The sheet 50 px in from each side of the picture, on a dark table.
    const desk = photo((x, y) => (x < 50 || x >= 800 || y < 50 || y >= 1050 ? [90, 70, 55] : [222, 222, 222]), BOXES);
    const paper = whitenPaper(desk, 850, 1100, DPI);
    expect(roughPage(paper, inkRows(desk, 850, 1100))).toBe(true);
    const dark = photo(() => [150, 150, 150], BOXES);
    expect(roughPage(whitenPaper(dark, 850, 1100, DPI), inkRows(dark, 850, 1100))).toBe(true);
  });
});

describe("the template editor's Letterhead line", () => {
  const picture = (n: number) => ({ path: `00000000-0000-4000-8000-000000000001/letterhead/${n}1111111-1111-4111-8111-111111111111.png`, width: 1540, height: 200 });
  const t = { ...DEFAULT_TEMPLATE, header: "banner" as const };

  it("says which of Crewtavo's header styles prints at the top when the business's own letterhead has no top", () => {
    expect(letterheadSummary({ ...t, letterhead: "custom", letterhead_header: null, letterhead_footer: picture(2) }, "Brand color")).toBe("Banner header · Your letterhead's bottom · Brand color · Modern lettering");
    expect(letterheadSummary({ ...t, letterhead: "custom", letterhead_header: picture(1), letterhead_footer: picture(2) }, "Brand color")).toBe("Your own letterhead · Brand color · Modern lettering");
    expect(letterheadSummary({ ...t, letterhead: "custom", letterhead_header: null, letterhead_footer: null }, "Brand color")).toBe("Your own letterhead, not uploaded yet");
    expect(letterheadSummary({ ...t, letterhead: "built_in", letterhead_header: picture(1), font: "classic" }, "Navy")).toBe("Banner · Navy · Classic lettering");
  });
});
