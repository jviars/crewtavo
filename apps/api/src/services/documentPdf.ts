/**
 * The PDF of an estimate or invoice (pdf/DocumentPdf.tsx), made here rather than in the browser:
 * Safari on an iPhone crashes making one (its JavaScript engine runs out of stack in react-pdf's
 * dependencies), and a PDF from the server is just a file the phone shows and prints, on the whole
 * sheet with no browser header or footer.
 *
 * Its pictures come from the business's own storage, never from an address in the request: the
 * letterhead, logo and package pictures by their /api/public paths, a signature or initials as the
 * PNG it was drawn as. Any other picture is left off.
 */
import { createElement } from "react";
import { Font, renderToBuffer } from "@react-pdf/renderer";
import { z } from "zod";
import type { DocumentCompany, DocumentData } from "../../../web/src/features/documents/types";
import type { TemplateSettings } from "@crewtavo/core/documents";
import type { Env } from "../env";
import { assetDir } from "../lib/reviewCard";
import { storedFile } from "../lib/storedFile";
import { adminClient, type Db } from "../lib/supabase";
import { DocumentPdf, documentPictures, type PdfPicture } from "../pdf/DocumentPdf";
import { LETTERHEAD_MAX_BYTES } from "./letterhead";
import { isPng, LOGO_MAX_BYTES } from "./logo";
import { PACKAGE_PICTURE_MAX_BYTES } from "./packagePictures";
import { isJpeg } from "./photos";

/**
 * Figtree, then for the letters it doesn't have, its Latin Extended part (Ł, ő, ș) and then Noto
 * Sans for Vietnamese (ễ, ơ, đ): each letter is printed in the first that has it.
 */
const FONTS = ["Figtree", "Figtree Ext", "Noto Sans"];
let registered = false;

/** The fonts, from next to the server (assets/fonts, as the review card's are). Words aren't hyphenated. */
function registerFonts() {
  if (registered) return;
  const dir = assetDir().fonts;
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

/** The most a drawn signature or initials may be, as text (a data URL) and as a picture. */
const DRAWN_MAX_CHARS = 1_500_000;
const MAX_SIDE = 6000;

/** A PNG's or JPEG's size in pixels, from its header; null when it's neither, or bigger than any picture here. */
export function pictureSize(bytes: Uint8Array): { width: number; height: number } | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let size: { width: number; height: number } | null = null;
  if (isPng(bytes)) size = { width: view.getUint32(16), height: view.getUint32(20) };
  else if (isJpeg(bytes)) {
    // The frame's header (SOF0 to SOF15, but not DHT, JPG or DAC) says its height and width.
    for (let at = 2; at + 9 < bytes.length; ) {
      if (bytes[at] !== 0xff) return null;
      const marker = bytes[at + 1]!;
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        size = { width: view.getUint16(at + 7), height: view.getUint16(at + 5) };
        break;
      }
      at += 2 + view.getUint16(at + 2);
    }
  }
  return size && size.width > 0 && size.height > 0 && size.width <= MAX_SIDE && size.height <= MAX_SIDE ? size : null;
}

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
/** The business's own pictures, by the path the pages load them from, and where each is stored. */
const STORED: Array<{ path: RegExp; folder: string; ext: "png" | "jpg"; max: number }> = [
  { path: new RegExp(`^/api/public/letterhead/(${UUID})/(${UUID})\\.png$`, "i"), folder: "letterhead", ext: "png", max: LETTERHEAD_MAX_BYTES },
  { path: new RegExp(`^/api/public/logo/(${UUID})/(${UUID})\\.png$`, "i"), folder: "logo", ext: "png", max: LOGO_MAX_BYTES },
  { path: new RegExp(`^/api/public/package/(${UUID})/(${UUID})\\.jpg$`, "i"), folder: "packages", ext: "jpg", max: PACKAGE_PICTURE_MAX_BYTES },
  { path: new RegExp(`^/api/public/service/(${UUID})/(${UUID})\\.jpg$`, "i"), folder: "services", ext: "jpg", max: PACKAGE_PICTURE_MAX_BYTES },
];

/** One of the document's pictures, from storage or as drawn; null for any other, or one that isn't a picture. */
export async function pictureFor(admin: Db, url: string): Promise<PdfPicture | null> {
  let bytes: Uint8Array | null = null;
  let format: "png" | "jpg" = "png";
  const drawn = /^data:image\/png;base64,([a-z0-9+/=]+)$/i.exec(url);
  if (drawn) {
    if (url.length > DRAWN_MAX_CHARS) return null;
    bytes = Buffer.from(drawn[1]!, "base64");
  } else {
    // Only the path counts (the page may have it as a full address): nothing is fetched from another server.
    let path: string;
    try {
      path = new URL(url, "http://local").pathname;
    } catch {
      return null;
    }
    const stored = STORED.map((s) => ({ s, m: s.path.exec(path) })).find((x) => x.m);
    if (!stored) return null;
    format = stored.s.ext;
    bytes = await storedFile(admin, `${stored.m![1]!.toLowerCase()}/${stored.s.folder}/${stored.m![2]!.toLowerCase()}.${stored.s.ext}`, stored.s.max);
  }
  if (!bytes || !(format === "png" ? isPng(bytes) : isJpeg(bytes))) return null;
  const size = pictureSize(bytes);
  return size && { src: { data: Buffer.from(bytes), format }, ...size };
}

