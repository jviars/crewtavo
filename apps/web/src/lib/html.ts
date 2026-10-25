/** Sanitizing user-written rich text (SOPs, notes) to a small, safe subset of HTML. */
import { videoAttributes, videoEmbed } from "@crewtavo/core/video";
import DOMPurify from "dompurify";

// div holds callouts (data-callout) and checklist items (ul data-type="taskList" > li data-checked); data-* attributes pass by default.
const ALLOWED_TAGS = ["p", "br", "h2", "h3", "h4", "strong", "b", "em", "i", "u", "s", "ul", "ol", "li", "blockquote", "a", "hr", "code", "pre", "img", "iframe", "table", "thead", "tbody", "tr", "th", "td", "div"];
const ALLOWED_ATTR = ["href", "src", "alt", "title", "target", "rel", "colspan", "rowspan"];

let hooked = false;
function ensureHooks() {
  if (hooked) return;
  hooked = true;
  // Links open in a new tab and never get access to this window.
  DOMPurify.addHook("afterSanitizeAttributes", (node) => {
    if (node.tagName === "A" && node.getAttribute("href")) {
      node.setAttribute("target", "_blank");
      node.setAttribute("rel", "noopener noreferrer nofollow");
    }
    // Videos: only YouTube and Vimeo players, rebuilt from the video's id with our own attributes.
    if (node.tagName === "IFRAME") {
      const video = videoEmbed(node.getAttribute("src") ?? "");
      for (const { name } of [...node.attributes]) node.removeAttribute(name);
      if (!video) return node.remove();
      for (const [name, value] of Object.entries(videoAttributes(video))) node.setAttribute(name, value);
    }
  });
}

export function sanitizeHtml(html: string): string {
  ensureHooks();
  return DOMPurify.sanitize(html, { ALLOWED_TAGS, ALLOWED_ATTR, ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|tel:|\/)/i });
}

/** Whether a guide has anything to read or watch. */
export const hasContent = (html: string) => Boolean(htmlToText(html)) || /<(img|iframe)\b/i.test(sanitizeHtml(html));

/** Plain text for search: block elements become line breaks. */
export function htmlToText(html: string): string {
  const doc = new DOMParser().parseFromString(`<div>${sanitizeHtml(html)}</div>`, "text/html");
  doc.querySelectorAll("p, h2, h3, h4, li, blockquote, pre, tr, br").forEach((el) => el.append("\n"));
  return (doc.body.textContent ?? "").replace(/\n{3,}/g, "\n\n").trim();
}

export interface Section { id: string; title: string; level: 2 | 3 }

const slug = (text: string) =>
  text.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "section";

/**
 * A guide's sections for "On this page": each h2 and h3 gets an id from its words (so a link can
 * point at it, like /kb/…#mixing-ratio) and a "#" link to copy. Takes sanitized HTML.
 */
export function withSections(html: string): { html: string; sections: Section[] } {
  const doc = new DOMParser().parseFromString(`<div>${html}</div>`, "text/html");
  const root = doc.body.firstElementChild!;
  const used = new Set<string>();
  const sections: Section[] = [];
  root.querySelectorAll("h2, h3").forEach((heading) => {
    const title = heading.textContent?.trim() ?? "";
    if (!title) return;
    let id = slug(title);
    for (let n = 2; used.has(id); n++) id = `${slug(title)}-${n}`;
    used.add(id);
    heading.id = id;
    const anchor = doc.createElement("a");
    anchor.className = "heading-anchor";
    anchor.setAttribute("href", `#${id}`);
    anchor.setAttribute("aria-label", "Copy a link to this section");
    anchor.textContent = "#";
    heading.append(anchor);
    sections.push({ id, title, level: heading.tagName === "H2" ? 2 : 3 });
  });
  return { html: root.innerHTML, sections };
}

