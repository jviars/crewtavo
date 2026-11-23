/**
 * The PDF of an estimate or invoice, made on the server (services/documentPdf.ts, pdf/DocumentPdf.tsx,
 * routes/documentPdf.ts) and read back with pdf.js: its sheets, the words on each, where the
 * business's own letterhead lands, where its pictures may come from, who may have one made (print
 * tickets) and how big a document may be. Storage, the database, the sign-in and the rate limit are
 * stand-ins.
 */
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { crc32, deflateSync } from "node:zlib";
import { DEFAULT_TEMPLATE, templateSettings, type TemplateSettings } from "@crewtavo/core/documents";
import { getDocument, OPS } from "pdfjs-dist/legacy/build/pdf.mjs";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DocumentCompany, DocumentData } from "../../web/src/features/documents/types";
import type { Env } from "../src/env";
import { signToken } from "../src/lib/crypto";
import { clientLink } from "../src/lib/links";
import { assetDir } from "../src/lib/reviewCard";
import { memoryDb, type MemoryDb } from "./fixtures/memoryDb";

const stored = vi.hoisted(() => ({ files: new Map<string, Uint8Array>(), asked: [] as string[], broken: false, reported: [] as unknown[] }));
vi.mock("../src/lib/storedFile", () => ({
  storedFile: async (_admin: unknown, path: string) => {
    stored.asked.push(path);
    if (stored.broken) throw new Error("Storage is down");
    return stored.files.get(path) ?? null;
  },
}));
vi.mock("../src/lib/monitoring", async (original) => ({ ...(await original<typeof import("../src/lib/monitoring")>()), reportError: (error: unknown) => stored.reported.push(error) }));
/** The database a Client Hub link is checked against, and who's signed in for the office's print ticket. */
const world = vi.hoisted(() => ({ db: null as unknown as MemoryDb, company: "00000000-0000-4000-8000-000000000001", role: "office", permissions: ["sales", "invoices", "settings"] as string[] }));
vi.mock("../src/lib/supabase", async (original) => {
  const { memoryClient } = await import("./fixtures/memoryDb");
  return { ...(await original<typeof import("../src/lib/supabase")>()), adminClient: () => memoryClient(() => world.db) };
});
vi.mock("../src/lib/limit", async (original) => ({ ...(await original<typeof import("../src/lib/limit")>()), allow: async () => true }));
vi.mock("../src/lib/auth", async (original) => ({
  ...(await original<typeof import("../src/lib/auth")>()),
  requireUser: async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
    c.set("userId", "00000000-0000-4000-8000-0000000000a1");
    await next();
  },
  // As requireCompany does: the levels a route takes, the business on screen, and the person's areas.
  requireCompany: (roles: readonly string[]) => async (c: { set: (k: string, v: unknown) => void; json: (b: unknown, s: number) => Response }, next: () => Promise<void>) => {
    if (!roles.includes(world.role)) return c.json({ error: "You don't have permission to do that. Ask an admin if you need it." }, 403);
    c.set("companyId", world.company);
    c.set("role", world.role);
    c.set("permissions", world.permissions);
    await next();
  },
}));

const { documentPdf, knownTimeZone, pictureFor, pictureSize, printTicket, readPrintTicket, PDF_LIMITS, setPdfWorker } = await import("../src/services/documentPdf");
const { pngUnpacksToItsSize } = await import("../src/pdf/render");
const { documentPdfRoutes } = await import("../src/routes/documentPdf");

/** A PNG of `width` × `height` gray pixels; `packed`, its pixel data as packed, when it isn't those pixels. */
function png(width = 1, height = 1, packed?: Buffer): Uint8Array {
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
  const rows = () => Buffer.concat(Array.from({ length: height }, () => Buffer.from([0, ...Array(width).fill(128)])));
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", packed ?? deflateSync(rows())), chunk("IEND", Buffer.alloc(0))]);
}

/** A PNG whose header says it's `width` × `height`, without the pixels (only its header is read). */
function sized(width: number, height: number): Uint8Array {
  const picture = png(1, 1);
  const view = new DataView(picture.buffer, picture.byteOffset);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return picture;
}
const dataUrl = (picture: Uint8Array) => `data:image/png;base64,${Buffer.from(picture).toString("base64")}`;

