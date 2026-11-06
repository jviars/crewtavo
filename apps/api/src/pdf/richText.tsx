/**
 * A contract's paragraph as runs of react-pdf text: the cleaned HTML of contractBlocks (apps/web
 * lib/html), so strong, em, u, s and br, and in a list item or quote, paragraphs and lists. Read a
 * tag at a time, with no HTML parser (the server has none); any other tag leaves its words alone.
 */
import { Text } from "@react-pdf/renderer";
import type { Style } from "@react-pdf/types";
import type { ReactNode } from "react";

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** Text with its character references read: "&amp;" -> "&", "&#8217;" -> "’". */
function decode(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (whole, name: string) => {
    if (name[0] !== "#") return ENTITIES[name.toLowerCase()] ?? whole;
    const code = name[1] === "x" || name[1] === "X" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
    return code > 0 && code < 0x110000 ? String.fromCodePoint(code) : whole;
  });
}

/** How each inline tag's words look; `bold` is how strong words do (ink on the clause's gray). */
const INLINE: Record<string, (bold: Style) => Style> = {
  strong: (bold) => bold,
  b: (bold) => bold,
  em: () => ({ fontStyle: "italic" }),
  i: () => ({ fontStyle: "italic" }),
  u: () => ({ textDecoration: "underline" }),
  s: () => ({ textDecoration: "line-through" }),
};

/** Tags that start on a line of their own. */
const BLOCK = new Set(["p", "div", "ul", "ol", "li", "h3", "h4", "blockquote"]);

/** Runs of text for `html`. `keepBreaks` keeps the line breaks of plain text (a section written without formatting). */
export function richText(html: string, bold: Style, keepBreaks = false): ReactNode[] {
  type Run = { tag: string; style: Style | null; runs: ReactNode[] };
  const stack: Run[] = [{ tag: "", style: null, runs: [] }];
  const lists: Array<{ ordered: boolean; n: number }> = [];
  let last = "";
  let key = 0;
  const into = () => stack[stack.length - 1]!.runs;
  const write = (text: string) => {
    into().push(text);
    last = text;
  };
  /** Closes the runs from `depth` up, each into the one under it. */
  const close = (depth: number) => {
    while (stack.length > depth) {
      const run = stack.pop()!;
      if (run.runs.length) into().push(<Text key={key++} style={run.style ?? undefined}>{run.runs}</Text>);
    }
  };

  for (const token of html.match(/<[^>]*>|[^<]+/g) ?? []) {
    if (token[0] !== "<") {
      const text = keepBreaks ? decode(token) : decode(token).replace(/\s+/g, " ");
      if (!last) write(text.replace(/^\s+/, ""));
      else if (text) write(last.endsWith("\n") ? text.replace(/^ +/, "") : text);
      continue;
    }
    const tag = /^<(\/)?([a-z0-9]+)/i.exec(token);
    if (!tag) continue;
    const name = tag[2]!.toLowerCase();
    if (name === "br") write("\n");
    else if (tag[1]) {
      if (name === "ul" || name === "ol") lists.pop();
      const depth = stack.map((r) => r.tag).lastIndexOf(name);
      if (INLINE[name] && depth > 0) close(depth);
    } else {
      if (BLOCK.has(name) && last && !last.endsWith("\n")) write("\n");
      if (name === "ul" || name === "ol") lists.push({ ordered: name === "ol", n: 0 });
      const list = lists[lists.length - 1];
      if (name === "li" && list) write(`${"    ".repeat(lists.length - 1)}${list.ordered ? `${++list.n}.` : "•"} `);
      if (INLINE[name]) stack.push({ tag: name, style: INLINE[name](bold), runs: [] });
    }
  }
  close(1);
  return stack[0]!.runs;
}
