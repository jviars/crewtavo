/**
 * The PDF of an estimate or invoice, made on the server (services/documentPdf.ts, pdf/DocumentPdf.tsx,
 * routes/documentPdf.ts) and read back with pdf.js: its sheets, the words on each, where the
 * business's own letterhead lands, and where its pictures may come from. Storage and the rate limit
 * are stand-ins.
 */
import { createRequire } from "node:module";
import { crc32, deflateSync } from "node:zlib";
import { DEFAULT_TEMPLATE, templateSettings, type TemplateSettings } from "@crewtavo/core/documents";
import { getDocument, OPS } from "pdfjs-dist/legacy/build/pdf.mjs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DocumentCompany, DocumentData } from "../../web/src/features/documents/types";
import type { Env } from "../src/env";
import { assetDir } from "../src/lib/reviewCard";

const stored = vi.hoisted(() => ({ files: new Map<string, Uint8Array>(), asked: [] as string[], broken: false, reported: [] as unknown[] }));
vi.mock("../src/lib/storedFile", () => ({
  storedFile: async (_admin: unknown, path: string) => {
    stored.asked.push(path);
    if (stored.broken) throw new Error("Storage is down");
    return stored.files.get(path) ?? null;
  },
}));
vi.mock("../src/lib/monitoring", async (original) => ({ ...(await original<typeof import("../src/lib/monitoring")>()), reportError: (error: unknown) => stored.reported.push(error) }));
vi.mock("../src/lib/supabase", async (original) => ({ ...(await original<typeof import("../src/lib/supabase")>()), adminClient: () => ({}) }));
vi.mock("../src/lib/limit", () => ({ allow: async () => true }));

const { documentPdf, knownTimeZone, pictureFor, pictureSize } = await import("../src/services/documentPdf");
const { documentPdfRoutes } = await import("../src/routes/documentPdf");

/** A PNG of `width` × `height` gray pixels. */
function png(width = 1, height = 1): Uint8Array {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 0, 0, 0, 0], 8); // 8-bit gray
  const rows = Buffer.concat(Array.from({ length: height }, () => Buffer.from([0, ...Array(width).fill(128)])));
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
}

const COMPANY_ID = "00000000-0000-4000-8000-000000000001";
const TOP = "11111111-1111-4111-8111-111111111111";
const BOTTOM = "22222222-2222-4222-8222-222222222222";
const env = {} as Env;
const company: DocumentCompany = { name: "Arrington Paving", phone: "(540) 483-5606", email: "info@example.com", website: null, address: ["160 Energy Blvd", "Rocky Mount, VA 24151"], logo: null, settings: {} };
const line = (name: string, total: number, description?: string) => ({ name, description, quantity: 1, unit: "", unit_price: total, total });
const invoice: DocumentData = {
  kind: "invoice",
  number: 1042,
  date: "2026-11-05",
  dueOn: "2026-12-05",
  client: { name: "Alex Morgan", lines: ["1482 Maple Ave", "Springfield, IL 62704"] },
  lines: [line("Asphalt driveway", 4200, "3 in. compacted"), line("Sealcoat", 350), line("Crack fill", 180)],
  subtotal: 4730,
  discount: 0,
  tax: 0,
  total: 4730,
  payments: [],
  balanceDue: 4730,
};
const cut = (file: string, height: number, full: boolean) => ({ path: `${COMPANY_ID}/letterhead/${file}.png`, width: 2550, height, ...(full && { full_sheet: true as const }) });
const ownLetterhead = (full: boolean): Partial<TemplateSettings> => ({ letterhead: "custom", letterhead_header: cut(TOP, 420, full), letterhead_footer: cut(BOTTOM, 300, full) });

beforeEach(() => {
  stored.files.clear();
  stored.asked.length = 0;
  stored.broken = false;
  stored.reported.length = 0;
  stored.files.set(`${COMPANY_ID}/letterhead/${TOP}.png`, png(4, 1));
  stored.files.set(`${COMPANY_ID}/letterhead/${BOTTOM}.png`, png(4, 1));
});

type Box = { left: number; right: number; bottom: number; top: number };
type Sheet = { width: number; height: number; text: string; pictures: Box[]; words: Array<{ str: string; right: number }> };

/** Whether a sheet's words include `words`, spaces aside (pdf.js reads letter-spaced words a letter at a time). */
const has = (sheet: Sheet, words: string) => sheet.text.replace(/\s/g, "").includes(words.replace(/\s/g, ""));

/** Multiplies two PDF matrices: `m` applied first, then `n`. */
const times = (m: number[], n: number[]) => [m[0]! * n[0]! + m[1]! * n[2]!, m[0]! * n[1]! + m[1]! * n[3]!, m[2]! * n[0]! + m[3]! * n[2]!, m[2]! * n[1]! + m[3]! * n[3]!, m[4]! * n[0]! + m[5]! * n[2]! + n[4]!, m[4]! * n[1]! + m[5]! * n[3]! + n[5]!];