export const escapeHtml =(s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** Plain text (e.g. pasted) to paragraphs. */
export const textToHtml = (text: string) =>
  text
    .split(/\n{2,}/)
    .map((block) => `<p>${escapeHtml(block).replace(/\n/g, "<br>")}</p>`)
    .join("");

// ---------------------------------------------------------------------------------------------
// Contract sections (Settings → Contract terms), printed on estimates and invoices
// ---------------------------------------------------------------------------------------------

/** What a contract section may hold: words and their formatting, lists, quotes, rules and tables. No links, pictures or video. */
const CONTRACT_TAGS = ["p", "br", "h3", "h4", "strong", "b", "em", "i", "u", "s", "ul", "ol", "li", "blockquote", "hr", "table", "thead", "tbody", "tr", "th", "td"];
const CONTRACT_ATTR = ["colspan", "rowspan"];

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** HTML as plain text without a browser: tags dropped, block ends as line breaks, entities read. */
function plainText(html: string): string {
  return html
    .replace(/<(script|style|template|iframe)\b[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|h[1-6]|li|blockquote|tr|div|section|article|address|pre|header|footer|main|aside|figure|figcaption|center|dt|dd)\s*>/gi, "\n")
    .replace(/<\/?[a-z!?][^>]*>?/gi, "")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
      if (name[0] !== "#") return ENTITIES[name.toLowerCase()] ?? whole;
      const code = name[1] === "x" || name[1] === "X" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
    })
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Headings a contract doesn't use, as the ones it does: big ones as h3, small ones as h4. */
const HEADINGS: Record<string, string> = { H1: "h3", H2: "h3", H5: "h4", H6: "h4" };
/** Boxes of words a contract doesn't use (from pasted or other editors' HTML): each prints as its own paragraph. */
const BOXES = new Set(["DIV", "SECTION", "ARTICLE", "ADDRESS", "PRE", "HEADER", "FOOTER", "MAIN", "ASIDE", "NAV", "FIGURE", "FIGCAPTION", "CENTER", "DL", "DT", "DD", "DETAILS", "SUMMARY", "FIELDSET", "LEGEND", "FORM"]);
const BLOCKS = new Set(["P", "H1", "H2", "H3", "H4", "H5", "H6", "UL", "OL", "LI", "TABLE", "BLOCKQUOTE", "HR", ...BOXES]);

/** `el` swapped for `tag` with the same children. */
function rename(el: Element, tag: string) {
  const next = el.ownerDocument.createElement(tag);
  next.append(...Array.from(el.childNodes));
  el.replaceWith(next);
}

/**
 * Headings and boxes of words a contract can't hold turned into ones it can, before cleaning drops
 * them (keeping their words, which would otherwise run into the next paragraph's): an h2 is an h3,
 * a div of words a paragraph, a div of paragraphs just its paragraphs.
 */
function reshape(html: string): string {
  const doc = new DOMParser().parseFromString(`<!doctype html><body>${html}</body>`, "text/html");
  // The innermost first, so each box's children are already what they'll be.
  for (const el of Array.from(doc.body.querySelectorAll("*")).reverse()) {
    const heading = HEADINGS[el.tagName];
    if (heading) {
      rename(el, heading);
      continue;
    }
    if (!BOXES.has(el.tagName)) continue;
    if (el.tagName === "PRE") {
      for (const text of Array.from(el.childNodes).filter((n): n is Text => n instanceof Text)) {
        const lines = text.data.split("\n");
        text.replaceWith(...lines.flatMap((line, i) => (i ? [doc.createElement("br"), line] : [line])));
      }
    }
    if (!Array.from(el.children).some((c) => BLOCKS.has(c.tagName))) {
      rename(el, "p");
      continue;
    }
    // Paragraphs and lists inside: each run of words between them is a paragraph of its own, and the box goes.
    const out: Node[] = [];
    let run: Node[] = [];
    const flush = () => {
      if (run.some((n) => n.textContent?.trim())) {
        const p = doc.createElement("p");
        p.append(...run);
        out.push(p);
      }
      run = [];
    };
    for (const node of Array.from(el.childNodes)) {
      if (node instanceof Element && BLOCKS.has(node.tagName)) {
        flush();
        out.push(node);
      } else run.push(node);
    }
    flush();
    el.replaceWith(...out);
  }
  return doc.body.innerHTML;
}

