/**
 * The paper an estimate or invoice is drawn on, the same on screen and in print, and the few
 * browser facts the pages need. EstimateDocument.tsx draws the pages; paginate.ts decides what goes
 * on each.
 *
 * A letter page is 8.5 × 11 in: 816 × 1056 CSS px. Every page keeps a white margin of 0.4 in on each
 * side (the @page margin when it prints), and everything on it (the letterhead, the body and the
 * footer) is in the content box inside: 7.7 × 10.2 in, the width the business's own letterhead
 * pictures are cut for (letterhead.ts). The body's words sit a little further in.
 */
import type { CSSProperties } from "react";
import type { PaperSpace } from "./paginate";

/** 8.5 × 11 in at 96 dpi. */
export const PAGE_WIDTH = 816;
export const PAGE_HEIGHT = 1056;
/** 0.4 in on every side. */
export const PAGE_MARGIN = 38.4;
/** The content box: 7.7 × 10.2 in. */
export const CONTENT_WIDTH = 739.2;
export const CONTENT_HEIGHT = 979.2;
/** How far in from the content box the words sit (44 px from the paper's edge, all told). */
export const BODY_INSET = 6;
/** Space at the top and bottom of the body, between the letterhead and the footer. */
export const BODY_PAD_TOP = 26;
export const BODY_PAD_BOTTOM = 20;
/** Kept free at the bottom of every page, so rounding never pushes a line onto another sheet. */
export const PAGE_SLACK = 8;
/** Between pages on screen. */
export const PAGE_GAP = 24;
/**
 * Safari (on a Mac, and every browser on an iPad or iPhone) prints inside its own margins, with a
 * header and footer, as well as the @page margin. So there each page is printed this much smaller
 * (its content box 5.8 × 7.65 in), inside a thin @page margin (WEBKIT_PAGE_MARGIN): it fits the
 * room an iPad leaves on a letter sheet, with some to spare.
 */
export const WEBKIT_PRINT_SCALE = 0.75;
/**
 * The @page margin when WebKit prints: thin, since its own margins are on top of it, but not none,
 * so a page never touches the edge of a sheet the printer leaves no margin on.
 */
export const WEBKIT_PAGE_MARGIN = "0.1in";

/** Whether this browser prints through WebKit: Safari on a Mac, and every browser on an iPad or iPhone. */
export const isWebKit = () => typeof navigator !== "undefined" && (navigator.vendor ?? "").startsWith("Apple");

/** The measurements above, for EstimateDocument.module.css. */
export const PAPER_VARS = {
  "--page-w": `${PAGE_WIDTH}px`,
  "--page-h": `${PAGE_HEIGHT}px`,
  "--page-margin": `${PAGE_MARGIN}px`,
  "--page-gap": `${PAGE_GAP}px`,
  "--box-w": `${CONTENT_WIDTH}px`,
  "--box-h": `${CONTENT_HEIGHT}px`,
  "--doc-pad": `${BODY_INSET}px`,
  "--pad-top": `${BODY_PAD_TOP}px`,
  "--pad-bottom": `${BODY_PAD_BOTTOM}px`,
} as CSSProperties;

/** The room for the body on each page, from the measured letterhead, running header and footer. */
export function paperSpace(parts: { letterhead: number; running: number; footer: number }): PaperSpace {
  return {
    first: CONTENT_HEIGHT - parts.letterhead - parts.footer,
    rest: CONTENT_HEIGHT - parts.running - parts.footer,
    padTop: BODY_PAD_TOP,
    padBottom: BODY_PAD_BOTTOM,
    slack: PAGE_SLACK,
  };
}

/** How tall a stack of `pages` pages is on screen. */
export const stackHeight = (pages: number) => pages * PAGE_HEIGHT + Math.max(0, pages - 1) * PAGE_GAP;

// ---------------------------------------------------------------------------------------------
// Cutting a block between its lines (in the hidden copy usePaper measures)
// ---------------------------------------------------------------------------------------------

/**
 * The boxes of words in a block that may be cut between their lines: EstimateDocument marks them
 * `data-split` (a paragraph's words, each cell of a contract table's row, a line's name and
 * description). Everything else in a block (a line's amounts, the "Notes" label) stays whole, in
 * its first part.
 */
