/**
 * A link's preview for team chat: the page's title, description, site name and a small picture,
 * read from its <head> (Open Graph and Twitter tags, else <title> and the description). Only from
 * the public internet (lib/publicHttp.ts): http or https on their usual ports, never this server,
 * its network or a cloud's metadata service, the address checked being the one connected to, and
 * every redirect (three at most) checked again. Five seconds and 512 KB of an HTML page at most.
 *
 * The picture comes through here too, by the same rules (a JPEG or PNG of up to 2 MB), shrunk to a
 * small JPEG kept with the preview: people's browsers never load anything from the linked site, so
 * it doesn't learn who read the message, and Crewtavo's own pages need no outside images.
 */
import type { IncomingMessage } from "node:http";
import { isIP } from "node:net";
import { pipeline, type Readable } from "node:stream";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import { decode, encode } from "jpeg-js";
import { PNG } from "pngjs";
import { isPng, pngSize } from "../services/logo";
import { isJpeg } from "../services/photos";
import { privateHost, publicGet } from "./publicHttp";
import { shrinkRgba, type Rgba } from "./thumbnail";

export interface LinkPreview {
  /** The page it ended up on, after any redirects. */
  url: string;
  title: string | null;
  description: string | null;
  site_name: string | null;
  /** A small JPEG, as a data: address. */
  image: string | null;
}

export const PREVIEW_LIMITS = {
  timeoutMs: 5_000,
  pageBytes: 512 * 1024,
  imageBytes: 2 * 1024 * 1024,
  redirects: 3,
  /** The picture's longer side, once shrunk. */
  imagePx: 240,
};
type Limits = typeof PREVIEW_LIMITS;

const HEADERS = { "Accept-Encoding": "gzip, br", "Accept-Language": "en", "User-Agent": "Mozilla/5.0 (compatible; Crewtavo link preview)" };

/**
 * A link Crewtavo may read for a preview: http or https on the usual port, no name and password in
 * it, and a name that isn't plainly inside a network (localhost, a single word, 10.0.0.5). Null when
 * it isn't one. The address the name stands for is checked as it's connected to (publicGet).
 */
export function previewable(href: string): URL | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  // The URL drops a scheme's own port (80, 443), so any port left is another.
  if (url.port !== "") return null;
  if (url.username || url.password) return null;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (!isIP(host) && !host.includes(".")) return null;
  if (privateHost(url)) return null;
  url.hash = "";
  return url;
}

/** GET a public page, following up to `redirects` redirects (each checked again). Null when it leads anywhere it shouldn't. */
async function publicPage(start: URL, accept: string, signal: AbortSignal, limits: Limits): Promise<{ response: IncomingMessage; url: URL } | null> {
  let url: URL | null = start;
  for (let hop = 0; url; hop++) {
    const response = await publicGet(url, { ...HEADERS, Accept: accept }, signal);
    const status = response.statusCode ?? 0;
    const location = response.headers.location;
    if (status >= 300 && status < 400 && location) {
      response.destroy();
      if (hop >= limits.redirects) return null;
      url = previewable(new URL(location, url).toString());
      continue;
    }
    if (status < 200 || status > 299) {
      response.destroy();
      return null;
    }
    return { response, url };
  }
  return null;
}

/**
 * A response's body, unpacked, up to `max` bytes: what's past that isn't read, and a page's
 * reading stops at the end of its <head>. Packed bodies count as they unpack, so a small packed one
 * can't fill memory.
 */
