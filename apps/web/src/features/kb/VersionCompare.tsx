/**
 * Two versions of a guide side by side (one under the other on a phone), as KB-Extras draws them:
 * what was taken out marked on the left, what's new on the right, an unchanged heading across both
 * as the section the change is in, and long unchanged stretches folded.
 */
import { Fragment, useMemo, useState } from "react";
import { Icon } from "@/components/ui/Icon";
import { EmptyState } from "@/components/ui/States";
import { sanitizeHtml } from "@/lib/html";
import { blocksOf, compareBlocks, wordChanges, type Block, type Row } from "./diff";

export interface Version { label: string; title: string; html: string }

/** Unchanged blocks shown around a change; longer stretches between changes fold. */
const CONTEXT = 1;

export function VersionCompare({ before, after }: { before: Version; after: Version }) {
  const [unfolded, setUnfolded] = useState(false);
  const rows = useMemo(() => {
    const titles: Row[] = before.title === after.title ? [] : [{ kind: "changed", before: { kind: "heading", text: before.title }, after: { kind: "heading", text: after.title } }];
    return [...titles, ...compareBlocks(blocksOf(sanitizeHtml(before.html)), blocksOf(sanitizeHtml(after.html)))];
  }, [before.title, before.html, after.title, after.html]);
  const changed = rows.filter((r) => r.kind !== "same").length;
  if (!changed) return <EmptyState icon="check" title="No changes to the words" compact>These versions read the same. Only formatting may differ.</EmptyState>;

  // Which rows show: every change, and CONTEXT unchanged rows either side of one.
  const near = rows.map((_, i) => unfolded || rows.slice(Math.max(0, i - CONTEXT), i + CONTEXT + 1).some((r) => r.kind !== "same"));
  return (
    <div className="diff" role="table" aria-label={`Changes from ${before.label} to ${after.label}`}>
      <div className="diff-head" role="row">
        <span role="columnheader">{before.label}</span>
        <span role="columnheader">{after.label}</span>
      </div>
      {rows.map((row, i) => {
        if (!near[i]) {
          if (i > 0 && !near[i - 1]) return null;
          let hidden = 0;
          while (i + hidden < rows.length && !near[i + hidden]) hidden++;
          return (
            <div key={i} className="diff-fold" role="row">
              <span role="cell">
                <Icon name="sort" size={13} />
                <span>{hidden} unchanged {hidden === 1 ? "part" : "parts"}</span>
                <span aria-hidden="true">·</span>
                <button type="button" onClick={() => setUnfolded(true)}>Show all</button>
              </span>
            </div>
          );
        }
        // An unchanged heading reads as the section the changes under it are in, across both sides.
        if (row.kind === "same" && row.before.kind === "heading") {
          return (
            <div key={i} className="diff-row diff-sec" role="row">
              <span role="cell">{row.before.text}</span>
            </div>
          );
        }
        return <DiffRow key={i} row={row} />;
      })}
      <p className="diff-summary">{changed} {changed === 1 ? "change" : "changes"}</p>
    </div>
  );
}

function DiffRow({ row }: { row: Row }) {
  const words = row.kind === "changed" ? wordChanges(row.before.text, row.after.text) : null;
  return (
    <div className="diff-row" role="row" data-row={row.kind}>
      <Cell block={"before" in row ? row.before : null} side="before" kind={row.kind} parts={words?.before} />
      <Cell block={"after" in row ? row.after : null} side="after" kind={row.kind} parts={words?.after} />
    </div>
  );
}

function Cell({ block, side, kind, parts }: { block: Block | null; side: "before" | "after"; kind: Row["kind"]; parts?: Array<{ text: string; changed: boolean }> }) {
  if (!block) return <span className="diff-cell" role="cell" data-empty />;
  const Mark = side === "before" ? "del" : "ins";
  // A block taken out or added is marked whole; a changed one, just its words that changed.
  const whole = kind === "removed" || kind === "added" || (kind === "changed" && block.kind === "media");
  return (
    <span className="diff-cell" role="cell" data-block={block.kind} data-kind={kind}>
      {whole ? <Mark>{block.text}</Mark> : parts ? parts.map((p, i) => <Fragment key={i}>{p.changed ? <Mark>{p.text}</Mark> : p.text}</Fragment>) : block.text}
    </span>
  );
}