const text = (max: number) => z.string().max(max);
const amount = z.number().finite();
const signature = z.object({ name: text(200), image: text(DRAWN_MAX_CHARS).nullable(), date: text(40).nullable() }).nullish();
const block = z.union([
  z.object({ kind: z.enum(["p", "h3", "h4", "text"]), html: text(50_000) }),
  z.object({ kind: z.literal("hr") }),
  z.object({ kind: z.literal("li"), list: z.enum(["ul", "ol"]), number: z.number().int().min(0).max(100_000), html: text(50_000) }),
  z.object({ kind: z.literal("quote"), quote: z.number().int(), html: text(50_000) }),
  z.object({ kind: z.literal("row"), table: z.number().int(), head: z.boolean(), columns: z.number().int().min(1).max(20), cells: z.array(z.object({ tag: z.enum(["td", "th"]), html: text(20_000), colSpan: z.number().int().min(1).max(20) })).max(20) }),
]);

/** What a page sends to be made into a PDF: the document as it shows it, and the business's currency. */
export const documentPdfInput = z.object({
  template: z.unknown(),
  company: z.object({ name: text(300), phone: text(100).nullable(), email: text(300).nullable(), website: text(500).nullable(), address: z.array(text(300)).max(10), logo: text(500).nullable(), settings: z.unknown().optional() }),
  currency: text(3),
  timeZone: text(64).optional(),
  data: z.object({
    kind: z.enum(["estimate", "invoice"]),
    number: z.number().int().nullable(),
    date: text(40).nullable(),
    validUntil: text(40).nullish(),
    dueOn: text(40).nullish(),
    title: text(500).nullish(),
    facts: z.array(text(500)).max(20).optional(),
    client: z.object({ name: text(300), lines: z.array(text(300)).max(10) }),
    lines: z.array(z.object({ name: text(500), description: text(5000).nullish(), quantity: amount, unit: text(40), unit_price: amount, total: amount })).max(1000),
    subtotal: amount,
    discount: amount,
    discountLabel: text(200).optional(),
    credits: z.array(z.object({ label: text(300), amount })).max(50).optional(),
    tax: amount,
    taxExempt: text(300).optional(),
    total: amount,
    deposit: amount.nullish(),
    repeats: text(300).nullish(),
    payments: z.array(z.object({ label: text(300), amount })).max(200).optional(),
    balanceDue: amount.nullish(),
    notes: text(20_000).nullish(),
    signatures: z.object({ customer: signature, company: signature }).optional(),
    contract: z
      .object({
        sections: z
          .array(
            z.object({
              id: text(100),
              title: text(500),
              html: text(100_000),
              place: z.enum(["signatures", "terms"]),
              initials: z.boolean(),
              initialed: z.object({ image: text(DRAWN_MAX_CHARS), date: text(40).nullable() }).nullish(),
              blocks: z.array(block).max(3000).optional(),
            }),
          )
          .max(100),
      })
      .optional(),
    options: z
      .array(
        z.object({
          id: text(100),
          name: text(300),
          tier: text(60).nullable(),
          picture: z.object({ src: text(500), width: z.number(), height: z.number() }).nullable(),
          style: text(40),
          highlights: z.array(text(500)).max(20),
          warranty: text(2000),
          total: amount.nullable(),
          chosen: z.boolean(),
        }),
      )
      .max(3)
      .optional(),
  }),
});

/** A time zone dates can be shown in ("America/New_York"), else none. */
export function knownTimeZone(zone: string | undefined): string | undefined {
  if (!zone) return undefined;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return zone;
  } catch {
    return undefined;
  }
}

/** The PDF of a document on the business's template, with its pictures from storage. */
export async function documentPdf(env: Env, input: { template: TemplateSettings; company: DocumentCompany; data: DocumentData; currency: string; timeZone?: string }): Promise<Buffer> {
  registerFonts();
  const admin = adminClient(env);
  const urls = documentPictures(input.template, input.company, input.data);
  const loaded = await Promise.all(urls.map((url) => pictureFor(admin, url)));
  const pictures = new Map(urls.map((url, i) => [url, loaded[i] ?? null]));
  return renderToBuffer(createElement(DocumentPdf, { ...input, timeZone: knownTimeZone(input.timeZone), pictures, font: FONTS }) as Parameters<typeof renderToBuffer>[0]);
}
