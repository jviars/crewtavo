/**
 * Which part of a document goes on which page. EstimateDocument.tsx measures the body as a list of
 * blocks (the parties, each line row, the totals, each paragraph of a contract section...) and this
 * fills letter pages with them, top to bottom, the way a person would: a heading never ends a page
 * alone, a table's head repeats when its rows go on to another page, the signatures sit at the
 * bottom of their page, and a block too tall for the room left is cut between two of its lines and
 * carried on at the top of the next page, so nothing is ever left off.
 *
 * Plain arithmetic on heights, with no browser, so it's tested on its own (test/paginate.test.ts).
 * paper.ts has the page's measurements.
 */

/** A block of the body, as measured. Heights and spaces are CSS px. */
export interface PaperBlock {
  key: string;
  height: number;
  /** Room above it, unless it starts a page. */
  spaceBefore?: number;
  /** Goes to the next page with the block after it rather than end a page alone. */
  keepWithNext?: boolean;
  /** Starts a new page. */
  breakBefore?: boolean;
  /** Sits at the bottom of its page with everything after it there, when the page has something above it. */
  pinBottom?: boolean;
  /** A row of a table: which table, and how tall its head is (repeated over its rows on a new page; 0 for none). */
  table?: { id: string; head: number };
  /** Where its lines end, in px from its top, lowest first: where it can be cut. Without any, it's never cut where it could move. */
  cuts?: number[];
  /** Moves to the next page whole when it doesn't fit, and is cut only when it's taller than a page. */
  whole?: boolean;
}

/** The room on a page for the body: between the letterhead (or running header) and the footer. */
export interface PaperSpace {
  /** The first page, under the letterhead. */
  first: number;
  /** Every later page, under the running header. */
  rest: number;
  /** Space at the top and bottom of the body. */
  padTop: number;
  padBottom: number;
  /** Kept free at the bottom of every page, so a fraction of a pixel never pushes a line over. */
  slack: number;
}

/** A block (or the part of it from `offset`, `height` tall) on a page. */
export interface PaperFragment {
  key: string;
  offset: number;
  height: number;
  /** Only part of the block: it's drawn through a window of this height. */
  part?: boolean;
}

export interface PaperPage {
  fragments: PaperFragment[];
  /** The table whose head repeats at the top of this page, over its rows carried on from the page before. */
  repeatHead: string | null;
  /** The fragment from which the rest of the page sits at its bottom. */
  pinFrom: number | null;
}

/** A document's pages, in order. There's always at least one. */
export type PaperLayout = PaperPage[];

const EPSILON = 0.01;
/** The least room left on a page for part of a block with no lines to cut at (rather than a sliver): else it starts the next page. */
const MIN_PART = 48;

/** How much body fits on page `index` (0 is the first). */
export const pageRoom = (space: PaperSpace, index: number) => Math.max(0, (index === 0 ? space.first : space.rest) - space.padTop - space.padBottom - space.slack);

/** The first cut past `from`, or undefined. */
const nextCut = (cuts: readonly number[] | undefined, from: number) => cuts?.find((c) => c > from + EPSILON);

/** The last cut in (`from`, `to`], or undefined. */
function lastCut(cuts: readonly number[] | undefined, from: number, to: number): number | undefined {
  let best: number | undefined;
  for (const c of cuts ?? []) {
    if (c > to + EPSILON) break;
    if (c > from + EPSILON) best = c;
  }
  return best;
}