/** A PDF read back: each sheet's size, its words, and the box each picture fills (in points, from the bottom left). */
async function read(pdf: Uint8Array): Promise<Sheet[]> {
  const doc = await getDocument({ data: new Uint8Array(pdf), verbosity: 0 }).promise;
  const out: Sheet[] = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const content = await page.getTextContent();
    const ops = await page.getOperatorList();
    const boxes: Box[] = [];
    let matrix = [1, 0, 0, 1, 0, 0];
    const saved: number[][] = [];
    ops.fnArray.forEach((fn, i) => {
      if (fn === OPS.save) saved.push(matrix);
      else if (fn === OPS.restore) matrix = saved.pop() ?? matrix;
      else if (fn === OPS.transform) matrix = times(ops.argsArray[i] as number[], matrix);
      else if (fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject) {
        const corners = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([x, y]) => [matrix[0]! * x! + matrix[2]! * y! + matrix[4]!, matrix[1]! * x! + matrix[3]! * y! + matrix[5]!]);
        boxes.push({ left: Math.min(...corners.map((c) => c[0]!)), right: Math.max(...corners.map((c) => c[0]!)), bottom: Math.min(...corners.map((c) => c[1]!)), top: Math.max(...corners.map((c) => c[1]!)) });
      }
    });
    const [, , width, height] = page.view;
    const words = content.items.flatMap((item) => ("str" in item && item.str.trim() ? [{ str: item.str, right: item.transform[4] + item.width }] : []));
    out.push({ width: width!, height: height!, text: content.items.map((item) => ("str" in item ? item.str : "")).join(" ").replace(/\s+/g, " "), pictures: boxes, words });
  }
  return out;
}

const sheets = async (template: Partial<TemplateSettings>, data: DocumentData = invoice, currency = "USD", timeZone?: string) =>
  read(await documentPdf(env, { template: { ...DEFAULT_TEMPLATE, ...template }, company, data, currency, timeZone }));

const long = { ...invoice, lines: Array.from({ length: 30 }, (_, i) => line(`Item ${i + 1}`, 100, "A line with a description under it")) };