const COMPANY_ID = world.company;
/** Another business on the same server. */
const OTHER_ID = "00000000-0000-4000-8000-000000000002";
const TOP = "11111111-1111-4111-8111-111111111111";
const BOTTOM = "22222222-2222-4222-8222-222222222222";
const env = { SUPABASE_URL: "https://example.supabase.co", SUPABASE_SECRET_KEY: "sb_secret_test", APP_URL: "https://crew.example.com" } as Env;
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
  world.db = memoryDb();
  world.role = "office";
  world.permissions = ["sales", "invoices", "settings"];
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
  read(await documentPdf(env, { companyId: COMPANY_ID, template: { ...DEFAULT_TEMPLATE, ...template }, company, data, currency, timeZone }));

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
    expect(await pictureFor({} as never, `/api/public/logo/${COMPANY_ID}/${TOP}.png`, COMPANY_ID)).toMatchObject({ width: 3, height: 2, src: { format: "png" } });
    expect(await pictureFor({} as never, `https://crm.example.com/api/public/logo/${COMPANY_ID}/${TOP}.png`, COMPANY_ID)).toMatchObject({ width: 3, height: 2 });
    expect(await pictureFor({} as never, dataUrl(png(5, 4)), COMPANY_ID)).toMatchObject({ width: 5, height: 4, src: { format: "png" } });
  });

  it("never fetches another address, and leaves off anything that isn't the picture it says", async () => {
    stored.asked.length = 0;
    for (const url of ["https://example.com/logo.png", "/api/public/letterhead/../../secrets.png", `/api/public/logo/${COMPANY_ID}/${BOTTOM}.png`, "data:image/svg+xml;base64,PHN2Zz4=", `data:image/png;base64,${Buffer.from("not a png").toString("base64")}`]) {
      expect(await pictureFor({} as never, url, COMPANY_ID), url).toBeNull();
    }
    // Only the one stored path was looked for (and it isn't there).
    expect(stored.asked).toEqual([`${COMPANY_ID}/logo/${BOTTOM}.png`]);
  });

  it("only takes the pictures of the business the PDF is for", async () => {
    stored.files.set(`${OTHER_ID}/logo/${TOP}.png`, png(3, 2));
    stored.files.set(`${OTHER_ID}/letterhead/${TOP}.png`, png(4, 1));
    stored.asked.length = 0;
    expect(await pictureFor({} as never, `/api/public/logo/${OTHER_ID}/${TOP}.png`, COMPANY_ID)).toBeNull();
    // Another business's letterhead on the template sent is never read, and the page goes without.
    const [page] = await sheets({ letterhead: "custom", letterhead_header: { path: `${OTHER_ID}/letterhead/${TOP}.png`, width: 2550, height: 420 } });
    expect(page!.pictures).toEqual([]);
    expect(stored.asked).toEqual([]);
  });

  it("leaves off a drawn signature bigger than a signature pad draws one", async () => {
    // 4,000 × 4,000 by its header: twice the most a pad makes (logo.ts DRAWN_MAX_PIXELS).
    expect(await pictureFor({} as never, dataUrl(sized(4000, 4000)), COMPANY_ID)).toBeNull();
  });

  it("leaves off a PNG whose pixels unpack to more than its size says", () => {
    expect(pngUnpacksToItsSize(png(40, 10))).toBe(true);
    // 1 × 1 by its header, a megabyte once unpacked: about a kilobyte as sent.
    const packed = png(1, 1, deflateSync(Buffer.alloc(1_000_000)));
    expect(packed.length).toBeLessThan(5_000);
    expect(pngUnpacksToItsSize(packed)).toBe(false);
    expect(pngUnpacksToItsSize(new TextEncoder().encode("not a PNG, nor anything like one"))).toBe(false);
  });

  it("reads a picture's size from its header, and refuses one too big to be any picture here", () => {
    expect(pictureSize(png(7, 9))).toEqual({ width: 7, height: 9 });
    expect(pictureSize(sized(50_000, 1))).toBeNull();
    // A JPEG's frame header: FFD8, then SOF0 with height 300 and width 400.
    expect(pictureSize(new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0x2c, 0x01, 0x90, 0x03, 0, 0, 0, 0, 0, 0, 0, 0]))).toEqual({ width: 400, height: 300 });
  });
});

