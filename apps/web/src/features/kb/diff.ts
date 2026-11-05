/**
 * Comparing two versions of a guide (Revision history → Changes): each version as its blocks
 * (headings, paragraphs, list items...), lined up, and the words that changed in a block marked.
 */

/** A block of a guide as it reads: a heading, a step or list item, a paragraph, a table cell, a picture or a video. `key`: which picture or video. */
export interface Block { kind: "heading" | "item" | "text" | "media"; text: string; key?: string }

/** A guide's HTML (sanitized) as its blocks. Needs a browser (DOMParser). */
export function blocksOf(html: string): Block[] {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const blocks: Block[] = [];
  for (const el of doc.body.querySelectorAll("h2, h3, h4, p, td, th, pre, img, iframe")) {
    if (el.matches("td p, th p")) continue;
    if (el.matches("img, iframe")) {
      blocks.push({
        kind: "media",
        text: el.matches("img") ? `Picture${el.getAttribute("alt") ? `: ${el.getAttribute("alt")}` : ""}` : "Video",
        key: el.getAttribute("data-path") ?? el.getAttribute("src") ?? undefined,
      });
      continue;
    }
    const text = (el.textContent ?? "").replace(/\s+/g, " ").trim();
    if (!text) continue;
    blocks.push({ kind: el.matches("h2, h3, h4") ? "heading" : el.closest("li") ? "item" : "text", text });
  }
  return blocks;
}

export type Op<T> = { op: "same"; a: T; b: T } | { op: "del"; a: T } | { op: "add"; b: T };

/** The shortest edit from `a` to `b` (longest common subsequence), deletions before additions in each run. */
export function diffSeq<T>(a: readonly T[], b: readonly T[], same: (x: T, y: T) => boolean = Object.is): Op<T>[] {
  const n = a.length;
  const m = b.length;
  // lcs[i][j]: the longest common run of a[i..] and b[j..].
  const lcs = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) lcs[i][j] = same(a[i], b[j]) ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const ops: Op<T>[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && same(a[i], b[j])) ops.push({ op: "same", a: a[i++], b: b[j++] });
    else if (j >= m || (i < n && lcs[i + 1][j] >= lcs[i][j + 1])) ops.push({ op: "del", a: a[i++] });
    else ops.push({ op: "add", b: b[j++] });
  }
  return ops;
}

/** A row of the side-by-side view: the block before, the block after, or both (the same, or changed). */
export type Row = { kind: "same" | "changed"; before: Block; after: Block } | { kind: "removed"; before: Block } | { kind: "added"; after: Block };

/** Two versions' blocks as rows: a removed block followed by an added one of the same kind reads as that block changed. */
export function compareBlocks(before: readonly Block[], after: readonly Block[]): Row[] {
  // Too long to line up in a moment (a very long guide): every block counts as changed or kept, in order.
  if (before.length * after.length > 400_000) {
    return Array.from({ length: Math.max(before.length, after.length) }, (_, i) =>
      before[i] && after[i] ? { kind: before[i].text === after[i].text ? "same" : "changed", before: before[i], after: after[i] } : before[i] ? { kind: "removed", before: before[i] } : { kind: "added", after: after[i] },
    ) as Row[];
  }
  const ops = diffSeq(before, after, (x, y) => x.kind === y.kind && x.text === y.text && x.key === y.key);
  const rows: Row[] = [];
  for (let k = 0; k < ops.length; ) {
    const op = ops[k];
    if (op.op === "same") {
      rows.push({ kind: "same", before: op.a, after: op.b });
      k++;
      continue;
    }
    const dels: Block[] = [];
    const adds: Block[] = [];
    while (k < ops.length && ops[k].op === "del") dels.push((ops[k++] as { a: Block }).a);
    while (k < ops.length && ops[k].op === "add") adds.push((ops[k++] as { b: Block }).b);
    // Paired in order while they're the same kind of block; the rest are removed or added.
    let p = 0;
    while (p < dels.length && p < adds.length && dels[p].kind === adds[p].kind) {
      rows.push({ kind: "changed", before: dels[p], after: adds[p] });
      p++;
    }
    for (const d of dels.slice(p)) rows.push({ kind: "removed", before: d });
    for (const a of adds.slice(p)) rows.push({ kind: "added", after: a });
  }
  return rows;
}

/** The words of a changed block, marked: in `before`, what's gone; in `after`, what's new. */
export function wordChanges(before: string, after: string): { before: Array<{ text: string; changed: boolean }>; after: Array<{ text: string; changed: boolean }> } {
  const a = before.split(/(\s+)/).filter(Boolean);
  const b = after.split(/(\s+)/).filter(Boolean);
  if (a.length * b.length > 250_000) return { before: [{ text: before, changed: true }], after: [{ text: after, changed: true }] };
  const out = { before: [] as Array<{ text: string; changed: boolean }>, after: [] as Array<{ text: string; changed: boolean }> };
  const push = (list: Array<{ text: string; changed: boolean }>, text: string, changed: boolean) => {
    const last = list[list.length - 1];
    if (last && last.changed === changed) last.text += text;
    else list.push({ text, changed });
  };
  for (const op of diffSeq(a, b)) {
    if (op.op === "same") {
      push(out.before, op.a, false);
      push(out.after, op.b, false);
    } else if (op.op === "del") push(out.before, op.a, true);
    else push(out.after, op.b, true);
  }
  return out;
}
