/**
 * Laying an estimate's body out on letter pages (features/documents/paginate.ts): what fits, what
 * moves on together, table heads repeated, long things cut between their lines, and the signatures
 * at the bottom of their page. Heights are made up here; in the browser they're measured.
 */
import { describe, expect, it } from "vitest";
import { pageRoom, paginate, type PaperBlock, type PaperLayout, type PaperSpace } from "../src/features/documents/paginate";

/** Pages with 500 px of room each (the first a little less, under the letterhead). */
const SPACE: PaperSpace = { first: 480, rest: 520, padTop: 6, padBottom: 6, slack: 8 };
const ROOM_FIRST = pageRoom(SPACE, 0);
const ROOM = pageRoom(SPACE, 1);

const keysOf = (layout: PaperLayout) => layout.map((page) => page.fragments.map((f) => f.key));

/** Lines of `line` px: where a block of `height` can be cut. */
const linesOf = (height: number, line = 18) => Array.from({ length: Math.floor(height / line) - 1 }, (_, i) => (i + 1) * line);

/** Every page's blocks, with the space between them (and a repeated head), fit in its room. */
function expectFits(layout: PaperLayout, blocks: PaperBlock[]) {
  const byKey = new Map(blocks.map((b) => [b.key, b]));
  layout.forEach((page, i) => {
    let used = page.repeatHead ? byKey.get(page.fragments[0]!.key)!.table!.head : 0;
    page.fragments.forEach((f, j) => {
      used += (j === 0 ? 0 : byKey.get(f.key)!.spaceBefore ?? 0) + f.height;
    });
    expect(used, `page ${i + 1}`).toBeLessThanOrEqual(pageRoom(SPACE, i) + 0.01);
  });
}

/** Nothing is left off: each block's fragments, in order, add up to all of it. */
function expectWhole(layout: PaperLayout, blocks: PaperBlock[]) {
  const fragments = layout.flatMap((page) => page.fragments);
  expect([...new Set(fragments.map((f) => f.key))]).toEqual(blocks.map((b) => b.key));
  for (const b of blocks) {
    let at = 0;
    for (const f of fragments.filter((f) => f.key === b.key)) {
      expect(f.offset, b.key).toBeCloseTo(at, 5);
      at += f.height;
    }
    expect(at, b.key).toBeCloseTo(b.height, 5);
  }
}