const INVOICE_ID = "00000000-0000-4000-8000-0000000000e1";
const QUOTE_ID = "00000000-0000-4000-8000-0000000000e2";
const CLIENT_ID = "00000000-0000-4000-8000-0000000000c1";
/** The business's invoice 1042 and quote 77, for one client, as the Client Hub reads them. */
const hubWorld = (resetAt: string | null = null) =>
  memoryDb({
    companies: [{ id: COMPANY_ID, name: "Arrington Paving" }],
    clients: [{ id: CLIENT_ID, company_id: COMPANY_ID, links_reset_at: resetAt }],
    invoices: [{ id: INVOICE_ID, company_id: COMPANY_ID, client_id: CLIENT_ID, number: 1042 }],
    quotes: [{ id: QUOTE_ID, company_id: COMPANY_ID, client_id: CLIENT_ID, number: 77 }],
  });
/** A Client Hub link's token, as the address /hub/<token> carries it. */
const hubToken = async (t: "quote" | "invoice" | "client", id: string) => (await clientLink(env, "https://crew.example.com", { c: COMPANY_ID, t, id })).split("/hub/")[1]!;
const askTicket = (path: string) => documentPdfRoutes.request(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }, env);
/** The document as a page sends it to print. */
const sent = (data: unknown, template: unknown = templateSettings({})) => JSON.stringify({ template, company, currency: "USD", data });