const SPLIT = "[data-split]";

/** The boxes the browser drew a text node's words in, from `top`; none for words it didn't draw. */
function rectsOf(range: Range, top: number): Array<{ top: number; bottom: number }> {
  return Array.from(range.getClientRects())
    .filter((r) => r.height > 0)
    .map((r) => ({ top: r.top - top, bottom: r.bottom - top }));
}

/**
 * Where a block can be cut between its lines: just under each line of the words in its `data-split`
 * boxes, below everything else in it and under at least one of their lines (so a part is never
 * just the "Notes" label, or a line's name without its words). In px from its top, lowest first.
 * Lines side by side (a row's cells) count as one.
 */
export function lineCuts(el: HTMLElement): number[] {
  const top = el.getBoundingClientRect().top;
  const range = document.createRange();
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  const boxes: Array<{ top: number; bottom: number; split: boolean }> = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!node.nodeValue?.trim()) continue;
    const owner = node.parentElement?.closest(SPLIT);
    const split = Boolean(owner && el.contains(owner));
    range.selectNodeContents(node);
    for (const r of rectsOf(range, top)) boxes.push({ ...r, split });
  }
  boxes.sort((a, b) => a.top - b.top);
  const lines: Array<{ top: number; bottom: number; split: boolean; fixed: boolean }> = [];
  for (const box of boxes) {
    const last = lines[lines.length - 1];
    if (last && box.top < last.bottom - 1) {
      last.bottom = Math.max(last.bottom, box.bottom);
      last.split ||= box.split;
      last.fixed ||= !box.split;
    } else lines.push({ top: box.top, bottom: box.bottom, split: box.split, fixed: !box.split });
  }
  const firstSplit = lines.findIndex((l) => l.split);
  let lastFixed = -1;
  lines.forEach((l, i) => l.fixed && (lastFixed = i));
  const cuts: number[] = [];
  for (let i = Math.max(firstSplit, lastFixed); firstSplit >= 0 && i + 1 < lines.length; i++) {
    // Halfway between this line's bottom and the next one's top: all of this line, none of the next.
    const cut = Math.round(((lines[i]!.bottom + Math.max(lines[i]!.bottom, lines[i + 1]!.top)) / 2) * 10) / 10;
    if (cut > 1 && cut > (cuts[cuts.length - 1] ?? 0)) cuts.push(cut);
  }
  return cuts;
}

/** A place in a box of words: before the character at `offset` in a text node, or (the box itself) at its end. */
interface Point {
  node: Node;
  offset: number;
}

/** Where `box`'s words are cut at `at` px below `top`: before the first character of its first line under `at`. */
function pointAt(box: Element, top: number, at: number): Point {
  const range = document.createRange();
  const walker = document.createTreeWalker(box, NodeFilter.SHOW_TEXT);
  /** Whether character `k` of `node` is drawn under the cut; null for one that isn't drawn (a collapsed space). */
  const under = (node: Text, k: number) => {
    range.setStart(node, k);
    range.setEnd(node, k + 1);
    const r = rectsOf(range, top)[0];
    return r ? (r.top + r.bottom) / 2 >= at : null;
  };
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    range.selectNodeContents(node);
    const rects = rectsOf(range, top);
    if (!rects.some((r) => (r.top + r.bottom) / 2 >= at)) continue;
    // Its first character under the cut: lines go down as the words go on, so halve the search.
    let lo = 0;
    let hi = node.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      let k = mid;
      let below = under(node, k);
      while (below === null && k + 1 < hi) below = under(node, ++k);
      if (below === false) lo = k + 1;
      else hi = mid;
    }
    return { node, offset: lo };
  }
  return { node: box, offset: box.childNodes.length };
}

/** How many characters of `box`'s words come before `point`. */
function charsBefore(box: Element, point: Point): number {
  const range = document.createRange();
  range.setStart(box, 0);
  range.setEnd(point.node, point.offset);
  return range.toString().length;
}

/** The child indexes from `box` down to `node`. */
function pathTo(box: Node, node: Node): number[] {
  const path: number[] = [];
  for (let n = node; n !== box && n.parentNode; n = n.parentNode) path.unshift(Array.prototype.indexOf.call(n.parentNode.childNodes, n));
  return path;
}