describe("the PDF of an invoice", () => {
  it("is a letter sheet with the letterhead, the client, the lines and the totals", async () => {
    const [page, ...more] = await sheets({});
    expect(more).toEqual([]);
    expect([page!.width, page!.height]).toEqual([612, 792]);
    for (const words of ["Arrington Paving", "BILL TO", "Alex Morgan", "INVOICE", "No. 1042", "Due December 5, 2026", "Asphalt driveway", "$4,200.00", "Balance due $4,730.00", "Page 1 of 1"]) expect(has(page!, words), words).toBe(true);
     // The amounts, the totals' included, end where the words do: 0.4 in and 6 px in from the paper's right edge.
    const edge = 612 - (0.4 * 72 + 6 * 0.75);
    for (const amount of ["$4,200.00", "$4,730.00"]) expect(page!.words.filter((w) => w.str === amount).map((w) => w.right), amount).toEqual(expect.arrayContaining([expect.closeTo(edge, 0)]));
    expect(page!.words.filter((w) => w.str === "$4,730.00").every((w) => Math.abs(w.right - edge) < 1)).toBe(true);
  });

  it("goes on to more sheets, each after the first with the running header, and numbers them", async () => {
    const pages = await sheets({}, long);
    expect(pages.length).toBeGreaterThan(1);
    pages.forEach((page, i) => {
      expect(has(page, `Page ${i + 1} of ${pages.length}`)).toBe(true);
      expect(has(page, "Arrington Paving · Invoice No. 1042 continued")).toBe(i > 0);
      // The lines' head on every sheet the lines go on to, as the pages repeat it.
      if (long.lines.some((l) => page.text.includes(`${l.name} `))) expect(has(page, "DESCRIPTION QTY PRICE AMOUNT"), `sheet ${i + 1}`).toBe(true);
    });
    const all = pages.map((p) => p.text).join(" ");
    expect(long.lines.every((l) => all.includes(`${l.name} `) || all.endsWith(l.name))).toBe(true);
  });

  it("puts the business's own letterhead cut full width on the paper's edges, from its storage", async () => {
    const pages = await sheets(ownLetterhead(true), long);
    expect(stored.asked.sort()).toEqual([`${COMPANY_ID}/letterhead/${TOP}.png`, `${COMPANY_ID}/letterhead/${BOTTOM}.png`].sort());
    pages.forEach((page, i) => {
      const top = page.pictures.find((p) => Math.abs(p.top - 792) < 0.5);
      const bottom = page.pictures.find((p) => Math.abs(p.bottom) < 0.5);
      expect(bottom && [bottom.left, bottom.right, bottom.top]).toEqual([expect.closeTo(0, 1), expect.closeTo(612, 1), expect.closeTo((612 * 300) / 2550, 1)]);
      if (i === 0) expect(top && [top.left, top.right, top.bottom]).toEqual([expect.closeTo(0, 1), expect.closeTo(612, 1), expect.closeTo(792 - (612 * 420) / 2550, 1)]);
      else expect(top).toBeUndefined();
    });
  });

  it("keeps a letterhead cut before inside the 0.4 in margin", async () => {
    const [page] = await sheets(ownLetterhead(false));
    const margin = 0.4 * 72;
    expect(page!.pictures.map((p) => [p.left, p.right])).toEqual([
      [expect.closeTo(margin, 1), expect.closeTo(612 - margin, 1)],
      [expect.closeTo(margin, 1), expect.closeTo(612 - margin, 1)],
    ]);
  });

  it("shows money in the business's currency, and its payments and what's left", async () => {
    const paid = { ...invoice, payments: [{ label: "Paid November 5, 2026", amount: 500 }, { label: "Refunded November 6, 2026", amount: -50 }], balanceDue: 4280 };
    const [page] = await sheets({ footer: "Thank you for your business" }, paid, "CAD");
    for (const words of ["Paid November 5, 2026 −CA$500.00", "Refunded November 6, 2026 +CA$50.00", "Balance due CA$4,280.00", "Thank you for your business"]) expect(has(page!, words), words).toBe(true);
  });

  it("prints a contract section from the blocks the page read, bold words and numbered items included", async () => {
    const section = {
      id: "s1",
      title: "Warranty",
      html: "",
      place: "signatures" as const,
      initials: false,
      blocks: [
        { kind: "p" as const, html: "We stand behind our <strong>workmanship</strong> &amp; materials." },
        { kind: "li" as const, list: "ol" as const, number: 1, html: "Two years on the surface" },
        { kind: "li" as const, list: "ol" as const, number: 2, html: "One year on <em>sealcoat</em>" },
      ],
    };
    const [page] = await sheets({}, { ...invoice, contract: { sections: [section] } });
    for (const words of ["Warranty", "We stand behind our workmanship & materials.", "1. Two years on the surface", "2. One year on sealcoat"]) expect(has(page!, words), words).toBe(true);
  });

  const NAMES = "Łukasz Nguyễn-Peña, Đặng Thị Hương, Søren Ørsted, Zoë Brontë, Ștefan Gărgăriță, Müller Straße";

  it("has a font with every letter of a name with accents, Vietnamese's included, in each weight", () => {
    // fontkit, as react-pdf reads fonts with (it has no types of its own).
    const { openSync } = createRequire(import.meta.url)("fontkit") as { openSync(path: string): { hasGlyphForCodePoint(c: number): boolean } };
    const fonts = (style: string) => ["figtree-latin", "figtree-latin-ext", "noto-sans-vietnamese"].map((file) => openSync(`${assetDir().fonts}${file}-${style}.woff`));
    for (const style of ["400-normal", "400-italic", "700-normal", "700-italic"]) {
      const missing = [...NAMES.replace(/[\s,-]/g, "")].filter((letter) => !fonts(style).some((font) => font.hasGlyphForCodePoint(letter.codePointAt(0)!)));
      expect(missing, style).toEqual([]);
    }
  });

  it("prints a name with accents as it's written, in the modern and the classic look", async () => {
    for (const font of ["modern", "classic"] as const) {
      const [page] = await sheets({ font }, { ...invoice, client: { name: NAMES, lines: [] }, notes: NAMES });
      // A letter put together from two shapes (ị) reads back with a control character after it.
      expect(page!.text.replace(/[\s\p{Cc}]/gu, ""), font).toContain(NAMES.replace(/\s/g, ""));
    }
  });
});

describe("the PDF of a signed estimate", () => {
  // Signed at 10:30 in the evening in Virginia: already the 6th in UTC.
  const signed: DocumentData = { ...invoice, kind: "estimate", validUntil: "2026-12-05", signatures: { customer: { name: "Alex Morgan", image: `data:image/png;base64,${Buffer.from(png(40, 10)).toString("base64")}`, date: "2026-11-06T03:30:00Z" } } };

  it("dates the signature on the day where it's printed, as the page does", async () => {
    const [virginia] = await sheets({ company_signs: false }, signed, "USD", "America/New_York");
    expect(has(virginia!, "Nov 5, 2026")).toBe(true);
    expect(has(virginia!, "Nov 6, 2026")).toBe(false);
    const [london] = await sheets({ company_signs: false }, signed, "USD", "Europe/London");
    expect(has(london!, "Nov 6, 2026")).toBe(true);
  });

  it("only takes a time zone there is", () => {
    expect([knownTimeZone("America/New_York"), knownTimeZone("Not/A_Zone"), knownTimeZone(undefined)]).toEqual(["America/New_York", undefined, undefined]);
  });
});