describe("POST /api/public/documents/<name>.pdf", () => {
  /** A print ticket for the office of the business, unless one is given. */
  const post = async (document: string, file = "Invoice%201042.pdf", ticket?: string) => {
    const body = new FormData();
    body.set("ticket", ticket ?? (await printTicket(env, COMPANY_ID)));
    body.set("document", document);
    return documentPdfRoutes.request(`/public/documents/${file}`, { method: "POST", body }, env);
  };

  it("answers the document a page sends with its PDF, named for it, shown in the tab", async () => {
    const res = await post(sent(invoice));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition")).toBe('inline; filename="Invoice 1042.pdf"');
    expect(Buffer.from(await res.arrayBuffer()).subarray(0, 5).toString()).toBe("%PDF-");
  });

  /** The page the tab shows instead of a PDF: its status, and whether it's the page that says so. */
  const sorry = async (res: Response) => [res.status, res.headers.get("content-type")?.startsWith("text/html") && (await res.text()).includes("Couldn't make the PDF")];

  it("is only at a PDF's name", async () => {
    for (const file of ["Invoice%201042", "x.html", "%3Cscript%3E.pdf", `${"a".repeat(120)}.pdf`]) expect(await sorry(await post(sent(invoice), file)), file).toEqual([404, true]);
  });

  it("answers anything that isn't a document with a page saying so, in the tab", async () => {
    for (const body of ["not json", JSON.stringify({ company, currency: "USD", data: { ...invoice, lines: "lots" } }), JSON.stringify({ template: {}, company, currency: "USD", data: { ...invoice, kind: "receipt" } })]) {
      expect(await sorry(await post(body)), body.slice(0, 30)).toEqual([400, true]);
    }
  });

  it("tells the person printing when the PDF can't be made, and reports why", async () => {
    stored.broken = true;
    const res = await post(sent(invoice, { ...DEFAULT_TEMPLATE, ...ownLetterhead(true) }));
    expect(await sorry(res)).toEqual([500, true]);
    expect(stored.reported).toEqual([expect.objectContaining({ message: "Storage is down" })]);
  });

  it("makes no PDF without a print ticket this server made, still good", async () => {
    const now = Math.floor(Date.now() / 1000);
    const runOut = await signToken(env, { k: "document-pdf", c: COMPANY_ID, exp: now - 1 });
    const anotherServer = await signToken({ ...env, SUPABASE_SECRET_KEY: "sb_secret_another_server" }, { k: "document-pdf", c: COMPANY_ID, exp: now + 60 });
    // A Client Hub link is signed by this server too, but it isn't a print ticket.
    const hubLink = await hubToken("invoice", INVOICE_ID);
    for (const ticket of ["", "not.a-ticket", runOut, anotherServer, hubLink]) expect(await sorry(await post(sent(invoice), undefined, ticket)), ticket.slice(0, 20)).toEqual([403, true]);
    expect(stored.asked).toEqual([]);
  });

  it("prints only the quote or invoice a Client Hub link's ticket is for", async () => {
    world.db = hubWorld();
    const res = await askTicket(`/hub/${await hubToken("invoice", INVOICE_ID)}/print-ticket`);
    expect(res.status).toBe(200);
    const { ticket } = (await res.json()) as { ticket: string };
    expect(await readPrintTicket(env, ticket)).toMatchObject({ c: COMPANY_ID, doc: { kind: "invoice", number: 1042 } });
    expect((await post(sent(invoice), undefined, ticket)).status).toBe(200);
    for (const other of [{ ...invoice, number: 1043 }, { ...invoice, kind: "estimate" }, { ...invoice, number: null }]) {
      expect(await sorry(await post(sent(other), undefined, ticket)), JSON.stringify(other).slice(0, 40)).toEqual([403, true]);
    }
    const quote = (await (await askTicket(`/hub/${await hubToken("quote", QUOTE_ID)}/print-ticket`)).json()) as { ticket: string };
    expect(await readPrintTicket(env, quote.ticket)).toMatchObject({ doc: { kind: "estimate", number: 77 } });
  });

  it("gives no ticket for a Client Hub link that isn't working, or isn't to a quote or invoice", async () => {
    world.db = hubWorld();
    expect((await askTicket(`/hub/${await hubToken("client", CLIENT_ID)}/print-ticket`)).status).toBe(404);
    expect((await askTicket("/hub/not-a-link/print-ticket")).status).toBe(404);
    const gone = await hubToken("invoice", "00000000-0000-4000-8000-0000000000ff");
    expect((await askTicket(`/hub/${gone}/print-ticket`)).status).toBe(404);
    // The office reset the client's links after this one was made.
    const old = await hubToken("invoice", INVOICE_ID);
    world.db = hubWorld(new Date(Date.now() + 60_000).toISOString());
    expect((await askTicket(`/hub/${old}/print-ticket`)).status).toBe(410);
  });

  it("gives a member of the business on screen a ticket for any of its documents, when their screens print", async () => {
    const res = await askTicket("/documents/print-ticket");
    expect(res.status).toBe(200);
    const ticket = await readPrintTicket(env, ((await res.json()) as { ticket: string }).ticket);
    expect(ticket).toMatchObject({ c: COMPANY_ID });
    expect(ticket!.doc).toBeUndefined();
    // Field crew have no screen that prints one; a sub isn't on the team.
    world.role = "field_crew";
    world.permissions = [];
    expect((await askTicket("/documents/print-ticket")).status).toBe(403);
    world.role = "subcontractor";
    expect((await askTicket("/documents/print-ticket")).status).toBe(403);
  });

  it("turns down a document bigger than any real one, before it's made", async () => {
    const section = (i: number, more: Record<string, unknown>) => ({ id: `s${i}`, title: "", html: "<p>Initial here.</p>", place: "signatures", initials: false, ...more });
    const initialed = (images: string[]) => ({ ...invoice, contract: { sections: images.map((image, i) => section(i, { initials: true, initialed: { image, date: null } })) } });
    const tooBig = [
      // Words: two hundred lines of five thousand characters, however they start.
      { ...invoice, lines: Array.from({ length: 200 }, (_, i) => line(`Item ${i}`, 1, "x".repeat(5_000))) },
      { ...invoice, lines: Array.from({ length: 200 }, (_, i) => line(`Item ${i}`, 1, `data:image/png;base64,${"x".repeat(4_900)}`)) },
      // Values: a list longer than any document's.
      { ...invoice, facts: Array.from({ length: PDF_LIMITS.values + 1 }, () => 1) },
      // A contract in more pieces than a hundred pages.
      { ...invoice, contract: { sections: [0, 1, 2].map((i) => section(i, { blocks: Array.from({ length: 2_500 }, () => ({ kind: "hr" })) })) } },
      // More different initials than any contract has.
      initialed(Array.from({ length: PDF_LIMITS.drawn + 1 }, (_, i) => dataUrl(png(i + 1, 1)))),
      // Initials each no bigger than a pad draws them, but more pixels than a PDF takes all told.
      initialed([dataUrl(sized(2800, 2800)), dataUrl(sized(2800, 2801)), dataUrl(sized(2801, 2800))]),
    ];
    for (const data of tooBig) expect(await sorry(await post(sent(data))), JSON.stringify(data).slice(0, 60)).toEqual([413, true]);
    expect(stored.asked).toEqual([]);
    // A contract with initials, as a real one has them, is made.
    expect((await post(sent(initialed([dataUrl(png(30, 10)), dataUrl(png(31, 10))])))).status).toBe(200);
  });
});

