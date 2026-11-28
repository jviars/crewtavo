/**
 * What a team chat message carries besides its words, shared by the web app and the API: the files
 * it can take (the endings the database allows, private.chat_file_endings() in
 * supabase/migrations/20261129100000_chat_files_and_audio.sql), the links in it and the Crewtavo
 * records they name, its own address, and how a search's words are found in it again to mark them.
 */
import { chatBlocks, type ChatBlock, type ChatInline } from "./chat";

/** The parts of URL (browsers' and Node's) used here: core is built without either's types. */
type WebUrl = { origin: string; pathname: string };
declare const URL: new (url: string, base?: string) => WebUrl;

// ---------------------------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------------------------

/** The endings a message's files may have, by kind, as private.chat_file_endings() lists them. */
export const CHAT_PHOTO_ENDINGS = ["jpg", "jpeg", "png", "webp", "gif", "heic", "heif"] as const;
export const CHAT_DOCUMENT_ENDINGS = ["pdf", "doc", "docx", "xls", "xlsx", "csv", "txt", "rtf", "ppt", "pptx", "odt", "ods", "odp"] as const;
export const CHAT_AUDIO_ENDINGS = ["webm", "weba", "m4a", "mp4", "aac", "mp3", "mpga", "ogg", "oga", "opus", "wav"] as const;

/** Up to six files a message, each up to 15 MB (lib/files.ts in the web app). */
export const CHAT_MAX_FILES = 6;
export const CHAT_MAX_FILE_BYTES = 15 * 1024 * 1024;

/** What the file picker offers for "Choose a file": the document endings, with their types for phones that go by type. */
export const CHAT_DOCUMENT_ACCEPT = [
  ...CHAT_DOCUMENT_ENDINGS.map((e) => `.${e}`),
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "text/plain",
  "text/csv",
].join(",");

export type ChatFileKind = "photo" | "document" | "audio";

const ending = (name: string | null | undefined) => /\.([a-z0-9]+)$/i.exec(name ?? "")?.[1]?.toLowerCase() ?? "";

/** What a stored file is, by the ending it's stored under (or, before it's stored, its name or type). Null when a message can't carry it. */
export function chatFileKind(file: { path?: string | null; name?: string | null; type?: string | null }): ChatFileKind | null {
  const end = ending(file.path) || ending(file.name);
  if ((CHAT_PHOTO_ENDINGS as readonly string[]).includes(end)) return "photo";
  if ((CHAT_DOCUMENT_ENDINGS as readonly string[]).includes(end)) return "document";
  if ((CHAT_AUDIO_ENDINGS as readonly string[]).includes(end)) return "audio";
  if (!end && file.type?.startsWith("image/")) return "photo";
  return null;
}

/** Documents by their kind, for a card's icon and its short label ("PDF", "Word"). */
export type ChatDocumentType = "pdf" | "word" | "sheet" | "slides" | "text" | "csv";
const DOCUMENT_TYPES: Record<string, ChatDocumentType> = {
  pdf: "pdf", doc: "word", docx: "word", odt: "word", rtf: "word",
  xls: "sheet", xlsx: "sheet", ods: "sheet", csv: "csv",
  ppt: "slides", pptx: "slides", odp: "slides", txt: "text",
};
export const chatDocumentType = (file: { path?: string | null; name?: string | null }): ChatDocumentType =>
  DOCUMENT_TYPES[ending(file.path) || ending(file.name)] ?? "text";

/** "PDF", "Word", "Excel", "PowerPoint", "Text", "CSV": the names people know these files by (the same in every language). */
export const CHAT_DOCUMENT_LABELS: Record<ChatDocumentType, string> = { pdf: "PDF", word: "Word", sheet: "Excel", slides: "PowerPoint", text: "Text", csv: "CSV" };