const follow = (root: Node, path: number[]) => path.reduce<Node>((n, i) => n.childNodes[i]!, root);

/**
 * The HTML of `box`'s words from `a` to `b` (null for its start or end), inside the elements they're
 * in (so bold stays bold, a list item stays in its list). A list item carried on from the page
 * before is marked `data-carried`, to be drawn without its number or bullet, and a numbered list
 * carried on starts at the item it carries on with.
 */
function partHtml(box: Element, a: Point | null, b: Point | null): string {
  const copy = box.cloneNode(true) as Element;
  const range = document.createRange();
  if (b) {
    const end = follow(copy, pathTo(box, b.node));
    range.setStart(end, b.offset);
    range.setEnd(copy, copy.childNodes.length);
    range.deleteContents();
    // What's left empty where the cut was (the next item, started on the next line) goes too.
    for (let n: Node | null = end; n && n !== copy; ) {
      const parent: Node | null = n.parentNode;
      const empty = n instanceof Element ? !n.textContent && !n.querySelector("br, hr") : n instanceof Text && !n.data;
      if (!empty) break;
      n.parentNode?.removeChild(n);
      n = parent;
    }
  }
  if (a) {
    const path = pathTo(box, a.node);
    // The elements it's in: whether each list item started above the cut, and the number each numbered list carries on from.
    const marks = path.slice(0, -1).map((_, depth) => {
      const el = follow(box, path.slice(0, depth + 1)) as Element;
      const before = document.createRange();
      before.setStart(el, 0);
      before.setEnd(a.node, a.offset);
      const items = el instanceof HTMLOListElement ? Array.from(el.childNodes).slice(0, path[depth + 1]).filter((c) => c.nodeName === "LI").length : null;
      return { el: follow(copy, path.slice(0, depth + 1)) as Element, carried: el.tagName === "LI" && Boolean(before.toString().trim()), start: items === null ? null : (el as HTMLOListElement).start + items };
    });
    range.setStart(copy, 0);
    range.setEnd(follow(copy, path), a.offset);
    range.deleteContents();
    for (const mark of marks) {
      if (mark.carried) mark.el.setAttribute("data-carried", "");
      if (mark.start !== null) mark.el.setAttribute("start", String(mark.start));
    }
  }
  return copy.innerHTML;
}

/** The words of part of a block cut between pages, for one box of words in it: characters `from` to `to`, and as HTML. */
export interface PaperWords {
  from: number;
  to: number;
  html: string;
}

/**
 * The words of the part of a block from `from` px to `to` px (null for its top or bottom; each a cut
 * from lineCuts), for each of its `data-split` boxes in order. Lets the page draw just that part,
 * so a page never holds words it doesn't show.
 */
export function cutWords(el: HTMLElement, from: number | null, to: number | null): PaperWords[] {
  const top = el.getBoundingClientRect().top;
  return Array.from(el.querySelectorAll(SPLIT)).map((box) => {
    const a = from === null ? null : pointAt(box, top, from);
    const b = to === null ? null : pointAt(box, top, to);
    const words = { from: a ? charsBefore(box, a) : 0, to: b ? charsBefore(box, b) : (box.textContent ?? "").length };
    return { ...words, html: words.to > words.from ? partHtml(box, a, b) : "" };
  });
}

/** After the browser has drawn `count` more frames (or, in a tab that isn't showing, soon after). */
export function nextFrames(count = 2): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, 200 * count);
    const step = (left: number) =>
      requestAnimationFrame(() => {
        if (left > 1) return step(left - 1);
        clearTimeout(timer);
        resolve();
      });
    step(count);
  });
}

/**
 * Once every document on the page that prints (PrintableDocument) has laid out its pages for good:
 * after its lettering and pictures loaded. Waits `waitMs` at most.
 */
export function paperSettled(waitMs = 2000): Promise<void> {
  const settled = () => Array.from(document.querySelectorAll("[data-printable-document]")).every((el) => el.hasAttribute("data-paginated"));
  const end = Date.now() + waitMs;
  return new Promise((resolve) => {
    const check = () => (settled() || Date.now() >= end ? resolve() : setTimeout(check, 30));
    check();
  });
}