async function readSome(response: IncomingMessage, max: number, untilHeadEnds: boolean): Promise<{ bytes: Buffer; whole: boolean }> {
  const encoding = String(response.headers["content-encoding"] ?? "").trim().toLowerCase();
  const unzip = encoding === "gzip" || encoding === "x-gzip" ? createGunzip() : encoding === "br" ? createBrotliDecompress() : encoding === "deflate" ? createInflate() : null;
  const body: Readable = unzip ? pipeline(response, unzip, () => undefined) : response;
  const chunks: Buffer[] = [];
  let size = 0;
  let whole = true;
  try {
    for await (const chunk of body as AsyncIterable<Buffer>) {
      const room = max - size;
      chunks.push(chunk.byteLength > room ? chunk.subarray(0, room) : chunk);
      size += Math.min(chunk.byteLength, room);
      if (chunk.byteLength >= room) {
        whole = false;
        break;
      }
      if (untilHeadEnds && /<\/head\s*>|<body[\s>]/i.test(chunk.toString("latin1"))) break;
    }
  } finally {
    response.destroy();
    unzip?.destroy();
  }
  return { bytes: Buffer.concat(chunks), whole };
}

const NAMED: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", hellip: "…", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”",
  copy: "©", reg: "®", trade: "™", middot: "·", bull: "•", eacute: "é", egrave: "è", aacute: "á", oacute: "ó", uacute: "ú", iacute: "í", ntilde: "ñ", uuml: "ü",
};
/** HTML's character references in a value, and its spaces as one. */
function text(value: string | undefined, max: number): string | null {
  if (!value) return null;
  const decoded = value
    .replace(/&#x([0-9a-f]{1,6});/gi, (_, hex: string) => safeChar(parseInt(hex, 16)))
    .replace(/&#([0-9]{1,7});/g, (_, dec: string) => safeChar(Number(dec)))
    .replace(/&([a-z]+);/gi, (whole, name: string) => NAMED[name.toLowerCase()] ?? whole)
    .replace(/\s+/g, " ")
    .trim();
  if (!decoded) return null;
  return decoded.length > max ? `${decoded.slice(0, max - 1).trimEnd()}…` : decoded;
}
const safeChar = (code: number) => (code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : "");

/** How much of a page is looked at for its tags: a page's <head> is near its start, and a page can't make reading it slow. */
export const PARSE_CHARS = 64 * 1024;

const isSpace = (ch: string | undefined) => ch === " " || ch === "\n" || ch === "\t" || ch === "\r" || ch === "\f";
const isNameEnd = (ch: string | undefined) => ch === undefined || isSpace(ch) || ch === "/" || ch === ">";

/**
 * A tag's attributes from the text inside its < and >, lower-case names to raw values (the first of
 * each name). One pass over it, never going back: no pattern of attributes or quotes makes it slow.
 */
function attributes(inside: string): Record<string, string> {
  const out: Record<string, string> = {};
  let i = 0;
  const n = inside.length;
  while (i < n) {
    while (i < n && (isSpace(inside[i]) || inside[i] === "/")) i += 1;
    const start = i;
    while (i < n && !isSpace(inside[i]) && inside[i] !== "=" && inside[i] !== "/") i += 1;
    const name = inside.slice(start, i).toLowerCase();
    if (!name) {
      i += 1;
      continue;
    }
    while (i < n && isSpace(inside[i])) i += 1;
    let value = "";
    if (inside[i] === "=") {
      i += 1;
      while (i < n && isSpace(inside[i])) i += 1;
      const quote = inside[i];
      if (quote === '"' || quote === "'") {
        const end = inside.indexOf(quote, i + 1);
        value = inside.slice(i + 1, end === -1 ? n : end);
        i = end === -1 ? n : end + 1;
      } else {
        const begin = i;
        while (i < n && !isSpace(inside[i])) i += 1;
        value = inside.slice(begin, i);
      }
    }
    if (!(name in out)) out[name] = value;
  }
  return out;
}

/**
 * The tags of a page's head that say what it is: each <meta>'s attributes and the <title>'s words.
 * It reads forward with indexOf from one "<" to the next and stops at the end of the head (or the
 * start of the body), so it takes time in step with the page, whatever the page holds.
 */
export function headTags(html: string): { metas: Array<Record<string, string>>; title: string | undefined } {
  const page = html.slice(0, PARSE_CHARS);
  const lower = page.toLowerCase();
  const metas: Array<Record<string, string>> = [];
  let title: string | undefined;
  for (let at = lower.indexOf("<"); at !== -1; at = lower.indexOf("<", at + 1)) {
    if (lower.startsWith("</head", at) || (lower.startsWith("<body", at) && isNameEnd(lower[at + 5]))) break;
    if (lower.startsWith("<!--", at)) {
      const end = lower.indexOf("-->", at + 4);
      if (end === -1) break;
      at = end + 2;
      continue;
    }
    if (lower.startsWith("<meta", at) && isNameEnd(lower[at + 5])) {
      const end = lower.indexOf(">", at + 5);
      if (end === -1) break;
      metas.push(attributes(page.slice(at + 5, end)));
      at = end;
    } else if (title === undefined && lower.startsWith("<title", at) && isNameEnd(lower[at + 6])) {
      const open = lower.indexOf(">", at + 6);
      const close = open === -1 ? -1 : lower.indexOf("</title", open + 1);
      if (close === -1) break;
      title = page.slice(open + 1, close);
      at = close;
    }
  }
  return { metas, title };
}

/** What a page's <head> says about it. */
export function readHead(html: string, pageUrl: URL): Omit<LinkPreview, "url" | "image"> & { image: string | null } {
  const tags = headTags(html);
  const meta = new Map<string, string>();
  for (const a of tags.metas) {
    const key = (a.property ?? a.name ?? a.itemprop ?? "").toLowerCase();
    if (key && a.content !== undefined && !meta.has(key)) meta.set(key, a.content);
  }
  const title = tags.title;
  const imageHref = meta.get("og:image:secure_url") ?? meta.get("og:image") ?? meta.get("og:image:url") ?? meta.get("twitter:image") ?? meta.get("twitter:image:src");
  let image: string | null = null;
  if (imageHref) {
    try {
      image = new URL(text(imageHref, 2048) ?? "", pageUrl).toString();
    } catch {
      image = null;
    }
  }
  return {
    title: text(meta.get("og:title") ?? meta.get("twitter:title") ?? title, 200),
    description: text(meta.get("og:description") ?? meta.get("twitter:description") ?? meta.get("description"), 300),
    site_name: text(meta.get("og:site_name") ?? meta.get("application-name"), 80) ?? pageUrl.hostname.replace(/^www\./, ""),
    image,
  };
}

const charsetOf = (value: string | undefined) => (value ? /charset\s*=\s*["']?([\w-]{1,40})/i.exec(value)?.[1] : undefined);

/** A page's text in its own character set (from its header, else a <meta> near its start), else UTF-8. */
function decodeHtml(bytes: Buffer, contentType: string): string {
  const metas = headTags(bytes.subarray(0, 2048).toString("latin1")).metas;
  const declared = charsetOf(contentType) ?? metas.find((a) => a.charset)?.charset ?? charsetOf(metas.find((a) => a["http-equiv"]?.toLowerCase() === "content-type")?.content);
  try {
    return new TextDecoder(declared ?? "utf-8").decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

let shrinking: Promise<unknown> = Promise.resolve();
/**
 * Bigger than any picture a page shows for its link (they're about 1200 by 630): one this size is
 * something else, and isn't decoded, as decoding one takes long and needs a lot of memory. Read from
 * the picture's own header first.
 */
export const MAX_PICTURE_SIDE = 4000;
const MAX_MEGAPIXELS = 8;

/** A JPEG's width and height, from its frame header (the first SOF marker); null when it has none. */
export function jpegSize(bytes: Uint8Array): [number, number] | null {
  let i = 2;
  while (i + 9 < bytes.length) {
    if (bytes[i] !== 0xff) return null;
    const marker = bytes[i + 1]!;
    // Fill bytes, and markers that stand alone.
    if (marker === 0xff) {
      i += 1;
      continue;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      i += 2;
      continue;
    }
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return [(bytes[i + 7]! << 8) | bytes[i + 8]!, (bytes[i + 5]! << 8) | bytes[i + 6]!];
    }
    i += 2 + ((bytes[i + 2]! << 8) | bytes[i + 3]!);
  }
  return null;
}

/** Whether a picture's header says it's small enough to decode. */
const decodable = (size: [number, number] | null) =>
  Boolean(size && size[0] > 0 && size[1] > 0 && size[0] <= MAX_PICTURE_SIDE && size[1] <= MAX_PICTURE_SIDE && size[0] * size[1] <= MAX_MEGAPIXELS * 1_000_000);

/** A JPEG or PNG, as a small JPEG data: address; null for anything else, or one that doesn't decode. One at a time, with the server free between them. */
export function previewPicture(bytes: Uint8Array, max = PREVIEW_LIMITS.imagePx): Promise<string | null> {
  const next = shrinking
    .then(() => new Promise((resolve) => setImmediate(resolve)))
    .then(() => {
      let pixels: Rgba;
      if (isJpeg(bytes)) {
        if (!decodable(jpegSize(bytes))) return null;
        const photo = decode(bytes, { useTArray: true, formatAsRGBA: true, maxResolutionInMP: MAX_MEGAPIXELS, maxMemoryUsageInMB: 64 });
        pixels = { data: photo.data, width: photo.width, height: photo.height };
      } else if (isPng(bytes)) {
        if (!decodable(pngSize(bytes))) return null;
        const png = PNG.sync.read(Buffer.from(bytes));
        // On white: a see-through picture would come out black as a JPEG.
        const data = new Uint8Array(png.data);
        for (let i = 0; i < data.length; i += 4) {
          const alpha = data[i + 3]! / 255;
          for (let c = 0; c < 3; c++) data[i + c] = Math.round(data[i + c]! * alpha + 255 * (1 - alpha));
          data[i + 3] = 255;
        }
        pixels = { data, width: png.width, height: png.height };
      } else return null;
      const small = shrinkRgba(pixels, max);
      return `data:image/jpeg;base64,${Buffer.from(encode(small, 72).data).toString("base64")}`;
    })
    .catch(() => null);
  shrinking = next;
  return next;
}

async function readPicture(href: string, limits: Limits): Promise<string | null> {
  const url = previewable(href);
  if (!url) return null;
  try {
    const page = await publicPage(url, "image/jpeg, image/png;q=0.9", AbortSignal.timeout(limits.timeoutMs), limits);
    if (!page) return null;
    const type = String(page.response.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
    if (type !== "image/jpeg" && type !== "image/png" && type !== "image/jpg") {
      page.response.destroy();
      return null;
    }
    const length = Number(page.response.headers["content-length"] ?? 0);
    if (length > limits.imageBytes) {
      page.response.destroy();
      return null;
    }
    const { bytes, whole } = await readSome(page.response, limits.imageBytes, false);
    return whole ? await previewPicture(bytes, limits.imagePx) : null;
  } catch {
    return null;
  }
}

/**
 * The preview of a public web page, or null when there's none to show: not a page Crewtavo may
 * read, not HTML, an error, too slow, or nothing on it to show.
 */
export async function fetchPreview(link: string | URL, limits: Limits = PREVIEW_LIMITS): Promise<LinkPreview | null> {
  const start = previewable(String(link));
  if (!start) return null;
  let found: { response: IncomingMessage; url: URL } | null;
  let html: string;
  try {
    found = await publicPage(start, "text/html, application/xhtml+xml;q=0.9", AbortSignal.timeout(limits.timeoutMs), limits);
    if (!found) return null;
    const type = String(found.response.headers["content-type"] ?? "").toLowerCase();
    if (!/^\s*(text\/html|application\/xhtml\+xml)\b/.test(type)) {
      found.response.destroy();
      return null;
    }
    html = decodeHtml((await readSome(found.response, limits.pageBytes, true)).bytes, type);
  } catch {
    return null;
  }
  const head = readHead(html, found.url);
  if (!head.title && !head.description) return null;
  return {
    url: found.url.toString(),
    title: head.title,
    description: head.description,
    site_name: head.site_name,
    image: head.image ? await readPicture(head.image, limits) : null,
  };
}
