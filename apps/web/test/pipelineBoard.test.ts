/**
 * The sales board's quiet look (direction B, features/pipeline): lanes on the page with no box or
 * colored stage border, cards with no side bar, a menu on each card that keyboard and touch can
 * reach, stage chips and an inbox list on a phone in place of a board that scrolls sideways, and the
 * whole board on paper.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8");
const features = read("styles/features.css");
const css = features.slice(features.indexOf("/* ---------- Pipeline board"), features.indexOf("/* ---------- Automations builder"));
const page = read("features/pipeline/PipelinePage.tsx");
const rule = (selector: string) => {
  const at = css.indexOf(`\n${selector} {`);
  return at < 0 ? "" : css.slice(at, css.indexOf("}", at));
};

describe("sales board look", () => {
  it("draws lanes on the page, boxed only while a card is held over them", () => {
    expect(css).not.toBe("");
    const lane = rule(".board-lane");
    expect(lane).not.toMatch(/border:|background:|box-shadow:/);
    expect(css).toContain(".board-lane[data-target] { background: var(--fill); }");
    expect(css).toMatch(/\.board-lane\[data-drop\] \{[^}]*var\(--green\)/);
    // No colored stage border over a lane, no side bar on a stale card.
    expect(css).not.toMatch(/border-(top|bottom|left):\s*[23]px/);
    expect(css).not.toContain("--stage");
    expect(page).not.toContain("data-stale");
  });

  it("puts a lane's name, quiet count and total on a hairline", () => {
    expect(rule(".board-lane-head")).toContain("border-bottom: 1px solid var(--divider)");
    expect(rule(".board-lane-count")).toContain("color: var(--quiet)");
    expect(rule(".board-lane-sum")).toContain("margin-left: auto");
  });

  it("keeps each card's menu reachable from the keyboard and on touch screens", () => {
    expect(css).toContain(".deal:is(:hover, :focus-within) .deal-more");
    expect(css).toMatch(/@media \(hover: none\) \{ \.deal-more \{ opacity: 1; \} \}/);
    expect(css).toContain(".deal:has(.deal-link:focus-visible)");
    // The link opens the record; the card itself is what's dragged.
    expect(page).toMatch(/<Link className="deal-link"[^>]*draggable=\{false\}/);
    expect(page).toMatch(/<article\s+className="deal"\s+draggable/);
    // A finger gets 44px around the 26px button (26 + 2 × 9).
    expect(css).toMatch(/@media \(pointer: coarse\) \{ \.deal-more::before \{[^}]*inset: -9px;/);
    expect(rule(".deal-more")).toContain("width: 26px");
  });

  it("orders a card's menu as the Menus board's row menu: open first, lost or archived last after a separator", () => {
    const menu = page.slice(page.indexOf("const actions = (c: Card)"), page.indexOf("const cards = data.data"));
    const labels = [...menu.matchAll(/label: (?:quote \? )?"([^"]+)"/g)].map((m) => m[1]);
    expect(labels[0]).toBe("Open quote");
    expect(labels.at(-1)).toBe("Mark lost");
    expect(menu.slice(menu.lastIndexOf("{ separator: true }"))).toContain("danger: true");
    expect(menu.match(/danger: true/g)).toHaveLength(1);
  });

  it("shows stage chips over an inbox list on a phone, and the whole board on paper", () => {
    expect(css).toContain("@media (min-width: 901px) { .pipe-phone { display: none; } }");
    expect(css).toMatch(/@media \(max-width: 900px\) \{\s*\.board, \.board-lost/);
    expect(css).toMatch(/@media print \{\s*\.board \{ display: grid !important;/);
    expect(page).toContain('<InboxList\n                  className="pipe-phone"');
  });
});