describe("laying a document out on pages", () => {
  it("knows the room on a page: the body's space less its padding and the slack at the bottom", () => {
    expect(ROOM_FIRST).toBe(460);
    expect(ROOM).toBe(500);
    expect(pageRoom({ ...SPACE, first: 10 }, 0)).toBe(0);
  });

  it("always has at least one page", () => {
    expect(paginate([], SPACE)).toEqual([{ fragments: [], repeatHead: null, pinFrom: null }]);
  });

  it("fills a page counting the space between blocks, but not above the first one on a page", () => {
    const blocks: PaperBlock[] = [
      { key: "parties", height: 100 },
      { key: "strip", height: 100, spaceBefore: 20 },
      { key: "totals", height: 100, spaceBefore: 20 },
      { key: "notes", height: 100, spaceBefore: 20 },
      // 100 + 3 × 120 = 460: exactly the first page. With its space this one doesn't fit.
      { key: "terms", height: 90, spaceBefore: 20 },
    ];
    const layout = paginate(blocks, SPACE);
    expect(keysOf(layout)).toEqual([["parties", "strip", "totals", "notes"], ["terms"]]);
    expect(layout[1]!.fragments[0]).toEqual({ key: "terms", offset: 0, height: 90 });
    expectFits(layout, blocks);
  });

  it("keeps every page within its room, whatever the blocks", () => {
    let seed = 7;
    const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const blocks: PaperBlock[] = Array.from({ length: 120 }, (_, i) => {
      const height = Math.round(10 + random() * 260);
      return { key: `b${i}`, height, spaceBefore: [0, 3, 8, 20][i % 4], keepWithNext: random() < 0.15, cuts: random() < 0.5 ? linesOf(height) : undefined };
    });
    const layout = paginate(blocks, SPACE);
    expect(layout.length).toBeGreaterThan(10);
    expectFits(layout, blocks);
    expectWhole(layout, blocks);
    // With now and then a block taller than a page, with lines to cut at or none.
    const tall = blocks.map((b, i): PaperBlock => (i % 9 === 4 ? { ...b, height: 520 + i * 7, whole: i % 2 === 0, cuts: i % 3 ? linesOf(520 + i * 7) : undefined } : b));
    const tallLayout = paginate(tall, SPACE);
    expectFits(tallLayout, tall);
    expectWhole(tallLayout, tall);
  });

  it("never ends a page with a heading alone: it goes on with what follows", () => {
    const blocks: PaperBlock[] = [
      { key: "lines", height: 400 },
      { key: "title", height: 20, spaceBefore: 18, keepWithNext: true },
      { key: "clause", height: 60, spaceBefore: 6 },
    ];
    // The title would fit under the lines (400 + 38 = 438), but the clause after it wouldn't.
    expect(keysOf(paginate(blocks, SPACE))).toEqual([["lines"], ["title", "clause"]]);
    // With room for the clause too, they stay.
    expect(keysOf(paginate([{ ...blocks[0]!, height: 300 }, ...blocks.slice(1)], SPACE))).toEqual([["lines", "title", "clause"]]);
  });

  it("moves a whole chain of headings with the block they lead to", () => {
    const blocks: PaperBlock[] = [
      { key: "lines", height: 360 },
      { key: "heading", height: 30, keepWithNext: true },
      { key: "title", height: 20, spaceBefore: 18, keepWithNext: true },
      { key: "subhead", height: 18, spaceBefore: 12, keepWithNext: true },
      { key: "clause", height: 60, spaceBefore: 6 },
    ];
    expect(keysOf(paginate(blocks, SPACE))).toEqual([["lines"], ["heading", "title", "subhead", "clause"]]);
  });

  it("starts the lead-in to a paragraph that can be cut where it is, with the paragraph's first line", () => {
    const blocks: PaperBlock[] = [
      { key: "lines", height: 400 },
      { key: "title", height: 20, spaceBefore: 18, keepWithNext: true },
      // 400 + 38 + 6 + 18 = 462 > 460: not even its first line fits.
      { key: "clause", height: 180, spaceBefore: 6, cuts: linesOf(180) },
    ];
    expect(keysOf(paginate(blocks, SPACE))).toEqual([["lines"], ["title", "clause"]]);
    const roomier = paginate([{ ...blocks[0]!, height: 380 }, ...blocks.slice(1)], SPACE);
    expect(keysOf(roomier)).toEqual([["lines", "title", "clause"], ["clause"]]);
    expect(roomier[0]!.fragments[2]).toEqual({ key: "clause", offset: 0, height: 36, part: true });
    expect(roomier[1]!.fragments[0]).toEqual({ key: "clause", offset: 36, height: 144, part: true });
  });

  it("splits a chain that's taller than any page rather than moving it", () => {
    const blocks: PaperBlock[] = [
      { key: "intro", height: 200 },
      { key: "a", height: 200, spaceBefore: 10, keepWithNext: true },
      { key: "b", height: 200, spaceBefore: 10, keepWithNext: true },
      { key: "c", height: 200, spaceBefore: 10 },
    ];
    const layout = paginate(blocks, SPACE);
    expect(keysOf(layout)).toEqual([["intro", "a"], ["b", "c"]]);
    expectFits(layout, blocks);
  });

  it("starts a new page where a block asks, but never leaves a page empty", () => {
    const blocks: PaperBlock[] = [
      { key: "signatures", height: 100 },
      { key: "terms-heading", height: 30, breakBefore: true, keepWithNext: true },
      { key: "clause", height: 40, spaceBefore: 18 },
    ];
    expect(keysOf(paginate(blocks, SPACE))).toEqual([["signatures"], ["terms-heading", "clause"]]);
    expect(keysOf(paginate(blocks.slice(1), SPACE))).toEqual([["terms-heading", "clause"]]);
  });

  it("repeats a table's head over its rows on the next page", () => {
    const lines = { id: "lines", head: 28 };
    const blocks: PaperBlock[] = [
      { key: "parties", height: 120 },
      { key: "lines-head", height: 28, spaceBefore: 20, keepWithNext: true },
      ...Array.from({ length: 12 }, (_, i): PaperBlock => ({ key: `line-${i}`, height: 40, table: lines, whole: true })),
      { key: "totals", height: 90, spaceBefore: 20 },
    ];
    const layout = paginate(blocks, SPACE);
    // 120 + 48 + 7 rows of 40 = 448 on the first page; the head and 5 rows and the totals on the next.
    expect(keysOf(layout)).toEqual([
      ["parties", "lines-head", ...[0, 1, 2, 3, 4, 5, 6].map((i) => `line-${i}`)],
      [...[7, 8, 9, 10, 11].map((i) => `line-${i}`), "totals"],
    ]);
    expect(layout.map((p) => p.repeatHead)).toEqual([null, "lines"]);
    expectFits(layout, blocks);
  });

  it("doesn't repeat a head that's nothing (a contract table without one)", () => {
    const table = { id: "t1", head: 0 };
    const blocks: PaperBlock[] = [{ key: "intro", height: 440 }, ...Array.from({ length: 3 }, (_, i): PaperBlock => ({ key: `row-${i}`, height: 30, spaceBefore: i ? 0 : 8, table, whole: true }))];
    const layout = paginate(blocks, SPACE);
    expect(keysOf(layout)).toEqual([["intro"], ["row-0", "row-1", "row-2"]]);
    expect(layout[1]!.repeatHead).toBeNull();
  });

  it("carries a 40-item list over pages, one item at a time", () => {
    const blocks: PaperBlock[] = [
      { key: "title", height: 20, keepWithNext: true },
      ...Array.from({ length: 40 }, (_, i): PaperBlock => ({ key: `item-${i}`, height: i % 5 === 0 ? 54 : 36, spaceBefore: i ? 3 : 6, cuts: i % 5 === 0 ? [18, 36] : [18] })),
    ];
    const layout = paginate(blocks, SPACE);
    expect(layout.length).toBe(4);
    expectFits(layout, blocks);
    expectWhole(layout, blocks);
    // Every page but the last is filled to within a line.
    layout.slice(0, -1).forEach((page, i) => {
      const used = page.fragments.reduce((sum, f, j) => sum + f.height + (j ? (blocks.find((b) => b.key === f.key)!.spaceBefore ?? 0) : 0), 0);
      expect(pageRoom(SPACE, i) - used).toBeLessThan(18 + 3);
    });
  });

  it("cuts a paragraph three pages long between its lines, and carries on at the top of each page", () => {
    const paragraph: PaperBlock = { key: "clause", height: 1404, spaceBefore: 8, cuts: linesOf(1404) };
    const blocks: PaperBlock[] = [{ key: "title", height: 20, keepWithNext: true }, paragraph];
    const layout = paginate(blocks, SPACE);
    expect(keysOf(layout)).toEqual([["title", "clause"], ["clause"], ["clause"]]);
    const parts = layout.flatMap((p) => p.fragments.filter((f) => f.key === "clause"));
    expect(parts.every((f) => f.part)).toBe(true);
    // Each part ends on a line (the last at the paragraph's end) and fills its page to within a line.
    for (const f of parts.slice(0, -1)) expect((f.offset + f.height) % 18).toBe(0);
    expect(parts[0]!.height).toBe(432);
    expect(parts[1]!.height).toBe(486);
    expectFits(layout, blocks);
    expectWhole(layout, blocks);
  });

  it("moves a row that fits on a page to the next one whole, rather than cutting it", () => {
    const lines = { id: "lines", head: 28 };
    const blocks: PaperBlock[] = [
      { key: "intro", height: 380 },
      { key: "line-0", height: 120, spaceBefore: 20, table: lines, whole: true, cuts: linesOf(120) },
    ];
    const layout = paginate(blocks, SPACE);
    expect(layout[1]!.fragments).toEqual([{ key: "line-0", offset: 0, height: 120 }]);
    expect(layout[1]!.repeatHead).toBe("lines");
  });

  it("cuts a row taller than a page between its lines, with the head over each part", () => {
    const lines = { id: "lines", head: 28 };
    const tall: PaperBlock = { key: "line-1", height: 1100, table: lines, whole: true, cuts: linesOf(1100, 20) };
    const blocks: PaperBlock[] = [
      { key: "lines-head", height: 28, keepWithNext: true },
      { key: "line-0", height: 40, table: lines, whole: true },
      tall,
      { key: "line-2", height: 40, table: lines, whole: true },
    ];
    const layout = paginate(blocks, SPACE);
    expect(keysOf(layout)).toEqual([["lines-head", "line-0", "line-1"], ["line-1"], ["line-1", "line-2"]]);
    expect(layout.map((p) => p.repeatHead)).toEqual([null, "lines", "lines"]);
    expect(layout[0]!.fragments[2]).toMatchObject({ offset: 0, height: 380, part: true });
    expect(layout[1]!.fragments[0]).toMatchObject({ offset: 380, height: 460, part: true });
    expectFits(layout, blocks);
    expectWhole(layout, blocks);
  });

  it("prints a block that can't be cut between lines and is taller than a page in full, a page at a time, starting where it is", () => {
    const blocks: PaperBlock[] = [{ key: "a", height: 100 }, { key: "huge", height: 1200, spaceBefore: 20 }];
    const layout = paginate(blocks, SPACE);
    // Moving it on would leave the first page empty under "a" and cut it all the same.
    expect(keysOf(layout)).toEqual([["a", "huge"], ["huge"], ["huge"]]);
    expect(layout[0]!.fragments[1]).toEqual({ key: "huge", offset: 0, height: 340, part: true });
    expectFits(layout, blocks);
    expectWhole(layout, blocks);
    // With hardly any room left, it starts the next page instead of a sliver of it.
    const full = paginate([{ key: "a", height: 420 }, blocks[1]!], SPACE);
    expect(keysOf(full)).toEqual([["a"], ["huge"], ["huge"], ["huge"]]);
    expectWhole(full, [{ key: "a", height: 420 }, blocks[1]!]);
    // One that fits on a page still moves on whole.
    expect(keysOf(paginate([{ key: "a", height: 300 }, { key: "options", height: 480, spaceBefore: 20 }], SPACE))).toEqual([["a"], ["options"]]);
  });

  it("puts the signatures at the bottom of their page only when there's something above them", () => {
    const blocks: PaperBlock[] = [
      { key: "lines", height: 200 },
      { key: "totals", height: 80, spaceBefore: 20 },
      { key: "signatures", height: 110, spaceBefore: 20, pinBottom: true },
    ];
    const layout = paginate(blocks, SPACE);
    expect(keysOf(layout)).toEqual([["lines", "totals", "signatures"]]);
    expect(layout[0]!.pinFrom).toBe(2);
    // Moved to a page of their own: at the top of it, not alone at the bottom of an empty page.
    const moved = paginate([{ ...blocks[0]!, height: 300 }, ...blocks.slice(1)], SPACE);
    expect(keysOf(moved)).toEqual([["lines", "totals"], ["signatures"]]);
    expect(moved.map((p) => p.pinFrom)).toEqual([null, null]);
  });

  it("keeps the sentence above the signatures with them, at the bottom together", () => {
    const blocks: PaperBlock[] = [
      { key: "lines", height: 320 },
      { key: "accept", height: 18, spaceBefore: 20, keepWithNext: true, pinBottom: true },
      { key: "signatures", height: 110, spaceBefore: 4 },
      { key: "terms-heading", height: 30, breakBefore: true, keepWithNext: true },
      { key: "clause", height: 40, spaceBefore: 18 },
    ];
    const layout = paginate(blocks, SPACE);
    // 320 + 38 fits, but not the signatures after it: the sentence goes on with them.
    expect(keysOf(layout)).toEqual([["lines"], ["accept", "signatures"], ["terms-heading", "clause"]]);
    expect(layout[1]!.pinFrom).toBeNull();
    const fits = paginate([{ ...blocks[0]!, height: 200 }, ...blocks.slice(1)], SPACE);
    expect(keysOf(fits)).toEqual([["lines", "accept", "signatures"], ["terms-heading", "clause"]]);
    expect(fits[0]!.pinFrom).toBe(1);
  });

  it("keeps a section's initials with the end of the section", () => {
    const initials: PaperBlock = { key: "s0-initials", height: 40, spaceBefore: 8 };
    // A one-line clause can't be cut: it moves on with the initials.
    const short: PaperBlock[] = [{ key: "lines", height: 400 }, { key: "s0-0", height: 18, spaceBefore: 20, keepWithNext: true }, initials];
    expect(keysOf(paginate(short, SPACE))).toEqual([["lines"], ["s0-0", "s0-initials"]]);
    // A longer one stays, and its last line goes on with them.
    const long: PaperBlock[] = [{ key: "lines", height: 300 }, { key: "s0-0", height: 126, spaceBefore: 20, keepWithNext: true, cuts: linesOf(126) }, initials];
    const layout = paginate(long, SPACE);
    expect(keysOf(layout)).toEqual([["lines", "s0-0"], ["s0-0", "s0-initials"]]);
    expect(layout[1]!.fragments[0]).toEqual({ key: "s0-0", offset: 108, height: 18, part: true });
    expectFits(layout, long);
    expectWhole(layout, long);
  });

  it("fills the page with a titled section of one long paragraph and initials, its last lines going on with the initials", () => {
    const blocks: PaperBlock[] = [
      { key: "lines", height: 200 },
      { key: "s0-title", height: 20, spaceBefore: 18, keepWithNext: true },
      { key: "s0-0", height: 288, spaceBefore: 6, keepWithNext: true, cuts: linesOf(288) },
      { key: "s0-initials", height: 40, spaceBefore: 8 },
    ];
    const layout = paginate(blocks, SPACE);
    // Not the whole section moved on, leaving most of the first page blank.
    expect(keysOf(layout)).toEqual([["lines", "s0-title", "s0-0"], ["s0-0", "s0-initials"]]);
    expect(layout[0]!.fragments[2]).toMatchObject({ offset: 0, part: true });
    expect(pageRoom(SPACE, 0) - (200 + 38 + 6 + layout[0]!.fragments[2]!.height)).toBeLessThan(18);
    expectFits(layout, blocks);
    expectWhole(layout, blocks);
  });
});
