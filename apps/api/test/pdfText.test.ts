/**
 * A contract's words in the PDF (pdf/richText.tsx): its formatting read a tag at a time, and how
 * long that takes and how deep it goes on whatever a page sends, closed or not.
 */
import { isValidElement, type ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { richText } from "../src/pdf/richText";

const BOLD = { fontWeight: 700 };
const kids = (node: ReactNode): ReactNode[] => (isValidElement<{ children?: ReactNode }>(node) ? [node.props.children].flat() : []);
/** The words of the runs, formatting aside. */
const words = (nodes: ReactNode[]): string => nodes.map((n) => (typeof n === "string" ? n : words(kids(n)))).join("");
/** How many runs deep the formatting goes. */
const deepest = (nodes: ReactNode[]): number => Math.max(0, ...nodes.map((n) => (isValidElement(n) ? 1 + deepest(kids(n)) : 0)));

describe("a contract's words in the PDF", () => {
  it("reads bold, italic, lists and character references", () => {
    const runs = richText("We stand behind our <strong>workmanship</strong> &amp; materials.", BOLD);
    expect(words(runs)).toBe("We stand behind our workmanship & materials.");
    expect(runs[1]).toMatchObject({ props: { style: BOLD } });
    expect(words(richText("<ol><li>One</li><li>Two <em>more</em></li></ol>", BOLD))).toBe("1. One\n2. Two more");
  });

  it("passes over a lone \"<\" and keeps the words after it", () => {
    expect(words(richText("a < b <strong>c</strong>", BOLD))).toBe("a  b c");
  });

  it("takes time in step with what it's sent, however its tags are left open", () => {
    const sent = [
      // A "<" with no ">" after it: each was read to the end.
      "<a".repeat(100_000),
      // Closing tags of formatting that isn't open: each looked through everything open.
      "<b>".repeat(30_000) + "x" + "</i>".repeat(30_000),
      "<b><i>".repeat(20_000) + "x" + "</u>".repeat(40_000),
    ];
    for (const html of sent) {
      const started = performance.now();
      richText(html, BOLD);
      expect(performance.now() - started, html.slice(0, 12)).toBeLessThan(1000);
    }
  });

  it("nests formatting and lists only so deep", () => {
    const nested = richText(`${"<b><i>".repeat(5_000)}deep${"</i></b>".repeat(5_000)} after`, BOLD);
    expect(words(nested)).toBe("deep after");
    expect(deepest(nested)).toBeLessThanOrEqual(12);
    // Each item's indent stops growing: the words don't grow with every list opened.
    const items = words(richText(`${"<ul>".repeat(20_000)}${"<li>x</li>".repeat(20_000)}`, BOLD));
    expect(items.length).toBeLessThan(20_000 * 60);
  });
});