describe("a PDF made on a thread of its own, as the built server makes it", () => {
  const out = fileURLToPath(new URL("../../../dist/test/pdf-worker/", import.meta.url));
  const thread = () => pathToFileURL(`${out}pdf-worker.mjs`);

  beforeAll(async () => {
    // Bundled as scripts/build-server.mjs bundles it, next to a package.json that says where the PDF's
    // maker finds its built-in fonts (as scripts/dev-api.mjs writes one).
    const { build } = await import("esbuild");
    await build({
      entryPoints: [fileURLToPath(new URL("../src/pdf/worker.ts", import.meta.url))],
      outfile: `${out}pdf-worker.mjs`,
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node22",
      logLevel: "warning",
      banner: { js: "import { createRequire as __testCreateRequire } from 'node:module'; const require = __testCreateRequire(import.meta.url);" },
    });
    writeFileSync(`${out}package.json`, `${JSON.stringify({ private: true, imports: { "#standard-fonts/*": "pdfkit/standard-fonts/*" } })}\n`);
    setPdfWorker(thread());
  }, 120_000);
  afterAll(() => setPdfWorker(null));

  it("makes the same PDF there, with its pictures from the business's storage", async () => {
    // The same document made on this thread, to compare with.
    setPdfWorker(null);
    const here = await sheets(ownLetterhead(true), long);
    setPdfWorker(thread());
    stored.asked.length = 0;

    const pages = await sheets(ownLetterhead(true), long);
    expect(pages.length).toBeGreaterThan(1);
    pages.forEach((page, i) => expect(has(page, `Page ${i + 1} of ${pages.length}`)).toBe(true));
    // The business's own letterhead is a picture, so its name is in the words from the second sheet on.
    expect(has(pages[0]!, "Alex Morgan")).toBe(true);
    expect(has(pages[1]!, "Arrington Paving · Invoice No. 1042 continued")).toBe(true);
    expect(pages[0]!.pictures).toHaveLength(2);
    expect(pages.map((p) => [p.width, p.height, p.text, p.pictures])).toEqual(here.map((p) => [p.width, p.height, p.text, p.pictures]));
    expect(stored.asked.sort()).toEqual([`${COMPANY_ID}/letterhead/${TOP}.png`, `${COMPANY_ID}/letterhead/${BOTTOM}.png`].sort());
  }, 60_000);

  it("leaves off a PNG there whose pixels unpack to more than its size says, and still makes the PDF", async () => {
    const packed = dataUrl(png(1, 1, deflateSync(Buffer.alloc(1_000_000))));
    const signed: DocumentData = { ...invoice, kind: "estimate", signatures: { customer: { name: "Alex Morgan", image: packed, date: null } } };
    const [page] = await sheets({ company_signs: false }, signed);
    expect(has(page!, "Alex Morgan")).toBe(true);
    expect(page!.pictures).toEqual([]);
  }, 60_000);
});