describe("where a PDF's pictures come from", () => {
  it("reads the business's own pictures from storage by their paths, and a drawn signature as the PNG it is", async () => {
    stored.files.set(`${COMPANY_ID}/logo/${TOP}.png`, png(3, 2));
    expect(await pictureFor({} as never, `/api/public/logo/${COMPANY_ID}/${TOP}.png`)).toMatchObject({ width: 3, height: 2, src: { format: "png" } });
    expect(await pictureFor({} as never, `https://crm.example.com/api/public/logo/${COMPANY_ID}/${TOP}.png`)).toMatchObject({ width: 3, height: 2 });
    const drawn = `data:image/png;base64,${Buffer.from(png(5, 4)).toString("base64")}`;
    expect(await pictureFor({} as never, drawn)).toMatchObject({ width: 5, height: 4, src: { format: "png" } });
  });

  it("never fetches another address, and leaves off anything that isn't the picture it says", async () => {
    stored.asked.length = 0;
    for (const url of ["https://example.com/logo.png", "/api/public/letterhead/../../secrets.png", `/api/public/logo/${COMPANY_ID}/${BOTTOM}.png`, "data:image/svg+xml;base64,PHN2Zz4=", `data:image/png;base64,${Buffer.from("not a png").toString("base64")}`]) {
      expect(await pictureFor({} as never, url), url).toBeNull();
    }
    // Only the one stored path was looked for (and it isn't there).
    expect(stored.asked).toEqual([`${COMPANY_ID}/logo/${BOTTOM}.png`]);
  });

  it("reads a picture's size from its header, and refuses one too big to be any picture here", () => {
    expect(pictureSize(png(7, 9))).toEqual({ width: 7, height: 9 });
    const huge = png(1, 1);
    new DataView(huge.buffer, huge.byteOffset).setUint32(16, 50_000);
    expect(pictureSize(huge)).toBeNull();
    // A JPEG's frame header: FFD8, then SOF0 with height 300 and width 400.
    expect(pictureSize(new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0x2c, 0x01, 0x90, 0x03, 0, 0, 0, 0, 0, 0, 0, 0]))).toEqual({ width: 400, height: 300 });
  });
});

describe("POST /api/public/documents/<name>.pdf", () => {
  const post = (document: string, file = "Invoice%201042.pdf") => {
    const body = new FormData();
    body.set("document", document);
    return documentPdfRoutes.request(`/public/documents/${file}`, { method: "POST", body }, env);
  };

  it("answers the document a page sends with its PDF, named for it, shown in the tab", async () => {
    const res = await post(JSON.stringify({ template: templateSettings({}), company, currency: "USD", data: invoice }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition")).toBe('inline; filename="Invoice 1042.pdf"');
    expect(Buffer.from(await res.arrayBuffer()).subarray(0, 5).toString()).toBe("%PDF-");
  });

  /** The page the tab shows instead of a PDF: its status, and whether it's the page that says so. */
  const sorry = async (res: Response) => [res.status, res.headers.get("content-type")?.startsWith("text/html") && (await res.text()).includes("Couldn't make the PDF")];

  it("is only at a PDF's name", async () => {
    const document = JSON.stringify({ template: templateSettings({}), company, currency: "USD", data: invoice });
    for (const file of ["Invoice%201042", "x.html", "%3Cscript%3E.pdf", `${"a".repeat(120)}.pdf`]) expect(await sorry(await post(document, file)), file).toEqual([404, true]);
  });

  it("answers anything that isn't a document with a page saying so, in the tab", async () => {
    for (const body of ["not json", JSON.stringify({ company, currency: "USD", data: { ...invoice, lines: "lots" } }), JSON.stringify({ template: {}, company, currency: "USD", data: { ...invoice, kind: "receipt" } })]) {
      expect(await sorry(await post(body)), body.slice(0, 30)).toEqual([400, true]);
    }
  });

  it("tells the person printing when the PDF can't be made, and reports why", async () => {
    stored.broken = true;
    const res = await post(JSON.stringify({ template: { ...DEFAULT_TEMPLATE, ...ownLetterhead(true) }, company, currency: "USD", data: invoice }));
    expect(await sorry(res)).toEqual([500, true]);
    expect(stored.reported).toEqual([expect.objectContaining({ message: "Storage is down" })]);
  });
});