/** A size as a file card shows it: "820 KB", "1.2 MB". */
export function fileSize(bytes: number | null | undefined): string | null {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0) return null;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  const mb = bytes / (1024 * 1024);
  return `${mb < 10 ? mb.toFixed(1).replace(/\.0$/, "") : Math.round(mb)} MB`;
}

// ---------------------------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------------------------

/** A message's own address, to copy and send: it opens the channel at the message. */
export const chatMessageLink = (origin: string, channelId: string, messageId: string) => `${origin.replace(/\/$/, "")}/chat/${channelId}?message=${messageId}`;

/** The http(s) links in a message, once each, in the order they're written. Links inside code (`like this`, or a code block) aren't links. */
export function messageLinks(body: string): string[] {
  const out: string[] = [];
  const inline = (nodes: ChatInline[]) => {
    for (const n of nodes) {
      if (n.kind === "link") {
        if (/^https?:\/\//i.test(n.href) && !out.includes(n.href)) out.push(n.href);
      } else if ("children" in n) inline(n.children);
    }
  };
  const block = (b: ChatBlock) => {
    if (b.kind === "paragraph") b.lines.forEach(inline);
    else if (b.kind === "heading") inline(b.children);
    else if (b.kind === "quote") b.blocks.forEach(block);
    else if (b.kind === "list") b.items.forEach(inline);
  };
  chatBlocks(body).forEach(block);
  return out;
}

export type ChatRecordKind = "quote" | "invoice" | "job" | "client" | "request";
export interface ChatRecordLink {
  kind: ChatRecordKind;
  id: string;
  /** A Client Hub link (what the client opens), not the record's own page. */
  hub: boolean;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PAGES: Record<string, ChatRecordKind> = { quotes: "quote", invoices: "invoice", jobs: "job", clients: "client", requests: "request" };

const BASE64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** Base64url as text, or null when it isn't plain ASCII (a link's payload never is anything else). */
function fromBase64Url(body: string): string | null {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const ch of body) {
    const n = BASE64URL.indexOf(ch);
    if (n < 0) return null;
    value = (value << 6) | n;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      const byte = (value >> bits) & 255;
      if (byte > 127) return null;
      out += String.fromCharCode(byte);
    }
  }
  return out;
}

/** A Client Hub link's payload (lib/links.ts in the API): its signature can't be checked here, and needn't be, as the record is read with the viewer's own access. */
function hubPayload(token: string): { t?: unknown; id?: unknown; c?: unknown } | null {
  const body = token.replace(/\.$/, "").split(".")[0] ?? "";
  if (!/^[A-Za-z0-9_-]{8,2000}$/.test(body)) return null;
  try {
    const text = fromBase64Url(body);
    if (text === null) return null;
    const value: unknown = JSON.parse(text);
    return value && typeof value === "object" ? (value as { t?: unknown; id?: unknown; c?: unknown }) : null;
  } catch {
    return null;
  }
}

/**
 * The record a link to this Crewtavo names: /quotes/:id, /invoices/:id, /jobs/:id, /clients/:id or
 * /requests/:id at `origin`, or a Client Hub link for a quote, an invoice or a client of `company`.
 * Null for anything else (another site, another screen, another business's link).
 */
export function chatRecordLink(href: string, origin: string, company?: string): ChatRecordLink | null {
  let url: WebUrl;
  let home: WebUrl;
  try {
    url = new URL(href);
    home = new URL(origin);
  } catch {
    return null;
  }
  if (url.origin !== home.origin) return null;
  const [first, second, third] = url.pathname.split("/").filter(Boolean);
  if (first && second && !third && PAGES[first] && UUID.test(second)) return { kind: PAGES[first]!, id: second.toLowerCase(), hub: false };
  if (first === "hub" && second && !third) {
    const payload = hubPayload(decodeURIComponent(second));
    if (!payload || typeof payload.id !== "string" || !UUID.test(payload.id)) return null;
    if (company && payload.c !== company) return null;
    if (payload.t === "quote" || payload.t === "invoice" || payload.t === "client") return { kind: payload.t, id: payload.id.toLowerCase(), hub: true };
  }
  return null;
}