/** Lays `blocks` out on pages of `space`. */
export function paginate(blocks: readonly PaperBlock[], space: PaperSpace): PaperLayout {
  const pages: PaperPage[] = [];
  let page!: PaperPage;
  let used = 0;
  const open = () => {
    page = { fragments: [], repeatHead: null, pinFrom: null };
    pages.push(page);
    used = 0;
  };
  open();

  const room = () => pageRoom(space, pages.length - 1);
  const nextRoom = () => pageRoom(space, pages.length);
  const empty = () => page.fragments.length === 0;
  /** What goes above a block where it starts: its space, or at the top of a page the head of the table it's a row of. */
  const lead = (b: PaperBlock, top: boolean) => (top ? b.table?.head ?? 0 : b.spaceBefore ?? 0);
  /** The least of a block that has to fit for it to start somewhere: a line of one that can be cut there, else all of it. */
  const start = (b: PaperBlock, fresh: number) => {
    const first = nextCut(b.cuts, 0);
    return first !== undefined && (!b.whole || b.height > fresh - lead(b, true) + EPSILON) ? first : b.height;
  };
  /**
   * The room block `i` and the blocks it keeps with need to start together, on this page or (`top`)
   * at the top of a new one. A block further on that can be cut needs only its first line: it fills
   * the page from there, and its last lines go on with what it keeps with (below).
   */
  const chain = (i: number, top: boolean) => {
    const fresh = nextRoom();
    let need = lead(blocks[i]!, top);
    let j = i;
    while (blocks[j]!.keepWithNext && j + 1 < blocks.length && !blocks[j + 1]!.breakBefore) {
      if (j > i && blocks[j]!.cuts?.length && !blocks[j]!.whole) break;
      need += blocks[j]!.height + (blocks[j + 1]!.spaceBefore ?? 0);
      j++;
    }
    return need + start(blocks[j]!, fresh);
  };

  const add = (b: PaperBlock, offset: number, height: number, part: boolean, top: number) => {
    if (b.pinBottom && !empty() && page.pinFrom === null) page.pinFrom = page.fragments.length;
    if (empty() && b.table && b.table.head > 0) page.repeatHead = b.table.id;
    page.fragments.push(part ? { key: b.key, offset, height, part: true } : { key: b.key, offset: 0, height });
    used += top + height;
  };

  blocks.forEach((b, i) => {
    if (b.breakBefore && !empty()) open();
    // A heading (or anything else kept with what follows) that would end this page alone moves on with it, when they fit on a
    // page together. A block that can be cut to fill the page stays, and its last lines go on with what follows instead (below).
    const fills = Boolean(b.cuts?.length) && !b.whole;
    if (!empty() && b.keepWithNext && !fills && chain(i, false) > room() - used + EPSILON && chain(i, true) <= nextRoom() + EPSILON) open();

    let offset = 0;
    for (;;) {
      const top = empty();
      const before = lead(b, top);
      const avail = room() - used - before;
      const rest = b.height - offset;

      if (rest <= avail + EPSILON) {
        // It fits, but what it keeps with doesn't: when it can be cut, its last lines go on with that.
        const next = blocks[i + 1];
        if (b.keepWithNext && next && !next.breakBefore && chain(i + 1, false) > avail - rest + EPSILON) {
          const cut = lastCut(b.cuts, offset, b.height - 1);
          if (cut !== undefined && b.height - cut + chain(i + 1, false) <= nextRoom() + EPSILON) {
            add(b, offset, cut - offset, true, before);
            offset = cut;
            open();
            continue;
          }
        }
        add(b, offset, rest, offset > 0, before);
        return;
      }

      // It doesn't fit. Something that moves whole (and fits on a page) goes to the next page; one
      // that can't be cut between its lines and is taller than a page anyway starts here (below).
      const tall = rest > nextRoom() - lead(b, true) + EPSILON;
      if (!top && (b.cuts?.length ? b.whole && !tall : !tall)) {
        open();
        continue;
      }
      // Else as many of its lines as fit here, and the rest on the next page.
      const cut = lastCut(b.cuts, offset, offset + avail);
      if (cut !== undefined) {
        add(b, offset, cut - offset, true, before);
        offset = cut;
        open();
        continue;
      }
      if (!top && (b.cuts?.length || avail < MIN_PART)) {
        open();
        continue;
      }
      // Not one line of it fits on a whole page, or it has no lines and is taller than a page: cut where the page ends.
      if (avail <= EPSILON) {
        add(b, offset, rest, offset > 0, before);
        return;
      }
      add(b, offset, avail, true, before);
      offset += avail;
      open();
    }
  });
  return pages;
}