/**
 * A contract section's HTML cleaned to what may print on a contract (tags above, no attributes but
 * a table cell's colspan and rowspan). Headings and boxes of words it can't hold become ones it can
 * first, so no words run together. Without a browser (the server, tests) it's the section's words
 * as escaped plain text, never HTML.
 */
export function sanitizeContractHtml(html: string): string {
  if (!DOMPurify.isSupported || typeof DOMParser === "undefined") return escapeHtml(plainText(html));
  return DOMPurify.sanitize(reshape(html), { ALLOWED_TAGS: CONTRACT_TAGS, ALLOWED_ATTR: CONTRACT_ATTR, ALLOW_DATA_ATTR: false, ALLOW_ARIA_ATTR: false });
}

export interface ContractCell {
  tag: "td" | "th";
  /** Cleaned HTML. */
  html: string;
  colSpan: number;
}

/** A row of a contract's table as it's written: whether it's in the table's head, and its cells with how many columns and rows each spans. */
export interface ContractTableRow {
  thead: boolean;
  cells: Array<ContractCell & { rowSpan: number }>;
}

/**
 * A contract's table as the rows it prints in, each a block of its own (so a page can end between
 * any two): a cell spanning rows prints in its first row, with an empty cell under it in each row
 * it spanned, so every row keeps its columns. The rows at the top that are the table's head (or all
 * headings) are `head`, repeated over the rows carried on to another page; never the last row.
 */
export function contractTable(rows: ContractTableRow[], table: number): Array<Extract<ContractBlock, { kind: "row" }>> {
  // By column: a cell above still spanning down, and how many more rows it spans.
  const above: Array<{ rows: number; colSpan: number; tag: ContractCell["tag"] } | undefined> = [];
  const spanning = (from: number) => above.some((a, col) => col >= from && a && a.rows > 0);
  const printed = rows.map((row) => {
    const cells: ContractCell[] = [];
    const queue = [...row.cells];
    for (let col = 0; ; ) {
      const held = above[col];
      if (held && held.rows > 0) {
        cells.push({ tag: held.tag, html: "", colSpan: held.colSpan });
        held.rows--;
        col += held.colSpan;
        continue;
      }
      const cell = queue.shift();
      if (!cell) {
        if (!spanning(col)) break;
        // A short row, with a spanning cell further along: an empty cell keeps the columns lined up.
        cells.push({ tag: "td", html: "", colSpan: 1 });
        col++;
        continue;
      }
      cells.push({ tag: cell.tag, html: cell.html, colSpan: cell.colSpan });
      for (let c = col + 1; c < col + cell.colSpan; c++) if (above[c]) above[c]!.rows = 0;
      above[col] = cell.rowSpan > 1 ? { rows: cell.rowSpan - 1, colSpan: cell.colSpan, tag: cell.tag } : undefined;
      col += cell.colSpan;
    }
    return cells;
  });
  const columns = Math.max(1, ...printed.map((cells) => cells.reduce((n, c) => n + c.colSpan, 0)));
  let heading = true;
  return rows.map((row, i) => {
    heading = heading && (row.thead || (row.cells.length > 0 && row.cells.every((c) => c.tag === "th")));
    return { kind: "row", table, head: heading && i < rows.length - 1, columns, cells: printed[i]! };
  });
}

/**
 * A contract section's body in the pieces a page can end between: each paragraph (words outside
 * any paragraph make one), heading, rule, list item (numbered as in its list), child of a quote
 * (`quote` tells quotes apart) and table row (`head` for the rows over a table's body; `table`
 * tells tables apart). All HTML is cleaned. "text" is the whole body as plain text, without a browser.
 */