/** The links under a message that get a card: its first three, leaving out this Crewtavo's own pages that aren't records. */
export function cardLinks(body: string, origin: string, company?: string, max = 3): Array<{ href: string; record: ChatRecordLink | null }> {
  let home: string | null = null;
  try {
    home = new URL(origin).origin;
  } catch {
    home = null;
  }
  return messageLinks(body)
    .map((href) => ({ href, record: chatRecordLink(href, origin, company) }))
    .filter(({ href, record }) => {
      if (record) return true;
      try {
        return new URL(href).origin !== home;
      } catch {
        return false;
      }
    })
    .slice(0, max);
}

// ---------------------------------------------------------------------------------------------
// Search: the words looked for, found again in what a result shows
// ---------------------------------------------------------------------------------------------

/** A search's words as the database splits them (public.chat_search): at spaces and punctuation, in lower case. */
export function searchWords(query: string): string[] {
  return [...new Set(query.toLowerCase().split(/[\s\p{P}\p{S}]+/u).filter(Boolean))].slice(0, 12);
}

/** The start of a word a search word matches, as the database's English stems do roughly: "fences" finds "fence". */
function stem(word: string): string {
  if (word.length < 5) return word;
  return word.replace(/(?:ies|es|s|ing|ed|ly)$/, "") || word;
}

export interface Marked {
  text: string;
  hit: boolean;
}

/** `text` in pieces, the parts a search for `query` matched marked: each word it starts (or shares a start with), or a word found inside another. */
export function markMatches(text: string, query: string): Marked[] {
  const lower = text.toLowerCase();
  // Lower case that changes a text's length (a dotted capital I) can't be lined up with it: no marks.
  if (lower.length !== text.length) return [{ text, hit: false }];
  const needles = [...new Set([...searchWords(query), query.trim().toLowerCase()].flatMap((w) => [w, stem(w)]).filter((w) => w.length >= 1))];
  const marks = new Array<boolean>(text.length).fill(false);
  for (const needle of needles) {
    for (let at = lower.indexOf(needle); at !== -1; at = lower.indexOf(needle, at + 1)) {
      // A one- or two-letter word only marks the start of a word, so "a" doesn't light up every a.
      const startsWord = at === 0 || !/[\p{L}\p{N}]/u.test(lower[at - 1]!);
      if (needle.length < 3 && !startsWord) continue;
      // The start of a word marks the whole word, as the search matched it ("fenc" finds "Fences").
      let end = at + needle.length;
      if (startsWord) while (end < lower.length && /[\p{L}\p{N}]/u.test(lower[end]!)) end += 1;
      marks.fill(true, at, end);
    }
  }
  const out: Marked[] = [];
  for (let i = 0; i < text.length; i++) {
    const last = out[out.length - 1];
    if (last && last.hit === marks[i]) last.text += text[i];
    else out.push({ text: text[i]!, hit: marks[i]! });
  }
  return out;
}

/** A long result cut to about `max` characters around the first word found, with "…" where it's cut. */
export function searchSnippet(text: string, query: string, max = 200): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  const lower = flat.toLowerCase();
  const first = searchWords(query)
    .flatMap((w) => [lower.indexOf(w), lower.indexOf(stem(w))])
    .filter((at) => at >= 0)
    .sort((a, b) => a - b)[0];
  if (first === undefined || first < max / 3) return `${flat.slice(0, max).replace(/\s+\S*$/, "")}…`;
  let start = Math.max(0, first - Math.floor(max / 3));
  // From the start of a word.
  const space = flat.indexOf(" ", start);
  if (space !== -1 && space < first) start = space + 1;
  const end = Math.min(flat.length, start + max);
  return `…${flat.slice(start, end).replace(/\s+\S*$/, "")}${end < flat.length ? "…" : ""}`;
}