export type ContractBlock =
  | { kind: "p" | "h3" | "h4"; html: string }
  | { kind: "hr" }
  | { kind: "li"; list: "ul" | "ol"; number: number; html: string }
  | { kind: "quote"; quote: number; html: string }
  | { kind: "row"; table: number; head: boolean; columns: number; cells: ContractCell[] }
  | { kind: "text"; html: string };

const INLINE = new Set(["#text", "BR", "STRONG", "B", "EM", "I", "U", "S"]);
const CONTRACT_CACHE = new Map<string, ContractBlock[]>();

const hasWords = (node: Node) => Boolean(node.textContent?.trim());

/** Runs of words and inline formatting in `nodes`, each as one paragraph, between the blocks. */
function groupInline(nodes: Node[], each: (block: { inline: string } | { element: Element }) => void) {
  let run: Node[] = [];
  const flush = () => {
    if (run.some(hasWords)) {
      const box = document.createElement("div");
      for (const node of run) box.append(node.cloneNode(true));
      each({ inline: box.innerHTML.trim() });
    }
    run = [];
  };
  for (const node of nodes) {
    if (INLINE.has(node.nodeName)) run.push(node);
    else if (node instanceof Element) {
      flush();
      each({ element: node });
    }
  }
  flush();
}

/** A contract section's body (raw HTML from the library, fill-ins filled) as the blocks it prints in. */
export function contractBlocks(html: string): ContractBlock[] {
  const clean = sanitizeContractHtml(html);
  if (!DOMPurify.isSupported || typeof DOMParser === "undefined") return clean.trim() ? [{ kind: "text", html: clean }] : [];
  const cached = CONTRACT_CACHE.get(html);
  if (cached) return cached;

  const doc = new DOMParser().parseFromString(`<!doctype html><body>${clean}</body>`, "text/html");
  const blocks: ContractBlock[] = [];
  let tables = 0;
  let quotes = 0;
  groupInline(Array.from(doc.body.childNodes), (part) => {
    if ("inline" in part) return blocks.push({ kind: "p", html: part.inline });
    const el = part.element;
    const tag = el.tagName.toLowerCase();
    if (tag === "hr") return blocks.push({ kind: "hr" });
    if (tag === "h3" || tag === "h4") return hasWords(el) && blocks.push({ kind: tag, html: el.innerHTML.trim() });
    if (tag === "ul" || tag === "ol") {
      let number = 0;
      for (const li of Array.from(el.children)) if (li.tagName === "LI" && hasWords(li)) blocks.push({ kind: "li", list: tag, number: ++number, html: li.innerHTML.trim() });
      return;
    }
    if (tag === "blockquote") {
      const quote = ++quotes;
      groupInline(Array.from(el.childNodes), (child) => blocks.push({ kind: "quote", quote, html: "inline" in child ? `<p>${child.inline}</p>` : child.element.outerHTML }));
      return;
    }
    if (tag === "table") {
      const span = (c: Element, name: string) => Math.max(1, Math.min(50, Number(c.getAttribute(name)) || 1));
      const rows = Array.from(el.querySelectorAll("tr"))
        .filter((tr) => tr.closest("table") === el)
        .map((tr): ContractTableRow => ({
          thead: tr.parentElement?.tagName === "THEAD",
          cells: Array.from(tr.children)
            .filter((c) => c.tagName === "TD" || c.tagName === "TH")
            .map((c) => ({ tag: c.tagName === "TH" ? "th" : "td", html: c.innerHTML.trim(), colSpan: span(c, "colspan"), rowSpan: span(c, "rowspan") })),
        }));
      blocks.push(...contractTable(rows, ++tables));
      return;
    }
    // Anything else left at the top (a list item out of its list, say) prints as a paragraph.
    if (hasWords(el)) blocks.push({ kind: "p", html: el.innerHTML.trim() });
  });

  if (CONTRACT_CACHE.size >= 200) CONTRACT_CACHE.delete(CONTRACT_CACHE.keys().next().value!);
  CONTRACT_CACHE.set(html, blocks);
  return blocks;
}
